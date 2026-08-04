/**
 * Serial (USB-CDC) MIDI transport — for Fractal devices whose USB control
 * channel is a serial device, not a MIDI-class interface.
 *
 * Today that is exactly one device: the **FM3**. It exposes no USB-MIDI
 * interface on ANY OS (Fractal's own docs: "the FM3 is not a USB MIDI
 * device") — its control channel enumerates as:
 *   - Windows: "FM3 Communications Port" COM port (requires Fractal's
 *     FM3 USB **Serial** Driver, separate from the audio driver)
 *   - macOS:   /dev/cu.usbmodem* (built-in CDC-ACM, no driver)
 *   - Linux:   /dev/ttyACM* (cdc_acm)
 * The byte stream on that port is raw MIDI (SysEx frames verbatim) at a
 * nominal 115200 baud — CDC-ACM ignores the baud setting, we set it anyway.
 * HARDWARE-CONFIRMED end to end (FM3 fw 12.00, macOS Apple Silicon,
 * 2026-06-12 community field test): discovery by Fractal VID, open, framing
 * (zero malformed frames across broadcast bursts), and the full read+write
 * probe session ran over THIS implementation. macOS lists the /dev/tty.*
 * node; we prefer the /dev/cu.* callout twin when present (tty.* can block
 * on carrier-detect on some setups). The LINUX leg is separately
 * HARDWARE-CONFIRMED (FM3 fw 12.0, 2026-06-27, ForgeFX — an independent app
 * built on this codec): discovery by Fractal VID at the `/dev/serial/by-id/`
 * path, open, and a full read+write session over raw USB-serial, matching
 * the discovery-by-vendor-id path this module already implements.
 *
 * ## Deferred open
 *
 * The connection-registry contract (`registerConnector`) is SYNCHRONOUS, but
 * serialport discovery + open are async. `connectSerial` therefore returns a
 * facade immediately: outbound `send()`s queue until the port opens (order
 * preserved), and a discovery/open failure is surfaced on the first wire
 * interaction — queued waiters reject with the full diagnostic, and any later
 * `send()` throws it. In practice the open (~tens of ms) completes well inside
 * the first tool's ack window, so tools behave as with the sync transport.
 *
 * The CDC port is EXCLUSIVE-open (a real OS-level lock, unlike WinMM's silent
 * failure): if FM3-Edit or Fractal-Bot has the port, our open errors loudly
 * and we say exactly that.
 *
 * KNOWN LIMITATIONS (community-beta, accepted consciously — revisit before
 * promoting to verified):
 * 1. In-flight-open false-accept window: a send() issued BEFORE the async
 *    open settles queues and returns; if the open then FAILS, the queued
 *    bytes are dropped (lastSendError is set, queued waiters reject with the
 *    diagnostic, but a fire-and-forget caller that already returned ok has
 *    lied once). Window is the open latency (~tens of ms) on the FIRST tool
 *    call only.
 * 2. A failed-open facade stays cached in the connection registry until
 *    reconnect_midi forces a fresh connect — every error message therefore
 *    names reconnect_midi as the recovery step. There is no automatic
 *    re-discovery on later tool calls.
 *
 * `serialport` is imported dynamically so merely loading this module (or the
 * core transport barrel) never loads the native binding — environments
 * without it stay healthy until a serial connect is actually attempted.
 */
import fs from 'node:fs';
import type { MidiConnection } from './transport.js';
import { createSerialMidiFramer } from './serialFraming.js';

/** Fractal Audio Systems USB vendor id (usb.ids registry: 2466). */
export const FRACTAL_USB_VENDOR_ID = '2466';

export interface SerialPortInfoLike {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  pnpId?: string;
  friendlyName?: string;
}

export interface SerialCandidate extends SerialPortInfoLike {
  /** Why this port matched (vendor id / name); undefined when unmatched. */
  matchReason?: string;
}

/**
 * Decide whether an OS serial port looks like a Fractal CDC control channel.
 * Conservative on purpose: we only auto-pick ports carrying Fractal metadata
 * (vendor id 0x2466, or an FM3/Fractal-named driver entry). A bare
 * /dev/cu.usbmodem* with no metadata could be any CDC gadget — those require
 * the explicit-path escape hatch rather than a guess.
 */
export function matchFractalSerialPort(info: SerialPortInfoLike): string | undefined {
  if (info.vendorId?.toLowerCase() === FRACTAL_USB_VENDOR_ID) {
    return 'Fractal USB vendor id (0x2466)';
  }
  const names = [info.friendlyName, info.manufacturer, info.pnpId]
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.toLowerCase());
  if (names.some((n) => n.includes('fractal'))) return 'Fractal-named device';
  if (names.some((n) => /fm.?3/.test(n))) return 'FM3-named serial port';
  return undefined;
}

/**
 * Enumerate OS serial ports, tagging Fractal-looking candidates. Used by the
 * `list_midi_ports` diagnostic surface and by `connectSerial` discovery.
 * Returns [] (never throws) when the serialport module is unavailable.
 */
export async function listSerialCandidates(): Promise<SerialCandidate[]> {
  let list: SerialPortInfoLike[];
  try {
    const { SerialPort } = await import('serialport');
    list = (await SerialPort.list()) as SerialPortInfoLike[];
  } catch {
    return [];
  }
  return list.map((p) => ({ ...p, matchReason: matchFractalSerialPort(p) }));
}

export interface SerialConnectOptions {
  /**
   * Skip discovery and open exactly this OS path (e.g. "COM5",
   * "/dev/cu.usbmodem14201"). Escape hatch for ports that enumerate without
   * Fractal metadata; device connectors usually feed an env var through here.
   */
  explicitPath?: string;
  /** Nominal baud (CDC-ACM ignores it). Default 115200 — the FM3 figure. */
  baudRate?: number;
  /** First line of the discovery-failure diagnostic. */
  notFoundLeadIn?: string;
  /** Device-specific hints appended to the discovery-failure diagnostic. */
  notFoundHints?: readonly string[];
  /**
   * Sink for the one-line "connected via serial <path>" notice emitted after a
   * successful open, so field reports are self-documenting about which port
   * (and which match rule) carried the session. Default: console.error (safe
   * for MCP stdio servers — stderr goes to the host's log, not the protocol).
   */
  log?: (line: string) => void;
}

interface SerialPortLike {
  isOpen: boolean;
  write(data: Buffer, cb?: (err?: Error | null) => void): unknown;
  open(cb: (err?: Error | null) => void): void;
  close(cb?: (err?: Error | null) => void): void;
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
}

/**
 * Open a serial MIDI connection (deferred open — see module doc).
 * Satisfies the same `MidiConnection` contract as the node-midi transport,
 * so dispatchers, writers, and readers are transport-blind.
 */
export function connectSerial(opts: SerialConnectOptions = {}): MidiConnection {
  const baudRate = opts.baudRate ?? 115200;

  const handlers = new Set<(bytes: number[]) => void>();
  const dispatch = (bytes: number[]): void => {
    const snapshot = Array.from(handlers);
    for (const h of snapshot) h(bytes);
  };
  const frame = createSerialMidiFramer(dispatch);

  let port: SerialPortLike | undefined;
  let opened = false;
  let closed = false;
  let openError: Error | undefined;
  const sendQueue: number[][] = [];
  const sendErrCell: { value?: Error } = {};
  // Waiters registered before the open settles; rejected with the full
  // diagnostic if discovery/open fails (instead of a vague timeout).
  const openFailureRejecters = new Set<(err: Error) => void>();

  const failOpen = (err: Error): void => {
    openError = err;
    // Queued sends are discarded — record that loudly so writers polling
    // lastSendError after a fire-and-forget send (the node-midi contract)
    // see the failure instead of silence-means-accepted.
    if (sendQueue.length > 0) sendErrCell.value = err;
    sendQueue.length = 0;
    const snapshot = Array.from(openFailureRejecters);
    openFailureRejecters.clear();
    for (const reject of snapshot) reject(err);
  };

  const buildNotFound = (candidates: SerialCandidate[], detail?: string): Error => {
    const lines: string[] = [
      opts.notFoundLeadIn ?? 'No Fractal serial (USB-CDC) port found.',
      ...(opts.notFoundHints ?? []),
    ];
    if (detail) lines.push(detail);
    if (candidates.length === 0) {
      lines.push('No serial ports of any kind are visible to the OS.');
    } else {
      lines.push('Serial ports the server can see (none matched):');
      for (const c of candidates) {
        const meta = [c.friendlyName ?? c.manufacturer, c.vendorId && `vid ${c.vendorId}`]
          .filter(Boolean)
          .join(', ');
        lines.push(`  ${c.path}${meta ? `  (${meta})` : ''}`);
      }
    }
    return new Error(lines.join('\n'));
  };

  const writeNow = (bytes: number[]): void => {
    sendErrCell.value = undefined;
    port?.write(Buffer.from(bytes), (err) => {
      if (err) sendErrCell.value = err;
    });
  };

  const RECOVERY_HINT =
    'After fixing the cause, call reconnect_midi (the failed connection stays ' +
    'cached until a forced reconnect).';

  void (async () => {
    let SerialPortCtor: typeof import('serialport').SerialPort;
    try {
      ({ SerialPort: SerialPortCtor } = await import('serialport'));
    } catch (err) {
      // Module-load failure is an INSTALL problem, not a port problem —
      // never blame FM3-Edit / drivers for it.
      const cause = err instanceof Error ? err.message : String(err);
      failOpen(new Error(
        `The serial transport module ("serialport") failed to load: ${cause}\n` +
        'This is an installation problem (missing or broken native binding), not a ' +
        'device problem. Reinstall the server (re-run setup), then retry. ' + RECOVERY_HINT,
      ));
      return;
    }
    try {
      const SerialPort = SerialPortCtor;
      let path = opts.explicitPath;
      let matchNote = 'explicit path';
      if (!path) {
        const candidates = await listSerialCandidates();
        const hit = candidates.find((c) => c.matchReason !== undefined);
        if (!hit) {
          failOpen(buildNotFound(candidates));
          return;
        }
        path = hit.path;
        matchNote = `matched: ${hit.matchReason}`;
        // macOS lists the /dev/tty.* node, but tty.* can block on
        // carrier-detect on some setups; the /dev/cu.* callout twin is the
        // conventional macOS choice. Prefer it when it exists (field report,
        // FM3 over USB-CDC, 2026-06-12).
        if (path.startsWith('/dev/tty.')) {
          const cuTwin = `/dev/cu.${path.slice('/dev/tty.'.length)}`;
          if (candidates.some((c) => c.path === cuTwin) || fs.existsSync(cuTwin)) {
            path = cuTwin;
            matchNote += '; preferred cu.* callout twin over tty.*';
          }
        }
      }
      if (closed) return;
      const sp = new SerialPort({ path, baudRate, autoOpen: false }) as unknown as SerialPortLike;
      sp.on('data', (chunk: Buffer) => frame(chunk));
      sp.on('error', (err: Error) => {
        sendErrCell.value = err;
      });
      await new Promise<void>((resolve, reject) => {
        sp.open((err) => (err ? reject(err) : resolve()));
      });
      if (closed) {
        sp.close();
        return;
      }
      port = sp;
      opened = true;
      // One-line connect notice so field reports are self-documenting.
      (opts.log ?? console.error)(`connected via serial ${path} (${matchNote})`);
      openFailureRejecters.clear(); // can no longer fire; release the refs
      // Flush sends queued while the open was in flight, in order.
      for (const bytes of sendQueue.splice(0)) writeNow(bytes);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      failOpen(new Error(
        `Serial port found but could NOT be opened: ${cause}\n` +
        'The CDC control channel is EXCLUSIVE: if FM3-Edit or Fractal-Bot is ' +
        'running (even minimized), it holds the port — fully quit it. On Windows ' +
        'the FM3 also needs Fractal\'s "FM3 USB Serial Driver" (separate from the ' +
        `audio driver). ${RECOVERY_HINT}`,
      ));
    }
  })();

  const send = (bytes: number[]): void => {
    if (openError) throw openError;
    if (!opened) {
      sendQueue.push([...bytes]);
      return;
    }
    if (!port || port.isOpen === false) {
      // Unplug / driver death after a successful open: the serialport
      // 'error'/'close' path flips isOpen. Mirror the node-midi contract
      // (send throws loudly, lastSendError set) instead of writing into
      // a dead stream and reporting silence-means-accepted.
      const err = sendErrCell.value
        ?? new Error('Serial port is no longer open (device unplugged or driver reset). Call reconnect_midi.');
      sendErrCell.value = err;
      throw err;
    }
    writeNow(bytes);
  };

  const makeReceiver = (
    predicate: (bytes: number[]) => boolean,
    timeoutMs: number,
    timeoutLabel: string,
  ): Promise<number[]> => {
    const p = new Promise<number[]>((resolve, reject) => {
      if (openError) {
        reject(openError);
        return;
      }
      const timer = setTimeout(() => {
        handlers.delete(handler);
        openFailureRejecters.delete(onOpenFailure);
        reject(new Error(`${timeoutLabel} after ${timeoutMs}ms`));
      }, timeoutMs);
      const onOpenFailure = (err: Error): void => {
        clearTimeout(timer);
        handlers.delete(handler);
        reject(err);
      };
      const handler = (bytes: number[]): void => {
        if (bytes[0] !== 0xf0) return;
        if (!predicate(bytes)) return;
        clearTimeout(timer);
        handlers.delete(handler);
        openFailureRejecters.delete(onOpenFailure);
        resolve(bytes);
      };
      handlers.add(handler);
      if (!opened) openFailureRejecters.add(onOpenFailure);
    });
    // Pre-observe the rejection. Callers that register a receiver FIRST and
    // send() SECOND (the standard register-before-write pattern) abandon
    // this promise when send() throws synchronously — without this no-op
    // handler, that abandoned rejection is an unhandledRejection and Node
    // KILLS THE WHOLE SERVER PROCESS. Awaiting callers still receive the
    // rejection normally.
    p.catch(() => { /* observed; real handling happens at the await site */ });
    return p;
  };

  return {
    send,
    get lastSendError(): Error | undefined { return sendErrCell.value; },
    receiveSysEx: (timeoutMs = 1000) =>
      makeReceiver(() => true, timeoutMs, 'Timeout waiting for SysEx response'),
    receiveSysExMatching: (predicate, timeoutMs = 1000) =>
      makeReceiver(predicate, timeoutMs, 'Timeout waiting for matching SysEx'),
    onMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    hasInput: true,
    // Deferred-open facade: undefined `port` = not opened yet (not dead → true);
    // an opened port that flipped isOpen=false (unplug/driver reset) → false.
    isPortOpen: () => !closed && (port ? port.isOpen !== false : true),
    close: () => {
      closed = true;
      handlers.clear();
      openFailureRejecters.clear();
      if (port) {
        try { port.close(); } catch { /* best-effort */ }
      }
      port = undefined;
      opened = false;
    },
  };
}
