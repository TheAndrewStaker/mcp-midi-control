/**
 * Send a MIDI Control Center project archive (`.mfprojz`) to the MicroFreak,
 * slot by slot, over this server's own hardware-confirmed `import_preset`
 * write path. Replaces MCC's Import -> Send for a whole reorganised library.
 *
 * The wire work is entirely `writer.restorePresetBinary`; this script only
 * parses the archive, orders it, and drives the loop. That split is
 * deliberate: the loop belongs in a future `restore_device` (the missing
 * inverse of `backup_device`), and nothing here should have to move when it
 * lands.
 *
 * DESTRUCTIVE. Every slot in range is overwritten and this device has no
 * separate save step -- a stored-slot SysEx write IS the persist. Take a
 * `backup_device` sweep, or keep MCC's own "Recall to Computer" export, before
 * running it. The script names the restore file it expects and refuses to
 * start without an explicit typed confirmation.
 *
 * Batch conventions follow `dispatcher/backupSweep.ts`, so the eventual tool
 * inherits them unchanged: quote the cost before the wait, abort after three
 * consecutive failures rather than grinding through a dead transport, and
 * never report a partial as a success.
 *
 * KNOWN GAP, to close with `restore_device`: the backup sweep below writes its
 * `.syx` files directly and does NOT call `recordBackup`, so `list_backups`
 * cannot see them. The files are byte-exact and usable; they are just not in
 * the index a user would search.
 *
 * Usage:
 *   npx tsx scripts/microfreak-send-library.ts --file "<lib>.mfprojz" [options]
 *
 *   --from N / --to N   Device slot range (default 1..512).
 *   --canary            Write ONLY the first slot in range, then read it back
 *                       and diff all 4672 bytes against the source.
 *   --dry-run           Parse and report; touch no hardware.
 *   --no-backup         Skip the pre-write sweep. Don't.
 *   --yes               Skip the typed confirmation (for a resumed run).
 */
import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

import { MICROFREAK_DESCRIPTOR } from '../packages/arturia/src/descriptor.js';
import {
  MICROFREAK_CATEGORIES,
  parseLibrary,
  presetPayloadToDumpBytes,
  type LibrarySlot,
} from '../packages/arturia/src/codec/mfprojz.js';
import { withEndpoint } from '../packages/core/src/protocol-generic/dispatcher/core.js';
import { closeAllMidiConnections } from '../packages/core/src/midi/transport.js';
import type { DispatchCtx } from '../packages/core/src/protocol-generic/types.js';

/** Stop after this many consecutive failures: the transport is gone, not the slot. */
const CONSECUTIVE_FAILURE_ABORT = 3;

const JOURNAL = path.join(os.homedir(), 'mcp-midi-backups', 'microfreak-library-send.json');

interface Args {
  file: string; from: number; to: number;
  canary: boolean; dryRun: boolean; yes: boolean; backup: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const file = get('--file');
  if (file === undefined) {
    console.error('--file <path.mfprojz> is required.');
    process.exit(2);
  }
  return {
    file,
    from: Number(get('--from') ?? 1),
    to: Number(get('--to') ?? 512),
    canary: argv.includes('--canary'),
    dryRun: argv.includes('--dry-run'),
    yes: argv.includes('--yes'),
    backup: !argv.includes('--no-backup'),
  };
}

/**
 * Sweep every slot about to be overwritten to disk first, in the same
 * byte-exact `.syx` shape `export_preset` writes -- so this script can send
 * the result straight back. Defaults ON, matching `upload_project`'s
 * `backup_first`. A slot whose dump fails writes NO file and is reported: a
 * file named like a backup that does not contain the preset converts "I have
 * no backup" into "I have a corrupt backup", found at restore time.
 */
async function backupRange(ctx: DispatchCtx, slots: readonly number[], dir: string): Promise<number> {
  const dump = MICROFREAK_DESCRIPTOR.reader.dumpStoredPresetBinary;
  if (dump === undefined) throw new Error('MicroFreak descriptor has no dumpStoredPresetBinary.');
  fs.mkdirSync(dir, { recursive: true });
  const manifest: { slot: number; name: string; file: string }[] = [];
  const failed: number[] = [];

  for (const slot of slots) {
    try {
      const out = await dump(slot, ctx);
      const safe = (out.name ?? `slot-${slot}`).replace(/[^A-Za-z0-9 _.-]/g, '_').trim() || `slot-${slot}`;
      const file = `${String(slot).padStart(3, '0')}-${safe}.syx`;
      fs.writeFileSync(path.join(dir, file), Buffer.from(out.bytes));
      manifest.push({ slot, name: out.name ?? '', file });
    } catch (err) {
      failed.push(slot);
      console.error(`  backup FAILED slot ${slot}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (manifest.length % 100 === 0 && manifest.length > 0) console.log(`  backed up ${manifest.length}/${slots.length}`);
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ device: 'microfreak', presets: manifest, failed }, null, 2));
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} slot(s) could not be backed up (${failed.slice(0, 5).join(', ')}…). ` +
      `Refusing to overwrite what could not be saved first. Re-run with --no-backup only if you accept losing them.`,
    );
  }
  return manifest.length;
}

function categoryName(c: number): string {
  return MICROFREAK_CATEGORIES[c] ?? `type ${c}`;
}

/** Where the category changes, i.e. the block layout the reorg encodes. */
function categoryBlocks(slots: readonly LibrarySlot[]): string[] {
  const out: string[] = [];
  let runStart = 0;
  for (let i = 1; i <= slots.length; i++) {
    if (i === slots.length || slots[i]!.category !== slots[runStart]!.category) {
      if (i - runStart >= 4) {
        out.push(`  ${String(slots[runStart]!.slot).padStart(3)}-${String(slots[i - 1]!.slot).padEnd(3)} ` +
          `${categoryName(slots[runStart]!.category).padEnd(11)} ${i - runStart} presets  (${slots[runStart]!.name})`);
      }
      runStart = i;
    }
  }
  return out;
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const entries = new AdmZip(args.file).getEntries()
    .filter((e) => !e.isDirectory && e.entryName.endsWith('.mbp'))
    .map((e) => ({ path: e.entryName, bytes: new Uint8Array(e.getData()) }));
  const { slots, unparsed } = parseLibrary(entries);

  if (unparsed.length > 0) {
    console.error(`REFUSING: ${unparsed.length} of ${entries.length} archive entries did not parse as MicroFreak presets.`);
    console.error(`  e.g. ${unparsed.slice(0, 3).join('\n       ')}`);
    console.error('A short library would leave the device half-written. Fix the archive first.');
    process.exit(1);
  }

  const targets = slots.filter((s) => s.slot >= args.from && s.slot <= args.to && s.payload !== undefined);
  const empties = slots.filter((s) => s.slot >= args.from && s.slot <= args.to && s.payload === undefined);

  console.log(`Library : ${path.basename(args.file)}`);
  console.log(`Parsed  : ${slots.length} slots, ${slots.filter((s) => s.payload).length} with content`);
  console.log(`Range   : ${args.from}..${args.to} -> ${targets.length} to write${empties.length > 0 ? `, ${empties.length} empty (skipped)` : ''}`);
  console.log('Layout  :');
  for (const line of categoryBlocks(targets)) console.log(line);
  console.log(`Head    : ${targets.slice(0, 6).map((s) => `${s.slot}=${s.name}`).join(', ')}`);

  if (args.dryRun) { console.log('\n--dry-run: nothing sent.'); return; }

  const plan = args.canary ? targets.slice(0, 1) : targets;
  // 201 ms measured for a 146-frame read; the write adds a metadata/confirm/
  // begin trio plus two name queries, so quote generously and correct from
  // the real per-slot figure this run prints.
  const backupDir = path.join(os.homedir(), 'mcp-midi-backups',
    `microfreak-pre-send-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  const estimateSec = Math.ceil((plan.length * (args.backup ? 650 : 400)) / 1000);
  console.log(`\nWill overwrite ${plan.length} slot(s) on the MicroFreak. Estimated ${estimateSec}s.`);
  console.log('This device has no separate save step: each write persists immediately and cannot be undone from here.');
  console.log(args.backup
    ? `Backup first : ${backupDir}\n               (byte-exact .syx per slot; send them back with --file on a rebuilt archive, or import_preset one at a time)`
    : 'Backup       : SKIPPED (--no-backup). Your only restore is the MCC "Recall to Computer" export.');

  if (!args.yes) {
    const answer = await ask(`\nType the number of slots to confirm (${plan.length}), anything else aborts: `);
    if (answer.trim() !== String(plan.length)) { console.log('Aborted. Nothing sent.'); return; }
  }

  const results: { slot: number; name: string; ok: boolean; ms: number; detail?: string }[] = [];
  let consecutiveFailures = 0;
  const started = Date.now();

  // The journal is this script's resume record, so it must survive the
  // failures most likely to interrupt a multi-minute run: a transport death
  // between slots, a device_busy refusal, or a throwing canary read-back.
  // Writing it only after a clean return loses exactly the cases it exists for.
  const writeJournal = (): void => {
    const okSlots = results.filter((r) => r.ok);
    fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
    fs.writeFileSync(JOURNAL, JSON.stringify({
      library: args.file, range: [args.from, args.to], canary: args.canary,
      written: okSlots.length,
      failed: results.filter((r) => !r.ok).map((f) => ({ slot: f.slot, name: f.name, detail: f.detail })),
      last_ok_slot: okSlots.at(-1)?.slot,
      avg_ms_per_slot: results.length > 0 ? Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length) : 0,
    }, null, 2));
  };

  try {
    await withEndpoint(MICROFREAK_DESCRIPTOR, async (ctx: DispatchCtx) => {
    const restore = MICROFREAK_DESCRIPTOR.writer.restorePresetBinary;
    if (restore === undefined) throw new Error('MicroFreak descriptor has no restorePresetBinary.');

    if (args.backup) {
      console.log(`\nBacking up ${plan.length} slot(s) before writing…`);
      const saved = await backupRange(ctx, plan.map((p) => p.slot), backupDir);
      console.log(`  ${saved} preset(s) saved to ${backupDir}`);
    }

    console.log(`\nWriting ${plan.length} slot(s)…`);
    // Timed from HERE, not from `started`: the backup sweep above is minutes of
    // wall clock and folding it in makes the first ETA read several times the
    // real one, which is worse than no ETA.
    const writeStarted = Date.now();
    for (const target of plan) {
      const t0 = Date.now();
      let ok = false;
      let detail: string | undefined;
      try {
        const outcome = await restore(ctx, presetPayloadToDumpBytes(target.payload!), {
          target_location: target.slot,
          save_authorized: true,
          confirm_overwrite: true,
          name: target.name,
          preset_type: target.category,
        });
        ok = outcome.ok;
        detail = outcome.warning;
      } catch (err) {
        detail = err instanceof Error ? err.message : String(err);
      }
      const ms = Date.now() - t0;
      results.push({ slot: target.slot, name: target.name, ok, ms, detail });

      if (ok) consecutiveFailures = 0;
      else {
        consecutiveFailures++;
        console.error(`  FAIL slot ${target.slot} "${target.name}": ${detail ?? 'unknown'}`);
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_ABORT) {
          console.error(`\nABORTING after ${CONSECUTIVE_FAILURE_ABORT} consecutive failures: the transport is gone, not the slot.`);
          break;
        }
      }
      if (results.length % 25 === 0 || results.length === plan.length) {
        const done = results.length;
        const rate = (Date.now() - writeStarted) / done;
        console.log(`  ${done}/${plan.length} slots  (${Math.round(rate)} ms/slot, ~${Math.ceil((plan.length - done) * rate / 1000)}s left)`);
      }
    }

    // Canary: an independent read-back, diffed byte for byte. The write path's
    // own receipt only proves the NAME came back; this proves the payload did.
    if (args.canary && results[0]?.ok === true) {
      const dump = MICROFREAK_DESCRIPTOR.reader.dumpStoredPresetBinary;
      if (dump !== undefined) {
        const target = plan[0]!;
        const readBack = await dump(target.slot, ctx);
        const got: number[] = [];
        const raw = readBack.bytes;
        for (let i = 0; i < raw.length; i += 42) got.push(...Array.from(raw.slice(i + 9, i + 41)));
        const want = target.payload!;
        const diffs = want.filter((v, i) => v !== got[i]).length;
        console.log(`\nCanary read-back: ${got.length} payload bytes, ${diffs} differ from the source.`);
        console.log(diffs === 0 ? 'BYTE-EXACT.' : 'MISMATCH: do not run the batch.');
      }
    }
    }, { opName: 'microfreak-send-library' });
  } finally {
    writeJournal();
  }

  const okCount = results.filter((r) => r.ok).length;
  const failures = results.filter((r) => !r.ok);
  const elapsed = Math.round((Date.now() - started) / 1000);
  const avg = results.length > 0 ? Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length) : 0;

  console.log(`\n${okCount}/${plan.length} written in ${elapsed}s (${avg} ms/slot). Journal: ${JOURNAL}`);
  for (const w of results.filter((r) => r.ok && r.detail !== undefined)) {
    console.log(`  note slot ${w.slot}: ${w.detail}`);
  }
  if (failures.length > 0) {
    const resumeFrom = failures[0]!.slot;
    console.error(`${failures.length} FAILED. Resume with --from ${resumeFrom} --to ${args.to} --yes once the cause is fixed.`);
    process.exitCode = 1;
  }
}

// An open MIDI port keeps the event loop alive, so `process.on('exit')` --
// where transport.ts hangs its own cleanup -- can never fire on its own. A
// standalone script must close the ports itself or it hangs after finishing,
// still holding the instance lock: the next run then refuses with
// `port_held_elsewhere` pointing at a process that already did its work.
main()
  .catch((err) => {
    console.error(`send-library failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => { closeAllMidiConnections(); });
