import { Store } from '../db/store.js';
import { Planner } from '../planner/planner.js';
import { Breaker } from '../sender/breaker.js';
import { Sender } from '../sender/sender.js';
import { Inbox } from '../inbox/inbox.js';
import { WhatsAppPort } from '../sender/port.js';
import { normalizePhone } from '../domain/phone.js';
import { buildDailySummary } from '../metrics/reports.js';
import { dayKey, addDays } from '../util/time.js';

export interface TelegramPort { send(text: string, o?: { urgent?: boolean }): Promise<void>; onText(cb: (text: string, fromId: string) => void): void }
export class FakeTelegram implements TelegramPort { sent: { text: string; urgent?: boolean }[] = []; cb: ((t: string, f: string) => void)[] = []; async send(text: string, o?: { urgent?: boolean }) { this.sent.push({ text, urgent: o?.urgent }); } onText(cb: (t: string, f: string) => void) { this.cb.push(cb); } say(text: string, from = '1') { this.cb.forEach((c) => c(text, from)); } }

/** Real Telegram Bot API (long polling). Only the owner's account id is ever obeyed; everyone else is ignored silently. */
export class HttpTelegram implements TelegramPort {
  private cbs: ((t: string, f: string) => void)[] = []; private offset = 0; private stopped = false;
  constructor(private token: string, private ownerId: string, private f: typeof fetch = fetch) { if (!token || !ownerId) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID required'); }
  onText(cb: (t: string, f: string) => void) { this.cbs.push(cb); }
  async send(text: string) { await this.f(`https://api.telegram.org/bot${this.token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: this.ownerId, text: text.slice(0, 3900) }) }); }
  async poll() {
    while (!this.stopped) {
      try {
        const r = await (await this.f(`https://api.telegram.org/bot${this.token}/getUpdates?timeout=25&offset=${this.offset}`)).json() as any;
        for (const u of r.result ?? []) { this.offset = u.update_id + 1; const t = u.message?.text; const from = String(u.message?.from?.id ?? ''); if (t) this.cbs.forEach((c) => c(t, from)); }
      } catch { await new Promise((r) => setTimeout(r, 5000)); }
    }
  }
  stop() { this.stopped = true; }
}

export interface BotDeps { store: Store; planner: Planner; breaker: Breaker; sender: Sender; inbox: Inbox; wa: WhatsAppPort; ownerId: string; pair?: (digits: string) => Promise<string> }
/** The control surface: pause, resume, status, mode switch, skip, DNC, tomorrow, replies, report, approve a drafted reply. */
export class ControlBot {
  constructor(private d: BotDeps) {}
  async handle(text: string, fromId: string): Promise<string | null> {
    if (fromId !== this.d.ownerId) return null; // strangers get nothing, not even an error
    const [cmd, ...rest] = text.trim().split(/\s+/); const arg = rest.join(' '); const { store, planner } = this.d; const s = store.settings();
    switch (cmd.toLowerCase().replace(/@.*$/, '')) {
      case '/status': {
        const day = planner.today(); const p = planner.ensurePlan(day); const sentNew = planner.sentOn(day, ['first']), sentF = planner.sentOn(day, ['followup1', 'followup2', 'followup3']);
        return `Mode: ${this.d.sender.mode()} (setting ${s.sendMode}) · ${store.isPaused() ? '⏸ PAUSED (' + store.kvGet('pause_reason') + ')' : '▶️ running'} · WhatsApp: ${this.d.wa.status()}\nToday ${day}: new ${sentNew}/${p.caps.newCap}, follow-ups ${sentF}/${p.caps.followCap}, planned left ${p.items.filter((i) => i.state === 'planned').length}\nWarm-up day ${p.caps.rampIndex} · ready pool ${store.leadsByStatus('message_ready').length}\nPending replies: ${this.d.inbox.pending().length}`;
      }
      case '/pause': store.setPaused(true, 'manual pause', 'owner'); return '⏸ Paused. Nothing will be sent.';
      case '/resume': { const r = this.d.breaker.resume('owner', this.d.wa.status() === 'open'); return r.ok ? '▶️ Resumed (warm-up restarted if it was a breaker stop).' : `Cannot resume: ${r.reason}`; }
      case '/mode': { if (!['off', 'assisted', 'auto'].includes(arg)) return 'Usage: /mode off|assisted|auto'; store.setSetting('sendMode', arg, 'owner'); return `Send mode = ${arg}${arg !== 'off' && this.d.sender.mode() === 'off' ? ' (but SEND_ENABLED is not true on the server, so it is still a dry run)' : ''}`; }
      case '/skip': { const q = arg.toLowerCase(); const day = planner.today(); const it = planner.items(day).find((i) => i.state === 'planned' && (i.id === arg || store.lead(i.lead_id)!.name.toLowerCase().includes(q))); return it && planner.skipItem(it.id, 'owner_skip') ? `Skipped ${store.lead(it.lead_id)!.name}` : 'No such planned item'; }
      case '/dnc': { const p = normalizePhone(arg, s.country); if (!p) return 'Usage: /dnc +9665XXXXXXXX'; store.addDnc(p.e164, 'owner', 'manual'); const l = store.leadByAnyPhone(p.e164); if (l) { store.updateLead(l.id, { dnc: true, dnc_reason: 'manual' }, 'owner'); this.d.inbox.stopSequence(l.id, 'dnc'); } return `🚫 ${p.e164} will never be messaged.`; }
      case '/tomorrow': { const t = addDays(planner.today(), 1); const caps = planner.caps(t); return `Tomorrow ${t}: new cap ${caps.newCap} (warm-up day ${caps.rampIndex}), follow-up cap ${caps.followCap}. Ready leads: ${store.leadsByStatus('message_ready').length}.`; }
      case '/replies': { const p = this.d.inbox.pending(5); return p.length ? p.map((r) => `• ${store.lead(r.lead_id)!.name}: ${r.category} — «${String(r.text).slice(0, 80)}»  (/handled ${r.message_id})`).join('\n') : 'No pending replies.'; }
      case '/handled': this.d.inbox.markHandled(arg); return 'Marked handled.';
      case '/send': { const r = await this.d.sender.sendReply(arg, 'owner'); if (r.ok) this.d.inbox.markHandled(String(store.db.get("SELECT id FROM messages WHERE id=?", arg)?.id)); return r.ok ? '✅ Sent.' : `Not sent: ${r.reason}`; }
      case '/draft': { /* /draft <inboundMessageId> → turns the suggested reply into a sendable reply message */ const rc = store.db.get('SELECT rc.*, m.lead_id FROM reply_class rc JOIN messages m ON m.id=rc.message_id WHERE rc.message_id=?', arg); if (!rc?.suggested) return 'No suggested reply.'; const { msg } = store.createMessage({ lead_id: rc.lead_id, kind: 'reply', text: rc.suggested, state: 'ready' }); return `Draft ready: /send ${msg.id}`; }
      case '/replied': { // assisted mode: WhatsApp is on your phone, so tell the system what the client answered:  /replied <name or phone> | <their text>
        const [who, ...t] = arg.split('|'); const text = t.join('|').trim(); if (!who.trim() || !text) return 'Usage: /replied <name or phone> | <what they wrote>';
        const q = who.trim().toLowerCase(); const lead = store.allLeads().find((l) => l.first_sent_at && (l.name.toLowerCase().includes(q) || (l.phone ?? '').replace(/\D/g, '').endsWith(q.replace(/\D/g, '')) && /\d{5,}/.test(q)));
        if (!lead?.phone) return 'No sent lead matches that name/phone.';
        const r = await this.d.inbox.handle({ id: 'manual-' + Date.now(), from: lead.phone.replace(/\D/g, ''), jid: '', text, kind: 'text', at: store.now() }); return r.matched ? `Recorded reply from «${lead.name}» (${r.category}). Follow-ups stopped.` : 'Not recorded.'; }
      case '/done': return this.d.sender.confirmAssisted(arg) ? '✅ Recorded as sent.' : 'Nothing to confirm.';
      case '/report': return buildDailySummary(store, planner.today());
      case '/pair': { if (!this.d.pair) return 'Pairing is not available.'; const p = normalizePhone(arg, s.country); if (!p) return 'Usage: /pair +9665XXXXXXXX (the dedicated outreach number)'; return `Pairing code (enter in WhatsApp → Linked devices → Link with phone number): ${await this.d.pair(p.digits)}`; }
      case '/help': case '/start': return '/status /pause /resume /mode off|assisted|auto /skip <name> /dnc <phone> /tomorrow /replies /handled <id> /draft <id> /send <id> /done <id> /replied <name> | <text> /report /pair <phone>';
      default: return null;
    }
  }
  wire(tg: TelegramPort) { tg.onText(async (t, f) => { const r = await this.handle(t, f); if (r) await tg.send(r); }); }
}
export { dayKey };
