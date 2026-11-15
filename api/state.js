import { db, q, getSetting } from '../lib/db.js';
import { requireAuth, fail } from '../lib/http.js';
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const since = new Date(Date.now() - 200 * 864e5).toISOString();
    // Supabase returns at most 1,000 rows per request, so page through everything
    const all = async (make) => { const out = []; for (let from = 0; ; from += 1000) { const rows = await q(make().range(from, from + 999)); out.push(...rows); if (rows.length < 1000) return out; } };
    const [clients, accounts, posts, daily, user] = await Promise.all([
      all(() => db().from('clients').select('*').order('name').order('id')),
      all(() => db().from('accounts').select('id,kind,client_id,page_id,name,username,picture_url,token_status,token_error,followers,last_sync').order('id')),
      all(() => db().from('posts').select('id,client_id,platforms,type,caption,first_comment,media,scheduled_at,status,source,error,results,metrics,shares_out').gte('scheduled_at', since).order('scheduled_at').order('id')),
      all(() => db().from('daily_stats').select('account_id,day,reach,views,engagements,followers').gte('day', since.slice(0, 10)).order('account_id').order('day')),
      getSetting('meta_user')
    ]);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      clients, accounts, posts, daily, now: Date.now(),
      meta: user ? { name: user.name, connected_at: user.connected_at } : null,
      appId: process.env.META_APP_ID || null,
      ai: !!process.env.ANTHROPIC_API_KEY
    });
  } catch (e) { fail(res, e); }
}
