import { Store } from '../db/store.js';
import { Planner } from '../planner/planner.js';
import { dayKey, addDays, localToUtc } from '../util/time.js';

const POSITIVE = ['price', 'send_details', 'positive', 'who_is_this'];
const NEGATIVE = ['opt_out', 'not_interested'];
const NEUTRAL = ['later', 'has_agency', 'employee', 'voice_or_call', 'other'];
export const REPLY_LABELS: Record<string, string> = { who_is_this: 'سأل من أنت', price: 'سأل عن السعر', send_details: 'طلب التفاصيل', positive: 'مهتم', later: 'لاحقًا', has_agency: 'عنده شركة', employee: 'موظف', voice_or_call: 'صوت/مكالمة', not_interested: 'غير مهتم', opt_out: 'طلب عدم التواصل', other: 'غير واضح' };
const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const J = (s: any, d: any) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

export class Stats {
  constructor(private store: Store, private planner: Planner) {}
  private tz() { return this.store.settings().timeZone; }
  private sinceIso(days: number | null) { if (!days) return '1970-01-01T00:00:00Z'; return localToUtc(addDays(dayKey(this.store.clock.now(), this.tz()), -(days - 1)), 0, this.tz()).toISOString(); }

  /** Cheap fingerprint: when it changes, connected dashboards refetch (real-time without polling the heavy queries). */
  version(): string {
    const d = this.store.db;
    const a = d.get('SELECT COALESCE(MAX(id),0) e FROM events')!.e, b = d.get('SELECT COUNT(*) c, COALESCE(MAX(rowid),0) m FROM messages')!, c = d.get("SELECT COUNT(*) c FROM plan_items WHERE state IN ('sent','dryrun','assisted','skipped')")!.c, p = this.store.isPaused() ? 1 : 0;
    return `${a}.${b.c}.${b.m}.${c}.${p}.${d.get('SELECT COUNT(*) c FROM crm_outbox WHERE state=\'pending\'')!.c}`;
  }

  overview(wa: string, mode: string) {
    const s = this.store.settings(); const day = dayKey(this.store.clock.now(), s.timeZone); const plan = this.planner.ensurePlan(day); const d = this.store.db;
    const a = localToUtc(day, 0, s.timeZone).toISOString(), b = localToUtc(addDays(day, 1), 0, s.timeZone).toISOString();
    const sentNew = this.planner.sentOn(day, ['first']), sentF = this.planner.sentOn(day, ['followup1', 'followup2', 'followup3']);
    const items = plan.items.map((i) => ({ id: i.id, at: i.target_at, kind: i.kind, state: i.state, lead: this.store.lead(i.lead_id)?.name ?? '', leadId: i.lead_id }));
    const last = d.get("SELECT MAX(sent_at) t FROM messages WHERE direction='out' AND state='sent'")?.t ?? null;
    return {
      now: this.store.now(), day, state: { paused: this.store.isPaused(), reason: this.store.kvGet('pause_reason') ?? '', breaker: this.store.kvGet('breaker') ?? null, mode, wa, warmupDay: plan.caps.rampIndex },
      today: { caps: plan.caps, sentNew, sentFollow: sentF, planned: items, left: items.filter((i) => i.state === 'planned').length, notes: J(d.get('SELECT notes FROM plans WHERE day=?', day)?.notes, []) },
      pool: { ready: this.store.leadsByStatus('message_ready').length, qualified: this.store.leadsByStatus('qualified').length, needsReview: this.store.leadsByStatus('needs_review').length, days: Math.round((this.store.leadsByStatus('message_ready').length / Math.max(1, s.newPerDay)) * 10) / 10, low: this.store.leadsByStatus('message_ready').length < s.poolMinDays * s.newPerDay },
      crm: { pending: Number(d.get("SELECT COUNT(*) c FROM crm_outbox WHERE state='pending'")!.c), dead: Number(d.get("SELECT COUNT(*) c FROM crm_outbox WHERE state='dead'")!.c) },
      spend: { google: this.store.spendSince('google', a), ai: this.store.spendSince('ai', a), caps: s.budgets },
      replies: { pending: Number(d.get('SELECT COUNT(*) c FROM reply_class WHERE handled=0')!.c), todayIn: Number(d.get("SELECT COUNT(*) c FROM messages WHERE direction='in' AND created_at>=? AND created_at<?", a, b)!.c) },
      lastSentAt: last, health: { failureStreak: this.store.kvGet<number>('failure_streak', 0) ?? 0, notOnWaStreak: this.store.kvGet<number>('not_on_wa_streak', 0) ?? 0, reconnects1h: (this.store.kvGet<number[]>('reconnects', []) ?? []).length }
    };
  }

  /** Per-day series for the chart. */
  series(days: number) {
    const s = this.store.settings(); const today = dayKey(this.store.clock.now(), s.timeZone); const out: { day: string; sent: number; followups: number; replies: number; positive: number; negative: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = addDays(today, -i); const a = localToUtc(day, 0, s.timeZone).toISOString(), b = localToUtc(addDays(day, 1), 0, s.timeZone).toISOString(); const d = this.store.db;
      const sent = (k: string) => Number(d.get(`SELECT COUNT(*) c FROM messages WHERE direction='out' AND state='sent' AND sent_at>=? AND sent_at<? AND kind ${k}`, a, b)!.c);
      const cls = d.all('SELECT rc.category c FROM reply_class rc JOIN messages m ON m.id=rc.message_id WHERE m.created_at>=? AND m.created_at<?', a, b).map((r) => r.c as string);
      out.push({ day, sent: sent("='first'"), followups: sent("LIKE 'followup%'"), replies: cls.length, positive: cls.filter((c) => POSITIVE.includes(c)).length, negative: cls.filter((c) => NEGATIVE.includes(c)).length });
    }
    return out;
  }

  funnel(days: number | null) {
    const since = this.sinceIso(days); const d = this.store.db; const n = (sql: string, ...p: any[]) => Number(d.get(sql, ...p)!.c);
    const discovered = n('SELECT COUNT(*) c FROM leads WHERE created_at>=?', since);
    const qualified = n("SELECT COUNT(*) c FROM leads WHERE created_at>=? AND tier IN ('A','B') AND status NOT IN ('rejected','too_big')", since);
    const ready = n("SELECT COUNT(DISTINCT lead_id) c FROM messages WHERE direction='out' AND kind='first' AND created_at>=?", since);
    const sent = n('SELECT COUNT(*) c FROM leads WHERE first_sent_at>=?', since);
    const replied = n("SELECT COUNT(DISTINCT l.id) c FROM leads l JOIN messages m ON m.lead_id=l.id AND m.direction='in' WHERE l.first_sent_at>=?", since);
    const positive = n(`SELECT COUNT(DISTINCT l.id) c FROM leads l JOIN messages m ON m.lead_id=l.id AND m.direction='in' JOIN reply_class rc ON rc.message_id=m.id WHERE l.first_sent_at>=? AND rc.category IN (${POSITIVE.map(() => '?').join(',')})`, since, ...POSITIVE);
    const booked = n("SELECT COUNT(*) c FROM leads WHERE first_sent_at>=? AND status='call_booked'", since);
    const steps = [{ key: 'discovered', label: 'تم اكتشافهم', n: discovered }, { key: 'qualified', label: 'مؤهلين (A/B)', n: qualified }, { key: 'ready', label: 'رسالة جاهزة', n: ready }, { key: 'sent', label: 'اتبعتلهم', n: sent }, { key: 'replied', label: 'ردّوا', n: replied }, { key: 'positive', label: 'ردّ إيجابي', n: positive }, { key: 'booked', label: 'حجزوا مكالمة', n: booked }];
    return steps.map((x, i) => ({ ...x, pctOfPrev: i ? rate(x.n, steps[i - 1].n) : 100, pctOfSent: i >= 3 ? rate(x.n, sent) : null }));
  }

  results(days: number | null) {
    const since = this.sinceIso(days); const d = this.store.db;
    const sentLeads = d.all('SELECT id, variant, city, segment, status, first_sent_at FROM leads WHERE first_sent_at>=?', since);
    const cls = d.all(`SELECT l.id lid, rc.category c, m.created_at at, m.text FROM reply_class rc JOIN messages m ON m.id=rc.message_id JOIN leads l ON l.id=m.lead_id WHERE l.first_sent_at>=? ORDER BY m.created_at`, since);
    const byLead = new Map<string, string[]>(); for (const r of cls) byLead.set(r.lid, [...(byLead.get(r.lid) ?? []), r.c]);
    const sent = sentLeads.length; const replied = byLead.size;
    const positive = [...byLead.values()].filter((v) => v.some((c) => POSITIVE.includes(c))).length;
    const negative = [...byLead.values()].filter((v) => v.some((c) => NEGATIVE.includes(c))).length;
    const optOut = [...byLead.values()].filter((v) => v.includes('opt_out')).length;
    const ignored = sentLeads.filter((l) => !byLead.has(l.id) && ['no_reply_closed', 'followup_3_sent'].includes(l.status)).length;
    const waiting = sentLeads.filter((l) => !byLead.has(l.id) && !['no_reply_closed', 'followup_3_sent', 'wrong_contact'].includes(l.status)).length;
    const booked = sentLeads.filter((l) => l.status === 'call_booked').length;
    // our response time: inbound → next reply we sent
    const gaps: number[] = []; for (const r of d.all("SELECT m.lead_id, m.created_at a, (SELECT MIN(o.sent_at) FROM messages o WHERE o.lead_id=m.lead_id AND o.direction='out' AND o.kind LIKE 'reply%' AND o.sent_at>m.created_at) b FROM messages m JOIN leads l ON l.id=m.lead_id WHERE m.direction='in' AND l.first_sent_at>=?", since)) if (r.b) gaps.push(Math.round((Date.parse(r.b) - Date.parse(r.a)) / 60000));
    const failures = Number(d.get("SELECT COUNT(*) c FROM messages WHERE direction='out' AND state IN ('failed','needs_review') AND created_at>=?", since)!.c);
    const wrong = Number(d.get("SELECT COUNT(*) c FROM leads WHERE first_sent_at IS NULL AND status='wrong_contact' AND created_at>=?", since)!.c);
    return { sent, replied, replyRate: rate(replied, sent), positive, positiveRate: rate(positive, sent), negative, negativeRate: rate(negative, sent), optOut, optOutRate: rate(optOut, sent), ignored, ignoredRate: rate(ignored, sent), waiting, booked, bookedRate: rate(booked, sent), medianResponseMin: median(gaps), failures, notOnWhatsapp: wrong, followupsSent: Number(d.get("SELECT COUNT(*) c FROM messages WHERE direction='out' AND state='sent' AND kind LIKE 'followup%' AND sent_at>=?", since)!.c) };
  }

  /** Why people answered the way they did: categories with wording, and splits by variant / city / segment / send hour. */
  reasons(days: number | null) {
    const since = this.sinceIso(days); const tz = this.tz();
    const rows = this.store.db.all(`SELECT rc.category c, m.text, m.created_at at, l.id lid, l.name, l.variant, l.city, l.segment, l.first_sent_at fs FROM reply_class rc JOIN messages m ON m.id=rc.message_id JOIN leads l ON l.id=m.lead_id WHERE l.first_sent_at>=? ORDER BY m.created_at DESC`, since);
    const total = rows.length; const cats = new Map<string, { n: number; examples: string[] }>();
    for (const r of rows) { const c = cats.get(r.c) ?? { n: 0, examples: [] }; c.n++; if (c.examples.length < 4) c.examples.push(r.text); cats.set(r.c, c); }
    const categories = [...cats.entries()].map(([k, v]) => ({ category: k, label: REPLY_LABELS[k] ?? k, tone: POSITIVE.includes(k) ? 'positive' : NEGATIVE.includes(k) ? 'negative' : 'neutral', n: v.n, pct: rate(v.n, total), examples: v.examples })).sort((a, b) => b.n - a.n);
    const sentBy = (key: 'variant' | 'city' | 'segment') => { const m = new Map<string, { sent: number; pos: number; neg: number; rep: number }>(); for (const l of this.store.db.all(`SELECT ${key} k, id FROM leads WHERE first_sent_at>=?`, since)) { const g = m.get(l.k ?? '—') ?? { sent: 0, pos: 0, neg: 0, rep: 0 }; g.sent++; const cs = rows.filter((r) => r.lid === l.id).map((r) => r.c as string); if (cs.length) g.rep++; if (cs.some((c) => POSITIVE.includes(c))) g.pos++; if (cs.some((c) => NEGATIVE.includes(c))) g.neg++; m.set(l.k ?? '—', g); } return [...m.entries()].map(([k, g]) => ({ key: k, sent: g.sent, replies: g.rep, positive: g.pos, negative: g.neg, replyRate: rate(g.rep, g.sent), positiveRate: rate(g.pos, g.sent), negativeRate: rate(g.neg, g.sent) })).sort((a, b) => b.sent - a.sent); };
    const hourOf = (iso: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)));
    const hours = new Map<string, { sent: number; rep: number; pos: number }>(); const replyLeads = new Set(rows.map((r) => r.lid)); const posLeads = new Set(rows.filter((r) => POSITIVE.includes(r.c)).map((r) => r.lid));
    for (const l of this.store.db.all('SELECT id, first_sent_at fs FROM leads WHERE first_sent_at>=?', since)) { const h = hourOf(l.fs); const k = h < 14 ? 'قبل الظهر' : 'بعد الظهر'; const g = hours.get(k) ?? { sent: 0, rep: 0, pos: 0 }; g.sent++; if (replyLeads.has(l.id)) g.rep++; if (posLeads.has(l.id)) g.pos++; hours.set(k, g); }
    const byWindow = [...hours.entries()].map(([k, g]) => ({ key: k, sent: g.sent, replies: g.rep, positive: g.pos, replyRate: rate(g.rep, g.sent), positiveRate: rate(g.pos, g.sent) }));
    const optOuts = rows.filter((r) => r.c === 'opt_out').slice(0, 20).map((r) => ({ lead: r.name, text: r.text, at: r.at, variant: r.variant, city: r.city }));
    const byVariant = sentBy('variant'), byCity = sentBy('city'), bySegment = sentBy('segment');
    return { total, categories, byVariant, byCity, bySegment, byWindow, optOuts, insights: this.insights(byVariant, byCity, bySegment, byWindow, categories, total) };
  }
  /** Plain-language reading of the numbers; only when the sample is big enough to mean something. */
  private insights(v: any[], c: any[], s: any[], w: any[], cats: any[], total: number): string[] {
    const out: string[] = []; const MIN = 20;
    if (total < 10) return ['لسه الردود قليلة (' + total + ') — الاستنتاجات تبدأ بعد حوالي 10 ردود، والمقارنة الجادة بعد 50 إرسال لكل نسخة.'];
    const top = (arr: any[], lab: string) => { const big = arr.filter((x) => x.sent >= MIN); if (big.length >= 2) { const best = [...big].sort((a, b) => b.positiveRate - a.positiveRate)[0], worst = [...big].sort((a, b) => b.negativeRate - a.negativeRate)[0]; out.push(`${lab}: الأفضل في الردود الإيجابية «${best.key}» (${best.positiveRate}%)` + (worst.negativeRate > 0 ? `، والأعلى في الرفض «${worst.key}» (${worst.negativeRate}%)` : '')); } };
    top(v, 'النسخة'); top(c, 'المدينة'); top(s, 'النشاط'); top(w, 'وقت الإرسال');
    const neg = cats.filter((x) => x.tone === 'negative'); const negPct = neg.reduce((n, x) => n + x.pct, 0); if (negPct >= 30) out.push(`نسبة الرفض/طلب عدم التواصل ${Math.round(negPct)}% من الردود — راجع نص الافتتاحية قبل ما تزوّد الحجم.`);
    const who = cats.find((x) => x.category === 'who_is_this'); if (who && who.pct >= 25) out.push('كتير بيسألوا «من أنت؟» — ممكن نضيف في الرسالة سطر أوضح عن مصدر الرقم.');
    const price = cats.find((x) => x.category === 'price'); if (price && price.pct >= 20) out.push('السؤال عن السعر متكرر — جهّز ردًا واضحًا يدفع لمكالمة.');
    if (!out.length) out.push('الأرقام متقاربة بين المجموعات — مفيش فرق واضح لحد دلوقتي.');
    return out;
  }

  /** Message quality: validator/judge status per message and which ingredients actually get replies. */
  quality(days: number | null) {
    const since = this.sinceIso(days); const d = this.store.db;
    const rows = d.all(`SELECT m.id, m.lead_id, m.variant, m.text, m.personal_line, m.evidence_ids, m.validator_results vr, m.sent_at, l.name, l.first_sent_at FROM messages m JOIN leads l ON l.id=m.lead_id WHERE m.direction='out' AND m.kind='first' AND m.state='sent' AND m.sent_at>=? ORDER BY m.sent_at DESC`, since);
    const cls = new Map<string, string[]>(); for (const r of d.all('SELECT m.lead_id lid, rc.category c FROM reply_class rc JOIN messages m ON m.id=rc.message_id')) cls.set(r.lid, [...(cls.get(r.lid) ?? []), r.c]);
    const evType = (ids: string[]) => this.store.evidenceByIds(ids)[0]?.type ?? 'none';
    const msgs = rows.map((r) => { const vr = J(r.vr, {}); const checks: { pass: boolean }[] = vr.checks ?? []; const replies = cls.get(r.lead_id) ?? []; const outcome = !replies.length ? 'no_reply' : replies.some((c) => POSITIVE.includes(c)) ? 'positive' : replies.some((c) => NEGATIVE.includes(c)) ? 'negative' : 'neutral';
      return { id: r.id, leadId: r.lead_id, lead: r.name, variant: r.variant, text: r.text, line: r.personal_line, words: r.text.split(/\s+/).length, checksPassed: checks.filter((c) => c.pass).length, checksTotal: checks.length, judgePass: vr.judge?.pass ?? null, evidence: evType(J(r.evidence_ids, [])), parts: vr.parts ?? null, outcome, replies, sentAt: r.sent_at }; });
    const group = (key: (m: (typeof msgs)[number]) => string) => { const g = new Map<string, { n: number; rep: number; pos: number; neg: number }>(); for (const m of msgs) { const k = key(m); const x = g.get(k) ?? { n: 0, rep: 0, pos: 0, neg: 0 }; x.n++; if (m.replies.length) x.rep++; if (m.outcome === 'positive') x.pos++; if (m.outcome === 'negative') x.neg++; g.set(k, x); } return [...g.entries()].map(([k, x]) => ({ key: k, sent: x.n, replyRate: rate(x.rep, x.n), positiveRate: rate(x.pos, x.n), negativeRate: rate(x.neg, x.n) })).sort((a, b) => b.sent - a.sent); };
    const EV: Record<string, string> = { review: 'تقييم عميل', review_pattern: 'نمط تقييمات', rating: 'تقييم خرائط', website_text: 'محتوى الموقع', recent_update: 'تحديث حديث', none: 'بدون' };
    const lines = (o: string) => msgs.filter((m) => m.outcome === o && m.line).slice(0, 5).map((m) => ({ line: m.line, lead: m.lead, variant: m.variant }));
    return { total: msgs.length, avgChecks: msgs.length ? Math.round((msgs.reduce((n, m) => n + (m.checksTotal ? m.checksPassed / m.checksTotal : 1), 0) / msgs.length) * 100) : null, judgePassRate: rate(msgs.filter((m) => m.judgePass).length, msgs.length), avgWords: msgs.length ? Math.round(msgs.reduce((n, m) => n + m.words, 0) / msgs.length) : null,
      byVariant: group((m) => m.variant ?? '—'), byEvidence: group((m) => EV[m.evidence] ?? m.evidence), byOpening: group((m) => (m.parts ? 'افتتاحية ' + (m.parts.g + 1) : '—')), byQuestion: group((m) => (m.parts ? 'سؤال ' + (m.parts.q + 1) : '—')),
      bestLines: lines('positive'), worstLines: lines('negative'), recent: msgs.slice(0, 30).map(({ parts, ...m }) => m), note: msgs.length < 50 ? 'عيّنة صغيرة — النِّسَب للاسترشاد فقط، والمقارنة الجادة بعد 50 رسالة لكل نسخة.' : null };
  }

  leads(q: { text?: string; status?: string; limit?: number; offset?: number }) {
    const w: string[] = ['1=1']; const p: any[] = [];
    if (q.text) { w.push('(l.name LIKE ? OR l.phone LIKE ? OR l.city LIKE ?)'); p.push(`%${q.text}%`, `%${q.text}%`, `%${q.text}%`); }
    if (q.status) { w.push('l.status=?'); p.push(q.status); }
    const rows = this.store.db.all(`SELECT l.id, l.name, l.city, l.segment, l.status, l.tier, l.score, l.variant, l.phone, l.first_sent_at, (SELECT MAX(COALESCE(m.sent_at,m.created_at)) FROM messages m WHERE m.lead_id=l.id) last_at, (SELECT rc.category FROM reply_class rc JOIN messages m ON m.id=rc.message_id WHERE m.lead_id=l.id ORDER BY m.created_at DESC LIMIT 1) last_reply, (SELECT COUNT(*) FROM messages m WHERE m.lead_id=l.id AND m.direction='out' AND m.state='sent') sent_n, (SELECT COUNT(*) FROM messages m WHERE m.lead_id=l.id AND m.direction='in') in_n FROM leads l WHERE ${w.join(' AND ')} ORDER BY (last_at IS NULL), last_at DESC LIMIT ? OFFSET ?`, ...p, Math.min(200, q.limit ?? 50), q.offset ?? 0);
    const total = Number(this.store.db.get(`SELECT COUNT(*) c FROM leads l WHERE ${w.join(' AND ')}`, ...p)!.c);
    return { total, rows };
  }
  statusCounts() { return this.store.db.all('SELECT status, COUNT(*) n FROM leads GROUP BY status ORDER BY n DESC'); }

  /** One lead, everything: the full conversation, evidence, classification, status history. Independent of the CRM. */
  conversation(leadId: string) {
    const l = this.store.lead(leadId); if (!l) return null; const d = this.store.db;
    const messages = this.store.messagesOf(leadId).map((m) => { const rc = d.get('SELECT category, confidence, suggested, handled, needs_eyes FROM reply_class WHERE message_id=?', m.id); const vr = m.validator_results as any;
      return { id: m.id, dir: m.direction, kind: m.kind.startsWith('reply') ? 'reply' : m.kind, state: m.state, text: m.text, line: m.personal_line, variant: m.variant, at: m.sent_at ?? m.created_at, scheduledAt: m.scheduled_at, waId: m.wa_message_id, delivery: m.delivery_status, failure: m.failure_reason, checks: vr?.checks ? { passed: vr.checks.filter((c: any) => c.pass).length, total: vr.checks.length } : null, judge: vr?.judge?.pass ?? null, reply: rc ? { category: rc.category, label: REPLY_LABELS[rc.category] ?? rc.category, confidence: rc.confidence, suggested: rc.suggested, handled: !!rc.handled, needsEyes: !!rc.needs_eyes } : null }; });
    const history = d.all("SELECT at, type, actor, data FROM events WHERE lead_id=? ORDER BY id", leadId).map((e) => ({ at: e.at, type: e.type, actor: e.actor, data: J(e.data, {}) }));
    return { lead: { id: l.id, name: l.name, segment: l.segment, city: l.city, country: l.country, phone: l.phone, website: l.website, instagram: l.instagram, owner: l.owner_name, status: l.status, note: l.status_note, tier: l.tier, score: l.score, breakdown: l.score_breakdown, variant: l.variant, dnc: l.dnc, dncReason: l.dnc_reason, rating: l.rating, reviewCount: l.review_count, crmId: l.crm_id, firstSentAt: l.first_sent_at, sources: l.sources }, evidence: this.store.evidence(leadId).map((e) => ({ id: e.id, type: e.type, snippet: e.snippet, source: e.source, url: e.source_url })), messages, history };
  }
}
export { POSITIVE, NEGATIVE, NEUTRAL };
