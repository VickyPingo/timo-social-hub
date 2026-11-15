import { createClient } from '@supabase/supabase-js';
let client;
export function db() {
  if (!client) {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SECRET_KEY is not set in Vercel.');
    client = createClient(url, key, { db: { schema: 'social' }, auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}
export async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error('Database: ' + error.message);
  return data;
}
export async function getSetting(key) {
  const rows = await q(db().from('settings').select('value').eq('key', key));
  return rows[0] ? rows[0].value : null;
}
export async function setSetting(key, value) {
  await q(db().from('settings').upsert({ key, value }));
}
