/**
 * Dispatcher: `delete_project`, the only operation in this server that makes
 * stored content stop existing.
 *
 * Every other destructive path here REPLACES: `upload_project` puts a different
 * project where one was, `save_preset` puts a different preset where one was.
 * The old thing is gone either way, but the slot is still a slot with something
 * in it, and the user gets a receipt naming what they now have. A delete leaves
 * nothing, on hardware with no undo, no trash, and no front-panel erase.
 *
 * That difference is why the gates below are stricter than the overwrite gate,
 * and why two of them are deliberately NOT symmetric with it:
 *
 *  - The overwrite gate SKIPS its occupancy read when `confirm_overwrite` is
 *    passed, because on a write the read only buys information: the write lands
 *    either way. Here the read is unconditional. It is the only thing separating
 *    "erase this project" from "erase the wrong project", and it is also the only
 *    evidence that the file we backed up is the file we destroyed.
 *  - `upload_project`'s backup is a FLAG (`backup_first`), defaulting true. Here
 *    there is no flag. See `backup` below.
 *
 * Shape of a call, in order, cheapest gate first:
 *
 *   1. capability          the device can erase a stored project at all
 *   2. arguments           slots named and in range, no duplicates, at least one
 *   3. ceiling             MAX_DELETES_PER_CALL, refused whole, never truncated
 *   4. pre-flight read     both oracles, per slot; refuse on empty / unreadable
 *   5. authorization       `confirm_delete`, whose refusal CARRIES the report
 *   6. backup              per slot, CRC-verified to disk, abort on anything else
 *   7. delete              writer: read-then-erase-then-re-read, per slot
 *   8. verify              fresh session, both oracles + a free control, after
 *                          the manifest flush window
 *
 * Steps 1-5 send nothing destructive and can all be exercised offline, which is
 * the point: a refusal path nobody tests is a refusal path that does not work.
 *
 * ## Named slots, never a range
 *
 * `slots` is a list the caller writes out. There is no `from`/`to` anywhere in
 * this feature, at any layer, and adding one would undo most of the safety here.
 * Two independent reasons:
 *
 *  - The 2026-06-27 incident that emptied a pack's 64-slot sample pool was a LOOP
 *    over a range. A range argument is the shape of that mistake.
 *  - Novation Components does not loop either. It enumerates every slot, then
 *    sends one delete frame per slot its own directory listed as occupied. The
 *    device's own tooling treats "which slots" as a result of a read, not as an
 *    interval typed by a human. So does this.
 *
 * A caller who wants a range must enumerate it with `scan_locations` first, which
 * means they have SEEN what is in it before they name it.
 */

import { openCtx, requireDevice, toWirePack } from './core.js';
import { backupProjectSlot } from './backup.js';
import {
  DispatchError,
  type DeviceDescriptor,
  type DispatchCtx,
  type ProjectDeleteOutcome,
  type ProjectDeleteResult,
  type ProjectSlotProbe,
  type ProjectSlotProbeReport,
} from '../types.js';

/**
 * Hard ceiling on slots erased by ONE call. Refused above it, never truncated.
 *
 * Eight, for four reasons, in descending order of how much they matter:
 *
 *  1. It is an order of magnitude below the failure this gate exists to prevent.
 *     On 2026-06-27 a loop of these frames cleared 64 slots in one go, and the
 *     resulting hole was misdiagnosed for months as a directory-commit bug. No
 *     single authorized call can empty a pack; clearing one takes eight separate
 *     calls, each of which re-reads the card and re-states what it is about to
 *     destroy. The friction IS the feature.
 *  2. Each delete costs a full CRC-verified backup download of the project
 *     first, several seconds apiece. Eight is already a minute of wall time, well
 *     past the point where a tool must quote the wait to the user anyway.
 *  3. It covers the real job. The use case is a pack REORGANISATION that shrinks
 *     a layout and leaves a stale tail; those tails are a handful of slots, not
 *     dozens.
 *  4. Truncating to fit would be worse than refusing at any ceiling. A caller who
 *     asked for twelve and got eight believes the range is clear when four
 *     projects are still there, and on this device the next thing they do is act
 *     on that belief.
 */
export const MAX_DELETES_PER_CALL = 8;

/**
 * How long to wait after the delete session closes before the DIRECTORY
 * verification read. The Circuit flushes a pack's manifest seconds after a
 * transfer session closes (measured 6.3 s and 7.4 s on two Components captures),
 * so a directory read taken sooner reports stale contents. On a delete that
 * would show the erased project still present and provoke a pointless re-erase.
 */
const MANIFEST_FLUSH_WAIT_MS = 9_000;

export interface DeleteProjectArgs {
  port: string;
  /**
   * Projects to erase, NAMED individually, 1..64 exactly as the device numbers
   * them. There is no range form; see the module header for why.
   */
  slots: readonly number[];
  /** microSD pack, 1-BASED as the device shows it ("Pack 5" = 5). Default 1. */
  pack?: number;
  /**
   * Erase authorization. Without it the call performs the read-only pre-flight
   * and REFUSES, returning what would be lost. There is no default that erases.
   */
  confirm_delete?: boolean;
  /** Destination folder for the mandatory pre-delete backups. Default `~/mcp-midi-backups`. */
  directory?: string;
  /**
   * How long to wait before the DIRECTORY verification read, overriding
   * {@link MANIFEST_FLUSH_WAIT_MS}. Not on the tool surface: an agent has no way
   * to know a good value and lowering it only produces false "not confirmed"
   * reports. It exists so offline tests, whose mock device has no flush lag, do
   * not have to sleep through a real device's.
   */
  flush_wait_ms?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** "Project 12 (Winter Margin)" / "Project 12" when the directory gave no name. */
function describeSlot(p: ProjectSlotProbe): string {
  return p.name ? `Project ${p.slot} ("${p.name}")` : `Project ${p.slot}`;
}

function requireDeletableDevice(port: string): DeviceDescriptor {
  const descriptor = requireDevice(port);
  if (!descriptor.writer.deleteProjects || !descriptor.reader.probeProjectSlots) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `${descriptor.display_name} cannot erase a stored location. Deleting stored content is a Circuit Tracks-family ` +
      `capability: its file transport has a per-slot delete opcode. Most gear has no erase at all, including every ` +
      `Fractal device, where a preset location always holds something and the way to "remove" a preset is to write a ` +
      `different one over it.`,
      { retry_action: 'To replace what is stored instead of erasing it, use apply_preset + save_preset (preset devices) or upload_project (Circuit Tracks).' },
    );
  }
  return descriptor;
}

/** Range / duplicate / emptiness checks. Runs before any port is opened. */
function validateSlots(descriptor: DeviceDescriptor, slots: readonly number[]): readonly number[] {
  if (slots.length === 0) {
    throw new DispatchError('bad_request', descriptor.display_name,
      'delete_project needs at least one project to erase. Pass `slots` as the project numbers the device shows, e.g. [61, 62].');
  }
  for (const s of slots) {
    if (!Number.isInteger(s) || s < 1 || s > 64) {
      throw new DispatchError('bad_location', descriptor.display_name,
        `Project must be 1..64, numbered exactly as the device shows it (Project 1..64), got ${s}.`);
    }
  }
  const seen = new Set<number>();
  const dupes = slots.filter((s) => (seen.has(s) ? true : (seen.add(s), false)));
  if (dupes.length > 0) {
    // Not merely tidy: a duplicate means the caller's model of the range is
    // wrong, and the second pass would report "already empty" for a slot the
    // first pass destroyed, which reads like a failure rather than an echo.
    throw new DispatchError('bad_request', descriptor.display_name,
      `delete_project was given the same project twice (${[...new Set(dupes)].join(', ')}). List each project once.`);
  }
  // The ceiling is a REFUSAL, never a truncation. See MAX_DELETES_PER_CALL.
  if (slots.length > MAX_DELETES_PER_CALL) {
    throw new DispatchError('delete_ceiling_exceeded', descriptor.display_name,
      `delete_project erases at most ${MAX_DELETES_PER_CALL} projects per call and was asked for ${slots.length}. ` +
      `This is refused rather than trimmed to ${MAX_DELETES_PER_CALL}: a partial erase reported as done would leave ` +
      `${slots.length - MAX_DELETES_PER_CALL} project(s) still on the card while the caller believed the range was clear. ` +
      `Split it into calls of ${MAX_DELETES_PER_CALL} or fewer, confirming each with the user, and expect each one to take ` +
      `roughly ${MAX_DELETES_PER_CALL * 8} seconds.`,
      { retry_action: `Re-call with ${MAX_DELETES_PER_CALL} or fewer projects, then repeat for the rest.` });
  }
  return slots;
}

/**
 * Read-before-delete. Refuses the WHOLE call, not just the offending slot, when
 * any slot is empty or unreadable.
 *
 * Whole-call, because a caller who names an empty slot has a wrong picture of
 * the card, and quietly skipping it while erasing its neighbours acts on that
 * wrong picture at full destructive force. The same argument applies harder to
 * an unreadable slot: "could not read" must never degrade to "assume empty and
 * carry on", and the neighbours are addressed through the same connection that
 * just failed to answer.
 */
function requireAllOccupied(descriptor: DeviceDescriptor, probes: readonly ProjectSlotProbe[], pack: number): void {
  const where = `Pack ${pack}`;
  const unreadable = probes.filter((p) => p.unreadable !== undefined);
  if (unreadable.length > 0) {
    throw new DispatchError('no_ack', descriptor.display_name,
      `Could not establish whether ${unreadable.map((p) => `Project ${p.slot}`).join(', ')} on ${where} ` +
      `${unreadable.length === 1 ? 'is' : 'are'} occupied (${unreadable[0].unreadable}), so nothing was erased. ` +
      `An erase is not attempted on a slot whose contents are unknown. Stop playback on the device, make sure no other ` +
      `app holds its MIDI port, then reconnect_midi and retry.`,
      { retry_action: 'reconnect_midi, then re-call. If the slot still cannot be read, do not force it: read the pack with scan_locations first.' });
  }
  const empty = probes.filter((p) => !p.exists);
  if (empty.length > 0) {
    throw new DispatchError('bad_location', descriptor.display_name,
      `${empty.map((p) => `Project ${p.slot}`).join(', ')} on ${where} ` +
      `${empty.length === 1 ? 'is' : 'are'} already empty, so there is nothing to erase and the whole call was refused ` +
      `rather than partly run. Check the pack with scan_locations, then re-call with only the projects that exist.`,
      { retry_action: 'Call scan_locations to see what this pack actually holds, then re-call with the occupied projects.' });
  }
}

/**
 * Authorization gate. Its refusal IS the pre-flight report: the caller cannot
 * reach a delete without first receiving a message naming every project that
 * would be destroyed. That is the multi-preset overwrite gate from
 * `docs/SAFE-EDIT-WORKFLOW.md` ("pre-flight scan the target range and surface
 * what would be overwritten"), not a second gate invented beside it, and it is
 * why there is no `dry_run` here: the unauthorized call already is one.
 */
function requireDeleteAuthorized(
  descriptor: DeviceDescriptor, probes: readonly ProjectSlotProbe[], pack: number, confirmDelete: boolean | undefined,
): void {
  if (confirmDelete === true) return;
  const listed = probes.map(describeSlot).join(', ');
  throw new DispatchError('delete_confirmation_required', descriptor.display_name,
    `Nothing was erased. This would PERMANENTLY DELETE ${probes.length} project(s) from Pack ${pack}: ${listed}. ` +
    `The Circuit has no undo and no trash, so once erased they exist only in the backup this tool takes first. ` +
    `Read that list back to the user, name each project, and get an explicit yes before re-calling with ` +
    `confirm_delete: true. Do not pass confirm_delete because the user said "tidy up" or "sort out the pack": ` +
    `pass it when they have agreed to lose these specific projects.`,
    { retry_action: 'Tell the user exactly which projects would be deleted, then re-call with confirm_delete: true once they agree.' });
}

/**
 * Mandatory pre-delete backup. Deliberately NOT a flag, unlike
 * `upload_project`'s `backup_first`, for three reasons:
 *
 *  1. `backup_first` was found (2026-07-29) to be a silent no-op unless
 *     `confirm_overwrite` was passed too: a caller could ask for a backup, be
 *     told nothing, and reasonably believe one had been taken. A flag whose
 *     effect depends on another flag is the failure mode. No flag, no failure.
 *  2. On an upload there is a genuinely non-destructive path (writing an empty
 *     slot), so the backup really is optional there. Here there is none: this
 *     tool refuses empty slots, so every call that gets this far destroys
 *     something. The backup is not extra caution on a risky path, it IS the undo,
 *     and an undo you can switch off is not an undo.
 *  3. The cost is one download per slot against a permanent loss on a device with
 *     no erase and no trash. Point `directory` at a synced folder if the backups
 *     should leave the machine.
 *
 * Anything other than `saved` ABORTS the whole call before a single delete frame
 * is sent. `skipped_empty` and `skipped_unsupported` are not tolerated leniently
 * here even though they are benign elsewhere: the pre-flight already proved the
 * slot occupied and the capability gate already proved the device can dump it, so
 * either status is a CONTRADICTION between two reads, and the correct response to
 * two reads disagreeing is to stop.
 *
 * `structurally_valid === false` aborts too, and that case is subtler: the read
 * PASSED the device's transfer CRC and the file it delivered is still not a
 * project. On an overwrite that is a warning, because the slot ends up holding
 * something either way. Here it means the only copy of the project would be a
 * file that cannot be restored, which is the same outcome as taking no backup at
 * all while reporting that one was taken.
 */
async function backupBeforeDelete(
  descriptor: DeviceDescriptor, ctx: DispatchCtx, probes: readonly ProjectSlotProbe[], directory: string | undefined,
): Promise<Map<number, string>> {
  const paths = new Map<number, string>();
  for (const p of probes) {
    // May throw (read failure / CRC mismatch). Let it propagate: a project we
    // could not back up is a project we must not erase.
    const backup = await backupProjectSlot(descriptor, ctx, p.slot, { directory, tool: 'backup-before-delete' });
    const earlier = paths.size > 0
      ? `${paths.size} earlier backup(s) in this call were written and are safe to delete by hand; `
      : '';
    if (backup.status !== 'saved' || backup.file_path === undefined) {
      throw new DispatchError('bad_location', descriptor.display_name,
        `Nothing was erased. ${describeSlot(p)} read as occupied a moment ago, but the pre-delete backup came back ` +
        `"${backup.status}" instead of a saved file, so the erase would have been unrecoverable. ` +
        `${earlier}no delete was sent for any project. Retry, and if it repeats, back the pack up with backup_device first.`,
        { retry_action: 'Run backup_device over these projects first, confirm the files exist with list_backups, then retry.' });
    }
    if (backup.structurally_valid === false) {
      throw new DispatchError('bad_location', descriptor.display_name,
        `Nothing was erased. The pre-delete backup of ${describeSlot(p)} passed the device's transfer check but the file ` +
        `it delivered is not a valid project, so restoring it would not bring the project back. Erasing the slot would ` +
        `therefore destroy the only usable copy. ${backup.note} ` +
        `${earlier}no delete was sent for any project. Read the slot with get_preset to see what is actually stored there, ` +
        `and if the stored project is itself corrupt, overwrite it with upload_project instead of erasing it.`
          .replace(/\s+/g, ' ').trim(),
        { retry_action: 'Inspect the slot with get_preset. If the backup cannot be made restorable, do not erase: overwrite the slot with upload_project instead.' });
    }
    paths.set(p.slot, backup.file_path);
  }
  return paths;
}

export async function executeDeleteProject(args: DeleteProjectArgs): Promise<ProjectDeleteOutcome> {
  // 1 + 2 + 3: capability, arguments, ceiling. No port opened yet, so a caller
  // who got any of these wrong pays nothing and touches nothing.
  const descriptor = requireDeletableDevice(args.port);
  const slots = validateSlots(descriptor, args.slots);

  // One ctx carries the pack, so the pre-flight read, the backup, the delete and
  // the verification physically cannot address different packs (see
  // DispatchCtx.pack). On an erase that property is load-bearing: a gate that
  // cleared Pack 1 while the delete landed on Pack 5 would green-light the exact
  // destruction it exists to prevent, and the "backup" on disk would be of a
  // project that was never touched.
  const ctx = openCtx(descriptor, { pack: toWirePack(args.pack) });
  const devicePack = (ctx.pack ?? 0) + 1;

  // 4: read before delete, both oracles, unconditional.
  const report = await descriptor.reader.probeProjectSlots!(ctx, slots);
  const probes = report.slots;
  requireAllOccupied(descriptor, probes, devicePack);

  // 5: authorization. Its refusal carries the report of what would be lost.
  requireDeleteAuthorized(descriptor, probes, devicePack, args.confirm_delete);

  // 6: backup. Throws before any delete frame if it cannot produce a saved file.
  const backups = await backupBeforeDelete(descriptor, ctx, probes, args.directory);

  // 7: erase. The writer re-reads each slot immediately before its delete frame.
  const wire = await descriptor.writer.deleteProjects!(ctx, slots);

  // 8: verify with the OTHER oracle, in a fresh session, after the flush window.
  //    The writer already re-queried in-session; the directory is what a delete
  //    actually edits, so checking only the directory would be circular and
  //    checking it too early would report a stale hit. Both, and late.
  const flushWait = args.flush_wait_ms ?? MANIFEST_FLUSH_WAIT_MS;
  if (flushWait > 0) await sleep(flushWait);
  let after: ProjectSlotProbeReport = { slots: [] };
  let verifyError: string | undefined;
  try {
    // Rebuild the ctx on a FRESH handle. Two reasons, and the first is a bug
    // rather than a nicety: the writer force-reconnects before a transfer (the
    // idle/USB-suspend hardening every Circuit session path uses), which closes
    // the handle `ctx.conn` still points at. Verifying through the old one reads
    // a dead port and reports "not confirmed" for a delete that worked, which on
    // this device invites a re-send. The second reason is the verification's own
    // contract: it is supposed to be a fresh session, not a continuation of the
    // one that did the erasing.
    const verifyCtx: DispatchCtx = ctx.reconnect ? { ...ctx, conn: ctx.reconnect() } : ctx;
    after = await descriptor.reader.probeProjectSlots!(verifyCtx, slots);
  } catch (err) {
    verifyError = err instanceof Error ? err.message : String(err);
  }
  const afterBySlot = new Map(after.slots.map((p) => [p.slot, p]));
  // The free reference for this verification. Prefer the one read alongside the
  // post-delete probe (same session, same device state); fall back to the
  // pre-flight's. Absent on a full pack, in which case the comparison is
  // reported UNAVAILABLE rather than quietly counted as a pass.
  const control = after.free_control ?? report.free_control;

  const deleted: ProjectDeleteResult[] = wire.map((r) => {
    const before = probes.find((p) => p.slot === r.slot);
    const post = afterBySlot.get(r.slot);
    const goneByDirectory = post === undefined ? undefined : post.unreadable === undefined && !post.in_directory;
    // Byte-for-byte against a slot the device itself calls free. This is the
    // check that catches the 2026-07-29 mis-scoring: an erased slot answers
    // EXACTLY as a never-occupied one does, so if the two frames differ, the
    // erase is not confirmed no matter what our own parser concluded.
    const matchesControl = control === undefined || post?.reply === undefined
      ? undefined
      : post.reply.length === control.reply.length && post.reply.every((b, i) => b === control.reply[i]);
    const confirmed = r.ok === true && r.gone_by_query === true && goneByDirectory === true && matchesControl !== false;
    return {
      slot: r.slot,
      ok: confirmed,
      name: before?.name,
      backup_path: backups.get(r.slot),
      gone_by_query: r.gone_by_query,
      gone_by_directory: goneByDirectory,
      matches_free_control: matchesControl,
      error: confirmed
        ? undefined
        : r.error
          ?? (verifyError !== undefined
            ? `the delete was acknowledged but the confirming read failed (${verifyError}); re-read this project with scan_locations before assuming either outcome`
            : matchesControl === false
              ? 'the delete was acknowledged but the slot does not answer the way a known-free slot does; re-read this project with scan_locations'
              : `the delete was acknowledged but only ${r.gone_by_query ? 'one' : 'neither'} of the two checks confirmed it is gone; re-read this project with scan_locations`),
    };
  });

  const gone = deleted.filter((d) => d.ok);
  const kept = deleted.filter((d) => !d.ok);
  const backupDir = [...backups.values()][0]?.replace(/[\\/][^\\/]+$/, '');
  const controlNote = control === undefined
    ? 'No empty project was available on this pack to use as a reference for what "free" looks like, so that third comparison was skipped.'
    : `Each erased slot also answers the file query byte-for-byte the way Project ${control.slot}, which the device reports as empty, answers it.`;
  return {
    ok: kept.length === 0,
    pack: devicePack,
    deleted,
    info:
      `Erased ${gone.length} of ${deleted.length} project(s) from Pack ${devicePack}` +
      (gone.length > 0 ? `: ${gone.map((d) => (d.name ? `Project ${d.slot} ("${d.name}")` : `Project ${d.slot}`)).join(', ')}` : '') + '. ' +
      `Each one was read as occupied, backed up CRC-verified${backupDir ? ` to ${backupDir}` : ''}, erased, and then confirmed gone by TWO ` +
      `INDEPENDENT checks: the device's own per-file query, which is computed from the file rather than read out of the ` +
      `directory, and a fresh read of the pack directory taken after the device's manifest flush. The directory alone would ` +
      `be circular, since it is the table a delete edits. ${controlNote} ` +
      `To put one back, use upload_project with its backup file and the same pack; list_backups finds them by name.`,
    warning: kept.length > 0
      ? `${kept.length} project(s) were NOT confirmed erased: ` +
        kept.map((d) => `Project ${d.slot} (${d.error})`).join('; ') +
        `. Treat those slots as UNKNOWN, not as empty and not as intact: re-read the pack with scan_locations before acting on them. ` +
        `Their backups were taken before anything was sent, so nothing is unrecoverable.`
      : undefined,
  };
}
