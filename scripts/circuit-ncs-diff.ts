/**
 * circuit-ncs-diff — byte-diff two Circuit Tracks `.ncs` files and CLASSIFY every
 * changed run against the known project regions. Built for the note-track
 * multi-pattern RE (docs/_private/HANDOFF-circuit-multipattern.md): upload a
 * baseline, do a native switch on the device, export the slot, and diff the two.
 * The classifier immediately says whether the device wrote into the per-track
 * CHAIN table (0x2c4 region → pattern-chain-driven) or the SCENE stack
 * (0x50 + N*0x28 → scene-driven), so we stop guessing which mechanism switches
 * the note track.
 *
 *   npx tsx scripts/circuit-ncs-diff.ts <baseline.ncs> <exported.ncs>
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import {
  NCS_FILE_SIZE, META_OFFSETS, NOTE_STEP_REGION, DRUM_STEP_REGION,
} from '@mcp-midi-control/circuit-tracks/ncs/format.js';

// Chain-table track order is note-tracks-first (HARDWARE-CONFIRMED for the two
// MIDI tracks + the drum group; within-pair synth1/synth2 and per-drum order are
// inferred from Circuit's canonical track order — see chain.ts).
const GLOBAL_TRACKS = ['synth1', 'synth2', 'midi1', 'midi2', 'drum1', 'drum2', 'drum3', 'drum4'];

/** Per-track chain table: base 0x2c4, stride 4 → start@base+t*4, end@+1 (matches chain.ts). */
const CHAIN_BASE = 0x2c4;
const CHAIN_STRIDE = 4;
/** Scene block geometry: 16 scenes, 0x28 bytes each, starting at 0x50 (decoded from a
 * scene-baked reference; the scene-chain END byte at 0x2c1 sits right after them). */
const SCENE_BASE = 0x50;
const SCENE_STRIDE = 0x28;
const SCENE_COUNT = 16;
const SCENE_CHAIN_END = 0x2c1;

/** Classify a single absolute offset into a human-readable region label. */
function classify(off: number): string {
  if (off === 0x2c1) return 'SCENE-CHAIN END (0x2c1)';
  if (off >= CHAIN_BASE && off < CHAIN_BASE + GLOBAL_TRACKS.length * CHAIN_STRIDE) {
    const t = Math.floor((off - CHAIN_BASE) / CHAIN_STRIDE);
    const field = (off - CHAIN_BASE) % CHAIN_STRIDE === 0 ? 'start' : (off - CHAIN_BASE) % CHAIN_STRIDE === 1 ? 'end' : `+${(off - CHAIN_BASE) % CHAIN_STRIDE}`;
    return `CHAIN table → ${GLOBAL_TRACKS[t]} ${field}`;
  }
  if (off >= SCENE_BASE && off < SCENE_BASE + SCENE_COUNT * SCENE_STRIDE) {
    const n = Math.floor((off - SCENE_BASE) / SCENE_STRIDE);
    const within = (off - SCENE_BASE) % SCENE_STRIDE;
    return `SCENE stack → scene ${n + 1} (+0x${within.toString(16)} within the ${SCENE_STRIDE}-byte block)`;
  }
  // Note / drum step + metadata regions.
  for (let b = 0; b < META_OFFSETS.length; b++) {
    const meta = META_OFFSETS[b];
    const isDrum = b >= 16 && b < 48;
    const region = isDrum ? DRUM_STEP_REGION : NOTE_STEP_REGION;
    if (off === meta) return `${blockLabel(b)} metadata byte (length/etc @0x${meta.toString(16)})`;
    if (off >= meta - region && off < meta) return `${blockLabel(b)} STEP data`;
  }
  if (off === 0x10 || (off >= 0x10 && off < 0x20)) return 'project NAME (0x10)';
  if (off >= 0x1a200 && off < 0x1a300) return 'scene-selection state (0x1a2xx)';
  if (off >= 0x26f00 && off < 0x27000) return 'scene-select state / chain tail (0x26fxx)';
  return '?? UNCLASSIFIED';
}

function blockLabel(b: number): string {
  if (b < 16) return `synth${b < 8 ? 1 : 2} pat${b % 8}`;
  if (b < 48) { const d = b - 16; return `drum${Math.floor(d / 8) + 1} pat${d % 8}`; }
  const m = b - 48; return `midi${m < 8 ? 1 : 2} pat${m % 8}`;
}

function load(path: string): Uint8Array {
  const buf = new Uint8Array(readFileSync(path));
  if (buf.length !== NCS_FILE_SIZE) throw new Error(`${path}: expected ${NCS_FILE_SIZE}-byte .ncs, got ${buf.length}`);
  return buf;
}

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.log('usage: npx tsx scripts/circuit-ncs-diff.ts <baseline.ncs> <exported.ncs>');
  process.exit(1);
}

const a = load(aPath);
const b = load(bPath);
console.log(`diff  baseline=${basename(aPath)}  exported=${basename(bPath)}\n`);

// Collect differing offsets, group into contiguous runs.
const diffs: number[] = [];
for (let i = 0; i < NCS_FILE_SIZE; i++) if (a[i] !== b[i]) diffs.push(i);

if (diffs.length === 0) { console.log('  (identical — the export == the baseline; the native switch changed nothing on disk)'); process.exit(0); }

let runStart = diffs[0];
let prev = diffs[0];
const flush = (end: number): void => {
  const run: number[] = [];
  for (let i = runStart; i <= end; i++) if (a[i] !== b[i]) run.push(i);
  const from = run.map((o) => a[o].toString(16).padStart(2, '0')).join(' ');
  const to = run.map((o) => b[o].toString(16).padStart(2, '0')).join(' ');
  console.log(`  @0x${runStart.toString(16)}..0x${end.toString(16)} (${run.length}B)  [${classify(runStart)}]`);
  console.log(`     base : ${from}`);
  console.log(`     exp  : ${to}`);
};
for (const o of diffs.slice(1)) {
  if (o !== prev + 1) { flush(prev); runStart = o; }
  prev = o;
}
flush(prev);
console.log(`\n  ${diffs.length} changed byte(s) in ${new Set(diffs.map((o) => classify(o))).size} region class(es).`);
