/**
 * HW-125 follow-up #2: multi-block triple write sweep.
 *
 * Drive 1 triple write failed in the validation probe while Amp 1
 * succeeded. This script tests every placed block in the active preset
 * to determine which blocks accept triple writes.
 *
 * For each block: read via fn=0x1F, pick a known continuous-knob
 * paramId, modify it, send triple, re-read, report.
 *
 * Run:
 *   npx tsx scripts/_research/probe-axefx2-state-write-multiblock.ts
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

function encode14(n: number): [number, number] {
  return [n & 0x7f, (n >> 7) & 0x7f];
}

function decode14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}

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
    for (const n of needles) {
      if (name.toLowerCase().includes(n.toLowerCase())) return i;
    }
  }
  return -1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// All block effectIds from the II block table (instance 1 only).
const BLOCKS_TO_TEST: { name: string; effectId: number; knobParamId: number }[] = [
  { name: 'Amp 1',          effectId: 106, knobParamId: 2 },   // amp.bass
  { name: 'Drive 1',        effectId: 108, knobParamId: 1 },   // drive.gain
  { name: 'Delay 1',        effectId: 112, knobParamId: 2 },   // delay.feedback
  { name: 'Reverb 1',       effectId: 114, knobParamId: 1 },   // reverb.time
  { name: 'Compressor 1',   effectId: 116, knobParamId: 1 },   // compressor.threshold
  { name: 'Cab 1',          effectId: 110, knobParamId: 1 },   // cab param
  { name: 'Chorus 1',       effectId: 118, knobParamId: 1 },   // chorus.rate
  { name: 'Flanger 1',      effectId: 120, knobParamId: 1 },   // flanger.rate
  { name: 'Phaser 1',       effectId: 122, knobParamId: 1 },   // phaser.rate
  { name: 'Wah 1',          effectId: 124, knobParamId: 1 },   // wah.position
  { name: 'Volume/Pan 1',   effectId: 127, knobParamId: 1 },   // vol.level
  { name: 'Filter 1',       effectId: 130, knobParamId: 1 },
  { name: 'Pitch 1',        effectId: 132, knobParamId: 1 },
  { name: 'Graphic EQ 1',   effectId: 146, knobParamId: 1 },
  { name: 'Parametric EQ 1',effectId: 148, knobParamId: 1 },
  { name: 'Multi Delay 1',  effectId: 150, knobParamId: 1 },
  { name: 'Tremolo/Pan 1',  effectId: 134, knobParamId: 1 },
  { name: 'Rotary 1',       effectId: 136, knobParamId: 1 },
  { name: 'FX Loop 1',      effectId: 142, knobParamId: 1 },
  { name: 'Enhancer 1',     effectId: 140, knobParamId: 1 },
  { name: 'Formant 1',      effectId: 138, knobParamId: 1 },
];

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
        // NACK - block not placed
        return null;
      }
    }
  }
  if (header) return { ...header, values };
  return null;
}

function buildTripleFrames(
  targetId: number,
  values: readonly number[],
  opFlag: number,
): number[][] {
  const header = buildEnvelope(FN_STATE_HEADER, [
    ...encode14(targetId), ...encode14(values.length), opFlag,
  ]);
  const chunks: number[][] = [];
  for (let start = 0; start < values.length; start += STATE_DUMP_CHUNK_MAX_ITEMS) {
    const slice = values.slice(start, start + STATE_DUMP_CHUNK_MAX_ITEMS);
    const body: number[] = [FN_STATE_CHUNK, ...encode14(slice.length)];
    for (const v of slice) body.push(...packValue16(v));
    chunks.push(buildEnvelope(body[0], body.slice(1)));
  }
  if (chunks.length === 0) {
    chunks.push(buildEnvelope(FN_STATE_CHUNK, [...encode14(0)]));
  }
  return [header, ...chunks, buildEnvelope(FN_STATE_FOOTER)];
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  HW-125 Multi-Block Triple Write Sweep');
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
  input.on('message', (_dt, bytes) => {
    if (bytes[0] === 0xf0) collected.push(bytes.slice());
  });
  input.openPort(inIdx);
  await sleep(500);
  collected.length = 0;

  const results: { name: string; placed: boolean; values: number; wrote: boolean; verified: boolean; detail: string }[] = [];

  try {
    for (const block of BLOCKS_TO_TEST) {
      process.stdout.write(`  ${block.name.padEnd(20)} (id=${block.effectId}): `);

      // Step 1: Read baseline.
      const snap = await readAllParams(output, collected, block.effectId);
      if (!snap) {
        console.log('not placed (NACK or timeout)');
        results.push({ name: block.name, placed: false, values: 0, wrote: false, verified: false, detail: 'not placed' });
        continue;
      }

      const pid = Math.min(block.knobParamId, snap.values.length - 1);
      const original = snap.values[pid];

      // Step 2: Modify one position and write triple.
      const modified = [...snap.values];
      modified[pid] = original > 32768 ? 16384 : 49152;

      const frames = buildTripleFrames(block.effectId, modified, 0x01);
      for (const frame of frames) output.sendMessage(frame);
      await sleep(500);

      // Step 3: Re-read.
      const verify = await readAllParams(output, collected, block.effectId);
      if (!verify) {
        console.log(`${snap.values.length} vals, post-write read FAILED`);
        results.push({ name: block.name, placed: true, values: snap.values.length, wrote: false, verified: false, detail: 'post-write read failed' });
        continue;
      }

      const landed = verify.values[pid] === modified[pid];
      let drift = 0;
      for (let i = 0; i < modified.length; i++) {
        if (verify.values[i] !== modified[i]) drift++;
      }

      const tag = landed && drift === 0 ? '✓ WRITE OK' :
        landed && drift > 0 ? `~ wrote but ${drift} drift` :
        `✗ FAILED (pos[${pid}]: sent=${modified[pid]}, got=${verify.values[pid]}, orig=${original})`;
      console.log(`${snap.values.length} vals, ${tag}`);
      results.push({ name: block.name, placed: true, values: snap.values.length, wrote: landed, verified: drift === 0, detail: tag });

      // Step 4: Restore via triple.
      if (landed) {
        const restoreFrames = buildTripleFrames(block.effectId, snap.values, 0x01);
        for (const frame of restoreFrames) output.sendMessage(frame);
        await sleep(300);
      }
    }

    // Also test fn=0x2e on Drive 1 as a control, to confirm Drive is writable at all.
    console.log('\n  ── Drive 1 fn=0x2e control ──');
    const driveCtrl = await readAllParams(output, collected, BLOCKS_TO_TEST[1].effectId);
    if (driveCtrl) {
      const origDrive = driveCtrl.values[1];
      const testVal = origDrive > 32768 ? 3.0 : 7.0;
      output.sendMessage(buildSetParamDirect(108, 1, testVal));
      await sleep(500);
      const drvAfter = await readAllParams(output, collected, 108);
      if (drvAfter) {
        const drvLanded = drvAfter.values[1] !== origDrive;
        console.log(`  fn=0x2e: drive.gain ${origDrive} -> ${drvAfter.values[1]} ${drvLanded ? '✓' : '✗'}`);
        // Restore.
        output.sendMessage(buildSetParamDirect(108, 1, origDrive / 6553.5));
        await sleep(300);
      }
    }

    // Summary table.
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  RESULTS');
    console.log('═══════════════════════════════════════════════════════════════');
    const placed = results.filter(r => r.placed);
    const accepted = placed.filter(r => r.wrote);
    const clean = placed.filter(r => r.wrote && r.verified);
    console.log(`  Blocks tested:    ${results.length}`);
    console.log(`  Placed in preset: ${placed.length}`);
    console.log(`  Triple write OK:  ${accepted.length}/${placed.length}`);
    console.log(`  Byte-exact:       ${clean.length}/${placed.length}`);
    console.log('');
    for (const r of results) {
      console.log(`  ${r.placed ? (r.wrote && r.verified ? '✓' : r.wrote ? '~' : '✗') : '-'} ${r.name.padEnd(20)} ${r.detail}`);
    }
    console.log('═══════════════════════════════════════════════════════════════\n');

  } finally {
    input.closePort();
    output.closePort();
    console.log('  Ports closed.');
  }
}

function buildSetParamDirect(effectId: number, paramId: number, displayValue: number): number[] {
  return buildEnvelope(FN_SET_PARAM_DIRECT, [
    ...encode14(effectId),
    ...encode14(paramId),
    ...packFloat32ForDirect(displayValue),
  ]);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
