/**
 * Baileys (unofficial WhatsApp Web protocol) adapter — the ONLY file that imports it, and only when connect() runs (Phase 5).
 * Pinned in package.json (see DECISIONS D-04). NOT exercised by the unit tests (they use FakeWhatsApp); it must be verified in
 * the supervised live pilot (docs/RUNBOOK.md §Pilot checks). Auth state lives on the server volume in AUTH_STATE_DIR.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InboundWa, WaEvent, WaSendError, WaStatus, WhatsAppPort } from './port.js';
import { Logger, nullLogger } from '../util/log.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BaileysWhatsApp implements WhatsAppPort {
  private sock: any = null; private st: WaStatus = 'closed'; private inCb: ((m: InboundWa) => void)[] = []; private evCb: ((e: WaEvent) => void)[] = [];
  private echoFile: string;
  constructor(private authDir: string, private log: Logger = nullLogger) { mkdirSync(authDir, { recursive: true }); this.echoFile = join(authDir, 'sent-echo.jsonl'); }
  status() { return this.st; }
  onInbound(cb: (m: InboundWa) => void) { this.inCb.push(cb); }
  onEvent(cb: (e: WaEvent) => void) { this.evCb.push(cb); }
  private emit(e: WaEvent) { for (const c of this.evCb) c(e); }

  async connect(): Promise<void> {
    const mod: any = await import('@whiskeysockets/baileys'); // lazy: tests never load it
    const make = mod.default?.default ?? mod.default ?? mod.makeWASocket; const { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = mod;
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version: number[] | undefined; try { version = (await fetchLatestBaileysVersion()).version; } catch { /* use bundled */ }
    this.st = 'connecting'; this.emit({ type: 'status', status: 'connecting' });
    const sock = make({ auth: state, version, browser: Browsers?.macOS?.('Desktop') ?? ['Magmafy', 'Desktop', '1.0'], printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u: any) => {
      if (u.qr) this.emit({ type: 'qr', qr: u.qr });
      if (u.connection === 'open') { this.st = 'open'; this.emit({ type: 'status', status: 'open' }); }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason?.loggedOut || code === 401) { this.st = 'logged_out'; this.emit({ type: 'status', status: 'logged_out', reason: 'logged out from the phone / session invalid' }); }
        else if (code === 403 || code === 'forbidden') { this.st = 'closed'; this.emit({ type: 'restricted', detail: 'WhatsApp refused the connection (403): the number may be restricted' }); }
        else { this.st = 'closed'; this.emit({ type: 'status', status: 'closed', reason: String(code ?? 'unknown') }); } // NO automatic reconnect loop here: the breaker counts drops; the supervisor decides
      }
    });
    sock.ev.on('messages.upsert', (ev: any) => {
      for (const m of ev.messages ?? []) {
        const jid: string = m.key?.remoteJid ?? ''; if (!jid || jid === 'status@broadcast') continue;
        const text: string | null = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? null;
        if (m.key.fromMe) { if (text) appendFileSync(this.echoFile, JSON.stringify({ jid, text, at: new Date().toISOString() }) + '\n'); continue; }
        const real = m.key.senderPn ?? m.key.remoteJidAlt ?? jid; // LID addressing: prefer the phone-number JID when WhatsApp provides it
        const kind = jid.endsWith('@g.us') ? 'group' : m.message?.audioMessage ? 'voice' : text ? 'text' : m.message ? 'media' : 'other';
        for (const c of this.inCb) c({ id: m.key.id, from: String(real).split('@')[0].split(':')[0], jid, text, kind, at: new Date((Number(m.messageTimestamp) || Date.now() / 1000) * 1000).toISOString() });
      }
    });
    sock.ev.on('messages.update', (ups: any[]) => { for (const u of ups ?? []) { const s = u.update?.status; const id = u.key?.id; if (!id || s == null) continue; this.emit({ type: 'receipt', messageId: id, status: s >= 4 ? 'read' : s === 3 ? 'delivered' : s === 2 ? 'server' : 'failed' }); } });
    sock.ev.on('call', (calls: any[]) => { for (const c of calls ?? []) for (const cb of this.inCb) cb({ id: c.id, from: String(c.from ?? '').split('@')[0], jid: c.from, text: null, kind: c.status === 'timeout' || c.status === 'reject' ? 'missed_call' : 'call', at: new Date().toISOString() }); });
  }
  /** Pairing by phone-number code (no QR image needed): the owner types the 8-character code in WhatsApp → Linked devices. */
  async requestPairingCode(phoneDigits: string): Promise<string> { if (!this.sock) throw new Error('connect() first'); return this.sock.requestPairingCode(phoneDigits); }

  async isOnWhatsApp(digits: string): Promise<boolean> {
    if (this.st !== 'open') throw new WaSendError('not_connected', true);
    const r = await this.sock.onWhatsApp(`${digits}@s.whatsapp.net`); return !!r?.[0]?.exists;
  }
  async sendText(digits: string, text: string, o?: { typingMs?: number }): Promise<{ messageId: string }> {
    if (this.st !== 'open' || !this.sock) throw new WaSendError('not_connected', true);
    const jid = `${digits}@s.whatsapp.net`;
    try {
      await this.sock.presenceSubscribe(jid); await sleep(400); await this.sock.sendPresenceUpdate('composing', jid); await sleep(o?.typingMs ?? 2000); await this.sock.sendPresenceUpdate('paused', jid);
      const res = await Promise.race([this.sock.sendMessage(jid, { text }), sleep(30_000).then(() => { throw Object.assign(new Error('Timed Out'), { timedOut: true }); })]);
      return { messageId: String((res as any)?.key?.id ?? '') };
    } catch (e: any) {
      const msg = String(e?.message ?? e); const code = e?.output?.statusCode ?? e?.data;
      if (code === 429 || /rate-overlimit|too many/i.test(msg)) throw new WaSendError('rate_limited', true, msg);
      if (code === 403 || /forbidden|restrict|banned/i.test(msg)) throw new WaSendError('restricted', true, msg);
      if (e?.timedOut || /timed out/i.test(msg)) throw new WaSendError('timeout', false, msg); // the message MAY have gone out
      if (/connection (closed|lost)|stream errored/i.test(msg)) throw new WaSendError('dropped', false, msg);
      throw new WaSendError('other', false, msg);
    }
  }
  /** Uses the locally recorded echoes of our own outgoing messages (Baileys has no server-side history lookup). */
  async wasSent(digits: string, text: string, sinceIso: string): Promise<boolean | null> {
    if (!existsSync(this.echoFile)) return null;
    try { const since = Date.parse(sinceIso) - 60_000; const hit = readFileSync(this.echoFile, 'utf8').split('\n').filter(Boolean).slice(-1000).map((l) => JSON.parse(l)).some((x) => x.jid.startsWith(digits) && x.text === text && Date.parse(x.at) >= since); return hit ? true : null; /* absence of an echo proves nothing */ } catch { return null; }
  }
}
