/**
 * circuit-drop-head-patterns — remove the first N patterns from a Circuit
 * Tracks project so playback begins where the remaining content starts.
 *
 * WHY (2026-08-09, one song's performance redesign): under the owner's
 * empty-first-project convention, the phase a performer plays SOLO lives in
 * the song's `<Song> 00 Ready` project (untimed — they loop until ready),
 * so the first CONTENT project must begin at the band entry. That song's P1
 * carried 4 pad-only patterns (m1-8, the guitar-solo bars) before the drums
 * at m9; this tool cuts such leading patterns. It is the inverse of
 * `circuit-pad-pickup-head.ts`.
 *
 * WHAT IT DOES, for ALL 8 tracks: moves pattern regions [N..8) to [0..8-N)
 * (raw byte copies: the 896-byte note-step regions, the 128-byte drum lane
 * regions, the length bytes), clears the freed tail patterns to the
 * project's own empty-step dialect (prototypes harvested from the input),
 * resets tail lengths to the template 16, and rewrites every CHAINED
 * track's chain end to `end - N` (start must be 0; the chain START byte is
 * only hardware-proven at 0). Scene-chained projects are REFUSED (pattern
 * indices in scene tables would dangle).
 *
 * SAFETY: dry-run by default (--write to emit); refuses unless the input is
 * structurally valid, every chained track's chain covers the drop, and the
 * dropped patterns are what the caller EXPECTS (--expect-dropped-empty
 * requires every dropped pattern to be empty on the named kinds, e.g.
 * "drums" = no drum/midi2 content, so a cut can never silently eat drums).
 * Always self-verifies: decode-level shift equality on every track, cleared
 * tails, chain ends, and a whole-file byte audit confined to the pattern
 * areas + length bytes + chain bytes.
 *
 * Usage:
 *   npx tsx scripts/circuit-drop-head-patterns.ts <in.ncs> <out.ncs> --drop 4 [--expect-dropped-empty drums] [--write]
 */

import { readFileSync, writeFileSync } from 'node:fs';

import {
  META_OFFSETS,
  NCS_FILE_SIZE,
  NOTE_STEP_BYTES,
  STEPS_PER_PATTERN,
  checkNcsStructure,
  drumBlockIndex,
  drumRowBase,
  noteBlockIndex,
  noteStepBase,
  type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';
import { decodeNotePattern } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../packages/circuit-tracks/src/ncs/drumPattern.js';
import { getSceneChainEnd } from '../packages/circuit-tracks/src/ncs/sceneChain.js';

const NOTE_TRACKS: readonly NoteTrack[] = ['synth1', 'synth2', 'midi1', 'midi2'];
const CHAIN_BASE = 0x2c4;
const NOTE_REGION = STEPS_PER_PATTERN * NOTE_STEP_BYTES; // 896
const DRUM_REGION = 128;
const PATTERNS = 8;
const TEMPLATE_LENGTH_BYTE = 0x0f; // 16 steps

interface Args { input: string; output: string; drop: number; write: boolean; expectDroppedEmpty?: string }
function parseArgs(argv: readonly string[]): Args {
  const rest: string[] = [];
  let drop: number | undefined;
  let write = false;
  let expectDroppedEmpty: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--drop') drop = Number(argv[++i]);
    else if (a === '--write') write = true;
    else if (a === '--expect-dropped-empty') expectDroppedEmpty = argv[++i];
    else rest.push(a);
  }
  if (rest.length !== 2 || drop === undefined || !Number.isInteger(drop) || drop < 1 || drop >= PATTERNS) {
    console.error('usage: circuit-drop-head-patterns.ts <in.ncs> <out.ncs> --drop N (1..7) [--expect-dropped-empty drums] [--write]');
    process.exit(2);
  }
  return { input: rest[0], output: rest[1], drop, write, expectDroppedEmpty };
}

const args = parseArgs(process.argv.slice(2));
const original = new Uint8Array(readFileSync(args.input));
const structure = checkNcsStructure(original);
if (!structure.ok) {
  console.error(`REFUSED: '${args.input}' is not a Circuit Tracks project: ${structure.faults.join('; ')}`);
  process.exit(1);
}
const sceneEnd = getSceneChainEnd(original);
if (sceneEnd !== undefined && sceneEnd > 0) {
  console.error(`REFUSED: this project uses a SCENE chain (${sceneEnd} scene step(s)); dropping patterns would dangle its scene tables. Re-author instead.`);
  process.exit(1);
}
const { drop } = args;

// Chain slots: [start, end] per track; note slots 0-3, drums 4-7.
const chains = Array.from({ length: 8 }, (_, i) => ({
  start: original[CHAIN_BASE + i * 4],
  end: original[CHAIN_BASE + i * 4 + 1],
}));
for (let i = 0; i < 8; i++) {
  const c = chains[i];
  if (c.end > c.start) {
    if (c.start !== 0) { console.error(`REFUSED: chain slot ${i} starts at pattern ${c.start + 1}; only start=1 chains are hardware-proven.`); process.exit(1); }
    if (c.end < drop) { console.error(`REFUSED: chain slot ${i} ends at pattern ${c.end + 1}, shorter than the ${drop}-pattern drop.`); process.exit(1); }
  }
}

// Expectation gate: the dropped patterns must be empty on the named kinds.
if (args.expectDroppedEmpty === 'drums') {
  for (let p = 0; p < drop; p++) {
    const midi2 = decodeNotePattern(original, 'midi2', p).reduce((n, s) => n + s.notes.length, 0);
    const internal = [0, 1, 2, 3].reduce((n, d) => n + decodeDrumPattern(original, d, p).filter((s) => s.active).length, 0);
    if (midi2 > 0 || internal > 0) {
      console.error(`REFUSED: dropped pattern ${p + 1} carries drum content (midi2 ${midi2} note(s), internal ${internal} hit(s)) — not the expected empty-of-drums head.`);
      process.exit(1);
    }
  }
}

const buf = original.slice();

// Empty-step prototypes, harvested from the INPUT's own bytes.
function noteEmptyProto(t: NoteTrack): Uint8Array | undefined {
  for (let p = 0; p < PATTERNS; p++) {
    const base = noteStepBase(t, p);
    for (let s = 0; s < STEPS_PER_PATTERN; s++) {
      if (original[base + s * NOTE_STEP_BYTES] === 0) {
        return original.slice(base + s * NOTE_STEP_BYTES, base + (s + 1) * NOTE_STEP_BYTES);
      }
    }
  }
  return undefined;
}
function drumEmptyProto(t: number): [number, number, number, number] | undefined {
  for (let p = 0; p < PATTERNS; p++) {
    const rb = drumRowBase(t, p);
    for (let s = 0; s < STEPS_PER_PATTERN; s++) {
      if (original[rb + 96 + s] === 0) {
        return [original[rb + s], original[rb + 32 + s], original[rb + 64 + s], original[rb + 96 + s]];
      }
    }
  }
  return undefined;
}

// The move + tail clear + length bytes, all 8 tracks.
for (const t of NOTE_TRACKS) {
  for (let p = drop; p < PATTERNS; p++) {
    buf.copyWithin(noteStepBase(t, p - drop), noteStepBase(t, p), noteStepBase(t, p) + NOTE_REGION);
    buf[META_OFFSETS[noteBlockIndex(t, p - drop)]] = original[META_OFFSETS[noteBlockIndex(t, p)]];
  }
  const proto = noteEmptyProto(t);
  for (let p = PATTERNS - drop; p < PATTERNS; p++) {
    if (proto !== undefined) {
      const base = noteStepBase(t, p);
      for (let s = 0; s < STEPS_PER_PATTERN; s++) buf.set(proto, base + s * NOTE_STEP_BYTES);
    }
    buf[META_OFFSETS[noteBlockIndex(t, p)]] = TEMPLATE_LENGTH_BYTE;
  }
}
for (let t = 0; t < 4; t++) {
  for (let p = drop; p < PATTERNS; p++) {
    buf.copyWithin(drumRowBase(t, p - drop), drumRowBase(t, p), drumRowBase(t, p) + DRUM_REGION);
    buf[META_OFFSETS[drumBlockIndex(t, p - drop)]] = original[META_OFFSETS[drumBlockIndex(t, p)]];
  }
  const proto = drumEmptyProto(t);
  for (let p = PATTERNS - drop; p < PATTERNS; p++) {
    if (proto !== undefined) {
      const rb = drumRowBase(t, p);
      for (let s = 0; s < STEPS_PER_PATTERN; s++) {
        buf[rb + s] = proto[0]; buf[rb + 32 + s] = proto[1]; buf[rb + 64 + s] = proto[2]; buf[rb + 96 + s] = proto[3];
      }
    }
    buf[META_OFFSETS[drumBlockIndex(t, p)]] = TEMPLATE_LENGTH_BYTE;
  }
}
for (let i = 0; i < 8; i++) {
  if (chains[i].end > chains[i].start) buf[CHAIN_BASE + i * 4 + 1] = chains[i].end - drop;
}

// ── self-verify ─────────────────────────────────────────────────────────────
let failures = 0;
const fail = (m: string): void => { failures++; console.error(`  FAIL  ${m}`); };
const ok = (m: string): void => console.log(`  ok    ${m}`);

for (const t of NOTE_TRACKS) {
  let shifted = true;
  for (let p = 0; p < PATTERNS - drop; p++) {
    if (JSON.stringify(decodeNotePattern(buf, t, p)) !== JSON.stringify(decodeNotePattern(original, t, p + drop))) { shifted = false; break; }
  }
  shifted ? ok(`${t}: patterns ${drop + 1}-8 now play as 1-${PATTERNS - drop}`) : fail(`${t}: shifted content mismatch`);
  const tailEmpty = Array.from({ length: drop }, (_, i) => PATTERNS - drop + i)
    .every((p) => decodeNotePattern(buf, t, p).every((s) => s.notes.length === 0));
  tailEmpty ? ok(`${t}: freed tail patterns decode empty`) : fail(`${t}: freed tail not empty`);
}
for (let t = 0; t < 4; t++) {
  let shifted = true;
  for (let p = 0; p < PATTERNS - drop; p++) {
    if (JSON.stringify(decodeDrumPattern(buf, t, p)) !== JSON.stringify(decodeDrumPattern(original, t, p + drop))) { shifted = false; break; }
  }
  shifted ? ok(`drum${t + 1}: patterns ${drop + 1}-8 now play as 1-${PATTERNS - drop}`) : fail(`drum${t + 1}: shifted content mismatch`);
}

const allowed = (off: number): boolean => {
  for (const t of NOTE_TRACKS) {
    for (let p = 0; p < PATTERNS; p++) {
      const base = noteStepBase(t, p);
      if (off >= base && off < base + NOTE_REGION) return true;
      if (off === META_OFFSETS[noteBlockIndex(t, p)]) return true;
    }
  }
  for (let t = 0; t < 4; t++) {
    for (let p = 0; p < PATTERNS; p++) {
      const rb = drumRowBase(t, p);
      if (off >= rb && off < rb + DRUM_REGION) return true;
      if (off === META_OFFSETS[drumBlockIndex(t, p)]) return true;
    }
  }
  if (off >= CHAIN_BASE && off < CHAIN_BASE + 8 * 4) return true;
  return false;
};
const stray: number[] = [];
let changed = 0;
for (let i = 0; i < NCS_FILE_SIZE; i++) {
  if (buf[i] !== original[i]) { changed++; if (!allowed(i)) stray.push(i); }
}
stray.length === 0
  ? ok(`byte audit: ${changed} byte(s) changed, ALL inside pattern areas + length bytes + chain slots`)
  : fail(`byte audit: ${stray.length} STRAY byte(s): ${stray.slice(0, 8).map((o) => `0x${o.toString(16)}`).join(', ')}${stray.length > 8 ? ', …' : ''}`);

const newCycle = ((): number | undefined => {
  const anyChained = chains.some((x) => x.end > x.start);
  if (!anyChained) return undefined;
  const slot = chains.findIndex((x) => x.end > x.start);
  const track = slot < 4 ? NOTE_TRACKS[slot] : undefined;
  let total = 0;
  for (let p = 0; p <= buf[CHAIN_BASE + slot * 4 + 1]; p++) {
    total += buf[META_OFFSETS[track !== undefined ? noteBlockIndex(track, p) : drumBlockIndex(slot - 4, p)]] + 1;
  }
  return total;
})();
if (newCycle !== undefined) {
  console.log(`  chain cycle: ${newCycle} steps (${newCycle / 16} bars)${newCycle % 16 !== 0 ? '  WARN: not whole bars' : ''}`);
}

if (failures > 0) { console.error(`\n${failures} verification failure(s); nothing written.`); process.exit(1); }
console.log(`\nDropped the first ${drop} pattern(s); content, lengths and chains shifted accordingly on all 8 tracks.`);
if (args.write) { writeFileSync(args.output, buf); console.log(`WROTE ${args.output}`); }
else console.log(`DRY RUN: verified in memory only. Re-run with --write to emit ${args.output}.`);
