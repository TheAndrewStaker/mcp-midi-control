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
 *
 * `dumpStoredPresetBinary` (BK-MF-EXPORT, 2026-08-11) is the byte-exact
 * stored-preset dump behind export_preset(location) / backup_device: the
 * probe-confirmed 146-packet flow, ported here as an untested community-beta
 * tool path. Attached only when `config.sysex` exists.
 */

import type {
  BatchReadResult,
  DeviceReader,
  DispatchCtx,
  ParamQuery,
  PresetBinaryDump,
  ReadResult,
  ScannedLocation,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  buildDumpNext,
  buildDumpStart,
  buildGlobalRead,
  buildNameRequest,
  decodeGlobalReply,
  decodePresetName,
  decodePresetType,
  dumpAckMatcher,
  dumpPacketMatcher,
  dumpPacketPayload,
  globalReplyMatcher,
  isLastDumpPacket,
  nameReplyMatcher,
} from '../codec/sysex.js';
import { findGlobal, type FreakConfig } from '../devices/types.js';

const READ_TIMEOUT_MS = 400;

/**
 * Per-round-trip timeout for the preset-dump flow. More generous than the
 * single-frame READ_TIMEOUT_MS: the dump start makes the device assemble a
 * whole preset, and the probe that hardware-confirmed the flow allowed 2500 ms.
 */
const DUMP_TIMEOUT_MS = 1500;

/**
 * Hard stop on the packet-pull loop. The hardware-confirmed dump is 146
 * packets; this bound only exists so a device that never sends the 0x17
 * terminator cannot spin the loop forever.
 */
const DUMP_MAX_PACKETS = 512;

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

/**
 * Byte-exact backup of one STORED preset: the multi-packet dump flow the
 * 2026-07-25 probe hardware-confirmed (scripts/probe-microfreak-dump.ts;
 * STATE-MICROFREAK.md "FULL PRESET DUMP": 146 packets / 4672 payload bytes,
 * clean 0x17 termination, fw 5.0.0). This tool wiring of that flow is NEW and
 * itself untested on hardware (community beta); the dump.warning says so.
 *
 * `location` is DEVICE numbering: preset 1..preset_count, the same numbers
 * scan_locations and switch_preset speak. Read-only: the dump does not load
 * the preset or touch the working buffer.
 *
 * Discipline notes (same rules the name-scan established):
 *   - every reply matcher checks the echoed seq AND a reply-only command byte
 *     (0x15/0x16/0x17), so a looped-back request (0x19/0x18) can never
 *     self-confirm; see the matcher block in codec/sysex.ts.
 *   - a stream that stalls or never reaches the 0x17 terminator THROWS.
 *     Partial bytes are never returned: a truncated file saved as a backup is
 *     worse than no file (it fails at restore time, not at read time).
 */
async function dumpStoredPreset(
  config: FreakConfig,
  location: number,
  ctx: DispatchCtx,
): Promise<PresetBinaryDump> {
  const LABEL = config.display_name;
  const sysex = config.sysex;
  if (sysex === undefined) {
    throw new DispatchError(
      'capability_not_supported', LABEL,
      `${LABEL} has no SysEx support in this server (device-code byte unknown), so its stored presets cannot be dumped.`,
    );
  }
  const presetCount = sysex.preset_count ?? config.preset_count;
  if (!Number.isInteger(location) || location < 1 || location > presetCount) {
    throw new DispatchError(
      'bad_location', LABEL,
      `Stored-preset export on ${LABEL} takes a preset number 1..${presetCount} (the numbers the front panel and scan_locations use); got ${String(location)}.`,
    );
  }
  const device = sysex.device_code;
  const slot0 = location - 1;

  // Best-effort name read (hardware-confirmed path) so the backup file can
  // carry the preset's name. A timeout here is not an error: the dump itself
  // decides whether the slot answers.
  // The same reply also carries the preset's CATEGORY (offset 19), which is
  // NOT in the 4672-byte payload at any offset. Capturing it here is what
  // makes a category round-trip possible at all: export_preset returns it and
  // import_preset takes it back as `preset_type`. Without it a byte-exact
  // restore is byte-exact in sound and wrong in filing.
  let name: string | undefined;
  let category: number | undefined;
  {
    const seq = nextSeq();
    const waiter = ctx.conn.receiveSysExMatching(nameReplyMatcher(seq, slot0, device), READ_TIMEOUT_MS)
      .catch(() => undefined);
    ctx.conn.send(buildNameRequest(seq, slot0, device));
    const reply = await waiter;
    if (reply !== undefined) {
      const decoded = decodePresetName(reply);
      if (decoded.length > 0) name = decoded;
      category = decodePresetType(reply);
    }
  }

  // Dump start -> 0x15 ack.
  const startSeq = nextSeq();
  const ackWaiter = ctx.conn.receiveSysExMatching(dumpAckMatcher(startSeq, device), DUMP_TIMEOUT_MS)
    .catch(() => undefined);
  ctx.conn.send(buildDumpStart(startSeq, slot0, device));
  if (await ackWaiter === undefined) {
    throw new DispatchError(
      'no_ack', LABEL,
      `No dump-start acknowledgement for preset ${location} within ${DUMP_TIMEOUT_MS}ms. ` +
      'Either the slot is past the memory ceiling (384 presets on firmware 4, 512 on firmware 5), ' +
      'or the device is not reachable over USB right now. Nothing was written.',
    );
  }

  // Pull data packets (0x16 = more follow) until the 0x17 last-packet marker.
  const frames: number[][] = [];
  let payloadBytes = 0;
  let sawLast = false;
  for (let i = 0; i < DUMP_MAX_PACKETS; i++) {
    const seq = nextSeq();
    const waiter = ctx.conn.receiveSysExMatching(dumpPacketMatcher(seq, device), DUMP_TIMEOUT_MS)
      .catch(() => undefined);
    ctx.conn.send(buildDumpNext(seq, device));
    const pkt = await waiter;
    if (pkt === undefined) {
      throw new DispatchError(
        'no_ack', LABEL,
        `Preset ${location} dump stalled: no reply to data request ${i + 1} within ${DUMP_TIMEOUT_MS}ms ` +
        `(${frames.length} packets had arrived). The partial read was DISCARDED, no backup file will be ` +
        'written from it. Check the USB connection and retry.',
      );
    }
    frames.push([...pkt]);
    payloadBytes += dumpPacketPayload(pkt).length;
    if (isLastDumpPacket(pkt)) {
      sawLast = true;
      break;
    }
  }
  if (!sawLast) {
    throw new DispatchError(
      'no_ack', LABEL,
      `Preset ${location} dump never terminated: ${frames.length} packets arrived without the 0x17 ` +
      'last-packet marker (the hardware-confirmed dump is 146 packets). The read was DISCARDED rather ' +
      'than saved as a truncated backup.',
    );
  }

  const total = frames.reduce((n, f) => n + f.length, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const f of frames) {
    bytes.set(Uint8Array.from(f), off);
    off += f.length;
  }
  return {
    bytes,
    byte_length: bytes.length,
    frame_count: frames.length,
    format: 'microfreak-preset-dump',
    ...(name !== undefined ? { name } : {}),
    ...(category !== undefined ? { category } : {}),
    source: `stored preset ${location} (flash copy, ${payloadBytes} payload bytes in ${frames.length} packets)`,
    file_extension: 'syx',
    warning:
      'Hardware-confirmed 2026-08-14: this export wiring itself has read real stored presets ' +
      '(146-packet / 4672-byte dump, clean 0x17 termination, firmware 5.0.0) multiple times on the ' +
      'maintainer\'s unit, and a file it wrote round-tripped byte-exact through import_preset ' +
      '(0 of 6,132 bytes differed on read-back). import_preset can restore this file to a stored ' +
      'slot (also hardware-confirmed; requires target_location, save_authorized, and an explicit ' +
      'name, since this file does not carry the preset name itself).',
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

  // Presence of this method is itself a capability signal: the backup
  // dispatcher derives `can_dump_stored` from it (resolveBackupPolicy) and
  // export_preset(location) gates on it. So it is attached ONLY when the
  // SysEx surface exists; a Freak with no device code (MiniFreak) must not
  // advertise a stored dump it cannot perform.
  ...(config.sysex !== undefined
    ? {
        dumpStoredPresetBinary: (location: number, ctx: DispatchCtx): Promise<PresetBinaryDump> =>
          dumpStoredPreset(config, location, ctx),
      }
    : {}),
  };
}
