/**
 * circuit-pad-pickup-head — pad a project's HEAD pattern with leading rests so
 * a fused pickup (anacrusis) bar fills a whole 4/4 bar.
 *
 * WHY (2026-08-08, hardware-confirmed on the RC-505mk2): a project whose head
 * pattern is a partial bar (one song's slot 27: 24 steps = 2/4 pickup +
 * one bar; another's slot 25: 8 steps = the pickup alone) puts EVERY barline
 * of the whole multi-project song off the 4-beat grid a clock-slaved looper
 * counts from MIDI Start — its measure-quantized record-start then always
 * fires on the song's "3", never the one. A non-whole-bar chain cycle also
 * drifts further on every wrap. Padding the head to a whole bar fixes both;
 * the Play press becomes a short count before the pickup (the deliberate feel
 * change, owner-approved 2026-08-08 — see circuit-count-in-design-2026-07-29).
 *
 * WHAT IT DOES, per track (all 8: synth1/2, midi1/2, drum1-4) whose pattern-1
 * length equals --old-head-steps:
 *   - shifts the pattern-1 content +pad steps (raw in-region byte moves: the
 *     28-byte note step records / the four 32-byte drum lanes), filling the
 *     freed head steps with the pattern's own post-content EMPTY bytes so the
 *     template dialect is preserved verbatim;
 *   - sets the pattern-1 length byte to old+pad.
 * Tracks at any OTHER length are reported and left untouched (an unauthored
 * track still on the template's 16 default is silent and unchained; padding
 * it would be pure churn).
 *
 * SAFETY: dry-run by default (pass --write to emit the output file); refuses
 * unless the input is structurally a Circuit Tracks project and at least one
 * track matches the stated old length; ALWAYS verifies its own output before
 * reporting success: (a) decode-level — every old step reappears exactly
 * `pad` steps later, the head decodes empty; (b) byte-level — a full diff of
 * old vs new must fall entirely inside the participants' pattern-1 regions +
 * their length bytes (any stray byte is a hard FAIL); (c) reports the chain
 * cycle in bars before/after and warns if the result is still not whole bars.
 *
 * The device write stays on the normal gated path: transform a freshly
 * downloaded copy, then upload_project (backup_first) — this script touches
 * no MIDI and no card.
 *
 * Usage:
 *   npx tsx scripts/circuit-pad-pickup-head.ts <in.ncs> <out.ncs> --old-head-steps 24 --pad 8 [--write]
 */

import { readFileSync, writeFileSync } from 'node:fs';

import {
  META_OFFSETS,
  NCS_FILE_SIZE,
  STEPS_PER_PATTERN,
  checkNcsStructure,
  drumBlockIndex,
  drumRowBase,
  noteBlockIndex,
  noteStepBase,
  type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';
import { NOTE_STEP_BYTES } from '../packages/circuit-tracks/src/ncs/format.js';
import { decodeNotePattern } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../packages/circuit-tracks/src/ncs/drumPattern.js';
import { getNoteChain, lengthByte } from '../packages/circuit-tracks/src/ncs/chain.js';

const NOTE_TRACKS: readonly NoteTrack[] = ['synth1', 'synth2', 'midi1', 'midi2'];
const DRUM_TRACKS = [0, 1, 2, 3] as const;
const DRUM_LANES = [0, 32, 64, 96] as const; // velocity / probability / drum_choice / rhythm rows

interface Args { input: string; output: string; oldSteps: number; pad: number; write: boolean }

function parseArgs(argv: readonly string[]): Args {
  const rest: string[] = [];
  let oldSteps: number | undefined;
  let pad: number | undefined;
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--old-head-steps') oldSteps = Number(argv[++i]);
    else if (a === '--pad') pad = Number(argv[++i]);
    else if (a === '--write') write = true;
    else rest.push(a);
  }
  if (rest.length !== 2 || oldSteps === undefined || pad === undefined
    || !Number.isInteger(oldSteps) || !Number.isInteger(pad)
    || oldSteps < 1 || pad < 1 || oldSteps + pad > STEPS_PER_PATTERN) {
    console.error('usage: circuit-pad-pickup-head.ts <in.ncs> <out.ncs> --old-head-steps N --pad M [--write]');
    console.error(`       (N + M must fit one pattern, <= ${STEPS_PER_PATTERN} steps)`);
    process.exit(2);
  }
  return { input: rest[0], output: rest[1], oldSteps, pad, write };
}

const args = parseArgs(process.argv.slice(2));
const original = new Uint8Array(readFileSync(args.input));
const structure = checkNcsStructure(original);
if (!structure.ok) {
  console.error(`REFUSED: '${args.input}' is not a Circuit Tracks project: ${structure.faults.join('; ')}`);
  process.exit(1);
}

const { oldSteps, pad } = args;
const newSteps = oldSteps + pad;
const buf = original.slice();

// ── who participates: every track whose pattern-1 length equals oldSteps ────
const noteParticipants = NOTE_TRACKS.filter((t) => original[META_OFFSETS[noteBlockIndex(t, 0)]] === lengthByte(oldSteps));
const drumParticipants = DRUM_TRACKS.filter((t) => original[META_OFFSETS[drumBlockIndex(t, 0)]] === lengthByte(oldSteps));
const skipped = [
  ...NOTE_TRACKS.filter((t) => !noteParticipants.includes(t)).map((t) => `${t} (len ${original[META_OFFSETS[noteBlockIndex(t, 0)]] + 1})`),
  ...DRUM_TRACKS.filter((t) => !drumParticipants.includes(t)).map((t) => `drum${t + 1} (len ${original[META_OFFSETS[drumBlockIndex(t, 0)]] + 1})`),
];
if (noteParticipants.length + drumParticipants.length === 0) {
  console.error(`REFUSED: no track's pattern 1 is ${oldSteps} steps. Lengths found: ${skipped.join(', ')}. `
    + 'State the head length the project actually holds (--old-head-steps), or this is the wrong project.');
  process.exit(1);
}

// ── the shift, raw in-region byte moves ─────────────────────────────────────
for (const t of noteParticipants) {
  const base = noteStepBase(t, 0);
  // The empty-step prototype: the pattern's own first post-content step,
  // captured BEFORE the move (for a 24+8 head the shift fills the region
  // exactly, so afterwards no template-empty step would remain to copy).
  const protoOff = base + oldSteps * NOTE_STEP_BYTES;
  const proto = buf.slice(protoOff, protoOff + NOTE_STEP_BYTES);
  buf.copyWithin(base + pad * NOTE_STEP_BYTES, base, base + oldSteps * NOTE_STEP_BYTES);
  for (let s = 0; s < pad; s++) buf.set(proto, base + s * NOTE_STEP_BYTES);
  buf[META_OFFSETS[noteBlockIndex(t, 0)]] = lengthByte(newSteps);
}
for (const t of drumParticipants) {
  const rb = drumRowBase(t, 0);
  for (const lane of DRUM_LANES) {
    const proto = buf[rb + lane + oldSteps];
    buf.copyWithin(rb + lane + pad, rb + lane, rb + lane + oldSteps);
    for (let s = 0; s < pad; s++) buf[rb + lane + s] = proto;
  }
  buf[META_OFFSETS[drumBlockIndex(t, 0)]] = lengthByte(newSteps);
}

// ── verify (a): decode-level — content shifted exactly, head empty ──────────
let failures = 0;
const fail = (msg: string): void => { failures++; console.error(`  FAIL  ${msg}`); };
const ok = (msg: string): void => console.log(`  ok    ${msg}`);

for (const t of noteParticipants) {
  const before = decodeNotePattern(original, t, 0);
  const after = decodeNotePattern(buf, t, 0);
  let shifted = true;
  for (let s = 0; s < oldSteps; s++) {
    if (JSON.stringify(after[s + pad]) !== JSON.stringify(before[s])) { shifted = false; break; }
  }
  shifted ? ok(`${t}: all ${oldSteps} steps reappear exactly ${pad} steps later`) : fail(`${t}: shifted content mismatch`);
  const headEmpty = after.slice(0, pad).every((s) => s.notes.length === 0 && s.slotMask === 0);
  headEmpty ? ok(`${t}: the ${pad}-step head decodes empty`) : fail(`${t}: head not empty after pad`);
}
for (const t of drumParticipants) {
  const before = decodeDrumPattern(original, t, 0);
  const after = decodeDrumPattern(buf, t, 0);
  let shifted = true;
  for (let s = 0; s < oldSteps; s++) {
    if (JSON.stringify(after[s + pad]) !== JSON.stringify(before[s])) { shifted = false; break; }
  }
  shifted ? ok(`drum${t + 1}: all ${oldSteps} steps reappear exactly ${pad} steps later`) : fail(`drum${t + 1}: shifted content mismatch`);
  const headEmpty = after.slice(0, pad).every((s) => !s.active);
  headEmpty ? ok(`drum${t + 1}: the ${pad}-step head decodes inactive`) : fail(`drum${t + 1}: head not inactive after pad`);
}

// ── verify (b): byte-level — every diff inside an allowed region ────────────
const allowed = (off: number): boolean => {
  for (const t of noteParticipants) {
    const base = noteStepBase(t, 0);
    if (off >= base && off < base + STEPS_PER_PATTERN * NOTE_STEP_BYTES) return true;
    if (off === META_OFFSETS[noteBlockIndex(t, 0)]) return true;
  }
  for (const t of drumParticipants) {
    const rb = drumRowBase(t, 0);
    if (off >= rb && off < rb + 128) return true;
    if (off === META_OFFSETS[drumBlockIndex(t, 0)]) return true;
  }
  return false;
};
const stray: number[] = [];
let changed = 0;
for (let i = 0; i < NCS_FILE_SIZE; i++) {
  if (buf[i] !== original[i]) { changed++; if (!allowed(i)) stray.push(i); }
}
stray.length === 0
  ? ok(`byte audit: ${changed} byte(s) changed, ALL inside the participants' pattern-1 regions + length bytes`)
  : fail(`byte audit: ${stray.length} STRAY byte(s) outside the allowed regions: ${stray.slice(0, 8).map((o) => `0x${o.toString(16)}`).join(', ')}${stray.length > 8 ? ', …' : ''}`);

// ── verify (c): the chain cycle in bars, before and after ───────────────────
const cycleSteps = (b: Uint8Array): number | undefined => {
  // Every participant track shares one chain shape in these builds; read the
  // widest note-track chain (or pattern-1-only when unchained).
  let range: { start: number; end: number } | undefined;
  for (const t of NOTE_TRACKS) range = getNoteChain(b, t) ?? range;
  const lens: number[] = [];
  for (let p = range?.start ?? 0; p <= (range?.end ?? 0); p++) {
    lens.push(b[META_OFFSETS[noteBlockIndex(noteParticipants[0] ?? 'synth1', p)]] + 1);
  }
  return lens.reduce((a, n) => a + n, 0);
};
const before = cycleSteps(original);
const after = cycleSteps(buf);
if (before !== undefined && after !== undefined) {
  console.log(`  chain cycle: ${before} steps (${before / 16} bars) -> ${after} steps (${after / 16} bars)`);
  if (after % 16 !== 0) {
    console.warn('  WARN: the padded cycle is still not a whole number of 4/4 bars; linger wraps will still drift.');
  }
}

if (failures > 0) {
  console.error(`\n${failures} verification failure(s); nothing written.`);
  process.exit(1);
}
console.log(`\n${noteParticipants.join(', ')}${noteParticipants.length && drumParticipants.length ? ', ' : ''}`
  + `${drumParticipants.map((t) => `drum${t + 1}`).join(', ')}: pattern 1 padded ${oldSteps} -> ${newSteps} steps (${pad} leading rests).`);
if (skipped.length > 0) console.log(`untouched (length differs): ${skipped.join(', ')}`);
if (args.write) {
  writeFileSync(args.output, buf);
  console.log(`WROTE ${args.output}`);
} else {
  console.log(`DRY RUN: verified in memory only. Re-run with --write to emit ${args.output}.`);
}
