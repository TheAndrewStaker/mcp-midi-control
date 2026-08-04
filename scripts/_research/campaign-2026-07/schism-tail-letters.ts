/**
 * Phase 3: per-bar content letters per slot per track, window + 5 bars beyond,
 * to judge every loop wrap by structure. Read-only.
 * Run: npx tsx samples/_scratch/schism-tail-letters.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrMelodic, flattenSongsterrDrums, pitchToken, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s6700';
const loadPart = (id: number) => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const s1 = flattenSongsterrMelodic(loadPart(2));
const m1 = flattenSongsterrMelodic(loadPart(3));
const dr = flattenSongsterrDrums(loadPart(5));
const measures = s1.measures;

interface Ev { beat: number; key: string }
const evs: Record<string, Ev[]> = {
  S1: s1.notes.map((n) => ({ beat: n.beat, key: `p${n.pitch}` })),
  M1: m1.notes.map((n) => ({ beat: n.beat, key: `p${n.pitch}` })),
  DR: dr.events.map((e) => ({ beat: e.beat, key: `v${(e as any).voice}` })),
};
function barSig(t: string, mi: number): string {
  const b0 = measures[mi].startBeat;
  const b1 = b0 + (measures[mi].signature[0] * 4) / measures[mi].signature[1];
  return evs[t].filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9)
    .map((e) => `${Math.round((e.beat - b0) * 4)}:${e.key}`).sort().join(',');
}
const sigOfBar = (mi: number): string => `${measures[mi].signature[0]}/${measures[mi].signature[1]}`;

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

for (const { slot, name, from, to } of slots) {
  console.log(`\nslot ${slot} ${name} m${from}-${to} | sigs: ${Array.from({ length: to - from + 1 }, (_, i) => sigOfBar(from - 1 + i)).join(' ')} || next: ${Array.from({ length: 5 }, (_, i) => (to + i < measures.length ? sigOfBar(to + i) : '-')).join(' ')}`);
  for (const t of ['S1', 'M1', 'DR']) {
    const reg = new Map<string, string>();
    const letter = (sig: string): string => {
      if (sig === '') return '.';
      if (!reg.has(sig)) reg.set(sig, String.fromCharCode(65 + reg.size));
      return reg.get(sig)!;
    };
    const win = Array.from({ length: to - from + 1 }, (_, i) => letter(barSig(t, from - 1 + i)));
    if (win.every((x) => x === '.')) continue;
    const next = Array.from({ length: 5 }, (_, i) => (to + i < measures.length ? letter(barSig(t, to + i)) : '-'));
    console.log(`  ${t}: ${win.join(' ')} || ${next.join(' ')}`);
  }
}
