/**
 * Navigation executors — preset / scene / location moves + bulk scanning.
 *
 * Routes for `switch_preset`, `save_preset`, `switch_scene`, `rename`,
 * and `scan_locations` MCP tools.
 */

import {
  DispatchError,
  type RenameTarget,
  type ScannedLocation,
  type WriteResult,
} from '../types.js';

import { invalidateBlockLayoutCache } from './blockLayoutCache.js';
import { openCtx, requireDevice } from './core.js';

/**
 * Full lifecycle for `switch_preset`. Honors the cross-device safe-edit
 * contract: if the active buffer is dirty, the gate refuses (or saves
 * first) per the caller's `on_active_preset_edited` mode. Devices
 * without a dirty signal (Hydrasynth) omit the writer.guardActive...
 * method and the gate is skipped — guidance in describe_device.
 */
export async function executeSwitchPreset(args: {
  port: string;
  location: string | number;
  on_active_preset_edited?: 'warn' | 'discard' | 'save_active_first';
}): Promise<WriteResult & { device: string; warningText?: string; refused?: boolean }> {
  const descriptor = requireDevice(args.port);
  if (descriptor.writer.switchPreset === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `switch_preset is not implemented for ${descriptor.display_name}.`,
    );
  }
  const ctx = openCtx(descriptor);
  if (descriptor.writer.guardActiveBufferOrSave) {
    const mode = args.on_active_preset_edited ?? 'warn';
    const guard = await descriptor.writer.guardActiveBufferOrSave(ctx, mode);
    if (!guard.proceed) {
      return {
        op: 'switch_preset',
        target: String(args.location),
        acked: false,
        refused: true,
        warningText: guard.warningText,
        device: descriptor.display_name,
      };
    }
  }
  const result = await descriptor.writer.switchPreset(ctx, args.location);
  // BK-075: switching to a new preset replaces the working buffer
  // contents entirely; cached layout is now stale.
  invalidateBlockLayoutCache(descriptor.id);
  return { ...result, device: descriptor.display_name };
}

/**
 * Full lifecycle for `save_preset`. Schema capability gate first
 * (some devices may not expose save).
 */
export async function executeSavePreset(args: { port: string; location: string | number; name?: string }): Promise<WriteResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  if (!descriptor.capabilities.supports_save) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `save_preset is not a concept on ${descriptor.display_name}.`,
    );
  }
  if (descriptor.writer.savePreset === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `save_preset is not implemented for ${descriptor.display_name} (descriptor missing writer.savePreset).`,
    );
  }
  const ctx = openCtx(descriptor);
  const result = await descriptor.writer.savePreset(ctx, args.location, args.name);
  // BK-075: save persists the working buffer to a location; layout itself
  // didn't change, but invalidating is the safe call — a subsequent
  // switch_preset back to here would otherwise serve a snapshot keyed by
  // the old active-buffer state.
  invalidateBlockLayoutCache(descriptor.id);
  return { ...result, device: descriptor.display_name };
}

/**
 * Full lifecycle for `switch_scene`. Capability gate: device must have
 * scenes.
 */
export async function executeSwitchScene(args: { port: string; scene: number }): Promise<WriteResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  if (!descriptor.capabilities.has_scenes) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `Scenes are not a concept on ${descriptor.display_name}.`,
    );
  }
  if (descriptor.writer.switchScene === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `switch_scene is not implemented for ${descriptor.display_name}.`,
    );
  }
  const max = descriptor.capabilities.scene_count ?? 0;
  if (!Number.isInteger(args.scene) || args.scene < 1 || args.scene > max) {
    throw new DispatchError(
      'bad_location',
      descriptor.display_name,
      `Scene index ${args.scene} out of range on ${descriptor.display_name} (valid: 1..${max}).`,
    );
  }
  const ctx = openCtx(descriptor);
  const result = await descriptor.writer.switchScene(ctx, args.scene);
  return { ...result, device: descriptor.display_name };
}

/**
 * Full lifecycle for `rename`. Validates target shape against the
 * device's capabilities — scene targets require has_scenes and a valid
 * index.
 */
export async function executeRename(args: { port: string; target: string; name: string }): Promise<WriteResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  if (descriptor.writer.rename === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `rename is not implemented for ${descriptor.display_name}.`,
    );
  }
  if (args.target.startsWith('scene:')) {
    if (!descriptor.capabilities.has_scenes) {
      throw new DispatchError(
        'capability_not_supported',
        descriptor.display_name,
        `rename target 'scene:N' requires a device with scenes; ${descriptor.display_name} has none.`,
      );
    }
    const idx = Number(args.target.slice('scene:'.length));
    const max = descriptor.capabilities.scene_count ?? 0;
    if (!Number.isInteger(idx) || idx < 1 || idx > max) {
      throw new DispatchError(
        'bad_location',
        descriptor.display_name,
        `rename target '${args.target}' out of range on ${descriptor.display_name} (valid: scene:1..scene:${max}).`,
      );
    }
  } else if (args.target !== 'preset') {
    throw new DispatchError(
      'bad_location',
      descriptor.display_name,
      `rename target '${args.target}' is not recognized. Valid: 'preset' or 'scene:N'.`,
    );
  }
  if (args.name.length === 0 || args.name.length > 32) {
    throw new DispatchError(
      'value_out_of_range',
      descriptor.display_name,
      `rename name length ${args.name.length} out of range (must be 1..32).`,
    );
  }
  const ctx = openCtx(descriptor);
  const result = await descriptor.writer.rename(ctx, args.target as RenameTarget, args.name);
  return { ...result, device: descriptor.display_name };
}

/**
 * Full lifecycle for `scan_locations(port, from, to)`. The reader
 * adapter performs the iteration; this layer just routes.
 */
export async function executeScanLocations(args: {
  port: string;
  from: string | number;
  to: string | number;
}): Promise<{ device: string; scanned: readonly ScannedLocation[]; failed_at?: string; failed_reason?: string }> {
  const descriptor = requireDevice(args.port);
  if (descriptor.reader.scanLocations === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `scan_locations is not implemented for ${descriptor.display_name}.`,
    );
  }
  const ctx = openCtx(descriptor);
  const result = await descriptor.reader.scanLocations(ctx, args.from, args.to);
  return { ...result, device: descriptor.display_name };
}
