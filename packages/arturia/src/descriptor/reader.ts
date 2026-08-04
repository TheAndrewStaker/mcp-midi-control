/**
 * MicroFreak DeviceReader.
 *
 * **The asymmetry here is the whole story, and it is deliberate.**
 *
 *   - `system.*` (Utility globals) READ fine. SysEx `0x43` answers for all 128
 *     param slots; hardware-confirmed 2026-07-25.
 *   - Preset params (the CC-driven ones) CANNOT be read at all. The MicroFreak
 *     returns no value for them, its OLED does not even display an incoming CC
 *     (Arturia's manual claims it responds "as if you had turned a knob", which
 *     is false on fw 5.0.0), and its knob-catch position does not track
 *     CC-received values either. Save-then-dump is the only readback that
 *     exists, and that is a destructive, multi-step operation, not a `get_param`.
 *
 * So `getParam` refuses for preset params with an explanation and a workaround,
 * instead of returning a guessed or echoed value. Echoing back what was last
 * written would be the tempting shortcut and would be a lie: it would report
 * success even if the CC never reached the device.
 *
 * `scanLocations` reads stored preset NAMES, which IS supported and
 * hardware-confirmed (fixed ASCII offset 21, null-padded, seq echoed).
 */

import type {
  BatchReadResult,
  DeviceReader,
  DispatchCtx,
  ParamQuery,
  ReadResult,
  ScannedLocation,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  buildGlobalRead,
  buildNameRequest,
  decodeGlobalReply,
  decodePresetName,
  globalReplyMatcher,
  nameReplyMatcher,
} from '../codec/sysex.js';
import { findGlobal, type FreakConfig } from '../devices/types.js';

const READ_TIMEOUT_MS = 400;

let seqCounter = 0x40;
const nextSeq = (): number => { const s = seqCounter; seqCounter = (seqCounter + 1) & 0x7f; return s; };

const isSystemBlock = (block: string): boolean => block.trim().toLowerCase() === 'system';

function refusePresetRead(LABEL: string, block: string, name: string): never {
  throw new DispatchError(
    'capability_not_supported',
    LABEL,
    `${LABEL} cannot report '${block}.${name}'. Preset parameters are driven by MIDI CC and the `
    + 'device sends nothing back for them: its display does not show incoming CC (contrary to '
    + "Arturia's manual) and the knob-catch position does not track CC-set values. Reading one "
    + 'requires saving the preset to a slot and dumping it, which is a destructive multi-step '
    + `operation rather than a read. The Utility globals DO read back: try 'system.<param>' `
    + '(midi_input_channel, sync_source, midi_thru, ...).',
  );
}

async function readGlobal(config: FreakConfig, name: string, ctx: DispatchCtx): Promise<ReadResult> {
  const LABEL = config.display_name;
  if (config.sysex === undefined) {
    throw new DispatchError(
      'capability_not_supported', LABEL,
      `${LABEL} has no SysEx support in this server: its Arturia device-code byte is unknown, so `
      + 'nothing on it can be read back. Every parameter is write-only here.',
    );
  }
  const g = findGlobal(config, name);
  if (g === undefined) {
    throw new DispatchError('unknown_param', LABEL, `Unknown global parameter 'system.${name}' on ${LABEL}.`);
  }
  const seq = nextSeq();
  const waiter = ctx.conn.receiveSysExMatching(globalReplyMatcher(g.id, config.sysex.device_code), READ_TIMEOUT_MS)
    .catch(() => undefined);
  ctx.conn.send(buildGlobalRead(seq, g.id, config.sysex.device_code));
  const reply = await waiter;
  if (reply === undefined) {
    throw new DispatchError(
      'no_ack',
      LABEL,
      `No reply reading system.${g.param} within ${READ_TIMEOUT_MS}ms. Check the MicroFreak is `
      + 'connected by USB and that Utility > MIDI > Output dest includes USB.',
    );
  }
  const wire = decodeGlobalReply(reply);
  const display = g.channel === true
    ? wire + 1
    : (g.values !== undefined ? (g.values[wire] ?? `unknown(${wire})`) : wire);
  return {
    block: 'system',
    name: g.param,
    wire_value: wire,
    display_value: display,
    unit: g.channel === true ? 'count' : (g.values !== undefined ? 'enum' : 'count'),
    raw_response: [...reply],
  };
}

export function createReader(config: FreakConfig): DeviceReader {
  const LABEL = config.display_name;
  return {
  async getParam(ctx: DispatchCtx, block: string, name: string): Promise<ReadResult> {
    if (!isSystemBlock(block)) refusePresetRead(LABEL, block, name);
    return readGlobal(config, name, ctx);
  },

  async getParams(ctx: DispatchCtx, queries: readonly ParamQuery[]): Promise<BatchReadResult> {
    const reads: ReadResult[] = [];
    const failed: number[] = [];
    const errors: Record<number, string> = {};
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      try {
        if (!isSystemBlock(q.block)) refusePresetRead(LABEL, q.block, q.name);
        reads.push(await readGlobal(config, q.name, ctx));
      } catch (err) {
        failed.push(i);
        errors[i] = err instanceof Error ? err.message : String(err);
      }
    }
    const result: BatchReadResult = { reads, failed_indices: failed };
    if (failed.length > 0) result.errors = errors;
    return result;
  },

  async scanLocations(ctx: DispatchCtx, from: string | number, to: string | number): Promise<{
    scanned: readonly ScannedLocation[];
    failed_at?: string;
    failed_reason?: string;
  }> {
    const start = Math.max(1, Number(from));
    const end = Math.min(config.sysex?.preset_count ?? config.preset_count, Number(to));
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
      throw new DispatchError('bad_location', LABEL, `Bad scan range ${String(from)}..${String(to)}.`);
    }

    if (config.sysex === undefined) {
      throw new DispatchError(
        'capability_not_supported', LABEL,
        `${LABEL} cannot list preset names: its Arturia device-code byte is unknown, so the SysEx `
        + 'name-read path is unavailable.',
      );
    }
    const device = config.sysex.device_code;
    const scanned: ScannedLocation[] = [];
    for (let slot = start; slot <= end; slot++) {
      const slot0 = slot - 1;
      const seq = nextSeq();
      const waiter = ctx.conn.receiveSysExMatching(nameReplyMatcher(seq, slot0, device), READ_TIMEOUT_MS)
        .catch(() => undefined);
      ctx.conn.send(buildNameRequest(seq, slot0, device));
      const reply = await waiter;
      if (reply === undefined) {
        // A silent slot means past the memory ceiling: fw4 units stop at 384,
        // fw5 at 512. NOTE the device answers for exactly ONE index past the
        // last full bank (a range-check off-by-one, reproduced across both
        // firmwares), so a lone trailing answer is not a real slot.
        return {
          scanned,
          failed_at: String(slot),
          failed_reason:
            `No reply for preset ${slot}. That is normally the memory ceiling (384 on firmware 4, `
            + '512 on firmware 5), not an error.',
        };
      }
      const name = decodePresetName(reply);
      scanned.push({ location: String(slot), name, is_empty: name === '' || name === 'Init' });
    }
    return { scanned };
  },
  };
}
