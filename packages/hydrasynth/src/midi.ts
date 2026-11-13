/**
 * Hydrasynth Explorer — MIDI connection helper.
 *
 * Mirrors the shape of `src/protocol/midi.ts` (the AM4 connection
 * helper) but device-scoped: looks for "hydrasynth" / "asm hydra" in
 * port names, opens both an Output and an Input.
 *
 * Why the Input port matters: NRPN/CC writes are fire-and-forget on
 * the Hydrasynth (`docs/devices/hydrasynth-explorer/FIRST-SMOKE.md`
 * §3 — "The Hydrasynth does not ack CCs"). But SysEx is a *different*
 * protocol path that DOES emit acks per `SysexEncoding.txt` (lines
 * 342, 351-352, 377-378): `19 00` after Header `18 00`, `17 00 NN 16`
 * after every chunk, `1B 00` after Footer `1A 00`, and `07 00 BANK
 * PATCH` "Patch Saved" after the final chunk. Opening Input lets
 * `hydra_apply_init` observe these to diagnose silent-on-key-press
 * failure modes (HW-040 test 1).
 *
 * The Input port is best-effort — if the OS doesn't expose a
 * Hydrasynth input (some USB-MIDI driver configurations expose only
 * output), we fall back to output-only and `hasInput` flips false.
 * NRPN/CC tools keep working; only SysEx diagnostics lose visibility.
 */
import type { Input, Output } from '@julusian/midi';
import { createRequire } from 'node:module';

import {
  createSysExAssembler,
  makeSysExReceiver,
  type MidiConnection,
} from '@mcp-midi-control/core/midi/transport.js';
import { registerConnector } from '@mcp-midi-control/core/server-shared/connections.js';

/**
 * node-midi is loaded LAZILY (and synchronously via createRequire — the
 * connect/list contracts are sync), mirroring the pattern in
 * `packages/core/src/midi/transport.ts`: merely importing this module
 * never touches the native binding. That keeps serial-only sessions
 * (FM3 over USB-CDC) and `npm install --ignore-scripts` clones with no
 * node-gyp toolchain booting the server; the binding is only required
 * when a Hydrasynth port is actually listed or opened.
 */
let midiModule: typeof import('@julusian/midi') | undefined;
function loadMidi(): typeof import('@julusian/midi') {
  if (midiModule === undefined) {
    try {
      midiModule = createRequire(import.meta.url)('@julusian/midi') as typeof import('@julusian/midi');
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `The MIDI transport module ("@julusian/midi") failed to load: ${cause}\n` +
        'This is an installation problem (missing or broken native binding), not a device ' +
        'problem. @julusian/midi normally installs a prebuilt binary; if you installed with ' +
        '--ignore-scripts, run "npm rebuild @julusian/midi" to fetch/build it. Serial-only ' +
        'devices (FM3 over USB-CDC) do not need it.',
      );
    }
  }
  return midiModule;
}

const HYDRA_PORT_NEEDLES = ['hydrasynth', 'asm hydra'];

/**
 * The Hydrasynth connection IS the core `MidiConnection` since BK-110
 * (stored-content reads). Historically this was a narrower device-local
 * interface with its own handle, while the unified dispatcher held a
 * SECOND handle to the same exclusive Windows port via
 * `ensureConnection('hydrasynth')` — two handles to one port is the
 * port-contention bug class this project keeps re-hitting, and it also
 * meant `reconnect_midi` reset only the dispatcher's handle, never the
 * one apply_patch actually used. Now `connectHydrasynth` is registered
 * as the connector FACTORY for the 'hydrasynth' label (see the
 * `registerConnector` call at the bottom), so the registry owns the one
 * true handle and both the legacy patch tools (`ensureMidi`) and the
 * dispatcher (`withEndpoint` → `ctx.conn`) share it.
 */
export type HydrasynthConnection = MidiConnection;

export interface HydrasynthPortInfo {
  index: number;
  name: string;
  looksLikeHydrasynth: boolean;
}

function findHydrasynthOutputIndex(out: Output): number {
  for (let i = 0; i < out.getPortCount(); i++) {
    const name = out.getPortName(i).toLowerCase();
    if (HYDRA_PORT_NEEDLES.some((n) => name.includes(n))) return i;
  }
  return -1;
}

function findHydrasynthInputIndex(input: Input): number {
  for (let i = 0; i < input.getPortCount(); i++) {
    const name = input.getPortName(i).toLowerCase();
    if (HYDRA_PORT_NEEDLES.some((n) => name.includes(n))) return i;
  }
  return -1;
}

/**
 * Enumerate output ports without opening any. Used by the startup
 * banner so the server can log a verdict ("Hydrasynth detected" /
 * "Hydrasynth not visible") at boot, before any tool call.
 */
export function listHydrasynthOutputs(): HydrasynthPortInfo[] {
  const midi = loadMidi();
  const out = new midi.Output();
  try {
    const result: HydrasynthPortInfo[] = [];
    for (let i = 0; i < out.getPortCount(); i++) {
      const name = out.getPortName(i);
      const lower = name.toLowerCase();
      result.push({
        index: i,
        name,
        looksLikeHydrasynth: HYDRA_PORT_NEEDLES.some((n) => lower.includes(n)),
      });
    }
    return result;
  } finally {
    // node-midi requires explicit cleanup even when no port was opened
    // (closes the underlying ALSA/CoreMIDI/WinMM handle).
    try { out.closePort(); } catch { /* not opened */ }
  }
}

/**
 * Open the Hydrasynth Explorer output, plus the input if the OS
 * exposes one. Throws on no output port (the device is unusable
 * without it); falls back to output-only on no input port (NRPN
 * writes still work, SysEx loses ack visibility).
 *
 * Caller surfaces the throw to the user as an MCP error response.
 */
export function connectHydrasynth(): HydrasynthConnection {
  if (process.env.MCP_MOCK_TRANSPORT === '1') {
    return mockHydrasynthConnection();
  }
  const midi = loadMidi();
  const out = new midi.Output();
  const outIdx = findHydrasynthOutputIndex(out);
  if (outIdx < 0) {
    const visible: string[] = [];
    for (let i = 0; i < out.getPortCount(); i++) {
      visible.push(`[${i}] ${out.getPortName(i)}`);
    }
    try { out.closePort(); } catch { /* not opened */ }
    throw new Error(
      `Hydrasynth Explorer not found. Looked for any output port whose name contains: ` +
      `${HYDRA_PORT_NEEDLES.join(' / ')}. Visible outputs: ${visible.length === 0 ? '(none)' : visible.join(', ')}. ` +
      `Likely causes: device not powered on, USB cable not seated, or the OS hasn't enumerated it yet (try unplug + replug).`,
    );
  }
  out.openPort(outIdx);
  // openPort() does NOT throw on failure (RtMidi prints to stderr and
  // leaves the port closed). Assert the native isPortOpen() truth and
  // fail loudly with the exclusive-hold diagnosis (2026-06-10 incident).
  if (!out.isPortOpen()) {
    try { out.closePort(); } catch { /* best-effort */ }
    throw new Error(
      'Hydrasynth output port found but could NOT be opened (the OS refused the open). ' +
      'Windows MIDI ports are exclusive: another process is almost certainly holding it ' +
      '(a second MCP server instance from another Claude session, or a stale node.exe from ' +
      'an earlier session). Close the holder, then retry or call reconnect_midi. ' +
      'If this error repeats right after a reconnect_midi on a quiet bus, the holder may be THIS ' +
      "server's own previous handle (the driver does not always release a handle that died " +
      'mid-send): fully quit and relaunch the host app to restart the server.',
    );
  }

  const input = new midi.Input();
  const inIdx = findHydrasynthInputIndex(input);
  let inputOpen = false;
  const handlers = new Set<(bytes: number[]) => void>();

  if (inIdx >= 0) {
    // Wire the listener BEFORE openPort so we don't race the device; the
    // SysEx ignore-flags are (re)set AFTER openPort — see below.
    // Reassemble WinMM SysEx fragments before dispatching: node-midi
    // delivers any SysEx longer than RT_SYSEX_BUFFER_SIZE (2048 bytes,
    // midi/binding.gyp) as multiple `message` events. Hydrasynth patch
    // dump chunks sit under that cap today, but the assembler's fast
    // path passes complete frames through unchanged, so this costs
    // nothing and removes the truncation class entirely.
    const assemble = createSysExAssembler((bytes: number[]) => {
      for (const h of handlers) {
        try { h(bytes); } catch { /* swallow handler errors so one bad subscriber can't break others */ }
      }
    });
    input.on('message', (_dt: number, bytes: number[]) => {
      assemble(bytes);
    });
    input.openPort(inIdx);
    // Don't ignore SysEx (false), do ignore timing clock + active-sensing.
    // MUST come AFTER openPort: @julusian/midi resets the ignore-flags to
    // their defaults (SysEx ignored) on openPort, so an earlier call is
    // silently wiped and every inbound SysEx reply is dropped. node-midi
    // tolerated the earlier call; @julusian does not.
    input.ignoreTypes(false, true, true);
    if (!input.isPortOpen()) {
      // Dead INPUT = writes fire, every read/ack times out. Fail loudly.
      try { input.closePort(); } catch { /* best-effort */ }
      try { out.closePort(); } catch { /* best-effort */ }
      throw new Error(
        'Hydrasynth input port found but could NOT be opened (the OS refused the open). ' +
        'Windows MIDI inputs are exclusive: another process is almost certainly holding it ' +
        '(a second MCP server instance from another Claude session, or a stale node.exe from ' +
        'an earlier session). Close the holder, then retry or call reconnect_midi. ' +
      'If this error repeats right after a reconnect_midi on a quiet bus, the holder may be THIS ' +
      "server's own previous handle (the driver does not always release a handle that died " +
      'mid-send): fully quit and relaunch the host app to restart the server.',
      );
    }
    inputOpen = true;
  } else {
    try { input.closePort(); } catch { /* never opened */ }
  }

  // Track send errors on a separate cell so the conn object can
  // expose live state via a getter without TS forward-reference
  // issues. See AM4 midi.ts for the same pattern.
  const sendErrCell: { value?: Error } = {};
  let closed = false;
  return {
    send: (bytes) => {
      try {
        out.sendMessage(bytes);
        sendErrCell.value = undefined;
      } catch (err) {
        sendErrCell.value = err instanceof Error ? err : new Error(String(err));
        throw sendErrCell.value;
      }
    },
    get lastSendError(): Error | undefined { return sendErrCell.value; },
    receiveSysEx: (timeoutMs = 1000) =>
      makeSysExReceiver(handlers, () => true, timeoutMs, 'Timeout waiting for SysEx response'),
    receiveSysExMatching: (predicate, timeoutMs = 1000) =>
      makeSysExReceiver(handlers, predicate, timeoutMs, 'Timeout waiting for matching SysEx'),
    onMessage: (handler) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    hasInput: inputOpen,
    isPortOpen: () => {
      try {
        return out.isPortOpen() && (!inputOpen || input.isPortOpen());
      } catch {
        return false;
      }
    },
    close: () => {
      // Idempotent: the registry's stale-handle path and the process-exit
      // hook can both close; a second native close is a double-free.
      if (closed) return;
      closed = true;
      handlers.clear();
      try { out.closePort(); } catch { /* already closed */ }
      if (inputOpen) {
        try { input.closePort(); } catch { /* already closed */ }
      }
    },
  };
}

/**
 * Hydrasynth mock connection. Returned by `connectHydrasynth()` when
 * `MCP_MOCK_TRANSPORT=1` is set — lets agent-regression cases run
 * without an Explorer plugged in.
 *
 * Hydrasynth's CC / NRPN writes are fire-and-forget by design (the
 * device doesn't ack — see `docs/devices/hydrasynth-explorer/
 * FIRST-SMOKE.md` §3). SysEx patch dumps DO emit acks (`19 00`, `17 00
 * NN 16`, `1B 00`, `07 00 BANK PATCH` per SysexEncoding.txt) but the
 * Hydra tools observe these via the `onMessage` listener for
 * diagnostics, not via blocking awaits — so this no-input mock is
 * sufficient for both NRPN-driven and SysEx-driven write paths. If a
 * future agent-regression case needs ack visibility, extend
 * `mockHydrasynthConnection()` with a responder that synthesizes the
 * documented Hydrasynth ack bytes.
 */
function mockHydrasynthConnection(): HydrasynthConnection {
  return {
    send: (_bytes) => { /* no-op — writes accepted, no wire traffic */ },
    lastSendError: undefined,
    // No responder: receivers time out, mirroring hasInput:false hardware.
    receiveSysEx: (timeoutMs = 1000) =>
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`Timeout waiting for SysEx response after ${timeoutMs}ms (mock transport has no input)`)),
        timeoutMs,
      )),
    receiveSysExMatching: (_predicate, timeoutMs = 1000) =>
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`Timeout waiting for matching SysEx after ${timeoutMs}ms (mock transport has no input)`)),
        timeoutMs,
      )),
    onMessage: (_handler) => () => { /* no-op unsubscribe */ },
    hasInput: false,
    isPortOpen: () => true,
    close: () => { /* no-op */ },
  };
}

/**
 * Register this module's factory as the ONE connection source for the
 * 'hydrasynth' label (= the descriptor's `connection_label`). Both the
 * dispatcher's `withEndpoint` ctx build and the legacy patch tools'
 * `ensureMidi()` resolve through `ensureConnection('hydrasynth')`, so
 * they share a single handle to the exclusive Windows port, and
 * `reconnect_midi` (which force-reopens under this label) actually
 * resets the handle every Hydrasynth code path uses.
 *
 * Module-load side effect by design (see connections.ts): any code
 * importing this module — the descriptor, the tools, or a script —
 * gets the factory registered before the first `ensureConnection`.
 */
registerConnector('hydrasynth', connectHydrasynth);
