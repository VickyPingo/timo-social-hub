import { db, q } from '../lib/db.js';
import { requireAuth, body, fail } from '../lib/http.js';
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const b = await body(req);
    // bulk show/hide: POST { ids: [...], active: false }
    if (req.method === 'POST') {
      const ids = (b.ids || []).map(String).slice(0, 200);
      if (!ids.length) return res.status(400).json({ error: 'No pages selected' });
      await q(db().from('clients').update({ active: !!b.active }).in('id', ids));
      return res.status(200).json({ ok: true, count: ids.length });
    }
    if (req.method !== 'PATCH') return res.status(405).end();
    const patch = {};
    if (b.name) patch.name = String(b.name).slice(0, 80);
    if (b.niche !== undefined) patch.niche = String(b.niche).slice(0, 60);
    if (b.active !== undefined) patch.active = !!b.active;
    const data = await q(db().from('clients').update(patch).eq('id', req.query.id).select('*'));
    res.status(200).json({ client: data[0] });
  } catch (e) { fail(res, e); }
}
