/**
 * OFFERING backup audit — READ-ONLY, OFFLINE.
 *
 * The 2026-07-23 scene-chain conversion took pre-write backups into
 * ~/mcp-midi-backups (0-based `slot56/59/60` = device Projects 57/60/61). Decode
 * every Offering backup there, oldest first, to establish what the scene state
 * actually was at each write and whether the conversion ever reached the card.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DIR = 'C:/Users/Steph/mcp-midi-backups';
const SIZE = 160_780;

const rows: Array<{ when: string; file: string; slot: string; name: string; end: number; def: number[]; m2: string[]; d1: string[]; chain: string; a: number; b: number }> = [];
for (const f of readdirSync(DIR)) {
  if (!/Novation_Circuit_Tracks-pack5-slot(5[6-9]|6[0-3])-(Offering|Ofr)/.test(f)) continue;
  const m = /slot(\d+)-(.*?)-(\d{4}-\d{2}-\d{2}_[\d-]+)\.ncs$/.exec(f);
  if (!m) continue;
  const buf = new Uint8Array(readFileSync(path.join(DIR, f)));
  if (buf.length !== SIZE) continue;
  const def: number[] = []; const m2: string[] = []; const d1: string[] = [];
  for (let sc = 0; sc < 4; sc++) {
    const bb = 0x50 + sc * 0x28;
    def.push(buf[bb + 0x10]);
    m2.push(`[${buf[bb + 0x18 + 12]},${buf[bb + 0x18 + 13]}]`);
    d1.push(`[${buf[bb]},${buf[bb + 1]}]`);
  }
  const ch: string[] = [];
  for (let i = 0; i < 8; i++) ch.push(`${buf[0x2c4 + i * 4]},${buf[0x2c4 + i * 4 + 1]}`);
  rows.push({ when: m[3], file: f, slot: m[1], name: m[2], end: buf[0x2c1], def, m2, d1, chain: ch.join(' | '), a: buf[0x26fbc], b: buf[0x26fd2] });
}
rows.sort((x, y) => x.when.localeCompare(y.when) || x.slot.localeCompare(y.slot));
for (const r of rows) {
  console.log(`${r.when}  slot${r.slot} "${r.name}"`);
  console.log(`   0x2c1=${r.end}  stateA=${r.a} stateB=${r.b}  defined=[${r.def.join(',')}]  scene-midi2 ${r.m2.join(' ')}  scene-drum1 ${r.d1.join(' ')}`);
  console.log(`   plain chain = ${r.chain}`);
}
console.log(`\n${rows.length} backups.`);
