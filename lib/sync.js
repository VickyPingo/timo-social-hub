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

// remember which metric name Meta accepted, so later calls go straight to it
const metricCache = {};
async function seriesMetric(id, cands, days, token) {
  const key = cands.join(',');
  const order = metricCache[key] ? [metricCache[key], ...cands.filter(c => c !== metricCache[key])] : cands;
  const now = Date.now(), from = now - days * DAY, values = [];
  for (let end = now; end > from; end -= 30 * DAY) {
    const start = Math.max(from, end - 30 * DAY);
    for (const m of order) {
      try {
        const r = await graph(`/${id}/insights`, { metric: m, period: 'day', since: unix(start), until: unix(end), access_token: token });
        if (r.data && r.data.length) { metricCache[key] = m; values.push(...(r.data[0].values || [])); break; }
      } catch (e) { if (e instanceof MetaError && e.tokenDead) throw e; }
    }
  }
  return values.length ? { values } : null;
}
async function lifetimeMetric(id, cands, token) {
  const key = 'lt:' + cands.join(',');
  const order = metricCache[key] ? [metricCache[key], ...cands.filter(c => c !== metricCache[key])] : cands;
  for (const m of order) {
    try { const r = await graph(`/${id}/insights`, { metric: m, period: 'lifetime', access_token: token }); if (r.data && r.data.length) { metricCache[key] = m; return r.data[0].values?.[0]?.value ?? null; } }
    catch (e) { if (e instanceof MetaError && e.tokenDead) throw e; }
  }
  return null;
}
async function pMap(items, n, fn) { let i = 0; const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }; await Promise.all(Array.from({ length: Math.min(n, items.length) }, run)); }

const mapFbType = (att, statusType) => {
  const t = (att && (att.media_type || att.type)) || '';
  if (/video|reel/i.test(t) || /video/i.test(statusType || '')) return 'Reel';
  if (/album/i.test(t)) return 'Carousel';
  return 'Feed post';
};
const mapIgType = (m) => m.media_product_type === 'REELS' ? 'Reel' : m.media_product_type === 'STORY' ? 'Story' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : 'Feed post';

async function syncFacebook(acc, managedPageIds, opts = {}) {
  const token = acc.access_token, now = Date.now();
  const D = opts.days || 8, P = opts.postDays || 60, I = opts.insightDays || 35, back = !!opts.backfill;
  const info = await graph(`/${acc.id}`, { fields: 'followers_count,fan_count,name,picture{url},single_line_address,location{city,latitude,longitude}', access_token: token });
  const followers = info.followers_count ?? info.fan_count ?? acc.followers;
  const location = { city: info.location?.city || null, address: info.single_line_address || null, map: info.location?.latitude != null };
  await q(db().from('accounts').update({ followers, name: info.name, picture_url: info.picture?.data?.url || acc.picture_url, location }).eq('id', acc.id));

  const rows = {};
  addSeries(rows, 'reach', await seriesMetric(acc.id, ['page_total_media_view_unique', 'page_impressions_unique'], D, token));
  addSeries(rows, 'views', await seriesMetric(acc.id, ['page_media_view', 'page_impressions'], D, token));
  addSeries(rows, 'engagements', await seriesMetric(acc.id, ['page_post_engagements'], D, token));
  if (back) addSeries(rows, 'followers', await seriesMetric(acc.id, ['page_follows'], D, token));
  (rows[isoDay(now)] = rows[isoDay(now)] || {}).followers = followers;
  await upsertDaily(acc.id, rows);

  // posts from the last 60 days
  // comment counts need pages_read_user_content; fall back gracefully if it wasn't granted
  const FIELDS = [
    'id,message,created_time,permalink_url,full_picture,parent_id,status_type,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),attachments.limit(1){media_type,type,target}',
    'id,message,created_time,permalink_url,full_picture,parent_id,status_type,shares,reactions.summary(total_count).limit(0),attachments.limit(1){media_type,type,target}',
    'id,message,created_time,permalink_url,full_picture,parent_id,status_type,shares,attachments.limit(1){media_type,type,target}'
  ];
  let posts = [];
  for (const fields of FIELDS) {
    try { posts = await graphAll(`/${acc.id}/published_posts`, { fields, since: unix(now - P * DAY), limit: 50, access_token: token }, back ? 12 : 4); break; }
    catch (e) { if (!(e instanceof MetaError) || e.tokenDead || (e.code !== 10 && e.code !== 200 && e.code !== 100)) throw e; }
  }
  const sharesByOriginal = {};
  await pMap(posts, 5, async (p) => {
    const likes = p.reactions?.summary?.total_count || 0, comments = p.comments?.summary?.total_count || 0, shares = p.shares?.count || 0;
    const att = p.attachments?.data?.[0];
    const target = att?.target?.id || ((att?.target?.url || '').match(/fbid=(\d+)/) || [])[1] || null;
    if (p.parent_id) {
      // a share: Meta's parent_id prefix isn't the page id, so match on the original's post/object id or its photo id
      const ids = [...new Set([p.parent_id.split('_').pop(), target].filter(Boolean))];
      const orig = (await q(db().from('posts').select('id,client_id').or(ids.map(i => `fb_obj.eq.${i},fb_target.eq.${i}`).join(',')).limit(1)))[0];
      if (orig && orig.client_id !== acc.client_id) {
        // shared copies do have their own insights: reach, views and link clicks
        let reach = null, views = null, clicks = 0;
        try {
          const ins = await graph(`/${p.id}/insights`, { metric: 'post_total_media_view_unique,post_media_view,post_clicks', period: 'lifetime', access_token: token });
          for (const m of ins.data || []) { const v = m.values?.[0]?.value; if (m.name === 'post_total_media_view_unique') reach = v; if (m.name === 'post_media_view') views = v; if (m.name === 'post_clicks') clicks = v || 0; }
        } catch (e) {
          if (e instanceof MetaError && e.tokenDead) throw e;
          reach = await lifetimeMetric(p.id, ['post_total_media_view_unique', 'post_impressions_unique'], token);
          views = await lifetimeMetric(p.id, ['post_media_view', 'post_impressions'], token);
        }
        (sharesByOriginal[orig.id] = sharesByOriginal[orig.id] || []).push({ page: acc.client_id, share_id: p.id, at: p.created_time, likes, comments, shares, clicks, reach, views });
        await q(db().from('posts').delete().eq('fb_post_id', p.id).eq('source', 'meta')); // was imported as an ordinary post before
        return;
      }
    }
    const metrics = { likes, comments, shares, saves: 0, reach: null, views: null };
    const existing = await q(db().from('posts').select('id,metrics,source,status').eq('fb_post_id', p.id));
    const age = now - new Date(p.created_time).getTime();
    const haveReach = existing.length && existing[0].metrics?.fb?.reach != null;
    if (age < I * DAY && !(back && haveReach && age > 35 * DAY)) {
      metrics.reach = await lifetimeMetric(p.id, ['post_total_media_view_unique', 'post_impressions_unique'], token);
      metrics.views = await lifetimeMetric(p.id, ['post_media_view', 'post_impressions'], token);
    }
    if (existing.length) {
      const old = existing[0].metrics || {};
      const fbm = { ...(old.fb || {}), ...Object.fromEntries(Object.entries(metrics).filter(([, x]) => x != null)) };
      const upd = { metrics: { ...old, fb: fbm }, fb_target: target };
      if (existing[0].source === 'meta' && existing[0].status !== 'published') Object.assign(upd, { status: 'published', scheduled_at: p.created_time, results: { fb: { post_id: p.id, permalink: p.permalink_url } } });
      await q(db().from('posts').update(upd).eq('id', existing[0].id));
    } else {
      await q(db().from('posts').insert({
        client_id: acc.client_id, platforms: ['fb'], type: mapFbType(p.attachments?.data?.[0], p.status_type), caption: p.message || '',
        media: p.full_picture ? [{ url: p.full_picture, kind: 'image', external: true }] : [], scheduled_at: p.created_time,
        status: 'published', source: 'meta', fb_post_id: p.id, fb_target: target, results: { fb: { post_id: p.id, permalink: p.permalink_url } }, metrics: { fb: metrics }
      }));
    }
  });
  // posts scheduled outside the hub (Meta Business Suite). Read-only: Meta publishes them, never the hub.
  try {
    const sched = await graphAll(`/${acc.id}/scheduled_posts`, { fields: 'id,message,scheduled_publish_time,created_time,full_picture,attachments.limit(1){media_type,type}', limit: 50, access_token: token }, 3);
    const seen = [];
    for (const p of sched) {
      const spt = p.scheduled_publish_time;
      const at = spt == null ? null : new Date(typeof spt === 'number' || /^\d+$/.test(String(spt)) ? Number(spt) * 1000 : spt);
      if (!at || isNaN(at)) continue;
      seen.push(p.id);
      const row = { client_id: acc.client_id, platforms: ['fb'], type: mapFbType(p.attachments?.data?.[0]), caption: p.message || '',
        media: p.full_picture ? [{ url: p.full_picture, kind: 'image', external: true }] : [], scheduled_at: at.toISOString() };
      const ex = await q(db().from('posts').select('id,source,status').eq('fb_post_id', p.id));
      if (ex.length) { if (ex[0].source === 'meta' && ex[0].status === 'scheduled') await q(db().from('posts').update(row).eq('id', ex[0].id)); }
      else await q(db().from('posts').insert({ ...row, status: 'scheduled', source: 'meta', fb_post_id: p.id }));
    }
    // anything we imported earlier that Meta no longer lists (deleted or rescheduled away) and that hasn't gone live
    let del = db().from('posts').delete().eq('client_id', acc.client_id).eq('source', 'meta').eq('status', 'scheduled').contains('platforms', ['fb']).gt('scheduled_at', new Date(now).toISOString());
    if (seen.length) del = del.not('fb_post_id', 'in', `(${seen.join(',')})`);
    await q(del);
  } catch (e) { if (e instanceof MetaError && e.tokenDead) throw e; console.error('scheduled_posts', acc.id, e.message); }

  // attach shares made from this page onto originals owned by other managed pages
  for (const [origRowId, list] of Object.entries(sharesByOriginal)) {
    const orig = await q(db().from('posts').select('id,shares_out').eq('id', origRowId));
    if (!orig.length) continue;
    const keep = (orig[0].shares_out || []).filter(s => !list.some(n => n.share_id === s.share_id));
    await q(db().from('posts').update({ shares_out: keep.concat(list) }).eq('id', orig[0].id));
  }
}

async function syncInstagram(acc, opts = {}) {
  const token = acc.access_token, now = Date.now();
  const D = opts.days || 8, P = opts.postDays || 60, I = opts.insightDays || 35, back = !!opts.backfill;
  const info = await graph(`/${acc.id}`, { fields: 'followers_count,username,profile_picture_url', access_token: token });
  await q(db().from('accounts').update({ followers: info.followers_count || 0, username: info.username, picture_url: info.profile_picture_url || acc.picture_url }).eq('id', acc.id));

  const rows = {};
  addSeries(rows, 'reach', await seriesMetric(acc.id, ['reach'], D, token));
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

  const media = await graphAll(`/${acc.id}/media`, { fields: 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count,thumbnail_url,media_url', limit: 50, access_token: token }, back ? 6 : 2);
  await pMap(media, 5, async (m) => {
    const age = now - new Date(m.timestamp).getTime();
    if (age > P * DAY) return;
    const metrics = { likes: m.like_count || 0, comments: m.comments_count || 0, shares: 0, saves: 0, reach: null, views: null };
    if (age < I * DAY) {
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
  });
  if (back) await fillIgEngagement(acc, D);
}

/** Meta only gives daily IG engagement one day per call; for history, total it from that day's posts instead. */
async function fillIgEngagement(acc, days) {
  const since = new Date(Date.now() - days * DAY);
  const posts = await q(db().from('posts').select('scheduled_at,metrics').eq('client_id', acc.client_id).contains('platforms', ['ig']).eq('status', 'published').gte('scheduled_at', since.toISOString()));
  const byDay = {};
  for (const p of posts) { const m = p.metrics?.ig; if (!m) continue; const d = isoDay(p.scheduled_at); byDay[d] = (byDay[d] || 0) + (m.likes || 0) + (m.comments || 0) + (m.shares || 0) + (m.saves || 0); }
  const existing = await q(db().from('daily_stats').select('day,engagements').eq('account_id', acc.id).gte('day', isoDay(since)));
  const have = Object.fromEntries(existing.map(r => [r.day, r.engagements]));
  const rows = {};
  for (let t = since.getTime(); t < Date.now() - 3 * DAY; t += DAY) { const d = isoDay(t); if (have[d] == null) rows[d] = { engagements: byDay[d] || 0 }; }
  await upsertDaily(acc.id, rows);
}

export async function syncAccount(acc, opts = {}) {
  const all = await q(db().from('accounts').select('id,kind,client_id'));
  const managed = new Set(all.filter(a => a.kind === 'fb').map(a => a.id));
  try {
    if (acc.kind === 'fb') await syncFacebook(acc, managed, opts);
    else await syncInstagram(acc, opts);
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
  const active = (await q(db().from('clients').select('id').eq('active', true))).map(c => c.id);
  if (!active.length) return [];
  const accs = await q(db().from('accounts').select('*').in('client_id', active).neq('token_status', 'reconnect').or(`last_sync.is.null,last_sync.lt."${cutoff}"`).order('last_sync', { ascending: true, nullsFirst: true }).limit(n));
  const out = [];
  for (const a of accs) out.push(await syncAccount(a));
  return out;
}

export const BACKFILL = { days: 92, postDays: 92, insightDays: 92, backfill: true };
