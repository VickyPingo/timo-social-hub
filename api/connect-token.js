import { requireAuth, body, fail } from '../lib/http.js';
import { connectWithUserToken } from '../lib/meta.js';
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { token } = await body(req);
    if (!token || token.length < 20) return res.status(400).json({ error: 'Paste the access token from Graph API Explorer.' });
    res.status(200).json(await connectWithUserToken(token.trim()));
  } catch (e) { fail(res, e, 400); }
}
