/**
 * Circuit Tracks PACK DIRECTORY read — the microSD's pack list, by name.
 *
 * A Circuit Tracks with a microSD card holds up to 32 PACKS, each a complete
 * 64-project / 128-patch / 64-sample world. The front panel switches packs
 * (Shift + Projects); there is no MIDI command to switch one, and no command
 * that reports which pack is ACTIVE. What the device DOES expose is this: the
 * pack directory, listed by name.
 *
 * ## fileType 0x02 = the PACK directory
 *
 * The file-transfer transport addresses everything as `(fileType, pack, slot)`
 * (see `sampleDirectory.ts` `fileIdFor`). fileType 0x02 is the pack directory
 * itself, and it is listed with the SAME `DIR_CONTROL` (0x0b) request → header
 * + `DIR_ENTRY` (0x0c) replies protocol as projects (0x03) / patches (0x04) /
 * samples (0x05).
 *
 * The pack directory's replies are ONE BYTE SHORTER than a file directory's,
 * because a pack is not itself inside a pack (no `pack` field) and its count is
 * a single byte rather than a septet pair:
 *
 *   PACK header (11 bytes):  F0 00 20 29 01 64 03 0b 02 <count> F7
 *   FILE header (13 bytes):  F0 00 20 29 01 64 03 0b <type> <pack> <lo> <hi> F7
 *
 *   PACK entry:  F0 .. 03 0c 02 <packIndex> <ascii name…> F7
 *   FILE entry:  F0 .. 03 0c <type> <pack> <slot> <ascii name…> F7
 *
 * So a pack entry's name starts at msg[10], NOT msg[11]. Parsing a pack entry
 * with `sampleDirectory.parseDirEntry` silently eats the name's first character
 * as a `slot` byte ("00_ST & Roland" → "0_ST & Roland"); hence this module's
 * own parsers rather than reuse.
 *
 * ## Evidence
 *
 * STRONG (byte-exact, cross-validated, three independent legs):
 *
 *  1. `samples/captured/send-pack-to-circuit-tracks-pack-2-06-27-2026.pcapng`
 *     and `…-pack-3-…pcapng`: Components targeting packs 2 and 3 emits
 *     `0b 03 01` / `0d 03 01 <slot>` and `0b 05 02` / `0d 05 02 <slot>`
 *     respectively. The index is 0-BASED (pack 2 → 01, pack 3 → 02) and sits in
 *     the same position for fileType 0x03 (project) and 0x05 (sample) alike.
 *  2. Both captures' pack listings decode cleanly under the layout above:
 *     `0b 02 01` → one entry `0c 02 00 "00_ST & Roland"`; `0b 02 02` → that
 *     entry plus `0c 02 01 "00_invasion-test-og"`. Header count == entry count.
 *  3. The maintainer's own device, 2026-07-10 bench run: the frame recorded in
 *     `sampleDirectory.ts`'s hardening note as an 11-byte "malformed straggler"
 *     `0b 02 05` is in fact this header with count=5, matching the 5 packs the
 *     device shows on its front panel. It was rejected (correctly) by the
 *     13-byte FILE-header matcher, which is why it read as noise.
 *
 * Direction confirmed via `usb.endpoint_address.direction` (0 = host→device,
 * 1 = device→host): the host sends ONE `DIR_CONTROL([0x02])`; the device
 * replies with the header and then pushes one DIR_ENTRY per pack unsolicited.
 *
 * HARDWARE-CONFIRMED 2026-07-16 through this server's own code path, first
 * attempt (`scripts/probe-circuit-packs.ts` on the maintainer's device):
 * `readPackDirectory` returned `count=5` and all five names —
 *   Pack 1 (index 0) "00_73 pack from CT" · Pack 2 (1) "00_PACK" ·
 *   Pack 3 (2) "01_PACK" · Pack 4 (3) "02_PACK" · Pack 5 (4) "03_PACK"
 * — matching both the front panel's 5 packs and the count in the 2026-07-10
 * `0b 02 05` frame. The header shape, the entry layout (name at msg[10]), the
 * 0-based index, and the unsolicited-entry flow are all device-confirmed.
 *
 * Corollary, also confirmed by that read: index 0 = "00_73 pack from CT" is the
 * pack every transfer this server has ever made addressed, because `fileId`
 * hardcoded the byte to 0. The other four packs were unreachable.
 *
 * Read-only BY CONSTRUCTION, the same guarantee `sampleDirectory.ts` makes:
 * this module sends ONLY OPEN_SESSION / DIR_CONTROL / QUERY_INFO /
 * CLOSE_SESSION. It never sends WRITE_INIT / WRITE_DATA / WRITE_FINISH /
 * SET_FILENAME, so it cannot open (let alone abandon) a write transaction, the
 * failure that committed an empty directory in the disabled 2026-06-27 code.
 */

import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';

import { makeMessage, TRANSFER_CONSTANTS } from './transfer.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const DIR_ENTRY = 0x0c;

/** fileType of the pack directory itself (vs 0x03 project / 0x04 patch / 0x05 sample). */
export const FILE_TYPE_PACK = 0x02;

/**
 * Defensive ceiling on how many DIR_ENTRY replies we will read for one listing.
 *
 * NOT a sourced device limit: "pack" does not appear in the Circuit Tracks
 * Programmer's Reference at all, so 32 comes from Novation's user-facing
 * "32 packs on a microSD" figure, not the MIDI spec. It exists only to bound the
 * entry loop against a corrupt/hostile count byte (which can encode up to 127).
 * The device's own reported count is authoritative below this.
 */
export const MAX_PACK_ENTRIES = 32;

const REPLY_TIMEOUT_MS = 400;
const PRELUDE_TIMEOUT_MS = 400;
const DRAIN_TIMEOUT_MS = 40;
const ENTRY_TIMEOUT_MS = 400;

/**
 * Fixed on-wire length of the PACK listing header: F0 + 6-byte header + sub +
 * fileType + count + F7 = 11. Two bytes shorter than a FILE listing header
 * (13), which carries `pack` and a septet-pair count.
 */
const PACK_LIST_HEADER_LENGTH = 11;

/** One pack on the card. */
export interface PackEntry {
  /** 0-based wire index, the byte the fileId carries. */
  index: number;
  /** 1-based number as the device's front panel shows it (Shift + Projects). */
  device_pack: number;
  /** ASCII pack name. */
  name: string;
}

export interface PackDirectoryResult {
  count: number;
  packs: PackEntry[];
  /** Honesty note about evidence tier / what the read cannot tell you. */
  note?: string;
}

const ascii = (a: readonly number[]): string =>
  a.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '')).join('').trimEnd();

/**
 * Parse a PACK listing header reply (sub 0x0b, fileType 0x02): how many
 * DIR_ENTRY replies follow. Rejects anything that is not EXACTLY the 11-byte
 * shape, so a 13-byte FILE header (fileType 0x03/0x04/0x05) can never be
 * misread as a pack header, and vice versa.
 */
export function parsePackListHeader(msg: readonly number[]): { count: number } | undefined {
  if (msg.length !== PACK_LIST_HEADER_LENGTH) return undefined;
  if (msg[7] !== SUB.DIR_CONTROL || msg[8] !== FILE_TYPE_PACK) return undefined;
  return { count: msg[9] };
}

/**
 * Parse a PACK DIR_ENTRY reply (sub 0x0c, fileType 0x02): one pack's 0-based
 * index + ASCII name. The name starts at msg[10] (a pack entry has no `slot`
 * byte); `msg.length < 11` rejects a too-short frame rather than reading past
 * its end.
 */
export function parsePackEntry(msg: readonly number[]): { index: number; name: string } | undefined {
  if (msg.length < 11 || msg[7] !== DIR_ENTRY || msg[8] !== FILE_TYPE_PACK) return undefined;
  return { index: msg[9], name: ascii(msg.slice(10, msg.length - 1)) };
}

/** The 4-step non-destructive prelude, byte-identical to the hardware-confirmed upload prelude. */
function preludeMessages(): number[][] {
  return [
    makeMessage(SUB.OPEN_SESSION),
    makeMessage(SUB.DIR_CONTROL, [0x01]),
    makeMessage(SUB.QUERY_INFO, [0x01, 0x00]),
  ];
}

/**
 * Read the card's pack directory (names + 0-based indices). Requires a
 * bidirectional connection (the caller gates `conn.hasInput`).
 *
 * NOTE the prelude's 4th step IS the request: `DIR_CONTROL([0x02])` is both the
 * last handshake step every upload already sends AND the pack-listing call. The
 * upload path has always sent it and drained the replies on the floor; this
 * function is the same frame with the replies actually parsed.
 */
export async function readPackDirectory(conn: MidiConnection): Promise<PackDirectoryResult> {
  try {
    for (const msg of preludeMessages()) {
      const replyP = conn.receiveSysEx(PRELUDE_TIMEOUT_MS).catch(() => [] as number[]);
      conn.send(msg);
      await replyP;
    }

    // Clear any straggler still in flight from the prelude before the strict
    // header matcher registers (same defensive sweep as readSampleDirectory).
    await conn.receiveSysEx(DRAIN_TIMEOUT_MS).catch(() => undefined);

    // STRICT matcher: sub=DIR_CONTROL AND fileType=PACK AND the exact 11-byte
    // pack-header shape. A FILE header (13 bytes) for some other directory
    // cannot satisfy this, so it is left on the wire for its own reader.
    const headerP = conn
      .receiveSysExMatching(
        (m) => m[7] === SUB.DIR_CONTROL && m[8] === FILE_TYPE_PACK && m.length === PACK_LIST_HEADER_LENGTH,
        REPLY_TIMEOUT_MS,
      )
      .catch(() => [] as number[]);
    conn.send(makeMessage(SUB.DIR_CONTROL, [FILE_TYPE_PACK]));
    const header = parsePackListHeader(await headerP);
    const count = header?.count ?? 0;

    // The device pushes one DIR_ENTRY per pack, unsolicited, after the header.
    const wanted = Math.min(count, MAX_PACK_ENTRIES);
    const packs: PackEntry[] = [];
    for (let i = 0; i < wanted; i++) {
      const reply = await conn
        .receiveSysExMatching((m) => m[7] === DIR_ENTRY && m[8] === FILE_TYPE_PACK, ENTRY_TIMEOUT_MS)
        .catch(() => [] as number[]);
      const entry = parsePackEntry(reply);
      if (!entry) break;
      packs.push({ index: entry.index, device_pack: entry.index + 1, name: entry.name });
    }

    // Distinguish the two ways `packs` can fall short of `count`: our own
    // defensive cap vs a read that stopped early. Reporting a cap truncation as
    // a timeout would be a lie.
    let note: string | undefined;
    if (count > MAX_PACK_ENTRIES) {
      note = `Device reported ${count} pack(s); this read is capped at ${MAX_PACK_ENTRIES} and returned the first ${packs.length}.`;
    } else if (packs.length < count) {
      note = `Device reported ${count} pack(s) but only ${packs.length} name(s) arrived before the read timed out.`;
    }
    return { count, packs, note };
  } finally {
    // Always close, even on error, so the device never sits on its transfer screen.
    try {
      conn.send(makeMessage(SUB.CLOSE_SESSION));
    } catch {
      /* best effort */
    }
  }
}
