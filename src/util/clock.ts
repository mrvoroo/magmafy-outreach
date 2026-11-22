export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };
export class FakeClock implements Clock {
  constructor(private t: Date) {}
  now() { return new Date(this.t.getTime()); }
  set(d: Date) { this.t = d; }
  advance(ms: number) { this.t = new Date(this.t.getTime() + ms); }
}
