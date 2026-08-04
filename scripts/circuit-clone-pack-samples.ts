/**
 * circuit-clone-pack-samples.ts — replicate one pack's 64-slot SAMPLE POOL onto
 * another pack, INDEX-FOR-INDEX.
 *
 * ## Why this exists
 *
 * Sample slot numbers are PACK-RELATIVE. A project's `drum_binding` is a set of
 * raw slot indices, and the same index holds a different sound in every pack, so
 * a project authored against Pack 1's pool is silent (or wrong) on a pack whose
 * pool is empty. Cloning the pool index-for-index is what makes a project
 * portable between packs.
 *
 * ## Source of the audio: the DEVICE, not disk
 *
 * The per-file READ REQUEST (`buildReadFileRequest`, sampleDirectory.ts) is
 * decoded byte-exact from the Components "Get Pack from Circuit Tracks" capture
 * for fileType 0x05 (sample) as well as 0x03/0x04. The device answers with a
 * real WRITE_INIT (carrying the file size), a run of WRITE_DATA blocks, and a
 * WRITE_FINISH with a CRC32 — exactly the shape `downloadProject` already
 * consumes for projects. So we pull the SOURCE pack's actual bytes off the
 * device rather than trusting a disk mirror to still match what is loaded.
 *
 * Read frames only ever open a session, ask for a file, and close. No
 * WRITE_INIT-with-size / WRITE_DATA / WRITE_FINISH / SET_FILENAME is ever sent
 * to the SOURCE pack.
 *
 * The device's own WRITE_FINISH CRC32 gates each download, so a fetched sample
 * is self-validating: a wrong de-interleave cannot pass. That caught the one
 * real bug in this script's first run — the trailing `F7` was left on each
 * frame, so `msbDeinterleave` decoded it as one EXTRA data byte per block and
 * shifted the whole stream. The RIFF size still matched (we truncate to the
 * declared length) and the WAV still parsed; only the CRC said no. Strip the
 * envelope with `core()` exactly as uploadProject.ts does.
 *
 * ## Hardware status: the nonzero-pack sample WRITE is CONFIRMED (2026-07-27)
 *
 * This script's first run was the first on-device exercise of the nonzero-pack
 * sample write path, which had shipped community-beta since 2026-07-17. On the
 * maintainer's own 2-pack device it cloned all 64 of Pack 1's slots onto Pack 2:
 *
 *   - wire slot 0 written alone, then read back from Pack 2's pool: present.
 *   - wire slot 63 written NEXT, out of order, and it landed at 63 — not at the
 *     first free index. That is the proof that the slot byte is ADDRESSED, not
 *     append-ordered, which is the whole premise of an index-preserving clone.
 *   - 8 slots spread across the pool were then downloaded back OFF Pack 2 and
 *     were byte-identical (md5) to the Pack 1 originals.
 *
 * Callers still labelling this path community-beta are now stale: writer.ts
 * (both receipt strings), sampleDirectory.ts `capacity_note`, uploadSample.ts's
 * own docstring, descriptor.ts `verification`, the `pack` tool-arg descriptions,
 * docs/design/circuit-pack-addressing.md, and docs/contributing/devices/
 * circuit-tracks.md. Note that `verify-circuit-ncs.ts` ASSERTS the string
 * "community-beta" appears in the nonzero-pack `capacity_note`, so that gate has
 * to move in the same commit.
 *
 * ## The read-back races the flash commit
 *
 * The Circuit flushes the pack sample manifest ~6-8s AFTER the session CLOSE. A
 * pool read 1.2s later reports "(empty)" for slots that are on their way to
 * flash: the 2026-07-27 run fail-stopped on 8 such slots and a later re-read
 * showed every one of them present. Verification therefore POLLS (reconnect,
 * 9s, then 5s retries) instead of trusting one early read — an absent slot is
 * only a failure once the commit window has demonstrably passed.
 *
 * ## Usage
 *
 *   npx tsx scripts/circuit-clone-pack-samples.ts                      # survey only
 *   npx tsx scripts/circuit-clone-pack-samples.ts --fetch              # + download source audio to disk
 *   npx tsx scripts/circuit-clone-pack-samples.ts --fetch --apply      # + write to the target pack
 *   ... --from 1 --to 2 --cache <dir> --slots 0-7
 *
 * `--from` / `--to` are DEVICE pack numbers (front panel "Pack 1" = 1).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { connect, type MidiConnection } from '../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import {
  readSampleDirectory, buildReadFileRequest, SAMPLE_DIRECTORY_CONSTANTS,
} from '../packages/circuit-tracks/src/ncs/sampleDirectory.js';
import {
  makeMessage, msbDeinterleave, crc32, TRANSFER_CONSTANTS,
} from '../packages/circuit-tracks/src/ncs/transfer.js';
import { uploadSample, uploadSampleKit } from '../packages/circuit-tracks/src/samples/uploadSample.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const FILE_TYPE_SAMPLE = SAMPLE_DIRECTORY_CONSTANTS.FILE_TYPE_SAMPLE;
/**
 * Strip the SysEx envelope, exactly as `core()` in uploadProject.ts does. Both
 * ends matter: leaving the trailing `F7` on makes it the last byte handed to
 * `msbDeinterleave`, which decodes it as one EXTRA data byte per block — the
 * whole stream after block 1 shifts and only the device's CRC catches it.
 */
const core = (msg: readonly number[]): number[] => {
  let b = [...msg];
  if (b[0] === 0xf0) b = b.slice(1);
  if (b[b.length - 1] === 0xf7) b = b.slice(0, -1);
  return b;
};
/** Index of the subcommand byte in a `core()`-stripped frame (6-byte header first). */
const HDR_LEN = TRANSFER_CONSTANTS.HEADER.length; // 6
/** Same nibble decode uploadProject.ts uses for READ_INIT size / WRITE_FINISH CRC. */
const nibblesToInt = (ns: readonly number[]): number => ns.reduce((a, n) => a * 16 + (n & 0xf), 0) >>> 0;

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const FETCH = argv.includes('--fetch');
const APPLY = argv.includes('--apply');
const FROM_DEV = Number(flag('--from') ?? '1');
const TO_DEV = Number(flag('--to') ?? '2');
const CACHE = flag('--cache') ?? 'samples/circuit-tracks/pack-clone-src';
const SLOT_SPEC = flag('--slots');
const BATCH = Math.max(1, Number(flag('--batch') ?? '8'));

const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found (powered on? Components closed?).' } as const;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseSlots(spec: string | undefined): number[] | undefined {
  if (spec === undefined) return undefined;
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`bad --slots segment "${part}"`);
    const a = Number(m[1]); const b = m[2] === undefined ? a : Number(m[2]);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

// ── Sample DOWNLOAD (read-only) ──────────────────────────────────────

interface SampleDownload { ok: boolean; slot: number; bytes?: Uint8Array; crcOk: boolean; empty?: boolean; error?: string }

/**
 * Pull one sample file's bytes off `pack`/`slot`. Mirrors `downloadOnce` in
 * uploadProject.ts (same session shape, same de-interleave + CRC check), but
 * scoped to fileType 0x05 and with no fixed expected length: a sample's size
 * comes from the device's own READ_INIT reply.
 */
async function downloadSample(conn: MidiConnection, pack: number, slot: number, waitMs = 5000): Promise<SampleDownload> {
  const received: number[][] = [];
  const unsub = conn.onMessage((m) => { if (m[0] === 0xf0) received.push(core(m)); });
  const take = async (pred: (m: number[]) => boolean, timeout: number): Promise<number[] | undefined> => {
    const end = Date.now() + timeout;
    for (;;) {
      const i = received.findIndex(pred);
      if (i !== -1) return received.splice(i, 1)[0];
      if (Date.now() >= end) return undefined;
      await sleep(3);
    }
  };
  let started = false;
  try {
    conn.send(makeMessage(SUB.CLOSE_SESSION)); await sleep(200); received.length = 0;
    started = true;
    conn.send(makeMessage(SUB.OPEN_SESSION)); await sleep(300); received.length = 0;
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x01])); await sleep(100); received.length = 0;
    conn.send(makeMessage(SUB.QUERY_INFO, [0x01, 0x00])); await sleep(100); received.length = 0;
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x02])); await sleep(100); received.length = 0;
    conn.send(makeMessage(SUB.DIR_CONTROL, [FILE_TYPE_SAMPLE, pack & 0x7f])); await sleep(500); received.length = 0;
    conn.send(buildReadFileRequest(FILE_TYPE_SAMPLE, pack, slot));

    const init = await take((c) => c[HDR_LEN] === SUB.WRITE_INIT && c.length >= HDR_LEN + 1 + 8 + 3 + 4 + 5, waitMs);
    if (!init) return { ok: false, slot, crcOk: false, empty: true, error: 'no READ_INIT (empty slot)' };
    // READ_INIT tail: 5 size nibbles after [addr(8)][fid(3)][4 fixed bytes].
    const sizeOff = HDR_LEN + 1 + 8 + 3 + 4;
    const declared = nibblesToInt(init.slice(sizeOff, sizeOff + 5));

    const raw: number[] = [];
    let crcRx: number | undefined;
    const end = Date.now() + 120_000;
    while (Date.now() < end) {
      const m = await take((c) => c[HDR_LEN] === SUB.WRITE_DATA || c[HDR_LEN] === SUB.WRITE_FINISH, waitMs);
      if (!m) break;
      if (m[HDR_LEN] === SUB.WRITE_DATA) raw.push(...msbDeinterleave(m.slice(HDR_LEN + 1 + 8 + 3)));
      else { crcRx = nibblesToInt(m.slice(HDR_LEN + 1 + 8 + 3, HDR_LEN + 1 + 8 + 3 + 8)); break; }
    }
    const bytes = Uint8Array.from(declared > 0 ? raw.slice(0, declared) : raw);
    const crcOk = crcRx === crc32(bytes);
    return { ok: bytes.length > 0 && (declared === 0 || bytes.length === declared), slot, bytes, crcOk, error: crcOk ? undefined : `CRC mismatch (declared ${declared}, got ${bytes.length})` };
  } finally {
    if (started) { try { conn.send(makeMessage(SUB.CLOSE_SESSION)); } catch { /* dead handle */ } }
    unsub();
  }
}

// ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const fromWire = FROM_DEV - 1;
  const toWire = TO_DEV - 1;
  const only = parseSlots(SLOT_SPEC);

  console.log(`Circuit Tracks sample-pool clone: Pack ${FROM_DEV} (wire ${fromWire})  ->  Pack ${TO_DEV} (wire ${toWire})`);
  console.log(`MODE: survey${FETCH ? ' + fetch' : ''}${APPLY ? ' + APPLY (writes)' : ''}`);
  if (only) console.log(`slot filter: ${only.join(',')}`);
  console.log('');

  let conn = connect(CONNECT);
  if (!conn.hasInput) { console.log('REFUSED: no input port; every step here needs a bidirectional connection.'); exitMidiScript(2); }

  // ── Phase 1: survey both pools ─────────────────────────────────────
  const src = await readSampleDirectory(conn, fromWire);
  await sleep(300);
  const dst = await readSampleDirectory(conn, toWire);
  await sleep(300);

  const srcNamed = src.slots.filter((s) => s.name !== undefined);
  const dstNamed = dst.slots.filter((s) => s.name !== undefined);
  console.log(`SOURCE Pack ${FROM_DEV}: ${src.occupied}/${src.total} occupied`);
  for (const s of srcNamed) console.log(`   [wire ${String(s.slot).padStart(2)} / device ${String(s.device_slot).padStart(2)}]  ${s.name}`);
  console.log('');
  console.log(`TARGET Pack ${TO_DEV}: ${dst.occupied}/${dst.total} occupied`);
  if (dstNamed.length === 0) console.log('   (pool is empty)');
  for (const s of dstNamed) console.log(`   [wire ${String(s.slot).padStart(2)} / device ${String(s.device_slot).padStart(2)}]  ${s.name}`);
  console.log('');

  if (srcNamed.length === 0) { console.log('REFUSED: source pool is empty, nothing to clone.'); exitMidiScript(1); }

  const plan = srcNamed.filter((s) => only === undefined || only.includes(s.slot));
  console.log(`PLAN: ${plan.length} slot(s) to clone, each landing on the SAME wire index it holds on Pack ${FROM_DEV}.`);
  const collisions = plan.filter((s) => dst.slots[s.slot].name !== undefined);
  for (const c of collisions) console.log(`   OVERWRITE wire ${c.slot}: Pack ${TO_DEV} holds "${dst.slots[c.slot].name}" -> becomes "${c.name}"`);
  console.log('');

  if (!FETCH) { console.log('Survey only. Re-run with --fetch to pull the source audio.'); endMidiScript(); return; }

  // ── Phase 2: fetch source audio off the device ─────────────────────
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  const cachePath = (slot: number, name: string): string => join(CACHE, `p${fromWire}_s${String(slot).padStart(2, '0')}__${name.replace(/[^A-Za-z0-9._-]/g, '_')}`);

  const fetched = new Map<number, { path: string; name: string; bytes: Uint8Array }>();
  for (const s of plan) {
    const p = cachePath(s.slot, s.name!);
    if (existsSync(p)) {
      const bytes = new Uint8Array(readFileSync(p));
      fetched.set(s.slot, { path: p, name: s.name!, bytes });
      console.log(`  wire ${String(s.slot).padStart(2)}  cached   ${bytes.length} bytes  ${s.name}`);
      continue;
    }
    const d = await downloadSample(conn, fromWire, s.slot);
    if (!d.ok || !d.bytes || d.bytes.length === 0) {
      console.log(`  wire ${String(s.slot).padStart(2)}  FAILED   ${d.error ?? 'no bytes'}  ${s.name}`);
      console.log('FAIL-STOP on fetch: refusing to write a partial clone.');
      exitMidiScript(1);
    }
    const riff = String.fromCharCode(...d.bytes.slice(0, 4)) === 'RIFF';
    if (!riff) {
      console.log(`  wire ${String(s.slot).padStart(2)}  NOT A WAV (first 4 bytes ${[...d.bytes.slice(0, 4)].map((b) => b.toString(16)).join(' ')}) — refusing to clone bytes we cannot identify.`);
      exitMidiScript(1);
    }
    writeFileSync(p, d.bytes);
    fetched.set(s.slot, { path: p, name: s.name!, bytes: d.bytes });
    console.log(`  wire ${String(s.slot).padStart(2)}  read ok  ${d.bytes.length} bytes  crc=${d.crcOk ? 'OK' : 'MISMATCH'}  ${s.name}`);
    await sleep(120);
  }
  console.log(`\nfetched ${fetched.size}/${plan.length} source samples into ${CACHE}`);

  if (!APPLY) { console.log('\nFetch complete. Re-run with --fetch --apply to write to the target pack.'); endMidiScript(); return; }

  // ── Phase 3: write to the target pack, in verified batches ─────────
  //
  // The FIRST batch is deliberately size-1 whatever `--batch` says: a nonzero-
  // pack sample write has never been confirmed on hardware, and there is no
  // decoded delete, so the first one is the proving run. Its slot is a slot the
  // clone wants written anyway — nothing speculative is sent.
  console.log(`\nWRITING to Pack ${TO_DEV} (wire ${toWire}). Batch size ${BATCH} (first batch forced to 1); pool re-read after every batch.\n`);
  const reconnect = (): MidiConnection => { conn = reconnectMidi(conn, CONNECT); return conn; };
  const landed: number[] = [];
  const failed: number[] = [];

  let i = 0;
  let first = true;
  while (i < plan.length) {
    const size = first ? 1 : BATCH;
    const group = plan.slice(i, i + size);
    const items = group.map((s) => ({ wav: fetched.get(s.slot)!.bytes, slot: s.slot, filename: fetched.get(s.slot)!.name }));
    const label = group.map((s) => s.slot).join(',');
    const t0 = Date.now();
    const r = items.length === 1
      ? await uploadSample(conn, items[0].wav, items[0].slot, items[0].filename, { packIndex: toWire, reconnect })
      : await uploadSampleKit(conn, items, { packIndex: toWire, reconnect });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!r.ok) {
      console.log(`  wire [${label}]  WRITE FAILED after ${secs}s: ${r.error ?? 'unknown'}`);
      failed.push(...group.map((s) => s.slot));
      console.log(`\nFAIL-STOP. Landed and verified so far: [${landed.join(', ')}]`);
      console.log(`Not written / unverified: [${plan.slice(i).map((s) => s.slot).join(', ')}]`);
      exitMidiScript(1);
    }
    // Independent read-back: the write receipt is an ACK count, not proof the
    // pack manifest committed. Reconnect first — the device restarts its USB
    // stack after a transfer.
    //
    // RETRY, and why it is not papering over a failure: the Circuit flushes the
    // pack sample manifest to flash ~6-8s AFTER the session CLOSE (measured 6.3s
    // and 7.4s in two Components captures). A single read 1.2s after CLOSE
    // therefore reports "(empty)" for slots that are on their way to flash — the
    // 2026-07-27 run fail-stopped on exactly that and a later re-read showed all
    // 8 slots present. So an absent slot is only a failure once the commit window
    // has DEMONSTRABLY passed; poll it out rather than guessing one long sleep.
    let check = { slots: [] as { slot: number; name?: string }[] };
    let bad: typeof group = group;
    for (let attempt = 1; attempt <= 4 && bad.length > 0; attempt++) {
      reconnect();
      await sleep(attempt === 1 ? 9000 : 5000);
      check = await readSampleDirectory(conn, toWire);
      bad = group.filter((s) => check.slots[s.slot]?.name === undefined);
      if (bad.length > 0) console.log(`     (read-back attempt ${attempt}: ${group.length - bad.length}/${group.length} visible, waiting on the flash commit)`);
    }
    for (const s of group) {
      const got = check.slots[s.slot]?.name;
      const okSlot = got !== undefined;
      if (okSlot) landed.push(s.slot);
      console.log(`  wire ${String(s.slot).padStart(2)}  ${okSlot ? 'OK  ' : 'MISS'}  ${fetched.get(s.slot)!.bytes.length}B -> pool reads "${got ?? '(empty)'}"  (${secs}s/batch)`);
    }
    if (bad.length > 0) {
      console.log(`\nFAIL-STOP: ${bad.length} slot(s) acked but did NOT appear in the pool read-back.`);
      console.log(`Landed and verified: [${landed.join(', ')}]`);
      console.log(`Not written: [${plan.slice(i + group.length).map((s) => s.slot).join(', ')}]`);
      exitMidiScript(1);
    }
    console.log(`  --- ${landed.length}/${plan.length} verified ---`);
    i += group.length;
    first = false;
    await sleep(400);
  }

  // ── Phase 4: final independent pool read ───────────────────────────
  await sleep(500);
  const final = await readSampleDirectory(conn, toWire);
  console.log(`\nFINAL Pack ${TO_DEV} pool: ${final.occupied}/${final.total} occupied`);
  let mismatch = 0;
  for (const s of plan) {
    const want = s.name!; const got = final.slots[s.slot]?.name;
    const ok = got === want;
    if (!ok) mismatch++;
    console.log(`   wire ${String(s.slot).padStart(2)}  ${ok ? 'OK  ' : 'DIFF'}  want "${want}"  got "${got ?? '(empty)'}"`);
  }
  console.log(mismatch === 0
    ? `\nVERDICT: PASS. All ${plan.length} slots aligned index-for-index with Pack ${FROM_DEV}.`
    : `\nVERDICT: FAIL. ${mismatch} slot(s) disagree.`);
  endMidiScript(mismatch === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); endMidiScript(1); });
