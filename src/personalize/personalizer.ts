import { Store, Lead, Message, MsgKind, Evidence } from '../db/store.js';
import { AiPort } from './ai.js';
import { validate, failed } from './validators.js';
import { GREET_NAMED, GREET_PLAIN, OFFERS, QUESTIONS, FOLLOW1, FOLLOW3, FOLLOW2_CLOSE, FOLLOW_GREET_NAMED, FOLLOW_GREET_PLAIN, firstNameOf, fill } from './parts.js';
import { hashString } from '../util/rng.js';
import { CrmSync } from '../crm/sync.js';
import { Logger, nullLogger } from '../util/log.js';

export type PrepResult = { ok: true; message: Message } | { ok: false; reason: string; reasons?: string[] };
const MAX_LINE_WORDS = 11;

export class Personalizer {
  constructor(private store: Store, private ai: AiPort, private sync?: CrmSync, private log: Logger = nullLogger) {}

  /** Balanced A/B: the variant with fewer first messages so far (ties → A). Disabled variants are never used. */
  assignVariant(): 'A' | 'B' | 'C' {
    const on = this.store.settings().enabledVariants; const cnt: Record<string, number> = { A: 0, B: 0, C: 0 };
    for (const r of this.store.db.all("SELECT variant, COUNT(*) c FROM messages WHERE direction='out' AND kind='first' AND variant IS NOT NULL AND state!='skipped' GROUP BY variant")) cnt[r.variant] = r.c;
    return [...on].sort((a, b) => cnt[a] - cnt[b] || a.localeCompare(b))[0] as 'A' | 'B' | 'C';
  }
  private usable(leadId: string): Evidence[] { const now = this.store.now(); return this.store.evidence(leadId).filter((e) => !e.expires_at || e.expires_at > now); }
  private recent() { return this.store.recentOutboundTexts(30).map((m) => ({ text: m.text, personalLine: m.personal_line })); }
  private vars(s: ReturnType<Store['settings']>) { return { me: s.sender.firstName, co: s.sender.company }; }

  async prepareFirst(leadId: string): Promise<PrepResult> {
    const lead = this.store.lead(leadId); if (!lead) return { ok: false, reason: 'no_lead' };
    const existing = this.store.outboundOf(lead.id, 'first'); if (existing && existing.state !== 'skipped') return { ok: true, message: existing };
    if (!['qualified', 'needs_review'].includes(lead.status)) return { ok: false, reason: 'bad_status:' + lead.status };
    if (lead.dnc || this.store.isDnc(lead.phone)) return { ok: false, reason: 'dnc' };
    if (!lead.phone) return { ok: false, reason: 'no_phone' };
    const s = this.store.settings(); const variant = lead.variant && s.enabledVariants.includes(lead.variant as any) ? (lead.variant as 'A' | 'B' | 'C') : this.assignVariant();
    const ev = this.usable(lead.id);
    if (!ev.length && s.noEvidenceFallback === 'needs_review') return this.park(lead, ['no_evidence']);
    const reasons: string[] = []; const avoid = this.recent().map((r) => r.personalLine).filter((x): x is string => !!x);
    const name = firstNameOf(lead.owner_name); const rot = hashString(lead.id);
    const recentTexts = this.recent();
    for (let attempt = 0; attempt <= s.maxRegenerations; attempt++) {
      let line: string | null = null; let evId: string | null = null;
      if (ev.length) {
        const out = await this.ai.personalLine({ businessName: lead.name, segment: lead.segment, evidence: ev, excludeIds: [], avoidLines: [...avoid, ...reasons.filter((r) => r.startsWith('line:')).map((r) => r.slice(5))], maxWords: MAX_LINE_WORDS });
        if (!out) { reasons.push('ai_no_line'); break; }
        line = out.line; evId = out.evidenceId; if (!ev.some((e) => e.id === evId)) { reasons.push('ai_bad_evidence_id'); continue; }
      } // else: plain fallback (no personal line)
      const combo = this.pickCombo(lead, variant, name, line, evId ? [evId] : [], ev, recentTexts, rot + attempt, s);
      if (!combo.ok) { reasons.push(...combo.reasons); if (line) reasons.push('line:' + line); continue; }
      const used = ev.filter((e) => e.id === evId);
      const judge = await this.ai.judge({ message: combo.text, personalLine: line, evidence: used, ownerNameKnown: !!name });
      if (!judge.pass) { reasons.push('judge:' + (judge.issues.join('; ') || 'failed')); if (line) reasons.push('line:' + line); continue; }
      const { msg } = this.store.createMessage({ lead_id: lead.id, kind: 'first', text: combo.text, state: 'ready', variant, personal_line: line, evidence_ids: evId ? [evId] : [], validator_results: { checks: combo.checks, parts: combo.parts, judge } });
      this.store.updateLead(lead.id, { variant }, 'personalizer');
      if (lead.status === 'needs_review') this.store.transition(lead.id, 'message_ready', 'personalizer', 'regenerated'); else this.store.transition(lead.id, 'message_ready', 'personalizer');
      this.enqueueUpsert(this.store.lead(lead.id)!, line, evId, variant);
      return { ok: true, message: msg };
    }
    return this.park(lead, reasons);
  }

  private pickCombo(lead: Lead, variant: 'A' | 'B' | 'C', name: string | null, line: string | null, evIds: string[], ev: Evidence[], recentTexts: { text: string; personalLine?: string | null }[], rot: number, s: ReturnType<Store['settings']>) {
    const v = this.vars(s); const recentSigs = new Set(this.store.recentOutboundTexts(30).map((m) => JSON.stringify((m.validator_results as any)?.parts ?? null)));
    const gs = name ? GREET_NAMED : GREET_PLAIN; const qs = QUESTIONS[variant]; let lastFail: string[] = ['no_combo'];
    const combos: [number, number, number][] = [];
    for (let g = 0; g < gs.length; g++) for (let o = 0; o < OFFERS.length; o++) for (let q = 0; q < qs.length; q++) combos.push([g, o, q]);
    for (let k = 0; k < combos.length; k++) {
      const [g, o, q] = combos[(rot + k * 7) % combos.length]; const parts = { g, o, q, variant };
      if (recentSigs.has(JSON.stringify(parts))) continue;
      const greet = fill(gs[g], { ...v, name: name ?? '' }); const body = [line, OFFERS[o](lead.segment), qs[q]].filter(Boolean).join(' ');
      const text = `${greet}\n${body}`;
      const r = validate({ text, kind: 'first', personalLine: line, evidenceIds: evIds, evidence: ev, ownerName: lead.owner_name, senderFirstName: s.sender.firstName, company: s.sender.company, recentTexts });
      if (r.pass) return { ok: true as const, text, checks: r.checks, parts };
      lastFail = failed(r);
      if (lastFail.some((x) => /overlaps_evidence|evidence_cited|no_price|no_criticism|no_claims|no_digits|no_link|no_english|same personal line/.test(x))) break; // the line itself is bad: regenerate it, don't shuffle parts
    }
    return { ok: false as const, reasons: lastFail };
  }

  async prepareFollowup(leadId: string, kind: 'followup1' | 'followup2' | 'followup3'): Promise<PrepResult> {
    const lead = this.store.lead(leadId); if (!lead) return { ok: false, reason: 'no_lead' };
    if (lead.dnc || this.store.isDnc(lead.phone)) return { ok: false, reason: 'dnc' };
    const existing = this.store.outboundOf(lead.id, kind); if (existing && existing.state !== 'skipped') return { ok: true, message: existing };
    const s = this.store.settings(); const name = firstNameOf(lead.owner_name); const greet = name ? fill(FOLLOW_GREET_NAMED, { name }) : FOLLOW_GREET_PLAIN;
    const rot = hashString(lead.id + kind); const recentTexts = this.recent();
    let line: string | null = null; let evIds: string[] = []; let used: Evidence[] = [];
    let text: string;
    if (kind === 'followup1') text = fill(FOLLOW1[rot % FOLLOW1.length], { greet });
    else if (kind === 'followup3') text = fill(FOLLOW3[rot % FOLLOW3.length], { greet });
    else {
      const prior = this.store.messagesOf(lead.id).filter((m) => m.direction === 'out').flatMap((m) => m.evidence_ids);
      const ev = this.usable(lead.id); const avoid = this.recent().map((r) => r.personalLine).filter((x): x is string => !!x);
      const out = ev.length ? await this.ai.personalLine({ businessName: lead.name, segment: lead.segment, evidence: ev, excludeIds: prior, avoidLines: avoid, maxWords: MAX_LINE_WORDS }) : null;
      const fresh = out && !prior.includes(out.evidenceId) && ev.some((e) => e.id === out.evidenceId) ? out : null;
      if (fresh) { line = fresh.line; evIds = [fresh.evidenceId]; used = ev.filter((e) => e.id === fresh.evidenceId); text = `${greet} ${line} ${FOLLOW2_CLOSE[rot % FOLLOW2_CLOSE.length]}`; }
      else text = fill(FOLLOW1[1], { greet }); // no second real observation: gentle reminder instead (plan §6.8)
    }
    const r = validate({ text, kind, personalLine: line, evidenceIds: evIds, evidence: used, ownerName: lead.owner_name, senderFirstName: s.sender.firstName, company: s.sender.company, recentTexts: [] });
    if (!r.pass) return { ok: false, reason: 'validation', reasons: failed(r) };
    if (line) { const j = await this.ai.judge({ message: text, personalLine: line, evidence: used, ownerNameKnown: !!name }); if (!j.pass) return { ok: false, reason: 'judge', reasons: j.issues }; }
    const { msg } = this.store.createMessage({ lead_id: lead.id, kind, text, state: 'ready', variant: lead.variant, personal_line: line, evidence_ids: evIds, validator_results: { checks: r.checks } });
    return { ok: true, message: msg };
  }

  private park(lead: Lead, reasons: string[]): PrepResult {
    if (lead.status === 'qualified') this.store.transition(lead.id, 'needs_review', 'personalizer', reasons.slice(0, 4).join(' | ').slice(0, 300));
    else this.store.updateLead(lead.id, { status_note: reasons.join(' | ').slice(0, 300) } as any, 'personalizer');
    this.store.event('personalize_failed', 'personalizer', lead.id, { reasons });
    return { ok: false, reason: 'needs_review', reasons };
  }
  private enqueueUpsert(lead: Lead, line: string | null, evId: string | null, variant: string) {
    if (!this.sync) return;
    const ev = evId ? this.store.evidenceByIds([evId])[0] : null;
    this.sync.enqueue(lead.id, { op: 'upsert', args: { placeId: lead.place_id!, business: lead.name, segment: lead.segment, city: lead.city ?? undefined, country: lead.country ?? undefined, phone: lead.phone, link: lead.website ?? (lead.instagram ? 'https://instagram.com/' + lead.instagram : null), ownerName: lead.owner_name, personalLine: line ?? '', personalSource: ev ? `${ev.type}:${ev.source}${ev.source_url ? ' ' + ev.source_url : ''}` : '', variant, quality: lead.score ?? undefined } }, 'up_' + lead.id);
  }
}
