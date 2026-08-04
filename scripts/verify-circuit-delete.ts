/**
 * verify-circuit-delete: offline goldens for `delete_project`, the only
 * operation in this server that makes stored content stop existing.
 *
 * No hardware. A mock Circuit models a pack of projects and serves all four
 * exchanges the feature uses (directory listing, existence query, delete, and
 * the project download the pre-delete backup takes), so the whole flow AND
 * every refusal runs deterministically in milliseconds.
 *
 * WHAT THIS FILE IS FOR (read before trimming it):
 *
 * The frame goldens are the small half. The large half is the REFUSALS, because
 * on a device with no undo, a gate that silently stopped working would not fail
 * loudly, it would delete something. Every gate in `dispatcher/deleteProject.ts`
 * has a case here, and each case asserts the error CODE and a distinguishing
 * phrase of the message, not merely that something threw: two gates that both
 * throw are indistinguishable to a caller, and the message is the part an agent
 * has to act on.
 *
 * One case is worth naming. `post-delete refusal shape` covers a real
 * mis-scoring from 2026-07-29: a verification whose matcher accepted only the
 * OCCUPIED reply shape saw the device's free-slot answer (a DIFFERENT
 * subcommand) as an unmatched reply and reported a successfully erased project
 * "still there". The obvious next move after reading that is to send the delete
 * again. So the refusal shape is asserted here as a first-class expected
 * answer, and separately as byte-identical to a never-occupied control slot.
 *
 * Run:  npx tsx scripts/verify-circuit-delete.ts
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { DispatchError, type DeviceDescriptor } from '@mcp-midi-control/core/protocol-generic/types.js';
import { registerDevice, unregisterDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { ensureConnection, registerConnector } from '@mcp-midi-control/core/server-shared/connections.js';
import { executeDeleteProject, MAX_DELETES_PER_CALL } from '@mcp-midi-control/core/protocol-generic/dispatcher/deleteProject.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '@mcp-midi-control/circuit-tracks/descriptor.js';
import { NCS_FILE_SIZE, NCS_MAGIC, NCS_TOTAL_SESSION_SIZE_OFFSET } from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import {
  blockAddress, crc32, intToNibbles, makeMessage, msbInterleave, TRANSFER_CONSTANTS,
} from '@mcp-midi-control/circuit-tracks/ncs/transfer.js';
import {
  buildDeleteFile, buildQueryExists, isDeleteAckFor, parseExistsReply, FILE_TYPE,
} from '@mcp-midi-control/circuit-tracks/ncs/fileDelete.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) { console.log(`  OK    ${label}`); return; }
  failed++;
  console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
}

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const BLOCK = TRANSFER_CONSTANTS.BLOCK_SIZE;
const hex = (b: readonly number[]): string => b.map((x) => x.toString(16).padStart(2, '0')).join('');

// ── 1. Wire goldens ──────────────────────────────────────────────────
//
// Sourced from the capture-order decode of
// `samples/captured/send-pack-to-circuit-tracks-sleep-token-and-roland-samples-06-27-2026.pcapng`,
// where Novation Components erases project slot 6 of pack 0. The exchange in
// that capture, verbatim:
//
//   OUT  f0 00 20 29 01 64 03 0d 03 00 06 f7                    QUERY_EXISTS
//   IN   f0 00 20 29 01 64 03 0d 03 00 06 07 0b 0b 0b 09 03 0e 06 f7   occupied, crc 0x7bbb93e6
//   OUT  f0 00 20 29 01 64 03 08 03 00 06 f7                    DELETE_FILE
//   IN   f0 00 20 29 01 64 03 04 00 00 00 00 00 00 00 00 03 00 06 f7   ack
//
// A free slot instead answers `f0 00 20 29 01 64 03 05 00 …00 07 f7`.
function wireGoldens(): void {
  console.log('\nwire goldens (byte-exact against the Components capture)');

  check('DELETE_FILE(project, pack 0, slot 6) is the exact 12-byte frame',
    hex(buildDeleteFile(FILE_TYPE.PROJECT, 0, 6)) === 'f000202901640308030006f7',
    hex(buildDeleteFile(FILE_TYPE.PROJECT, 0, 6)));
  check('DELETE_FILE is 12 bytes', buildDeleteFile(FILE_TYPE.PROJECT, 0, 6).length === 12);
  check('QUERY_EXISTS(project, pack 0, slot 6) is the exact 12-byte frame',
    hex(buildQueryExists(FILE_TYPE.PROJECT, 0, 6)) === 'f00020290164030d030006f7',
    hex(buildQueryExists(FILE_TYPE.PROJECT, 0, 6)));

  // The pack byte is the one most likely to be wrong and the one that decides
  // WHICH project is destroyed, so it gets its own golden at a nonzero value.
  check('DELETE_FILE carries the pack byte (Pack 5 = wire 4, project 11 = wire 10)',
    hex(buildDeleteFile(FILE_TYPE.PROJECT, 4, 10)) === 'f00020290164030803040af7',
    hex(buildDeleteFile(FILE_TYPE.PROJECT, 4, 10)));
  // The frame the 2026-07-29 hardware verify actually sent, kept as its own
  // golden so the confirmed capability and the shipped encoder cannot drift.
  check('DELETE_FILE matches the frame the hardware verify sent (Pack 1, project 11)',
    hex(buildDeleteFile(FILE_TYPE.PROJECT, 0, 10)) === 'f00020290164030803000af7',
    hex(buildDeleteFile(FILE_TYPE.PROJECT, 0, 10)));
  // Sample/patch fileTypes are decoded but NOT wired to a tool. Goldened so the
  // builder stays honest if one is ever exposed.
  check('DELETE_FILE encodes the sample fileType too (decoded, not exposed)',
    hex(buildDeleteFile(FILE_TYPE.SAMPLE, 0, 0)) === 'f000202901640308050000f7');

  const occupied = [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x0d, 0x03, 0x00, 0x06,
    0x07, 0x0b, 0x0b, 0x0b, 0x09, 0x03, 0x0e, 0x06, 0xf7];
  const free = [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x05,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x07, 0xf7];
  const ack = [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x04, ...blockAddress(0), 0x03, 0x00, 0x06, 0xf7];

  const v = parseExistsReply(occupied, FILE_TYPE.PROJECT, 0, 6);
  check('occupied reply parses, and its CRC is the captured 0x7bbb93e6',
    v?.status === 'occupied' && v.crc32 === 0x7bbb93e6, JSON.stringify(v));
  check('free reply parses as FREE, not as an unmatched frame',
    parseExistsReply(free, FILE_TYPE.PROJECT, 0, 6)?.status === 'free');
  check('delete ack matches its own fileId', isDeleteAckFor(ack, FILE_TYPE.PROJECT, 0, 6));

  // The occupied answer AUTHORISES a delete, so a reply about a NEIGHBOURING
  // slot must not satisfy it. This is the mistake that erases the wrong project.
  check('occupied reply for slot 6 is NOT accepted as slot 7\'s',
    parseExistsReply(occupied, FILE_TYPE.PROJECT, 0, 7) === undefined);
  check('occupied reply for pack 0 is NOT accepted as pack 4\'s',
    parseExistsReply(occupied, FILE_TYPE.PROJECT, 4, 6) === undefined);
  check('delete ack for slot 6 is NOT accepted as slot 7\'s',
    !isDeleteAckFor(ack, FILE_TYPE.PROJECT, 0, 7));
  check('a truncated reply is UNKNOWN, never occupied and never free',
    parseExistsReply(occupied.slice(0, 14), FILE_TYPE.PROJECT, 0, 6) === undefined);
  check('silence is UNKNOWN, never free',
    parseExistsReply([], FILE_TYPE.PROJECT, 0, 6) === undefined);
}

// ── 2. Mock device ───────────────────────────────────────────────────

/** A structurally valid, uniquely-named 160,780-byte project. */
function makeProject(name: string, seed: number): Uint8Array {
  const buf = new Uint8Array(NCS_FILE_SIZE);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + seed) & 0xff;
  for (let i = 0; i < NCS_MAGIC.length; i++) buf[i] = NCS_MAGIC.charCodeAt(i);
  new DataView(buf.buffer).setUint32(NCS_TOTAL_SESSION_SIZE_OFFSET, NCS_FILE_SIZE, true);
  const n = name.padEnd(16, ' ').slice(0, 16);
  for (let i = 0; i < 16; i++) buf[0x10 + i] = n.charCodeAt(i) & 0x7f;
  return buf;
}

interface MockOptions {
  /** Wire slot -> project bytes. Anything absent is a free slot. */
  contents: Map<number, Uint8Array>;
  /** Wire slots whose existence query never answers (occupancy unreadable). */
  silentSlots?: Set<number>;
  /** Wire slots the directory lists but the existence query calls free (oracle disagreement). */
  directoryOnly?: Set<number>;
  /** Refuse to serve the project download, so the pre-delete backup cannot be taken. */
  failDownload?: boolean;
  /** Accept + ack the delete but keep the file, so the post-delete checks fail. */
  ignoreDelete?: boolean;
  pack?: number;
}

/**
 * Build a mock Circuit as a CONNECTION FACTORY over shared card state, not as a
 * single connection object.
 *
 * That distinction is load-bearing. `ensureConnection(label, true)` closes the
 * cached handle and calls the factory for a new one, and the writer force-
 * reconnects before every transfer. A mock that handed back the same object
 * every time would make a stale-handle bug invisible: the production code can
 * hold a reference to a handle that has since been closed and replaced, and the
 * mock would happily keep answering on it. Here each connection has its own
 * listeners and queues (as a real fresh handle does) and REFUSES to send once
 * closed, so using a superseded handle fails the way it fails on hardware.
 * This is exactly how the post-delete verification was caught reading a dead
 * port after the writer's reconnect.
 */
function mockCircuitFactory(opts: MockOptions): { factory: () => MidiConnection; sent: number[][] } {
  const pack = opts.pack ?? 0;
  const sent: number[][] = [];
  const factory = (): MidiConnection => makeConn(opts, pack, sent);
  return { factory, sent };
}

function makeConn(opts: MockOptions, pack: number, sent: number[][]): MidiConnection {
  const handlers = new Set<(m: number[]) => void>();
  const backlog: number[][] = [];
  const waiters: { pred: (m: number[]) => boolean; resolve: (v: number[]) => void; timer?: NodeJS.Timeout }[] = [];
  let closed = false;

  const deliver = (msg: number[]): void => {
    for (const h of handlers) h(msg);
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i !== -1) {
      const w = waiters.splice(i, 1)[0];
      if (w.timer) clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      backlog.push(msg);
    }
  };
  const register = (pred: (m: number[]) => boolean, timeoutMs = 1000): Promise<number[]> => {
    const i = backlog.findIndex(pred);
    if (i !== -1) return Promise.resolve(backlog.splice(i, 1)[0]);
    return new Promise<number[]>((resolve, reject) => {
      const w: (typeof waiters)[number] = { pred, resolve };
      waiters.push(w);
      w.timer = setTimeout(() => {
        const j = waiters.indexOf(w);
        if (j !== -1) waiters.splice(j, 1);
        reject(new Error('mock receive timeout'));
      }, Math.min(timeoutMs, 250));
    });
  };

  const nameOf = (slot: number): string => {
    const buf = opts.contents.get(slot);
    if (!buf) return '';
    let s = '';
    for (let i = 0x10; i < 0x20; i++) s += String.fromCharCode(buf[i] & 0x7f);
    return s.trimEnd();
  };

  const respond = (bytes: number[]): void => {
    const sub = bytes[7];
    // Directory listing for this fileType + pack: header then one entry per
    // occupied slot, exactly the shape sampleDirectory.ts parses.
    if (sub === SUB.DIR_CONTROL && bytes[8] === FILE_TYPE.PROJECT && bytes[9] === pack) {
      const listed = [...opts.contents.keys(), ...(opts.directoryOnly ?? [])].sort((a, b) => a - b);
      deliver([0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, SUB.DIR_CONTROL,
        FILE_TYPE.PROJECT, pack, listed.length & 0x7f, (listed.length >> 7) & 0x7f, 0xf7]);
      for (const slot of listed) {
        const label = `${String(slot).padStart(2, '0')}_${nameOf(slot) || 'SESSION'}.ncs`;
        deliver([0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x0c, FILE_TYPE.PROJECT, pack, slot,
          ...[...label].map((c) => c.charCodeAt(0) & 0x7f), 0xf7]);
      }
      return;
    }
    if (sub === SUB.QUERY_EXISTS && bytes[8] === FILE_TYPE.PROJECT && bytes[9] === pack) {
      const slot = bytes[10];
      if (opts.silentSlots?.has(slot)) return;   // no answer at all
      const buf = opts.contents.get(slot);
      if (buf === undefined) {
        // THE REFUSAL. A different subcommand from the occupied record, which
        // is exactly what the 2026-07-29 verification's matcher missed.
        deliver([0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, SUB.EMPTY_RECORD,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x07, 0xf7]);
        return;
      }
      deliver([0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, SUB.QUERY_EXISTS,
        FILE_TYPE.PROJECT, pack, slot, ...intToNibbles(crc32(buf), 8), 0xf7]);
      return;
    }
    if (sub === SUB.DELETE_FILE && bytes[8] === FILE_TYPE.PROJECT && bytes[9] === pack) {
      const slot = bytes[10];
      if (!opts.ignoreDelete) opts.contents.delete(slot);
      deliver([0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, SUB.ACK, ...blockAddress(0),
        FILE_TYPE.PROJECT, pack, slot, 0xf7]);
      return;
    }
    // Project download (the pre-delete backup): a read WRITE_INIT, trailing 0x02.
    if (sub === SUB.WRITE_INIT && bytes[bytes.length - 2] === 0x02) {
      if (opts.failDownload) return;
      const slot = bytes[18];
      const buf = opts.contents.get(slot);
      if (!buf) return;   // no READ_INIT = empty slot
      const fid = [FILE_TYPE.PROJECT, pack, slot];
      deliver(makeMessage(SUB.WRITE_INIT, [...blockAddress(0), ...fid, 0x01, 0x00, 0x00, 0x00, ...intToNibbles(buf.length, 5)]));
      const blocks = Math.ceil(buf.length / BLOCK);
      for (let b = 1; b <= blocks; b++) {
        deliver(makeMessage(SUB.WRITE_DATA, [...blockAddress(b), ...fid, ...msbInterleave(buf.subarray((b - 1) * BLOCK, b * BLOCK))]));
      }
      deliver(makeMessage(SUB.WRITE_FINISH, [...blockAddress(blocks + 1), ...fid, ...intToNibbles(crc32(buf), 8)]));
      return;
    }
    if (sub === SUB.OPEN_SESSION || sub === SUB.DIR_CONTROL || sub === SUB.QUERY_INFO) {
      deliver([0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, sub, 0x00, 0xf7]);
    }
  };

  /**
   * A new session starts with an empty inbound queue. Without this the mock is
   * LESS realistic than hardware, not more: the project download reads through
   * `onMessage` and never drains the `receiveSysExMatching` queue, so its
   * directory listing would sit in the backlog and be served to the NEXT
   * session's listing read, which then reports pre-delete occupancy. Real
   * connections have no such backlog, and the production code drains between
   * phases for exactly this class of desync.
   */
  const resetOnSessionBoundary = (sub: number): void => {
    if (sub === SUB.OPEN_SESSION || sub === SUB.CLOSE_SESSION) backlog.length = 0;
  };

  return {
    hasInput: true,
    isPortOpen: () => !closed,
    close: () => { closed = true; handlers.clear(); backlog.length = 0; },
    send: (bytes: number[]) => {
      if (closed) throw new Error('mock: send on a CLOSED handle (this handle was superseded by a reconnect)');
      sent.push([...bytes]);
      resetOnSessionBoundary(bytes[7]);
      respond(bytes);
    },
    onMessage: (h: (m: number[]) => void) => { handlers.add(h); return () => handlers.delete(h); },
    receiveSysEx: (t?: number) => register(() => true, t),
    receiveSysExMatching: (pred: (m: number[]) => boolean, t?: number) => register(pred, t),
  } as unknown as MidiConnection;
}

// ── 3. Gate + flow tests through the real dispatcher ────────────────

const PORT = 'circuit';
const LABEL = CIRCUIT_TRACKS_DESCRIPTOR.connection_label ?? CIRCUIT_TRACKS_DESCRIPTOR.id;

async function expectRefusal(
  label: string, code: string, phrase: string, run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
    check(label, false, 'the call SUCCEEDED; it was supposed to refuse');
  } catch (err) {
    if (!(err instanceof DispatchError)) {
      check(label, false, `threw a plain Error, not a DispatchError: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const codeOk = err.code === code;
    const msgOk = err.message.toLowerCase().includes(phrase.toLowerCase());
    check(label, codeOk && msgOk, `code=${err.code} (want ${code}); message=${err.message}`);
  }
}

async function gateTests(tmp: string): Promise<void> {
  console.log('\nrefusal gates (every one, through the real dispatcher)');

  // `ensureConnection` CACHES per label, so swapping the factory alone leaves
  // every later case running against the first mock. Force the swap.
  const install = (opts: MockOptions): number[][] => {
    const { factory, sent } = mockCircuitFactory(opts);
    registerConnector(LABEL, factory);
    ensureConnection(LABEL, true);
    return sent;
  };
  const stocked = (): Map<number, Uint8Array> => new Map([
    [10, makeProject('Winter Margin', 7)],
    [11, makeProject('Woke Code', 11)],
    [12, makeProject('Tidy Orbit', 13)],
  ]);

  // capability_not_supported: a device with no erase at all.
  {
    const noDelete: DeviceDescriptor = {
      ...CIRCUIT_TRACKS_DESCRIPTOR,
      id: 'stub-no-delete',
      display_name: 'Stub Preset Device',
      connection_label: 'stub-no-delete',
      port_match: [{ pattern: /stub-no-delete/i }],
      reader: { ...CIRCUIT_TRACKS_DESCRIPTOR.reader, probeProjectSlots: undefined },
      writer: { ...CIRCUIT_TRACKS_DESCRIPTOR.writer, deleteProjects: undefined },
    };
    registerDevice(noDelete);
    await expectRefusal(
      'a device with no erase refuses, and says overwriting is the way instead',
      'capability_not_supported', 'cannot erase a stored location',
      () => executeDeleteProject({ port: 'stub-no-delete', slots: [10], confirm_delete: true }));
    unregisterDevice('stub-no-delete');
  }

  // Argument shape. These run before any port is opened.
  install({ contents: stocked() });
  await expectRefusal('an empty slot list refuses', 'bad_request', 'at least one project',
    () => executeDeleteProject({ port: PORT, slots: [], confirm_delete: true }));
  await expectRefusal('project 0 refuses (the off-by-one a wire index makes)', 'bad_location', '1..64',
    () => executeDeleteProject({ port: PORT, slots: [0], confirm_delete: true }));
  await expectRefusal('project 65 refuses', 'bad_location', '1..64',
    () => executeDeleteProject({ port: PORT, slots: [65], confirm_delete: true }));
  await expectRefusal('a repeated project refuses', 'bad_request', 'same project twice',
    () => executeDeleteProject({ port: PORT, slots: [11, 11], confirm_delete: true }));

  // THE CEILING. Refused whole, never trimmed to fit.
  await expectRefusal(
    `${MAX_DELETES_PER_CALL + 1} projects refuses at the ceiling`,
    'delete_ceiling_exceeded', 'refused rather than trimmed',
    () => executeDeleteProject({
      port: PORT,
      slots: Array.from({ length: MAX_DELETES_PER_CALL + 1 }, (_, i) => i + 1),
      confirm_delete: true,
    }));
  {
    // and the refusal must not have deleted the first MAX of them on the way.
    const contents = stocked();
    const sent = install({ contents });
    try {
      await executeDeleteProject({
        port: PORT, slots: Array.from({ length: MAX_DELETES_PER_CALL + 1 }, (_, i) => i + 1), confirm_delete: true,
      });
    } catch { /* expected */ }
    check('the ceiling refusal sends NO delete frame at all',
      !sent.some((f) => f[7] === SUB.DELETE_FILE), `${sent.filter((f) => f[7] === SUB.DELETE_FILE).length} delete frame(s) were sent`);
  }

  // MISSING AUTHORISATION. The refusal must carry the report.
  {
    const contents = stocked();
    const sent = install({ contents });
    await expectRefusal(
      'no confirm_delete refuses, and NAMES every project that would be lost',
      'delete_confirmation_required', 'winter margin',
      () => executeDeleteProject({ port: PORT, slots: [11, 12], directory: tmp }));
    check('the unauthorised call sends no delete frame',
      !sent.some((f) => f[7] === SUB.DELETE_FILE));
    check('the unauthorised call writes no backup file (it destroyed nothing to back up)',
      readdirSync(tmp).length === 0, readdirSync(tmp).join(', '));
    check('the unauthorised call DID read the device (that is how it knows what to report)',
      sent.some((f) => f[7] === SUB.QUERY_EXISTS));
  }

  // FREE SLOT. Refuses the whole call, not just that slot.
  {
    const contents = stocked();
    const sent = install({ contents });
    await expectRefusal(
      'a project that reads empty refuses the WHOLE call',
      'bad_location', 'already empty',
      () => executeDeleteProject({ port: PORT, slots: [11, 40], confirm_delete: true, directory: tmp }));
    check('the empty-slot refusal deletes nothing, including the occupied neighbour',
      !sent.some((f) => f[7] === SUB.DELETE_FILE) && contents.has(10) && contents.has(11) && contents.has(12));
  }

  // UNREADABLE SLOT. Never degrades to "assume empty".
  {
    const sent = install({ contents: stocked(), silentSlots: new Set([11]) });
    await expectRefusal(
      'a project whose occupancy cannot be read refuses, and does NOT assume empty',
      'no_ack', 'could not establish',
      () => executeDeleteProject({ port: PORT, slots: [12], confirm_delete: true, directory: tmp }));
    check('the unreadable-slot refusal sends no delete frame',
      !sent.some((f) => f[7] === SUB.DELETE_FILE));
  }

  // ORACLES DISAGREE. Directory lists it, the file query says free.
  {
    install({ contents: stocked(), directoryOnly: new Set([20]) });
    await expectRefusal(
      'the two occupancy oracles disagreeing refuses rather than picking one',
      'no_ack', 'disagree',
      () => executeDeleteProject({ port: PORT, slots: [21], confirm_delete: true, directory: tmp }));
  }

  // BACKUP FAILURE. The download cannot be served, so nothing may be erased.
  {
    const contents = stocked();
    const sent = install({ contents, failDownload: true });
    let threw = false;
    try {
      await executeDeleteProject({ port: PORT, slots: [11], confirm_delete: true, directory: tmp });
    } catch { threw = true; }
    check('a backup that cannot be taken aborts the delete', threw);
    check('the backup-failure abort sends no delete frame, and the project survives',
      !sent.some((f) => f[7] === SUB.DELETE_FILE) && contents.has(10), 'a delete was sent despite having no backup');
    check('the backup-failure abort leaves no half-written file on disk',
      readdirSync(tmp).filter((f) => f.endsWith('.ncs')).length === 0);
  }

  // ACK BUT NOT GONE. The device says yes and keeps the file.
  {
    const contents = stocked();
    install({ contents, ignoreDelete: true });
    const res = await executeDeleteProject({ port: PORT, slots: [11], confirm_delete: true, directory: tmp, flush_wait_ms: 0 });
    check('an acked-but-still-present delete reports ok:false, not success',
      res.ok === false && res.deleted[0].ok === false, JSON.stringify(res.deleted));
    check('and warns that the slot is UNKNOWN rather than empty or intact',
      (res.warning ?? '').toLowerCase().includes('unknown'), res.warning);
    check('and still names the backup, so the caller knows nothing is unrecoverable',
      typeof res.deleted[0].backup_path === 'string');
  }
}

// ── 4. The success path, and the two-oracle verification ────────────

async function successPath(tmp: string): Promise<void> {
  console.log('\nsuccess path + verification');
  const contents = new Map<number, Uint8Array>([
    [10, makeProject('Winter Margin', 7)],
    [11, makeProject('Woke Code', 11)],
    [30, makeProject('Keep Me', 17)],
  ]);
  const { factory, sent } = mockCircuitFactory({ contents });
  registerConnector(LABEL, factory);
  ensureConnection(LABEL, true);

  const before = contents.get(11)!.slice();
  const res = await executeDeleteProject({
    port: PORT, slots: [12], confirm_delete: true, directory: tmp, flush_wait_ms: 0,
  });

  check('the delete succeeds', res.ok === true, JSON.stringify(res.deleted));
  check('it erased ONLY the named project', !contents.has(11) && contents.has(10) && contents.has(30),
    `remaining: ${[...contents.keys()].join(', ')}`);
  check('exactly ONE delete frame was sent, for the named slot only',
    sent.filter((f) => f[7] === SUB.DELETE_FILE).length === 1
    && sent.filter((f) => f[7] === SUB.DELETE_FILE)[0][10] === 11,
    JSON.stringify(sent.filter((f) => f[7] === SUB.DELETE_FILE)));

  const d = res.deleted[0];
  // The name comes from the DIRECTORY entry (the stored `.ncs` filename, which
  // is what Novation Components shows), not from a 160 KB download of the file.
  check('the result names what was destroyed', (d.name ?? '').includes('Woke Code'), String(d.name));
  check('BOTH oracles confirmed it gone (query AND directory)',
    d.gone_by_query === true && d.gone_by_directory === true, JSON.stringify(d));
  // The 2026-07-29 mis-scoring guard: the erased slot must answer EXACTLY as a
  // slot that was never occupied does, not merely "not like an occupied one".
  check('the erased slot answers byte-for-byte like a known-free control slot',
    d.matches_free_control === true, JSON.stringify(d));
  check('the receipt says both oracles were used, and why the directory alone is not enough',
    res.info.includes('INDEPENDENT') && res.info.toLowerCase().includes('circular'), res.info);

  // The backup IS the undo, so it has to be the real bytes.
  check('a backup file was written', typeof d.backup_path === 'string');
  check('the backup is byte-identical to what was erased',
    d.backup_path !== undefined && Buffer.from(readFileSync(d.backup_path)).equals(Buffer.from(before)));
  check('the backup is indexed as a pre-DELETE backup, not a pre-overwrite one',
    readFileSync(join(tmp, 'index.jsonl'), 'utf-8').includes('backup-before-delete'));

  // Read-before-delete ordering, asserted at the wire: the query for a slot must
  // come before its delete frame, in the same session.
  const order = sent.filter((f) => f[7] === SUB.QUERY_EXISTS || f[7] === SUB.DELETE_FILE);
  const firstDelete = order.findIndex((f) => f[7] === SUB.DELETE_FILE);
  check('a QUERY_EXISTS for the target precedes its DELETE_FILE',
    firstDelete > 0 && order.slice(0, firstDelete).some((f) => f[7] === SUB.QUERY_EXISTS && f[10] === 11));
  check('the slot is re-queried AFTER the delete too',
    order.slice(firstDelete + 1).some((f) => f[7] === SUB.QUERY_EXISTS && f[10] === 11));

  // Pack addressing: the gate, the backup, the delete and the verify must all
  // speak ONE pack. On an erase, a divergence here destroys the wrong project.
  {
    const packContents = new Map<number, Uint8Array>([[5, makeProject('On Pack 5', 3)]]);
    const { factory: f5, sent: s5 } = mockCircuitFactory({ contents: packContents, pack: 4 });
    registerConnector(LABEL, f5);
    ensureConnection(LABEL, true);
    const r5 = await executeDeleteProject({
      port: PORT, slots: [6], pack: 5, confirm_delete: true, directory: tmp, flush_wait_ms: 0,
    });
    check('a Pack 5 delete succeeds and reports Pack 5', r5.ok === true && r5.pack === 5, JSON.stringify(r5.deleted));
    const packBytes = new Set(s5.filter((f) => f[7] === SUB.QUERY_EXISTS || f[7] === SUB.DELETE_FILE).map((f) => f[9]));
    check('every query and delete frame carries wire pack 4, and nothing carries another pack',
      packBytes.size === 1 && packBytes.has(4), `packs seen: ${[...packBytes].join(', ')}`);
  }
}

async function main(): Promise<void> {
  wireGoldens();
  registerDevice(CIRCUIT_TRACKS_DESCRIPTOR);
  const tmp = mkdtempSync(join(tmpdir(), 'circuit-delete-'));
  const tmp2 = mkdtempSync(join(tmpdir(), 'circuit-delete-ok-'));
  try {
    await gateTests(tmp);
    await successPath(tmp2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(tmp2, { recursive: true, force: true });
  }
  console.log('');
  if (failed > 0) { console.error(`x ${failed} delete check(s) FAILED.`); process.exit(1); }
  console.log('OK verify-circuit-delete: frame goldens, every refusal gate, and the two-oracle verification.');
}

await main();
