import { requireAuth, body, fail } from '../lib/http.js';
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(400).json({ error: 'AI insights are not switched on (no ANTHROPIC_API_KEY).' });
  try {
    const { prompt } = await body(req);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 2000, messages: [{ role: 'user', content: String(prompt).slice(0, 40000) }] })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'AI request failed');
    const text = (j.content || []).map(c => c.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/);
    res.status(200).json(JSON.parse(m ? m[0] : text));
  } catch (e) { fail(res, e); }
}
