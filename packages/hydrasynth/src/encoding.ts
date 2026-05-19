/**
 * Pure NRPN encoding helpers for the Hydrasynth Explorer.
 *
 * Extracted from `server.ts` so they can be exercised by golden tests
 * (`scripts/hydrasynth/verify-encoding.ts`) without instantiating a
 * MIDI connection. Three concerns live here:
 *
 *   1. **Value resolution** — reconcile user input (number 0..16383,
 *      number 0..127 expecting auto-scale, or enum name string) with
 *      the entry's metadata (multi-slot dataMsb, enum table, sparse-
 *      encoding scale, 14-bit wireMax). Returns the integer the
 *      device should see in the data field.
 *   2. **MIDI byte construction** — build the 4-CC NRPN sequence
 *      (CC 99 / 98 / 6 / 38) per MIDI standard, with the data-MSB
 *      either carrying a slot index (multi-slot params) or the
 *      high 7 bits of a 14-bit value.
 *   3. **Lookup / alias** — already in `nrpn.ts`'s `findHydraNrpn`,
 *      re-exported here for convenience.
 */
import { findHydraNrpn, HYDRASYNTH_NRPNS, type HydrasynthNrpn } from './nrpn.js';
import { HYDRASYNTH_ENUMS, resolveHydraEnum, type HydrasynthEnum } from './enums.js';

/** Lowercase, drop non-alphanumerics — for relaxed matching. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export interface NrpnSearchHit {
  readonly entry: HydrasynthNrpn;
  /** Ranking score; higher is better. Used internally and not surfaced. */
  readonly score: number;
  /** Which field matched — informs response formatting. */
  readonly matchSource: 'name' | 'alias' | 'notes';
}

/**
 * Split a string at digit→letter and letter→digit boundaries into
 * alternating word / number segments. Used by `looseMatchSegments` to
 * bridge user queries that have the right segments but wrong inter-
 * segment glue: "mod1depth" → ["mod", "1", "depth"] should still
 * structurally match "modmatrix1depth" even though no literal substring
 * of "mod1depth" appears in "modmatrix1depth".
 */
function tokenizeAlphaNum(s: string): string[] {
  return s.match(/\d+|[a-z]+/g) ?? [];
}

/**
 * Returns true when `name` contains every segment of `query` IN ORDER,
 * letting other characters appear between them. Used as a fallback when
 * exact prefix / contains search returns nothing — bridges "mod1depth"
 * → "modmatrix1depth", "ringmod1" → "ringmodsource1", etc.
 */
function looseMatchSegments(query: string, name: string): boolean {
  const segs = tokenizeAlphaNum(query);
  if (segs.length < 2) return false;
  let pos = 0;
  for (const seg of segs) {
    const idx = name.indexOf(seg, pos);
    if (idx < 0) return false;
    pos = idx + seg.length;
  }
  return true;
}

/**
 * Boundary-aware prefix score. When `q` is a prefix of `name`, prefer
 * the case where the next char in `name` is a NON-digit (so "modmatrix1"
 * matches "modmatrix1depth" cleanly but ranks lower for
 * "modmatrix15modsource" because position 10 is '5' — a longer number).
 * Returns the prefix-match base score with a bonus for tighter matches
 * (shorter unmatched-suffix length).
 */
function prefixScore(q: string, name: string, baseStrong: number, baseWeak: number): number {
  if (!name.startsWith(q)) return 0;
  const next = name.charAt(q.length);
  const tightnessBonus = Math.max(0, 8 - (name.length - q.length));
  // No "next" char → exact match (handled separately above) or empty;
  // a non-digit next char is a clean boundary; a digit means q sits in
  // the middle of a longer number, weaker structural match.
  const isBoundary = next === '' || !/\d/.test(next);
  return (isBoundary ? baseStrong : baseWeak) + tightnessBonus;
}

/**
 * Fuzzy-search the NRPN registry by query string. Returns ranked matches
 * across canonical name, aliases, and notes (case- and punctuation-
 * insensitive). Scoring tiers (highest first):
 *
 *   100 — exact name match
 *   95  — exact alias match
 *   90  — name prefix at boundary (modmatrix1 → modmatrix1depth)
 *   85  — alias prefix at boundary
 *   80  — name prefix at digit-mid (modmatrix1 → modmatrix15modsource)
 *   70  — name contains query
 *   65  — alias contains query
 *   50  — loose-segment match (mod1depth → modmatrix1depth)
 *   30  — notes contain query
 *
 * Plus a small tightness bonus (0–8) inside prefix tiers so the closest
 * match by length surfaces first. Used by:
 *   - error paths in `hydra_set_engine_param` / `_params` to suggest
 *     close-by names when a write is rejected;
 *   - the `hydra_param_catalog` tool to answer query-driven discovery.
 */
export function findMatchingNrpns(query: string, limit = 60): NrpnSearchHit[] {
  const q = normalize(query);
  if (!q) return [];
  const hits: NrpnSearchHit[] = [];

  for (const e of HYDRASYNTH_NRPNS) {
    const nameNorm = normalize(e.name);
    let bestScore = 0;
    let source: NrpnSearchHit['matchSource'] = 'name';

    if (nameNorm === q) bestScore = Math.max(bestScore, 100);
    else {
      const ps = prefixScore(q, nameNorm, 90, 80);
      if (ps > bestScore) bestScore = ps;
      if (bestScore < 70 && nameNorm.includes(q)) bestScore = 70;
    }

    if (e.aliases) {
      for (const a of e.aliases) {
        const aNorm = normalize(a);
        if (aNorm === q && bestScore < 95) { bestScore = 95; source = 'alias'; }
        else {
          const ps = prefixScore(q, aNorm, 85, 75);
          if (ps > bestScore) { bestScore = ps; source = 'alias'; }
          if (bestScore < 65 && aNorm.includes(q)) { bestScore = 65; source = 'alias'; }
        }
      }
    }

    // Loose-segment fallback: bridges queries like "mod1depth" →
    // "modmatrix1depth" where the segments are right but the user used
    // a more compact name than the canonical edisyn label. Only kicks
    // in if no stronger match was found, since otherwise it's noise.
    if (bestScore < 50 && looseMatchSegments(q, nameNorm)) {
      bestScore = 50;
      source = 'name';
    }

    // Notes match — lowest priority. Helps when Claude searches by concept
    // ("vowel", "ribbon", "phaser") and the param's notes mention the term
    // even if the canonical name doesn't.
    if (bestScore < 30 && normalize(e.notes).includes(q)) {
      bestScore = 30;
      source = 'notes';
    }

    if (bestScore > 0) hits.push({ entry: e, score: bestScore, matchSource: source });
  }

  hits.sort((a, b) => b.score - a.score || a.entry.name.length - b.entry.name.length);
  return hits.slice(0, limit);
}

/**
 * Format a search hit as a one-line summary suitable for tool responses.
 * Includes canonical name, alias hint, slot index, enum-table linkage, and
 * a truncated note. Single line per hit so a list of 30 stays readable.
 */
export function formatNrpnHit(hit: NrpnSearchHit): string {
  const e = hit.entry;
  const aliasPart = e.aliases && e.aliases.length > 0 ? ` (alias: ${e.aliases[0]})` : '';
  const slotPart = e.dataMsb !== undefined ? ` [slot ${e.dataMsb}]` : '';
  const enumPart = e.enumTable !== undefined ? ` [enum: ${e.enumTable}]` : '';
  const notesShort = e.notes.split('\n')[0]?.slice(0, 60) ?? '';
  const notesPart = notesShort ? ` — ${notesShort}${notesShort.length === 60 ? '…' : ''}` : '';
  return `  ${e.name}${aliasPart}${slotPart}${enumPart}${notesPart}`;
}

export interface ResolvedNrpnValue {
  /** Integer to send in the NRPN data field. */
  readonly wire: number;
  /** True when 7-bit auto-scaling kicked in. Surfaced in tool output for transparency. */
  readonly scaled: boolean;
  /**
   * True when the bipolar branch ran — input was treated as a signed
   * display value (-displayMax..+displayMax) and centered on
   * wireMax/2. Surfaced in tool output so callers see why "value 0"
   * went to wire-center instead of wire-zero.
   */
  readonly bipolar: boolean;
}

/**
 * Resolve user input to a wire integer.
 *
 *   - String input → enum-table lookup, then apply `enumValueScale`
 *     for sparse-encoded params (FX types use ×8: Bypass=0, Chorus=8,
 *     …, Distortion=72; reverbtime uses ×64).
 *   - Number on an **enum-table param with enumValueScale** (FX type
 *     selectors, reverb time index) → treat as the enum index and
 *     scale up to wire. Lets callers pass `reverbtime: 105` meaning
 *     REVERB_TIMES[105] = "16.0s" instead of fighting the table.
 *     Bounds-checked against the table; out-of-range throws.
 *   - Number on a bipolar 14-bit param (displayMin defined, < 0) →
 *     treat input as signed display value; auto-scale across the full
 *     wire range with input 0 mapping to wire-center. Range check
 *     against displayMin/displayMax — **out-of-range throws** so
 *     callers don't silently produce garbage (Session 49 reverbtone
 *     bug — passing 72 to a -64..+64 param was wrap-encoding to
 *     display 8.0).
 *   - Number ≤ 128 on a unipolar 14-bit non-slot non-enum param →
 *     auto-scale to the param's `wireMax` so callers can stay in
 *     0..128 mental model. Skipped for multi-slot registers.
 *   - Otherwise pass through.
 */
export function resolveNrpnValue(entry: HydrasynthNrpn, input: number | string): ResolvedNrpnValue {
  if (typeof input === 'string') {
    if (!entry.enumTable) {
      throw new Error(
        `Parameter "${entry.name}" doesn't accept name strings — pass a numeric value (notes: ${entry.notes}).`,
      );
    }
    const idx = resolveHydraEnum(entry.enumTable, input);
    if (idx === undefined) {
      const table = HYDRASYNTH_ENUMS[entry.enumTable];
      const sample = table ? Object.values(table).slice(0, 6).join(', ') : '';
      throw new Error(
        `Couldn't resolve "${input}" in ${entry.enumTable}. ${sample ? `First few options: ${sample}…` : ''} Call hydra_list_enum_values("${entry.enumTable}") for the full list.`,
      );
    }
    return { wire: idx * (entry.enumValueScale ?? 1), scaled: false, bipolar: false };
  }
  // Numeric input on an enum-table param with enumValueScale: treat the
  // number as the enum index and apply the scale. Without this branch,
  // `reverbtime: 105` was percent-scaled instead — the user got
  // index 1 = "130ms" displayed when they meant index 105 = "16.0s"
  // (Session 49 ambient-pad bug). prefxtype / delaytype / reverbtype
  // / postfxtype / reverbtime are the only entries with enumValueScale
  // today, so the blast radius is well-bounded.
  if (entry.enumTable !== undefined && entry.enumValueScale !== undefined) {
    const table = HYDRASYNTH_ENUMS[entry.enumTable];
    const maxIdx = table !== undefined
      ? Math.max(...Object.keys(table).map((k) => Number(k)))
      : entry.wireMax ?? 0;
    if (!Number.isInteger(input) || input < 0 || input > maxIdx) {
      throw new Error(
        `Parameter "${entry.name}" expects an integer index 0..${maxIdx} (or a name string from ${entry.enumTable}); got ${input}.`,
      );
    }
    return { wire: input * entry.enumValueScale, scaled: true, bipolar: false };
  }
  const isFourteenBit =
    entry.wireMax !== undefined &&
    entry.wireMax > 127 &&
    entry.dataMsb === undefined &&
    entry.enumTable === undefined;
  // Explicit-range branch — when displayMin AND displayMax are both set,
  // trust them. Input is treated as a display value, mapped linearly
  // onto [0, wireMax] with displayMin → 0 and displayMax → wireMax.
  //
  // Two cases this branch handles:
  //   1. Bipolar params (displayMin < 0): input 0 → wire = wireMax/2 (the
  //      "no modulation" / centered state). +N and -N land on either side.
  //      Fixes the silent-prelude bug from 2026-04-28 where INIT_PATCH
  //      wrote `value: 0` to bipolar params expecting "off" but got
  //      max-negative because the old unipolar formula resolved
  //      0 × wireMax / 128 = 0 = display-min.
  //   2. Unipolar percent params (displayMin = 0, displayMax in {100, 150}):
  //      `value: 50` produces wire = wireMax/2 → device displays 50%.
  //      Fixes HW-057 / Session 47: the prior 0..128 default produced
  //      wire 3200/8192 = display 39.1% when callers passed value:50
  //      expecting 50% — confused the agent on every wet/feedback batch.
  //
  // Both cases use the same formula: wire = (input - displayMin) × wireMax / range.
  //
  // OOB handling differs by polarity:
  //   - Bipolar (displayMin < 0): OOB **throws**. Silent fall-through to
  //     percent-scaling produced bytes the device decoded as wrong-sign
  //     wraps (Session 49: reverbtone=72 displayed as 8.0 because 72
  //     auto-scaled as percent instead of being rejected).
  //   - Unipolar (displayMin = 0): OOB **passes through** as raw wire.
  //     Lets advanced callers send wire values directly when they need
  //     to (e.g. reverbpredelay where displayMax=250 but wireMax=8192).
  if (
    isFourteenBit &&
    entry.displayMin !== undefined &&
    entry.displayMax !== undefined
  ) {
    const { displayMin, displayMax, wireMax } = entry;
    const range = displayMax - displayMin;
    if (input >= displayMin && input <= displayMax && range > 0) {
      const wire = Math.min(
        Math.max(Math.round(((input - displayMin) * wireMax!) / range), 0),
        wireMax!,
      );
      return { wire, scaled: true, bipolar: displayMin < 0 };
    }
    if (displayMin < 0) {
      throw new Error(
        `Parameter "${entry.name}" expects a bipolar value in ${displayMin}..${displayMax}; got ${input}. Pass 0 for centered/no-modulation.`,
      );
    }
    // Unipolar OOB → fall through to raw pass-through.
  }
  if (isFourteenBit && input >= 0 && input <= 128) {
    // Hydrasynth's display goes 0..128, not 0..127. Most engine knobs
    // show `display = wire / 64` (with wireMax=8192 ⇒ display max 128.0).
    // We scale `value × wireMax / 128` so integer inputs land on integer
    // displays — value=55 → wire=3520 → display=55.0 exact, not 55.4.
    // Trade-off: value=127 hits 127.0 display rather than max; pass 128
    // (or any value ≥ 128) to reach the actual max wire value.
    const wire = Math.min(Math.round((input * entry.wireMax!) / 128), entry.wireMax!);
    return { wire, scaled: true, bipolar: false };
  }
  return { wire: input, scaled: false, bipolar: false };
}

// ─── Per-FX-type sub-param resolver ─────────────────────────────────
//
// Hydrasynth's `prefxparam1..5` / `postfxparam1..5` mean entirely
// different things depending on `prefxtype` / `postfxtype`. When
// prefxtype=Lo-Fi, param1=Cutoff Hz / param4=Output dB /
// param5=Sampling Hz; when prefxtype=Chorus, param1=Rate Hz / etc.
// The NRPN table carries this in parallel `fx{0..9}param{1..5}`
// entries (separate from the generic `prefxparam1..5`), but
// `findHydraNrpn("prefxparam1")` always returns the generic entry —
// which has no wireMax / display range / enum table.
//
// Result before this layer: agent sends `prefxparam1=88` thinking
// "halfway"; encoder falls through to raw pass-through (wire=88);
// device interprets at fx5param1 scale → 170 Hz Lo-Fi cutoff,
// killing audible volume on anything above the fundamental. Yungatita
// lo-fi test, 2026-05-12.
//
// This resolver picks the type-specific entry when the caller knows
// which FX type is in play (either pre-scanned from the same batch
// or pinned by the user).

/** FX_TYPES enum order. Mirrors src/asm/hydrasynth-explorer/enums.ts. */
const FX_TYPE_NAMES = [
  'Bypass', 'Chorus', 'Flanger', 'Rotary', 'Phaser',
  'Lo-Fi', 'Tremolo', 'EQ', 'Compressor', 'Distortion',
] as const;

// Per-FX-type sub-param enum patches.
//
// Several fxNparamM entries in the auto-generated NRPN table list
// their display values in `notes:` prose but lack a usable `enumTable`
// linkage. We register the missing tables in HYDRASYNTH_ENUMS at
// module load and overlay an `enumTable` reference on the entry at
// lookup time. The auto-generated file stays untouched (regenerating
// from CSV is the project-discipline path to make these permanent —
// see docs/devices/hydrasynth-explorer/references/nrpn.csv).

/** Lo-Fi Sampling Rate, descending (per fx5param5 notes). */
const LOFI_SAMPLING_RATES: HydrasynthEnum = {
  0: '44100', 1: '22050', 2: '14700', 3: '11025',
  4: '8820', 5: '7350', 6: '6300', 7: '5513',
  8: '4900', 9: '4410', 10: '4009', 11: '3675',
  12: '3392', 13: '3150', 14: '2940', 15: '2756',
};

/** Lo-Fi internal filter type (per fx5param3 notes). */
const LOFI_FILTER_TYPES: HydrasynthEnum = {
  0: 'Thru', 1: 'PWBass', 2: 'Radio', 3: 'Tele', 4: 'Clean', 5: 'Low',
};

/** Tremolo LFO shape (per fx6param3 notes). */
const TREMOLO_LFO_SHAPES: HydrasynthEnum = {
  0: 'Sine', 1: 'Square',
};

/** Chorus/Flanger Mono/Stereo (per fx1param5 / fx2param5 notes). */
const CHORUS_MONO_STEREO: HydrasynthEnum = {
  0: 'Mono', 1: 'Stereo',
};

/**
 * fxNparamM entry name → (enumTable label, scale). The label is the
 * key we add to HYDRASYNTH_ENUMS at module load; the scale is
 * `enumValueScale` (almost always 8 because the device emits in
 * multiples of 8 per the spec).
 */
const FX_ENUM_PATCHES: ReadonlyArray<{
  readonly entryNamePrefix: string;
  readonly tableLabel: string;
  readonly table: HydrasynthEnum;
  readonly enumValueScale: number;
}> = [
  { entryNamePrefix: 'fx5param3', tableLabel: 'LOFI_FILTER_TYPES',     table: LOFI_FILTER_TYPES,     enumValueScale: 8 },
  { entryNamePrefix: 'fx5param5', tableLabel: 'LOFI_SAMPLING_RATES',   table: LOFI_SAMPLING_RATES,   enumValueScale: 8 },
  { entryNamePrefix: 'fx6param3', tableLabel: 'TREMOLO_LFO_SHAPES',    table: TREMOLO_LFO_SHAPES,    enumValueScale: 8 },
  { entryNamePrefix: 'fx1param5', tableLabel: 'CHORUS_MONO_STEREO',    table: CHORUS_MONO_STEREO,    enumValueScale: 8 },
  { entryNamePrefix: 'fx2param5', tableLabel: 'CHORUS_MONO_STEREO',    table: CHORUS_MONO_STEREO,    enumValueScale: 8 },
];

// Register the patch tables in HYDRASYNTH_ENUMS so resolveHydraEnum
// and downstream lookups see them. Idempotent — re-importing the
// module is a no-op.
for (const patch of FX_ENUM_PATCHES) {
  if (!(patch.tableLabel in HYDRASYNTH_ENUMS)) {
    // HYDRASYNTH_ENUMS is `Readonly<Record<string, HydrasynthEnum>>`
    // by signature, but the underlying object is mutable. We extend
    // it once at module load; nrpn.ts entries that reference the
    // table by string label then resolve correctly.
    (HYDRASYNTH_ENUMS as Record<string, HydrasynthEnum>)[patch.tableLabel] = patch.table;
  }
}

/**
 * Apply an FX_ENUM_PATCHES overlay to an entry if its name matches.
 * Returns a copy with `enumTable` + `enumValueScale` populated; the
 * original entry is returned untouched when no patch applies.
 */
function applyFxEnumPatch(entry: HydrasynthNrpn): HydrasynthNrpn {
  if (entry.enumTable !== undefined) return entry; // already linked
  for (const patch of FX_ENUM_PATCHES) {
    if (entry.name.startsWith(patch.entryNamePrefix)) {
      return {
        ...entry,
        enumTable: patch.tableLabel,
        enumValueScale: patch.enumValueScale,
      };
    }
  }
  return entry;
}

/** Display name for an FX type index, for error/response messages. */
export function fxTypeName(idx: number): string {
  return FX_TYPE_NAMES[idx] ?? `unknown(${idx})`;
}

/**
 * Build a lookup of `(fxTypeIdx, paramIdx)` → entry, scanning
 * HYDRASYNTH_NRPNS for entries whose name starts with `fx{N}param{M}`.
 * Run once at module load. The NRPN names carry trailing parentheticals
 * (e.g. `"fx5param1 (Cutoff)"`) so we match on prefix.
 */
const FX_SUB_PARAM_INDEX: Map<string, HydrasynthNrpn> = (() => {
  const m = new Map<string, HydrasynthNrpn>();
  for (const entry of HYDRASYNTH_NRPNS) {
    const match = /^fx(\d)param([1-5])\b/.exec(entry.name);
    if (!match) continue;
    const fxIdx = Number(match[1]);
    const paramIdx = Number(match[2]);
    const key = `${fxIdx}.${paramIdx}`;
    // Apply enum-table overlay for entries the auto-gen pipeline
    // didn't link (Lo-Fi sampling/filter type, Tremolo LFO shape,
    // Chorus/Flanger mono-stereo).
    if (!m.has(key)) m.set(key, applyFxEnumPatch(entry));
  }
  return m;
})();

/** Lookup a per-FX-type sub-param entry by FX type index (0..9) + param index (1..5). */
export function fxSubParamEntry(fxTypeIdx: number, paramIdx: number): HydrasynthNrpn | undefined {
  return FX_SUB_PARAM_INDEX.get(`${fxTypeIdx}.${paramIdx}`);
}

/**
 * Parse a generic FX sub-param name (e.g. `"prefxparam1"`, `"postfxparam5"`)
 * into `{ surface: "pre" | "post", paramIdx: 1..5 }`. Returns undefined
 * for any name that isn't a generic FX sub-param.
 */
export function parseFxSubParamName(name: string): { surface: 'pre' | 'post'; paramIdx: number } | undefined {
  const m = /^(pre|post)fxparam([1-5])$/.exec(name);
  if (!m) return undefined;
  return { surface: m[1] as 'pre' | 'post', paramIdx: Number(m[2]) };
}

/**
 * Resolve `prefxtype` / `postfxtype` from a user-supplied value
 * (number index or display-name string). Returns the 0..9 index, or
 * undefined when the value isn't a valid FX type.
 */
export function resolveFxTypeIdx(value: number | string): number | undefined {
  if (typeof value === 'string') {
    const idx = resolveHydraEnum('FX_TYPES', value);
    return idx;
  }
  if (Number.isInteger(value) && value >= 0 && value < FX_TYPE_NAMES.length) {
    return value;
  }
  return undefined;
}

/**
 * Resolve a value for a (possibly FX-type-aware) param. For names
 * matching `prefxparam{1..5}` / `postfxparam{1..5}`, route to the
 * per-FX-type entry when `prefxTypeIdx` / `postfxTypeIdx` is known.
 * For all other names, delegate to `resolveNrpnValue` with the entry
 * from `findHydraNrpn`.
 *
 * Returns the resolved wire value plus the entry that was used (so
 * callers can surface the FX-type-specific display name like
 * "Lo-Fi Cutoff" instead of the generic "prefxparam1").
 */
export interface FxAwareResolution extends ResolvedNrpnValue {
  /** Entry that was actually used for encoding (may be a fxNparamM entry). */
  readonly entry: HydrasynthNrpn;
  /** When the FX-type-aware route fired, the FX type index 0..9. */
  readonly fxTypeIdx?: number;
}

/**
 * Per-entry custom wire transforms. The auto-gen NRPN table can't
 * express offsets like "wire = 464 + (display + 6) × 8" (Lo-Fi
 * Output dB). Returning a wire override here short-circuits
 * resolveNrpnValue. Throw on out-of-range so callers can't silently
 * produce garbage.
 */
const FX_ENTRY_TRANSFORMS: Record<
  string,
  (value: number | string) => ResolvedNrpnValue
> = {
  // Lo-Fi Output: -6..+36 dB → wire 464..800 (step 8).
  // Patch buffer stores wire/8 → patch byte 58..100 = display + 64.
  'fx5param4': (value) => {
    const display = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(display) || display < -6 || display > 36) {
      throw new Error(
        `Lo-Fi Output (fx5param4) expects -6..+36 dB; got ${value}.`,
      );
    }
    const wire = 464 + Math.round((display - -6) * 8);
    return { wire, scaled: true, bipolar: false };
  },
};

export function resolveFxAwareValue(
  paramName: string,
  value: number | string,
  context: { prefxTypeIdx?: number; postfxTypeIdx?: number },
): FxAwareResolution {
  const sub = parseFxSubParamName(paramName);
  if (sub) {
    const typeIdx = sub.surface === 'pre' ? context.prefxTypeIdx : context.postfxTypeIdx;
    if (typeIdx !== undefined) {
      const fxEntry = fxSubParamEntry(typeIdx, sub.paramIdx);
      if (fxEntry) {
        // Custom-transform entries (Lo-Fi Output etc.) bypass
        // resolveNrpnValue because their wire encoding has an offset
        // that the standard linear remap can't express. We match on
        // entry NAME PREFIX (auto-gen names include parentheticals
        // like "fx5param4  (Output)").
        for (const key of Object.keys(FX_ENTRY_TRANSFORMS)) {
          if (fxEntry.name.startsWith(key)) {
            const resolved = FX_ENTRY_TRANSFORMS[key]!(value);
            return { ...resolved, entry: fxEntry, fxTypeIdx: typeIdx };
          }
        }
        const resolved = resolveNrpnValue(fxEntry, value);
        return { ...resolved, entry: fxEntry, fxTypeIdx: typeIdx };
      }
      // Type known but no fxN entry — Bypass (fx0) has none, callers
      // shouldn't be setting sub-params on a bypassed surface anyway.
      // Fall through to generic.
    }
  }
  const entry = findHydraNrpn(paramName);
  if (!entry) {
    throw new Error(`resolveFxAwareValue: unknown param "${paramName}".`);
  }
  const resolved = resolveNrpnValue(entry, value);
  return { ...resolved, entry };
}

/**
 * Extract a friendly per-FX-type label from an entry name like
 * `"fx5param1 (Cutoff)"` → `"Cutoff"`. Returns undefined when the
 * entry has no parenthetical (the generic prefxparam1..5 entries).
 */
export function fxSubParamLabel(entry: HydrasynthNrpn): string | undefined {
  const m = /\(([^)]+)\)/.exec(entry.name);
  return m ? m[1].trim() : undefined;
}

/**
 * Build the four 3-byte CC messages that comprise one NRPN write.
 * Order is mandatory per MIDI: address-MSB (CC 99) → address-LSB
 * (CC 98) → data-MSB (CC 6) → data-LSB (CC 38).
 *
 * Returns one array per MIDI message — callers iterate and pass each
 * to `sendMessage()` separately. Bundling all 12 bytes into one call
 * makes node-midi treat the rest as a runt message; only the first CC
 * lands. (See server.ts `sendNrpn` for the runtime.)
 *
 * Two encoding modes for the data:
 *   - Multi-slot (entry.dataMsb defined): data-MSB = slot index,
 *     data-LSB = the 7-bit slot-relative value.
 *   - Plain 14-bit: data-MSB = (value >> 7) & 0x7F, data-LSB = value & 0x7F.
 */
export function nrpnMessagesFor(entry: HydrasynthNrpn, channel: number, value: number): number[][] {
  const status = 0xb0 | ((channel - 1) & 0x0f);
  const dataMsb = entry.dataMsb !== undefined
    ? entry.dataMsb & 0x7f
    : (value >> 7) & 0x7f;
  const dataLsb = value & 0x7f;
  return [
    [status, 99, entry.msb & 0x7f],
    [status, 98, entry.lsb & 0x7f],
    [status, 6, dataMsb],
    [status, 38, dataLsb],
  ];
}
