/**
 * Cross-device concept-key registry.
 *
 * The same conceptual knob is spelled differently across devices:
 *   - Drive output level: II `volume`, AM4 `level`, III `level`.
 *   - Amp power-amp master: II `master_volume`, AM4 `master`, III `master`.
 *   - Amp preamp gain: II `input_drive`, AM4 `gain`, III `gain`.
 *
 * `cross-device-aliases.ts` catches per-pair param-name divergences after
 * the agent has already typed one device's word. Concept-keys are the
 * canonical layer ABOVE the per-pair alias table. An agent that learned
 * the concept-key vocabulary writes the SAME word on every device, and
 * the dispatcher rewrites it to the local canonical name before the
 * writer sees it.
 *
 * Shape:
 *
 *   CONCEPT_KEYS['drive.output_level'] = {
 *     'axe-fx-ii': 'volume',
 *     'am4': 'level',
 *     'axe-fx-iii': 'level',
 *   };
 *
 * Lookup:
 *
 *   resolveConceptKey('am4', 'drive.output_level')
 *     => { localName: 'level', block: 'drive' }
 *
 *   resolveConceptKey('am4', 'drive.level')
 *     => undefined  (not a concept-key)
 *
 *   resolveConceptKey('am4', 'drive.unknown_concept')
 *     => undefined
 *
 * Scoping rules:
 *
 *   - Concept-keys are namespaced as `<block>.<concept>` so the same
 *     conceptual word can resolve differently per block (e.g.
 *     `amp.type` selects the amp model; `drive.type` selects the drive
 *     pedal model — both concept-keys, different mappings).
 *
 *   - Each concept-key maps to AT MOST ONE local param per device. If
 *     a device doesn't expose the concept (e.g. Hydrasynth has no
 *     drive block), the entry is omitted and `resolveConceptKey`
 *     returns `undefined` for that (device, key) pair.
 *
 *   - The block portion of the concept-key MUST match the device's
 *     canonical block slug. The dispatcher's existing block-alias
 *     resolution still applies on top, so a Hydrasynth user could
 *     type `module.cutoff` and the block_aliases would resolve
 *     `module` to a canonical block before concept-key lookup.
 *
 * Future work (NOT in this PR):
 *
 *   Enum-value concept-keys. The current
 *   `cross-device-enums.ts:resolveEnumAlias` table is structured as
 *   per-pair pairs (II `"USA IIC+"` <-> AM4 `"USA MK IIC+"`). A future
 *   `CONCEPT_ENUM_VALUES['amp.type.mesa-mark-iic-plus'] = { 'axe-fx-ii':
 *   'USA IIC+', 'am4': 'USA MK IIC+', 'axe-fx-iii': 'USA IIC+' }` would
 *   parallel this file's shape for enum-value cross-device routing.
 */

export type DevicePortSlug = 'am4' | 'axe-fx-ii' | 'axe-fx-iii' | 'hydrasynth';

/**
 * One concept-key entry. Maps the canonical cross-device concept-key
 * (e.g. `drive.output_level`) to the local param name on each device
 * that exposes the concept.
 *
 * Per-device entries are partial: a device that doesn't have the
 * concept simply omits its entry. `resolveConceptKey` returns
 * `undefined` for the (device, key) pair in that case.
 */
export type ConceptKeyMap = Partial<Record<DevicePortSlug, string>>;

/**
 * Successful resolution of a concept-key on a device.
 */
export interface ResolvedConceptKey {
  /** The canonical block slug (the `block` portion of the concept-key). */
  block: string;
  /** The device-local param name (the value the writer expects). */
  localName: string;
  /** The full concept-key the caller passed (e.g. `drive.output_level`). */
  conceptKey: string;
}

/**
 * The registry. Keyed by `<block>.<concept>`; values map each device
 * slug to its local param name. Devices that don't expose the concept
 * omit their entry.
 *
 * Curated to cover the common tone-building vocabulary across Fractal
 * devices plus the major Hydrasynth synth concepts. ~40 entries.
 */
export const CONCEPT_KEYS: Readonly<Record<string, ConceptKeyMap>> = Object.freeze({
  // ── Amp ─────────────────────────────────────────────────────────
  'amp.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'amp.preamp_gain': {
    'axe-fx-ii': 'input_drive',
    am4: 'gain',
    'axe-fx-iii': 'gain',
  },
  'amp.power_amp_master': {
    'axe-fx-ii': 'master_volume',
    am4: 'master',
    'axe-fx-iii': 'master',
  },
  'amp.output_level': {
    'axe-fx-ii': 'level',
    am4: 'level',
    'axe-fx-iii': 'level',
  },
  'amp.bass': {
    'axe-fx-ii': 'bass',
    am4: 'bass',
    'axe-fx-iii': 'bass',
  },
  'amp.mid': {
    'axe-fx-ii': 'middle',
    am4: 'mid',
    'axe-fx-iii': 'mid',
  },
  'amp.treble': {
    'axe-fx-ii': 'treble',
    am4: 'treble',
    'axe-fx-iii': 'treble',
  },
  'amp.presence': {
    'axe-fx-ii': 'presence',
    am4: 'presence',
    'axe-fx-iii': 'presence',
  },

  // ── Drive ───────────────────────────────────────────────────────
  'drive.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'drive.gain': {
    'axe-fx-ii': 'gain',
    am4: 'drive',
    'axe-fx-iii': 'gain',
  },
  'drive.color_tone': {
    'axe-fx-ii': 'tone',
    am4: 'tone',
    'axe-fx-iii': 'tone',
  },
  'drive.output_level': {
    'axe-fx-ii': 'volume',
    am4: 'level',
    'axe-fx-iii': 'level',
  },
  'drive.mix': {
    'axe-fx-ii': 'mix',
    am4: 'mix',
    'axe-fx-iii': 'mix',
  },

  // ── Reverb ──────────────────────────────────────────────────────
  'reverb.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'reverb.mix': {
    'axe-fx-ii': 'mix',
    am4: 'mix',
    'axe-fx-iii': 'mix',
  },
  'reverb.time': {
    'axe-fx-ii': 'time',
    am4: 'time',
    'axe-fx-iii': 'time',
  },
  'reverb.predelay': {
    'axe-fx-ii': 'predelay',
    am4: 'pre_delay',
    'axe-fx-iii': 'predelay',
  },
  'reverb.size': {
    'axe-fx-ii': 'size',
    am4: 'size',
    'axe-fx-iii': 'size',
  },

  // ── Delay ───────────────────────────────────────────────────────
  'delay.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'delay.time': {
    'axe-fx-ii': 'time',
    am4: 'time',
    'axe-fx-iii': 'time',
  },
  'delay.feedback': {
    'axe-fx-ii': 'feedback',
    am4: 'feedback',
    'axe-fx-iii': 'feed',
  },
  'delay.mix': {
    'axe-fx-ii': 'mix',
    am4: 'mix',
    'axe-fx-iii': 'mix',
  },

  // ── Chorus ──────────────────────────────────────────────────────
  'chorus.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'chorus.rate': {
    'axe-fx-ii': 'rate',
    am4: 'rate',
    'axe-fx-iii': 'rate',
  },
  'chorus.depth': {
    'axe-fx-ii': 'depth',
    am4: 'depth',
    'axe-fx-iii': 'depth',
  },
  'chorus.mix': {
    'axe-fx-ii': 'mix',
    am4: 'mix',
    'axe-fx-iii': 'mix',
  },

  // ── Wah ─────────────────────────────────────────────────────────
  'wah.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'wah.mix': {
    'axe-fx-ii': 'level',
    am4: 'mix',
    'axe-fx-iii': 'level',
  },

  // ── Pitch ───────────────────────────────────────────────────────
  'pitch.type': {
    'axe-fx-ii': 'effect_type',
    'axe-fx-iii': 'type',
  },
  'pitch.mix': {
    'axe-fx-ii': 'mix',
    'axe-fx-iii': 'mix',
  },

  // ── Filter ──────────────────────────────────────────────────────
  'filter.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'filter.cutoff': {
    'axe-fx-ii': 'frequency',
    am4: 'freq',
    'axe-fx-iii': 'freq',
    hydrasynth: 'cutoff',
  },
  'filter.resonance': {
    'axe-fx-ii': 'q',
    am4: 'q',
    'axe-fx-iii': 'q',
    hydrasynth: 'res',
  },

  // ── Compressor ──────────────────────────────────────────────────
  'compressor.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'compressor.threshold': {
    'axe-fx-ii': 'treshold',
    am4: 'threshold',
    'axe-fx-iii': 'thresh',
  },
  'compressor.ratio': {
    'axe-fx-ii': 'ratio',
    am4: 'ratio',
    'axe-fx-iii': 'ratio',
  },
  'compressor.attack': {
    'axe-fx-ii': 'attack',
    am4: 'attack',
    'axe-fx-iii': 'attack',
  },
  'compressor.release': {
    'axe-fx-ii': 'release',
    am4: 'release',
    'axe-fx-iii': 'release',
  },

  // ── Hydrasynth-specific synth concepts ──────────────────────────
  // These are synth-only — Fractal devices don't have these concepts,
  // so they map only on hydrasynth. The lookup helper returns
  // `undefined` when called for a Fractal device with these keys.
  'osc.pitch': {
    hydrasynth: 'semi',
  },
  'env.attack': {
    hydrasynth: 'attack',
  },
  'env.decay': {
    hydrasynth: 'decay',
  },
  'env.sustain': {
    hydrasynth: 'sustain',
  },
  'env.release': {
    hydrasynth: 'release',
  },
  'lfo.rate': {
    hydrasynth: 'rate',
  },
});

/**
 * Look up a concept-key on a target device. Returns the resolution
 * envelope (block + local name) or `undefined` if the key is not
 * registered OR if the device doesn't expose the concept.
 *
 * The concept-key must be in the `<block>.<concept>` form. Inputs
 * without a dot or unknown prefixes return `undefined` (the dispatcher
 * then falls through to per-device alias resolution + Levenshtein).
 *
 * Case-insensitive on the concept-key side. Returned `localName` is
 * the verbatim casing the device's param registry uses.
 */
export function resolveConceptKey(
  port: string,
  conceptKey: string,
): ResolvedConceptKey | undefined {
  const portKey = port.trim().toLowerCase();
  const keyLower = conceptKey.trim().toLowerCase();
  if (!keyLower.includes('.')) return undefined;
  const map = CONCEPT_KEYS[keyLower];
  if (map === undefined) return undefined;
  const localName = (map as Record<string, string | undefined>)[portKey];
  if (localName === undefined) return undefined;
  const dotIdx = keyLower.indexOf('.');
  const block = keyLower.slice(0, dotIdx);
  return { block, localName, conceptKey: keyLower };
}

/**
 * Look up a concept-key when only the `<concept>` portion is supplied
 * AND a target block is known (from the apply_preset slot's
 * `block_type` or a set_param `block` argument). Wraps `resolveConceptKey`
 * by prepending `<block>.` to the input.
 *
 * Used by the dispatcher's per-block param resolution path: the slot's
 * block_type provides the block portion, and the agent only needs to
 * type the bare concept word (e.g. `output_level` instead of the full
 * `drive.output_level`).
 *
 * Returns `undefined` when the resulting key is not in the registry OR
 * the device doesn't expose the concept.
 */
export function resolveConceptKeyForBlock(
  port: string,
  block: string,
  conceptOrParamName: string,
): ResolvedConceptKey | undefined {
  // If the caller already passed a fully-qualified concept-key (contains
  // a dot), defer to the unqualified lookup so we don't double-prefix.
  if (conceptOrParamName.includes('.')) {
    return resolveConceptKey(port, conceptOrParamName);
  }
  const blockKey = block.trim().toLowerCase();
  const conceptKey = `${blockKey}.${conceptOrParamName.trim().toLowerCase()}`;
  return resolveConceptKey(port, conceptKey);
}

/**
 * Return the per-device concept-key map for `describe_device`. Each
 * entry is `{ conceptKey, localName }` so the agent can read it as a
 * flat list and learn the device-specific spelling for each cross-
 * device concept.
 *
 * Pure data — built once from the static CONCEPT_KEYS registry. The
 * dispatcher's discovery executor invokes this on every
 * describe_device call.
 */
export function listConceptKeysForDevice(
  port: string,
): readonly { conceptKey: string; localName: string }[] {
  const portKey = port.trim().toLowerCase();
  const out: { conceptKey: string; localName: string }[] = [];
  for (const [conceptKey, map] of Object.entries(CONCEPT_KEYS)) {
    const localName = (map as Record<string, string | undefined>)[portKey];
    if (localName !== undefined) {
      out.push({ conceptKey, localName });
    }
  }
  return out;
}
