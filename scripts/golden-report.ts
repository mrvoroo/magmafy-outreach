// Writes docs/golden-set.md: the 30 golden leads and the message the system generates for each (offline writer), for human review.
import { writeFileSync } from 'node:fs';
import { Db } from '../src/db/db.js'; import { Store } from '../src/db/store.js'; import { Personalizer } from '../src/personalize/personalizer.js'; import { OfflineAi } from '../src/personalize/ai.js';
import { goldenLeads, seedGolden } from '../tests/golden-fixtures.js'; import { FakeClock } from '../src/util/clock.js'; import { countWords } from '../src/personalize/arabic.js';
const s = new Store(new Db(), new FakeClock(new Date('2026-12-01T08:00:00Z'))); const ids = seedGolden(s, goldenLeads()); const p = new Personalizer(s, new OfflineAi());
let out = '# Golden set — generated messages (offline writer)\n\nRate each: ✅ send as is · ✏️ minor edit · ❌ reject. Gate to go live: ≥90% ✅/✏️ and ZERO fabricated claims (run again with the real AI writer; see docs/GO-LIVE.md).\n\n';
let n = 0; for (const id of ids) { const l = s.lead(id)!; const r = await p.prepareFirst(id); n++;
  out += `## ${n}. ${l.name} (${l.segment})${l.owner_name ? ' — owner: ' + l.owner_name : ''}\nEvidence:\n${s.evidence(id).map((e) => `- [${e.type}] ${e.snippet}`).join('\n') || '- (none)'}\n\n`;
  out += r.ok ? `Variant ${r.message.variant} · ${countWords(r.message.text)} words\n\n> ${r.message.text.replace(/\n/g, '\n> ')}\n\n` : `**Parked for review:** ${r.reasons?.join('; ') ?? r.reason}\n\n`; out += 'Rating: ☐ ✅  ☐ ✏️  ☐ ❌\n\n'; }
writeFileSync(new URL('../docs/golden-set.md', import.meta.url), out); console.log('written', n);
