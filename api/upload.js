import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { requireAuth, body, fail } from '../lib/http.js';
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { name = 'file', type = '' } = await body(req);
    if (!/^(image|video)\//.test(type)) return res.status(400).json({ error: 'Only images and videos can be uploaded.' });
    const safe = String(name).toLowerCase().replace(/[^a-z0-9.\-_]/g, '-').slice(-60);
    const d = new Date();
    const path = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}-${safe}`;
    const st = db().storage.from('social-media');
    const { data, error } = await st.createSignedUploadUrl(path);
    if (error) throw error;
    const pub = st.getPublicUrl(path).data.publicUrl;
    res.status(200).json({ uploadUrl: data.signedUrl, path, publicUrl: pub, kind: type.startsWith('video') ? 'video' : 'image' });
  } catch (e) { fail(res, e); }
}
