import { describe, it, expect } from 'vitest';
import { Db } from '../src/db/db.js';
import { Store, Evidence } from '../src/db/store.js';
import { FakeClock } from '../src/util/clock.js';
import { validate, failed } from '../src/personalize/validators.js';
import { countWords } from '../src/personalize/arabic.js';
import { Personalizer } from '../src/personalize/personalizer.js';
import { OfflineAi, ScriptedAi } from '../src/personalize/ai.js';
import { firstNameOf } from '../src/personalize/parts.js';
import { goldenLeads, seedGolden } from './golden-fixtures.js';

const ev = (id: string, snippet: string): Evidence => ({ id, lead_id: 'x', type: 'review', snippet, source: 'google_places', source_url: null, captured_at: '', internal_only: true, expires_at: null });
const base = { kind: 'first' as const, personalLine: null, evidenceIds: [], evidence: [], ownerName: null, senderFirstName: 'أحمد', company: 'Magmafy', recentTexts: [] };
const vt = (text: string, extra: any = {}) => validate({ ...base, text, ...extra });

describe('validators: good and bad Arabic examples', () => {
  const good = 'السلام عليكم، معك أحمد من Magmafy.\nلاحظت إن عملاءكم يمدحون تنوع الكنب. نساعد معارض الأثاث توصلها طلبات أكثر من إعلانات السوشال وقوقل. تحب أرسل لك الفكرة في دقيقة؟';
  it('accepts a good message', () => {
    const e = ev('e1', 'ما شاء الله تنوع الكنب عندهم كبير والتعامل راقي');
    const r = vt(good, { personalLine: 'لاحظت إن عملاءكم يمدحون تنوع الكنب.', evidenceIds: ['e1'], evidence: [e] });
    expect(failed(r)).toEqual([]); expect(countWords(good)).toBeLessThan(40);
  });
  const bad: [string, string][] = [
    ['price', 'السلام عليكم، معك أحمد من Magmafy. نقدم باقة بسعر ممتاز لمعرضكم، تحب أرسل التفاصيل؟'],
    ['discount', 'السلام عليكم، معك أحمد من Magmafy. عندنا خصم خاص هذا الشهر، تحب أرسل لك؟'],
    ['link', 'السلام عليكم، معك أحمد من Magmafy. شوف موقعنا www.magmafy.com تحب نتكلم؟'],
    ['criticism', 'السلام عليكم، معك أحمد من Magmafy. صفحتكم ضعيفة وموقعكم قديم تحب نحسنه؟'],
    ['claim', 'السلام عليكم، معك أحمد من Magmafy. عملنا مع عشرات المعارض ونضمن لك نتائج، تحب نتكلم؟'],
    ['digits', 'السلام عليكم، معك أحمد من Magmafy. نزيد مبيعاتك 200% تحب نتكلم؟'],
    ['generic greeting', 'عزيزي المدير، معك أحمد من Magmafy. نساعد معارض الأثاث، تحب نتكلم؟'],
    ['english jargon', 'السلام عليكم، معك أحمد من Magmafy. We do SEO and branding for you, تحب نتكلم؟'],
    ['no question', 'السلام عليكم، معك أحمد من Magmafy. نساعد معارض الأثاث توصلها طلبات أكثر.'],
    ['too long', 'السلام عليكم معك أحمد من Magmafy ' + 'كلمة '.repeat(40) + '؟'],
    ['invented name', 'السلام عليكم أستاذ فهد، معك أحمد من Magmafy. نساعد معارض الأثاث، تحب نتكلم؟'],
    ['two emojis', 'السلام عليكم، معك أحمد من Magmafy 🌹🙏 تحب نتكلم؟'],
    ['no sender', 'السلام عليكم. نساعد معارض الأثاث توصلها طلبات، تحب نتكلم؟']
  ];
  for (const [n, t] of bad) it('rejects: ' + n, () => expect(vt(t).pass, n).toBe(false));
  it('allows the real owner name but not another', () => {
    expect(failed(vt('السلام عليكم أستاذ خالد، معك أحمد من Magmafy. تحب نتكلم؟', { ownerName: 'خالد العتيبي' }))).toEqual([]);
    expect(vt('السلام عليكم أستاذ فهد، معك أحمد من Magmafy. تحب نتكلم؟', { ownerName: 'خالد العتيبي' }).pass).toBe(false);
  });
  it('rejects a personal line the evidence does not support (fabrication)', () => {
    const e = ev('e1', 'التوصيل كان سريع جدا');
    const t = 'السلام عليكم، معك أحمد من Magmafy.\nشفت إنكم افتتحتم فرع جديد في جدة. نساعد معارض الأثاث. تحب نتكلم؟';
    expect(vt(t, { personalLine: 'شفت إنكم افتتحتم فرع جديد في جدة.', evidenceIds: ['e1'], evidence: [e] }).pass).toBe(false);
  });
  it('blocks near-duplicates and repeated personal lines', () => {
    const line = 'لاحظت إن عملاءكم يمدحون تنوع الكنب.'; const e = ev('e1', 'تنوع الكنب كبير');
    const t = `السلام عليكم، معك أحمد من Magmafy.\n${line} نساعد معارض الأثاث توصلها طلبات أكثر. تحب أرسل لك الفكرة؟`;
    expect(vt(t, { personalLine: line, evidenceIds: ['e1'], evidence: [e], recentTexts: [{ text: t }] }).pass).toBe(false);
    expect(vt(t, { personalLine: line, evidenceIds: ['e1'], evidence: [e], recentTexts: [{ text: 'مختلف تماما كلام ثاني هنا ما له علاقة', personalLine: line }] }).pass).toBe(false);
  });
});

describe('names', () => { it('keeps compound names', () => { expect(firstNameOf('خالد العتيبي')).toBe('خالد'); expect(firstNameOf('أبو فهد الشمري')).toBe('أبو فهد'); expect(firstNameOf('عبد الله القحطاني')).toBe('عبد الله'); expect(firstNameOf(null)).toBeNull(); }); });

describe('personalizer', () => {
  const mk = () => new Store(new Db(), new FakeClock(new Date('2026-12-01T08:00:00Z')));
  it('no evidence → needs_review by default (never fakes an observation)', async () => {
    const s = mk(); const l = s.createLead({ name: 'معرض', segment: 'furniture', place_id: 'p', phone: '+966551110000' }); s.transition(l.id, 'enriched', 't'); s.transition(l.id, 'qualified', 't');
    const r = await new Personalizer(s, new OfflineAi()).prepareFirst(l.id); expect(r.ok).toBe(false); expect(s.lead(l.id)!.status).toBe('needs_review');
  });
  it('regenerates when the judge or validators fail, then parks after N tries', async () => {
    const s = mk(); const l = s.createLead({ name: 'معرض', segment: 'furniture', place_id: 'p', phone: '+966551110000' }); s.transition(l.id, 'enriched', 't'); s.transition(l.id, 'qualified', 't');
    const e = s.addEvidence({ lead_id: l.id, type: 'review', snippet: 'ما شاء الله تنوع الكنب كبير والتعامل راقي جدا', source: 'google_places', source_url: null, internal_only: true, expires_at: null });
    const ai = new ScriptedAi([{ evidenceId: e.id, line: 'عملاءكم يمدحون سعر الكنب 200 ريال.' }, { evidenceId: e.id, line: 'لاحظت إن عملاءكم يمدحون تنوع الكنب.' }]);
    const r = await new Personalizer(s, ai).prepareFirst(l.id);
    expect(r.ok).toBe(true); expect(ai.calls.line).toBe(2);
    const ai2 = new ScriptedAi([{ evidenceId: e.id, line: 'لاحظت إن عملاءكم يمدحون تنوع الكنب.' }, { evidenceId: e.id, line: 'لاحظت إن عملاءكم يمدحون تنوع الكنب.' }, { evidenceId: e.id, line: 'لاحظت إن عملاءكم يمدحون تنوع الكنب.' }, { evidenceId: e.id, line: 'لاحظت إن عملاءكم يمدحون تنوع الكنب.' }], Array(8).fill({ pass: false, fabricated: ['x'], dialectOk: true, issues: ['not entailed'] }));
    const s2 = mk(); const l2 = s2.createLead({ name: 'معرض', segment: 'furniture', place_id: 'p', phone: '+966551110000' }); s2.transition(l2.id, 'enriched', 't'); s2.transition(l2.id, 'qualified', 't');
    s2.addEvidence({ lead_id: l2.id, type: 'review', snippet: 'تنوع الكنب', source: 'g', source_url: null, internal_only: true, expires_at: null });
    const r2 = await new Personalizer(s2, ai2).prepareFirst(l2.id); expect(r2.ok).toBe(false); expect(s2.lead(l2.id)!.status).toBe('needs_review');
  });
  it('idempotent: a second call returns the same stored message', async () => {
    const s = mk(); const l = s.createLead({ name: 'معرض', segment: 'furniture', place_id: 'p', phone: '+966551110000' }); s.transition(l.id, 'enriched', 't'); s.transition(l.id, 'qualified', 't');
    s.addEvidence({ lead_id: l.id, type: 'review', snippet: 'ما شاء الله تنوع الكنب كبير والتعامل راقي جدا', source: 'google_places', source_url: null, internal_only: true, expires_at: null });
    const p = new Personalizer(s, new OfflineAi()); const a = await p.prepareFirst(l.id); const b = await p.prepareFirst(l.id);
    expect(a.ok && b.ok && a.message.id === b.message.id).toBe(true);
  });
  it('follow-up 2 uses a DIFFERENT evidence item; with none left it falls back to a gentle reminder', async () => {
    const s = mk(); const l = s.createLead({ name: 'معرض', segment: 'furniture', place_id: 'p', phone: '+966551110000' }); s.transition(l.id, 'enriched', 't'); s.transition(l.id, 'qualified', 't');
    s.addEvidence({ lead_id: l.id, type: 'review', snippet: 'ما شاء الله تنوع الكنب كبير والتعامل راقي جدا', source: 'google_places', source_url: null, internal_only: true, expires_at: null });
    const p = new Personalizer(s, new OfflineAi()); const first = await p.prepareFirst(l.id); expect(first.ok).toBe(true);
    const f2a = await p.prepareFollowup(l.id, 'followup2'); expect(f2a.ok).toBe(true); if (f2a.ok) { expect(f2a.message.personal_line).toBeNull(); expect(f2a.message.text).not.toContain('تنوع الكنب'); }
    s.addEvidence({ lead_id: l.id, type: 'website_text', snippet: 'الموقع يعرض: كنب، ستائر، سجاد', source: 'website', source_url: 'https://x', internal_only: false, expires_at: null });
    const l2 = s.createLead({ name: 'معرض ٢', segment: 'furniture', place_id: 'p2', phone: '+966551110001' });
    expect(l2.id).not.toBe(l.id);
  });
  it('expired Google evidence is not used', async () => {
    const s = mk(); const l = s.createLead({ name: 'معرض', segment: 'furniture', place_id: 'p', phone: '+966551110000' }); s.transition(l.id, 'enriched', 't'); s.transition(l.id, 'qualified', 't');
    s.addEvidence({ lead_id: l.id, type: 'review', snippet: 'ما شاء الله تنوع الكنب كبير والتعامل راقي جدا', source: 'g', source_url: null, internal_only: true, expires_at: '2026-01-01T00:00:00Z' });
    expect((await new Personalizer(s, new OfflineAi()).prepareFirst(l.id)).ok).toBe(false);
  });
});

describe('GOLDEN SET (30 leads, offline AI): gate of Phase 3', () => {
  it('≥90% of leads that have evidence get a valid message, 0 fabrications, all distinct, A/B balanced, every message <40 words', async () => {
    const s = new Store(new Db(), new FakeClock(new Date('2026-12-01T08:00:00Z')));
    const ids = seedGolden(s, goodLeads()); const p = new Personalizer(s, new OfflineAi());
    let ok = 0, withEv = 0; const texts: string[] = [], lines: string[] = [], variants: Record<string, number> = { A: 0, B: 0 };
    for (const id of ids) {
      const hasEv = s.evidence(id).length > 0; if (hasEv) withEv++;
      const r = await p.prepareFirst(id);
      if (r.ok) { ok++; const m = r.message; texts.push(m.text); if (m.personal_line) lines.push(m.personal_line); variants[m.variant!]++; expect(countWords(m.text)).toBeLessThan(40); expect(m.text).toMatch(/[؟?]$/); expect(m.text).toContain('Magmafy'); expect((m.validator_results as any).judge.pass).toBe(true); }
      else expect(hasEv && r.reason !== 'needs_review').toBe(false);
    }
    expect(ids.length).toBe(30); expect(ok / withEv).toBeGreaterThanOrEqual(0.9);
    expect(new Set(texts).size).toBe(texts.length); expect(new Set(lines).size).toBeGreaterThan(texts.length * 0.5);
    expect(Math.abs(variants.A - variants.B)).toBeLessThanOrEqual(1);
    for (const l of lines) expect(l).not.toMatch(/[0-9]|ريال|خصم/);
  });
});
const goodLeads = () => goldenLeads();
