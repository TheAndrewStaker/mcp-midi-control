/**
 * AM4 0x01 SET_PARAM (write) and READ message builders.
 *
 * Message layout (after envelope F0 00 01 74 15 01):
 *   [hdr0_lo hdr0_hi] [hdr1_lo hdr1_hi] [hdr2_lo hdr2_hi]
 *   [hdr3_lo hdr3_hi] [hdr4_lo hdr4_hi]
 *   [packed_value_bytes...]
 *   [cs] F7
 *
 * Each header field is a 14-bit little-endian integer split into two 7-bit
 * septets. See docs/SYSEX-MAP.md §6a for field meanings.
 */

import { fractalChecksum } from '../shared/checksum.js';
import { encode14 } from '../shared/septet16.js';
import { packFloat32LE, packValue, packValueChunked, unpackValue, unpackValueChunked } from '../shared/packValue.js';
import { KNOWN_PARAMS, encode, type ParamKey } from './params.js';

export const AM4_MODEL_ID = 0x15;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const FUNC_PARAM_RW = 0x01;
const FUNC_GET_ALL_PARAMS = 0x1f;

const ACTION_WRITE = 0x0001;
const ACTION_SAVE_TO_LOCATION = 0x001b;
const ACTION_RENAME = 0x000c;
const ACTION_READ_PRESET_NAME = 0x0012;

// hardware-verified action codes from the AM4-Edit
// MESSAGE_* opcode table (see docs/devices/am4/am4edit-action-table.md).
const ACTION_SET_NORM = 0x0002;
const ACTION_INCR = 0x0003;
const ACTION_INCR_COARSE = 0x0004;
const ACTION_DECR = 0x0005;
const ACTION_DECR_COARSE = 0x0006;

const PRESET_NAME_BYTES = 32;
const RENAME_PID_LOW = 0x00ce;
const RENAME_PRESET_PID_HIGH = 0x000b;

const SCENE_SWITCH_PID_LOW = 0x00ce;
const SCENE_SWITCH_PID_HIGH = 0x000d;

const PRESET_SWITCH_PID_LOW = 0x00ce;
const PRESET_SWITCH_PID_HIGH = 0x000a;

const SCENE_RENAME_PID_LOW = 0x00ce;
const SCENE_RENAME_PID_HIGH_BASE = 0x0037;
const SCENE_NAME_BYTES = 32;

// `encode14` (2-byte LSB-first septet pair) comes from
// `fractal-midi/shared` (`shared/septet16.ts`), imported above.

/**
 * Re-export of the shared Fractal-protocol `ParamId` so existing AM4
 * call sites keep working. New code that doesn't otherwise depend on
 * AM4 should import directly from `@/fractal/shared/types.js`.
 */
import type { ParamId } from '../shared/types.js';
export type { ParamId };

/** Build a 0x01 WRITE message setting `param` to a 32-bit float `value`. */
export function buildSetFloatParam(param: ParamId, value: number): number[] {
  const valueBytes = Array.from(packFloat32LE(value));

  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(param.pidLow),
    ...encode14(param.pidHigh),
    ...encode14(ACTION_WRITE),
    ...encode14(0x0000),       // hdr3 reserved
    ...encode14(valueBytes.length - 1), // hdr4 = raw byte count (= 4 for float32)
    ...valueBytes,
  ];

  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  const cs = fractalChecksum(head);
  return [...head, cs, SYSEX_END];
}

/**
 * High-level write: look up `key` in the parameter registry, convert
 * `displayValue` to its internal float via the param's unit scale, and
 * build the SET_PARAM message.
 *
 * Example: `buildSetParam('amp.gain', 7.5)` → internal float 0.75.
 */
export function buildSetParam(key: ParamKey, displayValue: number): number[] {
  const param = KNOWN_PARAMS[key];
  return buildSetFloatParam(param, encode(param, displayValue));
}

/**
 * Build a NORMALIZED write (action 0x0002 = MESSAGE_SET_NORM).
 *
 * Unlike MESSAGE_SET (action 0x0001), this opcode takes a raw 0..1
 * normalized float directly — no display-to-internal conversion is
 * applied by either side. Useful when the caller already has a
 * normalized value (e.g., from an external controller, agent intent
 * like "70 percent gain", or a sliderwidget mapping).
 *
 * Hardware-verified  against AMP.GAIN on AM4 firmware
 * v2.00: writing 0.7 landed at internal float 0.7 (= display 7.0).
 * Wire shape identical to MESSAGE_SET except the action byte.
 *
 * @param param the target param (use `KNOWN_PARAMS[key]`)
 * @param normalized in [0, 1]. Out-of-range values throw.
 */
export function buildSetParamNorm(param: ParamId, normalized: number): number[] {
  if (normalized < 0 || normalized > 1) {
    throw new Error(`buildSetParamNorm: value out of [0, 1] range: ${normalized}`);
  }
  const valueBytes = Array.from(packFloat32LE(normalized));
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(param.pidLow),
    ...encode14(param.pidHigh),
    ...encode14(ACTION_SET_NORM),
    ...encode14(0x0000),
    ...encode14(valueBytes.length - 1),
    ...valueBytes,
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/**
 * Action code for MESSAGE_TOGGLE (0x0007).
 */
const ACTION_TOGGLE = 0x0007;

/**
 * Build a TOGGLE-BYPASS message that flips a block's bypass state
 * in-place. Maps to MESSAGE_TOGGLE (action 0x0007) targeting the
 * bypass register (pidHigh=0x0003).
 *
 * Hardware-verified  across 6 bypassable blocks (reverb,
 * delay, drive, chorus, flanger, phaser): each TOGGLE flipped the
 * block's bypass state cleanly, confirmed via long-form bypass read.
 *
 * NOTE: AM4's AMP slot doesn't have a bypass — on AMP, pidHigh=0x03
 * is the BOOST register. Use `buildSetBlockBypass` for explicit
 * bypass=true/false writes and reserve TOGGLE for the conversational
 * "flip the reverb on/off" UX.
 *
 * NOTE: bypass state lives at the WORKING-BUFFER level on the active
 * scene. Switch scene first if you want to toggle bypass on a
 * specific scene.
 *
 * @param blockPidLow the target block's own pidLow (use
 *   `BLOCK_TYPE_VALUES[block]`)
 */
export function buildToggleBlockBypass(blockPidLow: number): number[] {
  if (blockPidLow === 0) {
    throw new Error('buildToggleBlockBypass: empty slot value (0x0000) is not valid');
  }
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(blockPidLow),
    ...encode14(0x0003),         // bypass register pidHigh
    ...encode14(ACTION_TOGGLE),
    ...encode14(0x0000),         // hdr3 reserved
    ...encode14(0x0000),         // hdr4 = 0 (no payload)
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/**
 * Nudge granularity. "fine" steps the value by ~0.01 display units
 * (Q15 quantum = 66 u32 ticks); "coarse" steps by ~0.1 display
 * units (Q15 quantum = 655 ticks ≈ 10x fine, with Q15 rounding).
 */
export type NudgeGranularity = 'fine' | 'coarse';

/**
 * Nudge direction.
 */
export type NudgeDirection = 'incr' | 'decr';

/**
 * Build a NUDGE message: increment or decrement a continuous param
 * by one step. Maps to the AM4 MESSAGE_INCR / DECR / INCR_COARSE /
 * DECR_COARSE actions (wire bytes 0x03, 0x05, 0x04, 0x06).
 *
 * No payload — the device knows its own step quantum per param.
 * Hardware-verified  on AMP.GAIN:
 *   - fine  INCR/DECR = ±66 u32 ticks ≈ ±0.01 display units
 *   - coarse INCR/DECR = ±655 u32 ticks ≈ ±0.1 display units
 *
 * Useful for conversational "turn the gain up a touch" UX without
 * needing to compute the target value client-side.
 *
 * @param param target param descriptor
 * @param direction "incr" or "decr"
 * @param granularity "fine" or "coarse"
 */
export function buildNudgeParam(
  param: ParamId,
  direction: NudgeDirection,
  granularity: NudgeGranularity = 'fine',
): number[] {
  const action =
    direction === 'incr'
      ? granularity === 'coarse' ? ACTION_INCR_COARSE : ACTION_INCR
      : granularity === 'coarse' ? ACTION_DECR_COARSE : ACTION_DECR;
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(param.pidLow),
    ...encode14(param.pidHigh),
    ...encode14(action),
    ...encode14(0x0000),
    ...encode14(0x0000),  // hdr4 = 0; nudge has no payload
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/**
 * Predicate for `receiveSysExMatching` that accepts the AM4's wire-level
 * acknowledgement of a WRITE we just sent — a 64-byte frame carrying the
 * same pidLow/pidHigh, action `0x0001`, and `hdr4 = 0x0028` (40-byte
 * param descriptor).
 *
 * This matches the shape of the ack but does NOT tell apply from absorb.
 *  hardware testing proved the AM4 emits this same 64-byte ack
 * for writes to absent blocks (write had no audible effect) as well as
 * for writes to placed blocks (write landed). The 40-byte payload likely
 * contains a discriminator we haven't decoded — future work.
 *
 * A separate 23-byte frame byte-identical to our outgoing write also
 * appears on the input port (USB-MIDI receipt-echo or driver loopback);
 * the `hdr4 = 0x0028` check here filters that receipt-echo out so the
 * predicate matches the genuine device-originated ack.
 */
export function isWriteEcho(write: number[], response: number[]): boolean {
  // Header runs bytes 0..15 (envelope + func + 5 × 14-bit fields).
  if (response.length < 16) return false;
  // Envelope + function byte (bytes 0..5 of the write) must match exactly.
  for (let i = 0; i < 6; i++) if (response[i] !== write[i]) return false;
  // pidLow (bytes 6..7) and pidHigh (bytes 8..9) septets must match.
  for (let i = 6; i < 10; i++) if (response[i] !== write[i]) return false;
  // Action must be WRITE (0x0001) — 0x0026 is AM4-Edit's status poll.
  if (response[10] !== 0x01 || response[11] !== 0x00) return false;
  // hdr4 must be 0x0028 (40-byte param descriptor payload). A 0x0004 here
  // is our own write reflected back (loopback/receipt-echo), not an apply.
  if (response[14] !== 0x28 || response[15] !== 0x00) return false;
  return true;
}

/**
 * Predicate for `receiveSysExMatching` that accepts the AM4's "command ack"
 * — the 18-byte frame returned after successful addressing-only commands
 * (`save_to_location`, `set_preset_name`, `set_scene_name`). Shape
 * confirmed 2026-04-19 across both save and rename on hardware:
 *
 *   F0 00 01 74 15 01 <pidLow septets> <pidHigh septets>
 *                     <action septets> 00 00 00 00 <cksum> F7
 *
 * Addressing bytes (pidLow/pidHigh/action) echo the outgoing command
 * verbatim. hdr4 (bytes 12..13) is zero — no payload; the remaining two
 * bytes at 14..15 are also zero. This is a distinct shape from the
 * 64-byte SET_PARAM write-echo (hdr4 = 0x0028, 40-byte payload) and the
 * 23-byte USB-MIDI receipt-echo of our own bytes.
 *
 * Used by save/rename tools to report a clean "ack received" status
 * instead of dumping the raw frame to Claude for hex inspection.
 */
export function isCommandAck(write: number[], response: number[]): boolean {
  if (response.length !== 18) return false;
  if (response[0] !== SYSEX_START || response[17] !== SYSEX_END) return false;
  // Envelope + function byte (bytes 0..5) must match the outgoing write.
  for (let i = 0; i < 6; i++) if (response[i] !== write[i]) return false;
  // pidLow (6..7), pidHigh (8..9), action (10..11) echo the outgoing write.
  for (let i = 6; i < 12; i++) if (response[i] !== write[i]) return false;
  // hdr4 + trailing zero pad (12..15) all zero — 0-byte payload.
  for (let i = 12; i < 16; i++) if (response[i] !== 0x00) return false;
  return true;
}

/**
 * Block-placement register: pidLow that addresses the "which block occupies
 * slot N" state. The AM4 exposes 4 slots (positions 1..4 in the signal
 * chain) at pidHigh = 0x000F, 0x0010, 0x0011, 0x0012 respectively. Writing
 * a block's own pidLow as the float32 value places that block in the slot;
 * writing 0 clears the slot to "none" (empty). pidHigh = 0x0013 is NOT a
 * valid slot — the AM4 emits a structurally different ack and may produce
 * side effects on unrelated slots (observed  hardware test).
 *
 * Decoded  from  captures — see SYSEX-MAP.md §6c.
 */
export const BLOCK_SLOT_PID_LOW = 0x00ce;
export const BLOCK_SLOT_PID_HIGH_BASE = 0x000f;

/**
 * Build a WRITE that places `blockTypeValue` into slot `position` (1..4).
 * `blockTypeValue` is the target block's own pidLow (see `blockTypes.ts`);
 * pass 0 to clear the slot.
 *
 * Hardware-mapped : sending pidHigh 0x10/0x11/0x12 landed on
 * device slots 2/3/4, and pidHigh 0x13 produced an invalid-ack with
 * side effects on an unrelated slot — hence the base 0x000F so that
 * position 1..4 map to pidHigh 0x0F..0x12. Position 1 (pidHigh 0x000F)
 * isn't exercised by any capture on disk, but fits the linear pattern;
 * expected to land on device slot 1, pending independent hardware
 * confirmation after the base-address fix.
 */
export function buildSetBlockType(
  position: 1 | 2 | 3 | 4,
  blockTypeValue: number,
): number[] {
  if (position < 1 || position > 4 || !Number.isInteger(position)) {
    throw new Error(`Block position must be an integer 1..4, got ${position}`);
  }
  return buildSetFloatParam(
    {
      pidLow: BLOCK_SLOT_PID_LOW,
      pidHigh: BLOCK_SLOT_PID_HIGH_BASE + (position - 1),
    },
    blockTypeValue,
  );
}

/**
 * Build a SAVE-TO-LOCATION command that persists the AM4's current working
 * buffer to preset location `locationIndex` (0..103, A01..Z04). The command
 * uses the PARAM_RW function (0x01) with a fresh action byte — 0x001B —
 * which appears only in save captures. pidLow/pidHigh are both 0x0000
 * (not a block/param address; the "target" is the location itself,
 * carried in the payload).
 *
 * Payload = 4-byte uint32 LE location index (Z04 = 103 = 0x67 →
 * `67 00 00 00` raw, `33 40 00 00 00` after the 8-to-7 septet pack).
 *
 * Decoded  from `session-18-save-preset-z04.pcapng`. Byte-exact
 * golden lives in `verify-msg`.
 *
 * WRITE SAFETY: overwrites the target location. Only Z04 is designated
 * scratch during RE — callers are responsible for gating this.
 */
export function buildSaveToLocation(locationIndex: number): number[] {
  if (!Number.isInteger(locationIndex) || locationIndex < 0 || locationIndex > 103) {
    throw new Error(`Preset location index must be integer 0..103, got ${locationIndex}.`);
  }
  const raw = new Uint8Array(4);
  new DataView(raw.buffer).setUint32(0, locationIndex, true);
  const packed = Array.from(packValue(raw));
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(0x0000),                   // pidLow = 0 (no block/param — save is a global action)
    ...encode14(0x0000),                   // pidHigh = 0
    ...encode14(ACTION_SAVE_TO_LOCATION),  // action = 0x001B
    ...encode14(0x0000),                   // hdr3
    ...encode14(raw.length),               // hdr4 = 4 (raw byte count, pre-pack)
    ...packed,
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/**
 * Build a RENAME-PRESET command that sets the name of the preset stored
 * at preset location `locationIndex`. Shares the block-slot register
 * (pidLow=0x00CE) but with pidHigh=0x000B and a new action byte
 * (0x000C).
 *
 * Payload is 36 raw bytes:
 *   [0..3]   uint32 LE preset location index (same encoding as
 *            save-to-location)
 *   [4..35]  32-byte ASCII name, space-padded. Names longer than 32
 *            chars throw; shorter names are space-padded to 32.
 *
 * Decoded  from `session-20-rename-preset.pcapng` — see
 * SYSEX-MAP §6e. Byte-exact golden in `verify-msg`.
 *
 * WRITE SAFETY: like save-to-location, this writes to a specific preset
 * location and can clobber user presets. Callers should gate to Z04
 * during RE.
 */
export function buildSetPresetName(locationIndex: number, name: string): number[] {
  if (!Number.isInteger(locationIndex) || locationIndex < 0 || locationIndex > 103) {
    throw new Error(`Preset location index must be integer 0..103, got ${locationIndex}.`);
  }
  if (name.length > PRESET_NAME_BYTES) {
    throw new Error(`Preset name must be ≤ ${PRESET_NAME_BYTES} ASCII chars, got ${name.length}: "${name}".`);
  }
  // ASCII-only guard — the AM4 displays a limited character set; being
  // strict here surfaces problems early instead of writing unrenderable
  // codepoints to the device.
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      throw new Error(`Preset name contains non-ASCII-printable char 0x${c.toString(16)} at position ${i}: "${name}".`);
    }
  }
  const raw = new Uint8Array(4 + PRESET_NAME_BYTES);
  new DataView(raw.buffer).setUint32(0, locationIndex, true);
  // AM4 names are space-padded (0x20), not null-padded. Confirmed by
  // decoding session-20-rename-preset (raw bytes 4+N..35 were all 0x20
  // after the "boston" prefix).
  for (let i = 0; i < PRESET_NAME_BYTES; i++) {
    raw[4 + i] = i < name.length ? name.charCodeAt(i) : 0x20;
  }
  // 36-byte payloads need chunked (7-at-a-time) packing — see packValue.ts
  // comment. Single-chunk packing only works up to 7 raw bytes.
  const packed = Array.from(packValueChunked(raw));
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(RENAME_PID_LOW),
    ...encode14(RENAME_PRESET_PID_HIGH),
    ...encode14(ACTION_RENAME),
    ...encode14(0x0000),                // hdr3
    ...encode14(raw.length),            // hdr4 = 36 (raw byte count, pre-pack)
    ...packed,
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/**
 * Build a SWITCH-SCENE command that sets the AM4's active scene to
 * `sceneIndex` (0..3, corresponding to scenes 1..4 in the UI). Same
 * preset-level register family as block placement and preset rename
 * (pidLow=0x00CE), with pidHigh=0x000D and a standard WRITE action.
 * Payload = 4-byte uint32 LE scene index — NOT a float32, to match
 * the integer semantics of save-to-slot.
 *
 * Decoded  from `session-21-switch-scene-1-3-4.pcapng`
 * (combined with `session-18-switch-scene.pcapng`). All four scene
 * indices confirmed: 0→scene 1, 1→scene 2, 2→scene 3, 3→scene 4.
 * pidHigh stays fixed at 0x000D; only the u32 value changes. Byte-
 * exact goldens for all four scenes live in `verify-msg`.
 */
export function buildSwitchScene(sceneIndex: number): number[] {
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex > 3) {
    throw new Error(`Scene index must be integer 0..3, got ${sceneIndex}.`);
  }
  const raw = new Uint8Array(4);
  new DataView(raw.buffer).setUint32(0, sceneIndex, true);
  const packed = Array.from(packValue(raw));
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(SCENE_SWITCH_PID_LOW),
    ...encode14(SCENE_SWITCH_PID_HIGH),
    ...encode14(ACTION_WRITE),
    ...encode14(0x0000),
    ...encode14(raw.length),
    ...packed,
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/**
 * Per-block bypass register: pidHigh = 0x0003 on the block's own pidLow
 * (amp = 0x003A, drive = 0x0076, reverb = 0x0042, etc.). Value is a
 * float32: 1.0 = bypassed (silent), 0.0 = active.
 *
 * Scene-scoping is implicit. The AM4 is stateful — bypass writes land on
 * whichever scene is active right now. To change scene N's bypass for a
 * block, the caller switches scene first (via `buildSwitchScene(n)`),
 * then emits this write. Same stateful-scoping rule that applies to
 * channel switches and SET_PARAM writes (see  / ).
 *
 * Decoded  from four session-23 captures: amp/drive/reverb
 * bypass-on (float 1.0) and amp bypass-off (float 0.0). Byte-exact
 * goldens in `verify-msg`.
 */
const BLOCK_BYPASS_PID_HIGH = 0x0003;

/**
 * Build a SET-BYPASS command that silences (`bypassed=true`) or activates
 * (`bypassed=false`) the block whose pidLow is `blockPidLow` on the
 * AM4's currently-active scene. `blockPidLow` is the block's own pidLow
 * (see `BLOCK_TYPE_VALUES` in `blockTypes.ts`) — NOT a slot number.
 * `0x0000` (the "none" value) is rejected since bypass has no meaning
 * on an empty slot.
 *
 * Callers targeting a specific scene are responsible for issuing
 * `buildSwitchScene(sceneIndex)` first; this function writes the block-
 * level bypass register and inherits whichever scene the device is on.
 */
export function buildSetBlockBypass(blockPidLow: number, bypassed: boolean): number[] {
  if (!Number.isInteger(blockPidLow) || blockPidLow <= 0 || blockPidLow > 0x3fff) {
    throw new Error(`Block pidLow must be a positive 14-bit integer, got ${blockPidLow}.`);
  }
  return buildSetFloatParam(
    { pidLow: blockPidLow, pidHigh: BLOCK_BYPASS_PID_HIGH },
    bypassed ? 1.0 : 0.0,
  );
}

/**
 * Build a SWITCH-PRESET command that loads preset location
 * `locationIndex` (0..103, A01..Z04) into the AM4's working buffer.
 * Same register family as the other preset-level commands
 * (pidLow=0x00CE) with pidHigh=0x000A and a standard WRITE action.
 *
 * Value encoding: **float32** (IEEE 754 LE) representing the location
 * index — e.g. index 1 → float 1.0 → raw bytes `00 00 80 3f`. This is
 * DIFFERENT from scene-switch (u32 LE) and save-to-slot (u32 LE); both
 * encodings coexist in the same register. Decoded  from
 * `session-22-switch-preset-via-ui.pcapng`, which captured the user
 * clicking A01 → A02 → A01 in AM4-Edit. Two unique writes: float 1.0
 * (A02) and float 0.0 (A01). Byte-exact goldens in `verify-msg`.
 *
 * UX note: this is "load this preset into the working buffer", not
 * "save to this location." Calling this on an unsaved working buffer
 * discards edits — upstream MCP tool should confirm before issuing.
 */
export function buildSwitchPreset(locationIndex: number): number[] {
  if (!Number.isInteger(locationIndex) || locationIndex < 0 || locationIndex > 103) {
    throw new Error(`Preset location index must be integer 0..103, got ${locationIndex}.`);
  }
  return buildSetFloatParam(
    { pidLow: PRESET_SWITCH_PID_LOW, pidHigh: PRESET_SWITCH_PID_HIGH },
    locationIndex,
  );
}

/**
 * Build a RENAME-SCENE command that sets the name of scene `sceneIndex`
 * (0..3) in the current working buffer. Same envelope / action / payload
 * structure as `buildSetPresetName`, with two differences:
 *   - pidHigh varies per scene: `0x0037 + sceneIndex` (scenes 1..4 →
 *     0x0037 / 0x0038 / 0x0039 / 0x003A).
 *   - The 4-byte slot-index field at the head of the payload is zeroed
 *     — scene names are scoped to the working buffer, not a preset
 *     location.
 *
 * Decoded  from `session-20-rename-scene.pcapng` (scene 1)
 * plus `session-22-rename-scene-{2,3,4}.pcapng` (scenes 2/3/4).
 * Byte-exact goldens in `verify-msg` for scenes 2/3/4 with names
 * "clean" / "chorus" / "lead"; scene 1 was the initial Session 19g
 * capture confirming pidHigh=0x0037.
 *
 * Scope caveat: writes to the working buffer only. To persist scene
 * names to a preset location, callers must still issue a
 * `buildSaveToLocation` afterward.
 */
export function buildSetSceneName(sceneIndex: number, name: string): number[] {
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex > 3) {
    throw new Error(`Scene index must be integer 0..3, got ${sceneIndex}.`);
  }
  if (name.length > SCENE_NAME_BYTES) {
    throw new Error(`Scene name must be ≤ ${SCENE_NAME_BYTES} ASCII chars, got ${name.length}: "${name}".`);
  }
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      throw new Error(`Scene name contains non-ASCII-printable char 0x${c.toString(16)} at position ${i}: "${name}".`);
    }
  }
  const raw = new Uint8Array(4 + SCENE_NAME_BYTES);
  // Bytes 0..3 stay zero (working-buffer scope, no slot index).
  for (let i = 0; i < SCENE_NAME_BYTES; i++) {
    raw[4 + i] = i < name.length ? name.charCodeAt(i) : 0x20;
  }
  const packed = Array.from(packValueChunked(raw));
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(SCENE_RENAME_PID_LOW),
    ...encode14(SCENE_RENAME_PID_HIGH_BASE + sceneIndex),
    ...encode14(ACTION_RENAME),
    ...encode14(0x0000),
    ...encode14(raw.length),
    ...packed,
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/**
 * Function byte for the request-active-buffer-dump command. Distinct from
 * the 0x01 PARAM_RW family; the device replies with a 6-message
 * 0x77 / 0x78 / 0x79 stream (see `presetDump.ts` for the response decoder).
 */
const FUNC_REQUEST_DUMP = 0x03;

/**
 * Active-buffer sentinel byte. Same convention as the 0x77 response header's
 * bank field: `0x7F` means "the working buffer", not a stored bank/sub pair.
 */
const ACTIVE_BUFFER_SENTINEL = 0x7f;

/**
 * Build a REQUEST_ACTIVE_BUFFER_DUMP message that asks the AM4 to emit its
 * current working buffer as a 6-message preset-dump stream
 * (0x77 header + 4x 0x78 chunks + 0x79 footer, 12,352 bytes total).
 *
 * Wire shape (decoded  /  byte-exact from
 * `samples/captured/session-51-export-preset.tshark.txt`; AM4-Edit's
 * File -> Export Preset action against the working buffer):
 *
 *   F0 00 01 74 15 03 7F 7F 00 [cs] F7        (11 bytes total)
 *
 * - **function** `0x03` (NEW — distinct from the 0x01 PARAM_RW family;
 *   shares wire space with the dump response stream's reply functions
 *   0x77 / 0x78 / 0x79).
 * - **payload** `7F 7F 00`: byte 0 = active-buffer sentinel, byte 1 = same
 *   sentinel (the response header carries `bank=0x7F sub=0x00` for an
 *   active-buffer dump; the request mirrors the bank sentinel into both
 *   addressing slots), byte 2 = constant `0x00`.
 * - **checksum** XOR of all preceding bytes (computed via
 *   `fractalChecksum`, NOT hardcoded) — 0x13 in the captured frame.
 *
 * Non-destructive: no working-buffer mutation, no audible side effect, no
 * change to the active stored location pointer. The device responds with
 * the same byte stream `parsePresetBank` consumes, except the 0x77 header
 * carries `bank=0x7F` (active sentinel) instead of a stored bank/sub pair.
 *
 * STORED-PRESET variant: `buildRequestStoredPresetDump` below
 * (H1 encoding hardware-confirmed 2026-06-10).
 */
export function buildRequestActiveBufferDump(): number[] {
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_REQUEST_DUMP,
    ACTIVE_BUFFER_SENTINEL,
    ACTIVE_BUFFER_SENTINEL,
    0x00,
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/**
 * Build a fn=0x03 dump request for a STORED preset location. H1
 * encoding from preset-dump-request-research.md: payload
 * `[bank, sub, 0x00]` with bank = locationIndex >> 2 (A=0..Z=25) and
 * sub = locationIndex & 3 (display 01..04 -> wire 0..3).
 *
 * Status: hardware-confirmed on the founder's AM4 (2026-06-10 live
 * probe): A01 `00 00 00`, A02 `00 01 00`, and Z04 `19 03 00` each
 * returned the canonical 6-frame / 12,352-byte dump stream whose 0x77
 * header echoes the requested [bank, sub] byte-exactly. NO working-
 * buffer side effect: a before/after active-buffer compare changed
 * only the dump's known volatile bytes (same drift as two back-to-back
 * active dumps with nothing in between), and the post-request buffer
 * did not match the requested slot's content — i.e. unlike the
 * Axe-Fx II's slot-addressed fn 0x03, this does NOT reload the buffer.
 * Captures: samples/captured/hw132/am4-stored-{a01,a02-h1,z04}.syx.
 */
export function buildRequestStoredPresetDump(locationIndex: number): number[] {
  if (!Number.isInteger(locationIndex) || locationIndex < 0 || locationIndex > 103) {
    throw new Error(`buildRequestStoredPresetDump: location index out of range (0..103 = A01..Z04): ${locationIndex}`);
  }
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_REQUEST_DUMP,
    (locationIndex >> 2) & 0x7f,
    locationIndex & 0x03,
    0x00,
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/**
 * Build a 0x1F GET_ALL_PARAMS request for a single effectId.
 *
 * Hardware-verified 2026-05-22 (HW-AM4-FN1F probe). The device replies
 * with a three-frame state-broadcast triple:
 *
 *   F0 00 01 74 15 74 <eid_lo> <eid_hi> <size_lo> <size_hi> <cs> F7
 *   F0 00 01 74 15 75 <size_lo> <size_hi> <N × 3-byte packed septets> <cs> F7
 *   F0 00 01 74 15 76 <cs> F7
 *
 * `size` is septet-14-bit `itemCount` (the number of 16-bit ushorts in
 * the chunk payload); each ushort decodes via the same 3-byte packed-
 * septet shape as Axe-Fx II (`decode16Packed`). See
 * `docs/devices/am4/SYSEX-MAP.md` §6oa and primitive
 * `am4-fn1f-atomic-read` for the full contract.
 *
 * effectId 0 NACKs with multipurpose-response result_code 0x06 — the
 * device requires a valid effectId. The chunk-position-to-paramId
 * mapping is **not yet decoded**; this helper exposes the wire
 * primitive only. Callers should treat the decoded ushort array as
 * opaque until the mapping ships.
 */
export function buildGetAllParams(effectId: number): number[] {
  if (effectId < 0 || effectId > 0x3fff) {
    throw new Error(`effectId out of range [0..16383]: ${effectId}`);
  }
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_GET_ALL_PARAMS,
    ...encode14(effectId),
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/**
 * Build a 0x01 READ request for `param`. `readType` selects the response
 * shape — see docs/SYSEX-MAP.md §6a (use 0x0E for short parameter reads).
 */
export function buildReadParam(param: ParamId, readType = 0x0e): number[] {
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(param.pidLow),
    ...encode14(param.pidHigh),
    ...encode14(readType),
    ...encode14(0x0000),
    ...encode14(0x0000), // hdr4 = 0 (no payload on a read)
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  const cs = fractalChecksum(head);
  return [...head, cs, SYSEX_END];
}

const READ_TYPE_SHORT = 0x0e;
const READ_RESPONSE_PAYLOAD_RAW_BYTES = 4;

/**
 * Long-form param-descriptor read action. Empirically pinned 
 * from `samples/captured/session-46-front-panel-dly-rev-bypass.pcapng`:
 * AM4-Edit polls bypass state with `action=0x0d`, getting a 64-byte
 * response with `hdr4=0x0028` (40 raw payload bytes). The short read
 * (`action=0x0e`, hdr4=4) returns a static value that doesn't track
 * bypass writes; the long read tracks live state. Wire byte 22 of the
 * long response is the bypass flag (1=bypassed, 0=active) — confirmed
 * across 8 (block × scene) cases on hardware.
 */
export const READ_TYPE_LONG = 0x0d;
const LONG_READ_RESPONSE_TOTAL_BYTES = 64;
const LONG_READ_RESPONSE_HDR4 = 0x0028;
/** Wire-byte offset of the bypass flag in a long-read response. */
export const LONG_READ_BYPASS_FLAG_BYTE = 22;

/**
 * Denominator the AM4 uses to encode internal floats into the u32 read-
 * response field. **Empirically pinned at 65534 (= 0xFFFE = 2¹⁶ - 2)
 * by +** across 4 byte-exact
 * data points:
 *
 *   display | u32   | predicted u32 = round(internal × 65534)
 *   --------|-------|------------------------------------------
 *   3.00    | 19660 | 19660 ✓
 *   5.00    | 32767 | 32767 ✓
 *   6.00    | 39320 | 39320 ✓ (mid + treble, two captures)
 *
 * /65536 was eliminated by bass=5.00 (predicted 32768, observed 32767).
 * /65535 was eliminated by mid/treble=6.00 (predicted 39321, observed
 * 39320). Only /65534 with round-to-nearest fits all four samples.
 *
 * Why 65534 rather than the cleaner 65535 or 65536 is unconfirmed but
 * plausibly because the AM4 stores values internally in signed Q15
 * fixed-point (range -32767..+32767, with -32768 reserved as a sentinel)
 * and the read response shifts the magnitude left by 1 to fill a 16-bit
 * unsigned span. We didn't reverse-engineer the firmware past the
 * empirical match — the wire goldens in `verify-msg` are the ground truth.
 */
export const READ_VALUE_DENOMINATOR = 65534;

/**
 * Predicate for `receiveSysExMatching` that accepts the AM4's response
 * to a 0x01 READ we just sent. Shape decoded — see
 * SYSEX-MAP.md §6a:
 *
 *   F0 00 01 74 15 01 <pidLow septets> <pidHigh septets>
 *                     <readType septets> 00 00 04 00 <5 packed bytes> <cs> F7
 *
 * The response is byte-identical to the outgoing request through the
 * readType field, then `hdr4 = 0x0004` (4-byte payload follows) and 5
 * packed-septet bytes encoding those 4 bytes via the same `packValue`
 * scheme writes use. Distinct from `isWriteEcho` (hdr4 = 0x0028,
 * 64-byte ack) and `isCommandAck` (hdr4 = 0x0000, 18-byte ack).
 */
export function isReadResponse(read: number[], response: number[]): boolean {
  if (response.length !== 23) return false;
  if (response[0] !== SYSEX_START || response[22] !== SYSEX_END) return false;
  // Envelope + function byte (bytes 0..5) must match the outgoing read.
  for (let i = 0; i < 6; i++) if (response[i] !== read[i]) return false;
  // pidLow (6..7), pidHigh (8..9), readType (10..11) echo the outgoing read.
  for (let i = 6; i < 12; i++) if (response[i] !== read[i]) return false;
  // hdr3 (12..13) zero, hdr4 (14..15) = 0x0004 (4-byte payload follows).
  if (response[12] !== 0x00 || response[13] !== 0x00) return false;
  if (response[14] !== 0x04 || response[15] !== 0x00) return false;
  return true;
}

/**
 * Predicate for the long-form (action=0x0d) READ response. Same envelope
 * + echoed-fields shape as `isReadResponse`, but with `hdr4=0x0028` and
 * a 64-byte total length. Used by `am4_get_block_bypass` to read the
 * live bypass register ( / ).
 */
export function isReadResponseLong(read: number[], response: number[]): boolean {
  if (response.length !== LONG_READ_RESPONSE_TOTAL_BYTES) return false;
  if (response[0] !== SYSEX_START || response[response.length - 1] !== SYSEX_END) return false;
  for (let i = 0; i < 6; i++) if (response[i] !== read[i]) return false;
  for (let i = 6; i < 12; i++) if (response[i] !== read[i]) return false;
  if (response[12] !== 0x00 || response[13] !== 0x00) return false;
  if (response[14] !== (LONG_READ_RESPONSE_HDR4 & 0x7f)) return false;
  if (response[15] !== ((LONG_READ_RESPONSE_HDR4 >> 7) & 0x7f)) return false;
  return true;
}

/**
 * Extract the bypass flag from a long-form READ response (action=0x0d).
 * Returns true if the block is currently bypassed, false if active.
 *
 * Validates the envelope, echoed fields, and checksum. Throws on any
 * mismatch — pair with `isReadResponseLong` as the matcher predicate
 * before calling.
 */
export function parseLongReadBypassFlag(bytes: number[]): boolean {
  if (bytes.length !== LONG_READ_RESPONSE_TOTAL_BYTES) {
    throw new Error(`Long read response must be ${LONG_READ_RESPONSE_TOTAL_BYTES} bytes, got ${bytes.length}.`);
  }
  if (bytes[0] !== SYSEX_START || bytes[LONG_READ_RESPONSE_TOTAL_BYTES - 1] !== SYSEX_END) {
    throw new Error('Long read response missing F0/F7 envelope.');
  }
  for (let i = 0; i < FRACTAL_MFR.length; i++) {
    if (bytes[1 + i] !== FRACTAL_MFR[i]) {
      throw new Error('Long read response Fractal manufacturer ID mismatch.');
    }
  }
  if (bytes[4] !== AM4_MODEL_ID) {
    throw new Error(`Long read response device ID 0x${bytes[4].toString(16)} != AM4 (0x15).`);
  }
  if (bytes[5] !== FUNC_PARAM_RW) {
    throw new Error(`Long read response function byte 0x${bytes[5].toString(16)} != 0x01.`);
  }
  const csIdx = LONG_READ_RESPONSE_TOTAL_BYTES - 2;
  const expectedCs = fractalChecksum(bytes.slice(0, csIdx));
  if (bytes[csIdx] !== expectedCs) {
    throw new Error(`Long read response checksum mismatch: got 0x${bytes[csIdx].toString(16)}, expected 0x${expectedCs.toString(16)}.`);
  }
  return bytes[LONG_READ_BYPASS_FLAG_BYTE] === 0x01;
}

/** Result of parsing a 0x01 READ response. See `parseReadResponse`. */
export interface ReadResponse {
  pidLow: number;
  pidHigh: number;
  /** The unpacked 4 raw payload bytes — the firmware's u32 LE word. */
  rawValue: Uint8Array;
  /** Convenience: `rawValue` interpreted as little-endian uint32. */
  asUInt32LE(): number;
  /**
   * Convenience: interpret the u32 as a Q16 fixed-point internal float
   * (`u32 / 65536`). Use for knob / dB / hz / ms / % style continuous
   * params; pass through `decode(param, internal)` to get a display value.
   * For type-enum / block-placement registers, use `asUInt32LE()` instead
   * — those store the wire enum index directly, not Q16-scaled.
   */
  asInternalFloat(): number;
}

/**
 * Parse a 0x01 READ response into its pidLow, pidHigh, and 4 raw payload
 * bytes. Validates the envelope (F0 / mfr / device id / function / F7),
 * checksum, action = readType (0x0E), and hdr4 = 0x0004. Throws on any
 * mismatch — callers should check `isReadResponse` first when matching
 * against a specific outgoing read, or feed validated bytes here.
 *
 * The 5-byte packed payload is unpacked via the same `unpackValue` scheme
 * as writes. The resulting 4 raw bytes are returned for the caller to
 * interpret per param type — see SYSEX-MAP.md §6a's "Decode rule" note.
 *
 * Decoded from `samples/captured/session-42-readprobe.pcapng`.
 */
export function parseReadResponse(bytes: number[]): ReadResponse {
  if (bytes.length !== 23) {
    throw new Error(`Read response must be 23 bytes, got ${bytes.length}.`);
  }
  if (bytes[0] !== SYSEX_START || bytes[22] !== SYSEX_END) {
    throw new Error('Read response missing F0/F7 envelope.');
  }
  for (let i = 0; i < FRACTAL_MFR.length; i++) {
    if (bytes[1 + i] !== FRACTAL_MFR[i]) {
      throw new Error('Read response Fractal manufacturer ID mismatch.');
    }
  }
  if (bytes[4] !== AM4_MODEL_ID) {
    throw new Error(`Read response device ID 0x${bytes[4].toString(16)} != AM4 (0x15).`);
  }
  if (bytes[5] !== FUNC_PARAM_RW) {
    throw new Error(`Read response function byte 0x${bytes[5].toString(16)} != 0x01.`);
  }
  const expectedCs = fractalChecksum(bytes.slice(0, 21));
  if (bytes[21] !== expectedCs) {
    throw new Error(`Read response checksum mismatch: got 0x${bytes[21].toString(16)}, expected 0x${expectedCs.toString(16)}.`);
  }
  const pidLow = bytes[6] | (bytes[7] << 7);
  const pidHigh = bytes[8] | (bytes[9] << 7);
  const action = bytes[10] | (bytes[11] << 7);
  if (action !== READ_TYPE_SHORT) {
    throw new Error(`Read response action 0x${action.toString(16).padStart(4, '0')} != 0x000E (short read).`);
  }
  const hdr4 = bytes[14] | (bytes[15] << 7);
  if (hdr4 !== READ_RESPONSE_PAYLOAD_RAW_BYTES) {
    throw new Error(`Read response hdr4 0x${hdr4.toString(16).padStart(4, '0')} != 0x0004.`);
  }
  const wire = new Uint8Array(bytes.slice(16, 21));
  const rawValue = unpackValue(wire, READ_RESPONSE_PAYLOAD_RAW_BYTES);
  return {
    pidLow,
    pidHigh,
    rawValue,
    asUInt32LE(): number {
      return new DataView(rawValue.buffer, rawValue.byteOffset, 4).getUint32(0, true);
    },
    asInternalFloat(): number {
      return this.asUInt32LE() / READ_VALUE_DENOMINATOR;
    },
  };
}

/**
 * Sentinel string the AM4 returns in the 32-byte name buffer when a preset
 * location is empty. C-string, NUL-terminated within the buffer (the
 * trailing bytes after the NUL are uninitialised — typically 0x20 spaces
 * with a final 0x00). `parseGetPresetNameResponse` cuts the buffer at the
 * first NUL before comparing.
 */
export const PRESET_NAME_EMPTY_SENTINEL = '<EMPTY>';

const READ_PRESET_NAME_RESPONSE_TOTAL_BYTES = 55;
const READ_PRESET_NAME_RESPONSE_HDR4 = PRESET_NAME_BYTES; // 32 raw payload bytes
// 32 raw = 4 full 7-byte chunks + 1 partial 4-byte chunk → 4*8 + 5 = 37 packed wire bytes.
const READ_PRESET_NAME_RESPONSE_PACKED_BYTES = 37;

/**
 * Build a READ_PRESET_NAME request that reads the stored preset name at
 * preset location `locationIndex` (0..103, A01..Z04) WITHOUT loading the
 * preset into the working buffer.
 *
 * Wire shape (decoded  /  from
 * `samples/captured/session-46-am4edit-launch-device-connected.midi-events.txt`):
 *
 *   F0 00 01 74 15 01 [4E 01] [0B 00] [12 00] [00 00] [04 00]
 *                     [5 packed bytes — u32 LE location index] <cs> F7
 *
 * - **function** `0x01` (PARAM_RW)
 * - **pidLow** `0x00CE`, **pidHigh** `0x000B` — same register family as
 *   the rename WRITE (action `0x000C`); this is its read-direction sibling.
 * - **action** `0x0012` — READ_PRESET_NAME (new with this decode).
 * - **hdr4** `0x0004` — 4 raw payload bytes follow.
 * - **payload** — uint32 LE location index (0..103), sliding-window packed
 *   to 5 wire septets via `packValue` (§6b).
 *
 * Total wire size: 23 bytes. Non-destructive: working-buffer state is
 * preserved. AM4-Edit's "Refresh Preset Names" UI button issues this
 * exact command in a 104-iteration loop (~350 ms for a full sweep).
 *
 * Byte-exact goldens for locations 0, 1, 103 in `verify-msg`.
 */
export function buildGetPresetName(locationIndex: number): number[] {
  if (!Number.isInteger(locationIndex) || locationIndex < 0 || locationIndex > 103) {
    throw new Error(`Preset location index must be integer 0..103, got ${locationIndex}.`);
  }
  const raw = new Uint8Array(4);
  new DataView(raw.buffer).setUint32(0, locationIndex, true);
  const packed = Array.from(packValue(raw));
  const body: number[] = [
    AM4_MODEL_ID,
    FUNC_PARAM_RW,
    ...encode14(RENAME_PID_LOW),                // 0x00CE — shared with rename
    ...encode14(RENAME_PRESET_PID_HIGH),        // 0x000B — shared with rename
    ...encode14(ACTION_READ_PRESET_NAME),       // 0x0012 — read variant
    ...encode14(0x0000),                        // hdr3 reserved
    ...encode14(raw.length),                    // hdr4 = 4 (raw byte count)
    ...packed,
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/** Result of parsing a READ_PRESET_NAME response. See `parseGetPresetNameResponse`. */
export interface GetPresetNameResponse {
  /**
   * The preset location the response is for. The wire response does NOT
   * carry the location — AM4-Edit correlates request-with-response by
   * arrival order. Callers pass `expectedLocation` in so the parsed result
   * is self-describing for downstream tooling.
   */
  location: number;
  /**
   * The decoded preset name with trailing space-padding stripped.
   * For empty locations this is the literal string `<EMPTY>`.
   */
  name: string;
  /** True iff `name === '<EMPTY>'` — convenience flag for callers. */
  isEmpty: boolean;
}

/**
 * Parse a READ_PRESET_NAME response (action `0x0012`) into its name.
 *
 * Wire shape (56 bytes total):
 *
 *   F0 00 01 74 15 01 [4E 01] [0B 00] [12 00] [00 00] [20 00]
 *                     [37 packed bytes — 32 ASCII chars] <cs> F7
 *
 * The 32 raw bytes decode to a C-style ASCII name padded with 0x20
 * (spaces) and terminated by 0x00 within the 32-byte buffer. Empty
 * locations return the literal string `<EMPTY>` followed by 0x00 then
 * uninitialised buffer bytes.
 *
 * Validates envelope (F0/F7), Fractal manufacturer ID, AM4 model byte
 * (`0x15`), function byte (`0x01`), action (`0x0012`), hdr4 (`0x0020`),
 * and the XOR checksum. Throws clear errors on any mismatch with the
 * specific field that didn't match.
 *
 * Decoded  /  from
 * `samples/captured/session-46-am4edit-launch-device-connected.midi-events.txt`.
 * Byte-exact goldens for one populated location (A01 → "AM4 Gig Rig")
 * and one empty location (X02 → `<EMPTY>`) in `verify-msg`.
 */
export function parseGetPresetNameResponse(
  bytes: number[] | Uint8Array,
  expectedLocation: number,
): GetPresetNameResponse {
  const arr = Array.isArray(bytes) ? bytes : Array.from(bytes);
  if (!Number.isInteger(expectedLocation) || expectedLocation < 0 || expectedLocation > 103) {
    throw new Error(`Expected location must be integer 0..103, got ${expectedLocation}.`);
  }
  if (arr.length !== READ_PRESET_NAME_RESPONSE_TOTAL_BYTES) {
    throw new Error(
      `READ_PRESET_NAME response must be ${READ_PRESET_NAME_RESPONSE_TOTAL_BYTES} bytes, got ${arr.length}.`,
    );
  }
  if (arr[0] !== SYSEX_START || arr[arr.length - 1] !== SYSEX_END) {
    throw new Error('READ_PRESET_NAME response missing F0/F7 envelope.');
  }
  for (let i = 0; i < FRACTAL_MFR.length; i++) {
    if (arr[1 + i] !== FRACTAL_MFR[i]) {
      throw new Error('READ_PRESET_NAME response Fractal manufacturer ID mismatch.');
    }
  }
  if (arr[4] !== AM4_MODEL_ID) {
    throw new Error(`READ_PRESET_NAME response device ID 0x${arr[4].toString(16)} != AM4 (0x15).`);
  }
  if (arr[5] !== FUNC_PARAM_RW) {
    throw new Error(`READ_PRESET_NAME response function byte 0x${arr[5].toString(16)} != 0x01.`);
  }
  const pidLow = arr[6] | (arr[7] << 7);
  const pidHigh = arr[8] | (arr[9] << 7);
  const action = arr[10] | (arr[11] << 7);
  if (pidLow !== RENAME_PID_LOW) {
    throw new Error(
      `READ_PRESET_NAME response pidLow 0x${pidLow.toString(16).padStart(4, '0')} != 0x00CE.`,
    );
  }
  if (pidHigh !== RENAME_PRESET_PID_HIGH) {
    throw new Error(
      `READ_PRESET_NAME response pidHigh 0x${pidHigh.toString(16).padStart(4, '0')} != 0x000B.`,
    );
  }
  if (action !== ACTION_READ_PRESET_NAME) {
    throw new Error(
      `READ_PRESET_NAME response action 0x${action.toString(16).padStart(4, '0')} != 0x0012.`,
    );
  }
  const hdr4 = arr[14] | (arr[15] << 7);
  if (hdr4 !== READ_PRESET_NAME_RESPONSE_HDR4) {
    throw new Error(
      `READ_PRESET_NAME response hdr4 0x${hdr4.toString(16).padStart(4, '0')} != 0x0020 (32 raw bytes).`,
    );
  }
  const csIdx = arr.length - 2;
  const expectedCs = fractalChecksum(arr.slice(0, csIdx));
  if (arr[csIdx] !== expectedCs) {
    throw new Error(
      `READ_PRESET_NAME response checksum mismatch: got 0x${arr[csIdx].toString(16)}, expected 0x${expectedCs.toString(16)}.`,
    );
  }
  const packed = new Uint8Array(arr.slice(16, 16 + READ_PRESET_NAME_RESPONSE_PACKED_BYTES));
  const raw = unpackValueChunked(packed, PRESET_NAME_BYTES);
  // C-string semantics: cut at first NUL terminator inside the 32-byte
  // buffer, then strip trailing 0x20 padding. Empirically the AM4 NUL-
  // terminates within the 32-byte buffer; bytes after the NUL are
  // uninitialised (often 0x20 with a trailing 0x00).
  const ascii = String.fromCharCode(...Array.from(raw));
  const nulIdx = ascii.indexOf('\0');
  const name = (nulIdx >= 0 ? ascii.slice(0, nulIdx) : ascii).trimEnd();
  return {
    location: expectedLocation,
    name,
    isEmpty: name === PRESET_NAME_EMPTY_SENTINEL,
  };
}
