/**
 * VALIDATION for the (now SOLVED) note-track multi-pattern chain — see
 * docs/_private/HANDOFF-circuit-multipattern.md. This authored a 2-distinct-pattern
 * MIDI-2 project that used to loop pattern 1; it now bakes the CORRECT chain
 * (`setNoteChain('midi2', [0,1])`, slot 0x2d0) so the device auto-advances 1→2.
 *
 * Builds pattern 1 = kick (GM 36) four-on-the-floor (sparse) and pattern 2 = hat
 * (GM 42) on every step (busy) — different note AND density, so the result is
 * unambiguous. Sets the note LENGTH + the MIDI-2 note chain [0,1] + chromatic
 * scale. Notes are authored +12 (the Circuit transmits MIDI-track notes an octave low).
 *
 * The old bug: this called setDrumChain([0,1]), which wrote the range into the
 * DRUM chain slots (0x2d4+) that the MIDI 2 track ignores — so it never advanced.
 * Fixed 2026-07-01 after a device before/after diff located the real chain table.
 *
 *   npx tsx scripts/circuit-multipattern-repro.ts
 *   -> samples/circuit-tracks/grooves/gm/test_distinct.ncs
 *
 * On-hardware confirm of the AUTHORED chain (device fully booted + STOPPED):
 * upload_project(circuit-tracks, <that file>, <scratch slot>), let it settle, load + play.
 * The MIDI 2 track should alternate kick(36) → busy-hats(42) each pattern.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { setNotePattern } from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { setProjectScale, SCALE_CHROMATIC } from '@mcp-midi-control/circuit-tracks/ncs/scale.js';
import { setNoteChain } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import { META_OFFSETS, noteBlockIndex } from '@mcp-midi-control/circuit-tracks/ncs/format.js';

const OCTAVE = 12;
const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';
const OUT = 'samples/circuit-tracks/grooves/gm/test_distinct.ncs';

const buf = new Uint8Array(readFileSync(TEMPLATE));

// Pattern 1: kick (GM 36) on the 4 downbeats — sparse.
const KICK = 36 + OCTAVE;
setNotePattern(buf, 'midi2', 0, Array.from({ length: 16 }, (_, s) => (s % 4 === 0 ? [{ note: KICK, velocity: 110 }] : undefined)));
buf[META_OFFSETS[noteBlockIndex('midi2', 0)]] = 15; // 16 steps

// Pattern 2: hat (GM 42) on EVERY step — busy, different note.
const HAT = 42 + OCTAVE;
setNotePattern(buf, 'midi2', 1, Array.from({ length: 16 }, () => [{ note: HAT, velocity: 90 }]));
buf[META_OFFSETS[noteBlockIndex('midi2', 1)]] = 15; // 16 steps

setNoteChain(buf, 'midi2', { start: 0, end: 1 }); // MIDI 2 auto-advances patterns 1→2 (slot 0x2d0)
setProjectScale(buf, SCALE_CHROMATIC);

writeFileSync(OUT, buf);
console.log(`wrote ${OUT}\npattern 1 = kick 36 x4, pattern 2 = hat 42 x16. FIXED: MIDI 2 chain [0,1] → should alternate on device.`);
