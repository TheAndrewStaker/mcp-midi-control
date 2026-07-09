/**
 * VP4 (model byte 0x14) fn=0x01 parameter WRITE codec.
 *
 * The VP4 reuses the gen-3 envelope + XOR checksum + septet encoding, but its
 * fn=0x01 SET frame is its OWN shape — NOT the Axe-Fx III's. Decoded byte-exact
 * from two community captures (Kevin Iudicello, fw 4.03; the 2026-06-09 edit
 * session). See `docs/devices/vp4/SYSEX-MAP.md` (PARAMETER SET) and
 * `samples/captured/decoded/vp4-403-v2/FINDINGS.md`.
 *
 * Divergence from the III (why this is a separate module, not the shared codec):
 *   • NO 2-byte sub-action. effectId sits at payload pos 0-1 (III: pos 2-3, after
 *     a `09 00`/`52 00` sub-action).
 *   • A `tc` sub-opcode byte selects the operation: 0x01 discrete, 0x02 continuous
 *     (drag), 0x1b SAVE.
 *   • The value is a 5-septet LE float32 with the TOP TWO septets SWAPPED on the
 *     wire (emit [s0,s1,s2,s4,s3]); continuous params carry a normalized [0,1] float.
 *
 * Wire frame (21 bytes incl F0/F7):
 *   F0 00 01 74 14 01 [eid:14b LE] [pid:14b LE] [tc] 00 00 00 04 00 [val:5] cks F7
 *
 * Every write is answered by a synchronous From-VP4 echo (~+1 ms) carrying the same
 * eid/pid/tc (value verbatim for discrete) — `parseVp4WriteEcho`. SAVE additionally
 * gets a distinct 16-byte completion ack (~+153 ms) — `isVp4SaveAck`.
 */
import { fractalChecksum } from '../../shared/checksum.js';
// Throwing form — a deliberate tightening for VP4 (the old local copy
// silently truncated out-of-range ids instead of throwing).
import { encode14 } from '../../shared/septet16.js';
import { encode5SeptetFloat32, decode5SeptetFloat32 } from '../axe-fx-iii/setParam.js';

export const VP4_MODEL_ID = 0x14;
export const FN_PARAMETER = 0x01;

/** tc sub-opcode (payload pos 4). */
export const TC_DISCRETE = 0x01;
export const TC_CONTINUOUS = 0x02;
export const TC_SAVE = 0x1b;

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const MFR = [0x00, 0x01, 0x74] as const;

/**
 * Captured "bypassed" normalized value. enable = 0.0 (clean); the bypassed state
 * is `00 00 10 03 78` = float32 0.515625 — replicated verbatim from the capture
 * (its meaning as a boolean is undecoded, so we do not compute it from `true`).
 */
export const VP4_BYPASS_ON_NORMALIZED = 0.515625;
export const VP4_BYPASS_OFF_NORMALIZED = 0.0;

/** Captured SAVE command value (payload after `04 00`); 0x30 in the low septet. */
const SAVE_VALUE_BYTES = [0x30, 0x00, 0x00, 0x00, 0x00] as const;

/**
 * Encode a float32 as the VP4's on-wire 5-byte value: standard 5-septet LE
 * (`encode5SeptetFloat32`, shared with the rest of the gen-3 codec) with
 * the VP4-specific TOP-TWO-septet swap (emit `[s0,s1,s2,s4,s3]`).
 */
export function encodeVp4Float(value: number): [number, number, number, number, number] {
  const [s0, s1, s2, s3, s4] = encode5SeptetFloat32(value);
  return [s0, s1, s2, s4, s3];
}

/**
 * Decode the VP4's on-wire 5-byte value field back to a float32. Input bytes are
 * `[s0,s1,s2,s4,s3]` (top two swapped); un-swap, then reassemble/reinterpret via
 * the shared gen-3 `decode5SeptetFloat32`.
 */
export function decodeVp4Float(b: readonly number[]): number {
  const [w0, w1, w2, w4, w3] = b;
  return decode5SeptetFloat32(w0, w1, w2, w3, w4);
}

/**
 * Wrap an fn=0x01 payload in the VP4 envelope (F0 mfr model fn ... cks F7).
 * Exported for the other VP4 fn=0x01 builders (structureBlob.ts).
 */
export function buildVp4Frame(payload: readonly number[]): number[] {
  const body = [SYSEX_START, ...MFR, VP4_MODEL_ID, FN_PARAMETER, ...payload];
  return [...body, fractalChecksum(body), SYSEX_END];
}

/**
 * Build a VP4 parameter SET frame.
 * `continuous` selects tc=0x02 (knob/drag, normalized value) vs tc=0x01 (discrete).
 * `value` is the raw on-wire float (normalized [0,1] for continuous params).
 */
export function buildVp4SetParam(
  effectId: number,
  paramId: number,
  value: number,
  opts: { continuous?: boolean } = {},
): number[] {
  const tc = opts.continuous ? TC_CONTINUOUS : TC_DISCRETE;
  return buildVp4Frame([
    ...encode14(effectId),
    ...encode14(paramId),
    tc,
    0x00, 0x00, 0x00,
    0x04, 0x00,
    ...encodeVp4Float(value),
  ]);
}

/** Build a VP4 block-bypass SET (pid 3 = BLOCK_BYPASS, tc=0x01). */
export function buildVp4SetBypass(effectId: number, bypassed: boolean): number[] {
  const value = bypassed ? VP4_BYPASS_ON_NORMALIZED : VP4_BYPASS_OFF_NORMALIZED;
  return buildVp4Frame([
    ...encode14(effectId),
    0x03, 0x00,
    TC_DISCRETE,
    0x00, 0x00, 0x00,
    0x04, 0x00,
    ...encodeVp4Float(value),
  ]);
}

/**
 * Build a VP4 SAVE/store frame (save the active preset in place). Byte-identical
 * to the captured store command; exposes no location argument (the 0x30 value's
 * save-in-place vs index semantics are undetermined — both captured saves were to
 * the same location). Wait for `isVp4SaveAck` to confirm completion.
 */
export function buildVp4Save(): number[] {
  return buildVp4Frame([
    0x00, 0x00,
    0x00, 0x00,
    TC_SAVE,
    0x00, 0x00, 0x00,
    0x04, 0x00,
    ...SAVE_VALUE_BYTES,
  ]);
}

function isVp4Frame(bytes: readonly number[]): boolean {
  return (
    bytes.length >= 7 &&
    bytes[0] === SYSEX_START &&
    bytes[1] === MFR[0] && bytes[2] === MFR[1] && bytes[3] === MFR[2] &&
    bytes[4] === VP4_MODEL_ID && bytes[5] === FN_PARAMETER
  );
}

export interface Vp4WriteEcho {
  effectId: number;
  paramId: number;
  tc: number;
  /** The 5 on-wire value bytes echoed by the device (decode with decodeVp4Float). */
  valueBytes: number[];
}

/**
 * Parse the device's synchronous write echo. The echo is a From-VP4 fn=0x01 frame
 * carrying the same eid/pid/tc as the write; for discrete writes the value is
 * echoed verbatim. Returns null if `bytes` is not a VP4 fn=0x01 frame. Read-only.
 */
export function parseVp4WriteEcho(bytes: readonly number[]): Vp4WriteEcho | null {
  if (!isVp4Frame(bytes) || bytes.length < 14) return null;
  const effectId = (bytes[6] & 0x7f) | ((bytes[7] & 0x7f) << 7);
  const paramId = (bytes[8] & 0x7f) | ((bytes[9] & 0x7f) << 7);
  const tc = bytes[10];
  // The 5 value bytes sit at indices 16-20 (incl F0) in both the write and its
  // echo — the echo only swaps the write's `04` length tag for a `28` marker.
  const valueBytes = bytes.slice(16, 21).map((b) => b & 0x7f);
  return { effectId, paramId, tc, valueBytes };
}

/**
 * True if `bytes` is the 16-byte SAVE completion ack
 * (`F0 00 01 74 14 01 00 00 00 00 1B 00 00 00 00 00 0B F7`).
 */
export function isVp4SaveAck(bytes: readonly number[]): boolean {
  if (!isVp4Frame(bytes) || bytes.length !== 18) return false;
  return bytes[10] === TC_SAVE && bytes[bytes.length - 1] === SYSEX_END;
}
