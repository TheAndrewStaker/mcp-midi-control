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
} from '../types.js';

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
 */
function validateParamMap(
  descriptor: DeviceDescriptor,
  blockKey: string,
  basePath: string,
  slotIndex: number,
  map: Record<string, unknown>,
  errors: ValidationError[],
): void {
  const block = descriptor.blocks[blockKey];
  if (block === undefined) return;
  const validNames = Object.keys(block.params);
  for (const [paramName, value] of Object.entries(map)) {
    const path = `${basePath}.${paramName}`;
    const canonical = resolveParamKey(descriptor, blockKey, paramName);
    if (canonical === undefined) {
      errors.push({
        slot_index: slotIndex,
        path,
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
    if (schema.unit === 'enum' && schema.enum_values !== undefined) {
      if (typeof value === 'string') {
        const validLabels = Object.values(schema.enum_values);
        const lower = value.trim().toLowerCase();
        const matched = validLabels.some((label) => label.toLowerCase() === lower);
        if (!matched) {
          errors.push({
            slot_index: slotIndex,
            path,
            error: `${blockKey}.${canonical}: unknown enum value "${value}"`,
            suggestions: closest(value, validLabels),
          });
          continue;
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
      schema.encode(value as number | string);
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
 * Main entry. Returns every problem the walker finds. Empty array means
 * "structurally clean" , `executeApplyPreset` proceeds to type-knob
 * precheck + writer.applyPreset.
 */
export function collectApplyPresetErrors(
  spec: PresetSpec,
  descriptor: DeviceDescriptor,
): ValidationError[] {
  const errors: ValidationError[] = [];
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

    if (blockKey === undefined) continue;
    const shape = classifyParamsShape(slot.params);
    if (shape.shape === 'mixed') {
      errors.push({
        slot_index: i,
        path: `slots[${i}].params`,
        error: `params mixes flat values and channel-nested objects. Use one shape per slot: flat for current-channel writes, channel-nested ({X: {...}}) for per-channel.`,
      });
      continue;
    }
    if (shape.shape === 'flat') {
      validateParamMap(descriptor, blockKey, `slots[${i}].params`, i, slot.params as Record<string, unknown>, errors);
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
        continue;
      }
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
          validateParamMap(
            descriptor,
            blockKey,
            `slots[${i}].params.${chKey}`,
            i,
            paramMap as Record<string, unknown>,
            errors,
          );
        }
      }
      void block;
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

  return errors;
}
