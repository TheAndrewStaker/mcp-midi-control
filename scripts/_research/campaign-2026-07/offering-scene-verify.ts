/**
 * OFFERING scene-chain RE-APPLICATION — PHASE 4 VERIFICATION. OFFLINE, READ-ONLY.
 *
 * Compares the post-write download (offering-scenefix-authored-2026-07-31)
 * against the pre-write download (offering-scenefix-preauthor-2026-07-31, itself
 * gate-proved byte-identical to the campaign canonical) and answers, per target:
 *
 *   (1) the device holds EXACTLY the staged file (byte-identical), so nothing was
 *       lost or reinterpreted in transit;
 *   (2) the scene tables read as intended on BOTH legs — midi2 AND all four drum
 *       tracks — through the codec's own getters, with a 4-scene chain active;
 *   (3) the stale plain-chain range is CLEARED on every track that got a scene
 *       table (midi2 offset 721 = 0x2d1, and all four drum slots);
 *   (4) the three voice_notes pins (60/61/62 -> stored 72/73/74) are still on
 *       midi2 at their own step and velocity, on their own projects;
 *   (5) binding [1,2,5,11] and all six stored levels 0;
 *   (6) every one of the 987-hit internal drum layer's patterns and every midi2
 *       pattern byte-identical to pre-write;
 *   (7) the FULL 160,780-byte diff region-classified: every changed byte inside
 *       the scene-table + chain-tail regions, nothing outside;
 *   (8) the four untouched Offering witnesses byte-identical across all 160,780.
 *
 * Run: npx tsx samples/_scratch/offering-scene-verify.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  NCS_FILE_SIZE, PATTERNS_PER_TRACK, STEPS_PER_PATTERN, META_OFFSETS,
  noteBlockIndex, drumBlockIndex, getProjectName, getProjectColour, projectColourName,
  getProjectTempo, checkNcsStructure, MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL,
  DRUM_LEVEL_BASE, DRUM_LEVEL_STRIDE,
} from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import { getNoteChain } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import { getSceneChainEnd, getSceneNoteChain, getSceneDrumChain } from '@mcp-midi-control/circuit-tracks/ncs/sceneChain.js';
import { getDrumSampleBinding } from '@mcp-midi-control/circuit-tracks/ncs/drumBinding.js';
import { decodeNotePattern } from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { decodeDrumPattern } from '@mcp-midi-control/circuit-tracks/ncs/drumPattern.js';

import { PLANS, STAGED_DIR, BINDING, allowedRegions } from './offering-scene-stage.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const PRE = `${ROOT}/samples/circuit-ncs/offering-scenefix-preauthor-2026-07-31`;
const POST = `${ROOT}/samples/circuit-ncs/offering-scenefix-authored-2026-07-31`;
const TARGETS = PLANS.map((p) => p.slot);
const WITNESSES = [58, 59, 62, 63];
/** Stored note -> the pinned SPD-SX fill, and the project it belongs to. */
const PINS: Array<{ note: number; name: string; slot: number }> = [
  { note: 72, name: 'bridgeroll', slot: 60 },
  { note: 73, name: 'buildupflurry', slot: 61 },
  { note: 74, name: 'breakdownroll', slot: 62 },
];

const REGIONS = allowedRegions();
const classify = (o: number): string | undefined => REGIONS.find((x) => o >= x.from && o <= x.to)?.what;

let failures = 0;
const fail = (m: string): void => { failures++; console.log(`FAIL: ${m}`); };
const ok = (m: string): void => console.log(`  ok: ${m}`);

function load(dir: string): Map<number, Uint8Array> {
  const m = new Map<number, Uint8Array>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ncs'))) {
    const mm = /pack5-project0*(\d+)/.exec(f);
    if (mm) m.set(Number(mm[1]), new Uint8Array(readFileSync(path.join(dir, f))));
  }
  return m;
}
function midi2Sig(buf: Uint8Array, pattern: number): string {
  const st = decodeNotePattern(buf, 'midi2', pattern);
  const out: string[] = [];
  for (let s = 0; s < STEPS_PER_PATTERN; s++) for (const n of st[s].notes) out.push(`${s + 1}:${n.note}@${n.velocity}:${n.length ?? '-'}`);
  return out.join(',');
}
function drumSig(buf: Uint8Array, pattern: number): string {
  return [0, 1, 2, 3].map((t) => decodeDrumPattern(buf, t, pattern)
    .map((c, i) => (c.active ? `${i + 1}@${c.velocity}` : '')).filter(Boolean).join(',')).join('|');
}

const pre = load(PRE);
const post = load(POST);
const staged = load(STAGED_DIR);

for (const plan of PLANS) {
  const slot = plan.slot;
  const a = pre.get(slot); const b = post.get(slot); const s = staged.get(slot);
  console.log(`\n===== ${plan.label} (Project ${slot}) =====`);
  if (a === undefined || b === undefined || s === undefined) { fail(`slot ${slot}: missing ${a === undefined ? 'pre' : b === undefined ? 'post' : 'staged'} file`); continue; }
  const st = checkNcsStructure(b);
  if (st.ok) ok('structure ok'); else fail(`slot ${slot}: structure faults ${st.faults.join('; ')}`);

  // (1) device == staged
  if (Buffer.from(b).equals(Buffer.from(s))) ok(`(1) device holds EXACTLY the staged file, all ${NCS_FILE_SIZE} bytes`);
  else {
    const d: number[] = [];
    for (let o = 0; o < NCS_FILE_SIZE; o++) if (b[o] !== s[o]) d.push(o);
    fail(`slot ${slot}: (1) device differs from staged at ${d.length} byte(s): ${d.slice(0, 12).map((o) => `0x${o.toString(16)}(${s[o]}->${b[o]})`).join(', ')}`);
  }

  if (getProjectName(a) === getProjectName(b) && getProjectColour(a) === getProjectColour(b) && getProjectTempo(a) === getProjectTempo(b)) {
    ok(`name "${getProjectName(b)}" / ${projectColourName(getProjectColour(b))} / ${getProjectTempo(b)} BPM unchanged`);
  } else fail(`slot ${slot}: project metadata moved`);

  // (2) scene tables on BOTH legs
  const end = getSceneChainEnd(b);
  if (end === 4) ok('(2) scene chain ACTIVE, Scenes 1..4 (0x2c1 = 3)');
  else fail(`slot ${slot}: (2) scene-chain end reads ${end ?? '(none)'} , expected 4`);
  let sceneBad = 0;
  for (let sc = 0; sc < 4; sc++) {
    const want = plan.scenes[sc];
    const n = getSceneNoteChain(b, sc, 'midi2');
    const ds = [0, 1, 2, 3].map((t) => getSceneDrumChain(b, sc, t));
    const nOk = n !== undefined && n.start === want.start && n.end === want.end;
    const dOk = ds.every((d) => d !== undefined && d.start === want.start && d.end === want.end);
    if (!nOk || !dOk) sceneBad++;
    console.log(`     scene ${sc + 1}: want [${want.start},${want.end}]  midi2 ${n ? `[${n.start},${n.end}]` : '-'} ${nOk ? 'OK' : 'BAD'}  drums ${ds.map((d) => d ? `[${d.start},${d.end}]` : '-').join('')} ${dOk ? 'OK' : 'BAD'}`);
  }
  if (sceneBad === 0) ok('(2) all 4 scenes read as intended on the midi2 note leg AND all four drum tracks — both legs follow the same structure');
  else fail(`slot ${slot}: (2) ${sceneBad} scene(s) wrong`);

  // (3) stale plain-chain cleared
  const m2 = getNoteChain(b, 'midi2');
  const drumSlots = [[0x2d4, 0x2d5], [0x2d8, 0x2d9], [0x2dc, 0x2dd], [0x2e0, 0x2e1]];
  const drumsCleared = drumSlots.every(([s0, s1]) => b[s0] === 0 && b[s1] === 0);
  if (m2 === undefined && b[0x2d0] === 0 && b[0x2d1] === 0 && drumsCleared) {
    ok(`(3) stale plain chains CLEARED: midi2 [${b[0x2d0]},${b[0x2d1]}] (offset 721 was ${a[0x2d1]}), drums ${drumSlots.map(([s0, s1]) => `[${b[s0]},${b[s1]}]`).join('')} (were [${a[0x2d4]},${a[0x2d5]}])`);
  } else fail(`slot ${slot}: (3) plain chain NOT fully cleared: midi2 [${b[0x2d0]},${b[0x2d1]}], drums ${drumSlots.map(([s0, s1]) => `[${b[s0]},${b[s1]}]`).join('')}`);

  // (4) pins
  for (const pin of PINS.filter((p) => p.slot === slot)) {
    let found = '';
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const steps = decodeNotePattern(b, 'midi2', p);
      for (let sIdx = 0; sIdx < STEPS_PER_PATTERN; sIdx++) for (const n of steps[sIdx].notes) if (n.note === pin.note) found = `p${p + 1} step ${sIdx + 1} vel ${n.velocity}`;
    }
    if (found) ok(`(4) pin "${pin.name}" (voice_notes ${pin.note - 12}, stored ${pin.note}) still on midi2 at ${found}`);
    else fail(`slot ${slot}: (4) PIN "${pin.name}" IS GONE`);
  }
  const stray = PINS.filter((p) => p.slot !== slot).filter((pin) => {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) for (const s2 of decodeNotePattern(b, 'midi2', p)) for (const n of s2.notes) if (n.note === pin.note) return true;
    return false;
  });
  if (stray.length > 0) fail(`slot ${slot}: unexpected pin(s) ${stray.map((p) => p.name).join(',')}`);

  // (5) binding + levels
  const binding = getDrumSampleBinding(b);
  const levels = [b[MIXER_SYNTH1_LEVEL], b[MIXER_SYNTH2_LEVEL], ...[0, 1, 2, 3].map((n) => b[DRUM_LEVEL_BASE + n * DRUM_LEVEL_STRIDE])];
  if (JSON.stringify(binding) === JSON.stringify(BINDING) && levels.every((l) => l === 0)) ok(`(5) binding [${binding.join(',')}], all six stored levels 0`);
  else fail(`slot ${slot}: (5) binding [${binding.join(',')}] levels [${levels.join(',')}]`);

  // (6) all content byte-identical to pre-write
  let moved = 0; let hits = 0;
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    if (midi2Sig(a, p) !== midi2Sig(b, p)) moved++;
    if (drumSig(a, p) !== drumSig(b, p)) moved++;
    hits += drumSig(b, p).split('|').filter(Boolean).join(',').split(',').filter(Boolean).length;
    if (a[META_OFFSETS[noteBlockIndex('midi2', p)]] !== b[META_OFFSETS[noteBlockIndex('midi2', p)]]) moved++;
    for (let t = 0; t < 4; t++) if (a[META_OFFSETS[drumBlockIndex(t, p)]] !== b[META_OFFSETS[drumBlockIndex(t, p)]]) moved++;
  }
  if (moved === 0) ok(`(6) every midi2 and internal-drum pattern identical to pre-write (steps, velocities, lengths); ${hits} internal drum hits intact`);
  else fail(`slot ${slot}: (6) ${moved} content fingerprint(s) MOVED`);

  // (7) whole-file diff, region-classified
  const diff: number[] = [];
  for (let o = 0; o < NCS_FILE_SIZE; o++) if (a[o] !== b[o]) diff.push(o);
  const outside = diff.filter((o) => classify(o) === undefined);
  const byRegion = new Map<string, number>();
  for (const o of diff) { const w = classify(o) ?? 'OUTSIDE'; byRegion.set(w, (byRegion.get(w) ?? 0) + 1); }
  if (outside.length === 0) ok(`(7) ${diff.length} byte(s) changed on the device, ALL inside the scene-table + chain-tail regions (${[...byRegion].map(([w, n]) => `${w}:${n}`).join('  ')})`);
  else fail(`slot ${slot}: (7) ${outside.length} byte(s) changed OUTSIDE: ${outside.slice(0, 16).map((o) => `0x${o.toString(16)}(${a[o]}->${b[o]})`).join(', ')}`);
}

console.log('\n===== (8) untouched Offering witnesses =====');
for (const slot of WITNESSES) {
  const a = pre.get(slot); const b = post.get(slot);
  if (a === undefined || b === undefined) { fail(`witness ${slot}: missing capture`); continue; }
  if (Buffer.from(a).equals(Buffer.from(b))) ok(`witness Project ${slot} "${getProjectName(b)}" byte-identical across all ${NCS_FILE_SIZE} bytes`);
  else fail(`witness ${slot} MOVED`);
}

console.log(`\n${failures === 0 ? 'PHASE 4 PASS — 3/3 converted, both legs scene-chained, everything else byte-identical' : `${failures} FAILURES`}`);
process.exitCode = failures === 0 ? 0 : 1;
