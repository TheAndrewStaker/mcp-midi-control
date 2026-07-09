/**
 * HW-125 decode: test triple writes using DISPLAY-SCALE values for failing blocks.
 *
 * Hypothesis: blocks that failed triple writes (Drive, Compressor, Phaser, etc.)
 * use display-integer encoding in their state-dump, NOT 16-bit wire encoding.
 * If we write display-scale values in the triple, the write should land.
 *
 * Test plan:
 *   1. Read Drive 1 baseline via fn=0x1F (values should be in display-scale)
 *   2. Modify position 1 (drive.gain) to a known display integer (e.g. 7)
 *   3. Send triple back with that display-scale value
 *   4. Read back to confirm
 *
 * Also tests: if we can reverse-engineer the correct value for the
 * coarser blocks (Compressor, Phaser) by using calibrated values from
 * the encoding probe.
 *
 * Run:
 *   npx tsx scripts/_research/probe-axefx2-state-write-display-scale.ts
 */

import midi from "@julusian/midi";

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
const STATE_DUMP_CHUNK_MAX_ITEMS = 64;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}
function buildEnvelope(fn: number, payload: number[] = []): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, AXE_FX_II_MODEL, fn, ...payload];
  return [...head, fractalChecksum(head), SYSEX_END];
}
function encode14(n: number): [number, number] { return [n & 0x7f, (n >> 7) & 0x7f]; }
function decode14(lo: number, hi: number): number { return (lo & 0x7f) | ((hi & 0x7f) << 7); }
function packValue16(value: number): [number, number, number] {
  return [value & 0x7f, (value >> 7) & 0x7f, (value >> 14) & 0x03];
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
    for (const n of needles) { if (name.toLowerCase().includes(n.toLowerCase())) return i; }
  }
  return -1;
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

interface DecodedTriple { targetId: number; itemCount: number; opFlag: number; values: number[] }

function isFractalFn(bytes: number[], fn: number): boolean {
  return bytes.length >= 7 && bytes[0] === 0xf0 && bytes[1] === 0x00
    && bytes[2] === 0x01 && bytes[3] === 0x74 && bytes[4] === AXE_FX_II_MODEL && bytes[5] === fn;
}
function decodeChunkFrame(bytes: number[]): number[] {
  const itemCount = decode14(bytes[6], bytes[7]);
  const out: number[] = [];
  const start = 8; const end = bytes.length - 2;
  for (let i = 0; i < itemCount; i++) {
    const off = start + i * 3;
    if (off + 2 >= end) break;
    out.push(decode16Packed(bytes[off], bytes[off + 1], bytes[off + 2]));
  }
  return out;
}
async function readAllParams(output: midi.Output, collected: number[][], effectId: number): Promise<DecodedTriple | null> {
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
        if (tId === effectId && !header) header = { targetId: tId, itemCount: decode14(frame[8], frame[9]), opFlag: frame[10], values: [] };
      } else if (isFractalFn(frame, FN_STATE_CHUNK) && header) {
        for (const v of decodeChunkFrame(frame)) values.push(v);
      } else if (isFractalFn(frame, FN_STATE_FOOTER) && header) { return { ...header, values }; }
      else if (isFractalFn(frame, FN_MULTIPURPOSE)) return null;
    }
  }
  if (header) return { ...header, values };
  return null;
}
function buildTripleFrames(targetId: number, values: readonly number[], opFlag: number): number[][] {
  const header = buildEnvelope(FN_STATE_HEADER, [...encode14(targetId), ...encode14(values.length), opFlag]);
  const chunks: number[][] = [];
  for (let start = 0; start < values.length; start += STATE_DUMP_CHUNK_MAX_ITEMS) {
    const slice = values.slice(start, start + STATE_DUMP_CHUNK_MAX_ITEMS);
    const body: number[] = [FN_STATE_CHUNK, ...encode14(slice.length)];
    for (const v of slice) body.push(...packValue16(v));
    chunks.push(buildEnvelope(body[0], body.slice(1)));
  }
  if (chunks.length === 0) chunks.push(buildEnvelope(FN_STATE_CHUNK, [...encode14(0)]));
  return [header, ...chunks, buildEnvelope(FN_STATE_FOOTER)];
}
function buildSetParamDirect(effectId: number, paramId: number, displayValue: number): number[] {
  return buildEnvelope(FN_SET_PARAM_DIRECT, [...encode14(effectId), ...encode14(paramId), ...packFloat32ForDirect(displayValue)]);
}

interface WriteTest {
  name: string;
  effectId: number;
  paramId: number;
  paramName: string;
  writeValue: number; // display-scale integer to write in the triple
}

const TESTS: WriteTest[] = [
  // Drive: 1:1 display scale. Write display integer directly.
  { name: 'Drive 1', effectId: 108, paramId: 1, paramName: 'gain', writeValue: 7 },
  // Compressor: ~0.3 scale. display=5 -> state=2, display=10 -> state=4.
  // Try writing 3 (should correspond to ~display 7.5).
  { name: 'Compressor 1', effectId: 116, paramId: 1, paramName: 'threshold', writeValue: 3 },
  // Phaser: ~0.5 scale. display=10 -> state=5. Try writing 3.
  { name: 'Phaser 1', effectId: 122, paramId: 1, paramName: 'rate', writeValue: 3 },
  // Filter: state=5 was max for display 5..10. Try writing 3.
  { name: 'Filter 1', effectId: 130, paramId: 1, paramName: 'frequency', writeValue: 3 },
  // GEQ: state 0..3 range. Try writing 2.
  { name: 'Graphic EQ 1', effectId: 146, paramId: 1, paramName: 'band1', writeValue: 2 },
  // PEQ: state 0..1. Try writing 1.
  { name: 'Parametric EQ 1', effectId: 148, paramId: 1, paramName: 'freq1', writeValue: 1 },
];

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  HW-125: Display-Scale Triple Write Test');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const input = new midi.Input();
  const output = new midi.Output();
  const needles = ['Axe-Fx II', 'AxeFxII', 'AXE-FX II', 'XL+'];
  const outIdx = findPort(output, needles);
  if (outIdx < 0) { console.error('ERROR: output port not found'); process.exit(1); }
  const inIdx = findPort(input, needles);
  if (inIdx < 0) { console.error('ERROR: input port not found'); process.exit(1); }

  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);
  const collected: number[][] = [];
  input.on('message', (_dt, bytes) => { if (bytes[0] === 0xf0) collected.push(bytes.slice()); });
  input.openPort(inIdx);
  await sleep(500);
  collected.length = 0;

  try {
    for (const test of TESTS) {
      console.log(`── ${test.name} (${test.paramName}, pos ${test.paramId}) ──`);

      const baseline = await readAllParams(output, collected, test.effectId);
      if (!baseline) { console.log('  SKIP: not placed\n'); continue; }

      const originalState = baseline.values[test.paramId];
      console.log(`  Baseline state-dump: pos[${test.paramId}]=${originalState} (${baseline.values.length} total)`);

      // Ensure target value differs from current.
      let targetState = test.writeValue;
      if (targetState === originalState) {
        targetState = originalState > 0 ? originalState - 1 : originalState + 1;
      }

      // Modify ONLY the target position to a display-scale value.
      const modified = [...baseline.values];
      modified[test.paramId] = targetState;

      console.log(`  Writing triple with pos[${test.paramId}]=${targetState} (display-scale)...`);
      const frames = buildTripleFrames(test.effectId, modified, 0x01);
      for (const frame of frames) output.sendMessage(frame);
      await sleep(800);

      const verify = await readAllParams(output, collected, test.effectId);
      if (!verify) { console.log('  Post-write read FAILED\n'); continue; }

      const result = verify.values[test.paramId];
      const landed = result === targetState;

      // Check collateral damage.
      let drift = 0;
      for (let i = 0; i < modified.length; i++) {
        if (verify.values[i] !== modified[i]) drift++;
      }

      console.log(`  Result: pos[${test.paramId}]=${result} (expected ${targetState})`);
      console.log(`  ${landed ? '✓ WRITE ACCEPTED' : '✗ WRITE FAILED'} | drift=${drift}\n`);

      // Restore.
      if (landed) {
        const restore = [...verify.values];
        restore[test.paramId] = originalState;
        const restFrames = buildTripleFrames(test.effectId, restore, 0x01);
        for (const frame of restFrames) output.sendMessage(frame);
        await sleep(300);
      }
    }

    // If Drive works, do a full-triple-with-multiple-modified-params test.
    console.log('── Drive 1: Multi-param display-scale write ──');
    const driveBaseline = await readAllParams(output, collected, 108);
    if (driveBaseline) {
      console.log(`  Baseline: ${driveBaseline.values.length} values, first 5: [${driveBaseline.values.slice(0, 5).join(', ')}]`);
      // Modify multiple positions using display-scale integers.
      const mod = [...driveBaseline.values];
      // pos 0 = effect_type (enum, skip)
      // pos 1 = gain (0..10)
      // pos 2 = tone (0..10)
      // pos 3 = mid (0..10)
      mod[1] = 8; // gain = 8
      mod[2] = 6; // tone = 6
      mod[3] = 4; // mid = 4

      console.log(`  Writing: pos[1]=8, pos[2]=6, pos[3]=4...`);
      const frames = buildTripleFrames(108, mod, 0x01);
      for (const frame of frames) output.sendMessage(frame);
      await sleep(800);

      const verify = await readAllParams(output, collected, 108);
      if (verify) {
        console.log(`  Result: pos[1]=${verify.values[1]}, pos[2]=${verify.values[2]}, pos[3]=${verify.values[3]}`);
        const allOk = verify.values[1] === 8 && verify.values[2] === 6 && verify.values[3] === 4;
        let drift = 0;
        for (let i = 0; i < mod.length; i++) { if (verify.values[i] !== mod[i]) drift++; }
        console.log(`  ${allOk ? '✓ ALL THREE LANDED' : '✗ PARTIAL OR FAILED'} | drift=${drift}`);

        // Restore.
        const restFrames = buildTripleFrames(108, driveBaseline.values, 0x01);
        for (const frame of restFrames) output.sendMessage(frame);
        await sleep(300);
      }
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  DONE');
    console.log('═══════════════════════════════════════════════════════════════\n');

  } finally {
    input.closePort();
    output.closePort();
  }
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
