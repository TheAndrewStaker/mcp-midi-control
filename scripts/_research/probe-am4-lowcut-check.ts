// probe-am4-lowcut-check.ts - optional 1-minute confirm for the 2026-07-15
// register fix (ex-HW-132): 0x1f = CABINET_LOCUT (`amp.master_low_cut`),
// 0x22 = CABINET_PROXFREQ (`amp.proximity_frequency`).
//
// The catalog identity map + distinct session-41 capture floats already
// settle the assignment (see STATE-AM4 2026-07-15 addendum); this probe
// just flips the label from evidence-resolved to hardware-confirmed.
//
// Flow: read both registers, write Master Low Cut = 120 Hz, ask the
// founder what the FRONT PANEL shows for both knobs (Cab Master EQ /
// Cab Extras pages; NOT AM4-Edit, the editor caches), then restore the
// original value and confirm the read-back.
//
// Interactive by design (founder observation step → readline gate, per
// RE-WORKFLOW's probe design rule). Working buffer only, never saves.
//
// Usage: npx tsx scripts/_research/probe-am4-lowcut-check.ts
//   (requires an amp block in the active preset - any factory preset works)

import * as readline from 'node:readline';
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { sendReadAndParseRaw } from '@mcp-midi-control/am4/shared/readOps.js';
import { buildSetParam, decode, KNOWN_PARAMS } from 'fractal-midi/am4';

const PIDLOW_CABINET = 0x3e;
const PID_MASTER_LOW_CUT = 0x1f; // CABINET_LOCUT     → amp.master_low_cut
const PID_PROX_FREQ = 0x22; //      CABINET_PROXFREQ  → amp.proximity_frequency

const TEST_HZ = 120;
const SETTLE_MS = 80;
const Q16 = 65536;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

  const conn = connectAM4();
  console.log('=== Master Low Cut vs Proximity Frequency hardware confirm ===');
  console.log('Working buffer only; the original value is restored at the end.\n');

  const readInternal = async (pidHigh: number): Promise<number> => {
    const { parsed } = await sendReadAndParseRaw(conn, PIDLOW_CABINET, pidHigh);
    return parsed.asUInt32LE() / Q16;
  };

  let origLowCut: number;
  let origProx: number;
  try {
    origLowCut = await readInternal(PID_MASTER_LOW_CUT);
    origProx = await readInternal(PID_PROX_FREQ);
  } catch (e) {
    console.error('Baseline read failed - is an amp block placed? Switch to a');
    console.error('factory preset with an amp (e.g. A01) and re-run.');
    rl.close();
    conn.close();
    throw e;
  }
  console.log(`Baseline internal floats: master_low_cut=${origLowCut.toFixed(5)} proximity_frequency=${origProx.toFixed(5)}\n`);

  console.log(`Writing amp.master_low_cut = ${TEST_HZ} Hz (register 0x1f) ...`);
  conn.send(buildSetParam('amp.master_low_cut', TEST_HZ));
  await sleep(SETTLE_MS);

  console.log('\nOn the AM4 FRONT PANEL (not AM4-Edit), open the amp\'s Cab section');
  console.log('expert pages and read BOTH knobs:');
  const seenLowCut = await ask(`  Master Low Cut now reads (expected ~${TEST_HZ} Hz): `);
  const seenProx = await ask('  Proximity Frequency now reads (expected UNCHANGED): ');

  console.log('\nRestoring the original Master Low Cut ...');
  // AM4 SETs are DISPLAY-domain floats (captures: 33.3 / 222.0 / 5500.0 on
  // the wire); READs return Q16 internals. Decode before writing back, or
  // the restore clamps to the range minimum (hardware-observed 2026-07-15).
  conn.send(buildSetParam('amp.master_low_cut', decode(KNOWN_PARAMS['amp.master_low_cut'], origLowCut)));
  await sleep(SETTLE_MS);
  const rbLowCut = await readInternal(PID_MASTER_LOW_CUT);
  const rbProx = await readInternal(PID_PROX_FREQ);
  const restored = Math.abs(rbLowCut - origLowCut) < 1e-3 && Math.abs(rbProx - origProx) < 1e-3;
  console.log(`  read-back: master_low_cut=${rbLowCut.toFixed(5)} proximity_frequency=${rbProx.toFixed(5)} ${restored ? '(restored)' : '(!! restore mismatch - reload the preset to discard)'}`);

  console.log('\n=== RESULT ===');
  console.log(`  founder saw: Master Low Cut = "${seenLowCut}", Proximity Frequency = "${seenProx}"`);
  console.log(`  PASS if Master Low Cut showed ~${TEST_HZ} Hz and Proximity Frequency did not move.`);
  console.log('  Paste this whole output back into the session.');
  console.log('\nWorking buffer was touched (edited bit set). Switch presets or reload to discard.');
  rl.close();
  conn.close();
}

void main();
