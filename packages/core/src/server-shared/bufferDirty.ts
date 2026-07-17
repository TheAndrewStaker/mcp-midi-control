/**
 * Working-buffer dirty-state tracker (per-connection-label).
 *
 * Every Fractal device shares the same behavioral constraint:
 *
 *   - All writes target the device's WORKING BUFFER (the live preset
 *     edit surface). Per-scene writes target only the ACTIVE scene; to
 *     write scene N's state you must switch_scene N first.
 *   - Navigating to a different preset (switch_preset / LOAD_PRESET)
 *     reloads the new preset's stored bytes into the working buffer,
 *     DISCARDING any unsaved edits. There is no "undo."
 *   - Saving (STORE_PRESET / save_to_location) commits the working
 *     buffer to a slot, making subsequent navigation safe.
 *
 * This module tracks, per connection label ('am4', 'axe-fx-ii', etc.),
 * whether the working buffer has unsaved edits since the last clean
 * baseline (preset load or save). Tools that navigate (switch_preset,
 * apply_preset_at, apply_setlist) consult `isDirty(label)` and refuse
 * by default — or offer to save the active preset first — to prevent
 * silent loss of the user's edits.
 *
 * **Source-of-truth model.** Dirty/clean transitions are device-driven
 * where possible:
 *
 *   - **Axe-Fx II `markDirty`** fires when the device emits a
 *     0x74/0x75/0x76 state-broadcast triple. Captures across 6 device
 *     states (Session 68 analysis) prove the device emits these
 *     EXACTLY when the working buffer is edited — by us, AxeEdit, or
 *     the user's front-panel knob turn. Device-authoritative.
 *   - **Axe-Fx II `markClean`** fires when WE issue a
 *     switch_preset (0x3C) or store_preset (0x1D) envelope. The device
 *     doesn't announce its clean transitions, but the operations that
 *     produce them are unambiguous: loading a stored slot or saving
 *     the buffer to a slot.
 *   - **AM4** has no device broadcast (HW-107) and no transport-layer
 *     send classifier, so it fires `markDirty` at its writer /
 *     applyExecutor / presetRestore edit call sites (one per acked
 *     edit-class write) and `markClean` on save / switch. The AM4
 *     working-buffer dump is non-deterministic (~20% byte drift on a
 *     zero-mutation re-dump), so a fingerprint comparison is NOT used —
 *     that approach false-refused a real user immediately after a clean
 *     save (2026-06-03). NOTE: the AM4 *navigation gate* now prefers a
 *     device-true "edited" bit (GET_PATCH `byte[21] & 0x04`, hardware-
 *     confirmed 2026-06-03) over this in-memory flag — that bit DOES see
 *     out-of-band front-panel / AM4-Edit edits and clears on a front-panel
 *     save. This `markDirty`/`isDirty` tracker is the fallback when the
 *     device read fails. See `packages/am4/src/tools/safeEdit.ts` +
 *     `shared/readOps.ts:readActiveBufferEditedBit`.
 *
 * Fail mode: if the user presses SAVE on the device's own front panel
 * (rather than via the agent), we don't see the clean transition. The
 * dirty flag stays true until our next switch_preset / store_preset.
 * That's a false-positive — the agent will warn unnecessarily — which
 * fails safe (toward extra confirmation) rather than dangerously
 * (toward silent edit loss).
 */

const dirtyByLabel = new Map<string, boolean>();
const dirtyMarkedAt = new Map<string, number>();

/**
 * Mark the working buffer for this connection as having unsaved edits.
 * Called automatically by the connection layer when it sees a write-
 * class function byte go out on the wire.
 */
export function markDirty(label: string): void {
  dirtyByLabel.set(label, true);
  dirtyMarkedAt.set(label, Date.now());
}

/**
 * Milliseconds since `markDirty` last fired for this label, or
 * `undefined` if it never has (or was reset). Consumers that prefer a
 * DEVICE-TRUE dirty signal use this to guard the propagation race: a
 * device-side edited bit can lag OUR own just-sent write by a beat, so
 * a device read of "clean" within a short window after markDirty is
 * treated as stale (a human cannot have front-panel-saved milliseconds
 * after our write landed, which is the only legitimate way the device
 * bit clears while our flag is still set). See
 * `packages/am4/src/tools/safeEdit.ts:isActiveBufferDirty`.
 */
export function msSinceMarkedDirty(label: string): number | undefined {
  const at = dirtyMarkedAt.get(label);
  return at === undefined ? undefined : Date.now() - at;
}

/**
 * Mark the working buffer for this connection as clean (matches the
 * stored preset). Called automatically when a switch_preset or
 * save-to-location envelope goes out.
 */
export function markClean(label: string): void {
  dirtyByLabel.set(label, false);
}

/**
 * Return true if the working buffer has unsaved edits we've observed
 * since the last switch_preset / save. Default false (we haven't seen
 * anything yet on this connection).
 */
export function isDirty(label: string): boolean {
  return dirtyByLabel.get(label) ?? false;
}

/**
 * Reset the dirty flag for one connection (or all if no label supplied).
 * Useful when the underlying MIDI handle is reconnected — at that
 * point we've lost track of intermediate state, so the safe default
 * is "assume clean" and let the next write set it.
 */
export function resetDirty(label?: string): void {
  if (label === undefined) {
    dirtyByLabel.clear();
    dirtyMarkedAt.clear();
  } else {
    dirtyByLabel.delete(label);
    dirtyMarkedAt.delete(label);
  }
}
