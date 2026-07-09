/**
 * AM4 fn 0x1F: per-block position map for every audio block.
 *
 * Generalizes `probe-am4-fn1f-amp-positions.ts` to cover every shipped
 * audio block. Hypothesis (from Session 122 amp probe + KNOWN_PARAMS
 * inspection):
 *
 *     effectId == pidLow      (block routing byte from the SET envelope)
 *     chunkPosition == pidHigh (offset within the per-block u16 chunk)
 *
 * Confirmed for amp (effectId 58, pidLow 0x003a). This script tests the
 * same rule for 16 other blocks: compressor, geq, peq, reverb, delay,
 * chorus, flanger, rotary, phaser, wah, volpan, tremolo, filter, drive,
 * enhancer, gate. (ingate skipped: no writable knob_0_10 / percent
 * candidates — `gain_monitor` is a read-only meter.)
 *
 * Per param under test:
 *   1. Baseline the expected effectId chunk (single read up front, cached).
 *   2. Write a sentinel display value.
 *   3. Re-read the expected chunk; record diffs.
 *   4. Validate: exactly one position changed AND position == pidHigh AND
 *      after-value == round(internalFloat × 65534).
 *   5. Restore the original value by decoding the baseline u16 back to
 *      display via the unit's inverse (knob_0_10: u16/65534*10; percent:
 *      u16/65534*100), then writing it back.
 *
 * Post-probe: verifies restoration by re-reading each probed effectId
 * chunk and diffing against the captured baseline. Any drift is flagged.
 *
 * Output: samples/captured/decoded/am4-fn1f-all-blocks-position-map.json
 *
 * SAFETY NOTES:
 * - This probe writes to many working-buffer params. Discard or reload
 *   the preset after running (the working buffer is non-persistent, so
 *   no harm survives a preset reload).
 * - Type-conditional params may show "no diff" if the current preset's
 *   block-type doesn't expose them. Those rows are flagged but don't
 *   fail the run.
 *
 * Run with AM4 powered + USB connected + AM4-Edit closed:
 *   npx tsx scripts/_research/probe-am4-fn1f-all-blocks-positions.ts
 */
import midi from "@julusian/midi";
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  KNOWN_PARAMS,
  buildSetFloatParam,
  buildGetAllParams,
  encode,
  type ParamKey,
} from 'fractal-midi/am4';

const AM4_MODEL = 0x15;
const SYSEX_START = 0xf0;

// Read-only meters (writing is a no-op or dangerous). Skip from probe targets.
const READONLY_KEYS = new Set<string>([
  'ingate.gain_monitor',
  'compressor.gain_monitor',
  'gate.gain_monitor',
  'amp.cab_gain_monitor',
]);

type BlockProbe = {
  block: string;
  effectId: number;     // expected; == pidLow per hypothesis
  pidLow: number;       // observed from KNOWN_PARAMS
  paramKeys: ParamKey[];
};

/** Build per-block probe targets: up to 4 first-page knob_0_10/percent params. */
function buildBlockProbes(): BlockProbe[] {
  const blocks = [
    'compressor', 'geq', 'peq', 'reverb', 'delay', 'chorus',
    'flanger', 'rotary', 'phaser', 'wah', 'volpan', 'tremolo',
    'filter', 'drive', 'enhancer', 'gate',
  ];
  const out: BlockProbe[] = [];
  for (const block of blocks) {
    const candidates = (Object.entries(KNOWN_PARAMS) as [ParamKey, any][])
      .filter(([k, p]) => p.block === block)
      .filter(([k, p]) => (p.unit === 'knob_0_10' || p.unit === 'percent'))
      .filter(([k]) => !READONLY_KEYS.has(k))
      .sort(([, a], [, b]) => a.pidHigh - b.pidHigh);
    if (candidates.length === 0) {
      console.warn(`[warn] no probe candidates for block "${block}", skipping`);
      continue;
    }
    const pidLow = (candidates[0][1] as any).pidLow as number;
    out.push({
      block,
      effectId: pidLow, // hypothesis under test
      pidLow,
      paramKeys: candidates.slice(0, 4).map(([k]) => k),
    });
  }
  return out;
}

function decode14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}
function decode16Packed(b0: number, b1: number, b2: number): number {
  return (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
}
function isAm4Fn(bytes: number[], fn: number): boolean {
  return (
    bytes.length >= 7
    && bytes[0] === SYSEX_START && bytes[1] === 0x00 && bytes[2] === 0x01
    && bytes[3] === 0x74 && bytes[4] === AM4_MODEL && bytes[5] === fn
  );
}
function decodeChunkPayload(bytes: number[]): number[] {
  const itemCount = decode14(bytes[6], bytes[7]);
  const out: number[] = [];
  const start = 8;
  const end = bytes.length - 2;
  for (let i = 0; i < itemCount; i++) {
    const off = start + i * 3;
    if (off + 2 >= end) break;
    out.push(decode16Packed(bytes[off], bytes[off + 1], bytes[off + 2]));
  }
  return out;
}

function pickPort(instance: midi.Input | midi.Output, label: string): number {
  const n = instance.getPortCount();
  for (let i = 0; i < n; i++) {
    if (/AM4|Fractal.*AM4/i.test(instance.getPortName(i))) return i;
  }
  throw new Error(`No AM4 ${label} port`);
}

/** Inverse of `encode` for the two probe-friendly units. */
function u16ToDisplay(unit: 'knob_0_10' | 'percent', u16: number): number {
  const frac = u16 / 65534;
  if (unit === 'knob_0_10') return frac * 10;
  return frac * 100;
}

/** Pick a sentinel display value that's distinct from the current value. */
function pickSentinel(unit: 'knob_0_10' | 'percent', currentDisplay: number): number {
  // For knob_0_10: pick 3.0 unless current is ~3, then 7.0.
  // For percent: pick 30 unless current is ~30, then 70.
  if (unit === 'knob_0_10') {
    return Math.abs(currentDisplay - 3.0) > 0.5 ? 3.0 : 7.0;
  }
  return Math.abs(currentDisplay - 30) > 5 ? 30 : 70;
}

type ParamResult = {
  paramKey: ParamKey;
  pidLow: number;
  pidHigh: number;
  unit: 'knob_0_10' | 'percent';
  baselineU16: number;
  baselineDisplay: number;
  sentinelDisplay: number;
  expectedWire: number;
  observedDiffs: { position: number; before: number; after: number }[];
  ruleHolds: boolean;
  wireMatches: boolean;
  note?: string;
};

type BlockResult = {
  block: string;
  effectId: number;
  pidLow: number;
  baselineLength: number;
  params: ParamResult[];
  restorationDrift: { position: number; before: number; after: number }[];
};

async function main(): Promise<void> {
  const probes = buildBlockProbes();
  console.log(`Probing ${probes.length} blocks (${probes.reduce((n, b) => n + b.paramKeys.length, 0)} params total).`);
  for (const p of probes) {
    console.log(`  ${p.block.padEnd(12)} effectId=${p.effectId.toString().padStart(3)} pidLow=0x${p.pidLow.toString(16).padStart(4, '0')}  params=[${p.paramKeys.join(', ')}]`);
  }
  console.log();

  const input = new midi.Input();
  const output = new midi.Output();
  input.ignoreTypes(false, true, true);
  input.openPort(pickPort(input, 'input'));
  output.openPort(pickPort(output, 'output'));
  console.log('AM4 ports opened.');

  const frames: number[][] = [];
  let active = false;
  input.on('message', (_dt, msg) => { if (active) frames.push([...msg]); });
  const capture = async <T>(work: () => Promise<T>, waitMs = 500): Promise<number[][]> => {
    active = true;
    frames.length = 0;
    await work();
    await sleep(waitMs);
    active = false;
    const t = [...frames];
    frames.length = 0;
    return t;
  };

  const readChunk = async (effectId: number): Promise<number[]> => {
    const f = await capture(async () => { output.sendMessage(buildGetAllParams(effectId)); });
    for (const m of f) {
      if (isAm4Fn(m, 0x64) && m[6] === 0x1f) {
        throw new Error(`fn 0x1F NACK rc=0x${m[7].toString(16).padStart(2, '0')} for effectId=${effectId}`);
      }
    }
    const chunk = f.find((m) => isAm4Fn(m, 0x75));
    if (!chunk) return [];
    return decodeChunkPayload(chunk);
  };

  const writeParamDisplay = async (key: ParamKey, display: number): Promise<void> => {
    const p = KNOWN_PARAMS[key];
    await capture(async () => {
      output.sendMessage(buildSetFloatParam(p, encode(p, display)));
    }, 250);
  };

  const results: BlockResult[] = [];

  for (const probe of probes) {
    console.log(`\n[${probe.block}] effectId=${probe.effectId} pidLow=0x${probe.pidLow.toString(16).padStart(4, '0')}`);
    let baseline: number[];
    try {
      baseline = await readChunk(probe.effectId);
    } catch (err) {
      console.log(`  baseline read failed: ${err}`);
      continue;
    }
    if (baseline.length === 0) {
      console.log(`  baseline chunk empty (block not exposed by current preset?); skipping`);
      continue;
    }
    console.log(`  baseline: ${baseline.length} ushorts`);

    const blockResult: BlockResult = {
      block: probe.block,
      effectId: probe.effectId,
      pidLow: probe.pidLow,
      baselineLength: baseline.length,
      params: [],
      restorationDrift: [],
    };

    for (const key of probe.paramKeys) {
      const p = KNOWN_PARAMS[key] as any;
      const pidHigh = p.pidHigh as number;
      const unit = p.unit as 'knob_0_10' | 'percent';
      if (pidHigh >= baseline.length) {
        console.log(`  [${key}] pidHigh=0x${pidHigh.toString(16)} (${pidHigh}) exceeds chunk length ${baseline.length}; skipping`);
        blockResult.params.push({
          paramKey: key, pidLow: probe.pidLow, pidHigh, unit,
          baselineU16: -1, baselineDisplay: -1,
          sentinelDisplay: -1, expectedWire: -1,
          observedDiffs: [], ruleHolds: false, wireMatches: false,
          note: 'pidHigh outside chunk',
        });
        continue;
      }

      const baselineU16 = baseline[pidHigh];
      const baselineDisplay = u16ToDisplay(unit, baselineU16);
      const sentinelDisplay = pickSentinel(unit, baselineDisplay);
      const internalFloat = encode(p, sentinelDisplay);
      const expectedWire = Math.round(internalFloat * 65534);
      console.log(`  [${key}] pidHigh=0x${pidHigh.toString(16)} (${pidHigh}) unit=${unit} baseline u16=${baselineU16} (≈${baselineDisplay.toFixed(2)}) → sentinel display=${sentinelDisplay} (expected wire=${expectedWire})`);

      await writeParamDisplay(key, sentinelDisplay);
      const after = await readChunk(probe.effectId);
      const len = Math.min(baseline.length, after.length);
      const diffs: { position: number; before: number; after: number }[] = [];
      for (let i = 0; i < len; i++) {
        if (baseline[i] !== after[i]) diffs.push({ position: i, before: baseline[i], after: after[i] });
      }
      const expectedAt = diffs.find((d) => d.position === pidHigh);
      const ruleHolds = expectedAt !== undefined && diffs.length === 1;
      const wireMatches = expectedAt?.after === expectedWire;
      if (diffs.length === 0) {
        console.log(`     ⚠ no diff (type-conditional or no-op write)`);
      } else if (ruleHolds && wireMatches) {
        console.log(`     ✓ position ${pidHigh} matched; wire=${expectedAt!.after}`);
      } else {
        console.log(`     ! diffs at positions [${diffs.map((d) => d.position).join(', ')}]; ruleHolds=${ruleHolds} wireMatches=${wireMatches}`);
        for (const d of diffs) console.log(`         pos ${d.position}: ${d.before} → ${d.after}`);
      }

      // Restore by writing the baseline display value back.
      await writeParamDisplay(key, baselineDisplay);

      blockResult.params.push({
        paramKey: key, pidLow: probe.pidLow, pidHigh, unit,
        baselineU16, baselineDisplay,
        sentinelDisplay, expectedWire,
        observedDiffs: diffs, ruleHolds, wireMatches,
        note: diffs.length === 0 ? 'no diff (likely type-conditional)' : undefined,
      });
    }

    // Restoration sanity: re-read the chunk and compare to baseline.
    try {
      const final = await readChunk(probe.effectId);
      const len = Math.min(baseline.length, final.length);
      for (let i = 0; i < len; i++) {
        if (baseline[i] !== final[i]) blockResult.restorationDrift.push({ position: i, before: baseline[i], after: final[i] });
      }
      if (blockResult.restorationDrift.length === 0) {
        console.log(`  ✓ chunk restored cleanly`);
      } else {
        console.log(`  ⚠ restoration drift at ${blockResult.restorationDrift.length} position(s):`);
        for (const d of blockResult.restorationDrift) {
          console.log(`     pos ${d.position}: was ${d.before}, now ${d.after} (Δ${d.after - d.before})`);
        }
      }
    } catch (err) {
      console.log(`  restore-verify read failed: ${err}`);
    }

    results.push(blockResult);
  }

  input.closePort();
  output.closePort();

  mkdirSync('samples/captured/decoded', { recursive: true });
  const outPath = 'samples/captured/decoded/am4-fn1f-all-blocks-position-map.json';
  writeFileSync(outPath, JSON.stringify({
    run: new Date().toISOString(),
    hypothesis: 'effectId == pidLow AND chunkPosition == pidHigh',
    results,
  }, null, 2));

  // Console summary table.
  console.log('\n=== Per-block summary ===');
  console.log('block        eid  baseLen  paramsOk paramsTypeCond paramsViolated  restoreDrift');
  for (const r of results) {
    const ok = r.params.filter((p) => p.ruleHolds && p.wireMatches).length;
    const cond = r.params.filter((p) => p.observedDiffs.length === 0).length;
    const violated = r.params.filter((p) => p.observedDiffs.length > 0 && (!p.ruleHolds || !p.wireMatches)).length;
    console.log(
      r.block.padEnd(12)
      + r.effectId.toString().padStart(4)
      + r.baselineLength.toString().padStart(9)
      + ok.toString().padStart(10)
      + cond.toString().padStart(15)
      + violated.toString().padStart(15)
      + r.restorationDrift.length.toString().padStart(14),
    );
  }
  const totalOk = results.reduce((n, r) => n + r.params.filter((p) => p.ruleHolds && p.wireMatches).length, 0);
  const totalParams = results.reduce((n, r) => n + r.params.length, 0);
  const violated = results.flatMap((r) => r.params.filter((p) => p.observedDiffs.length > 0 && (!p.ruleHolds || !p.wireMatches)).map((p) => ({ block: r.block, ...p })));
  console.log(`\nTotal: ${totalOk}/${totalParams} params validate the rule (chunkPosition == pidHigh AND wire == round(internal × 65534)).`);
  if (violated.length > 0) {
    console.log(`\n⚠ ${violated.length} param(s) wrote diffs that violated the rule — these need follow-up:`);
    for (const v of violated) {
      console.log(`  ${v.block}.${(v.paramKey as string).split('.').pop()} pidHigh=0x${v.pidHigh.toString(16)} diffs=${JSON.stringify(v.observedDiffs)}`);
    }
  }

  console.log(`\nJSON: ${outPath}`);
  console.log('\nPOST-PROBE: the working buffer was written and restored param-by-param.');
  console.log('  Reload the active preset (switch_preset to current location) to');
  console.log('  guarantee a clean state before normal use.');
}

main().catch((err) => { console.error('FATAL:', err); process.exitCode = 1; });
