/**
 * Axe-Fx III tools,shared helpers, MIDI lazy-init, and constants.
 *
 * Mirrors the Axe-Fx II tools/shared.ts pattern: every per-family file
 * under `packages/axe-fx-iii/src/tools/` imports from here. The
 * lazy-MIDI surface (ensureConn / resetAxeFxIIIConnection) is the
 * core utility all the tool handlers reach for.
 *
 * Status: 🟡 community beta. The 5 functional tools registered through
 * this surface (switch_preset, switch_scene, get_preset_name,
 * get_scene_name, status_dump) ride on spec-documented wire envelopes
 * from Fractal's "Axe-Fx III MIDI for Third-Party Devices" v1.4 PDF,
 * but have NOT been hardware-verified end-to-end,no maintainer owns
 * an Axe-Fx III. Tool descriptions surface this caveat to the agent.
 */

import {
  buildQueryPatchName,
  buildStorePreset,
  describeMultipurposeResultCode,
  isMultipurposeResponse,
  isQueryPatchNameResponse,
  parseMultipurposeResponse,
  parseQueryPatchNameResponse,
  resolveEffectId as fmResolveEffectId,
} from 'fractal-midi/axe-fx-iii';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { connectAxeFxIII, type MidiConnection } from '../midi.js';
import { isDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';
import { AXEFX3_LABEL } from '@mcp-midi-control/core/server-shared/connections.js';
import {
  type OnEditedMode as SharedOnEditedMode,
  type DirtyGuardResult as SharedDirtyGuardResult,
  ON_EDITED_SCHEMA as SHARED_ON_EDITED_SCHEMA,
  ON_EDITED_DESCRIPTION as SHARED_ON_EDITED_DESCRIPTION,
} from '@mcp-midi-control/core/server-shared/safeEdit.js';

/**
 * Default response-await window for GET tools. The III responds to
 * function-0x0D / 0x0F / 0x13 GETs in well under 50ms over USB; 800ms
 * is generous enough to cover OS-side scheduling jitter without making
 * the tool feel hung.
 */
export const GET_RESPONSE_TIMEOUT_MS = 800;

/**
 * Caveat appended to SET tool responses (switch_preset, switch_scene).
 * The III's SET semantics for these functions don't generate explicit
 * ack frames on the wire,verification is by audible/visible response
 * on the device.
 */
export const NO_ACK_NOTE = [
  'Note: this tool is fire-and-forget,the Axe-Fx III protocol does not',
  'ack these writes. Verify the change by audible/visible response on the',
  'device (front panel preset / scene readout, audio output).',
].join('\n');

/**
 * Banner appended to every axefx3_* tool result. The III ships as a
 * 🟡 community beta,wire shapes are byte-verified against the v1.4
 * spec + 10 public captures (Session 97), but no III owner has yet
 * confirmed the implementation works end-to-end on real hardware.
 * Every tool response carries this banner until a beta-tester report
 * confirms front-panel-correct behavior. The banner is brief enough
 * not to drown out the actual response.
 */
export const BETA_NOTE = [
  '🟡 axe-fx-iii community beta,wire shape verified against public',
  'captures + v1.4 spec, not yet confirmed against real III hardware.',
  'If the response disagrees with what the front panel shows, please',
  'open an issue with the tool call + JSON response',
  '(see docs/AXEFX3-BETA-TESTING.md).',
].join('\n');

/**
 * T-23 (2026-05-21): prefix every Axe-Fx III tool description's first
 * line so the BETA status is visible BEFORE the substantive prose. The
 * existing BETA_NOTE at the end of each description carries the full
 * explanation, but an agent scanning tools/list top-down may decide to
 * call the tool before reaching the end. The prefix lands in the
 * first ~15 chars the agent reads.
 */
export const BETA_PREFIX = '[III BETA, unverified on hardware] ';

// -- MIDI lazy-init -------------------------------------------------------

let conn: MidiConnection | undefined;
let connError: Error | undefined;

export function ensureConn(): MidiConnection {
  if (conn) return conn;
  if (connError) throw connError;
  try {
    conn = connectAxeFxIII();
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
export function resetAxeFxIIIConnection(): {
  wasConnected: boolean;
  previousError: string | undefined;
} {
  const wasConnected = conn !== undefined;
  const previousError = connError?.message;
  if (conn) {
    try { conn.close(); } catch { /* dead handle */ }
  }
  conn = undefined;
  connError = undefined;
  return { wasConnected, previousError };
}

export function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/**
 * Block-name resolver that rewraps the underlying `fractal-midi` throw as a
 * `DispatchError` so the MCP tool callback's `asError(err)` formats the
 * agent retry hints inline (valid_options_tool, retry_action).
 *
 * Use this everywhere a tool callback resolves a user-supplied block name.
 */
export function resolveBlockOrThrow(blockName: string): number {
  try {
    return fmResolveEffectId(blockName);
  } catch (err) {
    throw new DispatchError(
      'unknown_block',
      'Fractal Axe-Fx III',
      err instanceof Error ? err.message : String(err),
      {
        valid_options_tool: 'axefx3_list_blocks',
        retry_action: 'Call axefx3_list_blocks to see every addressable block, then re-invoke with one verbatim name. Block names like "Reverb 1" / "Drive 2" or 3-letter group codes like "REV" both resolve.',
      },
    );
  }
}

// -- 0x64 MULTIPURPOSE_RESPONSE error-channel listener --------------------

/**
 * Window (in ms) we hold open after a fire-and-forget SET write to catch
 * a `0x64 MULTIPURPOSE_RESPONSE` from the III. The III emits 0x64 within
 * ~30–60 ms over USB when it rejects a frame; 250 ms is generous enough
 * to absorb scheduler jitter without slowing successful writes meaningfully
 * (success path still returns immediately on timeout,the cost is the
 * timeout itself when nothing comes back, which is the common case).
 */
export const ERROR_RESPONSE_TIMEOUT_MS = 250;

export interface MultipurposeErrorReport {
  echoedFn: number;
  resultCode: number;
  /** Human label for known result codes; `undefined` for unknown bytes. */
  description: string | undefined;
  /** Full inbound frame, for diagnostic display. */
  rawBytes: number[];
}

/**
 * Send a SET / fire-and-forget frame and watch for a 0x64
 * MULTIPURPOSE_RESPONSE within `ERROR_RESPONSE_TIMEOUT_MS`. The III only
 * emits 0x64 on rejection; the common (success) path is a timeout, which
 * resolves to `undefined`.
 *
 * IMPORTANT: register the listener BEFORE calling `c.send()` so the
 * response can't race ahead of the listener (matches the same discipline
 * used by `*_get_*` tools).
 */
export async function sendAndWatchForError(
  c: MidiConnection,
  bytes: number[],
): Promise<MultipurposeErrorReport | undefined> {
  const errorPromise = c
    .receiveSysExMatching(isMultipurposeResponse, ERROR_RESPONSE_TIMEOUT_MS)
    .catch(() => undefined as number[] | undefined);
  c.send(bytes);
  const raw = await errorPromise;
  if (!raw) return undefined;
  const { echoedFn, resultCode } = parseMultipurposeResponse(raw);
  return {
    echoedFn,
    resultCode,
    description: describeMultipurposeResultCode(resultCode),
    rawBytes: raw,
  };
}

/**
 * Format a `MultipurposeErrorReport` into the warning string we append
 * to a tool's response text. Keep terse,agents read the whole response.
 */
export function formatMultipurposeError(err: MultipurposeErrorReport): string {
  const fnHex = err.echoedFn.toString(16).padStart(2, '0').toUpperCase();
  const codeHex = err.resultCode.toString(16).padStart(2, '0').toUpperCase();
  const label = err.description ?? `(unknown code)`;
  return [
    `⚠ Device rejected the write,0x64 MULTIPURPOSE_RESPONSE received.`,
    `   echoed_fn=0x${fnHex}, result_code=0x${codeHex} (${label}).`,
    `   Recv (${err.rawBytes.length}B): ${toHex(err.rawBytes)}`,
  ].join('\n');
}

// -- Working-buffer dirty handling ----------------------------------------
//
// Shared by every III tool that navigates away from the active preset
// (apply_preset_at, switch_preset). Mirrors the Axe-Fx II pattern at
// `packages/axe-fx-ii/src/tools/shared.ts:guardActiveBufferOrSave`. Dirty
// classification happens at the connection layer (`packages/axe-fx-iii/
// src/midi.ts:wrapWithDirtyClassification`),STATE_BROADCAST inbound
// frames mark dirty; STORE_PRESET / PC outbound mark clean. See
// `docs/devices/axe-fx-iii/dirty-state-research.md` for evidence.

export const AXEFX3_DIRTY_LABEL = AXEFX3_LABEL;

// Re-export the cross-device safe-edit shapes under III-local names so
// III callers don't import from core directly. The canonical
// definitions live in `core/server-shared/safeEdit.ts`.
export type OnEditedMode = SharedOnEditedMode;
export type DirtyGuardResult = SharedDirtyGuardResult;
export const ON_EDITED_SCHEMA = SHARED_ON_EDITED_SCHEMA;
export const ON_EDITED_DESCRIPTION = SHARED_ON_EDITED_DESCRIPTION;

/**
 * Pre-navigation dirty check + optional save-first behavior.
 *
 *   - `mode='warn'` + dirty: returns proceed=false with a warning naming
 *     the active preset (number + name).
 *   - `mode='discard'` + dirty: returns proceed=true without saving.
 *   - `mode='save_active_first'` + dirty: saves the working buffer to
 *     the currently-active slot via 0x1D STORE_PRESET, then returns
 *     proceed=true. Returns proceed=false if the save is rejected by a
 *     0x64 MULTIPURPOSE_RESPONSE frame.
 *   - Clean buffer: returns proceed=true regardless of mode.
 *
 * 🟡 Beta caveat: the III's 0x1D STORE_PRESET envelope is ported from
 * II and not hardware-confirmed on real III firmware. If the device
 * rejects 0x1D, callers see a structured warning naming the rejection
 * code; they can fall back to save-on-the-device-front-panel.
 */
export async function guardActiveBufferOrSave(
  mode: OnEditedMode,
): Promise<DirtyGuardResult> {
  if (!isDirty(AXEFX3_DIRTY_LABEL)) {
    return { proceed: true };
  }
  if (mode === 'discard') {
    return { proceed: true };
  }
  const c = ensureConn();
  // Read the active preset number + name so the warning text is concrete.
  let presetNumber: number | undefined;
  let presetName: string | undefined;
  try {
    const respPromise = c.receiveSysExMatching(
      isQueryPatchNameResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(buildQueryPatchName('current'));
    const resp = await respPromise;
    const parsed = parseQueryPatchNameResponse(resp);
    presetNumber = parsed.presetNumber;
    presetName = parsed.name.trim() || undefined;
  } catch {
    presetNumber = undefined;
  }
  const activeDescriptor = presetNumber !== undefined
    ? `preset ${presetNumber}${presetName ? ` ("${presetName}")` : ''}`
    : 'the currently active preset';

  if (mode === 'warn') {
    return {
      proceed: false,
      warningText:
        `REFUSING TO NAVIGATE: ${activeDescriptor} has unsaved working-buffer edits ` +
        `on the Axe-Fx III.\n` +
        `\n` +
        `Navigating away would DISCARD those edits silently. Ask the user how to proceed:\n` +
        `  • "save first" → call this tool again with on_active_preset_edited="save_active_first" ` +
        `(saves the working buffer to ${activeDescriptor}, then navigates).\n` +
        `  • "discard"   → call this tool again with on_active_preset_edited="discard" ` +
        `(silently loses the edits).\n` +
        `\n` +
        `If the user wants to save to a DIFFERENT slot than ${activeDescriptor}, ` +
        `call axefx3_save_preset({ slot: <slot> }) directly first, then retry this tool.`,
    };
  }

  // save_active_first
  if (presetNumber === undefined) {
    return {
      proceed: false,
      warningText:
        `Could not read the active preset number,refusing to navigate to avoid losing ` +
        `edits silently. Try axefx3_reconnect_midi, then retry. If the device is in an ` +
        `unusual state, the user can save manually on the front panel before this tool retries.`,
    };
  }
  try {
    const errorPromise = c
      .receiveSysExMatching(isMultipurposeResponse, ERROR_RESPONSE_TIMEOUT_MS)
      .catch(() => undefined as number[] | undefined);
    c.send(buildStorePreset(presetNumber));
    const errorFrame = await errorPromise;
    if (errorFrame) {
      const { resultCode } = parseMultipurposeResponse(errorFrame);
      const label = describeMultipurposeResultCode(resultCode) ?? '(unknown code)';
      return {
        proceed: false,
        warningText:
          `Save failed: III rejected STORE_PRESET to ${activeDescriptor} with ` +
          `result_code=0x${resultCode.toString(16).padStart(2, '0').toUpperCase()} (${label}). ` +
          `Edits NOT saved; refusing to navigate. Pass on_active_preset_edited="discard" ` +
          `if you want to lose them anyway, or save manually on the device front panel.`,
      };
    }
    return {
      proceed: true,
      savedSlot: presetNumber,
      savedDetail: `Saved working buffer to ${activeDescriptor} before navigating ` +
        `(🟡 via the III's II-ported 0x1D STORE_PRESET envelope,confirm by checking ` +
        `the device front panel).`,
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
