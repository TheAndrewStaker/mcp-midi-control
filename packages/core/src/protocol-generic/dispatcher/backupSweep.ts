/**
 * Dispatcher, `backup_device` and `list_backups`.
 *
 * The product half of the backup story: `export_preset` already saves ONE
 * thing byte-exactly, but "back up my Circuit before we change anything" is a
 * RANGE, and a range is a different tool because it has a different cost, a
 * different failure model, and a different conversation attached to it.
 *
 * Three properties this file exists to guarantee:
 *
 * 1. **Nothing is destroyed and nothing is written to the device.** A backup
 *    is reads only. Every wire op here is a dump request. The whole file is
 *    read-only against hardware, by construction, there is no writer call in it.
 *
 * 2. **A short read is never saved as a backup.** A dump that fails, or fails
 *    its device CRC, is reported as a failed item and NO file is written for
 *    it. A file named like a backup that does not contain the preset is worse
 *    than no file: it converts "I have no backup" (recoverable, the user
 *    knows) into "I have a corrupt backup" (discovered at restore time).
 *
 * 3. **The user is told the cost BEFORE the wait, not during it.** This server
 *    speaks over stdio with no progress channel, so a 6-minute sweep is 6
 *    minutes of silence in a chat window. The gate is therefore a REFUSAL
 *    carrying the estimate: the first call quotes the job, the agent relays
 *    the quote, the user says yes, the second call carries
 *    `acknowledge_duration: true`. See CLAUDE.md "Performance budget".
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { openCtx, requireDevice, toWirePack, withHandleRetry } from './core.js';
import {
  backupTimestamp,
  defaultBackupDir,
  listBackups,
  LIST_BACKUPS_LIMIT_MAX,
  recordBackup,
  resolveBackupPolicy,
  sanitizeForFilename,
  type ListBackupsOptions,
  type ListedBackup,
  type ResolvedBackupPolicy,
} from './backupIndex.js';
import { DispatchError, type DeviceDescriptor, type DispatchCtx } from '../types.js';

/**
 * Items above which a sweep must be acknowledged. Three is deliberate: it is
 * the largest job that still fits the "< 1 s ... 2-5 wire transactions"
 * acceptable band on the fastest device, so anything bigger is a job the user
 * should have agreed to.
 */
const ACK_ITEM_THRESHOLD = 3;
/** Estimated seconds above which a sweep must be acknowledged (CLAUDE.md budget). */
const ACK_SECONDS_THRESHOLD = 5;
/**
 * Hard ceiling per call. One Circuit pack is 64 projects, so this admits the
 * largest natural whole-device unit and refuses anything that is really two
 * jobs pretending to be one.
 */
const MAX_ITEMS_PER_CALL = 64;
/** Consecutive failures after which we stop: the transport is gone, not the slot. */
const CONSECUTIVE_FAILURE_ABORT = 3;

export interface BackupDeviceArgs {
  port: string;
  /**
   * `'active'` dumps the working buffer (unsaved edits included). `'stored'`
   * sweeps stored locations. Default: `'stored'` when a range is given or the
   * device declares bounds, else `'active'`.
   */
  scope?: 'active' | 'stored';
  /** First stored location, DEVICE numbering. Defaults to the device's declared first. */
  from?: number;
  /** Last stored location, DEVICE numbering. Defaults to the device's declared last. */
  to?: number;
  /** 1-based microSD pack (Circuit Tracks). */
  pack?: number;
  /** Destination folder. Defaults to `mcp-midi-backups` under the user's home. */
  directory?: string;
  /** Set true only after the user agreed to the quoted duration. */
  acknowledge_duration?: boolean;
}

export interface BackupItemResult {
  location?: number | string;
  status: 'saved' | 'empty' | 'failed';
  file_name?: string;
  name?: string;
  byte_length?: number;
  error?: string;
}

export interface BackupDeviceResult {
  ok: boolean;
  device: string;
  unit: string;
  scope: 'active' | 'stored';
  directory: string;
  pack?: number;
  saved: number;
  empty: number;
  failed: number;
  duration_ms: number;
  items: readonly BackupItemResult[];
  restore_with?: string;
  info: string;
  warning?: string;
}

/**
 * Quote a sweep in words a musician can answer yes or no to. Deliberately
 * rounded and deliberately pessimistic: an over-quote that finishes early is
 * fine, an under-quote that runs long is the thing that erodes trust.
 */
function quoteDuration(seconds: number): string {
  if (seconds < 10) return `about ${Math.max(1, Math.round(seconds))} seconds`;
  if (seconds < 90) return `about ${Math.round(seconds / 5) * 5} seconds`;
  const mins = seconds / 60;
  if (mins < 10) return `about ${Math.round(mins * 2) / 2} minutes`;
  return `about ${Math.round(mins)} minutes`;
}

/**
 * Refuse an unacknowledged sweep, with the estimate in the message so the
 * agent has something concrete to put to the user. This is the "requires
 * explicit progress" rule from the performance budget, expressed as a gate
 * rather than as a hope that the agent remembers to warn.
 */
function assertDurationAcknowledged(
  descriptor: DeviceDescriptor,
  policy: ResolvedBackupPolicy,
  count: number,
  acknowledged: boolean,
): void {
  if (acknowledged) return;
  // A SINGLE unit is never gated, however slow the device. `export_preset` has
  // always backed up one location with no handshake at all, and one Circuit
  // project genuinely takes ~6 s there; gating the same work here purely
  // because it arrived through a different tool would make the backup tool the
  // more annoying way to do the identical thing. The gate exists for SWEEPS,
  // where the user cannot see how much they just asked for.
  if (count <= 1) return;
  const seconds = count * policy.seconds_per_unit;
  if (count <= ACK_ITEM_THRESHOLD && seconds <= ACK_SECONDS_THRESHOLD) return;
  throw new DispatchError(
    'duration_acknowledgement_required',
    descriptor.display_name,
    `Backing up ${count} ${policy.unit_label}${count === 1 ? '' : 's'} from ${descriptor.display_name} will take ${quoteDuration(seconds)}, ` +
      `during which this conversation cannot report progress and the device should be left alone. ` +
      `Tell the user how long it will take and what it covers, and re-call with acknowledge_duration: true once they agree. ` +
      `To make it quicker, narrow the range with from/to.`,
    {
      retry_action: 'Relay the duration to the user, then re-call with acknowledge_duration: true.',
    },
  );
}

/** Build the filename. Timestamped and unit-tagged, so a directory listing reads as a history. */
function backupFileName(
  descriptor: DeviceDescriptor,
  policy: ResolvedBackupPolicy,
  opts: { location?: number; pack?: number; name?: string; ext: string },
): string {
  const packTag = opts.pack !== undefined && opts.pack > 1 ? `pack${opts.pack}-` : '';
  const locTag = opts.location !== undefined
    ? `${packTag}${policy.unit_label}${String(opts.location).padStart(2, '0')}`
    : 'buffer';
  return [
    sanitizeForFilename(descriptor.display_name, 'device'),
    locTag,
    sanitizeForFilename(opts.name ?? policy.unit_label, policy.unit_label),
    backupTimestamp(),
  ].join('-') + `.${opts.ext}`;
}

/**
 * Find a free filename, appending `-2`, `-3`, ... before the extension when the
 * preferred name is taken. Bounded so a pathological directory cannot spin.
 */
function uniqueBackupPath(baseDir: string, preferred: string): { fileName: string; filePath: string } {
  const ext = path.extname(preferred);
  const stem = preferred.slice(0, preferred.length - ext.length);
  for (let n = 1; n <= 100; n++) {
    const fileName = n === 1 ? preferred : `${stem}-${n}${ext}`;
    const filePath = path.join(baseDir, fileName);
    if (!existsSync(filePath)) return { fileName, filePath };
  }
  throw new Error(`could not find a free filename for ${preferred} after 100 attempts; the backup directory needs tidying.`);
}

/**
 * Read one unit and write it to disk. Returns the per-item result; a read
 * failure is CAUGHT and reported (a sweep should not lose 40 good backups
 * because location 41 is unreadable), but nothing is written for it.
 */
async function backupOne(
  descriptor: DeviceDescriptor,
  policy: ResolvedBackupPolicy,
  ctx: DispatchCtx,
  baseDir: string,
  location: number | undefined,
  pack: number | undefined,
): Promise<BackupItemResult> {
  try {
    const dump = location === undefined
      ? await descriptor.reader.dumpActivePresetBinary!(ctx)
      : await descriptor.reader.dumpStoredPresetBinary!(location, ctx);
    if (dump.empty === true || dump.bytes.length === 0) {
      return { location, status: 'empty' };
    }
    const fileName0 = backupFileName(descriptor, policy, {
      location,
      pack,
      name: dump.name,
      ext: dump.file_extension ?? 'syx',
    });
    // Never let a backup overwrite a backup. The timestamp is second-resolution,
    // so backing the same location up twice inside one second collides, which
    // is a completely reasonable thing for a user to do, and must not be
    // reported as a failed backup. Disambiguate with a suffix instead of
    // refusing: both copies survive, which is the whole point.
    const { fileName, filePath } = uniqueBackupPath(baseDir, fileName0);
    await writeFile(filePath, Buffer.from(dump.bytes));
    recordBackup(baseDir, {
      file_name: fileName,
      device: descriptor.display_name,
      device_id: descriptor.id,
      unit: location === undefined ? 'active_buffer' : policy.unit_label,
      location,
      pack,
      name: dump.name,
      format: dump.format,
      byte_length: dump.byte_length,
      created_at: new Date().toISOString(),
      tool: 'backup_device',
      restore_with: policy.restore_tool,
    });
    return { location, status: 'saved', file_name: fileName, name: dump.name, byte_length: dump.byte_length };
  } catch (err) {
    return { location, status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

export async function executeBackupDevice(args: BackupDeviceArgs): Promise<BackupDeviceResult> {
  const descriptor = requireDevice(args.port);
  const policy = resolveBackupPolicy(descriptor);

  // Scope default. A bare `backup_device(port)` means "save what I am working
  // on right now", so it resolves to the working buffer wherever one exists:
  // that is the fast, always-safe answer and it captures unsaved edits, which
  // is the state a user is most likely to be in when they think to ask. A
  // stored SWEEP is opted into by naming a range, or is the only option on a
  // device with no working buffer at all (Circuit Tracks).
  const wantsRange = args.from !== undefined || args.to !== undefined;
  const scope: 'active' | 'stored' = args.scope
    ?? (wantsRange ? 'stored'
      : policy.can_dump_active ? 'active'
        : 'stored');

  if (scope === 'active' && !policy.can_dump_active) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `${descriptor.display_name} has no working-buffer dump, so there is no "current edit" to back up. ` +
        (policy.can_dump_stored
          ? `Back up stored ${policy.unit_label}s instead: pass scope: "stored" with from/to.`
          : `This device cannot be backed up through this server at all yet, its stored content has no read path. ` +
            `Use the manufacturer's own backup route until one lands.`),
    );
  }
  if (scope === 'stored' && !policy.can_dump_stored) {
    // The Axe-Fx II is the reason this refusal is worded so specifically: its
    // stored-slot dump request RELOADS the stored preset over the working
    // buffer (hardware-confirmed 2026-06-10), so a well-meaning "back up all
    // my presets" would silently destroy the user's unsaved edit. No tool path
    // uses it, and this one must not become the exception.
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `${descriptor.display_name} cannot dump a STORED ${policy.unit_label} without side effects, so this server will not sweep them. ` +
        (policy.can_dump_active
          ? `On this device the safe backup is the working buffer: call backup_device with scope: "active" (or export_preset with no location) while the ${policy.unit_label} you want is loaded. ` +
            `Back up several by loading each one and exporting it.`
          : `No backup path exists for it through this server yet.`) +
        ` (Reason: reading a stored slot on this device reloads it over the working buffer, discarding unsaved edits, a "backup" that destroys the thing it was protecting.)`,
    );
  }

  const baseDir = args.directory !== undefined && args.directory.trim().length > 0
    ? args.directory.trim()
    : defaultBackupDir();

  const started = Date.now();

  // ── active-buffer scope: exactly one item, always fast, no gate ──
  if (scope === 'active') {
    const ctx = openCtx(descriptor, { pack: toWirePack(args.pack) });
    await mkdir(baseDir, { recursive: true });
    const item = await withHandleRetry(ctx, (c) => backupOne(descriptor, policy, c, baseDir, undefined, args.pack));
    const ok = item.status === 'saved';
    return {
      ok,
      device: descriptor.display_name,
      unit: 'active_buffer',
      scope,
      directory: baseDir,
      saved: ok ? 1 : 0,
      empty: item.status === 'empty' ? 1 : 0,
      failed: item.status === 'failed' ? 1 : 0,
      duration_ms: Date.now() - started,
      items: [item],
      restore_with: policy.restore_tool,
      info: ok
        ? `Backed up the working buffer of ${descriptor.display_name}${item.name ? ` ("${item.name}")` : ''} to ${path.join(baseDir, item.file_name!)}. ` +
          `This includes unsaved edits. ${policy.restore_tool ? `Put it back with ${policy.restore_tool}.` : 'This device has no restore path through this server; reload the file in the manufacturer\'s editor.'}`
        : `Nothing was backed up: ${item.error ?? 'the working buffer read returned nothing'}.`,
    };
  }

  // ── stored scope: resolve the range ──
  const first = args.from ?? policy.bounds?.first;
  const last = args.to ?? policy.bounds?.last;
  if (first === undefined || last === undefined) {
    throw new DispatchError(
      'bad_request',
      descriptor.display_name,
      `backup_device needs an explicit from/to range on ${descriptor.display_name}: it does not declare how many ${policy.unit_label}s it has, ` +
        `and guessing the range would either miss content or hammer the device with reads of locations that do not exist. ` +
        `Pass from/to in the numbering the front panel shows.`,
      { retry_action: `Re-call with from and to (e.g. from: 1, to: 8) to back up a range of ${policy.unit_label}s.` },
    );
  }
  if (!Number.isInteger(first) || !Number.isInteger(last) || last < first) {
    throw new DispatchError('bad_location', descriptor.display_name,
      `backup_device: from/to must be integers with to >= from, got from=${first}, to=${last}.`);
  }
  const count = last - first + 1;
  if (count > MAX_ITEMS_PER_CALL) {
    throw new DispatchError(
      'bad_request',
      descriptor.display_name,
      `backup_device: ${count} ${policy.unit_label}s in one call is more than this tool will do at once (limit ${MAX_ITEMS_PER_CALL}). ` +
        `Split it into runs of ${MAX_ITEMS_PER_CALL} or fewer so each one stays answerable in a conversation.`,
    );
  }
  assertDurationAcknowledged(descriptor, policy, count, args.acknowledge_duration === true);

  const ctx = openCtx(descriptor, { pack: toWirePack(args.pack) });
  await mkdir(baseDir, { recursive: true });

  const items: BackupItemResult[] = [];
  let consecutiveFailures = 0;
  let aborted: string | undefined;
  for (let loc = first; loc <= last; loc++) {
    const item = await backupOne(descriptor, policy, ctx, baseDir, loc, args.pack);
    items.push(item);
    if (item.status === 'failed') {
      consecutiveFailures++;
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_ABORT) {
        // Three in a row is a dead transport, not three bad slots. Stopping
        // keeps the partial result (which is real and useful) and stops us
        // spending minutes producing nothing.
        aborted = `Stopped after ${CONSECUTIVE_FAILURE_ABORT} consecutive read failures at ${policy.unit_label} ${loc}; ` +
          `that pattern means the connection dropped rather than those ${policy.unit_label}s being bad. ` +
          `Everything read before that point IS saved. Try reconnect_midi, then re-run from ${loc}.`;
        break;
      }
    } else {
      consecutiveFailures = 0;
    }
  }

  const saved = items.filter((i) => i.status === 'saved').length;
  const empty = items.filter((i) => i.status === 'empty').length;
  const failed = items.filter((i) => i.status === 'failed').length;
  const packNote = args.pack !== undefined && args.pack > 1 ? ` on Pack ${args.pack}` : '';
  const restoreNote = policy.restore_tool
    ? ` Put any one of them back with ${policy.restore_tool}.`
    : ` This device has no restore path through this server yet, so treat these as archive copies.`;

  return {
    ok: failed === 0,
    device: descriptor.display_name,
    unit: policy.unit_label,
    scope,
    directory: baseDir,
    pack: args.pack,
    saved,
    empty,
    failed,
    duration_ms: Date.now() - started,
    items,
    restore_with: policy.restore_tool,
    info:
      `Backed up ${saved} ${policy.unit_label}${saved === 1 ? '' : 's'} from ${descriptor.display_name}${packNote} to ${baseDir}` +
      (empty > 0 ? `; ${empty} location${empty === 1 ? ' was' : 's were'} empty and skipped` : '') +
      (failed > 0 ? `; ${failed} could not be read and were NOT saved` : '') +
      `.${restoreNote} Find them again any time with list_backups.` +
      (policy.restore_note ? ` ${policy.restore_note}` : ''),
    warning: aborted,
  };
}

export interface ListBackupsResult {
  directory: string;
  count: number;
  total: number;
  backups: readonly ListedBackup[];
  info: string;
  truncated?: {
    returned: number;
    total: number;
    next_offset: number;
    note: string;
  };
}

/**
 * This response's share of the host's 50,000-char delivery cliff. Same
 * 40,000 as `list_params` and `lookup_lineage`, for the same reason: a page
 * boundary here costs one cheap follow-up call, so the 10,000 of headroom is
 * cheap insurance against a host that counts slightly differently.
 *
 * WHY A BUDGET AND NOT JUST A SMALLER `limit` MAX. The schema permitted
 * `limit:500` and the code honoured it literally: it returned exactly as many
 * entries as asked for, however heavy they were, with no ceiling and no
 * truncation marker. Measured at 385 chars per entry, `limit:500` came back
 * at 212,375 chars, so the model received NOTHING; the crossing was at
 * limit=130, well inside what the schema invited. Lowering the max to ~120
 * would have fixed today's number and re-broken the day an entry grew a
 * field, because per-entry cost is not fixed: a `device:"circuit"` filter
 * measured LARGER than the unfiltered call at the same limit (221,739 vs
 * 212,375), the filter having selected the heavier rows. A budget is bound to
 * the thing the host actually counts; a row count is a proxy for it.
 */
const LIST_BACKUPS_BUDGET_CHARS = 40_000;

/** Held back for the `truncated` block, composed after the rows are fitted. */
const LIST_BACKUPS_TRUNCATION_RESERVE = 600;

/**
 * Pure filesystem, no device, no MIDI. Answers "what have we got saved" in a
 * single sub-millisecond call, which is the only reason a user ever trusts
 * that a backup happened.
 */
export function executeListBackups(args: ListBackupsOptions = {}): ListBackupsResult {
  const { directory, backups, total } = listBackups(args);

  // `backups` is already `limit`-capped and sorted newest-first; `offset`
  // walks that same ordering. Both are indexes into the FILTERED list, so a
  // `next_offset` is only valid for the filter that produced it.
  const offset = Math.min(Math.max(0, Math.trunc(args.offset ?? 0)), backups.length);
  const page = backups.slice(offset);

  const envelope = { directory, count: 0, total, backups: [] as ListedBackup[], info: '' };
  let budget = LIST_BACKUPS_BUDGET_CHARS - JSON.stringify(envelope).length - LIST_BACKUPS_TRUNCATION_RESERVE;
  const fitted: ListedBackup[] = [];
  for (const entry of page) {
    const cost = JSON.stringify(entry).length + 1;
    // Always emit one: a single entry over the whole budget is a path-length
    // problem worth seeing, not a reason to answer with silence.
    if (budget - cost < 0 && fitted.length > 0) break;
    budget -= cost;
    fitted.push(entry);
  }

  const unindexed = fitted.filter((b) => b.unindexed).length;
  const info = total === 0
    ? `No backups found in ${directory}. Take one with backup_device (a range of presets/projects) or export_preset (a single one).`
    : `${total} backup${total === 1 ? '' : 's'} in ${directory}${fitted.length < total ? `, showing ${fitted.length} of them` : ''}.` +
      (unindexed > 0
        ? ` ${unindexed} of them predate the backup index (or were added by hand), so only their filename, size and date are known.`
        : '');

  const result: ListBackupsResult = { directory, count: fitted.length, total, backups: fitted, info };

  if (fitted.length === 0 && backups.length > 0) {
    result.truncated = {
      returned: 0,
      total,
      next_offset: 0,
      note:
        `No entries: offset ${offset} is past the last of the ${backups.length} this filter selected. `
        + 'Re-read from offset:0, or drop `offset`. A `truncated.next_offset` is only valid for the SAME '
        + 'filter and `limit` that produced it; changing `device`, `unit` or `include_missing` renumbers the rows.',
    };
    return result;
  }

  const consumedTo = offset + fitted.length;
  if (consumedTo < backups.length) {
    // Name the real cause. `limit` cutting the page is the caller getting
    // what they asked for; the budget cutting it is a ceiling they did not
    // set, and telling them otherwise invites them to narrow a call that was
    // already correct.
    // Only suggest raising `limit` when raising it is actually possible.
    // `limit` is capped at 500 by the schema, so on a folder larger than that
    // the selection is already as wide as it can be and "raise `limit`" is a
    // recovery instruction that does nothing. Paging is the answer there.
    const selectionIsRaisable = backups.length < total && backups.length < LIST_BACKUPS_LIMIT_MAX;
    result.truncated = {
      returned: fitted.length,
      total,
      next_offset: consumedTo,
      note:
        `Showing backups ${offset + 1}-${consumedTo} of the ${backups.length} this filter selected`
        + (backups.length < total
          ? ` (of ${total} in the folder${selectionIsRaisable ? '; raise `limit` to widen the selection' : `; \`limit\` is already at its maximum of ${LIST_BACKUPS_LIMIT_MAX}, so page or filter for the rest`})`
          : '')
        + `; the rest did not fit the ${LIST_BACKUPS_BUDGET_CHARS}-character response budget. `
        + `Call again with offset:${consumedTo} for the next page, or narrow with \`device\` / \`unit\`: `
        + 'these are sorted newest-first, so the first page is usually the one you want.',
    };
  }
  return result;
}
