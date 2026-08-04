/**
 * Backup tools (`backup_device`, `list_backups`).
 *
 * The user-facing half of the backup story. Two verbs, one for each half of
 * what a musician actually asks:
 *
 *   "back up my Circuit before we change anything"  -> backup_device
 *   "what have we got saved"                        -> list_backups
 *
 * The third verb, "put it back the way it was", is deliberately NOT here: a
 * restore overwrites, and this release ships the safe half first. The existing
 * per-unit restore paths (`import_preset` for Fractal `.syx`, `upload_project`
 * for a Circuit `.ncs`) already carry their own gates and remain the way back.
 * See the design note at the bottom of this file for the shape `restore_backup`
 * should take when it lands.
 *
 * Why these are not just arguments on `export_preset`: a range sweep has a
 * different cost class (minutes, not milliseconds), a different failure model
 * (partial success is the normal case, not an error), and needs a duration
 * handshake that would be dead weight on a single-preset export. Keeping them
 * apart lets `export_preset` stay the instant one-shot it is.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { executeBackupDevice, executeListBackups } from '../dispatcher/backupSweep.js';
import { LIST_BACKUPS_LIMIT_DEFAULT, LIST_BACKUPS_LIMIT_MAX } from '../dispatcher/backupIndex.js';
import { PACK_DESC, PORT_DESC, asError, asText } from './shared.js';

export function registerBackupTools(server: McpServer): void {
  server.registerTool('backup_device', {
    title: 'Back Up Device',
    // readOnlyHint against the DEVICE: this tool only issues dump requests. It
    // does write files to the user's disk, which is why openWorldHint is true.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: [
      'Save a device\'s content to byte-exact files on disk so a later change can be undone. READS ONLY: never writes to the device.',
      'Scopes: "active" (default wherever a working buffer exists) saves it INCLUDING unsaved edits, one fast call. "stored" sweeps locations `from`..`to` as the front panel numbers them (Fractal presets, Circuit projects with `pack`, kits); max 64 per call.',
      'DURATION GATE: a sweep over 3 locations or ~5 s REFUSES and returns a time estimate. Relay it to the user and re-call with `acknowledge_duration: true` only once THEY agree; there is no mid-sweep progress. Never set that flag on a first call.',
      'Empty locations are skipped, not failed; one that fails to read writes NO file, and earlier reads are kept.',
      'A device whose stored read has a side effect (Axe-Fx II) is refused with the reason and redirected to scope "active".',
      'Files go to `directory`, else `mcp-midi-backups` under the user\'s home, indexed for `list_backups`. Restore with the tool named in `restore_with`.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      scope: z.enum(['active', 'stored']).optional().describe('"active" = the working buffer, including unsaved edits (one fast read). "stored" = a range of saved locations via from/to. Default: "stored" when from/to or a declared range exists, else "active".'),
      from: z.number().int().min(0).optional().describe('First stored location to back up, in DEVICE numbering as the front panel shows it (AM4 0..103 = A01..Z04; Circuit Tracks Project 1..64). Required on devices that do not declare their own range.'),
      to: z.number().int().min(0).optional().describe('Last stored location to back up, inclusive, same numbering as `from`. Max 64 locations in one call.'),
      pack: z.number().int().min(1).max(32).optional().describe(`Which pack to back up. ${PACK_DESC}`),
      directory: z.string().optional().describe('Destination folder. Defaults to a `mcp-midi-backups` folder under the user\'s home. Point it at a cloud-synced folder (e.g. OneDrive) so the backups leave this machine. Created if it does not exist.'),
      acknowledge_duration: z.boolean().optional().describe('Pass true ONLY after telling the user how long the sweep will take and getting their agreement. Without it, any job over 3 locations or 5 seconds refuses and returns the estimate for you to relay.'),
    },
  }, async ({ port, scope, from, to, pack, directory, acknowledge_duration }) => {
    try {
      return asText(await executeBackupDevice({ port, scope, from, to, pack, directory, acknowledge_duration }));
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('list_backups', {
    title: 'List Backups',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      'List the backup files this server has saved, newest first, so a user can find one without knowing where we put them. Answers "what have we got saved" and "when did we last back this up".',
      'Local disk only: no device, no MIDI, instant, works with the gear unplugged.',
      'Each entry gives the source device, what the file IS (preset / project / kit / active_buffer), the location and pack it came from, the name the device gave it, size, date, and `restore_with` (the tool that puts it back).',
      'Filter with `device` (substring, e.g. "circuit") or `unit`. Backups come from backup_device and export_preset, and are taken automatically before upload_project overwrites a slot or delete_project erases one, so an erased project is findable here.',
    ].join(' '),
    inputSchema: {
      directory: z.string().optional().describe('Folder to list. Defaults to the `mcp-midi-backups` folder under the user\'s home, which is where backups go unless a `directory` was passed when taking them.'),
      device: z.string().optional().describe('Case-insensitive substring filter on the device name or id ("circuit", "am4", "fm9").'),
      unit: z.string().optional().describe('Filter by what the file is: "preset", "project", "kit", or "active_buffer".'),
      limit: z.number().int().min(1).max(LIST_BACKUPS_LIMIT_MAX).optional().describe(`How many entries to select, newest first. Default ${LIST_BACKUPS_LIMIT_DEFAULT}. A wide selection pages via \`truncated.next_offset\`.`),
      include_missing: z.boolean().optional().describe('Also list index entries whose file is no longer on disk (deleted or moved), flagged `missing: true`. Default false.'),
      offset: z.number().int().min(0).optional().describe('Resume index into the selection, from `truncated.next_offset`.'),
    },
  }, async ({ directory, device, unit, limit, include_missing, offset }) => {
    try {
      return asText(executeListBackups({ directory, device, unit, limit, include_missing, offset }));
    } catch (err) {
      return asError(err);
    }
  });
}

// ── Designed, not built: `restore_backup` ─────────────────────────────
//
// Restore is the dangerous half, so it ships behind the creating half rather
// than beside it. The shape it should take, so the next pass does not
// re-derive it:
//
//   restore_backup({ port, file_path, target_location?, pack?,
//                    save_authorized?, confirm_overwrite? })
//
//   - It is a THIN router, not a new wire path. It reads the index entry for
//     `file_path`, checks `device_id` and `format` against the resolved port,
//     and then delegates to the SAME executor the device already exposes
//     (`executeRestorePreset` for a Fractal `.syx`, `executeUploadProject` for
//     a Circuit `.ncs`). Inventing a second restore path per device is how the
//     two drift apart, and the second one is always the one without the gates.
//   - It therefore inherits the EXISTING gates rather than adding parallel
//     ones: `save_authorized` (SAFE-EDIT-WORKFLOW.md §3) for anything that
//     persists to a stored location, `confirm_overwrite` plus the
//     backup-before-overwrite read for a project slot, and the buffer-dirty
//     guard for anything that lands on the working buffer.
//   - It must REFUSE, never coerce: a file whose `format` or `device_id` does
//     not match the target port is a wrong-model restore, and pushing another
//     model's dump is exactly the class of write that bricks a preset. The
//     index makes this check cheap and it must be mandatory, including for
//     `unindexed` files, where the format cannot be established and the answer
//     is "tell me which device this is from" rather than a guess.
//   - Default target is the WORKING BUFFER wherever the device has one,
//     because that restore is reversible by switching presets. Persisting is
//     the opt-in, exactly as `import_preset` already does it.
//   - A RANGE restore (the inverse of the sweep) should not ship in the same
//     pass as the single restore. Writing 64 project slots from a folder is
//     the single most destructive operation this server could offer, and it
//     needs its own pre-flight scan of what it would overwrite, per the
//     multi-preset overwrite gate.
