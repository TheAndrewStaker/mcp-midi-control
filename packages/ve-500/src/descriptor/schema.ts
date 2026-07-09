/**
 * Boss VE-500 DeviceDescriptor schema helpers.
 *
 * The block/param schema is built from the catalog generated from the editor's
 * own address map (`roland-midi/ve-500`). Each catalog param carries a wire
 * integer range [min, max]; we expose that integer directly (display-first for
 * the 0..100 knobs and the on/off switches, which read identically on the panel).
 *
 * Only params whose display name ends in "Switch" are treated as bool ON/OFF.
 * Every other selector that the editor backs with a named option table (FX Type,
 * Reverb Type, Harmony Voice, Rotary Speed SLOW/FAST, Filter Mode AUTO/MANUAL,
 * EQ gains in dB, …) carries `enum_values` joined from the editor option tables
 * in the catalog generator; those become `unit:'enum'` and accept/echo the panel
 * label (case-insensitive) or the raw ordinal. Params with no matching table stay
 * plain numeric `count`.
 */

import type {
  BlockSchema,
  ParamSchema,
} from '@mcp-midi-control/core/protocol-generic/types.js';

import { VE500_PARAMS, type Ve500ParamDef } from 'roland-midi/ve-500';

/** Numeric INTEGER1xN / INTEGERnx4 sizes start here; smaller = raw/ASCII (skipped). */
const INTEGER_BASE = 0x10000;

/** Only the numeric, settable params are exposed (skips the ASCII patch-name). */
function isSettable(def: Ve500ParamDef): boolean {
  return def.size >= INTEGER_BASE;
}

/**
 * A genuine on/off enable: a 0..1 param whose display name ends in "Switch"
 * (e.g. "Enhancer Switch", "Vocoder Switch", and the bare FX "Switch"). Other
 * 0..1 params are 2-value enums/modes (SLOW/FAST, LPF/BPF, …) whose real labels
 * aren't joined yet — those are NOT switches and must not advertise ON/OFF.
 */
function isSwitch(def: Ve500ParamDef): boolean {
  return (
    def.min === 0 &&
    def.max === 1 &&
    def.display_name.trim().toLowerCase().endsWith('switch')
  );
}

const ON = new Set(['on', '1', 'true', 'yes', 'enable', 'enabled']);
const OFF = new Set(['off', '0', 'false', 'no', 'disable', 'disabled']);

export function makeEncode(def: Ve500ParamDef): ParamSchema['encode'] {
  return (display: number | string): number => {
    if (isSwitch(def)) {
      if (typeof display === 'string') {
        const s = display.trim().toLowerCase();
        if (ON.has(s)) return 1;
        if (OFF.has(s)) return 0;
        throw new Error(
          `${def.block}.${def.param}: expected on/off (or 0/1), got "${display}"`,
        );
      }
      return display ? 1 : 0;
    }
    // Enum/type/mode selector: accept the panel label (case-insensitive) or the
    // raw ordinal.
    if (def.enum_values) {
      if (typeof display === 'string') {
        const want = display.trim().toLowerCase();
        for (const [ord, label] of Object.entries(def.enum_values)) {
          if (label.toLowerCase() === want) return Number(ord);
        }
        const asNum = Number(display);
        if (Number.isInteger(asNum) && def.enum_values[asNum] !== undefined) {
          return asNum;
        }
        throw new Error(
          `${def.block}.${def.param}: unknown value "${display}". Valid: ${Object.values(def.enum_values).join(', ')}`,
        );
      }
      if (Number.isInteger(display) && def.enum_values[display] !== undefined) {
        return display;
      }
      throw new Error(
        `${def.block}.${def.param}: ordinal ${display} out of range [0..${def.max}]. Valid: ${Object.values(def.enum_values).join(', ')}`,
      );
    }
    const num = typeof display === 'number' ? display : Number(display);
    if (!Number.isFinite(num)) {
      throw new Error(
        `${def.block}.${def.param}: expected a number, got "${display}"`,
      );
    }
    const v = Math.round(num);
    if (v < def.min || v > def.max) {
      throw new Error(
        `${def.block}.${def.param} out of range [${def.min}..${def.max}]: ${num}`,
      );
    }
    return v;
  };
}

export function makeDecode(def: Ve500ParamDef): ParamSchema['decode'] {
  return (wire: number): number | string => {
    if (isSwitch(def)) return wire ? 'ON' : 'OFF';
    if (def.enum_values) return def.enum_values[wire] ?? wire;
    return wire;
  };
}

/** Title-case a block id like 'master_fx_harmony' -> 'Master Fx Harmony'. */
function titleCase(id: string): string {
  return id
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function buildBlocks(): Record<string, BlockSchema> {
  const grouped: Record<string, Record<string, ParamSchema>> = {};
  for (const def of VE500_PARAMS) {
    if (!isSettable(def)) continue;
    const params = (grouped[def.block] ??= {});
    const sw = isSwitch(def);
    const isEnum = !sw && def.enum_values !== undefined;
    params[def.param] = {
      display_name: def.display_name,
      unit: sw ? 'bool' : isEnum ? 'enum' : 'count',
      display_min: sw || isEnum ? undefined : def.min,
      display_max: sw || isEnum ? undefined : def.max,
      enum_values: sw ? { 0: 'OFF', 1: 'ON' } : def.enum_values,
      encode: makeEncode(def),
      decode: makeDecode(def),
    };
  }
  const out: Record<string, BlockSchema> = {};
  for (const [block, params] of Object.entries(grouped)) {
    out[block] = { display_name: titleCase(block), params };
  }
  return out;
}
