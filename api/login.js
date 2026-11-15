import crypto from 'node:crypto';
import { makeSession, sessionCookie, body } from '../lib/http.js';
export default async function handler(req, res) {
  if (req.method === 'DELETE' || req.query.logout) { res.setHeader('Set-Cookie', sessionCookie('', 0)); return res.status(200).json({ ok: true }); }
  if (req.method !== 'POST') return res.status(405).end();
  const want = process.env.HUB_PASSWORD || '';
  const { password = '' } = await body(req);
  await new Promise(r => setTimeout(r, 400)); // slow down guessing
  const a = crypto.createHash('sha256').update(String(password)).digest(), b = crypto.createHash('sha256').update(want).digest();
  if (!want || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'That password is not right.' });
  res.setHeader('Set-Cookie', sessionCookie(makeSession(), 30 * 86400));
  res.status(200).json({ ok: true });
}
