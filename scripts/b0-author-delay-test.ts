/**
 * b0-author-delay-test — author the B0 GATE test pattern (does the Circuit
 * Tracks MIDI-OUT transmit the note-track per-note `delay` field as REAL wire
 * micro-timing, or is the transmitted note-on quantized to the 16th step?).
 *
 * Layout (MIDI-2 track, pattern 0, 32 steps, one distinct note per probe so the
 * analyzer identifies onsets by pitch, immune to loop phase):
 *
 *   step  0: note 48, delay 0   ─┐
 *   step  8: note 50, delay 0    ├─ baseline: IOIs of exactly 8 steps each
 *   step 16: note 52, delay 0   ─┘  (self-calibrates the step length)
 *   step 24: note 53, delay 0 + note 55, delay 3   <- the decisive pair: SAME
 *            step, delays 0 vs 3. If the wire honors delay, the two note-ons
 *            are split by 3 micro-ticks (= half a 16th step). If MIDI-out
 *            quantizes to the step, they are simultaneous.
 *
 * The Circuit transmits MIDI-track notes one octave below the stored value, so
 * the wire notes are 36/38/40/41/43.
 *
 *   npx tsx scripts/b0-author-delay-test.ts
 *   -> samples/circuit-tracks/b0_delay_test.ncs
 *
 * Then: upload_project(circuit-tracks, <file>, <page-1 slot>), run
 * scripts/b0-capture-delay-onsets.ts, select the project via PC ch16 and
 * send_clock_start. Companion: gethsemane_electronic_HANDOFF.md (B0 gate).
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { setNotePattern, type NoteSlot } from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { setProjectScale, SCALE_CHROMATIC } from '@mcp-midi-control/circuit-tracks/ncs/scale.js';
import { setNoteChain, lengthByte } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import { META_OFFSETS, noteBlockIndex } from '@mcp-midi-control/circuit-tracks/ncs/format.js';

const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';
const OUT = 'samples/circuit-tracks/b0_delay_test.ncs';
const STEPS = 32;
const GATE = 3;
const VEL = 100;

function slot(note: number, delay: number): NoteSlot {
  return { note, gate: GATE, tie: false, delay, velocity: VEL };
}

function setProjectName(buf: Uint8Array, name: string): void {
  const padded = name.slice(0, 16).padEnd(16, ' ');
  for (let i = 0; i < 16; i++) buf[0x10 + i] = padded.charCodeAt(i) & 0x7f;
}

const buf = new Uint8Array(readFileSync(TEMPLATE));

const grid: Array<NoteSlot[] | undefined> = Array.from({ length: STEPS }, () => undefined);
grid[0] = [slot(48, 0)];
grid[8] = [slot(50, 0)];
grid[16] = [slot(52, 0)];
grid[24] = [slot(53, 0), slot(55, 3)];

setNotePattern(buf, 'midi2', 0, grid);
buf[META_OFFSETS[noteBlockIndex('midi2', 0)]] = lengthByte(STEPS);
setNoteChain(buf, 'midi2', { start: 0, end: 0 });
setProjectScale(buf, SCALE_CHROMATIC);
setProjectName(buf, 'B0 DELAY TEST');

writeFileSync(OUT, buf);
console.log(`B0 delay wire test -> ${OUT} (${buf.length} bytes)`);
console.log('  MIDI-2 pattern 0, 32 steps: authored notes 48@0, 50@8, 52@16, [53 d0 + 55 d3]@24');
console.log('  Wire notes (octave-low transmit): 36, 38, 40, 41, 43');
