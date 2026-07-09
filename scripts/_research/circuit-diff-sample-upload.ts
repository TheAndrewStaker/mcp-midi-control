/**
 * Single-process diagnostic: upload ONE sample, then read the directory back in
 * the SAME connection. No MCP, no process handoff. Tells us whether the write
 * commits to the manifest at all.
 */
import { readFileSync } from 'node:fs';
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { uploadSample } from '@mcp-midi-control/circuit-tracks/samples/uploadSample.js';
import { makeMessage, TRANSFER_CONSTANTS } from '@mcp-midi-control/circuit-tracks/ncs/transfer.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const FT = 0x05, QCRC = 0x0d, QNAME = 0x08, RNAME = 0x0c;
const ascii = (a: readonly number[]) => a.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '')).join('');
const FILE = 'C:/dev/mcp-midi-tools/samples/drum-sources/sleep-token-ii/page-leveled/stoken_1_01_kick.wav';

async function readSlotName(conn: ReturnType<typeof connect>, slot: number): Promise<string> {
  const prelude = [
    makeMessage(SUB.OPEN_SESSION), makeMessage(SUB.DIR_CONTROL, [0x01]),
    makeMessage(SUB.QUERY_INFO, [0x01, 0x00]), makeMessage(SUB.DIR_CONTROL, [0x02]),
    makeMessage(SUB.DIR_CONTROL, [FT, 0x00]),
  ];
  for (const m of prelude) { const p = conn.receiveSysEx(400).catch(() => [] as number[]); conn.send(m); await p; }
  for (let s = 0; s < 64; s++) {
    const p = conn.receiveSysExMatching((x) => x[7] === QCRC && x[8] === FT && x[10] === s, 200).catch(() => [] as number[]);
    conn.send(makeMessage(QCRC, [FT, 0x00, s])); await p;
  }
  const p = conn.receiveSysExMatching((x) => x[7] === RNAME && x[8] === FT && x[10] === slot, 300).catch(() => [] as number[]);
  conn.send(makeMessage(QNAME, [FT, 0x00, slot]));
  const reply = await p;
  return reply.length ? ascii(reply.slice(11, reply.length - 1)) : '(empty)';
}

async function main(): Promise<void> {
  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found.' });
  if (!conn.hasInput) { console.error('no input port'); conn.close(); process.exit(2); }
  try {
    console.log('before  : slot 1 =', JSON.stringify(await readSlotName(conn, 0)));
    const wav = new Uint8Array(readFileSync(FILE));
    const r = await uploadSample(conn, wav, 0, 'difftest_kick');
    console.log('upload  : ok=' + r.ok + (r.error ? '  error=' + r.error : '') + '  blocks=' + r.blocks);
    await new Promise((res) => setTimeout(res, 400));
    console.log('after   : slot 1 =', JSON.stringify(await readSlotName(conn, 0)));
  } finally { conn.close(); }
}
main().catch((e) => { console.error('ERR', e instanceof Error ? e.message : e); process.exit(1); });
