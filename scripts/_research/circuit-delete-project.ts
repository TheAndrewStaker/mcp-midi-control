/**
 * circuit-delete-project.ts — HARDWARE TEST of the project DELETE opcode.
 *
 * THE CLAIM UNDER TEST. Sub-command 0x08 of the file-transfer command group
 * deletes one stored file:
 *
 *     F0 00 20 29 01 64 03 08 <fileType> <pack> <slot> F7      (12 bytes)
 *
 * ...and sub-command 0x0d is a QUERY_EXISTS on the same 3-byte file id, which
 * answers with the file's CRC when the slot is occupied and a short refusal when
 * it is free. That makes 0x0d an occupancy oracle INDEPENDENT of the directory
 * listing — which matters here, because a delete's whole effect is on the
 * directory, so verifying a delete with only a directory read is circular.
 *
 * EVIDENCE (re-mined from captures held since 2026-06-27, verified in this
 * session against `samples/captured/send-pack-to-circuit-tracks-sleep-token-\
 * and-roland-samples-06-27-2026.pcapng`):
 *
 *   - Components sends 0x0d to ALL 64 project slots, then 0x08 to a SUBSET:
 *     0x06-0x12, 0x1e-0x3d, 0x3f = 46 slots.
 *   - The device's own DIR_ENTRY listing in the same capture names exactly those
 *     46 slots as occupied. The 0x08 set IS the occupied set, byte for byte.
 *   - Not one project WRITE follows: the capture goes from the 46 deletes
 *     straight to sample writes. So 0x08 is a standalone CLEAR, not a
 *     write preamble.
 *   - Every 0x08 draws an ACK echoing its own fileId.
 *   - The 0x0d replies split exactly the same way: occupied slots answer with an
 *     8-nibble (32-bit) CRC; the 6 free slots 0x00-0x05 and the 11 free slots
 *     0x13-0x1d answer with a short frame instead. The counts match the gaps.
 *
 * SAFETY. This is IRREVERSIBLE. Contract:
 *   - dry run by default, `--apply` required;
 *   - sends EXACTLY ONE 0x08, ever, for the one slot named on the command line
 *     (the 2026-06-27 incident that cleared 64 slots was a LOOP; there is no
 *     loop here and there must never be one);
 *   - refuses unless the slot's stored project matches `--name`;
 *   - refuses unless the downloaded bytes are byte-identical to `--expect-sha256`,
 *     so a slot holding anything unexpected is never touched;
 *   - takes a fresh CRC-gated backup of the exact bytes before the delete;
 *   - verifies past the flash-flush window on BOTH oracles.
 *
 * Usage:
 *   npx tsx scripts/_research/circuit-delete-project.ts --pack 1 --slot 11 --name "User Session" --expect-sha256 <hex>
 *   npx tsx scripts/_research/circuit-delete-project.ts --pack 1 --slot 11 --name "User Session" --expect-sha256 <hex> --apply
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connect, closeAllMidiConnections, type MidiConnection } from '../../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript, reconnectMidi } from '../_lib/midi-lifecycle.js';
import { downloadProject } from '../../packages/circuit-tracks/src/ncs/uploadProject.js';
import { readProjectDirectory } from '../../packages/circuit-tracks/src/ncs/sampleDirectory.js';
import { makeMessage, TRANSFER_CONSTANTS } from '../../packages/circuit-tracks/src/ncs/transfer.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const HDR = TRANSFER_CONSTANTS.HEADER;
/** Occupancy query: answers with the stored file's CRC, or a short refusal when free. */
const SUB_QUERY_EXISTS = 0x0d;
/** Delete one stored file by file id. IRREVERSIBLE. */
const SUB_DELETE = 0x08;
const FILE_TYPE_PROJECT = 0x03;

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const APPLY = argv.includes('--apply');
const devicePack = Number(flag('--pack') ?? '1');
const deviceSlot = Number(flag('--slot') ?? '11');
const expectName = flag('--name');
const expectSha = flag('--expect-sha256');

const wirePack = devicePack - 1;
const wireSlot = deviceSlot - 1;

const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hex = (ns: readonly number[]) => ns.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(0x10, 0x30)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

/** The device flushes its manifest to flash ~6-8 s after a session closes. */
const FLUSH_WINDOW_MS = 12_000;

interface ExistsReply { raw: number[]; occupied: boolean; crcNibbles?: number[]; }

/**
 * Send ONE query/action frame inside a fresh file-transfer session and return
 * whatever the device answers. The session prelude is the same non-destructive
 * open + directory handshake `readFileDirectory` replays; it never opens a write
 * transaction.
 */
async function inSession<T>(conn: MidiConnection, body: (inbox: number[][]) => Promise<T>): Promise<T> {
  const inbox: number[][] = [];
  const unsub = conn.onMessage((m) => { if (m.length > 7 && HDR.every((h, i) => m[1 + i] === h)) inbox.push(m); });
  try {
    conn.send(makeMessage(SUB.CLOSE_SESSION)); await sleep(250);
    inbox.length = 0;
    conn.send(makeMessage(SUB.OPEN_SESSION)); await sleep(300);
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x01])); await sleep(100);
    conn.send(makeMessage(SUB.QUERY_INFO, [0x01, 0x00])); await sleep(100);
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x02])); await sleep(100);
    conn.send(makeMessage(SUB.DIR_CONTROL, [FILE_TYPE_PROJECT, wirePack & 0x7f])); await sleep(600);
    inbox.length = 0;
    return await body(inbox);
  } finally {
    try { conn.send(makeMessage(SUB.CLOSE_SESSION)); } catch { /* port gone */ }
    unsub();
  }
}

/**
 * QUERY_EXISTS (0x0d). Occupied slots answer `… 0d 03 <pack> <slot> <8 nibbles>`
 * (a 32-bit CRC); free slots answer a shorter frame with no CRC tail.
 */
async function queryExists(conn: MidiConnection): Promise<ExistsReply | undefined> {
  return inSession(conn, async (inbox) => {
    conn.send(makeMessage(SUB_QUERY_EXISTS, [FILE_TYPE_PROJECT, wirePack & 0x7f, wireSlot & 0x7f]));
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const i = inbox.findIndex((m) => m[1 + HDR.length] === SUB_QUERY_EXISTS);
      if (i >= 0) {
        const raw = inbox[i];
        // core payload after F0+HDR+subcmd, minus the trailing F7
        const payload = raw.slice(1 + HDR.length + 1, raw.length - 1);
        const crcNibbles = payload.length >= 3 + 8 ? payload.slice(3, 11) : undefined;
        return { raw, occupied: crcNibbles !== undefined, crcNibbles };
      }
      await sleep(5);
    }
    return undefined;
  });
}

/** Send EXACTLY ONE delete frame and wait for its ACK. IRREVERSIBLE. */
async function deleteOnce(conn: MidiConnection): Promise<{ frame: number[]; acked: boolean; ack?: number[] }> {
  const frame = makeMessage(SUB_DELETE, [FILE_TYPE_PROJECT, wirePack & 0x7f, wireSlot & 0x7f]);
  const acked = await inSession(conn, async (inbox) => {
    conn.send(frame);
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const i = inbox.findIndex((m) => m[1 + HDR.length] === SUB.ACK);
      if (i >= 0) return inbox[i];
      await sleep(5);
    }
    return undefined;
  });
  return { frame, acked: acked !== undefined, ack: acked };
}

function reportDir(label: string, r: Awaited<ReturnType<typeof readProjectDirectory>>): void {
  const target = r.slots[wireSlot];
  console.log(`  ${label}: occupied=${r.occupied}/${r.total}, wire slot ${wireSlot} (Project ${deviceSlot}) = ${target?.name !== undefined ? `"${target.name}"` : 'EMPTY (no directory entry)'}`);
}

async function main(): Promise<void> {
  if (!expectName) { console.error('--name is required'); process.exit(1); }
  if (!expectSha) { console.error('--expect-sha256 is required (the exact bytes this invocation is allowed to destroy)'); process.exit(1); }

  console.log(`DELETE Pack ${devicePack} project ${deviceSlot} (wire pack ${wirePack}, wire slot ${wireSlot})`);
  console.log(APPLY ? 'MODE: APPLY — THIS IS IRREVERSIBLE' : 'MODE: DRY RUN (no 0x08 will be sent)');
  console.log('');

  let conn = connect(CONNECT);
  const reconnect = (): MidiConnection => { conn = reconnectMidi(conn, CONNECT); return conn; };

  // ── BEFORE, oracle 1: the directory listing ────────────────────────
  const dirBefore = await readProjectDirectory(conn, wirePack);
  reportDir('BEFORE dir  ', dirBefore);

  // ── BEFORE, oracle 2: QUERY_EXISTS 0x0d ────────────────────────────
  conn = reconnect();
  const qBefore = await queryExists(conn);
  console.log(`  BEFORE 0x0d : ${qBefore ? `${qBefore.occupied ? 'OCCUPIED' : 'FREE'} raw=[${hex(qBefore.raw)}]${qBefore.crcNibbles ? ` crc-nibbles=${hex(qBefore.crcNibbles)}` : ''}` : 'NO REPLY'}`);

  // ── Identity gate + fresh backup ───────────────────────────────────
  conn = reconnect();
  const r = await downloadProject(conn, wireSlot, { pack: wirePack, reconnect });
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    console.log(`  READ FAILED (ok=${r.ok} crcOk=${r.crcOk} empty=${r.empty ?? false}) ${r.error ?? ''} — refusing to delete a slot we could not read.`);
    exitMidiScript(1);
  }
  const sha = createHash('sha256').update(r.bytes).digest('hex');
  const cur = nameOf(r.bytes);
  console.log(`  stored name : "${cur}"`);
  console.log(`  sha256      : ${sha}`);
  if (cur !== expectName) { console.log(`  REFUSED: name is "${cur}", expected "${expectName}".`); exitMidiScript(1); }
  if (sha !== expectSha) { console.log(`  REFUSED: sha256 does not match --expect-sha256 ${expectSha}.`); exitMidiScript(1); }

  if (!APPLY) {
    console.log('');
    console.log(`  would send ONE frame: [${hex(makeMessage(SUB_DELETE, [FILE_TYPE_PROJECT, wirePack & 0x7f, wireSlot & 0x7f]))}]`);
    endMidiScript(); return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = `samples/circuit-ncs/pre-delete-${stamp}`;
  mkdirSync(backupDir, { recursive: true });
  const backup = `${backupDir}/pack${devicePack}-proj${String(deviceSlot).padStart(2, '0')}.ncs`;
  if (existsSync(backup)) { console.log(`  refusing to overwrite existing backup ${backup}`); exitMidiScript(1); }
  writeFileSync(backup, r.bytes);
  console.log(`  backup      : ${backup} (${r.bytes.length} bytes, device CRC ok)`);

  // ── THE ONE FRAME ──────────────────────────────────────────────────
  conn = reconnect();
  const d = await deleteOnce(conn);
  console.log('');
  console.log(`  SENT (once) : [${hex(d.frame)}]`);
  console.log(`  ACK         : ${d.acked ? `yes [${hex(d.ack ?? [])}]` : 'NO ACK'}`);

  // ── AFTER, past the flush window, on a fresh handle ────────────────
  console.log(`  waiting ${FLUSH_WINDOW_MS} ms past the flash-flush window...`);
  await sleep(FLUSH_WINDOW_MS);
  conn = reconnect();

  const qAfter = await queryExists(conn);
  console.log(`  AFTER 0x0d  : ${qAfter ? `${qAfter.occupied ? 'OCCUPIED' : 'FREE'} raw=[${hex(qAfter.raw)}]${qAfter.crcNibbles ? ` crc-nibbles=${hex(qAfter.crcNibbles)}` : ''}` : 'NO REPLY'}`);

  conn = reconnect();
  const dirAfter = await readProjectDirectory(conn, wirePack);
  reportDir('AFTER dir   ', dirAfter);

  // Third, independent: does the slot still dump bytes?
  conn = reconnect();
  const rAfter = await downloadProject(conn, wireSlot, { pack: wirePack, reconnect });
  console.log(`  AFTER read  : ${rAfter.empty ? 'EMPTY (no READ_INIT)' : `ok=${rAfter.ok} crcOk=${rAfter.crcOk} bytes=${rAfter.bytes?.length ?? 0}`}`);

  console.log('');
  const dirGone = dirAfter.slots[wireSlot]?.name === undefined;
  const queryGone = qAfter !== undefined && !qAfter.occupied;
  console.log(`  VERDICT: directory oracle says ${dirGone ? 'GONE' : 'STILL THERE'}; 0x0d oracle says ${queryGone ? 'GONE' : 'STILL THERE'}.`);
  console.log(`  occupied count ${dirBefore.occupied} -> ${dirAfter.occupied}`);
  console.log(`  Restore if needed: ${backup}`);
  endMidiScript();
}

main().catch((e) => { console.error(e); closeAllMidiConnections(); process.exit(1); });
