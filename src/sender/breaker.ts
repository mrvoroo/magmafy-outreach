import { Store } from '../db/store.js';
import { Planner } from '../planner/planner.js';
import { WaEvent } from './port.js';

/**
 * Circuit breaker (plan §6.6): on any warning sign STOP all sending, set "paused", alert, and require a MANUAL resume.
 * There are no automatic retry loops here: once tripped, nothing sends until a human calls resume().
 */
export class Breaker {
  constructor(private store: Store, private planner: Planner, private alert: (msg: string) => void) {}
  tripped(): boolean { return this.store.isPaused(); }
  trip(reason: string, detail = ''): void {
    const was = this.store.isPaused();
    this.store.setPaused(true, reason, 'breaker');
    this.store.kvSet('breaker', { reason, detail, at: this.store.now() });
    this.planner.resetRamp(); // after any warning the warm-up starts again
    this.store.event('breaker_trip', 'breaker', null, { reason, detail });
    if (!was) this.alert(`🛑 Sending STOPPED: ${reason}${detail ? ' — ' + detail : ''}. Nothing will be sent until you resume manually.`);
  }
  resume(actor: string, connected: boolean): { ok: boolean; reason?: string } {
    if (!connected) return { ok: false, reason: 'whatsapp_not_connected' };
    this.store.kvSet('failure_streak', 0); this.store.kvSet('not_on_wa_streak', 0); this.store.kvSet('reconnects', []);
    this.store.setPaused(false, 'manual resume', actor); this.store.kvSet('breaker', null); return { ok: true };
  }
  noteSendResult(ok: boolean) { const n = ok ? 0 : (this.store.kvGet<number>('failure_streak', 0) ?? 0) + 1; this.store.kvSet('failure_streak', n); if (!ok && n >= this.store.settings().breaker.failureStreak) this.trip('send_failures', `${n} consecutive failures`); }
  noteReachability(onWa: boolean) { const n = onWa ? 0 : (this.store.kvGet<number>('not_on_wa_streak', 0) ?? 0) + 1; this.store.kvSet('not_on_wa_streak', n); if (!onWa && n >= this.store.settings().breaker.notOnWhatsAppStreak) this.trip('not_on_whatsapp_spike', `${n} numbers in a row are not on WhatsApp`); }
  onWaEvent(e: WaEvent) {
    if (e.type === 'status') {
      if (e.status === 'logged_out') this.trip('logged_out', e.reason ?? 'session invalid');
      else if (e.status === 'closed' || e.status === 'connecting') {
        const now = this.store.clock.now().getTime(); const list = (this.store.kvGet<number[]>('reconnects', []) ?? []).filter((t) => now - t < 3600_000); if (e.status === 'closed') list.push(now); this.store.kvSet('reconnects', list);
        if (list.length > this.store.settings().breaker.reconnectsPerHour) this.trip('connection_flapping', `${list.length} drops in the last hour`);
      }
    } else if (e.type === 'restricted') this.trip('restricted', e.detail);
    else if (e.type === 'receipt' && e.status === 'failed') this.noteSendResult(false);
  }
  /** Many recent messages with no delivery receipt after 30 minutes = something is wrong (shadow restriction). */
  checkDelivery(nowMs: number, windowSize = 5, graceMin = 30): boolean {
    const last = this.store.db.all("SELECT sent_at, delivery_status FROM messages WHERE direction='out' AND state='sent' AND wa_message_id IS NOT NULL ORDER BY sent_at DESC LIMIT ?", windowSize);
    if (last.length < windowSize) return false;
    const bad = last.every((m) => !m.delivery_status && nowMs - new Date(m.sent_at).getTime() > graceMin * 60000);
    if (bad) this.trip('not_delivered', `last ${windowSize} messages have no delivery receipt`);
    return bad;
  }
}
