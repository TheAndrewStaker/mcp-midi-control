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
import { collectApplyPresetErrors } from './preflight.js';

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
  const preflightStart = Date.now();
  const validation_errors = collectApplyPresetErrors(args.spec, descriptor);
  if (validation_errors.length > 0) {
    return {
      ok: false,
      steps: 0,
      duration_ms: Date.now() - preflightStart,
      validation_errors,
      device: descriptor.display_name,
    };
  }
  // Legacy per-device pre-MIDI validation pass. Catches translation
  // errors the unified-surface walk above doesn't model (e.g. AM4
  // multi-instance rejection). Throws DispatchError on first error;
  // surfaced as a single fallback `validation_errors[]` entry below
  // so the contract stays uniform.
  if (descriptor.writer.validatePreset !== undefined) {
    try {
      descriptor.writer.validatePreset(args.spec, args.target_location);
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
  precheckTypeKnobCompatibility(args.spec, descriptor);
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
  const result = await descriptor.writer.applyPreset(ctx, args.spec, args.target_location, options);
  return { ...result, device: descriptor.display_name };
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
