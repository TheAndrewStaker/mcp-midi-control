/**
 * Golden: the overwrite gate and the write it guards address the SAME microSD
 * pack. No hardware — a recording mock connection.
 *
 * WHY THIS EXISTS (read before "simplifying" it):
 *
 * A Circuit Tracks card holds up to 32 packs, each a COMPLETE separate world of
 * 64 projects. The same slot number exists in every pack, so the pack byte alone
 * decides which project a write destroys (docs/design/circuit-pack-addressing.md).
 *
 * Three legs run on a stored-slot write: the pre-write BACKUP read, the overwrite
 * gate's OCCUPANCY read, and the WRITE. If they disagree about the pack, the gate
 * clears an empty slot on Pack 1 while the write lands on an occupied slot of
 * Pack 5 — the gate green-lights the exact clobber it exists to prevent, reports
 * success, and the backup on disk is of a project that was never touched. A
 * 2026-07-16 review flagged this as the #1 latent hazard of threading `pack`.
 *
 * The defense is structural: `pack` rides on `DispatchCtx`, so all three legs read
 * ONE field and cannot diverge (see DispatchCtx.pack). This golden pins that
 * property AT THE WIRE, which is the only layer that can't lie — it decodes the
 * pack byte out of every frame the writer actually emits and asserts the whole
 * operation speaks a single pack. If someone ever converts `pack` back into a
 * per-call argument and threads it into the write but not the gate, the recorded
 * frames carry two different packs and this fails.
 *
 * The pack rides the wire in two places, and BOTH are checked:
 *   - the fileId's middle byte:      [fileType, pack, slot] at frame[16..18]
 *   - the dir-listing scope frame:   DIR_CONTROL [0x03, pack] at frame[8..9]
 *
 * Run:  npx tsx scripts/verify-circuit-pack-gate.ts
 */

import {
  blockAddress, fileId, makeMessage, TRANSFER_CONSTANTS,
} from '@mcp-midi-control/circuit-tracks/ncs/transfer.js';
import { NCS_FILE_SIZE, NCS_MAGIC, NCS_TOTAL_SESSION_SIZE_OFFSET } from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import { writer } from '@mcp-midi-control/circuit-tracks/descriptor/writer.js';
import { reader } from '@mcp-midi-control/circuit-tracks/descriptor/reader.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '@mcp-midi-control/circuit-tracks/descriptor.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) { passed++; console.log(`  OK    ${label}`); return; }
  failed++;
  console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
}

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const FILE_TYPE_PROJECT = TRANSFER_CONSTANTS.FILE_TYPE_PROJECT;
const FILE_TYPE_SAMPLE = 0x05;
// SET_FILENAME's payload is the fid ALONE (no 8-byte address), so its pack byte
// sits one after the subcommand, not at FID_AT. SUB_DIR_ENUM/INFO (0x0d/0x08)
// likewise carry [fileType, pack, slot] right after the subcommand.
const SUB_DIR_ENUM = 0x0d;
const SUB_DIR_INFO = 0x08;
// F0 + HEADER(6) + subcmd → payload starts at 8; addr(8) then fid(3) at 16..18.
const SUBCMD_AT = 7;
const FID_AT = 16;

/**
 * Every pack index this frame references, or [] if it references none.
 * Deliberately decodes the RAW bytes rather than trusting any builder — a golden
 * that re-used the encoder's own view of "the pack" could not catch the encoder
 * being handed the wrong one.
 */
function packsReferenced(frame: readonly number[]): number[] {
  const out: number[] = [];
  const sub = frame[SUBCMD_AT];
  // fileId-bearing WRITE frames: [fileType, pack, slot] after the 8-byte address.
  if (
    (sub === SUB.WRITE_INIT || sub === SUB.WRITE_DATA || sub === SUB.WRITE_FINISH)
    && frame.length >= FID_AT + 3
    && (frame[FID_AT] === FILE_TYPE_PROJECT || frame[FID_AT] === FILE_TYPE_SAMPLE)
  ) {
    out.push(frame[FID_AT + 1]);
  }
  // SET_FILENAME: fid with NO address, so [fileType, pack, slot] at frame[8..10].
  if (sub === SUB.SET_FILENAME && frame.length > 9 && (frame[8] === FILE_TYPE_PROJECT || frame[8] === FILE_TYPE_SAMPLE)) {
    out.push(frame[9]);
  }
  // Pack-scoped dir listing / per-slot enum: DIR_CONTROL/0x0d/0x08 [fileType, pack, ...].
  if (
    (sub === SUB.DIR_CONTROL || sub === SUB_DIR_ENUM || sub === SUB_DIR_INFO)
    && (frame[8] === 0x03 || frame[8] === FILE_TYPE_SAMPLE) && frame.length > 9
  ) {
    out.push(frame[9]);
  }
  return out;
}

/**
 * Records every frame sent. ACKs everything so a write that clears the gate runs
 * to completion, and never emits a READ_INIT — so the gate's occupancy read finds
 * the slot EMPTY and lets the write through. That is the case we need: it is the
 * only one where the gate read AND the write both emit frames in ONE operation,
 * which is what makes a pack disagreement between them observable.
 */
function recordingConn(): { conn: MidiConnection; sent: number[][] } {
  const sent: number[][] = [];
  let handler: ((m: number[]) => void) | undefined;
  const conn = {
    send: (b: number[]) => {
      sent.push([...b]);
      const ack = makeMessage(SUB.ACK, [...blockAddress(0), ...fileId(0)]);
      queueMicrotask(() => handler?.(ack));
    },
    onMessage: (h: (m: number[]) => void) => { handler = h; return () => { handler = undefined; }; },
    hasInput: true,
    isPortOpen: () => true,
    close: () => { /* nothing to close */ },
    receiveSysEx: async () => { throw new Error('unused'); },
    receiveSysExMatching: async () => { throw new Error('unused'); },
  } as unknown as MidiConnection;
  return { conn, sent };
}

const ctxWithPack = (conn: MidiConnection, pack: number | undefined): DispatchCtx =>
  ({ conn, descriptor: CIRCUIT_TRACKS_DESCRIPTOR, pack, reconnect: () => conn }) as unknown as DispatchCtx;

async function main(): Promise<void> {
  // Structurally VALID, not merely the right length: `uploadProject` gained a
  // structural pre-flight (2026-07-29) and refuses a right-length non-project
  // before any frame is sent, which an all-zero buffer is. This suite is about
  // PACK ADDRESSING, so its fixture must clear unrelated gates or every check
  // below would be asserting against the argument-refusal path instead.
  const NCS = new Uint8Array(NCS_FILE_SIZE);
  for (let i = 0; i < NCS_MAGIC.length; i++) NCS[i] = NCS_MAGIC.charCodeAt(i);
  new DataView(NCS.buffer).setUint32(NCS_TOTAL_SESSION_SIZE_OFFSET, NCS_FILE_SIZE, true);

  // ── The divergence test ────────────────────────────────────────────
  // Wire pack 4 = the device's "Pack 5". One operation, gate read + write.
  // Takes a few seconds: the empty-slot occupancy read waits out the device
  // response timeout, and the writer exposes no timing knob. Worth it — this is
  // the check standing between a user and a silently destroyed project.
  {
    const WIRE_PACK = 4;
    const SLOT = 7;
    const { conn, sent } = recordingConn();
    const res = await writer.uploadProject!(ctxWithPack(conn, WIRE_PACK), NCS, SLOT);

    const all = sent.flatMap(packsReferenced);
    const distinct = [...new Set(all)].sort();
    check('gate + write both ran (the empty-slot read let the write through)',
      (res as { ok: boolean }).ok === true && sent.length > 2,
      JSON.stringify({ ok: (res as { ok: boolean }).ok, frames: sent.length }));
    check('every pack-scoped frame references a pack',
      all.length > 0, `found ${all.length} pack references across ${sent.length} frames`);
    // THE assertion: gate and write cannot be on different packs.
    check('gate read + write address ONE pack, and it is the requested one',
      distinct.length === 1 && distinct[0] === WIRE_PACK,
      `distinct packs seen on the wire: ${JSON.stringify(distinct)} (expected exactly [${WIRE_PACK}])`);

    // Prove the read leg specifically carried the pack — a gate that read pack 0
    // while the write targeted 4 is the exact silent clobber this guards.
    const dirScope = sent.filter((f) => f[SUBCMD_AT] === SUB.DIR_CONTROL && f[8] === 0x03);
    check('the gate\'s dir-listing scope frame carries the requested pack',
      dirScope.length > 0 && dirScope.every((f) => f[9] === WIRE_PACK),
      JSON.stringify({ frames: dirScope.length, packs: dirScope.map((f) => f[9]) }));

    // Prove the write leg carried it too.
    const writeData = sent.filter((f) => f[SUBCMD_AT] === SUB.WRITE_DATA && f[FID_AT] === FILE_TYPE_PROJECT);
    check('every WRITE_DATA frame carries the requested pack',
      writeData.length > 0 && writeData.every((f) => f[FID_AT + 1] === WIRE_PACK),
      JSON.stringify({ frames: writeData.length, packs: [...new Set(writeData.map((f) => f[FID_AT + 1]))] }));

    // And the slot still lands where asked (pack must not be confused for slot —
    // the original bug was exactly this byte being read as a slot's high septet).
    check('the slot byte is unchanged by pack addressing',
      writeData.every((f) => f[FID_AT + 2] === SLOT),
      JSON.stringify([...new Set(writeData.map((f) => f[FID_AT + 2]))]));
  }

  // ── The READ legs ──────────────────────────────────────────────────
  // Every leg that takes a `pack` ARG must actually put it on the wire. A read
  // that ignores it is not a harmless no-op: it serves another pack's project
  // while the caller believes the arg was honored, and on the backup leg that
  // means a "backed up" receipt for a file that is not the one being destroyed.
  //
  // Both of these shipped BROKEN in the first cut of this change — get_preset's
  // pack arg was a silent no-op (reader.ts downloadProject, no pack) — because
  // the write-path golden above cannot see a read leg. Hence these.
  {
    const WIRE_PACK = 4;
    const SLOT = 3;

    // get_preset(location) → the project read.
    {
      const { conn, sent } = recordingConn();
      // Reads the empty-slot path (the mock never sends READ_INIT); the frames
      // it emits on the way are what we are inspecting.
      await reader.getPreset!(ctxWithPack(conn, WIRE_PACK), { location: SLOT });
      const distinct = [...new Set(sent.flatMap(packsReferenced))];
      check('get_preset: the project read addresses the requested pack',
        distinct.length === 1 && distinct[0] === WIRE_PACK,
        `distinct packs on the wire: ${JSON.stringify(distinct)} (expected [${WIRE_PACK}])`);
    }

    // export_preset / backup-before-overwrite → dumpStoredPresetBinary.
    {
      const { conn, sent } = recordingConn();
      await reader.dumpStoredPresetBinary!(SLOT, ctxWithPack(conn, WIRE_PACK));
      const distinct = [...new Set(sent.flatMap(packsReferenced))];
      check('export_preset / backup: the stored dump addresses the requested pack',
        distinct.length === 1 && distinct[0] === WIRE_PACK,
        `distinct packs on the wire: ${JSON.stringify(distinct)} (expected [${WIRE_PACK}])`);
    }
  }

  // ── Back-compat: no pack on the ctx behaves exactly like Pack 1 ─────
  // Every pre-2026-07-16 caller omits pack; that path must be byte-identical.
  {
    const { conn, sent } = recordingConn();
    await writer.uploadProject!(ctxWithPack(conn, undefined), NCS, 7);
    const distinct = [...new Set(sent.flatMap(packsReferenced))];
    check('ctx without a pack addresses pack 0 (device "Pack 1") everywhere',
      distinct.length === 1 && distinct[0] === 0,
      `distinct packs: ${JSON.stringify(distinct)}`);
  }
}

await main();

console.log('');
if (failed > 0) { console.error(`x ${failed} pack-gate check(s) FAILED.`); process.exit(1); }
console.log(`OK verify-circuit-pack-gate: ${passed} check(s). Gate, write, project read, and stored dump all address the ctx pack.`);
