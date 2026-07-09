/**
 * Tempo-lock advisory.
 *
 * On AM4 / Axe-Fx II a delay or modulation block locks its timing param
 * (`delay.time`, modulation `rate`) to (song tempo × division) whenever
 * its `tempo` enum is set to anything other than NONE. BUG-2 correction
 * (2026-07-04 AM4 hardware session): the absolute write is NOT ignored at
 * the register level — the device STORES it (a read-back returns the value
 * just written), but while `tempo` is synced the timing engine plays the
 * tempo-derived time and the stored ms/Hz is inaudible. It takes effect
 * only if `tempo` is later set to NONE. The tempo-first guidance pushes
 * agents toward the synced state, which makes this silent-no-effect MORE
 * likely, so the dispatcher surfaces it.
 *
 * Two collectors:
 *   - `collectTempoLockCowriteWarnings` — zero new wire reads. Catches a
 *     SINGLE call that sets BOTH the tempo to a non-NONE division AND the
 *     absolute time/rate for the same block (a `set_params` batch or one
 *     `apply_preset` slot). Pure inspection of the writes in hand.
 *   - `collectTempoLockStandaloneWarnings` — reads the block's CURRENT
 *     tempo. Catches the standalone case (writing the time alone while the
 *     tempo was synced on an earlier turn), which the co-write collector
 *     can't see. Costs one wire read per timing-param write, so callers
 *     only invoke it on the timing params.
 *
 * Advisory only: like the phantom-param / routing-mask collectors, the
 * write proceeds and the warning rides `validation_info[]` so the agent
 * self-corrects (set tempo to NONE first) instead of reporting false
 * success.
 */

import type { DeviceDescriptor, DispatchCtx, ValidationInfo } from '../types.js';

/** A single resolved write, in canonical `block` / `name` + display value. */
export interface TempoLockWrite {
  block: string;
  name: string;
  value: number | string;
  /**
   * The channel / instance the write targets, when resolved. The standalone
   * collector forwards these to the live tempo read so it reads the SAME
   * channel/instance as the timing write (delay.time / <mod>.rate are
   * per-channel on AM4 A/B/C/D and per-instance on the II). Absent → the
   * device's currently-active channel is read.
   */
  channel?: string | number;
  instance?: number;
}

/**
 * A tempo enum value counts as "synced" (locking the timing param) when
 * it is anything other than NONE. Tempo enums encode NONE at wire 0 and
 * as the display label "NONE" (AM4 ships it as "NONE " with a trailing
 * space; II as "None"); everything else is a musical division.
 */
function isTempoSynced(value: number | string): boolean {
  if (typeof value === 'number') return value !== 0;
  return value.trim().toLowerCase() !== 'none';
}

/**
 * Inspect a set of resolved writes for the tempo-lock co-write trap and
 * return a `ValidationInfo[]` warning per offending block. Returns an
 * empty array when the descriptor declares no tempo-lock map, or no
 * block in the writes has both its tempo synced and its time/rate set.
 *
 * `pathPrefix` is prepended to the `path` field so apply_preset callers
 * can scope the notice to a slot (e.g. `slots[2].params`); set_params
 * passes none.
 */
export function collectTempoLockCowriteWarnings(
  descriptor: DeviceDescriptor,
  writes: readonly TempoLockWrite[],
  pathPrefix?: string,
): ValidationInfo[] {
  const lockMap = descriptor.tempo_locked_params;
  if (lockMap === undefined) return [];

  // Index the writes by canonical `block.name` path → display value.
  const byPath = new Map<string, number | string>();
  for (const w of writes) {
    byPath.set(`${w.block}.${w.name}`, w.value);
  }

  const out: ValidationInfo[] = [];
  for (const [timePath, tempoPath] of Object.entries(lockMap)) {
    if (!byPath.has(timePath)) continue;
    if (!byPath.has(tempoPath)) continue;
    const tempoValue = byPath.get(tempoPath)!;
    if (!isTempoSynced(tempoValue)) continue;
    const tempoName = tempoPath.split('.').slice(1).join('.');
    const fullPath = pathPrefix !== undefined ? `${pathPrefix}.${timePath.split('.').slice(1).join('.')}` : timePath;
    out.push({
      path: fullPath,
      info:
        `${timePath} was set in the same call as ${tempoPath}="${tempoValue}". ` +
        `On ${descriptor.display_name} a non-NONE tempo locks ${timePath} to the song ` +
        `tempo: the value is STORED but the timing engine plays the tempo-derived time, ` +
        `so the absolute value is inaudible until ${tempoPath} is set to "NONE". ` +
        `Either drop ${timePath} (let the division drive timing), or set ${tempoPath} ` +
        `to "NONE" if you meant the absolute value.`,
      level: 'warning',
      dropped_param: timePath.split('.').slice(1).join('.'),
      reason:
        `${tempoPath} is synced ("${tempoValue}"), which locks ${timePath} to ` +
        `(song tempo × division) on ${descriptor.display_name}; the absolute write to ` +
        `${timePath} is stored in the register but the timing engine ignores it while synced.`,
      retry_action:
        `Keep ${tempoPath}="${tempoValue}" and remove ${timePath} (tempo-synced is the ` +
        `default for rhythmic delays/modulation), OR set ${tempoPath} to "NONE" and ` +
        `re-send ${timePath} to use the absolute value.`,
    });
  }
  return out;
}

/**
 * Standalone tempo-lock advisory: for each timing-param write NOT
 * accompanied by a tempo write in the same call, read the block's CURRENT
 * tempo and warn if it is synced (non-NONE). This catches the case the
 * co-write collector can't — writing `delay.time` alone while `delay.tempo`
 * was synced on an earlier turn (BUG-2, 2026-07-04 AM4 session).
 *
 * Costs one wire read per standalone timing-param write; callers pass only
 * the resolved writes, and this returns empty for any non-timing param, so
 * the read happens exclusively when a timing param is actually being set.
 * Best-effort: a failed tempo read yields no warning (the write proceeds).
 */
export async function collectTempoLockStandaloneWarnings(
  descriptor: DeviceDescriptor,
  ctx: DispatchCtx,
  writes: readonly TempoLockWrite[],
): Promise<ValidationInfo[]> {
  const lockMap = descriptor.tempo_locked_params;
  if (lockMap === undefined) return [];
  const writtenPaths = new Set(writes.map((w) => `${w.block}.${w.name}`));

  const out: ValidationInfo[] = [];
  for (const w of writes) {
    const timePath = `${w.block}.${w.name}`;
    const tempoPath = lockMap[timePath];
    if (tempoPath === undefined) continue;          // not a tempo-locked timing param
    if (writtenPaths.has(tempoPath)) continue;      // co-write case — handled by the sibling collector
    const tempoName = tempoPath.split('.').slice(1).join('.');
    let tempoValue: number | string;
    try {
      // Read the tempo on the SAME channel/instance the timing write targets;
      // undefined channel reads the currently-active channel.
      const read = await descriptor.reader.getParam(ctx, w.block, tempoName, w.channel, w.instance);
      tempoValue = read.display_value;
    } catch {
      continue; // couldn't read the current tempo → stay silent, let the write proceed
    }
    if (!isTempoSynced(tempoValue)) continue;
    out.push({
      path: timePath,
      info:
        `${timePath} was written while ${tempoPath}="${tempoValue}" (read live). ` +
        `On ${descriptor.display_name} a non-NONE tempo locks ${timePath} to the song ` +
        `tempo: the value is STORED (a read-back returns it) but the timing engine plays ` +
        `the tempo-derived time, so the absolute value is inaudible until ${tempoPath} is ` +
        `set to "NONE". Set ${tempoPath} to "NONE" first if you meant the absolute value.`,
      level: 'warning',
      dropped_param: w.name,
      reason:
        `${tempoPath} currently reads "${tempoValue}" (synced), which locks ${timePath} to ` +
        `(song tempo × division) on ${descriptor.display_name}; the write is stored in the ` +
        `register but the timing engine ignores it while synced.`,
      retry_action:
        `Set ${tempoPath} to "NONE" then re-send ${timePath} for the absolute value, OR ` +
        `leave the tempo synced and drop ${timePath} (the division drives timing).`,
    });
  }
  return out;
}
