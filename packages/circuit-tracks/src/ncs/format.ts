/**
 * Novation Circuit Tracks `.ncs` project-file format: constants + offsets.
 *
 * The on-disk `.ncs` (one per project, in a Pack's `projects/` or the card's
 * `Sessions/` folder) is a fixed 160,780-byte RAW structured blob: not
 * compressed, not encrypted (measured entropy ~1.35 bits/byte), with a
 * readable project name at offset 0x10. ~97% of the file is constant
 * scaffolding shared by every project; only the small per-project payload
 * varies. That makes "template-modify" (keep the file verbatim, change only
 * the bytes you mean to) safe and cheap.
 *
 * The format here is reverse-engineered (clean-room: layout facts only,
 * validated byte-exact against a corpus of real exported projects). Format
 * facts are uncopyrightable; this is an independent TypeScript implementation.
 *
 * Block layout: 64 "blocks", each a (track, pattern) cell. Tracks are Synth1,
 * Synth2 (0-1), Drum1-4 (2-5), MIDI1-2 (6-7); 8 patterns each. Blocks 0-15 are
 * synth, 16-47 are drum, 48-63 are MIDI. Each block's step data ENDS at its
 * metadata offset and begins `region` bytes earlier.
 */

export const NCS_FILE_SIZE = 160_780;
export const STEPS_PER_PATTERN = 32;
export const PATTERNS_PER_TRACK = 8;
export const NUM_DRUM_TRACKS = 4;

/** Drum step region = 16-byte header + 4 rows x 32 (velocity / probability / drum_choice / rhythm). */
export const DRUM_STEP_REGION = 16 + 4 * 32; // 144

/** Drum blocks occupy metadata indices 16..47 (4 tracks x 8 patterns). */
export const DRUM_BLOCK_START = 16;

/** Per-block metadata offsets (step data ends here). 64 entries. */
export const META_OFFSETS: readonly number[] = [
  // synth blocks 0-15
  0x664, 0x130c, 0x1fb4, 0x2c5c, 0x3904, 0x45ac, 0x5254, 0x5efc,
  0x6ba4, 0x784c, 0x84f4, 0x919c, 0x9e44, 0xaaec, 0xb794, 0xc43c,
  // drum blocks 16-47
  0xcdf4, 0xd49c, 0xdb44, 0xe1ec, 0xe894, 0xef3c, 0xf5e4, 0xfc8c,
  0x10334, 0x109dc, 0x11084, 0x1172c, 0x11dd4, 0x1247c, 0x12b24, 0x131cc,
  0x13874, 0x13f1c, 0x145c4, 0x14c6c, 0x15314, 0x159bc, 0x16064, 0x1670c,
  0x16db4, 0x1745c, 0x17b04, 0x181ac, 0x18854, 0x18efc, 0x195a4, 0x19c4c,
  // midi blocks 48-63
  0x1a5fc, 0x1b2a4, 0x1bf4c, 0x1cbf4, 0x1d89c, 0x1e544, 0x1f1ec, 0x1fe94,
  0x20b3c, 0x217e4, 0x2248c, 0x23134, 0x23ddc, 0x24a84, 0x2572c, 0x263d4,
];

/** Metadata-block index for a drum (track 0..3 = Drum1..Drum4, pattern 0..7). */
export function drumBlockIndex(track: number, pattern: number): number {
  if (!Number.isInteger(track) || track < 0 || track >= NUM_DRUM_TRACKS) {
    throw new RangeError(`drum track must be 0..${NUM_DRUM_TRACKS - 1} (Drum1..Drum4), got ${track}`);
  }
  if (!Number.isInteger(pattern) || pattern < 0 || pattern >= PATTERNS_PER_TRACK) {
    throw new RangeError(`pattern must be 0..${PATTERNS_PER_TRACK - 1}, got ${pattern}`);
  }
  return DRUM_BLOCK_START + track * PATTERNS_PER_TRACK + pattern;
}

/** Byte offset of row 0 (velocity) for a drum (track, pattern). Rows: vel+0, prob+32, choice+64, rhythm+96. */
export function drumRowBase(track: number, pattern: number): number {
  return META_OFFSETS[drumBlockIndex(track, pattern)] - DRUM_STEP_REGION + 16;
}

export const NOTE_SLOTS_PER_STEP = 6;         // up to a 6-note chord per step
/** Note step = 1 header record + 6 note slots, 4 bytes each = 28 bytes. */
export const NOTE_STEP_BYTES = 4 * (1 + NOTE_SLOTS_PER_STEP); // 28
/** Note step region = 32 steps x 28 bytes, ending at the block's metadata offset. */
export const NOTE_STEP_REGION = NOTE_STEP_BYTES * STEPS_PER_PATTERN; // 896

/**
 * The four "note" tracks share one identical 28-byte step codec (verified
 * byte-for-byte): the two Synths play it internally, the two MIDI tracks send it
 * out the MIDI/USB port to drive external gear. They differ ONLY in which 8
 * metadata blocks they own.
 */
export type NoteTrack = 'synth1' | 'synth2' | 'midi1' | 'midi2';
const NOTE_TRACK_BLOCK_START: Readonly<Record<NoteTrack, number>> = {
  synth1: 0, synth2: 8, midi1: 48, midi2: 56,
};
export const NOTE_TRACKS = Object.keys(NOTE_TRACK_BLOCK_START) as readonly NoteTrack[];

/** Metadata-block index for a note track (synth1/synth2/midi1/midi2, pattern 0..7). */
export function noteBlockIndex(track: NoteTrack, pattern: number): number {
  const start = NOTE_TRACK_BLOCK_START[track];
  if (start === undefined) throw new RangeError(`note track must be one of ${NOTE_TRACKS.join('/')}, got ${track}`);
  if (!Number.isInteger(pattern) || pattern < 0 || pattern >= PATTERNS_PER_TRACK) {
    throw new RangeError(`pattern must be 0..${PATTERNS_PER_TRACK - 1}, got ${pattern}`);
  }
  return start + pattern;
}

/** Byte offset of step 0 (the header record) for a note track (track, pattern). */
export function noteStepBase(track: NoteTrack, pattern: number): number {
  return META_OFFSETS[noteBlockIndex(track, pattern)] - NOTE_STEP_REGION;
}
