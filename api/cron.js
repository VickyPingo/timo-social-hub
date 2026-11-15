import { cronAuthed, fail } from '../lib/http.js';
import { publishDue } from '../lib/publish.js';
import { syncStalest } from '../lib/sync.js';
export default async function handler(req, res) {
  if (!cronAuthed(req)) return res.status(401).json({ error: 'Bad cron key' });
  try {
    const job = req.query.job || 'publish';
    if (job === 'publish') return res.status(200).json({ published: await publishDue() });
    if (job === 'sync') return res.status(200).json({ synced: await syncStalest(4, 120) });
    res.status(400).json({ error: 'Unknown job' });
  } catch (e) { fail(res, e); }
}
