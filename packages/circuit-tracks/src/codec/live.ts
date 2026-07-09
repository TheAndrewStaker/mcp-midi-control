/**
 * Live control codec: emit CC and NRPN writes on a track's channel
 * (handoff §4). The NRPN form is the standard 3-message sequence
 * (CC 99 MSB / CC 98 LSB / CC 6 Data Entry MSB), all documented values
 * fit 7 bits, so Data Entry LSB (CC 38) is unused. A Null-RPN terminator
 * (CC 99 = 127 / CC 98 = 127) is opt-in; only emit it if hardware shows
 * sticky-NRPN behavior (handoff §4 recommendation).
 */

import type { CircuitParam } from '../params.js';

/** Channel byte for status `base | (ch-1)`. `channel` is 1..16. */
function statusByte(base: number, channel: number): number {
  return base | ((channel - 1) & 0x0f);
}

/** A single Control Change message. `channel` 1..16. */
export function ccMessage(channel: number, cc: number, value: number): number[] {
  return [statusByte(0xb0, channel), cc & 0x7f, value & 0x7f];
}

/** The CC sequence for one NRPN write (3 messages, +2 if null-terminated). */
export function nrpnMessages(
  channel: number, msb: number, lsb: number, value: number, nullTerminate = false,
): number[][] {
  const st = statusByte(0xb0, channel);
  const msgs: number[][] = [
    [st, 99, msb & 0x7f], // CC 99 = NRPN MSB
    [st, 98, lsb & 0x7f], // CC 98 = NRPN LSB
    [st, 6, value & 0x7f], // CC 6  = Data Entry MSB
  ];
  if (nullTerminate) {
    msgs.push([st, 99, 0x7f], [st, 98, 0x7f]);
  }
  return msgs;
}

/**
 * One write as a list of discrete MIDI messages (node-midi sends one at a time).
 * `opts.channel` overrides the param's registry channel (used to target Synth 2
 * on ch2 via the instance arg); defaults to the param's own channel.
 */
export function paramMessages(
  param: CircuitParam, wireValue: number, opts: { channel?: number; nullTerminate?: boolean } = {},
): number[][] {
  const ch = opts.channel ?? param.channel;
  if (param.addr.kind === 'cc') {
    return [ccMessage(ch, param.addr.cc, wireValue)];
  }
  return nrpnMessages(ch, param.addr.msb, param.addr.lsb, wireValue, opts.nullTerminate ?? false);
}

/** One write as a single flat byte run (concatenated messages), for pure builders / goldens. */
export function paramWire(param: CircuitParam, wireValue: number, nullTerminate = false): number[] {
  return paramMessages(param, wireValue, { nullTerminate }).flat();
}
