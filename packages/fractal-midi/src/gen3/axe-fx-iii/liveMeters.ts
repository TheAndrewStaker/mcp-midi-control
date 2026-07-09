/**
 * Gen-3 LIVE meters decode (fn=0x01 sub=0x2E telemetry payload).
 *
 * The same empty-target `fn=0x01 sub=0x2E` frame that carries the live routing
 * grid (`gridLayout.ts`, grid bitstream at byte 361+) ALSO carries live
 * telemetry — DSP/CPU utilization and stereo output meters — in fixed low
 * offsets near the front of the frame, BEFORE the grid region. So a host that
 * already polls the grid read gets these meters for free, with no extra wire
 * round-trip.
 *
 * Offsets are into the FULL SysEx frame WITH the leading 0xF0 (so `frame[0]`
 * is 0xF0, `frame[5]` is the fn byte, `frame[6]` is the sub byte). This matches
 * the wire layout the transport delivers (our inbound gen-3 frames include the
 * F0 status byte) and the convention used by the independent ForgeFX decoder.
 *
 * EVIDENCE (cross-validated, no key-press confirmation):
 *   - Independent source: the MIT-licensed ForgeFX project decodes these from
 *     its own FM3 (fw 12.0) hardware testing — `cpu% = 32 + f[37]*0.5`,
 *     `outL = f[35]/127`, `outR = f[36]/127`.
 *   - Cross-validated HERE against our own FM9 capture
 *     (`samples/captured/decoded/fm9-receive-preset-from-device-harp-2026-06-04`,
 *     model 0x12): across the 10 empty-target sub=0x2E responses in that capture
 *     (all reads of the SAME static preset, so any byte that VARIES between them
 *     must be live telemetry), exactly the bytes [35], [36] varied widely
 *     (32..122 / 7..119 — a stereo output meter bouncing with the audio).
 *     Be precise about WHAT this oracle proves on FM9:
 *       · output_left/right (f[35]/f[36]) are FM9-BEHAVIORALLY-CONFIRMED — they
 *         vary across identical reads, which only a live meter does.
 *       · cpu_percent (f[37]) is FM3(ForgeFX)-SOURCED and FM9-CONSISTENT, not
 *         FM9-confirmed: f[37] is CONSTANT at 66 (→ 65.0%), which is consistent
 *         with a steady per-preset DSP load but — being constant — the oracle
 *         cannot itself distinguish "CPU meter" from "any other static byte."
 *         Its identity rests on ForgeFX's FM3 hardware testing plus plausibility.
 *     Cross-validation against a behavioral oracle (varies-iff-telemetry) clears
 *     the project shipping bar; ships community-beta, awaiting a device
 *     front-panel cross-check to flip "untested" → "confirmed".
 *
 * INPUT METER DELIBERATELY OMITTED. ForgeFX reads an input meter at `f[588]`,
 * but that offset is FM3-frame-length-specific: the FM3's sub=0x2E frame is
 * ~590 bytes, so f[588] sits at its tail. On the FM9 the frame is 755 bytes and
 * index 588 lands INSIDE the grid bitstream region (which starts at byte 361):
 * in our FM9 capture f[588] is CONSTANT across all 10 reads (= static grid data,
 * NOT a live input level). Emitting `f[588]/127` as "input" would be a wrong,
 * frame-coincidental value on every non-FM3 device, so we ship only the three
 * device-invariant low-offset fields and leave the input meter to a future
 * device-specific decode backed by an FM3 capture we can validate against.
 */
import { FN_PARAMETER_SETGET } from './setParam.js';
import { SUB_ACTION_GRID_LAYOUT } from './gridLayout.js';

const SYSEX_START = 0xf0;

/** Byte offsets into the F0-included frame (device-invariant; pre-grid header). */
const OFFSET_OUTPUT_LEFT = 35;
const OFFSET_OUTPUT_RIGHT = 36;
const OFFSET_CPU = 37;

/** CPU% = CPU_BASE + raw7 * CPU_SLOPE (raw7 in 0..127 → 32.0 .. 95.5 %). */
const CPU_BASE = 32;
const CPU_SLOPE = 0.5;

/** A 7-bit MIDI meter byte's full-scale value. */
const METER_FULL_SCALE = 127;

/** Live telemetry decoded from a gen-3 sub=0x2E frame. */
export interface Gen3LiveMeters {
  /**
   * DSP / CPU utilization, percent. Decoded as `32 + raw*0.5` over a 7-bit
   * field, so the reportable range is 32.0..95.5%. Steady for a given preset
   * (it is the preset's DSP cost), which makes it the most useful meter for a
   * one-shot read: "how much headroom does this patch leave."
   */
  cpu_percent: number;
  /** Output meter, LEFT channel, normalized 0..1. Momentary (bounces with audio). */
  output_left: number;
  /** Output meter, RIGHT channel, normalized 0..1. Momentary. */
  output_right: number;
}

/** True when `frame` is a gen-3 fn=0x01 sub=0x2E frame (F0-included). */
function isSub2EFrame(frame: readonly number[]): boolean {
  return (
    frame[0] === SYSEX_START &&
    frame[5] === FN_PARAMETER_SETGET &&
    frame[6] === SUB_ACTION_GRID_LAYOUT
  );
}

/**
 * Decode the live CPU + stereo-output meters from a gen-3 sub=0x2E reply frame
 * (the SAME frame `parseGen3GridLayout` reads the routing grid from). Pass the
 * full SysEx frame WITH the leading 0xF0.
 *
 * Throws when `frame` is not a sub=0x2E frame, or is too short to contain the
 * CPU offset — callers that read meters opportunistically (e.g. get_preset)
 * should call this best-effort and degrade on throw rather than fail the read.
 */
export function parseGen3LiveMeters(frame: readonly number[]): Gen3LiveMeters {
  if (!isSub2EFrame(frame)) {
    throw new Error(
      'parseGen3LiveMeters: not a gen-3 fn=0x01 sub=0x2E frame (expected F0 at [0], ' +
        '0x01 at [5], 0x2E at [6]).',
    );
  }
  // Block-targeted sub=0x2E replies carry the SAME status layout as the
  // empty-target one, meters included: in the FM3 capture
  // `samples/captured/fm3-community-2026-06-12/fm3-probe-output.json` (job3,
  // three block-targeted reads of one static preset), f[35]/f[36] vary
  // (output meters) while f[37] holds constant (CPU 66.5%). The earlier
  // "block-targeted = name frame, bytes 35-37 not meters" reading was never
  // established — that FM9 session simply never checked them — so no
  // target-shape refusal here (parity with parseGen3GridLayout).
  if (frame.length <= OFFSET_CPU) {
    throw new Error(
      `parseGen3LiveMeters: frame too short for the meter region (have ${frame.length} ` +
        `bytes, need > ${OFFSET_CPU}).`,
    );
  }
  const round = (v: number, dp: number): number => {
    const f = 10 ** dp;
    return Math.round(v * f) / f;
  };
  return {
    cpu_percent: round(CPU_BASE + frame[OFFSET_CPU] * CPU_SLOPE, 1),
    output_left: round(frame[OFFSET_OUTPUT_LEFT] / METER_FULL_SCALE, 3),
    output_right: round(frame[OFFSET_OUTPUT_RIGHT] / METER_FULL_SCALE, 3),
  };
}
