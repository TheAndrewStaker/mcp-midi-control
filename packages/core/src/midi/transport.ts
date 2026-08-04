/**
 * Generic MIDI transport — port enumeration + open/connect wrapper around
 * node-midi. Device-agnostic; used by every device package and the
 * generic-MIDI primitive tools (`send_cc`, `send_note`, …).
 *
 * Wraps node-midi to:
 *   - find a port by name-substring match
 *   - enable SysEx (off by default in node-midi)
 *   - return promises for clean async/await usage
 *
 * Caller must call `close()` to release ports.
 *
 * Device-specific connector wrappers (e.g. `connectAM4`,
 * `connectAxeFxII`) live in their device packages and delegate to
 * `connect()` here with device-specific needles + onboarding hints.
 *
 * ## Why an unclosed connection HANGS the process (read before "just exiting")
 *
 * `Input.openPort()` in @julusian/midi calls `setupCallback()`, which creates a
 * `Napi::TypedThreadSafeFunction` (`src/input.cpp`, `handleMessage = TSFN_t::New`)
 * so the RtMidi callback thread can hand messages to JS. A live thread-safe
 * function holds a REF on the libuv event loop for as long as it exists, and the
 * only thing that releases it is `closePortAndRemoveCallback()`, reached from
 * `closePort()` or `destroy()`.
 *
 * So a process that opened an input port and never closed it NEVER EXITS. It
 * sits there forever holding the device's exclusive OS MIDI port, which on
 * Windows means every later open of that device fails. That is exactly the
 * zombie-node-process failure that wedged a Circuit Tracks (2026-07-26).
 *
 * The nasty part: a TSFN ref is invisible to `process.getActiveResourcesInfo()`
 * AND to `process._getActiveHandles()`: both report an EMPTY list while the
 * loop is pinned. Do not conclude "nothing is holding the loop" from those.
 *
 * Consequences encoded below:
 *   - `close()` is idempotent and fault-isolated (see `releaseNativeHandles`).
 *   - every live connection is tracked in `liveConnections` so a caller can
 *     release the lot with `closeAllMidiConnections()`, and so a `process.exit()`
 *     path still gets an orderly WinMM close instead of an abrupt teardown.
 */
import type { Input, Output } from '@julusian/midi';
import { createRequire } from 'node:module';

/**
 * The native MIDI binding (`@julusian/midi`, an API-compatible node-midi fork
 * that ships N-API prebuilds for every platform we target) is loaded LAZILY and
 * synchronously via createRequire — the `connect()` / `listMidiPorts()`
 * contracts are sync — so merely importing this module never touches the native
 * binding. That keeps serial-only sessions (FM3 over USB-CDC) working where the
 * binding is absent — e.g. an `npm install --ignore-scripts` clone (community
 * field report, 2026-06-12). With @julusian/midi the common case is a prebuilt
 * binary (no node-gyp toolchain needed); it falls back to compiling only when no
 * prebuild matches the platform.
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

export interface MidiConnection {
  send: (bytes: number[]) => void;
  /**
   * Last error thrown by the underlying `output.sendMessage` call, or
   * `undefined` if the most recent send succeeded. node-midi's WinMM
   * backend prints `MidiOutWinMM::sendMessage: error sending sysex
   * message` to stderr and silently fails on a stale handle, which
   * leaves the tool reporting "success" while 0/22 chunks land. Tools
   * doing multi-message dumps (Hydrasynth patch, AM4 apply_preset)
   * read this after each send to bail loudly on the first failure
   * instead of looping through 22 broken writes.
   */
  lastSendError?: Error;
  /** Resolves with the next inbound SysEx message, or rejects on timeout. */
  receiveSysEx: (timeoutMs?: number) => Promise<number[]>;
  /**
   * Wait for the first inbound SysEx that satisfies `predicate`. Non-matching
   * messages are silently dropped until `timeoutMs` elapses. Register BEFORE
   * the outgoing write so the response can't race ahead of the listener.
   */
  receiveSysExMatching: (
    predicate: (bytes: number[]) => boolean,
    timeoutMs?: number,
  ) => Promise<number[]>;
  /**
   * Subscribe to ALL inbound messages (SysEx + non-SysEx). Returns an
   * unsubscribe function. When `hasInput` is false (no input port found),
   * the handler is registered but will never fire — diagnostic tools that
   * report "n messages observed" stay safe to call.
   */
  onMessage: (handler: (bytes: number[]) => void) => () => void;
  /**
   * True when an input port was successfully opened. Diagnostic surfaces
   * (the inbound-capture timeline in `apply_preset` / `set_param` / etc.)
   * read this flag so they can say "no input port — capture is empty by
   * construction" instead of silently reporting an empty timeline.
   */
  hasInput: boolean;
  /**
   * Cheap liveness signal: true while the underlying OS port handle is open.
   * HONEST LIMITS: this is the OS open-flag, re-evaluated only at open/close —
   * it is a NEGATIVE catch (unplugged / closed), NOT a positive health check.
   * A WinMM handle poisoned mid-send is NOT released by closePort() and still
   * reports open (STATE.md 2026-06-10), so `isPortOpen() === true` does not
   * prove the handle can send. The only robust liveness signal is a round-trip
   * (a transfer's first ACK). Optional — transports/mocks may omit it.
   */
  isPortOpen?: () => boolean;
  /**
   * R2 handle-health stretch goal (docs/design/connection-canary.md): true
   * when the MOST RECENT `send()` call's wall-clock time exceeded
   * `SLOW_SEND_THRESHOLD_MS`, logged as a warning at the time it happened.
   * `@julusian/midi`'s `sendMessage` runs synchronously on the JS thread; a
   * send that stalls the device queue for a while (but still returns) is
   * exactly the failure mode `lastSendError` and `isPortOpen()` both miss;
   * neither is set/changed by a slow-but-completed send. This flag lets
   * `isHandleHealthy` (server-shared/handleHealth.ts) mark the handle
   * suspect for the NEXT acquire, without adding any round trip to this one.
   * HONEST LIMIT: a send that never returns at all (the true queue-stalled
   * hang) cannot be observed here either; this only catches "slow but
   * eventually returned," not a hang. Optional; only the real `connect()`-
   * backed connection tracks it; mocks/null/serial connections omit it
   * (reads as falsy, no change in behavior).
   */
  slowSendSuspect?: boolean;
  close: () => void;
}

/**
 * Wall-clock threshold (ms) above which a completed `send()` call is logged
 * as slow and marks the handle `slowSendSuspect` for the next health check.
 * See `MidiConnection.slowSendSuspect`.
 */
export const SLOW_SEND_THRESHOLD_MS = 250;

/**
 * Build a stateful SysEx reassembler. node-midi's WinMM backend hands
 * each MIM_LONGDATA buffer up as its own `message` event, so any SysEx
 * longer than RT_SYSEX_BUFFER_SIZE (1024 bytes — RtMidi.cpp:2467)
 * arrives split across multiple callbacks. AM4 preset-dump chunks
 * (3082 bytes) and Axe-Fx II preset bodies are both bigger than that.
 * Downstream parsers (presetDump.ts assertDumpMessageShape,
 * receiveSysExMatching, every device's response parser) assume one
 * F0…F7 message per emit — this glues fragments back together so the
 * assumption holds.
 *
 * Returned function is the inbound seam: feed every raw `message`
 * callback through it; it emits to `dispatch` once a fragment ends
 * in F7 (or immediately for any non-SysEx fragment, which short MIDI
 * messages always are).
 *
 * Edge cases:
 *   - Short MIDI (3-byte note/CC/PC) bypasses the accumulator —
 *     the first byte is a non-F0 status, so it ships straight through.
 *   - Complete SysEx in a single fragment (F0…F7, length ≤ 1024)
 *     also bypasses the accumulator. Fast path.
 *   - A fragment with F7 mid-buffer (rare on WinMM but legal MIDI)
 *     is split at the F7: prefix is emitted as the completed message,
 *     trailing bytes open a new accumulation if they start with F0.
 *
 * Serial byte streams use `createSerialMidiFramer` (serialFraming.ts)
 * instead — the two stay separate deliberately: the input contracts
 * (node-midi message-shaped fragments vs a raw byte stream) and
 * malformed-input behavior differ, so neither can substitute for the
 * other.
 *
 * Exported for unit testing so we don't need a live MIDI port to
 * prove the reassembly is correct.
 */
export function createSysExAssembler(
  dispatch: (bytes: number[]) => void,
): (fragment: number[]) => void {
  let accumulator: number[] | undefined;
  return (bytes: number[]): void => {
    if (bytes.length === 0) return;
    const startsWithF0 = bytes[0] === 0xf0;
    const endsWithF7 = bytes[bytes.length - 1] === 0xf7;

    // Fast path: complete SysEx in one fragment, or a non-SysEx
    // short message. Nothing to assemble.
    if (accumulator === undefined && startsWithF0 && endsWithF7) {
      dispatch(bytes);
      return;
    }
    if (accumulator === undefined && !startsWithF0) {
      dispatch(bytes);
      return;
    }

    // Open or continuing SysEx fragment.
    if (accumulator === undefined && startsWithF0) {
      accumulator = bytes.slice();
    } else if (accumulator !== undefined) {
      for (const b of bytes) accumulator.push(b);
    }

    // Drain on any F7. Handle F7-in-middle by splitting (defensive).
    if (accumulator !== undefined && endsWithF7) {
      const f7Index = accumulator.lastIndexOf(0xf7);
      const complete = accumulator.slice(0, f7Index + 1);
      const trailing = accumulator.slice(f7Index + 1);
      accumulator = undefined;
      dispatch(complete);
      if (trailing.length > 0 && trailing[0] === 0xf0) {
        if (trailing[trailing.length - 1] === 0xf7) {
          dispatch(trailing);
        } else {
          accumulator = trailing;
        }
      }
    }
  };
}

/**
 * Release the native input + output handles of one connection, isolating each
 * step so one failure cannot strand the others.
 *
 * Order and isolation are both load-bearing:
 *
 *  - OUTPUT FIRST. `MidiOutWinMM::closePort()` has no error path (it is a bare
 *    `midiOutClose`), whereas `MidiInWinMM::closePort()` CAN raise
 *    `RtMidiError::DRIVER_ERROR` when `midiInUnprepareHeader` fails on a handle
 *    that was poisoned mid-SysEx, and `NodeMidiInput::ClosePort` does not wrap
 *    that in a try/catch. Pre-fix, `close()` ran `input.closePort()` first, so a
 *    poisoned input aborted the whole close and the OUTPUT port stayed open for
 *    the life of the process. The next `connect()` then failed its
 *    `isPortOpen()` assertion against our OWN leaked handle, which is why
 *    `reconnect_midi` could never recover a wedged handle and only a full
 *    restart cleared it. Closing output first makes the recoverable half
 *    always recover.
 *
 *  - `destroy()` ONLY after a clean `closePort()`. RtMidi's WinMM input close
 *    `delete[]`s its sysex buffers BEFORE the error return and never clears the
 *    vector or `connected_`, so re-entering that path double-frees. A second
 *    close attempt on a handle that already threw is therefore unsafe; skip it.
 */
function releaseNativeHandles(input: Input, output: Output): void {
  try {
    output.closePort();
    try { output.destroy(); } catch { /* native object already gone */ }
  } catch { /* output could not be closed; keep going, input still must be */ }
  try {
    input.closePort();
    // Only reachable when closePort did NOT throw; see the double-free note.
    try { input.destroy(); } catch { /* native object already gone */ }
  } catch { /* poisoned handle: the OS releases it at process exit */ }
}

/**
 * Every connection `connect()` has handed out and that has not been closed yet.
 * Tracked so callers can release the whole set at the end of a run (scripts) and
 * so the process-exit hook below can close ports in an orderly way.
 */
const liveConnections = new Set<{ close: () => void }>();

/**
 * Close every MIDI connection this process still holds open.
 *
 * This is the call that lets a script TERMINATE. Because an open input port
 * pins the libuv loop through a thread-safe-function ref (see the module note),
 * a script that finishes its work while holding a connection hangs forever and
 * keeps the device's exclusive port. Call this at the end of any script that
 * opened a connection, instead of reaching for `process.exit()`. Letting the
 * loop drain naturally also means piped stdout is flushed and readers such as
 * `tail` see EOF.
 *
 * Idempotent and safe to call when nothing is open. Returns how many
 * connections were closed, which is what the regression guard asserts on.
 */
export function closeAllMidiConnections(): number {
  const snapshot = Array.from(liveConnections);
  for (const entry of snapshot) {
    try {
      entry.close();
    } catch {
      // close() is already fault-isolated internally; this only guards against
      // a caller-supplied close throwing. Never let one bad handle strand the rest.
    }
  }
  liveConnections.clear();
  return snapshot.length;
}

// Belt-and-braces for the `process.exit()` paths (fail-stop branches in the
// device scripts, and the MCP server's own shutdown). `exit` DOES fire on an
// explicit `process.exit()`, and `closePort()` is synchronous native work, so
// the ports get a proper midiInReset/midiInClose instead of being reclaimed
// abruptly by the OS. Registered once, at module load.
process.on('exit', () => { closeAllMidiConnections(); });

function findPortByName(
  port: Input | Output,
  needles: readonly string[],
): number {
  for (let i = 0; i < port.getPortCount(); i++) {
    const name = port.getPortName(i).toLowerCase();
    if (needles.some((n) => name.includes(n.toLowerCase()))) return i;
  }
  return -1;
}

export interface MidiPortInfo {
  index: number;
  name: string;
  direction: 'input' | 'output';
  /** True when this port's name matched one of the supplied needles. */
  matched: boolean;
}

function enumeratePorts(
  port: Input | Output,
  direction: 'input' | 'output',
  needles: readonly string[],
): MidiPortInfo[] {
  const out: MidiPortInfo[] = [];
  for (let i = 0; i < port.getPortCount(); i++) {
    const name = port.getPortName(i);
    const lower = name.toLowerCase();
    const matched = needles.length > 0 && needles.some((n) => lower.includes(n.toLowerCase()));
    out.push({ index: i, name, direction, matched });
  }
  return out;
}

/**
 * List every MIDI input and output the OS exposes, without opening any
 * connection. Used by the `list_midi_ports` MCP tool, every device-
 * specific "device not found" diagnostic, and ad-hoc discovery tooling.
 *
 * `needles` controls which ports get `matched: true`. Default (empty
 * array) leaves every port's `matched` field false — caller filters by
 * its own substring rules.
 *
 * Opens and immediately releases short-lived node-midi handles so a
 * subsequent `connect()` still sees a clean state.
 *
 * Under `MCP_MOCK_TRANSPORT=1`, the real port list is augmented with
 * synthetic AM4 / Axe-Fx II / Hydrasynth entries so callers that gate
 * on visibility (the agent-regression hardware probe, the startup
 * banner, the `list_midi_ports` MCP tool) treat the mock-backed
 * devices as connected. Mock matches the device-specific connectXXX
 * wrappers — each one short-circuits to `mockConnect` under the same
 * env var.
 */
export function listMidiPorts(
  needles: readonly string[] = [],
): { inputs: MidiPortInfo[]; outputs: MidiPortInfo[] } {
  const midi = loadMidi();
  let inputs: MidiPortInfo[] = [];
  let outputs: MidiPortInfo[] = [];
  try {
    const input = new midi.Input();
    const output = new midi.Output();
    try {
      inputs = enumeratePorts(input, 'input', needles);
      outputs = enumeratePorts(output, 'output', needles);
    } finally {
      // No port was ever opened here, so there is no thread-safe function to
      // release, but disposing the RtMidi objects deterministically (rather
      // than at GC) keeps a subsequent connect() looking at a clean state.
      releaseNativeHandles(input, output);
    }
  } catch {
    // RtMidi could not initialise a client (e.g. headless Linux with no
    // ALSA sequencer at /dev/snd/seq, or a machine with no MIDI backend at
    // all). The prebuilt binary still LOADED (loadMidi succeeded); there is
    // just no usable MIDI backend here. Treat it as zero ports so the caller
    // shows the "no MIDI driver visible" verdict instead of crashing.
    inputs = [];
    outputs = [];
  }
  if (process.env.MCP_MOCK_TRANSPORT === '1') {
    return {
      inputs: [...inputs, ...mockPortEntries('input', needles, inputs.length)],
      outputs: [...outputs, ...mockPortEntries('output', needles, outputs.length)],
    };
  }
  return { inputs, outputs };
}

/**
 * Synthetic port entries injected when `MCP_MOCK_TRANSPORT=1`. Names
 * match what each device's connectXXX wrapper would search for
 * (`AM4_PORT_NEEDLES`, `AXE_FX_II_PORT_NEEDLES`, etc.) so the visibility
 * gate trips for every mock-supported device.
 */
function mockPortEntries(
  direction: 'input' | 'output',
  needles: readonly string[],
  baseIndex: number,
): MidiPortInfo[] {
  const dirSuffix = direction === 'input' ? 'In' : 'Out';
  const fakeNames = [
    `AM4 MIDI ${dirSuffix} (mock)`,
    `Axe-Fx II MIDI ${dirSuffix} (mock)`,
    `Hydrasynth MIDI ${dirSuffix} (mock)`,
    `Circuit Tracks MIDI ${dirSuffix} (mock)`,
  ];
  return fakeNames.map((name, i) => {
    const lower = name.toLowerCase();
    const matched = needles.length > 0 && needles.some((n) => lower.includes(n.toLowerCase()));
    return { index: baseIndex + i, name, direction, matched };
  });
}

/**
 * Build the "no port found" error message. Lists what the OS does see so
 * the user can diagnose a typo / wrong-device situation. Device-specific
 * install hints are appended only when the caller passes them via
 * `notFoundHints`.
 */
function buildNotFoundError(
  needles: readonly string[],
  ins: string[],
  outs: string[],
  leadIn: string | undefined,
  extraHints: string[],
): Error {
  const noPorts = ins.length === 0 && outs.length === 0;
  const needleDesc = needles.map((n) => `"${n}"`).join(' or ');
  const lines: string[] = [
    leadIn ?? `No MIDI port matching ${needleDesc} found.`,
    ...extraHints,
  ];
  if (noPorts) {
    lines.push('No MIDI ports of any kind are visible — this usually means a MIDI driver is missing.');
  } else {
    lines.push(`MIDI ports the server can see (none matched ${needleDesc}):`);
    lines.push('Inputs:');
    lines.push(...(ins.length ? ins : ['  (none)']));
    lines.push('Outputs:');
    lines.push(...(outs.length ? outs : ['  (none)']));
  }
  return new Error(lines.join('\n'));
}

export interface ConnectOptions {
  /**
   * Case-insensitive substrings; the first port whose name contains any
   * needle wins. Bidirectional — applied to both inputs and outputs.
   */
  needles: readonly string[];
  /**
   * Optional first line of the "not found" error. Defaults to a generic
   * `No MIDI port matching ...` message; device-specific callers override
   * it (e.g. AM4 uses `AM4 not found in the MIDI device list.`).
   */
  notFoundLeadIn?: string;
  /**
   * Optional install / driver hints appended to the "not found" error.
   * AM4 callers pass driver download + AM4-Edit exclusivity warnings;
   * generic callers usually leave this empty.
   */
  notFoundHints?: string[];
}

/**
 * Synthesize zero-or-more inbound SysEx messages in response to one
 * outgoing message. Returned arrays are delivered to the connection's
 * `onMessage` handlers (and therefore to any pending `receiveSysEx*`
 * waiters) asynchronously, after a configurable latency.
 *
 * Per-device implementations live alongside each device's `midi.ts` —
 * AM4 produces SET_PARAM write-echos and command-acks, Axe-Fx II
 * produces parameter-value responses, etc. The core knows nothing
 * about any protocol; it just wires the synthesizer into the
 * connection.
 */
export type MockResponder = (outgoing: number[]) => number[][];

/**
 * Shared `receiveSysEx` / `receiveSysExMatching` promise construction
 * for the node-midi-backed connections (`connect`, `mockConnect`):
 * register a predicate handler on the shared handler set, race it
 * against a timeout, clean up on either outcome.
 *
 * Pre-observes the rejection (same hardening as serialTransport's
 * `makeReceiver`): callers that register a receiver FIRST and send()
 * SECOND (the standard register-before-write pattern) abandon this
 * promise when send() throws synchronously — without the no-op catch
 * handler, that abandoned rejection is an unhandledRejection and Node
 * KILLS THE WHOLE SERVER PROCESS. Awaiting callers still receive the
 * rejection normally.
 */
function makeSysExReceiver(
  handlers: Set<(bytes: number[]) => void>,
  predicate: (bytes: number[]) => boolean,
  timeoutMs: number,
  timeoutLabel: string,
): Promise<number[]> {
  const p = new Promise<number[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      handlers.delete(handler);
      reject(new Error(`${timeoutLabel} after ${timeoutMs}ms`));
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
  p.catch(() => { /* observed; real handling happens at the await site */ });
  return p;
}

export interface MockConnectOptions {
  /** Device-specific response synthesizer. Receives every outbound message; returns inbound responses to inject. */
  responder: MockResponder;
  /** Simulated ack latency in ms. Default 30 (matches AM4 typical). */
  ackLatencyMs?: number;
}

/**
 * Mock MidiConnection — accepts writes without touching USB and feeds
 * synthesized responses back through the same onMessage / receiveSysEx*
 * channels real connections use. Per the 2026 MCP community pattern
 * ("mock transport" — Fastio MCP testing guide), this replaces the
 * lowest dependency layer with a deterministic stub while leaving the
 * device dispatcher, schema validation, and encoding pipeline intact.
 *
 * Caller enables via env var on the device-specific connectXXX wrapper:
 *
 *   if (process.env.MCP_MOCK_TRANSPORT === '1') return mockConnect({
 *     responder: am4MockResponder,
 *   });
 *
 * Agent-regression cases that don't have hardware plugged in flip this
 * flag and all set_param / apply_preset / etc. tools execute end-to-end
 * against the in-memory mock — same code paths as the real device,
 * minus the USB layer.
 */
export function mockConnect(opts: MockConnectOptions): MidiConnection {
  const handlers = new Set<(bytes: number[]) => void>();
  const ackLatencyMs = opts.ackLatencyMs ?? 30;
  const sendErrCell: { value?: Error } = {};

  const deliver = (bytes: number[]): void => {
    // Snapshot handlers — handler may unsubscribe itself during delivery.
    const snapshot = Array.from(handlers);
    for (const h of snapshot) h([...bytes]);
  };

  const send = (bytes: number[]): void => {
    sendErrCell.value = undefined;
    const responses = opts.responder([...bytes]);
    // Deliver after the simulated latency so receiveSysExMatching's
    // ordering matches real hardware (the writer registers the
    // predicate before send returns).
    if (responses.length > 0) {
      setTimeout(() => {
        for (const r of responses) deliver(r);
      }, ackLatencyMs);
    }
  };

  return {
    send,
    get lastSendError(): Error | undefined { return sendErrCell.value; },
    receiveSysEx: (timeoutMs = 1000) =>
      makeSysExReceiver(handlers, () => true, timeoutMs, 'Timeout waiting for SysEx response'),
    receiveSysExMatching: (predicate, timeoutMs = 1000) =>
      makeSysExReceiver(handlers, predicate, timeoutMs, 'Timeout waiting for matching SysEx'),
    onMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    hasInput: true,
    isPortOpen: () => true,
    close: () => { handlers.clear(); },
  };
}

/**
 * Open a MIDI input + output pair matching the given needles. Throws
 * with a diagnostic message listing visible ports if no match is found.
 */
export function connect(opts: ConnectOptions): MidiConnection {
  // Mock-transport fallback (agent-regression / no hardware): devices WITHOUT a
  // registered mock factory (Circuit Tracks, VP4, the SPD-SX MIDI surface) reach
  // the generic connect() and would fail with "no port found". Under the mock
  // flag, hand them a generic fire-and-forget mock instead — writes succeed, no
  // SysEx is synthesized (these surfaces are fire-and-forget: CC / NRPN / note
  // sends, .ncs/sample transfers). Devices WITH a factory never reach here in mock
  // mode (their connectXXX short-circuits first). Production (flag unset) is
  // untouched. See MockResponder / mockConnect.
  if (process.env.MCP_MOCK_TRANSPORT === '1') {
    return mockConnect({ responder: () => [] });
  }
  const midi = loadMidi();
  const input = new midi.Input();
  const output = new midi.Output();

  const inputPort = findPortByName(input, opts.needles);
  const outputPort = findPortByName(output, opts.needles);

  if (inputPort === -1 || outputPort === -1) {
    const ins: string[] = [];
    for (let i = 0; i < input.getPortCount(); i++) ins.push(`  [${i}] ${input.getPortName(i)}`);
    const outs: string[] = [];
    for (let i = 0; i < output.getPortCount(); i++) outs.push(`  [${i}] ${output.getPortName(i)}`);
    // Nothing was opened, but dispose the RtMidi objects rather than leaving
    // them for GC: a "device not found" throw is a normal, repeatable path
    // (every retry loop hits it) and it should not accumulate native state.
    releaseNativeHandles(input, output);
    throw buildNotFoundError(opts.needles, ins, outs, opts.notFoundLeadIn, opts.notFoundHints ?? []);
  }

  const handlers = new Set<(bytes: number[]) => void>();
  const dispatch = (bytes: number[]): void => {
    for (const h of handlers) h(bytes);
  };
  const assemble = createSysExAssembler(dispatch);
  input.on('message', (_dt: number, bytes: number[]) => {
    assemble(bytes);
  });

  input.openPort(inputPort);
  output.openPort(outputPort);

  // Enable SysEx (false = don't ignore SysEx); ignore timing + active-sensing.
  // MUST come AFTER openPort: @julusian/midi resets the ignore-flags to their
  // defaults (SysEx ignored) when the port opens, so calling this earlier is
  // silently wiped and every inbound SysEx reply is dropped. node-midi tolerated
  // the earlier call; @julusian does not.
  input.ignoreTypes(false, true, true);

  // openPort() does NOT throw on failure: RtMidi prints the error to
  // stderr ("MidiInWinMM::openPort: error creating Windows MM MIDI
  // input port.") and leaves the port closed, after which every send
  // goes nowhere and every read times out while the tool layer reports
  // fire-and-forget success (2026-06-10 incident: 169 writes into a
  // dead port returned ok:true). isPortOpen() is the native truth —
  // assert it and fail LOUDLY with the exclusive-hold diagnosis.
  if (!input.isPortOpen() || !output.isPortOpen()) {
    const failedSide = !input.isPortOpen()
      ? (!output.isPortOpen() ? 'input + output ports' : 'input port')
      : 'output port';
    releaseNativeHandles(input, output);
    throw new Error(
      `MIDI ${failedSide} found but could NOT be opened (the OS refused the open). ` +
      'Windows MIDI ports are exclusive: another process is almost certainly holding the port. ' +
      'Common holders: a second MCP server instance (another Claude Code or Claude Desktop ' +
      'session with this server configured), a stale node process from an earlier session ' +
      '(check Task Manager for leftover node.exe), or a manufacturer editor (AxeEdit / ' +
      'AM4-Edit / FM-Edit / Fractal-Bot). Close the holder, then retry or call reconnect_midi. ' +
      'If this error REPEATS right after a reconnect_midi on a quiet bus, the holder may be THIS ' +
      "server's own previous handle (the Windows driver does not always release a handle that " +
      'died mid-send): restarting the server process is the reliable recovery — fully quit the ' +
      'host app (Claude Desktop: system tray, Quit) and relaunch.',
    );
  }

  // Track send errors on a separate cell so the `send` arrow can read /
  // write without TS forward-reference issues; the conn object exposes
  // the cell via a getter so callers see live state.
  const sendErrCell: { value?: Error } = {};
  // R2 stretch goal: wall-clock the synchronous native send. A slow-but-
  // completed send sets neither lastSendError nor changes isPortOpen(), so
  // without this it is invisible to every existing health signal. We can
  // only OBSERVE it after return (a genuinely blocked send never returns at
  // all, see MidiConnection.slowSendSuspect): logged once, one-way latch
  // (cleared only by a fresh reconnect, i.e. a new closure), read by
  // isHandleHealthy on the NEXT acquire.
  const slowSendCell: { value: boolean } = { value: false };
  let closed = false;
  const send = (bytes: number[]): void => {
    const startedAt = Date.now();
    try {
      output.sendMessage(bytes);
      sendErrCell.value = undefined;
    } catch (err) {
      sendErrCell.value = err instanceof Error ? err : new Error(String(err));
      throw sendErrCell.value;
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > SLOW_SEND_THRESHOLD_MS) {
        slowSendCell.value = true;
        console.error(
          `[midi] slow send: ${elapsedMs}ms (threshold ${SLOW_SEND_THRESHOLD_MS}ms); the handle is marked ` +
          'suspect for the next health check. This does NOT abort the current operation; it only biases the ' +
          'NEXT ensureConnection acquire toward a precautionary reconnect.',
        );
      }
    }
  };
  const conn: MidiConnection = {
    send,
    get lastSendError(): Error | undefined { return sendErrCell.value; },
    get slowSendSuspect(): boolean { return slowSendCell.value; },
    // The connect() copy of the receivers is the live process-kill
    // exposure the helper's pre-observe catch closes: send() CAN throw
    // synchronously here (output.sendMessage on a dead handle) after a
    // receiver was registered.
    receiveSysEx: (timeoutMs = 1000) =>
      makeSysExReceiver(handlers, () => true, timeoutMs, 'Timeout waiting for SysEx response'),
    receiveSysExMatching: (predicate, timeoutMs = 1000) =>
      makeSysExReceiver(handlers, predicate, timeoutMs, 'Timeout waiting for matching SysEx'),
    onMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    hasInput: true,
    isPortOpen: () => {
      try { return input.isPortOpen() && output.isPortOpen(); } catch { return false; }
    },
    close: () => {
      // Idempotent: callers double-close routinely (a script's own teardown
      // plus closeAllMidiConnections, or ensureConnection's stale-handle path
      // plus the process-exit hook). A second native close on an input that
      // already threw is a double-free, so the guard is a correctness
      // requirement, not just tidiness.
      if (closed) return;
      closed = true;
      liveConnections.delete(conn);
      handlers.clear();
      releaseNativeHandles(input, output);
    },
  };
  // Registered LAST so the entry always refers to a fully-built connection.
  liveConnections.add(conn);
  return conn;
}

/**
 * A `MidiConnection` for devices that have no MIDI pipe in their current
 * transport mode — storage-transport devices (SPD-SX in WAVE MGR mode).
 * Every I/O method throws with a clear, device-named message. Storage
 * reader/writer methods read `ctx.storage.root` and never call these, so the
 * throw only fires if a method is miswired to use the wire on a storage device
 * — i.e. it's a loud guardrail, not a code path taken in normal operation.
 *
 * Lets `DispatchCtx.conn` stay required (no churn across the ~156 existing
 * `ctx.conn` sites in MIDI devices) while still modeling endpoints that aren't
 * MIDI at all.
 */
export function createNullMidiConnection(deviceName: string, reason?: string): MidiConnection {
  const why = reason
    ?? `${deviceName} is on a storage transport (no MIDI connection in this mode). ` +
       'This operation tried to use the MIDI wire on a device that talks over a ' +
       'mounted drive — use the storage path (ctx.storage.root) instead.';
  const fail = (): never => {
    throw new Error(why);
  };
  return {
    send: fail,
    lastSendError: undefined,
    receiveSysEx: () => Promise.reject(new Error(why)),
    receiveSysExMatching: () => Promise.reject(new Error(why)),
    onMessage: () => () => { /* no inbound: this connection has no wire */ },
    hasInput: false,
    isPortOpen: () => false,
    close: () => { /* nothing to close */ },
  };
}

export function toHex(bytes: number[] | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? Array.from(bytes) : bytes;
  return arr.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
