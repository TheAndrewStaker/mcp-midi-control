/**
 * Per-(block, name) applicability helpers — translates the
 * `typeApplicability.ts` generated data into agent-facing prose and
 * runtime predicates.
 *
 * Used by `list_params` to annotate each parameter row with which
 * AM4 types expose it, by `set_param` to warn when the agent writes
 * a knob that the active type doesn't expose, and by `apply_preset`
 * to surface type/param mismatches before any wire bytes are sent.
 */
import {
  AMP_TYPES,
  CHORUS_TYPES,
  COMPRESSOR_TYPES,
  DELAY_TYPES,
  DRIVE_TYPES,
  FILTER_TYPES,
  FLANGER_TYPES,
  GATE_TYPES,
  GEQ_TYPES,
  PHASER_TYPES,
  REVERB_TYPES,
  TREMOLO_TYPES,
} from './cacheEnums.js';
import {
  TYPE_APPLICABILITY,
  type Applicability,
  type ApplicabilityGate,
} from './typeApplicability.js';

/**
 * AM4-Edit symbolic enum name → display name array (cacheEnums).
 * Enums not listed here are surfaced as raw indices in agent-facing
 * prose. The omitted ones (CABINET_MODE, DISTORT_MODE_1,
 * DISTORT_EQTYPE, REVERB_SPRINGTYPE, REVERB_LOWSLOPE,
 * REVERB_HIGHSLOPE, PEQ_TYPE1, PEQ_TYPE5) are sub-mode enums whose
 * display names we haven't extracted yet — usable as raw indices in
 * the meantime, easy to add when needed.
 */
const ENUM_LOOKUP: Readonly<Record<string, readonly string[]>> = {
  DISTORT_TYPE: AMP_TYPES,
  AMP_TYPE: AMP_TYPES,
  FUZZ_TYPE: DRIVE_TYPES,
  REVERB_TYPE: REVERB_TYPES,
  REVERB_BASETYPE: REVERB_TYPES,
  DELAY_TYPE: DELAY_TYPES,
  DELAY_MODEL: DELAY_TYPES,
  CHORUS_TYPE: CHORUS_TYPES,
  FLANGER_TYPE: FLANGER_TYPES,
  PHASER_TYPE: PHASER_TYPES,
  TREMOLO_TYPE: TREMOLO_TYPES,
  COMP_TYPE: COMPRESSOR_TYPES,
  FILTER_TYPE: FILTER_TYPES,
  GEQ_TYPE: GEQ_TYPES,
  GATE_TYPE: GATE_TYPES,
};

export function getApplicability(blockDotName: string): Applicability | undefined {
  return TYPE_APPLICABILITY[blockDotName];
}

/**
 * Render a type-enum gate's values as comma-joined display names. Falls
 * back to `idx N` for enums we don't have a cacheEnums lookup for.
 */
function renderTypeNames(gate: ApplicabilityGate): string {
  const list = ENUM_LOOKUP[gate.typeEnum] ?? [];
  return gate.values.map((v) => list[v] ?? `idx ${v}`).join(NAME_SEP);
}

/**
 * Above this many names, an inline roster stops being something an agent
 * reads and starts being something it scrolls past, and it is the single
 * largest contributor to the `list_params` payload. Past it, a SUMMARY
 * states the count and names `find_compatible_types` as the exact-list path;
 * `detail: 'full'` still renders every name, which is why the param-scoped
 * `list_params({block, name})` call remains lossless.
 */
const INLINE_ROSTER_MAX = 10;

/**
 * SEPARATOR FOR ENUM-VALUE LISTS, and it must not be a comma.
 *
 * 69 of the AM4's 79 reverb type names CONTAIN a comma: "Room, Small",
 * "Plate, Medium", "Spring, Large". Comma-joined, "Plate, Small, Plate,
 * Medium" reads as four values instead of two, and the agent has to
 * reproduce one of these strings byte-exactly for `set_param` to resolve it.
 * An unparseable roster on the block with the most gated params is a wrong
 * `set_param` argument waiting to happen.
 *
 * ` | ` collides with nothing across every AM4 roster (amp 248, reverb 79,
 * delay 29, compressor 19: zero pipes, and only reverb has commas), and costs
 * one character more than ", ".
 */
const NAME_SEP = ' | ';

/** Render the roster's display names for `indices`, unambiguously joined. */
function renderNames(roster: readonly string[], indices: readonly number[]): string {
  return indices.map((i) => roster[i] ?? `idx ${i}`).join(NAME_SEP);
}

/**
 * State a primary-type gate as prose, choosing whichever SIDE of the gate is
 * shorter. A knob exposed on 232 of 248 amp types is described by its 16
 * exceptions, not by its 232 inclusions: same information, ~7% of the
 * characters, and far more readable. `amp.treble` went from a 5,331-char
 * inclusion list to a one-line exclusion list this way.
 */
function renderPrimaryGate(
  block: string,
  paramName: string,
  exposed: ReadonlySet<number>,
  roster: readonly string[],
  detail: 'summary' | 'full',
  port: string,
): string {
  const total = roster.length;
  if (total === 0) {
    // No display-name table for this block's type enum (e.g. WAH_TYPE).
    // Fall back to naming the indices; nothing better is available.
    const idx = [...exposed].sort((a, b) => a - b);
    return `applies only when ${block}.type is one of: ${renderNames(roster, idx)}`;
  }
  if (exposed.size >= total) return `applies to any ${block} type`;

  const included = [...exposed].sort((a, b) => a - b);
  const excluded: number[] = [];
  for (let i = 0; i < total; i++) if (!exposed.has(i)) excluded.push(i);

  const useExcluded = excluded.length < included.length;
  const side = useExcluded ? excluded : included;
  const lead = `applies on ${included.length} of ${total} ${block} types`;

  if (detail === 'full' || side.length <= INLINE_ROSTER_MAX) {
    return useExcluded
      ? `${lead}, every type EXCEPT: ${renderNames(roster, excluded)}.`
      : `${lead}: ${renderNames(roster, included)}.`;
  }
  // BOTH templates carry `port`, because BOTH tools require it and an agent
  // pastes these literally. A template missing a required argument is not a
  // hint, it is an error the agent has to recover from: `port` is required on
  // find_compatible_types and on list_params, so the portless form this
  // originally shipped returned -32602 every time. The repo has prior evidence
  // of agents copying our literals verbatim (commit 4c9c94a, where the agent
  // copied our quote marks into argument values).
  return `${lead}. Call find_compatible_types({port:"${port}", block:"${block}", params:["${paramName}"]}) for the exact list, or list_params({port:"${port}", block:["${block}"], name:["${paramName}"]}) to read it here.`;
}

/**
 * One-line summary of a parameter's applicability for the agent — appears
 * in `list_params` row decoration and in `preflightApplicabilityWarning`.
 * Returns `undefined` for the common "no applicability data" case
 * (out-of-band registers, params not yet decoded by the type-applicability
 * extractor). Caller should treat as always-on. Empty string for
 * confirmed-always-on (no decoration needed).
 *
 * THIS PROSE AND `checkApplicability` MUST AGREE, AND FOR MONTHS THEY DID NOT.
 * The rule is the one `checkApplicability` settled on after the 2026-05-13
 * founder test: when a param carries PRIMARY-type gates (DISTORT_TYPE,
 * FUZZ_TYPE, DELAY_TYPE, …), that gate list is the AUTHORITATIVE set of types
 * exposing the knob, and `always: true` does not override it. This function used
 * to branch on `always` alone and emit "applies to any type (special-cased
 * on: …)" for exactly those params, so on 112 AM4 knobs `list_params` told the
 * agent the knob was universal while `set_param` refused the write as
 * type-gated. `amp.fat` read "applies to any type" and is exposed on NINE of
 * 248; `amp.geq_band_1` on FOUR. `preflightApplicabilityWarning` interleaves
 * both, so its warning text contradicted its own first sentence.
 *
 * Sub-mode gates (CABINET_MODE, DISTORT_MODE_1, REVERB_BASETYPE, …) stay
 * informational, because `checkApplicability` cannot enforce against state we
 * do not track. It mirrors the predicate exactly, including what it declines
 * to claim.
 *
 * Size fell out of the correctness fix rather than driving it: the misleading
 * branch was also 71,284 of the AM4's 101,734 applicability characters (both
 * over all 440 keys in TYPE_APPLICABILITY; over the 435 that are REGISTERED
 * params the before-total is 95,491), and the per-type "special-cased on:"
 * enumerations it emitted (up to 6,404 chars for ONE param, `amp.gain`, now
 * 89) are what put `list_params({block:["amp"]})` at 67,731, past
 * the 50,000-char host delivery cliff, i.e. the agent received none of it.
 */
export function describeApplicability(
  blockDotName: string,
  opts?: { readonly detail?: 'summary' | 'full'; readonly port?: string },
): string | undefined {
  const a = TYPE_APPLICABILITY[blockDotName];
  if (!a) return undefined;
  const detail = opts?.detail ?? 'summary';
  // Only ever rendered into the call templates above. This table is the AM4's,
  // so its descriptor id is the right default; the option exists so a caller
  // that knows its own port id does not have to trust that.
  const port = opts?.port ?? 'am4';
  const [block, paramName] = blockDotName.split('.');

  const primaryGates = a.gates.filter((g) => isPrimaryTypeEnum(g.typeEnum, block));
  const subModeGates = a.gates.filter(
    (g) => isGateForBlock(g.typeEnum, block) && !isPrimaryTypeEnum(g.typeEnum, block),
  );

  // A primary gate is only the WHOLE truth when it is the ONLY gate.
  //
  // Exposure in `__block_layout(.expert).xml` is a DISJUNCTION over gate rows:
  // the control appears if any row's condition holds. The 2026-08-02 correction
  // read the primary rows as the complete exposure set and dropped the rest,
  // which is right for the 14 params whose only rows are primary and wrong for
  // the 7 that also carry sub-mode rows.
  //
  // `amp.geq_band_1` is the worked example and was caught on hardware
  // (2026-08-04, founder, AM4-Edit). It has ONE DISTORT_TYPE row naming the
  // four JMPre-1 amps, which is that amp's own dedicated GEQ page, and SIXTEEN
  // DISTORT_EQTYPE rows. DISTORT_EQTYPE is the `Type` selector on the GEQ page
  // ("8 Band Var Q"), and it is what actually governs exposure, on any amp. We
  // were telling users the band applies to 4 of 248 amps; the founder saw the
  // full 8-band GEQ on 1959SLP Normal and 5F1 Tweed Champlifier, neither of
  // which is in the primary row.
  //
  // So: when sub-mode rows exist, the amp type ALONE cannot prove the param
  // inapplicable, and we must not claim it does. This deliberately errs toward
  // "might apply": the failure it replaces told a user a working knob was
  // unavailable, whereas over-claiming leaves the write to land with the
  // existing audibility warning attached.
  if (primaryGates.length > 0 && subModeGates.length === 0) {
    const exposed = new Set<number>();
    for (const g of primaryGates) for (const v of g.values) exposed.add(v);
    const typeEnum = primaryTypeEnumFor(block);
    const roster = typeEnum === undefined ? [] : ENUM_LOOKUP[typeEnum] ?? [];
    return renderPrimaryGate(block, paramName, exposed, roster, detail, port);
  }

  // No primary gate → nothing `checkApplicability` can enforce on the type
  // axis, so do not imply otherwise.
  if (subModeGates.length === 0) return a.always ? '' : undefined;
  const enums = [...new Set(subModeGates.map((g) => g.typeEnum))].join(', ');
  return detail === 'full'
    ? `applies to any ${block} type; sub-mode dependent (${subModeGates.map((g) => `${g.typeEnum}=[${renderTypeNames(g)}]`).join('; ')})`
    : `applies to any ${block} type; behaviour varies by sub-mode (${enums})`;
}

/** State the agent passes when checking applicability — current active type per block. */
export interface ActiveTypeContext {
  /** Block name (e.g. `amp`, `delay`) → wire enum index of its currently active type. */
  readonly currentTypes?: Readonly<Record<string, number>>;
}

/**
 * Predicate: is this parameter applicable on the active type?
 *
 * Returns:
 *   - { applicable: true } when always-on, OR when at least one gate
 *     matches the current type.
 *   - { applicable: false, reason } when the parameter is strictly
 *     type-gated and none of its gates match.
 *   - { applicable: 'unknown' } when we don't have applicability data
 *     for this key (caller should treat as applicable).
 */
export type ApplicabilityCheck =
  | { applicable: true }
  | { applicable: false; gates: readonly ApplicabilityGate[] }
  | { applicable: 'unknown' };

export function checkApplicability(
  blockDotName: string,
  ctx: ActiveTypeContext,
): ApplicabilityCheck {
  const a = TYPE_APPLICABILITY[blockDotName];
  if (!a) return { applicable: 'unknown' };
  // Truly universal — no gates at all → applies to every type.
  if (a.gates.length === 0) {
    return a.always ? { applicable: true } : { applicable: 'unknown' };
  }
  // 2026-05-13 founder-test correction. Original interpretation: if
  // `a.always === true`, the param applies on every type regardless of
  // gates ("gates list is informational, special-case pages only"). The
  // 5F8 Tweed Normal test surfaced that this is wrong for some
  // metadata-extracted params — amp.master shows `always: true` with a
  // large primary-type gates list, but the gates list is the AUTHORITATIVE
  // set of types that expose the param. Wire 185 (5F8 Tweed Normal) is
  // not in the master gates list; the AM4 silently no-ops master writes
  // on this amp model. Old interpretation let the write through and
  // claimed success; new interpretation refuses.
  //
  // Concretely: when primary-type gates exist (DISTORT_TYPE / FUZZ_TYPE
  // / etc.), the active type MUST be in the gate list. Sub-mode gates
  // (CABINET_MODE, DISTORT_MODE_1, …) are still informational — we
  // don't track sub-mode state so we can't enforce against them.
  const block = blockDotName.split('.')[0];
  const activeIndex = ctx.currentTypes?.[block];
  if (activeIndex === undefined) return { applicable: 'unknown' };
  let hasPrimaryGate = false;
  for (const g of a.gates) {
    if (!isGateForBlock(g.typeEnum, block)) continue;
    if (!isPrimaryTypeEnum(g.typeEnum, block)) continue;
    hasPrimaryGate = true;
    if (g.values.includes(activeIndex)) return { applicable: true };
  }
  // Only sub-mode gates, OR primary gates that did not match while sub-mode
  // gates also exist. Either way we cannot enforce on the type axis: a
  // sub-mode row can expose the param on a type the primary rows never name,
  // and we do not track sub-mode state.
  //
  // The second half of that condition is the 2026-08-04 correction, and it
  // must stay in lockstep with `describeApplicability` above. The two
  // functions describing and enforcing the same rule drifting apart is
  // exactly the bug that produced the 112-param misreport in the first place,
  // so if you change one branch, change both.
  const hasSubModeGate = a.gates.some(
    (g) => isGateForBlock(g.typeEnum, block) && !isPrimaryTypeEnum(g.typeEnum, block),
  );
  if (!hasPrimaryGate || hasSubModeGate) {
    // Treat as applicable if `always: true` (the universal-with-special-pages
    // case) or unknown otherwise (caller's fallback is "let the write through
    // with a warning" — see preflightApplicabilityWarning).
    return a.always ? { applicable: true } : { applicable: 'unknown' };
  }
  // Primary-type gates exist, are the ONLY gates, and the active type is NOT
  // in any of them → the param doesn't apply on this type. Refuse the write
  // rather than letting the device silently no-op it.
  return { applicable: false, gates: a.gates };
}

/**
 * find_compatible_types: which `block.type` enum values expose every
 * param in `paramNames`? Used by the unified-surface MCP tool of the
 * same name so the agent can pick a type compatible with the knobs
 * it plans to write, BEFORE apply_preset → no "dropped X param"
 * warning round-trip.
 *
 * Algorithm: start with the full type enum, intersect down per param.
 * Params with no applicability data, or only sub-mode gates (e.g.
 * CABINET_MODE), can't narrow on the primary-type axis — skipped.
 * Params with primary-type gates narrow the accepted-types set to the
 * gate value list.
 *
 * Returns `applicability_known: false` when NONE of the listed params
 * have primary-type gates — caller knows the result is the unfiltered
 * full list and should treat it as "try and see" rather than "these
 * are the only valid choices."
 */
export function findCompatibleTypes(
  block: string,
  paramNames: readonly string[],
): {
  compatible_types: readonly string[];
  total_types: number;
  applicability_known: boolean;
  note?: string;
} {
  const typeEnum = primaryTypeEnumFor(block);
  if (typeEnum === undefined) {
    return {
      compatible_types: [],
      total_types: 0,
      applicability_known: false,
      note: `block "${block}" has no primary type enum`,
    };
  }
  const enumDisplayNames = ENUM_LOOKUP[typeEnum] ?? [];
  if (enumDisplayNames.length === 0) {
    return {
      compatible_types: [],
      total_types: 0,
      applicability_known: false,
      note: `no display names registered for ${typeEnum}`,
    };
  }
  const totalTypes = enumDisplayNames.length;

  let accepted = new Set<number>(Array.from({ length: totalTypes }, (_, i) => i));
  let anyPrimaryGateApplied = false;
  const skippedParams: string[] = [];

  for (const paramName of paramNames) {
    const key = `${block}.${paramName}`;
    const a = TYPE_APPLICABILITY[key];
    if (a === undefined) {
      skippedParams.push(`${paramName} (no applicability data — treated as always-on)`);
      continue;
    }
    if (a.always && a.gates.length === 0) {
      continue;
    }
    const exposedHere = new Set<number>();
    let hasPrimaryGate = false;
    for (const g of a.gates) {
      if (g.typeEnum !== typeEnum) continue;
      hasPrimaryGate = true;
      for (const v of g.values) exposedHere.add(v);
    }
    if (!hasPrimaryGate) {
      skippedParams.push(`${paramName} (only sub-mode gates — not narrowable on primary type)`);
      continue;
    }
    anyPrimaryGateApplied = true;
    accepted = new Set([...accepted].filter((idx) => exposedHere.has(idx)));
    if (accepted.size === 0) break;
  }

  const compatibleNames: string[] = [...accepted]
    .sort((a, b) => a - b)
    .map((idx) => enumDisplayNames[idx])
    .filter((n): n is string => n !== undefined);

  const note = skippedParams.length > 0
    ? `Skipped from narrowing: ${skippedParams.join('; ')}.`
    : undefined;

  return {
    compatible_types: compatibleNames,
    total_types: totalTypes,
    applicability_known: anyPrimaryGateApplied,
    note,
  };
}

/**
 * Primary type enum for each AM4 block — the enum the agent picks via
 * `block.type` and that primary-type applicability gates filter on.
 * Mirrors `isPrimaryTypeEnum` below but returns the enum NAME rather
 * than a boolean (caller uses it to look up the display-name table).
 *
 * Returns undefined for blocks with no primary type enum (e.g. peq,
 * volpan, ingate) — those exist as block_types but don't have a
 * `type` selector knob users can pick.
 */
function primaryTypeEnumFor(block: string): string | undefined {
  switch (block) {
    case 'amp':        return 'DISTORT_TYPE';
    case 'drive':      return 'FUZZ_TYPE';
    case 'delay':      return 'DELAY_TYPE';
    case 'reverb':     return 'REVERB_TYPE';
    case 'chorus':     return 'CHORUS_TYPE';
    case 'flanger':    return 'FLANGER_TYPE';
    case 'phaser':     return 'PHASER_TYPE';
    case 'wah':        return 'WAH_TYPE';
    case 'compressor': return 'COMP_TYPE';
    case 'geq':        return 'GEQ_TYPE';
    case 'filter':     return 'FILTER_TYPE';
    case 'tremolo':    return 'TREMOLO_TYPE';
    case 'gate':       return 'GATE_TYPE';
    default:           return undefined;
  }
}

/**
 * Whether a typeEnum is the block's primary-type enum (the one we track
 * via `lastKnownType[<block>.type]`). Sub-mode enums (CABINET_MODE,
 * DISTORT_MODE_1, REVERB_BASETYPE, etc.) gate UI exposure but we don't
 * read them after every block-type change, so applicability checks
 * against them must downgrade to 'unknown' instead of firing.
 */
function isPrimaryTypeEnum(typeEnum: string, block: string): boolean {
  switch (block) {
    case 'amp':        return typeEnum === 'DISTORT_TYPE' || typeEnum === 'AMP_TYPE';
    case 'drive':      return typeEnum === 'FUZZ_TYPE';
    case 'delay':      return typeEnum === 'DELAY_TYPE' || typeEnum === 'DELAY_MODEL';
    case 'reverb':     return typeEnum === 'REVERB_TYPE';
    case 'chorus':     return typeEnum === 'CHORUS_TYPE';
    case 'flanger':    return typeEnum === 'FLANGER_TYPE';
    case 'phaser':     return typeEnum === 'PHASER_TYPE';
    case 'wah':        return typeEnum === 'WAH_TYPE';
    case 'compressor': return typeEnum === 'COMP_TYPE';
    case 'geq':        return typeEnum === 'GEQ_TYPE';
    case 'filter':     return typeEnum === 'FILTER_TYPE';
    case 'tremolo':    return typeEnum === 'TREMOLO_TYPE';
    case 'gate':       return typeEnum === 'GATE_TYPE';
    default:           return false;
  }
}

/**
 * Whether a gate's typeEnum corresponds to a given block. The bulk of
 * gates are intra-block (DELAY_TYPE on delay params, FUZZ_TYPE on drive
 * params), but a few cross over (REVERB_BASETYPE / REVERB_SPRINGTYPE
 * both on reverb params; DISTORT_MODE_1 / CABINET_MODE on amp params).
 */
function isGateForBlock(typeEnum: string, block: string): boolean {
  switch (block) {
    case 'amp':        return typeEnum === 'DISTORT_TYPE' || typeEnum === 'AMP_TYPE' || typeEnum === 'DISTORT_MODE_1' || typeEnum === 'DISTORT_EQTYPE' || typeEnum === 'CABINET_MODE';
    case 'drive':      return typeEnum === 'FUZZ_TYPE';
    case 'delay':      return typeEnum === 'DELAY_TYPE' || typeEnum === 'DELAY_MODEL';
    case 'reverb':     return typeEnum === 'REVERB_TYPE' || typeEnum === 'REVERB_BASETYPE' || typeEnum === 'REVERB_SPRINGTYPE' || typeEnum === 'REVERB_LOWSLOPE' || typeEnum === 'REVERB_HIGHSLOPE';
    case 'chorus':     return typeEnum === 'CHORUS_TYPE';
    case 'flanger':    return typeEnum === 'FLANGER_TYPE';
    case 'phaser':     return typeEnum === 'PHASER_TYPE';
    case 'wah':        return typeEnum === 'WAH_TYPE';
    case 'compressor': return typeEnum === 'COMP_TYPE';
    case 'geq':        return typeEnum === 'GEQ_TYPE';
    case 'peq':        return typeEnum === 'PEQ_TYPE1' || typeEnum === 'PEQ_TYPE5';
    case 'filter':     return typeEnum === 'FILTER_TYPE';
    case 'tremolo':    return typeEnum === 'TREMOLO_TYPE';
    case 'gate':       return typeEnum === 'GATE_TYPE';
    default:           return false;
  }
}
