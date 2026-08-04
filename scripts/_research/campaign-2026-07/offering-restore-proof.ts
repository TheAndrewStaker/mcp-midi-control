/**
 * Did the card get RESTORED to its pre-scene-conversion state? — READ-ONLY.
 *
 * Compare the 2026-07-23 16:59 pre-conversion backups (0-based slot56/59/60 =
 * Projects 57/60/61) against the 2026-07-30 19:08 pre-surgical-pass capture of
 * the same projects, byte for byte. If they are identical, the 2026-07-23 scene
 * conversion + offset-721 fix were undone by a restore and never reached the
 * current card.
 */
import { readFileSync } from 'node:fs';

const B = 'C:/Users/Steph/mcp-midi-backups';
const PAIRS: Array<[string, string, string]> = [
  ['Project 57 (Chorus)', `${B}/Novation_Circuit_Tracks-pack5-slot56-Offering_1_7-2026-07-23_16-59-06.ncs`, `${B}/Novation_Circuit_Tracks-pack5-slot57-Offering_1_7-2026-07-30_19-08-27.ncs`],
  ['Project 60 (Bridge)', `${B}/Novation_Circuit_Tracks-pack5-slot59-Offering_4_7-2026-07-23_16-59-17.ncs`, `${B}/Novation_Circuit_Tracks-pack5-slot60-Offering_4_7-2026-07-30_19-08-58.ncs`],
  ['Project 61 (Buildup)', `${B}/Novation_Circuit_Tracks-pack5-slot60-Offering_5_7-2026-07-23_16-59-25.ncs`, `${B}/Novation_Circuit_Tracks-pack5-slot61-Offering_5_7-2026-07-30_19-09-09.ncs`],
];
const POST: Array<[string, string, string]> = [
  ['Project 57 (Chorus)', `${B}/Novation_Circuit_Tracks-pack5-slot56-Offering_1_7-2026-07-23_17-35-03.ncs`, `${B}/Novation_Circuit_Tracks-pack5-slot57-Offering_1_7-2026-07-30_19-08-27.ncs`],
  ['Project 60 (Bridge)', `${B}/Novation_Circuit_Tracks-pack5-slot59-Offering_4_7-2026-07-23_17-35-10.ncs`, `${B}/Novation_Circuit_Tracks-pack5-slot60-Offering_4_7-2026-07-30_19-08-58.ncs`],
  ['Project 61 (Buildup)', `${B}/Novation_Circuit_Tracks-pack5-slot60-Offering_5_7-2026-07-23_17-35-18.ncs`, `${B}/Novation_Circuit_Tracks-pack5-slot61-Offering_5_7-2026-07-30_19-09-09.ncs`],
];

function diff(label: string, a: string, b: string): void {
  const x = new Uint8Array(readFileSync(a));
  const y = new Uint8Array(readFileSync(b));
  const d: number[] = [];
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) d.push(i);
  console.log(`${label}: ${d.length === 0 ? 'BYTE-IDENTICAL' : `${d.length} differing byte(s)`}` +
    (d.length > 0 && d.length <= 24 ? ` at ${d.map((o) => `0x${o.toString(16)}(${o}) ${x[o]}->${y[o]}`).join(', ')}` : ''));
}

console.log('=== 2026-07-23 PRE-CONVERSION (16:59) vs 2026-07-30 card (19:08) ===');
for (const [l, a, b] of PAIRS) diff(l, a, b);
console.log('\n=== 2026-07-23 POST-FIX (17:35, scenes + cleared chain) vs 2026-07-30 card (19:08) ===');
for (const [l, a, b] of POST) diff(l, a, b);
