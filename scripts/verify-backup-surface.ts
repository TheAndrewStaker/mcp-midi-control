/**
 * verify-backup-surface: offline goldens for the unified backup surface
 * (`backup_device` / `list_backups` and the index every backup path writes).
 *
 * Everything here is deterministic and device-free. The device side is a STUB
 * descriptor on the storage transport, which is what lets `openCtx` hand back a
 * null connection instead of opening a real MIDI port, so this runs with the
 * rig unplugged and with another agent holding the hardware token.
 *
 * What is actually being asserted, and why each one earns its place:
 *
 *   - The DURATION GATE fires before any wire work and carries a real estimate.
 *     A sweep that silently runs for six minutes is the performance-budget
 *     failure this project explicitly warns about.
 *   - A failed read writes NO file. A corrupt file that looks like a backup is
 *     worse than a missing one, because the user only finds out at restore time.
 *   - A backup never overwrites a backup.
 *   - A device whose stored-slot read has a SIDE EFFECT (the Axe-Fx II reloads
 *     flash over the working buffer) is refused with the reason, not swept.
 *   - The index survives a torn line, never throws on write failure, and
 *     `list_backups` still finds files that predate it.
 *
 * Imports reach into `packages/core/src` directly rather than through the
 * `@mcp-midi-control/core` specifier ON PURPOSE: that specifier resolves to the
 * package's BUILT `dist/`, so a specifier import would test the last build
 * instead of the change under test, and would not run at all on a fresh
 * checkout. Do not "fix" these into package imports.
 */

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BACKUP_INDEX_FILE,
  listBackups,
  readBackupIndex,
  recordBackup,
  resolveBackupPolicy,
  sanitizeForFilename,
} from '../packages/core/src/protocol-generic/dispatcher/backupIndex.js';
import {
  executeBackupDevice,
  executeListBackups,
} from '../packages/core/src/protocol-generic/dispatcher/backupSweep.js';
import { registerDevice, unregisterDevice } from '../packages/core/src/protocol-generic/registry.js';
import { DispatchError } from '../packages/core/src/protocol-generic/types.js';
import type {
  DeviceDescriptor,
  DispatchCtx,
  PresetBinaryDump,
} from '../packages/core/src/protocol-generic/types.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `  -- ${detail}`}`);
  if (!ok) failed++;
}

const tmp = mkdtempSync(join(tmpdir(), 'backup-surface-'));
const driveRoot = join(tmp, 'drive');
mkdirSync(driveRoot, { recursive: true });

function bytesFor(seed: number, len = 64): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (i * 7 + seed) & 0x7f;
  return b;
}

/**
 * A stub device. `stored` decides per-location what the dump does: bytes,
 * an empty slot, or a throw. Storage transport keeps `openCtx` off MIDI.
 */
function stubDescriptor(opts: {
  id?: string;
  stored?: (loc: number) => PresetBinaryDump | 'empty' | 'throw';
  active?: () => PresetBinaryDump;
  hasPacks?: boolean;
  canRestore?: boolean;
  canUploadProject?: boolean;
  backup?: Record<string, unknown>;
}): DeviceDescriptor {
  const reader: Record<string, unknown> = {};
  if (opts.stored) {
    reader.dumpStoredPresetBinary = async (location: number, _ctx: DispatchCtx): Promise<PresetBinaryDump> => {
      const r = opts.stored!(location);
      if (r === 'throw') throw new Error(`read of location ${location} failed`);
      if (r === 'empty') {
        return { bytes: new Uint8Array(0), byte_length: 0, frame_count: 0, format: 'stub', empty: true };
      }
      return r;
    };
  }
  if (opts.active) {
    reader.dumpActivePresetBinary = async (_ctx: DispatchCtx): Promise<PresetBinaryDump> => opts.active!();
  }
  const writer: Record<string, unknown> = {};
  if (opts.canRestore) writer.restorePresetBinary = async () => ({});
  if (opts.canUploadProject) writer.uploadProject = async () => ({});
  return {
    id: opts.id ?? 'stub-backup',
    display_name: opts.id === undefined ? 'Stub Device' : `Stub ${opts.id}`,
    port_match: [{ pattern: opts.id ?? 'stub-backup' }],
    transport: { kind: 'storage', resolveRoot: () => driveRoot },
    capabilities: {
      slot_model: 'linear',
      has_scenes: false,
      has_channels: false,
      supports_save: false,
      supports_lineage: false,
      has_packs: opts.hasPacks,
      ...(opts.backup ? { backup: opts.backup } : {}),
    },
    reader,
    writer,
  } as unknown as DeviceDescriptor;
}

function dump(seed: number, name: string): PresetBinaryDump {
  const bytes = bytesFor(seed);
  return { bytes, byte_length: bytes.length, frame_count: 1, format: 'stub-dump', name, file_extension: 'syx' };
}

async function expectThrow(fn: () => Promise<unknown>): Promise<DispatchError | Error | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err as Error;
  }
}

async function main(): Promise<void> {
  // ── 1. Index: round-trip, resilience, and never-throw ─────────────
  {
    const dir = join(tmp, 'idx');
    check('recordBackup: writes a line', recordBackup(dir, {
      file_name: 'a.syx', device: 'Fractal AM4', device_id: 'am4', unit: 'preset',
      location: 50, byte_length: 12352, created_at: '2026-07-01T10:00:00.000Z', tool: 'export_preset',
    }));
    recordBackup(dir, {
      file_name: 'b.ncs', device: 'Novation Circuit Tracks', device_id: 'circuit-tracks', unit: 'project',
      location: 7, pack: 5, byte_length: 160780, created_at: '2026-07-02T10:00:00.000Z', tool: 'backup_device',
    });
    const entries = readBackupIndex(dir);
    check('readBackupIndex: both entries parse', entries.length === 2, `got ${entries.length}`);
    check('readBackupIndex: pack survives the round-trip', entries[1].pack === 5, String(entries[1].pack));

    // A torn tail (power loss mid-append) must cost ONE entry, not the index.
    writeFileSync(join(dir, BACKUP_INDEX_FILE), `${readFileSync(join(dir, BACKUP_INDEX_FILE), 'utf-8')}{"file_name":"c.sy`, 'utf-8');
    check('readBackupIndex: torn final line is skipped, earlier entries survive', readBackupIndex(dir).length === 2);

    // A file exists on disk but never got indexed (pre-index backup, or the
    // user dropped one in). It must STILL be findable, flagged as such.
    writeFileSync(join(dir, 'a.syx'), Buffer.from(bytesFor(1)));
    writeFileSync(join(dir, 'b.ncs'), Buffer.from(bytesFor(2)));
    writeFileSync(join(dir, 'legacy-hand-added.syx'), Buffer.from(bytesFor(3)));
    const listed = listBackups({ directory: dir });
    check('listBackups: finds all three files', listed.total === 3, String(listed.total));
    const legacy = listed.backups.find((b) => b.file_name === 'legacy-hand-added.syx');
    check('listBackups: unindexed file surfaced and FLAGGED unindexed', legacy?.unindexed === true);
    check('listBackups: newest first', listed.backups[0].created_at >= listed.backups[1].created_at);
    check('listBackups: device filter is a case-insensitive substring',
      listBackups({ directory: dir, device: 'circuit' }).total === 1);
    check('listBackups: unit filter', listBackups({ directory: dir, unit: 'preset' }).total === 1);

    // An index row whose file was deleted must not be reported as present.
    rmSync(join(dir, 'a.syx'));
    check('listBackups: deleted file drops out of the default listing',
      listBackups({ directory: dir }).backups.every((b) => b.file_name !== 'a.syx'));
    check('listBackups: include_missing surfaces it, flagged missing',
      listBackups({ directory: dir, include_missing: true }).backups.some((b) => b.file_name === 'a.syx' && b.missing === true));
  }

  // recordBackup must NEVER throw: the file on disk is the backup, and a
  // failed index write must not turn a good backup into a failed tool call.
  {
    const notADir = join(tmp, 'blocker');
    writeFileSync(notADir, 'I am a file, not a directory');
    let threw = false;
    let result = true;
    try {
      result = recordBackup(notADir, {
        file_name: 'x.syx', device: 'D', unit: 'preset', byte_length: 1,
        created_at: new Date().toISOString(), tool: 't',
      });
    } catch { threw = true; }
    check('recordBackup: unwritable target does NOT throw', !threw);
    check('recordBackup: reports false rather than claiming success', result === false);
  }

  check('sanitizeForFilename: strips separators', sanitizeForFilename('a/b:c*d') === 'a_b_c_d', sanitizeForFilename('a/b:c*d'));
  check('sanitizeForFilename: empty input falls back', sanitizeForFilename('///', 'preset') === 'preset');

  // ── 2. Policy derivation from generic capability signals ──────────
  {
    const circuitish = resolveBackupPolicy(stubDescriptor({ id: 'p1', stored: () => 'empty', hasPacks: true, canUploadProject: true }));
    check('policy: pack-addressed device calls its unit a "project"', circuitish.unit_label === 'project', circuitish.unit_label);
    check('policy: pack-addressed device is quoted per-file-transfer cost', circuitish.seconds_per_unit === 6, String(circuitish.seconds_per_unit));
    check('policy: restore tool derived from uploadProject', circuitish.restore_tool === 'upload_project', String(circuitish.restore_tool));

    const storageish = resolveBackupPolicy(stubDescriptor({ id: 'p2', stored: () => 'empty' }));
    check('policy: storage-transport device calls its unit a "kit"', storageish.unit_label === 'kit', storageish.unit_label);

    const fractalish = resolveBackupPolicy(stubDescriptor({ id: 'p3', stored: () => 'empty', canRestore: true, backup: { unit_label: 'preset', first_location: 0, last_location: 103, seconds_per_unit: 0.5 } }));
    check('policy: declared unit_label wins over derivation', fractalish.unit_label === 'preset', fractalish.unit_label);
    check('policy: declared bounds are exposed for a no-args sweep', fractalish.bounds?.last === 103, JSON.stringify(fractalish.bounds));
    check('policy: restore tool derived from restorePresetBinary', fractalish.restore_tool === 'import_preset', String(fractalish.restore_tool));

    const readOnlyNothing = resolveBackupPolicy(stubDescriptor({ id: 'p4' }));
    check('policy: a device with no dump path reports neither capability',
      !readOnlyNothing.can_dump_stored && !readOnlyNothing.can_dump_active);
    check('policy: no restore tool is INVENTED when no write path exists', readOnlyNothing.restore_tool === undefined);
  }

  // ── 3. Duration gate ─────────────────────────────────────────────
  {
    const d = stubDescriptor({ id: 'gate', stored: (l) => dump(l, `P${l}`), backup: { unit_label: 'preset', seconds_per_unit: 6 } });
    registerDevice(d);
    const dir = join(tmp, 'gate');

    const err = await expectThrow(() => executeBackupDevice({ port: 'gate', scope: 'stored', from: 1, to: 20, directory: dir }));
    check('duration gate: an unacknowledged 20-unit sweep REFUSES', err instanceof DispatchError);
    check('duration gate: refusal code is duration_acknowledgement_required',
      err instanceof DispatchError && err.code === 'duration_acknowledgement_required', (err as DispatchError)?.code);
    check('duration gate: refusal quotes a duration the agent can relay',
      /\d+ minutes|\d+ seconds/.test(err?.message ?? ''), err?.message?.slice(0, 140));
    check('duration gate: refusal names the count and the unit',
      /20 presets/.test(err?.message ?? ''), err?.message?.slice(0, 100));
    check('duration gate: NO files written on the refused call',
      !existsSync(dir) || readdirSync(dir).length === 0);

    // A small job stays frictionless: no acknowledgement needed.
    const small = await executeBackupDevice({ port: 'gate', scope: 'stored', from: 1, to: 1, directory: dir });
    check('duration gate: a 1-unit sweep runs with no acknowledgement', small.ok && small.saved === 1);

    const big = await executeBackupDevice({ port: 'gate', scope: 'stored', from: 1, to: 20, directory: dir, acknowledge_duration: true });
    check('duration gate: acknowledged sweep runs all 20', big.saved === 20, String(big.saved));

    const tooBig = await expectThrow(() => executeBackupDevice({ port: 'gate', scope: 'stored', from: 1, to: 200, directory: dir, acknowledge_duration: true }));
    check('sweep ceiling: 200 units refused even when acknowledged',
      tooBig instanceof DispatchError && /limit 64/.test(tooBig.message), tooBig?.message?.slice(0, 100));
    unregisterDevice('gate');
  }

  // ── 4. Sweep outcomes: saved / empty / failed ─────────────────────
  {
    const d = stubDescriptor({
      id: 'sweep',
      stored: (l) => (l === 2 ? 'empty' : l === 3 ? 'throw' : dump(l, `Tone ${l}`)),
      canRestore: true,
      backup: { unit_label: 'preset', seconds_per_unit: 0.01 },
    });
    registerDevice(d);
    const dir = join(tmp, 'sweep');
    const res = await executeBackupDevice({ port: 'sweep', scope: 'stored', from: 1, to: 5, directory: dir, acknowledge_duration: true });
    check('sweep: 3 saved, 1 empty, 1 failed', res.saved === 3 && res.empty === 1 && res.failed === 1,
      `saved=${res.saved} empty=${res.empty} failed=${res.failed}`);
    check('sweep: ok=false when any unit failed', res.ok === false);
    check('sweep: a partial run still reports what it DID save', /Backed up 3 presets/.test(res.info), res.info.slice(0, 100));
    check('sweep: names the restore tool', res.restore_with === 'import_preset');
    check('sweep: points the user at list_backups', /list_backups/.test(res.info));

    const files = readdirSync(dir).filter((f) => f.endsWith('.syx'));
    check('sweep: exactly 3 files on disk (empty and failed wrote NOTHING)', files.length === 3, files.join(','));
    check('sweep: no file was written for the failed location 3',
      !files.some((f) => /preset03/.test(f)), files.join(','));
    check('sweep: filenames carry the location and the device-given name',
      files.some((f) => /preset01/.test(f) && /Tone_1/.test(f)), files.join(','));

    // Everything written is indexed, so it is findable later without knowing
    // any of the above naming.
    const listed = executeListBackups({ directory: dir });
    check('sweep: every saved file is in the index', listed.total === 3 && listed.backups.every((b) => !b.unindexed));
    check('sweep: index entry carries the stored location', listed.backups.every((b) => typeof b.location === 'number'));
    check('list_backups: info names the folder so a user can go look', listed.info.includes(dir));
    unregisterDevice('sweep');
  }

  // A backup must never overwrite a backup, even on a filename collision.
  {
    const d = stubDescriptor({ id: 'collide', stored: () => dump(1, 'Same'), backup: { seconds_per_unit: 0.01 } });
    registerDevice(d);
    const dir = join(tmp, 'collide');
    mkdirSync(dir, { recursive: true });
    const first = await executeBackupDevice({ port: 'collide', scope: 'stored', from: 1, to: 1, directory: dir });
    const existing = readdirSync(dir).find((f) => f.endsWith('.syx'))!;
    const before = readFileSync(join(dir, existing));
    check('collision guard: first backup saved', first.saved === 1);
    // Same location, same second: the filename collides. Backing something up
    // twice in quick succession is a normal thing to do and must not be
    // reported as a failed backup, nor silently clobber the first copy.
    const second = await executeBackupDevice({ port: 'collide', scope: 'stored', from: 1, to: 1, directory: dir });
    check('collision guard: an immediate re-backup SUCCEEDS', second.saved === 1 && second.failed === 0,
      `saved=${second.saved} failed=${second.failed} ${second.items[0]?.error ?? ''}`);
    check('collision guard: it lands on a new suffixed file, not the old one',
      second.items[0].file_name !== existing, `${second.items[0].file_name} vs ${existing}`);
    check('collision guard: the first copy is byte-untouched',
      readFileSync(join(dir, existing)).equals(before));
    check('collision guard: both copies are on disk', readdirSync(dir).filter((f) => f.endsWith('.syx')).length === 2);
    unregisterDevice('collide');
  }

  // Three consecutive failures = the transport died, not three bad slots.
  {
    const d = stubDescriptor({
      id: 'dead',
      stored: (l) => (l <= 2 ? dump(l, `Ok${l}`) : 'throw'),
      backup: { seconds_per_unit: 0.01 },
    });
    registerDevice(d);
    const dir = join(tmp, 'dead');
    const res = await executeBackupDevice({ port: 'dead', scope: 'stored', from: 1, to: 30, directory: dir, acknowledge_duration: true });
    check('abort: stops after 3 consecutive failures instead of grinding through 30',
      res.items.length === 5, `attempted ${res.items.length}`);
    check('abort: the 2 good backups before the failure are KEPT', res.saved === 2, String(res.saved));
    check('abort: warning explains it is a connection drop, not bad slots',
      /connection dropped/.test(res.warning ?? ''), res.warning?.slice(0, 120));
    check('abort: warning tells the user where to resume from', /re-run from 5/.test(res.warning ?? ''), res.warning);
    unregisterDevice('dead');
  }

  // ── 5. Refusals ──────────────────────────────────────────────────
  {
    // The Axe-Fx II shape: an active-buffer dump exists, a stored dump does
    // NOT, because reading a stored slot on that device reloads flash over the
    // working buffer. A sweep must refuse and explain, not fall back silently.
    const d = stubDescriptor({ id: 'buffer-only', active: () => dump(9, 'Live Edit'), canRestore: true });
    registerDevice(d);
    const err = await expectThrow(() => executeBackupDevice({ port: 'buffer-only', scope: 'stored', from: 1, to: 4, acknowledge_duration: true, directory: join(tmp, 'nope') }));
    check('refusal: stored sweep on a buffer-only device is refused',
      err instanceof DispatchError && err.code === 'capability_not_supported', (err as DispatchError)?.code);
    check('refusal: the reason (a stored read would discard unsaved edits) is stated',
      /discard(ing)? unsaved edits/.test(err?.message ?? ''), err?.message?.slice(0, 200));
    check('refusal: redirects to the working-buffer backup that IS safe',
      /scope: "active"/.test(err?.message ?? ''));

    // ...and the working-buffer backup it redirects to actually works.
    const dir = join(tmp, 'bufonly');
    const res = await executeBackupDevice({ port: 'buffer-only', directory: dir });
    check('default scope: a bare backup_device saves the WORKING BUFFER on a device that has one',
      res.scope === 'active' && res.saved === 1, `${res.scope}/${res.saved}`);
    check('active backup: says out loud that unsaved edits are included',
      /unsaved edits/.test(res.info), res.info.slice(0, 140));
    unregisterDevice('buffer-only');
  }

  {
    const d = stubDescriptor({ id: 'nobounds', stored: (l) => dump(l, `X${l}`) });
    registerDevice(d);
    const err = await expectThrow(() => executeBackupDevice({ port: 'nobounds', scope: 'stored', directory: join(tmp, 'nb') }));
    check('refusal: a range-less sweep on a bounds-less device asks for from/to instead of guessing',
      err instanceof DispatchError && err.code === 'bad_request', (err as DispatchError)?.code);
    check('refusal: explains why guessing the range is not acceptable',
      /guessing the range/.test(err?.message ?? ''), err?.message?.slice(0, 160));
    unregisterDevice('nobounds');
  }

  {
    const d = stubDescriptor({ id: 'nothing' });
    registerDevice(d);
    const err = await expectThrow(() => executeBackupDevice({ port: 'nothing', scope: 'active', directory: join(tmp, 'n') }));
    check('refusal: a device with no dump path at all is refused honestly',
      err instanceof DispatchError && /cannot be backed up through this server/.test(err.message), err?.message?.slice(0, 160));
    unregisterDevice('nothing');
  }

  // ── 6. list_backups on a cold start ──────────────────────────────
  {
    const empty = executeListBackups({ directory: join(tmp, 'never-used') });
    check('list_backups: an empty folder is a clean answer, not an error', empty.total === 0);
    check('list_backups: empty answer tells the user how to make one',
      /backup_device/.test(empty.info) && /export_preset/.test(empty.info), empty.info);
  }

  console.log(failed === 0 ? '\nAll backup-surface checks passed.' : `\n${failed} check(s) FAILED.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });
