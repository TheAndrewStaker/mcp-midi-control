/**
 * BK-075 block-layout snapshot cache.
 *
 * The phantom-param pre-flight in `executeSetParam` needs to know which
 * block types are placed in the device's active working buffer. A fresh
 * read costs ~200ms (AM4: 4 slot reads; II: 1 grid read), which is fine
 * once per agent burst but unacceptable per `set_param` when an agent
 * writes 5-15 params in a row.
 *
 * Strategy: in-memory cache keyed by device-id. TTL = 5 seconds (covers
 * typical agent set_param bursts; outside that window the agent is
 * either thinking or done). Writers invalidate explicitly via
 * `invalidateBlockLayoutCache(deviceId)` from set_block / apply_preset /
 * save_preset / switch_preset dispatcher hooks.
 *
 * Connection-identity check (per MCP eng review 2026-05-21): the cache
 * value carries a reference to the `MidiConnection` it was captured
 * against. On cache hit, we verify `ctx.conn === cached.conn`; a
 * reconnect produces a new MidiConnection instance, so the cache misses
 * naturally without an explicit reconnect hook. Prevents serving stale
 * layout if the user swaps hardware mid-session.
 *
 * Weak ordering note: this cache is intentionally NOT thread-safe across
 * concurrent dispatcher calls on the same device. MCP tool calls on a
 * given device serialize at the MIDI handle layer (one outstanding wire
 * round-trip at a time), so a `set_block` write completes before the
 * next `set_param` runs its pre-flight. If concurrency ever lands, this
 * module needs an explicit lock.
 */

import type { BlockLayoutSnapshot, DispatchCtx } from '../types.js';

interface CacheEntry {
  snapshot: BlockLayoutSnapshot;
  capturedAt: number;
  conn: DispatchCtx['conn'];
}

const TTL_MS = 5000;
const cache = new Map<string, CacheEntry>();

/**
 * Return the cached snapshot if it's fresh AND captured against the
 * current MIDI connection; otherwise call `fresher()` and cache the
 * result. Caller provides `deviceId` (typically `descriptor.id`) and
 * the fresh-read closure.
 */
export async function getCachedBlockLayout(
  deviceId: string,
  ctx: DispatchCtx,
  fresher: () => Promise<BlockLayoutSnapshot>,
): Promise<BlockLayoutSnapshot> {
  const now = Date.now();
  const cached = cache.get(deviceId);
  if (
    cached !== undefined &&
    cached.conn === ctx.conn &&
    now - cached.capturedAt < TTL_MS
  ) {
    return cached.snapshot;
  }
  const snapshot = await fresher();
  cache.set(deviceId, { snapshot, capturedAt: now, conn: ctx.conn });
  return snapshot;
}

/**
 * Clear the cached snapshot for a single device. Called by writer
 * hooks (set_block, apply_preset, save_preset, switch_preset) after a
 * successful wire write whose effect could change which blocks are
 * placed.
 */
export function invalidateBlockLayoutCache(deviceId: string): void {
  cache.delete(deviceId);
}

/**
 * Clear ALL cached snapshots. Exported for test setup / teardown.
 * Production code does not call this — use the per-device invalidator.
 */
export function _resetBlockLayoutCacheForTests(): void {
  cache.clear();
}
