/** Structured JSON logger with secret redaction. */
const SECRET_KEYS = /(key|token|secret|password|passphrase|authorization)/i;
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 5 || v == null) return v;
  if (typeof v === 'string') return v.length > 500 ? v.slice(0, 500) + '…' : v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(x, depth + 1);
    return o;
  }
  return v;
}
export interface Logger { info(msg: string, f?: object): void; warn(msg: string, f?: object): void; error(msg: string, f?: object): void }
export function createLogger(level = 'info', sink: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  const order = { info: 1, warn: 2, error: 3 } as const;
  const min = level === 'error' ? 3 : level === 'warn' ? 2 : 1;
  const emit = (lv: keyof typeof order, msg: string, f?: object) => { if (order[lv] >= min) sink(JSON.stringify({ t: new Date().toISOString(), lv, msg, ...(redact(f ?? {}) as object) })); };
  return { info: (m, f) => emit('info', m, f), warn: (m, f) => emit('warn', m, f), error: (m, f) => emit('error', m, f) };
}
export const nullLogger: Logger = { info() {}, warn() {}, error() {} };
