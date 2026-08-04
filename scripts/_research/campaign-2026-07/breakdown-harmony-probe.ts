/**
 * Breakdown harmony + residuals probe. READ-ONLY, disk only.
 *  1. t0 (Electric Piano 1) through the CURRENT melodic import: onset/gate/tie
 *     census vs the old midi1 image (per old project window).
 *  2. Locations of the 3 multi-onset [0,3] drum cells.
 *  3. The named delta bars for the ear list: decode m8 and m22 both sides.
 * Run: npx tsx samples/_scratch/breakdown-harmony-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, importSongsterrMelodic,
  type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { quantizeDrumEvents } from '../../packages/core/src/protocol-generic/patterns/drumScore.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { type NoteTrack } from '../../packages/circuit-tracks/src/ncs/format.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s23527';
const ORACLE = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/card-backup-2026-07-29/pack5';
const load = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const BOUNDS: [number, number][] = [[1, 16], [17, 32], [33, 48], [49, 62], [63, 77]];
const PROJECTS = [35, 36, 37, 38, 39];

console.log('=== 1. t0 through importSongsterrMelodic, per old window ===');
for (const [i, [mFrom, mTo]] of BOUNDS.entries()) {
  const imp = importSongsterrMelodic(load(0), { fromMeasure: mFrom, toMeasure: mTo });
  const m = imp as any;
  // count emitted onsets from cells
  let onsets = 0; let ties = 0; const gates = new Map<string, number>();
  for (const c of m.cells ?? []) {
    const notes = Array.isArray(c.notes) ? c.notes.length : 1;
    onsets += notes;
    if (c.tie) ties += notes;
    const g = c.gate_sixths ?? c.gate ?? '?';
    gates.set(String(g), (gates.get(String(g)) ?? 0) + notes);
  }
  console.log(`P${i + 1} m${mFrom}-${mTo}: cells ${m.cells?.length ?? '?'}, onsets ${onsets}, ties ${ties}, off_grid ${m.off_grid}, merged ${m.merged}, gate_splits ${m.gate_splits}, chord_overflow ${m.chord_overflow}`);
  if (i === 0) console.log(`  gates: ${[...gates].sort((a, b) => Number(a[0]) - Number(b[0])).map(([g, c]) => `${g}x${c}`).join(' ')}`);
  // old midi1 census for the window
  const buf = readFileSync(`${ORACLE}/proj${PROJECTS[i]}__${PROJECTS[i] - 1}_SESSION.ncs`);
  let oOnsets = 0; let oTies = 0;
  for (let p = 0; p < 8; p++) {
    for (const s of decodeNotePattern(buf as unknown as Uint8Array, 'midi1' as NoteTrack, p)) {
      if (!s.active) continue;
      for (const n of s.notes) { oOnsets++; if (n.tie) oTies++; }
    }
  }
  console.log(`  old midi1: onsets ${oOnsets}, ties ${oTies}`);
}

console.log('\n=== 2. the [0,3] multi-onset drum cells ===');
const drums = flattenSongsterrDrums(load(6));
const q = quantizeDrumEvents(drums.events, { beats: drums.totalBeats, stepsPerBeat: 4 });
for (const [voice, steps] of Object.entries(q.voices)) {
  for (const [g, s] of steps.entries()) {
    if (s.on && s.micro && s.micro.length > 1) {
      console.log(`  ${voice} bar m${Math.floor(g / 16) + 1} step ${g % 16}: micro ${JSON.stringify(s.micro)} vel ${s.velocity ?? (s.accent ? 120 : 100)}`);
    }
  }
}

console.log('\n=== 3. delta bars: m8 and m22, source vs old card ===');
const bar = (mm: number): void => {
  const s0 = (mm - 1) * 16;
  const src: string[] = [];
  for (const [voice, steps] of Object.entries(q.voices)) {
    for (let s = s0; s < s0 + 16; s++) {
      const st = steps[s]; if (!st?.on) continue;
      src.push(`${voice}@${s - s0}${st.micro ? '+' + st.micro.join('/') : ''}:${st.velocity ?? (st.accent ? 120 : 100)}`);
    }
  }
  // old card: locate the project + local step
  const pi = BOUNDS.findIndex(([a, b]) => mm >= a && mm <= b);
  const base = (BOUNDS[pi][0] - 1) * 16;
  const buf = readFileSync(`${ORACLE}/proj${PROJECTS[pi]}__${PROJECTS[pi] - 1}_SESSION.ncs`);
  const NOTE_VOICE: Record<number, string> = { 48: 'kick', 50: 'snare', 54: 'hat', 57: 'tom', 58: 'openhat', 61: 'crash' };
  const card: string[] = [];
  for (let p = 0; p < 8; p++) {
    for (const [si, s] of decodeNotePattern(buf as unknown as Uint8Array, 'midi2' as NoteTrack, p).entries()) {
      if (!s.active) continue;
      const g = base + p * 32 + si;
      if (g < s0 || g >= s0 + 16) continue;
      for (const n of s.notes) card.push(`${NOTE_VOICE[n.note] ?? n.note}@${g - s0}${n.delay ? '+' + n.delay : ''}:${n.velocity}`);
    }
  }
  console.log(`m${mm} source: ${src.sort().join(' ')}`);
  console.log(`m${mm} card:   ${card.sort().join(' ')}`);
};
bar(8); bar(22);
console.log('\ndone.');
