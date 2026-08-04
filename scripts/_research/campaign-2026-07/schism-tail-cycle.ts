/**
 * Phase 2: riff-cycle truncation test at loop-wrap, all Schism slots + Amber.
 * Read-only. Run: npx tsx samples/_scratch/schism-tail-cycle.ts
 *
 * For each slot's SOURCE window (contiguous bars), build per-bar content
 * signatures per track, detect the riff period P by autocorrelation, and test
 * whether the window ends mid-cycle (residual r = L mod P != 0). If the source
 * bars AFTER the window complete the cycle (match the earlier cycle's remaining
 * bars), the loop wrap is provably truncated and the missing notes are those
 * bars' content.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  flattenSongsterrMelodic, flattenSongsterrDrums, pitchToken, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { META_OFFSETS, noteBlockIndex, getProjectName, type NoteTrack } from '../../packages/circuit-tracks/src/ncs/format.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache';
const loadPart = (song: string, id: number) => JSON.parse(readFileSync(`${CACHE}/${song}/part-${id}.json`, 'utf8')) as SongsterrPart;

// ── Schism sources ──────────────────────────────────────────────────
const s1 = flattenSongsterrMelodic(loadPart('s6700', 2));
const m1 = flattenSongsterrMelodic(loadPart('s6700', 3));
const dr = flattenSongsterrDrums(loadPart('s6700', 5));
const measures = s1.measures;

interface Ev { beat: number; key: string }
const evS1: Ev[] = s1.notes.map((n) => ({ beat: n.beat, key: `p${n.pitch}` }));
const evM1: Ev[] = m1.notes.map((n) => ({ beat: n.beat, key: `p${n.pitch}` }));
const evDR: Ev[] = dr.events.map((e) => ({ beat: e.beat, key: `v${(e as any).voice}` }));

const barSteps = (mi: number): number => Math.round(((measures[mi].signature[0] * 4) / measures[mi].signature[1]) * 4);
function barSig(evs: Ev[], mi: number): string {
  const b0 = measures[mi].startBeat;
  const b1 = b0 + (measures[mi].signature[0] * 4) / measures[mi].signature[1];
  return evs.filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9)
    .map((e) => `${Math.round((e.beat - b0) * 4)}:${e.key}`).sort().join(',');
}
function barNotes(evs: Ev[], mi: number): string[] {
  const b0 = measures[mi].startBeat;
  const b1 = b0 + (measures[mi].signature[0] * 4) / measures[mi].signature[1];
  return evs.filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9)
    .map((e) => {
      const step = Math.round((e.beat - b0) * 4);
      const name = e.key.startsWith('p') ? pitchToken(Number(e.key.slice(1))) : e.key.slice(1);
      return `${name}@m${mi + 1}s${step}`;
    });
}

const slots: Array<{ slot: number; name: string; from: number; to: number }> = [
  { slot: 9, name: 'Intro', from: 4, to: 19 }, { slot: 10, name: 'V1a', from: 20, to: 31 },
  { slot: 11, name: 'V1b', from: 32, to: 43 }, { slot: 12, name: 'Br1', from: 44, to: 51 },
  { slot: 13, name: 'V2', from: 52, to: 67 }, { slot: 14, name: 'Br2Hvy', from: 68, to: 85 },
  { slot: 15, name: 'V3', from: 86, to: 101 }, { slot: 16, name: 'Br3', from: 102, to: 117 },
  { slot: 17, name: 'Int1', from: 118, to: 136 }, { slot: 18, name: 'Int2', from: 137, to: 155 },
  { slot: 19, name: 'Int3', from: 156, to: 173 }, { slot: 20, name: 'Int4', from: 174, to: 191 },
  { slot: 21, name: 'Btwn1', from: 192, to: 202 }, { slot: 22, name: 'Btwn2', from: 203, to: 213 },
  { slot: 23, name: 'Out1', from: 214, to: 226 }, { slot: 24, name: 'Out2', from: 227, to: 238 },
];

const tracks: Array<{ label: string; evs: Ev[] }> = [
  { label: 'S1', evs: evS1 }, { label: 'M1', evs: evM1 }, { label: 'DR', evs: evDR },
];

console.log('=== SCHISM: loop-wrap cycle audit per slot per track ===');
for (const { slot, name, from, to } of slots) {
  const L = to - from + 1;
  for (const { label, evs } of tracks) {
    const sigs = Array.from({ length: L }, (_, i) => barSig(evs, from - 1 + i));
    if (sigs.every((s) => s === '')) continue; // track silent in this window
    // period detection
    let bestP = 0; let bestRatio = 0;
    for (let P = 1; P <= Math.min(8, Math.floor(L / 2)); P++) {
      let hit = 0;
      for (let i = P; i < L; i++) if (sigs[i] === sigs[i - P]) hit++;
      const ratio = hit / (L - P);
      if (ratio > bestRatio + 1e-9) { bestRatio = ratio; bestP = P; }
    }
    if (bestRatio < 0.99) {
      console.log(`slot ${slot} ${name.padEnd(6)} ${label}: no exact bar period (best P=${bestP} ratio=${bestRatio.toFixed(2)}) -> wrap not cycle-judgeable`);
      continue;
    }
    const P = bestP;
    const r = L % P;
    if (r === 0) {
      console.log(`slot ${slot} ${name.padEnd(6)} ${label}: period ${P} bars, window = ${L / P} full cycles -> WRAP CLEAN`);
      continue;
    }
    // window ends r bars into a cycle; missing = P - r bars. Do the NEXT source bars complete it?
    const missBars = P - r;
    const cont: boolean[] = [];
    for (let j = 0; j < missBars; j++) {
      const srcMi = to - 1 + 1 + j;           // 0-based index of bar after the window
      const cycMi = to - 1 + 1 + j - P;       // same cycle position, previous cycle (inside window)
      cont.push(srcMi < measures.length && barSig(evs, srcMi) === barSig(evs, cycMi));
    }
    const proven = cont.every(Boolean);
    const missNotes = proven
      ? Array.from({ length: missBars }, (_, j) => barNotes(evs, to + j)).flat()
      : [];
    const missSteps = proven
      ? Array.from({ length: missBars }, (_, j) => barSteps(to + j)).reduce((a, b) => a + b, 0)
      : 0;
    console.log(`slot ${slot} ${name.padEnd(6)} ${label}: period ${P}, window ${L} bars = ${Math.floor(L / P)} cycles + ${r} bar(s) -> `
      + (proven
        ? `TRUNCATED WRAP: missing ${missBars} bar(s) (m${to + 1}-${to + missBars}, ${missSteps} steps, ${missNotes.length} notes), source continues the cycle there`
        : `ends mid-cycle but the next bars do NOT repeat the cycle (${cont.join(',')}) -> musically new material, wrap acceptable`));
    if (proven && missNotes.length > 0) console.log(`    missing: ${missNotes.join(' ')}`);
  }
}

// ── slot 17 explicit proof: m137 == m122/m127/m132 on S1 ───────────
console.log('\nslot 17 proof: S1 bar sigs of the 3/4 closers:');
for (const m of [122, 127, 132, 137]) console.log(`  m${m}: ${barSig(evS1, m - 1) || '(empty)'}`);
console.log('  m137 == m132:', barSig(evS1, 136) === barSig(evS1, 131));
console.log('  slot 18 pattern 1 (m137-138) carries the bar on the card: see phase-1 output');

// ── AMBER ───────────────────────────────────────────────────────────
console.log('\n=== AMBER (s24430 r3852308) final-pattern audit ===');
const amDrum = flattenSongsterrDrums(loadPart('s24430', 10));
console.log(`drum part: ${amDrum.measures.length} measures, totalBeats ${amDrum.totalBeats}, last event beat ${Math.max(...amDrum.events.map((e) => e.beat)).toFixed(2)} (m70 ends at beat ${amDrum.measures[69].startBeat + 4})`);
const evAM: Ev[] = amDrum.events.map((e) => ({ beat: e.beat, key: `v${(e as any).voice}` }));
const amMeasures = amDrum.measures;
function amBarStepSet(w: { from: number; to: number }): number[] {
  const b0 = amMeasures[w.from - 1].startBeat;
  const b1 = amMeasures[w.to - 1].startBeat + 4;
  const set = new Set<number>();
  for (const e of evAM) if (e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9) set.add(Math.round((e.beat - b0) * 4));
  return [...set].sort((a, b) => a - b);
}

const AMBER_DIR = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/amber-authored-2026-07-29';
const amFiles = readdirSync(AMBER_DIR).filter((f) => f.endsWith('.ncs'));
const amBuf = new Map<number, Uint8Array>();
for (const f of amFiles) { const m = /project(\d+)/.exec(f); if (m) amBuf.set(Number(m[1]), new Uint8Array(readFileSync(join(AMBER_DIR, f)))); }

function scenes(buf: Uint8Array): Array<{ midi1: [number, number]; midi2: [number, number] }> {
  const end0 = buf[0x2c1];
  const out: Array<{ midi1: [number, number]; midi2: [number, number] }> = [];
  for (let n = 0; n <= end0; n++) {
    const b = 0x50 + n * 0x28;
    out.push({
      midi1: [buf[b + 0x18 + 8], buf[b + 0x18 + 9]],
      midi2: [buf[b + 0x18 + 12], buf[b + 0x18 + 13]],
    });
  }
  return out;
}
const chainOf = (buf: Uint8Array, i: number): [number, number] => [buf[0x2c4 + i * 4], buf[0x2c4 + i * 4 + 1]];
const noteLen = (buf: Uint8Array, t: NoteTrack, p: number): number => buf[META_OFFSETS[noteBlockIndex(t, p)]] + 1;

// project -> the window (measures) each PATTERN SLOT holds, per the plan tables
const amberSlots: Array<{ slot: number; patWins: Array<[number, number]> }> = [
  { slot: 9, patWins: [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16]] },
  { slot: 10, patWins: [[17, 18], [19, 20], [21, 22], [23, 24], [29, 30], [31, 32]] },   // B C D E F G
  { slot: 11, patWins: [[37, 38], [39, 40], [41, 42], [43, 44], [45, 46], [47, 48], [49, 50], [51, 52]] },
  { slot: 12, patWins: [[53, 54], [55, 56], [57, 58], [59, 60], [69, 70], [67, 68], [69, 70]] }, // placeholder; read scenes below
];

for (const { slot } of amberSlots) {
  const buf = amBuf.get(slot);
  if (!buf) { console.log(`amber slot ${slot}: NO FILE`); continue; }
  const sc = scenes(buf);
  const ch = ['synth1', 'synth2', 'midi1', 'midi2'].map((t, i) => `${t}=[${chainOf(buf, i).join('-')}]`).join(' ');
  console.log(`\namber slot ${slot} "${getProjectName(buf)}": chains ${ch} sceneEnd0=${buf[0x2c1]}`);
  console.log(`  scenes(midi1/midi2): ${sc.map((s) => `[${s.midi1.join('-')}|${s.midi2.join('-')}]`).join(' ')}`);
  console.log(`  midi2 lens=[${[...Array(8).keys()].map((p) => noteLen(buf, 'midi2', p)).join(',')}] midi1 lens=[${[...Array(8).keys()].map((p) => noteLen(buf, 'midi1', p)).join(',')}]`);
  // last played midi2 pattern: last scene's midi2 end (scene chain), else plain chain end
  const lastPat = buf[0x2c1] > 0 ? sc[sc.length - 1].midi2[1] : chainOf(buf, 3)[1];
  const got = decodeNotePattern(buf, 'midi2', lastPat).map((s, i) => (s.active ? i : -1)).filter((i) => i >= 0);
  console.log(`  last played midi2 pattern = ${lastPat + 1}, onset steps [${got.join(',')}], len ${noteLen(buf, 'midi2', lastPat)}`);
}

// Amber ground truth: source final window m69-70 (cell I, the ending)
console.log(`\namber source final window m69-70 onset steps: [${amBarStepSet({ from: 69, to: 70 }).join(',')}]`);
console.log(`amber source window m35-36 (slot10 G) steps: [${amBarStepSet({ from: 35, to: 36 }).join(',')}]`);
console.log(`amber source window m51-52 (slot11 last) steps: [${amBarStepSet({ from: 51, to: 52 }).join(',')}]`);
console.log(`amber source window m15-16 (slot9 last) steps: [${amBarStepSet({ from: 15, to: 16 }).join(',')}]`);
