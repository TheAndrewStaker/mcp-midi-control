/**
 * MicroFreak DeviceWriter.
 *
 * Two write paths, with very different evidence behind them:
 *
 *   - **Preset params over MIDI CC.** Arturia's manual Appendix D is the
 *     authoritative map. CC 23 (cutoff) and CC 83 (resonance) are
 *     hardware-confirmed by this project; CC 83 byte-exactly, via
 *     set-CC -> save -> dump -> diff, which moved exactly 3 bytes under the
 *     preset payload's own inline `Reso` label. Fire-and-forget: the device
 *     sends no acknowledgement and exposes no readback, so `acked` is honestly
 *     false with a reason rather than a fabricated success.
 *   - **Globals over SysEx `0x42`.** Hardware-confirmed: written on a MicroFreak
 *     to a value that DIFFERED from the one held, and the change verified by
 *     read-back in both directions. Writing an equal value would have passed
 *     whether or not the write did anything, so only the differing-value form is
 *     a real test. Every write is still verified by an immediate read-back,
 *     since the device never acknowledges one.
 *
 *     That read-back is only trustworthy because the reply matcher checks the
 *     DIRECTION byte. A global read answer and a global write command share the
 *     shape `02 42 <param> <value>` and differ only in byte 5 (`0x7F` from the
 *     device, `0x01` to it), so without that check a write echoed back on the
 *     port would satisfy the matcher and confirm itself. See codec/sysex.ts.
 *
 * TWO GLOBALS CAN BREAK SOMETHING THE READ-BACK CANNOT SEE, and they are guarded
 * differently on purpose:
 *
 *   - `output_dest` without its USB bit severs the transport this server speaks
 *     over. Always wrong, cannot be undone from here, so it is REFUSED.
 *   - `output_dest` without its MIDI bit, or `midi_thru` off, silences the 5-pin
 *     MIDI Out. Harmless on a synth with nothing plugged into it, fatal on a rig
 *     where that cable drives something else, and invisible either way because
 *     every read still travels over USB and still answers. So it WARNS, and only
 *     when the rig manifest actually declares a device on the other end of that
 *     cable. See `dinLegWarning` below and `../downstream.ts` for why the
 *     manifest is the oracle rather than a descriptor flag.
 *
 * `switch_preset` is Program Change and is hardware-confirmed **0-based**
 * (PC 4 loaded preset 5), which the manual never documents at all.
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

import {
  buildGlobalRead,
  buildGlobalWrite,
  decodeGlobalReply,
  globalReplyMatcher,
} from '../codec/sysex.js';
import { downstreamMidiConsumers, type DownstreamMidiConsumer } from '../downstream.js';
import { ccEvidenceNote, findCc, findGlobal, type FreakGlobal, type FreakConfig } from '../devices/types.js';

const READ_BACK_TIMEOUT_MS = 400;

/**
 * The warning a DIN-silencing global write earns, or undefined when it earns
 * none.
 *
 * Two conditions, and BOTH have to hold. The value has to actually take the
 * device's physical MIDI Out out of service (`din_alive` says which values keep
 * it in service), AND the rig manifest has to declare something plugged into
 * that output. Requiring the second is the whole design: most owners have
 * nothing in the MIDI Out, so a guard that fired on the value alone would warn
 * everybody about a consequence almost nobody has, and a warning that always
 * fires is one people learn to scroll past.
 *
 * It warns rather than refuses. Severing USB is always wrong and is refused,
 * because it breaks the server's own transport and cannot be undone from here.
 * Silencing the DIN leg is a legitimate thing a user may want; what is NOT
 * legitimate is doing it silently while their vocal chain is hanging off it.
 */
function dinLegWarning(
  config: FreakConfig,
  g: FreakGlobal,
  wireValue: number,
): string | undefined {
  if (g.din_alive === undefined || g.din_alive.has(wireValue)) return undefined;
  const consumers: DownstreamMidiConsumer[] = downstreamMidiConsumers(config.id);
  if (consumers.length === 0) return undefined;
  const fed = consumers.map((c) => `${c.name} (rig edge "${c.edge}")`).join(', ');
  return `system.${g.param} = ${wireValue} takes the ${config.display_name}'s 5-pin MIDI Out `
    + `out of service, and your rig manifest says that output feeds ${fed}. `
    + 'The write was sent, so that device is receiving nothing from here now. Nothing about '
    + 'this shows up in a read: every value on this synth still answers over USB, because USB '
    + 'is a different path from the cable that just went quiet. To put it back, set '
    + `system.${g.param} to ${[...g.din_alive].sort((a, b) => a - b).join(' or ')}.`;
}

/**
 * The MicroFreak's MIDI receive channel is user-configurable (Utility > MIDI >
 * Input Chan) and cannot be discovered over the wire, so CC/PC writes need a
 * channel from configuration. Defaults to 1; override with MCP_MICROFREAK_CHANNEL.
 */
function txChannel(config: FreakConfig): number {
  const raw = process.env[config.channel_env];
  const n = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 16) return 1;
  return n;
}

let seqCounter = 0;
const nextSeq = (): number => { const s = seqCounter; seqCounter = (seqCounter + 1) & 0x7f; return s; };

const isSystemBlock = (block: string): boolean => block.trim().toLowerCase() === 'system';

/**
 * Read one global straight back, so a community-beta write is a checked write.
 *
 * The device code MUST be threaded through to the matcher. Letting it default
 * would pin the reply matcher to the MicroFreak's `0x07` while the request below
 * goes out addressed to whatever device this config actually is, so on any other
 * Freak nothing would ever match and every global write would report itself
 * unconfirmed. That is a family-factory bug, not a MicroFreak one, and it only
 * surfaces on the second device.
 */
async function readBackGlobal(ctx: DispatchCtx, config: FreakConfig, id: number): Promise<number | undefined> {
  const device = config.sysex!.device_code;
  const seq = nextSeq();
  const waiter = ctx.conn.receiveSysExMatching(globalReplyMatcher(id, device), READ_BACK_TIMEOUT_MS)
    .catch(() => undefined);
  ctx.conn.send(buildGlobalRead(seq, id, device));
  const reply = await waiter;
  return reply === undefined ? undefined : decodeGlobalReply(reply);
}

async function writeGlobal(ctx: DispatchCtx, config: FreakConfig, name: string, wireValue: number): Promise<WriteResult> {
  const LABEL = config.display_name;
  if (config.sysex === undefined) {
    throw new DispatchError(
      'capability_not_supported', LABEL,
      `${LABEL} has no SysEx support in this server: its Arturia device-code byte is unknown, so `
      + 'the Utility/global surface cannot be addressed. Guessing the byte would target a '
      + 'different Arturia product. Capture it from a MIDI Control Center session to enable this.',
    );
  }
  const g = findGlobal(config, name);
  if (g === undefined) {
    throw new DispatchError('unknown_param', LABEL, `Unknown global parameter 'system.${name}' on ${LABEL}.`);
  }

  // Refuse to sever the transport we are speaking over. `Output dest` selects
  // which physical outputs carry MIDI; setting it to a value without the USB bit
  // silently disconnects this server from the device, and because the setting is
  // then unreadable (the read travels over the same USB path) it cannot even be
  // undone from here. Front panel only.
  const usbAlive = config.sysex.output_dest_usb_alive ?? new Set<number>();
  if (g.usb_critical === true && !usbAlive.has(wireValue)) {
    throw new DispatchError(
      'bad_request',
      LABEL,
      `Refusing to set system.${g.param} to ${wireValue}: that value does not include USB, `
      + `which is the transport this server uses to reach the ${LABEL}. The write would `
      + `disconnect the device AND make the setting unreadable, so it could not be undone `
      + `from here. Change it on the front panel (Utility > MIDI > Output dest) if you `
      + `really want it. USB-alive values: ${[...usbAlive].join(', ')}.`,
    );
  }

  ctx.conn.send(buildGlobalWrite(nextSeq(), g.id, wireValue, config.sysex.device_code));
  if (ctx.conn.lastSendError !== undefined) {
    throw new DispatchError('stale_handle', LABEL, `Send failed: ${ctx.conn.lastSendError.message}`);
  }

  const readBack = await readBackGlobal(ctx, config, g.id);
  const acked = readBack === wireValue;
  const result: WriteResult = {
    op: 'set_param',
    target: `system.${g.param}`,
    block: 'system',
    name: g.param,
    wire_value: wireValue,
    acked,
  };
  if (!acked) {
    result.unconfirmed = true;
    result.warning = readBack === undefined
      ? 'Write sent, but the read-back did not answer within the window, so it is unconfirmed.'
      : `Write sent, but the read-back returned ${readBack} rather than ${wireValue}. `
        + 'Trust the read-back: it reports what the device actually holds now. A value the device '
        + 'refused or clamped reads back as the value it kept, so treat this as the write being '
        + 'rejected rather than as a reporting glitch.';
  }

  // Keyed off what the DEVICE now holds, not off what we asked for. If the write
  // was clamped or rejected the read-back is the honest value, and warning about
  // a leg that is still carrying would be a false alarm.
  const effective = readBack ?? wireValue;
  const dinWarning = dinLegWarning(config, g, effective);
  if (dinWarning !== undefined) {
    result.warning = result.warning === undefined ? dinWarning : `${result.warning} ${dinWarning}`;
  }
  return result;
}

function writeCc(ctx: DispatchCtx, config: FreakConfig, block: string, name: string, wireValue: number): WriteResult {
  const LABEL = config.display_name;
  const cc = findCc(config, block, name);
  if (cc === undefined) {
    throw new DispatchError('unknown_param', LABEL, `Unknown parameter '${block}.${name}' on ${LABEL}.`);
  }
  const status = 0xb0 | (txChannel(config) - 1);
  ctx.conn.send([status, cc.cc, wireValue & 0x7f]);
  if (ctx.conn.lastSendError !== undefined) {
    throw new DispatchError('stale_handle', LABEL, `Send failed: ${ctx.conn.lastSendError.message}`);
  }
  // A CC whose NUMBER is only second-hand carries a different, louder risk than
  // one that is merely unacknowledged: a wrong number moves some OTHER parameter
  // instead of doing nothing, and nothing here can detect that. It gets its own
  // sentence rather than being folded into the generic no-ack wording.
  const evidenceNote = ccEvidenceNote(cc);
  return {
    op: 'set_param',
    target: `${block}.${name}`,
    block,
    name,
    wire_value: wireValue,
    acked: false,
    unconfirmed: true,
    info:
      `CC ${cc.cc} sent. This device neither acknowledges CC nor reports preset parameter `
      + 'values back (its display does not even show incoming CC, contrary to the manual), so '
      + 'this cannot be confirmed from here. Confirm by ear, or save the preset and dump it.'
      + (evidenceNote === undefined ? '' : ` ${evidenceNote}`),
  };
}

export function createWriter(config: FreakConfig): DeviceWriter {
  const LABEL = config.display_name;
  return {
  buildSetParam(block: string, name: string, wireValue: number): number[] {
    if (isSystemBlock(block)) {
      const g = config.sysex === undefined ? undefined : findGlobal(config, name);
      if (g === undefined) {
        throw new DispatchError('unknown_param', LABEL, `Unknown global parameter 'system.${name}'.`);
      }
      return buildGlobalWrite(nextSeq(), g.id, wireValue, config.sysex!.device_code);
    }
    const cc = findCc(config, block, name);
    if (cc === undefined) {
      throw new DispatchError('unknown_param', LABEL, `Unknown parameter '${block}.${name}'.`);
    }
    return [0xb0 | (txChannel(config) - 1), cc.cc, wireValue & 0x7f];
  },

  buildSwitchPreset(location: LocationRef): number[] {
    const slot = typeof location === 'number' ? location : Number(location);
    // Hardware-confirmed 0-based: PC 4 loaded preset 5.
    return [0xc0 | (txChannel(config) - 1), (slot - 1) & 0x7f];
  },

  async setParam(ctx: DispatchCtx, block: string, name: string, wireValue: number): Promise<WriteResult> {
    if (isSystemBlock(block)) return writeGlobal(ctx, config, name, wireValue);
    return writeCc(ctx, config, block, name, wireValue);
  },

  async setParams(ctx: DispatchCtx, ops: readonly WriteOp[]): Promise<BatchWriteResult> {
    const writes: WriteResult[] = [];
    let acked_count = 0;
    let unacked_count = 0;
    for (const op of ops) {
      try {
        const r = isSystemBlock(op.block)
          ? await writeGlobal(ctx, config, op.name, op.value as number)
          : writeCc(ctx, config, op.block, op.name, op.value as number);
        writes.push(r);
        if (r.acked) acked_count++; else unacked_count++;
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

  async switchPreset(ctx: DispatchCtx, location: LocationRef): Promise<WriteResult> {
    const slot = typeof location === 'number' ? location : Number(location);
    if (!Number.isInteger(slot) || slot < 1 || slot > config.preset_count) {
      throw new DispatchError(
        'bad_location',
        LABEL,
        `Preset must be 1..${config.preset_count} on ${LABEL}. `
        + 'Firmware 4 units only have 384; the ceiling is probe-able by reading preset names.',
      );
    }
    if (slot > config.pc_max_preset) {
      throw new DispatchError(
        'capability_not_supported',
        LABEL,
        `Preset ${slot} is beyond ${config.pc_max_preset}, and plain Program Change only addresses 0..127. `
        + 'Bank Select for the higher banks is NOT decoded or tested on this device, so this '
        + 'refuses rather than sending a message that would silently load the wrong sound. '
        + 'Select it on the front panel.',
      );
    }
    ctx.conn.send([0xc0 | (txChannel(config) - 1), (slot - 1) & 0x7f]);
    if (ctx.conn.lastSendError !== undefined) {
      throw new DispatchError('stale_handle', LABEL, `Send failed: ${ctx.conn.lastSendError.message}`);
    }
    return {
      op: 'switch_preset',
      target: String(slot),
      acked: false,
      unconfirmed: true,
      info:
        'Program Change sent (0-based, hardware-confirmed). The MicroFreak does not acknowledge '
        + 'preset changes on the wire, so confirm on its display.',
    };
  },
  };
}
