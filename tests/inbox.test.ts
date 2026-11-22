import { describe, it, expect } from 'vitest';
import { classifyRules } from '../src/inbox/classify.js';
import { world } from './helpers.js';

describe('reply classification (Arabic + English, real-looking replies)', () => {
  const cases: [string, string][] = [
    ['من معي؟', 'who_is_this'], ['وش تبي؟', 'who_is_this'], ['من وين جبت رقمي', 'who_is_this'], ['كيف حصلت على رقمي؟', 'who_is_this'], ['who is this?', 'who_is_this'],
    ['كم السعر؟', 'price'], ['بكم الباقة', 'price'], ['كم تكلفة الإعلانات عندكم', 'price'], ['how much?', 'price'],
    ['ارسل التفاصيل', 'send_details'], ['ابشر أرسل', 'send_details'], ['تمام ارسل الفكرة', 'send_details'], ['ايوه', 'send_details'], ['yes send', 'send_details'],
    ['عندنا شركة تدير لنا الإعلانات', 'has_agency'], ['نتعامل مع وكالة', 'has_agency'], ['we have an agency already', 'has_agency'],
    ['بعدين', 'later'], ['تواصل معنا بعد رمضان', 'later'], ['الشهر الجاي إن شاء الله', 'later'], ['not now', 'later'],
    ['مو مهتم', 'not_interested'], ['لا شكرا', 'not_interested'], ['ما نحتاج', 'not_interested'], ['no thanks', 'not_interested'],
    ['لا تراسلوني', 'opt_out'], ['مو مهتم ولا تراسلوني', 'opt_out'], ['احذف رقمي', 'opt_out'], ['stop', 'opt_out'], ['STOP messaging me', 'opt_out'], ["don't message me again", 'opt_out'], ['شيلوني من القائمة', 'opt_out'], ['هذا سبام', 'opt_out'], ['ما ابي رسايل', 'opt_out'],
    ['أنا موظف، كلم المدير', 'employee'], ['المدير مو موجود', 'employee'],
    ['مهتم كلمني', 'positive'], ['ممتاز نتكلم', 'positive'], ['interested, call me', 'positive'],
    ['😂😂', 'other'], ['', 'other']
  ];
  for (const [t, c] of cases) it(`«${t}» → ${c}`, () => expect(classifyRules(t, 'text').category).toBe(c));
  it('voice notes and calls are their own class with high confidence', () => { for (const k of ['voice', 'call', 'missed_call']) expect(classifyRules(null, k)).toMatchObject({ category: 'voice_or_call', confidence: 0.99 }); });
  it('opt-out wins over every other signal', () => { expect(classifyRules('ارسل التفاصيل لكن لا تراسلوني بعدها', 'text').category).toBe('opt_out'); });
});

describe('inbox behaviour', () => {
  async function sentLead() {
    const w = await world(); await w.app.start(); await w.makeReady(3); await w.app.morning(); await w.runDay();
    const lead = w.store.allLeads().find((l) => l.status === 'first_message_sent')!; return { w, lead };
  }
  it('a reply stops the sequence immediately, alerts with suggested reply + original message, and is mirrored to the CRM', async () => {
    const { w, lead } = await sentLead(); const f = w.store.db.run("INSERT INTO messages(id,lead_id,direction,kind,text,state,created_at) VALUES ('fu1',?,'out','followup1','x','ready',?)", lead.id, w.store.now());
    void f; w.wa.emitInbound({ id: 'in1', from: lead.phone!.replace(/\D/g, ''), jid: 'x', text: 'كم السعر؟', kind: 'text', at: w.store.now() }); await w.settle();
    expect(w.store.lead(lead.id)!.status).toBe('replied'); expect(w.store.message('fu1')!.state).toBe('skipped');
    const a = w.tg.sent.find((s) => s.text.includes(lead.name))!; expect(a.text).toContain('price'); expect(a.text).toContain('Suggested reply'); expect(a.text).toContain('Personal line'); expect(a.urgent).toBe(true);
    await w.app.sync.flush(); expect(w.crm.leads.get(lead.crm_id!)!.log.some((x) => x.dir === 'in' && x.text === 'كم السعر؟')).toBe(true); expect(w.crm.leads.get(lead.crm_id!)!.stage).toBe('متفاعل');
  });
  it('opt-out: permanent DNC (local + CRM), nothing more ever planned, even if the lead is re-imported', async () => {
    const { w, lead } = await sentLead(); w.wa.emitInbound({ id: 'in2', from: lead.phone!.replace(/\D/g, ''), jid: 'x', text: 'مو مهتم ولا تراسلوني', kind: 'text', at: w.store.now() }); await w.settle();
    const l = w.store.lead(lead.id)!; expect(l.status).toBe('opted_out'); expect(l.dnc).toBe(true); expect(w.store.isDnc(lead.phone)).toBe(true);
    await w.app.sync.flush(); const c = w.crm.leads.get(lead.crm_id!)!; expect(c.dnc).toBe(true); expect(c.stage).toBe('غير مؤهل');
    expect(w.store.events(lead.id, 50).some((e) => e.type === 'opt_out')).toBe(true);
  });
  it('not interested → declined; has agency → reminder ~90d; later → reminder; employee/other stay replied', async () => {
    const w = await world(); await w.app.start(); await w.makeReady(5); await w.app.morning(); await w.runDay(); const leads = w.store.allLeads().filter((l) => l.status === 'first_message_sent').slice(0, 4);
    const say = async (l: any, id: string, t: string) => { w.wa.emitInbound({ id, from: l.phone.replace(/\D/g, ''), jid: 'x', text: t, kind: 'text', at: w.store.now() }); await w.settle(); };
    await say(leads[0], 'a', 'لا شكرا'); await say(leads[1], 'b', 'عندنا شركة تدير لنا'); await say(leads[2], 'c', 'بعدين'); await say(leads[3], 'd', 'أنا موظف');
    expect(w.store.lead(leads[0].id)!.status).toBe('declined'); expect(w.store.lead(leads[1].id)!.status).toBe('has_agency'); expect(w.store.lead(leads[2].id)!.status).toBe('later'); expect(w.store.lead(leads[3].id)!.status).toBe('replied');
    const rem = w.store.db.all('SELECT * FROM reminders'); expect(rem).toHaveLength(2); const ha = rem.find((r) => r.kind === 'has_agency')!; expect(Date.parse(ha.due_day) - Date.parse(w.today)).toBe(90 * 86400000);
    w.clock.advance(91 * 86400000); expect(w.app.inbox.dueReminders()).toBe(2); expect(w.app.inbox.dueReminders()).toBe(0);
  });
  it('voice notes / calls alert as urgent; low-confidence text says «needs your eyes»', async () => {
    const { w, lead } = await sentLead(); w.wa.emitInbound({ id: 'v1', from: lead.phone!.replace(/\D/g, ''), jid: 'x', text: null, kind: 'voice', at: w.store.now() }); await w.settle();
    expect(w.tg.sent.at(-1)!.urgent).toBe(true); expect(w.tg.sent.at(-1)!.text).toContain('voice_or_call');
    w.wa.emitInbound({ id: 'v2', from: lead.phone!.replace(/\D/g, ''), jid: 'x', text: '😂😂', kind: 'text', at: w.store.now() }); await w.settle(); expect(w.tg.sent.at(-1)!.text).toContain('needs your eyes');
  });
  it('duplicate delivery, groups, our own echoes and unknown numbers are handled safely', async () => {
    const { w, lead } = await sentLead(); const m = { id: 'dup', from: lead.phone!.replace(/\D/g, ''), jid: 'x', text: 'ارسل', kind: 'text' as const, at: w.store.now() };
    w.wa.emitInbound(m); w.wa.emitInbound(m); await w.settle(); expect(w.store.messagesOf(lead.id).filter((x) => x.direction === 'in')).toHaveLength(1);
    const n = w.tg.sent.length; w.wa.emitInbound({ id: 'g', from: '1203', jid: 'x@g.us', text: 'join', kind: 'group', at: '' }); w.wa.emitInbound({ id: 'e', from: m.from, jid: 'x', text: 'mine', kind: 'text', at: '', fromMe: true }); await w.settle(); expect(w.tg.sent.length).toBe(n);
    w.wa.emitInbound({ id: 'u', from: '966511111111', jid: 'x', text: 'hello', kind: 'text', at: '' }); await w.settle(); expect(w.tg.sent.at(-1)!.text).toContain('unknown number');
  });
  it('replies are NEVER sent automatically (AUTO_REPLY off); the owner approves with /draft then /send', async () => {
    const { w, lead } = await sentLead(); const before = w.wa.sent.length; w.wa.emitInbound({ id: 'q', from: lead.phone!.replace(/\D/g, ''), jid: 'x', text: 'من معي', kind: 'text', at: w.store.now() }); await w.settle(); expect(w.wa.sent.length).toBe(before);
    const inbound = w.store.messagesOf(lead.id).find((x) => x.direction === 'in')!; const r1 = await w.app.bot.handle('/draft ' + inbound.id, 'owner'); expect(r1).toContain('/send'); const replyId = r1!.split('/send ')[1].trim();
    w.clock.advance(60000); expect(await w.app.bot.handle('/send ' + replyId, 'owner')).toContain('Sent'); expect(w.wa.sent.length).toBe(before + 1); expect(w.wa.sent.at(-1)!.text).toContain('خرائط قوقل');
    expect(await w.app.bot.handle('/send ' + replyId, 'owner')).toContain('Sent'); expect(w.wa.sent.length).toBe(before + 1); // idempotent
  });
});

describe('control bot', () => {
  it('ignores everyone except the owner; pause/resume/mode/status/dnc/skip work', async () => {
    const w = await world(); await w.app.start(); await w.makeReady(5); await w.app.morning();
    expect(await w.app.bot.handle('/pause', 'stranger')).toBeNull(); expect(w.store.isPaused()).toBe(false);
    expect(await w.app.bot.handle('/pause', 'owner')).toContain('Paused'); expect(w.store.isPaused()).toBe(true); expect(await w.app.bot.handle('/status', 'owner')).toContain('PAUSED');
    expect(await w.app.bot.handle('/resume', 'owner')).toContain('Resumed'); expect(await w.app.bot.handle('/mode assisted', 'owner')).toContain('assisted'); expect(w.store.settings().sendMode).toBe('assisted'); expect(await w.app.bot.handle('/mode banana', 'owner')).toContain('Usage');
    const it = w.app.planner.items(w.today)[0]; const name = w.store.lead(it.lead_id)!.name; expect(await w.app.bot.handle('/skip ' + name, 'owner')).toContain('Skipped');
    expect(await w.app.bot.handle('/dnc +966 55 000 0001', 'owner')).toContain('never be messaged'); expect(w.store.isDnc('+966550000001')).toBe(true);
  });
});

describe('follow-ups', () => {
  it('day 2 / 5 / 9 from the first message, each once; stop on reply; close as no-reply after the final one', async () => {
    const w = await world(); await w.app.start(); await w.makeReady(2); await w.app.morning(); await w.runDay(); const lead = w.store.allLeads().find((l) => l.status === 'first_message_sent')!; const other = w.store.allLeads().filter((l) => l.status === 'first_message_sent')[1];
    const kinds: string[] = [];
    for (let d = 1; d <= 14; d++) { await w.nextDay(); await w.app.morning(); await w.runDay(); const sentNow = w.store.messagesOf(lead.id).filter((m) => m.direction === 'out' && m.state === 'sent').map((m) => m.kind); kinds.push(sentNow.join('+')); if (d === 4 && other) { w.wa.emitInbound({ id: 'r', from: other.phone!.replace(/\D/g, ''), jid: 'x', text: 'ارسل', kind: 'text', at: w.store.now() }); await w.settle(); } }
    expect(kinds[0]).toBe('first'); expect(kinds[1]).toBe('first+followup1'); expect(kinds[4]).toBe('first+followup1+followup2'); expect(kinds[8]).toBe('first+followup1+followup2+followup3');
    expect(w.store.lead(lead.id)!.status).toBe('no_reply_closed'); await w.app.sync.flush(); expect(w.crm.leads.get(lead.crm_id!)!.stage).toBe('خسرناه'); expect(w.crm.leads.get(lead.crm_id!)!.attempts).toBe(4);
    if (other) { expect(w.store.messagesOf(other.id).filter((m) => m.direction === 'out' && m.state === 'sent').map((m) => m.kind)).toEqual(['first', 'followup1']); expect(w.store.lead(other.id)!.status).toBe('replied'); }
    for (const l of w.store.allLeads()) { const sent = w.store.messagesOf(l.id).filter((m) => m.direction === 'out' && m.state === 'sent'); expect(new Set(sent.map((m) => m.kind)).size).toBe(sent.length); }
  });
});
