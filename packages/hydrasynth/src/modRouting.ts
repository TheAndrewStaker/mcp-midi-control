/**
 * Hydrasynth mod-matrix / macro routing: name resolution.
 *
 * The wire-value DATA tables (source/destination name<->wire maps + ordered
 * name arrays) are generated from the edisyn reference into the sibling
 * `modRoutingTables.ts` by `scripts/hydrasynth/generate-mod-routing.ts`. This
 * file is HAND-AUTHORED: it holds the resolver logic (normalization, friendly
 * aliases, lookup) and re-exports the tables so callers import from one place.
 *
 * Logic lives here, not in the generated file, on purpose: a generated
 * template can't safely carry regexes (a `\d` collapses and a `$1`
 * backreference is ambiguous when emitted through a string), so the
 * generator stays pure data and the regex-bearing resolvers stay here.
 *
 * Wire fact (see modRoutingTables.ts header): mod source/target take a
 * 14-bit CATEGORY-PREFIXED VALUE, not a list index. Primitive:
 * `hydra-mod-matrix-category-prefixed-value`.
 */
import {
  MOD_SOURCE_BY_WIRE,
  MOD_DEST_BY_WIRE,
  MOD_SOURCE_NAMES,
  MOD_DEST_NAMES,
} from './modRoutingTables.js';

export {
  MOD_SOURCE_BY_WIRE,
  MOD_DEST_BY_WIRE,
  MOD_SOURCE_NAMES,
  MOD_DEST_NAMES,
} from './modRoutingTables.js';

/** Lowercase, drop non-alphanumerics, for relaxed matching. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Rewrite a normalized string so the labels an agent (or recipe author)
 * naturally types resolve to the device's exact vocabulary. Each rule is
 * conservative and only fires on a recognizable synth-vocabulary variant:
 *   - "Velocity" -> the device's note-on velocity source label
 *   - aftertouch / pressure / polytouch synonyms -> Poly / Chan Aftertouch
 *   - "Mutator N X" -> "Mut N X" (the device abbreviates Mutator as Mut)
 *   - FX "... Mix" -> "... Dry/Wet" (the device's wet-mix label)
 *   - bare "Filter X" -> "Filt 1 X" (Filter 1 is the implied default)
 * Returns the rewritten normalized string (may equal the input).
 */
function aliasNorm(n: string): string {
  let s = n;
  if (s === 'velocity' || s === 'vel' || s === 'notevel') s = 'noteonvel';
  // Aftertouch / key-pressure synonyms. The Hydrasynth's signature is
  // POLYPHONIC aftertouch ("pressing one key harder"), so "polytouch" and
  // any poly variant resolve to Poly Aftertouch; "channel"/"mono" variants
  // resolve to Chan Aftertouch. Bare "aftertouch" / "pressure" defaults to
  // Poly (the device-signature, most expressive choice); the dispatch
  // response echoes the resolved label so the user can switch to "channel
  // aftertouch" if they meant the mono one.
  if (
    /^(poly)?(aftertouch|aftrtouch|touch|pressure|at)$/.test(s) ||
    s === 'polyphonicaftertouch' ||
    s === 'polyaftertouch' ||
    s === 'polypressure' ||
    s === 'keypressure' ||
    s === 'keytouch'
  ) {
    s = 'polyaftertouch';
  } else if (
    s === 'channelaftertouch' ||
    s === 'channelpressure' ||
    s === 'monoaftertouch' ||
    s === 'chanaftertouch' ||
    s === 'chanat' ||
    s === 'chanpressure'
  ) {
    s = 'chanaftertouch';
  }
  // Mutator<digit> -> mut<digit>.
  s = s.replace(/^mutator(\d)/, 'mut$1');
  // FX wet-mix synonyms: "<fx>mix" -> "<fx>drywet".
  s = s.replace(/(reverb|delay|prefx|postfx|mut\d)mix$/, '$1drywet');
  // Bare "filter cutoff/resonance/drive" -> Filter 1.
  s = s
    .replace(/^filtercutoff$/, 'filt1cutoff')
    .replace(/^filterresonance$/, 'filt1resonance')
    .replace(/^filterdrive$/, 'filt1drive');
  // "filter<digit> X" -> "filt<digit> X" (Filter -> Filt).
  s = s.replace(/^filter(\d)/, 'filt$1');
  return s;
}

function buildNameToWire(byWire: Readonly<Record<number, string>>): Map<string, number> {
  const m = new Map<string, number>();
  for (const [wire, label] of Object.entries(byWire)) {
    m.set(norm(label), Number(wire));
  }
  return m;
}
const SOURCE_NAME_TO_WIRE = buildNameToWire(MOD_SOURCE_BY_WIRE);
const DEST_NAME_TO_WIRE = buildNameToWire(MOD_DEST_BY_WIRE);

export interface ModNameResolution {
  /** 14-bit wire value to send. */
  readonly wire: number;
  /** Canonical label resolved to (for response echo). */
  readonly label: string;
}

function lookup(
  table: Map<string, number>,
  byWire: Readonly<Record<number, string>>,
  input: string,
): ModNameResolution | undefined {
  const n = norm(input);
  let wire = table.get(n);
  if (wire === undefined) wire = table.get(aliasNorm(n));
  if (wire === undefined) return undefined;
  return { wire, label: byWire[wire]! };
}

/** Resolve a mod SOURCE name (case/punctuation/synonym tolerant) to its wire value. */
export function resolveModSource(input: string | number): ModNameResolution | undefined {
  if (typeof input === 'number') {
    const label = MOD_SOURCE_BY_WIRE[input];
    return label === undefined ? undefined : { wire: input, label };
  }
  return lookup(SOURCE_NAME_TO_WIRE, MOD_SOURCE_BY_WIRE, input);
}

/** Resolve a mod DESTINATION / macro-target name (synonym tolerant) to its wire value. */
export function resolveModDest(input: string | number): ModNameResolution | undefined {
  if (typeof input === 'number') {
    const label = MOD_DEST_BY_WIRE[input];
    return label === undefined ? undefined : { wire: input, label };
  }
  return lookup(DEST_NAME_TO_WIRE, MOD_DEST_BY_WIRE, input);
}

/** Sample of valid source labels for error messages. */
export function sampleSourceNames(n = 8): string[] {
  return MOD_SOURCE_NAMES.slice(0, n);
}
/** Sample of valid destination labels for error messages. */
export function sampleDestNames(n = 10): string[] {
  return MOD_DEST_NAMES.slice(0, n);
}

// ---------------------------------------------------------------------------
// PATCH-IMAGE route encoding (2026-08-22, BK-HYDRA-DISPLAY-GAPS P7).
//
// The NRPN surface and the PATCH IMAGE use two DIFFERENT value spaces for
// routes. NRPN carries the 14-bit category-prefixed wire value above; the
// image stores (a) the LINEAR index into the edisyn-ordered list and (b) the
// destination's device CATEGORY id in a parallel region. Established by the
// 1024-image flash-corpus census (samples/_scratch/hydra-matrix-census*.ts):
// every observed factory (category, index) pair matched MOD_DEST_NAMES /
// MOD_DEST_CATEGORIES positions; sources matched MOD_SOURCE_NAMES positions.
// ---------------------------------------------------------------------------

import { MOD_DEST_CATEGORIES } from './modRoutingTables.js';
export { MOD_DEST_CATEGORIES } from './modRoutingTables.js';

const SOURCE_LABEL_TO_IMAGE: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  MOD_SOURCE_NAMES.forEach((label, i) => { if (!m.has(label)) m.set(label, i); });
  return m;
})();
const DEST_LABEL_TO_IMAGE: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  MOD_DEST_NAMES.forEach((label, i) => { if (!m.has(label)) m.set(label, i); });
  return m;
})();

/**
 * Normalized (case/punctuation/synonym-tolerant, same `norm`/`aliasNorm` as
 * the wire lookups) label -> IMAGE index, TOTAL over the image tables — this
 * covers the vendored-table holes (image entries with no NRPN wire mapping)
 * that the label->wire->image chain cannot reach. First-wins on duplicate
 * labels ("CC 64 / Sustain" appears at source images 27 and 99; 27 wins,
 * display-identical).
 */
const SOURCE_NORM_TO_IMAGE: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  MOD_SOURCE_NAMES.forEach((label, i) => { const k = norm(label); if (!m.has(k)) m.set(k, i); });
  return m;
})();
const DEST_NORM_TO_IMAGE: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  MOD_DEST_NAMES.forEach((label, i) => { const k = norm(label); if (!m.has(k)) m.set(k, i); });
  return m;
})();

/** Resolution of a route label directly to its patch-image linear index. */
export interface ModImageResolution {
  /** Patch-image linear list index (edisyn roster position). */
  readonly image: number;
  /** Canonical label resolved to (for response echo). */
  readonly label: string;
}

/**
 * Resolve a mod SOURCE label (synonym tolerant) to its patch-image index.
 * Two vocabularies resolve: the image tables' own labels (direct normalized
 * match — total, including wire-less holes), then the WIRE tables' labels +
 * synonyms via resolveModSource → label → image (e.g. "ModW", whose synonym
 * handling lives on the wire side).
 */
export function modSourceImageIndexForLabel(input: string): ModImageResolution | undefined {
  const n = norm(input);
  const image = SOURCE_NORM_TO_IMAGE.get(n) ?? SOURCE_NORM_TO_IMAGE.get(aliasNorm(n));
  if (image !== undefined) return { image, label: MOD_SOURCE_NAMES[image]! };
  const viaWire = lookup(SOURCE_NAME_TO_WIRE, MOD_SOURCE_BY_WIRE, input);
  if (viaWire === undefined) return undefined;
  const idx = SOURCE_LABEL_TO_IMAGE.get(viaWire.label);
  return idx === undefined ? undefined : { image: idx, label: MOD_SOURCE_NAMES[idx]! };
}

/** Resolve a mod DESTINATION / macro-target label to its patch-image index. */
export function modDestImageIndexForLabel(input: string): ModImageResolution | undefined {
  const n = norm(input);
  const image = DEST_NORM_TO_IMAGE.get(n) ?? DEST_NORM_TO_IMAGE.get(aliasNorm(n));
  if (image !== undefined) return { image, label: MOD_DEST_NAMES[image]! };
  const viaWire = lookup(DEST_NAME_TO_WIRE, MOD_DEST_BY_WIRE, input);
  if (viaWire === undefined) return undefined;
  const idx = DEST_LABEL_TO_IMAGE.get(viaWire.label);
  return idx === undefined ? undefined : { image: idx, label: MOD_DEST_NAMES[idx]! };
}

/** NRPN wire value -> patch-image LINEAR index for a mod SOURCE. */
export function modSourceImageIndex(wire: number): number | undefined {
  const label = MOD_SOURCE_BY_WIRE[wire];
  if (label === undefined) return undefined;
  return SOURCE_LABEL_TO_IMAGE.get(label);
}

/** NRPN wire value -> patch-image LINEAR index for a mod DESTINATION / macro target. */
export function modDestImageIndex(wire: number): number | undefined {
  const label = MOD_DEST_BY_WIRE[wire];
  if (label === undefined) return undefined;
  return DEST_LABEL_TO_IMAGE.get(label);
}

/** Device category id for a destination's patch-image linear index (0 = Off/none). */
export function modDestCategoryForImageIndex(index: number): number {
  if (index <= 0 || index >= MOD_DEST_CATEGORIES.length) return 0;
  return MOD_DEST_CATEGORIES[index]!;
}

/** Display label for a patch-image SOURCE linear index (decode direction). */
export function modSourceLabelForImageIndex(index: number): string | undefined {
  return MOD_SOURCE_NAMES[index];
}
/** Display label for a patch-image DESTINATION linear index (decode direction). */
export function modDestLabelForImageIndex(index: number): string | undefined {
  return MOD_DEST_NAMES[index];
}

/**
 * Classify a canonical param name into its patch-image route field kind.
 * Depth/button fields are NOT listed: they ride the standard u16le wire/8
 * convention and need no translation.
 */
export function matrixImageFieldKind(
  name: string,
): 'source' | 'target' | 'macro_target' | 'target_category' | undefined {
  if (/^modmatrix\d+modsource$/.test(name)) return 'source';
  if (/^modmatrix\d+modtarget$/.test(name)) return 'target';
  if (/^macro\d+target\d+$/.test(name)) return 'macro_target';
  if (/^modmatrix\d+targetcategory$/.test(name) || /^macro\d+targetcategory\d+$/.test(name)) {
    return 'target_category';
  }
  return undefined;
}
