/**
 * Axe-Fx Standard/Ultra (gen-1) DeviceWriter.
 *
 * Scope: this WRITER owns the SET path (`buildSetParam` + `setParam` +
 * `setParams`) and `switchPreset` (standard MIDI Program Change 0..127, a
 * channel voice message, NOT gen-1 SysEx; the published gen-1 SysEx spec has
 * no preset-change function and pins no bank-select mechanism, so presets
 * >= 128 refuse honestly). Parameter READ-back is wired separately in
 * `reader.ts` (fn 0x02 query -> MIDI_PARAM_VALUE), so gen-1 supports both set
 * AND get_param. Save and scenes/channels are genuinely out of scope (not in
 * the published gen-1 doc); the dispatcher returns `capability_not_supported`
 * for those. Do not read "SET path" here as "set-only device".
 *
 * Community-beta: the wire is decoded byte-exactly from the vendor doc but not
 * confirmed on gen-1 hardware. Every response carries a beta note pointing the
 * user at the front panel. SysEx ops additionally carry the Standard
 * model-byte warning when the matched port looks like a Standard (frames use
 * the Ultra byte 0x01; Standard may be 0x00; see ../midi.ts).
 */

import type {
  BatchWriteResult,
  DeviceWriter,
  DispatchCtx,
  LocationRef,
  WriteOp,
  WriteResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { buildProgramChange } from '@mcp-midi-control/core/midi/messages.js';

import {
  KNOWN_PARAMS,
  blockIdFor,
  buildSetParam as buildSetParamBytes,
  type AxeFxGen1Param,
} from 'fractal-midi/gen1';

import { gen1StandardModelByteWarning } from '../midi.js';

const DEVICE_LABEL = 'Fractal Axe-Fx Standard/Ultra';
const BETA_NOTE =
  'gen-1 (Axe-Fx Standard/Ultra) is community-beta: the wire is decoded from the published ' +
  'Ultra SysEx doc but not hardware-verified. Confirm the change on the front panel.';

function resolveParam(block: string, name: string): AxeFxGen1Param {
  const p = KNOWN_PARAMS[`${block}.${name}` as keyof typeof KNOWN_PARAMS] as AxeFxGen1Param | undefined;
  if (!p) {
    const known = Object.values(KNOWN_PARAMS)
      .filter((x) => (x as AxeFxGen1Param).block === block)
      .map((x) => (x as AxeFxGen1Param).name);
    throw new DispatchError(
      'unknown_param',
      DEVICE_LABEL,
      `Unknown parameter '${block}.${name}' on ${DEVICE_LABEL}.` +
        (known.length ? ` Known params for ${block}: ${known.slice(0, 20).join(', ')}${known.length > 20 ? ', …' : ''}.` : ` Unknown block '${block}'.`),
      { retry_action: `Call list_params({port, block:["${block}"]}) for the canonical names.` },
    );
  }
  return p;
}

export const writer: DeviceWriter = {
  buildSetParam(block, name, wireValue): number[] {
    const p = resolveParam(block, name);
    const blockId = blockIdFor(block, 1);
    if (blockId === undefined) {
      throw new DispatchError('unknown_block', DEVICE_LABEL, `No wire blockId for '${block}' on ${DEVICE_LABEL}.`);
    }
    return buildSetParamBytes(blockId, p.paramId, wireValue);
  },

  async setParam(ctx: DispatchCtx, block, name, wireValue): Promise<WriteResult> {
    const bytes = writer.buildSetParam(block, name, wireValue);
    ctx.conn.send(bytes);
    const p = resolveParam(block, name);
    const display = makeDisplay(p, wireValue);
    const standardWarning = gen1StandardModelByteWarning();
    return {
      op: 'set_param',
      target: `${block}.${name}`,
      block,
      name,
      wire_value: wireValue,
      ...(display !== undefined ? { display_value: display } : {}),
      acked: true,
      info: `Set sent to ${DEVICE_LABEL}; the device does not echo writes, so read the value back with get_param (parameter read is wired, community-beta). ${BETA_NOTE}`,
      ...(standardWarning !== undefined ? { warning: standardWarning } : {}),
    };
  },

  async setParams(ctx: DispatchCtx, ops: readonly WriteOp[]): Promise<BatchWriteResult> {
    const writes: WriteResult[] = [];
    let acked_count = 0;
    let unacked_count = 0;
    for (const op of ops) {
      try {
        const r = await writer.setParam!(ctx, op.block, op.name, op.value as number, op.channel);
        writes.push(r);
        acked_count++;
      } catch (err) {
        writes.push({
          op: 'set_param',
          target: `${op.block}.${op.name}`,
          block: op.block,
          name: op.name,
          acked: false,
          warning: err instanceof Error ? err.message : String(err),
        });
        unacked_count++;
      }
    }
    return { writes, acked_count, unacked_count };
  },

  buildSwitchPreset(location): number[] {
    return buildProgramChange(0, resolveGen1PresetNumber(location));
  },

  // switch_preset: standard MIDI Program Change, NOT gen-1 SysEx. The gen-1
  // SysEx spec has no preset-change function; PC is the era-standard recall
  // path (the stored-read refusal in reader.ts already points users at it).
  // STRONG-evidence basis (standard MIDI channel voice message), ships
  // untested-community-beta. PC carries no model byte, so the Standard
  // model-byte question does not touch this op. PC reaches 128 programs; the
  // spec pins NO bank-select mechanism, so presets >= 128 refuse (see
  // resolveGen1PresetNumber).
  async switchPreset(ctx: DispatchCtx, location: LocationRef): Promise<WriteResult> {
    const preset = resolveGen1PresetNumber(location);
    ctx.conn.send(buildProgramChange(0, preset));
    return {
      op: 'switch_preset',
      target: `preset ${preset}`,
      acked: true,
      unconfirmed: true,
      info:
        `Sent standard MIDI Program Change ${preset} on channel 1. Which preset the unit recalls ` +
        `depends on its own MIDI channel (must be 1 or OMNI) and any custom PC mapping configured ` +
        `on the unit; there is no readback, so confirm the loaded preset on the front panel. ${BETA_NOTE}`,
    };
  },

  // get/save/scene/channel/block ops intentionally omitted: gen-1's doc
  // documents only the parameter-set message. The dispatcher returns
  // capability_not_supported for those unified tools.
};

/**
 * Resolve a switch_preset `location` to a MIDI program number 0..127.
 * Accepts an integer, a numeric string, or the spec's bank-letter labels
 * ("A000".."A127"; the digits are the absolute preset number). Mirrors the
 * reader's stored-read resolver, but the ceiling here is the PC range:
 * the published gen-1 SysEx spec has no preset-change function and pins no
 * bank-select mechanism, so presets >= 128 refuse rather than guess one.
 */
function resolveGen1PresetNumber(loc: LocationRef): number {
  let preset: number;
  if (typeof loc === 'number') {
    preset = loc;
  } else {
    const m = /^\s*(?:[abc])?\s*(\d{1,3})\s*$/i.exec(loc);
    if (!m) {
      throw new DispatchError(
        'bad_location',
        DEVICE_LABEL,
        `gen-1 preset locations are numbers (spec labels A000..C383), got ${JSON.stringify(loc)}.`,
      );
    }
    preset = Number.parseInt(m[1], 10);
  }
  if (!Number.isInteger(preset) || preset < 0 || preset > 383) {
    throw new DispatchError(
      'bad_location',
      DEVICE_LABEL,
      `gen-1 presets are 0..383 (banks A/B/C), got ${JSON.stringify(loc)}.`,
    );
  }
  if (preset > 127) {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      `switch_preset reaches presets 0..127 only (one standard MIDI Program Change). Preset ${preset} ` +
        `needs a bank change first, and the published gen-1 SysEx spec pins no bank-select mechanism, ` +
        `so this server will not guess one. Workaround: select the bank on the unit (or via send_cc ` +
        `CC#0 if you know your unit's bank-select convention), then switch_preset with the 0..127 ` +
        `number inside that bank. A community capture of the era's editor changing banks would close ` +
        `this (docs/contributing/devices/axe-fx-gen1.md).`,
    );
  }
  return preset;
}

/** Best-effort decode of the wire value back to a display label for the receipt. */
function makeDisplay(p: AxeFxGen1Param, wire: number): number | string | undefined {
  if (p.controlType === 'enum' || p.controlType === 'switch') return p.enumValues?.[wire] ?? wire;
  if (p.scaling !== 'linear' || !p.display) return undefined;
  const { min, max } = p.display;
  const wmax = p.range.max ?? 254;
  return Math.round((min + (wire / wmax) * (max - min)) * 100) / 100;
}
