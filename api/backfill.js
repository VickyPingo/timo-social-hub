import { db, q } from '../lib/db.js';
import { requireAuth, fail } from '../lib/http.js';
import { syncAccount, BACKFILL } from '../lib/sync.js';
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const acc = await q(db().from('accounts').select('*').eq('id', req.query.id));
    if (!acc.length) return res.status(404).json({ error: 'Account not found' });
    res.status(200).json(await syncAccount(acc[0], BACKFILL));
  } catch (e) { fail(res, e); }
}
