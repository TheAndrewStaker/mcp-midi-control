/**
 * The confirmable overwrite gate, shared by every tool that persists the
 * working buffer to a stored location: `save_preset` and `apply_preset`
 * (target_location + save_authorized).
 *
 * Before this module the gate lived inside `save_preset` only, and
 * `apply_preset({target_location, save_authorized: true})` persisted with no
 * occupancy check at all. A 2026-11-25 AM4 hardware run caught it: an apply
 * with save to an occupied, non-active location replaced the stored preset
 * with no refusal, while `save_preset` to the same location refused. One
 * helper, two callers, so the two persist paths cannot drift again.
 *
 * The two callers differ in ONE policy, passed as `gateActiveLocation`:
 *   - save_preset (false): saving back to the location being edited is a
 *     refresh of the user's own edits, so it needs no confirmation.
 *   - apply_preset (true): a fresh build REPLACES the preset, even at the
 *     active location. The stored preset there is not the user's edit, it is
 *     whatever the build is about to destroy, so an occupied active target
 *     is gated too.
 */
import type { DeviceDescriptor, DispatchCtx, LocationRef } from '../types.js';

export type OverwriteGateOutcome =
  /** Target read as free (or confirmed by the caller): proceed. */
  | { kind: 'clear' }
  /** The device has a pre-check but the read failed: proceed, flag the receipt. */
  | { kind: 'precheck_failed' }
  /** The device exposes no pre-check at all: proceed, flag the receipt. */
  | { kind: 'no_precheck' }
  /** The target holds a named preset: refuse until confirm_overwrite. */
  | { kind: 'occupied'; target_display: string; occupant_name: string; is_active_location: boolean }
  /** The device cannot read the target's occupancy: refuse until confirm_overwrite. */
  | { kind: 'unknown'; target_display: string; is_active_location: boolean };

export async function runOverwriteGate(
  descriptor: DeviceDescriptor,
  ctx: DispatchCtx,
  location: LocationRef,
  opts: { confirm_overwrite?: boolean; gateActiveLocation: boolean },
): Promise<OverwriteGateOutcome> {
  if (opts.confirm_overwrite === true) return { kind: 'clear' };
  const check = descriptor.reader.checkOverwriteTarget;
  if (check === undefined) return { kind: 'no_precheck' };
  let target: Awaited<ReturnType<typeof check>>;
  try {
    target = await check.call(descriptor.reader, ctx, location);
  } catch {
    target = undefined;
  }
  if (target === undefined) return { kind: 'precheck_failed' };
  const gated = opts.gateActiveLocation || !target.is_active_location;
  if (!gated) return { kind: 'clear' };
  if (target.occupant_name !== undefined) {
    return {
      kind: 'occupied',
      target_display: target.target_display,
      occupant_name: target.occupant_name,
      is_active_location: target.is_active_location,
    };
  }
  if (target.occupancy_unknown === true) {
    return { kind: 'unknown', target_display: target.target_display, is_active_location: target.is_active_location };
  }
  return { kind: 'clear' };
}
