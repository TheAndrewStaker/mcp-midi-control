/**
 * AM4 MESSAGE_TOGGLE (0x07) re-test on bypassable blocks
 * ======================================================
 *
 * Session 104 (2026-05-20). Founder observation: AM4's AMP slot
 * doesn't have a bypass — pidHigh=0x03 on AMP is the BOOST toggle.
 * So the cmd-ack-variants probe's TOGGLE @ AMP pidHigh=0x03 was
 * exercising boost, not bypass.
 *
 * This probe re-tests TOGGLE on blocks that DO have bypass:
 * REVERB, DELAY, DRIVE, CHORUS. For each, we:
 *
 *   1. Use the existing buildSetBlockBypass(block, true) writer to
 *      force the block into a known BYPASSED state, wait for the ack.
 *   2. Read back the block's bypass state via long-form read
 *      (action 0x0D) to confirm baseline = bypassed.
 *   3. Fire TOGGLE @ block pidHigh=0x03 (action 0x07).
 *   4. Read back the block's bypass state. If it's now ACTIVE,
 *      TOGGLE flipped it.
 *   5. Fire TOGGLE again. Read back. If it's now BYPASSED again,
 *      TOGGLE flips consistently.
 *
 * # Safety
 *
 *   Mutates working buffer (bypass state of placed blocks). Switches
 *   to Z04 first; doesn't save. Reversible by reloading Z04.
 *
 * # Run
 *
 *   npx tsx scripts/_research/probe-am4-toggle-bypass.ts
 */

import midi from 'midi';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import {
  BLOCK_TYPE_VALUES,
  buildSetBlockBypass,
  buildReadParam,
  buildSwitchPreset,
  isReadResponseLong,
  parseLongReadBypassFlag,
  READ_TYPE_LONG,
} from 'fractal-midi/am4';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const AM4_MODEL = 0x15;
const FUNC_PARAM_RW = 0x01;
const BYPASS_PID_HIGH = 0x0003;
const ACTION_TOGGLE = 0x0007;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}

function encode14(n: number): [number, number] {
  return [n & 0x7f, (n >> 7) & 0x7f];
}

function buildToggle(pidLow: number, pidHigh: number): number[] {
  const head = [
    SYSEX_START, ...FRACTAL_MFR, AM4_MODEL, FUNC_PARAM_RW,
    ...encode14(pidLow), ...encode14(pidHigh), ...encode14(ACTION_TOGGLE),
    ...encode14(0x0000), ...encode14(0x0000),
  ];
  return [...head, fractalChecksum(head), SYSEX_END];
}

function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function findPort(io: midi.Input | midi.Output, needles: string[]): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    const name = io.getPortName(i);
    for (const n of needles) {
      if (name.toLowerCase().includes(n.toLowerCase())) {
        console.log(`  matched port [${i}] ${name}`);
        return i;
      }
    }
  }
  return -1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readBypass(output: midi.Output, collected: number[][], blockPidLow: number): Promise<boolean | null> {
  const req = buildReadParam({ pidLow: blockPidLow, pidHigh: BYPASS_PID_HIGH }, READ_TYPE_LONG);
  const before = collected.length;
  output.sendMessage(req);
  await sleep(300);
  for (const f of collected.slice(before)) {
    if (isReadResponseLong(req, f)) {
      try {
        return parseLongReadBypassFlag(f);
      } catch { /* fallthrough */ }
    }
  }
  return null;
}

const BLOCKS: Array<{ name: string; pidLow: number }> = [
  { name: 'reverb',  pidLow: BLOCK_TYPE_VALUES.reverb },
  { name: 'delay',   pidLow: BLOCK_TYPE_VALUES.delay },
  { name: 'drive',   pidLow: BLOCK_TYPE_VALUES.drive },
  { name: 'chorus',  pidLow: BLOCK_TYPE_VALUES.chorus },
  { name: 'flanger', pidLow: BLOCK_TYPE_VALUES.flanger },
  { name: 'phaser',  pidLow: BLOCK_TYPE_VALUES.phaser },
];

async function main(): Promise<void> {
  console.log('AM4 MESSAGE_TOGGLE re-test on bypassable blocks');
  console.log('═══════════════════════════════════════════════');

  const input = new midi.Input();
  const output = new midi.Output();
  const needles = ['AM4', 'Fractal'];
  console.log('\nInput ports:');
  for (let i = 0; i < input.getPortCount(); i++) console.log(`  [${i}] ${input.getPortName(i)}`);
  console.log('Output ports:');
  for (let i = 0; i < output.getPortCount(); i++) console.log(`  [${i}] ${output.getPortName(i)}`);

  const outIdx = findPort(output, needles);
  const inIdx = findPort(input, needles);
  if (outIdx < 0 || inIdx < 0) { console.error('AM4 port not found'); process.exit(1); }

  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);
  const collected: number[][] = [];
  input.on('message', (_dt, bytes) => { if (bytes[0] === 0xf0) collected.push(bytes.slice()); });
  input.openPort(inIdx);
  await sleep(500);

  // Switch to Z04 for safe scratch.
  output.sendMessage(buildSwitchPreset(103));
  await sleep(800);
  collected.length = 0;

  interface Result { block: string; tests: string[]; }
  const results: Result[] = [];

  for (const block of BLOCKS) {
    console.log(`\n══ ${block.name} (pidLow=0x${block.pidLow.toString(16)}) ══`);
    const tests: string[] = [];

    // Step 1: force bypassed=true via existing writer (action=0x01 with bypass=1).
    output.sendMessage(buildSetBlockBypass(block.pidLow, true));
    await sleep(300);

    // Read baseline.
    let state = await readBypass(output, collected, block.pidLow);
    if (state === null) {
      tests.push(`⚠️  baseline read failed — block may not be placed on Z04`);
      results.push({ block: block.name, tests });
      console.log(`  ${tests.join('\n  ')}`);
      continue;
    }
    tests.push(`baseline after force-bypass=true: ${state ? 'BYPASSED' : 'ACTIVE'}`);
    console.log(`  ${tests[tests.length - 1]}`);

    // Step 2: send TOGGLE.
    const toggleReq = buildToggle(block.pidLow, BYPASS_PID_HIGH);
    console.log(`  TOGGLE @ pidHigh=0x03: ${toHex(toggleReq)}`);
    output.sendMessage(toggleReq);
    await sleep(300);
    let state2 = await readBypass(output, collected, block.pidLow);
    tests.push(`after TOGGLE #1: ${state2 === null ? 'read failed' : state2 ? 'BYPASSED' : 'ACTIVE'}`);
    console.log(`  ${tests[tests.length - 1]}`);

    // Step 3: TOGGLE again, see if it flips back.
    output.sendMessage(toggleReq);
    await sleep(300);
    let state3 = await readBypass(output, collected, block.pidLow);
    tests.push(`after TOGGLE #2: ${state3 === null ? 'read failed' : state3 ? 'BYPASSED' : 'ACTIVE'}`);
    console.log(`  ${tests[tests.length - 1]}`);

    // Verdict.
    if (state2 !== null && state !== state2 && state3 !== null && state2 !== state3) {
      tests.push(`🟢 CONFIRMED: TOGGLE flips bypass state for ${block.name}`);
    } else if (state2 === state) {
      tests.push(`🟡 TOGGLE did not flip bypass for ${block.name} (baseline=${state}, after=${state2})`);
    } else {
      tests.push(`⚪ inconclusive (some reads failed)`);
    }
    console.log(`  ${tests[tests.length - 1]}`);

    results.push({ block: block.name, tests });
  }

  // Restore: reload Z04.
  output.sendMessage(buildSwitchPreset(103));
  await sleep(500);

  // Save findings.
  mkdirSync('samples/captured', { recursive: true });
  const md: string[] = [
    `# AM4 MESSAGE_TOGGLE (0x07) re-test on bypassable blocks`,
    ``,
    `> Auto-generated by \`scripts/_research/probe-am4-toggle-bypass.ts\` at ${new Date().toISOString()}`,
    ``,
    `Context: AM4's AMP slot doesn't have bypass; pidHigh=0x03 on AMP = boost toggle.`,
    `This probe re-tests TOGGLE on blocks that DO have bypass (reverb, delay, drive, etc.).`,
    ``,
    `## Per-block results`,
    ``,
  ];
  for (const r of results) {
    md.push(`### ${r.block}`, '');
    for (const t of r.tests) md.push(`- ${t}`);
    md.push('');
  }
  const out = path.resolve('samples/captured/probe-am4-toggle-bypass-findings.md');
  writeFileSync(out, md.join('\n'));
  console.log(`\nWrote findings to ${out}`);

  input.closePort();
  output.closePort();
  process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
