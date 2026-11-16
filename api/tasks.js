import { db, q } from '../lib/db.js';
import { requireAuth, body, fail } from '../lib/http.js';
const RECUR = [null, 'daily', 'weekdays', 'weekly', 'monthly'];
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const b = await body(req);
    switch (b.op) {
      case 'add': {
        const title = String(b.title || '').trim().slice(0, 300);
        if (!title) return res.status(400).json({ error: 'Type a task first.' });
        const row = { title, client_id: b.client_id || null, due_date: isDay(b.due_date) ? b.due_date : new Date().toISOString().slice(0, 10), recur: RECUR.includes(b.recur || null) ? (b.recur || null) : null };
        return res.status(200).json({ task: (await q(db().from('tasks').insert(row).select('*')))[0] });
      }
      case 'update': {
        const patch = {};
        if (b.title) patch.title = String(b.title).trim().slice(0, 300);
        if (b.client_id !== undefined) patch.client_id = b.client_id || null;
        if (isDay(b.due_date)) patch.due_date = b.due_date;
        if (b.recur !== undefined && RECUR.includes(b.recur || null)) patch.recur = b.recur || null;
        return res.status(200).json({ task: (await q(db().from('tasks').update(patch).eq('id', b.id).select('*')))[0] });
      }
      case 'delete':
        await q(db().from('tasks').update({ deleted: true }).eq('id', b.id));
        return res.status(200).json({ ok: true });
      case 'check': case 'uncheck': {
        const keys = (Array.isArray(b.keys) ? b.keys : [b.key]).map(String).filter(k => /^(task|share|auto):[\w:.\-]{1,200}$/.test(k)).slice(0, 100);
        if (!keys.length) return res.status(400).json({ error: 'Bad key' });
        if (b.op === 'check') await q(db().from('checks').upsert(keys.map(key => ({ key }))));
        else await q(db().from('checks').delete().in('key', keys));
        return res.status(200).json({ ok: true });
      }
      default: return res.status(400).json({ error: 'Unknown operation' });
    }
  } catch (e) { fail(res, e); }
}
