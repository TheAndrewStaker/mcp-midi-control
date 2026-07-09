/**
 * READ-ONLY: read the Circuit Tracks pack's 64-slot sample directory and print
 * each slot's stored name. Decoded from a real Components capture
 * (docs/design/circuit-sample-upload.md): Components enumerates the pool with a
 * per-slot query `…03 08 05 00 <slot> F7`, and the device replies
 * `…03 0c 05 00 <slot> <ASCII name> F7`. We replay the same open/dir handshake,
 * then query every slot and decode the name. Sends NO write of any kind.
 *
 * Requires the "Circuit Tracks" port to be FREE (close Novation Components).
 *
 *   npx tsx scripts/circuit-read-sample-directory.ts
 */
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { makeMessage, TRANSFER_CONSTANTS } from '@mcp-midi-control/circuit-tracks/ncs/transfer.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const FILE_TYPE_SAMPLE = 0x05;
const QUERY_CRC = 0x0d;    // host → device: "slot N occupancy/CRC" (enumeration pass)
const QUERY_NAME = 0x08;   // host → device: "give me slot N's info"
const REPLY_NAME = 0x0c;   // device → host: fileId + ASCII name
const DEBUG = process.argv.includes('--debug');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ascii = (a: readonly number[]) => a.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '')).join('');

async function main(): Promise<void> {
  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found (is Components still holding the port?).' });
  if (!conn.hasInput) { console.error('No input port — the directory read needs a bidirectional connection.'); conn.close(); process.exit(2); }
  try {
    // DEBUG: tally every inbound SysEx so we can see what the device actually
    // returns (subcmd at index 7 of the raw F0..F7 message).
    const inTally: Record<number, number> = {};
    let firstReplies: number[][] = [];
    const unsub = conn.onMessage((m) => {
      if (m[0] !== 0xf0) return;
      const sub = m[7];
      inTally[sub] = (inTally[sub] ?? 0) + 1;
      if (DEBUG && firstReplies.length < 8) firstReplies.push(m);
    });

    // Replay the captured open + directory handshake (drain replies).
    const prelude: number[][] = [
      makeMessage(SUB.OPEN_SESSION),
      makeMessage(SUB.DIR_CONTROL, [0x01]),
      makeMessage(SUB.QUERY_INFO, [0x01, 0x00]),
      makeMessage(SUB.DIR_CONTROL, [0x02]),
      makeMessage(SUB.DIR_CONTROL, [FILE_TYPE_SAMPLE, 0x00]),
    ];
    for (const msg of prelude) {
      const replyP = conn.receiveSysEx(400).catch(() => [] as number[]);
      conn.send(msg);
      await replyP;
    }

    // Enumeration pass: 0x0d per slot (this is what Components does first; the
    // device appears to need it before it will answer 0x08 name queries).
    for (let slot = 0; slot < 64; slot++) {
      const replyP = conn
        .receiveSysExMatching((m) => m[7] === QUERY_CRC && m[8] === FILE_TYPE_SAMPLE && m[10] === slot, 250)
        .catch(() => [] as number[]);
      conn.send(makeMessage(QUERY_CRC, [FILE_TYPE_SAMPLE, 0x00, slot]));
      await replyP;
    }

    const names: (string | undefined)[] = [];
    for (let slot = 0; slot < 64; slot++) {
      // Register the matcher BEFORE send (the sync-throw-safe order).
      const replyP = conn
        .receiveSysExMatching((m) => m[7] === REPLY_NAME && m[8] === FILE_TYPE_SAMPLE && m[10] === slot, 250)
        .catch(() => [] as number[]);
      conn.send(makeMessage(QUERY_NAME, [FILE_TYPE_SAMPLE, 0x00, slot]));
      const reply = await replyP;
      names[slot] = reply.length ? ascii(reply.slice(11, reply.length - 1)) : undefined;
    }
    unsub();
    if (DEBUG) {
      const hx = (a: number[]) => a.map((x) => x.toString(16).padStart(2, '0')).join(' ');
      console.log('inbound subcmd tally:', Object.entries(inTally).map(([s, c]) => `0x${(+s).toString(16)}:${c}`).join('  ') || '(none)');
      for (const m of firstReplies) console.log('  reply:', hx(m.slice(0, Math.min(m.length, 24))));
      console.log('');
    }
    const filled = names.filter((n) => n).length;
    console.log(`Sample directory — ${filled}/64 slots occupied:\n`);
    for (let s = 0; s < 64; s++) {
      const dev = s + 1; // device shows 1..64
      console.log(`  slot ${String(dev).padStart(2)}  ${names[s] ?? '(empty)'}`);
    }
  } finally {
    // ALWAYS end the session, even on an early error — otherwise the device is
    // left on its file-transfer screen waiting for a close (the wedge we hit).
    try { conn.send(makeMessage(SUB.CLOSE_SESSION)); await sleep(50); } catch { /* handle already dead */ }
    conn.close();
  }
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
