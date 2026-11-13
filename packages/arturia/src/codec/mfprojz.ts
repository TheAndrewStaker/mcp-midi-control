/**
 * MIDI Control Center project archives (`.mfprojz`) and the per-preset `.mbp`
 * files inside them.
 *
 * An MCC project archive is a zip of one `.mbp` per preset slot. Each `.mbp`
 * is a Boost text archive whose trailing vector is the preset payload --
 * **byte-identical to what `export_preset` reads off the device**, verified
 * against a live hardware read (slot 196 "Chorgan", all 4672 bytes, 2026-08-15)
 * and against `samples/arturia-microfreak/dumps/preset-001.bin`. Values are
 * already 7-bit (0..127), so a payload goes straight onto the wire with no
 * unpacking: `presetPayloadToDumpBytes` frames it into exactly the 146-frame
 * stream `restorePresetBinary` consumes.
 *
 * This module deliberately does NOT open the zip. It takes the already-read
 * entries so the shipped package needs no archive dependency; the caller
 * supplies `{ path, bytes }` pairs from whatever reader it already has.
 *
 * ## The lex-rank trap, and why `slotOrder` exists
 *
 * A `.mbp`'s leading filename number is a POSITION LABEL consumed in
 * LEXICOGRAPHIC order, NOT a slot number. MCC writes device slot k to the
 * label at lex rank k of "01".."09","10".."99","100"..N -- so rank 11 is label
 * "100" and rank 21 is label "11". Reading the number as a slot scrambles
 * everything from slot 11 on. Confirmed three independent ways: the 2026-08-09
 * diff against a full `scan_locations` name scan (512/512 under the rank model,
 * scrambled under a numeric read), the device export's 322 payload-bearing
 * entries landing exactly on the device's 322 non-empty slots, and the live
 * rank-196 read above.
 */

/**
 * MCC's preset "Type" field, and the value the write path's metadata frame
 * carries (`buildPresetMetadata`'s `presetType`). The order is alphabetical;
 * decoded from the 322 non-empty presets in a device export, whose names
 * partition cleanly across these twelve (e.g. every `type 6` is a drum sound,
 * every `type 11` is a vocoder patch).
 *
 * Three presets in that corpus carry bit 7 set (128, 129, 131). Its meaning is
 * unknown and it is NOT round-trippable: a SysEx data byte cannot exceed 127,
 * so `buildPresetMetadata` masks it off and those presets write as 0/1/3.
 */
import { buildPresetDataFrame, DEVICE_MICROFREAK } from './sysex.js';

export const MICROFREAK_CATEGORIES = [
  'Bass', 'Brass', 'Keys', 'Lead', 'Organ', 'Pad',
  'Percussion', 'Sequence', 'SFX', 'Strings', 'Template', 'Vocoder',
] as const;

/** Payload length of one MicroFreak preset: 146 dump packets x 32 bytes. */
export const MICROFREAK_PAYLOAD_BYTES = 4672;

/** One entry parsed out of a `.mbp`. `payload` absent ⇒ an empty ("Init") slot. */
export interface MbpPreset {
  name: string;
  /** MCC's Type field. Index into `MICROFREAK_CATEGORIES` when < 12. */
  category: number;
  /** 7-bit preset payload, or `undefined` for an empty slot. */
  payload?: number[];
}

/** A `.mbp` file as read out of its archive. */
export interface ArchiveEntry {
  /** Path inside the archive. Only the basename's leading number is read. */
  path: string;
  bytes: Uint8Array;
}

/** An entry bound to the device slot it will be written to. */
export interface LibrarySlot extends MbpPreset {
  /** 1-based device slot, i.e. the number the front panel shows. */
  slot: number;
  path: string;
}

const HEADER_TOKENS_BEFORE_NAME = 8;

/**
 * Parse one `.mbp`. Returns `undefined` for anything that is not a MicroFreak
 * preset archive rather than guessing at a partial read.
 *
 * Layout, all validated against real MCC output:
 *   `22 serialization::archive 10 0 4 <a> <b> <nameLen> <name> <category> …`
 *   … then a trailing `<count> <count bytes>` vector (count 0 on an empty slot).
 * The name may contain spaces ("Glass Organ"), so it is read by the length
 * prefix at char level, never by whitespace tokenising.
 */
export function parseMbp(bytes: Uint8Array, expectedPayloadBytes = MICROFREAK_PAYLOAD_BYTES): MbpPreset | undefined {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  if (!text.startsWith('22 serialization::archive ')) return undefined;

  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < HEADER_TOKENS_BEFORE_NAME + 2) return undefined;

  const nameLength = Number(tokens[HEADER_TOKENS_BEFORE_NAME - 1]);
  if (!Number.isInteger(nameLength) || nameLength < 0) return undefined;

  // Walk to the end of the last header token to find where the name starts.
  let cursor = 0;
  for (let i = 0; i < HEADER_TOKENS_BEFORE_NAME; i++) {
    const found = text.indexOf(tokens[i]!, cursor);
    if (found === -1) return undefined;
    cursor = found + tokens[i]!.length;
  }
  const name = text.slice(cursor + 1, cursor + 1 + nameLength);
  const afterName = text.slice(cursor + 1 + nameLength).split(/\s+/).filter((t) => t.length > 0);
  const category = Number(afterName[0]);
  // The category rides a 7-bit SysEx data byte, so anything outside 0..127 is
  // not a category this format can carry. Refusing here matters: the write
  // path masks with `& 0x7f`, which would turn 200 into 72 -- a DIFFERENT
  // valid category, written silently, and invisible to the read-back check
  // because that compares against the already-masked value.
  if (!Number.isInteger(category) || category < 0 || category > 127) return undefined;

  // The payload vector is a trailing run whose length is written immediately
  // before it, so there are exactly two shapes to accept: an empty slot
  // (`… 0`) or a full payload (`… <expected> <expected bytes>`). TEST THOSE
  // TWO POSITIONS DIRECTLY. An earlier version scanned the whole token array
  // for the largest N where `tokens[len-1-N] === String(N)`, which let any
  // header token whose value equalled its distance from the end win: an empty
  // slot in category 8 self-collided and the file was rejected as corrupt,
  // which `microfreak-send-library.ts` escalates into refusing a whole
  // 512-slot send.
  if (tokens[tokens.length - 1] === '0') return { name, category };
  const count = tokens[tokens.length - 1 - expectedPayloadBytes];
  if (count !== String(expectedPayloadBytes)) return undefined;

  const payload: number[] = [];
  for (let i = tokens.length - expectedPayloadBytes; i < tokens.length; i++) {
    const v = Number(tokens[i]);
    // A payload byte that is not 7-bit means this is not what we think it is;
    // it would also be illegal on the wire.
    if (!Number.isInteger(v) || v < 0 || v > 127) return undefined;
    payload.push(v);
  }
  return { name, category, payload };
}

/** The leading numeric label of a `.mbp` path, e.g. `…/100-Foo-A100.mbp` → `"100"`. */
function slotLabel(entryPath: string): string {
  const base = entryPath.split(/[\\/]/).pop() ?? entryPath;
  return base.split('-')[0] ?? base;
}

/**
 * Order archive entries into device-slot order, applying the lex-rank rule
 * documented at the top of this file. Entry at index i is device slot i + 1.
 *
 * Throws on duplicate labels: every real archive puts all its presets in one
 * directory with unique labels, so a duplicate means the archive is not shaped
 * the way this decode assumes and silently picking one would misplace presets.
 */
export function slotOrder<T extends { path: string }>(entries: readonly T[]): T[] {
  const labels = new Set<string>();
  for (const e of entries) {
    const label = slotLabel(e.path);
    if (labels.has(label)) {
      throw new Error(
        `.mfprojz has more than one preset labelled "${label}"; slot order is ambiguous. ` +
        `Every MCC archive seen so far holds all presets in one directory with unique labels.`,
      );
    }
    labels.add(label);
  }
  return [...entries].sort((a, b) => (slotLabel(a.path) < slotLabel(b.path) ? -1 : 1));
}

/**
 * Parse a whole project archive into slot-ordered presets. Entries that do not
 * parse are reported rather than dropped, so a caller never silently sends a
 * short library.
 */
export function parseLibrary(entries: readonly ArchiveEntry[]): {
  slots: LibrarySlot[];
  unparsed: string[];
} {
  const ordered = slotOrder(entries);
  const slots: LibrarySlot[] = [];
  const unparsed: string[] = [];
  ordered.forEach((entry, i) => {
    const preset = parseMbp(entry.bytes);
    if (preset === undefined) unparsed.push(entry.path);
    else slots.push({ ...preset, slot: i + 1, path: entry.path });
  });
  return { slots, unparsed };
}

/**
 * Frame a payload into the concatenated 146-frame SysEx stream that
 * `export_preset` writes and `restorePresetBinary` reads. The seq byte is
 * irrelevant here -- the write path re-stamps every frame with its own running
 * counter -- so it is left at 0, matching the captured begin-marker reset.
 */
export function presetPayloadToDumpBytes(
  payload: readonly number[],
  device = DEVICE_MICROFREAK,
): Uint8Array {
  if (payload.length !== MICROFREAK_PAYLOAD_BYTES) {
    throw new Error(`presetPayloadToDumpBytes: expected ${MICROFREAK_PAYLOAD_BYTES} payload bytes, got ${payload.length}.`);
  }
  // Delegate to the codec's own frame builder rather than re-literalising the
  // envelope. An earlier version hand-rolled identical bytes; they matched, but
  // a second encoder for one wire format is exactly the drift CLAUDE.md's
  // cross-package regression discipline warns about, and the framing test would
  // not have caught a divergence (it checks hardcoded expectations, not the
  // other encoder).
  const out: number[] = [];
  for (let offset = 0; offset < payload.length; offset += 32) {
    const isLast = offset + 32 >= payload.length;
    out.push(...buildPresetDataFrame(0, payload.slice(offset, offset + 32), isLast, device));
  }
  return Uint8Array.from(out);
}
