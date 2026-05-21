/**
 * mcp-midi-control — Phase 0 Feasibility Probe
 *
 * Run this first. It will:
 * 1. List all MIDI devices
 * 2. Attempt to connect to the AM4
 * 3. Send a mode switch command (visible result on device)
 * 4. Send a firmware version request
 * 5. Log all responses
 *
 * Prerequisites:
 *   - Fractal AM4 USB driver installed
 *   - AM4 powered on and connected via USB
 *   - node-midi installed: npm install midi
 *   - Run: npx ts-node scripts/probe.ts
 */

import midi from 'midi';

// ─── Checksum ───────────────────────────────────────────────────────────────

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7F;
}

function buildMessage(modelId: number, functionId: number, payload: number[] = []): number[] {
  const header = [0xF0, 0x00, 0x01, 0x74, modelId, functionId, ...payload];
  const checksum = fractalChecksum(header);
  return [...header, checksum, 0xF7];
}

const AM4_MODEL_ID = 0x15;

// ─── 14-bit split (block IDs, parameter IDs) ────────────────────────────────

function encode14(n: number): [number, number] {
  return [n & 0x7F, (n >> 7) & 0x7F];
}

// ─── Known Commands ──────────────────────────────────────────────────────────

const COMMANDS = {
  SCENES_MODE:   [0xF0, 0x00, 0x01, 0x74, 0x15, 0x12, 0x49, 0x4B, 0xF7],
  PRESETS_MODE:  [0xF0, 0x00, 0x01, 0x74, 0x15, 0x12, 0x48, 0x4A, 0xF7],
  EFFECTS_MODE:  [0xF0, 0x00, 0x01, 0x74, 0x15, 0x12, 0x4A, 0x48, 0xF7],
  TUNER_MODE:    [0xF0, 0x00, 0x01, 0x74, 0x15, 0x12, 0x18, 0x1A, 0xF7],
  GET_FIRMWARE:     buildMessage(AM4_MODEL_ID, 0x08),
  // Axe-Fx III 3rd-party spec commands (PDF in docs/devices/axe-fx-iii/manuals/). AM4 is
  // expected to follow the III spec since it's in the same product family.
  // Query form: send 0x7F (or 0x7F 0x7F for 14-bit) as the value.
  Q_SCENE:          buildMessage(AM4_MODEL_ID, 0x0C, [0x7F]),
  Q_PATCH_NAME:     buildMessage(AM4_MODEL_ID, 0x0D, [0x7F, 0x7F]),
  Q_SCENE_NAME:     buildMessage(AM4_MODEL_ID, 0x0E, [0x7F]),
  Q_TEMPO:          buildMessage(AM4_MODEL_ID, 0x14, [0x7F, 0x7F]),
  STATUS_DUMP:      buildMessage(AM4_MODEL_ID, 0x13),
};


// ─── Hex formatting ──────────────────────────────────────────────────────────

function toHex(bytes: number[]): string {
  return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function parseAscii(bytes: number[]): string {
  return bytes
    .filter(b => b >= 0x20 && b < 0x7F)
    .map(b => String.fromCharCode(b))
    .join('');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const input = new midi.Input();
  const output = new midi.Output();

  // ── Step 1: List ports ──
  console.log('\n=== MIDI PORTS ===');
  console.log('Inputs:');
  for (let i = 0; i < input.getPortCount(); i++) {
    console.log(`  [${i}] ${input.getPortName(i)}`);
  }
  console.log('Outputs:');
  for (let i = 0; i < output.getPortCount(); i++) {
    console.log(`  [${i}] ${output.getPortName(i)}`);
  }

  // ── Step 2: Find AM4 ──
  let inputPort = -1;
  let outputPort = -1;

  for (let i = 0; i < input.getPortCount(); i++) {
    const name = input.getPortName(i).toLowerCase();
    if (name.includes('am4') || name.includes('fractal')) {
      inputPort = i;
      break;
    }
  }
  for (let i = 0; i < output.getPortCount(); i++) {
    const name = output.getPortName(i).toLowerCase();
    if (name.includes('am4') || name.includes('fractal')) {
      outputPort = i;
      break;
    }
  }

  if (inputPort === -1 || outputPort === -1) {
    console.error('\n❌ AM4 not found in MIDI device list.');
    console.error('   Check: USB driver installed? AM4 powered on?');
    console.error('   Try connecting AM4-Edit first, then close it and re-run.');
    process.exit(1);
  }

  console.log(`\n✅ Found AM4 — input port ${inputPort}, output port ${outputPort}`);

  // ── Step 3: Open ports and listen ──
  const responses: Array<{ time: number; bytes: number[] }> = [];

  input.on('message', (deltaTime: number, message: number[]) => {
    const entry = { time: Date.now(), bytes: message };
    responses.push(entry);
    const isSysEx = message[0] === 0xF0;
    console.log(`\n📥 RECEIVED [${isSysEx ? 'SysEx' : 'MIDI'}]:`);
    console.log(`   HEX:   ${toHex(message)}`);
    if (isSysEx) {
      console.log(`   ASCII: ${parseAscii(message)}`);
      if (message.length > 6) {
        console.log(`   Model: 0x${message[4].toString(16).toUpperCase()}`);
        console.log(`   Func:  0x${message[5].toString(16).toUpperCase()}`);
      }
    }
  });

  // node-midi ignores SysEx by default. Enable it (args: sysex, timing, activeSensing).
  input.ignoreTypes(false, true, true);

  input.openPort(inputPort);
  output.openPort(outputPort);

  console.log('\n=== SENDING TEST COMMANDS ===\n');

  // ── Step 4: Mode switch (visible test) ──
  console.log('→ Sending SCENES_MODE command...');
  console.log(`  ${toHex(COMMANDS.SCENES_MODE)}`);
  output.sendMessage(COMMANDS.SCENES_MODE);
  await sleep(500);
  console.log('  (Check AM4 display — should show Scenes mode)');

  await sleep(1000);

  // ── Step 5: Firmware version ──
  console.log('\n→ Sending GET_FIRMWARE_VERSION...');
  console.log(`  ${toHex(COMMANDS.GET_FIRMWARE)}`);
  output.sendMessage(COMMANDS.GET_FIRMWARE);
  await sleep(1000);

  // ── Step 6: Axe-Fx III protocol probes ──
  console.log('\n=== AXE-FX III PROTOCOL PROBES ===\n');

  const probes: Array<[string, number[]]> = [
    ['Q_SCENE (0x0C)',       COMMANDS.Q_SCENE],
    ['Q_PATCH_NAME (0x0D)',  COMMANDS.Q_PATCH_NAME],
    ['Q_SCENE_NAME (0x0E)',  COMMANDS.Q_SCENE_NAME],
    ['Q_TEMPO (0x14)',       COMMANDS.Q_TEMPO],
    ['STATUS_DUMP (0x13)',   COMMANDS.STATUS_DUMP],
  ];
  for (const [label, msg] of probes) {
    console.log(`→ ${label.padEnd(22)} ${toHex(msg)}`);
    output.sendMessage(msg);
    await sleep(1000);
  }

  // ── Step 8: Summary ──
  console.log('\n=== SUMMARY ===');
  console.log(`Responses received: ${responses.length}`);

  if (responses.length === 0) {
    console.log('\n⚠️  No responses received.');
    console.log('   Possible causes:');
    console.log('   1. Function IDs differ on AM4 vs Axe-FX II');
    console.log('   2. AM4 requires editor session handshake first');
    console.log('   3. MIDI port mismatch');
    console.log('\n   Next step: Open AM4-Edit with MIDI-OX to sniff valid commands.');
  } else {
    console.log('\n✅ Communication confirmed! Review responses above.');
    console.log('   Next step: Decode response payloads in docs/SESSIONS.md');
  }

  input.closePort();
  output.closePort();
}

main().catch(console.error);
