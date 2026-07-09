/**
 * author-gethsemane-accurate — regenerate the Sleep Token "Gethsemane"
 * ELECTRONIC groove (Songsterr 1467797, "Programmed Drums", displayed measures
 * 129-130, 74 bpm) with REAL micro-step placement (Front B, B0-hardware-
 * confirmed 2026-07-02) instead of the buzz-roll approximation.
 *
 * This is the micro-step ACCURACY TEST from the handoff
 * (samples/circuit-tracks/grooves/gm/gethsemane_electronic_HANDOFF.md): the
 * bridge hat is ~69% plain 16ths + 27 32nds (micro-tick 3) + 12 16th-triplet
 * offsets (ticks 2 & 4); placing them takes fidelity ~69% → ~87%.
 *
 * Deliberately runs the PRODUCTION pipeline end-to-end (not a hand-built
 * grid) so the song is a test of the shipped code path:
 *
 *   fetchSongsterrDrums → importSongsterrDrums (quantizer now PLACES off-grid
 *   onsets as Step.micro) → compileToPlan (per-onset events with .micro) →
 *   authorPlanIntoProject (note-slot delay bytes) → .ncs
 *
 * All voices route to the MIDI-2 track (ch4) on GM+12 notes — the SPD-SX path,
 * mirroring `external_targets note_offset:12` (the Circuit transmits MIDI-track
 * notes an octave low).
 *
 *   npx tsx scripts/author-gethsemane-accurate.ts
 *   -> samples/circuit-tracks/grooves/gm/gethsemane_electronic_accurate.ncs
 *
 * A/B against the buzz baseline gethsemane_electronic_gm.ncs on the SPD-SX
 * (ch4, pads on GM 36/38/42, hat pad POLY).
 */
import { readFileSync, writeFileSync } from 'node:fs';

import {
  fetchSongsterrDrums,
  importSongsterrDrums,
  compileToPlan,
  type NeutralPattern,
  type Voice,
} from '@mcp-midi-control/core/protocol-generic/patterns/index.js';
import type { DeviceCapabilities, VoiceTarget } from '@mcp-midi-control/core/protocol-generic/types.js';
import { authorPlanIntoProject } from '@mcp-midi-control/circuit-tracks/descriptor/writer.js';
import { decodeNotePattern } from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { setNoteChain } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';

const GM: Readonly<Record<string, number>> = {
  kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, ride: 51, crash: 49, perc: 56,
};
const OCTAVE = 12;        // Circuit MIDI-track octave-low transmit compensation
const CH_MIDI2 = 4;

const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';
const OUT = 'samples/circuit-tracks/grooves/gm/gethsemane_electronic_accurate.ncs';
const PROJECT_NAME = 'Gethsemane ACC';

const CAPS: DeviceCapabilities = {
  slot_model: 'linear', has_scenes: false, has_channels: false,
  supports_save: false, supports_lineage: false, pattern_realizers: ['ncs_upload'],
};

function setProjectName(buf: Uint8Array, name: string): void {
  const padded = name.slice(0, 16).padEnd(16, ' ');
  for (let i = 0; i < 16; i++) buf[0x10 + i] = padded.charCodeAt(i) & 0x7f;
}

async function main(): Promise<void> {
  console.log('fetching Songsterr 1467797 track "Programmed"…');
  const fetched = await fetchSongsterrDrums('1467797', { trackName: 'Programmed' });
  const imp = importSongsterrDrums(fetched.part, { fromMeasure: 129, toMeasure: 130, stepsPerBeat: 4 });
  console.log(`  window: measures 129-130, ${imp.window.beats} beats @ ${imp.bpm} bpm → ${imp.steps} steps`);
  for (const w of imp.warnings) console.log(`  note: ${w}`);
  if (imp.steps !== 32) throw new Error(`expected 32 steps, got ${imp.steps}`);

  const voices: Record<string, Voice> = {};
  const overrides: Record<string, readonly VoiceTarget[]> = {};
  for (const [voice, steps] of Object.entries(imp.voices)) {
    const gm = GM[voice];
    if (gm === undefined) throw new Error(`no GM note for voice "${voice}"`);
    voices[voice] = { steps };
    overrides[voice] = [{ channel: CH_MIDI2, note: gm + OCTAVE }];
  }

  const pattern: NeutralPattern = { name: 'gethsemane-accurate', steps: 32, voices };
  const plan = compileToPlan(pattern, CAPS, { bpm: imp.bpm ?? 74, mode: 'ncs_upload', overrides });

  const buf = new Uint8Array(readFileSync(TEMPLATE));
  const res = authorPlanIntoProject(buf, plan);
  setNoteChain(buf, 'midi2', { start: 0, end: 0 });
  setProjectName(buf, PROJECT_NAME);
  writeFileSync(OUT, buf);

  // ── Placement report: read the authored bytes BACK and histogram the delays ──
  const decoded = decodeNotePattern(buf, 'midi2', 0);
  const hatNote = GM.hat + OCTAVE;
  const delayHist = new Map<number, number>();
  let hatSlots = 0;
  const lanes: string[] = [];
  for (let s = 0; s < 32; s++) {
    const hats = decoded[s].notes.filter((n) => n.note === hatNote);
    hatSlots += hats.length;
    for (const n of hats) delayHist.set(n.delay, (delayHist.get(n.delay) ?? 0) + 1);
    lanes.push(hats.length === 0 ? '.' : hats.map((n) => String(n.delay)).join(''));
  }
  console.log(`\nGethsemane ACCURATE groove -> ${OUT} (${buf.length} bytes)`);
  console.log(`  authored tracks: ${JSON.stringify(res.note_tracks)}, unrouted=${res.unrouted}`);
  console.log(`  scale=${res.scale_set?.name ?? 'Chromatic'}; project name "${PROJECT_NAME}"`);
  console.log(`\n  hat lane per step (digits = the step's slot delays, '.'=rest):`);
  console.log(`    ${lanes.join(' ')}`);
  console.log(`\n  hat slots: ${hatSlots} total; delay histogram (tick → count):`);
  for (const [d, c] of [...delayHist.entries()].sort((a, b) => a[0] - b[0])) {
    const tag = d === 0 ? 'on-grid 16ths' : d === 3 ? '32nd "and"s (expect ~27 across the full bridge)' : (d === 2 || d === 4) ? 'triplet offsets' : 'other';
    console.log(`    tick ${d}: ${c}   (${tag})`);
  }
  console.log(`\n  Upload: upload_project(circuit-tracks, "${OUT}", <slot>)  and A/B vs gethsemane_electronic_gm.ncs`);
  console.log('  SPD-SX: Circuit MIDI-2 ch4, pads on GM 36/38/42, hat pad MODE=POLY, DYNAMICS ON.');
}

main().catch((e) => { console.error(e); process.exit(1); });
