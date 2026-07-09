/**
 * HW-125: Axe-Fx II state-broadcast WRITE probe (0x74/0x75/0x76 bidirectional test).
 *
 * Tests whether the device accepts a synthesized 0x74/0x75/0x76 triple
 * as a WRITE operation. If it does, apply_preset collapses from ~166
 * sequential fn=0x2e messages to ~18 (one triple per placed block).
 *
 * Methodology (read-modify-write, single known param):
 *
 *   Phase 1 — CONTROL: verify fn=0x2e write + fn=0x1F readback works.
 *   Phase 2 — TEST:    read full block state via fn=0x1F, modify one
 *                       position, send entire triple back, re-read to
 *                       confirm. Try both opFlag=0x01 and opFlag=0x00.
 *   Phase 3 — RESTORE: put the original value back via fn=0x2e.
 *
 * Target: Amp 1 (effectId 106), amp.bass (paramId 2, display 0..10).
 * Chosen because amp.bass is a continuous knob with an easily verified
 * range and no type-applicability gating.
 *
 * HW-086 precedent: tested on Volume/Pan 1 (9 values, tiny block) and
 * got "broadcast-only" verdict. This test uses Amp 1 (236 values) with
 * proper fn=0x1F round-trip reads and a control write as baseline.
 *
 * Prereqs:
 *   - Axe-Fx II XL+ powered on, USB connected
 *   - Close AxeEdit (its polling pollutes inbound stream)
 *   - A preset with Amp 1 placed and active
 *
 * Run:
 *   npx tsx scripts/_research/probe-axefx2-state-write.ts
 */

import midi from "@julusian/midi";

const AXE_FX_II_MODEL = 0x07;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;

const AMP_1_EFFECT_ID = 106;
const TARGET_PARAM_ID = 2; // amp.bass (display 0..10, wire 0..65535)

const FN_GET_ALL_PARAMS = 0x1f;
const FN_SET_PARAM_DIRECT = 0x2e;
const FN_STATE_HEADER = 0x74;
const FN_STATE_CHUNK = 0x75;
const FN_STATE_FOOTER = 0x76;

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
  return [
    n & 0x7f,
    (n >> 7) & 0x7f,
    (n >> 14) & 0x7f,
    (n >> 21) & 0x7f,
    (n >> 28) & 0x0f,
  ];
}

function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function findPort(io: midi.Input | midi.Output, needles: string[]): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    const name = io.getPortName(i);
    for (const n of needles) {
      if (name.toLowerCase().includes(n.toLowerCase())) {
        console.log(`  matched port [${i}] ${name}`);
        return i;
      }
    }
  }
  return -1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Wire helpers ─────────────────────────────────────────────────────

function buildGetAllParams(effectId: number): number[] {
  return buildEnvelope(FN_GET_ALL_PARAMS, [...encode14(effectId)]);
}

function buildSetParamDirect(effectId: number, paramId: number, displayValue: number): number[] {
  return buildEnvelope(FN_SET_PARAM_DIRECT, [
    ...encode14(effectId),
    ...encode14(paramId),
    ...packFloat32ForDirect(displayValue),
  ]);
}

function buildStateBroadcastTriple(
  targetId: number,
  values: readonly number[],
  opFlag: number,
): number[] {
  const header = buildEnvelope(FN_STATE_HEADER, [
    ...encode14(targetId),
    ...encode14(values.length),
    opFlag,
  ]);

  const chunks: number[] = [];
  for (let start = 0; start < values.length; start += STATE_DUMP_CHUNK_MAX_ITEMS) {
    const slice = values.slice(start, start + STATE_DUMP_CHUNK_MAX_ITEMS);
    const body: number[] = [FN_STATE_CHUNK, ...encode14(slice.length)];
    for (const v of slice) {
      body.push(...packValue16(v));
    }
    chunks.push(...buildEnvelope(body[0], body.slice(1)));
  }
  if (chunks.length === 0) {
    chunks.push(...buildEnvelope(FN_STATE_CHUNK, [...encode14(0)]));
  }

  const footer = buildEnvelope(FN_STATE_FOOTER);
  return [...header, ...chunks, ...footer];
}

// ── Triple parser ────────────────────────────────────────────────────

interface DecodedTriple {
  targetId: number;
  itemCount: number;
  opFlag: number;
  values: number[];
}

function isFractalFn(bytes: number[], fn: number): boolean {
  return (
    bytes.length >= 7
    && bytes[0] === 0xf0
    && bytes[1] === 0x00
    && bytes[2] === 0x01
    && bytes[3] === 0x74
    && bytes[4] === AXE_FX_II_MODEL
    && bytes[5] === fn
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

async function readAllParamsViaFn1F(
  output: midi.Output,
  collected: number[][],
  effectId: number,
): Promise<DecodedTriple | null> {
  const before = collected.length;
  output.sendMessage(buildGetAllParams(effectId));

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
          header = {
            targetId: tId,
            itemCount: decode14(frame[8], frame[9]),
            opFlag: frame[10],
            values: [],
          };
        }
      } else if (isFractalFn(frame, FN_STATE_CHUNK) && header) {
        for (const v of decodeChunkFrame(frame)) values.push(v);
      } else if (isFractalFn(frame, FN_STATE_FOOTER) && header) {
        return { ...header, values };
      }
    }
  }

  if (header) return { ...header, values };
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  HW-125: Axe-Fx II State-Broadcast WRITE Probe');
  console.log('  Target: Amp 1 (effectId 106), amp.bass (paramId 2)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const input = new midi.Input();
  const output = new midi.Output();

  console.log('Input ports:');
  for (let i = 0; i < input.getPortCount(); i++) console.log(`  [${i}] ${input.getPortName(i)}`);
  console.log('Output ports:');
  for (let i = 0; i < output.getPortCount(); i++) console.log(`  [${i}] ${output.getPortName(i)}`);

  const needles = ['Axe-Fx II', 'AxeFxII', 'AXE-FX II', 'XL+'];
  const outIdx = findPort(output, needles);
  if (outIdx < 0) { console.error('\nERROR: Axe-Fx II output port not found'); process.exit(1); }
  const inIdx = findPort(input, needles);
  if (inIdx < 0) { console.error('\nERROR: Axe-Fx II input port not found'); process.exit(1); }

  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);
  const collected: number[][] = [];
  input.on('message', (_dt, bytes) => {
    if (bytes[0] === 0xf0) collected.push(bytes.slice());
  });
  input.openPort(inIdx);
  console.log('\n  Ports opened. Warmup...');
  await sleep(500);
  collected.length = 0;

  try {
    // ── Phase 1: CONTROL — verify fn=0x1F read + fn=0x2e write roundtrip ──
    console.log('\n┌────────────────────────────────────────────────────────��┐');
    console.log('│  PHASE 1: Control (fn=0x1F read + fn=0x2e write)        │');
    console.log('└─────────────────────────────────────────────────────────┘\n');

    const read1 = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
    if (!read1) {
      console.error('ABORT: fn=0x1F returned no triple for Amp 1. Is Amp placed in active preset?');
      process.exit(1);
    }
    console.log(`  fn=0x1F read: ${read1.values.length} values, opFlag=${read1.opFlag}`);
    const originalWire = read1.values[TARGET_PARAM_ID];
    console.log(`  amp.bass (pos ${TARGET_PARAM_ID}) original wire value: ${originalWire}`);

    // Write a different display value via fn=0x2e (control write).
    // amp.bass display range is 0..10. Pick a value different from current.
    const currentDisplay = originalWire / 6553.5; // approx: 65535 / 10 = 6553.5
    const controlDisplay = currentDisplay > 5 ? 3.0 : 7.0;
    console.log(`  Control: writing amp.bass = ${controlDisplay} via fn=0x2e...`);
    output.sendMessage(buildSetParamDirect(AMP_1_EFFECT_ID, TARGET_PARAM_ID, controlDisplay));
    await sleep(500);

    // Read back to confirm fn=0x2e landed.
    const read2 = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
    if (!read2) {
      console.error('ABORT: fn=0x1F second read failed');
      process.exit(1);
    }
    const controlWire = read2.values[TARGET_PARAM_ID];
    const controlLanded = controlWire !== originalWire;
    console.log(`  amp.bass after fn=0x2e: wire=${controlWire} (was ${originalWire})`);
    console.log(`  Control write ${controlLanded ? '✓ LANDED' : '✗ FAILED (device unresponsive?)'}`);
    if (!controlLanded) {
      console.error('ABORT: fn=0x2e control write did not change the value. Check hardware.');
      process.exit(1);
    }

    // Restore original value.
    const restoreDisplay = originalWire / 6553.5;
    console.log(`  Restoring amp.bass to ~${restoreDisplay.toFixed(2)} via fn=0x2e...`);
    output.sendMessage(buildSetParamDirect(AMP_1_EFFECT_ID, TARGET_PARAM_ID, restoreDisplay));
    await sleep(500);

    // Confirm restore.
    const read3 = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
    if (!read3) {
      console.error('ABORT: fn=0x1F third read failed');
      process.exit(1);
    }
    console.log(`  amp.bass after restore: wire=${read3.values[TARGET_PARAM_ID]}`);

    // ── Phase 2: Triple write tests ──
    console.log('\n┌─────────────────────────────────────────────────────────┐');
    console.log('│  PHASE 2: State-broadcast triple write tests             │');
    console.log('└─────────────────────────────────────────────────────────┘\n');

    // Get fresh baseline.
    const baseline = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
    if (!baseline) {
      console.error('ABORT: fn=0x1F baseline read failed');
      process.exit(1);
    }
    const baselineWire = baseline.values[TARGET_PARAM_ID];
    console.log(`  Baseline: amp.bass wire=${baselineWire}, total values=${baseline.values.length}`);

    // Modify amp.bass position to a distinctly different wire value.
    const testWire = baselineWire > 32768 ? 16384 : 49152;
    const modifiedValues = [...baseline.values];
    modifiedValues[TARGET_PARAM_ID] = testWire;

    // ── Test A: opFlag=0x01 (direct block edit) ──
    console.log(`\n  Test A: triple write with opFlag=0x01 (direct block edit)`);
    console.log(`    Sending triple: targetId=${AMP_1_EFFECT_ID}, values=${modifiedValues.length}, pos[${TARGET_PARAM_ID}]=${testWire} (was ${baselineWire})`);

    const tripleA = buildStateBroadcastTriple(AMP_1_EFFECT_ID, modifiedValues, 0x01);
    // Send as individual SysEx frames (device expects separate messages).
    const framesA = splitTripleIntoFrames(tripleA);
    console.log(`    Sending ${framesA.length} SysEx frames...`);
    for (const frame of framesA) {
      output.sendMessage(frame);
    }
    await sleep(1000);

    const readA = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
    if (!readA) {
      console.error('    fn=0x1F post-write read failed');
    } else {
      const resultA = readA.values[TARGET_PARAM_ID];
      const deltaA = resultA - baselineWire;
      const successA = resultA === testWire;
      console.log(`    Result: amp.bass wire=${resultA} (expected ${testWire}, delta=${deltaA})`);
      console.log(`    Test A: ${successA ? '✓ WRITE ACCEPTED — triple is bidirectional!' : '✗ No change (or unexpected value)'}`);

      if (successA) {
        // Restore via fn=0x2e.
        output.sendMessage(buildSetParamDirect(AMP_1_EFFECT_ID, TARGET_PARAM_ID, baselineWire / 6553.5));
        await sleep(500);
      }
    }

    // ── Test B: opFlag=0x00 (preset-structure change) ──
    // Re-read baseline in case Test A changed something.
    const baseline2 = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
    if (!baseline2) {
      console.error('    fn=0x1F pre-test-B read failed');
    } else {
      const baselineWire2 = baseline2.values[TARGET_PARAM_ID];
      const testWire2 = baselineWire2 > 32768 ? 16384 : 49152;
      const modifiedValues2 = [...baseline2.values];
      modifiedValues2[TARGET_PARAM_ID] = testWire2;

      console.log(`\n  Test B: triple write with opFlag=0x00 (preset-structure)`);
      console.log(`    Sending triple: targetId=${AMP_1_EFFECT_ID}, values=${modifiedValues2.length}, pos[${TARGET_PARAM_ID}]=${testWire2} (was ${baselineWire2})`);

      const tripleB = buildStateBroadcastTriple(AMP_1_EFFECT_ID, modifiedValues2, 0x00);
      const framesB = splitTripleIntoFrames(tripleB);
      console.log(`    Sending ${framesB.length} SysEx frames...`);
      for (const frame of framesB) {
        output.sendMessage(frame);
      }
      await sleep(1000);

      const readB = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
      if (!readB) {
        console.error('    fn=0x1F post-write read failed');
      } else {
        const resultB = readB.values[TARGET_PARAM_ID];
        const deltaB = resultB - baselineWire2;
        const successB = resultB === testWire2;
        console.log(`    Result: amp.bass wire=${resultB} (expected ${testWire2}, delta=${deltaB})`);
        console.log(`    Test B: ${successB ? '✓ WRITE ACCEPTED — triple is bidirectional!' : '✗ No change (or unexpected value)'}`);

        if (successB) {
          output.sendMessage(buildSetParamDirect(AMP_1_EFFECT_ID, TARGET_PARAM_ID, baselineWire2 / 6553.5));
          await sleep(500);
        }
      }
    }

    // ── Test C: send ONLY the modified position's chunk (minimal write) ──
    // Some devices accept partial chunks. Try sending header with itemCount
    // matching only a few values around the target paramId.
    const baseline3 = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
    if (baseline3) {
      const baselineWire3 = baseline3.values[TARGET_PARAM_ID];
      const testWire3 = baselineWire3 > 32768 ? 16384 : 49152;

      console.log(`\n  Test C: full triple but with fn=0x02 action byte prepended`);
      console.log(`    (Some Fractal devices use fn 0x02 with the SET payload for writes.`);
      console.log(`     Testing if the triple needs a different function byte on the header.)`);

      // Try using fn=0x02 as the header function byte instead of 0x74.
      // This is speculative: maybe the WRITE envelope uses a different fn.
      const modifiedValues3 = [...baseline3.values];
      modifiedValues3[TARGET_PARAM_ID] = testWire3;

      // Build the same triple shape but with function byte 0x02 on header.
      const headerC = buildEnvelope(0x02, [
        ...encode14(AMP_1_EFFECT_ID),
        ...encode14(modifiedValues3.length),
        0x01,
      ]);
      console.log(`    Sending header with fn=0x02: ${toHex(headerC.slice(0, 14))}...`);
      output.sendMessage(headerC);
      await sleep(200);

      // Check if device NACKs (fn 0x64).
      const nackCheck = collected.filter(f => f.length >= 7 && f[5] === 0x64);
      if (nackCheck.length > 0) {
        console.log(`    Got NACK (fn 0x64) — fn=0x02 header shape rejected`);
      } else {
        console.log(`    No NACK (or no response at all)`);
      }

      // Still try the full triple write as fn=0x74/0x75/0x76 but with the
      // itemCount set to just 1 (only the param we want to change).
      console.log(`\n  Test D: single-value triple (itemCount=1, position ${TARGET_PARAM_ID} only)`);
      const singleHeader = buildEnvelope(FN_STATE_HEADER, [
        ...encode14(AMP_1_EFFECT_ID),
        ...encode14(1), // itemCount = 1
        0x01,
      ]);
      const singleChunk = buildEnvelope(FN_STATE_CHUNK, [
        ...encode14(1),
        ...packValue16(testWire3),
      ]);
      const singleFooter = buildEnvelope(FN_STATE_FOOTER);

      console.log(`    Sending 3 frames (header claims 1 item)...`);
      output.sendMessage(singleHeader);
      output.sendMessage(singleChunk);
      output.sendMessage(singleFooter);
      await sleep(1000);

      const readD = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
      if (readD) {
        const resultD = readD.values[TARGET_PARAM_ID];
        const successD = resultD === testWire3;
        console.log(`    Result: amp.bass wire=${resultD} (expected ${testWire3})`);
        console.log(`    Test D: ${successD ? '✓ WRITE ACCEPTED' : '✗ No change'}`);
        if (successD) {
          output.sendMessage(buildSetParamDirect(AMP_1_EFFECT_ID, TARGET_PARAM_ID, baselineWire3 / 6553.5));
          await sleep(500);
        }
      }
    }

    // ── Phase 3: RESTORE to original ──
    console.log('\n┌─────────────────────────────────────────────────────────┐');
    console.log('│  PHASE 3: Final restore                                  │');
    console.log('└─────────────────────────────────────────────────────────┘\n');

    output.sendMessage(buildSetParamDirect(AMP_1_EFFECT_ID, TARGET_PARAM_ID, originalWire / 6553.5));
    await sleep(500);
    const finalRead = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
    if (finalRead) {
      console.log(`  Final amp.bass: wire=${finalRead.values[TARGET_PARAM_ID]} (original was ${originalWire})`);
    }

    // ── Summary ──
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Review results above. If any test shows ✓, the device');
    console.log('  accepts state-broadcast triples as writes. Report to');
    console.log('  HW-125 in HARDWARE-TASKS-AXEFX2.md.');
    console.log('═══════════════════════════════════════════════════════════════\n');

  } finally {
    input.closePort();
    output.closePort();
    console.log('  Ports closed.');
  }
}

/** Split a flat byte array (concatenated SysEx frames) into individual frames. */
function splitTripleIntoFrames(flat: number[]): number[][] {
  const frames: number[][] = [];
  let start = -1;
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] === 0xf0) start = i;
    if (flat[i] === 0xf7 && start >= 0) {
      frames.push(flat.slice(start, i + 1));
      start = -1;
    }
  }
  return frames;
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
