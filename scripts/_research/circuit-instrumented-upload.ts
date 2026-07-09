/**
 * Instrumented single-sample upload: log EVERY inbound SysEx (time + group/subcmd)
 * so we can see exactly what THIS device sends after CLOSE on an empty pack, and
 * whether the commit-wait matched the right frame. Then read the slot back.
 */
import { readFileSync } from 'node:fs';
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { uploadSample } from '@mcp-midi-control/circuit-tracks/samples/uploadSample.js';
import { makeMessage, TRANSFER_CONSTANTS } from '@mcp-midi-control/circuit-tracks/ncs/transfer.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const FT = 0x05, QCRC = 0x0d, QNAME = 0x08, RNAME = 0x0c;
const FILE = 'C:/dev/mcp-midi-tools/samples/drum-sources/sleep-token-ii/page-leveled/stoken_1_01_kick.wav';
const ascii = (a: readonly number[]) => a.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '')).join('');
const t0 = Date.now();
const rel = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6);

async function readSlot(conn: ReturnType<typeof connect>, slot: number): Promise<string> {
  const prelude = [makeMessage(SUB.OPEN_SESSION), makeMessage(SUB.DIR_CONTROL, [0x01]), makeMessage(SUB.QUERY_INFO, [0x01, 0x00]), makeMessage(SUB.DIR_CONTROL, [0x02]), makeMessage(SUB.DIR_CONTROL, [FT, 0x00])];
  for (const m of prelude) { const p = conn.receiveSysEx(400).catch(() => [] as number[]); conn.send(m); await p; }
  for (let s = 0; s < 64; s++) { const p = conn.receiveSysExMatching((x) => x[7] === QCRC && x[8] === FT && x[10] === s, 200).catch(() => [] as number[]); conn.send(makeMessage(QCRC, [FT, 0x00, s])); await p; }
  const p = conn.receiveSysExMatching((x) => x[7] === RNAME && x[8] === FT && x[10] === slot, 300).catch(() => [] as number[]);
  conn.send(makeMessage(QNAME, [FT, 0x00, slot])); const r = await p;
  return r.length ? ascii(r.slice(11, r.length - 1)) : '(empty)';
}

async function main(): Promise<void> {
  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found.' });
  if (!conn.hasInput) { console.error('no input'); conn.close(); process.exit(2); }
  // Tally inbound by group(byte6)+subcmd(byte7); print the interesting (non-ack, non-clock) ones.
  const seen: Record<string, number> = {};
  conn.onMessage((m) => {
    if (m[0] !== 0xf0) return;
    const grp = m[6], sub = m[7];
    const key = `grp${grp.toString(16)}/sub${sub.toString(16)}`;
    seen[key] = (seen[key] ?? 0) + 1;
    // Log post-upload-ish notifications (not the flood of 0x04 acks during writes).
    if (sub !== 0x04 && Date.now() - t0 > 200) console.log(`${rel()}  IN  ${key}  ${m.slice(6, Math.min(m.length, 14)).map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  });
  try {
    console.log(`${rel()}  uploading slot 1 (awaitCommitMs default)…`);
    const r = await uploadSample(conn, new Uint8Array(readFileSync(FILE)), 0, 'instr_kick');
    console.log(`${rel()}  upload returned ok=${r.ok}${r.error ? ' err=' + r.error : ''}`);
    await new Promise((res) => setTimeout(res, 2000)); // catch any late commit frame
    console.log(`${rel()}  reading slot 1 back…`);
    console.log(`${rel()}  slot 1 = ${JSON.stringify(await readSlot(conn, 0))}`);
    console.log('inbound tally:', seen);
  } finally { conn.close(); }
}
main().catch((e) => { console.error('ERR', e instanceof Error ? e.message : e); process.exit(1); });
