import type { Evidence } from '../db/store.js';
import { significant } from './arabic.js';
import { Store } from '../db/store.js';
import { BudgetGuard } from '../sourcing/places.js';
import { RetryableError, FatalError, withRetry, withTimeout } from '../util/errors.js';

export interface PersonalLineInput { businessName: string; segment: string; evidence: Pick<Evidence, 'id' | 'type' | 'snippet'>[]; excludeIds: string[]; avoidLines: string[]; maxWords: number }
export interface PersonalLineOutput { evidenceId: string; line: string }
export interface JudgeInput { message: string; personalLine: string | null; evidence: Pick<Evidence, 'id' | 'type' | 'snippet'>[]; ownerNameKnown: boolean }
export interface JudgeOutput { pass: boolean; fabricated: string[]; dialectOk: boolean; issues: string[] }
export interface ReplyClassInput { text: string; leadName: string; ourLastMessage: string | null }
export interface ReplyClassOutput { category: string; confidence: number }
export interface DraftReplyInput { category: string; text: string; leadName: string; ownerName: string | null; sourceNote: string }
/** All AI use goes through this port: faked in tests, Anthropic in production, an offline rule-based fallback for dry runs. */
export interface AiPort {
  personalLine(i: PersonalLineInput): Promise<PersonalLineOutput | null>;
  judge(i: JudgeInput): Promise<JudgeOutput>;
  classifyReply?(i: ReplyClassInput): Promise<ReplyClassOutput>;
}

const rank = (t: string) => ({ recent_update: 5, review: 4, review_pattern: 3, website_text: 2, rating: 1 } as Record<string, number>)[t] ?? 0;

/** Rule-based, fully grounded fallback (no network). Every line is built from the evidence text itself; several phrasings per type so lines can differ. */
const REVIEW_T = ['لاحظت إن عملاءكم في التقييمات يمدحون {t}.', 'قريت في تقييمات عملائكم مدحهم ل{t}.', 'واضح من تقييمات عملائكم رضاهم عن {t}.', 'عملاءكم يذكرون {t} في تقييماتهم، وهذا يفرح.', 'ما شاء الله، تقييمات عملائكم تذكر {t} بشكل لافت.', 'من تقييمات عملائكم يبان اهتمامكم ب{t}.', 'عجبني إن عملاءكم يذكرون {t} في تقييماتهم.', 'تقييمات عملائكم تتكلم عن {t}، وهذا يسعد.', 'ملاحظة حلوة في تقييمات عملائكم: {t}.'];
const PATTERN_T = ['ما شاء الله، تقييمات عملائكم تذكر {t}.', 'لفتني إن تقييمات عملائكم تتكرر فيها إشادة ب{t}.', 'تقييمات عملائكم تشيد ب{t}، وهذا شي نادر.', 'يبان من تقييمات عملائكم إن {t} عندكم مميز.', 'عملاءكم في التقييمات يشيدون ب{t}.'];
const UPDATE_T = ['شفت في موقعكم: {t}.', 'لفتني في موقعكم: {t}.', 'تابعت موقعكم وشفت: {t}.'];
const SITE_T = ['عجبني إن موقعكم يعرض {t}.', 'ما شاء الله، موقعكم يعرض {t}.', 'لفتني تنوع موقعكم، يعرض {t}.'];
const RATING_T = ['ما شاء الله، تقييمكم عالي على خرائط قوقل.', 'تقييمكم على خرائط قوقل يدل على ثقة عملائكم، ما شاء الله.'];
const THEMES: [RegExp, string][] = [[/تنوع|تشكيلة|خيارات/, 'تنوع التشكيلة'], [/توصيل/, 'سرعة التوصيل'], [/جودة|خامة|خامات|تصنيع/, 'جودة الخامات'], [/تعامل|خدمة|فريق/, 'حسن التعامل']];
const SKELETONS = [...REVIEW_T, ...PATTERN_T, ...UPDATE_T, ...SITE_T, ...RATING_T].flatMap((t) => t.split('{t}')).map((x) => x.trim()).filter((x) => x.length > 1).sort((a, b) => b.length - a.length); // longest first, so a short piece never eats part of a longer one
const fillT = (t: string, v: string) => t.replace('{t}', v);

export class OfflineAi implements AiPort {
  async personalLine(i: PersonalLineInput): Promise<PersonalLineOutput | null> {
    const cands = i.evidence.filter((e) => !i.excludeIds.includes(e.id)).sort((a, b) => rank(b.type) - rank(a.type));
    for (const e of cands) for (const line of this.linesFor(e)) if (!i.avoidLines.includes(line)) return { evidenceId: e.id, line };
    return null;
  }
  private linesFor(e: Pick<Evidence, 'type' | 'snippet'>): string[] {
    const s = e.snippet;
    if (e.type === 'review' || e.type === 'review_pattern') { const t = THEMES.find(([re]) => re.test(s)); if (!t) return []; return (e.type === 'review' ? REVIEW_T : PATTERN_T).map((x) => fillT(x, t[1])); }
    if (e.type === 'recent_update') { const core = s.replace(/[0-9٠-٩]+/g, '').split(/\s+/).slice(0, 9).join(' '); return core.length > 8 ? UPDATE_T.map((x) => fillT(x, core)) : []; }
    if (e.type === 'website_text' && s.startsWith('الموقع يعرض:')) { const c = s.replace('الموقع يعرض:', '').trim().split('،').slice(0, 3).join(' و'); return SITE_T.map((x) => fillT(x, c)); }
    if (e.type === 'rating') return RATING_T;
    return [];
  }
  /** Entailment for the offline writer: remove the fixed template words, check theme labels against their trigger words, and require every remaining word to occur in the evidence. */
  async judge(i: JudgeInput): Promise<JudgeOutput> {
    if (!i.personalLine) return { pass: true, fabricated: [], dialectOk: true, issues: [] };
    const evText = i.evidence.map((e) => e.snippet).join(' ');
    const ev = new Set<string>(); for (const w of significant(evText)) ev.add(w);
    let rest = i.personalLine; const unknown: string[] = [];
    for (const sk of SKELETONS) rest = rest.split(sk).join(' ');
    for (const [re, label] of THEMES) if (rest.includes(label)) { if (!re.test(evText)) unknown.push(label); rest = rest.split(label).join(' '); }
    for (const w of significant(rest)) if (!ev.has(w) && ![...ev].some((e) => e.includes(w) || w.includes(e))) unknown.push(w);
    return { pass: unknown.length === 0, fabricated: unknown, dialectOk: true, issues: unknown.length ? ['unsupported: ' + unknown.join(',')] : [] };
  }
}

/** Anthropic Messages API. The prompts forbid inventing facts; JSON in, JSON out; budget-guarded. */
export class AnthropicAi implements AiPort {
  constructor(private key: string, private model: string, private guard: BudgetGuard, private f: typeof fetch = fetch, private usdPerCall = 0.01) { if (!key) throw new Error('ANTHROPIC_API_KEY required'); }
  private async ask(system: string, user: string): Promise<any> {
    this.guard.check(this.usdPerCall);
    const res = await withRetry(async () => {
      let r: Response;
      try { r = await withTimeout(this.f('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': this.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: this.model, max_tokens: 600, system, messages: [{ role: 'user', content: user }] }) }), 30_000, 'anthropic'); }
      catch (e) { throw new RetryableError((e as Error).message); }
      if (r.status === 429 || r.status >= 500) throw new RetryableError('anthropic http ' + r.status);
      if (!r.ok) throw new FatalError('anthropic http ' + r.status);
      return r.json() as Promise<any>;
    });
    this.guard.record(this.usdPerCall, 'messages');
    const txt: string = res.content?.[0]?.text ?? ''; const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new RetryableError('AI returned no JSON');
    try { return JSON.parse(m[0]); } catch { throw new RetryableError('AI returned invalid JSON'); }
  }
  async personalLine(i: PersonalLineInput) {
    const sys = `You write ONE short personal sentence in natural Saudi/Gulf white-dialect Arabic for a first WhatsApp message to a furniture/decor business owner.
Rules: base it ONLY on ONE of the given evidence items; never add facts, numbers, prices, claims or criticism; positive and specific; at most ${i.maxWords} words; no emojis, no English, no links; do not copy review text verbatim, paraphrase naturally (e.g. "لاحظت إن عملاءكم يمدحون ..."). Output JSON only: {"evidenceId":"<id>","line":"<sentence>"} or {"evidenceId":null} if nothing is usable.`;
    const usr = JSON.stringify({ business: i.businessName, segment: i.segment, evidence: i.evidence.filter((e) => !i.excludeIds.includes(e.id)), avoidSimilarTo: i.avoidLines.slice(0, 15) });
    const r = await this.ask(sys, usr); return r?.evidenceId && r?.line ? { evidenceId: String(r.evidenceId), line: String(r.line).trim() } : null;
  }
  async judge(i: JudgeInput) {
    const sys = `You are a strict fact-checker and Arabic editor. Given a WhatsApp message, its personal line and the evidence items, decide: (1) does the evidence actually support EVERY factual statement in the personal line (entailment)? (2) is any fact, number, claim, price or criticism present that is not in the evidence? (3) is the Arabic natural Saudi/Gulf white dialect, polite and human (not machine-translated, no marketing jargon)? Output JSON only: {"pass":bool,"fabricated":[strings],"dialectOk":bool,"issues":[strings]}. pass=true only if entailed, nothing fabricated and dialectOk.`;
    const r = await this.ask(sys, JSON.stringify({ message: i.message, personalLine: i.personalLine, evidence: i.evidence, ownerNameKnown: i.ownerNameKnown }));
    return { pass: !!r.pass && r.dialectOk !== false && !(r.fabricated?.length), fabricated: r.fabricated ?? [], dialectOk: r.dialectOk !== false, issues: r.issues ?? [] };
  }
  async classifyReply(i: ReplyClassInput) {
    const sys = `Classify a WhatsApp reply from a business owner to our cold outreach. Categories: who_is_this, price, send_details, has_agency, later, not_interested, voice_or_call, positive, employee, opt_out, other. Output JSON only: {"category":"...","confidence":0..1}.`;
    const r = await this.ask(sys, JSON.stringify(i)); return { category: String(r.category ?? 'other'), confidence: Number(r.confidence ?? 0.5) };
  }
}
export class ScriptedAi implements AiPort {
  constructor(public lines: (PersonalLineOutput | null)[] = [], public judgeResults: JudgeOutput[] = []) {}
  calls = { line: 0, judge: 0 };
  async personalLine() { return this.lines[this.calls.line++] ?? null; }
  async judge() { return this.judgeResults[this.calls.judge++] ?? { pass: true, fabricated: [], dialectOk: true, issues: [] }; }
}
