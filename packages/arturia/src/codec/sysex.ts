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

/** Extract the null-padded ASCII preset name from a NAME_REPLY. */
export function decodePresetName(bytes: readonly number[]): string {
  const raw = bytes.slice(NAME_OFFSET, bytes.length - 1);
  const end = raw.indexOf(0x00);
  return String.fromCharCode(...(end === -1 ? raw : raw.slice(0, end)));
}
