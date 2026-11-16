import { db, q } from '../lib/db.js';
import { requireAuth, body, fail } from '../lib/http.js';
const TYPES = ['Feed post', 'Reel', 'Story', 'Carousel'];
const EDITABLE = ['draft', 'scheduled', 'failed'];
function clean(p) {
  const out = {};
  if (p.platforms) out.platforms = p.platforms.filter(x => x === 'fb' || x === 'ig');
  if (p.type) { if (!TYPES.includes(p.type)) throw new Error('Unknown post type'); out.type = p.type; }
  if (p.caption !== undefined) out.caption = String(p.caption).slice(0, 63206);
  if (p.first_comment !== undefined) out.first_comment = String(p.first_comment).slice(0, 2200);
  if (p.media) out.media = p.media.slice(0, 10).map(m => ({ url: String(m.url), path: m.path || null, kind: m.kind === 'video' ? 'video' : 'image' }));
  if (p.scheduled_at) { const t = new Date(p.scheduled_at); if (isNaN(t)) throw new Error('Bad date'); out.scheduled_at = t.toISOString(); }
  if (p.cta !== undefined) out.cta = p.cta && (p.cta.whatsapp || p.cta.messenger) ? { whatsapp: !!p.cta.whatsapp, messenger: !!p.cta.messenger, text: String(p.cta.text || '').slice(0, 300) } : null;
  if (p.status) { if (!['draft', 'scheduled'].includes(p.status)) throw new Error('Bad status'); out.status = p.status; }
  return out;
}
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const b = await body(req);
    if (req.method === 'POST') {
      const rows = (b.posts || []).map(p => ({ client_id: p.client_id, ...clean(p), source: 'hub' }));
      if (!rows.length) return res.status(400).json({ error: 'Nothing to save' });
      const data = await q(db().from('posts').insert(rows).select('*'));
      return res.status(200).json({ posts: data });
    }
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const cur = await q(db().from('posts').select('status,results,source').eq('id', id));
    if (!cur.length) return res.status(404).json({ error: 'Post not found' });
    if (cur[0].source === 'meta') return res.status(409).json({ error: 'This post was scheduled in Meta Business Suite. Edit or delete it there.' });
    if (req.method === 'PATCH') {
      if (!EDITABLE.includes(cur[0].status) && !b.retry) return res.status(409).json({ error: 'This post is already published or publishing.' });
      const patch = clean(b);
      patch.updated_at = new Date().toISOString();
      if (b.retry || cur[0].status === 'failed') patch.error = null;
      const data = await q(db().from('posts').update(patch).eq('id', id).select('*'));
      return res.status(200).json({ post: data[0] });
    }
    if (req.method === 'DELETE') {
      if (!EDITABLE.includes(cur[0].status)) return res.status(409).json({ error: 'Published posts are deleted on Facebook/Instagram directly.' });
      await q(db().from('posts').delete().eq('id', id));
      return res.status(200).json({ ok: true });
    }
    res.status(405).end();
  } catch (e) { fail(res, e); }
}
