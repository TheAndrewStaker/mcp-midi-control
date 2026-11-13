/**
 * Golden: `upload_sample` with a `folder` (the batch path that used to be the
 * separate `upload_kit` tool), driven through the dispatcher with stub devices.
 *
 * Covers what the dispatcher owns and no writer can see: file discovery,
 * natural sort, the kit-token filter, the first-slot mapping, the 64-slot
 * ceiling (skipped files are REPORTED, never dropped silently), the choice
 * between a device's own batch path and a per-file loop, and the refusals.
 *
 * Storage transport keeps the stubs off MIDI, so this runs anywhere.
 *
 * Run via:  npx tsx scripts/verify-upload-sample-folder.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeUploadSample } from '../packages/core/src/protocol-generic/dispatcher/uploads.js';
import { registerDevice, unregisterDevice } from '../packages/core/src/protocol-generic/registry.js';
import { DispatchError } from '../packages/core/src/protocol-generic/types.js';
import type {
  DeviceDescriptor,
  KitUploadItem,
  KitUploadOutcome,
  SampleUploadOutcome,
} from '../packages/core/src/protocol-generic/types.js';

let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  OK    ${label}`);
  else { failed++; console.error(`  FAIL  ${label}${detail !== undefined ? `  (${detail})` : ''}`); }
}

const tmp = mkdtempSync(join(tmpdir(), 'upload-folder-'));
const driveRoot = join(tmp, 'drive');
mkdirSync(driveRoot, { recursive: true });

function folderOf(name: string, files: string[]): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), new Uint8Array([0x52, 0x49, 0x46, 0x46]));
  return dir;
}

interface Calls {
  batch: Array<{ items: KitUploadItem[]; confirm: boolean | undefined }>;
  single: Array<{ slot: number | undefined; filename: string }>;
}

function stub(id: string, mode: 'batch' | 'single', calls: Calls, failOn?: string): DeviceDescriptor {
  const writer: Record<string, unknown> = {
    uploadSample: async (_ctx: unknown, _wav: Uint8Array, slot: number | undefined, filename: string): Promise<SampleUploadOutcome> => {
      if (filename === failOn) throw new Error('card full');
      calls.single.push({ slot, filename });
      return { ok: true, slot: slot ?? calls.single.length - 1, blocks: 1, converted: false, filename, info: 'ok' };
    },
  };
  if (mode === 'batch') {
    writer.uploadKit = async (_ctx: unknown, items: KitUploadItem[], opts?: { confirmOverwrite?: boolean }): Promise<KitUploadOutcome> => {
      calls.batch.push({ items, confirm: opts?.confirmOverwrite });
      return { ok: true, uploaded: items.map((i) => ({ slot: i.slot, filename: i.filename, converted: false })), info: 'batch ok' };
    };
  }
  return {
    id,
    display_name: `Stub ${id}`,
    port_match: [{ pattern: id }],
    transport: { kind: 'storage', resolveRoot: () => driveRoot },
    capabilities: { slot_model: 'linear', has_scenes: false, has_channels: false, supports_save: false, supports_lineage: false },
    reader: {},
    writer,
  } as unknown as DeviceDescriptor;
}

async function thrown(fn: () => Promise<unknown>): Promise<Error | undefined> {
  try { await fn(); return undefined; } catch (e) { return e as Error; }
}

async function main(): Promise<void> {
  console.log('upload_sample folder:');
  const mixed = folderOf('mixed', ['10_k1_hat.wav', '2_k1_snr.wav', '1_k1_kick.wav', '3_k10_tom.wav', 'notes.txt', '4_k2_clap.WAV']);

  // ── a device with its own batch path gets ONE call ──
  {
    const calls: Calls = { batch: [], single: [] };
    const d = stub('fold-batch', 'batch', calls);
    registerDevice(d);
    try {
      const r = await executeUploadSample({ port: d.id, folder: mixed, confirm_overwrite: true }) as KitUploadOutcome;
      const names = calls.batch[0]?.items.map((i) => i.filename) ?? [];
      check('batch device: one uploadKit call, no single-sample calls', calls.batch.length === 1 && calls.single.length === 0);
      check('files are natural-sorted (2_ before 10_) and non-WAVs are ignored',
        JSON.stringify(names) === JSON.stringify(['1_k1_kick.wav', '2_k1_snr.wav', '3_k10_tom.wav', '4_k2_clap.WAV', '10_k1_hat.wav']), names.join(','));
      check('slots count up from 1 by default (wire-indexed from 0)',
        JSON.stringify(calls.batch[0].items.map((i) => i.slot)) === '[0,1,2,3,4]');
      check('confirm_overwrite reaches the writer', calls.batch[0].confirm === true);
      check('the writer outcome is returned', r.ok === true && r.uploaded.length === 5);

      calls.batch.length = 0;
      await executeUploadSample({ port: d.id, folder: mixed, kit: 'k1', slot: 9 });
      const k1 = calls.batch[0].items;
      check('kit token filters as a delimited segment (k1 does not catch k10)',
        JSON.stringify(k1.map((i) => i.filename)) === JSON.stringify(['1_k1_kick.wav', '2_k1_snr.wav', '10_k1_hat.wav']));
      check('with a folder, `slot` is the FIRST slot', JSON.stringify(k1.map((i) => i.slot)) === '[8,9,10]');

      calls.batch.length = 0;
      const over = await executeUploadSample({ port: d.id, folder: mixed, slot: 62 }) as KitUploadOutcome;
      check('files past slot 64 are not sent', calls.batch[0].items.length === 3);
      check('and are REPORTED as skipped, by name', /2 file\(s\) did not fit/.test(over.warning ?? '') && /10_k1_hat\.wav/.test(over.warning ?? ''), over.warning);

      const both = await thrown(() => executeUploadSample({ port: d.id, folder: mixed, file: join(mixed, '1_k1_kick.wav') }));
      check('file AND folder together refuses', both instanceof DispatchError && /not both/.test(both.message));
      const neither = await thrown(() => executeUploadSample({ port: d.id }));
      check('neither file nor folder refuses, naming both', neither instanceof DispatchError && /`file`.*`folder`/.test(neither.message));
      const none = await thrown(() => executeUploadSample({ port: d.id, folder: mixed, kit: 'k9' }));
      check('a filter that matches nothing refuses, naming the token', none instanceof DispatchError && /matching kit 'k9'/.test(none.message));
      const missing = await thrown(() => executeUploadSample({ port: d.id, folder: join(tmp, 'nope') }));
      check('an unreadable folder refuses', missing instanceof DispatchError && /Could not read folder/.test(missing.message));
      check('the refusals sent nothing', calls.batch.length === 1);
    } finally {
      unregisterDevice(d.id);
    }
  }

  // ── a device without a batch path gets its single path per file ──
  {
    const calls: Calls = { batch: [], single: [] };
    const d = stub('fold-single', 'single', calls);
    registerDevice(d);
    try {
      const r = await executeUploadSample({ port: d.id, folder: mixed, kit: 'k1' }) as KitUploadOutcome;
      check('append-only device: one single-sample call per file, in order, with no slot',
        JSON.stringify(calls.single) === JSON.stringify([
          { filename: '1_k1_kick.wav' }, { filename: '2_k1_snr.wav' }, { filename: '10_k1_hat.wav' },
        ]), JSON.stringify(calls.single));
      check('the loop reports every upload', r.ok === true && r.uploaded.length === 3);

      calls.single.length = 0;
      await executeUploadSample({ port: d.id, folder: mixed, kit: 'k1', slot: 5 });
      check('a given slot counts up per file (device numbering in, wire index to the writer)',
        JSON.stringify(calls.single.map((c) => c.slot)) === '[4,5,6]', JSON.stringify(calls.single));
    } finally {
      unregisterDevice(d.id);
    }
  }

  // ── the loop stops at the first failure and says what stayed ──
  {
    const calls: Calls = { batch: [], single: [] };
    const d = stub('fold-fail', 'single', calls, '2_k1_snr.wav');
    registerDevice(d);
    try {
      const r = await executeUploadSample({ port: d.id, folder: mixed, kit: 'k1' }) as KitUploadOutcome;
      check('a mid-batch failure stops the loop', r.ok === false && calls.single.length === 1);
      check('the receipt names the failed file and what was already written',
        r.failed?.filename === '2_k1_snr.wav' && /1 sample\(s\) before it were written and stay/.test(r.warning ?? ''), r.warning);
    } finally {
      unregisterDevice(d.id);
    }
  }

  console.log(failed === 0 ? '\nAll upload_sample folder checks passed.' : `\n${failed} check(s) FAILED.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
