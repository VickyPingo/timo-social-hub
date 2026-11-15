import { db, q } from '../lib/db.js';
import { requireAuth, body, fail } from '../lib/http.js';
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'PATCH') return res.status(405).end();
  try {
    const b = await body(req), patch = {};
    if (b.name) patch.name = String(b.name).slice(0, 80);
    if (b.niche !== undefined) patch.niche = String(b.niche).slice(0, 60);
    if (b.active !== undefined) patch.active = !!b.active;
    const data = await q(db().from('clients').update(patch).eq('id', req.query.id).select('*'));
    res.status(200).json({ client: data[0] });
  } catch (e) { fail(res, e); }
}
