/**
 * Arturia SysEx envelope + opcodes.
 *
 * Brand-level, not device-level: the envelope is shared across the Arturia
 * hardware line and differs only by a device-code byte, so a MiniBrute or
 * MatrixBrute config slots in beside the MicroFreak without a second codec.
 *
 *   F0  00 20 6B  <device>  01  <seq>  <len>  <cmd>  …payload…  F7
 *       ^^^^^^^^ Arturia MMA id
 *
 * `seq` is echoed byte-exactly in the reply. **Match on it.** Matching only on
 * the Arturia header lets a late answer to a PREVIOUS request be misattributed
 * to the current one, which manufactured a phantom "the preset ceiling is 385"
 * result during the 2026-07-25 decode session before the matcher was tightened.
 *
 * Everything here is HARDWARE-CONFIRMED on a MicroFreak (fw 5.0.0) except where
 * marked. Provenance for the shapes: community reverse-engineering of MIDI
 * Control Center traffic (github.com/francoisgeorgy/microfreak-reverse), then
 * put on a wire and verified by this project.
 */

export const ARTURIA_ID = [0x00, 0x20, 0x6b] as const;

/** Device code byte. 0x04 = MiniBrute, 0x06 = MatrixBrute, 0x07 = MicroFreak. */
export const DEVICE_MICROFREAK = 0x07;

/**
 * Byte 5 is a DIRECTION marker on the global-settings path, and the captures are
 * unambiguous: every host->device request carries `0x01`, every device->host
 * global answer carries `0x7F` (`samples/arturia-microfreak/re-notes/notes2.md`,
 * 23 request/reply pairs, no exceptions). The decode is unaffected by an earlier
 * miscount of that figure as 27: every one of the real pairs carries `0x7F`.
 *
 * This matters because a global READ answer and a global WRITE command are
 * otherwise the SAME shape (`02 42 <param> <value>`). Without the direction
 * check, a write echoed or looped back on the port satisfies a reply matcher and
 * a write "verifies" itself. Matching the direction byte makes that structurally
 * impossible.
 *
 * NOT true of the preset-NAME path: name replies carry `0x01` in byte 5 like the
 * request does, and echo the seq in byte 6 instead. Do not generalise this
 * constant to `nameReplyMatcher`.
 */
export const DIR_TO_DEVICE = 0x01;
export const DIR_FROM_DEVICE = 0x7f;

/** Command bytes observed on the wire. */
export const CMD = {
  /** Read a preset name / start a preset dump (differs by the trailing flag). */
  READ_PRESET: 0x19,
  /** Request the next packet of an in-progress preset dump. */
  DUMP_NEXT: 0x18,
  /** Dump-start acknowledgement. */
  DUMP_ACK: 0x15,
  /** Dump data packet, more follow. */
  DUMP_MORE: 0x16,
  /** Dump data packet, LAST one. */
  DUMP_LAST: 0x17,
  /** Preset-name answer. */
  NAME_REPLY: 0x52,
  /** Global/Utility setting WRITE. Also the shape the device answers a read in. */
  GLOBAL_WRITE: 0x42,
  /** Global/Utility setting READ. */
  GLOBAL_READ: 0x43,
} as const;

/** Preset payload offset at which the ASCII name begins (null-padded). */
export const NAME_OFFSET = 21;

/** 128 presets per bank; `bank = slot0 / 128`, `index = slot0 % 128`. */
export const PRESETS_PER_BANK = 128;

export interface BankIndex { bank: number; index: number }

/** Split a 0-based slot into the device's bank/index addressing. */
export function toBankIndex(slot0: number): BankIndex {
  return { bank: Math.floor(slot0 / PRESETS_PER_BANK), index: slot0 % PRESETS_PER_BANK };
}

function envelope(device: number, seq: number, body: readonly number[]): number[] {
  return [0xf0, ...ARTURIA_ID, device, DIR_TO_DEVICE, seq & 0x7f, ...body, 0xf7];
}

/** Request a preset's NAME. */
export function buildNameRequest(seq: number, slot0: number, device = DEVICE_MICROFREAK): number[] {
  const { bank, index } = toBankIndex(slot0);
  return envelope(device, seq, [0x03, CMD.READ_PRESET, bank, index, 0x00]);
}

/** Begin a full preset dump. Answered with a DUMP_ACK, then DUMP_NEXT pulls packets. */
export function buildDumpStart(seq: number, slot0: number, device = DEVICE_MICROFREAK): number[] {
  const { bank, index } = toBankIndex(slot0);
  return envelope(device, seq, [0x03, CMD.READ_PRESET, bank, index, 0x01]);
}

/** Request the next dump packet. */
export function buildDumpNext(seq: number, device = DEVICE_MICROFREAK): number[] {
  return envelope(device, seq, [0x01, CMD.DUMP_NEXT, 0x00]);
}

/** Read one global/Utility setting. READ-ONLY: this is 0x43, never the 0x42 write. */
export function buildGlobalRead(seq: number, param: number, device = DEVICE_MICROFREAK): number[] {
  return envelope(device, seq, [0x01, CMD.GLOBAL_READ, param & 0x7f]);
}

/**
 * WRITE one global/Utility setting.
 *
 * HARDWARE-CONFIRMED 2026-07-25. Originally decoded from MIDI Control Center
 * captures and shipped community-beta; then exercised on a MicroFreak by writing
 * a value that DIFFERED from the current one (0 -> 1 -> 0 on `knob_send_ccs`) and
 * confirming the change by read-back in both directions. Writing a value equal to
 * the current one would have "passed" even if the write did nothing, so the
 * differing-value form is the only honest test.
 *
 * Callers should still verify by reading back (the reader is cheap and the
 * device never acknowledges a write).
 */
export function buildGlobalWrite(seq: number, param: number, value: number, device = DEVICE_MICROFREAK): number[] {
  return envelope(device, seq, [0x02, CMD.GLOBAL_WRITE, param & 0x7f, value & 0x7f]);
}

/** Does this message carry the Arturia id for `device`? */
export function isArturia(bytes: readonly number[], device = DEVICE_MICROFREAK): boolean {
  return bytes[1] === ARTURIA_ID[0] && bytes[2] === ARTURIA_ID[1]
    && bytes[3] === ARTURIA_ID[2] && bytes[4] === device;
}

/**
 * Matcher for a preset-NAME answer to a specific request. Checks the echoed
 * seq AND the echoed bank/index, not just the header (see the header note).
 */
export function nameReplyMatcher(seq: number, slot0: number, device = DEVICE_MICROFREAK) {
  const { bank, index } = toBankIndex(slot0);
  return (b: readonly number[]): boolean =>
    isArturia(b, device) && b[6] === (seq & 0x7f)
    && b[8] === CMD.NAME_REPLY && b[9] === bank && b[10] === index;
}

/**
 * Matcher for a global-setting answer to a specific param.
 *
 * Deliberately does NOT match on `seq`: the captures show the device does not
 * echo it here. It answers with its own counter that advances by 2 per reply
 * (request seq 00,01,02,... -> reply byte6 02,04,06,...), so a seq check would
 * reject every genuine answer. The preset-name path is the opposite and DOES
 * echo, which is why `nameReplyMatcher` checks it.
 *
 * The direction byte is what disambiguates instead, and it is strictly stronger
 * than a seq check here: it rejects host-originated frames outright, so a global
 * WRITE can never be mistaken for an answer to a read.
 */
export function globalReplyMatcher(param: number, device = DEVICE_MICROFREAK) {
  return (b: readonly number[]): boolean =>
    isArturia(b, device) && b[5] === DIR_FROM_DEVICE
    && b[8] === CMD.GLOBAL_WRITE && b[9] === (param & 0x7f);
}

/** Extract the value from a global-setting answer. */
export function decodeGlobalReply(bytes: readonly number[]): number {
  return bytes[10];
}

// ── Preset-dump reply matchers ──────────────────────────────────────────────
//
// Reply shapes, hardware-verified end to end by the 2026-07-25 probe run
// (scripts/probe-microfreak-dump.ts; recorded in STATE-MICROFREAK.md "FULL
// PRESET DUMP", 146 packets / 4672 bytes terminating on 0x17):
//
//   ack        :  F0 00 20 6B <dev> 01 <seq> 00 15 F7
//   data packet:  F0 00 20 6B <dev> 01 <seq> <len> 16|17 ...payload... F7
//
// Unlike the global path, dump replies carry 0x01 in byte 5 (like the name
// path) and echo the request seq in byte 6, so the direction byte cannot be
// the echo guard here. The COMMAND byte is: every host-originated frame on
// this flow carries 0x19 (dump start) or 0x18 (data request) in byte 8,
// while replies carry 0x15/0x16/0x17, so a looped-back request can never
// satisfy these matchers. Seq echo then pins WHICH request a reply answers
// (the same misattribution discipline `nameReplyMatcher` exists for).

/** Matcher for the dump-start acknowledgement (`00 15`). */
export function dumpAckMatcher(seq: number, device = DEVICE_MICROFREAK) {
  return (b: readonly number[]): boolean =>
    isArturia(b, device) && b[6] === (seq & 0x7f) && b[8] === CMD.DUMP_ACK;
}

/** Matcher for a dump data packet: 0x16 (more follow) or 0x17 (last). */
export function dumpPacketMatcher(seq: number, device = DEVICE_MICROFREAK) {
  return (b: readonly number[]): boolean =>
    isArturia(b, device) && b[6] === (seq & 0x7f)
    && (b[8] === CMD.DUMP_MORE || b[8] === CMD.DUMP_LAST);
}

/** True when a dump data packet is the LAST one (command byte 0x17). */
export function isLastDumpPacket(bytes: readonly number[]): boolean {
  return bytes[8] === CMD.DUMP_LAST;
}

/**
 * Payload bytes of one dump data packet: everything after the 9-byte header,
 * before the trailing F7. The same slice the hardware-confirmed probe used to
 * assemble the 4672-byte preset payload (`p.slice(9, p.length - 1)`).
 */
export function dumpPacketPayload(bytes: readonly number[]): number[] {
  return [...bytes.slice(9, bytes.length - 1)];
}

/** Extract the null-padded ASCII preset name from a NAME_REPLY. */
export function decodePresetName(bytes: readonly number[]): string {
  const raw = bytes.slice(NAME_OFFSET, bytes.length - 1);
  const end = raw.indexOf(0x00);
  return String.fromCharCode(...(end === -1 ? raw : raw.slice(0, end)));
}

// ── Preset WRITE (import_preset) ────────────────────────────────────────────
//
// Decoded from a real MIDI Control Center capture writing presets TO a
// MicroFreak (`samples/captured/microfreak-mcc-preset-copy.pcapng`,
// 2026-08-13/14; per-event frame dumps at
// `samples/_scratch/microfreak-write-decode/event{1,2,3}-{out,in}.syx`).
// Three drags were captured: "Revert to Iron" -> slot 505, the SAME preset
// -> slot 506 (isolates address bytes from content), then a DIFFERENT
// preset "Yggdrasil" -> slot 506 (isolates content from address). The
// 146-frame payload was cross-validated against a live `export_preset`
// read of the same preset taken immediately after the capture
// (`Arturia_MicroFreak-Revert_to_Iron-2026-08-14_00-03-34.syx`): ZERO byte
// difference across all 146 payload frames, so the write side reuses the
// EXACT SAME TLV container the read side already decodes -- no separate
// write-side content decode is needed.
//
// One MicroFreak preset write is six frame types in this order:
//   1. `buildNameRequest` (EXISTING, above) at the DESTINATION slot: a
//      read-before-write occupancy check, answered with the CURRENT
//      occupant's name.
//   2. `buildPresetMetadata`: destination bank/index + name (45B).
//   3. `buildPresetConfirm`: same body shape as `buildNameRequest`,
//      different cmd + flag (13B).
//   4. `buildBulkBegin`: "the bulk payload starts now" (10B). The captured
//      seq byte is ALWAYS 0 here, a deliberate reset from whatever the
//      running counter held (0x60,0x61,0x62 -> 0x00 in event 1); the
//      causal necessity of the reset is unconfirmed, but it is reproduced
//      verbatim rather than risked away.
//   5. 146 x `buildPresetDataFrame` (42B each): the SAME 32-byte payload
//      shape `dumpPacketPayload` parses on the read side, built in
//      reverse.
//   6. `buildNameRequest` again at the DESTINATION slot: the closing
//      query, answered with the NEW name. This is the write's actual
//      proof of persistence (an ack is not proof of a stored write; the
//      read-back is).
//
// DIRECTIONAL REUSE. Frames 2-5 reuse READ-side class bytes with the
// OPPOSITE role, and sometimes the OPPOSITE direction of "who normally
// sends this":
//   - NAME_REPLY (0x52): read-side, a device->host answer. Write-side, the
//     HOST sends it twice (metadata push, confirm) as a command.
//   - DUMP_ACK (0x15): read-side, a device->host "dump starting" ack.
//     Write-side, the HOST sends it once to mark "beginning the bulk
//     transfer".
//   - DUMP_MORE / DUMP_LAST (0x16 / 0x17): read-side, device->host data
//     packets. Write-side, the HOST sends them (identical 32-byte payload
//     shape) and the DEVICE ACKs each one.
//   - DUMP_NEXT (0x18): read-side, a host->device "send the next packet"
//     request (`buildDumpNext`, 11 bytes with a trailing flag byte).
//     Write-side, the DEVICE sends it back as a per-frame ACK
//     (`presetWriteAckMatcher`, 10 bytes, NO trailing flag byte -- a
//     different shape despite the shared class byte).
// Direction byte 5 is 0x01 (DIR_TO_DEVICE) on EVERY frame in this flow, in
// BOTH directions, exactly like the read-side dump packets (see the
// "Preset-dump reply matchers" note above) -- so a write-flow matcher must
// key off the COMMAND byte + seq, never the direction byte.

/**
 * ASCII name field width in a preset-write metadata/confirm frame. Matches
 * NAME_OFFSET's 45-byte reply shape: the field runs bytes 21..43 inclusive.
 */
export const PRESET_NAME_FIELD_LENGTH = 23;

function presetNameField(name: string): number[] {
  if (name.length > PRESET_NAME_FIELD_LENGTH) {
    throw new Error(
      `MicroFreak preset name "${name}" is ${name.length} characters; the write frame's name field holds ${PRESET_NAME_FIELD_LENGTH}.`,
    );
  }
  const bytes = [...name].map((c) => c.charCodeAt(0) & 0x7f);
  while (bytes.length < PRESET_NAME_FIELD_LENGTH) bytes.push(0x00);
  return bytes;
}

/**
 * WRITE metadata push: destination bank/index, a preset "Type"/category
 * tracking byte, and the preset name. 45 bytes, byte-exact against
 * `event1-out.syx` frame index 1 (event2/event3 index 1 differ only in
 * the varying fields):
 *
 *   `F0 00 20 6B 07 01 61 23 52 03 78 00 00 00 00 00 00 78 06 09 33
 *    52 65 76 65 72 74 20 74 6F 20 49 72 6F 6E 00x9 F7`
 *
 * The six zero bytes at offsets 11-16 and the index value repeated at
 * offset 17 are constant across all three captured drags; their role is
 * unknown, and they are reproduced verbatim rather than guessed at.
 *
 * `presetType` is a HYPOTHESIS, not independently confirmed: only two data
 * points exist across the whole capture (0x09 for "Revert to Iron",
 * written twice; 0x05 for "Yggdrasil"), and the 4672-byte dump payload
 * does NOT carry it at any matching byte offset (checked programmatically:
 * no position in the "Revert to Iron" payload holds 0x09 where the
 * "Yggdrasil" payload holds 0x05), so it cannot be derived from an
 * `export_preset` dump. Defaults to 0x00, the value an empty "Init" slot
 * answers with -- filing the written preset with NO category rather than
 * risking a wrong one. See `decodePresetType` for what IS confirmed about
 * this byte (not yet wired into the write path).
 */
export function buildPresetMetadata(
  seq: number,
  destSlot0: number,
  name: string,
  presetType = 0x00,
  device = DEVICE_MICROFREAK,
): number[] {
  const { bank, index } = toBankIndex(destSlot0);
  return envelope(device, seq, [
    0x23, CMD.NAME_REPLY, bank, index,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    index, 0x06, presetType & 0x7f, 0x33,
    ...presetNameField(name),
  ]);
}

/**
 * WRITE confirm: same body shape as `buildNameRequest` (length 0x03, bank,
 * index, flag) but the cmd byte is NAME_REPLY (0x52, not READ_PRESET) and
 * the trailing flag is 0x01 (not 0x00). Byte-exact against
 * `event1-out.syx` frame index 2: `F0 00 20 6B 07 01 62 03 52 03 78 01 F7`.
 */
export function buildPresetConfirm(seq: number, destSlot0: number, device = DEVICE_MICROFREAK): number[] {
  const { bank, index } = toBankIndex(destSlot0);
  return envelope(device, seq, [0x03, CMD.NAME_REPLY, bank, index, 0x01]);
}

/**
 * WRITE begin-bulk marker: "the 146-packet payload starts now". 10 bytes,
 * length 0x00 (nothing follows the cmd byte). Byte-exact against
 * `event1-out.syx` frame index 3: `F0 00 20 6B 07 01 00 00 15 F7`. Callers
 * should pass `seq = 0`, matching every captured drag (see the module note
 * above on the seq reset).
 */
export function buildBulkBegin(seq: number, device = DEVICE_MICROFREAK): number[] {
  return envelope(device, seq, [0x00, CMD.DUMP_ACK]);
}

/**
 * WRITE data frame (one of 146): 32 payload bytes, the exact inverse of
 * `dumpPacketPayload`. `isLast` picks DUMP_LAST (0x17, the 146th frame)
 * over DUMP_MORE (0x16, the other 145). Byte-exact against
 * `event1-out.syx` frame index 4 (first frame, 0x16) and index 149 (last
 * frame, 0x17).
 */
export function buildPresetDataFrame(
  seq: number,
  chunk: readonly number[],
  isLast: boolean,
  device = DEVICE_MICROFREAK,
): number[] {
  if (chunk.length !== 32) {
    throw new Error(`buildPresetDataFrame: chunk must be exactly 32 bytes, got ${chunk.length}.`);
  }
  return envelope(device, seq, [0x20, isLast ? CMD.DUMP_LAST : CMD.DUMP_MORE, ...chunk]);
}

/**
 * Matcher for the device's per-frame ACK during a preset WRITE. The
 * metadata push, the confirm, the begin marker, and each of the 146 data
 * frames all get one (149 acks total per write). Reuses DUMP_NEXT's class
 * byte (0x18) in the OPPOSITE direction from `buildDumpNext`'s
 * host->device request: this is a device->host reply, 10 bytes, with NO
 * trailing flag byte (`buildDumpNext`'s request is 11 bytes with a
 * trailing 0x00 -- a different shape despite the shared class byte).
 * Byte-exact against `event1-in.syx` frame index 1:
 * `F0 00 20 6B 07 01 61 00 18 F7`.
 */
export function presetWriteAckMatcher(seq: number, device = DEVICE_MICROFREAK) {
  return (b: readonly number[]): boolean =>
    isArturia(b, device) && b[6] === (seq & 0x7f) && b[7] === 0x00 && b[8] === CMD.DUMP_NEXT;
}

/**
 * The "Type"/category byte from a NAME_REPLY frame: offset 19, one byte
 * before the 0x33 marker that precedes the name field at NAME_OFFSET.
 * Observed consistently across 4 independent readings in the capture: an
 * "Init" (empty) slot answers 0, and every reply naming an OCCUPIED slot
 * carries the SAME value the metadata push later used to (re)write that
 * exact preset (0x09 for "Revert to Iron", seen once in a destination
 * query reply AND in two separate metadata pushes; 0x05 for "Yggdrasil").
 * That cross-check (reply value == push value, for two different presets)
 * is stronger than the two raw data points suggest, but still only two
 * distinct VALUES. Round-trippable without knowing its semantics: copy it
 * from a source read to a destination write unchanged.
 *
 * The VALUE SPACE is now decoded: it is MCC's preset "Type" field, an
 * alphabetical ordinal (see `MICROFREAK_CATEGORIES` in `mfprojz.ts`),
 * recovered from the 322 non-empty presets of a device export whose names
 * partition cleanly across the twelve categories. Wired into
 * `buildPresetMetadata`'s call site via `restorePresetBinary`'s
 * `preset_type` option, which also checks this decoder's answer against
 * what it wrote in the closing read-back.
 */
export function decodePresetType(bytes: readonly number[]): number {
  return bytes[19] ?? 0;
}
