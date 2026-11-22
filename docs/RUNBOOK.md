# Runbook
**Golden rule:** at the first warning sign the system stops itself (breaker) and tells you on Telegram. It never resumes alone.
## Telegram commands
`/status /pause /resume /mode off|assisted|auto /skip <name> /dnc <phone> /tomorrow /replies /draft <id> /send <id> /handled <id> /done <id> /report /pair <phone>`
## If WhatsApp restricts or bans the number
1. Breaker trips (`restricted`/`logged_out`). Do NOT re-pair repeatedly. 2. `/mode assisted` (safe fallback: you tap wa.me links; no automation). 3. Appeal from the phone, stop all outreach for several days. 4. Consider a fresh dedicated SIM; warm-up restarts automatically (5/day). 5. Review what was sent last (admin page → last 20 messages).
## If the session logs out
Breaker `logged_out`. `/pair +9665…` → enter the 8-char code in WhatsApp → Linked devices → Link with phone number. Then `/resume`. If auth state is corrupted: restore `auth-YYYY-MM-DD.enc` (see Restore).
## If the CRM is down
Sending **fails closed** (the pre-send CRM check cannot pass) and CRM writes queue in the outbox (retry with backoff, per-lead order, idempotent). Nothing is lost. After recovery: `/status`; dead rows appear as alerts — check Apps Script quota / key / `OUTREACH_ENABLED`.
## If the number/uncertain-send alert appears
"I will NOT resend": open WhatsApp, see whether the message went out, then mark the lead by hand in the CRM; the system never retries an uncertain send.
## Restore drill (run once before go-live, then quarterly)
```bash
# on a clean machine: copy deploy/.env + latest backups
sqlite3 outreach-YYYY-MM-DD.sqlite 'pragma integrity_check; select count(*) from leads;'
node -e "import('./dist/ops/backup.js').then(m=>console.log(m.restoreAuthState('auth-YYYY-MM-DD.enc','/data/auth_state',process.env.BACKUP_PASSPHRASE)))"
cp outreach-YYYY-MM-DD.sqlite /data/outreach.sqlite && docker compose up -d
```
Automated drill in tests: `tests/ops.test.ts`. Backups: DB nightly (14 kept) + encrypted auth state; **copy them off the server** (rclone/S3) — not automated here (BLOCKERS B-12).
## Pilot checks (live, supervised; these cannot be tested without the real number)
Inbound from `@lid` JIDs matches the right lead; delivery receipts arrive (the breaker needs them); typing indicator works; `wasSent` echo file is written; reconnect behaviour; CRM timeline equals WhatsApp.
## Settings
All caps/windows/variants/ramp are rows in the `settings` table (admin page shows them; `Store.setSetting` validates).
