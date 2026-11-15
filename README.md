# Timo Social Hub

Scheduling, overview, analytics and monthly Word reports for Timo Marketing's client Facebook and Instagram pages.

- `public/` dashboard (single page) and login page
- `api/` Vercel serverless functions
- `lib/` Meta Graph API, publisher and stats sync
- Database: `social` schema in the ClaimAppv2 Supabase project. Media in the public `social-media` bucket.
- Scheduler: Supabase pg_cron calls `/api/cron?job=publish` every 2 min and `/api/cron?job=sync` every 10 min (key in Supabase Vault).

## Environment variables (Vercel)

| Key | What |
|---|---|
| SUPABASE_URL | https://magmhrdbwpcfkibudtqj.supabase.co |
| SUPABASE_SECRET_KEY | Supabase secret key (sb_secret_…) |
| META_APP_ID | 1840947690577725 |
| META_APP_SECRET | Meta app secret |
| META_CONFIG_ID | optional: Facebook Login for Business configuration id |
| PUBLIC_URL | https://social.timomarketing.co.za |
| HUB_PASSWORD | password for logging in |
| SESSION_SECRET | random string |
| CRON_SECRET | must match the `social_hub_cron_key` vault secret |
| ANTHROPIC_API_KEY | optional: turns on "Write insights with AI" in Reports |
