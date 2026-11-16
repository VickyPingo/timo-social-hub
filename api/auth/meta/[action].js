import { isAuthed, stateToken, checkStateToken, requireAuth, body, fail } from '../../../lib/http.js';
import { V, graph, connectWithUserToken } from '../../../lib/meta.js';
function start(req, res) {
  if (!isAuthed(req)) { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
  const p = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: `${process.env.PUBLIC_URL}/api/auth/meta/callback`,
    state: stateToken(), response_type: 'code'
  });
  if (process.env.META_CONFIG_ID) p.set('config_id', process.env.META_CONFIG_ID);
  else p.set('scope', 'pages_show_list,pages_read_engagement,pages_read_user_content,pages_manage_posts,read_insights,business_management,instagram_basic,instagram_content_publish,instagram_manage_insights');
  res.writeHead(302, { Location: `https://www.facebook.com/${V}/dialog/oauth?${p}` });
  res.end();
}

const back = (res, msg) => { res.writeHead(302, { Location: '/?connect=' + encodeURIComponent(msg) + '#pages' }); res.end(); };
async function callback(req, res) {
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

async function token(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { token } = await body(req);
    if (!token || token.length < 20) return res.status(400).json({ error: 'Paste the access token from Graph API Explorer.' });
    res.status(200).json(await connectWithUserToken(token.trim()));
  } catch (e) { fail(res, e, 400); }
}
export default async function handler(req, res) {
  if (req.query.action === 'token') return token(req, res);
  if (req.query.action === 'start') return start(req, res);
  if (req.query.action === 'callback') return callback(req, res);
  res.status(404).end();
}
