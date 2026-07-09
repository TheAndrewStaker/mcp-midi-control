/**
 * Circuit Tracks `.ncs` — pattern LENGTH + per-track pattern CHAIN edits.
 *
 * Fields decoded from real before/after device diffs and hardware-confirmed:
 *
 *  - **Length** — byte 0 of a pattern's metadata block (`META_OFFSETS`),
 *    value = steps-1 (`0x1f` = 32). The template default `0x0f` = 16, so a
 *    32-step pattern plays only its first bar unless this is set. HARDWARE-
 *    CONFIRMED (drum tracks 2026-06-22; note tracks 2026-06-30).
 *
 *  - **Chain** — ONE per-track chain table, shared by every track (2026-07-01
 *    device capture, HARDWARE-CONFIRMED on the maintainer's Circuit Tracks).
 *    Base `0x2c4`, 8 slots × 4 bytes, each `[start, end, 0, 0]` — 0-based
 *    pattern indices; the track auto-advances patterns start..end (inclusive)
 *    and loops. An unchained track is `[0, 0]` (plays pattern 1 only). The
 *    table's track order is NOT the META-block order — the four NOTE tracks
 *    come first, then the four drums:
 *
 *      slot 0  0x2c4  synth1      slot 4  0x2d4  drum1
 *      slot 1  0x2c8  synth2      slot 5  0x2d8  drum2
 *      slot 2  0x2cc  midi1       slot 6  0x2dc  drum3
 *      slot 3  0x2d0  midi2       slot 7  0x2e0  drum4
 *
 *    CONFIRMED (device-isolated): midi1 `0x2cc` end=2 (Program 1, chained 1→3);
 *    midi2 `0x2d0` end=3 (Program 2, chained 1→4); the drum slot GROUP reproduces
 *    the earlier hardware-confirmed `setDrumChain([0,1])`. Note-track auto-advance
 *    is THIS table, not scenes (the scene stack was byte-identical across the
 *    captures). synth1=slot0 is also device-isolated (2026-07-01 Project 4: a
 *    Synth-1-only chain set `0x2c4` end=3 with synth2 `0x2c8` untouched), so all
 *    four NOTE-track slots (0-3) are confirmed; synth2=slot1 follows by
 *    elimination. INFERRED (low-stakes): the individual drum1..drum4 order within
 *    slots 4-7 — no capture moves one drum alone, but `setDrumChain` writes all 4
 *    identically so it is immaterial. Also INFERRED: the START byte at offset+0 —
 *    every capture chains from pattern 1, so only the END byte (offset+1) is
 *    device-proven 0-based. See docs/_private/HANDOFF-circuit-multipattern.md.
 *
 * All edits mutate the project buffer in place and touch only these bytes.
 */

import {
  NCS_FILE_SIZE, NUM_DRUM_TRACKS, PATTERNS_PER_TRACK,
  META_OFFSETS, drumBlockIndex, type NoteTrack,
} from './format.js';

/** Length byte value for an N-step pattern (stored as steps-1). 32 → 0x1f. */
export const lengthByte = (steps: number): number => Math.max(0, Math.min(31, steps - 1));

/** Shared chain table: base 0x2c4, 8 slots × 4 bytes, [start, end, 0, 0]. */
const CHAIN_TABLE_BASE = 0x2c4;
const CHAIN_SLOT_STRIDE = 4;
/** Global chain-slot index of drum track 0 (the four note tracks precede drums). */
const DRUM_CHAIN_INDEX_BASE = 4;
/** Global chain-slot index per note track (see the table above). */
const NOTE_TRACK_CHAIN_INDEX: Readonly<Record<NoteTrack, number>> = {
  synth1: 0, synth2: 1, midi1: 2, midi2: 3,
};

/** Byte offset of a track's chain slot (its `[start, end, 0, 0]` record). */
function chainSlotOffset(globalIndex: number): number {
  return CHAIN_TABLE_BASE + globalIndex * CHAIN_SLOT_STRIDE;
}

// SUSPECT — likely a MIS-DECODE, DRUM-only. 0x26fc7 is the project's
// "active/last-selected drum sample" UI byte (it equals Drum 2's sample slot
// across Project 33 + 43; see docs/design/circuit-drum-binding.md). The `0x0c`
// seen in the lone drum-chain capture was the user's last-selected sample (slot
// 12), not a chain constant. `setNoteChain` correctly does NOT write it — but note
// the 2026-07-01 note-chain captures did NOT "change only the slot bytes": they
// also rewrote 0x26fc7 / 0x2e9 (non-deterministic session/UI-selection bytes) and
// the drum end-bytes. Kept for drums to avoid changing shipped bytes; drop after a
// clean re-capture (a chain edit touching no sample).
const CHAIN_TAIL_OFFSET = 0x26fc7;
const CHAIN_TAIL_ENABLE = 0x0c;

function assertBuf(buf: Uint8Array): void {
  if (buf.length !== NCS_FILE_SIZE) throw new RangeError(`.ncs buffer must be ${NCS_FILE_SIZE} bytes, got ${buf.length}`);
}

/** Set one drum pattern's length (track 0..3, pattern 0..7) to `steps`. */
export function setDrumPatternLength(buf: Uint8Array, track: number, pattern: number, steps: number): void {
  assertBuf(buf);
  buf[META_OFFSETS[drumBlockIndex(track, pattern)]] = lengthByte(steps);
}

/** Set EVERY drum pattern (4 tracks × 8 patterns) to `steps` (default 32). */
export function setAllDrumLengths(buf: Uint8Array, steps = 32): void {
  assertBuf(buf);
  for (let track = 0; track < NUM_DRUM_TRACKS; track++) {
    for (let pattern = 0; pattern < PATTERNS_PER_TRACK; pattern++) setDrumPatternLength(buf, track, pattern, steps);
  }
}

/**
 * Bake a drum pattern CHAIN over the range `[start, end]` (0-based pattern
 * indices) on all four drum tracks, so the device auto-advances start..end and
 * loops. `setAllDrumLengths` should be called too (a chained pattern still needs
 * its length set). Returns the byte offsets changed (for verification).
 *
 * DECODED-BETA: hardware-confirmed only for `[0,1]` (chain pattern 1→2). Wider
 * ranges write the same `[start,end]` layout the capture revealed plus the
 * captured enable tail, but are UNTESTED — confirm on hardware before trusting
 * a song's full chain (see the queued capture).
 */
export function setDrumChain(buf: Uint8Array, range: { start: number; end: number }): readonly number[] {
  assertBuf(buf);
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= PATTERNS_PER_TRACK || end < start) {
    throw new RangeError(`chain range must be 0..${PATTERNS_PER_TRACK - 1} with start<=end, got [${start},${end}]`);
  }
  const changed: number[] = [];
  for (let track = 0; track < NUM_DRUM_TRACKS; track++) {
    const startOff = chainSlotOffset(DRUM_CHAIN_INDEX_BASE + track);
    const endOff = startOff + 1;
    buf[startOff] = start;
    buf[endOff] = end;
    changed.push(startOff, endOff);
  }
  buf[CHAIN_TAIL_OFFSET] = CHAIN_TAIL_ENABLE;
  changed.push(CHAIN_TAIL_OFFSET);
  return changed;
}

/**
 * Bake a per-track pattern CHAIN on a NOTE track (synth1/synth2/midi1/midi2)
 * over the range `[start, end]` (0-based pattern indices, inclusive), so the
 * device auto-advances that track through patterns start..end and loops. Sets
 * only the track's 2-byte chain slot; no tail byte (note chains don't use it).
 * Returns the byte offsets changed. HARDWARE-CONFIRMED (2026-07-01): reproduces
 * the chain-slot bytes the device writes (midi1 `0x2cd`=end, midi2 `0x2d1`=end),
 * NOT the device's full save image (which also rewrites session UI-selection
 * bytes 0x26fc7/0x2e9 and drum end-bytes — those are correctly left alone here).
 *
 * This is what makes a multi-pattern note track (e.g. a MIDI-2 groove driving
 * the SPD-SX) advance — without it the device loops pattern 1 forever. Chaining
 * MIDI 2 uses slot `0x2d0`; the earlier bug wrote the range into the DRUM slots
 * (`setDrumChain`, `0x2d4+`), which the note track ignores.
 */
export function setNoteChain(
  buf: Uint8Array,
  track: NoteTrack,
  range: { start: number; end: number },
): readonly number[] {
  assertBuf(buf);
  const idx = NOTE_TRACK_CHAIN_INDEX[track];
  if (idx === undefined) {
    throw new RangeError(`note track must be one of synth1/synth2/midi1/midi2, got ${track}`);
  }
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= PATTERNS_PER_TRACK || end < start) {
    throw new RangeError(`chain range must be 0..${PATTERNS_PER_TRACK - 1} with start<=end, got [${start},${end}]`);
  }
  const startOff = chainSlotOffset(idx);
  buf[startOff] = start;
  buf[startOff + 1] = end;
  return [startOff, startOff + 1];
}

/**
 * Read a note track's chain `[start, end]` (0-based, inclusive), or `undefined`
 * if the track is unchained (a `[0, 0]` slot = plays pattern 1 only).
 */
export function getNoteChain(buf: Uint8Array, track: NoteTrack): { start: number; end: number } | undefined {
  assertBuf(buf);
  const idx = NOTE_TRACK_CHAIN_INDEX[track];
  if (idx === undefined) {
    throw new RangeError(`note track must be one of synth1/synth2/midi1/midi2, got ${track}`);
  }
  const off = chainSlotOffset(idx);
  const start = buf[off];
  const end = buf[off + 1];
  return end > start ? { start, end } : undefined;
}
