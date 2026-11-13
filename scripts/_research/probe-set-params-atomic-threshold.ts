/**
 * HW-133 leg 1: BK-084 mode-collapse `SET_PARAMS_ATOMIC_THRESHOLD` timing
 * measurement (Axe-Fx II XL+), non-interactive.
 *
 * `setParamsAtomic.ts`'s threshold (currently 4) is PROVISIONAL, guessed
 * pending exactly this measurement (design doc open question #1): "time N
 * sequential set_param-shaped writes for N = 1..6 against one atomic push,
 * find the crossover, don't eyeball it."
 *
 * Drives the REAL public dispatcher entry point `executeSetParams` (the
 * exact function the `set_params` MCP tool calls) for N = 1..6 amp knobs,
 * imported directly from THIS worktree's source (independent of whatever
 * server the Desktop session has loaded, same rationale as
 * probe-ii-retune-dispatcher-stress.ts). Below the threshold (N < 4 today)
 * this naturally exercises the individual-write path; at/above it, the
 * REAL atomic image path fires — no bypassing, no synthetic timing, this
 * is the exact code path a live set_params call takes today.
 *
 * IMPORTANT HONESTY NOTE (read before changing the constant from this data
 * alone): individual fn=0x2e writes are fire-and-forget with no awaited
 * ack, so N of them completing is near-instantaneous almost regardless of
 * N — raw wall-clock time will essentially NEVER favor the atomic path,
 * whose ~4s dump/patch/push/verify cost is roughly CONSTANT regardless of
 * N. The atomic path's value proposition was never "faster," it's "one
 * clean transition, no audible stepping between knobs" (retuneApply.ts's
 * own bench language). This probe measures the objective numbers
 * (individual-path wall time per N, atomic-path fixed cost) so the
 * threshold decision is evidence-based, but the actual PERCEPTUAL
 * crossover, how many discrete audible steps stop feeling smooth, is a
 * listening judgment only the founder can make. Report the numbers, don't
 * silently pick a "winner" from timing alone.
 *
 * Self-restoring: reads each knob's CURRENT display value before touching
 * anything, nudges it by a small safe delta for the timed write, restores
 * the exact original value after EVERY trial (not just at the end), and
 * verifies the restore via a read-back. Working-buffer only; no
 * save_authorized anywhere in this script.
 *
 * Preconditions: Axe-Fx II XL+ connected, an Amp block placed anywhere in
 * the active working-buffer preset (any preset with an amp works).
 *
 * Run:  npx tsx scripts/_research/probe-set-params-atomic-threshold.ts
 */

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeGetParam, executeSetParams } from '@mcp-midi-control/core/protocol-generic/dispatcher/params.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { SET_PARAMS_ATOMIC_THRESHOLD } from '@mcp-midi-control/fractal-gen2/descriptor/setParamsAtomic.js';

registerDevice(AXEFX2_DESCRIPTOR);

const PORT = 'axe-fx-ii';
// Six known-calibrated continuous amp knobs (packages/fractal-midi
// gen2/axe-fx-ii/params.ts) -- covers the full N=1..6 range the design
// doc's open question names.
const KNOBS = ['bass', 'middle', 'treble', 'master_volume', 'presence', 'depth'] as const;
const NUDGE = 0.3; // small, safe, easily-restored delta

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}

async function main(): Promise<void> {
  console.log('── HW-133: SET_PARAMS_ATOMIC_THRESHOLD timing measurement (Axe-Fx II XL+) ──');
  console.log(`  current provisional threshold: ${SET_PARAMS_ATOMIC_THRESHOLD}`);

  console.log('\nPhase A: read original values (for restore) ...');
  const originals: number[] = [];
  for (const name of KNOBS) {
    const r = await executeGetParam({ port: PORT, block: 'amp', name });
    const dv = typeof r.display_value === 'number' ? r.display_value : Number(r.display_value);
    check(`A: amp.${name} read as a number`, Number.isFinite(dv), `got ${JSON.stringify(r.display_value)}`);
    originals.push(dv);
  }
  if (fail > 0) {
    console.error('\nAborting: could not read baseline values safely (is an amp placed?).');
    process.exit(1);
  }
  console.log(`  originals: ${KNOBS.map((n, i) => `${n}=${originals[i]}`).join(', ')}`);

  async function restore(n: number): Promise<void> {
    await executeSetParams({
      port: PORT,
      ops: KNOBS.slice(0, n).map((name, i) => ({ block: 'amp', name, value: originals[i] })),
    });
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // All 6 knobs are registered 0..10 (params.ts displayMin/displayMax); a
  // uniform +NUDGE would overflow a knob already near 10 (master_volume
  // read 10 exactly on this device) and a uniform -NUDGE would underflow
  // one near 0 (presence/depth both read 0). Nudge toward the center
  // instead: down if already high, up otherwise. Safe for any value
  // actually observed in the 0..10 range.
  const nudgeFor = (original: number): number => (original + NUDGE <= 9.5 ? NUDGE : -NUDGE);

  interface Trial { n: number; elapsedMs: number; applyPath: string | undefined; ackedCount: number; restoredOk: boolean }
  const trials: Trial[] = [];

  try {
    for (let n = 1; n <= KNOBS.length; n++) {
      console.log(`\nPhase B.${n}: set_params batch of ${n} amp knob(s) ...`);
      const ops = KNOBS.slice(0, n).map((name, i) => ({ block: 'amp', name, value: originals[i] + nudgeFor(originals[i]) }));
      const started = Date.now();
      const result = await executeSetParams({ port: PORT, ops });
      const elapsedMs = Date.now() - started;
      const applyPath = (result as { apply_path?: string }).apply_path;
      check(`B.${n}: acked_count === ${n}`, result.acked_count === n, `got ${result.acked_count}, unacked=${result.unacked_count}`);
      console.log(`    elapsed=${elapsedMs} ms, apply_path=${applyPath ?? '(individual, below threshold)'}`);

      // Restore + verify via a fresh read before moving to the next trial.
      // Settle first: fn=0x2e writes are fire-and-forget, and an immediate
      // GET can race a write still in flight (observed on this device: an
      // unsettled read-back on the very first trial reported the pre-
      // restore nudged value).
      await restore(n);
      await sleep(150);
      const verify = await executeGetParam({ port: PORT, block: 'amp', name: KNOBS[0] });
      const vdv = typeof verify.display_value === 'number' ? verify.display_value : Number(verify.display_value);
      const restoredOk = Math.abs(vdv - originals[0]) < 0.05;
      check(`B.${n}: restore verified (amp.${KNOBS[0]} back to ${originals[0]})`, restoredOk, `read back ${vdv}`);

      trials.push({ n, elapsedMs, applyPath, ackedCount: result.acked_count, restoredOk });
    }
  } finally {
    // Belt-and-suspenders full restore regardless of where the loop stopped.
    await restore(KNOBS.length).catch((err) => console.error('final restore failed:', err));
  }

  console.log('\n── Timing table ──');
  console.log('  N | elapsed_ms | path');
  for (const t of trials) {
    console.log(`  ${t.n} | ${t.elapsedMs} | ${t.applyPath ?? 'individual'}`);
  }

  const individualTrials = trials.filter((t) => t.applyPath === undefined);
  const atomicTrials = trials.filter((t) => t.applyPath === 'preset-image');
  if (individualTrials.length > 0) {
    const maxIndividual = Math.max(...individualTrials.map((t) => t.elapsedMs));
    console.log(`\n  individual-path max elapsed (N=1..${individualTrials.length}): ${maxIndividual} ms`);
  }
  if (atomicTrials.length > 0) {
    const avgAtomic = Math.round(atomicTrials.reduce((a, t) => a + t.elapsedMs, 0) / atomicTrials.length);
    console.log(`  atomic-path average elapsed (N=${atomicTrials.map((t) => t.n).join(',')}): ${avgAtomic} ms`);
  }
  console.log(
    '\n  NOTE: raw wall-clock time will almost always favor individual writes (fire-and-forget,\n' +
    '  near-instant) regardless of N; the atomic path\'s fixed ~4s cost buys ONE clean\n' +
    '  transition instead of N audible steps. This data confirms/updates the atomic path\'s\n' +
    '  actual fixed cost on real hardware; the perceptual "how many steps stop sounding\n' +
    '  smooth" crossover needs a listening pass, not just this table.',
  );

  console.log(`\n${pass} PASS, ${fail} FAIL.`);
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 200);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
