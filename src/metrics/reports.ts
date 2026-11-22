import { Store } from '../db/store.js';
import { addDays, localToUtc } from '../util/time.js';

export interface VariantStats { variant: string; sent: number; replies: number; positive: number; callsBooked: number; replyRate: number; positiveRate: number }
const POSITIVE = ['price', 'send_details', 'positive', 'who_is_this'];

/** Per-variant stats computed from the DB. Replies are counted once per lead. */
export function variantStats(store: Store, opts: { sinceIso?: string; untilIso?: string; groupBy?: 'variant' | 'city' | 'segment' } = {}): VariantStats[] {
  const key = opts.groupBy ?? 'variant'; const rows = store.db.all(`SELECT l.id lid, l.${key === 'variant' ? 'variant' : key} k, l.status st, l.first_sent_at fs FROM leads l WHERE l.first_sent_at IS NOT NULL ${opts.sinceIso ? 'AND l.first_sent_at>=?' : ''} ${opts.untilIso ? 'AND l.first_sent_at<?' : ''}`, ...(opts.sinceIso ? [opts.sinceIso] : []), ...(opts.untilIso ? [opts.untilIso] : []));
  const groups = new Map<string, { sent: number; replies: number; positive: number; calls: number }>();
  for (const r of rows) {
    const g = groups.get(r.k ?? '—') ?? { sent: 0, replies: 0, positive: 0, calls: 0 }; g.sent++;
    const cls = store.db.all("SELECT rc.category FROM reply_class rc JOIN messages m ON m.id=rc.message_id WHERE m.lead_id=?", r.lid);
    if (cls.length) g.replies++; if (cls.some((c) => POSITIVE.includes(c.category))) g.positive++; if (r.st === 'call_booked') g.calls++; groups.set(r.k ?? '—', g);
  }
  return [...groups.entries()].map(([variant, g]) => ({ variant, sent: g.sent, replies: g.replies, positive: g.positive, callsBooked: g.calls, replyRate: g.sent ? g.replies / g.sent : 0, positiveRate: g.sent ? g.positive / g.sent : 0 })).sort((a, b) => a.variant.localeCompare(b.variant));
}

export function buildDailySummary(store: Store, day: string): string {
  const s = store.settings(); const a = localToUtc(day, 0, s.timeZone).toISOString(), b = localToUtc(addDays(day, 1), 0, s.timeZone).toISOString();
  const cnt = (kinds: string[]) => Number(store.db.get(`SELECT COUNT(*) c FROM messages WHERE direction='out' AND state='sent' AND sent_at>=? AND sent_at<? AND kind IN (${kinds.map(() => '?').join(',')})`, a, b, ...kinds)!.c);
  const replies = store.db.all("SELECT rc.category, COUNT(*) c FROM reply_class rc JOIN messages m ON m.id=rc.message_id WHERE m.created_at>=? AND m.created_at<? GROUP BY rc.category", a, b);
  const failures = Number(store.db.get("SELECT COUNT(*) c FROM events WHERE type IN ('breaker_trip','crm_sync_dead','personalize_failed') AND at>=? AND at<?", a, b)!.c);
  const spendG = store.spendSince('google', a), spendA = store.spendSince('ai', a); const pool = store.leadsByStatus('message_ready').length;
  const booked = Number(store.db.get("SELECT COUNT(*) c FROM events WHERE type='status' AND json_extract(data,'$.to')='call_booked' AND at>=? AND at<?", a, b)!.c);
  return `📊 Magmafy outreach — ${day}\nNew messages: ${cnt(['first'])} · Follow-ups: ${cnt(['followup1', 'followup2', 'followup3'])}\nReplies: ${replies.reduce((n, r) => n + r.c, 0)}${replies.length ? ' (' + replies.map((r) => `${r.category} ${r.c}`).join(', ') + ')' : ''}\nCalls booked: ${booked} · Problems: ${failures}\nReady pool: ${pool} leads (${(pool / Math.max(1, s.newPerDay)).toFixed(1)} days)${pool < s.poolMinDays * s.newPerDay ? ' ⚠️ LOW' : ''}\nSpend today: Google $${spendG.toFixed(2)} · AI $${spendA.toFixed(2)}\nState: ${store.isPaused() ? 'PAUSED — ' + store.kvGet('pause_reason') : 'running'}`;
}

export function buildWeeklyReport(store: Store, untilDay: string): string {
  const s = store.settings(); const since = localToUtc(addDays(untilDay, -7), 0, s.timeZone).toISOString();
  const v = variantStats(store, { sinceIso: since }); const total = v.reduce((n, x) => n + x.sent, 0);
  const lines = v.map((x) => `Variant ${x.variant}: sent ${x.sent}, replies ${x.replies} (${(x.replyRate * 100).toFixed(0)}%), positive ${x.positive} (${(x.positiveRate * 100).toFixed(0)}%), calls ${x.callsBooked}`);
  const ready = v.length >= 2 && v.every((x) => x.sent >= 50);
  const tips: string[] = []; if (!ready) tips.push(`Not enough data to compare variants yet (need 50 sends each; now ${v.map((x) => x.variant + ':' + x.sent).join(' ')}). Do not change the copy yet.`);
  else { const best = [...v].sort((a, b) => b.positiveRate - a.positiveRate)[0]; tips.push(`Suggestion (not applied automatically): variant ${best.variant} has the higher positive-reply rate. Change ONE thing at a time.`); }
  const cities = variantStats(store, { sinceIso: since, groupBy: 'city' });
  return `📈 Weekly report to ${untilDay}\nTotal first messages: ${total}\n${lines.join('\n') || 'No sends yet.'}\nBy city: ${cities.map((c) => `${c.variant} ${c.replies}/${c.sent}`).join(' · ') || '—'}\n\n${tips.join('\n')}`;
}
