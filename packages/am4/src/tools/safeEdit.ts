/**
 * AM4 safe-edit guard — pre-navigation dirty check.
 *
 * Source of truth (preferred): the DEVICE-TRUE "edited" bit, read via a
 * GET_PATCH descriptor read (`readActiveBufferEditedBit` — `byte[21] & 0x04`).
 * Confirmed on hardware 2026-06-03: it holds 0x00 at rest, flips to 0x04 on
 * any working-buffer edit (ours, front-panel, or AM4-Edit), and returns to
 * 0x00 on save. This catches out-of-band front-panel / parallel-editor edits
 * that the in-memory tracker is blind to (the AM4 emits no push on those,
 * HW-107), and it correctly reads clean after a front-panel save.
 *
 * Fallback: the deterministic in-memory `isDirty(AM4_DIRTY_LABEL)` flag from
 * the shared `bufferDirty` tracker, used only when the device read fails
 * (timeout / device busy). `markDirty` fires at every AM4 edit-class write
 * call site (writer.ts / applyExecutor.ts / presetRestore.ts); `markClean`
 * fires on save / switch. It reliably reflects OUR edits.
 *
 * Why not the working-buffer fingerprint poll this replaced: the AM4 dump is
 * non-deterministic (~20% byte drift on a zero-mutation re-dump, warm-pair
 * capture 2026-05-28), so a hash comparison both fails-open and false-refuses.
 * A real v0.1.0 user hit the false refusal — `apply_preset` to a location
 * refused for "unsaved edits" immediately after a clean `save_preset` to it.
 * The single device-true bit is deterministic and unit-testable; the
 * in-memory flag backstops it.
 *
 * Modes (cross-device contract, see `docs/SAFE-EDIT-WORKFLOW.md`):
 *   - `'warn'` (default) — dirty → refuse with a structured warning.
 *   - `'discard'` — caller opted in to losing edits; proceed without touching
 *     the flag or the connection.
 *   - `'save_active_first'` — dirty → save the working buffer to the active
 *     location (ack-gated), `markClean`, then proceed.
 */

import { AM4_LABEL } from '@mcp-midi-control/core/server-shared/connections.js';
import { isDirty, markClean, msSinceMarkedDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';
import type { DirtyGuardResult, OnEditedMode } from '@mcp-midi-control/core/server-shared/safeEdit.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { formatLocationDisplay, buildSaveToLocation, isCommandAck } from 'fractal-midi/am4';
import { sendReadAndParse, readPresetName, readActiveBufferEditedBit } from '../shared/readOps.js';
import { sendAndAwaitAck } from '../shared/wireOps.js';

export const AM4_DIRTY_LABEL = AM4_LABEL;

/**
 * Is the AM4 working buffer dirty? Prefers the DEVICE-TRUE "edited" bit
 * (GET_PATCH byte[21] & 0x04) — confirmed on hardware 2026-06-03 — which
 * catches front-panel / AM4-Edit edits that the in-memory `markDirty`
 * tracker cannot see (the AM4 emits no push on out-of-band edits, HW-107).
 * It also clears correctly on a front-panel save, where `markDirty` would
 * stay stuck true and cause a false refusal.
 *
 * Falls back to the in-memory `isDirty` flag only if the read fails
 * (timeout / device busy) — that flag reliably reflects OUR edits even
 * when the device read doesn't land.
 */
/**
 * Propagation-race guard window: if OUR in-memory tracker was marked
 * dirty within this many ms and the device-true edited bit reads clean,
 * trust the tracker. The device bit can lag our own just-sent write by
 * a beat (caught live 2026-07-10: audition-then-switch slipped the gate
 * because the bit read landed before the device set it). A human cannot
 * front-panel-save within 2s of our write landing, which is the only
 * legitimate way the bit clears while our flag is still set, so inside
 * the window the tracker is the truer signal. Outside it, the device
 * bit stays authoritative (it sees front-panel edits and saves).
 */
const DIRTY_MARK_TRUST_WINDOW_MS = 2000;

async function isActiveBufferDirty(conn: MidiConnection): Promise<boolean> {
  try {
    const deviceBit = await readActiveBufferEditedBit(conn);
    if (deviceBit) return true;
    const sinceMark = msSinceMarkedDirty(AM4_DIRTY_LABEL);
    return isDirty(AM4_DIRTY_LABEL)
      && sinceMark !== undefined
      && sinceMark < DIRTY_MARK_TRUST_WINDOW_MS;
  } catch {
    return isDirty(AM4_DIRTY_LABEL);
  }
}

const LOCATION_STATE_PID_LOW = 0x00ce;
const LOCATION_STATE_PID_HIGH = 0x000a;

/**
 * Pre-navigation dirty check + optional save-first behavior for AM4.
 *
 * Consults the deterministic in-memory dirty flag (`isDirty`), set by
 * `markDirty` at AM4 write call sites and cleared by `markClean` on
 * save/switch. Mirrors `guardActiveBufferOrSave` from Axe-Fx II /
 * fractal-gen3, but uses AM4's location-code naming (A01–Z04) and
 * READ_PRESET_NAME for the warning text.
 *
 * - Clean buffer → `proceed: true` regardless of mode.
 * - Dirty + `mode='warn'` (default) → `proceed: false` with warning.
 * - Dirty + `mode='discard'` → `proceed: true`, silent edit loss.
 * - Dirty + `mode='save_active_first'` → save to active location (ack-gated),
 *   then `proceed: true`. If the save doesn't ack, returns `proceed: false`.
 */
export async function guardActiveAM4BufferOrSave(
  conn: MidiConnection,
  mode: OnEditedMode,
): Promise<DirtyGuardResult> {
  // User already opted in to losing edits — never touch the connection.
  if (mode === 'discard') {
    return { proceed: true };
  }

  // Device-true edited bit (GET_PATCH byte[21] & 0x04), preferred over the
  // in-memory flag so front-panel / AM4-Edit edits are caught and a
  // front-panel save is correctly seen as clean. Falls back to the
  // deterministic `isDirty` tracker if the read fails.
  if (!(await isActiveBufferDirty(conn))) {
    return { proceed: true };
  }

  // Dirty. Read the active location only to NAME it (warn) or to TARGET
  // the save (save_active_first). A read failure degrades, it does not
  // block — except save_active_first, which needs a concrete target.
  let activeIndex: number | undefined;
  try {
    const parsed = await sendReadAndParse(conn, LOCATION_STATE_PID_LOW, LOCATION_STATE_PID_HIGH);
    const idx = parsed.asUInt32LE();
    if (idx >= 0 && idx <= 103) activeIndex = idx;
  } catch {
    activeIndex = undefined;
  }

  let activeName: string | undefined;
  if (activeIndex !== undefined) {
    try {
      const nameResp = await readPresetName(conn, activeIndex);
      activeName = nameResp.name?.trim() || undefined;
    } catch {
      activeName = undefined;
    }
  }

  const activeDescriptor =
    activeIndex !== undefined
      ? `location ${formatLocationDisplay(activeIndex)}${activeName ? ` ("${activeName}")` : ''}`
      : 'the active location';

  if (mode === 'warn') {
    return {
      proceed: false,
      warningText:
        `REFUSING TO NAVIGATE: ${activeDescriptor} has unsaved working-buffer edits.\n` +
        `\n` +
        `Navigating away would DISCARD those edits silently. Ask the user how to proceed:\n` +
        `  • "save first" → call this tool again with on_active_preset_edited="save_active_first" ` +
        `(saves the working buffer to ${activeDescriptor}, then navigates).\n` +
        `  • "discard" → call this tool again with on_active_preset_edited="discard" ` +
        `(silently loses the edits).\n` +
        `\n` +
        `If the user wants to save to a DIFFERENT location than ${activeDescriptor}, ` +
        `call save_preset({ port:'am4', location:"<code>" }) directly first, then retry this tool.`,
    };
  }

  // save_active_first — needs a concrete target location.
  if (activeIndex === undefined) {
    return {
      proceed: false,
      warningText:
        `Cannot save_active_first: failed to read the active AM4 location, so there is no ` +
        `target to save the working buffer to. Pass on_active_preset_edited="discard" to ` +
        `proceed without saving, or save to an explicit location with ` +
        `save_preset({ port:'am4', location:"<code>" }) first.`,
    };
  }

  try {
    const locationCode = formatLocationDisplay(activeIndex);
    // AWAIT the ack — save_to_location IS ack-gated on AM4 (isCommandAck,
    // 18-byte command-ack). Only markClean once the device confirms the
    // save landed. (The old "fire-and-forget" assumption was wrong;
    // savePreset() awaits this same ack.)
    const result = await sendAndAwaitAck(conn, buildSaveToLocation(activeIndex), isCommandAck);
    if (!result.acked) {
      return {
        proceed: false,
        warningText:
          `Save to ${activeDescriptor} sent but no ack received. Refusing to navigate ` +
          `(the buffer may still be unsaved). Pass on_active_preset_edited="discard" to ` +
          `proceed without saving, or retry.`,
      };
    }
    markClean(AM4_DIRTY_LABEL);
    return {
      proceed: true,
      savedSlot: locationCode,
      savedDetail: `Saved working buffer to ${activeDescriptor} before navigating.`,
    };
  } catch (err) {
    return {
      proceed: false,
      warningText:
        `Save attempt failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Refusing to navigate. Pass on_active_preset_edited="discard" to proceed without saving.`,
    };
  }
}
