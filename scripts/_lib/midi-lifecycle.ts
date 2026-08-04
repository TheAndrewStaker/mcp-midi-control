/**
 * MIDI connection lifecycle for the device scripts under `scripts/`.
 *
 * ## The bug this exists to prevent
 *
 * `@julusian/midi` creates a `Napi::TypedThreadSafeFunction` when an Input port
 * is opened, and a live thread-safe function holds a ref on the libuv event
 * loop. A script that opens a connection, does its work, and falls off the end
 * of the module body therefore NEVER EXITS: it sits idle forever while still
 * holding the device's exclusive OS MIDI port. On 2026-07-26 twelve such zombie
 * node processes accumulated in one evening and wedged a Circuit Tracks: every
 * later read came back `ok=false crcOk=false` until they were killed by hand.
 *
 * It is also why piping one of these scripts through `tail` swallowed the whole
 * run: `tail` buffers until EOF, and a process that never exits never sends one.
 *
 * The ref is invisible to `process.getActiveResourcesInfo()` and
 * `process._getActiveHandles()`, which both report an empty list while the loop
 * is pinned, so "nothing is holding the loop" is not a conclusion those APIs
 * support. Full write-up in `packages/core/src/midi/transport.ts`.
 *
 * ## The three rules
 *
 * 1. End a wire-touching script with `endMidiScript()` as its LAST statement,
 *    not `process.exit(0)`. It releases every open port and lets the loop drain
 *    on its own, so a pipe reader gets its EOF from the process finishing
 *    normally rather than from a forced teardown.
 * 2. For a mid-flow stop (dry run finished, nothing to do, fail-stop) use
 *    `exitMidiScript(code)`. It returns `never`, so TypeScript keeps treating
 *    the branch as terminating exactly like the `process.exit()` it replaces.
 *    Do NOT use `endMidiScript()` there: it returns, and execution would fall
 *    through into the apply path.
 * 3. Swap connections with `reconnectMidi()`, never by reassigning over a live
 *    one. Windows MIDI ports are exclusive, so the previous handle has to be
 *    released before the new open. Otherwise each reconnect both leaks a
 *    loop-pinning ref AND competes with itself for the port.
 *
 * On stdout truncation: `process.exit()` is often blamed for eating buffered
 * output, but Node writes to a PIPE synchronously on Windows and Linux, and
 * 3 x 5,000 lines through a pipe arrived complete under `process.exit(0)` on
 * this stack (Node 24, win32). It IS asynchronous for a pipe on macOS, so
 * `exitMidiScript` still asks for a blocking handle before exiting. The reason
 * `tail` swallowed these runs was not truncation. It was the process never
 * exiting, so `tail` never saw EOF and never printed its buffer.
 */
import {
  closeAllMidiConnections,
  connect,
  type ConnectOptions,
  type MidiConnection,
} from '../../packages/core/src/midi/transport.js';

// Re-exported so a script needing a mid-run release (e.g. closing the port as
// soon as the bytes are in hand, before a long analysis phase) has one import.
export { closeAllMidiConnections };

/**
 * Release the previous connection, then open a fresh one.
 *
 * This is the body every device script's `reconnect` callback wants. The
 * Circuit reboots its USB stack after a project/sample upload, so `reconnect`
 * fires on essentially every write: a batch over 64 slots reassigning over a
 * live `conn` leaked 64 open port pairs inside a single process.
 *
 * Closing first is not just hygiene: on Windows the port is exclusive, so an
 * un-released handle can make the very reopen this callback exists to perform
 * fail. `close()` is fault-isolated and never throws, including on a handle
 * that was poisoned mid-transfer.
 */
export function reconnectMidi(previous: MidiConnection, opts: ConnectOptions): MidiConnection {
  previous.close();
  return connect(opts);
}

/**
 * Normal end-of-script teardown: close every MIDI port this process opened and
 * let the event loop drain.
 *
 * Sets `process.exitCode` rather than calling `process.exit()`, so the process
 * ends by running out of work instead of being torn down. Once the ports are
 * closed nothing pins the loop, so it exits on its own.
 *
 * RETURNS. It does not terminate, so it is only valid as the last statement of a
 * script. For an early stop use `exitMidiScript`.
 */
export function endMidiScript(exitCode = 0): void {
  closeAllMidiConnections();
  if (exitCode !== 0) process.exitCode = exitCode;
}

/**
 * Mid-flow stop: release every MIDI port, then terminate immediately.
 *
 * The `never` return type is the point. These call sites replace a
 * `process.exit(n)` that TypeScript knew was terminating; anything that returns
 * `void` would silently let the code below it run on, which for these scripts
 * means a dry run falling through into the apply path.
 */
export function exitMidiScript(exitCode = 0): never {
  closeAllMidiConnections();
  // Only matters on macOS, where stdout to a pipe is asynchronous and an exit
  // can outrun a queued write. Best-effort: `_handle` is undefined when stdout
  // is already synchronous (Windows/Linux pipes, any file) and on a destroyed
  // stream, in which case there is nothing to do.
  for (const stream of [process.stdout, process.stderr]) {
    const handle = (stream as unknown as { _handle?: { setBlocking?: (blocking: boolean) => void } })._handle;
    try { handle?.setBlocking?.(true); } catch { /* not a settable handle */ }
  }
  process.exit(exitCode);
}
