/**
 * BK-084 follow-up: does the ATOMIC image-patch path (batch >= threshold)
 * actually refuse a param targeting an unplaced block, per-entry, without
 * corrupting the other ops in the same batch? `setParamsAtomic.ts`'s own
 * doc comment claims this is redundant-safe ("the image patch pipeline
 * already refuses... any block absent from the dump's TLV chain") but
 * that claim had never been hardware-exercised. The original
 * dispatcher-stress Phase H tested the wrong path (2 ops, below the
 * threshold=4, routed through the INDIVIDUAL per-op writer instead, which
 * never gated on placement even before BK-084 -- that's pre-existing,
 * unrelated behavior, not a regression). This is the real replacement for
 * the deleted `collectRetuneStructuralErrors` whole-batch gate: a
 * per-entry refusal inside the atomic path itself.
 *
 * Location 666 (founder-authorized disposable). Working-buffer only,
 * self-restoring.
 *
 * Run:  npx tsx scripts/_research/probe-set-params-atomic-unplaced-refusal.ts
 */

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeSetParams } from '@mcp-midi-control/core/protocol-generic/dispatcher/params.js';
import { ensureConnection } from '@mcp-midi-control/core/server-shared/connections.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { dumpWorkingBufferBytes } from '@mcp-midi-control/fractal-gen2/descriptor/patchDumpIo.js';
import { restorePresetBinaryAxeFxII } from '@mcp-midi-control/fractal-gen2/descriptor/presetRestore.js';

registerDevice(AXEFX2_DESCRIPTOR);
const PORT = 'axe-fx-ii';

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function main(): Promise<void> {
  console.log('── BK-084 follow-up: atomic-path per-entry unplaced-block refusal (Axe-Fx II XL+, location 666) ──');
  const conn = ensureConnection('axe-fx-ii');
  const ctx = { conn, descriptor: AXEFX2_DESCRIPTOR, reconnect: async () => ensureConnection('axe-fx-ii', true) } as unknown as DispatchCtx;

  const baseline = await dumpWorkingBufferBytes(ctx);
  console.log(`  baseline dumped (${baseline.length} B)`);

  try {
    console.log('\nBatch: 5 continuous ops (>= threshold=4, forces atomic), 4 targeting placed blocks + 1 targeting an unplaced block (pitch)...');
    const r = await executeSetParams({
      port: PORT,
      ops: [
        { block: 'amp', name: 'bass', value: 6.2 },
        { block: 'amp', name: 'treble', value: 6.4 },
        { block: 'amp', name: 'presence', value: 6.6 },
        { block: 'amp', name: 'master_volume', value: 6.8 },
        { block: 'pitch', name: 'mix', value: 50 }, // NOT placed in this preset
      ],
    });
    const applyPath = (r as { apply_path?: string }).apply_path;
    check('atomic path engaged (apply_path=preset-image)', applyPath === 'preset-image', String(applyPath));
    check('4 placed-block ops acked', r.acked_count === 4, `acked=${r.acked_count}`);
    check('1 unplaced-block op refused (per-entry, not a whole-batch gate)', r.unacked_count === 1, `unacked=${r.unacked_count}`);
    const pitchResult = r.writes.find((w) => w.name === 'mix' && w.acked === false);
    check('the refused entry is specifically the pitch write, with a placement-related warning', pitchResult !== undefined && /place|grid|not.*chain|absent/i.test(pitchResult.warning ?? ''), JSON.stringify(pitchResult));

    const post = await dumpWorkingBufferBytes(ctx);
    check('buffer not left in an unknown/corrupted state (a fresh dump succeeds)', post.length > 0, `${post.length} B`);
  } finally {
    console.log('\nRestoring baseline...');
    const restore = await restorePresetBinaryAxeFxII(ctx, baseline).catch((err) => ({ ok: false, nacks: [{ detail: String(err) }] }));
    check('baseline restored (0 NACKs)', restore.ok, 'nacks' in restore ? `${restore.nacks.length} NACK(s)` : '');
    const after = await dumpWorkingBufferBytes(ctx).catch(() => undefined);
    if (after !== undefined) check('working buffer byte-identical to baseline after restore', bytesEqual(after, baseline));
  }

  console.log(`\n${pass} PASS, ${fail} FAIL.`);
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 200);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
