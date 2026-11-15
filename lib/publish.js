import { db, q } from './db.js';
import { graph, MetaError, markTokenDead } from './meta.js';

const isVideo = m => m.kind === 'video';

async function accountsFor(clientId) {
  const rows = await q(db().from('accounts').select('*').eq('client_id', clientId));
  return { fb: rows.find(a => a.kind === 'fb'), ig: rows.find(a => a.kind === 'ig') };
}

async function publishFacebook(post, acc) {
  const token = acc.access_token, page = acc.id, media = post.media || [];
  const msg = post.caption || undefined;
  const videos = media.filter(isVideo), images = media.filter(m => !isVideo(m));
  if (post.type === 'Story') throw new Error('Facebook Stories cannot be published through the API yet. Untick Facebook for Stories.');
  if (videos.length) {
    const r = await graph(`/${page}/videos`, { file_url: videos[0].url, description: msg, access_token: token }, 'POST');
    return { id: r.id, post_id: r.post_id || `${page}_${r.id}` };
  }
  if (images.length === 1) {
    const r = await graph(`/${page}/photos`, { url: images[0].url, message: msg, access_token: token }, 'POST');
    return { id: r.id, post_id: r.post_id || r.id };
  }
  if (images.length > 1) {
    const ids = [];
    for (const im of images.slice(0, 10)) {
      const r = await graph(`/${page}/photos`, { url: im.url, published: 'false', access_token: token }, 'POST');
      ids.push(r.id);
    }
    const params = { message: msg, access_token: token };
    ids.forEach((id, i) => { params[`attached_media[${i}]`] = { media_fbid: id }; });
    const r = await graph(`/${page}/feed`, params, 'POST');
    return { id: r.id, post_id: r.id };
  }
  const r = await graph(`/${page}/feed`, { message: msg, access_token: token }, 'POST');
  return { id: r.id, post_id: r.id };
}

async function createIgContainer(post, acc) {
  const ig = acc.id, token = acc.access_token, media = post.media || [];
  if (!media.length) throw new Error('Instagram needs an image or video.');
  const caption = post.caption || undefined;
  if (post.type === 'Story') {
    const m = media[0];
    return (await graph(`/${ig}/media`, { media_type: 'STORIES', [isVideo(m) ? 'video_url' : 'image_url']: m.url, access_token: token }, 'POST')).id;
  }
  if (media.length > 1) {
    const children = [];
    for (const m of media.slice(0, 10)) {
      const p = isVideo(m) ? { media_type: 'VIDEO', video_url: m.url } : { image_url: m.url };
      children.push((await graph(`/${ig}/media`, { ...p, is_carousel_item: 'true', access_token: token }, 'POST')).id);
    }
    return (await graph(`/${ig}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption, access_token: token }, 'POST')).id;
  }
  const m = media[0];
  if (isVideo(m)) return (await graph(`/${ig}/media`, { media_type: 'REELS', video_url: m.url, caption, access_token: token }, 'POST')).id;
  return (await graph(`/${ig}/media`, { image_url: m.url, caption, access_token: token }, 'POST')).id;
}

/** Returns 'done' | 'pending'. Throws on failure. */
async function stepInstagram(post, acc, results) {
  const r = results.ig = results.ig || {};
  if (!r.container) r.container = await createIgContainer(post, acc);
  const st = await graph(`/${r.container}`, { fields: 'status_code,status', access_token: acc.access_token });
  if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') { const c = r.container; delete r.container; throw new Error(`Instagram could not process the media (${st.status || st.status_code}). Container ${c}.`); }
  if (st.status_code !== 'FINISHED' && st.status_code !== 'PUBLISHED') return 'pending';
  const pub = await graph(`/${acc.id}/media_publish`, { creation_id: r.container, access_token: acc.access_token }, 'POST');
  r.id = pub.id;
  if (post.first_comment && post.type !== 'Story') {
    try { await graph(`/${pub.id}/comments`, { message: post.first_comment, access_token: acc.access_token }, 'POST'); }
    catch (e) { r.comment_error = e.message; }
  }
  try { const info = await graph(`/${pub.id}`, { fields: 'permalink', access_token: acc.access_token }); r.permalink = info.permalink; } catch {}
  return 'done';
}

async function processPost(post) {
  const results = { ...(post.results || {}) };
  const errors = [];
  let pending = false;
  const { fb, ig } = await accountsFor(post.client_id);
  const patch = {};

  if (post.platforms.includes('fb') && !(results.fb && results.fb.post_id)) {
    try {
      if (!fb) throw new Error('No Facebook page connected for this client.');
      const r = await publishFacebook(post, fb);
      results.fb = { ...r, at: new Date().toISOString() };
      patch.fb_post_id = r.post_id;
    } catch (e) {
      if (e instanceof MetaError && e.tokenDead && fb) await markTokenDead(fb.id, e);
      errors.push('Facebook: ' + e.message);
    }
  }
  if (post.platforms.includes('ig') && !(results.ig && results.ig.id)) {
    try {
      if (!ig) throw new Error('No Instagram account linked for this client.');
      const s = await stepInstagram(post, ig, results);
      if (s === 'pending') pending = true; else patch.ig_media_id = results.ig.id;
    } catch (e) {
      if (e instanceof MetaError && e.tokenDead && ig) await markTokenDead(ig.id, e);
      errors.push('Instagram: ' + e.message);
    }
  }
  const tooOld = Date.now() - new Date(post.scheduled_at).getTime() > 2 * 3600e3;
  if (pending && tooOld) { errors.push('Instagram: the video was still processing after 2 hours.'); pending = false; }

  Object.assign(patch, { results, updated_at: new Date().toISOString() });
  if (pending) { patch.status = 'publishing'; patch.error = errors.join(' · ') || null; }
  else if (errors.length) { patch.status = 'failed'; patch.error = errors.join(' · '); }
  else { patch.status = 'published'; patch.error = null; }
  await q(db().from('posts').update(patch).eq('id', post.id));
  return { id: post.id, status: patch.status, error: patch.error };
}

/** Publish everything that is due. Claims each post atomically so overlapping runs never double-post. */
export async function publishDue(limit = 6) {
  const now = new Date();
  const due = await q(db().from('posts').select('*').eq('status', 'scheduled').eq('source', 'hub').lte('scheduled_at', new Date(now.getTime() + 30e3).toISOString()).order('scheduled_at').limit(limit));
  const stale = new Date(now.getTime() - 50e3).toISOString();
  const pending = await q(db().from('posts').select('*').eq('status', 'publishing').lt('updated_at', stale).order('scheduled_at').limit(limit));
  const out = [];
  for (const p of due) {
    const claimed = await q(db().from('posts').update({ status: 'publishing', updated_at: now.toISOString() }).eq('id', p.id).eq('status', 'scheduled').select('id'));
    if (claimed.length) out.push(await processPost(p));
  }
  for (const p of pending) {
    const claimed = await q(db().from('posts').update({ updated_at: now.toISOString() }).eq('id', p.id).eq('status', 'publishing').lt('updated_at', stale).select('id'));
    if (claimed.length) out.push(await processPost(p));
  }
  return out;
}
