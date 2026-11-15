import { db, q } from './db.js';
import { graph, graphAll, firstMetric, MetaError, markTokenDead } from './meta.js';

const DAY = 864e5;
const isoDay = t => new Date(t).toISOString().slice(0, 10);
const unix = t => Math.floor(t / 1000);
const dayOfEnd = endTime => isoDay(new Date(endTime).getTime() - DAY);

async function upsertDaily(accountId, rows) {
  const list = Object.entries(rows).map(([day, v]) => ({ account_id: accountId, day, ...v }));
  if (!list.length) return;
  // merge with existing so partial metrics don't wipe others
  const existing = await q(db().from('daily_stats').select('*').eq('account_id', accountId).in('day', list.map(r => r.day)));
  const ex = Object.fromEntries(existing.map(r => [r.day, r]));
  const merged = list.map(r => { const o = ex[r.day] || {}; const m = { ...o, ...r }; for (const k of ['reach', 'views', 'engagements', 'followers']) if (r[k] == null && o[k] != null) m[k] = o[k]; return m; });
  await q(db().from('daily_stats').upsert(merged));
}

function addSeries(rows, field, metric) {
  if (!metric) return;
  for (const v of metric.values || []) {
    const val = typeof v.value === 'number' ? v.value : (v.value && typeof v.value === 'object' ? Object.values(v.value).reduce((a, b) => a + (+b || 0), 0) : null);
    if (val == null) continue;
    const d = dayOfEnd(v.end_time);
    (rows[d] = rows[d] || {})[field] = Math.round(val);
  }
}

const mapFbType = (att, statusType) => {
  const t = (att && (att.media_type || att.type)) || '';
  if (/video|reel/i.test(t) || /video/i.test(statusType || '')) return 'Reel';
  if (/album/i.test(t)) return 'Carousel';
  return 'Feed post';
};
const mapIgType = (m) => m.media_product_type === 'REELS' ? 'Reel' : m.media_product_type === 'STORY' ? 'Story' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : 'Feed post';

async function syncFacebook(acc, managedPageIds, clientOfPage) {
  const token = acc.access_token, now = Date.now();
  const info = await graph(`/${acc.id}`, { fields: 'followers_count,fan_count,name,picture{url}', access_token: token });
  const followers = info.followers_count ?? info.fan_count ?? acc.followers;
  await q(db().from('accounts').update({ followers, name: info.name, picture_url: info.picture?.data?.url || acc.picture_url }).eq('id', acc.id));

  const rows = {};
  const range = { period: 'day', since: unix(now - 8 * DAY), until: unix(now) };
  addSeries(rows, 'reach', await firstMetric(acc.id, ['page_total_media_view_unique', 'page_impressions_unique'], range, token));
  addSeries(rows, 'views', await firstMetric(acc.id, ['page_media_view', 'page_impressions'], range, token));
  addSeries(rows, 'engagements', await firstMetric(acc.id, ['page_post_engagements'], range, token));
  (rows[isoDay(now)] = rows[isoDay(now)] || {}).followers = followers;
  await upsertDaily(acc.id, rows);

  // posts from the last 60 days
  // comment counts need pages_read_user_content; fall back gracefully if it wasn't granted
  const FIELDS = [
    'id,message,created_time,permalink_url,full_picture,parent_id,status_type,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),attachments.limit(1){media_type,type}',
    'id,message,created_time,permalink_url,full_picture,parent_id,status_type,shares,reactions.summary(total_count).limit(0),attachments.limit(1){media_type,type}',
    'id,message,created_time,permalink_url,full_picture,status_type,shares'
  ];
  let posts = [];
  for (const fields of FIELDS) {
    try { posts = await graphAll(`/${acc.id}/published_posts`, { fields, since: unix(now - 60 * DAY), limit: 50, access_token: token }, 4); break; }
    catch (e) { if (!(e instanceof MetaError) || e.tokenDead || (e.code !== 10 && e.code !== 200 && e.code !== 100)) throw e; }
  }
  const sharesByOriginal = {};
  for (const p of posts) {
    const likes = p.reactions?.summary?.total_count || 0, comments = p.comments?.summary?.total_count || 0, shares = p.shares?.count || 0;
    const parentPage = p.parent_id ? p.parent_id.split('_')[0] : null;
    if (p.parent_id && parentPage !== acc.id && managedPageIds.has(parentPage)) {
      (sharesByOriginal[p.parent_id] = sharesByOriginal[p.parent_id] || []).push({ page: acc.client_id, share_id: p.id, at: p.created_time, likes, comments, shares, views: null });
      continue;
    }
    const metrics = { likes, comments, shares, saves: 0, reach: null, views: null };
    if (now - new Date(p.created_time).getTime() < 35 * DAY) {
      const lt = { period: 'lifetime' };
      const r = await firstMetric(p.id, ['post_total_media_view_unique', 'post_impressions_unique'], lt, token);
      const v = await firstMetric(p.id, ['post_media_view', 'post_impressions'], lt, token);
      metrics.reach = r?.values?.[0]?.value ?? null; metrics.views = v?.values?.[0]?.value ?? null;
    }
    const existing = await q(db().from('posts').select('id,metrics').eq('fb_post_id', p.id));
    if (existing.length) {
      const old = existing[0].metrics || {};
      const fbm = { ...(old.fb || {}), ...Object.fromEntries(Object.entries(metrics).filter(([, x]) => x != null)) };
      await q(db().from('posts').update({ metrics: { ...old, fb: fbm } }).eq('id', existing[0].id));
    } else {
      await q(db().from('posts').insert({
        client_id: acc.client_id, platforms: ['fb'], type: mapFbType(p.attachments?.data?.[0], p.status_type), caption: p.message || '',
        media: p.full_picture ? [{ url: p.full_picture, kind: 'image', external: true }] : [], scheduled_at: p.created_time,
        status: 'published', source: 'meta', fb_post_id: p.id, results: { fb: { post_id: p.id, permalink: p.permalink_url } }, metrics: { fb: metrics }
      }));
    }
  }
  // attach shares made from this page onto originals owned by other managed pages
  for (const [origId, list] of Object.entries(sharesByOriginal)) {
    const orig = await q(db().from('posts').select('id,shares_out').eq('fb_post_id', origId));
    if (!orig.length) continue;
    const keep = (orig[0].shares_out || []).filter(s => !list.some(n => n.share_id === s.share_id));
    await q(db().from('posts').update({ shares_out: keep.concat(list) }).eq('id', orig[0].id));
  }
}

async function syncInstagram(acc) {
  const token = acc.access_token, now = Date.now();
  const info = await graph(`/${acc.id}`, { fields: 'followers_count,username,profile_picture_url', access_token: token });
  await q(db().from('accounts').update({ followers: info.followers_count || 0, username: info.username, picture_url: info.profile_picture_url || acc.picture_url }).eq('id', acc.id));

  const rows = {};
  try { const r = await graph(`/${acc.id}/insights`, { metric: 'reach', period: 'day', since: unix(now - 8 * DAY), until: unix(now), access_token: token }); addSeries(rows, 'reach', r.data?.[0]); } catch (e) { if (e instanceof MetaError && e.tokenDead) throw e; }
  for (let i = 1; i <= 3; i++) {
    const start = new Date(isoDay(now - i * DAY) + 'T00:00:00Z').getTime();
    try {
      const r = await graph(`/${acc.id}/insights`, { metric: 'views,total_interactions', metric_type: 'total_value', period: 'day', since: unix(start), until: unix(start + DAY), access_token: token });
      const d = isoDay(start); rows[d] = rows[d] || {};
      for (const m of r.data || []) { const v = m.total_value?.value; if (v == null) continue; if (m.name === 'views') rows[d].views = v; if (m.name === 'total_interactions') rows[d].engagements = v; }
    } catch (e) { if (e instanceof MetaError && e.tokenDead) throw e; }
  }
  (rows[isoDay(now)] = rows[isoDay(now)] || {}).followers = info.followers_count || 0;
  await upsertDaily(acc.id, rows);

  const media = await graphAll(`/${acc.id}/media`, { fields: 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count,thumbnail_url,media_url', limit: 50, access_token: token }, 2);
  for (const m of media) {
    const age = now - new Date(m.timestamp).getTime();
    if (age > 60 * DAY) continue;
    const metrics = { likes: m.like_count || 0, comments: m.comments_count || 0, shares: 0, saves: 0, reach: null, views: null };
    if (age < 35 * DAY) {
      let ins = null;
      for (const set of ['reach,views,saved,shares,total_interactions', 'reach,saved,shares', 'reach']) {
        try { ins = await graph(`/${m.id}/insights`, { metric: set, access_token: token }); break; } catch (e) { if (e instanceof MetaError && e.tokenDead) throw e; }
      }
      for (const x of ins?.data || []) { const v = x.values?.[0]?.value ?? x.total_value?.value; if (v == null) continue; if (x.name === 'reach') metrics.reach = v; if (x.name === 'views') metrics.views = v; if (x.name === 'saved') metrics.saves = v; if (x.name === 'shares') metrics.shares = v; }
    }
    const existing = await q(db().from('posts').select('id,metrics').eq('ig_media_id', m.id));
    if (existing.length) {
      const old = existing[0].metrics || {};
      await q(db().from('posts').update({ metrics: { ...old, ig: { ...(old.ig || {}), ...Object.fromEntries(Object.entries(metrics).filter(([, x]) => x != null)) } } }).eq('id', existing[0].id));
    } else {
      const thumb = m.thumbnail_url || (m.media_type !== 'VIDEO' ? m.media_url : null);
      await q(db().from('posts').insert({
        client_id: acc.client_id, platforms: ['ig'], type: mapIgType(m), caption: m.caption || '',
        media: thumb ? [{ url: thumb, kind: 'image', external: true }] : [], scheduled_at: m.timestamp, status: 'published', source: 'meta',
        ig_media_id: m.id, results: { ig: { id: m.id, permalink: m.permalink } }, metrics: { ig: metrics }
      }));
    }
  }
}

export async function syncAccount(acc) {
  const all = await q(db().from('accounts').select('id,kind,client_id'));
  const managed = new Set(all.filter(a => a.kind === 'fb').map(a => a.id));
  try {
    if (acc.kind === 'fb') await syncFacebook(acc, managed);
    else await syncInstagram(acc);
    await q(db().from('accounts').update({ last_sync: new Date().toISOString(), token_status: 'ok', token_error: null }).eq('id', acc.id));
    return { id: acc.id, ok: true };
  } catch (e) {
    if (e instanceof MetaError && e.tokenDead) await markTokenDead(acc.id, e);
    else await q(db().from('accounts').update({ last_sync: new Date().toISOString(), token_error: String(e.message).slice(0, 300) }).eq('id', acc.id));
    return { id: acc.id, ok: false, error: e.message };
  }
}

/** Sync the accounts that were synced longest ago. */
export async function syncStalest(n = 4, olderThanMin = 120) {
  const cutoff = new Date(Date.now() - olderThanMin * 60e3).toISOString();
  const accs = await q(db().from('accounts').select('*').neq('token_status', 'reconnect').or(`last_sync.is.null,last_sync.lt."${cutoff}"`).order('last_sync', { ascending: true, nullsFirst: true }).limit(n));
  const out = [];
  for (const a of accs) out.push(await syncAccount(a));
  return out;
}
