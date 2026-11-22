export type NumberType = 'mobile' | 'landline' | 'unknown';
export interface PhoneInfo { e164: string; digits: string; type: NumberType; country: string | null }

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩', FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export const CC: Record<string, string> = { SA: '966', AE: '971', BH: '973', QA: '974', KW: '965', OM: '968' };

/** Normalises any written phone number to international digits (no '+'), or null if it cannot be one. */
export function normalizePhone(raw: string, defaultCountry: keyof typeof CC = 'SA'): PhoneInfo | null {
  let s = String(raw ?? '').replace(/[٠-٩]/g, (c) => String(AR_DIGITS.indexOf(c))).replace(/[۰-۹]/g, (c) => String(FA_DIGITS.indexOf(c)));
  s = s.replace(/(ext|x|ت|تحويلة)[^\d]*\d+$/i, '');
  let d = s.replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = CC[defaultCountry] + d.slice(1);
  else if (!Object.values(CC).some((c) => d.startsWith(c))) d = CC[defaultCountry] + d; // local number written without 0
  if (d.length < 10 || d.length > 15) return null;
  const country = Object.entries(CC).find(([, c]) => d.startsWith(c))?.[0] ?? null;
  return { e164: '+' + d, digits: d, type: guessType(d, country), country };
}

/** Best-effort: Saudi mobiles are 9665xxxxxxxx; landlines 96611… 96612… 96613… 96614… 9661xxxxxxx. */
export function guessType(digits: string, country: string | null): NumberType {
  const national = country ? digits.slice(CC[country].length) : digits;
  switch (country) {
    case 'SA': return /^5\d{8}$/.test(national) ? 'mobile' : /^1[1-9]\d{7}$/.test(national) || /^9200|^8\d{9}$/.test(national) ? 'landline' : 'unknown';
    case 'AE': return /^5\d{8}$/.test(national) ? 'mobile' : /^[2-9]\d{7}$/.test(national) ? 'landline' : 'unknown';
    case 'BH': return /^[36]\d{7}$/.test(national) ? 'mobile' : /^1\d{7}$/.test(national) ? 'landline' : 'unknown';
    case 'QA': return /^[3567]\d{7}$/.test(national) ? 'mobile' : /^4\d{7}$/.test(national) ? 'landline' : 'unknown';
    default: return 'unknown';
  }
}
export const toJid = (digits: string) => `${digits}@s.whatsapp.net`;
