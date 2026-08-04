/**
 * Persist the hardware-confirmed M>PCR configuration as a named VE-500 patch at
 * U97 (maintainer-named location, 2026-07-26).
 *
 * Standalone (runs from SOURCE via tsx, no dist build). Three phases, chosen by
 * argv[2]:
 *
 *   inspect - SAFETY READ, non-destructive. Reads the ACTIVE edit buffer's
 *             M>PCR state, then reads U97's STORED contents at its own user-patch
 *             address (0x04040000 + 0x40000*96) WITHOUT recalling it, so the live
 *             buffer is never disturbed. Writes a full JSON backup of U97 under
 *             samples/ve-500/ and reports how far U97 differs from factory init.
 *   store   - re-asserts the two patch-level M>PCR params if the buffer lost them,
 *             writes the 16-char patch name, then stores the buffer to U97 behind
 *             the editor comm-mode handshake the 2026-07-08 session proved a store
 *             needs. Verifies by reading U97's STORED address back afterwards,
 *             which is an address this run never wrote to directly.
 *   verify  - the read-back leg on its own.
 *
 * Recall is deliberately NOT used anywhere here. The unit currently has
 * `system_midi.midi_program_change_in = 0`, so the bare-Program-Change recall path
 * for U01..U99 is dead, and recalling would also wipe the live buffer this script
 * exists to preserve. Reading a stored patch at its own address needs neither.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect } from '../packages/core/src/midi/transport.js';
import { PADDING } from '../packages/roland-midi/src/shared/index.js';
import {
  findParam,
  buildGetParam,
  buildSetParam,
  paramReplyMatcher,
  decodeParamReply,
  buildCommMode,
  buildSavePreset,
  buildSetPatchName,
  saveAckMatcher,
  userPatchAddr,
  VE500_PARAMS,
} from '../packages/roland-midi/src/ve-500/index.js';

const mode = (process.argv[2] ?? 'inspect') as 'inspect' | 'store' | 'verify';

/** U97: 1-based user memory 97, 0-based store index 96. */
const U97 = 97;
const U97_STORE_INDEX = U97 - 1;
const U97_BASE = userPatchAddr(U97);

/**
 * 16 ASCII chars is the hard limit: `common.patch_name` is size 16 (raw byte
 * count = ASCII), space-padded, each char masked to 7 bits
 * (`roland-midi/shared/packValue.ts`). This name is exactly 16, so nothing is
 * truncated and no padding is added. ">" is in the unit's own font: the device
 * calls this feature "M>PCR" in its own menus.
 */
const PATCH_NAME = 'M>PCR MICROFREAK';

const VE = ['ve-500', 've500'];
const TIMEOUT_MS = 400;

type Val = number | string | undefined;

function def(block: string, name: string) {
  const d = findParam(block, name);
  if (!d) throw new Error(`UNRESOLVED param '${block}.${name}'`);
  return d;
}

async function read(
  conn: ReturnType<typeof connect>,
  block: string,
  name: string,
  patchBase?: number,
): Promise<Val> {
  const d = def(block, name);
  const opts = patchBase === undefined ? undefined : { patchBase };
  const waiter = conn
    .receiveSysExMatching(paramReplyMatcher(d, opts), TIMEOUT_MS)
    .catch(() => undefined);
  conn.send(buildGetParam(d, opts));
  const reply = await waiter;
  return reply === undefined ? undefined : decodeParamReply(d, reply, opts);
}

function show(v: Val): string {
  if (v === undefined) return 'NO REPLY';
  return typeof v === 'string' ? `"${v}"` : String(v);
}

function label(block: string, name: string, v: Val): string {
  const d = findParam(block, name);
  const e = typeof v === 'number' ? d?.enum_values?.[v] : undefined;
  return e ? `${v} (${e})` : show(v);
}

/** The five values the 2026-07-26 bring-up set, three of them SYSTEM globals. */
const BRINGUP = [
  { block: 'pitch_correct', name: 'switch', want: 1, scope: 'patch' },
  { block: 'pitch_correct_midi', name: 'midi_to_pcr', want: 2, scope: 'patch' },
  { block: 'system_pitch_correct_midi', name: 'midi_to_pcr', want: 2, scope: 'system' },
  { block: 'system_pref', name: 'preference_m2pcr', want: 0, scope: 'system' },
  { block: 'system_midi', name: 'midi_program_change_in', want: 0, scope: 'system' },
] as const;

async function readBuffer(conn: ReturnType<typeof connect>): Promise<void> {
  console.log('\n=== ACTIVE EDIT BUFFER ===');
  console.log(`common.patch_name${' '.repeat(29)} = ${show(await read(conn, 'common', 'patch_name'))}`);
  for (const b of BRINGUP) {
    const key = `${b.block}.${b.name}`;
    console.log(`${key.padEnd(46)} = ${label(b.block, b.name, await read(conn, b.block, b.name))}  [${b.scope}]`);
  }
}

/** Full non-destructive read of U97's STORED patch region, straight from flash. */
async function dumpStored(conn: ReturnType<typeof connect>): Promise<{
  entries: Array<{ block: string; param: string; wire: Val; init: number | string; differs: boolean }>;
  noReply: number;
}> {
  const entries: Array<{ block: string; param: string; wire: Val; init: number | string; differs: boolean }> = [];
  let noReply = 0;
  let done = 0;
  for (const d of VE500_PARAMS) {
    if (d.size & PADDING) continue; // reserved filler, nothing to back up
    const opts = { patchBase: U97_BASE };
    const waiter = conn
      .receiveSysExMatching(paramReplyMatcher(d, opts), TIMEOUT_MS)
      .catch(() => undefined);
    conn.send(buildGetParam(d, opts));
    const reply = await waiter;
    const wire = reply === undefined ? undefined : decodeParamReply(d, reply, opts);
    if (wire === undefined) noReply++;
    entries.push({
      block: d.block,
      param: d.param,
      wire,
      init: d.init,
      differs: wire !== undefined && String(wire) !== String(d.init),
    });
    if (++done % 100 === 0) console.log(`  ...${done} params read (${noReply} no-reply)`);
  }
  return { entries, noReply };
}

async function main(): Promise<void> {
  const conn = connect({ needles: VE, notFoundLeadIn: 'VE-500 not found.' });

  if (mode === 'inspect') {
    await readBuffer(conn);

    console.log(`\n=== U97 STORED CONTENTS (read at 0x${U97_BASE.toString(16)}, NOT recalled) ===`);
    const storedName = await read(conn, 'common', 'patch_name', U97_BASE);
    console.log(`U97 patch name = ${show(storedName)}`);
    for (const b of BRINGUP.filter((x) => x.scope === 'patch')) {
      console.log(`U97 ${`${b.block}.${b.name}`.padEnd(42)} = ${label(b.block, b.name, await read(conn, b.block, b.name, U97_BASE))}`);
    }

    console.log('\nFull backup dump of U97 (every non-reserved patch param):');
    const { entries, noReply } = await dumpStored(conn);
    const changed = entries.filter((e) => e.differs);
    mkdirSync('samples/ve-500', { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = `samples/ve-500/U97-backup-${stamp}.json`;
    writeFileSync(
      path,
      JSON.stringify(
        {
          captured: new Date().toISOString(),
          location: 'U97',
          patch_base: `0x${U97_BASE.toString(16)}`,
          method: 'RQ1 per catalog param at the user-patch base; the patch was NOT recalled',
          patch_name: storedName,
          params_read: entries.length,
          no_reply: noReply,
          differs_from_init: changed.length,
          entries,
        },
        null,
        1,
      ),
    );
    console.log(`\n  params read : ${entries.length} (${noReply} no reply)`);
    console.log(`  differ from factory init : ${changed.length}`);
    if (changed.length > 0) {
      console.log('  first 40 differences:');
      for (const c of changed.slice(0, 40)) {
        console.log(`    ${`${c.block}.${c.param}`.padEnd(46)} stored=${show(c.wire)}  init=${show(c.init)}`);
      }
    }
    console.log(`  BACKUP WRITTEN: ${path}`);
    conn.close();
    return;
  }

  if (mode === 'store') {
    await readBuffer(conn);

    // 1. Re-assert the two PATCH-level values if the buffer lost them. The three
    //    SYSTEM globals are deliberately NOT touched: they are already correct and
    //    they are not part of a patch.
    console.log('\n=== RE-ASSERT PATCH-LEVEL M>PCR PAIR ===');
    for (const b of BRINGUP.filter((x) => x.scope === 'patch')) {
      const cur = await read(conn, b.block, b.name);
      if (cur === b.want) {
        console.log(`${`${b.block}.${b.name}`.padEnd(46)} already ${label(b.block, b.name, cur)}, left alone`);
        continue;
      }
      conn.send(buildSetParam(def(b.block, b.name), b.want));
      await new Promise((r) => setTimeout(r, 60));
      const post = await read(conn, b.block, b.name);
      console.log(`${`${b.block}.${b.name}`.padEnd(46)} ${show(cur)} -> ${label(b.block, b.name, post)}  ${post === b.want ? 'OK' : 'NOT CONFIRMED'}`);
    }

    // 2. Name the buffer.
    console.log('\n=== NAME ===');
    conn.send(buildSetPatchName(PATCH_NAME));
    await new Promise((r) => setTimeout(r, 120));
    const nameBack = await read(conn, 'common', 'patch_name');
    console.log(`buffer patch_name = ${show(nameBack)}  (${PATCH_NAME.length}/16 chars)`);

    // 3. Store behind the comm-mode handshake (2026-07-08 hardware-confirmed
    //    procedure: mode ON, then STORE, then wait for the device's own echo of
    //    the store command address. That session did NOT send mode OFF afterwards
    //    and the editor itself leaves it on for the whole connection, so neither
    //    does this).
    console.log('\n=== STORE -> U97 ===');
    conn.send(buildCommMode(true));
    const ackWaiter = conn.receiveSysExMatching(saveAckMatcher(), 1000).catch(() => undefined);
    conn.send(buildSavePreset(U97_STORE_INDEX));
    const ack = await ackWaiter;
    console.log(`store index ${U97_STORE_INDEX} (U97): device store-echo ${ack ? 'RECEIVED' : 'NOT SEEN'}`);
  }

  // 4. Verify from FLASH, not from the buffer and not from the ack.
  await new Promise((r) => setTimeout(r, 300));
  console.log(`\n=== VERIFY: read U97 STORED at 0x${U97_BASE.toString(16)} ===`);
  console.log(`U97 patch_name = ${show(await read(conn, 'common', 'patch_name', U97_BASE))}`);
  for (const b of BRINGUP.filter((x) => x.scope === 'patch')) {
    const v = await read(conn, b.block, b.name, U97_BASE);
    console.log(`U97 ${`${b.block}.${b.name}`.padEnd(42)} = ${label(b.block, b.name, v)}  ${v === b.want ? 'CONFIRMED' : 'NOT CONFIRMED'}`);
  }

  conn.close();
}

await main();
process.exit(0);
