/**
 * AM4-specific MIDI helpers. Thin wrappers over the generic transport
 * in `@/core/midi/transport.ts` plus the AM4 SysEx-aware inbound
 * message describer used by every AM4 tool's diagnostic timeline.
 *
 * Generic MIDI port enumeration / connect / hex helpers live in
 * `@/core/midi/transport.ts`. Re-exported below until call sites are
 * migrated to import from core directly.
 */

import {
  connect,
  listMidiPorts as listMidiPortsGeneric,
  mockConnect,
  type MidiConnection,
  type MidiPortInfo as GenericMidiPortInfo,
  type MockResponder,
} from '@mcp-midi-control/core/midi/transport.js';
import { fractalChecksum } from 'fractal-midi/shared';
import { packValue, packValueChunked } from 'fractal-midi/shared';

export {
  connect,
  toHex,
  type ConnectOptions,
  type MidiConnection,
} from '@mcp-midi-control/core/midi/transport.js';

/** Substrings used to find AM4 ports — `am4` matches Windows/Mac, `fractal` covers some driver variants. */
export const AM4_PORT_NEEDLES = ['am4', 'fractal'] as const;

/**
 * AM4-flavored port info: the generic `MidiPortInfo` plus a
 * `looksLikeAM4` flag tagged against the AM4 needle list. Existing
 * call sites read `looksLikeAM4` directly; new code should pass the
 * AM4 needles into `listMidiPorts` and read `matched` instead.
 */
export interface MidiPortInfo extends GenericMidiPortInfo {
  looksLikeAM4: boolean;
}

/**
 * AM4-flavored port enumeration. Always tags `looksLikeAM4` against
 * the AM4 needle list, regardless of what `needles` is passed.
 * Defaults to the AM4 needles, so AM4-specific callers can call
 * `listMidiPorts()` with no args.
 */
export function listMidiPorts(
  needles: readonly string[] = AM4_PORT_NEEDLES,
): { inputs: MidiPortInfo[]; outputs: MidiPortInfo[] } {
  const both = listMidiPortsGeneric(needles);
  const tag = (p: GenericMidiPortInfo): MidiPortInfo => ({
    ...p,
    looksLikeAM4: AM4_PORT_NEEDLES.some((n) => p.name.toLowerCase().includes(n)),
  });
  return {
    inputs: both.inputs.map(tag),
    outputs: both.outputs.map(tag),
  };
}

/**
 * Open a connection to the AM4. Thin wrapper around `connect()` that
 * supplies the AM4-specific name needles and the install/driver hints
 * users hit during AM4 onboarding.
 *
 * When `MCP_MOCK_TRANSPORT=1` is set in the environment, returns a
 * mock connection backed by `am4MockResponder` (no USB). Lets the
 * agent-regression harness exercise the full dispatcher pipeline
 * (display → wire encoding, channel switching, validator-layer error
 * envelopes, applyExecutor) against in-memory state. Real-hardware
 * release-gate tests (launch-verify, Desktop e2e) ignore the flag.
 */
export function connectAM4(): MidiConnection {
  if (process.env.MCP_MOCK_TRANSPORT === '1') {
    return mockConnect({ responder: am4MockResponder });
  }
  return connect({
    needles: AM4_PORT_NEEDLES,
    notFoundLeadIn: 'AM4 not found in the MIDI device list. Common causes:',
    notFoundHints: [
      '  - AM4 is powered off or not connected by USB',
      '  - AM4 USB driver not installed (https://www.fractalaudio.com/am4-downloads/)',
      '',
      'Once the AM4 is visible, call `list_midi_ports` to confirm the server sees it, then retry. Use `reconnect_midi` to force a fresh handle.',
    ],
  });
}

/**
 * AM4-specific mock response synthesizer. Given an outgoing SysEx
 * frame, returns the inbound responses the AM4 would emit.
 *
 * Recognized shapes (see `setParam.ts` for outgoing layouts, this file's
 * `describeAm4InboundMessage` for inbound ack envelopes, `readOps.ts`
 * for the read predicates):
 *
 *   - 0x01 PARAM_RW + action=0x0001 WRITE → 64-byte write-echo
 *     (hdr4=0x0028). Satisfies `isWriteEcho`.
 *   - 0x01 PARAM_RW + action=0x000E short READ → 23-byte read response
 *     (hdr4=0x0004, 5 packed bytes). Satisfies `isReadResponse`. Value
 *     comes from `mockReadValueFor(pidLow, pidHigh)`.
 *   - 0x01 PARAM_RW + action=0x000D long READ (bypass) → 64-byte
 *     response (hdr4=0x0028) with bypass flag at byte 22.
 *   - 0x01 PARAM_RW + action=0x0012 READ_PRESET_NAME → 55-byte response
 *     (hdr4=0x0020, 37 packed bytes for 32-char preset name).
 *   - 0x01 PARAM_RW + other action (save/rename/preset-switch) →
 *     18-byte command-ack (hdr4=0x0000). Satisfies `isCommandAck`.
 *   - 0x12 mode switch → no response (write-only, no ack expected).
 *
 * Predicate-only correctness: AM4 predicates check structural fields
 * (envelope + function + addressing + hdr4 + length) plus a small
 * payload region (long read uses byte 22 for bypass). Filling the
 * rest of the payload with zeros is fine — the parsers tolerate
 * empty / zero-value content.
 *
 * The mock is stateless beyond `mockReadValueFor`'s hardcoded "current
 * location = Z04" hint. Writes succeed but their values aren't read
 * back; sufficient for agent-regression cases that test agent BEHAVIOR
 * (tool sequencing, arg correctness) rather than wire-roundtrip state.
 */
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const ACTION_WRITE_LO = 0x01;
const ACTION_LONG_READ_LO = 0x0d;
const ACTION_SHORT_READ_LO = 0x0e;
const ACTION_READ_PRESET_NAME_LO = 0x12;
const HDR4_WRITE_ECHO_LO = 0x28;
const HDR4_SHORT_READ_LO = 0x04;
const HDR4_LONG_READ_LO = 0x28;
const HDR4_READ_PRESET_NAME_LO = 0x20;

// Common AM4 state registers (see packages/am4/src/tools/read.ts and
// packages/am4/src/setParam.ts). Mock hardcodes plausible defaults so
// agents that poll state during hero-case prompts see something
// representative of a populated Z04 working buffer.
const LOCATION_STATE_PID_LOW = 0x00ce;
const LOCATION_STATE_PID_HIGH = 0x000a;
const MOCK_ACTIVE_LOCATION_INDEX = 103; // Z04

// Block-placement registers — slots 1..4 live at
// (pidLow=0x00CE, pidHigh=0x000F+i). The u32 value is the placed
// block's pidLow (e.g. amp=0x003A). See `BLOCK_SLOT_PID_LOW` /
// `BLOCK_SLOT_PID_HIGH_BASE` in setParam.ts.
const BLOCK_SLOT_PID_LOW = 0x00ce;
const BLOCK_SLOT_PID_HIGH_SLOT_1 = 0x000f;
const BLOCK_SLOT_PID_HIGH_SLOT_2 = 0x0010;
const BLOCK_SLOT_PID_HIGH_SLOT_3 = 0x0011;
const BLOCK_SLOT_PID_HIGH_SLOT_4 = 0x0012;

// Block-type pidLow values (mirror packages/am4/src/blockTypes.ts).
const BLOCK_PID_LOW_AMP = 0x003a;
const BLOCK_PID_LOW_REVERB = 0x0042;
const BLOCK_PID_LOW_DELAY = 0x0046;
const BLOCK_PID_LOW_CHORUS = 0x004e;

// Default mock preset placement: amp / chorus / reverb / delay on
// slots 1..4. Gives agents that read Z04 something realistic to
// tweak (without it, every slot reads as "none" and read-then-tweak
// prompts fail because there's no amp to bump gain on).
const MOCK_SLOT_BLOCK_TYPES: ReadonlyMap<number, number> = new Map([
  [BLOCK_SLOT_PID_HIGH_SLOT_1, BLOCK_PID_LOW_AMP],
  [BLOCK_SLOT_PID_HIGH_SLOT_2, BLOCK_PID_LOW_CHORUS],
  [BLOCK_SLOT_PID_HIGH_SLOT_3, BLOCK_PID_LOW_REVERB],
  [BLOCK_SLOT_PID_HIGH_SLOT_4, BLOCK_PID_LOW_DELAY],
]);

// Default mock param value: u32 32767 ÷ 65534 ≈ 0.5 → display ~5.0 on
// the 0..10 knob convention (`READ_VALUE_DENOMINATOR` = 65534, see
// `setParam.ts`). Sensible mid-scale for amp.gain, reverb.mix, etc.
const MOCK_DEFAULT_PARAM_VALUE = 32767;

/**
 * Compute the u32 value the mock should return for a short-read of a
 * given (pidLow, pidHigh) pair. Specialized for state registers the
 * hero cases poll; defaults to a mid-scale display value for any
 * param-read the mock doesn't have a specific answer for.
 */
function mockReadValueFor(pidLow: number, pidHigh: number): number {
  if (pidLow === LOCATION_STATE_PID_LOW && pidHigh === LOCATION_STATE_PID_HIGH) {
    return MOCK_ACTIVE_LOCATION_INDEX;
  }
  if (pidLow === BLOCK_SLOT_PID_LOW) {
    const placed = MOCK_SLOT_BLOCK_TYPES.get(pidHigh);
    if (placed !== undefined) return placed;
  }
  return MOCK_DEFAULT_PARAM_VALUE;
}

/**
 * Build the AM4 short-read response (23 bytes) for an outgoing short
 * read. Payload encodes a u32 little-endian value via the same
 * packValue scheme writes use.
 */
function buildShortReadResponse(outgoing: number[], pidLow: number, pidHigh: number): number[] {
  const value = mockReadValueFor(pidLow, pidHigh);
  const raw = new Uint8Array(4);
  new DataView(raw.buffer).setUint32(0, value, true);
  const packed = Array.from(packValue(raw));
  const body: number[] = new Array<number>(16).fill(0);
  body[0] = SYSEX_START;
  for (let i = 1; i <= 11; i++) body[i] = outgoing[i] ?? 0;
  body[12] = 0x00; body[13] = 0x00;
  body[14] = HDR4_SHORT_READ_LO; body[15] = 0x00;
  const head = [...body, ...packed];
  const cs = fractalChecksum(head);
  return [...head, cs, SYSEX_END];
}

/**
 * Build the AM4 long-read response (64 bytes) for an outgoing long
 * read. Payload is 40 zero bytes — agent reads bypass=0 at byte 22.
 */
function buildLongReadResponse(outgoing: number[]): number[] {
  const body: number[] = new Array<number>(62).fill(0);
  body[0] = SYSEX_START;
  for (let i = 1; i <= 11; i++) body[i] = outgoing[i] ?? 0;
  body[14] = HDR4_LONG_READ_LO; body[15] = 0x00;
  // bytes 16..61 zero — bypass flag at byte 22 stays 0 (active).
  const cs = fractalChecksum(body);
  return [...body, cs, SYSEX_END];
}

/**
 * Build the READ_PRESET_NAME response (55 bytes) for an outgoing
 * preset-name read. 32-char name is "(mock preset)" + spaces, packed
 * via packValueChunked into 37 wire bytes.
 */
function buildPresetNameResponse(outgoing: number[]): number[] {
  const name = '(mock preset)';
  const raw = new Uint8Array(32);
  for (let i = 0; i < name.length && i < 32; i++) raw[i] = name.charCodeAt(i);
  for (let i = name.length; i < 32; i++) raw[i] = 0x20; // pad with spaces
  const packed = Array.from(packValueChunked(raw));
  const body: number[] = new Array<number>(16).fill(0);
  body[0] = SYSEX_START;
  for (let i = 1; i <= 11; i++) body[i] = outgoing[i] ?? 0;
  body[14] = HDR4_READ_PRESET_NAME_LO; body[15] = 0x00;
  const head = [...body, ...packed];
  const cs = fractalChecksum(head);
  return [...head, cs, SYSEX_END];
}

export const am4MockResponder: MockResponder = (outgoing) => {
  if (outgoing.length < 8) return [];
  if (outgoing[0] !== SYSEX_START) return [];
  if (outgoing[1] !== 0x00 || outgoing[2] !== 0x01 || outgoing[3] !== 0x74 || outgoing[4] !== 0x15) {
    return [];
  }
  const fn = outgoing[5];
  if (fn !== 0x01) return []; // mode switches (0x12) etc. — write-only, no ack
  if (outgoing.length < 12) return [];
  const pidLow = (outgoing[6] ?? 0) | ((outgoing[7] ?? 0) << 7);
  const pidHigh = (outgoing[8] ?? 0) | ((outgoing[9] ?? 0) << 7);
  const actionLo = outgoing[10];
  const actionHi = outgoing[11];

  if (actionHi !== 0x00) {
    // High-byte non-zero actions aren't part of our envelope set —
    // return command-ack to keep the writer from timing out.
    return [buildCommandAck(outgoing)];
  }

  switch (actionLo) {
    case ACTION_WRITE_LO:
      return [buildWriteEcho(outgoing)];
    case ACTION_SHORT_READ_LO:
      return [buildShortReadResponse(outgoing, pidLow, pidHigh)];
    case ACTION_LONG_READ_LO:
      return [buildLongReadResponse(outgoing)];
    case ACTION_READ_PRESET_NAME_LO:
      return [buildPresetNameResponse(outgoing)];
    default:
      return [buildCommandAck(outgoing)];
  }
};

function buildWriteEcho(outgoing: number[]): number[] {
  const body: number[] = new Array<number>(62).fill(0);
  body[0] = SYSEX_START;
  for (let i = 1; i <= 9; i++) body[i] = outgoing[i] ?? 0;
  body[10] = ACTION_WRITE_LO; body[11] = 0x00;
  body[14] = HDR4_WRITE_ECHO_LO; body[15] = 0x00;
  const cs = fractalChecksum(body);
  return [...body, cs, SYSEX_END];
}

function buildCommandAck(outgoing: number[]): number[] {
  const ack: number[] = new Array<number>(16).fill(0);
  ack[0] = SYSEX_START;
  for (let i = 1; i <= 11; i++) ack[i] = outgoing[i] ?? 0;
  const cs = fractalChecksum(ack);
  return [...ack, cs, SYSEX_END];
}

// Register the AM4 connector with the shared connection registry as a
// side effect of loading this module. Importing anything from `am4/midi.ts`
// (or any module that transitively imports it) makes `ensureConnection(
// AM4_LABEL)` route through `connectAM4()` automatically. Tools and
// scripts that don't import this module fall back to the generic
// substring connect — fine for ad-hoc port lookups.
import { registerConnector, AM4_LABEL } from '@mcp-midi-control/core/server-shared/connections.js';
registerConnector(AM4_LABEL, connectAM4);

// -- AM4 inbound-message describer -----------------------------------------

import { toHex } from '@mcp-midi-control/core/midi/transport.js';

/**
 * AM4 SysEx envelope prefix: F0 00 01 74 15. Anything that doesn't start
 * with these 5 bytes (after the 0xF0) is non-AM4 SysEx and gets a generic
 * "non-AM4 SysEx" label so we still report it instead of pretending nothing
 * arrived.
 */
const AM4_SYSEX_PREFIX = [0x00, 0x01, 0x74, 0x15] as const;

/**
 * Decode 14-bit septet-encoded little-endian pair: low byte (bits 0-6) +
 * high byte (bits 7-13). Used by every AM4 ack we label here — function
 * arguments, action codes, and PP/QQ preset-number fields all follow this.
 */
function decode14(lo: number, hi: number): number {
  return ((hi & 0x7f) << 7) | (lo & 0x7f);
}

/**
 * Human-readable label for an inbound MIDI message — primarily AM4 SysEx
 * acks/responses, with a sensible fallback for non-SysEx (CC / PC / Note)
 * and non-AM4 SysEx so diagnostic tools never hide messages.
 *
 * AM4 envelope: `F0 00 01 74 15 [function] [payload...] [checksum] F7`.
 * Documented function bytes that we label (cross-reference
 * `docs/devices/am4/SYSEX-MAP.md`):
 *
 *   - 0x01 PARAM_RW — write echo (64B, hdr4=0x0028) or 18B command-ack
 *           (save / preset-rename / scene-rename — addressing-only echo
 *           with zero payload).
 *   - 0x08 GET_FIRMWARE_VERSION response.
 *   - 0x14 GET_PRESET_NUMBER response (PP=bits 0-6, QQ=bits 7-13).
 *   - 0x12 mode switch (only ever sent outbound; included for round-trip
 *           captures — labelled "Mode switch" if it ever turns up inbound).
 *   - 0x64 MULTIPURPOSE_RESPONSE — generic ACK/NACK `[FN, RC]`. RC=0x00
 *           OK, RC=0x05 "parsed but not honored" (the NACK class — see
 *           SYSEX-MAP §6 on 0x0F GET_PRESET_NAME for the canonical
 *           example).
 *
 * Anything else (recognised function but unrecognised payload shape) gets
 * labelled `function 0xNN` so unknowns are still searchable in logs.
 *
 * Pure function — no I/O, no state. Goldens-friendly.
 */
export function describeAm4InboundMessage(bytes: number[] | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? Array.from(bytes) : bytes;
  const hex = toHex(arr);
  if (arr.length === 0) return '(empty message)';
  if (arr[0] !== 0xf0) {
    const status = arr[0] ?? 0;
    if ((status & 0xf0) === 0xb0) return `CC ch=${(status & 0x0f) + 1} #${arr[1]}=${arr[2]} (${hex})`;
    if ((status & 0xf0) === 0xc0) return `PC ch=${(status & 0x0f) + 1} program=${arr[1]} (${hex})`;
    if ((status & 0xf0) === 0x90) return `NoteOn ch=${(status & 0x0f) + 1} note=${arr[1]} vel=${arr[2]} (${hex})`;
    if ((status & 0xf0) === 0x80) return `NoteOff ch=${(status & 0x0f) + 1} note=${arr[1]} (${hex})`;
    return `Other ${hex}`;
  }
  // SysEx: must end in 0xF7 to be parseable as a complete envelope.
  if (arr[arr.length - 1] !== 0xf7) {
    return `SysEx (truncated, no F7) ${hex}`;
  }
  // Check AM4 manufacturer prefix (after F0): 00 01 74 15.
  const prefixOk = AM4_SYSEX_PREFIX.every((b, i) => arr[i + 1] === b);
  if (!prefixOk) {
    return `non-AM4 SysEx ${hex}`;
  }
  if (arr.length < 8) {
    // Need at least F0 00 01 74 15 [fn] [cksum] F7 = 8 bytes.
    return `AM4 SysEx (too short, ${arr.length}B) ${hex}`;
  }
  const fn = arr[5]!;
  // Strip envelope (F0 + prefix + fn) and trailing (cksum + F7).
  // Indices [6 .. length-3] inclusive are payload.
  const payload = arr.slice(6, arr.length - 2);
  switch (fn) {
    case 0x01: {
      // PARAM_RW family. Two known shapes:
      //   - 64-byte SET_PARAM write-echo (hdr4 = 0x0028, 40-byte payload).
      //   - 18-byte command-ack (save / rename — addressing-only echo, zero
      //     payload, hdr4 = 0x0000).
      // Both share the [pidLow_septets, pidHigh_septets, action_septets, ...]
      // layout immediately after fn.
      if (payload.length < 6) return `function 0x01 PARAM_RW (short, ${arr.length}B) ${hex}`;
      const pidLow = decode14(payload[0]!, payload[1]!);
      const pidHigh = decode14(payload[2]!, payload[3]!);
      const action = decode14(payload[4]!, payload[5]!);
      const addr = `pidLow=0x${pidLow.toString(16).padStart(4, '0').toUpperCase()} pidHigh=0x${pidHigh.toString(16).padStart(4, '0').toUpperCase()} action=0x${action.toString(16).padStart(4, '0').toUpperCase()}`;
      // Save-to-location ack: action=0x001B.
      if (action === 0x001b) return `Save ACK (${addr})`;
      // Rename ack: action=0x000C.
      if (action === 0x000c) return `Rename ACK (${addr})`;
      // 18-byte command-ack shape (write-echo for save/rename family — zero
      // payload, action ≠ WRITE).
      if (arr.length === 18) return `Command ACK (${addr})`;
      // 64-byte SET_PARAM write echo (hdr4=0x0028, 40-byte payload).
      if (arr.length === 64 && action === 0x0001) return `SET_PARAM write echo (${addr})`;
      // Fall-through for shapes we haven't catalogued yet — include
      // addressing fields so future captures are identifiable in logs.
      return `function 0x01 PARAM_RW (${addr}, ${arr.length}B)`;
    }
    case 0x08: {
      // GET_FIRMWARE_VERSION response — payload starts MAJ MIN R1 R2 R3 R4 R5
      // followed by a null-terminated build-date ASCII string. Just label
      // the major.minor when we can decode them.
      if (payload.length >= 2) {
        return `Firmware version response (v${payload[0]}.${payload[1]})`;
      }
      return `function 0x08 GET_FIRMWARE_VERSION (short)`;
    }
    case 0x12:
      // Mode switch — outbound-only in normal use, but label it cleanly if
      // a capture ever sees it inbound (e.g. round-trip test, USB receipt
      // echo).
      return `Mode switch (function 0x12) ${hex}`;
    case 0x14: {
      // GET_PRESET_NUMBER response: F0 00 01 74 15 14 PP QQ [CS] F7.
      // 14-bit preset slot index, 0..103.
      if (payload.length >= 2) {
        const slot = decode14(payload[0]!, payload[1]!);
        return `Preset number response (slot=${slot})`;
      }
      return `function 0x14 GET_PRESET_NUMBER (short)`;
    }
    case 0x64: {
      // MULTIPURPOSE_RESPONSE: payload = [FN, RC]. RC=0x00 OK,
      // RC=0x05 NACK (command parsed but not honored).
      if (payload.length >= 2) {
        const echoedFn = payload[0]!;
        const rc = payload[1]!;
        const rcLabel = rc === 0x00 ? 'OK' : rc === 0x05 ? 'NACK rc=0x05 (parsed, not honored)' : `rc=0x${rc.toString(16).padStart(2, '0').toUpperCase()}`;
        return `Multipurpose response for fn=0x${echoedFn.toString(16).padStart(2, '0').toUpperCase()}: ${rcLabel}`;
      }
      return `function 0x64 MULTIPURPOSE_RESPONSE (short)`;
    }
    default:
      return `function 0x${fn.toString(16).padStart(2, '0').toUpperCase()} (${arr.length}B) ${hex}`;
  }
}
