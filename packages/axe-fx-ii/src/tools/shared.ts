/**
 * Axe-Fx II tools, shared helpers, MIDI lazy-init, and constants.
 *
 * Every per-family file under src/fractal/axe-fx-ii/tools/ imports from
 * here. The lazy-MIDI surface (ensureConn / resetAxeFxIIConnection)
 * and the param/block resolvers (findParam / findBlock) are the core
 * utilities all the tool handlers reach for.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  AXE_FX_II_BLOCKS,
  BLOCK_BY_ID,
  resolveBlock,
  type AxeFxIIBlock,
} from 'fractal-midi/axe-fx-ii';
import { KNOWN_PARAMS, type AxeFxIIParam } from 'fractal-midi/axe-fx-ii';
import { connectAxeFxII, listAxeFxIIOutputs, type AxeFxIIConnection } from '../midi.js';
import { findParamFuzzy } from 'fractal-midi/axe-fx-ii';
import {
  buildGetPresetName,
  buildGetPresetNumber,
  buildSetPresetName,
  buildStorePreset,
  isGetPresetNameResponse,
  isGetPresetNumberResponse,
  isStorePresetResponse,
  parseGetPresetNameResponse,
  parseGetPresetNumberResponse,
  parseStorePresetResponse,
} from 'fractal-midi/axe-fx-ii';
import { isDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';
import {
  ON_EDITED_DESCRIPTION as SHARED_ON_EDITED_DESCRIPTION,
  ON_EDITED_SCHEMA as SHARED_ON_EDITED_SCHEMA,
  type DirtyGuardResult as SharedDirtyGuardResult,
  type OnEditedMode as SharedOnEditedMode,
} from '@mcp-midi-control/core/server-shared/safeEdit.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

export const AXEFX_DIRTY_LABEL = 'axe-fx-ii';

/**
 * Default response-await window for GET tools. The Axe-Fx II responds
 * to function-0x02 GET in well under 50ms in a healthy USB connection;
 * 800ms is generous enough to cover OS-side scheduling jitter without
 * making the tool feel hung.
 */
export const GET_RESPONSE_TIMEOUT_MS = 800;

// -- MIDI lazy-init -------------------------------------------------------

let conn: AxeFxIIConnection | undefined;
let connError: Error | undefined;

export function ensureConn(): AxeFxIIConnection {
  if (conn) return conn;
  if (connError) throw connError;
  try {
    conn = connectAxeFxII();
    return conn;
  } catch (err) {
    connError = err instanceof Error ? err : new Error(String(err));
    throw connError;
  }
}

/**
 * Drop the cached connection so the next ensureConn() re-attempts the
 * port open. Useful when the user plugs the device in mid-session and
 * the cached "not connected" error keeps masking the now-working port.
 */
export function resetAxeFxIIConnection(): { wasConnected: boolean; previousError: string | undefined } {
  const wasConnected = conn !== undefined;
  const previousError = connError?.message;
  if (conn) {
    try { conn.close(); } catch { /* dead handle */ }
  }
  conn = undefined;
  connError = undefined;
  return { wasConnected, previousError };
}

// -- Helpers --------------------------------------------------------------

/**
 * Terse caveat appended to SET tool responses only, writes on the
 * Axe-Fx II don't ack on the wire (the protocol is fire-and-forget for
 * SET_BLOCK_PARAMETER_VALUE), so the only verification path is the user
 * hearing or seeing the change on the device. NOT appended to GET tool
 * responses (the response itself IS the verification, a successful
 * decode of a 40-byte name frame proves the read works) nor to pure
 * data tools like list_block_types / list_params.
 *
 * Hardware-verification status across the axefx2_* surface is tracked
 * in HARDWARE-TASKS-AXEFX2.md, not here. Earlier versions of this
 * banner included a longer "🟡 wiki-documented" hedge appended to
 * every response, that made the tool look unreliable when reads were
 * actually self-verifying. See Session 56 commit `<TBD>` for context.
 */
export const NO_ACK_NOTE = 'Note: SET tools on Axe-Fx II are fire-and-forget; the protocol does not ack writes. Verify the change by audible/visible response on the device.';

/**
 * Resolve a param descriptor from a block instance + snake-case name.
 *
 * The registry is keyed `<block-slug>.<param-name>` (e.g. `volpan.volume`,
 * `compressor.ratio`) but the agent addresses blocks by group code
 * (`VOL`, `CPR`) or display name (`Volume/Pan 1`). We resolve by
 * matching (groupCode, name) against the registry, that way both
 * `axefx2_list_params` (which filters by groupCode + slug) and
 * `axefx2_get_param` / `axefx2_set_param` (this resolver) see the
 * same set of valid names.
 *
 * Historically there was a `paramKey(group, name)` that built
 * `<group>.<name>` and looked it up directly, but it broke any
 * block where the groupCode (3-letter) differs from the block slug,
 * e.g. VOL/volpan, CPR/compressor, CHO/chorus, DLY/delay, REV/reverb.
 */
export function findParam(target: AxeFxIIBlock, name: string): AxeFxIIParam | undefined {
  return findParamFuzzy(target, name);
}

export function findBlock(input: string | number): AxeFxIIBlock {
  const resolved = resolveBlock(input);
  if (!resolved) {
    const sampleNames = AXE_FX_II_BLOCKS.slice(0, 8).map((b) => b.name);
    throw new DispatchError(
      'unknown_block',
      'Fractal Axe-Fx II',
      `Unknown block "${input}". Pass either an effectId (e.g. 106) or a display name like "Amp 1" / "Reverb 1" / "Delay 1".`,
      {
        valid_options: sampleNames,
        valid_options_tool: 'axefx2_list_block_types',
        retry_action: 'Re-invoke with one verbatim name from the valid_options list or call axefx2_list_block_types for the complete catalog.',
      },
    );
  }
  return resolved;
}

export function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

// ── Working-buffer dirty handling ─────────────────────────────────────
//
// Shared by axefx2_switch_preset / axefx2_apply_preset_at /
// axefx2_apply_setlist. Every Fractal device (II/III/AM4) has the same
// constraint: writes target the working buffer, navigation discards
// unsaved edits. Before any tool navigates away from the active preset,
// it consults `isDirty('axe-fx-ii')` and respects the caller's
// `on_active_preset_edited` mode.

// Re-exported from the cross-device shared safe-edit module so the
// Axe-Fx II callers don't change their import path, but the canonical
// definition lives in one place. AM4 and Hydrasynth import from the
// shared module directly.
export type OnEditedMode = SharedOnEditedMode;
export const ON_EDITED_DESCRIPTION = SHARED_ON_EDITED_DESCRIPTION;
export type DirtyGuardResult = SharedDirtyGuardResult;

/**
 * Pre-navigation dirty check + optional save-first behavior.
 *
 * - `mode='warn'` + dirty: returns proceed=false with a warning text the
 *   tool should bubble up unchanged. Includes the active preset's name
 *   so the agent can describe what would be lost.
 * - `mode='discard'` + dirty: returns proceed=true without saving.
 * - `mode='save_active_first'` + dirty: saves working buffer to the
 *   currently-active slot, then returns proceed=true. Returns
 *   proceed=false (with a warning) if the save fails.
 * - Clean buffer: returns proceed=true regardless of mode.
 */
export async function guardActiveBufferOrSave(
  mode: OnEditedMode,
): Promise<DirtyGuardResult> {
  if (!isDirty(AXEFX_DIRTY_LABEL)) {
    return { proceed: true };
  }
  if (mode === 'discard') {
    return { proceed: true };
  }
  const c = ensureConn();
  // Read the active preset's number + name so the warning is concrete.
  let activeWire: number | undefined;
  let activeName: string | undefined;
  try {
    const numP = c.receiveSysExMatching(isGetPresetNumberResponse, GET_RESPONSE_TIMEOUT_MS);
    c.send(buildGetPresetNumber());
    const numResp = await numP;
    activeWire = parseGetPresetNumberResponse(numResp).presetNumber;
  } catch {
    activeWire = undefined;
  }
  try {
    const nameP = c.receiveSysExMatching(isGetPresetNameResponse, GET_RESPONSE_TIMEOUT_MS);
    c.send(buildGetPresetName());
    const nameResp = await nameP;
    activeName = parseGetPresetNameResponse(nameResp).trimEnd() || undefined;
  } catch {
    activeName = undefined;
  }
  const activeDescriptor = activeWire !== undefined
    ? `display slot ${activeWire + 1}${activeName ? ` ("${activeName}")` : ''}`
    : 'the currently active preset';

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
        `If the user wants to save to a DIFFERENT slot than ${activeDescriptor}, ` +
        `call axefx2_save_preset({ slot: <slot> }) directly first, then retry this tool.`,
    };
  }

  // save_active_first path.
  if (activeWire === undefined) {
    return {
      proceed: false,
      warningText:
        `Could not read the active preset number, refusing to navigate to avoid losing edits silently.\n` +
        `Try axefx2_reconnect_midi, then retry. If the device is in an unusual state, ` +
        `the user can save manually on the front panel before this tool retries.`,
    };
  }
  try {
    const storeAck = c.receiveSysExMatching(isStorePresetResponse, GET_RESPONSE_TIMEOUT_MS);
    c.send(buildStorePreset(activeWire));
    const ack = await storeAck;
    const parsed = parseStorePresetResponse(ack);
    if (!parsed.ok) {
      return {
        proceed: false,
        warningText:
          `Save failed: STORE_PRESET to ${activeDescriptor} returned ` +
          `result_code=0x${parsed.resultCode.toString(16)}. Edits NOT saved; refusing to ` +
          `navigate. Pass on_active_preset_edited="discard" if you want to lose them anyway.`,
      };
    }
    return {
      proceed: true,
      savedSlot: activeWire + 1,
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

export const ON_EDITED_SCHEMA = SHARED_ON_EDITED_SCHEMA;
