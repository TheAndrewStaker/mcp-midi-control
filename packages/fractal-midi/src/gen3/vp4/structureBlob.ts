/**
 * VP4 (model byte 0x14) whole-preset STRUCTURE BLOB — eid206 pid0 tc=0x1f.
 *
 * The VP4's system block eid 206 exposes, on paramId 0 with typecode 0x1f, a
 * single septet-packed blob carrying the active preset's STRUCTURE: preset
 * name, the four scene names, the current scene index, and the serial 4-slot
 * chain as effect IDs. One read = the whole layout (the register VP4-Edit
 * itself polls to render the chain).
 *
 * Decoded byte-exact from 392 captured VP4-Edit queries across TWO community
 * captures (Kevin Iudicello, fw 4.03):
 *   - `samples/captured/decoded/vp4-403/frames.json` (2026-06-08 read-poll
 *     session, preset "Y1: Main Bank": WAH/DRV/PHR/DLY, post scene-1→3 switch)
 *   - `samples/captured/decoded/vp4-403-v2/frames.json` (2026-06-09 annotated
 *     edit session, preset "Y1: Virtual Pedalboard")
 *
 * Wire shape (request, 18 bytes — verbatim in both captures, 202×):
 *   F0 00 01 74 14 01 4E 01 00 00 1F 00 00 00 00 00 cs F7
 *                     └eid 206─┘ └pid 0┘ tc      └len=0┘
 *
 * Response (238 bytes): same header through tc=0x1f, then `00 00 00` +
 * a 14-bit LSB-first length tag `40 01` (= 192 raw bytes, the same length-tag
 * convention as the write frame's `04 00`), then 220 packed bytes, cks, F7.
 * The 220 packed bytes unpack 8→7 with the chunked LSB-first-with-carry
 * scheme (primitive [[iii-byte-stream-septet-pack-8to7]]; the shared
 * `unpackValueChunked` — carry restarts every 8 wire / 7 raw bytes) into a
 * 192-byte raw record:
 *
 *   | raw offset | field |
 *   |---|---|
 *   | [0]        | u8 status flag: 0x00 fresh-loaded, 0x60 after the first structural edit |
 *   | [4]        | 1-bit toggle that FLIPS on every structural command (delete/move/save/scene) — NOT a clean dirty flag |
 *   | [8]        | u8 CURRENT SCENE, 0-based |
 *   | [12..15]   | float32 LE live telemetry — varies per poll; EXCLUDED from the parse (never fingerprint the raw blob) |
 *   | [16..47]   | preset name, ASCII, space-padded to 31 chars + NUL |
 *   | [48..175]  | scene 1..4 names, 4 × 32-byte records (31 ASCII + NUL) |
 *   | [176..191] | CHAIN TABLE: 4 × u32 LE effectId (shared gen-3 effect-ID table), slots 1..4 in order; 0 = empty slot |
 *
 * Oracles (byte-exact, action-annotated):
 *   - CHAIN: three chain states across the v2 edit session match the annotated
 *     actions — [118,78,70,66] (Drive/Chorus/Delay/Reverb) → the eid206 pid10
 *     write at 4.78 s (Drive delete) → [0,78,70,66] → the pid15/pid16 pair at
 *     10.73 s (Delay move + cascade) → [70,0,78,66] = the annotated
 *     [DLY, empty, CHO, RVB]. The v1 preset independently reads [70,118,90,94]
 *     = exactly its four annotated blocks (DLY/DRV/PHR/WAH).
 *   - CURRENT SCENE: the annotated v2 scene 1→3 switch (pid13 write at
 *     41.15 s) flips raw[8] 0→2; the v1 capture (also post scene-1→3) reads 2.
 *   - NAMES: "Virtual Pedalboard" / "Main Bank" + all eight scene names read
 *     as clean ASCII at the offsets above in both captures.
 *
 * Community beta: the blob layout is byte-decoded from real fw 4.03 hardware
 * traffic, but this server ISSUING the read is untested on hardware.
 */
import { fractalChecksum } from '../../shared/checksum.js';
import { encode14, decode14 } from '../../shared/septet16.js';
import { unpackValueChunked } from '../../shared/packValue.js';
import { AXE_FX_III_BLOCKS } from '../axe-fx-iii/blockTypes.js';
import { VP4_MODEL_ID, FN_PARAMETER, buildVp4Frame } from './setParam.js';

/** VP4 system block that owns the structure blob (beyond the III roster). */
export const VP4_STRUCTURE_EFFECT_ID = 206;
export const VP4_STRUCTURE_PARAM_ID = 0;
/** typecode selecting the large packed-blob response representation. */
export const TC_STRUCTURE_BLOB = 0x1f;

/** Raw (unpacked) record length carried by the response's 14-bit length tag. */
const STRUCTURE_RAW_LEN = 192;
/** ceil-ish chunked wire size for 192 raw bytes: 27 full chunks ×8 + (3+1). */
const STRUCTURE_PACKED_LEN = 220;

const NAME_RECORD_LEN = 32;
const PRESET_NAME_OFFSET = 16;
const SCENE_NAMES_OFFSET = 48;
const SCENE_COUNT = 4;
const CHAIN_OFFSET = 176;
const CHAIN_SLOTS = 4;

/** One occupied slot in the VP4's serial chain. */
export interface Vp4ChainSlot {
  /** Shared gen-3 effect ID (axe-fx-iii blockTypes table). */
  effectId: number;
  /**
   * Display name resolved from the shared gen-3 block table ("Delay",
   * "Drive 2"), or undefined for an effect ID outside the known roster.
   */
  name?: string;
}

export interface Vp4StructureBlob {
  /** raw[0]: 0x00 fresh-loaded, 0x60 observed after the first structural edit. */
  statusFlag: number;
  /** raw[8]: current scene, 0-based (wire value). */
  currentScene: number;
  /** Current scene as the panel shows it, 1-based (project display convention). */
  currentSceneDisplay: number;
  /** Preset name (trailing pad spaces stripped). */
  presetName: string;
  /** Scene 1..4 names (trailing pad spaces stripped). */
  sceneNames: [string, string, string, string];
  /** Serial chain, slots 1..4 in order; null = empty slot. */
  chain: [Vp4ChainSlot | null, Vp4ChainSlot | null, Vp4ChainSlot | null, Vp4ChainSlot | null];
}

/**
 * Build the eid206 pid0 tc=0x1f structure-blob GET. Byte-identical to the
 * frame VP4-Edit sends (202 occurrences across the two fw 4.03 captures):
 * `F0 00 01 74 14 01 4E 01 00 00 1F 00 00 00 00 00 40 F7`. Read-only.
 */
export function buildVp4GetStructureBlob(): number[] {
  return buildVp4Frame([
    ...encode14(VP4_STRUCTURE_EFFECT_ID),
    ...encode14(VP4_STRUCTURE_PARAM_ID),
    TC_STRUCTURE_BLOB,
    0x00, 0x00, 0x00,
    0x00, 0x00, // 14-bit length tag: a GET carries no value bytes
  ]);
}

/** Reverse lookup into the shared gen-3 block table: effectId → display name. */
function effectIdToName(effectId: number): string | undefined {
  for (const b of AXE_FX_III_BLOCKS) {
    if (b.firstId === null) continue;
    const d = effectId - b.firstId;
    if (d >= 0 && d < b.instances) return d === 0 ? b.name : `${b.name} ${d + 1}`;
  }
  return undefined;
}

/** ASCII decode of a 32-byte name record: cut at NUL, strip pad spaces. */
function decodeNameRecord(raw: Uint8Array, offset: number): string {
  let out = '';
  for (let i = 0; i < NAME_RECORD_LEN; i++) {
    const c = raw[offset + i];
    if (c === 0) break;
    out += String.fromCharCode(c & 0x7f);
  }
  return out.replace(/\s+$/, '');
}

/**
 * Parse a full eid206 pid0 tc=0x1f response frame (F0..F7 included) into the
 * decoded preset structure. Throws on anything that is not a well-formed
 * structure-blob response (wrong envelope/register/typecode, bad checksum,
 * unexpected length tag, truncated packed region).
 *
 * The live-telemetry float at raw[12..15] varies on every poll and is
 * deliberately NOT surfaced — never fingerprint or byte-compare raw blobs.
 */
export function parseVp4StructureBlob(bytes: readonly number[]): Vp4StructureBlob {
  if (
    bytes.length < 20 ||
    bytes[0] !== 0xf0 ||
    bytes[1] !== 0x00 || bytes[2] !== 0x01 || bytes[3] !== 0x74 ||
    bytes[4] !== VP4_MODEL_ID || bytes[5] !== FN_PARAMETER
  ) {
    throw new Error(
      `parseVp4StructureBlob: not a VP4 fn=0x01 frame (${bytes.length} bytes).`,
    );
  }
  const eid = decode14(bytes[6], bytes[7]);
  const pid = decode14(bytes[8], bytes[9]);
  const tc = bytes[10];
  if (eid !== VP4_STRUCTURE_EFFECT_ID || pid !== VP4_STRUCTURE_PARAM_ID || tc !== TC_STRUCTURE_BLOB) {
    throw new Error(
      `parseVp4StructureBlob: not the eid206 pid0 tc=0x1f structure register ` +
        `(eid ${eid}, pid ${pid}, tc 0x${tc.toString(16)}).`,
    );
  }
  if (bytes[bytes.length - 1] !== 0xf7) {
    throw new Error('parseVp4StructureBlob: frame does not end in F7.');
  }
  const expectedCks = fractalChecksum(bytes.slice(0, bytes.length - 2));
  if (bytes[bytes.length - 2] !== expectedCks) {
    throw new Error(
      `parseVp4StructureBlob: checksum mismatch (frame 0x${bytes[bytes.length - 2].toString(16)}, ` +
        `computed 0x${expectedCks.toString(16)}).`,
    );
  }
  // After tc: 3 zero bytes, then the 14-bit raw-length tag (same convention
  // as the write frame's `04 00`), then the packed region.
  const rawLen = decode14(bytes[14], bytes[15]);
  if (rawLen !== STRUCTURE_RAW_LEN) {
    throw new Error(
      `parseVp4StructureBlob: unexpected length tag ${rawLen} (expected ${STRUCTURE_RAW_LEN}; ` +
        `both fw 4.03 captures carry 192). Refusing to guess a different layout.`,
    );
  }
  const packed = bytes.slice(16, bytes.length - 2);
  if (packed.length !== STRUCTURE_PACKED_LEN) {
    throw new Error(
      `parseVp4StructureBlob: packed region is ${packed.length} bytes, expected ${STRUCTURE_PACKED_LEN}.`,
    );
  }
  const raw = unpackValueChunked(Uint8Array.from(packed), STRUCTURE_RAW_LEN);

  const sceneNames: string[] = [];
  for (let s = 0; s < SCENE_COUNT; s++) {
    sceneNames.push(decodeNameRecord(raw, SCENE_NAMES_OFFSET + s * NAME_RECORD_LEN));
  }
  const chain: Array<Vp4ChainSlot | null> = [];
  for (let s = 0; s < CHAIN_SLOTS; s++) {
    const o = CHAIN_OFFSET + s * 4;
    const effectId = (raw[o] | (raw[o + 1] << 8) | (raw[o + 2] << 16) | (raw[o + 3] << 24)) >>> 0;
    chain.push(effectId === 0 ? null : { effectId, name: effectIdToName(effectId) });
  }

  return {
    statusFlag: raw[0],
    currentScene: raw[8],
    currentSceneDisplay: raw[8] + 1,
    presetName: decodeNameRecord(raw, PRESET_NAME_OFFSET),
    sceneNames: sceneNames as [string, string, string, string],
    chain: chain as Vp4StructureBlob['chain'],
  };
}
