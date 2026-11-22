import { z } from 'zod';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const window = z.object({ start: hhmm, end: hhmm });

export const SettingsSchema = z.object({
  // volume (plan §8)
  newPerDay: z.number().int().min(0).max(30).default(12),
  followUpPerDay: z.number().int().min(0).max(20).default(6),
  totalCeilingPerDay: z.number().int().min(0).max(40).default(18),
  sendingDays: z.array(z.number().int().min(0).max(6)).default([6, 0, 1, 2, 3, 4]), // Sat–Thu (0=Sun)
  timeZone: z.string().default('Asia/Riyadh'),
  country: z.enum(['SA', 'AE', 'BH', 'QA']).default('SA'),
  windows: z.array(window).min(1).default([{ start: '10:30', end: '13:00' }, { start: '16:30', end: '20:30' }]),
  prayerBufferMinutes: z.object({ before: z.number().default(10), after: z.number().default(25) }).default({}),
  gapMinutes: z.object({ min: z.number().default(4), max: z.number().default(25) }).default({}),
  warmup: z.object({ enabled: z.boolean().default(true), steps: z.array(z.object({ fromDay: z.number().int(), perDay: z.number().int() })).default([{ fromDay: 1, perDay: 5 }, { fromDay: 3, perDay: 8 }, { fromDay: 5, perDay: 10 }, { fromDay: 7, perDay: 12 }]) }).default({}),
  followUpDelaysDays: z.tuple([z.number(), z.number(), z.number()]).default([2, 5, 9]),
  variantSplit: z.object({ firstBlock: z.number().int().default(50) }).default({}),
  enabledVariants: z.array(z.enum(['A', 'B', 'C'])).default(['A', 'B']),
  sendMode: z.enum(['off', 'assisted', 'auto']).default('off'),
  autoReply: z.enum(['off', 'whoIsThisOnly']).default('off'),
  budgets: z.object({ googleDailyUsd: z.number().default(3), googleMonthlyUsd: z.number().default(40), aiDailyUsd: z.number().default(3), aiMonthlyUsd: z.number().default(40) }).default({}),
  allowedTiers: z.array(z.enum(['A', 'B', 'C'])).default(['A', 'B']),
  googleRetentionDays: z.number().int().default(30), // conservative; re-read Places terms at deploy (DECISIONS D-07)
  targetCities: z.array(z.object({ city: z.string(), cityAr: z.string(), country: z.enum(['SA', 'AE', 'BH', 'QA']) })).default([
    { city: 'Riyadh', cityAr: 'الرياض', country: 'SA' }, { city: 'Jeddah', cityAr: 'جدة', country: 'SA' }, { city: 'Dammam', cityAr: 'الدمام', country: 'SA' },
    { city: 'Khobar', cityAr: 'الخبر', country: 'SA' }, { city: 'Makkah', cityAr: 'مكة', country: 'SA' }, { city: 'Madinah', cityAr: 'المدينة المنورة', country: 'SA' },
    { city: 'Buraydah', cityAr: 'بريدة', country: 'SA' }, { city: 'Dubai', cityAr: 'دبي', country: 'AE' }, { city: 'Abu Dhabi', cityAr: 'أبو ظبي', country: 'AE' },
    { city: 'Sharjah', cityAr: 'الشارقة', country: 'AE' }, { city: 'Manama', cityAr: 'المنامة', country: 'BH' }, { city: 'Doha', cityAr: 'الدوحة', country: 'QA' }
  ]),
  segments: z.array(z.enum(['furniture', 'decor', 'furnishing'])).default(['furniture', 'decor', 'furnishing']),
  sender: z.object({ firstName: z.string().default('أحمد'), fullName: z.string().default('أحمد أشرف'), company: z.string().default('Magmafy') }).default({}),
  poolMinDays: z.number().int().default(3),
  noEvidenceFallback: z.enum(['needs_review', 'plain']).default('needs_review'),
  maxRegenerations: z.number().int().default(3),
  reminderDays: z.object({ hasAgency: z.number().default(90), later: z.number().default(30) }).default({}),
  summaryTime: z.string().default('21:00'),
  breaker: z.object({ failureStreak: z.number().default(3), notOnWhatsAppStreak: z.number().default(4), reconnectsPerHour: z.number().default(5) }).default({})
});
export type Settings = z.infer<typeof SettingsSchema>;
export const defaultSettings = (): Settings => SettingsSchema.parse({});

/** The hard safety env flags. Live sending needs BOTH SEND_ENABLED=true and mode != off. */
export function liveSendingAllowed(env: Record<string, string | undefined>, s: Settings): boolean {
  return env.SEND_ENABLED === 'true' && s.sendMode !== 'off';
}
