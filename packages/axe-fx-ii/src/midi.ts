/**
 * Axe-Fx II MIDI connection helper.
 *
 * Mirrors the pattern in `src/asm/hydrasynth-explorer/midi.ts` —
 * device-scoped port discovery + lazy-opened bidirectional handle.
 * Looks for "axe-fx" / "axefx" in port names (case-insensitive).
 *
 * Why a separate helper from the AM4 one: both devices are made by
 * Fractal Audio, so the AM4 helper's `fractal` needle would also match
 * Axe-Fx II ports — leaving the user's two-Fractal-device-plugged-in
 * setup ambiguous. Splitting the needles keeps the device routing
 * unambiguous when both are present.
 *
 * Status: 🟢 hardware-verified on Axe-Fx II XL+ Quantum 8.02
 * (2026-05-10). Bidirectional MIDI handle proven by HW-080 (preset
 * name read, function 0x0F) + HW-076 (grid layout read, function
 * 0x20) + HW-077 (param read, function 0x02 GET) + HW-075 (param
 * write + bypass, function 0x02 SET). Port discovery via the
 * `axe-fx` / `axefx` needles routes correctly on the founder's
 * two-Fractal-device setup.
 */
import midi, { Input, Output } from 'midi';

import { markClean, markDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';

const AXE_FX_II_PORT_NEEDLES = ['axe-fx', 'axefx'];
const AXEFX_DIRTY_LABEL = 'axe-fx-ii';

// Fractal Axe-Fx II model byte (Q8.02 XL+). All envelopes targeted at /
// emitted by the device carry this in byte[4]; foreign envelopes don't
// affect our buffer-dirty state.
const AXE_FX_II_XL_PLUS_MODEL_ID = 0x07;

// ── Dirty-state classification — DEVICE-SOURCED (not heuristic) ───────
//
// Decoded from passive captures across 6 distinct device states
// (Session 68 analysis of session-58 + session-61 captures):
//
//   - direct-sync (read-only)   → 0 state broadcasts
//   - preset-change (switch)    → 0 state broadcasts
//   - save-attempt (store)      → 0 state broadcasts
//   - knob-turn (edit)          → 1 state broadcast triple
//   - block-add (edit)          → 1 state broadcast triple
//   - grid-move (edit)          → 1 state broadcast triple
//
// The device emits a 0x74/0x75/0x76 state-broadcast triple EXACTLY when
// the working buffer is edited — whether by AxeEdit, by our MCP server,
// or by the user touching a knob on the device front panel. It does
// NOT emit on reads, preset switches, or saves. Receiving a 0x74 frame
// is therefore an AUTHORITATIVE dirty signal from the device itself,
// not a heuristic on our part.
//
// The clean signal stays code-sourced because the device doesn't
// announce "I'm clean now" — but the OPERATIONS that produce a clean
// state are unambiguous: switch_preset (0x3C) loads a stored slot;
// store_preset (0x1D) commits the working buffer to a slot. We mark
// clean when WE issue those envelopes. A SAVE pressed on the device's
// own front panel won't be reflected (false-dirty on next check), but
// that's a fail-safe degradation — the agent will warn the user, who
// can confirm and discard.

const CLEAN_FUNCTIONS = new Set<number>([
  0x3c, // SWITCH_PRESET / LOAD_PRESET
  0x1d, // STORE_PRESET
]);

// Belt-and-suspenders: while the inbound 0x74 state-broadcast is the
// authoritative dirty signal documented above, hardware testing (2026-
// 05-14) showed it doesn't reliably reach the listener after SysEx-
// driven function 0x02 SET writes from our unified set_param tool. Until
// that's fully characterized, we also fire markDirty on outbound edit-
// class functions so the safe-edit gate cannot silently miss an edit
// the agent issued. This is fail-safe (extra confirmation needed if
// the device's own broadcast missed) rather than fail-dangerous
// (silently discarding the user's tweak on the next switch_preset).
//
// 0x02 is dual-purpose (GET=0x00 / SET=0x01 in the action byte at
// offset 11); only SET is an edit.
const EDIT_FUNCTIONS = new Set<number>([
  0x05, // SET_GRID_CELL (block placement)
  0x06, // SET_CELL_ROUTING (cable add/remove)
  0x09, // SET_PRESET_NAME (rename)
  0x11, // SET_BLOCK_CHANNEL (X/Y change)
]);

function isCleanOutbound(bytes: readonly number[]): boolean {
  if (bytes.length < 8) return false;
  if (bytes[0] !== 0xf0) return false;
  if (bytes[1] !== 0x00 || bytes[2] !== 0x01 || bytes[3] !== 0x74) return false;
  if (bytes[4] !== AXE_FX_II_XL_PLUS_MODEL_ID) return false;
  return CLEAN_FUNCTIONS.has(bytes[5]);
}

function isEditOutbound(bytes: readonly number[]): boolean {
  if (bytes.length < 8) return false;
  if (bytes[0] !== 0xf0) return false;
  if (bytes[1] !== 0x00 || bytes[2] !== 0x01 || bytes[3] !== 0x74) return false;
  if (bytes[4] !== AXE_FX_II_XL_PLUS_MODEL_ID) return false;
  if (EDIT_FUNCTIONS.has(bytes[5])) return true;
  // 0x02 SET_PARAM dual-purpose: action byte at offset 13 distinguishes
  // SET (0x01) from GET (0x00). The byte after the func is effectId(2)
  // + paramId(2) + value(3) = 7 bytes; then the action byte. Only mark
  // dirty on SET.
  if (bytes[5] === 0x02 && bytes.length >= 15 && bytes[13] === 0x01) return true;
  return false;
}

function isStateBroadcastInbound(bytes: readonly number[]): boolean {
  if (bytes.length < 6) return false;
  if (bytes[0] !== 0xf0) return false;
  if (bytes[1] !== 0x00 || bytes[2] !== 0x01 || bytes[3] !== 0x74) return false;
  if (bytes[4] !== AXE_FX_II_XL_PLUS_MODEL_ID) return false;
  // The header byte 0x74 is sufficient — chunks (0x75) and footers
  // (0x76) always follow a header, so we don't need to count all three.
  return bytes[5] === 0x74;
}

export interface AxeFxIIConnection {
  send: (bytes: number[]) => void;
  /**
   * Subscribe to inbound MIDI from the Axe-Fx II. Returns an
   * unsubscribe function. When `hasInput` is false (no input port
   * found), the handler is registered but will never fire.
   *
   * Active-sensing (0xFE) and MIDI timing clock (0xF8) are filtered
   * by `ignoreTypes(false, true, true)` so the handler only sees
   * meaningful messages (SysEx, CC, PC, notes).
   */
  onMessage: (handler: (bytes: number[]) => void) => () => void;
  /**
   * Wait for the first inbound SysEx that satisfies `predicate`. Non-
   * matching messages are silently dropped until `timeoutMs` elapses.
   * Throws on timeout. Caller MUST register before sending the request
   * so the device's response can't race ahead of the listener.
   *
   * Throws synchronously if `hasInput` is false — GET tools that need
   * a response are unusable without an input port.
   */
  receiveSysExMatching: (
    predicate: (bytes: number[]) => boolean,
    timeoutMs?: number,
  ) => Promise<number[]>;
  /** True when an input port was successfully opened. */
  hasInput: boolean;
  close: () => void;
  /**
   * NOT IMPLEMENTED on Axe-Fx II. The Axe-Fx II connection exposes
   * `receiveSysExMatching` (predicate-filtered) but not the generic
   * `receiveSysEx` that accepts any SysEx frame. Calling this throws so
   * the gap is visible at the call site rather than failing silently.
   * If a future dispatcher path needs plain `receiveSysEx` on Axe-Fx II,
   * implement it here using the same `handlers` Set pattern as
   * `receiveSysExMatching`.
   */
  receiveSysEx: (timeoutMs?: number) => Promise<number[]>;
  /** Not tracked on Axe-Fx II (send errors surface via thrown exceptions). */
  lastSendError?: Error;
}

export interface AxeFxIIPortInfo {
  index: number;
  name: string;
  looksLikeAxeFxII: boolean;
}

function findAxeFxIIOutputIndex(out: Output): number {
  for (let i = 0; i < out.getPortCount(); i++) {
    const name = out.getPortName(i).toLowerCase();
    if (AXE_FX_II_PORT_NEEDLES.some((n) => name.includes(n))) return i;
  }
  return -1;
}

function findAxeFxIIInputIndex(input: Input): number {
  for (let i = 0; i < input.getPortCount(); i++) {
    const name = input.getPortName(i).toLowerCase();
    if (AXE_FX_II_PORT_NEEDLES.some((n) => name.includes(n))) return i;
  }
  return -1;
}

/**
 * Enumerate output ports without opening any. Used by the startup
 * banner so the server can log a verdict ("Axe-Fx II detected" /
 * "Axe-Fx II not visible") at boot, before any tool call.
 */
export function listAxeFxIIOutputs(): AxeFxIIPortInfo[] {
  const out = new midi.Output();
  try {
    const result: AxeFxIIPortInfo[] = [];
    for (let i = 0; i < out.getPortCount(); i++) {
      const name = out.getPortName(i);
      const lower = name.toLowerCase();
      result.push({
        index: i,
        name,
        looksLikeAxeFxII: AXE_FX_II_PORT_NEEDLES.some((n) => lower.includes(n)),
      });
    }
    return result;
  } finally {
    try { out.closePort(); } catch { /* not opened */ }
  }
}

/**
 * Open the Axe-Fx II output, plus the input if the OS exposes one.
 * Throws on no output port; falls back to output-only on no input
 * port (writes still work, GET responses lose visibility).
 *
 * Caller surfaces the throw to the user as an MCP error response.
 */
export function connectAxeFxII(): AxeFxIIConnection {
  if (process.env.MCP_MOCK_TRANSPORT === '1') {
    return mockAxeFxIIConnection();
  }
  const out = new midi.Output();
  const outIdx = findAxeFxIIOutputIndex(out);
  if (outIdx < 0) {
    const visible: string[] = [];
    for (let i = 0; i < out.getPortCount(); i++) {
      visible.push(`[${i}] ${out.getPortName(i)}`);
    }
    try { out.closePort(); } catch { /* not opened */ }
    throw new Error(
      `Axe-Fx II not found. Looked for any output port whose name contains: ` +
      `${AXE_FX_II_PORT_NEEDLES.join(' / ')}. Visible outputs: ${visible.length === 0 ? '(none)' : visible.join(', ')}. ` +
      `Likely causes: device not powered on, USB cable not seated, or the Fractal USB driver isn't installed.`,
    );
  }
  out.openPort(outIdx);

  const input = new midi.Input();
  const inIdx = findAxeFxIIInputIndex(input);
  let inputOpen = false;
  const handlers = new Set<(bytes: number[]) => void>();

  if (inIdx >= 0) {
    // Don't ignore SysEx (false), do ignore timing clock + active-sensing (true, true).
    // Wire the listener BEFORE openPort so we don't race the device.
    input.ignoreTypes(false, true, true);
    input.on('message', (_dt: number, bytes: number[]) => {
      // Device-sourced dirty signal: every state-broadcast triple from
      // the device means the working buffer was edited. No heuristic /
      // no timing window — the captures prove the device only emits
      // these on edits (not on reads/switches/saves).
      if (isStateBroadcastInbound(bytes)) {
        markDirty(AXEFX_DIRTY_LABEL);
      }
      for (const h of handlers) {
        try { h(bytes); } catch { /* swallow handler errors so one bad subscriber can't break others */ }
      }
    });
    input.openPort(inIdx);
    inputOpen = true;
  } else {
    try { input.closePort(); } catch { /* never opened */ }
  }

  return {
    send: (bytes) => {
      // The DIRTY signal comes from the device (inbound state-broadcast
      // triples); we don't infer it from our outbound writes. We DO mark
      // clean when we issue switch_preset / store_preset because those
      // operations transition the buffer to a known-clean state (device
      // doesn't announce that transition, so we record it here).
      if (isCleanOutbound(bytes)) markClean(AXEFX_DIRTY_LABEL);
      else if (isEditOutbound(bytes)) markDirty(AXEFX_DIRTY_LABEL);
      out.sendMessage(bytes);
    },
    onMessage: (handler) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    receiveSysExMatching: (predicate, timeoutMs = 1000) => {
      if (!inputOpen) {
        return Promise.reject(new Error(
          'No Axe-Fx II input port available. GET tools (axefx2_get_param, ' +
          'axefx2_get_grid_layout, axefx2_get_preset_name) require a bidirectional ' +
          'MIDI connection. Confirm the OS exposes both Axe-Fx II input and output ' +
          'ports via list_midi_ports — some USB-MIDI driver configurations expose ' +
          'output only.',
        ));
      }
      return new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          handlers.delete(handler);
          reject(new Error(`Timeout waiting for matching SysEx after ${timeoutMs}ms`));
        }, timeoutMs);
        const handler = (bytes: number[]) => {
          if (bytes[0] !== 0xf0) return;
          if (!predicate(bytes)) return;
          clearTimeout(timer);
          handlers.delete(handler);
          resolve(bytes);
        };
        handlers.add(handler);
      });
    },
    hasInput: inputOpen,
    close: () => {
      handlers.clear();
      try { out.closePort(); } catch { /* already closed */ }
      if (inputOpen) {
        try { input.closePort(); } catch { /* already closed */ }
      }
    },
    receiveSysEx: (_timeoutMs?: number) => {
      return Promise.reject(new Error(
        'receiveSysEx is not implemented on Axe-Fx II — use receiveSysExMatching ' +
        'with an explicit predicate. If a dispatcher path calls this, add the ' +
        'predicate-less handler here using the same handlers Set pattern.',
      ));
    },
    lastSendError: undefined,
  };
}

/**
 * Axe-Fx II mock connection. Returned by `connectAxeFxII()` when
 * `MCP_MOCK_TRANSPORT=1` is set — lets agent-regression cases run
 * without the XL+ plugged in.
 *
 * Writes are accepted (no-op send). Reads via `receiveSysExMatching`
 * time out — the Axe-Fx II GET response shapes (state-broadcast
 * triples 0x74/0x75/0x76 etc.) aren't synthesized yet. Cases that
 * exercise WRITE-only paths (apply_preset, set_param, switch_preset,
 * v0.4 routing) will pass; read-driven cases will need a responder
 * extension following the AM4 pattern in am4/midi.ts:am4MockResponder.
 *
 * The `hasInput:true` flag is set so the writers' "no input port" guard
 * doesn't trip — the mock pretends a bidirectional connection exists
 * even though reads will time out at the predicate level.
 */
// BK-113 follow-up: II mock fixture profiles for adversary testing.
// Default 'clean-scratch' returns the empty grid (existing behavior).
// 'populated-unrouted' places Amp 1 at (row 2, col 3) with routing_mask=0
// so the BK-076 routing-mask pre-flight has a real failure to detect.
// Picked at process spawn time via the `MOCK_FIXTURE` env var (the
// agent-regression runner injects it per case-spec).
type AxeFxIIMockFixture = 'clean-scratch' | 'populated-unrouted';
const MOCK_FIXTURE: AxeFxIIMockFixture = ((): AxeFxIIMockFixture => {
  const raw = process.env.MOCK_FIXTURE;
  if (raw === 'populated-unrouted') return raw;
  return 'clean-scratch';
})();

function mockAxeFxIIConnection(): AxeFxIIConnection {
  const handlers = new Set<(bytes: number[]) => void>();
  // Minimal mock responder: synthesizes the GET_BLOCK_CHANNEL response
  // (function 0x11) so bucket-7 channel-write safety logic can run under
  // MCP_MOCK_TRANSPORT=1. All other GETs still fall through to the
  // not-implemented rejection — extending this responder is the path to
  // mock more read-side wire shapes (see am4MockResponder for the
  // full-coverage pattern).
  //
  // The mock pretends every block is currently on channel X. That lets
  // the agent-retry-paths test cover both branches:
  //   - set_param(channel: 'X') succeeds (active channel matches);
  //   - set_param(channel: 'Y') refuses with channel-mismatch warning.
  const FUNC_BLOCK_CHANNEL = 0x11;
  const FUNC_GET_GRID_LAYOUT = 0x20;
  const FUNC_GET_PRESET_NAME = 0x0f;
  const SYSEX_START_BYTE = 0xf0;
  const SYSEX_END_BYTE = 0xf7;

  // BK-070 mock: synthesize a 48-cell grid response for fn 0x20.
  //
  // Default ('clean-scratch'): empty grid (every cell zero). Lets the
  // unified `get_preset` end-to-end test verify routing without also
  // stubbing per-block fn 0x1F responses.
  //
  // BK-113 follow-up ('populated-unrouted'): grid carries Amp 1 (id 106)
  // at (row 2, col 3) with routingFlags=0 — block placed but no
  // previous-column cell feeds its input. Exercises the BK-076
  // routing-mask=0 pre-flight end-to-end: `set_param` on `amp` reads
  // the grid via `getBlockLayoutSnapshot`, computes `unroutedBlocks`,
  // and surfaces the `validation_info[]` warning. All other cells stay
  // empty.
  //
  // Per `parseGetGridLayoutResponse`: cells are column-major, top-to-
  // bottom within each column. Per cell, 4 bytes: blockId lo (bits
  // 6-0), blockId hi (bits 13-7), routing flags, unused.
  const buildGridResponse = (outgoing: number[]): number[] | undefined => {
    if (outgoing.length < 8) return undefined;
    if (outgoing[0] !== SYSEX_START_BYTE) return undefined;
    if (outgoing[1] !== 0x00 || outgoing[2] !== 0x01 || outgoing[3] !== 0x74) return undefined;
    if (outgoing[5] !== FUNC_GET_GRID_LAYOUT) return undefined;
    const modelId = outgoing[4];
    const cells = new Array(48 * 4).fill(0x00);
    if (MOCK_FIXTURE === 'populated-unrouted') {
      // Amp 1 = id 106. Place at row 2 col 3 with routingFlags=0.
      // Cell index = (col - 1) * 4 + (row - 1) = 2 * 4 + 1 = 9.
      const cellIndex = 9;
      const byteOffset = cellIndex * 4;
      const ampId = 106;
      cells[byteOffset] = ampId & 0x7f;
      cells[byteOffset + 1] = (ampId >> 7) & 0x7f;
      cells[byteOffset + 2] = 0x00; // routingFlags = 0 → no input cable
      cells[byteOffset + 3] = 0x00;
    }
    const head = [
      SYSEX_START_BYTE, 0x00, 0x01, 0x74,
      modelId, FUNC_GET_GRID_LAYOUT,
      ...cells,
    ];
    const cs = head.slice(1).reduce((a, b) => a ^ b, 0) & 0x7f;
    return [...head, cs, SYSEX_END_BYTE];
  };

  // Back-compat alias so existing references resolve.
  const buildEmptyGridResponse = buildGridResponse;

  // BK-070 mock: GET_PRESET_NAME response so `get_preset` can fill
  // `name`. Returns "Mock Preset" + null terminator. Body is null-
  // terminated ASCII per parseGetPresetNameResponse.
  const buildPresetNameResponse = (outgoing: number[]): number[] | undefined => {
    if (outgoing.length < 7) return undefined;
    if (outgoing[0] !== SYSEX_START_BYTE) return undefined;
    if (outgoing[1] !== 0x00 || outgoing[2] !== 0x01 || outgoing[3] !== 0x74) return undefined;
    if (outgoing[5] !== FUNC_GET_PRESET_NAME) return undefined;
    const modelId = outgoing[4];
    const nameBytes = Array.from('Mock Preset', (c) => c.charCodeAt(0));
    const head = [
      SYSEX_START_BYTE, 0x00, 0x01, 0x74,
      modelId, FUNC_GET_PRESET_NAME,
      ...nameBytes, 0x00,
    ];
    const cs = head.slice(1).reduce((a, b) => a ^ b, 0) & 0x7f;
    return [...head, cs, SYSEX_END_BYTE];
  };

  const buildGetBlockChannelMockResponse = (outgoing: number[]): number[] | undefined => {
    if (outgoing.length < 10) return undefined;
    if (outgoing[0] !== SYSEX_START_BYTE) return undefined;
    if (outgoing[1] !== 0x00 || outgoing[2] !== 0x01 || outgoing[3] !== 0x74) {
      return undefined;
    }
    const modelId = outgoing[4];
    const fn = outgoing[5];
    if (fn !== FUNC_BLOCK_CHANNEL) return undefined;
    // Outgoing 'get' frame has action=0x00 at index 9; ignore writes
    // (action=0x01) — those don't get a response in the live protocol.
    if (outgoing[9] !== 0x00) return undefined;
    const effLo = outgoing[6] ?? 0;
    const effHi = outgoing[7] ?? 0;
    // Response: F0 00 01 74 [model] 11 [eff_lo] [eff_hi] [chan=0 (X)] [cs] F7
    const head = [
      SYSEX_START_BYTE, 0x00, 0x01, 0x74,
      modelId, FUNC_BLOCK_CHANNEL,
      effLo & 0x7f, effHi & 0x7f, 0x00,
    ];
    const cs = head.slice(1).reduce((a, b) => a ^ b, 0) & 0x7f;
    return [...head, cs, SYSEX_END_BYTE];
  };
  return {
    send: (bytes) => {
      // Synthesize an inbound response when the outgoing frame matches a
      // known shape the mock can answer. Each responder returns undefined
      // when the outgoing frame isn't its shape, so we just walk the
      // ordered list and use the first hit. Currently covers:
      //   - GET_BLOCK_CHANNEL (fn 0x11) — bucket-7 channel-write safety
      //   - GET_GRID_LAYOUT  (fn 0x20) — BK-070 get_preset, empty grid
      //   - GET_PRESET_NAME  (fn 0x0f) — BK-070 get_preset, name field
      const response =
        buildGetBlockChannelMockResponse(bytes)
        ?? buildEmptyGridResponse(bytes)
        ?? buildPresetNameResponse(bytes);
      if (response !== undefined) {
        // Dispatch on next tick so the sender's await/receive setup has
        // time to register its predicate handler before the response
        // arrives. setImmediate avoids the 0ms-timer race on Windows.
        setImmediate(() => {
          for (const h of handlers) {
            try { h(response); } catch { /* swallow handler errors */ }
          }
        });
      }
    },
    onMessage: (handler) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    receiveSysExMatching: (predicate, timeoutMs = 1000) => {
      return new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          handlers.delete(handler);
          reject(new Error(
            `mock Axe-Fx II transport: no synthesized response for this predicate within ${timeoutMs}ms. ` +
            `Extend mockAxeFxIIConnection with the wire shape this caller needs.`,
          ));
        }, timeoutMs);
        const handler = (bytes: number[]) => {
          if (bytes[0] !== SYSEX_START_BYTE) return;
          if (!predicate(bytes)) return;
          clearTimeout(timer);
          handlers.delete(handler);
          resolve(bytes);
        };
        handlers.add(handler);
      });
    },
    hasInput: true,
    close: () => { handlers.clear(); },
    receiveSysEx: (_timeoutMs?: number) => Promise.reject(new Error(
      'receiveSysEx is not implemented on Axe-Fx II — use receiveSysExMatching ' +
      'with an explicit predicate.',
    )),
    lastSendError: undefined,
  };
}

// Register the Axe-Fx II connector with the shared connection registry
// as a side effect of loading this module. `AxeFxIIConnection` now
// implements all fields of `MidiConnection` (receiveSysEx throws "not
// implemented" and lastSendError is always undefined) so the cast is
// a plain structural assignment rather than an escape hatch.
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { registerConnector, AXEFX2_LABEL } from '@mcp-midi-control/core/server-shared/connections.js';
registerConnector(AXEFX2_LABEL, () => connectAxeFxII() as MidiConnection);
