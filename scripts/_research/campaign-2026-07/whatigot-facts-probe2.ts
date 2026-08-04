/**
 * What I Got follow-up probe: resolve the m41 letters-vs-identity question,
 * t14 voice census + kick lane, t15 raw GM-number histogram. READ-ONLY.
 * Run: npx tsx samples/_scratch/whatigot-facts-probe2.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s211';
const loadPart = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;

const t15 = flattenSongsterrDrums(loadPart(15), { drumMap: { 27: 'hat', 28: 'snare' } });
const measures = t15.measures;
const barStart = (mi: number): number => measures[mi].startBeat;
const barLen = (mi: number): number => (measures[mi].signature[0] * 4) / measures[mi].signature[1];
interface Ev { beat: number; key: string }
const evs: Ev[] = t15.events.map((e) => ({ beat: e.beat, key: `${e.voice}${e.velocity !== undefined ? `@${e.velocity}` : ''}${e.ghost === true ? '~' : ''}` }));
function barSig(mi: number): string {
  const b0 = barStart(mi); const b1 = b0 + barLen(mi);
  return evs.filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9)
    .map((e) => `${(Math.round((e.beat - b0) * 16) / 16)}:${e.key}`).sort().join(',');
}
console.log('DR15 direct bar sigs (0-based mi -> bar m=mi+1):');
for (const m of [2, 40, 41, 42, 62, 63, 64, 65]) {
  console.log(`  m${m}: ${barSig(m - 1) || '(rest)'}`);
}
console.log(`  m41==m40? ${barSig(40) === barSig(39)}   m41==m2? ${barSig(40) === barSig(1)}   m41==m63? ${barSig(40) === barSig(62)}`);
console.log(`  m2==m3? ${barSig(1) === barSig(2)}`);

// t14 census
const t14 = flattenSongsterrDrums(loadPart(14));
const v14 = new Map<string, number>();
for (const e of t14.events) v14.set(e.voice, (v14.get(e.voice) ?? 0) + 1);
console.log(`\nt14 voice census: ${[...v14.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(', ')}`);
const ev14kick: Ev[] = t14.events.filter((e) => e.voice === 'kick').map((e) => ({ beat: e.beat, key: 'k' }));
function kickBar(mi: number): string {
  const b0 = barStart(mi); const b1 = b0 + barLen(mi);
  return ev14kick.filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9)
    .map((e) => `${(Math.round((e.beat - b0) * 16) / 16)}`).sort((a, b) => Number(a) - Number(b)).join(',');
}
console.log('t14 KICK lane, first bars of each section (beat positions in-bar):');
for (const m of [22, 23, 24, 34, 35, 42, 50, 56, 64, 65, 66, 67]) {
  console.log(`  m${m}: ${kickBar(m - 1) || '(rest)'}`);
}
// distinct kick bars m22-67
const kseen = new Map<string, number>();
for (let mi = 21; mi <= 66; mi++) { const s = kickBar(mi); if (s !== '') kseen.set(s, (kseen.get(s) ?? 0) + 1); }
console.log(`  distinct kick bars m22-67: ${kseen.size}; top: ${[...kseen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, n]) => `[${s}] x${n}`).join('  ')}`);

// t15 raw GM-number histogram (raw JSON walk: drum part notes carry fret = percussion number)
const raw = loadPart(15) as unknown as { measures: Array<{ voices: Array<{ beats: Array<{ notes?: Array<{ fret?: number; rest?: boolean }> }> }> }> };
const frets = new Map<number, number>();
for (const m of raw.measures) for (const v of m.voices) for (const b of v.beats) for (const n of b.notes ?? []) {
  if (n.rest !== true && typeof n.fret === 'number') frets.set(n.fret, (frets.get(n.fret) ?? 0) + 1);
}
console.log(`\nt15 raw percussion-number histogram: ${[...frets.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f}:${n}`).join(' ')}`);
