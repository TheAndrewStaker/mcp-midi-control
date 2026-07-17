// probe-am4-cab-verify-steps.ts - chat-driven variant of the cab-register
// verification (ex-HW-132 confirm + mic roster clamp), for when the agent
// drives the wire and the founder only reads the front panel between steps.
// Each invocation is one non-interactive step; the founder's panel reading
// comes back through the conversation (the chat turn IS the readline gate).
//
// Modes:
//   --mic-clamp   Sweep CABINET_DYNACAB_MIC1 0..7 with readback; restores
//                 the original mic; prints the accepted index range
//                 (= mic roster size). Fully self-contained.
//   --set         Save baseline (master_low_cut, proximity_frequency) to a
//                 state file, then write amp.master_low_cut = 120 Hz.
//                 Founder then reads BOTH knobs on the FRONT PANEL.
//   --restore     Restore the baseline from the state file + verify readback.
//
// Working buffer only, never saves. State file:
//   samples/captured/decoded/_am4-cab-verify-state.json
//
// Usage: npx tsx scripts/_research/probe-am4-cab-verify-steps.ts --<mode>

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { sendReadAndParseRaw } from '@mcp-midi-control/am4/shared/readOps.js';
import { buildSetParam, buildSetFloatParam, decode, KNOWN_PARAMS } from 'fractal-midi/am4';

const PIDLOW_CABINET = 0x3e;
const PID_MASTER_LOW_CUT = 0x1f; // CABINET_LOCUT     → amp.master_low_cut
const PID_PROX_FREQ = 0x22; //      CABINET_PROXFREQ  → amp.proximity_frequency
const PID_DYNACAB_MIC1 = 0x43; //   CABINET_DYNACAB_MIC1

const TEST_HZ = 120;
const SETTLE_MS = 80;
const Q16 = 65536;
const MIC_SWEEP_MAX = 8;
const STATE_FILE = 'samples/captured/decoded/_am4-cab-verify-state.json';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Conn = ReturnType<typeof connectAM4>;

async function readU32(conn: Conn, pidHigh: number): Promise<number> {
  const { parsed } = await sendReadAndParseRaw(conn, PIDLOW_CABINET, pidHigh);
  return parsed.asUInt32LE();
}

async function writeInternal(conn: Conn, pidHigh: number, internal: number): Promise<void> {
  conn.send(buildSetFloatParam({ pidLow: PIDLOW_CABINET, pidHigh }, internal));
  await sleep(SETTLE_MS);
}

async function micClamp(conn: Conn): Promise<void> {
  const orig = await readU32(conn, PID_DYNACAB_MIC1);
  console.log(`mic-clamp: baseline MIC1 = ${orig}`);
  let acceptedMax = -1;
  for (let i = 0; i < MIC_SWEEP_MAX; i++) {
    await writeInternal(conn, PID_DYNACAB_MIC1, i);
    const rb = await readU32(conn, PID_DYNACAB_MIC1);
    console.log(`  write ${i} → readback ${rb}${rb === i ? '' : '  (clamped)'}`);
    if (rb !== i) break;
    acceptedMax = i;
  }
  await writeInternal(conn, PID_DYNACAB_MIC1, orig);
  const rb = await readU32(conn, PID_DYNACAB_MIC1);
  console.log(`mic-clamp: restored MIC1 = ${rb} ${rb === orig ? '(restored)' : '(!! restore mismatch)'}`);
  console.log(`mic-clamp RESULT: accepted indices 0..${acceptedMax} → mic roster size ${acceptedMax + 1}`);
}

async function setStep(conn: Conn): Promise<void> {
  const lowCut = (await readU32(conn, PID_MASTER_LOW_CUT)) / Q16;
  const prox = (await readU32(conn, PID_PROX_FREQ)) / Q16;
  mkdirSync('samples/captured/decoded', { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ lowCut, prox, savedAt: new Date().toISOString() }, null, 2));
  console.log(`baseline saved: master_low_cut internal=${lowCut.toFixed(5)}, proximity_frequency internal=${prox.toFixed(5)}`);
  conn.send(buildSetParam('amp.master_low_cut', TEST_HZ));
  await sleep(SETTLE_MS);
  console.log(`WROTE amp.master_low_cut = ${TEST_HZ} Hz (register 0x1f).`);
  console.log('Founder: on the AM4 FRONT PANEL, read BOTH knobs in the amp Cab section');
  console.log(`  expert pages: Master Low Cut (expect ~${TEST_HZ} Hz) and Proximity`);
  console.log('  Frequency (expect UNCHANGED). Report both, then run --restore.');
}

async function restoreStep(conn: Conn): Promise<void> {
  if (!existsSync(STATE_FILE)) {
    throw new Error(`no state file at ${STATE_FILE} - was --set run?`);
  }
  const st = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as { lowCut: number; prox: number };
  // AM4 SETs are DISPLAY-domain floats (captures: 33.3 / 222.0 / 5500.0 on
  // the wire); READs return Q16 internals. Decode internal → display before
  // writing back, or a low-cut restore of "0.25766 Hz" clamps to 20 Hz
  // (exactly the bug the first version of this step had).
  const displayLowCut = decode(KNOWN_PARAMS['amp.master_low_cut'], st.lowCut);
  console.log(`restoring amp.master_low_cut = ${displayLowCut.toFixed(2)} Hz (internal ${st.lowCut.toFixed(5)})`);
  conn.send(buildSetParam('amp.master_low_cut', displayLowCut));
  await sleep(SETTLE_MS);
  const rbLow = (await readU32(conn, PID_MASTER_LOW_CUT)) / Q16;
  const rbProx = (await readU32(conn, PID_PROX_FREQ)) / Q16;
  const ok = Math.abs(rbLow - st.lowCut) < 1e-3 && Math.abs(rbProx - st.prox) < 1e-3;
  console.log(`restored: master_low_cut internal=${rbLow.toFixed(5)} proximity_frequency internal=${rbProx.toFixed(5)} ${ok ? '(restored)' : '(!! mismatch - reload the preset to discard)'}`);
  if (ok) unlinkSync(STATE_FILE);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const conn = connectAM4();
  try {
    if (mode === '--mic-clamp') await micClamp(conn);
    else if (mode === '--set') await setStep(conn);
    else if (mode === '--restore') await restoreStep(conn);
    else {
      console.error('usage: probe-am4-cab-verify-steps.ts --mic-clamp | --set | --restore');
      process.exitCode = 2;
    }
  } finally {
    conn.close();
  }
}

void main();
