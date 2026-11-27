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
/**
 * Block knobs whose read register holds a literal integer too: every
 * stepped control the AM4-Edit cache records with typecode 16 and step 1
 * (2p2 cache). Hardware-confirmed 2026-11-25 on fw 2.02: reverb Density 4
 * read u32 = 4 (and 8 = 8), Voice 1 Shift +12 read u32 = 12; the Q16 path
 * clamped both to their minimum. chorus.number_of_voices (cache step 2)
 * stores 1..4 and displays 2..8 via `rawIntStep` (stored 1 shows "2").
 */
const STEPPED_INT_KEYS: ReadonlySet<string> = new Set([
  'drive.bit_reduce', 'drive.diode_quantity_pdqty', 'drive.diode_quantity',
  'reverb.springs', 'reverb.basetype', 'reverb.voice_1_shift', 'reverb.voice_2_shift',
  'reverb.tonetype', 'reverb.density', 'delay.bit_reduction', 'phaser.feedback_point',
  'filter.order', 'amp.tubes', 'chorus.number_of_voices',
]);

export function isRawIntRegister(param: Param): boolean {
  if (STEPPED_INT_KEYS.has(`${param.block}.${param.name}`)) return true;
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
    (param.name.endsWith('_cc') || SEL_CC_PID_HIGHS.has(param.pidHigh)) &&
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
  // Signed knobs (Voice Shift -24..24) come back 16-bit two's-complement:
  // fw 2.02 hardware 2026-11-25, Voice 2 Shift -12 read u32 = 65524.
  const raw = Math.round(param.displayMin < 0 && u32 >= 0x8000 ? u32 - 0x10000 : u32);
  if (rawIntRegisterHasNone(param) && raw === RAW_INT_NONE_SENTINEL) return 'None';
  if (rawIntRegisterHasPedal(param)) {
    const pedal = RAW_INT_PEDAL_VALUES.indexOf(raw);
    if (pedal >= 0) return `Pedal ${pedal + 1}`;
  }
  return param.rawIntStep !== undefined ? raw * param.rawIntStep : raw;
}

/**
 * CC-assignment registers whose roster also offers a PEDAL jack: in the AM4-Edit
 * caches these rosters end `CC #127 (127) | NONE (128) | PEDAL 1 (129) |
 * PEDAL 2 (130)`, ordinals anchored by the hardware-confirmed NONE = 128
 * sentinel. The set is read off effectDefinitions_15_2p2 (fw 2.02): every
 * roster whose 129th entry is "PEDAL 1". Nine of them (73, 75, 76, 93, 94,
 * 111-114: tuner, scene +/-1, preset +/-1, FX1-4 bypass) gained the pedal in
 * fw 2.01; the rest (volumes, tap tempo, metronome, ...) already had it in 2.00.
 * 166-170 are the fw 2.01 mode-select registers.
 */
export const RAW_INT_PEDAL_VALUES: readonly number[] = Object.freeze([129, 130]);
const PEDAL_CAPABLE_PID_HIGHS: ReadonlySet<number> = new Set([
  70, 71, 72, 73, 75, 76, 93, 94, 110, 111, 112, 113, 114, 119, 120, 121, 122, 131, 153, 159, 161,
  166, 167, 168, 169, 170,
]);
/** fw 2.01 mode-select CC registers: named `*_sel`, not `*_cc`, but they are CC assignments with a NONE state. */
const SEL_CC_PID_HIGHS: ReadonlySet<number> = new Set([166, 167, 168, 169, 170]);

/** True when a CC-assignment register also accepts 'Pedal 1' / 'Pedal 2' (fw 2.01+). */
export function rawIntRegisterHasPedal(param: Param): boolean {
  return rawIntRegisterHasNone(param) && PEDAL_CAPABLE_PID_HIGHS.has(param.pidHigh);
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
  if (typeof value === 'string') {
    const m = /^\s*pedal\s*([12])\s*$/i.exec(value);
    if (m) {
      if (!rawIntRegisterHasPedal(param)) {
        throw new Error(`${param.block}.${param.name} cannot be assigned to a pedal (valid: ${param.displayMin}..${param.displayMax} or 'None').`);
      }
      return RAW_INT_PEDAL_VALUES[Number(m[1]) - 1];
    }
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    const noneHint = rawIntRegisterHasNone(param) ? ` or 'None'` : '';
    throw new Error(`Expected an integer${noneHint} for ${param.block}.${param.name}, got "${value}".`);
  }
  const rounded = Math.round(num);
  if (rounded < param.displayMin || rounded > param.displayMax) {
    const noneHint = rawIntRegisterHasPedal(param) ? ` (or 'None', 'Pedal 1', 'Pedal 2')` : rawIntRegisterHasNone(param) ? ` (or 'None')` : '';
    throw new Error(`${param.block}.${param.name} out of range [${param.displayMin}..${param.displayMax}]${noneHint}: ${num}`);
  }
  if (param.rawIntStep !== undefined && rounded % param.rawIntStep !== 0) {
    throw new Error(`${param.block}.${param.name} moves in steps of ${param.rawIntStep} (${param.displayMin}..${param.displayMax}): ${num}`);
  }
  return rounded;
}
