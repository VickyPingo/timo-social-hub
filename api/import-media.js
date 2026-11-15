import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { requireAuth, body, fail } from '../lib/http.js';

const MAX = 300 * 1024 * 1024;
// turn common share links into direct downloads
function direct(u) {
  let m = u.match(/drive\.google\.com\/file\/d\/([^/?#]+)/) || u.match(/drive\.google\.com\/open\?id=([^&#]+)/) || u.match(/drive\.google\.com\/uc\?(?:.*&)?id=([^&#]+)/);
  if (m) return `https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t`;
  if (/dropbox\.com\//.test(u)) { const x = new URL(u); x.searchParams.set('dl', '1'); return x.href; }
  if (/1drv\.ms|onedrive\.live\.com/.test(u)) return u + (u.includes('?') ? '&' : '?') + 'download=1';
  return u;
}
function blockedHost(h) {
  return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.internal') || h.endsWith('.local');
}
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { url } = await body(req);
    let u;
    try { u = new URL(String(url).trim()); } catch { return res.status(400).json({ error: 'Not a valid link' }); }
    if (!/^https?:$/.test(u.protocol) || blockedHost(u.hostname)) return res.status(400).json({ error: 'That link cannot be used' });
    // already in our bucket: reuse
    const ours = process.env.SUPABASE_URL && u.href.startsWith(process.env.SUPABASE_URL + '/storage/v1/object/public/social-media/');
    if (ours) return res.status(200).json({ url: u.href, kind: /\.(mp4|mov)$/i.test(u.pathname) ? 'video' : 'image' });

    const r = await fetch(direct(u.href), { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 TimoSocialHub' } });
    if (!r.ok) return res.status(400).json({ error: `Could not download the file (${r.status}). Check the link is shared publicly.` });
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^(image|video)\//.test(type)) return res.status(400).json({ error: type.includes('html') ? 'That link opens a web page, not the file. Share it as "anyone with the link" or use a direct download link.' : `Not an image or video (${type || 'unknown type'})` });
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX) return res.status(400).json({ error: 'File is larger than 300 MB' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX) return res.status(400).json({ error: 'File is larger than 300 MB' });
    const d = new Date();
    const path = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/import-${crypto.randomUUID()}.${EXT[type] || type.split('/')[1] || 'bin'}`;
    const st = db().storage.from('social-media');
    const { error } = await st.upload(path, buf, { contentType: type, upsert: false });
    if (error) throw error;
    res.status(200).json({ url: st.getPublicUrl(path).data.publicUrl, path, kind: type.startsWith('video') ? 'video' : 'image' });
  } catch (e) { fail(res, e); }
}
