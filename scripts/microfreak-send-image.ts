/**
 * Send a BUILT MicroFreak library image (a `plan.json` plus one `.syx` per slot)
 * to the device, slot by slot, over this server's hardware-confirmed
 * `import_preset` write path.
 *
 * Sibling of `microfreak-send-library.ts`, which sends an MCC `.mfprojz`
 * verbatim. This one sends an image we BUILT: presets reordered into the blocks
 * declared by `docs/_private/rig/microfreak-layout.json`, with their stored
 * Preset Volume normalized. The builder emits the plan; this script only drives
 * the loop, exactly the same split, so both can be lifted into a future
 * `restore_device` unchanged.
 *
 * DESTRUCTIVE. Every slot in the plan is overwritten and this device has no
 * separate save step: a stored-slot SysEx write IS the persist. Take a
 * `backup_device` sweep first.
 *
 * Usage:
 *   npx tsx scripts/microfreak-send-image.ts --dir <imageDir> [options]
 *
 *   --dir DIR       Directory holding plan.json and the per-slot .syx files.
 *   --from N --to N Restrict to a device slot range (default: the whole plan).
 *   --canary        Write ONLY the first slot in range, then read it back.
 *   --dry-run       Parse, validate and report; touch no hardware.
 *   --yes           Skip the typed confirmation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import { MICROFREAK_DESCRIPTOR } from '../packages/arturia/src/descriptor.js';
import { MICROFREAK_CATEGORIES, presetPayloadToDumpBytes } from '../packages/arturia/src/codec/mfprojz.js';
import { withEndpoint } from '../packages/core/src/protocol-generic/dispatcher/core.js';
import { closeAllMidiConnections } from '../packages/core/src/midi/transport.js';
import type { DispatchCtx } from '../packages/core/src/protocol-generic/types.js';

/** Stop after this many consecutive failures: the transport is gone, not the slot. */
const CONSECUTIVE_FAILURE_ABORT = 3;
const PAYLOAD_BYTES = 4672;

interface PlanEntry {
  slot: number;
  name: string;
  block: string;
  tag: string | null;
  file: string;
  init?: boolean;
}

/**
 * Pull the 4672-byte payload back out of a 146-frame dump file. Each frame is
 * `F0 00 20 6B 07 01 <seq> 0x20 <0x16|0x17> <32 bytes> F7`; the sequence byte is
 * transport bookkeeping and is ignored.
 */
function payloadFromDump(bytes: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 42 <= bytes.length; i += 42) {
    const f = bytes.subarray(i, i + 42);
    if (f[0] !== 0xf0 || f[41] !== 0xf7 || f[7] !== 0x20) {
      throw new Error(`malformed frame at byte ${i}`);
    }
    for (let k = 9; k < 41; k++) out.push(f[k]);
  }
  if (out.length !== PAYLOAD_BYTES) {
    throw new Error(`expected ${PAYLOAD_BYTES} payload bytes, got ${out.length}`);
  }
  return out;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const dir = arg('--dir');
  if (dir === undefined) { console.error('--dir <imageDir> is required.'); process.exit(2); }
  const dryRun = process.argv.includes('--dry-run');
  const canary = process.argv.includes('--canary');
  const yes = process.argv.includes('--yes');
  const from = Number(arg('--from') ?? 1);
  const to = Number(arg('--to') ?? 512);

  const plan: PlanEntry[] = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  let targets = plan.filter((p) => p.slot >= from && p.slot <= to);
  if (canary) targets = targets.slice(0, 1);

  // Validate the WHOLE range before touching hardware: a file that fails to
  // parse halfway through a 512-slot write is a half-written library.
  const loaded = targets.map((t) => {
    const raw = fs.readFileSync(path.join(dir, t.file));
    const payload = payloadFromDump(raw);
    const category = t.tag === null ? 0 : Math.max(0, MICROFREAK_CATEGORIES.indexOf(t.tag as never));
    return { ...t, payload, category };
  });
  console.log(`Validated ${loaded.length} slot(s); every payload is ${PAYLOAD_BYTES} bytes.`);

  const blocks = new Map<string, number>();
  for (const t of loaded) blocks.set(t.block, (blocks.get(t.block) ?? 0) + 1);
  console.log([...blocks].map(([b, n]) => `${b}:${n}`).join('  '));

  if (dryRun) { console.log('\n--dry-run: no hardware touched.'); return; }

  const seconds = Math.ceil((loaded.length * 260) / 1000);
  console.log(`\nDESTRUCTIVE: overwrites slots ${loaded[0].slot}..${loaded[loaded.length - 1].slot}. ~${seconds}s.`);
  if (!yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((r) => rl.question('Type SEND to continue: ', r));
    rl.close();
    if (answer.trim() !== 'SEND') { console.log('Aborted.'); return; }
  }

  const restore = MICROFREAK_DESCRIPTOR.writer.restorePresetBinary;
  if (restore === undefined) throw new Error('MicroFreak descriptor has no restorePresetBinary.');

  const results: { slot: number; name: string; ok: boolean; detail?: string }[] = [];
  let consecutiveFailures = 0;
  const started = Date.now();

  await withEndpoint(MICROFREAK_DESCRIPTOR, async (ctx: DispatchCtx) => {
    for (const t of loaded) {
      let ok = false;
      let detail: string | undefined;
      try {
        const outcome = await restore(ctx, presetPayloadToDumpBytes(t.payload), {
          target_location: t.slot,
          save_authorized: true,
          confirm_overwrite: true,
          name: t.name,
          preset_type: t.category,
        });
        ok = outcome.ok;
        detail = outcome.warning;
      } catch (err) {
        detail = err instanceof Error ? err.message : String(err);
      }
      results.push({ slot: t.slot, name: t.name, ok, detail });
      if (ok) consecutiveFailures = 0;
      else {
        consecutiveFailures++;
        console.error(`  FAIL slot ${t.slot} "${t.name}": ${detail ?? 'unknown'}`);
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_ABORT) {
          console.error(`\nABORTING after ${CONSECUTIVE_FAILURE_ABORT} consecutive failures: the transport is gone, not the slot.`);
          break;
        }
      }
      if (results.length % 32 === 0 || results.length === loaded.length) {
        const rate = (Date.now() - started) / results.length;
        console.log(`  ${results.length}/${loaded.length}  (${Math.round(rate)} ms/slot, ~${Math.ceil((loaded.length - results.length) * rate / 1000)}s left)`);
      }
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${loaded.length} written in ${Math.round((Date.now() - started) / 1000)}s.`);
  if (failed.length > 0) {
    console.error(`${failed.length} FAILED: ${failed.slice(0, 10).map((f) => f.slot).join(', ')}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  // An open MIDI port keeps Node's event loop alive, so `process.on('exit')`
  // cleanup can never fire and the script hangs holding the instance lock.
  .finally(() => { closeAllMidiConnections(); });
