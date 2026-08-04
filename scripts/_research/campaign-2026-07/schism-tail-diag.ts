/**
 * Schism tail-defect diagnosis (2026-07-29, read-only, NO device).
 * Run: npx tsx samples/_scratch/schism-tail-diag.ts   (from repo root)
 *
 * Compares the authored card bytes (samples/circuit-ncs/schism-levels-verify-2026-07-29)
 * against the source (samples/songsterr-cache/s6700, rev 8009215) per pattern window,
 * reproducing the exact import path (importSongsterrMelodic / importSongsterrDrums with
 * fromMeasure/toMeasure), for every slot 9-24 and every sounding track.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  importSongsterrMelodic, importSongsterrDrums, flattenSongsterrMelodic,
  pitchToken, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { packPatternsOnBarLines } from '../../packages/core/src/protocol-generic/patterns/songChop.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import {
  META_OFFSETS, noteBlockIndex, drumBlockIndex, getProjectName, type NoteTrack,
} from '../../packages/circuit-tracks/src/ncs/format.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s6700';
const NCS_DIR = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/schism-levels-verify-2026-07-29';
const load = (id: number) => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const part2 = load(2); // Synth 1
const part3 = load(3); // MIDI 1 (MicroFreak)
const part5 = load(5); // drums -> MIDI 2

const flatS1 = flattenSongsterrMelodic(part2);
const measures = flatS1.measures;

// windows per slot: plain parts pack on bar lines; 14/16 use the plan's explicit section lists
type Win = { from: number; to: number };
const plain: Record<number, [number, number]> = {
  9: [4, 19], 10: [20, 31], 11: [32, 43], 12: [44, 51], 13: [52, 67], 15: [86, 101],
  17: [118, 136], 18: [137, 155], 19: [156, 173], 20: [174, 191], 21: [192, 202],
  22: [203, 213], 23: [214, 226], 24: [227, 238],
};
const explicit: Record<number, Win[]> = {
  14: [[68, 69], [72, 73], [74, 75], [76, 77], [78, 79], [80, 81], [82, 84], [85, 85]].map(([f, t]) => ({ from: f, to: t })),
  16: [[102, 103], [104, 105], [106, 107], [108, 109], [110, 111], [112, 113], [116, 116], [117, 117]].map(([f, t]) => ({ from: f, to: t })),
};
function windowsFor(slot: number): Win[] {
  if (explicit[slot]) return explicit[slot];
  const [f, t] = plain[slot];
  return packPatternsOnBarLines(measures, f - 1, t - 1, 4, 32).map((w) => ({ from: w.from_measure, to: w.to_measure }));
}
const stepsOf = (w: Win): number => {
  let n = 0;
  for (let i = w.from - 1; i <= w.to - 1; i++) {
    const m = measures[i];
    n += Math.round(((m.signature[0] * 4) / m.signature[1]) * 4);
  }
  return n;
};

// expected content per window per source part (exactly the import path used at authoring)
interface ExpNote { step: number; pitches: number[] }
function expectMelodic(part: SongsterrPart, w: Win): { steps: number; notes: ExpNote[]; oow: number; offgrid: number } {
  const imp = importSongsterrMelodic(part, { fromMeasure: w.from, toMeasure: w.to });
  const notes: ExpNote[] = [];
  imp.steps.forEach((s: any, i: number) => {
    if (s.on) notes.push({ step: i, pitches: Array.isArray(s.notes) ? s.notes : [s.notes] });
  });
  return { steps: imp.steps.length, notes, oow: (imp as any).out_of_window ?? 0, offgrid: (imp as any).off_grid ?? 0 };
}
function expectDrums(w: Win): { steps: number; onsetSteps: number[] } {
  const imp = importSongsterrDrums(part5, { fromMeasure: w.from, toMeasure: w.to });
  const set = new Set<number>();
  for (const grid of Object.values(imp.voices)) {
    (grid as any[]).forEach((s, i) => { if (s.on) set.add(i); });
  }
  return { steps: imp.steps, onsetSteps: [...set].sort((a, b) => a - b) };
}

// authored content
const files = readdirSync(NCS_DIR).filter((f) => f.endsWith('.ncs'));
const bufOf = new Map<number, Uint8Array>();
for (const f of files) {
  const m = /project(\d+)/.exec(f);
  if (m) bufOf.set(Number(m[1]), new Uint8Array(readFileSync(join(NCS_DIR, f))));
}

const CHAIN_BASE = 0x2c4;
const chainOf = (buf: Uint8Array, slotIdx: number): [number, number] => [buf[CHAIN_BASE + slotIdx * 4], buf[CHAIN_BASE + slotIdx * 4 + 1]];
const NOTE_CHAIN_IDX: Record<string, number> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };
const noteLen = (buf: Uint8Array, t: NoteTrack, p: number): number => buf[META_OFFSETS[noteBlockIndex(t, p)]] + 1;
const drumLen = (buf: Uint8Array, t: number, p: number): number => buf[META_OFFSETS[drumBlockIndex(t, p)]] + 1;

function authoredNotes(buf: Uint8Array, t: NoteTrack, p: number): ExpNote[] {
  const out: ExpNote[] = [];
  decodeNotePattern(buf, t, p).forEach((s, i) => {
    if (s.active) out.push({ step: i, pitches: s.notes.map((n) => n.note).sort((a, b) => a - b) });
  });
  return out;
}
function authoredDrumUnion(buf: Uint8Array, p: number): number[] {
  const set = new Set<number>();
  for (let t = 0; t < 4; t++) decodeDrumPattern(buf, t, p).forEach((s, i) => { if (s.active) set.add(i); });
  return [...set].sort((a, b) => a - b);
}

// helper: name a step of a window as measure+beat
function stepPlace(w: Win, step: number): string {
  const b0 = measures[w.from - 1].startBeat;
  const beat = b0 + step / 4;
  let mi = w.from - 1;
  while (mi + 1 <= w.to - 1 && measures[mi + 1].startBeat <= beat + 1e-9) mi++;
  const inBar = beat - measures[mi].startBeat;
  return `m${mi + 1} beat ${(inBar + 1).toFixed(2)}`;
}

const fmt = (n: ExpNote): string => `${n.step}:${n.pitches.map(pitchToken).join('+')}`;

// ── the sweep ──────────────────────────────────────────────────────
const slots = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
for (const slot of slots) {
  const buf = bufOf.get(slot);
  if (!buf) { console.log(`slot ${slot}: NO FILE`); continue; }
  const wins = windowsFor(slot);
  console.log(`\n=== slot ${slot}  "${getProjectName(buf)}"  ${wins.length} windows  m${wins[0].from}-m${wins[wins.length - 1].to} ===`);
  console.log(`  plan steps: [${wins.map(stepsOf).join(',')}]`);
  const chains = ['synth1', 'synth2', 'midi1', 'midi2'].map((t, i) => `${t}=[${chainOf(buf, i).join('-')}]`).join(' ')
    + ' drums=' + [0, 1, 2, 3].map((t) => `[${chainOf(buf, 4 + t).join('-')}]`).join('');
  console.log(`  chains: ${chains}  sceneEnd@0x2c1=${buf[0x2c1]}`);

  // melodic tracks
  for (const [track, part] of [['synth1', part2], ['midi1', part3]] as Array<[NoteTrack, SongsterrPart]>) {
    const anyExpected = wins.some((w) => expectMelodic(part, w).notes.length > 0);
    const anyAuthored = [...Array(8).keys()].some((p) => authoredNotes(buf, track, p).length > 0);
    if (!anyExpected && !anyAuthored) continue;
    console.log(`  -- ${track} --  lens=[${[...Array(8).keys()].map((p) => noteLen(buf, track, p)).join(',')}]`);
    wins.forEach((w, i) => {
      const exp = expectMelodic(part, w);
      const got = authoredNotes(buf, track, i);
      const lenByte = noteLen(buf, track, i);
      const expSet = new Set(exp.notes.map(fmt));
      const gotSet = new Set(got.map(fmt));
      const missing = exp.notes.filter((n) => !gotSet.has(fmt(n)));
      const extra = got.filter((n) => !expSet.has(fmt(n)));
      const flag = missing.length > 0 || extra.length > 0 || lenByte !== exp.steps ? '  <<< MISMATCH' : '';
      console.log(`    pat${i + 1} m${w.from}-${w.to} expSteps=${exp.steps} lenByte=${lenByte} expOnsets=${exp.notes.length} gotOnsets=${got.length}`
        + (exp.oow > 0 ? ` OOW=${exp.oow}` : '') + flag);
      if (missing.length > 0) console.log(`      missing: ${missing.map((n) => `${fmt(n)}(${stepPlace(w, n.step)})`).join(' ')}`);
      if (extra.length > 0) console.log(`      extra:   ${extra.map(fmt).join(' ')}`);
    });
  }

  // drums: midi2 (external) + internal drum union
  const anyDrumAuthored = [...Array(8).keys()].some((p) => authoredNotes(buf, 'midi2', p).length > 0 || authoredDrumUnion(buf, p).length > 0);
  const anyDrumExpected = wins.some((w) => expectDrums(w).onsetSteps.length > 0);
  if (anyDrumAuthored || anyDrumExpected) {
    console.log(`  -- drums --  midi2 lens=[${[...Array(8).keys()].map((p) => noteLen(buf, 'midi2', p)).join(',')}]`
      + ` drum1 lens=[${[...Array(8).keys()].map((p) => drumLen(buf, 0, p)).join(',')}]`);
    wins.forEach((w, i) => {
      const exp = expectDrums(w);
      const gotM2 = authoredNotes(buf, 'midi2', i).map((n) => n.step);
      const gotDr = authoredDrumUnion(buf, i);
      const lenByte = noteLen(buf, 'midi2', i);
      const missM2 = exp.onsetSteps.filter((s) => !gotM2.includes(s));
      const extraM2 = gotM2.filter((s) => !exp.onsetSteps.includes(s));
      const flag = missM2.length > 0 || extraM2.length > 0 || lenByte !== exp.steps ? '  <<< MISMATCH' : '';
      console.log(`    pat${i + 1} m${w.from}-${w.to} expSteps=${exp.steps} lenByte=${lenByte} expOnsetSteps=${exp.onsetSteps.length} midi2=${gotM2.length} drumsU=${gotDr.length}${flag}`);
      if (missM2.length > 0) console.log(`      midi2 missing steps: ${missM2.map((s) => `${s}(${stepPlace(w, s)})`).join(' ')}`);
      if (extraM2.length > 0) console.log(`      midi2 extra steps:   ${extraM2.join(' ')}`);
    });
  }
}

// ── m118-136 signatures for the record ─────────────────────────────
console.log('\nSignatures m118-136: ' + [...Array(19).keys()].map((k) => {
  const m = measures[117 + k];
  return `m${118 + k}=${m.signature[0]}/${m.signature[1]}`;
}).join(' '));
