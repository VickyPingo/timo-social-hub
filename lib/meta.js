import { db, q, setSetting } from './db.js';

export const V = process.env.META_GRAPH_VERSION || 'v25.0';
const BASE = `https://graph.facebook.com/${V}`;

export class MetaError extends Error {
  constructor(msg, code, sub) { super(msg); this.code = code; this.sub = sub; }
  get tokenDead() { return this.code === 190 || this.code === 102 || this.sub === 463 || this.sub === 460; }
}

/** Call the Graph API. params go in the query string for GET, form body for POST. */
export async function graph(path, params = {}, method = 'GET') {
  const url = new URL(path.startsWith('http') ? path : BASE + (path.startsWith('/') ? path : '/' + path));
  const opts = { method, headers: {} };
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
  if (method === 'GET') {
    for (const [k, v] of Object.entries(clean)) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  } else {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(clean)) form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    opts.body = form;
    opts.headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  let res, json;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, opts);
    json = await res.json().catch(() => ({}));
    const e = json.error;
    // transient errors: retry with backoff
    if (e && (e.is_transient || [1, 2, 4, 17, 341].includes(e.code)) && attempt < 2) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    break;
  }
  if (json.error) {
    const e = json.error;
    throw new MetaError(e.error_user_msg || e.message || 'Meta API error', e.code, e.error_subcode);
  }
  return json;
}

/** Follow paging.next up to maxPages. */
export async function graphAll(path, params, maxPages = 5) {
  let out = [], page = await graph(path, params), n = 1;
  out = out.concat(page.data || []);
  while (page.paging && page.paging.next && n < maxPages) { page = await graph(page.paging.next); out = out.concat(page.data || []); n++; }
  return out;
}

/** Try metric names in order; return the first that Meta accepts (names change between API versions). */
export async function firstMetric(id, candidates, params, token) {
  for (const m of candidates) {
    try {
      const r = await graph(`/${id}/insights`, { metric: m, access_token: token, ...params });
      if (r.data && r.data.length) return r.data[0];
    } catch (e) {
      if (e instanceof MetaError && e.tokenDead) throw e;
    }
  }
  return null;
}

export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40) || 'client';
}

/** Exchange a user token for a long-lived one, then store every Page + linked IG account it can manage. */
export async function connectWithUserToken(userToken) {
  const appId = process.env.META_APP_ID, secret = process.env.META_APP_SECRET;
  if (!appId || !secret) throw new Error('META_APP_ID or META_APP_SECRET is not set in Vercel.');
  let longToken = userToken;
  try {
    const ex = await graph('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: secret, fb_exchange_token: userToken });
    longToken = ex.access_token || userToken;
  } catch (e) { /* already long-lived or system user token */ }
  const me = await graph('/me', { fields: 'id,name', access_token: longToken });
  await setSetting('meta_user', { id: me.id, name: me.name, token: longToken, connected_at: new Date().toISOString() });

  const pages = await graphAll('/me/accounts', {
    fields: 'id,name,access_token,category,picture{url},followers_count,fan_count,instagram_business_account{id,username,profile_picture_url,followers_count}',
    limit: 100, access_token: longToken
  }, 10);

  const existingAcc = await q(db().from('accounts').select('id,client_id'));
  const accClient = Object.fromEntries(existingAcc.map(a => [a.id, a.client_id]));
  const clients = await q(db().from('clients').select('id,hue'));
  const usedIds = new Set(clients.map(c => c.id));
  let hueSeed = clients.length * 47;
  const summary = { pages: 0, instagram: 0 };

  for (const p of pages) {
    let clientId = accClient[p.id];
    if (!clientId) {
      let base = slugify(p.name), id = base, i = 2;
      while (usedIds.has(id)) id = `${base}-${i++}`;
      usedIds.add(id); clientId = id; hueSeed += 47;
      await q(db().from('clients').insert({ id, name: p.name, niche: p.category || '', hue: hueSeed % 360 }));
    }
    await q(db().from('accounts').upsert({
      id: p.id, kind: 'fb', client_id: clientId, name: p.name, picture_url: p.picture?.data?.url || null,
      access_token: p.access_token, token_status: 'ok', token_error: null,
      followers: p.followers_count ?? p.fan_count ?? 0
    }));
    summary.pages++;
    const ig = p.instagram_business_account;
    if (ig) {
      await q(db().from('accounts').upsert({
        id: ig.id, kind: 'ig', client_id: clientId, page_id: p.id, name: p.name, username: ig.username,
        picture_url: ig.profile_picture_url || null, access_token: p.access_token, token_status: 'ok', token_error: null,
        followers: ig.followers_count || 0
      }));
      summary.instagram++;
    }
  }
  return { user: me.name, ...summary };
}

export async function markTokenDead(accountId, err) {
  await q(db().from('accounts').update({ token_status: 'reconnect', token_error: String(err.message || err).slice(0, 300) }).eq('id', accountId));
}
