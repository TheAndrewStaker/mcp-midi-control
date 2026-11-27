/**
 * Navigation executors — preset / scene / location moves + bulk scanning.
 *
 * Routes for `switch_preset`, `save_preset`, `switch_scene`, `rename`,
 * and `scan_locations` MCP tools.
 */

import {
  DispatchError,
  type DispatchCtx,
  type RenameTarget,
  type ScannedLocation,
  type WriteResult,
} from '../types.js';

import { invalidateBlockLayoutCache } from './blockLayoutCache.js';
import { assertInstanceSupported, requireDevice, toWirePack, withEndpoint, withHandleRetry } from './core.js';
import { resetModRouteState } from './modRouteState.js';
import { runOverwriteGate } from './overwriteGate.js';

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
  const switchPreset = descriptor.writer.switchPreset;
  if (switchPreset === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `switch_preset is not implemented for ${descriptor.display_name}.`,
    );
  }
  // Phase B: the dirty-gate read and the switch ride one exclusive visit,
  // so nothing lands on the wire between the gate's answer and the move.
  const outcome = await withEndpoint(descriptor, async (ctx) => {
    // NOTE: guardActiveBufferOrSave (below) is intentionally NOT wrapped in
    // Phase A.5's reconnect-and-retry: in 'save_active_first' mode it performs
    // a SAVE itself (multi-step, not a single leaf op), so it stays out of
    // scope this phase alongside apply_preset/apply_setlist — see
    // dispatcher/core.ts's withHandleRetry doc comment.
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
        };
      }
    }
    // Phase A.5: reconnect-and-retry-once on a handle-level fault.
    return withHandleRetry(ctx, (c) => switchPreset(c, args.location));
  }, { opName: 'switch_preset' });
  if ('refused' in outcome && outcome.refused === true) {
    return { ...outcome, device: descriptor.display_name };
  }
  // BK-075: switching to a new preset replaces the working buffer
  // contents entirely; cached layout is now stale.
  invalidateBlockLayoutCache(descriptor.id);
  // The new preset carries its own mod-matrix/macro routes; the per-
  // session slot allocator's view of which slots are free is no longer
  // valid. Clear it so the next set_mod_route on this device starts fresh.
  resetModRouteState(descriptor.id);
  return { ...outcome, device: descriptor.display_name };
}

/**
 * Full lifecycle for `save_preset`. Schema capability gate first
 * (some devices may not expose save).
 */
export async function executeSavePreset(args: {
  port: string;
  location: string | number;
  name?: string;
  confirm_overwrite?: boolean;
  instance?: number;
}): Promise<WriteResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  // `instance` selects which block instance's buffer is saved (Circuit Tracks:
  // 1 = Synth 1, 2 = Synth 2). Reject it on single-instance devices up front,
  // same gate as set_param, so a stray instance arg fails loudly not silently.
  assertInstanceSupported(descriptor, args.instance, 'save_preset');
  // Gate on IMPLEMENTATION presence, not the `supports_save` (= persistence is
  // hardware-VERIFIED) flag. A device that implements writer.savePreset can
  // save; whether persistence is hardware-confirmed is conveyed by the result's
  // beta warning (writer.savePreset surfaces it), per the "ship evidence-backed,
  // mark untested" policy. The store envelope being captured byte-exact (gen-3)
  // is evidence; refusing the explicit, user-invoked save would withhold a
  // working-untested capability. (Auto-save during navigation stays gated on
  // supports_save in the safe-edit guard — silent unverified flash writes are a
  // separate, stricter concern.)
  const savePreset = descriptor.writer.savePreset;
  if (savePreset === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `save_preset is not a concept on ${descriptor.display_name} (no writer.savePreset; ` +
        `its persistence envelope is not wired).`,
    );
  }
  // Phase B: the overwrite pre-check read, the persisting write, and the
  // read-back receipt are one exclusive visit — a concurrent op cannot
  // slip between the gate's answer and the flash write it authorized.
  return withEndpoint(descriptor, (ctx) => savePresetLocked(descriptor, ctx, savePreset, args),
    { opName: 'save_preset' });
}

/** The locked tail of {@link executeSavePreset}: everything that touches the wire. */
async function savePresetLocked(
  descriptor: ReturnType<typeof requireDevice>,
  ctx: DispatchCtx,
  savePreset: NonNullable<ReturnType<typeof requireDevice>['writer']['savePreset']>,
  args: {
    port: string;
    location: string | number;
    name?: string;
    confirm_overwrite?: boolean;
    instance?: number;
  },
): Promise<WriteResult & { device: string }> {
  // ── Overwrite gate (confirmable, never a hard wall) — device-agnostic.
  // Runs only when the device exposes `checkOverwriteTarget`; devices that
  // can't read a stored location's name simply skip it (today's behavior).
  // Refuse ONLY when the target is occupied AND is not the active/edited
  // location AND the caller did not confirm. A read miss degrades (proceed,
  // but flag the unverified overwrite below).
  const gate = await runOverwriteGate(descriptor, ctx, args.location, {
    confirm_overwrite: args.confirm_overwrite,
    gateActiveLocation: false,
  });
  const overwritePrecheckFailed = gate.kind === 'precheck_failed';
  if (gate.kind === 'occupied') {
    return {
      op: 'save_preset',
      target: gate.target_display,
      acked: false,
      warning:
        `REFUSING TO OVERWRITE: ${gate.target_display} already holds "${gate.occupant_name}", ` +
        `and it is not the location you are editing. Saving here would replace that preset. ` +
        `Confirm with the user, then call save_preset again with confirm_overwrite: true to proceed, ` +
        `or pick an empty location.`,
      device: descriptor.display_name,
    };
  }
  if (gate.kind === 'unknown') {
    // The device knows which location is ACTIVE but cannot read whether an
    // arbitrary target is occupied, so no occupant means UNKNOWN, not empty.
    // Refuse rather than save-then-warn, and never imply a check happened.
    return {
      op: 'save_preset',
      target: gate.target_display,
      acked: false,
      warning:
        `REFUSING TO SAVE to ${gate.target_display}: it is not the location you are editing, and ` +
        `${descriptor.display_name} has NO decoded way to read what is stored there, so this server cannot ` +
        `tell you whether that location is empty or holds a preset you would destroy. Nothing was sent. ` +
        `Ask the user to check ${gate.target_display} on the front panel, then call save_preset again with ` +
        `confirm_overwrite: true. Saving back to the location you are currently editing needs no confirmation.`,
      device: descriptor.display_name,
    };
  }

  // Phase A.5: reconnect-and-retry-once on a handle-level fault. The
  // preceding overwrite pre-check and the readSaveSnapshot receipt below are
  // each already best-effort (try/catch, degrade to "could not confirm"), so
  // only the actual persisting write needs the retry here.
  const result: WriteResult = await withHandleRetry(ctx, (c) => savePreset(c, args.location, args.name, args.instance));

  // ── Receipt (device-agnostic): when the save acked and the device exposes
  // `readSaveSnapshot`, attach saved_snapshot + a human read-back line.
  // Best-effort — a read-back failure never un-does a save that landed.
  if (result.acked && descriptor.reader.readSaveSnapshot) {
    try {
      const { snapshot, missing } = await descriptor.reader.readSaveSnapshot(ctx, args.location);
      result.saved_snapshot = snapshot;
      const receiptLine =
        `Saved chain: ${snapshot.block_chain.map((b) => (b === 'none' ? '(empty)' : b)).join(' → ')}` +
        `${snapshot.amp_model ? `; amp: ${snapshot.amp_model}` : ''}` +
        `${snapshot.drive_model ? `; drive: ${snapshot.drive_model}` : ''}` +
        `${snapshot.preset_name ? `; name: "${snapshot.preset_name}"` : ''}.`;
      const missingNote =
        missing.length > 0 ? `Could not confirm ${missing.join(', ')} on read-back (best-effort).` : undefined;
      result.info = [result.info, receiptLine, missingNote].filter((s): s is string => Boolean(s)).join(' ');
    } catch {
      result.info = [
        result.info,
        'Could not read back the saved preset to build a receipt (best-effort; the save itself landed).',
      ].filter((s): s is string => Boolean(s)).join(' ');
    }
  }
  if (overwritePrecheckFailed) {
    result.info = [
      result.info,
      'NOTE: could not pre-check the target for an existing preset before saving (name read failed); ' +
        'confirm with the user that nothing important was overwritten.',
    ].filter((s): s is string => Boolean(s)).join(' ');
  } else if (descriptor.reader.checkOverwriteTarget === undefined && args.confirm_overwrite !== true) {
    // The device exposes no overwrite pre-check (only AM4 does today), so the
    // gate above silently no-op'd. Tell the agent the target was not scanned,
    // rather than letting it assume the AM4 refusal protects every device.
    result.info = [
      result.info,
      `NOTE: ${descriptor.display_name} has no overwrite pre-check, so the target location was not scanned ` +
        'for an existing preset before saving. Confirm with the user that the target was free or intended.',
    ].filter((s): s is string => Boolean(s)).join(' ');
  }

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
  const switchScene = descriptor.writer.switchScene;
  if (switchScene === undefined) {
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
  // Phase B: exclusive per-endpoint visit.
  const result = await withEndpoint(descriptor, (ctx) =>
    // Phase A.5: reconnect-and-retry-once on a handle-level fault.
    withHandleRetry(ctx, (c) => switchScene(c, args.scene)),
  { opName: 'switch_scene' });
  return { ...result, device: descriptor.display_name };
}

/**
 * Full lifecycle for `rename`. Validates target shape against the
 * device's capabilities — scene targets require has_scenes and a valid
 * index.
 */
export async function executeRename(args: { port: string; target: string; name: string }): Promise<WriteResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  const rename = descriptor.writer.rename;
  if (rename === undefined) {
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
  // Phase B: exclusive per-endpoint visit.
  const result = await withEndpoint(descriptor, (ctx) =>
    // Phase A.5: reconnect-and-retry-once on a handle-level fault.
    withHandleRetry(ctx, (c) => rename(c, args.target as RenameTarget, args.name)),
  { opName: 'rename' });
  return { ...result, device: descriptor.display_name };
}

/**
 * Full lifecycle for `scan_locations(port, from, to)`. The reader
 * adapter performs the iteration; this layer just routes.
 */
export async function executeScanLocations(rawArgs: {
  port: string;
  from?: string | number;
  to?: string | number;
  pack?: number;
  on_active_preset_edited?: 'warn' | 'discard' | 'save_active_first';
}): Promise<{
  device: string;
  scanned: readonly ScannedLocation[];
  failed_at?: string;
  failed_reason?: string;
  warning?: string;
  note?: string;
}> {
  const descriptor = requireDevice(rawArgs.port);
  const scanLocations = descriptor.reader.scanLocations;
  if (scanLocations === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `scan_locations is not implemented for ${descriptor.display_name}.`,
    );
  }
  const { args, note } = resolveScanRange(descriptor, rawArgs);
  const result = await executeScanLocationsResolved(descriptor, scanLocations, args);
  return note !== undefined ? { ...result, note: pageNote(descriptor, rawArgs, args, result, note) } : result;
}

/**
 * The default-range note, corrected after the scan: a capped first page that came back SHORT of its
 * page size holds everything there is, so "the rest is ..." would send the agent paging for nothing
 * (dogfood 2026-11-15: an 88-project MPC card was reported as "the first page only").
 */
export function pageNote(
  descriptor: Pick<ReturnType<typeof requireDevice>, 'capabilities'>,
  rawArgs: { from?: string | number; to?: string | number },
  args: { from: string | number; to: string | number },
  result: { scanned: readonly unknown[]; failed_at?: string },
  note: string,
): string {
  const def = descriptor.capabilities.scan_default_range;
  const whole = rawArgs.from === undefined && rawArgs.to === undefined;
  if (!whole || def?.rest === undefined || result.failed_at !== undefined) return note;
  if (typeof args.from !== 'number' || typeof args.to !== 'number') return note;
  const page = args.to - args.from + 1;
  if (result.scanned.length >= page) return note;
  return `No from/to given: scanned ${String(args.from)}..${String(args.to)} and it holds everything: `
    + `${String(result.scanned.length)} entries, no further page.`;
}

/**
 * Fill an omitted `from` / `to` from the descriptor's `scan_default_range`.
 * Pure, exported for the gate. A device with no default (a navigating scanner,
 * or one whose range is not static) refuses with the range to pass instead.
 */
export function resolveScanRange<A extends { from?: string | number; to?: string | number }>(
  descriptor: Pick<ReturnType<typeof requireDevice>, 'display_name' | 'capabilities'>,
  args: A,
): { args: A & { from: string | number; to: string | number }; note?: string } {
  if (args.from !== undefined && args.to !== undefined) {
    return { args: args as A & { from: string | number; to: string | number } };
  }
  const def = descriptor.capabilities.scan_default_range;
  if (def === undefined) {
    const why = descriptor.capabilities.scan_navigates === true
      ? ` It scans by SWITCHING to each preset (discards unsaved edits, ~250 ms each), so it never defaults to its whole range.`
      : '';
    throw new DispatchError(
      'bad_location',
      descriptor.display_name,
      `scan_locations on ${descriptor.display_name} needs an explicit from and to.${why}`,
    );
  }
  const whole = args.from === undefined && args.to === undefined;
  if (!whole && def.rest !== undefined) {
    // The default is a capped first page, so its far end is not the device's
    // last location; pairing it with a caller's other end would scan the wrong
    // span (or a reversed one). Ask for both rather than guess.
    throw new DispatchError(
      'bad_location',
      descriptor.display_name,
      `scan_locations on ${descriptor.display_name}: pass both from and to, or neither. With neither it scans `
      + `${String(def.from)}..${String(def.to)}, and the rest is ${def.rest}.`,
    );
  }
  const from = args.from ?? def.from;
  const to = args.to ?? def.to;
  const note = whole
    ? `No from/to given: scanned ${String(from)}..${String(to)}`
      + (def.rest !== undefined
        ? `, the first page only (a whole-range default would exceed the per-call time or size budget). The rest is ${def.rest}; call again with that from/to.`
        : ', the whole range.')
    : `${args.from === undefined ? 'from' : 'to'} omitted: defaulted to ${String(args.from === undefined ? from : to)}.`;
  return { args: { ...args, from, to }, note };
}

async function executeScanLocationsResolved(
  descriptor: ReturnType<typeof requireDevice>,
  scanLocations: NonNullable<ReturnType<typeof requireDevice>['reader']['scanLocations']>,
  args: {
    port: string;
    from: string | number;
    to: string | number;
    pack?: number;
    on_active_preset_edited?: 'warn' | 'discard' | 'save_active_first';
  },
): Promise<{
  device: string;
  scanned: readonly ScannedLocation[];
  failed_at?: string;
  failed_reason?: string;
  warning?: string;
}> {
  // `pack` (Circuit Tracks) rides on ctx like every other pack-addressed op, so a
  // scan lists the requested pack's directory. assertPackSupported (inside the
  // ctx build) refuses pack>1 on packless devices.
  //
  // Phase B: the dirty-gate read and the whole multi-location sweep are one
  // exclusive visit. The AM4's preset-name responses carry NO location on the
  // wire (correlation is arrival order), so a concurrent read during a sweep
  // could bind a name to the wrong location — the exact defect the arbiter
  // exists to close.
  return withEndpoint(descriptor, (ctx) => scanLocationsLocked(descriptor, ctx, scanLocations, args),
    { pack: toWirePack(args.pack), opName: 'scan_locations' });
}

/** The locked tail of {@link executeScanLocations}: the gate read + the sweep. */
async function scanLocationsLocked(
  descriptor: ReturnType<typeof requireDevice>,
  ctx: DispatchCtx,
  scanLocations: NonNullable<ReturnType<typeof requireDevice>['reader']['scanLocations']>,
  args: {
    port: string;
    from: string | number;
    to: string | number;
    pack?: number;
    on_active_preset_edited?: 'warn' | 'discard' | 'save_active_first';
  },
): Promise<{
  device: string;
  scanned: readonly ScannedLocation[];
  failed_at?: string;
  failed_reason?: string;
  warning?: string;
}> {
  // ── Buffer-dirty gate, for devices whose scan NAVIGATES ────────────
  //
  // On such a device (the Axe-Fx II) a scan sends a switch per slot, so it
  // discards unsaved working-buffer edits exactly as `switch_preset` would,
  // only ~64 times over. `switch_preset` has always consulted this guard and
  // `scan_locations` never did, which produced the 2026-08-03 sequence where
  // an agent warned the user about the destructive effect of its NEXT call
  // while having silently caused it three calls earlier. The device-level
  // restore at the end of the scan puts the preset NUMBER back, which reads
  // like a rollback and is not one: the reload comes from flash.
  //
  // Devices that read a stored name without moving (the AM4) skip this
  // entirely, so the common non-destructive case gains no friction.
  if (descriptor.capabilities.scan_navigates === true && descriptor.writer.guardActiveBufferOrSave) {
    const mode = args.on_active_preset_edited ?? 'warn';
    const guard = await descriptor.writer.guardActiveBufferOrSave(ctx, mode);
    if (!guard.proceed) {
      throw new DispatchError(
        'buffer_dirty',
        descriptor.display_name,
        `${guard.warningText ?? 'The working buffer has unsaved edits.'} `
        + `scan_locations on ${descriptor.display_name} reads each name by SWITCHING to that preset, so it would `
        + `discard those edits before you saw the list, and the preset number it restores afterwards reloads from `
        + `flash rather than bringing them back. Re-call with on_active_preset_edited:'discard' to scan anyway, `
        + `or 'save_active_first' to keep the edits.`,
      );
    }
  }

  // Phase A.5: reconnect-and-retry-once on a handle-level fault. A scan is a
  // bounded batch of independent per-location reads (not a stateful transfer
  // session), so restarting it whole on a fresh handle is safe.
  const result = await withHandleRetry(ctx, (c) => scanLocations(c, args.from, args.to));
  return {
    ...result,
    device: descriptor.display_name,
    ...(descriptor.capabilities.scan_navigates === true
      ? { warning: `${descriptor.display_name} scans by switching to each location. The originally active location was reloaded afterwards, from flash: any unsaved edits it had are gone.` }
      : {}),
  };
}
