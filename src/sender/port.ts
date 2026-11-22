/** The ONLY thing that talks to WhatsApp. Faked in tests; Baileys adapter in production. */
export type WaStatus = 'open' | 'connecting' | 'closed' | 'logged_out';
export interface InboundWa { id: string; from: string; jid: string; text: string | null; kind: 'text' | 'voice' | 'call' | 'missed_call' | 'media' | 'group' | 'other'; at: string; fromMe?: boolean }
export type WaEvent = { type: 'status'; status: WaStatus; reason?: string } | { type: 'receipt'; messageId: string; status: 'server' | 'delivered' | 'read' | 'failed' } | { type: 'restricted'; detail: string } | { type: 'qr'; qr: string };

/** Errors the adapter throws. `certain` = we know nothing was sent; `uncertain` = the message may have gone out. */
export class WaSendError extends Error { constructor(public code: 'not_connected' | 'rate_limited' | 'timeout' | 'dropped' | 'restricted' | 'other', public certain: boolean, msg?: string) { super(msg ?? code); } }

export interface WhatsAppPort {
  status(): WaStatus;
  connect(): Promise<void>;
  /** Is this number on WhatsApp? (Only called for leads about to be messaged.) */
  isOnWhatsApp(digits: string): Promise<boolean>;
  sendText(digits: string, text: string, o?: { typingMs?: number }): Promise<{ messageId: string }>;
  /** Did we already send exactly this text to this number after `sinceIso`? null = cannot know. */
  wasSent(digits: string, text: string, sinceIso: string): Promise<boolean | null>;
  onInbound(cb: (m: InboundWa) => void): void;
  onEvent(cb: (e: WaEvent) => void): void;
}

export class FakeWhatsApp implements WhatsAppPort {
  st: WaStatus = 'open'; sent: { digits: string; text: string; at: number; messageId: string }[] = []; notOnWa = new Set<string>(); registered = new Set<string>();
  failNext: WaSendError | null = null; failAlways: WaSendError | null = null; sendDelayMs = 0; private inCb: ((m: InboundWa) => void)[] = []; private evCb: ((e: WaEvent) => void)[] = []; typing: number[] = [];
  /** When set, the send is recorded (it "went out") and THEN an error is thrown: the uncertain-send case. */
  /** Like the real thing, a delivery receipt follows every send (a macro-task later). Tests that want «no receipts» set it false. */
  autoReceipts = true; dropAfterSend = false; knowsHistory = true; checks: string[] = []; now = () => Date.now();
  status() { return this.st; }
  async connect() { this.st = 'open'; }
  async isOnWhatsApp(d: string) { this.checks.push(d); return !this.notOnWa.has(d); }
  async sendText(digits: string, text: string, o?: { typingMs?: number }) {
    if (this.st !== 'open') throw new WaSendError('not_connected', true);
    if (this.failAlways) throw this.failAlways; if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    this.typing.push(o?.typingMs ?? 0); const id = 'WA' + (this.sent.length + 1);
    this.sent.push({ digits, text, at: this.now(), messageId: id });
    if (this.dropAfterSend) { this.dropAfterSend = false; throw new WaSendError('dropped', false, 'connection dropped after send'); }
    if (this.autoReceipts) setTimeout(() => this.emit({ type: 'receipt', messageId: id, status: 'delivered' }), 0);
    return { messageId: id };
  }
  async wasSent(d: string, t: string) { return this.knowsHistory ? this.sent.some((s) => s.digits === d && s.text === t) : null; }
  onInbound(cb: (m: InboundWa) => void) { this.inCb.push(cb); } onEvent(cb: (e: WaEvent) => void) { this.evCb.push(cb); }
  emitInbound(m: InboundWa) { this.inCb.forEach((c) => c(m)); } emit(e: WaEvent) { if (e.type === 'status') this.st = e.status; this.evCb.forEach((c) => c(e)); }
}
