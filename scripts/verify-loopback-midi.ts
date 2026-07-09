/**
 * Virtual-loopback MIDI receive test (macOS + Linux).
 *
 * The one piece of @julusian/midi validation we can run WITHOUT physical
 * hardware. It catches the regression class that physical-device tests
 * caught only by luck of someone having gear plugged in:
 *
 *   1. The N-API prebuilt binary loads on this platform (the macOS .mcpb /
 *      no-Xcode install hinges on the darwin-arm64/x64 prebuild loading).
 *   2. A SysEx message ROUND-TRIPS through an opened input port — i.e. the
 *      inbound-SysEx receive path works. This is exactly what the
 *      `ignoreTypes`-after-`openPort` ordering protects: @julusian resets
 *      the ignore-flags to their defaults (SysEx ignored) on openPort, so
 *      if `ignoreTypes(false,...)` is called BEFORE openPort the SysEx is
 *      filtered and never arrives. This test opens the port the same way
 *      the device transports do (wire listener -> openPort -> ignoreTypes)
 *      and asserts the SysEx comes back.
 *
 * It also asserts the negative (ignoreTypes BEFORE openPort drops the
 * SysEx) as a soft signal: if that ever starts receiving, @julusian has
 * changed its reset behaviour and the transports' ordering may no longer
 * be load-bearing — worth knowing, but not a hard failure (platform RtMidi
 * backends can differ).
 *
 * WINDOWS: RtMidi's WinMM backend does not support virtual ports
 * (`openVirtualPort` throws), so this test SKIPS on win32 with exit 0. The
 * receive path on Windows is covered by physical-hardware verification and
 * the per-device live-regression suite.
 *
 * Run: `npm run verify-loopback-midi` (wired into the native-matrix CI job).
 */
import { createRequire } from 'node:module';
import process from 'node:process';

const PORT_NAME = 'mcp-loopback-test';
// F0 <non-commercial mfr id 0x7D> 01 02 03 F7 — a harmless test SysEx.
const TEST_SYSEX = [0xf0, 0x7d, 0x01, 0x02, 0x03, 0xf7];
const RECEIVE_WINDOW_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface MidiLib {
  Input: new () => MidiInput;
  Output: new () => MidiOutput;
}
interface MidiInput {
  getPortCount(): number;
  getPortName(i: number): string;
  openPort(i: number): void;
  closePort(): void;
  ignoreTypes(sysex: boolean, timing: boolean, activeSensing: boolean): void;
  on(event: 'message', cb: (deltaTime: number, message: number[]) => void): void;
}
interface MidiOutput {
  openVirtualPort(name: string): void;
  sendMessage(message: number[]): void;
  closePort(): void;
}

function loadMidi(): MidiLib {
  // Same load mechanism as the device transports (createRequire of the
  // N-API addon). If this throws, the prebuilt binary did not load on this
  // platform — the headline thing the macOS install win depends on.
  return createRequire(import.meta.url)('@julusian/midi') as MidiLib;
}

function findPort(input: MidiInput, needle: string): number {
  for (let i = 0; i < input.getPortCount(); i++) {
    if (input.getPortName(i).toLowerCase().includes(needle.toLowerCase())) return i;
  }
  return -1;
}

/**
 * Open `input` on the virtual port and collect inbound messages, ordering
 * `ignoreTypes` relative to `openPort` per `ignoreAfterOpen`. Returns the
 * collected messages after the receive window.
 */
async function roundTrip(
  midi: MidiLib,
  output: MidiOutput,
  ignoreAfterOpen: boolean,
): Promise<number[][]> {
  const input = new midi.Input();
  const received: number[][] = [];
  try {
    const idx = findPort(input, PORT_NAME);
    if (idx < 0) throw new Error(`virtual port "${PORT_NAME}" not visible to the input (ports: ${input.getPortCount()})`);

    // Mirror the device transports exactly: wire the listener BEFORE
    // openPort (so we don't race), and set the SysEx ignore-flags relative
    // to openPort per the variant under test.
    input.on('message', (_dt, msg) => received.push([...msg]));
    if (!ignoreAfterOpen) input.ignoreTypes(false, true, true); // WRONG order (pre-openPort)
    input.openPort(idx);
    if (ignoreAfterOpen) input.ignoreTypes(false, true, true); // CORRECT order (post-openPort)

    await sleep(20); // let the port settle
    output.sendMessage(TEST_SYSEX);
    await sleep(RECEIVE_WINDOW_MS);
    return received;
  } finally {
    try { input.closePort(); } catch { /* best-effort */ }
  }
}

function sameBytes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    console.log('verify-loopback-midi: SKIP on win32 (RtMidi WinMM has no virtual ports). ' +
      'Receive path on Windows is covered by physical-hardware + live-regression.');
    return;
  }

  let midi: MidiLib;
  try {
    midi = loadMidi();
  } catch (err) {
    console.error('verify-loopback-midi: FAIL — @julusian/midi prebuilt did not load on ' +
      `${process.platform}/${process.arch}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // 1) serialport prebuilt loads (FM3 USB-CDC transport). Load-only; no port.
  try {
    const sp = await import('serialport');
    if (!(sp as { SerialPort?: unknown }).SerialPort) throw new Error('no SerialPort export');
    console.log(`verify-loopback-midi: serialport prebuilt loads on ${process.platform}/${process.arch} ✓`);
  } catch (err) {
    console.error(`verify-loopback-midi: FAIL — serialport prebuilt did not load: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Virtual ports need the ALSA sequencer on Linux. Headless CI runners
  // often cannot load snd-seq, so creating the port throws. That is an
  // environment limitation, not a receive-path regression: the prebuilt
  // already loaded (the headline guarantee), and the macOS legs cover the
  // SysEx round-trip. Skip cleanly on Linux rather than hard-fail.
  let output: MidiOutput;
  try {
    output = new midi.Output();
    output.openVirtualPort(PORT_NAME);
  } catch (err) {
    if (process.platform === 'linux') {
      console.log('verify-loopback-midi: SKIP on linux, no ALSA sequencer available to create a ' +
        `virtual port (${err instanceof Error ? err.message : String(err)}). The prebuilt loaded fine; ` +
        'the receive-path round-trip is verified by the macOS legs.');
      return;
    }
    throw err;
  }
  try {
    await sleep(20); // let the virtual source appear in port lists

    // 2) CORRECT order (ignoreTypes AFTER openPort) — SysEx MUST round-trip.
    const good = await roundTrip(midi, output, true);
    const gotSysex = good.some((m) => sameBytes(m, TEST_SYSEX));
    if (!gotSysex) {
      console.error('verify-loopback-midi: FAIL — SysEx did NOT round-trip with ignoreTypes-after-openPort. ' +
        `The receive path is broken on ${process.platform}/${process.arch}. ` +
        `Received ${good.length} message(s): ${JSON.stringify(good)}`);
      process.exit(1);
    }
    console.log(`verify-loopback-midi: SysEx round-trips with ignoreTypes-after-openPort on ${process.platform}/${process.arch} ✓`);

    // 3) WRONG order (ignoreTypes BEFORE openPort) — soft signal. Expected
    //    to DROP the SysEx (proving the ordering invariant has teeth). If it
    //    receives, @julusian no longer resets on openPort — log loudly.
    const bad = await roundTrip(midi, output, false);
    const badGotSysex = bad.some((m) => sameBytes(m, TEST_SYSEX));
    if (badGotSysex) {
      console.warn('verify-loopback-midi: NOTE — SysEx ALSO arrived with ignoreTypes-BEFORE-openPort. ' +
        '@julusian may have stopped resetting ignore-flags on openPort; the transports\' ' +
        'ignoreTypes-after-openPort ordering may no longer be load-bearing. Re-evaluate the fix.');
    } else {
      console.log('verify-loopback-midi: confirmed the ordering invariant has teeth ' +
        '(SysEx dropped when ignoreTypes precedes openPort) ✓');
    }
  } finally {
    try { output.closePort(); } catch { /* best-effort */ }
  }

  console.log('verify-loopback-midi: ok');
}

main().catch((err) => {
  console.error('verify-loopback-midi: FAIL —', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
