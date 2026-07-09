/**
 * AM4 MIDI-config register decode/encode (raw-integer register class).
 *
 * The AM4 stores parameters in one of two wire forms in the 4-byte read
 * register:
 *
 *   1. **Normalized Q16** — `u32 = round(normalized × 65534)`. Every
 *      continuous knob (gain, cutoff, mix, the amp Q-factors, …). Read
 *      back via `ReadResponse.asInternalFloat()` then `decode()`.
 *   2. **Raw integer** — `u32 = the display integer itself`. The MIDI /
 *      device-config registers: the whole `global` MIDI map (CC
 *      assignments, MIDI channel, scene/preset config) and the per-scene
 *      MIDI transmit slots (`preset.scene_N_midi_M_channel` / `_value`).
 *      Read back via `ReadResponse.asUInt32LE()` directly — NO Q16 scale.
 *
 * These registers are all tagged `unit: 'count'`, but so are some
 * normalized knobs (amp Q-factors span 0.1..10 on a log curve), so the
 * unit alone can't tell them apart. The distinguishing rule is
 * structural: `count` registers on the `global` pseudo-block and the
 * `preset` scene-MIDI channel/value slots are raw integers; every other
 * `count` param is a normalized knob.
 *
 * Before this module the reader ran every non-enum param through the Q16
 * path, so a scene-select CC of 34 read back as `34 / 65534 ≈ 0.0005`
 * and displayed as 0 (BUG-6, 2026-07-03/04 AM4 hardware session). Writes
 * were unaffected — `encode('count', 34) = 34.0`, and the device
 * truncates the float to integer 34 — so only the read/display side and
 * the "None" write path (GAP-2) needed the fix.
 */

import type { Param } from './params.js';

/**
 * The u32 value a CC-assignment register holds when it is unassigned.
 * Valid CC numbers are 0..127; 128 is the "None" / off sentinel.
 * Hardware-confirmed for `global.scene_cc` (2026-07-03/04): the register
 * read back 128 while the front panel showed the assignment as NONE.
 */
export const RAW_INT_NONE_SENTINEL = 128;

/** Case-insensitive spellings accepted as the "None"/off value on a write. */
const NONE_ALIASES = new Set(['none', 'off']);

/**
 * True when `param`'s read register holds a literal integer (the read
 * u32 IS the display value) rather than a normalized Q16 float.
 *
 * Covers the AM4 global MIDI/setup map (every `count` register on the
 * `global` pseudo-block) and the per-scene MIDI transmit slots
 * (`preset.scene_N_midi_M_channel` / `_value`). Enum registers are a
 * separate class and return false here (the reader handles them on its
 * own enum branch).
 */
export function isRawIntRegister(param: Param): boolean {
  if (param.unit !== 'count') return false;
  if (param.block === 'global') {
    // The MIDI-config registers are all non-negative integer configs (CC
    // numbers 0..127, MIDI channel 1..16, scene 1..4, ...). Exclude the
    // negative-range global `count` params — the six tuner cent-offset
    // knobs `global.offset1..offset6` (-25..25) are Q16 calibration knobs,
    // NOT raw-int registers, and must stay on the normalized decode path.
    return param.displayMin >= 0;
  }
  if (param.block === 'preset') return /_midi_\d+_(channel|value)$/.test(param.name);
  return false;
}

/**
 * True when `param` is a raw-int register that uses 128 as its "None" /
 * unassigned sentinel. Restricted to the 0..127 CC-assignment registers
 * on the `global` block — MIDI-channel (1..16), default-scene (1..4), and
 * the per-scene value/channel slots have no "None" state.
 */
export function rawIntRegisterHasNone(param: Param): boolean {
  return (
    param.block === 'global' &&
    isRawIntRegister(param) &&
    // CC-ASSIGNMENT registers only (name ends `_cc`): those carry the 128 =
    // "None"/unassigned sentinel (hardware-confirmed for scene_cc). Other
    // 0..127 global registers are VALUE registers (e.g. ext_startval_begin,
    // an external-controller start value) — they have no None state, so we
    // must not accept 'None'→128 there or mislabel a read of 128 as 'None'.
    param.name.endsWith('_cc') &&
    param.displayMin === 0 &&
    param.displayMax === 127
  );
}

/**
 * Decode a raw-int register's read u32 into its display value. Returns
 * the literal integer, or the string `'None'` when the value is the
 * unassigned sentinel on a CC-assignment register.
 */
export function decodeRawIntRegister(param: Param, u32: number): number | string {
  const raw = Math.round(u32);
  if (rawIntRegisterHasNone(param) && raw === RAW_INT_NONE_SENTINEL) return 'None';
  return raw;
}

/**
 * Encode a display value for a raw-int register write, returning the
 * integer that `buildSetParam` will pack (it re-applies the `count`
 * scale of 1, so the returned integer reaches the wire verbatim).
 *
 * Accepts the string `'None'` / `'off'` on CC-assignment registers and
 * maps it to the 128 sentinel (GAP-2). Numeric input is rounded to an
 * integer and range-checked against `[displayMin, displayMax]`.
 */
export function encodeRawIntRegister(param: Param, value: number | string): number {
  if (typeof value === 'string' && NONE_ALIASES.has(value.trim().toLowerCase())) {
    if (!rawIntRegisterHasNone(param)) {
      throw new Error(`${param.block}.${param.name} has no 'None' setting (valid: ${param.displayMin}..${param.displayMax}).`);
    }
    return RAW_INT_NONE_SENTINEL;
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    const noneHint = rawIntRegisterHasNone(param) ? ` or 'None'` : '';
    throw new Error(`Expected an integer${noneHint} for ${param.block}.${param.name}, got "${value}".`);
  }
  const rounded = Math.round(num);
  if (rounded < param.displayMin || rounded > param.displayMax) {
    const noneHint = rawIntRegisterHasNone(param) ? ` (or 'None')` : '';
    throw new Error(`${param.block}.${param.name} out of range [${param.displayMin}..${param.displayMax}]${noneHint}: ${num}`);
  }
  return rounded;
}
