import { isAuthed, checkStateToken } from '../../../lib/http.js';
import { graph, connectWithUserToken } from '../../../lib/meta.js';
const back = (res, msg) => { res.writeHead(302, { Location: '/?connect=' + encodeURIComponent(msg) + '#pages' }); res.end(); };
export default async function handler(req, res) {
  if (!isAuthed(req)) { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
  const { code, state, error_description } = req.query;
  if (error_description) return back(res, 'error');
  if (!checkStateToken(state)) return back(res, 'expired');
  try {
    const t = await graph('/oauth/access_token', {
      client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET,
      redirect_uri: `${process.env.PUBLIC_URL}/api/auth/meta/callback`, code
    });
    await connectWithUserToken(t.access_token);
    back(res, 'connected');
  } catch (e) { console.error(e); back(res, 'error'); }
}
