/**
 * Full per-position encoding sweep for the Axe-Fx II state-broadcast triple.
 *
 * For each placed block, iterates every position in the fn=0x1F state-dump
 * and classifies the encoding type by writing two known display values via
 * fn=0x2e and observing the state-dump delta.
 *
 * Classification:
 *   wire16      - state ≈ display * 6553.4  (65534/10 for 0..10 knobs)
 *   display_int - state ≈ round(display)    (integer display value)
 *   readonly    - no state change on write
 *   unknown     - other (logged for manual review)
 *
 * After sweeping a block, switches preset away and back to discard working-
 * buffer mutations. No permanent changes.
 *
 * Usage:
 *   npx tsx scripts/_research/probe-axefx2-encoding-sweep.ts [block-names...]
 *
 * Examples:
 *   npx tsx scripts/_research/probe-axefx2-encoding-sweep.ts          # all 21
 *   npx tsx scripts/_research/probe-axefx2-encoding-sweep.ts amp drive # just 2
 *
 * Output: samples/captured/decoded/encoding-sweep-results.json
 *
 * Estimated time: ~14 min for all 21 blocks (530ms per position).
 */

import midi from "@julusian/midi";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

const AXE_FX_II_MODEL = 0x07;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;

const FN_GET_ALL_PARAMS = 0x1f;
const FN_SET_PARAM_DIRECT = 0x2e;
const FN_STATE_HEADER = 0x74;
const FN_STATE_CHUNK = 0x75;
const FN_STATE_FOOTER = 0x76;
const FN_MULTIPURPOSE = 0x64;

const TRIPLE_TIMEOUT_MS = 3000;
const SETTLE_MS = 150;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}

function buildEnvelope(fn: number, payload: number[] = []): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, AXE_FX_II_MODEL, fn, ...payload];
  return [...head, fractalChecksum(head), SYSEX_END];
}

function encode14(n: number): [number, number] {
  return [n & 0x7f, (n >> 7) & 0x7f];
}

function decode14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}

function decode16Packed(b0: number, b1: number, b2: number): number {
  return (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
}

function packFloat32ForDirect(value: number): [number, number, number, number, number] {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  const bytes = new Uint8Array(buf);
  const n = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | ((bytes[3] << 24) >>> 0);
  return [n & 0x7f, (n >> 7) & 0x7f, (n >> 14) & 0x7f, (n >> 21) & 0x7f, (n >> 28) & 0x0f];
}

function findPort(io: midi.Input | midi.Output, needles: string[]): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    const name = io.getPortName(i);
    for (const n of needles) {
      if (name.toLowerCase().includes(n.toLowerCase())) return i;
    }
  }
  return -1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface DecodedTriple {
  targetId: number;
  itemCount: number;
  opFlag: number;
  values: number[];
}

function isFractalFn(bytes: number[], fn: number): boolean {
  return (
    bytes.length >= 7
    && bytes[0] === 0xf0 && bytes[1] === 0x00 && bytes[2] === 0x01
    && bytes[3] === 0x74 && bytes[4] === AXE_FX_II_MODEL && bytes[5] === fn
  );
}

function decodeChunkFrame(bytes: number[]): number[] {
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

async function readAllParams(
  output: midi.Output,
  collected: number[][],
  effectId: number,
): Promise<DecodedTriple | null> {
  const before = collected.length;
  output.sendMessage(buildEnvelope(FN_GET_ALL_PARAMS, [...encode14(effectId)]));

  const deadline = Date.now() + TRIPLE_TIMEOUT_MS;
  let header: DecodedTriple | undefined;
  const values: number[] = [];

  while (Date.now() < deadline) {
    await sleep(50);
    for (let i = before; i < collected.length; i++) {
      const frame = collected[i];
      if (isFractalFn(frame, FN_STATE_HEADER)) {
        const tId = decode14(frame[6], frame[7]);
        if (tId === effectId && !header) {
          header = { targetId: tId, itemCount: decode14(frame[8], frame[9]), opFlag: frame[10], values: [] };
        }
      } else if (isFractalFn(frame, FN_STATE_CHUNK) && header) {
        for (const v of decodeChunkFrame(frame)) values.push(v);
      } else if (isFractalFn(frame, FN_STATE_FOOTER) && header) {
        return { ...header, values };
      } else if (isFractalFn(frame, FN_MULTIPURPOSE)) {
        return null;
      }
    }
  }
  if (header) return { ...header, values };
  return null;
}

function buildSetParamDirect(effectId: number, paramId: number, displayValue: number): number[] {
  return buildEnvelope(FN_SET_PARAM_DIRECT, [
    ...encode14(effectId),
    ...encode14(paramId),
    ...packFloat32ForDirect(displayValue),
  ]);
}

function switchPreset(output: midi.Output, displayNum: number): void {
  const wire = displayNum - 1;
  const bankMSB = Math.floor(wire / 128);
  const pc = wire % 128;
  output.sendMessage([0xb0, 0x00, bankMSB]);
  output.sendMessage([0xc0, pc]);
}

async function getCurrentPreset(
  output: midi.Output,
  collected: number[][],
): Promise<number> {
  const before = collected.length;
  output.sendMessage(buildEnvelope(0x14)); // GET_PRESET_NUMBER
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await sleep(50);
    for (let i = before; i < collected.length; i++) {
      const frame = collected[i];
      if (isFractalFn(frame, 0x14) && frame.length >= 10) {
        const lo = frame[6];
        const hi = frame[7];
        return (lo | (hi << 7)) + 1; // wire → display
      }
    }
  }
  return 1; // fallback
}

type EncodingType = 'wire16' | 'display_int' | 'readonly' | 'unknown';

interface PositionResult {
  pos: number;
  type: EncodingType;
  baseline: number;
  s1: number;
  s2: number;
  scale?: number;
}

interface BlockResult {
  name: string;
  effectId: number;
  positions: number;
  encodingMap: PositionResult[];
  summary: Record<EncodingType, number>;
  durationMs: number;
}

const ALL_BLOCKS: { name: string; effectId: number; key: string }[] = [
  { name: 'Amp 1',           effectId: 106, key: 'amp' },
  { name: 'Drive 1',         effectId: 108, key: 'drive' },
  { name: 'Cab 1',           effectId: 110, key: 'cab' },
  { name: 'Delay 1',         effectId: 112, key: 'delay' },
  { name: 'Reverb 1',        effectId: 114, key: 'reverb' },
  { name: 'Compressor 1',    effectId: 116, key: 'compressor' },
  { name: 'Chorus 1',        effectId: 118, key: 'chorus' },
  { name: 'Flanger 1',       effectId: 120, key: 'flanger' },
  { name: 'Phaser 1',        effectId: 122, key: 'phaser' },
  { name: 'Wah 1',           effectId: 124, key: 'wah' },
  { name: 'Volume/Pan 1',    effectId: 127, key: 'volpan' },
  { name: 'Filter 1',        effectId: 130, key: 'filter' },
  { name: 'Pitch 1',         effectId: 132, key: 'pitch' },
  { name: 'Tremolo/Pan 1',   effectId: 134, key: 'tremolo' },
  { name: 'Rotary 1',        effectId: 136, key: 'rotary' },
  { name: 'Formant 1',       effectId: 138, key: 'formant' },
  { name: 'Enhancer 1',      effectId: 140, key: 'enhancer' },
  { name: 'FX Loop 1',       effectId: 142, key: 'fxloop' },
  { name: 'Graphic EQ 1',    effectId: 146, key: 'geq' },
  { name: 'Parametric EQ 1', effectId: 148, key: 'peq' },
  { name: 'Multi Delay 1',   effectId: 150, key: 'multidelay' },
];

// Test values: two display-unit writes per position. Using 3.0 and 7.0
// avoids boundary effects (0 might be special, 10 might clip).
const TEST_DISPLAY_A = 3.0;
const TEST_DISPLAY_B = 7.0;

function classifyPosition(baseline: number, s1: number, s2: number): { type: EncodingType; scale?: number } {
  // Both writes had no effect.
  if (s1 === baseline && s2 === baseline) {
    return { type: 'readonly' };
  }

  const delta = s2 - s1;
  const displayDelta = TEST_DISPLAY_B - TEST_DISPLAY_A; // 4.0

  if (delta === 0) {
    // Writes landed but both map to same state value (might be enum with
    // resolution coarser than our test points). If s1 != baseline, something
    // changed but we can't distinguish.
    if (s1 !== baseline) {
      return { type: 'unknown', scale: 0 };
    }
    return { type: 'readonly' };
  }

  const scalePerUnit = delta / displayDelta;

  // wire16: 65534 / displayRange. For 0..10 range, that's 6553.4 per unit.
  // Allow wide tolerance (5000..8000) to catch non-standard ranges.
  if (scalePerUnit > 4000 && scalePerUnit < 9000) {
    return { type: 'wire16', scale: scalePerUnit };
  }

  // display_int: 1:1 mapping (delta per display unit ≈ 1.0).
  if (Math.abs(scalePerUnit - 1.0) < 0.3) {
    return { type: 'display_int', scale: scalePerUnit };
  }

  // Some params have display ranges other than 0..10 (e.g. 0..100%, 20..20000 Hz).
  // These produce different scales. Report as unknown with the measured scale.
  return { type: 'unknown', scale: scalePerUnit };
}

async function sweepBlock(
  output: midi.Output,
  collected: number[][],
  block: { name: string; effectId: number },
  progressPrefix: string,
): Promise<BlockResult | null> {
  const t0 = Date.now();

  // Read baseline.
  const baseline = await readAllParams(output, collected, block.effectId);
  if (!baseline) {
    console.log(`${progressPrefix} SKIP: block not placed (NACK/timeout)`);
    return null;
  }

  const totalPositions = baseline.values.length;
  console.log(`${progressPrefix} ${block.name} (effectId=${block.effectId}, ${totalPositions} positions)`);

  const encodingMap: PositionResult[] = [];
  const summary: Record<EncodingType, number> = { wire16: 0, display_int: 0, readonly: 0, unknown: 0 };

  for (let pos = 0; pos < totalPositions; pos++) {
    const baseVal = baseline.values[pos];

    // Write test value A.
    output.sendMessage(buildSetParamDirect(block.effectId, pos, TEST_DISPLAY_A));
    await sleep(SETTLE_MS);
    const snapA = await readAllParams(output, collected, block.effectId);
    const s1 = snapA ? snapA.values[pos] : baseVal;

    // Write test value B.
    output.sendMessage(buildSetParamDirect(block.effectId, pos, TEST_DISPLAY_B));
    await sleep(SETTLE_MS);
    const snapB = await readAllParams(output, collected, block.effectId);
    const s2 = snapB ? snapB.values[pos] : baseVal;

    const { type, scale } = classifyPosition(baseVal, s1, s2);
    encodingMap.push({ pos, type, baseline: baseVal, s1, s2, scale });
    summary[type]++;

    // Progress every 20 positions.
    if ((pos + 1) % 20 === 0 || pos === totalPositions - 1) {
      const pct = Math.round(((pos + 1) / totalPositions) * 100);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `${progressPrefix}   [${pct}%] pos ${pos + 1}/${totalPositions} ` +
        `(${elapsed}s) w16=${summary.wire16} int=${summary.display_int} ` +
        `ro=${summary.readonly} unk=${summary.unknown}`
      );
    }
  }

  const durationMs = Date.now() - t0;
  console.log(
    `${progressPrefix} DONE in ${(durationMs / 1000).toFixed(1)}s: ` +
    `wire16=${summary.wire16} display_int=${summary.display_int} ` +
    `readonly=${summary.readonly} unknown=${summary.unknown}`
  );

  return { name: block.name, effectId: block.effectId, positions: totalPositions, encodingMap, summary, durationMs };
}

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('  Axe-Fx II: Full Per-Position Encoding Sweep');
  console.log('  Classifies every state-dump position for triple-write support');
  console.log('================================================================\n');

  // Parse block filter from args.
  const args = process.argv.slice(2);
  let blocksToSweep = ALL_BLOCKS;
  if (args.length > 0 && args[0] !== '--resume') {
    const keys = args.map(a => a.toLowerCase());
    blocksToSweep = ALL_BLOCKS.filter(b => keys.some(k => b.key.includes(k) || b.name.toLowerCase().includes(k)));
    if (blocksToSweep.length === 0) {
      console.error(`No blocks matched: ${args.join(', ')}`);
      console.error(`Available: ${ALL_BLOCKS.map(b => b.key).join(', ')}`);
      process.exit(1);
    }
  }

  // Always merge with existing results (preserves data from previous runs).
  const outDir = join(process.cwd(), 'samples', 'captured', 'decoded');
  const outPath = join(outDir, 'encoding-sweep-results.json');
  let existingResults: Record<string, BlockResult> = {};
  const resumeMode = args.includes('--resume');

  if (existsSync(outPath)) {
    try {
      existingResults = JSON.parse(readFileSync(outPath, 'utf-8'));
      const done = Object.keys(existingResults).length;
      console.log(`  Existing data: ${done} blocks in file`);
      if (resumeMode) console.log(`  Resume mode: will skip already-completed blocks\n`);
      else console.log(`  Will re-sweep targeted blocks, preserve others\n`);
    } catch { /* start fresh */ }
  }

  console.log(`  Blocks to sweep: ${blocksToSweep.map(b => b.key).join(', ')}`);
  console.log(`  Test values: display=${TEST_DISPLAY_A} and display=${TEST_DISPLAY_B}`);
  console.log(`  Settle time: ${SETTLE_MS}ms per write`);
  console.log(`  Output: ${outPath}\n`);

  const input = new midi.Input();
  const output = new midi.Output();

  const needles = ['Axe-Fx II', 'AxeFxII', 'AXE-FX II', 'XL+'];
  const outIdx = findPort(output, needles);
  if (outIdx < 0) { console.error('ERROR: MIDI output port not found'); process.exit(1); }
  const inIdx = findPort(input, needles);
  if (inIdx < 0) { console.error('ERROR: MIDI input port not found'); process.exit(1); }

  console.log(`  Output port: ${output.getPortName(outIdx)}`);
  console.log(`  Input port:  ${input.getPortName(inIdx)}\n`);

  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);
  const collected: number[][] = [];
  input.on('message', (_dt: number, bytes: number[]) => {
    if (bytes[0] === 0xf0) collected.push(bytes.slice());
  });
  input.openPort(inIdx);
  await sleep(500);
  collected.length = 0;

  const results: Record<string, BlockResult> = { ...existingResults };
  const totalBlocks = blocksToSweep.length;
  let sweepedCount = 0;

  try {
    // Detect current preset so we can restore after each block.
    const startPreset = await getCurrentPreset(output, collected);
    console.log(`  Current preset: ${startPreset}\n`);

    // Pick a scratch preset for round-trip restore (one away from current).
    const scratchPreset = startPreset === 1 ? 2 : startPreset - 1;

    for (let bi = 0; bi < totalBlocks; bi++) {
      const block = blocksToSweep[bi];
      const prefix = `[${bi + 1}/${totalBlocks}]`;

      // Skip if already done in resume mode.
      if (resumeMode && existingResults[block.key]) {
        console.log(`${prefix} ${block.name} - already done (resume), skipping`);
        continue;
      }

      const result = await sweepBlock(output, collected, block, prefix);
      if (result) {
        results[block.key] = result;
        sweepedCount++;
      }

      // Discard working-buffer changes: switch away then back to reload from flash.
      switchPreset(output, scratchPreset);
      await sleep(500);
      switchPreset(output, startPreset);
      await sleep(500);

      // Save intermediate results after each block (crash-safe).
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      writeFileSync(outPath, JSON.stringify(results, null, 2));
      console.log(`  (saved intermediate results)\n`);
    }

    // Final summary.
    console.log('\n================================================================');
    console.log('  SWEEP COMPLETE');
    console.log('================================================================\n');

    let totalW16 = 0, totalInt = 0, totalRo = 0, totalUnk = 0;
    for (const [key, r] of Object.entries(results)) {
      console.log(`  ${r.name.padEnd(18)} ${r.positions} pos: w16=${r.summary.wire16} int=${r.summary.display_int} ro=${r.summary.readonly} unk=${r.summary.unknown}`);
      totalW16 += r.summary.wire16;
      totalInt += r.summary.display_int;
      totalRo += r.summary.readonly;
      totalUnk += r.summary.unknown;
    }
    const total = totalW16 + totalInt + totalRo + totalUnk;
    console.log(`\n  TOTALS: ${total} positions across ${Object.keys(results).length} blocks`);
    console.log(`    wire16:      ${totalW16} (${(totalW16 / total * 100).toFixed(1)}%)`);
    console.log(`    display_int: ${totalInt} (${(totalInt / total * 100).toFixed(1)}%)`);
    console.log(`    readonly:    ${totalRo} (${(totalRo / total * 100).toFixed(1)}%)`);
    console.log(`    unknown:     ${totalUnk} (${(totalUnk / total * 100).toFixed(1)}%)`);
    console.log(`\n  Results: ${outPath}`);

  } finally {
    input.closePort();
    output.closePort();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
