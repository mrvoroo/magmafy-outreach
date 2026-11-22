# Magmafy Outreach System
Automatic, personal, honest WhatsApp outreach for furniture / decor / interior-furnishing businesses in the Gulf; every lead and message mirrors into the Magmafy CRM. Spec: `Magmafy_Outreach_System_Plan.md`. State of the build: `PROGRESS.md`. What needs a human: `BLOCKERS.md`.

```bash
npm install && npm run typecheck && npm test      # 140+ tests, all with fakes — no network, nothing is ever sent
npx tsx scripts/golden-report.ts                  # regenerates docs/golden-set.md for human review
```
**Safe by default:** with no secrets it runs on fakes in dry-run. A real WhatsApp send needs ALL of: `SEND_ENABLED=true`, a CRM key, `sendMode != off`, not paused, circuit breaker not tripped.

Layout: `src/{sourcing,enrich,qualify,personalize,planner,sender,inbox,followup,crm,control,metrics,ops}` — each external system (Google, WhatsApp, Anthropic, CRM, Telegram) is behind an interface with a fake in tests. Docs: `docs/RUNBOOK.md`, `docs/GO-LIVE.md`, `docs/SETUP.md`, `docs/PHASE0-REPORT.md`.
