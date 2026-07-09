/**
 * Project-level Scale + Root setting in a Circuit Tracks `.ncs`.
 *
 * The Circuit constrains every note a synth/MIDI track plays to the project's
 * selected Scale + Root, and re-quantizes stored notes to it on playback (user
 * guide v3 p.30: "with some scales certain notes shift up or down"; the scale
 * "will be saved when you save the Project"). This matters for authoring: our
 * note tokens are ABSOLUTE pitches, so a non-Chromatic scale silently shifts
 * them — in the DEFAULT C Natural Minor, an authored C-maj7 arpeggio
 * C-E-G-B plays back as C-Eb-G-Bb (hardware-confirmed 2026-06-19, then fixed
 * by switching the project to Chromatic). Chromatic (type 15) is the only scale
 * containing all 12 notes, so it is the one scale under which authored absolute
 * pitches play literally — the orchestrator sets it whenever it writes a note
 * track.
 *
 * Tail layout (validated against the MIT namirsab/circuit-tracks-tools decoder
 * and the file bytes; clean-room — facts only): root at TAIL+16 (0x26D0C),
 * type at TAIL+17 (0x26D0D).
 *
 * Note on Root under Chromatic: setting Chromatic leaves the project Root at the
 * template's value (the blank template is 0/0 = C). Root is only irrelevant
 * WHILE Chromatic stays selected — if a performer later switches the project off
 * Chromatic on the device, the pattern is re-keyed from that template Root, not
 * from the authored key.
 */

import { NCS_FILE_SIZE } from './format.js';

/** Start of the per-project settings tail. */
export const TAIL_OFFSET = 0x26cfc;
export const SCALE_ROOT_OFFSET = TAIL_OFFSET + 16; // 0x26D0C, root 0..11 (0=C)
export const SCALE_TYPE_OFFSET = TAIL_OFFSET + 17; // 0x26D0D, type 0..15

/** The 16 scales, indexed by the stored type byte (device Scales View pads 17–32). */
export const SCALE_NAMES: readonly string[] = [
  'Natural Minor', 'Major', 'Dorian', 'Phrygian', 'Mixolydian',
  'Melodic Minor', 'Harmonic Minor', 'Bebop Dorian', 'Blues', 'Minor Pentatonic',
  'Hungarian Minor', 'Ukrainian Dorian', 'Marva', 'Todi', 'Whole Tone', 'Chromatic',
];
/** Chromatic = all 12 notes in scale ⇒ authored absolute pitches play literally. */
export const SCALE_CHROMATIC = 15;

/**
 * Pitch-class sets (semitones from the scale root) per scale type, used ONLY to
 * advise whether authored notes will be re-quantized by a chosen non-Chromatic
 * scale. This drives an advisory message, never the write or the device's
 * actual quantization — so an off-by-one on an exotic scale costs at most a
 * slightly-wrong warning count, not a wrong note. The common scales (minor,
 * major, the modes, pentatonic, blues, whole tone, chromatic) are the standard
 * definitions and reliable; the exotic ones (Bebop Dorian, Hungarian/Ukrainian,
 * Marva, Todi) use the conventional theory sets pending an on-device check.
 */
export const SCALE_INTERVALS: readonly (readonly number[])[] = [
  [0, 2, 3, 5, 7, 8, 10],          // 0  Natural Minor
  [0, 2, 4, 5, 7, 9, 11],          // 1  Major
  [0, 2, 3, 5, 7, 9, 10],          // 2  Dorian
  [0, 1, 3, 5, 7, 8, 10],          // 3  Phrygian
  [0, 2, 4, 5, 7, 9, 10],          // 4  Mixolydian
  [0, 2, 3, 5, 7, 9, 11],          // 5  Melodic Minor (ascending)
  [0, 2, 3, 5, 7, 8, 11],          // 6  Harmonic Minor
  [0, 2, 3, 4, 5, 7, 9, 10],       // 7  Bebop Dorian
  [0, 3, 5, 6, 7, 10],             // 8  Blues
  [0, 3, 5, 7, 10],                // 9  Minor Pentatonic
  [0, 2, 3, 6, 7, 8, 11],          // 10 Hungarian Minor
  [0, 2, 3, 6, 7, 9, 10],          // 11 Ukrainian Dorian
  [0, 1, 4, 6, 7, 9, 11],          // 12 Marva
  [0, 1, 3, 6, 7, 8, 11],          // 13 Todi
  [0, 2, 4, 6, 8, 10],             // 14 Whole Tone
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], // 15 Chromatic
];

/**
 * Count the DISTINCT authored pitch-classes that fall outside the given scale
 * (rooted at `root`) — i.e. the notes the device will silently shift. 0 for
 * Chromatic (every pitch-class is in scale) and for any fully in-key pattern.
 */
export function notesOutsideScale(notes: Iterable<number>, type: number, root: number): number {
  const set = new Set(SCALE_INTERVALS[type] ?? SCALE_INTERVALS[SCALE_CHROMATIC]);
  const offenders = new Set<number>();
  for (const note of notes) {
    const degree = ((note - root) % 12 + 12) % 12;
    if (!set.has(degree)) offenders.add(note % 12);
  }
  return offenders.size;
}

/**
 * The human advisory describing the scale a note-track upload set, given the
 * prior scale and how many authored pitch-classes the new scale will shift.
 * Pure (golden-testable); the writer folds the returned sentence into its
 * result `info`. Leads with a space so it concatenates cleanly.
 */
export function describeScaleChange(prior: ProjectScale, set: ProjectScale, outOfScale: number): string {
  const was = `(was ${prior.rootName} ${prior.name})`;
  if (set.name === 'Chromatic') {
    return ` Project scale set to Chromatic ${was} so the authored pitches play literally; ` +
      `change the scale on the device to remap them musically.`;
  }
  const head = ` Project scale set to ${set.rootName} ${set.name} ${was}.`;
  return outOfScale > 0
    ? `${head} WARNING: ${outOfScale} authored pitch-class(es) are outside ${set.rootName} ${set.name} and the ` +
      `device WILL shift them on playback; pass scale:"chromatic" to keep the exact pitches.`
    : `${head} All authored notes are in-key.`;
}

const ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export interface ProjectScale {
  root: number;      // 0..11 (0 = C)
  type: number;      // 0..15 (0 = Natural Minor … 15 = Chromatic)
  rootName: string;  // 'C'..'B'
  name: string;      // 'Natural Minor' … 'Chromatic'
}

function assertBuf(buf: Uint8Array): void {
  if (buf.length !== NCS_FILE_SIZE) {
    throw new RangeError(`.ncs buffer must be ${NCS_FILE_SIZE} bytes, got ${buf.length}`);
  }
}

/** Read the project's Scale + Root. */
export function getProjectScale(buf: Uint8Array): ProjectScale {
  assertBuf(buf);
  const root = buf[SCALE_ROOT_OFFSET];
  const type = buf[SCALE_TYPE_OFFSET];
  return {
    root,
    type,
    rootName: ROOT_NAMES[root] ?? `?${root}`,
    name: SCALE_NAMES[type] ?? `?${type}`,
  };
}

/** Set the project's Scale type (and optionally Root) in place. */
export function setProjectScale(buf: Uint8Array, type: number, root?: number): void {
  assertBuf(buf);
  if (!Number.isInteger(type) || type < 0 || type > 15) {
    throw new RangeError(`scale type must be 0..15, got ${type}`);
  }
  buf[SCALE_TYPE_OFFSET] = type;
  if (root !== undefined) {
    if (!Number.isInteger(root) || root < 0 || root > 11) {
      throw new RangeError(`scale root must be 0..11, got ${root}`);
    }
    buf[SCALE_ROOT_OFFSET] = root;
  }
}

/** Spoken scale-name aliases → stored type byte (musical vocabulary, not device). */
const SCALE_ALIASES: Readonly<Record<string, number>> = {
  'natural minor': 0, minor: 0, min: 0, aeolian: 0,
  major: 1, maj: 1, ionian: 1,
  dorian: 2, phrygian: 3,
  mixolydian: 4, mixo: 4,
  'melodic minor': 5, melodic: 5,
  'harmonic minor': 6, harmonic: 6,
  'bebop dorian': 7, bebop: 7,
  blues: 8,
  'minor pentatonic': 9, pentatonic: 9, 'min pent': 9,
  'hungarian minor': 10, hungarian: 10,
  'ukrainian dorian': 11, 'ukranian dorian': 11, ukrainian: 11,
  marva: 12, todi: 13,
  'whole tone': 14, 'whole-tone': 14, wholetone: 14,
  chromatic: 15,
};
const ROOT_PC: Readonly<Record<string, number>> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export interface ResolvedScale { type: number; root?: number; }

/**
 * Parse a spoken scale request into a stored type (+ optional root). Reads a
 * leading root note if present (`"C minor"` → root 0; `"G mixolydian"` → root
 * 7; `"Eb major"` → root 3) and matches the rest against the scale names /
 * aliases. A bare scale name (`"dorian"`, `"chromatic"`) sets the type and
 * leaves the root untouched. Throws on an unrecognized scale (no silent
 * fallback to the wrong scale).
 */
export function resolveScaleName(input: string): ResolvedScale {
  const raw = input.trim();
  let root: number | undefined;
  let rest = raw.toLowerCase();
  // Optional leading root note: a letter A–G + optional accidental, then a
  // word break (so "c minor" parses a root, but "chromatic" / "dorian" do not).
  const m = /^([a-g])(#|s|b|♯|♭)?(\s+|$)/i.exec(raw);
  if (m && m[3] !== '') {
    const pc = ROOT_PC[m[1].toLowerCase()];
    const acc = m[2] === '#' || m[2] === 's' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
    root = ((pc + acc) % 12 + 12) % 12;
    rest = raw.slice(m[0].length).trim().toLowerCase();
  }
  if (rest.length === 0) {
    throw new RangeError(`Scale "${input}" names a root but no scale type (e.g. "C minor", "G mixolydian").`);
  }
  const type = SCALE_ALIASES[rest];
  if (type === undefined) {
    throw new RangeError(`Unknown scale "${rest}". Known: ${SCALE_NAMES.join(', ')} (plus aliases minor/major/mixo/pentatonic…).`);
  }
  return { type, root };
}

