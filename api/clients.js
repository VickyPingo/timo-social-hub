import { db, q, setSetting } from '../lib/db.js';
import { requireAuth, body, fail } from '../lib/http.js';
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const b = await body(req);
    // bulk show/hide: POST { ids: [...], active: false }
    if (req.method === 'POST' && Array.isArray(b.places)) {
      const places = b.places.slice(0, 100).map(p => ({ id: String(p.id || '').replace(/\D/g, '').slice(0, 25), name: String(p.name || '').trim().slice(0, 100) })).filter(p => p.id.length >= 6 && p.name);
      await setSetting('places', places);
      return res.status(200).json({ places });
    }
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
    if (b.contact && typeof b.contact === 'object') { let n = String(b.contact.whatsapp || '').replace(/\D/g, ''); if (n.startsWith('0')) n = '27' + n.slice(1); patch.contact = { whatsapp: n.slice(0, 15), whatsapp_text: String(b.contact.whatsapp_text || '').slice(0, 300) }; }
    if (Array.isArray(b.groups)) patch.groups = b.groups.slice(0, 60).map((g, i) => ({ id: String(g.id || ('g' + Date.now().toString(36) + i)).replace(/[^\w-]/g, '').slice(0, 30), name: String(g.name || '').trim().slice(0, 120), url: /^https:\/\/(www\.|m\.|web\.)?facebook\.com\//.test(String(g.url || '')) ? String(g.url).trim().slice(0, 300) : '' })).filter(g => g.name);
    const data = await q(db().from('clients').update(patch).eq('id', req.query.id).select('*'));
    res.status(200).json({ client: data[0] });
  } catch (e) { fail(res, e); }
}
