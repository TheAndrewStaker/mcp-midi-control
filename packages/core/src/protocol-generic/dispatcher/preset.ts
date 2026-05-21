/**
 * Preset executors — `apply_preset`, `apply_setlist`, `restore_defaults`
 * full-lifecycle dispatch.
 *
 * `apply_preset` works in two modes: working-buffer only (no
 * target_location) or atomic switch + apply + save (with target_location).
 * `apply_setlist` iterates apply_preset across an N-entry batch with one
 * shared inbound capture. `restore_defaults` resets one location or a
 * range to factory; the descriptor decides which writer hook to call.
 */

import {
  DispatchError,
  type ApplyResult,
  type ApplySetlistResult,
  type DeviceDescriptor,
  type PresetSnapshot,
  type PresetSlotSpec,
  type PresetSpec,
  type RestoreDefaultsRangeOptions,
  type RestoreDefaultsRangeResult,
  type RestoreDefaultsResult,
  type SetlistApplyOptions,
  type SetlistEntrySpec,
  type ValidationError,
  type ValidationInfo,
} from '../types.js';

import { invalidateBlockLayoutCache } from './blockLayoutCache.js';
import { openCtx, requireDevice } from './core.js';
import { collectApplyPresetPreflight } from './preflight.js';
import { translatePresetSpec, type TranslatePresetResult } from '../port-preset.js';

/**
 * BK-071: type-knob applicability pre-flight for `apply_preset`.
 *
 * When a slot specifies both a `type` enum value AND additional knobs,
 * the picked type may not expose every listed knob — the wire writes
 * ack but those knob values silently no-op on the device. The H1
 * Sunday Morning trace surfaced this: agent set
 * `reverb.type="Hall, Large"` + `reverb.time=6`, the writes acked,
 * the agent reported "decay locked in" — but Hall algorithms are
 * fixed-decay and `time` never applied.
 *
 * The pre-flight runs per-knob via `findCompatibleTypes` and returns
 * structured `ValidationInfo` entries for each dropped param. The
 * dispatcher accepts the write (the user may want the type for
 * other reasons; refusing violates display-first + user-agency) and
 * surfaces the drops on `validation_info[]` so the agent self-corrects
 * on the next turn instead of reporting false success.
 *
 * Why soft-warn instead of hard refusal (MCP eng review 2026-05-21):
 *   - A guitarist might want Hall for the tail texture and accept the
 *     fixed-decay default. Refusing the type robs them of that choice.
 *   - Hard refusal teaches agents to retry-loop around dispatcher
 *     errors instead of reading the structured info surface that
 *     already drives recovery on alias / case-tolerance paths.
 *
 * Device must implement `descriptor.findCompatibleTypes` for the
 * pre-flight to run. Devices without it (Axe-Fx II / III / Hydra
 * today) return an empty array — their existing dropped-param warning
 * path remains. Adding `findCompatibleTypes` to those devices later
 * activates the pre-flight automatically with no dispatcher change.
 */
/**
 * BK-077: channel-Y inactive pre-flight for `apply_preset`.
 *
 * When a slot specifies channel-nested params (e.g. `{X: {...}, Y: {...}}`)
 * BUT every scene in `spec.scenes[]` references a different channel for
 * that block, the channel-Y data is written to the working buffer yet
 * never reaches the audio path. The agent reports "applied Y settings"
 * and the user hears the X channel's tone. BK-058 traced this class of
 * silent failure on Axe-Fx II; the writer-side fix preserved Y data,
 * but a spec that wrote Y while every authored scene routes to X is
 * still a real trap.
 *
 * Fires only when `spec.scenes` is explicitly defined AND non-empty. A
 * working-buffer-only apply (no scenes[]) inherits the device's current
 * scene configuration, which the dispatcher can't see without a wire
 * read; in that case we stay silent rather than risk a false positive.
 *
 * Soft-warn (level='warning'), not refusal: the user might be authoring
 * Y state for a future scene swap (a `set_param` after the apply could
 * route a scene to Y). Surfacing the trap lets the agent self-correct
 * (move the params under an active channel, or add a scene mapping)
 * without robbing the user of intentional Y-stash flows.
 *
 * No additional wire reads: the check is pure spec validation. Devices
 * without channels or scenes return an empty array.
 */
export function collectChannelYInactiveWarnings(
  spec: PresetSpec,
  descriptor: DeviceDescriptor,
): ValidationInfo[] {
  const out: ValidationInfo[] = [];
  if (spec.scenes === undefined || spec.scenes.length === 0) return out;
  const cap = descriptor.capabilities;
  if (!cap.has_scenes || !cap.has_channels) return out;
  const channelNames = cap.channel_names ?? [];
  if (channelNames.length === 0) return out;
  const channelNamesUpper = channelNames.map((c) => c.toUpperCase());

  for (let i = 0; i < spec.slots.length; i++) {
    const slot = spec.slots[i];
    const params = slot.params;
    if (params === undefined || params === null) continue;
    const entries = Object.entries(params as Record<string, unknown>);
    const looksNested = entries.some(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v));
    if (!looksNested) continue;

    const paramChannels = new Map<string, Record<string, unknown>>();
    for (const [chKey, chValue] of entries) {
      if (chValue === null || typeof chValue !== 'object' || Array.isArray(chValue)) continue;
      const upperCh = chKey.trim().toUpperCase();
      if (!channelNamesUpper.includes(upperCh)) continue;
      paramChannels.set(upperCh, chValue as Record<string, unknown>);
    }
    if (paramChannels.size === 0) continue;

    const blockType = slot.block_type;
    const blockTypeLower = blockType.toLowerCase();
    const slotIdLower = slot.id?.toLowerCase();
    const matchesSlot = (blockSlug: string): boolean => {
      const sl = blockSlug.trim().toLowerCase();
      return sl === blockTypeLower || (slotIdLower !== undefined && sl === slotIdLower);
    };

    const referencedChannels = new Set<string>();
    const sceneRefs: { scene: number; channel: string | undefined }[] = [];
    for (const sc of spec.scenes) {
      let entry: { channel: string | undefined } = { channel: undefined };
      if (sc.channels !== undefined) {
        for (const [blockSlug, ch] of Object.entries(sc.channels)) {
          if (!matchesSlot(blockSlug)) continue;
          const normalized = typeof ch === 'number'
            ? channelNames[ch]?.toUpperCase()
            : String(ch).trim().toUpperCase();
          if (normalized !== undefined && channelNamesUpper.includes(normalized)) {
            referencedChannels.add(normalized);
            entry = { channel: normalized };
          }
          break;
        }
      }
      sceneRefs.push({ scene: sc.scene, channel: entry.channel });
    }

    // Only warn when at least one scene explicitly constrains this
    // block's channel. An empty `referencedChannels` means no scene in
    // the spec touched this block's channel pointer; device-side scenes
    // still apply, so we can't claim Y is inactive without a wire read.
    if (referencedChannels.size === 0) continue;

    for (const [paramCh, paramMap] of paramChannels) {
      if (referencedChannels.has(paramCh)) continue;
      const droppedParams = Object.keys(paramMap);
      if (droppedParams.length === 0) continue;
      const head = droppedParams.slice(0, 5);
      const more = droppedParams.length > head.length ? ` (+${droppedParams.length - head.length} more)` : '';
      const referencedList = Array.from(referencedChannels).join(', ');
      const sceneSummary = sceneRefs
        .map((s) => `scene ${s.scene}→${s.channel ?? '(unspecified)'}`)
        .join(', ');
      const activeAlts = Array.from(referencedChannels).join('/');
      out.push({
        slot_index: i,
        path: `slots[${i}].params.${paramCh}`,
        info: `${blockType} channel-${paramCh} params (${head.join(', ')}${more}) write to the working buffer but no scene in this spec activates ${blockType} channel ${paramCh} (${sceneSummary}). The channel-${paramCh} state is stored but inaudible unless an existing device-side scene routes ${blockType} to ${paramCh}.`,
        level: 'warning',
        dropped_param: droppedParams.length === 1 ? droppedParams[0] : undefined,
        reason: `No scene in spec.scenes[] sets ${blockType} channel to ${paramCh}; authored scenes use ${referencedList}.`,
        retry_action: `Either add channel ${paramCh} to one of the scenes' channel maps (e.g. \`scenes[N].channels.${blockType} = "${paramCh}"\`), or move the channel-${paramCh} params under one of the active channels (${activeAlts}).`,
      });
    }
  }
  return out;
}

export function collectTypeKnobApplicabilityWarnings(
  spec: PresetSpec,
  descriptor: DeviceDescriptor,
): ValidationInfo[] {
  return applyTypeKnobApplicabilityPreflight(spec, descriptor).warnings;
}

/**
 * T-7 (Session "subtraction-sprint", 2026-05-21): the same BK-071 walk,
 * extended to STRIP each dropped knob from the spec before wire
 * dispatch instead of just warning post-hoc. Rationale:
 *
 *   - Pre-T-7 behavior: warning collected pre-flight, BUT the spec
 *     including the dropped knob was still sent on the wire. The device
 *     acked and silently no-op'd. Wasted SysEx round-trip per dropped
 *     knob (50-300 ms apiece on AM4, 50 ms apiece on II).
 *   - Post-T-7 behavior: dropped knob is removed from the spec before
 *     `writer.applyPreset` sees it. No wire byte is sent for a write
 *     the device would have silently dropped. The warning still fires
 *     and tells the agent which write was suppressed and why.
 *
 * This preserves the existing soft-warn philosophy: the type is still
 * applied (a guitarist who wants Hall for the tail texture gets Hall),
 * only the knob that the type fundamentally can't express is suppressed.
 * The user-agency rationale documented above is unchanged. What changes
 * is that we stop pretending the wire write matters when we know it
 * doesn't.
 *
 * Returns:
 *   - `spec`: a deep-copy of the input with dropped knobs removed.
 *     Empty channels (every knob dropped) are themselves dropped to keep
 *     the spec clean. If nothing was filtered, returns the original
 *     reference (no allocation on the common path).
 *   - `warnings`: ValidationInfo[] with level='warning' and
 *     dropped_param set for each suppressed knob. Same shape as the
 *     legacy `collectTypeKnobApplicabilityWarnings` return.
 */
export function applyTypeKnobApplicabilityPreflight(
  spec: PresetSpec,
  descriptor: DeviceDescriptor,
): { spec: PresetSpec; warnings: ValidationInfo[] } {
  // Stash the function reference in a local so TS narrows it inside the
  // .map closure below (the outer descriptor.findCompatibleTypes guard
  // doesn't survive the closure boundary).
  const findCompatibleTypes = descriptor.findCompatibleTypes;
  if (findCompatibleTypes === undefined) return { spec, warnings: [] };
  const warnings: ValidationInfo[] = [];
  let mutated = false;
  const newSlots = spec.slots.map((slot, i): PresetSlotSpec => {
    const params = slot.params;
    if (params === undefined || params === null) return slot;
    // PresetSlotSpec.params allows EITHER a flat record (`{type, knob1,
    // knob2}`) for non-channel blocks OR a channel-nested record (`{A:
    // {type, knob1}, D: {type, knob2}}`) for channel blocks. Walk both
    // shapes uniformly.
    const channelMaps: { channel: string | undefined; map: Record<string, unknown> }[] = [];
    const entries = Object.entries(params as Record<string, unknown>);
    const looksNested = entries.some(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v));
    if (looksNested) {
      for (const [ch, v] of entries) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          channelMaps.push({ channel: ch, map: v as Record<string, unknown> });
        }
      }
    } else {
      channelMaps.push({ channel: undefined, map: params as Record<string, unknown> });
    }
    // Pairs of (channel, knob) to strip from this slot's params after
    // the walk completes.
    const dropsForSlot: { channel: string | undefined; knob: string }[] = [];
    for (const { channel, map } of channelMaps) {
      const typeValue = map.type;
      if (typeof typeValue !== 'string') continue;
      const knobNames = Object.keys(map).filter((k) => k !== 'type');
      if (knobNames.length === 0) continue;
      // Bulk gate: if the type exposes every knob, skip the per-knob
      // loop entirely. Most calls land here (the common case is
      // type-compatible specs).
      const bulk = findCompatibleTypes({ block: slot.block_type, params: knobNames });
      if (!bulk.applicability_known) continue;
      if (bulk.compatible_types.includes(typeValue)) continue;
      // Type fails the bulk gate — at least one knob is dropped. Loop
      // per-knob to pinpoint which (and surface each with its own
      // retry pointer).
      for (const knobName of knobNames) {
        const perKnob = findCompatibleTypes({
          block: slot.block_type,
          params: [knobName],
        });
        if (!perKnob.applicability_known) continue;
        if (perKnob.compatible_types.includes(typeValue)) continue;
        const where = channel !== undefined ? `.${channel}` : '';
        const head = perKnob.compatible_types.slice(0, 8);
        const more = perKnob.compatible_types.length > head.length
          ? ` (… ${perKnob.compatible_types.length - head.length} more)`
          : '';
        dropsForSlot.push({ channel, knob: knobName });
        warnings.push({
          slot_index: i,
          path: `slots[${i}].params${where}.${knobName}`,
          info: `${slot.block_type}.${knobName} is not exposed by ${slot.block_type}.type="${typeValue}" on ${descriptor.display_name}. The write was suppressed by apply_preset pre-flight (the device would have silently no-op'd it). Pick a type that exposes ${knobName} (e.g. ${head.join(', ')}${more}) or call find_compatible_types({block:"${slot.block_type}", params:["${knobName}"]}) for the full list.`,
          level: 'warning',
          dropped_param: knobName,
          reason: `${slot.block_type}.type="${typeValue}" does not expose ${knobName} on ${descriptor.display_name}.`,
          retry_action: `Call find_compatible_types({block:"${slot.block_type}", params:["${knobName}"]}) to pick a ${knobName}-exposing ${slot.block_type} type, then re-issue apply_preset with the verbatim choice.`,
        });
      }
    }
    if (dropsForSlot.length === 0) return slot;
    mutated = true;
    // The strip helper preserves the input's shape (flat ⇄ flat,
    // nested ⇄ nested), so the resulting params still satisfies the
    // PresetSlotSpec union. Cast at the boundary so we don't have to
    // thread a polymorphic generic through the helper.
    const filteredParams = stripDroppedKnobsFromSlotParams(params, dropsForSlot) as PresetSlotSpec['params'];
    return { ...slot, params: filteredParams };
  });
  if (!mutated) return { spec, warnings };
  return { spec: { ...spec, slots: newSlots }, warnings };
}

/**
 * Remove the (channel, knob) pairs from a slot's params record.
 * Handles both flat and channel-nested shapes; preserves whichever the
 * input used. Empty channels (every knob filtered out) are themselves
 * dropped so the spec stays clean.
 */
function stripDroppedKnobsFromSlotParams(
  params: unknown,
  drops: readonly { channel: string | undefined; knob: string }[],
): unknown {
  if (params === null || typeof params !== 'object') return params;
  const entries = Object.entries(params as Record<string, unknown>);
  const looksNested = entries.some(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v));
  if (looksNested) {
    const out: Record<string, unknown> = {};
    for (const [ch, v] of entries) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const droppedKnobsForCh = new Set(
          drops.filter((d) => d.channel === ch).map((d) => d.knob),
        );
        const chMap = v as Record<string, unknown>;
        const newChMap: Record<string, unknown> = {};
        for (const [k, kv] of Object.entries(chMap)) {
          if (!droppedKnobsForCh.has(k)) newChMap[k] = kv;
        }
        if (Object.keys(newChMap).length > 0) out[ch] = newChMap;
      } else {
        out[ch] = v;
      }
    }
    return out;
  }
  const droppedKnobsFlat = new Set(
    drops.filter((d) => d.channel === undefined).map((d) => d.knob),
  );
  const flat = params as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) {
    if (!droppedKnobsFlat.has(k)) out[k] = v;
  }
  return out;
}

/**
 * BK-070: full lifecycle for `get_preset`. One round-trip per placed
 * block via the device's atomic-read primitive; closes the N×get_param
 * read pain in a single tool call.
 *
 * Returns a PresetSnapshot describing the active working buffer. Scope
 * v1: active-channel state only, no routing edges, no per-scene
 * snapshots. The reader populates `_meta` with the device label,
 * timestamp, and partial-info flags so callers can distinguish a
 * complete snapshot from a partial one programmatically.
 *
 * Devices that don't implement `reader.getPreset` error with
 * capability_not_supported. Callers fall back to grid + per-block
 * get_param reads.
 */
export async function executeGetPreset(args: {
  port: string;
  include_channel_state?: boolean;
}): Promise<PresetSnapshot> {
  const descriptor = requireDevice(args.port);
  if (descriptor.reader.getPreset === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `get_preset is not implemented for ${descriptor.display_name}. Fall back to get_param / get_params per block, or call describe_device to see which capabilities the device exposes.`,
    );
  }
  const ctx = openCtx(descriptor);
  return descriptor.reader.getPreset(ctx, { include_channel_state: args.include_channel_state === true });
}

/**
 * Full lifecycle for `apply_preset`. Optional `target_location` runs the
 * switch + apply + save sequence atomically; without it, writes the
 * spec to the working buffer only (legacy `am4_apply_preset` shape).
 *
 * Safe-edit gates apply when `target_location` is set (cf.
 * `docs/SAFE-EDIT-WORKFLOW.md`):
 *   - `save_authorized` MUST be true; otherwise the dispatcher
 *     throws a `save_authorization_required` DispatchError that the
 *     unified tool handler formats into the canonical refusal text.
 *   - `on_active_preset_edited` is passed to the descriptor's
 *     `guardActiveBufferOrSave` (if the device supports dirty
 *     tracking); a refusal becomes a `buffer_dirty` DispatchError.
 *
 * Working-buffer-only mode (no `target_location`) doesn't navigate
 * and doesn't save, so neither gate applies.
 */
export async function executeApplyPreset(args: {
  port: string;
  spec: PresetSpec;
  target_location?: string | number;
  save_authorized?: boolean;
  on_active_preset_edited?: 'warn' | 'discard' | 'save_active_first';
  /**
   * BK-057: when true, the dispatcher runs `writer.verifyChain` after a
   * successful `applyPreset` and decorates the response with
   * `chain_integrity`. Devices that don't implement `verifyChain` get
   * a trivial-pass envelope ("not applicable on <device>").
   */
  verify_chain?: boolean;
}): Promise<ApplyResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  if (descriptor.writer.applyPreset === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `apply_preset is not implemented for ${descriptor.display_name}.`,
    );
  }
  if (args.target_location !== undefined && !descriptor.capabilities.supports_save) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `apply_preset(target_location=...) requires a device that supports save; ${descriptor.display_name} does not.`,
    );
  }
  // BK-059 structured pre-flight pass: walk the entire spec, collect
  // every shape/vocabulary error, return them all at once with zero
  // wire ops. The agent fixes the whole spec in one follow-up call
  // instead of bouncing through "first error throws" recovery.
  //
  // BK-065 + BK-066 phase 1: the preflight walker now also consults
  // the cross-device alias table and runs a four-tier enum tolerance
  // matcher. Successful auto-resolutions land on `info[]` and the
  // walker returns a normalized copy of the spec where alias + case/
  // whitespace substitutions have been collapsed onto the device's
  // canonical vocabulary. The writer downstream sees that normalized
  // spec, not the original, so it stays oblivious to the alias /
  // matcher entirely.
  const preflightStart = Date.now();
  const preflight = collectApplyPresetPreflight(args.spec, descriptor);
  if (preflight.errors.length > 0) {
    return {
      ok: false,
      steps: 0,
      duration_ms: Date.now() - preflightStart,
      validation_errors: preflight.errors,
      device: descriptor.display_name,
    };
  }
  // From here on, the canonical, alias-resolved spec is what we pass
  // downstream. Original `args.spec` is left untouched.
  const normalizedSpec = preflight.normalized_spec;
  // Legacy per-device pre-MIDI validation pass. Catches translation
  // errors the unified-surface walk above doesn't model (e.g. AM4
  // multi-instance rejection). Throws DispatchError on first error;
  // surfaced as a single fallback `validation_errors[]` entry below
  // so the contract stays uniform.
  if (descriptor.writer.validatePreset !== undefined) {
    try {
      descriptor.writer.validatePreset(normalizedSpec, args.target_location);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const fallback: ValidationError = { path: 'spec', error: message };
      return {
        ok: false,
        steps: 0,
        duration_ms: Date.now() - preflightStart,
        validation_errors: [fallback],
        device: descriptor.display_name,
      };
    }
  }
  // BK-071 structural type-knob applicability pre-flight: when a slot
  // specifies both a `type` enum value AND additional knobs, identify
  // any knob the picked type doesn't expose and surface it as a
  // structured `validation_info[]` entry (level: 'warning'). Closes the
  // H1 silent-no-op trap (e.g. reverb.type="Hall, Large" + reverb.time=6)
  // without violating display-first / user-agency. Devices without
  // findCompatibleTypes (II / III / Hydra today) get an empty array;
  // their existing dropped-param warning path remains.
  //
  // T-7 (2026-05-21): in addition to surfacing the warning, the
  // pre-flight now STRIPS the dropped knob from the spec before wire
  // dispatch. Previous behavior wrote the doomed knob on the wire and
  // let the device silently no-op it (wasted 50-300 ms per dropped
  // knob). The type itself is preserved (user agency); only the
  // type-incompatible knob is suppressed. Channel-Y inactive checks
  // and chain verification continue to walk the un-stripped
  // `normalizedSpec` so a full-channel filter doesn't accidentally
  // hide a channel-Y trap or a routing reference.
  const applicability = applyTypeKnobApplicabilityPreflight(normalizedSpec, descriptor);
  const applicabilityWarnings = applicability.warnings;
  const wireSpec = applicability.spec;
  // BK-077: channel-Y inactive pre-flight. Pure spec validation — when
  // a slot specifies channel-nested params but no scene in this spec
  // activates that channel for the block, the data writes but never
  // hits the audio path. Closes the BK-058 silent-failure class at the
  // spec-validation layer (the writer-side fix already preserves Y
  // data; this surfaces the trap before the agent reports false
  // success). Devices without channels/scenes get an empty array.
  const channelInactiveWarnings = collectChannelYInactiveWarnings(normalizedSpec, descriptor);
  // Safe-edit contract for target_location:
  //   - The buffer-dirty gate ALWAYS runs (target_location implies the
  //     active location is about to change, so unsaved edits would be
  //     lost without the gate).
  //   - The save step requires explicit save_authorized=true. Without
  //     it, the executor runs switch + apply only ("audition at
  //     target" — working buffer holds the new build at the target
  //     location; reversible by switching presets).
  //
  // Working-buffer-only mode (no target_location) skips both gates:
  // no navigation, no save, the user's audition stays at the current
  // active location.
  const ctx = openCtx(descriptor);
  if (args.target_location !== undefined && descriptor.writer.guardActiveBufferOrSave) {
    const mode = args.on_active_preset_edited ?? 'warn';
    const guard = await descriptor.writer.guardActiveBufferOrSave(ctx, mode);
    if (!guard.proceed) {
      throw new DispatchError(
        'buffer_dirty',
        descriptor.display_name,
        guard.warningText ?? 'Navigation refused: active buffer has unsaved edits.',
      );
    }
  }
  const options = args.target_location !== undefined
    ? { save: args.save_authorized === true }
    : undefined;
  // wireSpec === normalizedSpec when no knobs were stripped (common
  // case); otherwise it's a deep-copy with dropped knobs removed per
  // T-7. The writer never sees the suppressed knobs.
  const result = await descriptor.writer.applyPreset(ctx, wireSpec, args.target_location, options);
  // BK-075: apply_preset can change which blocks are placed in the
  // working buffer; cached layout snapshot is now stale regardless of
  // target_location. Invalidate so the next set_param re-reads.
  invalidateBlockLayoutCache(descriptor.id);
  // Surface any BK-065 alias substitutions + BK-066 case/whitespace
  // resolutions on the success path so the agent learns the canonical
  // vocabulary. BK-071: also includes type-knob applicability warnings
  // for dropped params. Omit the field entirely when nothing was
  // resolved/dropped so the happy-path response stays unchanged.
  const combinedInfo: ValidationInfo[] = [
    ...preflight.info,
    ...applicabilityWarnings,
    ...channelInactiveWarnings,
  ];
  const validation_info = combinedInfo.length > 0 ? combinedInfo : undefined;

  // BK-057: optional read-after-write chain integrity check. Only runs
  // when the caller opted in (verify_chain: true) AND the apply itself
  // succeeded; a failed apply doesn't have anything to verify.
  let chain_integrity = undefined as ApplyResult['chain_integrity'];
  if (args.verify_chain === true && result.ok) {
    if (descriptor.writer.verifyChain !== undefined) {
      chain_integrity = await descriptor.writer.verifyChain(ctx, normalizedSpec);
    } else {
      chain_integrity = {
        ok: true,
        breaks: [],
        summary: `verify_chain: not applicable on ${descriptor.display_name} (no chain-routing semantics).`,
        extra_round_trips: 0,
      };
    }
  }

  return {
    ...result,
    ...(validation_info !== undefined ? { validation_info } : {}),
    ...(chain_integrity !== undefined ? { chain_integrity } : {}),
    device: descriptor.display_name,
  };
}

/**
 * Full lifecycle for `apply_setlist`. Iterates apply_preset across N
 * entries with up-front validation. Returns a structured per-entry
 * result envelope so callers can summarize partial-success batches.
 */
export async function executeApplySetlist(args: {
  port: string;
  entries: readonly SetlistEntrySpec[];
  options?: SetlistApplyOptions;
  on_active_preset_edited?: 'warn' | 'discard' | 'save_active_first';
}): Promise<ApplySetlistResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  if (descriptor.writer.applySetlist === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `apply_setlist is not implemented for ${descriptor.display_name}.`,
    );
  }
  if (!descriptor.capabilities.supports_save) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `apply_setlist requires a device that supports save; ${descriptor.display_name} does not.`,
    );
  }
  if (args.entries.length === 0) {
    throw new DispatchError(
      'value_out_of_range',
      descriptor.display_name,
      `apply_setlist requires at least one entry.`,
    );
  }
  const ctx = openCtx(descriptor);
  // Multi-preset intent implies save authorization, but the dirty
  // gate still applies — discarding the active buffer's unsaved
  // edits is a separate concern from "the user asked to save N
  // new presets." Per docs/SAFE-EDIT-WORKFLOW.md scenario 5.
  if (descriptor.writer.guardActiveBufferOrSave) {
    const mode = args.on_active_preset_edited ?? 'warn';
    const guard = await descriptor.writer.guardActiveBufferOrSave(ctx, mode);
    if (!guard.proceed) {
      throw new DispatchError(
        'buffer_dirty',
        descriptor.display_name,
        guard.warningText ?? 'Setlist refused: active buffer has unsaved edits.',
      );
    }
  }
  const result = await descriptor.writer.applySetlist(ctx, args.entries, args.options);
  // BK-075: setlist iterated applies; cached layout reflects whatever
  // state the LAST applied entry left behind. Safest is invalidate.
  invalidateBlockLayoutCache(descriptor.id);
  return { ...result, device: descriptor.display_name };
}

/**
 * BK-067 result envelope. Wraps the pure translator's output and adds
 * the apply-side fields when the dispatcher actually fires the
 * translated spec at the target device.
 */
export interface PortPresetResult extends TranslatePresetResult {
  /** Source device's display name. */
  source_device: string;
  /** Target device's display name. */
  target_device: string;
  /**
   * Present when the dispatcher applied the translated spec to the
   * target device. Carries the same envelope `executeApplyPreset`
   * returns (ok, steps, duration_ms, validation_info, ...).
   */
  apply_result?: ApplyResult & { device: string };
  /**
   * True when the dispatcher returned BEFORE firing any apply wire op.
   * Set by the `dry_run: true` flag or when `target_location` is
   * omitted (translator-only mode).
   */
  dry_run: boolean;
}

/**
 * BK-067 cross-device tone porting. Translates a `PresetSpec` from one
 * device's vocabulary to another (via `translatePresetSpec`) and,
 * optionally, applies it to the target device by handing the
 * translated spec to `executeApplyPreset`.
 *
 * Three modes (mirrors `apply_preset`'s gating):
 *
 *   1. `dry_run: true` OR no `target_location` → translator-only.
 *      Returns the translated spec + summary + warnings. No wire ops
 *      on either device.
 *   2. `target_location` without `save_authorized: true` → audition
 *      at target. Translator runs, then `executeApplyPreset` runs
 *      with `save_authorized: false` (navigate + apply, no save).
 *      Reversible by switching presets on the target device.
 *   3. `target_location` with `save_authorized: true` → translate +
 *      apply + save. Destructive. Use only when the user used
 *      explicit save-language.
 *
 * The source device is not touched. The translator is pure (no I/O),
 * so callers can use this in dry-run mode without any device
 * connected.
 *
 * v1 limitation: this tool does NOT read the source preset from the
 * source device. The caller supplies the `source_spec` directly.
 * v2 (HW-118, post-MVP) layers a device-read on top so the caller
 * can ask for `source_location: 'M03'` and the dispatcher handles the
 * source-side dump. For now, agents should construct the source spec
 * via the existing read tools (`get_block_layout`, `get_param`,
 * `get_params`) before calling `port_preset`.
 */
export async function executePortPreset(args: {
  source_port: string;
  source_spec: PresetSpec;
  target_port: string;
  target_location?: string | number;
  dry_run?: boolean;
  save_authorized?: boolean;
  on_active_preset_edited?: 'warn' | 'discard' | 'save_active_first';
}): Promise<PortPresetResult> {
  const sourceDescriptor = requireDevice(args.source_port);
  const targetDescriptor = requireDevice(args.target_port);
  // Same-device port_preset is a no-op route. Surface as a soft error
  // so callers don't accidentally use this tool when they meant apply_preset.
  if (sourceDescriptor.id === targetDescriptor.id) {
    throw new DispatchError(
      'value_out_of_range',
      sourceDescriptor.display_name,
      `port_preset source and target are the same device (${sourceDescriptor.display_name}). Use apply_preset instead.`,
    );
  }

  const translation = translatePresetSpec(
    sourceDescriptor,
    args.source_spec,
    targetDescriptor,
  );

  // Translator-only modes: no apply, just return the translated spec.
  const translatorOnly =
    args.dry_run === true || args.target_location === undefined;
  if (translatorOnly || !translation.ok) {
    return {
      ...translation,
      source_device: sourceDescriptor.display_name,
      target_device: targetDescriptor.display_name,
      dry_run: true,
    };
  }

  // Apply path: hand the translated spec to executeApplyPreset, which
  // re-runs preflight on the target descriptor (catches any gap the
  // translator couldn't bridge — unknown blocks, unmappable enums) and
  // enforces the safe-edit gates the same as direct apply_preset.
  const applyResult = await executeApplyPreset({
    port: args.target_port,
    spec: translation.applied_spec,
    target_location: args.target_location,
    save_authorized: args.save_authorized,
    on_active_preset_edited: args.on_active_preset_edited,
  });

  return {
    ...translation,
    source_device: sourceDescriptor.display_name,
    target_device: targetDescriptor.display_name,
    apply_result: applyResult,
    dry_run: false,
  };
}

/**
 * Full lifecycle for `restore_defaults`. Two shapes — single location or
 * inclusive range — picked by `to`. Devices without a factory bank
 * (descriptor.capabilities.supports_factory_restore=false) reject.
 */
export async function executeRestoreDefaults(args: {
  port: string;
  from: string | number;
  to?: string | number;
  on_error?: 'stop' | 'continue';
  dry_run?: boolean;
  verify?: boolean;
}): Promise<(RestoreDefaultsResult | RestoreDefaultsRangeResult) & { device: string; shape: 'single' | 'range' }> {
  const descriptor = requireDevice(args.port);
  if (!descriptor.capabilities.supports_factory_restore) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `${descriptor.display_name} does not expose a factory-restore capability.`,
    );
  }
  const ctx = openCtx(descriptor);
  if (args.to === undefined || args.to === args.from) {
    if (descriptor.writer.restoreDefaults === undefined) {
      throw new DispatchError(
        'capability_not_supported',
        descriptor.display_name,
        `restore_defaults (single) not implemented for ${descriptor.display_name}.`,
      );
    }
    const result = await descriptor.writer.restoreDefaults(ctx, args.from, { verify: args.verify });
    // BK-075: factory restore overwrites the location; if the user is
    // currently sitting at it the working buffer reflects the factory
    // preset (different blocks). Invalidate cache.
    invalidateBlockLayoutCache(descriptor.id);
    return { ...result, device: descriptor.display_name, shape: 'single' };
  }
  if (descriptor.writer.restoreDefaultsRange === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `restore_defaults (range) not implemented for ${descriptor.display_name}.`,
    );
  }
  const opts: RestoreDefaultsRangeOptions = {
    on_error: args.on_error,
    dry_run: args.dry_run,
    verify: args.verify,
  };
  const result = await descriptor.writer.restoreDefaultsRange(ctx, args.from, args.to, opts);
  invalidateBlockLayoutCache(descriptor.id);
  return { ...result, device: descriptor.display_name, shape: 'range' };
}
