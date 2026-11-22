# DECISIONS — choices the plan left open (newest last)

| ID | Decision | Reason |
|---|---|---|
| D-01 | Outreach code lives in `outreach-system/` inside `Magmafy-CRM-source` (branch `claude/gracious-bohr-ia8a22`), not in a new repo. | The cloud session is scoped to one repository and may not create repos; losing the work if the container is reclaimed is worse than a temporary co-location. It shares nothing with the CRM build (own package.json, no imports either way). To split: `git subtree split -P outreach-system -b outreach-only` then push to `mrvoroo/magmafy-outreach`. |
| D-02 | Database = SQLite (`node:sqlite`, WAL) instead of Postgres. | Plan said Postgres was a suggestion. One process, one number, ~30 rows/day: SQLite is simpler, needs no extra container, backs up with a file copy, and is fully testable in-memory. All SQL goes through `Store`, so a Postgres adapter is a contained change. |
| D-03 | Job queue = a small in-process scheduler over DB state (plan items / outbox tables), not pg-boss. | No Postgres; all caps/plans are derived from the DB so a restart cannot double-send (plan §9.5). |
| D-04 | Baileys pinned to `@whiskeysockets/baileys@6.7.24` (npm `legacy` tag), behind an interface; installed as optionalDependency and only imported at runtime in Phase 5 code path. | `latest` is 7.0.0-rc14 (release candidate). A stable pinned line is safer for a ban-sensitive sender; bump deliberately after reading changelog. |
| D-05 | Sending is impossible unless env `SEND_ENABLED=true` AND settings `sendMode != off` AND not paused. Default env = safe. | Plan §0.3. |
| D-06 | Extra statuses `needs_review`, `too_big`, `rejected`, `parked` added to the plan's machine. | Needed for plan behaviours (park for review, too-big bucket, out-of-segment reject, no-WhatsApp parking). |
| D-07 | Google-derived data retention default = 30 days (`googleRetentionDays`), evidence from Places reviews gets `expires_at`; place_id kept permanently. | Plan §3.6 asked for a config value; I could not read the live Places terms offline (network allowlist). Conservative default; verify at deploy (BLOCKERS B-09). |
| D-08 | Model for AI = `claude-sonnet-5-5` default, configurable. | Cost/quality balance for 12 msgs/day. |
| D-09 | A lead is pushed to the CRM when it becomes `message_ready` (it has a personal line), not when merely discovered. | Keeps the CRM free of ~100 unmessaged rows; the plan's stage mapping still holds. |
| D-10 | Per-lead time zone and prayer times: windows are evaluated in the lead's country tz and city; a slot is only given to a lead for whom it is allowed. Default sending days Sat–Thu for all countries (Friday skipped). UAE weekend (Sat–Sun) not applied: showrooms trade at weekends — change `sendingDays` if wanted. | Plan said verify at build time. |
| D-11 | Prayer times computed in-process (NOAA solar position, Umm al-Qura: Fajr 18.5°, Isha = Maghrib+90). Buffers 10 min before / 25 after. | No external dependency; ±2 min covered by buffers. |
| D-12 | Catch-up: owed sends from missed days (after the first live send) are added at most +4/day, owed pool capped at 2 days' work; never during warm-up; total ceiling 18. | «No double batch». |
| D-13 | Items more than 90 min late are released (not sent late). Certain failures retry after 10–20 min; uncertain sends (timeout/drop after send) are NEVER retried: needs_review + alert. | Duplicate worse than delay. |
| D-14 | The AI only writes the ONE personal sentence; greeting/offer/question come from approved banks (`personalize/parts.ts`), so no unapproved claim can enter. All digits are banned in cold messages. | Honesty rules §7. |
| D-15 | Deterministic validators + AI judge both required; offline rule-based writer/judge exists for dry-runs and tests only. | Plan §6.4. |
| D-16 | Opt-out detection is regex code (Arabic+English), checked before every other class; opt-out also sends nothing automatically. | Plan §6.7. |
| D-17 | Breaker needs delivery receipts: 5 recent sends with none after 30 min trips it. Verify receipts arrive in the pilot (B-14). | Shadow-restriction signal. |
| D-18 | Reply messages are stored with kind `reply:<id>` (many per lead); CRM door accepts kind `reply` without counting an attempt. | Several replies per lead. |
| D-19 | SQLite DB backed up nightly with `sqlite backup`, auth state AES-256-GCM encrypted; off-server copy left to Ashraf. | No cloud credentials available. |

