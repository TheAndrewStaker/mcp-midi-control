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
 *   - Type-knob applicability — `collectTypeKnobApplicabilityWarnings`
 *     (BK-071, Session 109) runs after preflight. It surfaces dropped
 *     knobs as `validation_info[]` entries with level='warning' rather
 *     than throwing, so the write proceeds and the agent self-corrects
 *     on the next turn via `retry_action`. Prior behavior was hard
 *     refusal (DispatchError value_out_of_range); replaced per MCP eng
 *     review (hard refusal taught agents to retry-loop instead of
 *     reading the info surface that drives recovery elsewhere).
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
import { resolveConceptKeyForBlock } from '../concept-keys.js';
import { findEnumMatch, resolveEnumAlias } from '../cross-device-enums.js';
import {
  formatUnknownEnumError,
  formatUnknownParamError,
  topClosest,
} from './errorFormat.js';

/**
 * Compute a small list of closest matches (up to `max` entries) to a
 * given input string. Used for the `suggestions[]` field on errors so
 * agents can pick a verbatim retry value.
 *
 * Wraps the shared `topClosest` helper in errorFormat.ts so the
 * preflight walker and per-device error sites rank candidates the
 * same way.
 */
function closest(input: string, options: readonly string[], max = 5): string[] {
  return topClosest(input, options, max);
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
  slotContext: string,
  map: Record<string, unknown>,
  errors: ValidationError[],
  info: ValidationInfo[],
  normalizedOut: Record<string, unknown>,
): void {
  const block = descriptor.blocks[blockKey];
  if (block === undefined) return;
  const validNames = Object.keys(block.params);
  for (const [paramName, value] of Object.entries(map)) {
    // Resolution order:
    //   1. Exact local-name match (the fast path — most common).
    //   2. Concept-key match (cross-device canonical vocabulary).
    //   3. Cross-device alias table (per-pair foreign-word fallback).
    //   4. Levenshtein "did you mean..." suggestion (existing behavior).
    //
    // Step 1 happens inside `resolveParamKey` further below. Step 2 runs
    // first here because concept-keys are device-agnostic and we want
    // an info notice that names the concept-key explicitly. Step 3
    // (alias) catches the per-pair cases that aren't concept-keys.
    let effectiveName = paramName;
    let aliasInfoEntry: ValidationInfo | undefined;

    // Step 2: concept-key resolution. If the agent typed a concept-key
    // (either fully-qualified `block.concept` or just `concept` for the
    // current block), rewrite to the device-local name.
    const conceptResult = resolveConceptKeyForBlock(descriptor.id, blockKey, paramName);
    if (
      conceptResult !== undefined
      && conceptResult.localName !== paramName.toLowerCase()
      && block.params[conceptResult.localName] !== undefined
    ) {
      effectiveName = conceptResult.localName;
      aliasInfoEntry = {
        slot_index: slotIndex,
        path: `${basePath}.${conceptResult.localName}`,
        info: `resolved ${blockKey}.${paramName} -> ${blockKey}.${conceptResult.localName} via cross-device concept-key "${conceptResult.conceptKey}"`,
        alias_used: paramName,
        canonical: conceptResult.localName,
      };
    } else {
      // Step 3: cross-device alias table. If the agent typed a foreign
      // device's vocabulary (e.g. `volume` on AM4 drive, where the
      // canonical is `level`), swap to the canonical before any further
      // resolution.
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
    }
    const path = `${basePath}.${effectiveName}`;
    const canonical = resolveParamKey(descriptor, blockKey, effectiveName);
    if (canonical === undefined) {
      errors.push({
        slot_index: slotIndex,
        path: `${basePath}.${paramName}`,
        error: formatUnknownParamError({
          slotContext,
          deviceName: descriptor.display_name,
          block: blockKey,
          badParam: paramName,
          knownNames: validNames,
        }),
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
              error:
                formatUnknownEnumError({
                  slotContext,
                  block: blockKey,
                  paramName: canonical,
                  badValue: value,
                  validValues: validLabels,
                }) +
                ` Closest match is "${enumResult.match}" — retry with that value if it's what you meant.`,
              suggestions:
                enumResult.candidates.length > 0
                  ? enumResult.candidates
                  : closest(value, validLabels),
              suggested_substitution: enumResult.match,
            });
            continue;
          } else {
            errors.push({
              slot_index: slotIndex,
              path,
              error: formatUnknownEnumError({
                slotContext,
                block: blockKey,
                paramName: canonical,
                badValue: value,
                validValues: validLabels,
              }),
              suggestions:
                enumResult.candidates.length > 0
                  ? enumResult.candidates
                  : closest(value, validLabels),
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
 *
 * Returns a (possibly normalized) slot ref. On grid devices, if the
 * caller passed a bare integer N, we silently coerce it to
 * `{row: 2, col: N}` (row 2 is the conventional signal-chain row on
 * II/III) and surface an `info[]` entry advising the agent of the
 * shorthand. The presetSlotShape zod schema documents that shorthand
 * as accepted, so preflight should match.
 */
function validateSlotRef(
  descriptor: DeviceDescriptor,
  slotIndex: number,
  slot: PresetSlotSpec['slot'],
  errors: ValidationError[],
  info: ValidationInfo[],
): PresetSlotSpec['slot'] {
  const cap = descriptor.capabilities;
  if (cap.slot_model === 'linear') {
    if (typeof slot !== 'number') {
      errors.push({
        slot_index: slotIndex,
        path: `slots[${slotIndex}].slot`,
        error: `${descriptor.display_name} is a linear-slot device , pass slot as a 1-based integer, not {row, col}.`,
      });
      return slot;
    }
    if (!Number.isInteger(slot) || slot < 1 || (cap.slot_count !== undefined && slot > cap.slot_count)) {
      errors.push({
        slot_index: slotIndex,
        path: `slots[${slotIndex}].slot`,
        error: `slot ${slot} out of range on ${descriptor.display_name} (valid: 1..${cap.slot_count ?? '?'})`,
      });
    }
    return slot;
  }
  if (cap.slot_model === 'grid') {
    // BK-XXX: auto-coerce bare-int shorthand to {row:2, col:N}. The
    // presetSlotShape zod schema documents this shorthand as accepted,
    // so the preflight walker must coerce rather than reject. Row 2
    // is the conventional audio-chain row on every grid Fractal
    // device (II / III); cells on row 1/3/4 require the long form.
    let normalized: PresetSlotSpec['slot'] = slot;
    if (typeof slot === 'number') {
      const coercedCol = slot;
      const coerced = { row: 2, col: coercedCol };
      info.push({
        slot_index: slotIndex,
        path: `slots[${slotIndex}].slot`,
        info: `coerced shorthand slot=${coercedCol} -> {row: 2, col: ${coercedCol}} on ${descriptor.display_name} (row 2 is the audio-chain row; pass {row, col} explicitly to target other rows)`,
        original_value: String(coercedCol),
        canonical: `{row: 2, col: ${coercedCol}}`,
      });
      normalized = coerced;
    } else if (typeof slot !== 'object' || slot === null) {
      errors.push({
        slot_index: slotIndex,
        path: `slots[${slotIndex}].slot`,
        error: `${descriptor.display_name} is a grid device , pass slot as {row, col} or as a single integer shorthand for {row: 2, col: N}.`,
      });
      return slot;
    }
    const ref = normalized as { row: number; col: number };
    const { row, col } = ref;
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
    return normalized;
  }
  return slot;
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
    const rawSlot = spec.slots[i];
    // T-5 (2026-05-21): merge params + params_by_channel into a single
    // internal `params` field for the existing dispatcher walkers.
    // Schema enforces flat-on-params + nested-on-params_by_channel;
    // setting both on one slot is a structured error. From here on the
    // dispatcher sees only `slot.params` (carrying whichever shape the
    // caller actually authored).
    let slot: PresetSlotSpec = rawSlot;
    const rawByChannel = (rawSlot as { params_by_channel?: unknown }).params_by_channel;
    if (rawByChannel !== undefined) {
      if (rawSlot.params !== undefined) {
        errors.push({
          slot_index: i,
          path: `slots[${i}]`,
          error: `slots[${i}] sets BOTH params (flat) AND params_by_channel (nested). Pick one: flat for non-channel blocks or active-channel-only writes; params_by_channel for multi-channel authoring.`,
        });
      } else {
        const { params_by_channel: _drop, ...rest } = rawSlot as PresetSlotSpec & { params_by_channel?: unknown };
        void _drop;
        slot = {
          ...rest,
          params: rawByChannel as PresetSlotSpec['params'],
        };
      }
    }
    const normalizedSlotRef = validateSlotRef(descriptor, i, slot.slot, errors, info);
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

    // AM4-style slot context used by the shared unknown-param /
    // unknown-enum formatter. Mirrors the format applyExecutor.ts
    // produces for AM4 single-write errors so every device reports
    // unknown-param errors with the same shape. Linear devices use
    // "(position N, block)"; grid devices use "(row R col C, block)".
    const slotContext = (() => {
      const blockLabel = blockKey ?? slot.block_type;
      if (typeof normalizedSlotRef === 'number') {
        return `slots[${i}] (position ${normalizedSlotRef}, ${blockLabel})`;
      }
      if (
        typeof normalizedSlotRef === 'object'
        && normalizedSlotRef !== null
        && 'row' in normalizedSlotRef
      ) {
        const ref = normalizedSlotRef as { row: number; col: number };
        return `slots[${i}] (row ${ref.row} col ${ref.col}, ${blockLabel})`;
      }
      return `slots[${i}] (${blockLabel})`;
    })();

    // Start a normalized copy of this slot. Default to passing the
    // input through unchanged; we'll overwrite `params` when we walk
    // them, and overwrite `block_type` if the block alias resolved.
    const normalizedSlot: { -readonly [K in keyof PresetSlotSpec]: PresetSlotSpec[K] } = {
      slot: normalizedSlotRef,
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
        slotContext,
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
            `${slotContext} channels.${chKey}`,
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
