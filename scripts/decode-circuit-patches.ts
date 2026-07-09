/**
 * Oracle validation for the Circuit Tracks structured patch decode (Leg 2).
 *
 * Decodes the 128 captured factory patch dumps (samples/, gitignored) against
 * the §13 offset map and checks, for EVERY mapped offset, that the byte falls in
 * the assigned param's wire range across all 128 patches. A mis-assigned offset
 * would surface as out-of-range values; an off-by-one would mismatch the anchor
 * defaults. This is the data-driven gate that confirms the layout before it
 * ships — it needs the gitignored captures, so it is NOT part of preflight; run
 * it by hand when the layout changes:
 *
 *   npx tsx scripts/decode-circuit-patches.ts
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CIRCUIT_PARAMS, buildBlocks, findParam, type CircuitParam } from '@mcp-midi-control/circuit-tracks/params.js';
import { decodePatchName } from '@mcp-midi-control/circuit-tracks/codec/blob.js';
import { PATCH_OFFSETS, OFFSET_BY_PARAM, validateLayout } from '@mcp-midi-control/circuit-tracks/codec/patchLayout.js';

const DIR = join(process.cwd(), 'samples', 'circuit-tracks', 'pack0', 'patches');

if (!existsSync(DIR)) {
  console.error(`SKIP: ${DIR} not found (captures are gitignored local scratch). Nothing to validate.`);
  process.exit(0);
}

const files = readdirSync(DIR)
  .filter((f) => /^patch_\d+\.syx$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));

if (files.length === 0) { console.error(`SKIP: no patch_*.syx in ${DIR}.`); process.exit(0); }

const bodies: Uint8Array[] = [];
for (const f of files) {
  const buf = readFileSync(join(DIR, f));
  if (buf.length !== 350) { console.error(`FAIL: ${f} is ${buf.length} bytes, expected 350.`); process.exit(1); }
  bodies.push(new Uint8Array(buf.subarray(9, 349))); // strip 9-byte prefix + F7 → 340 body
}
console.log(`Loaded ${bodies.length} patch bodies (340 bytes each).`);

let failed = 0;
const fail = (m: string) => { failed++; console.error(`  FAIL  ${m}`); };

// 1. Layout self-consistency (also run in the committed golden).
const problems = validateLayout();
if (problems.length) { problems.forEach((p) => fail(`layout: ${p}`)); }
else console.log(`  OK    layout self-consistent (${PATCH_OFFSETS.length} mapped offsets, all resolve to registry params)`);

// 2. Wire-range check per mapped param across all 128 patches.
function inRange(cp: CircuitParam, wire: number): boolean {
  if (cp.enum) return cp.enum[wire] !== undefined;
  if (cp.signed) return wire >= cp.signed.lo && wire <= cp.signed.hi;
  return wire >= (cp.min ?? 0) && wire <= (cp.max ?? 127);
}
let rangeViolations = 0;
for (const { offset, block, name } of PATCH_OFFSETS) {
  const cp = findParam(block, name)!;
  const bad: number[] = [];
  bodies.forEach((b, i) => { if (!inRange(cp, b[offset] & 0x7f)) bad.push(i); });
  if (bad.length) {
    rangeViolations++;
    fail(`${block}.${name} (off ${offset}): ${bad.length}/128 patches out of range — likely mis-assigned. e.g. patch ${bad[0]} = ${bodies[bad[0]][offset]}`);
  }
}
if (!rangeViolations) console.log(`  OK    all ${PATCH_OFFSETS.length} mapped offsets in range across all 128 patches`);

// 3. Anchor defaults — the distinctive modal values that pin the offset map.
const ANCHORS: { block: string; name: string; expect: number }[] = [
  { block: 'mixer', name: 'osc1_level', expect: 127 },
  // NB: filter.frequency (off 64) is the most-tweaked knob (55 distinct values
  // across the corpus), so its mode ≠ default — a poor anchor. filter.tracking
  // (off 65, default 127, rarely touched) pins the same block reliably.
  { block: 'filter', name: 'tracking', expect: 127 },
  { block: 'filter', name: 'q_normalize', expect: 64 },
  { block: 'env1', name: 'attack', expect: 2 },
  { block: 'lfo1', name: 'rate', expect: 68 },
  { block: 'eq', name: 'treble_frequency', expect: 125 },
  { block: 'fx', name: 'distortion_compensation', expect: 100 },
  { block: 'fx', name: 'chorus_feedback', expect: 74 },
  { block: 'fx', name: 'chorus_type', expect: 1 },
];
const modeOf = (offset: number): number => {
  const counts = new Map<number, number>();
  for (const b of bodies) { const v = b[offset] & 0x7f; counts.set(v, (counts.get(v) ?? 0) + 1); }
  return [...counts.entries()].sort((a, c) => c[1] - a[1])[0][0];
};
for (const a of ANCHORS) {
  const offset = OFFSET_BY_PARAM.get(`${a.block}.${a.name}`)!;
  const mode = modeOf(offset);
  if (mode !== a.expect) fail(`anchor ${a.block}.${a.name} (off ${offset}): modal value ${mode} ≠ expected default ${a.expect}`);
}
if (!failed) console.log(`  OK    ${ANCHORS.length} distinctive anchor defaults match the modal value across the corpus`);

// 4. Sanity: decode patch_0's headline params for eyeballing.
const blocks = buildBlocks();
const show = (block: string, name: string): string => {
  const off = OFFSET_BY_PARAM.get(`${block}.${name}`)!;
  const wire = bodies[0][off] & 0x7f;
  return `${block}.${name}=${blocks[block].params[name].decode(wire)}`;
};
console.log(`\n  patch_0 "${decodePatchName(bodies[0])}": ${['osc1.wave', 'filter.frequency', 'filter.resonance', 'env1.attack', 'lfo1.rate'].map((k) => show(...k.split('.') as [string, string])).join(', ')}`);
console.log(`  registry params total: ${CIRCUIT_PARAMS.length}; decodable from patch dump: ${PATCH_OFFSETS.length}`);

console.log('');
if (failed > 0) { console.error(`x ${failed} validation failure(s).`); process.exit(1); }
console.log('OK decode-circuit-patches: §13 layout confirmed against 128 factory patches.');
