/**
 * verify-circuit-backup: offline goldens for the Circuit Tracks project backup
 * leg (Backup Tier 1).
 *
 * Two surfaces, both pure-logic-testable without hardware:
 *   1. reader.dumpStoredPresetBinary — drives the real `downloadProject` loop
 *      against a MOCK device that replays a known project (build its WRITE_INIT/
 *      WRITE_DATA/WRITE_FINISH frames from the same primitives the codec uses),
 *      asserting the returned PresetBinaryDump (bytes/format/extension/name) and
 *      that a CRC-mismatched read THROWS instead of handing back a bad "backup".
 *   2. backupProjectSlot — the dispatcher's backup-before-overwrite helper, with
 *      a STUB descriptor so the saved / skipped_empty / skipped_unsupported /
 *      read-throws-propagates branches are checked fast (no 5 s empty-slot wait).
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import type { DeviceDescriptor, DispatchCtx, PresetBinaryDump } from '@mcp-midi-control/core/protocol-generic/types.js';
import { backupProjectSlot } from '@mcp-midi-control/core/protocol-generic/dispatcher/backup.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '@mcp-midi-control/circuit-tracks/descriptor.js';
import { NCS_FILE_SIZE } from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import {
  blockAddress, crc32, fileId, intToNibbles, makeMessage, msbInterleave, TRANSFER_CONSTANTS,
} from '@mcp-midi-control/circuit-tracks/ncs/transfer.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `  — ${detail}`}`);
  if (!ok) failed++;
}

const HDR = TRANSFER_CONSTANTS.HEADER;
const SUB = TRANSFER_CONSTANTS.SUBCMD;
const BLOCK = TRANSFER_CONSTANTS.BLOCK_SIZE;

/** A deterministic 160,780-byte "project" with a readable name at offset 0x10. */
function makeProject(name: string): Uint8Array {
  const buf = new Uint8Array(NCS_FILE_SIZE);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 7) & 0xff;
  const n = name.padEnd(16, ' ').slice(0, 16);
  for (let i = 0; i < 16; i++) buf[0x10 + i] = n.charCodeAt(i) & 0x7f;
  return buf;
}

/**
 * Mock device for a DOWNLOAD: on the host's read WRITE_INIT (trailing 0x02
 * flag), synchronously emit the project's WRITE_INIT + WRITE_DATA*N +
 * WRITE_FINISH response frames into the inbound stream. `corruptCrc` flips the
 * final CRC so the reader's verify fails.
 */
function downloadMock(slot: number, project: Uint8Array, opts: { corruptCrc?: boolean } = {}): MidiConnection {
  let handler: ((m: number[]) => void) | undefined;
  const fid = fileId(slot);
  const emitResponse = (): void => {
    if (!handler) return;
    const numBlocks = Math.ceil(project.length / BLOCK);
    handler(makeMessage(SUB.WRITE_INIT, [...blockAddress(0), ...fid, 0x01, 0x00, 0x00, 0x00, ...intToNibbles(project.length, 5)]));
    for (let b = 1; b <= numBlocks; b++) {
      const chunk = project.subarray((b - 1) * BLOCK, (b - 1) * BLOCK + BLOCK);
      handler(makeMessage(SUB.WRITE_DATA, [...blockAddress(b), ...fid, ...msbInterleave(chunk)]));
    }
    const crc = opts.corruptCrc ? (crc32(project) ^ 0xffffffff) >>> 0 : crc32(project);
    handler(makeMessage(SUB.WRITE_FINISH, [...blockAddress(numBlocks + 1), ...fid, ...intToNibbles(crc, 8)]));
  };
  return {
    send: (bytes: number[]) => {
      const c = bytes[0] === 0xf0 ? bytes.slice(1, -1) : bytes;
      if (c[HDR.length] === SUB.WRITE_INIT && c[c.length - 1] === 0x02) emitResponse();
    },
    onMessage: (h: (m: number[]) => void) => { handler = h; return () => { handler = undefined; }; },
    hasInput: true,
    isPortOpen: () => true,
    close: () => { /* */ },
  } as unknown as MidiConnection;
}

function ctxFor(conn: MidiConnection, descriptor: DeviceDescriptor): DispatchCtx {
  return { conn, descriptor } as DispatchCtx;
}

async function main(): Promise<void> {
  const reader = CIRCUIT_TRACKS_DESCRIPTOR.reader;
  check('Circuit reader exposes dumpStoredPresetBinary', typeof reader.dumpStoredPresetBinary === 'function');

  // 1a. Occupied slot → a CRC-clean PresetBinaryDump shaped as a .ncs backup.
  {
    const project = makeProject('Eden Groove');
    const conn = downloadMock(7, project);
    const dump = await reader.dumpStoredPresetBinary!(7, ctxFor(conn, CIRCUIT_TRACKS_DESCRIPTOR));
    check('dumpStoredPresetBinary: byte-exact bytes', dump.byte_length === NCS_FILE_SIZE && Buffer.from(dump.bytes).equals(Buffer.from(project)));
    check('dumpStoredPresetBinary: format = circuit-ncs-project', dump.format === 'circuit-ncs-project', dump.format);
    check('dumpStoredPresetBinary: file_extension = ncs', dump.file_extension === 'ncs', String(dump.file_extension));
    check('dumpStoredPresetBinary: decoded name', dump.name === 'Eden Groove', String(dump.name));
    check('dumpStoredPresetBinary: not flagged empty', dump.empty !== true);
    check('dumpStoredPresetBinary: frame_count = ceil(size/8192) = 20', dump.frame_count === Math.ceil(NCS_FILE_SIZE / BLOCK), String(dump.frame_count));
  }

  // 1b. CRC mismatch → HARD throw (never return unverified bytes as a backup).
  {
    const conn = downloadMock(9, makeProject('Corrupt'), { corruptCrc: true });
    let threw = false;
    try { await reader.dumpStoredPresetBinary!(9, ctxFor(conn, CIRCUIT_TRACKS_DESCRIPTOR)); }
    catch { threw = true; }
    check('dumpStoredPresetBinary: CRC mismatch throws (no corrupt backup)', threw);
  }

  // 1c. bad slot rejected before any wire op.
  {
    let threw = false;
    try { await reader.dumpStoredPresetBinary!(64, ctxFor(downloadMock(0, makeProject('x')), CIRCUIT_TRACKS_DESCRIPTOR)); }
    catch { threw = true; }
    check('dumpStoredPresetBinary: slot 64 rejected (0..63)', threw);
  }

  // 2. backupProjectSlot helper branches, against stub descriptors (fast).
  const tmp = mkdtempSync(join(tmpdir(), 'circuit-backup-'));
  try {
    const bytes = makeProject('Backup Me');
    const stub = (dump?: PresetBinaryDump, throws?: boolean): DeviceDescriptor => ({
      ...CIRCUIT_TRACKS_DESCRIPTOR,
      reader: {
        ...CIRCUIT_TRACKS_DESCRIPTOR.reader,
        dumpStoredPresetBinary: dump === undefined && !throws
          ? undefined
          : async () => {
            if (throws) throw new Error('CRC mismatch (simulated)');
            return dump!;
          },
      },
    });

    // saved: occupied slot → a file is written with the exact bytes.
    {
      const d = stub({ bytes, byte_length: bytes.length, frame_count: 20, format: 'circuit-ncs-project', file_extension: 'ncs', name: 'Backup Me' });
      const r = await backupProjectSlot(d, ctxFor(downloadMock(0, bytes), d), 5, { directory: tmp });
      const wrote = r.file_path !== undefined && existsSync(r.file_path);
      check('backupProjectSlot: occupied → status saved + file on disk', r.status === 'saved' && wrote, JSON.stringify({ status: r.status }));
      check('backupProjectSlot: saved file is byte-exact', wrote && Buffer.from(readFileSync(r.file_path!)).equals(Buffer.from(bytes)));
      check('backupProjectSlot: backup filename carries slot + .ncs', !!r.file_path && /slot05.*\.ncs$/.test(r.file_path));
    }

    // skipped_empty: empty slot → no file, clean note.
    {
      const d = stub({ bytes: new Uint8Array(0), byte_length: 0, frame_count: 0, format: 'circuit-ncs-project', file_extension: 'ncs', empty: true });
      const before = readdirSync(tmp).length;
      const r = await backupProjectSlot(d, ctxFor(downloadMock(0, bytes), d), 6, { directory: tmp });
      check('backupProjectSlot: empty → skipped_empty, no file', r.status === 'skipped_empty' && readdirSync(tmp).length === before, JSON.stringify({ status: r.status }));
    }

    // skipped_unsupported: device with no stored read → no backup, but no throw.
    {
      const d = stub(undefined);
      const r = await backupProjectSlot(d, ctxFor(downloadMock(0, bytes), d), 7, { directory: tmp });
      check('backupProjectSlot: no dumpStoredPresetBinary → skipped_unsupported', r.status === 'skipped_unsupported');
    }

    // read throws (CRC fail) → propagates, NO file written (caller must abort the overwrite).
    {
      const d = stub(undefined, true);
      const before = readdirSync(tmp).length;
      let threw = false;
      try { await backupProjectSlot(d, ctxFor(downloadMock(0, bytes), d), 8, { directory: tmp }); }
      catch { threw = true; }
      check('backupProjectSlot: read failure propagates + writes no file', threw && readdirSync(tmp).length === before);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failed === 0 ? '\nverify-circuit-backup: all checks passed' : `\nverify-circuit-backup: ${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
