/**
 * Axe-Fx III SysEx wire builders.
 *
 * BEFORE EDITING THIS FILE, READ:
 *   - `docs/SYSEX-MAP-AXE-FX-III.md`   (project spec summary + known bugs)
 *   - `docs/manuals/AxeFx3-MIDI-3rdParty.txt`  (Fractal v1.4 PDF, extracted)
 *
 * The v1.4 PDF is the only public spec Fractal ships for the III's
 * third-party MIDI surface. It IS in this repo as extracted text.
 * Don't web-search or guess opcodes — grep the .txt first.
 *
 * Envelope: `F0 00 01 74 0x10 [function] [payload...] [checksum] F7`.
 * Same modern Fractal family as AM4 (model 0x15), FM3 (0x11), FM9
 * (0x12), VP4 (0x14) — III is 0x10.
 *
 * Function-byte map (all opcodes documented in the PDF):
 *   - 0x0A SET/GET BYPASS         (id id dd)
 *   - 0x0B SET/GET CHANNEL        (id id dd)
 *   - 0x0C SET/GET SCENE          (dd)
 *   - 0x0D QUERY PATCH NAME       (dd dd — preset number; returns nn nn + 32-char name)
 *   - 0x0E QUERY SCENE NAME       (dd — scene index; returns nn + 32-char name)
 *   - 0x0F SET/GET LOOPER STATE   (dd — button index; returns state bitfield)
 *   - 0x10 TEMPO TAP              (no payload; also the "tempo down-beat" push frame)
 *   - 0x11 TUNER ON/OFF           (dd; push variant carries note/string/cents)
 *   - 0x13 STATUS DUMP            (no payload; returns id id dd triples)
 *   - 0x14 SET/GET TEMPO          (dd dd — BPM)
 *
 * NOT documented in v1.4 (deliberately omitted by Fractal):
 *   - SET_PRESET / SWITCH_PRESET — use MIDI Program Change (CC0/CC32 + PC).
 *   - SET_PARAMETER_VALUE (0x02) — family inference only; param-IDs not public.
 *   - STORE_PRESET / SAVE — multi-frame envelope (0x77/0x78/0x79) per
 *     community RE; not in v1.4.
 *   - SET_PRESET_NAME / SET_SCENE_NAME — names are query-only.
 */
import { fractalChecksum } from '../../shared/checksum.js';
import { packValueChunked, unpackValueChunked } from '../../shared/packValue.js';
import { encode14, decode14, packValue16, unpackValue16 } from '../../shared/septet16.js';

/** Axe-Fx III model byte. From Fractal's published spec. */
export const AXE_FX_III_MODEL_ID = 0x10;

/** SysEx framing bytes shared across the entire modern Fractal family. */
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR_PREFIX = [0x00, 0x01, 0x74] as const;

// ── Function-ID bytes from the Axe-Fx III spec v1.4 ────────────────

export const FN_SET_GET_BYPASS = 0x0a;
export const FN_SET_GET_CHANNEL = 0x0b;
export const FN_SET_GET_SCENE = 0x0c;
export const FN_QUERY_PATCH_NAME = 0x0d;
export const FN_QUERY_SCENE_NAME = 0x0e;
export const FN_SET_GET_LOOPER = 0x0f;
export const FN_TEMPO_TAP = 0x10;
export const FN_TUNER_ON_OFF = 0x11;
export const FN_STATUS_DUMP = 0x13;
export const FN_SET_GET_TEMPO = 0x14;

/**
 * 0x64 MULTIPURPOSE_RESPONSE — the III's error channel.
 *
 * When the III receives a malformed SysEx or an unsupported function it
 * replies with:
 *
 *   `F0 00 01 74 10 64 [echoed_fn] [result_code] [cs] F7`   (10 bytes)
 *
 * `echoed_fn` is the function byte the host sent that the device
 * rejected; `result_code` is the device's reason byte (0x00 has been
 * seen for "general / checksum error", 0x05 has been seen for "NACK"
 * during preset-store experiments). Wire shape is documented in v1.4
 * and confirmed against a 2018 community capture — see
 * `docs/axefx3-fn01-decode.md`.
 */
export const FN_MULTIPURPOSE_RESPONSE = 0x64;

/**
 * 0x01 PARAMETER_SETGET — III parameter-write opcode (NOT the II's
 * 0x02 opcode). **Not in the v1.4 III spec** (Fractal deliberately
 * omits parameter writes), but the wire shape is byte-verified
 * against 10 community-captured frames spanning two effect blocks
 * and two sub-action codes — see `docs/axefx3-set-parameter-captures.md`.
 *
 * Evidence chain (pivot 2026-05-18):
 *   • FC-12 footswitch captures (4 frames): Amp 1/2
 *     boost ON/OFF. Effect IDs 58/59 (`ID_DISTORT1` / `ID_DISTORT2`,
 *     the gen-3 AMP block), paramId 40, sub-action `52 00` (mouse-drag).
 *     Already decoded
 *     into the field-layout table in `docs/axefx3-fn01-decode.md`.
 *   • Mountain Utilities forum captures (6 frames, from a public
 *     forum capture 2019-03-13): AxeEdit III writing Delay 1 TIME. Effect ID 70
 *     (`ID_DELAY1`), paramId 2. Four frames sub-action `52 00`
 *     (mouse-drag, intermediate values mid-drag) + two frames
 *     sub-action `09 00` (typed-input, final value). All 10 frames
 *     are 23 bytes, checksums validate, fields decode cleanly.
 *   •  Ghidra mining: opcode 0x01 appears in the III
 *     message-builder caller list — firmware code path is present.
 *
 * Earlier sessions (85+86) shipped `FN_SET_PARAMETER = 0x02` as a
 * II→III model-byte-swap port. That was WRONG — the III uses fn=0x01
 * with a 2-byte sub-action discriminator, NOT fn=0x02. 
 * reverted to the byte-verified envelope.
 *
 * Sub-actions seen on the wire:
 *   • `09 00` — typed-input SET (clean envelope, drag-context bytes
 *     zero). This is what we ship for `buildSetParameter`.
 *   • `52 00` — mouse-drag SET (drag-context bytes at pos 12-14
 *     carry cursor delta). Identical semantically; we don't emit
 *     this shape — the device accepts either.
 *   • `04 01` — STATE_BROADCAST (device→host, unsolicited state
 *     stream emitted on parameter change). NOT a sync SET response
 *     — the III appears to have no documented synchronous response
 *     to fn=0x01 SET.
 *
 * Status: 🟢 SET verified against 10 public captures, ready to ship.
 * GET shape still 🟡 — no captured GET frames exist on the open web
 * as of ; the implementation uses `09 00` with value=0 as
 * a hypothesis, matching the SET shape with an empty value field.
 */
export const FN_PARAMETER_SETGET = 0x01;

/** III parameter SETGET sub-action codes (pos 6-7 of the envelope). */
const SUB_ACTION_SET_TYPED: readonly [number, number] = [0x09, 0x00];
const SUB_ACTION_STATE_BROADCAST: readonly [number, number] = [0x04, 0x01];

/** Query sentinel — when this is the value byte, the device responds with current state. */
export const QUERY_SENTINEL = 0x7f;

// ── Encoding helpers ───────────────────────────────────────────────
//
// `encode14` / `decode14` (2-byte LSB-first septet pair — preset
// numbers, BPMs, effect IDs across the Fractal family) come from
// `fractal-midi/shared` (`shared/septet16.ts`), imported above.

/**
 * Build an envelope: `F0 00 01 74 [model] [function] [payload...]
 * [checksum] F7`. Checksum covers everything from `F0` through the
 * last payload byte (XOR-7bit).
 */
function buildEnvelope(
  fn: number,
  payload: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  const body = [SYSEX_START, ...FRACTAL_MFR_PREFIX, modelByte, fn, ...payload];
  const checksum = fractalChecksum(body);
  return [...body, checksum, SYSEX_END];
}

// ── 0x01 PARAMETER_SETGET ─────────────────────────────────────────
//
// Per primitive entry [[iii-fn01-set-parameter-envelope]], AxeEdit
// III's editor-side builder FUN_14033ec70 (Ghidra dump
// `samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt`
// L1325-1531, re-confirmed at
// `ghidra-axe-edit-iii-actions-and-shapes.txt` L22641-22850) defines
// the fn=0x01 payload as a 6-field structure:
//
//   { action14, blockId14, paramId14, value32, modifier14, tailCount14, tail[] }
//
// Field widths in the editor's own emission: action/block/param/
// modifier/tailCount each 2-byte LSB-first septet pair (14-bit
// unsigned, via [[septet-14bit]]); value32 a 5-byte LSB-first
// 5-septet 32-bit unsigned (via `pack5Septet32`); tail[] variable
// raw bytes (length = tailCount14).
//
// CORRECTED 2026-06-08 (FM3 fw 12.00 lldb + our FM9 capture, BoodieTraps):
// the value32 field IS a 5-septet float32 at pos 12-16 — exactly the
// FUN_14033ec70 layout — interpreted as IEEE-754. The earlier "value at
// pos 15-16 as a packValue16, pos 12-14 zero" reading was a MISREAD: for the
// small ordinals in the public captures (e.g. reverb 16 = 2^4), float32's low
// three septets are zero, so its nonzero high septets happen to land at pos
// 15-16 where a packValue16 would sit — coincidental alignment that hid the
// real field. `buildSetParameter` now emits:
//
//   pos 0-5:   F0 00 01 74 <model> 01       (envelope + fn=0x01)
//   pos 6-7:   sub-action                   (09 00 discrete, 52 00 continuous)
//   pos 8-9:   blockId14 / effect ID
//   pos 10-11: paramId14
//   pos 12-16: value32 = 5-septet LE float32 (discrete = float32(ordinal);
//                                            continuous = float32(normalized))
//   pos 17-20: four zero bytes
//   pos 21:    checksum
//   pos 22:    F7
//
// modifier / tailCount / tail (the rest of FUN_14033ec70) stay zero and are not
// exposed. Byte-exact vs the 5 oracle frames in setparam.test.ts.

/**
 * `packValue16` / `unpackValue16` (16-bit unsigned across three 7-bit
 * septets: bits 6..0, 13..7, 15..14) are re-exported from
 * `fractal-midi/shared` (`shared/septet16.ts`) — one canonical
 * implementation shared byte-identically with the gen-2 codec.
 *
 * Value-range note (III-observed): valid input range 0..65534 (16-bit
 * minus one — II wiki convention, carried forward to the III on the
 * assumption param-value ranges scaled with firmware). All observed III
 * captures use 14-bit values (pos 17 always zero); the 16-bit slot
 * exists in the envelope shape but isn't exercised by any public
 * capture yet.
 */
export { packValue16, unpackValue16 };

/**
 * Pack a 32-bit unsigned value into five 7-bit septets, LSB-first.
 *
 * Mirrors FUN_14033ec70 in AxeEdit III (the editor's canonical fn=0x01
 * payload builder) — Ghidra dump
 * `samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt`
 * L1463-1467:
 *
 *   pbVar4[6]  = (v >> 0)  & 0x7f
 *   pbVar4[7]  = (v >> 7)  & 0x7f
 *   pbVar4[8]  = (v >> 14) & 0x7f
 *   pbVar4[9]  = (v >> 21) & 0x7f
 *   pbVar4[10] = (v >> 28)
 *
 * Range: 0..2^32-1. For values in 0..16383, bytes 0-1 carry the low
 * 14 bits LSB-first and bytes 2-4 are zero (the low-14-bit prefix is
 * identical to `packValue16(v).slice(0, 2)`).
 *
 * The integer packer underlying `encode5SeptetFloat32`, which `buildSetParameter`
 * uses to place the float32 value32 field at pos 12-16. (The previous note that
 * this was "not used on the wire" reflected the pos-15 packValue16 misread,
 * corrected 2026-06-08.)
 */
export function pack5Septet32(value: number): [number, number, number, number, number] {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`pack5Septet32 input out of range (0..2^32-1): ${value}`);
  }
  return [
    (value >>> 0) & 0x7f,
    (value >>> 7) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 21) & 0x7f,
    (value >>> 28) & 0x7f,
  ];
}

/** Inverse of `pack5Septet32`: 5 LSB-first septets → unsigned 32-bit. */
export function unpack5Septet32(s0: number, s1: number, s2: number, s3: number, s4: number): number {
  return (
    ((s0 & 0x7f)) | ((s1 & 0x7f) << 7) | ((s2 & 0x7f) << 14)
    | ((s3 & 0x7f) << 21) | ((s4 & 0x7f) << 28)
  ) >>> 0;
}

const _f32buf = new ArrayBuffer(4);
const _f32 = new Float32Array(_f32buf);
const _u32 = new Uint32Array(_f32buf);

/**
 * Decode a 5-septet-LE little-endian IEEE-754 float32. This is the
 * NORMALIZED value space FM9-Edit uses for mouse-drag SETs (sub-action
 * `52 00`) and for the 60-byte SET value-echo response — FM9-confirmed
 * from a community hardware capture (2026-06-03). Continuous params normalize to
 * `[0,1]` (wire16/65534); enum/type params report `index/(count-1)`
 * (e.g. Reverb type Medium Spring = 16/78 = 0.205128).
 */
export function decode5SeptetFloat32(s0: number, s1: number, s2: number, s3: number, s4: number): number {
  _u32[0] = unpack5Septet32(s0, s1, s2, s3, s4);
  return _f32[0];
}

/**
 * Encode an IEEE-754 float32 as 5 LSB-first 7-bit septets — the inverse of
 * `decode5SeptetFloat32` and the value field every gen-3 SET carries at payload
 * pos 12. Discrete type/model selects pass `float32(read-ordinal)`; continuous
 * knob drags pass `float32(normalized 0..1)`. Wire-confirmed on FM3 fw 12.00
 * (BoodieTraps, 2026-06-08) and against our own FM9 capture (reverb ordinal 16 →
 * float32 16.0 → septets [00,00,00,0c,04]).
 */
export function encode5SeptetFloat32(value: number): [number, number, number, number, number] {
  _f32[0] = value;
  return pack5Septet32(_u32[0]);
}

/**
 * Parse the gen-3 SET value-echo / GET response (FM9-confirmed). The device
 * answers a typed SET (`sub 09 00`), a mouse-drag SET (`sub 52 00`), or a GET
 * (`sub 09 00`/`1F 00` with the value field zero) with a synchronous frame
 * carrying the effectId, paramId, and the device's quantized NORMALIZED value
 * as a 5-septet float32 at bytes 12-16.
 *
 * For a CONTINUOUS knob the float field is the value. For a DISCRETE type/model
 * selector the float field is ZERO and the device's current type NAME rides as
 * a length-prefixed 8→7 packed string later in the frame — surfaced here as
 * `displayName` when present (FM9 capture 2026-06-19: a reverb-type GET returned
 * float32=0 + "Small Room"; the old code reported only the misleading 0). The
 * CALLER picks which to trust by the param's `wire_kind` (discrete → displayName,
 * continuous → normalizedValue); do NOT infer kind from "value is zero" alone
 * (a knob legitimately at 0.0 is also zero). Read-only; emits nothing on the wire.
 */
export function parseGen3SetValueEcho(bytes: readonly number[]): {
  effectId: number;
  paramId: number;
  normalizedValue: number;
  /** Device's current display string (type NAME for discrete params), when the frame carries one. */
  displayName?: string;
} {
  if (
    bytes.length < 22 || bytes[0] !== 0xf0 || bytes[1] !== 0x00
    || bytes[2] !== 0x01 || bytes[3] !== 0x74 || bytes[5] !== 0x01
  ) {
    throw new Error('parseGen3SetValueEcho: not a fn=0x01 echo frame');
  }
  // A type/model GET/echo carries the device's display string (the NAME) in the
  // length-prefixed region parsed by parseGetParameterResponse. Use the frame's
  // OWN model byte (FM9=0x12, III=0x10, …) so the predicate's model gate passes.
  let displayName: string | undefined;
  const modelByte = bytes[4];
  try {
    if (isGetParameterResponse(bytes, modelByte)) {
      displayName = parseGetParameterResponse(bytes, modelByte).displayString;
    }
  } catch {
    // not a display-string frame; leave displayName undefined.
  }
  return {
    effectId: decode14(bytes[8], bytes[9]),
    paramId: decode14(bytes[10], bytes[11]),
    normalizedValue: decode5SeptetFloat32(bytes[12], bytes[13], bytes[14], bytes[15], bytes[16]),
    displayName,
  };
}

/**
 * SET PARAMETER (function 0x01, sub-action 0x09 0x00 — typed input).
 *
 * Internal 6-field model (per FUN_14033ec70 in AxeEdit III; see
 * primitive entry [[iii-fn01-set-parameter-envelope]]):
 *
 *   { action14, blockId14, paramId14, value32, modifier14, tailCount14, tail[] }
 *
 * Emitted wire bytes (DISCRETE select; the value32 field is a 5-septet float32
 * at pos 12-16, corrected 2026-06-08):
 *
 *   `F0 00 01 74 <model> 01 09 00 [id_lo id_hi] [pid_lo pid_hi]
 *    [s0 s1 s2 s3 s4 = float32(ordinal)] 00 00 00 00 [cs] F7`
 *
 * 23 bytes. Byte-exact against the FM3 fw 12.00 + FM9 oracle frames (and the 10
 * earlier public captures, which agree because float32(small ordinal) aliases the
 * old pos-15 read). The continuous form (`buildSetParameterContinuous`, sub
 * `52 00`) carries `float32(normalized)` in the SAME field; a bare 52 00 stream
 * commits with no `56 00` begin-gesture.
 *
 * The 6-field model's `modifier14`, `tailCount14`, and `tail[]` slots stay zero
 * and are not exposed in the public API.
 *
 * The device's RESPONSE to a SET is a synchronous 60-byte value-echo (effectId,
 * paramId, a 5-septet float32 value, then a descriptor block) — parse it with
 * `parseGen3SetValueEcho`. The real device→host edit broadcast is the
 * `0x74/0x75/0x76` burst, NOT `fn=0x01 04 01`.
 */
/** Continuous mouse-drag SET sub-action (knob writes carry float32 normalized 0..1). */
export const SUB_ACTION_SET_CONTINUOUS: readonly [number, number] = [0x52, 0x00];

/**
 * Low-level gen-3 SET frame: the value rides as a 5-septet LE float32 at payload
 * pos 12 (NOT a packValue16 at pos 15), followed by FOUR trailing zero bytes.
 * `subAction` selects discrete (`09 00`) vs continuous (`52 00`).
 *
 * Wire shape (23 bytes), byte-exact vs FM3 fw 12.00 + FM9 captures:
 *   F0 00 01 74 <model> 01 <sub:2> <eid:14b LE> <pid:14b LE>
 *      <float32:5-septet @12-16> 00 00 00 00 <xor cks> F7
 */
function buildSetParameterFloat(
  effectId: number,
  paramId: number,
  floatValue: number,
  subAction: readonly [number, number],
  modelByte: number,
): number[] {
  return buildEnvelope(FN_PARAMETER_SETGET, [
    ...subAction,
    ...encode14(effectId),
    ...encode14(paramId),
    ...encode5SeptetFloat32(floatValue),
    0x00, 0x00, 0x00, 0x00,
  ], modelByte);
}

/**
 * DISCRETE type/model SELECT (sub-action `09 00`). The value is the read-roster
 * ORDINAL emitted as `float32(ordinal)` — e.g. Reverb type "Medium Spring" =
 * ordinal 16 → float32 16.0 → septets [00,00,00,0c,04]. The read-roster ordinal
 * IS the set value; there is no separate "raw-id" space (the 523/524/527/528/529
 * we once recorded were float32(ordinal) misread as a packValue16 at pos 15,
 * lossy across whole ordinal bands). Confirmed FM3 fw 12.00 (BoodieTraps) + our
 * FM9 reverb capture, 2026-06-08.
 */
export function buildSetParameter(
  effectId: number,
  paramId: number,
  ordinal: number,
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  return buildSetParameterFloat(effectId, paramId, ordinal, SUB_ACTION_SET_TYPED, modelByte);
}

/**
 * CONTINUOUS knob SET (sub-action `52 00`). The value is `float32(normalized)`
 * where `normalized` is in [0,1] (display→wire→/65534 at the catalog boundary).
 * A bare `52 00` stream commits on its own — no `56 00` begin-gesture is required
 * (FM3 fw 12.00 gain-sweep capture: 45 frames, zero 56 00). Pos-12 float, same
 * field as the discrete form; only the sub-action and value semantics differ.
 */
export function buildSetParameterContinuous(
  effectId: number,
  paramId: number,
  normalized: number,
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  return buildSetParameterFloat(effectId, paramId, normalized, SUB_ACTION_SET_CONTINUOUS, modelByte);
}

/**
 * GET PARAMETER (function 0x01, sub-action 0x09 0x00 with value=0).
 *
 * 🟡 Hypothesis only — no public GET capture exists. The send shape
 * mirrors SET with the value field zeroed, on the theory that the III
 * either echoes the param's current value or emits a `04 01`
 * STATE_BROADCAST asynchronously. Callers should treat a missing
 * response within ~250 ms as "GET not supported on this firmware,"
 * not as a tool error, and fall back to 0x13 STATUS_DUMP or
 * STATE_BROADCAST listening.
 */
export function buildGetParameter(
  effectId: number,
  paramId: number,
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  return buildEnvelope(FN_PARAMETER_SETGET, [
    ...SUB_ACTION_SET_TYPED,
    ...encode14(effectId),
    ...encode14(paramId),
    0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
  ], modelByte);
}

/**
 * GET CURRENT TYPE NAME (function 0x01, sub-action 0x1F 0x00).
 *
 * The gen-3 editor reads a block's current type/model NAME with this sub-action
 * (effectId + the block's "type" paramId as the target; the value field stays
 * zero). The device replies with the long fn=0x01 GET frame whose display-string
 * region carries the model name — decode the reply with `parseGetParameterResponse`
 * (`.displayString`). Byte-confirmed on FM9 fw 11.0 (capture 2026-06-19): the
 * reverb/amp/drive type reads returned "Small Room" / "59 Bassguy Bright" /
 * "Rat Distortion". (`buildGetParameter`'s `09 00` GET elicits the same
 * display-string reply; this `1F 00` form matches what the editor sends.)
 *
 * Wire (23 bytes): `F0 00 01 74 <model> 01 1F 00 <eid:14b LE> <pid:14b LE>
 *  00*9 <cks> F7`. Read-only; carries no value, mutates nothing.
 */
export const SUB_ACTION_GET_TYPE_NAME = 0x1f;

export function buildRequestCurrentTypeName(
  effectId: number,
  typeParamId: number,
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  return buildEnvelope(FN_PARAMETER_SETGET, [
    SUB_ACTION_GET_TYPE_NAME,
    0x00,
    ...encode14(effectId),
    ...encode14(typeParamId),
    0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
  ], modelByte);
}

/**
 * Block-bypass via PARAMETER_SETGET (paramId 255 is the bypass
 * register per Axe-Fx II wiki — III binding unverified). The III
 * v1.4 spec exposes a separate 0x0A SET_BYPASS opcode — prefer that
 * one for production bypass writes. This builder exists as a
 * fallback for the 0x02-port era and is kept compatible with the
 * pivoted fn=0x01 envelope.
 *
 * 🟡 III-untested specifically for paramId=255 binding.
 */
export function buildSetParameterBypass(effectId: number, bypassed: boolean): number[] {
  return buildSetParameter(effectId, 255, bypassed ? 1 : 0);
}

/**
 * Predicate: is this an inbound fn=0x01 PARAMETER frame? Accepts any
 * sub-action — `52 00` (echo of host SET, observed in passive sniffs),
 * `04 01` (STATE_BROADCAST), or `09 00` (theoretically a host
 * typed-input echo). The parser disambiguates by sub-action.
 */
export function isSetGetParameterResponse(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): boolean {
  return isAxeFxIIIFrame(bytes, FN_PARAMETER_SETGET, modelByte);
}

/**
 * Discriminator for `parseSetGetParameterResponse` results so callers can
 * branch on the sub-action without re-reading the sub-action bytes.
 *
 * - `'set_echo'` — sub-action `09 00` or `52 00`. Both `paramId` and
 *   `value` are populated. Round-trip self-consistent with
 *   `buildSetParameter`.
 * - `'state_broadcast'` — sub-action `04 01`. `paramId` is reported as
 *   `0` because the wire frame omits the field; track the last-SET
 *   paramId in the caller and attribute the broadcast value to it.
 */
export type AxeFxIIIParameterFrameKind = 'set_echo' | 'state_broadcast';

/**
 * Parse an inbound fn=0x01 PARAMETER frame. Returns
 * `{ kind, effectId, paramId, value, subAction }`.
 *
 * Two response shapes seen in captures:
 *   • Sub-action `52 00` (23 bytes): host-SET echo. effId at pos 2-3
 *     of payload, paramId at 4-5, value at 9-11 (packValue16). Round-
 *     trip self-consistent with `buildSetParameter`.
 *   • Sub-action `04 01` (23 bytes): STATE_BROADCAST. effId at
 *     pos 2-3, paramId field is zero (the broadcast doesn't carry
 *     it), value at 6-7 as a 2-septet LS-first pair.
 *
 * For `04 01` STATE_BROADCAST frames we return `paramId: 0` to
 * signal the caller that paramId is unknown — they should track
 * which param was last SET to attribute the broadcast value.
 *
 * For consumers that prefer an explicit broadcast handler, see
 * `parseStateBroadcast`, which throws on non-broadcast frames.
 */
export function parseSetGetParameterResponse(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): {
  kind: AxeFxIIIParameterFrameKind;
  effectId: number;
  paramId: number;
  value: number;
  subAction: number;
} {
  if (!isSetGetParameterResponse(bytes, modelByte)) {
    throw new Error(`parseSetGetParameterResponse: not a fn=0x01 frame (len=${bytes.length})`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length < 15) {
    throw new Error(`parseSetGetParameterResponse: payload too short (${payload.length}B; expected ≥15)`);
  }
  const subAction = (payload[0] & 0x7f) | ((payload[1] & 0x7f) << 7);
  if (payload[0] === 0x04 && payload[1] === 0x01) {
    // STATE_BROADCAST — different field layout (no paramId slot, value
    // at pos 6-7 as a 2-septet pair, optional flag at pos 8).
    return {
      kind: 'state_broadcast',
      effectId: decode14(payload[2], payload[3]),
      paramId: 0,
      value: decode14(payload[6], payload[7]),
      subAction,
    };
  }
  // SET / SET-echo layout (sub-action `09 00` discrete or `52 00` continuous).
  // The value is a 5-septet float32 at payload pos 6-10 (= frame bytes 12-16),
  // NOT a packValue16 at pos 9-11 — see encode5SeptetFloat32 / the 2026-06-08
  // FM3+FM9 confirmation. For a discrete select it is float32(ordinal); for a
  // continuous drag it is float32(normalized 0..1).
  // NOTE (FM9 capture 2026-06-19): a GET/echo on a TYPE/model param carries
  // float32 ZERO here AND the device's current type NAME as a length-prefixed
  // 8→7 packed string later in the frame. This parser returns only the numeric
  // `value` (0 for type params); use `parseGetParameterResponse` /
  // `parseGen3SetValueEcho().displayName` to read the name. Do not treat the 0
  // as the type's value.
  return {
    kind: 'set_echo',
    effectId: decode14(payload[2], payload[3]),
    paramId: decode14(payload[4], payload[5]),
    value: decode5SeptetFloat32(payload[6], payload[7], payload[8], payload[9], payload[10]),
    subAction,
  };
}

/**
 * Parse the async `04 01` STATE_BROADCAST sub-action specifically.
 * Throws on any other sub-action.
 *
 * Use this when listening for the III's unsolicited state-change push
 * (the closest thing the III has to a GET response — the device emits
 * a broadcast whenever a parameter changes, whether the change was
 * driven by the host, by the front panel, or by another editor).
 *
 * Caller must track which paramId was last SET on this effectId to
 * attribute the broadcast value — the broadcast frame does NOT echo
 * the paramId.
 */
export function parseStateBroadcast(bytes: readonly number[]): {
  effectId: number;
  value: number;
} {
  const parsed = parseSetGetParameterResponse(bytes);
  if (parsed.kind !== 'state_broadcast') {
    throw new Error(
      `parseStateBroadcast: frame is sub-action 0x${parsed.subAction.toString(16).padStart(4, '0')}, not 0x0104 STATE_BROADCAST`,
    );
  }
  return { effectId: parsed.effectId, value: parsed.value };
}

// ── 0x74/0x75/0x76 gen-3 STATE-BROADCAST burst (device → host) ──────
//
// The REAL gen-3 working-buffer-edit broadcast, byte-confirmed on FM9
// hardware (firmware 11.00, community capture 2026-06-03). NOT the
// `fn=0x01 04 01` form the III research notes assumed (which no editor was
// observed to emit). The device emits this burst both on a front-panel edit and as the
// response to an fn=0x1F bulk-read poll. The burst is four frames:
//
//   0x74 head  F0 00 01 74 [model] 74 [blockId:14b] [itemCount:14b] [flag] [cs] F7
//   0x75 body  F0 00 01 74 [model] 75 [sectionId] [flag] [N × packValue16] [cs] F7
//   0x75 tail  (a continuation section; sectionId differs)
//   0x76 end   F0 00 01 74 [model] 76 [cs] F7
//
// The body carries one 3-septet packValue16 per parameter in device-true
// paramId order (body index i == that block family's paramId i — validated
// against the mined FM9 catalog). Read-only decode of device-emitted bytes;
// emits nothing on the wire.

/** Parse the 0x74 head of a gen-3 state-broadcast burst → which block + item count. */
export function parseGen3StateBroadcastHead(bytes: readonly number[]): {
  blockId: number;
  itemCount: number;
} {
  if (
    bytes.length < 11 || bytes[0] !== 0xf0 || bytes[1] !== 0x00
    || bytes[2] !== 0x01 || bytes[3] !== 0x74 || bytes[5] !== 0x74
  ) {
    throw new Error('parseGen3StateBroadcastHead: not a fn=0x74 state-broadcast head frame');
  }
  return {
    blockId: decode14(bytes[6], bytes[7]),
    itemCount: decode14(bytes[8], bytes[9]),
  };
}

/**
 * Parse the 0x75 body of a gen-3 state-broadcast burst into its
 * per-parameter values (one 3-septet `packValue16` each, in paramId order).
 */
export function parseGen3StateBroadcastBody(bytes: readonly number[]): {
  sectionId: number;
  values: number[];
} {
  if (
    bytes.length < 10 || bytes[0] !== 0xf0 || bytes[1] !== 0x00
    || bytes[2] !== 0x01 || bytes[3] !== 0x74 || bytes[5] !== 0x75
  ) {
    throw new Error('parseGen3StateBroadcastBody: not a fn=0x75 state-broadcast body frame');
  }
  const sectionId = bytes[6];
  // bytes[6]=sectionId, bytes[7]=reserved/flag; 3-septet triples from byte 8,
  // trailing [cs][F7] stripped.
  const end = bytes.length - 2;
  const values: number[] = [];
  for (let i = 8; i + 3 <= end; i += 3) {
    values.push(unpackValue16(bytes[i], bytes[i + 1], bytes[i + 2]));
  }
  return { sectionId, values };
}

// ── 0x1F block bulk-read POLL (host → device) ──────────────────────
//
// Byte-confirmed on FM9 (firmware 11.00, community capture 2026-06-03):
// a 10-byte poll whose reply IS the 0x74/0x75/0x76 state-broadcast burst
// (~1 ms later; there is no separate fn=0x1F response body). This is the
// gen-3 atomic whole-block read, structurally identical to the Axe-Fx II's
// fn=0x1F SYSEX_GET_ALL_PARAMS (same opcode, same triple-frame answer): the
// cross-device transfer is exact, differing only by model byte + the gen-3
// 3-septet `packValue16` value encoding.
//
//   poll  F0 00 01 74 [model] 1F [effectId:14b septet-LE] [cs] F7   (10 B)
//
// The device rejects a poll for an UNPLACED block with an fn=0x64
// MULTIPURPOSE_RESPONSE NACK rather than a burst (II-observed; assumed for
// gen-3 pending tester confirmation).

export const FN_BLOCK_BULK_READ = 0x1f;

/**
 * Build the fn=0x1F block bulk-read poll for `effectId`. The reply is the
 * 0x74/0x75(xN)/0x76 burst; collect it with `assembleGen3BlockBulkRead`.
 * Read-only: carries no value, mutates nothing.
 */
export function buildBlockBulkReadPoll(
  effectId: number,
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  if (!Number.isInteger(effectId) || effectId < 0 || effectId > 0x3fff) {
    throw new Error(`buildBlockBulkReadPoll: effectId out of range (0..16383): ${effectId}`);
  }
  return buildEnvelope(FN_BLOCK_BULK_READ, encode14(effectId), modelByte);
}

// ── 0x03 REQUEST_PRESET_DUMP (host → device) ───────────────────────
//
// Byte-confirmed on FM9 (firmware 11.00, community "receive preset from
// device" capture 2026-06-04, decoded in
// `docs/_private/FM9-CAPTURE-RECEIVE+SWEEP-2026-06-04.md` and re-verified
// by the `fm9-decode-verify` workflow). A 10-byte request that asks the
// device to send a STORED preset back as the 0x77/0x78/0x79 dump chain
// (head + N×body + tail), the same envelope `fractal-gen3`'s
// `presetDump.ts` already parses/serializes. This is the read/backup
// trigger; it mutates nothing on the device.
//
//   request  F0 00 01 74 [model] 03 [preset_high7] [preset_low7] 00 [cs] F7   (11 B)
//
// The preset number is BIG-ENDIAN septet ([high, low]), matching the II /
// gen-3 STORE / GET_TEMPO MSB-first convention — NOT the little-endian
// `encode14` used for effect/param ids. Captured FM9 requests decoded to
// 49, 129, 197, 273, 274, 355, 443, 444 (all valid 0..511 indices); the
// little-endian misreading gives nonsense (e.g. 6272). The trailing 0x00
// is a fixed third payload byte present in every captured request.
//
// Write-back (host → device 0x77/0x78/0x79) is NOT yet captured; do not
// add a device-bound preset-write builder until that direction is verified.

export const FN_REQUEST_PRESET_DUMP = 0x03;

/**
 * Build the fn=0x03 REQUEST_PRESET_DUMP for a STORED preset. The device
 * replies with the 0x77 header + N×0x78 body + 0x79 footer dump; collect
 * those frames and parse with `fractal-gen3`'s `parsePresetDump`.
 * Read-only: carries no value, mutates nothing on the device.
 *
 * `presetNumber` is the stored-location index (FM9: 0..511; the III banks
 * 0..383). Big-endian septet encoding per the captured wire shape.
 */
export function buildRequestPresetDump(
  presetNumber: number,
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  if (!Number.isInteger(presetNumber) || presetNumber < 0 || presetNumber > 0x3fff) {
    throw new Error(`buildRequestPresetDump: preset out of range (0..16383): ${presetNumber}`);
  }
  const high = (presetNumber >> 7) & 0x7f;
  const low = presetNumber & 0x7f;
  return buildEnvelope(FN_REQUEST_PRESET_DUMP, [high, low, 0x00], modelByte);
}

// ── EDIT-BUFFER DUMP (fn=0x43 request → 0x51 head + 0x52 body run) ──
//
// fn=0x43 (no args) asks the device to dump its ACTIVE working buffer (the
// currently-edited preset). The reply is a 0x51 head + a homogeneous run of
// 0x52 body frames, with NO tail frame (unlike the stored dump's 0x79).
// Wire-confirmed on FM9 (FW 11.00, 2026-06-04 receive capture; request is
// byte-exact `F0 00 01 74 12 43 54 F7`, no payload). The body uses the same
// 3-septet word packing as the stored 0x78 chunk; the canonical body length is
// 3082 B (off-lengths in the USBPcap capture were drop/coalesce artifacts).
//
// This is the active-buffer scope `export_preset` maps to; distinct from the
// stored-preset dump (fn=0x03 → 0x77/0x78/0x79). The dump is READ-only and the
// request carries no payload, so it mutates nothing on the device. For a
// byte-exact backup the body frames are treated as opaque (concatenated
// verbatim); the inner section layout is not yet decoded.

export const FN_REQUEST_EDIT_BUFFER_DUMP = 0x43;
export const FN_EDIT_BUFFER_DUMP_HEAD = 0x51;
export const FN_EDIT_BUFFER_DUMP_BODY = 0x52;

/**
 * Build the fn=0x43 REQUEST_EDIT_BUFFER_DUMP (no args). The device replies with
 * a 0x51 head + a run of 0x52 body frames (no tail). Collect them until the
 * stream goes quiet; concatenate verbatim for a byte-exact `.syx` backup.
 * Read-only: carries no value, mutates nothing on the device.
 */
export function buildRequestEditBufferDump(
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  return buildEnvelope(FN_REQUEST_EDIT_BUFFER_DUMP, [], modelByte);
}

/** Non-throwing predicate: is `bytes` the 0x51 edit-buffer dump HEAD for `modelByte`? */
export function isEditBufferDumpHead(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): boolean {
  return isAxeFxIIIFrame(bytes, FN_EDIT_BUFFER_DUMP_HEAD, modelByte);
}

/** Non-throwing predicate: is `bytes` a 0x52 edit-buffer dump BODY frame for `modelByte`? */
export function isEditBufferDumpBody(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): boolean {
  return isAxeFxIIIFrame(bytes, FN_EDIT_BUFFER_DUMP_BODY, modelByte);
}

/**
 * Non-throwing predicate: is `bytes` a gen-3 state-broadcast frame of the
 * given function byte (0x74 head / 0x75 body / 0x76 end) for `modelByte`?
 * Used by the burst collector to classify inbound frames without throwing.
 */
export function isGen3BroadcastFrame(
  bytes: readonly number[],
  fn: 0x74 | 0x75 | 0x76,
  modelByte: number = AXE_FX_III_MODEL_ID,
): boolean {
  return (
    bytes.length >= 7
    && bytes[0] === 0xf0 && bytes[1] === 0x00 && bytes[2] === 0x01
    && bytes[3] === 0x74 && bytes[4] === modelByte && bytes[5] === fn
  );
}

/** A reassembled fn=0x1F whole-block read. `values[i]` is that block's paramId `i`. */
export interface Gen3BlockBulkRead {
  /** Block/effect id echoed in the 0x74 head. */
  blockId: number;
  /** Param count the head advertised (cross-check against `values.length`). */
  itemCount: number;
  /** Positional wire values; index i == device-true paramId i (paged 0x75 bodies concatenated in arrival order). */
  values: number[];
}

/**
 * Assemble a collected 0x74/0x75…/0x76 burst into positional values.
 *
 * The 0x75 body is POSITIONAL: record index i == that block's device-true
 * paramId i (validated against the mined FM9 catalog, capture 2026-06-03).
 * A whole-block dump pages across multiple 0x75 sections (e.g. Reverb = a
 * 256-value section + a 36-value tail = itemCount 292); we concatenate them
 * in arrival order, so the tail continues the paramId sequence. The 0x74
 * head fixes the blockId + advertised itemCount; the 0x76 end is ignored.
 */
export function assembleGen3BlockBulkRead(
  frames: readonly (readonly number[])[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): Gen3BlockBulkRead {
  let head: { blockId: number; itemCount: number } | undefined;
  const values: number[] = [];
  for (const f of frames) {
    if (isGen3BroadcastFrame(f, 0x74, modelByte)) {
      if (head === undefined) head = parseGen3StateBroadcastHead(f);
    } else if (isGen3BroadcastFrame(f, 0x75, modelByte)) {
      for (const v of parseGen3StateBroadcastBody(f).values) values.push(v);
    }
    // 0x76 end: structural terminator, no payload.
  }
  if (head === undefined) {
    throw new Error('assembleGen3BlockBulkRead: no 0x74 head frame in the burst');
  }
  return { blockId: head.blockId, itemCount: head.itemCount, values };
}

// ── SET_GRID_CELL / block INSERT (fn=0x01 sub=0x32) ────────────────
//
// The gen-3 editor places a block into a grid cell with fn=0x01
// sub-action 0x32 (the editor names it `grid_set_position`). Captured
// byte-exact from FM9-Edit (0x12), AxeEdit III (0x10), and FM3-Edit
// (0x11) over loopMIDI; see the primitive [[gen3-fn01-grid-set-position-insert]]
// and the golden `scripts/primitives-verify.ts#case-gen3-fn01-grid-set-position-insert`.
//
// This supersedes the earlier fn=0x05 guess (a II-ported opcode the III
// firmware never confirmed). The editor pairs the insert with a cell-select
// companion (sub=0x30, gridPos only) emitted first; the select is a cursor
// move that does not change grid state (the codec-backed device simulator
// models it as a no-op), so the insert alone is the state-changing write and
// this builder emits just the insert. TRUE ON III/FM9 ONLY: the FM3 ignores
// the insert's target cell unless the select precedes it — see
// `buildSelectCell` below, hardware-confirmed 2026-06-27 (issue #9).
//
// Wire envelope (23 bytes):
//
//   `F0 00 01 74 <model> 01 32 00 <effectId_lo effectId_hi> 00 00
//    <gridPos_lo gridPos_hi> 00 00 00 00 00 00 00 <cks> F7`
//
// effectId is a septet 14-bit field at bytes 8-9; gridPos a septet 14-bit
// field at bytes 12-13 (both LSB-first via [[septet-14bit]]). A high septet
// of 0x08 on the effect id marks a shunt / routing element; real blocks have
// it zero. Rejections arrive as 0x64 MULTIPURPOSE_RESPONSE.

const FN_SET_GRID_CELL = FN_PARAMETER_SETGET; // 0x01
const GRID_INSERT_SUB_ACTION = 0x32;

/**
 * SET_GRID_CELL / block INSERT (fn=0x01 sub=0x32). Places `blockId` at cell
 * (row, col); `blockId=0` clears the cell.
 *
 * gridPos = (col - 1) * rows + (row - 1), column-major. The row stride is the
 * grid's row count, passed via `opts.rows`. The gen-3 grid is 6 rows on the
 * Axe-Fx III and FM9 (wire-confirmed), 4 rows on the FM3; pass its row count.
 * Default 6. Wire-confirmed across model 0x10/0x11/0x12; see the primitive
 * [[gen3-fn01-grid-set-position-insert]] entry.
 */
export function buildSetGridCell(opts: {
  row: number;
  col: number;
  blockId: number;
  rows?: number;
}, modelByte: number = AXE_FX_III_MODEL_ID): number[] {
  const { row, col, blockId, rows = 6 } = opts;
  if (!Number.isInteger(rows) || rows < 1) {
    throw new Error(`buildSetGridCell: rows must be a positive integer: ${rows}`);
  }
  if (!Number.isInteger(row) || row < 1 || row > rows) {
    throw new Error(`buildSetGridCell: row out of range (1..${rows}): ${row}`);
  }
  if (!Number.isInteger(col) || col < 1 || col > 14) {
    throw new Error(`buildSetGridCell: col out of range (1..14): ${col}`);
  }
  if (!Number.isInteger(blockId) || blockId < 0 || blockId > 0x3fff) {
    throw new Error(`buildSetGridCell: blockId out of range (0..16383): ${blockId}`);
  }
  const gridPos = (col - 1) * rows + (row - 1);
  // Payload: [sub-action, pad, effectId@8-9, 2 pad, gridPos@12-13, 7 pad].
  return buildEnvelope(FN_SET_GRID_CELL, [
    GRID_INSERT_SUB_ACTION,
    0x00,
    ...encode14(blockId),
    0x00, 0x00,
    ...encode14(gridPos),
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ], modelByte);
}

// ── SET_GRID_ROUTING (fn=0x01 sub=0x35) ────────────────────────────
//
// Draws or removes a cable between two adjacent-column cells in the gen-3
// grid. Wire envelope (26 bytes):
//
//   F0 00 01 74 <model> 01 35 00 00 00 00 00 <OP> 00 00 00 00 00
//   00 02 00 <b21> <b22> <b23> <cks> F7
//
// Two formulas, branched by grid row count:
//
// ── 6-row grids (III model=0x10, FM9 model=0x12) ─────────────────
// Decoded via FM9-Edit loopMIDI (26 cables, 2026-06-05):
//   srcGp    = (srcCol − 1) × 6 + (srcRow − 1)
//   b21      = floor(srcGp / 2)
//   colTerm  = floor(3·(srcCol−1)/2) + 1
//   destSign = destRow >= 3 ? 1 : 0
//   b22      = ((srcGp & 1) << 6) | (colTerm + destSign)
//   b23      = ((|destRow−3| + (srcCol even ? 2 : 0)) % 4) << 5
// Row-1 even srcCol refused — encoding not yet captured (6-row only).
//
// CANDIDATE FILL (community, hardware-unconfirmed): the MIT-licensed
// `ai-tone-assistant` project encodes cables from an explicit from/to pair:
//   from_pos = (srcCol−1)·6 + (srcRow−1);  to_pos = (destCol−1)·6 + (destRow−1)
//   d9 = from_pos >> 1                       ← equals our b21 = floor(srcGp/2)
//   d10 = (to_pos >> 2) | ((from_pos & 1) << 6)
//   d11 = (to_pos & 3) << 5
// This is byte-IDENTICAL to ours for the captured corpus (source rows 2-3);
// it DIVERGES at source row 1 and predicts the row-1 even-col fill we refuse.
// Do NOT adopt into the active path: his row-1 prediction is itself
// hardware-unconfirmed and his low-bits model differs from our colTerm/
// destSign law, so it could regress validated cells. Close it with the R4
// source-row-1 capture (r1c2→r1c3) before wiring; see
// docs/_private/gen3-routing-capture-protocol.md (R4).
//
// ── 4-row grids (FM3 model=0x11) ──────────────────────────────────
// Decoded via FM3-Edit loopMIDI (10 cables, 2026-06-05):
//   srcGp    = (srcCol − 1) × 4 + (srcRow − 1)
//   b21      = floor(srcGp / 2)
//   b22      = ((srcGp & 1) << 6) | srcCol       ← colTerm = srcCol; no destSign
//   b23      = (destRow − 1) << 5                 ← linear 1-indexed encoding
// All rows 1-4 and all srcCol parity (including row-1 even-col) work.

const GRID_ROUTING_SUB_ACTION = 0x35;
export const ROUTING_OP_CONNECT = 0x01;
export const ROUTING_OP_DISCONNECT = 0x02;

/**
 * SET_GRID_ROUTING (fn=0x01 sub=0x35). Draws or removes a cable between
 * `(srcRow, srcCol)` and `(destRow, srcCol + 1)`. Dest column is implicit.
 *
 * `op`: `ROUTING_OP_CONNECT` (0x01) or `ROUTING_OP_DISCONNECT` (0x02).
 * Defaults to connect.
 *
 * `rows`: 6 for III/FM9 (default), 4 for FM3. The formulas for b22/b23
 * differ between 6-row and 4-row grids (both byte-confirmed from
 * FM9-Edit and FM3-Edit loopMIDI captures, 2026-06-05).
 */
export function buildSetGridRouting(opts: {
  srcRow: number;
  srcCol: number;
  destRow: number;
  rows?: number;
  op?: number;
}, modelByte: number = AXE_FX_III_MODEL_ID): number[] {
  const { srcRow, srcCol, destRow, rows = 6, op = ROUTING_OP_CONNECT } = opts;

  if (rows !== 6 && rows !== 4) {
    throw new Error(
      `buildSetGridRouting: rows must be 4 (FM3) or 6 (III/FM9). Got rows=${rows}.`,
    );
  }
  if (!Number.isInteger(srcRow) || srcRow < 1 || srcRow > rows) {
    throw new Error(`buildSetGridRouting: srcRow out of range (1..${rows}): ${srcRow}`);
  }
  if (!Number.isInteger(srcCol) || srcCol < 1 || srcCol > 13) {
    throw new Error(`buildSetGridRouting: srcCol out of range (1..13): ${srcCol}`);
  }
  if (!Number.isInteger(destRow) || destRow < 1 || destRow > rows) {
    throw new Error(`buildSetGridRouting: destRow out of range (1..${rows}): ${destRow}`);
  }
  if (op !== ROUTING_OP_CONNECT && op !== ROUTING_OP_DISCONNECT) {
    throw new Error(`buildSetGridRouting: op must be ROUTING_OP_CONNECT (0x01) or ROUTING_OP_DISCONNECT (0x02): ${op}`);
  }
  // Row-1 even-col is only unresolved on 6-row grids. FM3 (4-row) encodes
  // them correctly with the 4-row formula (confirmed cable r1c2→r1c3).
  if (rows === 6 && srcRow === 1 && srcCol % 2 === 0) {
    throw new Error(
      `buildSetGridRouting: source row=1 even column (col ${srcCol}) is not yet decoded ` +
        `for 6-row grids. Capture r1c${srcCol}→r1c${srcCol + 1}, r1c${srcCol}→r3c${srcCol + 1}, ` +
        `r1c${srcCol}→r5c${srcCol + 1} with FM9-Edit or III-Edit to close this corner.`,
    );
  }

  const srcGp = (srcCol - 1) * rows + (srcRow - 1);
  const b21 = Math.floor(srcGp / 2);
  let b22: number;
  let b23: number;

  if (rows === 4) {
    // FM3 4-row formula (10/10 byte-confirmed, FM3-Edit loopMIDI, 2026-06-05):
    //   colTerm = srcCol (linear, no 3/2 scaling); no destSign.
    //   b23 = (destRow-1)*32 (simple 0-indexed row, no mod-4 wrap).
    b22 = ((srcGp & 1) << 6) | srcCol;
    b23 = (destRow - 1) << 5;
  } else {
    // 6-row formula (III/FM9, 26/26 byte-confirmed, FM9-Edit loopMIDI, 2026-06-05):
    const colTerm = Math.floor((3 * (srcCol - 1)) / 2) + 1;
    const destSign = destRow >= 3 ? 1 : 0;
    b22 = ((srcGp & 1) << 6) | (colTerm + destSign);
    b23 = ((Math.abs(destRow - 3) + (srcCol % 2 === 0 ? 2 : 0)) % 4) << 5;
  }

  // Payload layout (bytes after fn=0x01):
  // [sub=0x35, 0, 0, 0, 0, 0, OP, 0, 0, 0, 0, 0, 0, 0x02, 0, b21, b22, b23]
  // The constant 0x02 at payload[13] (wire byte 19) is the edge-record marker.
  return buildEnvelope(FN_PARAMETER_SETGET, [
    GRID_ROUTING_SUB_ACTION,
    0x00,
    0x00, 0x00, 0x00, 0x00,
    op,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x02,
    0x00,
    b21, b22, b23,
  ], modelByte);
}

// ── CLEAR / RESET GRID CELL (fn=0x01 sub=0x30, companion sub=0x33) ─
//
// Ghidra FACT-tier decode (2026-06-09 mine of
// `samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt`;
// table: `docs/_private/III-SUBACTIONS-MINE-2026-06-09.md`). The gen-3
// editor's "Clearing preset..." routine (FUN_140218f80, dump L9821-9976)
// loops gridPos 0..0x53 (84 = the III/FM9 6x14 grid cell count), and per
// cell emits a fn=0x01 sub=0x30 frame with the cell index in the value32
// field, then a sub=0x33 companion carrying the same index. The thin
// helper FUN_1403403e0 (dump L22283-22301) confirms the field map:
// blockId14=0, paramId14=0, value32=gridPos (raw uint32, NOT a float32),
// tailCount=0. After the loop, one final sub=0x30 with gridPos=0 is sent
// (dump L9977-9988).
//
// Wire (23 bytes, same skeleton as every fn=0x01 frame):
//
//   `F0 00 01 74 <model> 01 30 00 00 00 00 00 <gp_lo> <gp_hi> 00 00 00
//    00 00 00 00 <cks> F7`
//
// Cross-evidence: the byte-identical sub=0x30 frame was captured live as
// the block-insert "cell SELECT companion" (loopMIDI editor emulation,
// primitive [[gen3-fn01-grid-set-position-insert]]), with gridPos in the
// same 12-13 position. The mine grounds the semantics: the "Clearing
// preset..." string anchors sub=0x30 as the cell reset/clear (the insert
// transaction clears the target cell before inserting into it).
//
// Open points (decoded, hardware-unverified):
//   - Whether sub=0x30 alone deletes the block or the sub=0x33 companion
//     commits the clear is not disambiguated; the editor's clear loop
//     always sends the pair, the insert transaction sends 0x30 alone.
//   - The clear loop bound is 0x54 for ALL model bytes including FM3
//     (whose grid is 4x12 = 48 cells), so the index space may be a
//     model-agnostic 84-entry slot table rather than the literal grid.
//     For III/FM9 (6x14 = 84) the two readings coincide.
//
// Scope: the editor only emits these sub-actions for model bytes
// 0x10/0x11/0x12 (the dump's model gate). VP4 (0x14) has its own fn=0x01
// shape with no sub-action; do not use these builders for it.

export const SUB_ACTION_CLEAR_BLOCK = 0x30;
export const SUB_ACTION_CLEAR_BLOCK_COMPANION = 0x33;

function buildGridClearFrame(
  subAction: number,
  opts: { row: number; col: number; rows?: number },
  modelByte: number,
): number[] {
  const { row, col, rows = 6 } = opts;
  if (!Number.isInteger(rows) || rows < 1) {
    throw new Error(`buildClearBlock: rows must be a positive integer: ${rows}`);
  }
  if (!Number.isInteger(row) || row < 1 || row > rows) {
    throw new Error(`buildClearBlock: row out of range (1..${rows}): ${row}`);
  }
  if (!Number.isInteger(col) || col < 1 || col > 14) {
    throw new Error(`buildClearBlock: col out of range (1..14): ${col}`);
  }
  const gridPos = (col - 1) * rows + (row - 1);
  // Payload: [sub, pad, blockId14=0, paramId14=0, value32=gridPos
  // (raw uint32 5-septet, not float32), modifier14=0, tailCount14=0].
  return buildEnvelope(FN_PARAMETER_SETGET, [
    subAction,
    0x00,
    0x00, 0x00,
    0x00, 0x00,
    ...pack5Septet32(gridPos),
    0x00, 0x00,
    0x00, 0x00,
  ], modelByte);
}

/**
 * CLEAR / RESET GRID CELL (fn=0x01 sub=0x30): reset the block occupying
 * grid cell `(row, col)`. This is the editor's own per-cell clear op
 * (issued over every cell under "Clearing preset...") and the cell
 * companion it sends before a block insert. `rows` is the grid row
 * count: 6 for III/FM9 (default), 4 for FM3.
 *
 * Decoded from the Axe-Edit III binary (Ghidra, FACT tier: string
 * anchored) plus a live loopMIDI capture of the same frame; not yet
 * hardware-confirmed as a standalone delete. The editor's clear loop
 * follows each sub=0x30 with the `buildClearBlockCompanion` frame.
 */
export function buildClearBlock(
  opts: { row: number; col: number; rows?: number },
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  return buildGridClearFrame(SUB_ACTION_CLEAR_BLOCK, opts, modelByte);
}

/**
 * CLEAR-CELL COMPANION (fn=0x01 sub=0x33): the frame the editor's
 * "Clearing preset..." loop sends immediately after each sub=0x30, with
 * the same gridPos in the value32 field (the editor reuses its action
 * struct, so the index rides through; dump L9916-9925). Semantics not
 * separately anchored ("clear-preset companion step"); send it after
 * `buildClearBlock` to replicate the editor's exact clear sequence.
 */
export function buildClearBlockCompanion(
  opts: { row: number; col: number; rows?: number },
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  return buildGridClearFrame(SUB_ACTION_CLEAR_BLOCK_COMPANION, opts, modelByte);
}

/**
 * SELECT GRID CELL (fn=0x01 sub=0x30, gridPos only): move the edit cursor to
 * cell `(row, col)` WITHOUT changing grid state. Byte-identical to
 * `buildClearBlock`'s frame (the editor reuses one action struct), but its
 * role here is a cursor move, NOT a clear — it carries no sub=0x33 companion
 * (the 0x30+0x33 pair is the clear op).
 *
 * Why it exists separately: the FM3 (4-row grid) IGNORES a block INSERT's
 * target cell unless this select is sent first — an FM3 owner live-confirmed
 * this on hardware 2026-06-27 (sKuhLight/ForgeFX), whose FM3 codec sends
 * select → ~15 ms → insert. The Axe-Fx III and FM9 (6-row) place correctly
 * from the insert alone (hardware-confirmed: FM9 fn=0x13 read-back 2026-06-19),
 * so only the FM3 placement path pairs select+insert. Community-beta on FM3.
 */
export function buildSelectCell(
  opts: { row: number; col: number; rows?: number },
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  return buildGridClearFrame(SUB_ACTION_CLEAR_BLOCK, opts, modelByte);
}

// ── 0x09 SET_PRESET_NAME ───────────────────────────────────────────
//
// 🟡 NOT in v1.4 III spec — names are query-only there. Wire shape
// ported from the Axe-Fx II (function 0x09 takes 32 ASCII chars of
// the new working-buffer preset name). The III may honor it because
// the same firmware family handles 0x0D QUERY_PATCH_NAME; we test
// here and surface rejections.

const FN_SET_PRESET_NAME = 0x09;

/**
 * SET_PRESET_NAME (function 0x09) — set the working-buffer preset name.
 * Name is padded to 32 ASCII-printable chars (space-padded). The II
 * uses this for the working buffer only; pairing with the store op
 * (fn=0x01 sub=0x26) is what persists the rename to flash.
 *
 * 🟡 III-untested. The gen-3 editor's own name-write path is
 * `fn=0x01 sub=0x28` (`buildRenamePreset`, below), decoded from the
 * Axe-Edit III binary; prefer that one for gen-3 writes.
 */
export function buildSetPresetName(
  name: string,
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  if (name.length > 32) {
    throw new Error(`buildSetPresetName: name too long (max 32): "${name}" (${name.length})`);
  }
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      throw new Error(`buildSetPresetName: non-printable char at position ${i}: 0x${c.toString(16)}`);
    }
  }
  const padded = name.padEnd(32, ' ');
  return buildEnvelope(FN_SET_PRESET_NAME, [
    ...Array.from(padded, (c) => c.charCodeAt(0)),
  ], modelByte);
}

// ── NAME WRITES (fn=0x01 sub=0x28 preset, sub=0x2b scene) ──────────
//
// Ghidra FACT-tier decode (2026-06-09 mine of
// `ghidra-axe-edit-iii-actions-and-shapes.txt`; table:
// `docs/_private/III-SUBACTIONS-MINE-2026-06-09.md`). Two name-write
// sub-actions, both carrying a 32-byte raw name as the fn=0x01 tail:
//
//   sub=0x28  preset-name write. Helper FUN_140340560 (dump L8014-8053):
//             blockId14=0, paramId14=0, tailCount=32, tail = the 32-byte
//             name field. The "Clearing preset..." routine uses it to
//             write the literal "<EMPTY>" as the cleared preset's name
//             (dump L10410-10432), which is exactly what empty gen-3
//             preset slots display. value32 is 0 in that traced flow
//             (the preceding step writes 0; dump L10360).
//
//   sub=0x2b  indexed name write. Helper FUN_1403404a0 (dump
//             L10522-10561): blockId14=0, paramId14=INDEX, tailCount=32,
//             tail = the 32-byte name field. The "Clear All Names"
//             routine FUN_1402da550 (dump L17584-17612) loops index
//             0..7 with an empty name, matching the gen-3 8-scene count,
//             so the index is read as the scene index (decoded
//             inference; the indexed byte shape itself is exact).
//
// Tail encoding: the canonical fn=0x01 builder (FUN_14033ec70) sizes its
// payload as ceil(tailCount*8/7) + 15 and 8-to-7 septet-packs the tail
// (primitive [[iii-byte-stream-septet-pack-8to7]]); a 32-byte name packs
// to 37 wire bytes, total frame 60 bytes. The packer is byte-identical
// to `packValueChunked` (same sliding-window-with-carry algorithm,
// cross-asserted in the golden tests).
//
// PAD CAVEAT: the editor formats the 32-byte field via FUN_140386ac0,
// whose body is not in any dump we hold, so the pad byte for names
// shorter than 32 chars is NOT cited. We space-pad (0x20), matching
// every Fractal 32-char name field decoded so far (AM4 rename,
// hardware-confirmed space-pad from `session-20-rename-preset.pcapng`;
// II fn=0x09; gen-3 fn=0x0d responses). Flagged for capture
// confirmation.
//
// Scope: model bytes 0x10/0x11/0x12 only (the dump's model gate); VP4
// (0x14) has its own fn=0x01 shape. Decoded, hardware-unverified.

export const SUB_ACTION_SET_PRESET_NAME = 0x28;
export const SUB_ACTION_SET_SCENE_NAME = 0x2b;

const NAME_FIELD_BYTES = 32;

/** Validate and space-pad a name into the 32-byte raw field. */
function encodeName32(name: string, builder: string): Uint8Array {
  if (name.length > NAME_FIELD_BYTES) {
    throw new Error(`${builder}: name too long (max ${NAME_FIELD_BYTES}): "${name}" (${name.length})`);
  }
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      throw new Error(`${builder}: non-printable char at position ${i}: 0x${c.toString(16)}`);
    }
  }
  const raw = new Uint8Array(NAME_FIELD_BYTES).fill(0x20);
  for (let i = 0; i < name.length; i++) raw[i] = name.charCodeAt(i);
  return raw;
}

function buildFn01NameFrame(
  subAction: number,
  paramId: number,
  name: string,
  builder: string,
  modelByte: number,
): number[] {
  const tail = packValueChunked(encodeName32(name, builder));
  // Payload: [sub, pad, blockId14=0, paramId14, value32=0, modifier14=0,
  // tailCount14=32, 8-to-7-packed 32-byte name (37 wire bytes)].
  return buildEnvelope(FN_PARAMETER_SETGET, [
    subAction,
    0x00,
    0x00, 0x00,
    ...encode14(paramId),
    0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00,
    ...encode14(NAME_FIELD_BYTES),
    ...tail,
  ], modelByte);
}

/**
 * RENAME PRESET (fn=0x01 sub=0x28): write the working-buffer preset
 * name. This is the gen-3 editor's own name-write path (it supersedes
 * the fn=0x09 II-port hypothesis in `buildSetPresetName` for gen-3).
 * Persisting the rename to flash still requires the store op
 * (`buildStorePreset`, fn=0x01 sub=0x26).
 *
 * Decoded from the Axe-Edit III binary (Ghidra FACT tier); pad byte
 * convention-based (see section comment). Hardware-unverified.
 */
export function buildRenamePreset(
  name: string,
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  return buildFn01NameFrame(SUB_ACTION_SET_PRESET_NAME, 0, name, 'buildRenamePreset', modelByte);
}

/**
 * SET SCENE NAME (fn=0x01 sub=0x2b): write the name of scene
 * `sceneIndex` (0..7). The byte shape (index in the paramId14 field,
 * 32-byte name tail) is exact per the dump; the scene-index reading of
 * the field rests on the editor's "Clear All Names" loop running
 * exactly 0..7. Decoded, hardware-unverified.
 */
export function buildSetSceneName(
  sceneIndex: number,
  name: string,
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex > 7) {
    throw new Error(`buildSetSceneName: sceneIndex ${sceneIndex} out of range (0..7)`);
  }
  return buildFn01NameFrame(SUB_ACTION_SET_SCENE_NAME, sceneIndex, name, 'buildSetSceneName', modelByte);
}

/**
 * CLEAR ALL SCENE NAMES: the 8-frame sequence the editor's "Clear All
 * Names" command emits (fn=0x01 sub=0x2b, index 0..7, empty name each;
 * FUN_1402da550). Returns the frames in emission order; send them
 * back-to-back to replicate the editor. Decoded, hardware-unverified.
 */
export function buildClearAllSceneNames(
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[][] {
  const frames: number[][] = [];
  for (let i = 0; i < 8; i++) frames.push(buildSetSceneName(i, '', modelByte));
  return frames;
}

// ── STORE_PRESET (fn=0x01 sub=0x26) ────────────────────────────────
//
// The gen-3 editor saves the working buffer to a preset location with
// fn=0x01 sub-action 0x26. This is the editor's own outbound store op,
// captured byte-exact from FM9-Edit (model 0x12) AND AxeEdit III (model
// 0x10) driven over loopMIDI (no hardware); the two captures produced
// the byte-identical frame apart from the model byte. See the primitive
// entry [[gen3-fn01-store-preset]] and the golden
// `scripts/primitives-verify.ts#case-gen3-fn01-store-preset`.
//
// This supersedes the earlier fn=0x1D guess (a II-ported opcode that was
// never confirmed for gen-3 and kept gen-3 save in community-beta refusal).
//
// Wire envelope:
//
//   `F0 00 01 74 <model> 01 26 00 00 00 00 00 <pn_lo> <pn_hi>
//    00 00 00 00 00 00 00 <cks> F7`
//
// presetNumber is a septet-encoded 14-bit field at payload positions
// 12-13 (LSB-first: byte 12 = low septet) per [[septet-14bit]]. Saving
// in place stores to the active preset number. The high septet (byte 13)
// was zero in every fixture (in-place=0, 10, 5, all < 128); presets
// >= 128 are the natural septet extension but not yet directly captured.
// Note this LSB-first layout differs from the fn=0x03 preset-dump
// REQUEST, whose preset number is big-endian.

const FN_STORE_PRESET = FN_PARAMETER_SETGET; // 0x01
const STORE_SUB_ACTION = 0x26;

/**
 * STORE_PRESET (fn=0x01 sub=0x26): persist the working buffer to preset
 * location `presetNumber`. Wire-confirmed across model 0x10 and 0x12; see
 * the primitive [[gen3-fn01-store-preset]] entry.
 */
export function buildStorePreset(
  presetNumber: number,
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  if (!Number.isInteger(presetNumber) || presetNumber < 0 || presetNumber > 0x3fff) {
    throw new Error(`buildStorePreset: preset out of range (0..16383): ${presetNumber}`);
  }
  // Payload: [sub-action, 5 pad, pn_lo, pn_hi, 7 pad]. presetNumber sits
  // at payload positions 6-7 (envelope bytes 12-13), septet-encoded.
  return buildEnvelope(FN_STORE_PRESET, [
    STORE_SUB_ACTION,
    0x00, 0x00, 0x00, 0x00, 0x00,
    ...encode14(presetNumber),
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ], modelByte);
}

// ── SCENE-BLOB TRANSFER (standalone fn=0x5a header + fn=0x5c trailer) ─
//
// Ghidra FACT-tier decode (2026-06-09 mine of
// `ghidra-axe-edit-iii-actions-and-shapes.txt`, PART B; table:
// `docs/_private/III-SUBACTIONS-MINE-2026-06-09.md`). The emitter
// FUN_140328a10 (dump L22861-23053) builds a scene-targeted DATA
// TRANSFER, not a bare scene switch:
//
//   1. fn=0x5a header, 6-byte payload (dump L22925-22941):
//        byte 0    scene & 0x7f             (FACT: scene number)
//        bytes 1-2 septet14(arg)            (caller-supplied 14-bit arg;
//                                            semantics uncited)
//        bytes 3-5 septet21(dataWordCount)  (uint32-word count of the
//                                            data that follows)
//   2. the data, streamed in chunks of up to 0x100 uint32 words
//      (chunk-frame shape not decoded; FUN_1403359b0).
//   3. fn=0x5c trailer, 5-byte payload = 5-septet XOR-32 checksum over
//      all data words (XOR loop dump L23000-23019; emission L23025-23039;
//      standalone form FUN_140336a40 L23059-23086. Byte 4 carries only
//      the top 4 bits: `(xor32 >>> 28) & 0x0f`).
//
// The dump generator labeled this "fn=0x15 Change Scene"; the body shows
// the real fn bytes are 0x5a/0x5c. The editor NEVER emits a bare fn=0x5a
// with no data (a null data pointer aborts before any send, dump
// L22915), so a zero-filled "switch scene" form of this frame would be a
// guessed wire shape and is deliberately NOT provided. For a plain scene
// switch use the spec-documented fn=0x0c (`buildSetScene`).
//
// What the blob payload IS (per-scene state? scene-manager copy?) is
// undecoded; these builders exist so the header/trailer framing is
// available to capture-replay and future decode work. Decoded,
// hardware-unverified.

export const FN_SCENE_BLOB_HEADER = 0x5a;
export const FN_SCENE_BLOB_CHECKSUM = 0x5c;

/**
 * Scene-blob transfer HEADER (fn=0x5a). `scene` rides in payload byte 0
 * (FACT); `arg14` is the caller-supplied 14-bit field at bytes 1-2
 * (semantics uncited; the editor passes a runtime value); `dataWordCount`
 * is the uint32-word count of the data that will follow (21-bit septet
 * at bytes 3-5). This is NOT a scene switch; see the section comment.
 */
export function buildSceneBlobHeader(
  opts: { scene: number; arg14: number; dataWordCount: number },
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  const { scene, arg14, dataWordCount } = opts;
  if (!Number.isInteger(scene) || scene < 0 || scene > 7) {
    throw new Error(`buildSceneBlobHeader: scene ${scene} out of range (0..7)`);
  }
  if (!Number.isInteger(arg14) || arg14 < 0 || arg14 > 0x3fff) {
    throw new Error(`buildSceneBlobHeader: arg14 ${arg14} out of range (0..16383)`);
  }
  if (!Number.isInteger(dataWordCount) || dataWordCount < 0 || dataWordCount > 0x1fffff) {
    throw new Error(`buildSceneBlobHeader: dataWordCount ${dataWordCount} out of range (0..2097151)`);
  }
  return buildEnvelope(FN_SCENE_BLOB_HEADER, [
    scene & 0x7f,
    ...encode14(arg14),
    dataWordCount & 0x7f,
    (dataWordCount >> 7) & 0x7f,
    (dataWordCount >> 14) & 0x7f,
  ], modelByte);
}

/**
 * Scene-blob transfer CHECKSUM trailer (fn=0x5c). `xor32` is the XOR of
 * all uint32 data words (compute with `xorChecksum32Words`); it rides as
 * a 5-septet LSB-first field whose top byte carries only bits 28-31.
 */
export function buildSceneBlobChecksum(
  xor32: number,
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  if (!Number.isInteger(xor32) || xor32 < 0 || xor32 > 0xffffffff) {
    throw new Error(`buildSceneBlobChecksum: xor32 out of range (0..2^32-1): ${xor32}`);
  }
  return buildEnvelope(FN_SCENE_BLOB_CHECKSUM, [
    xor32 & 0x7f,
    (xor32 >>> 7) & 0x7f,
    (xor32 >>> 14) & 0x7f,
    (xor32 >>> 21) & 0x7f,
    (xor32 >>> 28) & 0x0f,
  ], modelByte);
}

/** XOR-32 checksum over uint32 data words, as the fn=0x5c trailer expects. */
export function xorChecksum32Words(words: readonly number[]): number {
  let acc = 0;
  for (const w of words) acc = (acc ^ w) >>> 0;
  return acc >>> 0;
}

// ── MIDI Program Change (preset switch via standard MIDI) ──────────
//
// The III v1.4 spec says: "To CHANGE the active preset on the III via
// MIDI, use standard Program Change messages (with CC 0 + CC 32 Bank
// Select for slots > 127)." This is NOT a SysEx envelope — it's
// 3 short MIDI messages back-to-back. The III is documented to honor
// these without any firmware-version caveats.

/**
 * Build the short-MIDI byte sequence to switch the III to preset
 * `presetNumber` (0..1023). Returns 9 bytes:
 *
 *   `B0 00 bankMsb`     (Control Change 0 = Bank Select MSB)
 *   `B0 20 bankLsb`     (Control Change 32 = Bank Select LSB)
 *   `C0 programNumber`  (Program Change on channel 1)
 *
 * Default MIDI channel is 1 (0x0 in the channel nibble). The III
 * listens on its globally-configured MIDI channel — users with a
 * non-default channel will need a `channel` arg (1..16) on the unified
 * `switch_preset` on a future iteration. For now we default
 * to channel 1, which matches Fractal's factory setting.
 *
 * Per the III v1.4 PDF: 1024 presets are addressed across 8 banks of
 * 128 each. presetNumber 0..127 = bank 0 PC 0..127, presetNumber
 * 128..255 = bank 1 PC 0..127, etc.
 *
 * BANK-SELECT ENCODING DIVERGES BY DEVICE:
 *   - `'standard'` (default; Axe-Fx III per the v1.4 spec): the device
 *     reads bank = (CC0 << 7) | CC32, so CC0 = bank>>7 (MSB) and CC32 =
 *     bank&0x7f (LSB). For banks 0..7 CC0 is 0 and CC32 carries the bank.
 *   - `'msb'` (FM9, hardware-confirmed on a real unit 2026-06-06 via the
 *     community fm9-catalog probe; FM3 fw 12.00 field-confirmed to IGNORE
 *     CC32 on 2026-06-12 — a 'standard' switch to preset 438 landed on
 *     54 = 438 mod 128, so the FM3 is NOT 'standard' despite the v1.4
 *     spec naming it): the device reads the bank from CC0/MSB and
 *     IGNORES CC32. With the standard encoding, any preset above 127 (bank
 *     >0) lands in bank 0 because the bank sits in CC32, which gets dropped.
 *     So the bank must go in CC0; CC32 is sent as 0 (ignored).
 *     Note the FM3's default switch_preset path is the SysEx-native
 *     sub=0x27 switch (FM3-hardware-confirmed), not PC — see
 *     buildSwitchPresetSysEx.
 *
 * This is a per-device read divergence with no single universal encoding
 * (a CC0-only reader and a (CC0<<7)|CC32 reader cannot both be satisfied for
 * bank>0), so the mode is selected per device via the codec config. AM4 and
 * Axe-Fx II switch presets over SysEx, not PC+bank, and are unaffected.
 */
export type Gen3BankSelectMode = 'standard' | 'msb';

export function buildSwitchPresetPC(
  presetNumber: number,
  channel: number = 1,
  bankSelect: Gen3BankSelectMode = 'standard',
): number[] {
  if (!Number.isInteger(presetNumber) || presetNumber < 0 || presetNumber > 1023) {
    throw new Error(
      `buildSwitchPresetPC: presetNumber ${presetNumber} out of range (0..1023).`,
    );
  }
  if (!Number.isInteger(channel) || channel < 1 || channel > 16) {
    throw new Error(`buildSwitchPresetPC: channel ${channel} out of range (1..16).`);
  }
  const ch0 = (channel - 1) & 0x0f;
  const bank = Math.floor(presetNumber / 128);
  const pc = presetNumber % 128;
  const [bankMsb, bankLsb] =
    bankSelect === 'msb'
      ? [bank & 0x7f, 0]                       // FM9: bank in CC0, CC32 ignored
      : [(bank >> 7) & 0x7f, bank & 0x7f];     // standard: (CC0<<7)|CC32
  return [
    0xb0 | ch0, 0x00, bankMsb, // CC 0 = Bank MSB
    0xb0 | ch0, 0x20, bankLsb, // CC 32 = Bank LSB
    0xc0 | ch0, pc & 0x7f,     // Program Change
  ];
}

// ── SWITCH PRESET via SysEx (fn=0x01 sub=0x27) ─────────────────────
//
// The gen-3 editor switches the active preset with an undocumented
// fn=0x01 sub-action 0x27 — a SysEx-native alternative to the MIDI
// Program Change + Bank Select path above. Captured from FM3-Edit and
// live-confirmed on FM3 fw 12.00 hardware (BoodieTraps, 2026-06-10): a
// server-issued frame switched the unit from preset 475 to 100.
//
// Two things this clears up about the gen-3 fn=0x01 family:
//   • The "wiki / AxeFxControl set-preset" function fn=0x3C is a HARD
//     NACK on FM3 — the unit replies fn=0x64 (multipurpose) with result
//     0x05, the same received-but-rejected signature as the legacy
//     fn=0x02 mistake. Do NOT emit fn=0x3C. (We never did; our default
//     switch_preset uses Program Change — see buildSwitchPresetPC.)
//   • The preset number in this frame is a PLAIN 14-bit LE septet int at
//     value pos 12 (encode14, same packing as the effectId/paramId
//     fields), NOT the 5-septet float32 that the discrete (0x09) /
//     continuous (0x52) value field carries. So the pos-12 value slot in
//     a gen-3 fn=0x01 frame is int-or-float depending on sub-action. It
//     is also LITTLE-endian here, unlike the BIG-endian preset# in the
//     fn=0x03 REQUEST_PRESET_DUMP request.
//
// Wire envelope (23 bytes), byte-exact vs the FM3 capture:
//
//   F0 00 01 74 <model> 01 27 00 00 00 00 00 <preset_lo preset_hi>
//      00 00 00 00 00 00 00 <cks> F7
//
// blockId14 and paramId14 are both zero (pos 8-11). gen-3 family-shared
// (model 0x10/0x11/0x12); FM3-confirmed, III/FM9 share the codec and are
// hardware-unverified for this sub-action.

/** Preset-switch sub-action for the gen-3 fn=0x01 SysEx-native path. */
export const SUB_ACTION_SWITCH_PRESET: readonly [number, number] = [0x27, 0x00];

/**
 * SWITCH PRESET via SysEx (fn=0x01 sub=0x27). The preset number rides as a
 * 14-bit LE septet int at payload pos 12 (NOT a float32; NOT the BE form the
 * fn=0x03 dump request uses). FM3-confirmed (BoodieTraps, 2026-06-10): a
 * server-issued frame moved the unit 475→100.
 *
 * This is a SysEx-native alternative to {@link buildSwitchPresetPC} (MIDI
 * Program Change + Bank Select). The codec's default switch_preset path stays
 * Program Change; this builder is exposed for callers that prefer the
 * SysEx-native route (no MIDI channel / bank-select-mode dependency). Do NOT
 * use fn=0x3C — it hard-NACKs on FM3.
 */
export function buildSwitchPresetSysEx(
  presetNumber: number,
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  if (!Number.isInteger(presetNumber) || presetNumber < 0 || presetNumber > 0x3fff) {
    throw new Error(
      `buildSwitchPresetSysEx: preset out of range (0..16383): ${presetNumber}`,
    );
  }
  return buildEnvelope(FN_PARAMETER_SETGET, [
    ...SUB_ACTION_SWITCH_PRESET,
    0x00, 0x00, // blockId14 = 0
    0x00, 0x00, // paramId14 = 0
    ...encode14(presetNumber), // preset# = 14-bit LE int at pos 12
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 7 trailing zeros
  ], modelByte);
}

// ── 0x0A SET/GET BYPASS ────────────────────────────────────────────

/**
 * SET BYPASS (function 0x0A). Targets the active scene only — per
 * spec the III's bypass writes don't carry a scene argument.
 *
 *   `F0 00 01 74 10 0A [id_lo] [id_hi] [dd] [cs] F7`
 *
 * `dd=0` engaged, `dd=1` bypassed.
 */
export function buildSetBypass(
  effectId: number,
  bypassed: boolean,
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  return buildEnvelope(FN_SET_GET_BYPASS, [
    ...encode14(effectId),
    bypassed ? 1 : 0,
  ], modelByte);
}

/** GET BYPASS (function 0x0A with `dd=0x7F`). Device responds with same envelope shape. */
export function buildGetBypass(effectId: number): number[] {
  return buildEnvelope(FN_SET_GET_BYPASS, [
    ...encode14(effectId),
    QUERY_SENTINEL,
  ]);
}

// ── 0x0B SET/GET CHANNEL ───────────────────────────────────────────

/**
 * SET CHANNEL (function 0x0B). Targets the active scene only.
 * `channel` is 0..3 mapping to A..D.
 *
 *   `F0 00 01 74 10 0B [id_lo] [id_hi] [channel] [cs] F7`
 */
export function buildSetChannel(
  effectId: number,
  channel: 0 | 1 | 2 | 3,
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  if (!Number.isInteger(channel) || channel < 0 || channel > 3) {
    throw new Error(`buildSetChannel: channel ${channel} out of range (0..3 = A..D)`);
  }
  return buildEnvelope(FN_SET_GET_CHANNEL, [
    ...encode14(effectId),
    channel,
  ], modelByte);
}

/** GET CHANNEL (function 0x0B with `dd=0x7F`). */
export function buildGetChannel(effectId: number): number[] {
  return buildEnvelope(FN_SET_GET_CHANNEL, [
    ...encode14(effectId),
    QUERY_SENTINEL,
  ]);
}

// ── 0x0C SET/GET SCENE ─────────────────────────────────────────────

/**
 * SET SCENE (function 0x0C). `sceneIndex` is 0..7. Spec also says
 * "Returns: ... where dd is the current scene" — so SET also echoes.
 */
export function buildSetScene(
  sceneIndex: number,
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex > 7) {
    throw new Error(`buildSetScene: sceneIndex ${sceneIndex} out of range (0..7)`);
  }
  return buildEnvelope(FN_SET_GET_SCENE, [sceneIndex & 0x7f], modelByte);
}

/** GET SCENE (function 0x0C with `dd=0x7F`). */
export function buildGetScene(modelByte: number = AXE_FX_III_MODEL_ID): number[] {
  return buildEnvelope(FN_SET_GET_SCENE, [QUERY_SENTINEL], modelByte);
}

// ── 0x0D QUERY PATCH NAME ──────────────────────────────────────────

/**
 * QUERY PATCH NAME (function 0x0D).
 *
 *   Request:  `F0 00 01 74 10 0D [dd dd preset#] [cs] F7`
 *   Current:  `F0 00 01 74 10 0D 7F 7F [cs] F7`
 *   Response: `F0 00 01 74 10 0D [nn nn preset#] [dd*32 name] [cs] F7`
 *
 * Pass a preset number 0..1023 (Mark II) / 0..511 (Mark I) to look
 * up that preset's name, or `'current'` to query the active preset.
 * Response contains BOTH the preset number AND the name — there's no
 * separate "get preset number" function in the v1.4 spec.
 *
 * NB: this is NOT a preset-switching command. To CHANGE the active
 * preset on the III via MIDI, use standard Program Change messages
 * (with CC 0 + CC 32 Bank Select for slots > 127). The III has no
 * SysEx preset-switch in the v1.4 public spec.
 */
export function buildQueryPatchName(
  presetNumber: number | 'current',
  modelByte: number = AXE_FX_III_MODEL_ID,
): number[] {
  if (presetNumber === 'current') {
    return buildEnvelope(FN_QUERY_PATCH_NAME, [QUERY_SENTINEL, QUERY_SENTINEL], modelByte);
  }
  if (!Number.isInteger(presetNumber) || presetNumber < 0 || presetNumber > 1023) {
    throw new Error(
      `buildQueryPatchName: presetNumber ${presetNumber} out of range (0..1023).`,
    );
  }
  return buildEnvelope(FN_QUERY_PATCH_NAME, encode14(presetNumber), modelByte);
}

// ── 0x0E QUERY SCENE NAME ──────────────────────────────────────────

/**
 * QUERY SCENE NAME (function 0x0E).
 *
 *   Request:  `F0 00 01 74 10 0E [dd scene] [cs] F7`
 *   Current:  `F0 00 01 74 10 0E 7F [cs] F7`
 *   Response: `F0 00 01 74 10 0E [nn scene] [dd*32 name] [cs] F7`
 *
 * No SET variant in the spec.
 */
export function buildQuerySceneName(sceneIndex: number | 'current'): number[] {
  if (sceneIndex === 'current') {
    return buildEnvelope(FN_QUERY_SCENE_NAME, [QUERY_SENTINEL]);
  }
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex > 7) {
    throw new Error(
      `buildQuerySceneName: sceneIndex ${sceneIndex} out of range (0..7).`,
    );
  }
  return buildEnvelope(FN_QUERY_SCENE_NAME, [sceneIndex & 0x7f]);
}

// ── 0x0F SET/GET LOOPER STATE ──────────────────────────────────────

export type LooperAction =
  | 'record'    // 0
  | 'play'      // 1
  | 'undo'      // 2
  | 'once'      // 3
  | 'reverse'   // 4
  | 'half_speed'; // 5

const LOOPER_ACTION_VALUES: Record<LooperAction, number> = {
  record: 0,
  play: 1,
  undo: 2,
  once: 3,
  reverse: 4,
  half_speed: 5,
};

/**
 * SET LOOPER (function 0x0F). Triggers a looper "button press":
 *
 *   `F0 00 01 74 10 0F [dd button] [cs] F7`
 *
 * Buttons per spec: 0=Record, 1=Play, 2=Undo, 3=Once, 4=Reverse,
 * 5=Half-speed.
 */
export function buildSetLooper(action: LooperAction): number[] {
  return buildEnvelope(FN_SET_GET_LOOPER, [LOOPER_ACTION_VALUES[action]]);
}

/**
 * GET LOOPER STATE (function 0x0F with `dd=0x7F`). Returns a state
 * bitfield: bit 0=Record, 1=Play, 2=Overdub, 3=Once, 4=Reverse,
 * 5=Half-speed.
 */
export function buildGetLooperState(): number[] {
  return buildEnvelope(FN_SET_GET_LOOPER, [QUERY_SENTINEL]);
}

// ── 0x10 TEMPO TAP ─────────────────────────────────────────────────

/**
 * TEMPO TAP (function 0x10). Single-shot, no payload. Each call
 * counts as one tap-tempo press; the III computes BPM from the
 * inter-tap interval the same way as the front-panel TAP button.
 */
export function buildTempoTap(): number[] {
  return buildEnvelope(FN_TEMPO_TAP, []);
}

// ── 0x11 TUNER ON/OFF ──────────────────────────────────────────────

/** TUNER ON/OFF (function 0x11). */
export function buildSetTuner(on: boolean): number[] {
  return buildEnvelope(FN_TUNER_ON_OFF, [on ? 1 : 0]);
}

// ── 0x13 STATUS DUMP ───────────────────────────────────────────────

/**
 * STATUS DUMP (function 0x13). One-shot snapshot of the current
 * scene's state across all effect blocks in the preset. Response is
 * a sequence of `id id dd` triples — see `parseStatusDumpResponse`.
 */
export function buildStatusDump(modelByte: number = AXE_FX_III_MODEL_ID): number[] {
  return buildEnvelope(FN_STATUS_DUMP, [], modelByte);
}

// ── 0x14 SET/GET TEMPO ─────────────────────────────────────────────

/**
 * SET TEMPO (function 0x14). BPM as a 14-bit value (LS-first septet
 * pair). Range per spec is implicitly 0..16383; in practice the III
 * accepts ~30..250 BPM (front-panel range).
 */
export function buildSetTempo(bpm: number): number[] {
  if (!Number.isInteger(bpm) || bpm < 0 || bpm > 0x3fff) {
    throw new Error(`buildSetTempo: bpm ${bpm} out of range (0..16383)`);
  }
  return buildEnvelope(FN_SET_GET_TEMPO, encode14(bpm));
}

/** GET TEMPO (function 0x14 with `dd dd = 7F 7F`). */
export function buildGetTempo(modelByte: number = AXE_FX_III_MODEL_ID): number[] {
  return buildEnvelope(FN_SET_GET_TEMPO, [QUERY_SENTINEL, QUERY_SENTINEL], modelByte);
}

// ── Response predicates + parsers ──────────────────────────────────

function isAxeFxIIIFrame(
  bytes: readonly number[],
  fn: number,
  modelByte: number = AXE_FX_III_MODEL_ID,
): boolean {
  if (bytes.length < 7) return false;
  if (bytes[0] !== SYSEX_START) return false;
  if (bytes[1] !== FRACTAL_MFR_PREFIX[0]) return false;
  if (bytes[2] !== FRACTAL_MFR_PREFIX[1]) return false;
  if (bytes[3] !== FRACTAL_MFR_PREFIX[2]) return false;
  if (bytes[4] !== modelByte) return false;
  if (bytes[5] !== fn) return false;
  if (bytes[bytes.length - 1] !== SYSEX_END) return false;
  return true;
}

/**
 * Decode an ASCII payload that's space- or null-padded. III name
 * responses are 32-char ASCII fields padded with spaces.
 */
function decodeName(bytes: readonly number[]): string {
  let end = bytes.length;
  while (end > 0) {
    const b = bytes[end - 1];
    if (b !== 0x00 && b !== 0x20) break;
    end -= 1;
  }
  return String.fromCharCode(...bytes.slice(0, end));
}

export function isSetGetBypassResponse(bytes: readonly number[]): boolean {
  return isAxeFxIIIFrame(bytes, FN_SET_GET_BYPASS);
}
export function isSetGetChannelResponse(bytes: readonly number[]): boolean {
  return isAxeFxIIIFrame(bytes, FN_SET_GET_CHANNEL);
}
export function isSetGetSceneResponse(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): boolean {
  return isAxeFxIIIFrame(bytes, FN_SET_GET_SCENE, modelByte);
}
export function isQueryPatchNameResponse(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): boolean {
  return isAxeFxIIIFrame(bytes, FN_QUERY_PATCH_NAME, modelByte);
}
export function isQuerySceneNameResponse(bytes: readonly number[]): boolean {
  return isAxeFxIIIFrame(bytes, FN_QUERY_SCENE_NAME);
}
export function isSetGetLooperResponse(bytes: readonly number[]): boolean {
  return isAxeFxIIIFrame(bytes, FN_SET_GET_LOOPER);
}
export function isStatusDumpResponse(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): boolean {
  return isAxeFxIIIFrame(bytes, FN_STATUS_DUMP, modelByte);
}
export function isSetGetTempoResponse(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): boolean {
  return isAxeFxIIIFrame(bytes, FN_SET_GET_TEMPO, modelByte);
}
export function isMultipurposeResponse(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
  expectedFn?: number,
): boolean {
  if (!isAxeFxIIIFrame(bytes, FN_MULTIPURPOSE_RESPONSE, modelByte)) return false;
  // A rejection body is `[echoed_fn, result_code]` (2 bytes; allow up to 4 for
  // any variant). 0x64 is OVERLOADED on the gen-3 wire as a continuous
  // tuner/tempo status STREAM whose body is longer, so a bare fn==0x64 test is
  // not enough: reject anything outside the 2..4 body shape here, or a stray
  // status frame in a write's reject-watch window gets mis-parsed as a
  // rejection with a garbage result code (a false-reject footgun).
  const payload = bytes.slice(6, -2);
  if (payload.length < 2 || payload.length > 4) return false;
  // When the caller knows which function it just sent, require the response to
  // ECHO that function (payload[0]); a 0x64 rejecting a different or earlier op
  // is not this write's rejection. Matches ForgeFX's Fm3Device echoed-fn guard.
  if (expectedFn !== undefined && (payload[0] & 0x7f) !== (expectedFn & 0x7f)) return false;
  return true;
}

/**
 * Parse a 0x0A SET/GET BYPASS response. Payload is `[id_lo, id_hi, dd]`.
 */
export function parseBypassResponse(bytes: readonly number[]): {
  effectId: number;
  bypassed: boolean;
} {
  if (!isSetGetBypassResponse(bytes)) {
    throw new Error(`parseBypassResponse: not a 0x0A frame (len=${bytes.length})`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length < 3) throw new Error(`parseBypassResponse: payload too short`);
  return {
    effectId: decode14(payload[0], payload[1]),
    bypassed: (payload[2] & 0x01) !== 0,
  };
}

/** Parse a 0x0B SET/GET CHANNEL response. */
export function parseChannelResponse(bytes: readonly number[]): {
  effectId: number;
  channel: number;
} {
  if (!isSetGetChannelResponse(bytes)) {
    throw new Error(`parseChannelResponse: not a 0x0B frame`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length < 3) throw new Error(`parseChannelResponse: payload too short`);
  return {
    effectId: decode14(payload[0], payload[1]),
    channel: payload[2] & 0x07,
  };
}

/** Parse a 0x0C SET/GET SCENE response. Payload is `[scene]`. */
export function parseSceneResponse(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): { scene: number } {
  if (!isSetGetSceneResponse(bytes, modelByte)) {
    throw new Error(`parseSceneResponse: not a 0x0C frame`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length < 1) throw new Error('parseSceneResponse: empty payload');
  return { scene: payload[0] & 0x07 };
}

/**
 * Parse a 0x0D QUERY PATCH NAME response.
 *
 *   `F0 00 01 74 10 0D [nn nn preset#] [dd*32 name] [cs] F7`
 *
 * Returns both the preset number AND the 32-char name (trimmed).
 */
export function parseQueryPatchNameResponse(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): {
  presetNumber: number;
  name: string;
} {
  if (!isQueryPatchNameResponse(bytes, modelByte)) {
    throw new Error(`parseQueryPatchNameResponse: not a 0x0D frame (len=${bytes.length})`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length < 2) {
    throw new Error(`parseQueryPatchNameResponse: payload too short (${payload.length}B)`);
  }
  const presetNumber = decode14(payload[0], payload[1]);
  const name = decodeName(payload.slice(2));
  return { presetNumber, name };
}

/**
 * Parse a 0x0E QUERY SCENE NAME response.
 *
 *   `F0 00 01 74 10 0E [nn scene] [dd*32 name] [cs] F7`
 */
export function parseQuerySceneNameResponse(bytes: readonly number[]): {
  scene: number;
  name: string;
} {
  if (!isQuerySceneNameResponse(bytes)) {
    throw new Error(`parseQuerySceneNameResponse: not a 0x0E frame`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length === 0) throw new Error('parseQuerySceneNameResponse: empty payload');
  const scene = payload[0] & 0x07;
  const name = decodeName(payload.slice(1));
  return { scene, name };
}

/**
 * Parse a 0x0F SET/GET LOOPER STATE response. dd is a bitfield:
 * bit0=Record, 1=Play, 2=Overdub, 3=Once, 4=Reverse, 5=Half-speed.
 */
export interface LooperState {
  recording: boolean;
  playing: boolean;
  overdubbing: boolean;
  once: boolean;
  reverse: boolean;
  halfSpeed: boolean;
  raw: number;
}

export function parseLooperStateResponse(bytes: readonly number[]): LooperState {
  if (!isSetGetLooperResponse(bytes)) {
    throw new Error(`parseLooperStateResponse: not a 0x0F frame`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length === 0) throw new Error('parseLooperStateResponse: empty payload');
  const dd = payload[0] & 0x7f;
  return {
    recording:    (dd & 0x01) !== 0,
    playing:      (dd & 0x02) !== 0,
    overdubbing:  (dd & 0x04) !== 0,
    once:         (dd & 0x08) !== 0,
    reverse:      (dd & 0x10) !== 0,
    halfSpeed:    (dd & 0x20) !== 0,
    raw: dd,
  };
}

/** Parse a 0x14 SET/GET TEMPO response. Payload is the BPM as a septet pair. */
export function parseTempoResponse(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): { bpm: number } {
  if (!isSetGetTempoResponse(bytes, modelByte)) {
    throw new Error(`parseTempoResponse: not a 0x14 frame`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length < 2) throw new Error('parseTempoResponse: payload too short');
  return { bpm: decode14(payload[0], payload[1]) };
}

/**
 * Parse a 0x64 MULTIPURPOSE_RESPONSE frame. Payload is `[echoed_fn, result_code]`.
 *
 *   `F0 00 01 74 10 64 [echoed_fn] [result_code] [cs] F7`
 *
 * Known `result_code` meanings (incomplete — Fractal doesn't publish a
 * full table):
 *   - `0x00` — general / checksum error
 *   - `0x05` — NACK (seen during preset-store experiments)
 *
 * Anything else surfaces as the raw byte. Callers convert this to a
 * warning string in their tool response.
 */
export function parseMultipurposeResponse(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): {
  echoedFn: number;
  resultCode: number;
} {
  if (!isMultipurposeResponse(bytes, modelByte)) {
    throw new Error(`parseMultipurposeResponse: not a 0x64 frame (len=${bytes.length})`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length < 2) {
    throw new Error(`parseMultipurposeResponse: payload too short (${payload.length}B)`);
  }
  return { echoedFn: payload[0] & 0x7f, resultCode: payload[1] & 0x7f };
}

/**
 * Human-readable label for a known `result_code` byte. Returns
 * `undefined` for codes not yet documented; callers fall back to the
 * raw hex value.
 *
 * Source: AxeEdit III 1.14.31 release binary contains a contiguous
 * 8-byte-aligned `MIDI_ERROR_*` string table at `.rdata` offset
 * 0x597108 onward. Entries are accessed by result_code as index.
 * Index 0 = `MIDI_ERROR_BAD_CHKSUM` matches the empirically-verified
 * 0x64 frame whose host-side trigger was a malformed checksum, so the
 * index → result_code mapping is high-confidence. Codes 0x00..0x1B
 * are populated; anything ≥ 0x1C returns undefined.
 *
 * See `docs/axefx3-fn01-decode.md` "0x64 result codes" for the full
 * decode + index-table evidence.
 */
export function describeMultipurposeResultCode(code: number): string | undefined {
  switch (code & 0x7f) {
    case 0x00: return 'bad checksum (MIDI_ERROR_BAD_CHKSUM)';
    case 0x01: return 'wrong SysEx manufacturer ID (MIDI_ERROR_WRONG_SYSEX_ID)';
    case 0x02: return 'wrong model number (MIDI_ERROR_WRONG_MODEL_NUM)';
    case 0x03: return 'bad argument (MIDI_ERROR_BAD_ARGUMENT)';
    case 0x04: return 'message not recognized (MIDI_ERROR_MSG_NOT_RECOGNIZED)';
    case 0x05: return 'invalid effect ID (MIDI_ERROR_INVALID_FXID)';
    case 0x06: return 'invalid parameter ID (MIDI_ERROR_INVALID_PARAMID)';
    case 0x07: return 'effect not in use in this preset (MIDI_ERROR_FX_NOT_IN_USE)';
    case 0x08: return 'no modifier slots left (MIDI_ERROR_NO_MODIFIERS_LEFT)';
    case 0x09: return 'wrong count (MIDI_ERROR_WRONG_COUNT)';
    case 0x0a: return 'effect not routable here (MIDI_ERROR_FX_NOT_ROUTABLE)';
    case 0x0b: return 'bad grid position (MIDI_ERROR_BAD_GRID_POS)';
    case 0x0c: return 'DSP overload (MIDI_ERROR_DSP_OVERLOAD)';
    case 0x0d: return 'function failed (MIDI_ERROR_FUNCTION_FAIL)';
    case 0x0e: return 'invalid patch number (MIDI_ERROR_INVALID_PATCHNUM)';
    case 0x0f: return 'illegal message (MIDI_ERROR_ILLEGAL_MSG)';
    case 0x10: return 'bad message length (MIDI_ERROR_BAD_MSG_LENGTH)';
    case 0x11: return 'image size incorrect (MIDI_ERROR_IMAGE_SIZE_INCORRECT)';
    case 0x12: return 'bad image checksum (MIDI_ERROR_BAD_IMAGE_CHKSUM)';
    case 0x13: return 'not ready for firmware update (MIDI_ERROR_NOT_RDY_FOR_FW_UPD)';
    case 0x14: return 'buffer overrun (MIDI_ERROR_BUFFER_OVERRUN)';
    case 0x15: return 'invalid cab number (MIDI_ERROR_INVALID_CABNUM)';
    case 0x16: return 'invalid modifier ID (MIDI_ERROR_INVALID_MODIFIERID)';
    case 0x17: return 'invalid bank number (MIDI_ERROR_INVALID_BANKNUM)';
    case 0x18: return 'firmware already current (MIDI_ERROR_FIRMWARE_ALREADY_CURRENT)';
    case 0x19: return 'command not supported (MIDI_ERROR_CMD_NOT_SUPPORTED)';
    case 0x1a: return 'null data (MIDI_ERROR_NULL_DATA)';
    case 0x1b: return 'flash write failed (MIDI_ERROR_FLASH_WRITE_FAILED)';
    default:   return undefined;
  }
}

/**
 * One block's row in a STATUS_DUMP response.
 *
 * Per v1.4 PDF: `dd` bit 0 = bypass, bits 3:1 = channel (0..7; current
 * max is 3), bits 6:4 = number of channels supported (0..7).
 */
export interface StatusDumpEntry {
  /** 14-bit effect ID per v1.4 PDF Appendix 1. */
  effectId: number;
  /** True if the block is bypassed in the active scene. */
  bypassed: boolean;
  /** Current channel index (0..7). Most blocks expose 2 or 4 channels. */
  channel: number;
  /** Number of channels this block supports (0..7). */
  channelCount: number;
}

/**
 * Parse a 0x13 STATUS_DUMP response into a list of per-block entries.
 *
 * Wire shape per v1.4 PDF:
 *   `F0 00 01 74 10 13 [id id dd]* [cs] F7`
 */
export function parseStatusDumpResponse(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): StatusDumpEntry[] {
  if (!isStatusDumpResponse(bytes, modelByte)) {
    throw new Error(
      `parseStatusDumpResponse: not a valid 0x13 frame (len=${bytes.length})`,
    );
  }
  const payload = bytes.slice(6, -2);
  if (payload.length % 3 !== 0) {
    throw new Error(
      `parseStatusDumpResponse: payload length ${payload.length} not a ` +
        'multiple of 3 — STATUS_DUMP frames are id-id-dd triples.',
    );
  }
  const entries: StatusDumpEntry[] = [];
  for (let i = 0; i < payload.length; i += 3) {
    const idLo = payload[i] & 0x7f;
    const idHi = payload[i + 1] & 0x7f;
    const dd = payload[i + 2] & 0x7f;
    entries.push({
      effectId: decode14(idLo, idHi),
      bypassed: (dd & 0x01) !== 0,
      channel: (dd >> 1) & 0x07,
      channelCount: (dd >> 4) & 0x07,
    });
  }
  return entries;
}

// ── Model-byte-bound codec factory ─────────────────────────────────
//
// The Axe-Fx III, FM3, FM9, and VP4 share this modern-family wire codec;
// they differ only in the model byte (III 0x10, FM3 0x11, FM9 0x12, VP4
// 0x14) and their per-device parameter catalogs (public-evidence chain:
// FM3 byte-confirmed via tysonlt/AxeFxControl; VP4 byte-confirmed via
// forum capture; FM9 wiki-sourced). createModernFractalCodec binds every
// model-byte-bearing builder/parser to one device's model byte so a
// descriptor can't accidentally emit the wrong model byte on any call.
// The free functions above stay exported and default to the III model
// byte (0x10), so existing III call sites are byte-identical.
//
// SCOPE: this binds the wire ENVELOPE (model byte + checksum + function
// family), which is the part validated as shared across the family. The
// parameter SET/GET path (fn=0x01) is reused from the III but remains
// hardware-unverified on FM/VP4 — keep it behind the beta discipline
// (preference_axefx3_no_untested_wire_paths) and do not treat a bound
// codec as hardware confirmation.

// ── fn=0x01 GET-RESPONSE (single-param read with the device's own label) ──
//
// First hardware-captured fn=0x01 GET response in the modern Fractal family,
// from a real FM9 (community fm9-catalog branch, commit a2a4664, 2026-06-06).
// Distinct from the 23-byte SET/GET echo (parseSetGetParameterResponse) and
// the STATE_BROADCAST (04 01): the GET response is a long frame carrying the
// param's internal IEEE-754 float (5 septets at payload[6..10]) AND the
// device's own display string (8→7 septet-packed at payload[15+], length at
// payload[13..14]). GET is non-destructive (read-only), so this is the
// primitive for a "device names its own values" calibration sweep
// (paramId name→id rebind). Goldens: GET_AMP / GET_DLY in the III setparam
// test. NOTE: the gen-3 reader currently reads via the fn=0x1F bulk broadcast;
// swapping single get_param to this GET path is a separate, hardware-gated
// step — this is exposed as a codec primitive, not yet the live read path.

/** Decode 5 MSB-first... no: 5 LSB-first 7-bit septets into a u32. */
function decode5Septet32(b: readonly number[]): number {
  return (
    ((b[0] & 0x7f) >>> 0) |
    ((b[1] & 0x7f) << 7) |
    ((b[2] & 0x7f) << 14) |
    ((b[3] & 0x7f) << 21) |
    ((b[4] & 0x7f) << 28)
  ) >>> 0;
}

/** Reinterpret a u32 bit pattern as a little-endian IEEE-754 float32. */
function bitsToFloat32(bits: number): number {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, bits, true);
  return new DataView(buf).getFloat32(0, true);
}

export function isGetParameterResponse(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): boolean {
  if (!isSetGetParameterResponse(bytes, modelByte)) return false;
  const payload = bytes.slice(6, -2);
  if (payload.length < 17) return false;
  // Not a STATE_BROADCAST (04 01), and the display-string length field is set.
  if (payload[0] === 0x04 && payload[1] === 0x01) return false;
  const strLen = (payload[13] & 0x7f) | ((payload[14] & 0x7f) << 7);
  return strLen > 0 && payload.length >= 15 + strLen + Math.ceil(strLen / 7);
}

export function parseGetParameterResponse(
  bytes: readonly number[],
  modelByte: number = AXE_FX_III_MODEL_ID,
): {
  effectId: number;
  paramId: number;
  /** Internal normalized value as an IEEE-754 float32. */
  internalValue: number;
  /** Raw u32 bit pattern of the float (for goldens / debugging). */
  valueBits: number;
  /** The device's own display text, trailing space / NUL trimmed. */
  displayString: string;
} {
  if (!isGetParameterResponse(bytes, modelByte)) {
    throw new Error(`parseGetParameterResponse: not an fn=0x01 GET response (len=${bytes.length})`);
  }
  const payload = bytes.slice(6, -2);
  const strLen = (payload[13] & 0x7f) | ((payload[14] & 0x7f) << 7);
  const raw = unpackValueChunked(Uint8Array.from(payload.slice(15)), strLen);
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === 0 || raw[end - 1] === 0x20)) end--;
  const valueBits = decode5Septet32(payload.slice(6, 11));
  return {
    effectId: decode14(payload[2], payload[3]),
    paramId: decode14(payload[4], payload[5]),
    internalValue: bitsToFloat32(valueBits),
    valueBits,
    displayString: String.fromCharCode(...Array.from(raw.slice(0, end))),
  };
}

export interface ModernFractalCodec {
  readonly modelByte: number;
  /** DISCRETE SET (sub 09 00): `value` is the read-roster ordinal → float32(ordinal) @pos12. */
  buildSetParameter(effectId: number, paramId: number, value: number): number[];
  /** CONTINUOUS SET (sub 52 00): `normalized` in [0,1] → float32(normalized) @pos12. */
  buildSetParameterContinuous(effectId: number, paramId: number, normalized: number): number[];
  buildGetParameter(effectId: number, paramId: number): number[];
  /** GET CURRENT TYPE NAME (sub 1F 00): reply decodes via parseGetParameterResponse().displayString. */
  buildRequestCurrentTypeName(effectId: number, typeParamId: number): number[];
  isGetParameterResponse(bytes: readonly number[]): boolean;
  parseGetParameterResponse(
    bytes: readonly number[],
  ): ReturnType<typeof parseGetParameterResponse>;
  buildSetBypass(effectId: number, bypassed: boolean): number[];
  buildSetChannel(effectId: number, channel: 0 | 1 | 2 | 3): number[];
  buildSetScene(sceneIndex: number): number[];
  buildSetGridCell(opts: { row: number; col: number; blockId: number; rows?: number }): number[];
  /** fn=0x01 sub=0x30 cursor-move to a cell (FM3 needs it before a block insert). */
  buildSelectCell(opts: { row: number; col: number; rows?: number }): number[];
  buildSetGridRouting(opts: { srcRow: number; srcCol: number; destRow: number; rows?: number; op?: number }): number[];
  buildSetPresetName(name: string): number[];
  buildStorePreset(presetNumber: number): number[];
  buildSwitchPresetPC(presetNumber: number, channel?: number): number[];
  /** SysEx-native preset switch (fn=0x01 sub=0x27); alternative to buildSwitchPresetPC. */
  buildSwitchPresetSysEx(presetNumber: number): number[];
  isSetGetParameterResponse(bytes: readonly number[]): boolean;
  parseSetGetParameterResponse(
    bytes: readonly number[],
  ): ReturnType<typeof parseSetGetParameterResponse>;
  isMultipurposeResponse(bytes: readonly number[], expectedFn?: number): boolean;
  parseMultipurposeResponse(
    bytes: readonly number[],
  ): ReturnType<typeof parseMultipurposeResponse>;
  describeMultipurposeResultCode(code: number): string | undefined;
  buildQueryPatchName(presetNumber: number | 'current'): number[];
  isQueryPatchNameResponse(bytes: readonly number[]): boolean;
  parseQueryPatchNameResponse(
    bytes: readonly number[],
  ): ReturnType<typeof parseQueryPatchNameResponse>;
  // Scene / tempo / status reads — model-bound so they parse this device's frames
  // (the free functions default to the III model byte, which throws on FM9/FM3).
  buildGetScene(): number[];
  isSetGetSceneResponse(bytes: readonly number[]): boolean;
  parseSceneResponse(bytes: readonly number[]): ReturnType<typeof parseSceneResponse>;
  buildGetTempo(): number[];
  isSetGetTempoResponse(bytes: readonly number[]): boolean;
  parseTempoResponse(bytes: readonly number[]): ReturnType<typeof parseTempoResponse>;
  buildStatusDump(): number[];
  isStatusDumpResponse(bytes: readonly number[]): boolean;
  parseStatusDumpResponse(bytes: readonly number[]): ReturnType<typeof parseStatusDumpResponse>;
  // fn=0x03 REQUEST_PRESET_DUMP (host → device) → 0x77/0x78/0x79 dump chain.
  buildRequestPresetDump(presetNumber: number): number[];
  // fn=0x43 REQUEST_EDIT_BUFFER_DUMP (no args) → 0x51 head + 0x52 body run (no tail).
  buildRequestEditBufferDump(): number[];
  isEditBufferDumpHead(bytes: readonly number[]): boolean;
  isEditBufferDumpBody(bytes: readonly number[]): boolean;
  // fn=0x1F block bulk-read (poll → 0x74/0x75/0x76 burst → positional values).
  buildBlockBulkReadPoll(effectId: number): number[];
  isGen3BroadcastFrame(bytes: readonly number[], fn: 0x74 | 0x75 | 0x76): boolean;
  assembleGen3BlockBulkRead(frames: readonly (readonly number[])[]): Gen3BlockBulkRead;
}

export function createModernFractalCodec(
  modelByte: number,
  opts: { bankSelect?: Gen3BankSelectMode } = {},
): ModernFractalCodec {
  const bankSelect = opts.bankSelect ?? 'standard';
  return {
    modelByte,
    buildSetParameter: (e, p, v) => buildSetParameter(e, p, v, modelByte),
    buildSetParameterContinuous: (e, p, v) => buildSetParameterContinuous(e, p, v, modelByte),
    buildGetParameter: (e, p) => buildGetParameter(e, p, modelByte),
    buildRequestCurrentTypeName: (e, p) => buildRequestCurrentTypeName(e, p, modelByte),
    buildSetBypass: (e, b) => buildSetBypass(e, b, modelByte),
    buildSetChannel: (e, c) => buildSetChannel(e, c, modelByte),
    buildSetScene: (s) => buildSetScene(s, modelByte),
    buildSetGridCell: (opts) => buildSetGridCell(opts, modelByte),
    buildSelectCell: (opts) => buildSelectCell(opts, modelByte),
    buildSetGridRouting: (opts) => buildSetGridRouting(opts, modelByte),
    buildSetPresetName: (n) => buildSetPresetName(n, modelByte),
    buildStorePreset: (n) => buildStorePreset(n, modelByte),
    buildSwitchPresetPC: (n, ch) => buildSwitchPresetPC(n, ch, bankSelect),
    buildSwitchPresetSysEx: (n) => buildSwitchPresetSysEx(n, modelByte),
    isSetGetParameterResponse: (b) => isSetGetParameterResponse(b, modelByte),
    parseSetGetParameterResponse: (b) => parseSetGetParameterResponse(b, modelByte),
    isGetParameterResponse: (b) => isGetParameterResponse(b, modelByte),
    parseGetParameterResponse: (b) => parseGetParameterResponse(b, modelByte),
    isMultipurposeResponse: (b, expectedFn) => isMultipurposeResponse(b, modelByte, expectedFn),
    parseMultipurposeResponse: (b) => parseMultipurposeResponse(b, modelByte),
    describeMultipurposeResultCode,
    buildQueryPatchName: (n) => buildQueryPatchName(n, modelByte),
    isQueryPatchNameResponse: (b) => isQueryPatchNameResponse(b, modelByte),
    parseQueryPatchNameResponse: (b) => parseQueryPatchNameResponse(b, modelByte),
    buildGetScene: () => buildGetScene(modelByte),
    isSetGetSceneResponse: (b) => isSetGetSceneResponse(b, modelByte),
    parseSceneResponse: (b) => parseSceneResponse(b, modelByte),
    buildGetTempo: () => buildGetTempo(modelByte),
    isSetGetTempoResponse: (b) => isSetGetTempoResponse(b, modelByte),
    parseTempoResponse: (b) => parseTempoResponse(b, modelByte),
    buildStatusDump: () => buildStatusDump(modelByte),
    isStatusDumpResponse: (b) => isStatusDumpResponse(b, modelByte),
    parseStatusDumpResponse: (b) => parseStatusDumpResponse(b, modelByte),
    buildRequestPresetDump: (n) => buildRequestPresetDump(n, modelByte),
    buildRequestEditBufferDump: () => buildRequestEditBufferDump(modelByte),
    isEditBufferDumpHead: (b) => isEditBufferDumpHead(b, modelByte),
    isEditBufferDumpBody: (b) => isEditBufferDumpBody(b, modelByte),
    buildBlockBulkReadPoll: (e) => buildBlockBulkReadPoll(e, modelByte),
    isGen3BroadcastFrame: (b, fn) => isGen3BroadcastFrame(b, fn, modelByte),
    assembleGen3BlockBulkRead: (frames) => assembleGen3BlockBulkRead(frames, modelByte),
  };
}
