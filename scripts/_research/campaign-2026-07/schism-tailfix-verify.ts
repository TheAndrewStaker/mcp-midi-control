/**
 * Schism tail-fix post-write verification (read-only, disk only; the device
 * capture is samples/circuit-ncs/schism-tailfix-verify-2026-07-29).
 * Run: npx tsx samples/_scratch/schism-tailfix-verify.ts
 *
 * Asserts, against the fresh device capture:
 *  A. TEN untouched slots (9-16, 21, 22): FULL-FILE byte-identity vs
 *     schism-levels-verify-2026-07-29.
 *  B. Six rewritten slots (17,18,19,20,23,24): header fields (name, colour,
 *     tempo, mixer levels), per-track length bytes == Option C packings,
 *     chain tables, and the defect doc's CLOSING-BAR content in the final
 *     chained pattern per sounding track.
 *  C. Shared-window identity: slot 17 patterns 1-7 and slot 23 patterns 1-6
 *     decode-identical to the pre-fix card (same source windows).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import {
  META_OFFSETS, noteBlockIndex, drumBlockIndex, getProjectName, type NoteTrack,
} from '../../packages/circuit-tracks/src/ncs/format.js';

const OLD_DIR = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/schism-levels-verify-2026-07-29';
const NEW_DIR = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/schism-tailfix-verify-2026-07-29';

const loadDir = (dir: string): Map<number, Buffer> => {
  const m = new Map<number, Buffer>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ncs'))) {
    const mm = /project(\d+)/.exec(f);
    if (mm) m.set(Number(mm[1]), readFileSync(join(dir, f)));
  }
  return m;
};
const oldOf = loadDir(OLD_DIR);
const newOf = loadDir(NEW_DIR);

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`ok: ${msg}`);

// ── A. ten untouched slots: full-file byte identity ─────────────────
console.log('=== A. untouched slots (full-file byte identity vs pre-fix card) ===');
for (const slot of [9, 10, 11, 12, 13, 14, 15, 16, 21, 22]) {
  const a = oldOf.get(slot); const b = newOf.get(slot);
  if (!a || !b) { fail(`slot ${slot}: missing capture (old=${!!a} new=${!!b})`); continue; }
  if (a.equals(b)) ok(`slot ${slot} byte-identical (${b.length} bytes)`);
  else {
    let first = -1, n = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { n++; if (first < 0) first = i; }
    fail(`slot ${slot} DIFFERS: ${n} bytes, first at 0x${first.toString(16)}`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────
const CHAIN_BASE = 0x2c4;
const chainOf = (buf: Buffer, idx: number): [number, number] => [buf[CHAIN_BASE + idx * 4], buf[CHAIN_BASE + idx * 4 + 1]];
const noteLens = (buf: Buffer, t: NoteTrack, n: number): number[] =>
  [...Array(n).keys()].map((p) => buf[META_OFFSETS[noteBlockIndex(t, p)]] + 1);
const drumLens = (buf: Buffer, t: number, n: number): number[] =>
  [...Array(n).keys()].map((p) => buf[META_OFFSETS[drumBlockIndex(t, p)]] + 1);
interface Onset { step: number; pitches: number[]; vels: number[] }
const noteOnsets = (buf: Buffer, t: NoteTrack, p: number): Onset[] => {
  const out: Onset[] = [];
  decodeNotePattern(buf, t, p).forEach((s: any, i: number) => {
    if (s.active) out.push({ step: i, pitches: s.notes.map((n: any) => n.note).sort((x: number, y: number) => x - y), vels: s.notes.map((n: any) => n.velocity) });
  });
  return out;
};
const drumSteps = (buf: Buffer, t: number, p: number): number[] => {
  const out: number[] = [];
  decodeDrumPattern(buf, t, p).forEach((s: any, i: number) => { if (s.active) out.push(i); });
  return out;
};
// pitch name -> midi (c4 = 60)
const midi = (tok: string): number => {
  const m = /^([a-g])(#|b)?(-?\d)$/.exec(tok.toLowerCase());
  if (!m) throw new Error(`bad pitch ${tok}`);
  const base: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  return base[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
};
const expectPitches = (buf: Buffer, t: NoteTrack, p: number, want: Array<[number, string[]]>, label: string): void => {
  const got = noteOnsets(buf, t, p);
  const bad: string[] = [];
  for (const [step, pitches] of want) {
    const g = got.find((o) => o.step === step);
    const wantP = pitches.map(midi).sort((x, y) => x - y).join(',');
    if (!g) bad.push(`step ${step}: MISSING (want ${pitches.join('+')})`);
    else if (g.pitches.join(',') !== wantP) bad.push(`step ${step}: got [${g.pitches}] want [${wantP}]`);
  }
  if (bad.length === 0) ok(`${label}: ${want.map(([s, ps]) => `${ps.join('+')}@${s}`).join(' ')}`);
  else fail(`${label}: ${bad.join('; ')}`);
};

// ── B. the six rewritten slots ───────────────────────────────────────
console.log('\n=== B. rewritten slots: header, lengths, chains, closing bars ===');
const NOTE_CHAIN_IDX: Record<string, number> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };
interface Spec { slot: number; name: string; lens: number[]; noteTracks: NoteTrack[]; drums: boolean; drumLv: number }
const SPECS: Spec[] = [
  { slot: 17, name: 'Schism 09 Int1', lens: [24, 30, 24, 30, 24, 30, 24, 30], noteTracks: ['synth1'], drums: false, drumLv: 100 },
  { slot: 18, name: 'Schism 10 Int2', lens: [24, 30, 24, 30, 24, 30, 24, 30], noteTracks: ['synth1', 'midi1'], drums: false, drumLv: 100 },
  { slot: 19, name: 'Schism 11 Int3', lens: [24, 30, 24, 30, 24, 30, 24], noteTracks: ['synth1', 'midi1'], drums: false, drumLv: 100 },
  { slot: 20, name: 'Schism 12 Int4', lens: [30, 32, 24, 28, 32, 32, 6], noteTracks: ['synth1', 'midi2'], drums: true, drumLv: 0 },
  { slot: 23, name: 'Schism 15 Out1', lens: [24, 24, 24, 24, 24, 24, 24], noteTracks: ['synth1', 'midi2'], drums: true, drumLv: 0 },
  { slot: 24, name: 'Schism 16 Out2', lens: [24, 32, 32, 32, 32, 16], noteTracks: ['synth1', 'midi2'], drums: true, drumLv: 0 },
];
for (const s of SPECS) {
  const buf = newOf.get(s.slot);
  if (!buf) { fail(`slot ${s.slot}: no capture`); continue; }
  const n = s.lens.length;
  console.log(`-- slot ${s.slot} --`);
  // header fields
  const name = getProjectName(buf);
  if (name !== s.name) fail(`slot ${s.slot} name "${name}" != "${s.name}"`);
  const hdr: string[] = [];
  if (buf[0x0c] !== 10) fail(`slot ${s.slot} colour ${buf[0x0c]} != 10 (Cyan)`); else hdr.push('Cyan');
  if (buf[0x34] !== 108) fail(`slot ${s.slot} tempo ${buf[0x34]} != 108`); else hdr.push('108bpm');
  if (buf[0x2701c] !== 0 || buf[0x2701d] !== 0) fail(`slot ${s.slot} synth levels ${buf[0x2701c]}/${buf[0x2701d]} != 0/0`); else hdr.push('synths 0/0');
  const dl = [0, 1, 2, 3].map((t) => buf[0x26fbd + t * 11]);
  if (dl.some((x) => x !== s.drumLv)) fail(`slot ${s.slot} drum levels [${dl}] != ${s.drumLv}x4`); else hdr.push(`drums ${s.drumLv}x4`);
  ok(`slot ${s.slot} header: "${name}", ${hdr.join(', ')}`);
  // length bytes per authored track
  for (const t of s.noteTracks) {
    const lens = noteLens(buf, t, n);
    if (JSON.stringify(lens) === JSON.stringify(s.lens)) ok(`slot ${s.slot} ${t} lens [${lens}]`);
    else fail(`slot ${s.slot} ${t} lens [${lens}] != [${s.lens}]`);
  }
  if (s.drums) {
    // condensed internal drums: a CONTENT track gets the section lengths; a track
    // the condense layer put nothing on keeps the template's 16-step defaults
    // (chained but empty and level-0 silent) — exactly the pre-fix card's shape.
    const old = oldOf.get(s.slot)!;
    for (let t = 0; t < 4; t++) {
      const lens = drumLens(buf, t, n);
      const anyContent = [...Array(n).keys()].some((p) => drumSteps(buf, t, p).length > 0);
      if (anyContent) {
        if (JSON.stringify(lens) === JSON.stringify(s.lens)) ok(`slot ${s.slot} drum${t + 1} lens [${lens}] (content track)`);
        else fail(`slot ${s.slot} drum${t + 1} lens [${lens}] != [${s.lens}]`);
      } else {
        const oldLens = drumLens(old, t, n);
        if (JSON.stringify(lens) === JSON.stringify(oldLens)) ok(`slot ${s.slot} drum${t + 1} empty; lens [${lens}] == pre-fix card (template default)`);
        else fail(`slot ${s.slot} drum${t + 1} empty but lens [${lens}] != pre-fix [${oldLens}]`);
      }
    }
  }
  // chains: every authored note track chains 1..n (bytes are 0-based start/end)
  for (const t of s.noteTracks) {
    const [c0, c1] = chainOf(buf, NOTE_CHAIN_IDX[t]);
    if (c0 === 0 && c1 === n - 1) ok(`slot ${s.slot} ${t} chain [${c0}-${c1}] = patterns 1-${n}`);
    else fail(`slot ${s.slot} ${t} chain [${c0}-${c1}] != [0-${n - 1}]`);
  }
  if (buf[0x2c1] !== 0) fail(`slot ${s.slot} scene end byte @0x2c1 = ${buf[0x2c1]} != 0 (plain chain expected)`);
}

// closing bars (the defect doc enumerations), final chained pattern per sounding track
console.log('\n-- closing-bar assertions --');
{
  const b17 = newOf.get(17)!;
  expectPitches(b17, 'synth1', 7, [[18, ['a2']], [20, ['a2']], [22, ['d4']], [24, ['a2']], [26, ['c4']], [28, ['a2']]],
    'slot 17 pat8 m137 closer (answer-melody bar)');
  const b18 = newOf.get(18)!;
  expectPitches(b18, 'synth1', 7, [[12, ['a2']], [14, ['a2']], [16, ['c4']]], 'slot 18 pat8 S1 3/8 closer');
  expectPitches(b18, 'midi1', 7, [[12, ['c3']], [13, ['c4']], [18, ['d3']], [19, ['d4']], [22, ['g2']], [26, ['g2']]],
    'slot 18 pat8 M1 close');
  const b19 = newOf.get(19)!;
  expectPitches(b19, 'synth1', 6, [[12, ['a2']], [14, ['a2']], [16, ['e4']], [18, ['a2']], [20, ['a2']], [22, ['a4']]],
    'slot 19 pat7 m174 (last riff-matching bar)');
  expectPitches(b19, 'midi1', 0, [[0, ['a1']]], 'slot 19 pat1 M1 lone a1 (close tail)');
  const b20 = newOf.get(20)!;
  expectPitches(b20, 'synth1', 6, [[0, ['g3']], [2, ['d4']], [4, ['a2']]], 'slot 20 pat7 m191 S1 close');
  const b23 = newOf.get(23)!;
  // m227 = steps 10..23 of pat7: 11 chord cells, f2+c3 opens, g2+d3 present
  expectPitches(b23, 'synth1', 6, [[10, ['f2', 'c3']], [14, ['e2', 'b2']], [18, ['g2', 'd3']], [20, ['d2', 'a2', 'd3']], [23, ['d2', 'a2', 'd3']]],
    'slot 23 pat7 m227 7/8 chord bar (spot pitches)');
  const on23 = noteOnsets(b23, 'synth1', 6).filter((o) => o.step >= 10);
  if (on23.length === 11) ok('slot 23 pat7 m227 has exactly 11 chord cells');
  else fail(`slot 23 pat7 m227 has ${on23.length} cells != 11`);
  const kick23 = drumSteps(b23, 0, 6); // drum1 = kick, pat7
  const roll = [...Array(14).keys()].map((i) => i + 10);
  if (roll.every((st) => kick23.includes(st))) ok('slot 23 pat7 kick roll present through m227 (steps 10-23, internal copy)');
  else fail(`slot 23 pat7 kick steps [${kick23}] missing part of the m227 roll`);
  const b24 = newOf.get(24)!;
  const p6 = noteOnsets(b24, 'synth1', 5).length + noteOnsets(b24, 'midi2', 5).length
    + [0, 1, 2, 3].reduce((a, t) => a + drumSteps(b24, t, 5).length, 0);
  if (p6 === 0) ok('slot 24 pat6 (m238) is the silent hold bar on every track');
  else fail(`slot 24 pat6 has ${p6} onsets, expected silent`);
  expectPitches(b24, 'synth1', 4, [[0, ['d2']], [4, ['d3']]], 'slot 24 pat5 (m236-237) content present');
}

// ── C. shared-window identity vs the pre-fix card ───────────────────
console.log('\n=== C. shared-window decode identity (old card vs new card) ===');
const cmpNote = (slot: number, t: NoteTrack, pats: number[]): void => {
  const a = oldOf.get(slot)!; const b = newOf.get(slot)!;
  const bad = pats.filter((p) => JSON.stringify(decodeNotePattern(a, t, p)) !== JSON.stringify(decodeNotePattern(b, t, p)));
  if (bad.length === 0) ok(`slot ${slot} ${t} patterns ${pats[0] + 1}-${pats[pats.length - 1] + 1} decode-identical to pre-fix card`);
  else fail(`slot ${slot} ${t} patterns [${bad.map((p) => p + 1)}] differ from pre-fix card`);
};
const cmpDrums = (slot: number, pats: number[]): void => {
  const a = oldOf.get(slot)!; const b = newOf.get(slot)!;
  const bad: string[] = [];
  for (let t = 0; t < 4; t++) {
    for (const p of pats) {
      if (JSON.stringify(decodeDrumPattern(a, t, p)) !== JSON.stringify(decodeDrumPattern(b, t, p))) bad.push(`drum${t + 1}/pat${p + 1}`);
    }
  }
  if (bad.length === 0) ok(`slot ${slot} internal drums patterns ${pats[0] + 1}-${pats[pats.length - 1] + 1} decode-identical to pre-fix card`);
  else fail(`slot ${slot} drums differ: ${bad.join(' ')}`);
};
cmpNote(17, 'synth1', [0, 1, 2, 3, 4, 5, 6]);      // m118-134 shared
cmpNote(23, 'synth1', [0, 1, 2, 3, 4, 5]);          // m214-225 shared
cmpNote(23, 'midi2', [0, 1, 2, 3, 4, 5]);
cmpDrums(23, [0, 1, 2, 3, 4, 5]);

console.log(`\n${failures === 0 ? 'ALL VERIFICATION CHECKS PASS' : failures + ' FAILURES'}`);
process.exitCode = failures === 0 ? 0 : 1;
