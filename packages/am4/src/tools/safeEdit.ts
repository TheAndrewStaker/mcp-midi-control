/**
 * AM4 safe-edit guard, pre-navigation dirty check.
 *
 * Single-source-of-truth model: the working-buffer fingerprint cache.
 * Before navigating away from the active preset, dump the working
 * buffer (HW-045) and compare its hash to the last known-clean
 * fingerprint for the active location. Mismatch → refuse / save-first /
 * discard per the caller's `mode`.
 *
 * Why a poll, not a classifier or a broadcast listener:
 *   - AM4 emits zero unsolicited MIDI on front-panel edits (HW-107
 *     closed Session 74). No push signal exists to listen for.
 *   - A code-side classifier ("mark dirty on outbound writes") is
 *     blind to front-panel and parallel-editor edits, so we'd still
 *     need the poll. Maintaining both is redundant complexity for
 *     ~200 ms of saved latency on the classifier-fast-path.
 *   - One round-trip on the navigation seam, the only moment the
 *     dirty answer actually matters, is cheap enough to always run.
 *
 * Cache baselines are refreshed after every clean transition
 * (post-switch, post-save) by `refreshAM4Fingerprint()`. First visit
 * to a location has no baseline; the guard degrades gracefully and
 * proceeds. The post-switch refresh establishes the baseline for
 * the next navigation.
 *
 * Modes (cross-device contract, see `docs/SAFE-EDIT-WORKFLOW.md`):
 *   - `'warn'` (default), dirty → refuse with a structured warning.
 *   - `'discard'`, caller already opted in to losing edits; skip the
 *     poll entirely and proceed.
 *   - `'save_active_first'`, dirty → save the working buffer to the
 *     active location, then proceed.
 */

import { AM4_LABEL } from '@mcp-midi-control/core/server-shared/connections.js';
import type { DirtyGuardResult, OnEditedMode } from '@mcp-midi-control/core/server-shared/safeEdit.js';

import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { formatLocationDisplay } from 'fractal-midi/am4';
import { sendReadAndParse, readPresetName } from '../shared/readOps.js';
import { buildRequestActiveBufferDump, buildSaveToLocation } from 'fractal-midi/am4';
import { receivePresetDumpStream } from '../presetDump.js';
import {
  cacheFingerprint,
  fingerprintDump,
  getCachedFingerprint,
} from '../bufferFingerprint.js';

export const AM4_DIRTY_LABEL = AM4_LABEL;

const LOCATION_STATE_PID_LOW = 0x00ce;
const LOCATION_STATE_PID_HIGH = 0x000a;

const BUFFER_DUMP_TIMEOUT_MS = 1500;

/**
 * Capture a fresh fingerprint of the AM4 working buffer and cache it
 * under the given location index. Called after every clean transition
 * (post-save, post-switch) so the next dirty-gate poll has a known-
 * good baseline to compare against.
 *
 * Best-effort: failures are swallowed, the next gate check will see
 * no cache and proceed gracefully rather than block the user's
 * navigation on a non-critical side task.
 */
export async function refreshAM4Fingerprint(
  conn: MidiConnection,
  locationIndex: number,
): Promise<void> {
  try {
    const streamPromise = receivePresetDumpStream(conn, { timeoutMs: BUFFER_DUMP_TIMEOUT_MS });
    conn.send(buildRequestActiveBufferDump());
    const stream = await streamPromise;
    const hash = fingerprintDump(stream.chunkBytes);
    cacheFingerprint(locationIndex, hash);
  } catch {
    // Best-effort, see jsdoc.
  }
}

/**
 * Connections we have already attempted to baseline-warm at least once.
 * Tracked via WeakSet so reconnects (forceReconnect) get a fresh warm-up
 * automatically, the old connection's reference dies, the new
 * connection isn't in the set yet.
 */
const warmedConnections = new WeakSet<MidiConnection>();

/**
 * One-shot baseline warm-up. Reads the active location, dumps the
 * working buffer, and caches its hash as the dirty-gate baseline for
 * that location.
 *
 * Closes the "first navigation after server restart silently proceeds"
 * gap. Without warm-up, the cache is empty until the first
 * post-switch refresh runs, so a `set_param` followed by an
 * unflagged `switch_preset` as the first two AM4 calls of a session
 * would lose the edit silently. With warm-up, the baseline is in
 * place before any edit can happen, so the gate refuses correctly.
 *
 * Idempotent on the hot path: a `WeakSet<MidiConnection>` records the
 * first attempt per connection lifetime; subsequent calls return
 * immediately. Cost is one wire read + one buffer dump (~150–200 ms)
 * on the first AM4 tool call per server lifetime, then ~0 ms.
 *
 * Best-effort: failures are swallowed (the gate's existing
 * graceful-degrade path still fires).
 */
export async function warmupAM4BaselineIfNeeded(
  conn: MidiConnection,
): Promise<void> {
  if (warmedConnections.has(conn)) return;
  // Mark attempted up front so a failed warm-up doesn't get retried on
  // every subsequent tool call, the gate's no-baseline branch will
  // still degrade gracefully if this read failed.
  warmedConnections.add(conn);
  try {
    const parsed = await sendReadAndParse(conn, LOCATION_STATE_PID_LOW, LOCATION_STATE_PID_HIGH);
    const idx = parsed.asUInt32LE();
    if (!Number.isInteger(idx) || idx < 0 || idx > 103) return;
    // If a baseline was already cached for this location (e.g. test
    // setup seeded one), respect it, don't overwrite with a fresh
    // read that might capture a different state.
    if (getCachedFingerprint(idx)) return;
    const streamPromise = receivePresetDumpStream(conn, { timeoutMs: BUFFER_DUMP_TIMEOUT_MS });
    conn.send(buildRequestActiveBufferDump());
    const stream = await streamPromise;
    const hash = fingerprintDump(stream.chunkBytes);
    cacheFingerprint(idx, hash);
  } catch {
    // Best-effort, see jsdoc.
  }
}

/**
 * Dump the working buffer and hash it. Used by the dirty gate to
 * compare the current state against the cached clean baseline.
 * Returns undefined on failure so the caller can degrade gracefully.
 */
async function readAM4Fingerprint(conn: MidiConnection): Promise<string | undefined> {
  try {
    const streamPromise = receivePresetDumpStream(conn, { timeoutMs: BUFFER_DUMP_TIMEOUT_MS });
    conn.send(buildRequestActiveBufferDump());
    const stream = await streamPromise;
    return fingerprintDump(stream.chunkBytes);
  } catch {
    return undefined;
  }
}

/**
 * Pre-navigation dirty check + optional save-first behavior for AM4.
 *
 * Mirrors `guardActiveBufferOrSave` from the Axe-Fx II implementation
 * but uses AM4's location-code naming (A01–Z04), AM4's READ_PRESET_NAME
 * wire path for warning text, and the working-buffer fingerprint poll
 * (since AM4 has no device-broadcast dirty signal, HW-107 Session 74).
 *
 * - Clean buffer → `proceed: true` regardless of mode.
 * - Dirty + `mode='warn'` (default) → `proceed: false` with warning.
 * - Dirty + `mode='discard'` → `proceed: true`, silent edit loss.
 * - Dirty + `mode='save_active_first'` → save to active location, then
 *   `proceed: true`. If the save fails, returns `proceed: false`.
 */
export async function guardActiveAM4BufferOrSave(
  conn: MidiConnection,
  mode: OnEditedMode,
): Promise<DirtyGuardResult> {
  // The user already opted in to losing edits, skip the dump
  // round-trip entirely and proceed.
  if (mode === 'discard') {
    return { proceed: true };
  }

  // Read the active location to (a) compare against the cached
  // fingerprint and (b) name the location in any warning text.
  let activeIndex: number | undefined;
  try {
    const parsed = await sendReadAndParse(conn, LOCATION_STATE_PID_LOW, LOCATION_STATE_PID_HIGH);
    const idx = parsed.asUInt32LE();
    if (idx >= 0 && idx <= 103) activeIndex = idx;
  } catch {
    activeIndex = undefined;
  }

  if (activeIndex === undefined) {
    // Can't read the active location → can't compare fingerprints →
    // proceed (degrade gracefully rather than block on a side check).
    return { proceed: true };
  }

  const cached = getCachedFingerprint(activeIndex);
  if (!cached) {
    // First-visit baseline isn't set yet. Skip the comparison; the
    // post-switch cache refresh will establish it for next time.
    return { proceed: true };
  }

  const currentHash = await readAM4Fingerprint(conn);
  if (currentHash === undefined) {
    // Dump failed, proceed rather than block on a non-critical
    // side check.
    return { proceed: true };
  }

  if (currentHash === cached.hash) {
    // Buffer matches the cached clean fingerprint, no edits since
    // the last clean transition.
    return { proceed: true };
  }

  // Hash mismatch → working buffer differs from the cached clean
  // state. Could be: our own writes (set_param, set_block_type,
  // apply_preset audition), front-panel edits, or AM4-Edit running
  // alongside us. Fall through to the warning/save logic.

  let activeName: string | undefined;
  try {
    const nameResp = await readPresetName(conn, activeIndex);
    activeName = nameResp.name?.trim() || undefined;
  } catch {
    activeName = undefined;
  }

  const activeDescriptor = `location ${formatLocationDisplay(activeIndex)}${activeName ? ` ("${activeName}")` : ''}`;

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
        `call am4_save_to_location({ location: "<code>" }) directly first, then retry this tool.`,
    };
  }

  // save_active_first path.
  try {
    // AM4 save_to_location is fire-and-forget (no ack); we send the bytes
    // and assume success. There's no inbound ack to await, the founder
    // verifies by hearing/seeing the change.
    const locationCode = formatLocationDisplay(activeIndex);
    conn.send(buildSaveToLocation(activeIndex));
    // The save persisted the working buffer to flash; the buffer now
    // matches the stored preset. Refresh the cache so the next dirty
    // gate sees a clean baseline.
    await refreshAM4Fingerprint(conn, activeIndex);
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
