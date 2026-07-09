/**
 * NON-DESTRUCTIVE hardware proof of the Circuit Tracks .ncs SysEx transport.
 *
 * Downloads project slot 0 off the device (the READ path: open session, dir
 * handshake, read-request, receive data blocks, verify CRC) and byte-compares
 * it to the user's exported project_0.ncs. If they match, the ENTIRE transport
 * (handshake, MSB-interleave, CRC, block framing, timing) is proven with ZERO
 * write risk, clearing the way for the upload.
 *
 * Reads only. Never writes to the device. Watchdog timeouts on every wait so it
 * cannot wedge. Requires the "Circuit Tracks" port to be FREE (no MCP server /
 * Components holding it).
 *
 * Run:  npx tsx scripts/circuit-ncs-read-verify.ts
 */

import { readFileSync } from 'node:fs';

import { connect, toHex } from '@mcp-midi-control/core/midi/transport.js';
import {
  blockAddress, crc32, fileId, makeMessage, msbDeinterleave, TRANSFER_CONSTANTS,
} from '@mcp-midi-control/circuit-tracks/ncs/transfer.js';
import { NCS_FILE_SIZE } from '@mcp-midi-control/circuit-tracks/ncs/format.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const HDR = TRANSFER_CONSTANTS.HEADER; // [00 20 29 01 64 03]
const SLOT = 0;
const ORACLE = 'C:/dev/mcp-midi-tools/samples/circuit-tracks/pack0/projects/project_0.ncs';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nibblesToInt = (ns: number[]) => ns.reduce((a, n) => (a * 16 + (n & 0xf)), 0) >>> 0;

/** Strip F0/F7 framing so byte 0 is the manufacturer id (matches the reference offset math). */
function core(msg: number[]): number[] {
  let b = msg;
  if (b[0] === 0xf0) b = b.slice(1);
  if (b[b.length - 1] === 0xf7) b = b.slice(0, -1);
  return b;
}
function isOurs(c: number[]): boolean {
  return c.length > HDR.length && HDR.every((h, i) => c[i] === h);
}

async function main(): Promise<void> {
  const oracle = new Uint8Array(readFileSync(ORACLE));
  console.log(`Oracle: ${ORACLE} (${oracle.length} bytes, crc32 0x${crc32(oracle).toString(16).toUpperCase()})`);

  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' });
  console.log('Connected to Circuit Tracks (bidirectional). Reading project slot 0...');

  const inbox: number[][] = [];
  const unsub = conn.onMessage((bytes) => { const c = core(bytes); if (isOurs(c)) inbox.push(c); });
  const drain = () => { inbox.length = 0; };
  async function waitFor(pred: (c: number[]) => boolean, timeoutMs: number): Promise<number[] | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const i = inbox.findIndex(pred);
      if (i >= 0) { const m = inbox[i]; inbox.splice(0, i + 1); return m; }
      await sleep(3);
    }
    return undefined;
  }

  const fid = fileId(SLOT);
  try {
    // 1. Open session + directory handshake (replicates Components).
    drain(); conn.send(makeMessage(SUB.OPEN_SESSION)); await sleep(300); drain();
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x01])); await sleep(100); drain();
    conn.send(makeMessage(SUB.QUERY_INFO, [0x01, 0x00])); await sleep(100); drain();
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x02])); await sleep(100); drain();
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x03, 0x00])); await sleep(500); drain();

    // 2. Read request: WRITE_INIT + 0x02 flag.
    conn.send(makeMessage(SUB.WRITE_INIT, [...blockAddress(0), ...fid, 0x02]));

    // 3. READ_INIT response carries the file size (5 nibbles after addr+fid+flags).
    const init = await waitFor((c) => c[HDR.length] === SUB.WRITE_INIT && c.length >= HDR.length + 1 + 8 + 3 + 4 + 5, 5000);
    if (!init) { console.error('FAIL: no READ_INIT response (device silent). Is the port free + device idle?'); conn.send(makeMessage(SUB.CLOSE_SESSION)); process.exit(2); }
    const sizeOff = HDR.length + 1 + 8 + 3 + 4;
    const size = nibblesToInt(init.slice(sizeOff, sizeOff + 5));
    console.log(`READ_INIT ok: device reports file size ${size} (expect ${NCS_FILE_SIZE}).`);

    // 4. Receive data blocks until WRITE_FINISH (carries the device's CRC).
    const raw: number[] = [];
    let crcReceived: number | undefined;
    const overall = Date.now() + 60_000;
    while (Date.now() < overall) {
      const m = await waitFor((c) => c[HDR.length] === SUB.WRITE_DATA || c[HDR.length] === SUB.WRITE_FINISH, 5000);
      if (!m) { console.error(`FAIL: transfer stalled at ${raw.length}/${size} bytes.`); break; }
      if (m[HDR.length] === SUB.WRITE_DATA) {
        raw.push(...msbDeinterleave(m.slice(HDR.length + 1 + 8 + 3)));
        process.stdout.write(`\r  received ${raw.length}/${size} bytes`);
      } else {
        crcReceived = nibblesToInt(m.slice(HDR.length + 1 + 8 + 3, HDR.length + 1 + 8 + 3 + 8));
        break;
      }
    }
    process.stdout.write('\n');
    conn.send(makeMessage(SUB.CLOSE_SESSION)); await sleep(100);

    // 5. Verify.
    const got = Uint8Array.from(raw.slice(0, NCS_FILE_SIZE));
    const crcComputed = crc32(got);
    console.log(`Downloaded ${got.length} bytes; CRC computed 0x${crcComputed.toString(16).toUpperCase()}, device-sent 0x${(crcReceived ?? 0).toString(16).toUpperCase()}`);
    const crcOk = crcReceived !== undefined && crcComputed === crcReceived;
    let mismatch = -1;
    for (let i = 0; i < NCS_FILE_SIZE; i++) if (got[i] !== oracle[i]) { mismatch = i; break; }
    const name = (b: Uint8Array) => String.fromCharCode(...b.slice(0x10, 0x20)).trim();

    console.log('');
    console.log(`  device CRC self-consistent: ${crcOk}`);
    console.log(`  downloaded project name @0x10: "${name(got)}"  (oracle: "${name(oracle)}")`);
    console.log(`  byte-for-byte vs exported project_0.ncs: ${mismatch === -1 ? 'IDENTICAL' : `differ first @0x${mismatch.toString(16)}`}`);
    if (crcOk && mismatch === -1) {
      console.log('\nPASS: transport PROVEN end-to-end on hardware (read round-trip byte-exact). Safe to proceed to WRITE.');
    } else {
      console.log('\nPARTIAL: see diffs above. (A name/content diff can mean slot 0 changed on the device since export; CRC-consistent + readable name still proves the transport.)');
    }
  } finally {
    unsub();
    conn.close();
  }
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
