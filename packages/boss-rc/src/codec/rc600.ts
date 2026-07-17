/**
 * RC-600 `.RC0` field dictionary (single-letter dialect, RC-600 generation).
 *
 * STRUCTURE is confirmed byte-exact against TWO real RC-600 device files:
 * `SupportDoc/RolExample/DATA/MEMORY001A.RC0` and `MEMORY050A.RC0` from
 * paulelong/RCEditor (MIT-licensed; the "RolExample" support doc is a
 * community-captured 198-file dump of one RC-600 unit's `ROLAND/DATA` tree:
 * a real capture, not a synthetic sample). Local copies:
 * `samples/rc505mk2-oracle/RC600_MEMORY001A.RC0` / `RC600_MEMORY050A.RC0`
 * (gitignored). Confirmed from those two files:
 *
 *   - Envelope: `<database name="RC-600" revision="0">`, one `<mem id="0">`,
 *     trailing `<count>HHHH</count>`, IDENTICAL shape to the mk2's (see
 *     `mk2.ts`), just a different `name=` string.
 *   - NAME: 12 leaves `A..L`, ASCII char codes, space(32)-padded. Both real
 *     files decode correctly with the SAME `decodeCharCodes` the mk2 uses:
 *     MEMORY001A -> "BasicA" (66,97,115,105,99,65,32x6), MEMORY050A ->
 *     "Memory50" (77,101,109,111,114,121,53,48,32x4). Reused verbatim
 *     (`readName`/`authorName`/`encodeName` from `mk2.ts`); this is pure
 *     ASCII-table encoding with zero model-specific ordinal risk.
 *   - TRACK1..TRACK6: BOTH real memories carry six `TRACK1`..`TRACK6`
 *     sections (not five); this is the byte-level confirmation of the
 *     RC-600's 6-track claim (`TRACK_COUNT` below), independent of the mk2's
 *     5-track hardware confirmation.
 *   - ASSIGN1..ASSIGN16: 16 slots per memory (matches the Parameter Guide's
 *     "ASSIGN1-16" heading), each exactly 10 leaves `A..J`. BOTH real memories'
 *     all-16 slots carry the IDENTICAL blank-default byte pattern
 *     `A0 B0 C0 D0 E0 F127 G0 H0 I0 J1` as the mk2's own hardware-confirmed
 *     blank default (see `mk2.ts` `clearAssign`), strong circumstantial
 *     evidence the letter POSITIONS carry the same semantic roles (SW / mode /
 *     source / reserved / actLo / actHi / reserved / target / min / max)
 *     across both generations, even though neither corpus file has a
 *     POPULATED assign to confirm the source/target ORDINAL values from.
 *
 * WHAT IS NOT DECODED, AND WHY THIS MODULE REFUSES TO GUESS IT. The mk2's
 * `H = (track-1)*11 + fn` / `SOURCE C = cc+6` ordinal math (mk2.ts) was
 * decoded by diffing a real MK2 OWNER'S POPULATED Assign table against the
 * front-panel display; a capture this module has no RC-600 equivalent of
 * (both corpus files hold only blank factory assigns). Two independent
 * "guess from the manual's list order" attempts exist and DISAGREE with each
 * other, which is exactly why guessing is refused here:
 *
 *   1. The RC-600 Parameter Guide's own ASSIGN target list order (`TRK1-6
 *      REC/PLY, PLY/STP, STOP, CLEAR, REVERSE, UN/RED, M.BACK, R.BACK, M.SET,
 *      M.CLEAR, LEVEL`) reuses the mk2's SAME 11 function names in the SAME
 *      order, extended to 6 tracks (suggesting, but not proving, the mk2's
 *      track-major stride-11 math might carry over as `H = (track-1)*11+fn`
 *      for tracks 1-6 (H 0..65)).
 *   2. paulelong/RCEditor's OWN `AssignCatalog.cs` ("Ordinal follows table
 *      order" per its own comment, i.e. also a guess, not a hardware
 *      capture) uses the OPPOSITE grouping: function-major, track-minor
 *      (`TRK1-6 REC/PLY` occupies ordinals 1-6 as a block, THEN `TRK1-6
 *      PLY/STP` occupies 7-12, etc.); flatly contradicting hypothesis 1.
 *      Its sibling `Models.cs` `AssignSlot` class comments ALSO disagree with
 *      our own mk2-hardware-confirmed letter mapping (e.g. claims `Enabled`
 *      maps to leaf `J`, `TargetValue` to `D`), inconsistent with the
 *      confirmed mk2 letters AND with the two real RC-600 files' own blank
 *      pattern (where `J=1` in EVERY sampled slot, including disabled ones,
 *      so `J` cannot encode "enabled").
 *
 * Two people, two contradictory guesses, from the SAME sibling generation.
 * That is the concrete case for the "positional list order -> wire id" ban
 * already in `fractal-midi`'s primitives corpus; so this module does not attempt a
 * source/target ordinal-to-label map. `readAllAssigns` reports the SW flag
 * (byte-confirmed: `A`) plus RAW `SOURCE#n` / `TARGET#n` tokens (never a
 * guessed label), and the author path REFUSES to write a populated assign
 * slot. See docs/_private/RC600-RESEARCH-2026-07-09.md for the full
 * evidence table and what one real RC-600 owner capture would resolve.
 */

import { Rc0Doc, setLeaf, getLeaf } from './rc0.js';

/** RC-600 track count (TRACK1..TRACK6), confirmed against both real corpus files. */
export const TRACK_COUNT = 6;

/**
 * ASSIGN leaves A..J, same letter positions as the mk2 (see module docstring
 * for the byte-pattern evidence). Semantic ROLE names mirror the mk2's
 * `ASSIGN_LEAVES` for readability; only the mk2's `source`/`target`
 * ORDINAL VALUES are refused, not these letter positions.
 */
const ASSIGN_LEAVES = {
  sw: 'A',
  sourceMode: 'B',
  source: 'C',
  reservedD: 'D',
  actLo: 'E',
  actHi: 'F',
  reservedG: 'G',
  target: 'H',
  targetMin: 'I',
  targetMax: 'J',
} as const;

/** One decoded RC-600 Assign slot. `source`/`target` are always raw `SOURCE#n` / `TARGET#n` tokens (or `(none)`); see module docstring for why no label map is attempted. */
export interface DecodedAssignRc600 {
  slot: number;
  sw: boolean;
  source: string;
  mode: 'MOMENT' | 'TOGGLE';
  actLo: number;
  actHi: number;
  target: string;
  targetMin: number;
  targetMax: number;
}

function leafInt(doc: Rc0Doc, path: string): number {
  return Number.parseInt(getLeaf(doc, path) ?? '0', 10) || 0;
}

/** Format a raw SOURCE ordinal as a token, never a guessed label. `0` (the confirmed blank-default value) reads as `(none)`. */
function rawSourceToken(c: number): string {
  return c === 0 ? '(none)' : `SOURCE#${c}`;
}

/** Format a raw TARGET ordinal as a token, never a guessed label. `0` (the confirmed blank-default value) reads as `(none)`. */
function rawTargetToken(h: number): string {
  return h === 0 ? '(none)' : `TARGET#${h}`;
}

/**
 * Decode one ASSIGN slot (1..16) of an RC-600 memory to a humanized-but-honest
 * shape (raw source/target tokens), or undefined when the block is absent.
 * Read-only; does not mutate the doc.
 */
export function readAssign(doc: Rc0Doc, memId: string | number, slot: number): DecodedAssignRc600 | undefined {
  const base = `database/mem#${memId}/ASSIGN${slot}`;
  if (!doc.byPath.has(`${base}/${ASSIGN_LEAVES.sw}`)) return undefined;
  return {
    slot,
    sw: leafInt(doc, `${base}/${ASSIGN_LEAVES.sw}`) === 1,
    source: rawSourceToken(leafInt(doc, `${base}/${ASSIGN_LEAVES.source}`)),
    mode: leafInt(doc, `${base}/${ASSIGN_LEAVES.sourceMode}`) === 1 ? 'TOGGLE' : 'MOMENT',
    actLo: leafInt(doc, `${base}/${ASSIGN_LEAVES.actLo}`),
    actHi: leafInt(doc, `${base}/${ASSIGN_LEAVES.actHi}`),
    target: rawTargetToken(leafInt(doc, `${base}/${ASSIGN_LEAVES.target}`)),
    targetMin: leafInt(doc, `${base}/${ASSIGN_LEAVES.targetMin}`),
    targetMax: leafInt(doc, `${base}/${ASSIGN_LEAVES.targetMax}`),
  };
}

/** Decode all 16 ASSIGN slots of an RC-600 memory (absent blocks skipped). */
export function readAllAssigns(doc: Rc0Doc, memId: string | number): DecodedAssignRc600[] {
  const out: DecodedAssignRc600[] = [];
  for (let slot = 1; slot <= 16; slot++) {
    const a = readAssign(doc, memId, slot);
    if (a) out.push(a);
  }
  return out;
}

/**
 * Blank one ASSIGN slot to the real-file factory-default shape: the EXACT
 * byte pattern confirmed in both real RC-600 corpus files
 * (`A0 B0 C0 D0 E0 F127 G0 H0 I0 J1`). Safe to author: it writes only the
 * confirmed blank pattern, touching no undecoded source/target ordinal.
 */
export function clearAssign(doc: Rc0Doc, memId: string | number, slot: number): void {
  const base = `database/mem#${memId}/ASSIGN${slot}`;
  if (!doc.byPath.has(`${base}/${ASSIGN_LEAVES.sw}`)) {
    throw new Error(`RC-600: no ASSIGN${slot} block at '${base}'. A real RC-600 memory carries ASSIGN1..16; is this the right memory id / file?`);
  }
  const set = (letter: string, value: number): void => setLeaf(doc, `${base}/${letter}`, value);
  set(ASSIGN_LEAVES.sw, 0);
  set(ASSIGN_LEAVES.sourceMode, 0);
  set(ASSIGN_LEAVES.source, 0);
  set(ASSIGN_LEAVES.reservedD, 0);
  set(ASSIGN_LEAVES.actLo, 0);
  set(ASSIGN_LEAVES.actHi, 127);
  set(ASSIGN_LEAVES.reservedG, 0);
  set(ASSIGN_LEAVES.target, 0);
  set(ASSIGN_LEAVES.targetMin, 0);
  set(ASSIGN_LEAVES.targetMax, 1);
}

/**
 * ASSIGN source/target authoring is refused: no confirmed ordinal-to-label
 * map exists for the RC-600 (see module docstring). Only a memory rename
 * (`spec.name` via `apply_preset`, or `save_preset`) and blanking existing
 * assigns (which `apply_preset`'s FRESH-BUILD does for every slot regardless)
 * are supported today.
 */
export function refuseAssignAuthoring(fieldLabel: string): never {
  throw new Error(
    `RC-600 ASSIGN ${fieldLabel} authoring is not yet decoded: no confirmed ordinal-to-label map exists for the RC-600 ` +
      "(the mk2's math does not transfer to a 6-track unit, and two independent from-the-manual guesses of the RC-600's " +
      'own ordinal order disagree with each other, see the rc600.ts module docstring). It needs its own oracle: a real ' +
      'RC-600 owner backup with a POPULATED Assign table, or two saves with one field changed, diffed. Only a memory ' +
      'rename (apply_preset spec.name / save_preset) is supported today.',
  );
}
