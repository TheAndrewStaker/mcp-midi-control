/**
 * OFFERING scene-chain timeline — READ-ONLY, OFFLINE.
 *
 * The 2026-07-31 canonical reports NO scene chain on 57/60/61 (all four scene
 * blocks undefined, 0x2c1 = 0, midi2 plain chain back at [0,7]/[0,2]). The
 * song doc says those three were converted to 4-scene chains on 2026-07-23 and
 * fixed at offset 721 the same day. Walk EVERY capture on disk, oldest first,
 * and print the raw scene bytes so the moment the state changed is visible.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/dev/mcp-midi-tools';
const BASE = `${ROOT}/samples/circuit-ncs`;
const SLOTS = new Set([57, 58, 59, 60, 61, 62, 63]);
const SIZE = 160_780;

interface Row { when: string; dir: string; slot: number; name: string; sceneEnd: number; defined: number[]; sceneMidi2: string[]; sceneDrum1: string[]; chain: string; stateA: number; stateB: number }

const rows: Row[] = [];
function walk(dir: string): string[] {
  const out: string[] = [];
  let ents: import('node:fs').Dirent[];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.ncs')) out.push(p);
  }
  return out;
}
const ROOTS = [BASE, 'C:/Users/Steph/mcp-midi-backups'];
for (const rootDir of ROOTS) {
  for (const full of walk(rootDir)) {
    const f = path.basename(full);
    const dir = path.relative(rootDir, path.dirname(full)) || '.';
    const m = /pack5-project(\d+)[-_]?(.*?)-?(\d{4}-\d{2}-\d{2}[_T][\d-]+)?\.ncs$/.exec(f);
    if (!m) continue;
    const slot = Number(m[1]);
    if (!SLOTS.has(slot)) continue;
    const buf = new Uint8Array(readFileSync(full));
    if (buf.length !== SIZE) continue;
    const defined: number[] = [];
    const sceneMidi2: string[] = [];
    const sceneDrum1: string[] = [];
    for (let sc = 0; sc < 4; sc++) {
      const b = 0x50 + sc * 0x28;
      defined.push(buf[b + 0x10]);
      sceneMidi2.push(`[${buf[b + 0x18 + 3 * 4]},${buf[b + 0x18 + 3 * 4 + 1]}]`);
      sceneDrum1.push(`[${buf[b + 0]},${buf[b + 1]}]`);
    }
    const chain: string[] = [];
    for (let i = 0; i < 8; i++) chain.push(`${buf[0x2c4 + i * 4]},${buf[0x2c4 + i * 4 + 1]}`);
    rows.push({
      when: m[3] ?? '(no-timestamp)', dir, slot, name: m[2],
      sceneEnd: buf[0x2c1], defined, sceneMidi2, sceneDrum1,
      chain: chain.join(' | '), stateA: buf[0x26fbc], stateB: buf[0x26fd2],
    });
  }
}

rows.sort((a, b) => (a.slot - b.slot) || a.when.localeCompare(b.when));
let cur = -1;
for (const r of rows) {
  if (r.slot !== cur) { cur = r.slot; console.log(`\n===== Project ${r.slot} =====`); }
  console.log(`${r.when}  ${r.dir}`);
  console.log(`   name="${r.name}"  0x2c1=${r.sceneEnd}  stateA=${r.stateA} stateB=${r.stateB}  defined=[${r.defined.join(',')}]`);
  console.log(`   scene midi2 ${r.sceneMidi2.join(' ')}   scene drum1 ${r.sceneDrum1.join(' ')}`);
  console.log(`   plain chain (s1|s2|m1|m2|d1|d2|d3|d4) = ${r.chain}`);
}

// Also look at the pre-upload staged file the scene-fix script produced, if kept.
for (const extra of ['samples/circuit-ncs', 'samples/_scratch']) {
  const dd = path.join(ROOT, extra);
  if (!existsSync(dd)) continue;
}
console.log(`\n${rows.length} captures walked.`);
