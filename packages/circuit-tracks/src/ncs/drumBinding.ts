/**
 * Circuit Tracks `.ncs` — DRUM-TRACK → SAMPLE-SLOT binding.
 *
 * Each of the 4 drum tracks (Drum 1..Drum 4) plays one sample from the Pack's
 * 64-slot pool. Which slot each track points to is a PROJECT-GLOBAL field — four
 * consecutive bytes, one per track, each a 0-based sample slot (byte = the
 * device's 1..64 "Sample N" minus 1):
 *
 *   0x1a278  Drum 1 sample slot (0..63)
 *   0x1a279  Drum 2 sample slot
 *   0x1a27a  Drum 3 sample slot
 *   0x1a27b  Drum 4 sample slot
 *
 * The field sits in the project-config region between the last drum step-block
 * (meta 0x19c4c) and the first MIDI block (meta 0x1a5fc).
 *
 * DECODED 2026-06-27 by a controlled on-device before/after diff (Project 33,
 * exported via export_preset, byte-diffed). HARDWARE-CONFIRMED both directions:
 *   - Reassigning Drum 1 to sample 12 produced byte 0x1a278 = 0x0b, and the
 *     device showed "china" on Drum 1 (sample 12). [first diff]
 *   - A clean single-variable reload+change of Drum 2 (crash→snare_roll) flipped
 *     ONLY 0x1a279 (0x07→0x06) plus its mirror; patterns untouched. [second diff]
 * This is the read/author half of the long-undecoded drum→sample binding: with
 * it, an authored project loads with its drum tracks already pointing at the
 * right kit slots (no on-device hand-assignment).
 *
 * MIRROR at 0x26fc7: across all three captures this byte equalled Drum 2's slot
 * (0x01/0x07/0x06). Its exact role is unconfirmed (likely "last-selected drum
 * sample" UI state) and it OVERLAPS the offset `chain.ts` currently treats as the
 * pattern-chain enable tail — a conflict to resolve before trusting either. We do
 * NOT write the mirror here (writing it risks clobbering chain state); the device
 * reconciles it on load. See docs/design/circuit-drum-binding.md.
 */

import { NCS_FILE_SIZE } from './format.js';
import { canonicalRole } from '@mcp-midi-control/core/protocol-generic/patterns/drumRoles.js';

/** Number of drum tracks (Drum 1..Drum 4). */
export const NUM_DRUM_TRACKS = 4;
/** Byte offset of Drum 1's sample-slot pointer; tracks 2..4 follow at +1 each. */
export const DRUM_BINDING_OFFSET = 0x1a278;
/** Max sample slot (0-based) — the pool is 64 slots (device "Sample 1".."Sample 64"). */
export const MAX_SAMPLE_SLOT = 63;

/**
 * Canonical Circuit role → pool-slot layout (0-based), the Layer-2 role→target map
 * for this device (see docs/design/groove-instrument-mapping.md). Mirrors
 * `pack_groove.py` SAMPLE_SLOT (which is 1-based; this is that minus 1) and the
 * role-ordered stoken kit we upload, so a groove authored against these roles
 * lands on the matching kit pieces. Voice names are the shared vocabulary used by
 * `GM_DRUM_TO_VOICE` (note→voice) and the Circuit `voice_map`.
 */
export const CIRCUIT_VOICE_SLOT: Readonly<Record<string, number>> = {
  kick: 0, snare: 1, closed_hat: 2, ride: 3, open_hat: 4, busy_hat: 5,
  snare_roll: 6, crash: 7, tom: 8, ride_bell: 9, sticks: 10, china: 11, perc: 12,
};

/** The voice each drum TRACK (Drum 1..4) plays by default — its base sample. */
export const DRUM_TRACK_BASE_VOICES: readonly string[] = ['kick', 'snare', 'closed_hat', 'ride'];

/**
 * Canonical stoken binding for Drum 1..4 = kick / snare / closed_hat / ride on
 * slots [0,1,2,3], derived from the role→slot map. An authored groove using this
 * binding loads turnkey against a role-ordered kit (no on-device hand-assignment).
 */
export const DEFAULT_DRUM_BINDING: readonly number[] =
  DRUM_TRACK_BASE_VOICES.map((v) => CIRCUIT_VOICE_SLOT[v]);

/**
 * Resolve a voice/role name (ANY dialect — `hat`, `closed_hat`, `Open Hat`, …) to
 * its Circuit pool slot via the canonical role spine, or undefined if unknown.
 * This is the cross-dialect lookup: `circuitSlotForVoice('hat') === 2`.
 */
export function circuitSlotForVoice(voice: string): number | undefined {
  const role = canonicalRole(voice);
  return role !== undefined ? CIRCUIT_VOICE_SLOT[role] : undefined;
}

/**
 * Resolve a per-step FLIP role to the pool slot it should play, honouring an
 * optional custom track binding. This is the join that lets `condense_drums`
 * and `drum_binding` COMPOSE instead of conflicting.
 *
 * Without a binding the pool is the canonical role-ordered kit, so this is
 * exactly {@link circuitSlotForVoice} (byte-identical to the pre-composition
 * behaviour). WITH a binding, the caller has declared the pool's layout
 * themselves: the only slots whose contents are then known are the four the
 * binding names, and each holds the sample for its track's own role
 * (kick / snare / closed_hat / ride, at the caller's slots). So a flip to one
 * of those four roles resolves to the BOUND slot (a ride flip on the hat track
 * plays the caller's ride sample, wherever they put it), and a flip to any
 * OTHER role (crash, tom, ride_bell…) returns undefined: the canonical layout
 * no longer describes this pool, and guessing a slot from it would flip the
 * step to whatever sample happens to live there, a silent misroute. The
 * caller layer reports the skipped flip; the hit keeps the track's bound sound.
 */
export function slotForFlipRole(voice: string, binding?: readonly number[]): number | undefined {
  const role = canonicalRole(voice);
  if (role === undefined) return undefined;
  if (binding === undefined) return CIRCUIT_VOICE_SLOT[role];
  const track = DRUM_TRACK_BASE_VOICES.findIndex((v) => canonicalRole(v) === role);
  return track >= 0 ? binding[track] : undefined;
}

/**
 * Resolve a per-track voice list (Drum 1..4 base voices) to a 4-slot binding via
 * the canonical role→slot map (any dialect accepted). Unknown voices throw
 * (author-time misconfig).
 */
export function bindingForTrackVoices(voices: readonly string[]): number[] {
  if (voices.length !== NUM_DRUM_TRACKS) {
    throw new RangeError(`expected ${NUM_DRUM_TRACKS} track voices, got ${voices.length}`);
  }
  return voices.map((v) => {
    const slot = circuitSlotForVoice(v);
    if (slot === undefined) throw new RangeError(`unknown drum voice "${v}" (no canonical slot)`);
    return slot;
  });
}

function assertBuf(buf: Uint8Array): void {
  if (buf.length !== NCS_FILE_SIZE) {
    throw new RangeError(`.ncs buffer must be ${NCS_FILE_SIZE} bytes, got ${buf.length}`);
  }
}

function assertSlot(slot: number, track: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SAMPLE_SLOT) {
    throw new RangeError(
      `drum ${track + 1} sample slot must be an integer 0..${MAX_SAMPLE_SLOT} (0-based; device Sample N = slot N-1), got ${slot}`,
    );
  }
}

/**
 * Set the 4 drum tracks' sample-slot pointers (0-based slots, one per Drum 1..4).
 * Mutates the buffer in place and returns the byte offsets changed.
 *
 * `slots[i]` is the 0-based pool slot Drum (i+1) will play — i.e. the device's
 * "Sample N" minus 1 (Sample 1 = slot 0). For the canonical stoken role layout
 * that the groove packer targets, pass [0, 1, 2, 3] = kick / snare / closed_hat /
 * ride on slots 1..4.
 */
export function setDrumSampleBinding(buf: Uint8Array, slots: readonly number[]): readonly number[] {
  assertBuf(buf);
  if (slots.length !== NUM_DRUM_TRACKS) {
    throw new RangeError(`expected ${NUM_DRUM_TRACKS} drum-track slots, got ${slots.length}`);
  }
  const changed: number[] = [];
  for (let t = 0; t < NUM_DRUM_TRACKS; t++) {
    assertSlot(slots[t], t);
    const off = DRUM_BINDING_OFFSET + t;
    buf[off] = slots[t];
    changed.push(off);
  }
  return changed;
}

/** Read the 4 drum tracks' current sample-slot pointers (0-based), Drum 1..4. */
export function getDrumSampleBinding(buf: Uint8Array): number[] {
  assertBuf(buf);
  const slots: number[] = [];
  for (let t = 0; t < NUM_DRUM_TRACKS; t++) slots.push(buf[DRUM_BINDING_OFFSET + t]);
  return slots;
}
