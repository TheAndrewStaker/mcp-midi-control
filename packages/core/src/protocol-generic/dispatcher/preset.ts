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
  type PresetSpec,
  type RestoreDefaultsRangeOptions,
  type RestoreDefaultsRangeResult,
  type RestoreDefaultsResult,
  type SetlistApplyOptions,
  type SetlistEntrySpec,
  type ValidationError,
} from '../types.js';

import { openCtx, requireDevice } from './core.js';
import { collectApplyPresetPreflight } from './preflight.js';
import { translatePresetSpec, type TranslatePresetResult } from '../port-preset.js';

/**
 * Generic type-knob compatibility precheck for `apply_preset`.
 *
 * When a slot specifies both a `type` enum value AND additional knobs,
 * the active type must expose every listed knob — otherwise the wire
 * writes ack but the knob values silently no-op on the device. The
 * H1 Sunday Morning trace surfaced this: agent set
 * `reverb.type="Hall, Large"` + `reverb.time=6`, the writes acked,
 * the agent reported "decay locked in" — but Hall algorithms are
 * fixed-decay and `time` never applied.
 *
 * This precheck closes the silent-no-op loop by failing fast with a
 * structured `DispatchError(value_out_of_range)` carrying `valid_options`
 * — the subset of type values that DO expose every listed knob. The
 * agent's natural error-recovery picks one from the list and retries.
 *
 * Device must implement `descriptor.findCompatibleTypes` for the
 * precheck to run. Devices without it (Axe-Fx II / III / Hydra today)
 * skip the check; their existing dropped-param warning path remains.
 */
function precheckTypeKnobCompatibility(
  spec: PresetSpec,
  descriptor: DeviceDescriptor,
): void {
  if (descriptor.findCompatibleTypes === undefined) return;
  for (let i = 0; i < spec.slots.length; i++) {
    const slot = spec.slots[i];
    const params = slot.params;
    if (params === undefined || params === null) continue;
    // The PresetSlotSpec.params union allows EITHER a flat record
    // (`{type, knob1, knob2}`) for non-channel blocks OR a channel-
    // nested record (`{A: {type, knob1}, D: {type, knob2}}`) for
    // channel blocks. Walk both shapes uniformly.
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
    for (const { channel, map } of channelMaps) {
      const typeValue = map.type;
      if (typeof typeValue !== 'string') continue;
      const knobNames = Object.keys(map).filter((k) => k !== 'type');
      if (knobNames.length === 0) continue;
      const result = descriptor.findCompatibleTypes({
        block: slot.block_type,
        params: knobNames,
      });
      // applicability_known: false → device has no structured data for
      // this block; we can't make a compatibility claim. Let the write
      // proceed; downstream dropped-param warnings still fire.
      if (!result.applicability_known) continue;
      if (result.compatible_types.includes(typeValue)) continue;
      // Incompatible. Slim valid_options to a reasonable head (the
      // full enum list can be 100+ entries on amp.type).
      const head = result.compatible_types.slice(0, 16);
      const more = result.compatible_types.length > head.length
        ? ` (… ${result.compatible_types.length - head.length} more — call find_compatible_types({block:"${slot.block_type}", params:[${knobNames.map((n) => `"${n}"`).join(', ')}]}) for the full subset)`
        : '';
      const where = channel !== undefined ? ` channel ${channel}` : '';
      throw new DispatchError(
        'value_out_of_range',
        descriptor.display_name,
        `slots[${i}] (${slot.block_type}${where}): type "${typeValue}" doesn't expose all of [${knobNames.join(', ')}] on ${descriptor.display_name}. The write would ack but the listed knobs would silently no-op. Pick a type that exposes every listed knob.`,
        {
          valid_options: [...head, ...(more.length > 0 ? [more.trim()] : [])],
          retry_action: `Call find_compatible_types({block:"${slot.block_type}", params:${JSON.stringify(knobNames)}}) for the canonical list, then re-issue apply_preset with a verbatim choice.`,
        },
      );
    }
  }
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
  // Structural type-knob compatibility precheck: when a slot specifies
  // both a `type` enum value AND additional knobs, ensure the type
  // exposes every listed knob. Catches the H1 silent-no-op trap
  // (e.g. reverb.type="Hall, Large" + reverb.time=6 — Hall is
  // fixed-decay, time silently drops). Device must implement
  // findCompatibleTypes for this to run; devices without it skip the
  // check (no false positives — applicability is unknown).
  precheckTypeKnobCompatibility(normalizedSpec, descriptor);
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
  const result = await descriptor.writer.applyPreset(ctx, normalizedSpec, args.target_location, options);
  // Surface any BK-065 alias substitutions + BK-066 case/whitespace
  // resolutions on the success path so the agent learns the canonical
  // vocabulary. Omit the field entirely when nothing was resolved so
  // the happy-path response stays unchanged for existing consumers.
  const validation_info = preflight.info.length > 0 ? preflight.info : undefined;

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
  return { ...result, device: descriptor.display_name, shape: 'range' };
}
