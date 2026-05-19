/**
 * Axe-Fx III-specific MIDI helpers. Wraps the generic transport in
 * @mcp-midi-control/core/midi/transport with III-specific port-name
 * needles + onboarding hints.
 *
 * Status: 🟡 wiki-documented, awaiting community capture verification
 * (BK-015 community beta workflow). The wire envelope shape is shared
 * with AM4 + Axe-Fx II XL+ (same modern Fractal SysEx family,
 * `F0 00 01 74 [model] ... [checksum] F7`), so transport + connection
 * are low-risk. Block roster + param-ID space ARE device-specific and
 * are decoded from the cached Fractal wiki — 🟡 confidence tag per
 * blockTypes.ts / params.ts.
 */

import {
  connect,
  mockConnect,
  type MidiConnection,
  type MockResponder,
} from '@mcp-midi-control/core/midi/transport.js';
import { markClean, markDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';

export {
  connect,
  toHex,
  type ConnectOptions,
  type MidiConnection,
} from '@mcp-midi-control/core/midi/transport.js';

// ── Dirty-state classification — DEVICE-SOURCED + outbound belt-and-suspenders
//
// Per `docs/devices/axe-fx-iii/dirty-state-research.md`, the III emits a STATE_BROADCAST
// frame on USB whenever the working buffer is edited: `fn=0x01` with
// sub-action `04 01` at payload pos 0..1. Five byte-decoded captures
// (Mountain Utilities forum + FC-12) confirm the wire shape; the parser
// already exists at `setParam.ts:parseSetGetParameterResponse`. Receiving
// this frame is the authoritative dirty signal.
//
// The clean signal stays code-sourced — the III doesn't announce clean
// transitions. We mark clean when WE emit:
//   - 0x1D STORE_PRESET (preset save)
//   - 0xCN Program Change (switch_preset uses MIDI PC + CC0 + CC32)
//
// Belt-and-suspenders: also markDirty on outbound edit-class SysEx so
// the safe-edit gate can't silently miss an edit if the device's own
// broadcast races a tool's response window. Pattern mirrors Axe-Fx II's
// midi.ts (see lines 60-100 there for the same rationale).

const AXEFX3_MODEL_ID = 0x10;
const AXEFX3_DIRTY_LABEL = 'axe-fx-iii';

const CLEAN_FUNCTIONS_III = new Set<number>([
  0x1d, // STORE_PRESET (II-derived 10-byte envelope)
]);

// EDIT_FUNCTIONS_III intentionally OMITS fn=0x01 PARAMETER_SETGET.
//
// II discriminates SET (edit) from GET (read) on its dual-purpose
// fn=0x02 via the action byte at bytes[13] (0x01 SET, 0x00 GET). III's
// fn=0x01 has no equivalent wire-level discriminator — `buildSetParameter`
// and `buildGetParameter` use the same sub-action `09 00` and only
// differ by the value field being zero on GET, which makes them
// indistinguishable from a legitimate `SET value=0`. SET/GET
// discrimination therefore lives at the CALL SITE (the handler that
// knew it was issuing a SET vs a GET): SET handlers call
// `markDirty('axe-fx-iii')` after `c.send(buildSetParameter(...))`;
// GET handlers do not.
//
// fn=0x05 SET_GRID_CELL and fn=0x09 SET_PRESET_NAME are unambiguous
// edits — they stay in EDIT_FUNCTIONS_III for connection-layer
// classification.
const EDIT_FUNCTIONS_III = new Set<number>([
  0x05, // SET_GRID_CELL (block placement; II port, III-untested)
  0x09, // SET_PRESET_NAME (rename; II port, III-untested)
]);

function isFractalIIIEnvelope(bytes: readonly number[]): boolean {
  return bytes.length >= 6
    && bytes[0] === 0xf0
    && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x74
    && bytes[4] === AXEFX3_MODEL_ID;
}

function isCleanOutboundIII(bytes: readonly number[]): boolean {
  if (isFractalIIIEnvelope(bytes) && CLEAN_FUNCTIONS_III.has(bytes[5])) return true;
  // switch_preset uses MIDI Program Change + Bank Select (not SysEx).
  // buildSwitchPresetPC produces a 9-byte sequence with the PC byte at
  // offset 6; match either short PC (offset 0) or bulk PC at any offset.
  for (let i = 0; i < bytes.length; i++) {
    if ((bytes[i] & 0xf0) === 0xc0) return true;
  }
  return false;
}

function isEditOutboundIII(bytes: readonly number[]): boolean {
  return isFractalIIIEnvelope(bytes) && EDIT_FUNCTIONS_III.has(bytes[5]);
}

function isStateBroadcastInboundIII(bytes: readonly number[]): boolean {
  if (!isFractalIIIEnvelope(bytes)) return false;
  if (bytes[5] !== 0x01) return false;
  if (bytes.length < 10) return false;
  return bytes[6] === 0x04 && bytes[7] === 0x01;
}

/**
 * Wrap a III connection with dirty-state classification. Adds:
 *   - inbound `onMessage` handler that fires `markDirty` on STATE_BROADCAST
 *   - `send` wrapper that fires `markClean` on switch_preset / save,
 *     `markDirty` on edit-class outbound (belt-and-suspenders).
 *
 * Returns a new connection object that delegates everything else to the
 * underlying conn unchanged.
 */
function wrapWithDirtyClassification(conn: MidiConnection): MidiConnection {
  conn.onMessage((bytes) => {
    if (isStateBroadcastInboundIII(bytes)) {
      markDirty(AXEFX3_DIRTY_LABEL);
    }
  });
  const originalSend = conn.send;
  return {
    ...conn,
    send: (bytes: number[]) => {
      if (isCleanOutboundIII(bytes)) markClean(AXEFX3_DIRTY_LABEL);
      else if (isEditOutboundIII(bytes)) markDirty(AXEFX3_DIRTY_LABEL);
      originalSend(bytes);
    },
  };
}

/**
 * Substrings used to find Axe-Fx III ports. The OS-side names vary by
 * USB driver / firmware version — these are the substrings we've seen
 * across Fractal's documentation:
 *
 *   - "Axe-Fx III"      — direct, most common after FW 9.x
 *   - "AXE-FX III"      — all-caps variant on some Windows drivers
 *   - "axefx3"          — some third-party / legacy class-compliant
 *                          names
 *
 * The match is case-insensitive (transport.ts lowercases both sides),
 * so any of these will match either case at the OS level. We
 * deliberately do NOT match the bare "Fractal" needle here — AM4 owns
 * that as a catch-all, so registration order in server-all/server/
 * index.ts puts Axe-Fx III BEFORE AM4 (per the registration-order
 * tiebreaking decision in DECISIONS.md row 40).
 */
export const AXE_FX_III_PORT_NEEDLES = ['axe-fx iii', 'axefx3', 'axe-fx 3'] as const;

/**
 * Open a connection to the Axe-Fx III. Thin wrapper around connect()
 * that supplies the III-specific name needles and the install/driver
 * hints users hit during III onboarding.
 *
 * Axe-Fx III uses a class-compliant USB-MIDI interface on Windows 10+
 * and macOS — no separate driver download required. The "MIDI" port
 * names appear as soon as the unit is plugged in and powered on.
 */
export function connectAxeFxIII(): MidiConnection {
  if (process.env.MCP_MOCK_TRANSPORT === '1') {
    return wrapWithDirtyClassification(mockConnect({ responder: axeFx3MockResponder }));
  }
  const conn = connect({
    needles: AXE_FX_III_PORT_NEEDLES,
    notFoundLeadIn: 'Axe-Fx III not found in the MIDI device list. Common causes:',
    notFoundHints: [
      '  - Axe-Fx III is powered off or not connected by USB',
      '  - USB cable is data-only or not seated fully',
      '  - On Windows: AxeEdit III claimed the MIDI port exclusively — quit AxeEdit III then retry',
      '',
      'Once visible, call `list_midi_ports` to confirm the server sees it, then retry. Use `reconnect_midi` to force a fresh handle.',
    ],
  });
  return wrapWithDirtyClassification(conn);
}

/**
 * Axe-Fx III mock response synthesizer. Minimal scaffolding — the III
 * tool surface ships behind a 🟡 community-beta banner with best-effort
 * envelopes (fn=0x01 PARAMETER_SETGET byte-verified, others II-ported),
 * so the mock's job is to make agent-regression flows runnable without
 * hardware. Returns [] (no inbound) for every outgoing message —
 * read predicates time out, write tools see the outbound dirty
 * classification fire from `wrapWithDirtyClassification`. Extend with
 * III-specific response shapes when III hardware-confirmation reports
 * land via the community beta-testing workflow.
 */
const axeFx3MockResponder: MockResponder = (_outgoing) => [];

// Register the Axe-Fx III connector with the shared connection registry
// as a module-load side effect. Importing anything from this module
// (or any module that transitively imports it) makes
// `ensureConnection(AXEFX3_LABEL)` route through `connectAxeFxIII()`.
import { registerConnector, AXEFX3_LABEL } from '@mcp-midi-control/core/server-shared/connections.js';
registerConnector(AXEFX3_LABEL, connectAxeFxIII);
export { AXEFX3_LABEL };

// ── Startup banner helper ────────────────────────────────────────────

import midi from 'midi';

interface AxeFxIIIPortInfo {
  index: number;
  name: string;
  looksLikeAxeFxIII: boolean;
}

/**
 * Enumerate output ports without opening any. Used by the startup
 * banner so the server can log a verdict ("Axe-Fx III detected" /
 * "Axe-Fx III not visible") at boot — mirrors the AM4 + Axe-Fx II
 * + Hydrasynth startup-banner pattern for consistency.
 */
export function listAxeFxIIIOutputs(): AxeFxIIIPortInfo[] {
  const out = new midi.Output();
  try {
    const result: AxeFxIIIPortInfo[] = [];
    for (let i = 0; i < out.getPortCount(); i++) {
      const name = out.getPortName(i);
      const lower = name.toLowerCase();
      result.push({
        index: i,
        name,
        looksLikeAxeFxIII: AXE_FX_III_PORT_NEEDLES.some((n) => lower.includes(n)),
      });
    }
    return result;
  } finally {
    out.closePort();
  }
}

/**
 * Startup-banner helper — describes whether an Axe-Fx III output port
 * is visible right now, without opening it. Returns a single-line
 * string for the server's startup stderr log.
 */
export function describeAxeFxIIIPortStatus(): string {
  try {
    const outputs = listAxeFxIIIOutputs();
    const iii = outputs.find((p) => p.looksLikeAxeFxIII);
    if (iii) return `Axe-Fx III detected at output [${iii.index}]: "${iii.name}" (🟡 community beta — see HARDWARE-TASKS-AXEFX3.md)`;
    if (outputs.length === 0) return 'no MIDI outputs visible';
    return `Axe-Fx III not visible among ${outputs.length} output(s)`;
  } catch (err) {
    return `port scan failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
