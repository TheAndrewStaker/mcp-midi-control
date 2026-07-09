/**
 * HW-125 follow-up: validate state-broadcast triple write safety.
 *
 * Challenges the positive finding from the initial probe:
 *
 *   1. POSITION INTEGRITY: After a triple write that modifies ONE
 *      position, confirm ALL other positions are byte-exact preserved.
 *      If the device applies a transform, silent corruption is possible.
 *
 *   2. CROSS-BLOCK: Confirm writes work on at least one other block
 *      (Drive 1, effectId 108, ~44 values).
 *
 *   3. CHANNEL INTERACTION: Read via fn=0x1F, check if a prior
 *      fn=0x11 channel-switch to Y changes what fn=0x1F returns.
 *      If fn=0x1F returns X-only, triple write might clobber Y.
 *
 *   4. MULTI-PARAM: Modify 3 positions simultaneously, confirm all 3
 *      land and nothing else moves.
 *
 * Prereqs: Same as initial probe (XL+ connected, AxeEdit closed,
 * preset with Amp 1 + Drive 1 placed).
 *
 * Run:
 *   npx tsx scripts/_research/probe-axefx2-state-write-validation.ts
 */

import midi from "@julusian/midi";

const AXE_FX_II_MODEL = 0x07;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;

const AMP_1_EFFECT_ID = 106;
const DRIVE_1_EFFECT_ID = 108;

const FN_GET_ALL_PARAMS = 0x1f;
const FN_SET_PARAM_DIRECT = 0x2e;
const FN_BLOCK_CHANNEL = 0x11;
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

function buildSetBlockChannel(effectId: number, channel: number): number[] {
  // fn 0x11: [effectId 14b septet] [channel: 0=X, 1=Y]
  return buildEnvelope(FN_BLOCK_CHANNEL, [...encode14(effectId), channel]);
}

function buildStateBroadcastTriple(
  targetId: number,
  values: readonly number[],
  opFlag: number,
): number[][] {
  const header = buildEnvelope(FN_STATE_HEADER, [
    ...encode14(targetId),
    ...encode14(values.length),
    opFlag,
  ]);

  const chunks: number[][] = [];
  for (let start = 0; start < values.length; start += STATE_DUMP_CHUNK_MAX_ITEMS) {
    const slice = values.slice(start, start + STATE_DUMP_CHUNK_MAX_ITEMS);
    const body: number[] = [FN_STATE_CHUNK, ...encode14(slice.length)];
    for (const v of slice) {
      body.push(...packValue16(v));
    }
    chunks.push(buildEnvelope(body[0], body.slice(1)));
  }
  if (chunks.length === 0) {
    chunks.push(buildEnvelope(FN_STATE_CHUNK, [...encode14(0)]));
  }

  const footer = buildEnvelope(FN_STATE_FOOTER);
  return [header, ...chunks, footer];
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
  console.log('  HW-125 Validation: State-Broadcast Write Safety Checks');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const input = new midi.Input();
  const output = new midi.Output();

  const needles = ['Axe-Fx II', 'AxeFxII', 'AXE-FX II', 'XL+'];
  const outIdx = findPort(output, needles);
  if (outIdx < 0) { console.error('ERROR: Axe-Fx II output port not found'); process.exit(1); }
  const inIdx = findPort(input, needles);
  if (inIdx < 0) { console.error('ERROR: Axe-Fx II input port not found'); process.exit(1); }

  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);
  const collected: number[][] = [];
  input.on('message', (_dt, bytes) => {
    if (bytes[0] === 0xf0) collected.push(bytes.slice());
  });
  input.openPort(inIdx);
  await sleep(500);
  collected.length = 0;

  try {
    // ══════════════════════════════════════════════════════════════════
    // TEST 1: Position integrity (all 236 positions round-trip exact)
    // ══════════════════════════════════════════════════════════════════
    console.log('┌─────────────────────────────────────────────────────────┐');
    console.log('│  TEST 1: Position integrity (Amp 1, 236 values)          │');
    console.log('└─────────────────────────────────────────────────────────┘\n');

    const snap1 = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
    if (!snap1) { console.error('ABORT: fn=0x1F read failed for Amp 1'); process.exit(1); }
    console.log(`  Baseline read: ${snap1.values.length} values`);

    // Modify position 2 (amp.bass) only.
    const original2 = snap1.values[2];
    const modified = [...snap1.values];
    modified[2] = original2 > 32768 ? 16384 : 49152;

    const frames1 = buildStateBroadcastTriple(AMP_1_EFFECT_ID, modified, 0x01);
    for (const frame of frames1) output.sendMessage(frame);
    await sleep(1000);

    const snap2 = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
    if (!snap2) { console.error('ABORT: fn=0x1F post-write read failed'); process.exit(1); }

    // Compare every position.
    let drifted = 0;
    const driftPositions: { pos: number; sent: number; got: number }[] = [];
    for (let i = 0; i < modified.length; i++) {
      if (snap2.values[i] !== modified[i]) {
        drifted++;
        if (driftPositions.length < 20) {
          driftPositions.push({ pos: i, sent: modified[i], got: snap2.values[i] });
        }
      }
    }

    const targetLanded = snap2.values[2] === modified[2];
    console.log(`  Target pos[2]: sent=${modified[2]}, got=${snap2.values[2]} ${targetLanded ? '✓' : '✗'}`);
    console.log(`  Position drift: ${drifted} of ${modified.length} positions differ from what we sent`);
    if (drifted > 0) {
      console.log('  DRIFTED POSITIONS:');
      for (const d of driftPositions) {
        console.log(`    pos[${d.pos}]: sent=${d.sent}, got=${d.got} (delta=${d.got - d.sent})`);
      }
    }
    console.log(`  TEST 1: ${drifted === 0 ? '✓ BYTE-EXACT round-trip' : `✗ ${drifted} positions corrupted`}\n`);

    // Restore.
    const restoreFrames = buildStateBroadcastTriple(AMP_1_EFFECT_ID, snap1.values, 0x01);
    for (const frame of restoreFrames) output.sendMessage(frame);
    await sleep(500);

    // ══════════════════════════════════════════════════════════════════
    // TEST 2: Cross-block (Drive 1, effectId 108)
    // ══════════════════════════════════════════════════════════════════
    console.log('┌─────────────────────────────────────────────────────────┐');
    console.log('│  TEST 2: Cross-block (Drive 1, effectId 108)             │');
    console.log('└─────────────────────────────────────────────────────────┘\n');

    const driveSnap1 = await readAllParamsViaFn1F(output, collected, DRIVE_1_EFFECT_ID);
    if (!driveSnap1) {
      console.log('  SKIP: fn=0x1F returned nothing for Drive 1. Block may not be placed.');
      console.log('  (This test requires Drive 1 in the active preset.)\n');
    } else {
      console.log(`  Drive 1 baseline: ${driveSnap1.values.length} values`);
      const drvOriginal = driveSnap1.values[1]; // drive.gain = paramId 1
      const drvModified = [...driveSnap1.values];
      drvModified[1] = drvOriginal > 32768 ? 16384 : 49152;

      const drvFrames = buildStateBroadcastTriple(DRIVE_1_EFFECT_ID, drvModified, 0x01);
      for (const frame of drvFrames) output.sendMessage(frame);
      await sleep(1000);

      const driveSnap2 = await readAllParamsViaFn1F(output, collected, DRIVE_1_EFFECT_ID);
      if (!driveSnap2) {
        console.log('  Post-write read failed');
      } else {
        const drvLanded = driveSnap2.values[1] === drvModified[1];
        let drvDrift = 0;
        for (let i = 0; i < drvModified.length; i++) {
          if (driveSnap2.values[i] !== drvModified[i]) drvDrift++;
        }
        console.log(`  Target pos[1]: sent=${drvModified[1]}, got=${driveSnap2.values[1]} ${drvLanded ? '✓' : '✗'}`);
        console.log(`  Position drift: ${drvDrift} of ${drvModified.length}`);
        console.log(`  TEST 2: ${drvLanded && drvDrift === 0 ? '✓ Cross-block confirmed' : '✗ Failed'}\n`);

        // Restore.
        const drvRestore = buildStateBroadcastTriple(DRIVE_1_EFFECT_ID, driveSnap1.values, 0x01);
        for (const frame of drvRestore) output.sendMessage(frame);
        await sleep(500);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // TEST 3: Channel interaction (does fn=0x1F read X or Y?)
    // ══════════════════════════════════════════════════════════════════
    console.log('┌─────────────────────────────────────────────────────────┐');
    console.log('│  TEST 3: Channel interaction (X vs Y via fn=0x11)        │');
    console.log('└─────────────────────────────────────────────────────────┘\n');

    // Read Amp 1 on channel X (default).
    const xSnap = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
    if (!xSnap) { console.error('  fn=0x1F read failed'); process.exit(1); }
    console.log(`  Channel X read: ${xSnap.values.length} values, first 5: [${xSnap.values.slice(0, 5).join(', ')}]`);

    // Switch to channel Y via fn=0x11.
    console.log('  Switching Amp 1 to channel Y via fn=0x11...');
    output.sendMessage(buildSetBlockChannel(AMP_1_EFFECT_ID, 1)); // 1 = Y
    await sleep(500);

    // Read again. If fn=0x1F is channel-aware, values may differ.
    const ySnap = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
    if (!ySnap) { console.error('  fn=0x1F read after Y-switch failed'); process.exit(1); }
    console.log(`  Channel Y read: ${ySnap.values.length} values, first 5: [${ySnap.values.slice(0, 5).join(', ')}]`);

    // Compare.
    let channelDiffs = 0;
    const channelDiffPositions: { pos: number; x: number; y: number }[] = [];
    for (let i = 0; i < Math.min(xSnap.values.length, ySnap.values.length); i++) {
      if (xSnap.values[i] !== ySnap.values[i]) {
        channelDiffs++;
        if (channelDiffPositions.length < 10) {
          channelDiffPositions.push({ pos: i, x: xSnap.values[i], y: ySnap.values[i] });
        }
      }
    }

    if (channelDiffs === 0) {
      console.log('  X and Y reads are IDENTICAL. fn=0x1F ignores channel state.');
      console.log('  RISK: triple write may only affect X. Channel Y might need separate handling.');
    } else {
      console.log(`  X and Y differ at ${channelDiffs} positions. fn=0x1F IS channel-aware.`);
      console.log('  SAFE: triple write targets the active channel. Need two writes for X+Y.');
      for (const d of channelDiffPositions) {
        console.log(`    pos[${d.pos}]: X=${d.x}, Y=${d.y}`);
      }
    }

    // Switch back to X.
    output.sendMessage(buildSetBlockChannel(AMP_1_EFFECT_ID, 0)); // 0 = X
    await sleep(300);
    console.log('  Restored channel X.\n');

    // ══════════════════════════════════════════════════════════════════
    // TEST 4: Multi-param simultaneous write
    // ══════════════════════════════════════════════════════════════════
    console.log('┌─────────────────────────────────────────────────────────┐');
    console.log('│  TEST 4: Multi-param simultaneous write (3 positions)    │');
    console.log('└─────────────────────────────────────────────────────────┘\n');

    const multiBase = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
    if (!multiBase) { console.error('  Read failed'); process.exit(1); }

    // Modify positions 1 (input_drive), 2 (bass), 4 (treble).
    const multiMod = [...multiBase.values];
    const targets = [
      { pos: 1, name: 'input_drive' },
      { pos: 2, name: 'bass' },
      { pos: 4, name: 'treble' },
    ];
    for (const t of targets) {
      multiMod[t.pos] = multiBase.values[t.pos] > 32768 ? 16384 : 49152;
    }

    console.log('  Writing 3 modified positions in one triple...');
    for (const t of targets) {
      console.log(`    pos[${t.pos}] (${t.name}): ${multiBase.values[t.pos]} -> ${multiMod[t.pos]}`);
    }

    const multiFrames = buildStateBroadcastTriple(AMP_1_EFFECT_ID, multiMod, 0x01);
    for (const frame of multiFrames) output.sendMessage(frame);
    await sleep(1000);

    const multiRead = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
    if (!multiRead) { console.error('  Post-write read failed'); process.exit(1); }

    let multiSuccess = true;
    for (const t of targets) {
      const landed = multiRead.values[t.pos] === multiMod[t.pos];
      console.log(`    pos[${t.pos}] (${t.name}): expected=${multiMod[t.pos]}, got=${multiRead.values[t.pos]} ${landed ? '✓' : '✗'}`);
      if (!landed) multiSuccess = false;
    }

    let multiDrift = 0;
    for (let i = 0; i < multiMod.length; i++) {
      if (multiRead.values[i] !== multiMod[i]) multiDrift++;
    }
    console.log(`  Collateral drift: ${multiDrift} positions unexpected`);
    console.log(`  TEST 4: ${multiSuccess && multiDrift === 0 ? '✓ Multi-param write confirmed' : '✗ Failed'}\n`);

    // Restore.
    const multiRestore = buildStateBroadcastTriple(AMP_1_EFFECT_ID, multiBase.values, 0x01);
    for (const frame of multiRestore) output.sendMessage(frame);
    await sleep(500);

    // ══════════════════════════════════════════════════════════════════
    // TEST 5: Timing — measure round-trip latency
    // ══════════════════════════════════════════════════════════════════
    console.log('┌─────────────────────────────────────────────────────────┐');
    console.log('│  TEST 5: Round-trip timing (read + write + verify)       │');
    console.log('└─────────────────────────────────────────────────────────┘\n');

    const t0 = Date.now();
    const timingRead = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
    const t1 = Date.now();
    if (timingRead) {
      const timingMod = [...timingRead.values];
      timingMod[2] = timingRead.values[2] > 32768 ? 16384 : 49152;
      const timingFrames = buildStateBroadcastTriple(AMP_1_EFFECT_ID, timingMod, 0x01);
      for (const frame of timingFrames) output.sendMessage(frame);
      const t2 = Date.now();
      await sleep(200); // minimal settle
      const timingVerify = await readAllParamsViaFn1F(output, collected, AMP_1_EFFECT_ID);
      const t3 = Date.now();

      console.log(`  fn=0x1F read:     ${t1 - t0} ms`);
      console.log(`  Triple send:      ${t2 - t1} ms (${timingFrames.length} frames)`);
      console.log(`  Settle + verify:  ${t3 - t2} ms`);
      console.log(`  Total round-trip: ${t3 - t0} ms`);
      if (timingVerify) {
        const landed = timingVerify.values[2] === timingMod[2];
        console.log(`  Write landed: ${landed ? '✓' : '✗'}`);
      }
      console.log('');

      // Compare: 236 individual fn=0x2e messages at ~50ms each = ~11.8s
      // vs this triple path
      console.log(`  Comparison:`);
      console.log(`    Sequential fn=0x2e (236 params): ~${236 * 50}ms estimated`);
      console.log(`    Triple path (read + write + verify): ${t3 - t0}ms measured`);
      console.log(`    Speedup: ~${Math.round((236 * 50) / (t3 - t0))}x\n`);

      // Restore.
      const timingRestore = buildStateBroadcastTriple(AMP_1_EFFECT_ID, timingRead.values, 0x01);
      for (const frame of timingRestore) output.sendMessage(frame);
      await sleep(500);
    }

    // ── Final summary ──
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  VALIDATION SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Review each TEST result above.');
    console.log('  Critical for apply_preset redesign:');
    console.log('    - TEST 1 must be ✓ (no position corruption)');
    console.log('    - TEST 3 determines X/Y write strategy');
    console.log('    - TEST 5 confirms the performance win is real');
    console.log('═══════════════════════════════════════════════════════════════\n');

  } finally {
    input.closePort();
    output.closePort();
    console.log('  Ports closed.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
