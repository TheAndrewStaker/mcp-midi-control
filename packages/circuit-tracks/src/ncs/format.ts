/**
 * Novation Circuit Tracks `.ncs` project-file format: constants + offsets.
 *
 * The on-disk `.ncs` (one per project, in a Pack's `projects/` or the card's
 * `Sessions/` folder) is a fixed 160,780-byte RAW structured blob: not
 * compressed, not encrypted (measured entropy ~1.35 bits/byte), with a
 * readable project name at offset 0x10. ~97% of the file is constant
 * scaffolding shared by every project; only the small per-project payload
 * varies. That makes "template-modify" (keep the file verbatim, change only
 * the bytes you mean to) safe and cheap.
 *
 * The format here is reverse-engineered (clean-room: layout facts only,
 * validated byte-exact against a corpus of real exported projects). Format
 * facts are uncopyrightable; this is an independent TypeScript implementation.
 *
 * Block layout: 64 "blocks", each a (track, pattern) cell. Tracks are Synth1,
 * Synth2 (0-1), Drum1-4 (2-5), MIDI1-2 (6-7); 8 patterns each. Blocks 0-15 are
 * synth, 16-47 are drum, 48-63 are MIDI. Each block's step data ENDS at its
 * metadata offset and begins `region` bytes earlier.
 */

export const NCS_FILE_SIZE = 160_780;

/**
 * STRUCTURAL VALIDITY, the check the device's CRC CANNOT do for us.
 *
 * ## The finding this exists for (2026-07-29)
 *
 * `card-backup-2026-07-27T16-49Z/pack1/proj64__63_OOO.ncs` is 160,780 bytes,
 * carries the `USER` magic, and its backup manifest records
 * `"crc_verified": true`. It is also garbage: `0xF0` bytes recur on a 2-byte
 * period throughout the body and the header's own `totalSessionSize` reads
 * 267,395,056 where every other project on the card reads 160,780. It is a
 * de-framing failure that the CRC pass waved through.
 *
 * **The device's WRITE_FINISH CRC32 covers the ENCODED STREAM, not the decoded
 * file.** So a transfer can be perfectly faithful while the thing it faithfully
 * carried is not a project. A bad MSB de-interleave, an off-by-one on the frame
 * trailer, a dropped block boundary: all of them survive the CRC, because the
 * CRC agrees with the bytes as sent. "CRC verified" therefore means "the
 * transfer was not corrupted", and it has never meant "the file is a project".
 * Every claim of the second kind that rested on the first was too strong.
 *
 * ## What this checks, and why exactly these
 *
 * Three cheap invariants, each independently sufficient to reject a de-framing
 * failure, taken together because each catches a different shear:
 *
 *   - **length** is `NCS_FILE_SIZE`. Catches truncation and over-read.
 *   - **`USER` magic at 0x00.** Catches a stream that never started where we
 *     think it did. (The `OOO` file PASSES this one, which is the point of
 *     having all three: the first four bytes survived and everything after
 *     them sheared.)
 *   - **`totalSessionSize` (LE uint32 at 0x04) is `NCS_FILE_SIZE`.** The file
 *     states its own length; a de-framed stream states some other number. This
 *     is the check that actually catches `OOO`, and it is self-validating in
 *     the strong sense: the value is not our convention, it is the file's own
 *     claim about itself, and it agrees with the length on all 97 good
 *     projects of the card capture.
 *
 * Deliberately NOT here: tempo range, swing range, chain-table shape. Those are
 * real checks and they live in the card-map scanner, which layers them on top of
 * this. They belong to "does this project look sane", not to "is this file a
 * project at all", and folding them in here would make an upload refuse a file
 * over a tempo byte.
 */
export const NCS_MAGIC = 'USER';
/** The file states its own total length here, LE uint32. Reads `NCS_FILE_SIZE` on every valid project. */
export const NCS_TOTAL_SESSION_SIZE_OFFSET = 0x04;

/** Verdict of {@link checkNcsStructure}. `faults` is empty exactly when `ok`. */
export interface NcsStructure {
  ok: boolean;
  /** One human-readable line per failed invariant, in check order. */
  faults: string[];
}

/**
 * Is this buffer structurally a Circuit Tracks project? Pure, no I/O, cheap
 * enough to run on every decoded file. NEVER throws: callers that want a hard
 * stop use {@link assertNcsStructure}, callers that want to RECORD the verdict
 * (a backup manifest, a card map) need the faults, not an exception.
 */
export function checkNcsStructure(buf: Uint8Array): NcsStructure {
  const faults: string[] = [];
  if (buf.length !== NCS_FILE_SIZE) {
    // A short buffer cannot carry the other two fields, so report and stop.
    return { ok: false, faults: [`length ${buf.length} bytes, expected ${NCS_FILE_SIZE}`] };
  }
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (magic !== NCS_MAGIC) {
    faults.push(`missing '${NCS_MAGIC}' magic at 0x00 (reads ${JSON.stringify(magic)})`);
  }
  const declared = (buf[4] | (buf[5] << 8) | (buf[6] << 16) | (buf[7] << 24)) >>> 0;
  if (declared !== NCS_FILE_SIZE) {
    faults.push(
      `totalSessionSize at 0x04 reads ${declared.toLocaleString('en-US')}, expected ${NCS_FILE_SIZE.toLocaleString('en-US')} ` +
      `(the file's own claim about its length disagrees with its length, which is what a de-framing failure looks like)`,
    );
  }
  return { ok: faults.length === 0, faults };
}

/**
 * The one sentence every surface uses to report a structure failure, so the
 * condition reads the same in a backup log, a card map, a tool error and a
 * verify script.
 *
 * `crcVerified: true` produces the LOUDER wording on purpose. A transfer that
 * failed is a known, ordinary condition with an obvious remedy (retry). A
 * transfer that SUCCEEDED and delivered a non-project is a different and more
 * interesting thing: it means the bytes on the card are bad, retrying will
 * faithfully re-fetch the same garbage, and the CRC verdict standing next to it
 * is not evidence of anything about the file. Collapsing the two into "invalid"
 * loses exactly the distinction that matters.
 */
export function ncsStructureNote(faults: readonly string[], opts: { crcVerified?: boolean } = {}): string {
  const what = faults.join('; ');
  if (opts.crcVerified === true) {
    return (
      `CRC-VERIFIED BUT STRUCTURALLY INVALID: ${what}. The transfer itself was clean, so this is NOT a ` +
      `transfer failure and retrying will fetch the same bytes: the device's WRITE_FINISH CRC32 covers the ` +
      `ENCODED STREAM, not the decoded file, so it cannot see a de-framing failure. Treat the file as unusable.`
    );
  }
  return `STRUCTURALLY INVALID: ${what}.`;
}

/**
 * Hard gate for the paths that must not proceed on a non-project: anything that
 * WRITES these bytes to a device slot. Throws `RangeError` naming every fault.
 */
export function assertNcsStructure(buf: Uint8Array, what = '.ncs project'): void {
  const v = checkNcsStructure(buf);
  if (!v.ok) throw new RangeError(`${what}: ${ncsStructureNote(v.faults)}`);
}

/**
 * PROJECT NAME: the human name the device's pack directory and Components show
 * for a project. Fixed field at 0x10..0x2F: 32 bytes of space-padded ASCII, no
 * terminator (the pad IS the terminator).
 *
 * HARDWARE-PROVEN WRITE CLASS. This exact edit (space-padded ASCII into
 * 0x10..0x2F, nothing else touched) is the rename surgery the After Dark
 * rebuild shipped on real slots (`scripts/circuit-after-dark-rename.ts`,
 * verified on-device 2026-07-28): the renamed projects load, play, and list
 * under their new names. The field width is corroborated by the blank template,
 * which is space-filled through 0x2F, and by every project in the 2026-07-29
 * card backup.
 *
 * REFUSES rather than truncates. A 33-character name silently cut to 32 is two
 * different songs reading identically on the card, with nothing in any receipt
 * to say so; same for non-ASCII, which the device's charset cannot represent
 * (the closest byte would render as a different character). The caller decides
 * the short form.
 */
export const PROJECT_NAME_OFFSET = 0x10;
/** Width of the stored name field in bytes (0x10..0x2F inclusive). */
export const PROJECT_NAME_LEN = 32;

/** Is this string storable in the name field as-is? One rule for set + apply. */
function assertProjectName(name: string): void {
  if (name.length === 0) {
    throw new RangeError('project name must not be empty (1..32 printable ASCII characters)');
  }
  if (name.length > PROJECT_NAME_LEN) {
    throw new RangeError(
      `project name "${name}" is ${name.length} characters; the stored field holds at most ${PROJECT_NAME_LEN}. ` +
      'Shorten it (nothing is truncated silently)',
    );
  }
  const bad = [...name].find((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) > 0x7e);
  if (bad !== undefined) {
    throw new RangeError(
      `project name "${name}" contains ${JSON.stringify(bad)}, which is not printable ASCII; ` +
      'the stored field holds plain ASCII only (letters, digits, punctuation, spaces)',
    );
  }
}

/** Read the project's stored name (trailing pad spaces trimmed). */
export function getProjectName(buf: Uint8Array): string {
  assertNcsBuffer(buf);
  let s = '';
  for (let i = 0; i < PROJECT_NAME_LEN; i++) {
    const c = buf[PROJECT_NAME_OFFSET + i];
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '';
  }
  return s.trimEnd();
}

/**
 * Write the project's stored name in place (space-padded to the full 32-byte
 * field so no stale tail survives). Returns the previous name so a caller can
 * report what it displaced. Refuses an empty, over-long, or non-ASCII name.
 */
export function setProjectName(buf: Uint8Array, name: string): string {
  assertNcsBuffer(buf);
  assertProjectName(name);
  const prev = getProjectName(buf);
  for (let i = 0; i < PROJECT_NAME_LEN; i++) {
    buf[PROJECT_NAME_OFFSET + i] = i < name.length ? name.charCodeAt(i) : 0x20;
  }
  return prev;
}

/** What {@link applyProjectName} did, so a caller can phrase its own receipt. */
export interface ProjectNameStamp {
  /** The caller asked for nothing, so the template's own name stands. */
  inherited: boolean;
  /** A name was asked for AND it differs from what the file already held. */
  changed: boolean;
  /** The name the file carries after the call. */
  name: string;
  /** The name it carried before. Equal to `name` when `inherited`. */
  previous: string;
}

/**
 * AUTHORING-TIME STAMP, the same shape and backward-compatibility contract as
 * {@link applyProjectColour}: `name` is OPTIONAL and undefined is a NO-OP that
 * reports what the template carried, so an authoring path that never passes a
 * name behaves exactly as it did before this existed and the file stays
 * byte-identical. Mutates `buf` in place, before the transfer, so the bytes
 * ride the same CRC-gated upload as everything else authored into the file.
 */
export function applyProjectName(buf: Uint8Array, name?: string): ProjectNameStamp {
  assertNcsBuffer(buf);
  const previous = getProjectName(buf);
  if (name === undefined) return { inherited: true, changed: false, name: previous, previous };
  setProjectName(buf, name);
  return { inherited: false, changed: name !== previous, name, previous };
}

/**
 * PROJECT PAD COLOUR — the colour the device lights a project's pad with in
 * Projects View. LE uint32 at 0x0C, holding a palette index 0..13.
 *
 * HARDWARE-CONFIRMED 2026-07-29. Two projects on Pack 3 were edited offline as a
 * single-byte write here — index 0 and index 8 — uploaded, and the device
 * rendered the two pads RED and GREEN in Projects View, as written. Exactly one
 * byte of 160,780 changed per project: no re-serialisation, no CRC fixup, no
 * collateral. The same surgical class as {@link PROJECT_TEMPO_OFFSET}. Because
 * the two confirmed indices sit at opposite ends of the table rather than next to
 * each other, "the palette order is as tabulated" is a supported reading rather
 * than an N=1 extrapolation; the twelve indices between them are interpolation on
 * a monotonic spectrum.
 *
 * WHY IT MATTERS. Mid-song, the only thing the device shows in Projects View is
 * a grid of lit pads — not names. Before this, the sole visual boundary between
 * one song's projects and the next was a deliberately-blanked slot. Colour is
 * strictly better: it survives a reorganisation, costs no slot, and marks a whole
 * song rather than only its first project.
 *
 * ⚠ UNLIKE tempo and the mixer levels, a device-side Save should PRESERVE a
 * file-authored colour: it is not composed from a knob position at save time, and
 * the manual has Macro 1 START at the project's current colour during Save. That
 * specific sequence has not been exercised, so it is the expectation, not a
 * finding.
 *
 * The neighbouring header word at 0x08 only ever holds 0 or 1 across 500 local
 * files, so it cannot be the colour and is left alone. (A reference decode labels
 * the two fields with each other's names while describing their contents
 * correctly; the hardware test settles it in favour of the descriptions.)
 */
export const PROJECT_COLOUR_OFFSET = 0x0c;

/**
 * The device's 14 project colours, in palette-index order. The order is a
 * spectrum, Red round to Pink, so "the Nth colour" is memorable without a table.
 * Names are Novation's own (user guide "Changing Project Colours", p.96, and the
 * Components projects view).
 */
export const PROJECT_COLOURS = [
  'Red', 'Rose', 'Peach', 'Orange', 'Sand', 'Yellow', 'Khaki',
  'Lime', 'Green', 'Teal', 'Cyan', 'Blue', 'Purple', 'Pink',
] as const;
export type ProjectColourName = typeof PROJECT_COLOURS[number];

/**
 * How a caller names a colour: a palette index 0..13, or a name from
 * {@link PROJECT_COLOURS} (matched case-insensitively, so `'green'` works).
 * Names are preferred at every call site a human writes — `8` is unreadable and
 * an off-by-one in it is invisible.
 */
export type ProjectColourRef = number | string;

/**
 * Blue. Every one of the 474 projects the maintainer has ever saved reads this,
 * and the user guide calls the untouched colour "dark blue", so it is the
 * factory default rather than a choice.
 *
 * Consequence worth stating: a project left at Blue is indistinguishable from a
 * project nobody has stamped yet. Treat "still Blue" as "not processed", which is
 * why Blue is LAST in {@link DISTINCT_COLOURS}.
 */
export const PROJECT_COLOUR_DEFAULT = 11;

/**
 * Palette indices ordered MOST-SEPARABLE-FIRST, so taking the first N gives the
 * highest-contrast N-colour set for free.
 *
 * ## The problem this solves
 *
 * The palette is a 14-step spectrum, which means adjacent entries are
 * deliberately close in hue: Red/Rose, Peach/Orange, Khaki/Lime, Green/Teal,
 * Cyan/Blue. Assigning songs the naive way — song 1 = colour 0, song 2 = colour
 * 1 — therefore yields pads a performer cannot tell apart across a dark stage,
 * which defeats the entire point of colouring them. Walking this list instead
 * spends the wheel evenly no matter how many songs a pack holds.
 *
 * ## How the order was derived
 *
 * Greedy maximum-separation over the spectrum: start at Red (one of the two
 * hardware-rendered anchors), then repeatedly take the entry furthest from
 * everything already taken, scoring separation two ways and requiring both to
 * agree — by perceptual colour CATEGORY (red / orange / yellow / green / cyan /
 * blue / purple / magenta, the categories an RGB pad can actually be named at a
 * distance) and by circular distance in PALETTE INDEX, since the doc's own
 * confusable pairs are all index-adjacent. The first six entries are pairwise
 * non-adjacent in index AND land in six different categories.
 *
 * Two deliberate departures from pure greedy:
 *   - **Pink (13) is 7th, not earlier.** It is index-adjacent to both Red (0) and
 *     Purple (12) once those are taken.
 *   - **Blue (11) is last.** It is the untouched default (see
 *     {@link PROJECT_COLOUR_DEFAULT}), so using it early destroys the "still
 *     Blue = not stamped yet" signal, and it is index-adjacent to Cyan (10),
 *     which the palette evidence names as a confusable pair.
 *
 * ## Confidence
 *
 * The eight entries are the eight nameable categories, so the SET is on solid
 * ground. The RANK ORDER between near-equals (Purple vs Green, Pink vs Orange)
 * is a judgement from the palette NAMES: exactly two of the fourteen hues have
 * been seen rendered on hardware (0 Red and 8 Green, both in this list, both
 * rendering as their names say). Everything else assumes Novation's names
 * describe what the LED does. Treat the list as a good default, not a measured
 * ranking, until more indices are seen lit.
 */
export const DISTINCT_COLOURS: readonly number[] = [
  0,  // Red     — hardware-rendered 2026-07-29
  10, // Cyan    — near-opposite hue; Novation's own factory demos ship at it
  12, // Purple
  8,  // Green   — hardware-rendered 2026-07-29
  5,  // Yellow
  3,  // Orange
  13, // Pink    — first entry index-adjacent to an earlier pick
  11, // Blue    — LAST: the untouched default, and adjacent to Cyan
];

/** Label for a palette index, for receipts. Never throws; unknown reads as `index N`. */
export function projectColourName(index: number): string {
  return PROJECT_COLOURS[index] ?? `index ${index}`;
}

/**
 * Coerce a caller's colour (index or name) to a palette index, or REFUSE.
 *
 * Refuses rather than clamping or falling back to a default, for the same reason
 * {@link setProjectTempo} does: a silently-substituted colour is a pad that lights
 * the wrong colour with nothing in the receipt to say so, which is worse than an
 * error the caller has to answer.
 */
export function resolveProjectColour(colour: ProjectColourRef): number {
  if (typeof colour === 'string') {
    const hit = PROJECT_COLOURS.findIndex((c) => c.toLowerCase() === colour.trim().toLowerCase());
    if (hit === -1) {
      throw new RangeError(
        `unknown project colour ${JSON.stringify(colour)}; the device's palette is ` +
        `${PROJECT_COLOURS.map((c, i) => `${i}=${c}`).join(', ')}`,
      );
    }
    return hit;
  }
  if (!Number.isInteger(colour) || colour < 0 || colour >= PROJECT_COLOURS.length) {
    throw new RangeError(
      `project colour must be a palette index 0..${PROJECT_COLOURS.length - 1} ` +
      `(${PROJECT_COLOURS.join('/')}) or one of those names, got ${JSON.stringify(colour)}`,
    );
  }
  return colour;
}

/** Read the project's stored pad colour as a palette index (0..13 on a valid project). */
export function getProjectColour(buf: Uint8Array): number {
  assertNcsBuffer(buf);
  return buf[PROJECT_COLOUR_OFFSET];
}

/**
 * Write the project's pad colour in place, by index or name. Returns the previous
 * index so a caller can report what it displaced.
 *
 * The field is a little-endian uint32 and every real project holds a value under
 * 14, so the three high bytes are written as zero rather than left alone: they
 * ARE part of the field, and Novation's own `.ncs` validator carries a
 * "Session colour out of range" check that a stale high byte would trip. On any
 * genuine project they are already zero, so this is a one-byte change in
 * practice and a correct four-byte write in principle.
 */
export function setProjectColour(buf: Uint8Array, colour: ProjectColourRef): number {
  assertNcsBuffer(buf);
  const index = resolveProjectColour(colour);
  const prev = buf[PROJECT_COLOUR_OFFSET];
  buf[PROJECT_COLOUR_OFFSET] = index;
  buf[PROJECT_COLOUR_OFFSET + 1] = 0;
  buf[PROJECT_COLOUR_OFFSET + 2] = 0;
  buf[PROJECT_COLOUR_OFFSET + 3] = 0;
  return prev;
}

/** What {@link applyProjectColour} did, so a caller can phrase its own receipt. */
export interface ProjectColourStamp {
  /** The caller asked for nothing, so the template's own colour stands. */
  inherited: boolean;
  /** A colour was asked for AND it differs from what the file already held. */
  changed: boolean;
  /** The palette index the file carries after the call. */
  index: number;
  /** The palette index it carried before. Equal to `index` when `inherited`. */
  previous: number;
}

/**
 * AUTHORING-TIME STAMP. Give an authored project its colour as it is born,
 * instead of surgically patching the byte afterwards — the decode doc's own
 * recommendation, because a pack built colour-by-construction is correct before
 * it is ever uploaded, and a post-pass is a second device round-trip per project
 * that can be forgotten.
 *
 * `colour` is OPTIONAL and undefined is a NO-OP that reports what the template
 * carried. That is the whole backward-compatibility contract: an authoring path
 * that never passes a colour behaves exactly as it did before this existed, and
 * the project inherits the template's colour as it always has.
 *
 * Mutates `buf` in place, before the transfer, so the byte rides the same
 * CRC-gated upload as everything else authored into the file.
 */
export function applyProjectColour(buf: Uint8Array, colour?: ProjectColourRef): ProjectColourStamp {
  assertNcsBuffer(buf);
  const previous = buf[PROJECT_COLOUR_OFFSET];
  if (colour === undefined) return { inherited: true, changed: false, index: previous, previous };
  const index = resolveProjectColour(colour);
  setProjectColour(buf, index);
  return { inherited: false, changed: index !== previous, index, previous };
}

/**
 * PROJECT TEMPO + SWING — the Tempo/Swing pair the front panel edits, stored
 * per project as two adjacent plain bytes in the file header.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Tempo is a per-project stored field, and
 * loading a project applies it (user guide: "Projects loaded when the sequencer
 * is not running will play at the tempo that was in force when the Project was
 * saved"). So a project authored without writing this byte does not merely lack
 * a tempo — it silently adopts whatever tempo the TEMPLATE carried, and the song
 * plays at the wrong speed with nothing in the receipt to say so. That is not
 * hypothetical: it is what happened to a whole authored pack (every project read
 * the template's 120 while the song is 140), which is why the authoring path now
 * treats the stored tempo as a required decision rather than an optional extra.
 *
 * ENCODING: the byte IS the BPM, no offset and no scale. Established, not
 * assumed, from three independent points that a linear map cannot fit any other
 * way (`y = a·x + b` through three identities forces `a=1, b=0`):
 *   - the user guide's documented default of 120 for a new project, which every
 *     never-tempo-touched project on the maintainer's card reads exactly;
 *   - a project whose song is 108 bpm reads exactly 108;
 *   - a project whose song is 122 bpm reads exactly 122.
 * The documented range 40..240 also fits one byte with no room for an offset:
 * any `b > 15` would put 240 past 0xff. Corroborated structurally by the
 * ADJACENT byte, which reads exactly 50 on every project on the card — the
 * documented Swing default — so the pair reads as the front panel's own
 * "Tempo/Swing" grouping rather than as two unrelated bytes.
 *
 * ⚠ A DEVICE-SIDE SAVE RE-SERIALISES FROM LIVE DEVICE STATE, exactly as it does
 * for the mixer levels below. If the tempo is dialled on the front panel and the
 * project is hand-saved, the stored byte becomes the DEVICE's tempo, not the one
 * authored here. So a file-authored tempo is authoritative only until the next
 * manual save; re-apply after one. (Read the other way, this is also why some
 * projects on the card carry their correct song tempo despite the authoring path
 * never having written it: they were set by hand and the device saved them.)
 *
 * Range and default are the user guide's, verbatim: "Circuit Tracks will operate
 * at any tempo in the range 40 to 240 BPM; the default tempo for a new Project
 * is 120 BPM", and for swing "its default value of 50 (the range is 20 to 80)".
 * The internal clock is integer-only ("no fractional tempo values").
 */
export const PROJECT_TEMPO_OFFSET = 0x34;
/** Adjacent to the tempo; the front panel edits the pair together (Macro 1 / Macro 2 in Tempo View). */
export const PROJECT_SWING_OFFSET = 0x35;
/** Slowest tempo the device will run (user guide). A lower value is refused, never clamped. */
export const TEMPO_MIN_BPM = 40;
/** Fastest tempo the device will run (user guide). */
export const TEMPO_MAX_BPM = 240;
/** The tempo a new project gets, and therefore the value a blank template carries. */
export const TEMPO_DEFAULT_BPM = 120;
/** Swing bounds and default (user guide). 50 = even, no swing. */
export const SWING_MIN = 20;
export const SWING_MAX = 80;
export const SWING_DEFAULT = 50;

/** Read the project's stored tempo in BPM. */
export function getProjectTempo(buf: Uint8Array): number {
  assertNcsBuffer(buf);
  return buf[PROJECT_TEMPO_OFFSET];
}

/**
 * Write the project's stored tempo in BPM, in place. Returns the previous value
 * so a caller can report what it displaced (an authored tempo that silently
 * replaces a hand-set one is the failure this whole field exists to surface).
 *
 * REFUSES out of range rather than clamping: a clamp turns "this song is 320
 * bpm" into a project that plays at 240 and says nothing, which is the same
 * silent-wrong-tempo failure by another route. The caller must decide.
 */
export function setProjectTempo(buf: Uint8Array, bpm: number): number {
  assertNcsBuffer(buf);
  if (!Number.isInteger(bpm) || bpm < TEMPO_MIN_BPM || bpm > TEMPO_MAX_BPM) {
    throw new RangeError(
      `tempo must be a whole number of BPM in ${TEMPO_MIN_BPM}..${TEMPO_MAX_BPM} ` +
      `(the device's range; its internal clock has no fractional tempos), got ${bpm}`,
    );
  }
  const prev = buf[PROJECT_TEMPO_OFFSET];
  buf[PROJECT_TEMPO_OFFSET] = bpm;
  return prev;
}

/** Read the project's stored swing (20..80; 50 = even). */
export function getProjectSwing(buf: Uint8Array): number {
  assertNcsBuffer(buf);
  return buf[PROJECT_SWING_OFFSET];
}

/**
 * TRACK MIXER region — decoded 2026-07-26 by controlled differential capture.
 *
 * Method: download a project, change ONE thing on the device, save to an empty
 * slot, download again, diff. Setting `synth1_level=10` and `synth2_level=20`
 * (deliberately distinct values, so each field is identified by its own value
 * rather than by guessing which of two adjacent bytes is which) moved **exactly
 * 2 bytes out of 160,780**, from 100 to precisely 10 and 20.
 *
 * Values are the RAW 0..127 level, the same scale as the project-channel CCs
 * (ch16 CC 12 = Synth 1 level, CC 14 = Synth 2 level). No rescaling.
 *
 * WHY THIS MATTERS: the mixer level is stored PER PROJECT and a project change
 * overwrites the live value, so a runtime CC cannot survive the next song
 * switch. Before this decode the only way to persist it was a manual Save on
 * the device, per project. Now it is a two-byte template edit, so
 * download -> patch -> upload works headlessly and batches across a whole pack.
 *
 * The layout reads as four LEVELS followed by four PANS (pans centre at 64).
 * Only the two synth levels are CONFIRMED; the rest are inferred and marked so.
 *
 * **The file order is NOT the CC declaration order, so do not map the remaining
 * two levels from it.** `params.ts` declares the block as synth1 (CC 12),
 * audio1 (CC 13), synth2 (CC 14), audio2 (CC 15) — interleaved. The capture
 * proves the FILE puts synth1 and synth2 ADJACENT (0x2701c=10, 0x2701d=20).
 * The two orderings therefore contradict each other, which makes the
 * audio1/audio2 assignment at 0x2701e/0x2701f an unresolved guess between two
 * candidate orderings, not a corollary. (The pans are split further still:
 * synth pans are CC 117/118, audio pans CC 35/36.) Confirm any of them the same
 * way the synth levels were confirmed: change one, save, diff.
 *
 * CORROBORATED ACROSS A CORPUS (2026-07-26), which matters because the decode
 * itself rests on a single differential sample. All 58 real projects of the
 * maintainer's Pack 5 were downloaded and inspected at this offset:
 *   - every file is exactly NCS_FILE_SIZE (no variable-length region upstream),
 *   - all 232 level bytes are <= 127 (i.e. the offset lands on real level data
 *     in every project, not on arbitrary payload),
 *   - 228 of 232 read exactly 100 (the factory default), and the ONLY four
 *     deviations are the two projects we had deliberately altered,
 *   - all 32 pan bytes read exactly 64 (centre) across every project, which
 *     independently supports the four-levels-then-four-pans reading.
 * A wrong or project-varying offset would show scattered values here instead.
 */
export const MIXER_SYNTH1_LEVEL = 0x2701c;   // CONFIRMED 2026-07-26
export const MIXER_SYNTH2_LEVEL = 0x2701d;   // CONFIRMED 2026-07-26
/** INFERRED from the 4-levels-then-4-pans layout. NOT confirmed by a diff. */
export const MIXER_AUDIO1_LEVEL_INFERRED = 0x2701e;
/** INFERRED. NOT confirmed by a diff. */
export const MIXER_AUDIO2_LEVEL_INFERRED = 0x2701f;
/** INFERRED: four pans, observed at 64 (centre) on an untouched project. */
export const MIXER_PAN_BASE_INFERRED = 0x27020;

/** Highest stored mixer level (synth + drum tracks; the CC scale's ceiling). */
export const MIXER_LEVEL_MAX = 127;

/** One range rule for every stored level write, so the refusal reads the same everywhere. */
function assertMixerLevel(level: number, what: string): void {
  if (!Number.isInteger(level) || level < 0 || level > MIXER_LEVEL_MAX) {
    throw new RangeError(
      `${what} stored mixer level must be an integer 0..${MIXER_LEVEL_MAX} ` +
      `(the raw fader scale, the same numbers as the mixer CCs; the factory default is 100), got ${level}`,
    );
  }
}

/** Read the stored mixer level (0..127) of a synth track. `synth` is 1 or 2. */
export function getSynthLevel(buf: Uint8Array, synth: 1 | 2): number {
  assertNcsBuffer(buf);
  return buf[synth === 1 ? MIXER_SYNTH1_LEVEL : MIXER_SYNTH2_LEVEL];
}

/**
 * Write one synth track's stored mixer level in place (both offsets CONFIRMED
 * by the 2026-07-26 differential). Returns the previous value so a caller can
 * report what it displaced. Refuses out of range, never clamps: a fader stored
 * at the wrong loudness with nothing in the receipt to say so is the failure
 * the stored-level surface exists to prevent.
 */
export function setSynthLevel(buf: Uint8Array, synth: 1 | 2, level: number): number {
  assertNcsBuffer(buf);
  assertMixerLevel(level, `synth ${synth}`);
  const off = synth === 1 ? MIXER_SYNTH1_LEVEL : MIXER_SYNTH2_LEVEL;
  const prev = buf[off];
  buf[off] = level;
  return prev;
}

/**
 * DRUM TRACK LEVELS — decoded 2026-07-26 by the same controlled differential.
 *
 * The drum levels are NOT in the `MIXER_*` block above: everything from
 * 0x27024 onward reads zero across the whole corpus, so the four levels there
 * are synth/audio only. The drums live in their own region, 0x60 bytes earlier,
 * on an 11-byte stride (each drum track's level sits inside a larger per-track
 * record whose remaining fields — patch, pitch, decay, distortion, eq, pan —
 * are not yet decoded; only the level byte is pinned).
 *
 * METHOD: set all four to DISTINCT values in one pass (Drum 1..4 = 10/20/30/40)
 * via their ch10 CCs (12 / 23 / 45 / 53), save on the device, re-download, diff.
 * Distinct values matter: each byte is then identified by its OWN value rather
 * than by guessing which of four near-identical bytes is which. Exactly 4 bytes
 * in the level range changed, each to the value it was set to, on a clean
 * 11-byte stride — a wrong offset would have produced scattered or partial hits.
 *
 * Values are the RAW 0..127 level, same scale as the CCs. 100 is the factory
 * default (all 232 drum-level bytes across the maintainer's 58-project pack read
 * 100 before this experiment).
 *
 * WHY IT MATTERS: authoring a condensed drum part onto the internal tracks is
 * only useful if it can be laid in SILENTLY (level 0) under an external kit, to
 * be dialled up from the mixer on demand. The level is stored per project and a
 * project change overwrites the live value, so a runtime CC cannot survive the
 * next song-part switch; only the stored byte does.
 *
 * ⚠ A DEVICE-SIDE SAVE OVERWRITES THESE FROM THE PHYSICAL KNOBS. The same diff
 * that decoded them also showed `MIXER_SYNTH1_LEVEL`/`MIXER_SYNTH2_LEVEL` moving
 * 0 -> 2 and 0 -> 39: values never sent, i.e. the live fader positions captured
 * at save time. So a hand-Save on the device silently reverts file-authored
 * levels. Re-apply them after any manual save.
 */
export const DRUM_LEVEL_BASE = 0x26fbd;
/** Bytes between consecutive drum-track level fields (Drum 1→2→3→4). */
export const DRUM_LEVEL_STRIDE = 11;
/** Byte offset of a drum track's stored mixer level. `track` is 0..3 = Drum 1..4. */
export function drumLevelOffset(track: number): number {
  if (!Number.isInteger(track) || track < 0 || track >= NUM_DRUM_TRACKS) {
    throw new RangeError(`drum track must be 0..${NUM_DRUM_TRACKS - 1} (Drum1..Drum4), got ${track}`);
  }
  return DRUM_LEVEL_BASE + track * DRUM_LEVEL_STRIDE;
}
function assertNcsBuffer(buf: Uint8Array): void {
  if (buf.length !== NCS_FILE_SIZE) {
    throw new RangeError(`.ncs buffer must be ${NCS_FILE_SIZE} bytes, got ${buf.length}`);
  }
}
/** Read the stored mixer level (0..127) of a drum track. `track` is 0..3 = Drum 1..4. */
export function getDrumLevel(buf: Uint8Array, track: number): number {
  assertNcsBuffer(buf);
  return buf[drumLevelOffset(track)];
}
/**
 * Write ONE drum track's stored mixer level in place and return the previous
 * value. The single-track sibling of {@link setDrumLevels}, for the partial
 * `mixer_levels` surface where the caller names exactly the tracks to touch
 * and every other track keeps the template's byte.
 */
export function setDrumLevel(buf: Uint8Array, track: number, level: number): number {
  assertNcsBuffer(buf);
  assertMixerLevel(level, `drum ${track + 1}`);
  const off = drumLevelOffset(track);
  const prev = buf[off];
  buf[off] = level;
  return prev;
}
/**
 * Write the four drum tracks' stored mixer levels in place (0..127 each, Drum
 * 1..4 in order) and return the byte offsets changed. Exactly `NUM_DRUM_TRACKS`
 * values: a partial list would leave the untouched tracks at whatever the
 * template held, which is the silent-until-it-isn't failure the level-0 policy
 * exists to prevent.
 */
export function setDrumLevels(buf: Uint8Array, levels: readonly number[]): readonly number[] {
  assertNcsBuffer(buf);
  if (levels.length !== NUM_DRUM_TRACKS) {
    throw new RangeError(`expected ${NUM_DRUM_TRACKS} drum levels (Drum1..Drum4), got ${levels.length}`);
  }
  const changed: number[] = [];
  for (let t = 0; t < NUM_DRUM_TRACKS; t++) {
    const level = levels[t];
    if (!Number.isInteger(level) || level < 0 || level > 127) {
      throw new RangeError(`drum ${t + 1} level must be an integer 0..127, got ${level}`);
    }
    const off = drumLevelOffset(t);
    buf[off] = level;
    changed.push(off);
  }
  return changed;
}
export const STEPS_PER_PATTERN = 32;
export const PATTERNS_PER_TRACK = 8;
export const NUM_DRUM_TRACKS = 4;

/** Drum step region = 16-byte header + 4 rows x 32 (velocity / probability / drum_choice / rhythm). */
export const DRUM_STEP_REGION = 16 + 4 * 32; // 144

/** Drum blocks occupy metadata indices 16..47 (4 tracks x 8 patterns). */
export const DRUM_BLOCK_START = 16;

/** Per-block metadata offsets (step data ends here). 64 entries. */
export const META_OFFSETS: readonly number[] = [
  // synth blocks 0-15
  0x664, 0x130c, 0x1fb4, 0x2c5c, 0x3904, 0x45ac, 0x5254, 0x5efc,
  0x6ba4, 0x784c, 0x84f4, 0x919c, 0x9e44, 0xaaec, 0xb794, 0xc43c,
  // drum blocks 16-47
  0xcdf4, 0xd49c, 0xdb44, 0xe1ec, 0xe894, 0xef3c, 0xf5e4, 0xfc8c,
  0x10334, 0x109dc, 0x11084, 0x1172c, 0x11dd4, 0x1247c, 0x12b24, 0x131cc,
  0x13874, 0x13f1c, 0x145c4, 0x14c6c, 0x15314, 0x159bc, 0x16064, 0x1670c,
  0x16db4, 0x1745c, 0x17b04, 0x181ac, 0x18854, 0x18efc, 0x195a4, 0x19c4c,
  // midi blocks 48-63
  0x1a5fc, 0x1b2a4, 0x1bf4c, 0x1cbf4, 0x1d89c, 0x1e544, 0x1f1ec, 0x1fe94,
  0x20b3c, 0x217e4, 0x2248c, 0x23134, 0x23ddc, 0x24a84, 0x2572c, 0x263d4,
];

/** Metadata-block index for a drum (track 0..3 = Drum1..Drum4, pattern 0..7). */
export function drumBlockIndex(track: number, pattern: number): number {
  if (!Number.isInteger(track) || track < 0 || track >= NUM_DRUM_TRACKS) {
    throw new RangeError(`drum track must be 0..${NUM_DRUM_TRACKS - 1} (Drum1..Drum4), got ${track}`);
  }
  if (!Number.isInteger(pattern) || pattern < 0 || pattern >= PATTERNS_PER_TRACK) {
    throw new RangeError(`pattern must be 0..${PATTERNS_PER_TRACK - 1}, got ${pattern}`);
  }
  return DRUM_BLOCK_START + track * PATTERNS_PER_TRACK + pattern;
}

/** Byte offset of row 0 (velocity) for a drum (track, pattern). Rows: vel+0, prob+32, choice+64, rhythm+96. */
export function drumRowBase(track: number, pattern: number): number {
  return META_OFFSETS[drumBlockIndex(track, pattern)] - DRUM_STEP_REGION + 16;
}

export const NOTE_SLOTS_PER_STEP = 6;         // up to a 6-note chord per step
/** Note step = 1 header record + 6 note slots, 4 bytes each = 28 bytes. */
export const NOTE_STEP_BYTES = 4 * (1 + NOTE_SLOTS_PER_STEP); // 28
/** Note step region = 32 steps x 28 bytes, ending at the block's metadata offset. */
export const NOTE_STEP_REGION = NOTE_STEP_BYTES * STEPS_PER_PATTERN; // 896

/**
 * The four "note" tracks share one identical 28-byte step codec (verified
 * byte-for-byte): the two Synths play it internally, the two MIDI tracks send it
 * out the MIDI/USB port to drive external gear. They differ ONLY in which 8
 * metadata blocks they own.
 */
export type NoteTrack = 'synth1' | 'synth2' | 'midi1' | 'midi2';
const NOTE_TRACK_BLOCK_START: Readonly<Record<NoteTrack, number>> = {
  synth1: 0, synth2: 8, midi1: 48, midi2: 56,
};
export const NOTE_TRACKS = Object.keys(NOTE_TRACK_BLOCK_START) as readonly NoteTrack[];

/** Metadata-block index for a note track (synth1/synth2/midi1/midi2, pattern 0..7). */
export function noteBlockIndex(track: NoteTrack, pattern: number): number {
  const start = NOTE_TRACK_BLOCK_START[track];
  if (start === undefined) throw new RangeError(`note track must be one of ${NOTE_TRACKS.join('/')}, got ${track}`);
  if (!Number.isInteger(pattern) || pattern < 0 || pattern >= PATTERNS_PER_TRACK) {
    throw new RangeError(`pattern must be 0..${PATTERNS_PER_TRACK - 1}, got ${pattern}`);
  }
  return start + pattern;
}

/** Byte offset of step 0 (the header record) for a note track (track, pattern). */
export function noteStepBase(track: NoteTrack, pattern: number): number {
  return META_OFFSETS[noteBlockIndex(track, pattern)] - NOTE_STEP_REGION;
}
