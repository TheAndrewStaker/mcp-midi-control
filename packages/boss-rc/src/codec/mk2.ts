/**
 * RC-505mk2 field dictionary + `.RC0` author helpers (single-letter dialect).
 *
 * Every mapping here is DEVICE-CONFIRMED against a real RC-505mk2 (2026-07-07)
 * unless marked `inferred`. Full evidence + the reference decode of the owner's
 * Memory 1 are in docs/manuals/other-gear/RC-505mk2-RC0-SCHEMA.md ("ASSIGN block
 * field dictionary" + "END-TO-END COORDINATION CONFIRMED ON HARDWARE").
 *
 * The codec (rc0.ts) is model-agnostic and byte-exact; this module is the
 * per-model knowledge (which leaf letter = which field, and the enum ordinals)
 * that turns a musician-level intent ("CC#81 plays track 2 and stops track 3")
 * into surgical setLeaf writes. Ordinals are RC-505mk2-specific: do NOT reuse
 * them for the RC-600 / RC-500 / mk1 siblings.
 */

import { Rc0Doc, setLeaf, getLeaf, leavesUnder } from './rc0.js';

/** The 10 ASSIGN leaves A..J, in device-confirmed field order. */
export const ASSIGN_LEAVES = {
  sw: 'A', // 0 OFF / 1 ON
  sourceMode: 'B', // 0 MOMENT / 1 TOGGLE (TOGGLE inferred)
  source: 'C', // SOURCE ordinal (see sourceOrdinal)
  reservedD: 'D', // 0 in every sampled assign
  actLo: 'E', // SOURCE ACT.LO 0..127
  actHi: 'F', // SOURCE ACT.HI 0..127
  reservedG: 'G', // 0 in every sampled assign
  target: 'H', // TARGET ordinal (see trackTargetOrdinal)
  targetMin: 'I', // TARGET MIN (0 = OFF for on/off targets)
  targetMax: 'J', // TARGET MAX (1 = ON for on/off targets)
} as const;

/**
 * Per-track TARGET functions, in the parameter-guide list order. The 11-wide
 * per-track stride and the first three functions (REC/PLY, PLY/STP, STOP) are
 * device-confirmed; the remaining eight offsets are `inferred` from the guide's
 * list order against the confirmed stride.
 */
export type TrackFn =
  | 'REC/PLY'
  | 'PLY/STP'
  | 'STOP'
  | 'CLEAR'
  | 'REVERSE'
  | 'UN/RED'
  | 'M.BACK'
  | 'R.BACK'
  | 'M.SET'
  | 'M.CLEAR'
  | 'LEVEL';

const TRACK_FN_OFFSET: Record<TrackFn, number> = {
  'REC/PLY': 0, // confirmed
  'PLY/STP': 1, // confirmed
  STOP: 2, // confirmed
  CLEAR: 3, // inferred
  REVERSE: 4, // inferred
  'UN/RED': 5, // inferred
  'M.BACK': 6, // inferred
  'R.BACK': 7, // inferred
  'M.SET': 8, // inferred
  'M.CLEAR': 9, // inferred
  LEVEL: 10, // inferred
};

export type TrackNumber = 1 | 2 | 3 | 4 | 5;

/**
 * TARGET ordinal for a per-track function. `H = (track - 1) * 11 + fn`.
 * Device-confirmed points: TRK2 REC/PLY=11, PLY/STP=12, STOP=13; TRK3
 * REC/PLY=22, PLY/STP=23, STOP=24. Non-per-track targets (CUR.TRK, global
 * transport, FX, mixer/mic) are NOT yet decoded and are refused by the author
 * path.
 */
export function trackTargetOrdinal(track: TrackNumber, fn: TrackFn): number {
  return (track - 1) * 11 + TRACK_FN_OFFSET[fn];
}

/** ASSIGN SOURCE: an onboard CTL footswitch, or an incoming MIDI CC. */
export type AssignSource = { kind: 'ctl'; n: 1 | 2 } | { kind: 'cc'; cc: number };

/**
 * SOURCE ordinal (`C`). CTL1=33, CTL2=34 (confirmed). MIDI CC in 64..95 maps as
 * `C = cc + 6` (confirmed at CC#80/81/82). The CC#01-31 base is UNSAMPLED, so a
 * CC in that range is refused rather than guessed.
 */
export function sourceOrdinal(src: AssignSource): number {
  if (src.kind === 'ctl') return src.n === 1 ? 33 : 34;
  const { cc } = src;
  if (cc >= 64 && cc <= 95) return cc + 6;
  throw new Error(
    `RC-505mk2 ASSIGN SOURCE for CC#${cc} is not decoded. Confirmed: CTL1/CTL2 and MIDI CC#64-95 (ordinal = CC# + 6). ` +
      `The CC#01-31 range uses a different, unsampled base; author it only after a device check.`,
  );
}

export type SourceMode = 'MOMENT' | 'TOGGLE';

/**
 * One ASSIGN slot's musician-level intent. The seven non-behavioural fields
 * carry the hardware-confirmed author-path defaults (MODE=MOMENT, ACT.LO=0,
 * ACT.HI=127, MIN=0/OFF, MAX=1/ON, D=G=0); override only when needed.
 */
export interface AssignSpec {
  /** SW: is this assignment active. */
  sw: boolean;
  /** The controller that drives the target. */
  source: AssignSource;
  /** Momentary trigger (default) vs latching toggle. */
  mode?: SourceMode;
  /** SOURCE active-range low (default 0). */
  actLo?: number;
  /** SOURCE active-range high (default 127). */
  actHi?: number;
  /** The per-track function this assignment controls. */
  target: { track: TrackNumber; fn: TrackFn };
  /** TARGET MIN (default 0 / OFF). */
  targetMin?: number;
  /** TARGET MAX (default 1 / ON). */
  targetMax?: number;
}

function assignPath(memId: string | number, slot: number): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > 16) {
    throw new Error(`RC-505mk2 ASSIGN slot must be 1..16, got ${slot}`);
  }
  return `database/mem#${memId}/ASSIGN${slot}`;
}

function clamp127(v: number, field: string): number {
  if (!Number.isInteger(v) || v < 0 || v > 127) {
    throw new Error(`${field} must be an integer 0..127, got ${v}`);
  }
  return v;
}

/**
 * One ASSIGN slot as raw wire ordinals (already resolved from display). The
 * lowest write primitive: `authorAssign` (structured) and the descriptor's
 * apply-path (schema-encoded) both funnel through `authorAssignRaw`.
 */
export interface RawAssign {
  sw: number; // 0/1
  mode: number; // 0 MOMENT / 1 TOGGLE
  sourceOrd: number; // C
  actLo: number; // E
  actHi: number; // F
  targetOrd: number; // H
  targetMin: number; // I
  targetMax: number; // J
}

/**
 * Write one ASSIGN slot's ten leaves (A..J) from raw ordinals, surgically:
 * every other byte in the file is preserved. The memory must already contain
 * the `ASSIGN<slot>` block (RC-505mk2 memories always ship all 16).
 */
export function authorAssignRaw(doc: Rc0Doc, memId: string | number, slot: number, raw: RawAssign): void {
  const base = assignPath(memId, slot);
  if (!doc.byPath.has(`${base}/${ASSIGN_LEAVES.sw}`)) {
    throw new Error(`RC-505mk2: no ASSIGN${slot} block at '${base}'. A real mk2 memory carries ASSIGN1..16; is this the right memory id / file?`);
  }
  const set = (letter: string, value: number): void => setLeaf(doc, `${base}/${letter}`, value);
  set(ASSIGN_LEAVES.sw, raw.sw ? 1 : 0);
  set(ASSIGN_LEAVES.sourceMode, raw.mode ? 1 : 0);
  set(ASSIGN_LEAVES.source, raw.sourceOrd);
  set(ASSIGN_LEAVES.reservedD, 0);
  set(ASSIGN_LEAVES.actLo, clamp127(raw.actLo, 'ACT.LO'));
  set(ASSIGN_LEAVES.actHi, clamp127(raw.actHi, 'ACT.HI'));
  set(ASSIGN_LEAVES.reservedG, 0);
  set(ASSIGN_LEAVES.target, raw.targetOrd);
  set(ASSIGN_LEAVES.targetMin, raw.targetMin);
  set(ASSIGN_LEAVES.targetMax, raw.targetMax);
}

/**
 * Clear one ASSIGN slot to the real-file blank shape (SW off, source/target 0,
 * ACT.LO 0 / ACT.HI 127, MIN 0 / MAX 1) — matches the blank assigns 8..16 of a
 * factory memory.
 */
export function clearAssign(doc: Rc0Doc, memId: string | number, slot: number): void {
  authorAssignRaw(doc, memId, slot, { sw: 0, mode: 0, sourceOrd: 0, actLo: 0, actHi: 127, targetOrd: 0, targetMin: 0, targetMax: 1 });
}

/**
 * Author one ASSIGN slot (1..16) from a structured spec, surgically. The seven
 * non-behavioural fields carry the hardware-confirmed defaults (MODE=MOMENT,
 * ACT.LO=0, ACT.HI=127, MIN=0/OFF, MAX=1/ON, D=G=0); override only when needed.
 */
export function authorAssign(doc: Rc0Doc, memId: string | number, slot: number, spec: AssignSpec): void {
  authorAssignRaw(doc, memId, slot, {
    sw: spec.sw ? 1 : 0,
    mode: (spec.mode ?? 'MOMENT') === 'TOGGLE' ? 1 : 0,
    sourceOrd: sourceOrdinal(spec.source),
    actLo: spec.actLo ?? 0,
    actHi: spec.actHi ?? 127,
    targetOrd: trackTargetOrdinal(spec.target.track, spec.target.fn),
    targetMin: spec.targetMin ?? 0,
    targetMax: spec.targetMax ?? 1,
  });
}

/** The 12 NAME leaves A..L (single-letter dialect). */
export const NAME_LEAVES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'] as const;
export const NAME_LENGTH = NAME_LEAVES.length;

/**
 * Encode a memory name to 12 ASCII char codes, space(32)-padded, truncated to
 * 12. Non-ASCII (code > 126) is rejected so the on-device display matches.
 */
export function encodeName(name: string): number[] {
  const codes: number[] = [];
  for (let i = 0; i < NAME_LENGTH; i++) {
    const ch = i < name.length ? name.charCodeAt(i) : 32;
    if (ch < 32 || ch > 126) throw new Error(`RC-505mk2 name: character '${name[i]}' (code ${ch}) is not printable ASCII 32..126`);
    codes.push(ch);
  }
  return codes;
}

/** Author a memory's NAME (12 char-code leaves) surgically. */
export function authorName(doc: Rc0Doc, memId: string | number, name: string): void {
  const codes = encodeName(name);
  NAME_LEAVES.forEach((letter, i) => setLeaf(doc, `database/mem#${memId}/NAME/${letter}`, codes[i]));
}

// ─────────────────────────────────────────────────────────────────────────────
// A/B <count> version arbitration
//
// Each memory is stored as a redundant pair MEMORY###A.RC0 / MEMORY###B.RC0.
// The trailing `<count>HHHH</count>` (4-char HEX after </database>) is a version
// counter; the device reads whichever file of the pair has the HIGHER count. On
// save it writes the OTHER slot with count+1, so the newest copy is always the
// max-count file. Author path: write the edited memory to the inactive slot,
// setting count = active + 1 (see the hardware-confirmed write above).
// ─────────────────────────────────────────────────────────────────────────────

const COUNT_MAX = 0xffff;

/** Parse a 4-char HEX `<count>` value to an int. */
export function parseCount(hex: string): number {
  const n = Number.parseInt(hex, 16);
  if (!Number.isInteger(n) || n < 0 || n > COUNT_MAX) throw new Error(`invalid RC0 <count> value '${hex}'`);
  return n;
}

/** Format an int as a 4-char uppercase HEX `<count>` value (device form). */
export function formatCount(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > COUNT_MAX) throw new Error(`RC0 <count> out of range 0..${COUNT_MAX}: ${n}`);
  return n.toString(16).toUpperCase().padStart(4, '0');
}

/** Read a doc's trailing `<count>` as an int, or undefined if the dialect has none (mk1 / RC-500). */
export function readCount(doc: Rc0Doc): number | undefined {
  const raw = getLeaf(doc, 'count');
  return raw === undefined ? undefined : parseCount(raw);
}

export type PairSlot = 'A' | 'B';

/** Which slot of an A/B pair the device currently reads (the higher count; ties favour A). */
export function activeSlot(countA: number, countB: number): PairSlot {
  return countA >= countB ? 'A' : 'B';
}

/**
 * Given the two counts of an A/B pair, decide which slot to WRITE and what
 * count to stamp on it: target the currently-inactive slot and set its count
 * one above the active slot, so the write becomes the new active copy (mirrors
 * the device's own save). Returns the slot to write and the count to set.
 */
export function planWrite(countA: number, countB: number): { writeSlot: PairSlot; count: number } {
  const active = activeSlot(countA, countB);
  const writeSlot: PairSlot = active === 'A' ? 'B' : 'A';
  const count = Math.min((active === 'A' ? countA : countB) + 1, COUNT_MAX);
  return { writeSlot, count };
}

/** Set a doc's trailing `<count>` to a specific int (4-char HEX). Throws if the dialect has no count leaf. */
export function setCount(doc: Rc0Doc, count: number): void {
  if (!doc.byPath.has('count')) throw new Error('this .RC0 has no trailing <count> (mk1 / RC-500 dialect); nothing to bump');
  setLeaf(doc, 'count', formatCount(count));
}

/** Decode a memory's NAME to a trimmed string (thin wrapper over the codec's char-code decoder). */
export function readName(doc: Rc0Doc, memId: string | number): string {
  return leavesUnder(doc, `database/mem#${memId}/NAME`)
    .map((l) => Number.parseInt(l.value, 10))
    .map((c) => (c >= 32 && c <= 126 ? String.fromCharCode(c) : ''))
    .join('')
    .replace(/\s+$/u, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Read path: inverse decoders (ordinal -> musician-level label). The write path
// (sourceOrdinal / trackTargetOrdinal) is the source of truth; these mirror it
// for reading an existing memory's Assign table back out. Ordinals outside the
// decoded ranges render as a raw `SOURCE#n` / `TARGET#n` token rather than a
// guess, so a read never silently mislabels an un-decoded (CUR.TRK / global /
// FX / mixer) target.
// ─────────────────────────────────────────────────────────────────────────────

const TRACK_FN_BY_OFFSET: TrackFn[] = [
  'REC/PLY', 'PLY/STP', 'STOP', 'CLEAR', 'REVERSE', 'UN/RED', 'M.BACK', 'R.BACK', 'M.SET', 'M.CLEAR', 'LEVEL',
];

/** Inverse of `sourceOrdinal`. Blank (`0`) reads as `(none)`; un-decoded ordinals as `SOURCE#n`. */
export function decodeSource(c: number): string {
  if (c === 0) return '(none)';
  if (c === 33) return 'CTL1';
  if (c === 34) return 'CTL2';
  if (c >= 70 && c <= 101) return `CC#${c - 6}`; // MIDI CC#64..95
  return `SOURCE#${c}`;
}

/**
 * Inverse of `trackTargetOrdinal`. Per-track ordinals 0..54 decode to `TRKn FN`;
 * others as `TARGET#n`. LABEL-CONFIDENCE CAVEAT: only REC/PLY, PLY/STP, and STOP
 * are device-confirmed; the other 8 functions (CLEAR, REVERSE, UN/RED, M.BACK,
 * R.BACK, M.SET, M.CLEAR, LEVEL) are INFERRED from the parameter-guide list order
 * against the confirmed 11-wide stride (see TRACK_FN_OFFSET), so a decoded label
 * for one of those is provisional until confirmed on hardware.
 */
export function decodeTarget(h: number): string {
  if (h < 0 || h > 54) return `TARGET#${h}`;
  const track = Math.floor(h / 11) + 1;
  const fn = TRACK_FN_BY_OFFSET[h % 11];
  return `TRK${track} ${fn}`;
}

/** One decoded Assign slot, read back from a memory doc for `get_preset`. */
export interface DecodedAssign {
  slot: number;
  sw: boolean;
  source: string;
  mode: SourceMode;
  actLo: number;
  actHi: number;
  target: string;
  targetMin: number;
  targetMax: number;
}

function leafInt(doc: Rc0Doc, path: string): number {
  return Number.parseInt(getLeaf(doc, path) ?? '0', 10) || 0;
}

/**
 * Decode one ASSIGN slot (1..16) of a memory to a humanized shape, or undefined
 * when that block is absent. Read-only; does not mutate the doc.
 */
export function readAssign(doc: Rc0Doc, memId: string | number, slot: number): DecodedAssign | undefined {
  const base = `database/mem#${memId}/ASSIGN${slot}`;
  if (!doc.byPath.has(`${base}/${ASSIGN_LEAVES.sw}`)) return undefined;
  return {
    slot,
    sw: leafInt(doc, `${base}/${ASSIGN_LEAVES.sw}`) === 1,
    source: decodeSource(leafInt(doc, `${base}/${ASSIGN_LEAVES.source}`)),
    mode: leafInt(doc, `${base}/${ASSIGN_LEAVES.sourceMode}`) === 1 ? 'TOGGLE' : 'MOMENT',
    actLo: leafInt(doc, `${base}/${ASSIGN_LEAVES.actLo}`),
    actHi: leafInt(doc, `${base}/${ASSIGN_LEAVES.actHi}`),
    target: decodeTarget(leafInt(doc, `${base}/${ASSIGN_LEAVES.target}`)),
    targetMin: leafInt(doc, `${base}/${ASSIGN_LEAVES.targetMin}`),
    targetMax: leafInt(doc, `${base}/${ASSIGN_LEAVES.targetMax}`),
  };
}

/**
 * Find the `<mem>` id inside a single-memory `.RC0` doc (each `MEMORY###.RC0`
 * holds exactly one `<mem id="N">`; the mk2 uses id `"0"`). Returns the id
 * string, or undefined if the doc has no `<mem>` section.
 */
export function memoryIdIn(doc: Rc0Doc): string | undefined {
  const m = doc.leaves.find((l) => l.path.startsWith('database/mem#'));
  if (!m) return undefined;
  const seg = m.path.split('/')[1]; // 'mem#0'
  return seg.slice('mem#'.length);
}

/** Decode all 16 ASSIGN slots of a memory (absent blocks skipped). */
export function readAllAssigns(doc: Rc0Doc, memId: string | number): DecodedAssign[] {
  const out: DecodedAssign[] = [];
  for (let slot = 1; slot <= 16; slot++) {
    const a = readAssign(doc, memId, slot);
    if (a) out.push(a);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply-path enum tables + label parsers. These back the descriptor's
// `blocks.assign` schema so `apply_preset` validates + round-trips the SAME
// labels `get_preset` emits (source `CC#81` / `CTL1`, target `TRK2 PLY/STP`,
// mode `MOMENT`/`TOGGLE`). Ordinal <-> label here is the inverse of the write
// helpers above; only the author-LEGAL sources are listed (CTL1/2 + CC#64-95),
// so an out-of-range source fails validation cleanly rather than being guessed.
// ─────────────────────────────────────────────────────────────────────────────

/** SOURCE ordinal -> label, for the author-legal sources only. */
export const SOURCE_ENUM_VALUES: Readonly<Record<number, string>> = (() => {
  const t: Record<number, string> = { 33: 'CTL1', 34: 'CTL2' };
  for (let cc = 64; cc <= 95; cc++) t[cc + 6] = `CC#${cc}`;
  return t;
})();

/**
 * TARGET ordinal -> label, for the decoded per-track functions (TRK1-5 x 11).
 * Same label-confidence caveat as `decodeTarget`: only REC/PLY, PLY/STP, and STOP
 * are device-confirmed; the other 8 per-track functions are INFERRED from the
 * parameter-guide order (see TRACK_FN_OFFSET) and provisional until hardware-confirmed.
 * The ordinals/stride are correct either way; only the human label of the inferred
 * 8 could be off by a position.
 */
export const TARGET_ENUM_VALUES: Readonly<Record<number, string>> = (() => {
  const t: Record<number, string> = {};
  for (let track = 1; track <= 5; track++) {
    for (const fn of Object.keys(TRACK_FN_OFFSET) as TrackFn[]) {
      t[trackTargetOrdinal(track as TrackNumber, fn)] = `TRK${track} ${fn}`;
    }
  }
  return t;
})();

/** SOURCE MODE ordinal -> label. */
export const MODE_ENUM_VALUES: Readonly<Record<number, string>> = { 0: 'MOMENT', 1: 'TOGGLE' };

function reverseEnum(table: Readonly<Record<number, string>>): Map<string, number> {
  return new Map(Object.entries(table).map(([ord, label]) => [label.toLowerCase(), Number(ord)]));
}
const SOURCE_BY_LABEL = reverseEnum(SOURCE_ENUM_VALUES);
const TARGET_BY_LABEL = reverseEnum(TARGET_ENUM_VALUES);
const MODE_BY_LABEL = reverseEnum(MODE_ENUM_VALUES);

/** Resolve a SOURCE label (`CTL1` / `CC#81`) OR a raw ordinal to the wire ordinal. */
export function sourceOrdinalFromDisplay(display: number | string): number {
  if (typeof display === 'number') {
    if (SOURCE_ENUM_VALUES[display] === undefined) throw new Error(`RC-505mk2 SOURCE ordinal ${display} is not an author-legal source (CTL1/CTL2 or MIDI CC#64-95).`);
    return display;
  }
  const o = SOURCE_BY_LABEL.get(display.trim().toLowerCase());
  if (o === undefined) throw new Error(`RC-505mk2 SOURCE '${display}' is not author-legal. Use CTL1/CTL2 or a MIDI CC in CC#64..CC#95 (CC#01-31 uses an unsampled base and is refused).`);
  return o;
}

/** Resolve a TARGET label (`TRK2 PLY/STP`) OR a raw ordinal to the wire ordinal. */
export function targetOrdinalFromDisplay(display: number | string): number {
  if (typeof display === 'number') {
    if (TARGET_ENUM_VALUES[display] === undefined) throw new Error(`RC-505mk2 TARGET ordinal ${display} is outside the decoded per-track set (TRK1-5 REC/PLY..LEVEL).`);
    return display;
  }
  const o = TARGET_BY_LABEL.get(display.trim().toLowerCase());
  if (o === undefined) throw new Error(`RC-505mk2 TARGET '${display}' is not a decoded per-track function. Use "TRKn <FN>" where FN is REC/PLY, PLY/STP, STOP, CLEAR, REVERSE, UN/RED, M.BACK, R.BACK, M.SET, M.CLEAR, or LEVEL.`);
  return o;
}

/** Resolve a SOURCE MODE label (`MOMENT`/`TOGGLE`) OR a raw ordinal to the wire ordinal. */
export function modeOrdinalFromDisplay(display: number | string): number {
  if (typeof display === 'number') return display ? 1 : 0;
  const o = MODE_BY_LABEL.get(display.trim().toLowerCase());
  if (o === undefined) throw new Error(`RC-505mk2 SOURCE MODE '${display}' must be MOMENT or TOGGLE.`);
  return o;
}
