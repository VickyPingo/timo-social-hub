import { isAuthed, stateToken } from '../../../lib/http.js';
import { V } from '../../../lib/meta.js';
export default function handler(req, res) {
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
