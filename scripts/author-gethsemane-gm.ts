/**
 * author-gethsemane-gm — regenerate the Sleep Token "Gethsemane" ELECTRONIC
 * groove (2nd-half second Bridge, Songsterr 1467797 track "Programmed Drums",
 * displayed measures 129-130, 74 bpm) as a GM / MIDI-2 Circuit Tracks project,
 * OFFLINE (no device), using the NEW General-MIDI drum-note map.
 *
 * Purpose: a dry-run of the groove→instrument mapping AFTER the GM changes
 * (commit 1694689 + the 2026-07-01 role/fold work), so the next session can
 * upload the file and hear it, and so we can COMPARE the note mapping against
 * the old sequential 60..68 convention. See the handoff prompt written next to
 * the .ncs (docs/_private is gitignored, so the prompt lives in scratch + is
 * echoed here).
 *
 *   npx tsx scripts/author-gethsemane-gm.ts
 *   -> samples/circuit-tracks/grooves/gm/gethsemane_electronic_gm.ncs
 *
 * Upload with upload_project(circuit-tracks, <file>, 63)  # Project 64 (scratch).
 *
 * WHY MIDI-2 only: the GM change is purely the NOTE NUMBERS the Circuit's MIDI-2
 * track sends to the SPD-SX. The Circuit's own internal drum tracks address a
 * sample POOL by slot, not by note, so they are unaffected by the GM remap — the
 * mapping comparison is entirely a MIDI-2 / SPD-SX matter. The "internal drums
 * AND MIDI-2 at once" version is the live path: apply_pattern(..., mode:ncs_upload,
 * external_targets:[{device:"spd-sx", track:"midi2", also_internal:true}]).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  setNotePattern,
  DEFAULT_GATE,
  type NoteSlot,
} from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { setProjectScale, SCALE_CHROMATIC } from '@mcp-midi-control/circuit-tracks/ncs/scale.js';
import { setNoteChain, lengthByte } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import { META_OFFSETS, noteBlockIndex, NOTE_SLOTS_PER_STEP } from '@mcp-midi-control/circuit-tracks/ncs/format.js';

// NEW General-MIDI drum-note map — MUST match SPDSX_GM_NOTE in the spd-sx
// descriptor (packages/spd-sx/src/descriptor.ts). OLD convention (for the
// comparison record) was sequential from C4: kick=60, snare=61, hat=62.
const GM: Readonly<Record<string, number>> = {
  kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, ride: 51, crash: 49, perc: 56,
};
const GM_OLD: Readonly<Record<string, number>> = { kick: 60, snare: 61, hat: 62 };

// The Circuit Tracks transmits MIDI-track notes ONE OCTAVE BELOW the stored
// value (USB capture 2026-06-28). So we author GM+12 and it leaves the device
// as the GM note the SPD-SX pad expects. (Mirrors external_targets note_offset:12.)
const OCTAVE = 12;

const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';
const OUT_DIR = 'samples/circuit-tracks/grooves/gm';
// v2 variant (pass "v2"): the anti-machine-gun buzz — retriggers DECAY like
// real bounces (rollVelocity curve) and fan 5 hits instead of 6 (30 Hz is
// faster than any human buzz at 74 bpm; 5 reads as an energetic fill).
// Three-way A/B: placed (accurate) vs v2 (decayed 5-roll) vs v1 (flat 6-buzz).
const V2 = process.argv[2] === 'v2';
const OUT_NAME = V2 ? 'gethsemane_electronic_gm_v2.ncs' : 'gethsemane_electronic_gm.ncs';
const PROJECT_NAME = V2 ? 'Gethsemane ST2' : 'Gethsemane ST';
const BUZZ_N = V2 ? 5 : 6;
const BPM = 74; // second Bridge local tempo (tempo map: 71 -> 141 -> 148 -> 74)

// Velocity per lane char. X=accent, x=normal, g=ghost; digit 6 = full buzz roll.
const VEL: Readonly<Record<string, number>> = { X: 118, x: 96, g: 52 };
const BUZZ_VEL = 96;

// The decoded 2-bar groove (16th grid, 32 steps). Kick on the downbeat, snare on
// beat 3 (half-time), hat = 8th pulse that erupts into buzz rolls (6) — the
// signature Sleep Token programmed hat, and the micro-step/POLY-trail showcase.
//   bar 1: pulse -> two ISOLATED buzz rolls (beats 3 & 4)
//   bar 2: pulse -> 8th-spaced buzzes -> a dense 4-buzz end fill (6666)
type Lane = [voice: string, steps: string];
const LANES: Lane[] = [
  ['kick',  'x...............x...............'],
  ['snare', '........x...............x.......'],
  ['hat',   'x.x.x.x.6...6...x.x.6.6.6.6.6666'],
];

const STEPS = 32;

/** Fan a buzz roll across the step via the per-note delay field — EXACTLY as
 * authorPlanIntoProject (circuit-tracks writer.ts) does: n retriggers of the
 * same note at delays round(k*5/(n-1)), one-step gate. v2 adds the engine's
 * rollVelocity decay (0.85^k, floor 20) so bounces fade like a real roll
 * instead of machine-gunning. On a POLY SPD-SX pad each retrigger rings. */
function buzzSlots(note: number, velocity: number, room: number): NoteSlot[] {
  const n = Math.min(BUZZ_N, room);
  const out: NoteSlot[] = [];
  for (let k = 0; k < n; k++) {
    const delay = Math.round((k * 5) / (BUZZ_N - 1));
    const v = V2 ? Math.max(20, Math.round(velocity * 0.85 ** k)) : velocity;
    out.push({ note, gate: DEFAULT_GATE, tie: false, delay, velocity: v });
  }
  return out;
}

/** Build the 32-step chord grid: accumulate each voice's hit per step, capping
 * at 6 note slots (buzz rolls consume up to 6), counting honest overflow. */
function buildGrid(): { grid: Array<NoteSlot[] | undefined>; overflow: number } {
  const grid: Array<NoteSlot[]> = Array.from({ length: STEPS }, () => []);
  let overflow = 0;
  for (const [voice, steps] of LANES) {
    const gm = GM[voice];
    if (gm === undefined) throw new Error(`unknown voice "${voice}"`);
    const note = gm + OCTAVE;
    for (let s = 0; s < steps.length && s < STEPS; s++) {
      const ch = steps[s];
      const cell = grid[s];
      const room = NOTE_SLOTS_PER_STEP - cell.length;
      if (ch === '6') {
        const slots = buzzSlots(note, BUZZ_VEL, room);
        if (BUZZ_N > room) overflow += BUZZ_N - slots.length;
        cell.push(...slots);
      } else if (VEL[ch] !== undefined) {
        if (room <= 0) { overflow++; continue; }
        cell.push({ note, gate: DEFAULT_GATE, tie: false, delay: 0, velocity: VEL[ch] });
      }
    }
  }
  return { grid: grid.map((c) => (c.length ? c : undefined)), overflow };
}

function setProjectName(buf: Uint8Array, name: string): void {
  const padded = name.slice(0, 16).padEnd(16, ' ');
  for (let i = 0; i < 16; i++) buf[0x10 + i] = padded.charCodeAt(i) & 0x7f;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const buf = new Uint8Array(readFileSync(TEMPLATE));

  const { grid, overflow } = buildGrid();
  setNotePattern(buf, 'midi2', 0, grid);
  buf[META_OFFSETS[noteBlockIndex('midi2', 0)]] = lengthByte(STEPS);
  setNoteChain(buf, 'midi2', { start: 0, end: 0 }); // single pattern
  setProjectScale(buf, SCALE_CHROMATIC);            // literal pitches
  setProjectName(buf, PROJECT_NAME);

  const outPath = path.join(OUT_DIR, OUT_NAME);
  writeFileSync(outPath, buf);

  // Report + comparison record.
  console.log(`\nGethsemane electronic groove -> ${outPath}  (${buf.length} bytes)\n`);
  console.log(`  ${PROJECT_NAME} | ${BPM} bpm | 32 steps (2 bars @16th) | MIDI-2 pattern 0 | scale=Chromatic`);
  console.log(`  Upload: upload_project(circuit-tracks, "${outPath}", 63)   # Project 64 (scratch)\n`);
  console.log('  Voice   GM note   authored (+12)   OLD (sequential)   SPD-SX pad');
  for (const [voice] of LANES) {
    const gm = GM[voice];
    console.log(
      `  ${voice.padEnd(6)}  ${String(gm).padStart(3)}       ${String(gm + OCTAVE).padStart(3)}` +
      `              ${String(GM_OLD[voice] ?? '-').padStart(3)}                ${voice}`,
    );
  }
  console.log('\n  Hat lane (buzz rolls fanned to 6 delayed retriggers on a POLY pad):');
  console.log(`    ${LANES[2][1]}`);
  const buzzCount = (LANES[2][1].match(/6/g) ?? []).length;
  console.log(`    ${buzzCount} buzz-roll steps; ${overflow} retrigger(s) dropped to the 6-note step cap (snare+buzz collisions).`);
  console.log('\n  SPD-SX must receive on the Circuit MIDI-2 channel (ch4 default) with pads on GM notes 36/38/42,');
  console.log('  hat pad MODE=POLY so the buzz retriggers ring instead of choking.\n');
}

main();
