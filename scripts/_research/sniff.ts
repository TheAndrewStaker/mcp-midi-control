/**
 * mcp-midi-control — MIDI Proxy Sniffer
 *
 * Sits in between AM4-Edit and the real AM4, forwarding SysEx both ways
 * and logging every message with direction, timestamp, and annotation.
 *
 * Prereq: loopMIDI (https://www.tobias-erichsen.de/software/loopmidi.html).
 * Create a single virtual port named "AM4 Sniff Bus" (or similar — any port
 * name containing "sniff" or "loop" will be auto-detected).
 *
 * Wiring (no configuration required in this script):
 *   AM4-Edit     ⇆  "AM4 Sniff Bus" (virtual)  ⇆  this script  ⇆  "AM4 MIDI In/Out" (real)
 *
 * In AM4-Edit: change MIDI In AND MIDI Out from the real AM4 ports to
 * "AM4 Sniff Bus". AM4-Edit now thinks the virtual port is the device.
 *
 * Usage:
 *   npm run sniff
 *
 * Output:
 *   samples/captured/session-<ISO-timestamp>.log
 *   Console also tails the same lines.
 *
 * Press Ctrl+C to stop; the log is flushed on exit.
 */

import midi from 'midi';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(__dirname, '..', 'samples', 'captured');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const sessionFile = path.join(SESSION_DIR, `session-${timestamp}.log`);

fs.mkdirSync(SESSION_DIR, { recursive: true });
const logStream = fs.createWriteStream(sessionFile, { flags: 'a' });

function log(line: string): void {
  console.log(line);
  logStream.write(line + '\n');
}

function toHex(bytes: number[]): string {
  return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function parseAscii(bytes: number[]): string {
  return bytes
    .filter(b => b >= 0x20 && b < 0x7F)
    .map(b => String.fromCharCode(b))
    .join('');
}

// Axe-Fx III / AM4 3rd-party function ID map (see docs/devices/am4/SYSEX-MAP.md).
// `0x01` is the internal editor-session stream used by AM4-Edit and is NOT
// in the public spec — included here for decoding AM4-Edit traffic.
const FN_NAMES: Record<number, string> = {
  0x01: 'EDITOR_STREAM (undocumented)',
  0x08: 'GET_FIRMWARE_VERSION',
  0x0A: 'SET/GET_BYPASS',
  0x0B: 'SET/GET_CHANNEL',
  0x0C: 'SET/GET_SCENE',
  0x0D: 'QUERY_PATCH_NAME',
  0x0E: 'QUERY_SCENE_NAME',
  0x0F: 'SET/GET_LOOPER_STATE',
  0x10: 'TEMPO_TAP / MIDI_TEMPO',
  0x11: 'TUNER_ON_OFF / MIDI_TUNE',
  0x12: 'MODE_SWITCH',
  0x13: 'STATUS_DUMP',
  0x14: 'SET/GET_TEMPO',
  0x64: 'MULTIPURPOSE_RESPONSE',
};

const MODEL_NAMES: Record<number, string> = {
  0x03: 'Axe-Fx II',
  0x08: 'AX8',
  0x10: 'Axe-Fx III',
  0x11: 'FM3',
  0x12: 'FM9',
  0x14: 'VP4',
  0x15: 'AM4',
};

// Axe-Fx III effect enum values for block IDs seen in messages.
// Partial list — AM4 extends with AMP at 206.
const BLOCK_NAMES: Record<number, string> = {
  2: 'CONTROL', 35: 'TUNER', 36: 'IRCAPTURE',
  37: 'INPUT1', 38: 'INPUT2', 39: 'INPUT3', 40: 'INPUT4', 41: 'INPUT5',
  42: 'OUTPUT1', 43: 'OUTPUT2', 44: 'OUTPUT3', 45: 'OUTPUT4',
  46: 'COMP1', 50: 'GRAPHEQ1', 54: 'PARAEQ1',
  58: 'DISTORT1', 59: 'DISTORT2', 60: 'DISTORT3', 61: 'DISTORT4',
  62: 'CAB1', 66: 'REVERB1', 70: 'DELAY1',
  78: 'CHORUS1', 82: 'FLANGER1', 86: 'ROTARY1', 90: 'PHASER1', 94: 'WAH1',
  102: 'VOLUME1', 106: 'TREMOLO1', 110: 'PITCH1', 114: 'FILTER1',
  118: 'FUZZ1', 122: 'ENHANCER1', 146: 'GATE1',
  206: 'AMP (AM4 extension)',
};

function annotate(bytes: number[]): string {
  if (bytes[0] !== 0xF0) return '(not SysEx)';
  if (bytes.length < 7) return '(too short)';
  const isFractal = bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x74;
  if (!isFractal) return `(manufacturer ${bytes[1].toString(16)}-${bytes[2].toString(16)}-${bytes[3].toString(16)}, not Fractal)`;
  const model = MODEL_NAMES[bytes[4]] ?? `model 0x${bytes[4].toString(16)}`;
  const fn = FN_NAMES[bytes[5]] ?? `fn 0x${bytes[5].toString(16).padStart(2, '0')}`;
  let extra = '';
  // For editor stream and common commands, byte 6-7 is the 14-bit block ID.
  if (bytes.length >= 9 && (bytes[5] === 0x01 || bytes[5] === 0x0A || bytes[5] === 0x0B)) {
    const blockId = (bytes[6] & 0x7F) | ((bytes[7] & 0x7F) << 7);
    const blockName = BLOCK_NAMES[blockId] ?? `block ${blockId}`;
    extra = ` | ${blockName}`;
  }
  return `${model} | ${fn}${extra} | ${bytes.length}B payload ${bytes.length - 8}B`;
}

function findPort<T extends { getPortCount(): number; getPortName(i: number): string }>(
  io: T,
  matchers: RegExp[],
): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    const name = io.getPortName(i);
    for (const re of matchers) {
      if (re.test(name)) return i;
    }
  }
  return -1;
}

function listPorts(): void {
  const tmpIn = new midi.Input();
  const tmpOut = new midi.Output();
  log('Available MIDI inputs:');
  for (let i = 0; i < tmpIn.getPortCount(); i++) log(`  [in ${i}]  ${tmpIn.getPortName(i)}`);
  log('Available MIDI outputs:');
  for (let i = 0; i < tmpOut.getPortCount(); i++) log(`  [out ${i}] ${tmpOut.getPortName(i)}`);
  tmpIn.closePort();
  tmpOut.closePort();
}

async function main(): Promise<void> {
  log(`=== AM4 SNIFF PROXY SESSION ${new Date().toISOString()} ===`);
  log(`Log file: ${sessionFile}`);
  log('');
  listPorts();
  log('');

  // Port layout:
  //   editorIn   listens on the virtual bus for AM4-Edit's outgoing commands
  //   editorOut  sends device responses back to AM4-Edit (same virtual bus)
  //   deviceIn   listens on the real AM4 MIDI In for its responses
  //   deviceOut  sends AM4-Edit's commands onward to the real AM4 MIDI Out
  const editorIn = new midi.Input();
  const editorOut = new midi.Output();
  const deviceIn = new midi.Input();
  const deviceOut = new midi.Output();

  // Real AM4 ports are named "AM4 MIDI In" / "AM4 MIDI Out" — match on that
  // exact substring so a virtual bus called "AM4 Sniff Bus" doesn't get
  // mistaken for the real device.
  const virtualMatchers = [/sniff/i, /loop/i, /virtual/i, /\bbus\b/i, /proxy/i];
  const am4Matchers = [/AM4 MIDI/i, /fractal/i];

  const editorInPort = findPort(editorIn, virtualMatchers);
  const editorOutPort = findPort(editorOut, virtualMatchers);
  const deviceInPort = findPort(deviceIn, am4Matchers);
  const deviceOutPort = findPort(deviceOut, am4Matchers);

  if (editorInPort === -1 || editorOutPort === -1) {
    log('❌ Could not find a virtual MIDI port. Install loopMIDI and create');
    log('   a port named "AM4 Sniff Bus" (or anything with "sniff"/"loop"/');
    log('   "virtual"/"bus" in the name), then re-run.');
    process.exit(1);
  }
  if (deviceInPort === -1 || deviceOutPort === -1) {
    log('❌ Could not find the AM4 MIDI ports. Is the AM4 connected and');
    log('   powered on? Is any other app (e.g. AM4-Edit) holding the ports?');
    process.exit(1);
  }

  log(`Editor-side (virtual bus):  in[${editorInPort}] "${editorIn.getPortName(editorInPort)}"  out[${editorOutPort}] "${editorOut.getPortName(editorOutPort)}"`);
  log(`Device-side (real AM4):     in[${deviceInPort}] "${deviceIn.getPortName(deviceInPort)}"  out[${deviceOutPort}] "${deviceOut.getPortName(deviceOutPort)}"`);
  log('');

  // SysEx passthrough must be enabled on both inputs.
  editorIn.ignoreTypes(false, true, true);
  deviceIn.ignoreTypes(false, true, true);

  let count = 0;
  const logMessage = (dir: 'EDITOR→DEVICE' | 'DEVICE→EDITOR', bytes: number[]): void => {
    count++;
    const ts = new Date().toISOString();
    log('');
    log(`[${count}] ${ts}  ${dir}`);
    log(`  HEX: ${toHex(bytes)}`);
    log(`  LEN: ${bytes.length}B`);
    log(`  ANN: ${annotate(bytes)}`);
    if (bytes[0] === 0xF0 && bytes.length > 8) {
      const ascii = parseAscii(bytes.slice(6, -2));
      if (ascii.length >= 3) log(`  STR: "${ascii}"`);
    }
  };

  editorIn.on('message', (_dt, message) => {
    logMessage('EDITOR→DEVICE', message);
    deviceOut.sendMessage(message);
  });
  deviceIn.on('message', (_dt, message) => {
    logMessage('DEVICE→EDITOR', message);
    editorOut.sendMessage(message);
  });

  editorIn.openPort(editorInPort);
  editorOut.openPort(editorOutPort);
  deviceIn.openPort(deviceInPort);
  deviceOut.openPort(deviceOutPort);

  log('✅ Proxy active. Open AM4-Edit; set its MIDI In/Out to the virtual bus.');
  log('   All SysEx is logged. Press Ctrl+C to stop.');
  log('─'.repeat(60));

  process.on('SIGINT', () => {
    log('');
    log(`=== SESSION END — ${count} messages ===`);
    log(`Saved: ${sessionFile}`);
    editorIn.closePort();
    editorOut.closePort();
    deviceIn.closePort();
    deviceOut.closePort();
    logStream.end(() => process.exit(0));
  });

  // Park until SIGINT.
  await new Promise(() => {});
}

main().catch(err => {
  log(`FATAL: ${err?.stack ?? err}`);
  process.exit(1);
});
