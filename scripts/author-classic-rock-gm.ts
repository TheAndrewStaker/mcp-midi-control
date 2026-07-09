/**
 * author-classic-rock-gm — hand-authored classic-rock drum grooves as GM / MIDI-2
 * Circuit projects for the BOTTOM rows of the project grid (slots 48..55 =
 * Projects 49..56). Same pipeline as the Sleep Token authoring: each groove is a
 * MIDI-2 note pattern (+12 octave so the Circuit's octave-low MIDI-track send
 * lands on the SPD-SX's GM pads), patterns chained so they auto-advance.
 *
 * The grooves are stylistic transcriptions of the songs' drum parts (kick/snare/
 * hat placements by ear/knowledge), NOT sampled MIDI — recognizable starters, not
 * note-perfect masters. Each project chains a main groove + a variation/fill.
 *
 *   npx tsx scripts/author-classic-rock-gm.ts
 *   -> samples/circuit-tracks/grooves/gm/classic-rock/<slug>_gm.ncs  (8 files)
 *
 * OFFLINE. Upload each with upload_project to slot 48+index.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { setNotePattern } from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { setProjectScale, SCALE_CHROMATIC } from '@mcp-midi-control/circuit-tracks/ncs/scale.js';
import { setNoteChain } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import { NCS_FILE_SIZE, META_OFFSETS, noteBlockIndex } from '@mcp-midi-control/circuit-tracks/ncs/format.js';

// SPD-SX GM pad note per voice (matches SPDSX_GM_NOTE in the spd-sx descriptor).
const GM: Readonly<Record<string, number>> = {
  kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, ride: 51, crash: 49, perc: 56,
};
const OCTAVE = 12;
const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';
const OUT_DIR = 'samples/circuit-tracks/grooves/gm/classic-rock';
const FIRST_SLOT = 48; // Projects 49..56 (bottom rows)

// Velocity per lane char: X=accent, x=normal, g=ghost, . / space = rest.
const VEL: Readonly<Record<string, number>> = { X: 118, x: 96, g: 52 };
type Lane = [voice: string, steps: string];
interface Groove { name: string; length: number; lanes: Lane[] }
interface Song { title: string; patterns: Groove[] }

// A lane string is read at 16th-note resolution. "|" is ignored (bar marker).
const g = (name: string, lanes: Lane[]): Groove => {
  const clean = lanes.map(([v, s]) => [v, s.replace(/\|/g, '')] as Lane);
  const length = Math.max(...clean.map(([, s]) => s.length));
  return { name, length, lanes: clean };
};

const SONGS: Song[] = [
  { title: 'TP Breakdown', patterns: [
    g('groove', [['hat', 'x.x.x.x.x.x.x.x.'], ['kick', 'x.....x.........'], ['snare', '....x.......x...']]),
    g('chorus', [['hat', 'x.x.x.x.x.x.x.x.'], ['kick', 'x.....x...x.....'], ['snare', '....x.......x...']]),
    g('fill',   [['hat', 'x.x.x.x.x.......'], ['kick', 'x.....x.........'], ['snare', '....x.....x.x.x.'], ['tom', '............x.x.']]),
  ] },
  { title: 'Back in Black', patterns: [
    g('groove', [['hat', 'x.x.x.x.x.x.x.x.'], ['kick', 'X.....x.x.......'], ['snare', '....X.......X...'], ['crash', 'X...............']]),
    g('turn',   [['hat', 'x.x.x.x.x.x.x.x.'], ['kick', 'X.....x.x...x...'], ['snare', '....X.......X...']]),
  ] },
  { title: 'Rock and Roll', patterns: [
    g('intro',  [['snare', '..x.x.x.X.......'], ['kick', 'x...............'], ['crash', '........X.......']]),
    g('groove', [['hat', 'x.x.x.x.x.x.x.x.'], ['kick', 'X.......x...x...'], ['snare', '....X.......X...'], ['crash', 'X...............']]),
    g('fill',   [['snare', '....X.....x.x.x.'], ['tom', '............x.x.'], ['kick', 'x...............']]),
  ] },
  { title: 'We Will Rock You', patterns: [
    g('stomp',  [['kick', 'X...X...........'], ['clap', '........X.......']]),
    g('build',  [['kick', 'X...X...X.......'], ['clap', '........X...X...']]),
  ] },
  { title: 'Baba ORiley', patterns: [
    g('groove', [['hat', 'x.x.x.x.x.x.x.x.'], ['kick', 'X.......X.......'], ['snare', '....X.......X...'], ['crash', 'X...............']]),
    g('drive',  [['hat', 'xxxxxxxxxxxxxxxx'], ['kick', 'X...X...X...X...'], ['snare', '....X.......X...']]),
  ] },
  { title: 'Sweet Home Ala', patterns: [
    g('groove', [['hat', 'x.x.x.x.x.x.x.x.'], ['kick', 'X.....x.x.......'], ['snare', '....X.......X...']]),
    g('ride',   [['ride', 'x.x.x.x.x.x.x.x.'], ['kick', 'X.....x.x.......'], ['snare', '....X.......X...']]),
  ] },
  { title: 'Sweet Child', patterns: [
    g('groove', [['hat', 'x.x.x.x.x.x.x.x.'], ['kick', 'X.......x.x.....'], ['snare', '....X.......X...'], ['crash', 'X...............']]),
    g('fill',   [['hat', 'x.x.x.x.........'], ['kick', 'X.......x.......'], ['snare', '....X.....x.X.x.'], ['tom', '............X.x.']]),
  ] },
  { title: 'Fortunate Son', patterns: [
    g('groove', [['hat', 'x.x.x.x.x.x.x.x.'], ['kick', 'X.....x.X.......'], ['snare', '....X.......X...']]),
    g('open',   [['openhat', 'x.x.x.x.x.x.x.x.'], ['kick', 'X.....x.X.......'], ['snare', '....X.......X...']]),
  ] },
];

const slug = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const lengthByte = (steps: number): number => Math.max(0, Math.min(31, steps - 1));

function setProjectName(buf: Uint8Array, name: string): void {
  const padded = name.slice(0, 16).padEnd(16, ' ');
  for (let i = 0; i < 16; i++) buf[0x10 + i] = padded.charCodeAt(i) & 0x7f;
}

/** Groove → per-step chord grid (voice hits merged per step, capped at 6). */
function grooveGrid(gr: Groove): Array<undefined | Array<{ note: number; velocity: number }>> {
  const grid: Array<undefined | Array<{ note: number; velocity: number }>> = Array.from({ length: gr.length }, () => undefined);
  for (const [voice, steps] of gr.lanes) {
    const gm = GM[voice];
    if (gm === undefined) throw new Error(`unknown voice "${voice}"`);
    for (let s = 0; s < steps.length; s++) {
      const vel = VEL[steps[s]];
      if (vel === undefined) continue;
      (grid[s] ??= []).push({ note: gm + OCTAVE, velocity: vel });
    }
  }
  return grid.map((c) => (c && c.length ? c.slice(0, 6) : undefined));
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log('Authoring classic-rock grooves (GM / MIDI-2) for the bottom project rows:\n');
  SONGS.forEach((song, i) => {
    const buf = new Uint8Array(readFileSync(TEMPLATE));
    const pats = song.patterns.slice(0, 8);
    pats.forEach((gr, pat) => {
      setNotePattern(buf, 'midi2', pat, grooveGrid(gr));
      buf[META_OFFSETS[noteBlockIndex('midi2', pat)]] = lengthByte(gr.length);
    });
    setNoteChain(buf, 'midi2', { start: 0, end: pats.length - 1 });
    setProjectScale(buf, SCALE_CHROMATIC);
    setProjectName(buf, song.title);
    const outName = `${slug(song.title)}_gm.ncs`;
    writeFileSync(path.join(OUT_DIR, outName), buf);
    const slot = FIRST_SLOT + i;
    console.log(`  slot ${slot} (Project ${slot + 1})  "${song.title}"  ${pats.length} patterns chained 1→${pats.length}  → ${outName}`);
  });
  console.log(`\nWrote ${SONGS.length} project(s) to ${OUT_DIR}. Upload each with upload_project(circuit-tracks, <file>, ${FIRST_SLOT}+index).`);
}

main();
