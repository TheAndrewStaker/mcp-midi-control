/**
 * Phase 1 (proof): author "The Summoning" as 8 swappable GM / MIDI-2 patterns.
 *
 * Reads the Sleep Token II Groove Pack MIDI for Song 01 (= "The Summoning"),
 * picks up to 8 grooves spanning simple→complex (by hit count), imports each
 * (GM percussion → neutral voice via the core importer), and writes each as a
 * NOTE-track pattern on MIDI 2 using the SPD-SX's GM note map (+12 octave so the
 * Circuit's octave-low MIDI-track transmission lands on the device's GM pads).
 *
 * Output: a ready .ncs (template-modified from blank_slot20). Upload it with the
 * MCP `upload_project` tool (the server owns the port → no capture/port
 * contention). This is OFFLINE: it touches no MIDI device.
 *
 *   npx tsx scripts/author-summoning-gm.ts
 *
 * NOTE-TRACK LENGTH: set by analogy with the hardware-confirmed DRUM length byte
 * (META_OFFSETS[block] = steps-1). The note block shares the drum metadata
 * layout (step data ends at META_OFFSETS[block]); Phase 1's hardware test
 * byte-confirms it for note tracks.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { parseMidiFile } from '@mcp-midi-control/core/protocol-generic/patterns/midiFile.js';
import { setNotePattern } from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { setProjectScale, SCALE_CHROMATIC } from '@mcp-midi-control/circuit-tracks/ncs/scale.js';
import { setNoteChain } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import { NCS_FILE_SIZE, META_OFFSETS, noteBlockIndex } from '@mcp-midi-control/circuit-tracks/ncs/format.js';

// The Sleep Token II Groove Pack uses its OWN note layout (drums on ch16, notes
// 1/2/3/13/14/41), NOT General MIDI. This is the ear-confirmed role map from the
// existing pipeline (groove_to_pattern.py): note → neutral voice.
const GROOVE_NOTE_TO_VOICE: Readonly<Record<number, string>> = {
  1: 'kick', 3: 'snare', 14: 'hat', 2: 'hat', 41: 'ride',
};
// SPD-SX GM pad note per neutral voice — must match SPDSX_GM_NOTE in the spd-sx
// descriptor (the device pads are set to these).
const SPDSX_GM_NOTE: Readonly<Record<string, number>> = {
  kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, ride: 51, crash: 49, perc: 56,
};
// The Circuit transmits MIDI-track notes ONE OCTAVE LOW (HW-confirmed). Author +12
// so the wire note equals the GM pad note.
const OCTAVE = 12;
const STEPS = 32; // 2 bars @ 16th notes (the groove pack's native length)
const lengthByte = (steps: number): number => Math.max(0, Math.min(31, steps - 1));

const GP = 'C:\\Users\\Public\\Documents\\Sleep Token - II\\MIDI Files\\Sleep Token II - Groove Pack';
const SONG_DIR = path.join(GP, 'Song 01 (110 BPM)'); // = The Summoning
const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';
const OUT_DIR = 'samples/circuit-tracks/grooves/gm';
const OUT = path.join(OUT_DIR, 'the_summoning_gm.ncs');

interface GrooveGrid {
  steps: Array<Map<string, number>>; // per step: voice -> peak velocity
  hits: number;
  unmapped: Map<number, number>;     // groove note -> count (notes with no role)
}

/** Reduce a groove MIDI to a 32-step voice grid using the ear-confirmed note map. */
function reduceGroove(bytes: Uint8Array): GrooveGrid {
  const p = parseMidiFile(bytes);
  const tpb = p.ticksPerBeat || 480;
  const stepTicks = tpb / 4; // 16th note
  const steps: Array<Map<string, number>> = Array.from({ length: STEPS }, () => new Map<string, number>());
  let hits = 0;
  const unmapped = new Map<number, number>();
  for (const n of p.notes) {
    if (n.velocity <= 0) continue;
    const voice = GROOVE_NOTE_TO_VOICE[n.note];
    if (voice === undefined) { unmapped.set(n.note, (unmapped.get(n.note) ?? 0) + 1); continue; }
    const s = Math.round(n.tick / stepTicks);
    if (s < 0 || s >= STEPS) continue;
    const cur = steps[s].get(voice) ?? 0;
    if (n.velocity > cur) steps[s].set(voice, n.velocity);
    hits++;
  }
  return { steps, hits, unmapped };
}

/** Even spread of up to `max` indices across `len` ranked items (simple→complex). */
function spread(len: number, max: number): number[] {
  if (len <= max) return [...Array(len).keys()];
  const out = new Set<number>();
  for (let i = 0; i < max; i++) out.add(Math.round((i * (len - 1)) / (max - 1)));
  return [...out];
}

function main(): void {
  const buf = new Uint8Array(readFileSync(TEMPLATE));
  if (buf.length !== NCS_FILE_SIZE) throw new Error(`template is ${buf.length} bytes, expected ${NCS_FILE_SIZE}`);

  const grooveFiles = readdirSync(SONG_DIR)
    .filter((f) => /groove.*\.mid$/i.test(f))
    .map((f) => path.join(SONG_DIR, f));
  if (grooveFiles.length === 0) throw new Error(`no *Groove*.mid in ${SONG_DIR}`);

  const ranked = grooveFiles
    .map((f) => ({ f, bytes: new Uint8Array(readFileSync(f)) }))
    .map((x) => ({ ...x, hits: reduceGroove(x.bytes).hits }))
    .sort((a, b) => a.hits - b.hits);
  const picks = spread(ranked.length, 8).map((i) => ranked[i]);

  console.log(`The Summoning — ${ranked.length} grooves, using ${picks.length} as patterns 1..${picks.length}:\n`);

  picks.forEach((p, pat) => {
    const g = reduceGroove(p.bytes);
    const grid: Array<undefined | Array<{ note: number; velocity: number }>> = [];
    for (let s = 0; s < STEPS; s++) {
      const cell = g.steps[s];
      const notes: Array<{ note: number; velocity: number }> = [];
      for (const [voice, vel] of cell) {
        const gm = SPDSX_GM_NOTE[voice];
        if (gm === undefined) continue;
        notes.push({ note: gm + OCTAVE, velocity: Math.max(1, Math.min(127, vel)) });
      }
      grid[s] = notes.length ? notes.slice(0, 6) : undefined;
    }

    setNotePattern(buf, 'midi2', pat, grid);
    buf[META_OFFSETS[noteBlockIndex('midi2', pat)]] = lengthByte(STEPS);

    const lane = grid.map((c) => (c && c.length ? (c.length > 1 ? String(Math.min(9, c.length)) : 'x') : '.')).join('');
    const usedGm = [...new Set(grid.flatMap((c) => c ?? []).map((n) => n.note - OCTAVE))].sort((a, b) => a - b);
    const unmappedList = [...g.unmapped.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}×${c}`).join(', ');
    console.log(`  pattern ${pat + 1}  ${path.basename(p.f)}  (${g.hits} mapped hits)`);
    console.log(`    ${lane}`);
    console.log(`    GM notes: ${usedGm.join(', ') || '(none)'}${unmappedList ? `   dropped: ${unmappedList}` : ''}`);
  });

  // Chain the MIDI 2 note track through all authored patterns so the device
  // auto-advances 1..N and loops. HARDWARE-CONFIRMED (2026-07-01): note-track
  // auto-advance is the per-track chain slot (midi2 = 0x2d0), NOT the drum chain
  // (0x2d4+) — the earlier setDrumChain here wrote the range into the drum slots,
  // which the MIDI 2 track ignored, so it looped pattern 1 forever.
  setNoteChain(buf, 'midi2', { start: 0, end: picks.length - 1 });

  // Chromatic so the authored GM notes play LITERALLY (no scale re-quantize).
  setProjectScale(buf, SCALE_CHROMATIC);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, buf);
  console.log(`\nwrote ${OUT}\nUpload with: upload_project(circuit-tracks, "${path.resolve(OUT)}", <slot>)`);
}

main();
