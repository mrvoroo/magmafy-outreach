# Plan: standalone admin dashboard + speed work (after the Render deploy)
**Status: planned, NOT started.** Order: (1) Render deploy works, (2) this plan. Requested by Ashraf.

## A. Outreach Admin Dashboard (separate from the CRM)
Purpose: one place to follow the outreach system on its own, with clear numbers, live. The CRM card and everything already in the CRM stay exactly as they are (nothing removed).
**Where:** served by the outreach service itself (replaces the minimal admin page), same token + (optional) Cloudflare Access. Real data only, straight from the outreach database.
**Screens**
1. **Live overview** — today's plan vs sent, next planned sends, system state (running / paused / breaker + reason), WhatsApp connection, mode, warm-up day, ready-lead pool, CRM sync queue, spend today (Google/AI). Updates in real time (server-sent events), no refresh.
2. **Funnel & progress** — discovered → qualified → message ready → sent → replied → positive → call booked, per day/week/city/segment/variant.
3. **Results** — reply rate, ignored (no reply after the whole sequence), opt-out requests, declined, positive replies (asked price / details / agreed to talk) and negatives, calls booked, time from reply to Ashraf's answer, send failures, number-health signals.
4. **Reasons analysis** — breakdown of every reply category and of opt-outs/declines with the actual wording and counts; patterns by time window, city, segment, variant, personal-line type (review / website / rating).
5. **Message quality rating** — per message: validators passed, judge verdict, whether it got a reply, positive or negative outcome; ranking of best/worst personal lines and openers; A/B comparison with sample sizes (no verdict before 50 each).
6. **Conversations** — pick any lead: the full thread (our exact messages, replies, classification, drafts, the evidence behind the personal line, status history). Searchable/filterable list. Reply approval (/send) from here too.
7. **Control** — pause/resume, mode, settings editor, skip lead, do-not-contact, reminders, alerts log.
**Rules:** read-mostly; every action is logged; no secrets or other leads' data exposed; Arabic/English UI, RTL.

## B. Speed (everything faster on the server)
- SQLite in WAL with the right indexes and cached prepared statements; summary tables / materialised daily counters so dashboards don't scan messages.
- Replace per-lead scans (`allLeads().find`) with indexed lookups (phone → lead, wa id → message); batch queries in morning/follow-up jobs.
- Parallelise safe I/O (enrichment fetches per host-polite, Places pages, AI calls for lead lines) while keeping per-host rate limits and one-send-at-a-time for WhatsApp.
- Prepare messages ahead (pool already ≥ 3 days) so send time is only the WhatsApp call; keep the WhatsApp socket warm.
- Faster reply alerts: inbound handler does stop-sequence + Telegram alert first, CRM sync/AI classification after (alert within ~1 s).
- CRM sync: batch outbox rows per lead into fewer Apps Script calls (Apps Script is the slow part), keep ≤ 1 call/s, queue never blocks sending (already fails-closed only on the pre-send check — add a short cache for the control check).
- Measure first: add timing metrics (p50/p95 per job) shown on the dashboard; set budgets and fix what exceeds them.
**Hard limits that stay:** human-like send gaps, caps, warm-up and breaker are NOT sped up — they protect the number.

## Order of work (when Ashraf says go, after the Render deploy)
1. Timing metrics + indexes + lookup fixes (B, quick wins).
2. Dashboard backend (aggregations + SSE) → screens 1, 6, 2.
3. Results/reasons/quality screens (3, 4, 5).
4. Control screen, polish, tests (unit + a seeded demo dataset), deploy.
