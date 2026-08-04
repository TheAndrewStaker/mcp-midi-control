/**
 * MicroFreak block/param schema for the unified tool surface.
 *
 * Two families of param, deliberately kept in one block map so they ride the
 * same `set_param` / `list_params` path (the VE-500 does the same with its
 * `system_*` blocks):
 *
 *   - PRESET params, driven by MIDI CC. Display-first as **0..100**, the scale
 *     the MicroFreak's own panel uses for its continuous controls, encoded to
 *     the 0..127 CC range at the boundary. WRITE-ONLY (see reader.ts).
 *   - GLOBAL / Utility params under the `system` block, driven by SysEx. These
 *     are readable AND writable.
 *
 * Display-first note: 0..100 -> 0..127 is a straight linear map with rounding,
 * so a round-trip is exact only on values landing on the 128-step grid. That
 * lossiness is the hardware's (128 steps behind a 100-step readout), not ours.
 * Exposing raw 0..127 would leak the wire format through the tool surface,
 * which the display-first rule forbids.
 */

import type {
  BlockSchema,
  ParamSchema,
} from '@mcp-midi-control/core/protocol-generic/types.js';

import { ccEvidenceNote, type FreakConfig, type FreakCc, type FreakGlobal } from '../devices/types.js';

const ON = new Set(['on', '1', 'true', 'yes', 'enable', 'enabled']);
const OFF = new Set(['off', '0', 'false', 'no', 'disable', 'disabled']);

function ccParam(cc: FreakCc): ParamSchema {
  const evidence_note = ccEvidenceNote(cc);
  if (cc.toggle === true) {
    return {
      display_name: cc.label,
      unit: 'enum',
      enum_values: { 0: 'Off', 127: 'On' },
      enum_partial: true,
      host_label: cc.label,
      evidence_note,
      encode: (display: number | string): number => {
        if (typeof display === 'number') return display >= 64 ? 127 : 0;
        const s = display.trim().toLowerCase();
        if (ON.has(s)) return 127;
        if (OFF.has(s)) return 0;
        throw new Error(`${cc.block}.${cc.param}: expected on/off, got "${display}"`);
      },
      decode: (wire: number): string => (wire >= 64 ? 'On' : 'Off'),
    } as ParamSchema;
  }

  return {
    display_name: cc.label,
    unit: 'percent',
    display_min: 0,
    display_max: 100,
    host_label: cc.label,
    evidence_note,
    encode: (display: number | string): number => {
      const n = typeof display === 'string' ? Number(display) : display;
      if (!Number.isFinite(n)) {
        throw new Error(`${cc.block}.${cc.param}: expected a number 0..100, got "${display}"`);
      }
      if (n < 0 || n > 100) throw new Error(`${cc.block}.${cc.param} out of range [0..100]: ${n}`);
      return Math.round((n / 100) * 127);
    },
    decode: (wire: number): number => Math.round((wire / 127) * 1000) / 10,
  } as ParamSchema;
}

function globalParam(g: FreakGlobal): ParamSchema {
  if (g.channel === true) {
    return {
      display_name: g.label,
      unit: 'count',
      display_min: 1,
      display_max: 16,
      host_label: g.label,
      encode: (display: number | string): number => {
        const n = typeof display === 'string' ? Number(display) : display;
        if (!Number.isInteger(n) || n < 1 || n > 16) {
          throw new Error(`${g.param}: expected a MIDI channel 1..16, got "${display}"`);
        }
        return n - 1;
      },
      decode: (wire: number): number => wire + 1,
    } as ParamSchema;
  }

  if (g.values !== undefined) {
    const values = g.values;
    const table: Record<number, string> = {};
    values.forEach((v, i) => { table[i] = v; });
    return {
      display_name: g.label,
      unit: 'enum',
      enum_values: table,
      host_label: g.label,
      encode: (display: number | string): number => {
        if (typeof display === 'number') return display;
        const s = display.trim().toLowerCase();
        const i = values.findIndex((v) => v.toLowerCase() === s);
        if (i === -1) {
          throw new Error(`${g.param}: expected one of ${values.join(' / ')}, got "${display}"`);
        }
        return i;
      },
      decode: (wire: number): string => values[wire] ?? `unknown(${wire})`,
    } as ParamSchema;
  }

  // `output_dest` and anything else without a confirmed label table stays a raw
  // integer, deliberately NOT dressed up as an enum. The manual implies
  // [None, USB, MIDI, BOTH] = 0..3, but the observed values are a bitmask
  // (USB=1, BOTH=5) and two of the four are unobservable, so a fabricated label
  // table would be a lie dressed as a feature.
  return {
    display_name: g.label,
    unit: 'count',
    display_min: 0,
    display_max: 127,
    host_label: g.label,
    encode: (display: number | string): number => {
      const n = typeof display === 'string' ? Number(display) : display;
      if (!Number.isInteger(n) || n < 0 || n > 127) {
        throw new Error(`${g.param}: expected an integer 0..127, got "${display}"`);
      }
      return n;
    },
    decode: (wire: number): number => wire,
  } as ParamSchema;
}

const BLOCK_LABELS: Record<string, string> = {
  oscillator: 'Oscillator',
  oscillator1: 'Oscillator 1',
  oscillator2: 'Oscillator 2',
  lfo1: 'LFO 1',
  lfo2: 'LFO 2',
  fx1: 'FX 1',
  fx2: 'FX 2',
  fx3: 'FX 3',
  seq: 'Sequencer',
  filter: 'Filter',
  envelope: 'Envelope',
  cycling_env: 'Cycling Envelope',
  lfo: 'LFO',
  arp: 'Arpeggiator / Sequencer',
  keyboard: 'Keyboard',
};

export function buildBlocks(config: FreakConfig): Record<string, BlockSchema> {
  const blocks: Record<string, BlockSchema> = {};

  for (const cc of config.ccs) {
    const existing = blocks[cc.block];
    const params: Record<string, ParamSchema> = existing === undefined
      ? {}
      : { ...existing.params };
    params[cc.param] = ccParam(cc);
    blocks[cc.block] = {
      display_name: BLOCK_LABELS[cc.block] ?? cc.block,
      params,
    };
  }

  // The `system` block exists ONLY when the device has a confirmed SysEx device
  // code. A device without one (MiniFreak) must not advertise globals it cannot
  // reach, so the block is absent rather than present-and-broken.
  if (config.sysex !== undefined) {
    const systemParams: Record<string, ParamSchema> = {};
    for (const g of config.sysex.globals) systemParams[g.param] = globalParam(g);
    blocks.system = { display_name: 'Utility / global settings', params: systemParams };
  }

  return blocks;
}
