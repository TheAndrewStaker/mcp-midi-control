/**
 * No Diggity (s287014 rev 3656036) measurement probe. Read-only over the cache.
 * Emits: drum-kit census, bass pitch census + first-bars decode, per-bar
 * signature letters for structure detection, and per-part section map.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, pitchToken,
  type SongsterrPart,
} from '@mcp-midi-control/core/protocol-generic/patterns/songsterr.js';

const dir = 'samples/songsterr-cache/s287014';
const load = (id: number): SongsterrPart =>
  JSON.parse(readFileSync(join(dir, `part-${id}.json`), 'utf8')) as SongsterrPart;

const gtr = flattenSongsterrMelodic(load(0));
const bass = flattenSongsterrMelodic(load(1));
const drums = flattenSongsterrDrums(load(2));

// ── drum kit census ──────────────────────────────────────────────────
const kit = new Map<string, number>();
const vel = new Map<number, number>();
for (const e of drums.events) {
  kit.set(`${e.voice ?? '??'} (gm ${e.note})`, (kit.get(`${e.voice ?? '??'} (gm ${e.note})`) ?? 0) + 1);
  vel.set(e.velocity ?? -1, (vel.get(e.velocity ?? -1) ?? 0) + 1);
}
console.log('=== DRUM KIT CENSUS (voice x hits) ===');
for (const [k, n] of [...kit.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
console.log('velocity multiset:', [...vel.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}x${n}`).join(' '));
console.log('unmapped:', drums.unmapped, JSON.stringify(drums.unmapped_numbers));

// ── bass pitch census ────────────────────────────────────────────────
const bassPitches = new Map<string, number>();
for (const n of bass.notes) bassPitches.set(pitchToken(n.pitch), (bassPitches.get(pitchToken(n.pitch)) ?? 0) + 1);
console.log('\n=== BASS PITCH CENSUS ===');
for (const [k, n] of [...bassPitches.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);

// pitch-CLASS census (octave-folded), for key evidence
const pcNames = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const pcs = new Map<string, number>();
for (const n of bass.notes) pcs.set(pcNames[n.pitch % 12], (pcs.get(pcNames[n.pitch % 12]) ?? 0) + 1);
console.log('bass pitch classes:', [...pcs.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}x${n}`).join(' '));

const gpcs = new Map<string, number>();
for (const n of gtr.notes) gpcs.set(pcNames[n.pitch % 12], (gpcs.get(pcNames[n.pitch % 12]) ?? 0) + 1);
console.log('gtr pitch classes:', [...gpcs.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}x${n}`).join(' '));

// ── first bars of bass + guitar, decoded ─────────────────────────────
const measures = bass.measures;
const barOf = (beat: number): number => {
  let lo = 0;
  for (let i = 0; i < measures.length; i++) if (beat >= measures[i].startBeat - 1e-6) lo = i;
  return lo;
};
console.log('\n=== BASS m1-8 (beat-in-bar: pitch:len[@vel]) ===');
for (const n of bass.notes) {
  const m = barOf(n.beat);
  if (m > 7) break;
  const off = n.beat - measures[m].startBeat;
  console.log(`  m${m + 1} b${off.toFixed(2)}: ${pitchToken(n.pitch)}:${n.durationBeats.toFixed(2)}${n.velocity !== undefined ? `@${n.velocity}` : ''}`);
}
console.log('\n=== GUITAR m1-8 ===');
for (const n of gtr.notes) {
  const m = barOf(n.beat);
  if (m > 7) break;
  const off = n.beat - measures[m].startBeat;
  console.log(`  m${m + 1} b${off.toFixed(2)}: ${pitchToken(n.pitch)}:${n.durationBeats.toFixed(2)}${n.velocity !== undefined ? `@${n.velocity}` : ''}`);
}

// ── per-bar signature letters (structure) ────────────────────────────
function barLetters(name: string, onsets: { beat: number; sig: string }[]): string[] {
  const per: string[][] = Array.from({ length: measures.length }, () => []);
  for (const o of onsets) {
    const m = barOf(o.beat);
    const off = o.beat - measures[m].startBeat;
    per[m].push(`${off.toFixed(2)}:${o.sig}`);
  }
  const sigOfBar = per.map((xs) => xs.join(' '));
  const seen = new Map<string, string>();
  const letters: string[] = [];
  for (const s of sigOfBar) {
    if (!seen.has(s)) {
      const c = seen.size;
      seen.set(s, s === '' ? '.' : c < 26 ? String.fromCharCode(65 + c) : `#${c}`);
    }
    letters.push(seen.get(s)!);
  }
  console.log(`\n=== ${name}: ${seen.size} distinct bar sigs ===`);
  for (let i = 0; i < letters.length; i += 16) {
    console.log(`  m${String(i + 1).padStart(3)}: ${letters.slice(i, i + 16).join(' ')}`);
  }
  return letters;
}
barLetters('DRUM bars', drums.events.map((e) => ({ beat: e.beat, sig: `${e.note}` })));
barLetters('BASS bars', bass.notes.map((n) => ({ beat: n.beat, sig: `${n.pitch}:${n.durationBeats.toFixed(2)}` })));
barLetters('GTR bars', gtr.notes.map((n) => ({ beat: n.beat, sig: `${n.pitch}:${n.durationBeats.toFixed(2)}` })));

// bass melodic-flat stats
console.log('\nbass: notes', bass.notes.length, 'ties_folded', bass.ties_folded, 'orphaned', bass.ties_orphaned, 'chords', (bass as { chord_beats?: number }).chord_beats ?? 'n/a');
console.log('gtr:  notes', gtr.notes.length, 'ties_folded', gtr.ties_folded);
