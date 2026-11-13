/**
 * Modern Fractal family MIDI helpers (Axe-Fx III / FM3 / FM9).
 *
 * One `createFractalGen3Connector` factory produces a port connector +
 * dirty-state classifier + startup-banner helper per device, all bound
 * to the device's model byte and port-name needles. The III, FM3, and
 * FM9 share the gen-3 SysEx envelope (`F0 00 01 74 [model] ... [cs] F7`)
 * and the same edit/clean function family, so only the model byte +
 * needles + labels differ.
 *
 * Status: III is byte-verified against public captures; FM3/FM9 reuse
 * the same transport with their model byte (🟡 community beta). The
 * codec + connection layer are low-risk (envelope shape is shared); the
 * block roster + param-ID space are catalog concerns (currently the III's
 * as a beta stopgap — see `factory.ts`).
 */

// node-midi is never imported at module scope here: the transport loads it
// lazily, so a serial-only FM3 session (or an --ignore-scripts install with no
// native toolchain) can import this module and connect without the binding.
import {
  connect,
  listMidiPorts,
  mockConnect,
  type MidiConnection,
  type MockResponder,
} from '@mcp-midi-control/core/midi/transport.js';
import { connectSerial } from '@mcp-midi-control/core/midi/serialTransport.js';
import { markClean, markDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';
import {
  registerConnector,
  AXEFX3_LABEL,
  FM3_LABEL,
  FM9_LABEL,
  VP4_LABEL,
} from '@mcp-midi-control/core/server-shared/connections.js';
import { makeGen3BroadcastMockResponder } from './parityMock.js';

export {
  connect,
  toHex,
  type ConnectOptions,
  type MidiConnection,
} from '@mcp-midi-control/core/midi/transport.js';
export { AXEFX3_LABEL, FM3_LABEL, FM9_LABEL, VP4_LABEL };

// ── Dirty-state classification (gen-3, device-sourced + outbound) ──
//
// The gen-3 device announces a working-buffer edit by emitting a
// STATE-BROADCAST burst. Two forms are recognised:
//
//   • fn=0x74 head (`F0 00 01 74 [model] 74 [blockId:14b] ... F7`), the
//     real form byte-confirmed on FM9 hardware (firmware 11.00, from a
//     community hardware capture, 2026-06-03). The full burst is
//     0x74 head + 0x75 body + 0x75 tail + 0x76 end; matching the 0x74 head
//     marks dirty once per burst. This is the form a front-panel edit (or
//     any whole-block read) produces on real hardware.
//   • fn=0x01 sub-action `04 01`, the form previously assumed from the III
//     dirty-state research notes. Kept for belt-and-suspenders; harmless if
//     the device never emits it.
//
// The clean signal stays code-sourced (the device doesn't announce clean
// transitions): we mark clean when WE emit the store op (fn=0x01 sub=0x26,
// wire-confirmed) or a Program Change. Belt-and-suspenders: also markDirty on
// outbound edit-class SysEx (0x09 SET_PRESET_NAME) so the safe-edit gate can't
// miss an edit if the device's broadcast races a tool's response window.
//
// fn=0x01 PARAMETER_SETGET is intentionally NOT treated as an edit by function
// byte alone: SET and GET share the envelope with no wire-level discriminator,
// so SET handlers mark dirty explicitly at the call site (see writer.ts). The
// store (sub=0x26) and block-insert (sub=0x32) ops also ride fn=0x01: store is
// special-cased as the clean signal below; block-insert (set_block) marks dirty
// explicitly at its call site, like set_param.
//
// A 0x74 burst is ALSO the device's answer to an fn=0x1F bulk-read poll, and
// this server sends those on every get_param / get_params / get_preset. Left
// unfiltered, each of our own READS marked the buffer dirty, so the safe-edit
// gate refused to navigate straight after a clean preset load (hardware-found
// on an Axe-Fx III, fw 32.06: "unsaved edits" on re-selecting the preset just
// loaded). The wrapper below therefore remembers which block it polled and
// does not count the burst that answers it.
//
// CAVEAT (running alongside the vendor editor): if FM9-Edit / Axe-Edit is open
// beside us and polling, ITS poll-triggered broadcasts still reach our shared
// input and mark us dirty with no real edit. That errs toward "dirty" (the
// safe direction: the gate prompts save/discard rather than silently losing
// an edit), so it is an accepted trade-off, not a correctness bug.

const STORE_PRESET_FN = 0x01; // store rides PARAMETER_SETGET (fn=0x01)...
const STORE_PRESET_SUB = 0x26; // ...distinguished by this sub-action byte (wire-confirmed)
const SWITCH_PRESET_SUB = 0x27; // SysEx preset switch (FM3-confirmed): loads from flash = buffer discarded
const EDIT_FUNCTIONS = new Set<number>([0x09]); // SET_PRESET_NAME (set_block now rides fn=0x01 sub=0x32, marked dirty at the call site)
const STATE_BROADCAST_HEAD = 0x74; // gen-3 device→host edit broadcast (hardware-confirmed on FM9)
const BLOCK_BULK_READ_FN = 0x1f; // host→device whole-block poll; answered by a 0x74 burst
/** How long a poll's answering burst is expected (a real burst lands in ~1 ms). */
const POLL_REPLY_WINDOW_MS = 1500;

function isGen3Envelope(bytes: readonly number[], modelId: number): boolean {
  return bytes.length >= 6
    && bytes[0] === 0xf0
    && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x74
    && bytes[4] === modelId;
}

// The fn=0x01 sub-action clean test only applies to GRID devices (III/FM3/FM9):
// the VP4's (0x14) fn=0x01 write frame has NO sub-action byte — byte 6 there is
// the effectId LOW SEPTET (vp4/setParam.ts), so e.g. a set_bypass targeting
// looper 1/2 (effectIds 166/167, low septets 0x26/0x27) would alias the
// store/switch sub-actions and falsely mark the buffer CLEAN (the unsafe
// direction for the safe-edit gate). VP4 therefore never gets the sub-action
// clean signal — its real store frame (buildVp4Save, tc=0x1b, byte 6 = 0x00)
// is never matched by this branch anyway; the Program Change path below still
// marks clean. (A VP4-true clean signal would check tc=0x1b at payload pos 4.)
const SUB_ACTION_CLEAN_MODELS = new Set<number>([0x10, 0x11, 0x12]);

function isCleanOutbound(bytes: readonly number[], modelId: number): boolean {
  // Store (sub=0x26) persists the buffer; the SysEx preset switch (sub=0x27,
  // FM3's switch_preset path) reloads from flash. Both leave the buffer clean.
  if (SUB_ACTION_CLEAN_MODELS.has(modelId)
    && isGen3Envelope(bytes, modelId)
    && bytes[5] === STORE_PRESET_FN
    && (bytes[6] === STORE_PRESET_SUB || bytes[6] === SWITCH_PRESET_SUB)) return true;
  // switch_preset on III/FM9 uses MIDI Program Change + Bank Select (not SysEx).
  for (let i = 0; i < bytes.length; i++) {
    if ((bytes[i] & 0xf0) === 0xc0) return true;
  }
  return false;
}

function isEditOutbound(bytes: readonly number[], modelId: number): boolean {
  return isGen3Envelope(bytes, modelId) && EDIT_FUNCTIONS.has(bytes[5]);
}

function isStateBroadcastInbound(bytes: readonly number[], modelId: number): boolean {
  if (!isGen3Envelope(bytes, modelId)) return false;
  // Real hardware form (FM9-confirmed): fn=0x74 broadcast head.
  if (bytes[5] === STATE_BROADCAST_HEAD) return true;
  // Legacy assumed form: fn=0x01 sub-action 04 01.
  if (bytes[5] === 0x01 && bytes.length >= 10 && bytes[6] === 0x04 && bytes[7] === 0x01) return true;
  return false;
}

/** Exported for the offline gate (verify-fractal-gen3-family); not a public API. */
export function wrapWithDirtyClassification(
  conn: MidiConnection,
  modelId: number,
  label: string,
): MidiConnection {
  // blockId -> deadline for the burst answering OUR OWN fn=0x1F poll of it.
  const polled = new Map<number, number>();
  conn.onMessage((bytes) => {
    if (!isStateBroadcastInbound(bytes, modelId)) return;
    if (bytes[5] === STATE_BROADCAST_HEAD && bytes.length >= 8) {
      const blockId = (bytes[6] & 0x7f) | ((bytes[7] & 0x7f) << 7);
      const deadline = polled.get(blockId);
      if (deadline !== undefined) {
        polled.delete(blockId); // one burst per poll
        if (Date.now() <= deadline) return; // our read, not an edit
      }
    }
    markDirty(label);
  });
  const originalSend = conn.send;
  return {
    ...conn,
    send: (bytes: number[]) => {
      if (isCleanOutbound(bytes, modelId)) markClean(label);
      else if (isEditOutbound(bytes, modelId)) markDirty(label);
      else if (isGen3Envelope(bytes, modelId) && bytes[5] === BLOCK_BULK_READ_FN && bytes.length >= 8) {
        polled.set((bytes[6] & 0x7f) | ((bytes[7] & 0x7f) << 7), Date.now() + POLL_REPLY_WINDOW_MS);
      }
      originalSend(bytes);
    },
  };
}

// ── Connector factory ──────────────────────────────────────────────

interface Gen3PortInfo {
  index: number;
  name: string;
  matched: boolean;
}

export interface FractalGen3Connector {
  /** Open (or mock) a connection wrapped with dirty classification. */
  connect: () => MidiConnection;
  /** Port-name substrings used to find this device's MIDI port. */
  portNeedles: readonly string[];
  /** Enumerate output ports without opening any (startup banner). */
  listOutputs: () => Gen3PortInfo[];
  /** One-line startup-banner verdict ("<device> detected" / "not visible"). */
  describePortStatus: () => string;
}

export interface Gen3ConnectorSpec {
  modelId: number;
  label: string;
  displayName: string;
  /** Lower-case port-name substrings (transport lowercases both sides). */
  portNeedles: readonly string[];
  notFoundLeadIn: string;
  notFoundHints: readonly string[];
  /** Mock-transport response synthesizer (agent-regression without hardware). */
  mockResponder?: MockResponder;
  /**
   * Fall back to a USB-CDC serial connection when no MIDI port matches.
   * FM3-only: the FM3 exposes no USB-MIDI interface on any OS — its control
   * channel is a serial device ("FM3 Communications Port" / /dev/cu.usbmodem*
   * / /dev/ttyACM*) carrying raw MIDI bytes. The MIDI-needle path stays
   * primary so DIN-via-interface and loopMIDI test setups keep working.
   * Community-beta: decoded from a collaborator's FM3 hardware sessions,
   * not yet hardware-verified through THIS implementation.
   */
  serialFallback?: {
    baudRate: number;
    /** Env var holding an explicit serial path override (e.g. COM5). */
    envPathVar?: string;
  };
}

export function createFractalGen3Connector(spec: Gen3ConnectorSpec): FractalGen3Connector {
  const mockResponder: MockResponder = spec.mockResponder ?? ((_outgoing) => []);

  function doConnect(): MidiConnection {
    if (process.env.MCP_MOCK_TRANSPORT === '1') {
      return wrapWithDirtyClassification(
        mockConnect({ responder: mockResponder }),
        spec.modelId,
        spec.label,
      );
    }
    let conn: MidiConnection;
    try {
      conn = connect({
        needles: spec.portNeedles,
        notFoundLeadIn: spec.notFoundLeadIn,
        notFoundHints: [...spec.notFoundHints],
      });
    } catch (midiErr) {
      if (!spec.serialFallback) throw midiErr;
      const explicitPath = spec.serialFallback.envPathVar
        ? process.env[spec.serialFallback.envPathVar]
        : undefined;
      // Carry the MIDI-side diagnostic into the serial failure path so a
      // fallback can never SWALLOW the original error (e.g. a loopMIDI/DIN
      // port that matched the needles but was exclusively held).
      const midiDetail = midiErr instanceof Error
        ? midiErr.message.split('\n')[0]
        : String(midiErr);
      conn = connectSerial({
        explicitPath,
        baudRate: spec.serialFallback.baudRate,
        notFoundLeadIn:
          `${spec.displayName} not found as a MIDI port OR a USB-CDC serial device. ` +
          `(Over USB the ${spec.displayName} is a SERIAL device, not a MIDI device.) Common causes:`,
        notFoundHints: [
          `  - ${spec.displayName} is powered off or not connected by USB`,
          '  - On Windows: Fractal\'s "FM3 USB Serial Driver" is not installed (separate from the audio driver)',
          `  - ${spec.displayName}-Edit or Fractal-Bot is holding the serial port (it is exclusive) — fully quit it`,
          spec.serialFallback.envPathVar
            ? `  - Port enumerates without Fractal metadata: set ${spec.serialFallback.envPathVar}=<path> (e.g. COM5 or /dev/cu.usbmodemXXXX)`
            : '',
          `  (MIDI-port path was tried first and also failed: ${midiDetail})`,
        ].filter((l) => l !== ''),
      });
    }
    return wrapWithDirtyClassification(conn, spec.modelId, spec.label);
  }

  function listOutputs(): Gen3PortInfo[] {
    return listMidiPorts(spec.portNeedles).outputs.map(({ index, name, matched }) => ({
      index,
      name,
      matched,
    }));
  }

  function describePortStatus(): string {
    try {
      const outputs = listOutputs();
      const hit = outputs.find((p) => p.matched);
      if (hit) return `${spec.displayName} detected at output [${hit.index}]: "${hit.name}" (🟡 community beta)`;
      if (outputs.length === 0) return 'no MIDI outputs visible';
      return `${spec.displayName} not visible among ${outputs.length} output(s)`;
    } catch (err) {
      return `port scan failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return { connect: doConnect, portNeedles: spec.portNeedles, listOutputs, describePortStatus };
}

// ── Axe-Fx III ─────────────────────────────────────────────────────
//
// We deliberately do NOT match the bare "Fractal" needle — AM4 owns that
// as a catch-all, so registration order in server-all puts the modern
// Fractal devices BEFORE AM4 (DECISIONS.md row 40).

/**
 * No-inbound mock responder: returns [] for every outgoing message, so read
 * predicates time out and write tools see only the outbound dirty
 * classification fire. Kept for VP4 (writes gated; no meaningful read surface)
 * and as the explicit "device answers nothing" baseline.
 *
 * The grid devices (III / FM3 / FM9) instead use `makeGen3BroadcastMockResponder`
 * below so agent-regression read flows (get_param / get_preset) complete without
 * hardware: an fn=0x1F poll for a placed block returns the real 0x74/0x75/0x76
 * burst, an unplaced block NACKs fast, and the edit-buffer dump answers fn=0x43.
 * Without this, a get_preset poll-loop times out on every catalogued block
 * (~40 × the read timeout), so read-bearing cases run minutes over budget.
 */
const noInboundResponder: MockResponder = (_outgoing) => [];

export const AXE_FX_III_PORT_NEEDLES = ['axe-fx iii', 'axefx3', 'axe-fx 3'] as const;

const axeFxIIIConnector = createFractalGen3Connector({
  modelId: 0x10,
  label: AXEFX3_LABEL,
  displayName: 'Axe-Fx III',
  portNeedles: AXE_FX_III_PORT_NEEDLES,
  notFoundLeadIn: 'Axe-Fx III not found in the MIDI device list. Common causes:',
  notFoundHints: [
    '  - Axe-Fx III is powered off or not connected by USB',
    '  - USB cable is data-only or not seated fully',
    '  - On Windows: AxeEdit III claimed the MIDI port exclusively — quit AxeEdit III then retry',
    '',
    'Once visible, call `list_midi_ports` to confirm the server sees it, then retry. Use `reconnect_midi` to force a fresh handle.',
  ],
  mockResponder: makeGen3BroadcastMockResponder({ modelByte: 0x10 }),
});

export const connectAxeFxIII = axeFxIIIConnector.connect;
export const listAxeFxIIIOutputs = axeFxIIIConnector.listOutputs;
export const describeAxeFxIIIPortStatus = axeFxIIIConnector.describePortStatus;

/**
 * Open a mock III connection whose inbound responder synthesizes the gen-3
 * 0x74/0x75/0x76 state-broadcast burst in answer to an fn=0x1F bulk-read poll
 * (see `./parityMock.ts`). Test-harness only: it lets the response-shape
 * parity gate drive the gen-3 reader's getPreset / getParam end to end with no
 * hardware. Requires `MCP_MOCK_TRANSPORT=1` (the shared mock-transport gate);
 * throws otherwise so it can never accidentally open a real port. The shipped
 * `connectAxeFxIII` keeps `noInboundResponder` as its default — this is a
 * separate connector, not a change to production behaviour.
 */
export function connectAxeFxIIIParityMock(): MidiConnection {
  return connectAxeFxIIIParityMockWith();
}

/**
 * Parametrized variant of `connectAxeFxIIIParityMock` that lets a test shape the
 * 0x75 body via a per-index `valueAt`. Used to exercise the reader's
 * channel-blocked projection (a param that differs across channels).
 */
export function connectAxeFxIIIParityMockWith(
  valueAt?: (effectId: number, index: number) => number,
): MidiConnection {
  if (process.env.MCP_MOCK_TRANSPORT !== '1') {
    throw new Error(
      'connectAxeFxIIIParityMock is a test-harness connector and requires MCP_MOCK_TRANSPORT=1.',
    );
  }
  return createFractalGen3Connector({
    modelId: 0x10,
    label: AXEFX3_LABEL,
    displayName: 'Axe-Fx III',
    portNeedles: AXE_FX_III_PORT_NEEDLES,
    notFoundLeadIn: '',
    notFoundHints: [],
    mockResponder: makeGen3BroadcastMockResponder({ modelByte: 0x10, valueAt }),
  }).connect();
}

// ── FM3 ────────────────────────────────────────────────────────────

export const FM3_PORT_NEEDLES = ['fm3', 'fm-3', 'fm 3'] as const;

const fm3Connector = createFractalGen3Connector({
  modelId: 0x11,
  label: FM3_LABEL,
  displayName: 'FM3',
  portNeedles: FM3_PORT_NEEDLES,
  notFoundLeadIn: 'FM3 not found in the MIDI device list. Common causes:',
  notFoundHints: [
    '  - FM3 is powered off or not connected by USB',
    '  - USB cable is data-only or not seated fully',
    '  - On Windows: FM3-Edit claimed the MIDI port exclusively — quit FM3-Edit then retry',
    '',
    'Once visible, call `list_midi_ports` to confirm the server sees it, then retry. Use `reconnect_midi` to force a fresh handle.',
  ],
  mockResponder: makeGen3BroadcastMockResponder({ modelByte: 0x11 }),
  serialFallback: { baudRate: 115200, envPathVar: 'MCP_FM3_SERIAL_PATH' },
});

export const connectFM3 = fm3Connector.connect;
export const listFM3Outputs = fm3Connector.listOutputs;
export const describeFM3PortStatus = fm3Connector.describePortStatus;

// ── FM9 ────────────────────────────────────────────────────────────

export const FM9_PORT_NEEDLES = ['fm9', 'fm-9', 'fm 9'] as const;

const fm9Connector = createFractalGen3Connector({
  modelId: 0x12,
  label: FM9_LABEL,
  displayName: 'FM9',
  portNeedles: FM9_PORT_NEEDLES,
  notFoundLeadIn: 'FM9 not found in the MIDI device list. Common causes:',
  notFoundHints: [
    '  - FM9 is powered off or not connected by USB',
    '  - USB cable is data-only or not seated fully',
    '  - On Windows: FM9-Edit claimed the MIDI port exclusively — quit FM9-Edit then retry',
    '',
    'Once visible, call `list_midi_ports` to confirm the server sees it, then retry. Use `reconnect_midi` to force a fresh handle.',
  ],
  mockResponder: makeGen3BroadcastMockResponder({ modelByte: 0x12 }),
});

export const connectFM9 = fm9Connector.connect;
export const listFM9Outputs = fm9Connector.listOutputs;
export const describeFM9PortStatus = fm9Connector.describePortStatus;

// ── VP4 ────────────────────────────────────────────────────────────
//
// The VP4 (model byte 0x14) is a gen-3 effects pedal: it reuses the gen-3
// SysEx envelope + effects codec but is AM4-SHAPE (serial 4-slot chain, no
// amp/cab). Only the fn=0x12 mode switch is wire-confirmed; the param/block
// write path is inferred and the descriptor gates writes. The connector is
// the same gen-3 transport with the VP4 model byte + port needles.

export const VP4_PORT_NEEDLES = ['vp4', 'vp-4', 'vp 4'] as const;

const vp4Connector = createFractalGen3Connector({
  modelId: 0x14,
  label: VP4_LABEL,
  displayName: 'VP4',
  portNeedles: VP4_PORT_NEEDLES,
  notFoundLeadIn: 'VP4 not found in the MIDI device list. Common causes:',
  notFoundHints: [
    '  - VP4 is powered off or not connected by USB',
    '  - USB cable is data-only or not seated fully',
    '  - On Windows: VP4-Edit claimed the MIDI port exclusively — quit VP4-Edit then retry',
    '',
    'Once visible, call `list_midi_ports` to confirm the server sees it, then retry. Use `reconnect_midi` to force a fresh handle.',
  ],
  mockResponder: noInboundResponder,
});

export const connectVP4 = vp4Connector.connect;
export const listVP4Outputs = vp4Connector.listOutputs;
export const describeVP4PortStatus = vp4Connector.describePortStatus;

// Register all connectors with the shared connection registry as a
// module-load side effect. Importing anything from this module (or any
// module that transitively imports it) makes `ensureConnection(<label>)`
// route through the matching connector.
registerConnector(AXEFX3_LABEL, connectAxeFxIII);
registerConnector(FM3_LABEL, connectFM3);
registerConnector(FM9_LABEL, connectFM9);
registerConnector(VP4_LABEL, connectVP4);
