/**
 * Billie Jean (s10586 r8048414) fold probe: exact sounding-bar lists for the
 * fill winners + targeted window comparisons for re-stomp folds. READ-ONLY,
 * offline from the cache. Re-runnable.
 *
 * Run: npx tsx samples/_scratch/billiejean-fold-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s10586';
const loadPart = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;

const kit = flattenSongsterrDrums(loadPart(16));
const perc = flattenSongsterrDrums(loadPart(15));
const measures = kit.measures;
interface Ev { beat: number; key: string }
const barStart = (mi: number): number => measures[mi].startBeat;
const barLen = (mi: number): number => (measures[mi].signature[0] * 4) / measures[mi].signature[1];
function barSig(evs: Ev[], mi: number): string {
  const b0 = barStart(mi); const b1 = b0 + barLen(mi);
  return evs.filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9)
    .map((e) => `${(Math.round((e.beat - b0) * 16) / 16)}:${e.key}`).sort().join(',');
}
const drumEvs = (fl: ReturnType<typeof flattenSongsterrDrums>): Ev[] => fl.events.map((e) => ({
  beat: e.beat,
  key: `${e.voice}${e.velocity !== undefined ? `@${e.velocity}` : ''}${e.ghost === true ? '~' : ''}`,
}));
const melEvs = (fl: ReturnType<typeof flattenSongsterrMelodic>): Ev[] => fl.notes.map((n) => ({
  beat: n.beat,
  key: `p${n.pitch}:d${n.durationBeats}:v${n.velocity ?? 'def'}`,
}));

const tracks: Array<{ label: string; evs: Ev[] }> = [
  { label: 'KIT', evs: drumEvs(kit) },
  { label: 'PERC', evs: drumEvs(perc) },
  { label: 'RHODES t8', evs: melEvs(flattenSongsterrMelodic(loadPart(8))) },
  { label: 'STRINGS t10', evs: melEvs(flattenSongsterrMelodic(loadPart(10))) },
  { label: 'BRASS t14', evs: melEvs(flattenSongsterrMelodic(loadPart(14))) },
  { label: 'EMU t12', evs: melEvs(flattenSongsterrMelodic(loadPart(12))) },
];

// 1. exact sounding-bar lists for the melodic fills
console.log('── sounding bars, exact ──');
for (const t of tracks.slice(2)) {
  const bars: number[] = [];
  for (let mi = 0; mi < 144; mi++) if (barSig(t.evs, mi) !== '') bars.push(mi + 1);
  console.log(`  ${t.label}: ${bars.join(' ')}`);
}

// 2. targeted window comparisons (bar-by-bar diffs on the selected set)
function cmp(aFrom: number, len: number, bFrom: number, label: string): void {
  console.log(`\n${label}:`);
  for (const t of tracks) {
    const diffs: string[] = [];
    for (let i = 0; i < len; i++) {
      const a = barSig(t.evs, aFrom - 1 + i); const b = barSig(t.evs, bFrom - 1 + i);
      if (a !== b) diffs.push(`m${aFrom + i}/m${bFrom + i}${a === '' ? ' (A rest)' : b === '' ? ' (B rest)' : ''}`);
    }
    console.log(`  ${t.label}: ${diffs.length === 0 ? 'identical' : `${diffs.length}/${len} differ: ${diffs.join(', ')}`}`);
  }
}
cmp(43, 12, 83, 'Chorus1 m43-54 vs Chorus2 head m83-94');
cmp(43, 10, 83, 'Chorus1 head m43-52 vs Chorus2 head m83-92');
cmp(35, 8, 75, 'PreCh1 m35-42 vs PreCh2 m75-82');
cmp(115, 12, 43, 'Chorus3 m115-126 vs Chorus1 m43-54');
cmp(115, 12, 91, 'Chorus3 m115-126 vs Chorus2 tail m91-102');
cmp(103, 12, 115, 'Interlude m103-114 vs Chorus3 m115-126');

// 3. what the strings actually play per region (2-bar block letters over m41-144)
console.log('\n── STRINGS t10 per-bar letters m41-144 ──');
const seen = new Map<string, string>();
let next = 0;
const alpha = 'abcdefghijklmnopqrstuvwxyz';
const out: string[] = [];
for (let mi = 40; mi < 144; mi++) {
  const sig = barSig(tracks[3].evs, mi);
  if (sig === '') { out.push('.'); continue; }
  if (!seen.has(sig)) { seen.set(sig, alpha[next] ?? `#${next - 26}`); next++; }
  out.push(seen.get(sig)!);
}
for (let i = 0; i < out.length; i += 16) {
  console.log(`  m${String(41 + i).padStart(3)}: ${out.slice(i, i + 16).join(' ')}`);
}
console.log(`  distinct strings bars: ${seen.size}`);

// 4. brass bars in Cho2 exactly + emulator note positions
console.log('\n── BRASS t14 note beats (bar:beat) ──');
const brass = flattenSongsterrMelodic(loadPart(14));
for (const n of [...brass.notes].sort((a, b) => a.beat - b.beat).slice(0, 50)) {
  console.log(`  m${Math.floor(n.beat / 4) + 1} beat ${(n.beat % 4).toFixed(2)} p${n.pitch} d${n.durationBeats}`);
}
console.log('\n── EMULATOR t12 notes ──');
const emu = flattenSongsterrMelodic(loadPart(12));
for (const n of [...emu.notes].sort((a, b) => a.beat - b.beat)) {
  console.log(`  m${Math.floor(n.beat / 4) + 1} beat ${(n.beat % 4).toFixed(2)} p${n.pitch} d${n.durationBeats} v${n.velocity ?? 'def'}`);
}

// 5. cross-pattern edge-crossers per candidate project grid
//    (project starts: groove m1; pc1 m35; cho1 m43; pc2 m75; cho2a m83; cho2b m93;
//     interlude m103; cho3 m115; outro m127; fade m141)
console.log('\n── edge-crossers per project anchor (melodic fills) ──');
const projects: Array<{ name: string; from: number; to: number }> = [
  { name: 'PreCh1 m35-42', from: 35, to: 42 },
  { name: 'Cho1 m43-54', from: 43, to: 54 },
  { name: 'PreCh2 m75-82', from: 75, to: 82 },
  { name: 'Cho2a m83-92', from: 83, to: 92 },
  { name: 'Cho2b m93-102', from: 93, to: 102 },
  { name: 'Interlude m103-114', from: 103, to: 114 },
  { name: 'Cho3 m115-126', from: 115, to: 126 },
  { name: 'Outro m127-140', from: 127, to: 140 },
  { name: 'Fade m141-144', from: 141, to: 144 },
];
const fills: Array<{ label: string; id: number }> = [
  { label: 'RHODES t8', id: 8 }, { label: 'STRINGS t10', id: 10 }, { label: 'BRASS t14', id: 14 }, { label: 'EMU t12', id: 12 },
];
for (const p of projects) {
  const anchor = barStart(p.from - 1);
  const endBeat = barStart(p.to - 1) + barLen(p.to - 1);
  for (const f of fills) {
    const fl = flattenSongsterrMelodic(loadPart(f.id));
    let n = 0;
    for (const note of fl.notes) {
      if (note.beat < anchor - 1e-9 || note.beat >= endBeat - 1e-9) continue;
      const s = Math.round((note.beat - anchor) * 4); const e = s + Math.round(note.durationBeats * 4);
      if (Math.floor(s / 32) !== Math.floor((e - 1) / 32)) n++;
    }
    if (n > 0) console.log(`  ${p.name} ${f.label}: ${n} cross-pattern sustain(s)`);
  }
}
