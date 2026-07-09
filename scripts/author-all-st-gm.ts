/**
 * author-all-st-gm — author ALL 10 Sleep Token II songs as GM / MIDI-2 Circuit
 * projects, one per project slot, each with up to 8 grooves as pattern-chained
 * MIDI-2 patterns that AUTO-ADVANCE 1..N (program advancing). Destined for the
 * device's SECOND PAGE of projects (slots 32..41).
 *
 * Per song: read its *Groove*.mid files, reduce each to a up-to-64-step (4-bar)
 * voice grid via the Sleep-Token→GM note map, rank simple→complex by hit count,
 * pick 4 grooves spanning that range, CHOP each into 32-step Circuit patterns so
 * the FULL 4-bar groove survives (+12 octave so the Circuit's octave-low MIDI-
 * track transmission lands on the SPD-SX's GM pads), then chain MIDI 2 across all
 * authored patterns with the hardware-confirmed setNoteChain (slot 0x2d0). Names
 * the project after the song.
 *
 *   npx tsx scripts/author-all-st-gm.ts
 *   -> samples/circuit-tracks/grooves/gm/all/<slug>_gm.ncs  (10 files)
 *
 * OFFLINE (touches no MIDI device). Upload each with upload_project to slot
 * 32+index. NOTE (detail/voicing): 7 voices mapped — kick/snare/closed-hat/busy-
 * hat/ride (ear-confirmed) + tom(7)/crash(23) (metric-evidence, medium confidence,
 * confirm by ear). The remaining pack notes (0/22/27/29/52/53) need an ear A/B
 * before enabling, and NOTE-TRACK PER-SCENE selection needs one device capture —
 * both are the open items (see docs/_private/HANDOFF-circuit-multipattern.md +
 * the decode-review workflow report).
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { parseMidiFile } from '@mcp-midi-control/core/protocol-generic/patterns/midiFile.js';
import { setNotePattern } from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { setProjectScale, SCALE_CHROMATIC } from '@mcp-midi-control/circuit-tracks/ncs/scale.js';
import { setNoteChain } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import { NCS_FILE_SIZE, META_OFFSETS, noteBlockIndex } from '@mcp-midi-control/circuit-tracks/ncs/format.js';

// User's labels for the anonymized MixWave folders (mirror song_names.py).
const SONG_NAMES: Readonly<Record<string, string>> = {
  'Song 01 (110 BPM)': 'The Summoning',
  'Song 02 (135 BPM)': 'Granite',
  'Song 03 (170 BPM)': 'The Offering',
  'Song 04 (170 BPM)': 'Take Me Back To Eden',
  'Song 05 (150 BPM)': 'Aqua Regia',
  'Song 06 (120 BPM)': 'Ascensionism',
  'Song 07 (120 BPM)': 'Hypnosis',
  'Song 08 (135 BPM)': 'Chokehold',
  'Song 09 (160 BPM)': 'Vore',
  'Song 10 (160 BPM)': 'Rain',
};

// Sleep-Token-groove note → neutral voice. The pack uses a proprietary NON-GM
// note layout, so roles come from the corpus's acoustic signature, not a spec.
const GROOVE_NOTE_TO_VOICE: Readonly<Record<number, string>> = {
  // Ear-confirmed (groove_to_pattern.py):
  1: 'kick', 3: 'snare', 14: 'hat', 2: 'hat', 41: 'ride',
  // Evidence-based enrichment (decode-review workflow, medium confidence — the
  // metric signature is strong but confirm by ear; both fold to distinct pads):
  7: 'tom',    // most fill-loaded, off-beat, sequential IOI → tom/rototom
  23: 'crash', // on-beat quarter accents (1 & 3), co-rides with ride(41) → crash/china
  // Ear-A/B candidates left UNMAPPED (mapping them would route a voice on a guess):
  // 0, 22, 27, 29, 52, 53 — resolve with a listening pass before enabling.
};
// SPD-SX GM pad note per voice — matches SPDSX_GM_NOTE in the spd-sx descriptor.
const SPDSX_GM_NOTE: Readonly<Record<string, number>> = {
  kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, ride: 51, crash: 49, perc: 56,
};
const OCTAVE = 12;          // Circuit transmits MIDI-track notes an octave low (HW-confirmed)
const SRC_STEPS = 64;       // parse up to 4 bars — the pack's TRUE length (was truncated to 32)
const PATTERN_STEPS = 32;   // one Circuit pattern = 2 bars @ 16ths
const MAX_PATTERNS = 8;     // Circuit patterns per track
const MAX_GROOVES = 4;      // 4 grooves × up to 2 patterns each fills the 8 pattern slots
const lengthByte = (steps: number): number => Math.max(0, Math.min(31, steps - 1));

const GP = 'C:\\Users\\Public\\Documents\\Sleep Token - II\\MIDI Files\\Sleep Token II - Groove Pack';
const OUT_DIR = 'samples/circuit-tracks/grooves/gm/all';
const FIRST_SLOT = 32;     // second page of projects (device shows "Project 33")

const slug = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Reduce a groove MIDI to a up-to-64-step map: step -> voice -> peak velocity,
 *  hit count, and the highest step used (to size the pattern count). */
function reduceGroove(bytes: Uint8Array): { steps: Array<Map<string, number>>; hits: number; maxStep: number } {
  const p = parseMidiFile(bytes);
  const stepTicks = (p.ticksPerBeat || 480) / 4; // 16th note
  const steps: Array<Map<string, number>> = Array.from({ length: SRC_STEPS }, () => new Map<string, number>());
  let hits = 0;
  let maxStep = -1;
  for (const n of p.notes) {
    if (n.velocity <= 0) continue;
    const voice = GROOVE_NOTE_TO_VOICE[n.note];
    if (voice === undefined) continue;
    const s = Math.round(n.tick / stepTicks);
    if (s < 0 || s >= SRC_STEPS) continue;
    const cur = steps[s].get(voice) ?? 0;
    if (n.velocity > cur) steps[s].set(voice, n.velocity);
    hits++;
    if (s > maxStep) maxStep = s;
  }
  return { steps, hits, maxStep };
}

/** Even spread of up to `max` indices across `len` ranked items. */
function spread(len: number, max: number): number[] {
  if (len <= max) return [...Array(len).keys()];
  const out = new Set<number>();
  for (let i = 0; i < max; i++) out.add(Math.round((i * (len - 1)) / (max - 1)));
  return [...out];
}

/** Write a 16-char project name at 0x10 (ASCII, space-padded; matches the reader). */
function setProjectName(buf: Uint8Array, name: string): void {
  const padded = name.slice(0, 16).padEnd(16, ' ');
  for (let i = 0; i < 16; i++) buf[0x10 + i] = padded.charCodeAt(i) & 0x7f;
}

function authorSong(songFolder: string, title: string, slot: number): void {
  const template = new Uint8Array(readFileSync('samples/circuit-tracks/blank_slot20.ncs'));
  const dir = path.join(GP, songFolder);
  const grooveFiles = readdirSync(dir).filter((f) => /groove.*\.mid$/i.test(f)).map((f) => path.join(dir, f));
  if (grooveFiles.length === 0) { console.log(`  ${title}: no grooves, skipped`); return; }

  const ranked = grooveFiles
    .map((f) => ({ f, g: reduceGroove(new Uint8Array(readFileSync(f))) }))
    .filter((x) => x.g.hits > 0)
    .sort((a, b) => a.g.hits - b.g.hits);
  // BUG-B guard: a song whose grooves map to zero hits must be skipped, not crash
  // the batch on setNoteChain([0,-1]).
  if (ranked.length === 0) { console.log(`  ${title}: no mapped hits, skipped`); return; }
  const picks = spread(ranked.length, MAX_GROOVES).map((i) => ranked[i]);

  // One step's notes → GM (octave-shifted), capped at the 6-note chord limit.
  const cellNotes = (cell: Map<string, number>): undefined | Array<{ note: number; velocity: number }> => {
    const notes: Array<{ note: number; velocity: number }> = [];
    for (const [voice, vel] of cell) {
      const gm = SPDSX_GM_NOTE[voice];
      if (gm === undefined) continue;
      notes.push({ note: gm + OCTAVE, velocity: Math.max(1, Math.min(127, vel)) });
    }
    return notes.length ? notes.slice(0, 6) : undefined;
  };

  // BUG-C fix: the source grooves are up to 4 bars (64 steps). Chop each into
  // 32-step Circuit patterns so the FULL groove survives (the old code kept only
  // the first 2 bars). Fill up to 8 pattern slots across the picked grooves.
  let pat = 0;
  for (const pk of picks) {
    if (pat >= MAX_PATTERNS) break;
    const nHalves = Math.max(1, Math.ceil((pk.g.maxStep + 1) / PATTERN_STEPS));
    for (let half = 0; half < nHalves && pat < MAX_PATTERNS; half++, pat++) {
      const grid: Array<undefined | Array<{ note: number; velocity: number }>> = [];
      for (let s = 0; s < PATTERN_STEPS; s++) {
        const src = half * PATTERN_STEPS + s;
        grid[s] = src < SRC_STEPS ? cellNotes(pk.g.steps[src]) : undefined;
      }
      setNotePattern(template, 'midi2', pat, grid);
      template[META_OFFSETS[noteBlockIndex('midi2', pat)]] = lengthByte(PATTERN_STEPS);
    }
  }

  setNoteChain(template, 'midi2', { start: 0, end: pat - 1 });
  setProjectScale(template, SCALE_CHROMATIC);
  setProjectName(template, title);

  const outName = `${slug(title)}_gm.ncs`;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, outName), template);
  console.log(`  slot ${slot} (Project ${slot + 1})  "${title}"  ${picks.length} grooves → ${pat} patterns chained 1→${pat}  → ${outName}`);
}

function main(): void {
  console.log('Authoring all 10 Sleep Token II songs (GM / MIDI-2, pattern-chained) for the second project page:\n');
  const folders = readdirSync(GP).filter((f) => /^Song \d+/.test(f)).sort();
  folders.forEach((folder, i) => {
    const title = SONG_NAMES[folder] ?? folder;
    // Isolate per-song failures so one bad song never aborts the whole batch.
    try { authorSong(folder, title, FIRST_SLOT + i); }
    catch (e) { console.log(`  ${title}: FAILED (${e instanceof Error ? e.message : e}) — skipped`); }
  });
  console.log(`\nWrote ${folders.length} project(s) to ${OUT_DIR}. Upload each with upload_project(circuit-tracks, <file>, ${FIRST_SLOT}+index).`);
}

main();
