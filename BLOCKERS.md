# BLOCKERS — what only Ashraf can do (priority order)
Everything else is built and tested with fakes. Nothing below stops the build; each unlocks the next real-world step.

| # | What (plain steps) | Unlocks |
|---|---|---|
| B-02 | **Deploy the CRM door.** Paste changed `backend/Code.gs`, `backend/Crm.gs`, **new** `backend/Outreach.gs` into Apps Script, new version → follow `DEPLOY-CHECKLIST.md` §7 (run ① setup, run `outreachSetupKey`, copy the key ONCE, delete that log entry, later set `OUTREACH_ENABLED=نعم`). Also merge the branch's frontend (read-only Outreach card). | Real CRM mirroring |
| B-03 | Google Cloud: Places API (New) key restricted to server IP + budget alert (docs/SETUP.md §2). | Sourcing real leads |
| B-04 | Anthropic API key with a spend limit (separate key). | Real writer/judge/classifier (until then an offline rule-based writer is used; its output is only for dry-run) |
| B-05 | Telegram bot token + your numeric user id. | Alerts, pause/resume, reply approval |
| B-06 | (Replaced by B-15 — Render.) Cloudflare DNS is optional. | — |
| B-07 | Dedicated SIM/number ready (not locked), WhatsApp Business set up and used by hand for several days. | Phase-5 pairing |
| B-08 | **Say go** for pairing + `SEND_ENABLED=true` + `/mode auto` (after GO-LIVE checklist). The system never does this itself. | First real message |
| B-09 | Check current Google Places terms on stored fields; adjust `googleRetentionDays` (default 30). | Terms compliance |
| B-10 | Check Apps Script daily quotas for the agency Workspace account (expected far above need). | Confidence |
| B-11 | Review `docs/golden-set.md` (regenerate with the real AI first): ≥90% usable, zero fabrications. Review 30 sourced leads. | Go-live gate |
| B-12 | Off-server copy of `/data/backups` (rclone/S3/another VPS) — not automated. Run the restore drill once. | Disaster recovery |
| B-13 | Confirm Gulf cold-B2B / data-protection rules with a local advisor. | Legal |
| B-14 | Live pilot items that cannot be tested without the real number: see `docs/RUNBOOK.md` «Pilot checks». | Pilot sign-off |
| B-15 | Hosting decision: **Render** (Starter web service + persistent disk). Plan in `docs/RENDER-PLAN.md`; Claude implements the config tonight when Ashraf says go. | Replaces the VPS step B-06 |
| B-16 | Dashboard: BUILT (see PROGRESS.md). Speed work (timing metrics, batching) still waits for the Render deploy. | Visibility |
