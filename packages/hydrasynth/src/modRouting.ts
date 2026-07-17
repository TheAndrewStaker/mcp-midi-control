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
