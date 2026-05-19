/**
 * BK-059: structured pre-flight validation for `apply_preset`.
 *
 * Walks the entire spec BEFORE any wire op fires and collects every
 * shape / vocabulary error in one pass. Returning a non-empty array
 * lets the dispatcher reply with `validation_errors[]` and zero wire
 * ops, so the agent can fix the whole spec in one follow-up call
 * instead of bouncing through the legacy "first-error-throws" loop.
 *
 * What's validated:
 *
 *   1. Slot-ref shape matches `capabilities.slot_model` (linear vs grid).
 *   2. Block-type names resolve against `descriptor.blocks` (+ alias map).
 *   3. Param names per block resolve via the block's params + aliases.
 *   4. Param values:
 *        - enums (with `enum_values`) match a known display label.
 *        - numerics inside `display_min..display_max` when present.
 *        - any DispatchError thrown by the param's `encode()` is captured.
 *   5. Channel keys in nested params are listed in `channel_names[]`.
 *   6. Scene indices are inside `1..scene_count`.
 *   7. Scene channel/bypass block references resolve against descriptor.
 *   8. landingScene is inside the device's scene range.
 *   9. Routing edge `from`/`to` references match a slot id (or auto-id).
 *
 * What's NOT validated here (continues to live downstream):
 *   - Type-knob applicability , `precheckTypeKnobCompatibility` still
 *     runs after preflight; its errors throw as DispatchError so the
 *     agent's existing recovery path stays unchanged.
 *   - Wire-mode encoding (the writer's responsibility once display →
 *     wire conversion has happened).
 *   - Device-specific multi-instance disambiguation , the writer
 *     translates spec → executor input and may surface additional
 *     translation errors via `validatePreset`. Those are reported as
 *     a single fallback `validation_errors[]` entry when preflight is
 *     clean but the writer's pass throws.
 */

import {
  DispatchError,
  type DeviceDescriptor,
  type PresetSpec,
  type PresetSlotSpec,
  type ValidationError,
  type ValidationInfo,
} from '../types.js';
import { resolveParamAlias } from '../cross-device-aliases.js';
import { findEnumMatch, resolveEnumAlias } from '../cross-device-enums.js';

/**
 * Compute a small list of closest matches (up to `max` entries) to a
 * given input string. Used for the `suggestions[]` field on errors so
 * agents can pick a verbatim retry value.
 *
 * Algorithm: case-insensitive Levenshtein distance ≤ 3 OR
 * case-insensitive substring containment; rank by distance.
 */
function closest(input: string, options: readonly string[], max = 5): string[] {
  if (options.length === 0) return [];
  const i = input.trim().toLowerCase();
  type Scored = { value: string; score: number };
  const scored: Scored[] = [];
  for (const o of options) {
    const lo = o.trim().toLowerCase();
    if (lo === i) continue;
    const d = levenshtein(i, lo);
    const contains = lo.includes(i) || i.includes(lo);
    let score = d;
    if (contains) score = Math.min(score, 1);
    if (score <= 3) scored.push({ value: o, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, max).map((s) => s.value);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Resolve a block-type slug against the descriptor's block map + alias
 * table. Returns the canonical key into `descriptor.blocks` or
 * `undefined` if neither the slug nor any alias matches.
 */
function resolveBlockKey(descriptor: DeviceDescriptor, slug: string): string | undefined {
  if (descriptor.blocks[slug] !== undefined) return slug;
  const lower = slug.trim().toLowerCase();
  for (const k of Object.keys(descriptor.blocks)) {
    if (k.toLowerCase() === lower) return k;
  }
  const aliases = descriptor.block_aliases ?? {};
  const aliasMatch = aliases[slug] ?? aliases[lower];
  if (aliasMatch !== undefined && descriptor.blocks[aliasMatch] !== undefined) {
    return aliasMatch;
  }
  return undefined;
}

/**
 * Resolve a param name against a block schema, honoring its alias map.
 * Returns the canonical key into `block.params` or undefined.
 */
function resolveParamKey(
  descriptor: DeviceDescriptor,
  blockKey: string,
  paramName: string,
): string | undefined {
  const block = descriptor.blocks[blockKey];
  if (block === undefined) return undefined;
  if (block.params[paramName] !== undefined) return paramName;
  const lower = paramName.trim().toLowerCase();
  for (const k of Object.keys(block.params)) {
    if (k.toLowerCase() === lower) return k;
  }
  const aliases = block.aliases ?? {};
  const aliasMatch = aliases[paramName] ?? aliases[lower];
  if (aliasMatch !== undefined && block.params[aliasMatch] !== undefined) {
    return aliasMatch;
  }
  return undefined;
}

/**
 * Inspect a per-slot `params` object and classify it as flat
 * (`{rate: 0.8}`) vs channel-nested (`{X: {gain: 6}}`). Mixed shapes
 * are reported as a validation error; the caller stops walking that
 * slot's params after pushing the error.
 */
function classifyParamsShape(
  params: PresetSlotSpec['params'] | undefined,
): { shape: 'empty' | 'flat' | 'nested' | 'mixed'; entries: [string, unknown][] } {
  if (params === undefined || params === null) return { shape: 'empty', entries: [] };
  const entries = Object.entries(params as Record<string, unknown>);
  let nested = 0;
  let flat = 0;
  for (const [, v] of entries) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) nested++;
    else flat++;
  }
  if (nested === 0 && flat === 0) return { shape: 'empty', entries };
  if (nested > 0 && flat > 0) return { shape: 'mixed', entries };
  return { shape: nested > 0 ? 'nested' : 'flat', entries };
}

/**
 * Walk a `params` map (either flat or one channel slice of nested) and
 * push a ValidationError for every unknown name / out-of-range value /
 * unknown enum. Continues past errors so the agent sees every problem
 * at once.
 *
 * BK-065 + BK-066 phase 1 additions:
 *   - Before flagging "unknown param", consult the cross-device alias
 *     table (`resolveParamAlias`). When an alias substitution happens,
 *     the canonical name replaces the input and an entry lands in
 *     `info[]` so the agent learns the host vocabulary.
 *   - For enum-typed string values, run the four-tier `findEnumMatch`
 *     cascade. Exact + case/whitespace tiers auto-resolve silently
 *     (case/whitespace surfaces as info). Fuzzy tier rejects with a
 *     `suggested_substitution` field so the agent can retry. None tier
 *     rejects as today.
 *
 * The function builds a normalized output map (`normalizedOut`) that
 * the caller stitches back into a normalized PresetSpec for the
 * writer. Inputs are never mutated.
 */
function validateParamMap(
  descriptor: DeviceDescriptor,
  blockKey: string,
  basePath: string,
  slotIndex: number,
  map: Record<string, unknown>,
  errors: ValidationError[],
  info: ValidationInfo[],
  normalizedOut: Record<string, unknown>,
): void {
  const block = descriptor.blocks[blockKey];
  if (block === undefined) return;
  const validNames = Object.keys(block.params);
  for (const [paramName, value] of Object.entries(map)) {
    // First, consult the cross-device alias table. If the agent typed a
    // foreign device's vocabulary (e.g. `volume` on AM4 drive, where the
    // canonical is `level`), swap to the canonical before any further
    // resolution. The original name lands in `info[]` so the agent can
    // learn the host vocabulary.
    let effectiveName = paramName;
    let aliasInfoEntry: ValidationInfo | undefined;
    const aliasResult = resolveParamAlias(descriptor.id, blockKey, paramName);
    if (aliasResult.aliasUsed !== undefined && aliasResult.canonical !== paramName) {
      effectiveName = aliasResult.canonical;
      aliasInfoEntry = {
        slot_index: slotIndex,
        path: `${basePath}.${aliasResult.canonical}`,
        info: `resolved ${blockKey}.${paramName} -> ${blockKey}.${aliasResult.canonical} via cross-device alias`,
        alias_used: aliasResult.aliasUsed,
        canonical: aliasResult.canonical,
      };
    }
    const path = `${basePath}.${effectiveName}`;
    const canonical = resolveParamKey(descriptor, blockKey, effectiveName);
    if (canonical === undefined) {
      errors.push({
        slot_index: slotIndex,
        path: `${basePath}.${paramName}`,
        error: `unknown param "${paramName}" on ${descriptor.display_name} block "${blockKey}"`,
        suggestions: closest(paramName, validNames),
      });
      continue;
    }
    const schema = block.params[canonical];
    if (schema === undefined) continue;
    if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
      errors.push({
        slot_index: slotIndex,
        path,
        error: `${blockKey}.${canonical}: expected number or string, got ${typeof value}`,
      });
      continue;
    }
    // Track the value that lands in the normalized map. Enum tolerance
    // may rewrite a string `value` to its canonical casing before the
    // writer consumes it.
    let normalizedValue: number | string | boolean = value;
    if (schema.unit === 'enum' && schema.enum_values !== undefined) {
      if (typeof value === 'string') {
        const validLabels = Object.values(schema.enum_values);
        const enumResult = findEnumMatch(value, validLabels);
        if (enumResult.certainty === 'exact' && enumResult.match !== undefined) {
          normalizedValue = enumResult.match;
          // Silent: no info entry. Exact match is the happy path.
        } else if (enumResult.certainty === 'case_or_space' && enumResult.match !== undefined) {
          normalizedValue = enumResult.match;
          info.push({
            slot_index: slotIndex,
            path,
            info: `resolved ${blockKey}.${canonical}="${value}" -> "${enumResult.match}" via case/whitespace-tolerant match`,
            original_value: value,
            canonical: enumResult.match,
          });
        } else {
          // BK-066 Phase 2: Phase 1 didn't auto-resolve. Before
          // surfacing a fuzzy-match warning or a hard error, try the
          // concept-key cross-device table. The agent that learned
          // II's `"USA IIC+"` and now targets AM4 gets silently
          // routed to AM4's `"USA MK IIC+"`, with the substitution
          // logged in `info[]` so the agent learns the host word.
          const aliasResult = resolveEnumAlias(descriptor.id, blockKey, canonical, value);
          if (
            aliasResult.aliasUsed !== undefined &&
            aliasResult.canonical !== value &&
            validLabels.includes(aliasResult.canonical)
          ) {
            normalizedValue = aliasResult.canonical;
            info.push({
              slot_index: slotIndex,
              path,
              info: `resolved ${blockKey}.${canonical}="${value}" -> "${aliasResult.canonical}" via cross-device concept-key "${aliasResult.conceptKey}"`,
              original_value: value,
              canonical: aliasResult.canonical,
            });
          } else if (enumResult.certainty === 'fuzzy' && enumResult.match !== undefined) {
            // Reject: a fuzzy match could silently change the user's
            // intent. Surface the top match as `suggested_substitution`
            // so the agent can retry with a verbatim value if it agrees.
            errors.push({
              slot_index: slotIndex,
              path,
              error: `${blockKey}.${canonical}: unknown enum value "${value}". Closest match is "${enumResult.match}". Retry with that value if it's what you meant.`,
              suggestions: enumResult.candidates,
              suggested_substitution: enumResult.match,
            });
            continue;
          } else {
            errors.push({
              slot_index: slotIndex,
              path,
              error: `${blockKey}.${canonical}: unknown enum value "${value}"`,
              suggestions: enumResult.candidates.length > 0 ? enumResult.candidates : closest(value, validLabels),
            });
            continue;
          }
        }
      } else if (typeof value === 'number') {
        if (schema.enum_values[value] === undefined) {
          errors.push({
            slot_index: slotIndex,
            path,
            error: `${blockKey}.${canonical}: enum index ${value} out of range`,
          });
          continue;
        }
      }
    }
    try {
      schema.encode(normalizedValue as number | string);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const suggestions =
        err instanceof DispatchError && err.details?.valid_options
          ? Array.from(err.details.valid_options)
          : undefined;
      errors.push({
        slot_index: slotIndex,
        path,
        error: `${blockKey}.${canonical}: ${message}`,
        suggestions,
      });
      continue;
    }
    // Success: write into the normalized map under the canonical name.
    // If multiple foreign aliases collide on the same canonical (rare;
    // would mean the agent specified both `volume` and `level` on AM4
    // drive), the last writer wins, which mirrors the existing
    // last-key-wins JS behavior for duplicate keys in the source spec.
    normalizedOut[canonical] = normalizedValue;
    if (aliasInfoEntry !== undefined) {
      info.push(aliasInfoEntry);
    }
  }
}

/**
 * Validate a slot ref against `capabilities.slot_model`. Errors when the
 * shape (number vs `{row,col}`) doesn't match, or when an out-of-range
 * row/col/index is supplied.
 */
function validateSlotRef(
  descriptor: DeviceDescriptor,
  slotIndex: number,
  slot: PresetSlotSpec['slot'],
  errors: ValidationError[],
): void {
  const cap = descriptor.capabilities;
  if (cap.slot_model === 'linear') {
    if (typeof slot !== 'number') {
      errors.push({
        slot_index: slotIndex,
        path: `slots[${slotIndex}].slot`,
        error: `${descriptor.display_name} is a linear-slot device , pass slot as a 1-based integer, not {row, col}.`,
      });
      return;
    }
    if (!Number.isInteger(slot) || slot < 1 || (cap.slot_count !== undefined && slot > cap.slot_count)) {
      errors.push({
        slot_index: slotIndex,
        path: `slots[${slotIndex}].slot`,
        error: `slot ${slot} out of range on ${descriptor.display_name} (valid: 1..${cap.slot_count ?? '?'})`,
      });
    }
    return;
  }
  if (cap.slot_model === 'grid') {
    if (typeof slot !== 'object' || slot === null) {
      errors.push({
        slot_index: slotIndex,
        path: `slots[${slotIndex}].slot`,
        error: `${descriptor.display_name} is a grid device , pass slot as {row, col}, not a single integer.`,
      });
      return;
    }
    const { row, col } = slot;
    const rows = cap.grid?.rows;
    const cols = cap.grid?.cols;
    if (!Number.isInteger(row) || row < 1 || (rows !== undefined && row > rows)) {
      errors.push({
        slot_index: slotIndex,
        path: `slots[${slotIndex}].slot.row`,
        error: `row ${row} out of range (valid: 1..${rows ?? '?'})`,
      });
    }
    if (!Number.isInteger(col) || col < 1 || (cols !== undefined && col > cols)) {
      errors.push({
        slot_index: slotIndex,
        path: `slots[${slotIndex}].slot.col`,
        error: `col ${col} out of range (valid: 1..${cols ?? '?'})`,
      });
    }
  }
}

/**
 * Result envelope for the preflight walker. Carries every classified
 * problem (`errors`), every silent auto-resolution that lands as a
 * post-success advisory (`info`), and a normalized spec where alias
 * substitutions + case/whitespace-tolerant enum matches have been
 * collapsed to the device's canonical vocabulary.
 *
 * When `errors.length > 0` the dispatcher returns the validation
 * response without firing any wire ops; `normalized_spec` reflects
 * whatever did normalize cleanly, but consumers should not rely on
 * it in that case.
 *
 * When `errors.length === 0` the dispatcher hands `normalized_spec`
 * (not the original) to the writer, so the writer never has to know
 * about the alias table or the enum matcher. `info[]` rides through
 * to `ApplyResult.validation_info` on the success path.
 */
export interface PreflightResult {
  errors: readonly ValidationError[];
  info: readonly ValidationInfo[];
  normalized_spec: PresetSpec;
}

/**
 * Main entry. Walks the spec and returns the full preflight envelope:
 * errors, info notices, and a normalized copy of the spec where the
 * cross-device alias table + tolerant enum matcher have already
 * collapsed inputs onto the device's canonical vocabulary.
 *
 * Pure: the input `spec` is never mutated. The normalized spec is a
 * shallow copy with `slots[].params` rebuilt onto new objects.
 */
export function collectApplyPresetPreflight(
  spec: PresetSpec,
  descriptor: DeviceDescriptor,
): PreflightResult {
  const errors: ValidationError[] = [];
  const info: ValidationInfo[] = [];
  const normalizedSlots: PresetSlotSpec[] = [];
  const cap = descriptor.capabilities;
  const channelNames = cap.channel_names ?? [];
  const channelNamesUpper = channelNames.map((c) => c.toUpperCase());

  // ── slots ─────────────────────────────────────────────────────────
  const slotIds: string[] = [];
  for (let i = 0; i < spec.slots.length; i++) {
    const slot = spec.slots[i];
    validateSlotRef(descriptor, i, slot.slot, errors);
    const blockKey = resolveBlockKey(descriptor, slot.block_type);
    if (blockKey === undefined) {
      errors.push({
        slot_index: i,
        path: `slots[${i}].block_type`,
        error: `unknown block_type "${slot.block_type}" on ${descriptor.display_name}`,
        suggestions: closest(slot.block_type, Object.keys(descriptor.blocks)),
      });
    }
    const id = slot.id ?? `${slot.block_type.toLowerCase()}${slot.instance !== undefined && slot.instance !== 1 ? `_${slot.instance}` : ''}`;
    slotIds.push(id);

    // Start a normalized copy of this slot. Default to passing the
    // input through unchanged; we'll overwrite `params` when we walk
    // them, and overwrite `block_type` if the block alias resolved.
    const normalizedSlot: { -readonly [K in keyof PresetSlotSpec]: PresetSlotSpec[K] } = {
      slot: slot.slot,
      block_type: blockKey ?? slot.block_type,
    };
    if (slot.bypassed !== undefined) normalizedSlot.bypassed = slot.bypassed;
    if (slot.id !== undefined) normalizedSlot.id = slot.id;
    if (slot.instance !== undefined) normalizedSlot.instance = slot.instance;

    if (blockKey === undefined) {
      // Push the partial normalized entry anyway so slot indexes line
      // up if the caller later re-walks (e.g. logging). No params copy
      // because we have no canonical block to validate against.
      if (slot.params !== undefined) {
        normalizedSlot.params = slot.params;
      }
      normalizedSlots.push(normalizedSlot);
      continue;
    }
    const shape = classifyParamsShape(slot.params);
    if (shape.shape === 'mixed') {
      errors.push({
        slot_index: i,
        path: `slots[${i}].params`,
        error: `params mixes flat values and channel-nested objects. Use one shape per slot: flat for current-channel writes, channel-nested ({X: {...}}) for per-channel.`,
      });
      if (slot.params !== undefined) normalizedSlot.params = slot.params;
      normalizedSlots.push(normalizedSlot);
      continue;
    }
    if (shape.shape === 'flat') {
      const normalizedFlat: Record<string, unknown> = {};
      validateParamMap(
        descriptor,
        blockKey,
        `slots[${i}].params`,
        i,
        slot.params as Record<string, unknown>,
        errors,
        info,
        normalizedFlat,
      );
      normalizedSlot.params = normalizedFlat as PresetSlotSpec['params'];
      normalizedSlots.push(normalizedSlot);
      continue;
    }
    if (shape.shape === 'nested') {
      const block = descriptor.blocks[blockKey];
      const blockHasChannels = cap.has_channels && (cap.channel_blocks?.includes(blockKey) ?? true);
      if (!cap.has_channels || !blockHasChannels) {
        errors.push({
          slot_index: i,
          path: `slots[${i}].params`,
          error: `block "${blockKey}" does not expose channels on ${descriptor.display_name} , use a flat params object instead of nested {X: {...}}.`,
        });
        if (slot.params !== undefined) normalizedSlot.params = slot.params;
        normalizedSlots.push(normalizedSlot);
        continue;
      }
      const normalizedNested: Record<string, Record<string, unknown>> = {};
      for (const [chKey, paramMap] of shape.entries) {
        const upperCh = chKey.trim().toUpperCase();
        if (channelNamesUpper.length > 0 && !channelNamesUpper.includes(upperCh)) {
          errors.push({
            slot_index: i,
            path: `slots[${i}].params.${chKey}`,
            error: `unknown channel "${chKey}" on ${descriptor.display_name} (valid: ${channelNames.join(', ')})`,
            suggestions: channelNames as string[],
          });
          continue;
        }
        if (paramMap !== null && typeof paramMap === 'object' && !Array.isArray(paramMap)) {
          const innerNormalized: Record<string, unknown> = {};
          validateParamMap(
            descriptor,
            blockKey,
            `slots[${i}].params.${chKey}`,
            i,
            paramMap as Record<string, unknown>,
            errors,
            info,
            innerNormalized,
          );
          normalizedNested[chKey] = innerNormalized;
        }
      }
      normalizedSlot.params = normalizedNested as PresetSlotSpec['params'];
      normalizedSlots.push(normalizedSlot);
      void block;
    } else {
      // shape: 'empty', pass through unchanged.
      normalizedSlots.push(normalizedSlot);
    }
  }

  // ── scenes ─────────────────────────────────────────────────────────
  if (spec.scenes !== undefined) {
    for (let i = 0; i < spec.scenes.length; i++) {
      const sc = spec.scenes[i];
      if (!cap.has_scenes) {
        errors.push({
          scene_index: i,
          path: `scenes[${i}]`,
          error: `${descriptor.display_name} does not expose scenes , drop the scenes[] array.`,
        });
        continue;
      }
      const sceneCount = cap.scene_count ?? 8;
      if (!Number.isInteger(sc.scene) || sc.scene < 1 || sc.scene > sceneCount) {
        errors.push({
          scene_index: i,
          path: `scenes[${i}].scene`,
          error: `scene index ${sc.scene} out of range (valid: 1..${sceneCount})`,
        });
      }
      if (sc.channels !== undefined) {
        for (const [blockSlug, ch] of Object.entries(sc.channels)) {
          const blockKey = resolveBlockKey(descriptor, blockSlug);
          if (blockKey === undefined) {
            errors.push({
              scene_index: i,
              path: `scenes[${i}].channels.${blockSlug}`,
              error: `unknown block "${blockSlug}" referenced in scenes[].channels`,
              suggestions: closest(blockSlug, Object.keys(descriptor.blocks)),
            });
            continue;
          }
          const upperCh = String(typeof ch === 'number' ? channelNames[ch] ?? `#${ch}` : ch).trim().toUpperCase();
          if (channelNamesUpper.length > 0 && !channelNamesUpper.includes(upperCh)) {
            errors.push({
              scene_index: i,
              path: `scenes[${i}].channels.${blockSlug}`,
              error: `channel "${ch}" is not valid on ${descriptor.display_name} (valid: ${channelNames.join(', ')})`,
              suggestions: channelNames as string[],
            });
          }
        }
      }
      if (sc.bypassed !== undefined) {
        for (const [blockSlug] of Object.entries(sc.bypassed)) {
          const blockKey = resolveBlockKey(descriptor, blockSlug);
          if (blockKey === undefined) {
            errors.push({
              scene_index: i,
              path: `scenes[${i}].bypassed.${blockSlug}`,
              error: `unknown block "${blockSlug}" referenced in scenes[].bypassed`,
              suggestions: closest(blockSlug, Object.keys(descriptor.blocks)),
            });
          }
        }
      }
    }
  }

  // ── landingScene ──────────────────────────────────────────────────
  if (spec.landingScene !== undefined && cap.has_scenes) {
    const sceneCount = cap.scene_count ?? 8;
    if (!Number.isInteger(spec.landingScene) || spec.landingScene < 1 || spec.landingScene > sceneCount) {
      errors.push({
        path: 'landingScene',
        error: `landingScene=${spec.landingScene} out of range (valid: 1..${sceneCount})`,
      });
    }
  }

  // ── routing ───────────────────────────────────────────────────────
  if (spec.routing !== undefined && spec.routing.length > 0) {
    if (cap.slot_model === 'linear') {
      errors.push({
        path: 'routing',
        error: `${descriptor.display_name} is a linear-slot device , routing edges are not accepted (routing is implicit by slot order).`,
      });
    } else {
      for (let i = 0; i < spec.routing.length; i++) {
        const edge = spec.routing[i];
        if (!slotIds.includes(edge.from)) {
          errors.push({
            routing_index: i,
            path: `routing[${i}].from`,
            error: `routing edge references unknown block id "${edge.from}"`,
            suggestions: closest(edge.from, slotIds),
          });
        }
        if (!slotIds.includes(edge.to)) {
          errors.push({
            routing_index: i,
            path: `routing[${i}].to`,
            error: `routing edge references unknown block id "${edge.to}"`,
            suggestions: closest(edge.to, slotIds),
          });
        }
      }
    }
  }

  // Stitch the normalized spec. We only rewrote `slots[].block_type`
  // (when a block alias resolved) and `slots[].params` (alias +
  // enum-tolerance substitutions). Scenes, routing, name, and
  // landingScene pass through verbatim.
  const normalized_spec: PresetSpec = {
    slots: normalizedSlots,
    ...(spec.scenes !== undefined ? { scenes: spec.scenes } : {}),
    ...(spec.name !== undefined ? { name: spec.name } : {}),
    ...(spec.landingScene !== undefined ? { landingScene: spec.landingScene } : {}),
    ...(spec.routing !== undefined ? { routing: spec.routing } : {}),
  };

  return { errors, info, normalized_spec };
}

/**
 * Legacy entry point. Pre-BK-065 / BK-066 callers wanted just the
 * errors array; goldens and external tools still import this shape.
 * Wraps `collectApplyPresetPreflight` and returns only the errors.
 */
export function collectApplyPresetErrors(
  spec: PresetSpec,
  descriptor: DeviceDescriptor,
): ValidationError[] {
  const result = collectApplyPresetPreflight(spec, descriptor);
  return [...result.errors];
}
