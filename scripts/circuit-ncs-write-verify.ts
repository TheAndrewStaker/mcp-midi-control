/**
 * Hardware WRITE + readback verify of the Circuit Tracks .ncs upload.
 *
 * Takes the exported project_0 (proven byte-identical to device slot 0 by the
 * read-verify), rewrites Drum 1 pattern 0 to a clean four-on-the-floor, UPLOADS
 * it to slot 0 over SysEx (open session, write_init, 20 data blocks with ACKs,
 * write_finish + CRC), then READS slot 0 back and confirms the readback equals
 * what we wrote (byte-exact) and the drum grid changed. Self-verifying: no
 * Components, no human step.
 *
 * DESTRUCTIVE: overwrites project slot 0 ("Hello Tracks", restorable from
 * Components). Watchdogs on every ACK wait so it cannot wedge.
 *
 * Run:  npx tsx scripts/circuit-ncs-write-verify.ts
 */

import { readFileSync } from 'node:fs';

import { connect } from '@mcp-midi-control/core/midi/transport.js';
import {
  blockAddress, buildUploadFrames, crc32, fileId, makeMessage, msbDeinterleave, TRANSFER_CONSTANTS,
} from '@mcp-midi-control/circuit-tracks/ncs/transfer.js';
import { NCS_FILE_SIZE } from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import { decodeDrumPattern, drumPatternToString, setDrumPattern } from '@mcp-midi-control/circuit-tracks/ncs/drumPattern.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const HDR = TRANSFER_CONSTANTS.HEADER;
const SLOT = 17; // empty slot on the device (the export skipped it), overwrites nothing
const PROJECT_NAME = 'MCP Kick Demo';
const ORACLE = 'C:/dev/mcp-midi-tools/samples/circuit-tracks/pack0/projects/project_0.ncs';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nibblesToInt = (ns: number[]) => ns.reduce((a, n) => (a * 16 + (n & 0xf)), 0) >>> 0;
function core(msg: number[]): number[] {
  let b = msg;
  if (b[0] === 0xf0) b = b.slice(1);
  if (b[b.length - 1] === 0xf7) b = b.slice(0, -1);
  return b;
}
const isOurs = (c: number[]) => c.length > HDR.length && HDR.every((h, i) => c[i] === h);
// The device ACKs with subcmd 0x04; the reference matches ANY ACK (it does not
// compare the addr/fid echoed back), so we do the same.
function isAck(c: number[]): boolean {
  return c.length >= HDR.length + 1 + 8 + 3 && c[HDR.length] === SUB.ACK;
}

async function main(): Promise<void> {
  const base = new Uint8Array(readFileSync(ORACLE));
  const modified = base.slice();
  setDrumPattern(modified, 0, 0, [0, 4, 8, 12].reduce((g, s) => { g[s] = { active: true, velocity: 110 }; return g; }, new Array(16).fill(false)));
  for (let i = 0; i < 16; i++) modified[0x10 + i] = i < PROJECT_NAME.length ? PROJECT_NAME.charCodeAt(i) : 0x20; // rename
  console.log(`Template: "${ORACLE}" → upload to slot ${SLOT} as "${PROJECT_NAME}"`);
  console.log(`  Drum1 p0 before: ${drumPatternToString(decodeDrumPattern(base, 0, 0))}`);
  console.log(`  Drum1 p0 after:  ${drumPatternToString(decodeDrumPattern(modified, 0, 0))}  (uploading this)`);

  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' });
  const inbox: number[][] = [];
  const unsub = conn.onMessage((m) => { const c = core(m); if (isOurs(c)) inbox.push(c); });
  const drain = () => { inbox.length = 0; };
  async function waitFor(pred: (c: number[]) => boolean, ms: number): Promise<number[] | undefined> {
    const end = Date.now() + ms;
    while (Date.now() < end) { const i = inbox.findIndex(pred); if (i >= 0) { const m = inbox[i]; inbox.splice(0, i + 1); return m; } await sleep(3); }
    return undefined;
  }
  const fid = fileId(SLOT);

  try {
    // Reset any half-open session left by a prior aborted attempt.
    conn.send(makeMessage(SUB.CLOSE_SESSION)); await sleep(200); drain();

    // ── WRITE ──
    console.log(`\nUploading to slot ${SLOT}...`);
    drain();
    const frames = buildUploadFrames(modified, SLOT);
    for (const f of frames) {
      conn.send(f.bytes);
      if (f.ack) {
        const ok = await waitFor((c) => isAck(c), 4000);
        if (!ok) { console.error(`\nFAIL: no ACK for ${f.label}. Aborting (device may be busy / port held).`); conn.send(makeMessage(SUB.CLOSE_SESSION)); process.exit(2); }
        if (f.label.startsWith('write_data')) process.stdout.write(`\r  ${f.label} acked`);
      } else {
        await sleep(120); drain();
      }
    }
    process.stdout.write('\n  upload complete (all blocks + finish acked).\n');
    await sleep(300);

    // ── READ BACK ──
    console.log(`Reading slot ${SLOT} back to verify...`);
    drain();
    conn.send(makeMessage(SUB.OPEN_SESSION)); await sleep(300); drain();
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x01])); await sleep(100); drain();
    conn.send(makeMessage(SUB.QUERY_INFO, [0x01, 0x00])); await sleep(100); drain();
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x02])); await sleep(100); drain();
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x03, 0x00])); await sleep(500); drain();
    conn.send(makeMessage(SUB.WRITE_INIT, [...blockAddress(0), ...fid, 0x02]));
    const init = await waitFor((c) => c[HDR.length] === SUB.WRITE_INIT && c.length >= HDR.length + 1 + 8 + 3 + 4 + 5, 5000);
    if (!init) { console.error('FAIL: no READ_INIT on readback.'); process.exit(2); }
    const raw: number[] = [];
    let crcRx: number | undefined;
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      const m = await waitFor((c) => c[HDR.length] === SUB.WRITE_DATA || c[HDR.length] === SUB.WRITE_FINISH, 5000);
      if (!m) break;
      if (m[HDR.length] === SUB.WRITE_DATA) raw.push(...msbDeinterleave(m.slice(HDR.length + 1 + 8 + 3)));
      else { crcRx = nibblesToInt(m.slice(HDR.length + 1 + 8 + 3, HDR.length + 1 + 8 + 3 + 8)); break; }
    }
    conn.send(makeMessage(SUB.CLOSE_SESSION)); await sleep(100);

    const readback = Uint8Array.from(raw.slice(0, NCS_FILE_SIZE));
    let mismatch = -1;
    for (let i = 0; i < NCS_FILE_SIZE; i++) if (readback[i] !== modified[i]) { mismatch = i; break; }
    const grid = drumPatternToString(decodeDrumPattern(readback, 0, 0));
    console.log('');
    console.log(`  readback CRC matches device: ${crcRx === crc32(readback)}`);
    console.log(`  readback == uploaded bytes: ${mismatch === -1 ? 'IDENTICAL' : `differ @0x${mismatch.toString(16)}`}`);
    console.log(`  readback Drum1 p0 grid: ${grid}`);
    const want = 'x...x...x...x...' + '.'.repeat(16);
    if (mismatch === -1 && grid === want) {
      console.log(`\nPASS: upload landed on the device, verified byte-exact by readback. "${PROJECT_NAME}" is now in slot ${SLOT}, Drum 1 = four-on-the-floor.`);
    } else {
      console.log('\nINCOMPLETE: see diffs above.');
    }
  } finally {
    unsub();
    conn.close();
  }
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
