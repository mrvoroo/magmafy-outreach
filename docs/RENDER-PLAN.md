# Deployment plan: Render (decided by Ashraf — to be executed on his word)

**Why Render:** ~$7/month, billed at the end of the month. **Status: planned, NOT started.**

## Target shape
- One **Web Service** (Docker runtime, built from this repo's `Dockerfile`), instance type **Starter** (always on — never the free tier, it sleeps and would drop WhatsApp).
- A **Persistent Disk** mounted at `/data` (SQLite DB, WhatsApp session, backups). Without a disk, every deploy wipes the WhatsApp session and the whole database — so the disk is mandatory (small extra cost, ~1 GB; verify current price).
- Exactly **1 instance** (WhatsApp allows one live session; a disk also means short downtime on each deploy — acceptable, deploy outside sending windows).
- HTTPS is provided by Render (no Caddy). Admin page behind the admin token (+ Cloudflare Access if a custom domain is used).
- Secrets = Render environment variables (never in the repo).

## Code/config changes needed (tonight)
1. Listen on Render's `PORT` env var, bind `0.0.0.0` (admin currently binds 127.0.0.1 on `ADMIN_PORT`).
2. `render.yaml` blueprint: service, disk (`/data`, 1 GB), env var names, health check path `/health`, region (closest to the Gulf available), auto-deploy OFF (manual deploys only).
3. Disable/ignore Caddy + compose files for this path (keep them as an alternative).
4. Backups: nightly job already writes to `/data/backups`; add an off-Render copy (needs a target — see below), because a disk is not a backup.
5. Outbound IP on Render is not fixed → restrict the Google Places key by **API only** (not by IP) + keep the budget cap.

## Steps for Ashraf (tonight, in order)
1. Render account → New → Blueprint → connect `mrvoroo/magmafy-outreach`.
2. Paste env vars (names in `.env.example`): `CRM_URL`, `CRM_OUTREACH_KEY`, `GOOGLE_PLACES_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, `ADMIN_BASIC_TOKEN`, `BACKUP_PASSPHRASE`. Leave `SEND_ENABLED=false` (dry run) until the GO-LIVE checklist is done.
3. Deploy → open `/health` → Telegram `/status`.
4. Then follow `docs/GO-LIVE.md` (sourcing, dry-run days, pairing, pilot).

## Still needed before this works end-to-end (unchanged blockers)
CRM door deployed (B-02), Google/Anthropic/Telegram keys (B-03…B-05), dedicated number (B-07), your go (B-08).

## Risks to remember
- Render can restart the service at any time: that is safe by design (intent-then-confirm, no blind retry), but the disk must be attached.
- Shared infrastructure + datacenter IP for WhatsApp: same ban-risk class as any VPS; warm-up and breaker stay mandatory.
- Verify Render's current prices/disk rules on the pricing page the night we start.
