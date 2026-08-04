/**
 * OFFERING populate — PHASE 4 VERIFICATION. OFFLINE, READ-ONLY.
 *
 * Compares the post-write download (`offering-authored-2026-07-31`) against the
 * pre-write canonical (`offering-preauthor-2026-07-31`, itself gate-proved
 * byte-identical to the campaign canonical) and answers, per project:
 *
 *   (a) the internal drum layer EQUALS the condenser's own answer for that
 *       project's own midi2 content (recomputed here from the PRE-WRITE bytes,
 *       through the product's `condenseToKit`);
 *   (b) the scene stack is BYTE-IDENTICAL to pre-write (all 16 scene blocks,
 *       the scene-chain end byte and its two state bytes);
 *   (c) the three `voice_notes` pins (stored 72/73/74 = pins 60/61/62) are still
 *       present, on their own projects, at their own steps and velocities;
 *   (d) the drum sample binding reads [1,2,5,11];
 *   (e) all six stored mixer levels read 0;
 *   (f) every byte outside the DRUM regions is identical to pre-write — the
 *       whole 160,780, region-classified, so anything unexpected is named;
 *   (g) the two untouched neighbours are byte-identical to pre-write.
 *
 * Run: npx tsx samples/_scratch/offering-verify.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  NCS_FILE_SIZE, META_OFFSETS, PATTERNS_PER_TRACK, STEPS_PER_PATTERN,
  drumBlockIndex, noteBlockIndex, getProjectName, getProjectColour, projectColourName,
  getProjectTempo, checkNcsStructure, MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL,
  DRUM_LEVEL_BASE, DRUM_LEVEL_STRIDE,
} from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import { getNoteChain } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import { getSceneChainEnd } from '@mcp-midi-control/circuit-tracks/ncs/sceneChain.js';
import { getDrumSampleBinding } from '@mcp-midi-control/circuit-tracks/ncs/drumBinding.js';
import { decodeNotePattern } from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { decodeDrumPattern } from '@mcp-midi-control/circuit-tracks/ncs/drumPattern.js';
import { condenseToKit, type NeutralPattern, type Step } from '@mcp-midi-control/core/protocol-generic/patterns/index.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const PRE = `${ROOT}/samples/circuit-ncs/offering-preauthor-2026-07-31`;
const POST = `${ROOT}/samples/circuit-ncs/offering-authored-2026-07-31`;
const TARGETS = [57, 58, 59, 60, 61, 62, 63];
const WITNESSES = [52, 53];
const BINDING = [1, 2, 5, 11];
const KIT = ['kick', 'snare', 'closed_hat', 'ride'] as const;

const SPDSX_GM: Record<string, number> = { kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, ride: 51, crash: 49, perc: 56 };
const NOTE_OFFSET = 12;
const STORED_TO_VOICE = new Map<number, string>(Object.entries(SPDSX_GM).map(([v, n]) => [n + NOTE_OFFSET, v]));
/** Stored note -> the pinned SPD-SX fill, and the project it belongs to. */
const PINS: Array<{ note: number; name: string; slot: number }> = [
  { note: 72, name: 'bridgeroll', slot: 60 },
  { note: 73, name: 'buildupflurry', slot: 61 },
  { note: 74, name: 'breakdownroll', slot: 62 },
];

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

// ── Region classifier: which byte belongs to the DRUM layer? ────────────────
// Everything the drums-only author is ALLOWED to move, and nothing else. Any
// differing byte outside this set is a regression and is named individually.
function drumRegions(): Array<{ from: number; to: number; what: string }> {
  const r: Array<{ from: number; to: number; what: string }> = [];
  // Drum step data + length byte, per track/pattern. The step region for a drum
  // pattern ends at its META byte; format.ts gives the meta offset, and the step
  // region is the 16-byte-aligned run before it (drumStepBase).
  for (let t = 0; t < 4; t++) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const meta = META_OFFSETS[drumBlockIndex(t, p)];
      // The drum block: its step bytes immediately precede the meta block. Use a
      // generous but CLOSED window that stops at the previous block's meta byte,
      // so a stray write into a neighbouring block is still caught.
      const prev = p === 0 && t === 0 ? undefined : META_OFFSETS[drumBlockIndex(t, p) - 1];
      r.push({ from: prev === undefined ? meta - 0x200 : prev + 1, to: meta, what: `drum${t + 1} pattern ${p + 1} steps+length` });
    }
  }
  r.push({ from: 0x2d4, to: 0x2e3, what: 'drum chain slots (0x2c4 table, slots 4-7)' });
  // setDrumChain's CHAIN_TAIL byte. Shipped behaviour of the drum-chain
  // primitive (chain.ts CHAIN_TAIL_OFFSET/ENABLE), carried by every other
  // project populated in this campaign — 0x0c on Stranglehold 1-6, Sugar 2-7,
  // Clint 27, Breakdown 35, Amber 9/11. Not a stray write.
  r.push({ from: 0x26fc7, to: 0x26fc7, what: 'drum chain tail 0x26fc7 (setDrumChain CHAIN_TAIL, = every other populated project)' });
  r.push({ from: 0x1a278, to: 0x1a27b, what: 'drum sample binding' });
  for (let n = 0; n < 4; n++) r.push({ from: DRUM_LEVEL_BASE + n * DRUM_LEVEL_STRIDE, to: DRUM_LEVEL_BASE + n * DRUM_LEVEL_STRIDE, what: `drum${n + 1} stored level` });
  r.push({ from: MIXER_SYNTH1_LEVEL, to: MIXER_SYNTH2_LEVEL, what: 'synth stored levels (re-stamped to the 0 already held)' });
  return r;
}
const REGIONS = drumRegions();
const classify = (o: number): string | undefined => REGIONS.find((x) => o >= x.from && o <= x.to)?.what;

/** Rebuild the section's drum voices from a project's stored midi2 pattern. */
function voicesFromMidi2(buf: Uint8Array, pattern: number): NeutralPattern | undefined {
  const steps = decodeNotePattern(buf, 'midi2', pattern);
  const voices: Record<string, { steps: Step[] }> = {};
  let any = false;
  for (let s = 0; s < STEPS_PER_PATTERN; s++) {
    for (const n of steps[s].notes) {
      const v = STORED_TO_VOICE.get(n.note);
      if (v === undefined) continue;               // a pinned SPD-SX fill: no internal role
      if (voices[v] === undefined) voices[v] = { steps: Array.from({ length: STEPS_PER_PATTERN }, () => ({ on: false } as Step)) };
      voices[v].steps[s] = { on: true, velocity: n.velocity } as Step;
      any = true;
    }
  }
  if (!any) return undefined;
  return { name: `p${pattern + 1}`, steps: STEPS_PER_PATTERN, voices };
}

const pre = load(PRE);
const post = load(POST);

for (const slot of TARGETS) {
  const a = pre.get(slot); const b = post.get(slot);
  console.log(`\n===== Project ${slot} =====`);
  if (a === undefined || b === undefined) { fail(`slot ${slot}: missing ${a === undefined ? 'pre' : 'post'} capture`); continue; }
  if (b.length !== NCS_FILE_SIZE) { fail(`slot ${slot}: post is ${b.length} bytes`); continue; }
  const st = checkNcsStructure(b);
  if (st.ok) ok('structure ok'); else fail(`slot ${slot}: structure faults ${st.faults.join('; ')}`);

  // (d) binding, (e) levels
  const binding = getDrumSampleBinding(b);
  if (JSON.stringify(binding) === JSON.stringify(BINDING)) ok(`(d) binding [${binding.join(',')}]`);
  else fail(`slot ${slot}: (d) binding [${binding.join(',')}] != [${BINDING.join(',')}]`);
  const levels = [b[MIXER_SYNTH1_LEVEL], b[MIXER_SYNTH2_LEVEL], ...[0, 1, 2, 3].map((n) => b[DRUM_LEVEL_BASE + n * DRUM_LEVEL_STRIDE])];
  if (levels.every((l) => l === 0)) ok('(e) all six stored levels 0 (silent)');
  else fail(`slot ${slot}: (e) levels [${levels.join(',')}] not all 0`);

  // identity of the untouched project metadata
  const meta: Array<[string, unknown, unknown]> = [
    ['name', getProjectName(a), getProjectName(b)],
    ['colour', projectColourName(getProjectColour(a)), projectColourName(getProjectColour(b))],
    ['tempo', getProjectTempo(a), getProjectTempo(b)],
  ];
  const metaBad = meta.filter(([, x, y]) => x !== y);
  if (metaBad.length === 0) ok(`name "${getProjectName(b)}" / colour ${projectColourName(getProjectColour(b))} / tempo ${getProjectTempo(b)} unchanged`);
  else fail(`slot ${slot}: metadata moved: ${metaBad.map(([k, x, y]) => `${k} ${String(x)}->${String(y)}`).join(', ')}`);

  // (b) SCENE STACK byte-identical: all 16 blocks + the chain end + state bytes.
  const sceneBytes: number[] = [];
  for (let sc = 0; sc < 16; sc++) for (let i = 0; i < 0x28; i++) sceneBytes.push(0x50 + sc * 0x28 + i);
  sceneBytes.push(0x2c1, 0x26fbc, 0x26fd2);
  const sceneDiff = sceneBytes.filter((o) => a[o] !== b[o]);
  if (sceneDiff.length === 0) {
    ok(`(b) scene stack byte-identical (${sceneBytes.length} bytes: 16 scene blocks + end 0x2c1=${b[0x2c1]} + state ${b[0x26fbc]}/${b[0x26fd2]}); scene chain ${getSceneChainEnd(b) ?? 'absent (as pre-write)'}`);
  } else fail(`slot ${slot}: (b) SCENE STACK MOVED at ${sceneDiff.map((o) => `0x${o.toString(16)}`).join(',')}`);

  // midi2 identity: the whole note-track region, chain slot included.
  const m2Bad: number[] = [];
  for (const track of ['synth1', 'synth2', 'midi1', 'midi2'] as const) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const meta2 = META_OFFSETS[noteBlockIndex(track, p)];
      for (let o = meta2 - 896; o <= meta2; o++) if (a[o] !== b[o]) m2Bad.push(o);
    }
  }
  for (let o = 0x2c4; o <= 0x2d3; o++) if (a[o] !== b[o]) m2Bad.push(o);
  if (m2Bad.length === 0) ok('note tracks (synth1/2, midi1, midi2) + their chain slots byte-identical, incl. the offset-721 byte');
  else fail(`slot ${slot}: NOTE-TRACK REGION MOVED at ${m2Bad.slice(0, 12).map((o) => `0x${o.toString(16)}`).join(',')}${m2Bad.length > 12 ? ` (+${m2Bad.length - 12} more)` : ''}`);

  // (c) the pins
  for (const pin of PINS.filter((p) => p.slot === slot)) {
    let found = '';
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const steps = decodeNotePattern(b, 'midi2', p);
      for (let s = 0; s < STEPS_PER_PATTERN; s++) {
        for (const n of steps[s].notes) if (n.note === pin.note) found = `p${p + 1} step ${s + 1} vel ${n.velocity}`;
      }
    }
    if (found) ok(`(c) pin "${pin.name}" (voice_notes ${pin.note - NOTE_OFFSET}, stored ${pin.note}) still on midi2 at ${found}`);
    else fail(`slot ${slot}: (c) PIN "${pin.name}" (stored note ${pin.note}) IS GONE from midi2`);
  }
  const strayPins = PINS.filter((p) => p.slot !== slot).filter((pin) => {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) for (const st2 of decodeNotePattern(b, 'midi2', p)) for (const n of st2.notes) if (n.note === pin.note) return true;
    return false;
  });
  if (strayPins.length > 0) fail(`slot ${slot}: unexpected pin(s) ${strayPins.map((p) => p.name).join(',')}`);

  // (a) the condensed layer equals the condenser's own answer for this project's
  //     own midi2 content, recomputed from the PRE-WRITE bytes.
  const chain = getNoteChain(a, 'midi2')!;
  // Which drum tracks this project writes at all (the writer's union).
  const written: number[] = [];
  for (let t = 0; t < 4; t++) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) if (decodeDrumPattern(b, t, p).some((c) => c.active)) { written.push(t); break; }
  }
  let mismatches = 0; let totalHits = 0;
  for (let p = 0; p <= chain.end; p++) {
    const np = voicesFromMidi2(a, p);
    const want = new Map<number, Array<{ on: boolean; vel: number }>>();
    for (let t = 0; t < 4; t++) want.set(t, Array.from({ length: STEPS_PER_PATTERN }, () => ({ on: false, vel: 0 })));
    if (np !== undefined) {
      const cond = condenseToKit(np, [...KIT]);
      for (let t = 0; t < 4; t++) {
        const row = cond.pattern.voices[KIT[t]];
        if (row === undefined) continue;
        const arr = want.get(t)!;
        row.steps.forEach((s, i) => { if (s.on) arr[i] = { on: true, vel: (s as { velocity?: number }).velocity ?? 100 }; });
      }
    }
    for (let t = 0; t < 4; t++) {
      const got = decodeDrumPattern(b, t, p);
      const exp = want.get(t)!;
      for (let s = 0; s < STEPS_PER_PATTERN; s++) {
        if (got[s].active !== exp[s].on) { mismatches++; continue; }
        if (exp[s].on) { totalHits++; if (got[s].velocity !== exp[s].vel) mismatches++; }
      }
    }
    // Length byte must equal the midi2 pattern's on every drum track the
    // project actually WRITES. A drum track with no content anywhere in the
    // project is outside the writer's union and deliberately keeps the
    // template's length; an empty pattern's length is immaterial.
    const wantLen = a[META_OFFSETS[noteBlockIndex('midi2', p)]];
    for (const t of written) if (b[META_OFFSETS[drumBlockIndex(t, p)]] !== wantLen) mismatches++;
  }
  // Pattern slots past the chain must be silent (nothing authored beyond it).
  let beyond = 0;
  for (let p = chain.end + 1; p < PATTERNS_PER_TRACK; p++) for (let t = 0; t < 4; t++) beyond += decodeDrumPattern(b, t, p).filter((c) => c.active).length;
  const idle = [0, 1, 2, 3].filter((t) => !written.includes(t));
  if (mismatches === 0 && beyond === 0) ok(`(a) internal drums EQUAL the condenser's answer for this project's own midi2 across patterns 1..${chain.end + 1} (${totalHits} hits, on/off + velocity + length on Drum${written.map((t) => t + 1).join('/')}), and nothing authored beyond the chain` + (idle.length ? ` [Drum${idle.map((t) => t + 1).join('/')} carry no content in this song and are left empty]` : ''));
  else fail(`slot ${slot}: (a) ${mismatches} condensed-layer mismatch(es), ${beyond} stray hit(s) past the chain`);

  // (f) whole-file diff, region-classified.
  const diff: number[] = [];
  for (let o = 0; o < NCS_FILE_SIZE; o++) if (a[o] !== b[o]) diff.push(o);
  const outside = diff.filter((o) => classify(o) === undefined);
  const byRegion = new Map<string, number>();
  for (const o of diff) { const w = classify(o) ?? 'OUTSIDE THE DRUM LAYER'; byRegion.set(w, (byRegion.get(w) ?? 0) + 1); }
  const summary = [...byRegion].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([w, n]) => `${w}:${n}`).join('  ');
  if (outside.length === 0) ok(`(f) ${diff.length} byte(s) changed, ALL inside the drum layer — ${summary}`);
  else fail(`slot ${slot}: (f) ${outside.length} byte(s) changed OUTSIDE the drum layer: ${outside.slice(0, 16).map((o) => `0x${o.toString(16)}(${a[o]}->${b[o]})`).join(', ')}${outside.length > 16 ? ` (+${outside.length - 16} more)` : ''}`);
  // Also state the drum chain explicitly.
  console.log(`     drum chain slots now [${b[0x2d4]},${b[0x2d5]}] (midi2 chain is [${b[0x2d0]},${b[0x2d1]}], untouched)`);
}

console.log('\n===== (g) untouched neighbours =====');
for (const slot of WITNESSES) {
  const a = pre.get(slot); const b = post.get(slot);
  if (a === undefined || b === undefined) { fail(`witness ${slot}: missing capture`); continue; }
  if (Buffer.from(a).equals(Buffer.from(b))) ok(`witness Project ${slot} byte-identical across all ${NCS_FILE_SIZE} bytes`);
  else fail(`witness ${slot} MOVED`);
}

console.log(`\n${failures === 0 ? 'PHASE 4 PASS — 7/7 populated, everything else byte-identical' : `${failures} FAILURES`}`);
process.exitCode = failures === 0 ? 0 : 1;
