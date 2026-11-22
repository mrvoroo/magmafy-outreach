import { describe, it, expect } from 'vitest';
import { world } from './helpers.js';
import { Stats } from '../src/dashboard/stats.js';
import { startAdmin } from '../src/ops/admin.js';

async function busyWorld() {
  const w = await world(); await w.app.start(); await w.makeReady(6); await w.app.morning(); await w.runDay();
  const sent = w.store.allLeads().filter((l) => l.first_sent_at);
  const say = async (l: any, id: string, t: string) => { w.wa.emitInbound({ id, from: l.phone.replace(/\D/g, ''), jid: 'x', text: t, kind: 'text', at: w.store.now() }); await w.settle(); };
  await say(sent[0], 'a', 'كم السعر؟'); await say(sent[1], 'b', 'مو مهتم ولا تراسلوني'); await say(sent[2], 'c', 'ارسل التفاصيل');
  return { w, sent, stats: new Stats(w.store, w.app.planner) };
}

describe('dashboard statistics (real numbers from the DB)', () => {
  it('overview: today vs caps, pool, state', async () => {
    const { w, stats } = await busyWorld(); const o = stats.overview('open', 'auto');
    expect(o.today.sentNew).toBe(w.store.allLeads().filter((l) => l.first_sent_at).length); expect(o.today.caps.newCap).toBeGreaterThanOrEqual(o.today.sentNew); expect(o.replies.pending).toBe(3); expect(o.state.paused).toBe(false);
  });
  it('funnel is monotonic and matches the counts', async () => {
    const { sent, stats } = await busyWorld(); const f = stats.funnel(null); const n = Object.fromEntries(f.map((x) => [x.key, x.n]));
    expect(n.sent).toBe(sent.length); expect(n.replied).toBe(3); expect(n.positive).toBe(2); expect(n.booked).toBe(0); expect(n.ready).toBeGreaterThanOrEqual(n.sent);
  });
  it('results: rates, opt-outs, positives and negatives', async () => {
    const { sent, stats } = await busyWorld(); const r = stats.results(null);
    expect(r.sent).toBe(sent.length); expect(r.replied).toBe(3); expect(r.positive).toBe(2); expect(r.negative).toBe(1); expect(r.optOut).toBe(1); expect(r.replyRate).toBe(Math.round((3 / sent.length) * 1000) / 10); expect(r.waiting).toBe(sent.length - 3);
  });
  it('reasons: categories with their wording, opt-out reason text, small-sample honesty', async () => {
    const { stats } = await busyWorld(); const r = stats.reasons(null);
    expect(r.categories.map((c) => c.category).sort()).toEqual(['opt_out', 'price', 'send_details']); expect(r.optOuts[0].text).toContain('تراسلوني'); expect(r.insights[0]).toContain('قليلة');
    expect(r.categories.find((c) => c.category === 'price')!.examples[0]).toContain('السعر');
  });
  it('quality: per message checks/judge/outcome and ingredient tables', async () => {
    const { stats } = await busyWorld(); const q = stats.quality(null);
    expect(q.total).toBeGreaterThan(0); expect(q.judgePassRate).toBe(100); expect(q.avgWords!).toBeLessThan(40); expect(q.recent.some((m) => m.outcome === 'positive')).toBe(true); expect(q.recent.some((m) => m.outcome === 'negative')).toBe(true); expect(q.note).toBeTruthy();
    expect(q.byEvidence.length).toBeGreaterThan(0);
  });
  it('conversation: the whole thread for ONE lead, separate from the CRM', async () => {
    const { sent, stats } = await busyWorld(); const c = stats.conversation(sent[0].id)!;
    expect(c.messages.map((m) => m.dir)).toEqual(['out', 'in']); expect(c.messages[1].reply!.category).toBe('price'); expect(c.messages[1].reply!.suggested).toBeTruthy(); expect(c.messages[0].checks!.total).toBeGreaterThan(5); expect(c.evidence.length).toBeGreaterThan(0); expect(c.history.some((e) => e.type === 'status')).toBe(true);
    expect(stats.conversation('nope')).toBeNull(); const list = stats.leads({ text: sent[0].name.slice(0, 5) }); expect(list.rows.length).toBeGreaterThan(0);
  });
  it('version changes when something happens (drives the live stream)', async () => {
    const { w, stats, sent } = await busyWorld(); const v1 = stats.version(); w.wa.emitInbound({ id: 'zz', from: sent[3].phone!.replace(/\D/g, ''), jid: 'x', text: 'بعدين', kind: 'text', at: w.store.now() }); await w.settle(); expect(stats.version()).not.toBe(v1);
  });
  it('API serves every screen and the SSE stream pushes a change', async () => {
    const { w, sent } = await busyWorld(); const tok = 'y'.repeat(30); const srv = startAdmin(w.app, tok, 0); await new Promise((r) => srv.once('listening', r)); const base = `http://127.0.0.1:${(srv.address() as any).port}`; const H = { 'x-admin-token': tok };
    try {
      for (const p of ['/api/overview', '/api/series?days=7', '/api/funnel?days=30', '/api/results?days=all', '/api/reasons?days=7', '/api/quality?days=30', '/api/leads', '/api/replies', '/api/settings', '/api/lead/' + sent[0].id]) { const r = await fetch(base + p, { headers: H }); expect(r.status, p).toBe(200); await r.json(); }
      const ac = new AbortController(); const r = await fetch(base + '/api/stream', { headers: H, signal: ac.signal }); const reader = r.body!.getReader(); const first = new TextDecoder().decode((await reader.read()).value); expect(first).toContain('"v"');
      w.wa.emitInbound({ id: 'sse', from: sent[4].phone!.replace(/\D/g, ''), jid: 'x', text: 'بعدين', kind: 'text', at: w.store.now() }); await w.settle();
      const second = await Promise.race([reader.read().then((x) => new TextDecoder().decode(x.value)), new Promise<string>((res) => setTimeout(() => res('TIMEOUT'), 5000))]); expect(second).toContain('data:'); ac.abort();
    } finally { srv.close(); }
  }, 15000);
});
