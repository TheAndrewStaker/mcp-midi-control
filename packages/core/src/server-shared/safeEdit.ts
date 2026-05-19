/**
 * Shared safe-edit primitives — schema/types used by every device's
 * `*_apply_preset_at` / `*_apply_setlist` / `*_switch_preset` tools.
 *
 * The contract these primitives implement is documented in
 * `docs/SAFE-EDIT-WORKFLOW.md`:
 *
 *   1. Buffer-dirty gate (`on_active_preset_edited`) — navigating
 *      away from an edited working buffer requires explicit
 *      authorization (warn / discard / save_active_first).
 *   2. Save-authorization gate (`save_authorized`) — apply-and-save
 *      tools refuse unless the caller has explicitly authorized the
 *      destructive save.
 *
 * Per-device guard FUNCTIONS live in each device's own module because
 * the warning text references device-specific slot/location naming
 * (AM4 location codes A01–Z04 vs Axe-Fx II preset numbers 1..16384)
 * and the dirty-source-of-truth varies (device-broadcast on Axe-Fx II,
 * code-side classifier on AM4, n/a on Hydrasynth). The SHAPES below
 * are device-agnostic — same parameter name, same enum values, same
 * description, so an agent that learned the pattern on one device
 * recognizes it on every other.
 */

import * as z from 'zod/v4';

// ── on_active_preset_edited ──────────────────────────────────────────

export type OnEditedMode = 'warn' | 'discard' | 'save_active_first';

export const ON_EDITED_SCHEMA = z.enum(['warn', 'discard', 'save_active_first']).optional();

export const ON_EDITED_DESCRIPTION =
  'What to do if the active preset has UNSAVED working-buffer edits ' +
  'when this tool needs to navigate away from it. "warn" (default) ' +
  'refuses to navigate and returns a structured warning; the agent ' +
  'should surface this to the user and ask whether to save first or ' +
  'discard the edits, then call again with on_active_preset_edited set. ' +
  '"discard" navigates immediately and silently throws away the edits. ' +
  '"save_active_first" saves the working buffer to whichever preset is ' +
  'currently loaded BEFORE navigating, preserving the user\'s in-progress ' +
  'edits.';

/**
 * Return value of a per-device guard function. `proceed=true` means the
 * caller may continue with its destructive operation; `proceed=false`
 * means surface `warningText` and stop.
 */
export interface DirtyGuardResult {
  /** Whether the caller may proceed with the navigation. */
  proceed: boolean;
  /** Tool-result text when proceed=false (the warning to surface). */
  warningText?: string;
  /** Human-readable detail for the proceed=true case (after save_active_first). */
  savedDetail?: string;
  /** When proceed=true after save_active_first, the slot the buffer was saved to. */
  savedSlot?: number | string;
}

// ── save_authorized ──────────────────────────────────────────────────

export const SAVE_AUTHORIZED_SCHEMA = z.boolean().optional();

/**
 * Build the canonical description for the `save_authorized` parameter,
 * with the calling device's working-buffer-only tool name interpolated.
 * Using a shared builder means every device gets the same wording — the
 * LLM recognizes the pattern across the whole tool surface.
 *
 * @param workingBufferToolName — the device's `_apply_preset` (no slot)
 *   tool name, e.g. `'am4_apply_preset'`, `'axefx2_apply_preset'`. The
 *   agent is told to use this for audition when save isn't authorized.
 */
export function buildSaveAuthorizedDescription(workingBufferToolName: string): string {
  return (
    'EXPLICIT save authorization. Default false. This tool is DESTRUCTIVE ' +
    '(overwrites the target slot) and requires the user to have used ' +
    `save/store/keep/put-on language about the target. If the user said ` +
    `"build a tone for X" without naming a save action, use ${workingBufferToolName} ` +
    '(working-buffer-only) FIRST so they can audition, then ASK before calling ' +
    'this tool with save_authorized: true. "Build a setlist" / "build presets ' +
    'in slots A/B/C" / "save this as Glassy" all count as authorized; "build ' +
    'a clean tone at slot N" without save/store/keep language does NOT.'
  );
}

/**
 * Canonical refusal text for the save-authorization gate. Per-device
 * callers prepend a one-line header that names the target slot in
 * device-local terms ("slot M03" vs "slot 700") and reference the
 * device's working-buffer-only tool by name.
 *
 * @param targetDescriptor — device-local slot description (e.g. `'slot M03'`, `'slot 700'`).
 * @param applyAtToolName — this tool's own name (e.g. `'am4_apply_preset_at'`).
 * @param workingBufferToolName — the device's `_apply_preset` (no slot) tool name.
 */
export function buildSaveAuthorizationRefusal(opts: {
  targetDescriptor: string;
  applyAtToolName: string;
  workingBufferToolName: string;
}): string {
  const { targetDescriptor, applyAtToolName, workingBufferToolName } = opts;
  return (
    `REFUSING TO SAVE: this tool persists the built preset to ${targetDescriptor}, ` +
    `which overwrites whatever is there. The default policy refuses unless ` +
    `save_authorized: true is explicitly passed.\n` +
    `\n` +
    `If the user said something like "build a clean tone" / "design a tone for X" ` +
    `without naming a save action (save, store, keep, put on, persist to ${targetDescriptor}), ` +
    `the right tool is ${workingBufferToolName} (WORKING-BUFFER-ONLY). Let the ` +
    `user audition the tone first, then ASK "want me to save it to ${targetDescriptor}?" ` +
    `before calling ${applyAtToolName} again with save_authorized: true.\n` +
    `\n` +
    `User phrases that DO authorize saving here: "save this to ${targetDescriptor}", ` +
    `"store as N", "build and save", "put it on N", "keep it at N", or "build a ` +
    `setlist into multiple slots" (multi-preset intent implies save).\n` +
    `\n` +
    `User phrases that DO NOT authorize saving (use ${workingBufferToolName} first): ` +
    `"build a tone for X", "design a clean preset", "make me a Marshall sound", ` +
    `"build a tone at ${targetDescriptor}" (the "at ${targetDescriptor}" names a target ` +
    `but doesn't authorize a save; the user might just want to audition there).`
  );
}
