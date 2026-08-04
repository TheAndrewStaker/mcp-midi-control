/**
 * circuit-gate-census.ts — corpus census of the Circuit Tracks `.ncs` note GATE byte.
 *
 * WHY: the note-gate handoff doc asserted the gate field's ceiling is 96 (a
 * 96-value fractional field in sixths of a step). A scan found gate byte 224
 * (= 0x80 | 96) in real projects, which the ceiling claim cannot explain. This
 * script walks EVERY `.ncs` under `samples/`, decodes all 4 note tracks x 8
 * patterns x 32 steps x 6 slots, and reports the full gate-byte distribution
 * broken down by track, by step index, and by project, plus targeted views for
 * the bit-7 hypotheses (tie / range-extension / unrelated flag).
 *
 * READ-ONLY. Touches no device, writes no file. Run:
 *   npx tsx scripts/circuit-gate-census.ts            # summary
 *   npx tsx scripts/circuit-gate-census.ts --projects # + per-project table
 *   npx tsx scripts/circuit-gate-census.ts --name Gate  # dump matching projects
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  decodeNotePattern,
  gateByte,
  type NoteSlot,
  type NoteStep,
} from '../packages/circuit-tracks/src/ncs/notePattern.js';
import {
  NCS_FILE_SIZE,
  NOTE_TRACKS,
  PATTERNS_PER_TRACK,
  STEPS_PER_PATTERN,
  noteStepBase as noteBase,
  type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';

const ROOT = join(import.meta.dirname, '..');
const SAMPLES = join(ROOT, 'samples');

/**
 * This census is about the RAW gate LANE byte, so it re-joins what the decoder
 * splits. `decodeNotePattern` returns the gate magnitude and the tie flag as
 * separate fields (that split is the whole point of the decode this census
 * produced the evidence for), and the histograms below must keep reporting the
 * on-disk byte or the numbers stop matching the handoff doc they justify.
 */
const gb = (n: Pick<NoteSlot, 'gate' | 'tie'>): number => gateByte(n.gate, n.tie);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.ncs')) out.push(p);
  }
  return out;
}

function projectName(buf: Uint8Array): string {
  let s = '';
  for (let i = 0x10; i < 0x20; i++) s += String.fromCharCode(buf[i] & 0x7f);
  return s.trim();
}

interface Occ {
  file: string;
  name: string;
  track: NoteTrack;
  pattern: number;
  step: number;
  slot: number;
  note: number;
  gate: number;
  delay: number;
  velocity: number;
}

const argv = process.argv.slice(2);
const wantProjects = argv.includes('--projects');
const nameFilterIdx = argv.indexOf('--name');
const nameFilter = nameFilterIdx >= 0 ? argv[nameFilterIdx + 1] : undefined;

const files = walk(SAMPLES).sort();
const global = new Map<number, number>();
const byTrack = new Map<NoteTrack, Map<number, number>>();
const byStepHi = new Map<number, number>();          // step index -> count of hi-bit gates
const byStepAll = new Map<number, number>();         // step index -> count of all notes
const perProjectHi = new Map<string, number>();      // "rel  name" -> hi-bit count
const perProjectAll = new Map<string, number>();
const hiOccs: Occ[] = [];
const allSteps: { rel: string; name: string; track: NoteTrack; pattern: number; steps: NoteStep[] }[] = [];

let scanned = 0;
let skipped = 0;

for (const f of files) {
  if (statSync(f).size !== NCS_FILE_SIZE) { skipped++; continue; }
  const buf = new Uint8Array(readFileSync(f));
  const rel = relative(ROOT, f).replace(/\\/g, '/');
  const name = projectName(buf);
  scanned++;
  const key = `${rel}\t${name}`;
  perProjectAll.set(key, perProjectAll.get(key) ?? 0);
  perProjectHi.set(key, perProjectHi.get(key) ?? 0);

  for (const track of NOTE_TRACKS) {
    let tm = byTrack.get(track);
    if (!tm) { tm = new Map(); byTrack.set(track, tm); }
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const steps = decodeNotePattern(buf, track, p);
      allSteps.push({ rel, name, track, pattern: p, steps });
      for (let s = 0; s < STEPS_PER_PATTERN; s++) {
        for (let slot = 0; slot < steps[s].notes.length; slot++) {
          const n = steps[s].notes[slot];
          const byte = gb(n);
          global.set(byte, (global.get(byte) ?? 0) + 1);
          tm.set(byte, (tm.get(byte) ?? 0) + 1);
          byStepAll.set(s, (byStepAll.get(s) ?? 0) + 1);
          perProjectAll.set(key, (perProjectAll.get(key) ?? 0) + 1);
          if (n.tie) {
            byStepHi.set(s, (byStepHi.get(s) ?? 0) + 1);
            perProjectHi.set(key, (perProjectHi.get(key) ?? 0) + 1);
            hiOccs.push({ file: rel, name, track, pattern: p, step: s, slot, ...n, gate: byte });
          }
        }
      }
    }
  }
}

const fmtHist = (m: Map<number, number>) =>
  [...m.entries()].sort((a, b) => a[0] - b[0]).map(([v, c]) => `${v}:${c}`).join(' ');

console.log(`# Circuit .ncs GATE census`);
console.log(`files found: ${files.length}   scanned: ${scanned}   skipped (wrong size): ${skipped}`);
const totalNotes = [...global.values()].reduce((a, b) => a + b, 0);
console.log(`total note slots decoded (mask-active only): ${totalNotes}`);
console.log();

console.log(`## GLOBAL gate-byte histogram (value:count)`);
console.log(fmtHist(global));
console.log();

const lo = [...global.entries()].filter(([v]) => !(v & 0x80));
const hi = [...global.entries()].filter(([v]) => v & 0x80);
const loCount = lo.reduce((a, [, c]) => a + c, 0);
const hiCount = hi.reduce((a, [, c]) => a + c, 0);
console.log(`## bit-7 split`);
console.log(`bit7 CLEAR (0x00..0x7f): ${loCount} notes over ${lo.length} distinct values, max ${Math.max(...lo.map(([v]) => v))}`);
console.log(`bit7 SET   (0x80..0xff): ${hiCount} notes over ${hi.length} distinct values -> ${fmtHist(new Map(hi))}`);
console.log(`bit7-SET values with bit7 masked off: ${[...new Set(hi.map(([v]) => v & 0x7f))].sort((a, b) => a - b).join(' ')}`);
console.log(`sub-step (1..5) count: ${lo.filter(([v]) => v >= 1 && v <= 5).reduce((a, [, c]) => a + c, 0)}`);
console.log(`gate 0 count: ${global.get(0) ?? 0}   gate >96 with bit7 clear: ${lo.filter(([v]) => v > 96).reduce((a, [, c]) => a + c, 0)}`);
console.log();

console.log(`## per-TRACK histogram`);
for (const t of NOTE_TRACKS) {
  const m = byTrack.get(t) ?? new Map();
  const tot = [...m.values()].reduce((a, b) => a + b, 0);
  const h = [...m.entries()].filter(([v]) => v & 0x80).reduce((a, [, c]) => a + c, 0);
  console.log(`${t.padEnd(7)} notes=${String(tot).padStart(6)} bit7set=${String(h).padStart(5)}  hist: ${fmtHist(m)}`);
}
console.log();

console.log(`## bit7-SET occurrences by STEP index (step: hiCount / allNotesAtThatStep)`);
console.log([...Array(STEPS_PER_PATTERN).keys()]
  .map((s) => `${s}:${byStepHi.get(s) ?? 0}/${byStepAll.get(s) ?? 0}`).join('  '));
console.log();

// Is a bit7 note the FIRST SOUNDING note of its pattern, or literally step 0?
let hiIsFirstSounding = 0, hiIsStep0 = 0, hiIsBoth = 0, hiIsNeither = 0;
const firstSoundingOf = new Map<string, number>();
for (const { rel, track, pattern, steps } of allSteps) {
  const k = `${rel}|${track}|${pattern}`;
  const idx = steps.findIndex((s) => s.notes.length > 0);
  firstSoundingOf.set(k, idx);
}
for (const o of hiOccs) {
  const first = firstSoundingOf.get(`${o.file}|${o.track}|${o.pattern}`) ?? -1;
  const isFirst = o.step === first;
  const isZero = o.step === 0;
  if (isFirst && isZero) hiIsBoth++;
  else if (isFirst) hiIsFirstSounding++;
  else if (isZero) hiIsStep0++;
  else hiIsNeither++;
}
console.log(`## "step 0" vs "first sounding note of the pattern"`);
console.log(`bit7 notes that are BOTH step 0 and first-sounding : ${hiIsBoth}`);
console.log(`bit7 notes first-sounding but NOT step 0           : ${hiIsFirstSounding}`);
console.log(`bit7 notes at step 0 but NOT first-sounding        : ${hiIsStep0}  (impossible unless step0 empty)`);
console.log(`bit7 notes that are NEITHER                        : ${hiIsNeither}`);
console.log();

// Hypothesis: bit7 = tie into the NEXT step. If so, the next step should be
// meaningfully related (e.g. empty, or a continuation). Test what follows.
let nextEmpty = 0, nextSounding = 0, nextIsLastStep = 0;
let hiWithSameNoteNext = 0;
for (const o of hiOccs) {
  const entry = allSteps.find((a) => a.rel === o.file && a.track === o.track && a.pattern === o.pattern);
  if (!entry) continue;
  if (o.step === STEPS_PER_PATTERN - 1) { nextIsLastStep++; continue; }
  const nxt = entry.steps[o.step + 1];
  if (nxt.notes.length === 0) nextEmpty++;
  else {
    nextSounding++;
    if (nxt.notes.some((n) => n.note === o.note)) hiWithSameNoteNext++;
  }
}
console.log(`## what follows a bit7 note (tie hypothesis)`);
console.log(`next step EMPTY     : ${nextEmpty}`);
console.log(`next step SOUNDING  : ${nextSounding}  (of which same note number: ${hiWithSameNoteNext})`);
console.log(`bit7 note on last step (31): ${nextIsLastStep}`);
console.log();

// How far does a bit7 note's low-7-bit gate reach, vs the gap to the next note?
{
  const buckets = new Map<string, number>();
  for (const o of hiOccs) {
    const entry = allSteps.find((a) => a.rel === o.file && a.track === o.track && a.pattern === o.pattern);
    if (!entry) continue;
    let gap = 0;
    for (let s = o.step + 1; s < STEPS_PER_PATTERN; s++) { if (entry.steps[s].notes.length) break; gap++; }
    const reachSteps = (o.gate & 0x7f) / 6;
    buckets.set(`gate${o.gate}(low=${o.gate & 0x7f}=${reachSteps}st) gapToNextNote=${gap}st`,
      (buckets.get(`gate${o.gate}(low=${o.gate & 0x7f}=${reachSteps}st) gapToNextNote=${gap}st`) ?? 0) + 1);
  }
  console.log(`## bit7 note reach vs silence that follows`);
  for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${v.toString().padStart(5)}  ${k}`);
  console.log();
}

// TIE hypothesis, decisive form: the manual says a tie-forward note must have a
// gate that reaches the NEXT sounding note, and that the tie joins it to a note
// of the SAME pitch. Compare the bit7 population against the bit7-clear gate-96
// control population on the same track.
{
  const stat = (pred: (g: number) => boolean, label: string) => {
    let n = 0, abuts = 0, samePitch = 0, allSamePitch = 0;
    for (const entry of allSteps) {
      if (!entry.rel.startsWith('samples/circuit-ncs/pack5/')) continue;   // one copy per project
      for (let s = 0; s < STEPS_PER_PATTERN; s++) {
        for (const note of entry.steps[s].notes) {
          if (!pred(gb(note))) continue;
          n++;
          let next = -1;
          for (let t = s + 1; t < STEPS_PER_PATTERN; t++) if (entry.steps[t].notes.length) { next = t; break; }
          if (next < 0) continue;
          const reachSteps = note.gate / 6;
          if (s + reachSteps === next) abuts++;
          if (entry.steps[next].notes.some((m) => m.note === note.note)) samePitch++;
          const mine = new Set(entry.steps[s].notes.map((m) => m.note));
          if ([...mine].every((p) => entry.steps[next].notes.some((m) => m.note === p))) allSamePitch++;
        }
      }
    }
    console.log(`  ${label}: n=${n} abutsNextOnset=${abuts} nextHasSamePitch=${samePitch} nextContainsWholeChord=${allSamePitch}`);
  };
  console.log(`## TIE test — bit7 population vs a bit7-clear control (pack5 only)`);
  stat((g) => (g & 0x80) !== 0, 'bit7 SET (gate 224)          ');
  stat((g) => g === 96, 'control: gate 96, bit7 clear  ');
  stat((g) => g === 48, 'control: gate 48, bit7 clear  ');
  console.log();
}

// Are all six slots of a bit7 step also bit7? (chord coherence)
{
  let chordSteps = 0, chordAllHi = 0, chordMixed = 0;
  const seen = new Set<string>();
  for (const o of hiOccs) {
    const k = `${o.file}|${o.track}|${o.pattern}|${o.step}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const entry = allSteps.find((a) => a.rel === o.file && a.track === o.track && a.pattern === o.pattern);
    if (!entry) continue;
    const notes = entry.steps[o.step].notes;
    if (notes.length < 2) continue;
    chordSteps++;
    if (notes.every((n) => n.tie)) chordAllHi++; else chordMixed++;
  }
  console.log(`## bit7 on multi-note (chord) steps: ${chordSteps} chord steps contain a bit7 note; all-slots-hi=${chordAllHi}, mixed=${chordMixed}`);
  console.log();
}

// RAW-LANE scan of the 28-byte note step: is there any OTHER candidate storage
// for the manual's documented per-step "tie-forward" boolean? (header bytes 2/3,
// probability, or a high bit on note/delay/velocity)
{
  const hdr2 = new Map<number, number>();
  const hdr3 = new Map<number, number>();
  const prob = new Map<number, number>();
  const noteHi = new Map<number, number>();
  const delayLane = new Map<number, number>();
  const velHi = new Map<number, number>();
  for (const f of files) {
    const buf = new Uint8Array(readFileSync(f));
    for (const track of NOTE_TRACKS) {
      for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
        const base = (() => {
          // reuse the decoder's own base by decoding once is wasteful; recompute
          // from format helpers instead.
          return noteBase(track, p);
        })();
        for (let s = 0; s < STEPS_PER_PATTERN; s++) {
          const o = base + s * 28;
          if (buf[o] === 0) continue;              // inactive step: stale bytes, ignore
          hdr2.set(buf[o + 2], (hdr2.get(buf[o + 2]) ?? 0) + 1);
          hdr3.set(buf[o + 3], (hdr3.get(buf[o + 3]) ?? 0) + 1);
          prob.set(buf[o + 1], (prob.get(buf[o + 1]) ?? 0) + 1);
          for (let n = 0; n < 6; n++) {
            if (!((buf[o] >> n) & 1)) continue;
            const sl = o + 4 + n * 4;
            noteHi.set(buf[sl] & 0x80 ? 1 : 0, (noteHi.get(buf[sl] & 0x80 ? 1 : 0) ?? 0) + 1);
            delayLane.set(buf[sl + 2], (delayLane.get(buf[sl + 2]) ?? 0) + 1);
            velHi.set(buf[sl + 3] & 0x80 ? 1 : 0, (velHi.get(buf[sl + 3] & 0x80 ? 1 : 0) ?? 0) + 1);
          }
        }
      }
    }
  }
    // Integrity cross-check: the decoder-driven count and this independent raw
  // popcount must agree, or one of the two walks is wrong.
  const rawNotes = (noteHi.get(0) ?? 0) + (noteHi.get(1) ?? 0);
  const decNotes = [...global.values()].reduce((a, b) => a + b, 0);
  const allStepsNotes = allSteps.reduce((a, e) => a + e.steps.reduce((x, s) => x + s.notes.length, 0), 0);
  console.log(`## INTEGRITY: decoder-count=${decNotes} allSteps-count=${allStepsNotes} raw-popcount=${rawNotes}` +
    (decNotes === rawNotes && decNotes === allStepsNotes ? '  AGREE' : '  *** DISAGREE ***'));
  console.log(`## raw-lane scan over ACTIVE steps (competing homes for a tie flag?)`);
  console.log(`  header byte2 : ${fmtHist(hdr2)}`);
  console.log(`  header byte3 : ${fmtHist(hdr3)}`);
  console.log(`  probability  : ${fmtHist(prob)}`);
  console.log(`  note bit7 set: ${noteHi.get(1) ?? 0} of ${(noteHi.get(0) ?? 0) + (noteHi.get(1) ?? 0)}`);
  console.log(`  delay lane   : ${fmtHist(delayLane)}`);
  console.log(`  vel  bit7 set: ${velHi.get(1) ?? 0} of ${(velHi.get(0) ?? 0) + (velHi.get(1) ?? 0)}`);
  console.log();
}

// Corpus-group breakdown: does bit7 appear OUTSIDE the maintainer's own Pack 5
// (i.e. in factory / older device downloads that our authoring never touched)?
{
  const groups = new Map<string, Map<number, number>>();
  const groupOf = (rel: string) =>
    rel.startsWith('samples/circuit-ncs/pack5') ? 'circuit-ncs/pack5 (maintainer pack, device download)'
      : rel.startsWith('samples/circuit-ncs/') ? 'circuit-ncs/<backup+restore> (device downloads)'
        : rel.startsWith('samples/circuit-tracks/pack0') ? 'circuit-tracks/pack0 (factory "Hello Tracks" pack)'
          : rel.startsWith('samples/circuit-tracks/grooves') ? 'circuit-tracks/grooves (server-authored)'
            : 'circuit-tracks/<root> (older device downloads)';
  for (const { rel, steps } of allSteps) {
    const g = groupOf(rel);
    let m = groups.get(g); if (!m) { m = new Map(); groups.set(g, m); }
    for (const st of steps) for (const n of st.notes) m.set(gb(n), (m.get(gb(n)) ?? 0) + 1);
  }
  console.log(`## by CORPUS GROUP (is bit7 confined to one origin?)`);
  for (const [g, m] of [...groups.entries()].sort()) {
    const tot = [...m.values()].reduce((a, b) => a + b, 0);
    const h = [...m.entries()].filter(([v]) => v & 0x80).reduce((a, c) => a + c[1], 0);
    const maxLo = Math.max(...[...m.keys()].filter((v) => !(v & 0x80)), 0);
    const distinct = [...m.keys()].filter((v) => !(v & 0x80)).sort((a, b) => a - b);
    console.log(`  ${g}`);
    console.log(`    notes=${tot} bit7set=${h} maxLowGate=${maxLo} distinctLowGates=${distinct.length} -> ${distinct.join(',')}`);
  }
  console.log();
}

// Per-SONG (name prefix) gate sets, to check the handoff's Sugar / Clint claims.
{
  const songs = new Map<string, Map<number, number>>();
  for (const { rel, name, steps } of allSteps) {
    if (!rel.startsWith('samples/circuit-ncs/pack5/')) continue;   // one canonical copy per project
    const song = name.replace(/\s*(P\d+|\d+\/\d+)\s*$/, '').trim() || name;
    let m = songs.get(song); if (!m) { m = new Map(); songs.set(song, m); }
    for (const st of steps) for (const n of st.notes) m.set(gb(n), (m.get(gb(n)) ?? 0) + 1);
  }
  console.log(`## per-SONG gate sets (samples/circuit-ncs/pack5 only)`);
  for (const [song, m] of [...songs.entries()].sort()) {
    console.log(`  ${song.padEnd(16)} ${fmtHist(m)}`);
  }
  console.log();
}

if (wantProjects) {
  console.log(`## per-project (only projects with >=1 note)`);
  const rows = [...perProjectAll.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, b) => (perProjectHi.get(b[0])! - perProjectHi.get(a[0])!) || b[1] - a[1]);
  for (const [k, all] of rows) {
    const [rel, name] = k.split('\t');
    console.log(`${String(perProjectHi.get(k)).padStart(5)} hi / ${String(all).padStart(5)} notes   "${name}"   ${rel}`);
  }
  console.log();
}

if (nameFilter) {
  console.log(`## dump of projects whose name matches /${nameFilter}/i`);
  const re = new RegExp(nameFilter, 'i');
  const seenFiles = new Set<string>();
  for (const entry of allSteps) {
    if (!re.test(entry.name)) continue;
    const nonEmpty = entry.steps.some((s) => s.notes.length > 0);
    if (!nonEmpty) continue;
    if (!seenFiles.has(entry.rel)) { seenFiles.add(entry.rel); console.log(`\n=== "${entry.name}"  ${entry.rel}`); }
    console.log(`  ${entry.track} pattern ${entry.pattern}:`);
    for (let s = 0; s < STEPS_PER_PATTERN; s++) {
      const st = entry.steps[s];
      if (!st.notes.length) continue;
      const desc = st.notes.map((n) => `note=${n.note} gate=${gb(n)}${n.tie ? `(0x80|${n.gate})` : ''} dly=${n.delay} vel=${n.velocity}`).join(' | ');
      console.log(`    step ${String(s).padStart(2)} mask=0x${st.slotMask.toString(16).padStart(2, '0')} prob=${st.probability}  ${desc}`);
    }
  }
}
