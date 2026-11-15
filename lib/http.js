import crypto from 'node:crypto';
const COOKIE = 'hub_session';
const DAYS = 30;
function sign(v) { return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'unset').update(v).digest('base64url'); }
export function makeSession() { const exp = String(Date.now() + DAYS * 864e5); return exp + '.' + sign(exp); }
export function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function isAuthed(req) {
  const m = (req.headers.cookie || '').match(new RegExp(COOKIE + '=([^;]+)'));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig) return false;
  const good = sign(exp);
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return false;
  return Number(exp) > Date.now();
}
export function requireAuth(req, res) {
  if (isAuthed(req)) return true;
  res.status(401).json({ error: 'Not logged in' });
  return false;
}
export function cronAuthed(req) {
  const k = req.headers['x-cron-key'] || '';
  const want = process.env.CRON_SECRET || '';
  return want.length > 10 && k.length === want.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want));
}
export async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}
export function fail(res, e, code = 500) {
  console.error(e);
  res.status(code).json({ error: e && e.message ? e.message : String(e) });
}
export function stateToken() { const t = String(Date.now()); return t + '.' + sign('oauth' + t); }
export function checkStateToken(s) {
  const [t, sig] = String(s || '').split('.');
  return !!t && sig === sign('oauth' + t) && Date.now() - Number(t) < 15 * 60e3;
}
