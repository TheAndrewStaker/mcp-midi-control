/**
 * Circuit Tracks `.ncs` — SCENE CHAIN (song arrangement) edit.
 *
 * A Scene Chain makes the project auto-advance through a contiguous range of
 * scenes (each scene plays its pattern chain once, then the next scene starts),
 * looping at the end — this is how a multi-section song plays hands-free across
 * more than one scene. On the device you build it in Mixer View by holding the
 * first scene pad and pressing the last (manual p.83).
 *
 * Decoded 2026-06-24 from a real before/after device diff (Project 64): a user
 * built a Scene 1→4 chain and saved. Exactly three bytes changed:
 *
 *   - `@0x2c1` 0x00 → 0x03 — the SCENE-CHAIN END, 0-based scene index. The chain
 *     runs Scene 1 (start) .. (end+1). This byte sits immediately after the
 *     16-scene stack (`0x51 + 16*0x27 = 0x2c1`), and is GLOBAL (one chain per
 *     project, not per-track). HARDWARE-CONFIRMED for the 1→4 case.
 *   - `@0x26fbc` 0x08 → 0x00 and `@0x26fd2` 0x05 → 0x07 — scene-select playback
 *     state (which scene the playhead sits on). We replicate the device's
 *     working-chain values verbatim so an authored file is byte-identical to
 *     what the device saves for a 1→N chain.
 *
 * SCOPE / LIMITS:
 *   - START is fixed at Scene 1. The capture's start was Scene 1 (index 0), so
 *     its byte (if separate) was 0 in both halves of the diff and is not located
 *     yet. Chains that start above Scene 1 need a fresh capture.
 *   - END is decoded-beta: byte-identical to the device for 1→4; 1→N (N≠4)
 *     extrapolates the single end byte and is UNTESTED beyond 1→4.
 */

import { NCS_FILE_SIZE, NUM_DRUM_TRACKS, PATTERNS_PER_TRACK, type NoteTrack } from './format.js';

/** Max scenes in a Circuit Tracks project (the 16 Mixer-View scene pads). */
export const MAX_SCENES = 16;

/** Scene-chain END byte: 0-based index of the last scene in the chain. */
const SCENE_CHAIN_END_OFFSET = 0x2c1;
/** Scene-select playback-state bytes the device sets when a chain is active. */
const SCENE_STATE_A_OFFSET = 0x26fbc;
const SCENE_STATE_A_CHAINED = 0x00;
const SCENE_STATE_B_OFFSET = 0x26fd2;
const SCENE_STATE_B_CHAINED = 0x07;

function assertBuf(buf: Uint8Array): void {
  if (buf.length !== NCS_FILE_SIZE) throw new RangeError(`.ncs buffer must be ${NCS_FILE_SIZE} bytes, got ${buf.length}`);
}

/**
 * Bake a Scene Chain that auto-advances Scene 1 .. `endScene` (1-based,
 * inclusive) and loops. `endScene` is 2..16 (a chain of one scene is just a
 * plain scene — no chain). The project must already have scenes defined for
 * 1..endScene (see the scene-bake pipeline). Returns the byte offsets changed.
 *
 * DECODED-BETA: byte-identical to the device for endScene=4; wider ends
 * extrapolate the single end byte and are UNTESTED. START is always Scene 1.
 */
export function setSceneChain(buf: Uint8Array, endScene: number): readonly number[] {
  assertBuf(buf);
  if (!Number.isInteger(endScene) || endScene < 2 || endScene > MAX_SCENES) {
    throw new RangeError(`scene chain end must be an integer 2..${MAX_SCENES} (start is always Scene 1), got ${endScene}`);
  }
  buf[SCENE_CHAIN_END_OFFSET] = endScene - 1; // 0-based last scene
  buf[SCENE_STATE_A_OFFSET] = SCENE_STATE_A_CHAINED;
  buf[SCENE_STATE_B_OFFSET] = SCENE_STATE_B_CHAINED;
  return [SCENE_CHAIN_END_OFFSET, SCENE_STATE_A_OFFSET, SCENE_STATE_B_OFFSET];
}

/** Read back the scene-chain end (1-based last scene), or undefined if no chain. */
export function getSceneChainEnd(buf: Uint8Array): number | undefined {
  assertBuf(buf);
  const end0 = buf[SCENE_CHAIN_END_OFFSET];
  return end0 > 0 ? end0 + 1 : undefined;
}

// ── Per-scene track pattern selection ────────────────────────────────
//
// A scene stores each track's pattern selection so a scene switch swaps whole
// sections of the song. Decoded 2026-07-01 from a device before/after diff
// (Project 4, MIDI-2 on pattern 1 in Scene 1 vs pattern 2 in Scene 2), COMMUNITY-
// BETA (single capture). Each scene block is 0x28 bytes at 0x50 + N*0x28:
//   +0x00..+0x0f : 4 DRUM chain slots [start,end,0,0] (drum1..4) — drums-first,
//                  UNLIKE the active 0x2c4 table (which is note-tracks-first)
//   +0x10        : "scene defined" flag (0x01)
//   +0x18..+0x27 : 4 NOTE chain slots [start,end,0,0] (synth1, synth2, midi1, midi2)
// Proof: Scene 1 held synth1=[0,3] (+0x18) AND midi2=[1,1] (+0x24), both matching
// the active table exactly; Scene 2 held midi2=[0,0]. A single pattern selection N
// is stored as the chain [N,N]; a real chain is [start,end] (0-based, inclusive).
const SCENE_BLOCK_BASE = 0x50;
const SCENE_BLOCK_STRIDE = 0x28;
const SCENE_DEFINED_FLAG_OFS = 0x10;
const SCENE_NOTE_TABLE_OFS = 0x18; // 4 note slots: synth1,synth2,midi1,midi2
const NOTE_SCENE_SLOT: Readonly<Record<NoteTrack, number>> = {
  synth1: 0, synth2: 1, midi1: 2, midi2: 3,
};
/** Confirmed for scenes 1..4 (0-based 0..3); wider scenes share the stride but are UNTESTED. */
const MAX_TESTED_SCENE = 3;

/**
 * Set a NOTE track's per-scene pattern selection: in scene `sceneIndex` (0-based,
 * Scene 1 = 0), that track plays patterns `[start, end]` (0-based, inclusive; a
 * single pattern N = `{start:N, end:N}`). Marks the scene defined. Chain the
 * scenes with {@link setSceneChain} to auto-advance sections. Returns the offsets
 * changed. COMMUNITY-BETA (decoded from one device capture); the `0x28` block
 * stride is device-confirmed for scenes 1..4.
 */
export function setSceneNoteChain(
  buf: Uint8Array, sceneIndex: number, track: NoteTrack, range: { start: number; end: number },
): readonly number[] {
  assertBuf(buf);
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= MAX_SCENES) {
    throw new RangeError(`sceneIndex must be 0..${MAX_SCENES - 1} (Scene 1 = 0), got ${sceneIndex}`);
  }
  if (sceneIndex > MAX_TESTED_SCENE) {
    // The stride is confirmed only through Scene 4; refuse rather than write a
    // possibly-misaligned block on faith (a wider capture would lift this).
    throw new RangeError(`scene ${sceneIndex + 1} is beyond the device-confirmed range (Scenes 1..${MAX_TESTED_SCENE + 1}); capture a wider scene set before using it`);
  }
  const slot = NOTE_SCENE_SLOT[track];
  if (slot === undefined) throw new RangeError(`note track must be synth1/synth2/midi1/midi2, got ${track}`);
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= PATTERNS_PER_TRACK || end < start) {
    throw new RangeError(`selection must be 0..${PATTERNS_PER_TRACK - 1} with start<=end, got [${start},${end}]`);
  }
  const block = SCENE_BLOCK_BASE + sceneIndex * SCENE_BLOCK_STRIDE;
  const off = block + SCENE_NOTE_TABLE_OFS + slot * 4;
  buf[off] = start;
  buf[off + 1] = end;
  buf[block + SCENE_DEFINED_FLAG_OFS] = 0x01; // mark the scene defined
  return [off, off + 1, block + SCENE_DEFINED_FLAG_OFS];
}

/** Scene block sub-table of the 4 DRUM chain slots (drums-first, +0x00). */
const SCENE_DRUM_TABLE_OFS = 0x00;

/**
 * Set a DRUM track's per-scene pattern selection (track 0..3 = Drum1..4), same
 * `[start, end]` semantics as {@link setSceneNoteChain}. The drum sub-table sits
 * at the scene block's +0x00 (drums-first — the capture proved the note table at
 * +0x18 and documents the drum slots before it). COMMUNITY-BETA, one step less
 * confirmed than the note table: the drum1..4 order WITHIN the sub-table is
 * inferred from the active-table layout (no capture moves one drum alone) — but
 * arrangement authoring writes all four identically, where the order is
 * immaterial (mirrors the setDrumChain situation in chain.ts).
 */
export function setSceneDrumChain(
  buf: Uint8Array, sceneIndex: number, drumTrack: number, range: { start: number; end: number },
): readonly number[] {
  assertBuf(buf);
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= MAX_SCENES) {
    throw new RangeError(`sceneIndex must be 0..${MAX_SCENES - 1} (Scene 1 = 0), got ${sceneIndex}`);
  }
  if (sceneIndex > MAX_TESTED_SCENE) {
    throw new RangeError(`scene ${sceneIndex + 1} is beyond the device-confirmed range (Scenes 1..${MAX_TESTED_SCENE + 1}); capture a wider scene set before using it`);
  }
  if (!Number.isInteger(drumTrack) || drumTrack < 0 || drumTrack >= NUM_DRUM_TRACKS) {
    throw new RangeError(`drum track must be 0..${NUM_DRUM_TRACKS - 1} (Drum1..4), got ${drumTrack}`);
  }
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= PATTERNS_PER_TRACK || end < start) {
    throw new RangeError(`selection must be 0..${PATTERNS_PER_TRACK - 1} with start<=end, got [${start},${end}]`);
  }
  const block = SCENE_BLOCK_BASE + sceneIndex * SCENE_BLOCK_STRIDE;
  const off = block + SCENE_DRUM_TABLE_OFS + drumTrack * 4;
  buf[off] = start;
  buf[off + 1] = end;
  buf[block + SCENE_DEFINED_FLAG_OFS] = 0x01;
  return [off, off + 1, block + SCENE_DEFINED_FLAG_OFS];
}

/** Read a drum track's per-scene selection `[start,end]`, or undefined if that scene is not defined. */
export function getSceneDrumChain(
  buf: Uint8Array, sceneIndex: number, drumTrack: number,
): { start: number; end: number } | undefined {
  assertBuf(buf);
  if (drumTrack < 0 || drumTrack >= NUM_DRUM_TRACKS || sceneIndex < 0 || sceneIndex >= MAX_SCENES) return undefined;
  const block = SCENE_BLOCK_BASE + sceneIndex * SCENE_BLOCK_STRIDE;
  if (buf[block + SCENE_DEFINED_FLAG_OFS] !== 0x01) return undefined;
  const off = block + SCENE_DRUM_TABLE_OFS + drumTrack * 4;
  return { start: buf[off], end: buf[off + 1] };
}

/** Read a note track's per-scene selection `[start,end]`, or undefined if that scene is not defined. */
export function getSceneNoteChain(
  buf: Uint8Array, sceneIndex: number, track: NoteTrack,
): { start: number; end: number } | undefined {
  assertBuf(buf);
  const slot = NOTE_SCENE_SLOT[track];
  if (slot === undefined || sceneIndex < 0 || sceneIndex >= MAX_SCENES) return undefined;
  const block = SCENE_BLOCK_BASE + sceneIndex * SCENE_BLOCK_STRIDE;
  if (buf[block + SCENE_DEFINED_FLAG_OFS] !== 0x01) return undefined;
  const off = block + SCENE_NOTE_TABLE_OFS + slot * 4;
  return { start: buf[off], end: buf[off + 1] };
}
