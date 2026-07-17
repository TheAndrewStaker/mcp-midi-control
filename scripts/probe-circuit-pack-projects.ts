/**
 * probe-circuit-pack-projects — list ONE pack's stored projects by name, in a
 * single round trip.
 *
 * Exercises the 2026-07-16 pack-addressing decode end-to-end: scope a session to
 * `DIR_CONTROL([0x03, pack])` and parse the header + DIR_ENTRY replies, instead
 * of probing 64 slots at ~6 s each. Entries come back only for OCCUPIED slots,
 * so anything absent is free.
 *
 * READ-ONLY: sends only OPEN_SESSION / DIR_CONTROL / QUERY_INFO / CLOSE_SESSION.
 *
 *   npx tsx scripts/probe-circuit-pack-projects.ts [pack]     # pack = 1-based, default 1
 */
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { makeMessage, TRANSFER_CONSTANTS } from '@mcp-midi-control/circuit-tracks/ncs/transfer.js';
import { parseDirListHeader, parseDirEntry } from '@mcp-midi-control/circuit-tracks/ncs/sampleDirectory.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const FILE_TYPE_PROJECT = 0x03;
const SLOT_COUNT = 64;

const devicePack = Number(process.argv[2] ?? 1);
if (!Number.isInteger(devicePack) || devicePack < 1 || devicePack > 32) {
  console.error(`pack must be 1..32 (as the front panel shows it), got ${process.argv[2]}`);
  process.exit(1);
}
const pack = devicePack - 1; // wire index is 0-based

async function main(): Promise<void> {
  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found (Components closed?).' });
  try {
    if (!conn.hasInput) { console.error('Needs a bidirectional connection.'); process.exit(1); }

    for (const msg of [
      makeMessage(SUB.OPEN_SESSION),
      makeMessage(SUB.DIR_CONTROL, [0x01]),
      makeMessage(SUB.QUERY_INFO, [0x01, 0x00]),
      makeMessage(SUB.DIR_CONTROL, [0x02]),
    ]) {
      const p = conn.receiveSysEx(400).catch(() => [] as number[]);
      conn.send(msg);
      await p;
    }
    await conn.receiveSysEx(40).catch(() => undefined);

    const headerP = conn
      .receiveSysExMatching((m) => m[7] === SUB.DIR_CONTROL && m[8] === FILE_TYPE_PROJECT && m.length === 13, 600)
      .catch(() => [] as number[]);
    conn.send(makeMessage(SUB.DIR_CONTROL, [FILE_TYPE_PROJECT, pack]));
    const header = parseDirListHeader(await headerP);

    if (!header) {
      console.log(`Pack ${devicePack} (wire ${pack}): no listing header came back.`);
      return;
    }
    console.log(`Pack ${devicePack} (wire index ${pack}): ${header.count} occupied project slot(s).\n`);

    const found = new Map<number, string>();
    for (let i = 0; i < header.count; i++) {
      const reply = await conn
        .receiveSysExMatching((m) => m[7] === 0x0c && m[8] === FILE_TYPE_PROJECT, 600)
        .catch(() => [] as number[]);
      const e = parseDirEntry(reply);
      if (!e) break;
      found.set(e.slot, e.name);
    }

    for (const [slot, name] of [...found].sort((a, b) => a[0] - b[0])) {
      console.log(`  slot ${String(slot).padStart(2)}  (Project ${String(slot + 1).padStart(2)})   "${name}"`);
    }
    if (found.size < header.count) {
      console.log(`\n  (only ${found.size} of ${header.count} entries arrived before timeout)`);
    }

    // Longest run of consecutive free slots — what an arrangement needs.
    let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
    for (let s = 0; s < SLOT_COUNT; s++) {
      if (!found.has(s)) {
        if (curLen === 0) curStart = s;
        curLen++;
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
      } else curLen = 0;
    }
    console.log(`\n  Free slots: ${SLOT_COUNT - found.size}/${SLOT_COUNT}. Longest free run: ${bestLen} starting at slot ${bestStart} (Project ${bestStart + 1}).`);
  } finally {
    try { conn.send(makeMessage(SUB.CLOSE_SESSION)); } catch { /* best effort */ }
    conn.close();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
