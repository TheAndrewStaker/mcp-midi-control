/**
 * MicroFreak BANK SELECT probe. Decides whether presets above 128 are reachable
 * over MIDI, which is currently the single largest functional gap on the device.
 *
 * ## The gap
 *
 * The MicroFreak holds 512 presets on firmware 5 (384 on firmware 4), but plain
 * Program Change carries only 0..127. `switch_preset` therefore REFUSES above
 * 128 rather than sending a message that would silently load the wrong sound,
 * which leaves three quarters of the device's memory reachable only from the
 * front panel. Arturia's manual documents no Program Change support at all (PC
 * was found here by probing, and is 0-based), so it says nothing about banks
 * either. This has to be settled empirically.
 *
 * ## What is being tested
 *
 * Standard MIDI selects a bank with CC 0 (Bank Select MSB) and/or CC 32 (LSB),
 * followed by a Program Change. Which one a device honours, if either, is
 * per-manufacturer. The hypotheses, in the order the probe tests them:
 *
 *   H1  CC 32 (LSB) carries the bank; PC carries the index within it.
 *   H2  CC 0 (MSB) carries the bank instead.
 *   H3  Neither. Program Change reaches only presets 1..128, and the rest of
 *       memory is genuinely front-panel-only.
 *
 * H3 is a perfectly good outcome. A confirmed "no" closes the question and
 * justifies the current refusal, which is far better than leaving it open.
 *
 * ## Safety
 *
 * This probe CHANGES which preset is loaded. That is reversible (switching
 * presets is what the device does all day) and writes nothing to memory: no
 * save, no store, no global write. But it DOES discard the edit buffer, so if
 * there is unsaved work on the device, save it on the front panel first.
 *
 * ## Interactive by design
 *
 * Per CLAUDE.md, a probe that depends on someone reading the device's own
 * display must wait for them to type what they see, never advance on a timer.
 * A timed sweep here would be worthless: the reader cannot know when to look.
 *
 * Run:  npx tsx scripts/probe-microfreak-bank-select.ts [midiChannel]
 *       (channel defaults to MCP_MICROFREAK_CHANNEL, then to 1)
 */
import * as readline from 'node:readline';

import { connect } from '../packages/core/src/midi/transport.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

function resolveChannel(): number {
  const raw = process.argv[2] ?? process.env.MCP_MICROFREAK_CHANNEL;
  const n = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 16) return 1;
  return n;
}

interface Step {
  /** What the probe is trying to learn. */
  purpose: string;
  /** Bank Select MSB (CC 0) value, or undefined to send none. */
  msb?: number;
  /** Bank Select LSB (CC 32) value, or undefined to send none. */
  lsb?: number;
  /** Program Change value. 0-based: PC n loads preset n+1 within the bank. */
  pc: number;
  /** The preset number that would confirm the hypothesis. */
  expectIfBanked: number;
  /** The preset number that means bank select was IGNORED. */
  expectIfIgnored: number;
}

const STEPS: readonly Step[] = [
  {
    purpose: 'Baseline. No bank select at all, so this pins the 0-based PC behaviour '
      + 'before any bank byte is introduced.',
    pc: 0,
    expectIfBanked: 1,
    expectIfIgnored: 1,
  },
  {
    purpose: 'H1: CC 32 (LSB) = 1 should reach bank 2, i.e. preset 129.',
    lsb: 1,
    pc: 0,
    expectIfBanked: 129,
    expectIfIgnored: 1,
  },
  {
    purpose: 'H1 again at a different index, so a coincidence cannot pass. '
      + 'LSB 1 + PC 9 should be preset 138.',
    lsb: 1,
    pc: 9,
    expectIfBanked: 138,
    expectIfIgnored: 10,
  },
  {
    purpose: 'H2: CC 0 (MSB) = 1 should reach preset 129 if the MSB is the bank byte.',
    msb: 1,
    pc: 0,
    expectIfBanked: 129,
    expectIfIgnored: 1,
  },
  {
    purpose: 'Reach the TOP of memory. Bank 3 (LSB 3) + PC 127 should be preset 512, '
      + 'the last slot on firmware 5.',
    lsb: 3,
    pc: 127,
    expectIfBanked: 512,
    expectIfIgnored: 128,
  },
];

async function main(): Promise<void> {
  const channel = resolveChannel();
  const status = (kind: number): number => kind | (channel - 1);

  console.log('MicroFreak Bank Select probe');
  console.log('='.repeat(66));
  console.log(`MIDI channel: ${channel}  (pass a different one as the first argument)`);
  console.log('');
  console.log('This probe CHANGES the loaded preset. It writes NOTHING to memory:');
  console.log('no save, no store, no global settings write. But switching presets');
  console.log('DISCARDS the edit buffer, so if you have unsaved work on the device,');
  console.log('save it on the front panel before continuing.');
  console.log('');
  console.log('After each step, read the preset number on the MicroFreak display and');
  console.log('type it in. Type "x" if the display did not change or you are unsure.');
  console.log('');

  const go = await ask('Ready? [y/N] ');
  if (go.trim().toLowerCase() !== 'y') {
    console.log('Aborted. Nothing was sent.');
    rl.close();
    process.exit(0);
  }

  const conn = connect({
    needles: ['microfreak', 'arturia'],
    notFoundLeadIn: 'MicroFreak not found in the MIDI device list.',
    notFoundHints: [
      'Connect it by USB and power it on (it runs from its own DC adapter, not USB bus power).',
      'Close MIDI Control Center: MIDI ports are exclusive, so an open editor blocks this probe.',
    ],
  });

  const results: Array<{ step: Step; answer: string }> = [];

  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i];
    console.log(`\n--- Step ${i + 1} of ${STEPS.length} ---`);
    console.log(s.purpose);

    const sent: string[] = [];
    if (s.msb !== undefined) {
      conn.send([status(0xb0), 0, s.msb]);
      sent.push(`CC 0 (MSB) = ${s.msb}`);
    }
    if (s.lsb !== undefined) {
      conn.send([status(0xb0), 32, s.lsb]);
      sent.push(`CC 32 (LSB) = ${s.lsb}`);
    }
    conn.send([status(0xc0), s.pc & 0x7f]);
    sent.push(`PC ${s.pc}`);
    console.log(`sent: ${sent.join(', ')}`);
    console.log(`  preset ${s.expectIfBanked} => bank select WORKS`);
    console.log(`  preset ${s.expectIfIgnored} => bank select IGNORED`);

    const answer = await ask('  what does the display show? ');
    results.push({ step: s, answer: answer.trim() });
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(66)}`);
  console.log('RESULTS');
  console.log('='.repeat(66));

  const num = (s: string): number | undefined => {
    const n = Number(s.replace(/[^0-9]/g, ''));
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };

  let lsbWorks = 0;
  let lsbTested = 0;
  let msbWorks = 0;
  let msbTested = 0;

  for (let i = 0; i < results.length; i++) {
    const { step, answer } = results[i];
    const got = num(answer);
    const banked = got === step.expectIfBanked;
    const ignored = got === step.expectIfIgnored;
    const verdict = got === undefined
      ? 'no reading'
      : banked ? 'BANKED' : ignored ? 'ignored' : `UNEXPECTED (${got})`;
    console.log(`  step ${i + 1}: answered "${answer}" -> ${verdict}`);

    if (step.lsb !== undefined) { lsbTested++; if (banked) lsbWorks++; }
    if (step.msb !== undefined) { msbTested++; if (banked) msbWorks++; }
  }

  console.log('');
  if (lsbTested > 0 && lsbWorks === lsbTested) {
    console.log('VERDICT: CC 32 (Bank Select LSB) selects the bank. All LSB steps landed.');
    console.log('  Next: raise pc_max_preset to the full preset_count in the MicroFreak config');
    console.log('  and send CC 32 = floor((slot-1)/128) before the Program Change.');
  } else if (msbTested > 0 && msbWorks === msbTested) {
    console.log('VERDICT: CC 0 (Bank Select MSB) selects the bank. All MSB steps landed.');
    console.log('  Next: same change, but send CC 0 rather than CC 32.');
  } else if (lsbWorks === 0 && msbWorks === 0) {
    console.log('VERDICT: Bank Select is IGNORED. Program Change reaches presets 1..128 only.');
    console.log('  This CONFIRMS the current refusal above 128 is correct, which is a real');
    console.log('  result worth recording: it closes the question rather than leaving it open.');
  } else {
    console.log('VERDICT: MIXED. Some steps banked and some did not, so the mapping is not');
    console.log('  a plain bank-times-128. Do NOT ship a bank implementation on this data.');
    console.log('  Re-run, and note anything unusual about which steps landed.');
  }
  console.log('');
  console.log('Record the outcome in docs/_private/STATE-MICROFREAK.md either way.');

  conn.close();
  rl.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  rl.close();
  process.exit(1);
});
