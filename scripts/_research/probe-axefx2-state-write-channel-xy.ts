/**
 * HW-125: Channel X/Y triple-write workflow proof.
 *
 * Tests the full production workflow for channel-safe atomic writes:
 *   1. Switch to channel X, write params via triple, verify
 *   2. Switch to channel Y, write DIFFERENT params via triple, verify
 *   3. Switch back to X, confirm X values held (no Y clobber)
 *   4. Switch to Y, confirm Y values held (no X clobber)
 *
 * Also tests: calibrating multiple positions within Drive 1 to confirm
 * all positions share the same display-integer encoding.
 *
 * Run:
 *   npx tsx scripts/_research/probe-axefx2-state-write-channel-xy.ts
 */

import midi from "@julusian/midi";

const AXE_FX_II_MODEL = 0x07;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;

const FN_GET_ALL_PARAMS = 0x1f;
const FN_SET_PARAM_DIRECT = 0x2e;
const FN_BLOCK_CHANNEL = 0x11;
const FN_STATE_HEADER = 0x74;
const FN_STATE_CHUNK = 0x75;
const FN_STATE_FOOTER = 0x76;
const FN_MULTIPURPOSE = 0x64;

const TRIPLE_TIMEOUT_MS = 3000;
const STATE_DUMP_CHUNK_MAX_ITEMS = 64;

const AMP_1 = 106;
const DRIVE_1 = 108;

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
function switchChannel(output: midi.Output, effectId: number, channel: number): void {
  output.sendMessage(buildEnvelope(FN_BLOCK_CHANNEL, [...encode14(effectId), channel]));
}
function buildSetParamDirect(effectId: number, paramId: number, displayValue: number): number[] {
  return buildEnvelope(FN_SET_PARAM_DIRECT, [...encode14(effectId), ...encode14(paramId), ...packFloat32ForDirect(displayValue)]);
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  HW-125: Channel X/Y Triple-Write Workflow Proof');
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
    // ══════════════════════════════════════════════════════════════════
    // PART 1: Full X/Y channel-isolated triple write on Amp 1
    // ══════════════════════════════════════════════════════════════════
    console.log('┌─────────────────────────────────────────────────────────┐');
    console.log('│  PART 1: Amp 1 X/Y channel-isolated triple writes       │');
    console.log('└─────────────────────────────────────────────────────────┘\n');

    // Step 1: Save original X and Y states.
    switchChannel(output, AMP_1, 0); // X
    await sleep(300);
    const origX = await readAllParams(output, collected, AMP_1);
    if (!origX) { console.error('ABORT: cannot read Amp 1 X'); process.exit(1); }

    switchChannel(output, AMP_1, 1); // Y
    await sleep(300);
    const origY = await readAllParams(output, collected, AMP_1);
    if (!origY) { console.error('ABORT: cannot read Amp 1 Y'); process.exit(1); }

    console.log(`  Original X[1..4]: [${origX.values.slice(1, 5).join(', ')}]`);
    console.log(`  Original Y[1..4]: [${origY.values.slice(1, 5).join(', ')}]`);

    // Step 2: Write DIFFERENT values to X and Y.
    // X: set pos[1]=10000, pos[2]=20000 (input_drive, bass)
    // Y: set pos[1]=50000, pos[2]=60000
    const writeX = [...origX.values];
    writeX[1] = 10000;
    writeX[2] = 20000;

    const writeY = [...origY.values];
    writeY[1] = 50000;
    writeY[2] = 60000;

    // Write X.
    switchChannel(output, AMP_1, 0);
    await sleep(300);
    console.log('\n  Writing X: pos[1]=10000, pos[2]=20000...');
    const xFrames = buildTripleFrames(AMP_1, writeX, 0x01);
    for (const f of xFrames) output.sendMessage(f);
    await sleep(500);

    // Write Y.
    switchChannel(output, AMP_1, 1);
    await sleep(300);
    console.log('  Writing Y: pos[1]=50000, pos[2]=60000...');
    const yFrames = buildTripleFrames(AMP_1, writeY, 0x01);
    for (const f of yFrames) output.sendMessage(f);
    await sleep(500);

    // Step 3: Verify X held.
    switchChannel(output, AMP_1, 0);
    await sleep(300);
    const verifyX = await readAllParams(output, collected, AMP_1);
    if (!verifyX) { console.error('  X verify read failed'); process.exit(1); }

    const xOk = verifyX.values[1] === 10000 && verifyX.values[2] === 20000;
    console.log(`\n  Verify X: pos[1]=${verifyX.values[1]} (expect 10000), pos[2]=${verifyX.values[2]} (expect 20000)`);
    console.log(`  X held after Y write: ${xOk ? '✓' : '✗'}`);

    // Step 4: Verify Y held.
    switchChannel(output, AMP_1, 1);
    await sleep(300);
    const verifyY = await readAllParams(output, collected, AMP_1);
    if (!verifyY) { console.error('  Y verify read failed'); process.exit(1); }

    const yOk = verifyY.values[1] === 50000 && verifyY.values[2] === 60000;
    console.log(`  Verify Y: pos[1]=${verifyY.values[1]} (expect 50000), pos[2]=${verifyY.values[2]} (expect 60000)`);
    console.log(`  Y held after X verify: ${yOk ? '✓' : '✗'}`);

    // Full isolation check: did writing Y clobber ANY X position?
    let xDrift = 0;
    for (let i = 0; i < writeX.length; i++) {
      if (verifyX.values[i] !== writeX[i]) xDrift++;
    }
    let yDrift = 0;
    for (let i = 0; i < writeY.length; i++) {
      if (verifyY.values[i] !== writeY[i]) yDrift++;
    }
    console.log(`\n  X total drift: ${xDrift}/${writeX.length}`);
    console.log(`  Y total drift: ${yDrift}/${writeY.length}`);
    console.log(`  CHANNEL ISOLATION: ${xDrift === 0 && yDrift === 0 ? '✓ PERFECT' : '✗ BREACH'}`);

    // Restore both channels.
    switchChannel(output, AMP_1, 0);
    await sleep(200);
    for (const f of buildTripleFrames(AMP_1, origX.values, 0x01)) output.sendMessage(f);
    await sleep(300);
    switchChannel(output, AMP_1, 1);
    await sleep(200);
    for (const f of buildTripleFrames(AMP_1, origY.values, 0x01)) output.sendMessage(f);
    await sleep(300);
    switchChannel(output, AMP_1, 0); // leave on X
    await sleep(200);

    // ══════════════════════════════════════════════════════════════════
    // PART 2: Drive 1 multi-position encoding survey
    // ══════════════════════════════════════════════════════════════════
    console.log('\n┌─────────────────────────────────────────────────────────┐');
    console.log('│  PART 2: Drive 1 full encoding survey (positions 0..10)  │');
    console.log('└─────────────────────────────────────────────────────────┘\n');

    // For each position in Drive 1, write display=5 via fn=0x2e and read
    // what state-dump value appears. This tells us if ALL positions use
    // display-int encoding or if some use wire16.
    const driveBase = await readAllParams(output, collected, DRIVE_1);
    if (!driveBase) {
      console.log('  SKIP: Drive 1 not placed\n');
    } else {
      console.log(`  Drive 1 has ${driveBase.values.length} positions`);
      console.log(`  Testing positions 0..15 (write display=5 via fn=0x2e, read state-dump):`);
      console.log(`  pos | before | after(5) | encoding`);
      console.log(`  ----|--------|----------|----------`);

      const testPositions = Math.min(16, driveBase.values.length);
      const encodings: string[] = [];

      for (let pos = 0; pos < testPositions; pos++) {
        const before = driveBase.values[pos];
        // Write display=5.0 to this paramId.
        output.sendMessage(buildSetParamDirect(DRIVE_1, pos, 5.0));
        await sleep(200);
        const after = await readAllParams(output, collected, DRIVE_1);
        if (!after) { console.log(`  ${pos.toString().padStart(3)} | read failed`); continue; }
        const afterVal = after.values[pos];
        let enc: string;
        if (afterVal === 32767 || afterVal === 32768) enc = 'wire16';
        else if (afterVal === 5) enc = 'display-int';
        else if (afterVal >= 1000) enc = `wire16? (${afterVal})`;
        else enc = `display-int? (${afterVal})`;
        encodings.push(enc);
        console.log(`  ${pos.toString().padStart(3)} | ${before.toString().padStart(6)} | ${afterVal.toString().padStart(8)} | ${enc}`);
      }

      // Restore Drive 1.
      for (const f of buildTripleFrames(DRIVE_1, driveBase.values, 0x01)) output.sendMessage(f);
      await sleep(300);

      const wire16Count = encodings.filter(e => e.startsWith('wire16')).length;
      const displayIntCount = encodings.filter(e => e.startsWith('display-int')).length;
      console.log(`\n  Summary: ${wire16Count} wire16, ${displayIntCount} display-int out of ${testPositions} tested`);
    }

    // ══════════════════════════════════════════════════════════════════
    // PART 3: Amp 1 encoding survey (control, should be all wire16)
    // ══════════════════════════════════════════════════════════════════
    console.log('\n┌─────────────────────────────────────────────────────────┐');
    console.log('│  PART 3: Amp 1 encoding survey (positions 0..15)         │');
    console.log('└─────────────────────────────────────────────────────────┘\n');

    const ampBase = await readAllParams(output, collected, AMP_1);
    if (!ampBase) {
      console.log('  SKIP: Amp 1 not placed\n');
    } else {
      console.log(`  pos | before | after(5) | encoding`);
      console.log(`  ----|--------|----------|----------`);

      const ampEncodings: string[] = [];
      for (let pos = 0; pos < 16; pos++) {
        const before = ampBase.values[pos];
        output.sendMessage(buildSetParamDirect(AMP_1, pos, 5.0));
        await sleep(200);
        const after = await readAllParams(output, collected, AMP_1);
        if (!after) { console.log(`  ${pos.toString().padStart(3)} | read failed`); continue; }
        const afterVal = after.values[pos];
        let enc: string;
        if (afterVal >= 30000 && afterVal <= 35000) enc = 'wire16';
        else if (afterVal === 5) enc = 'display-int';
        else if (afterVal >= 1000) enc = `wire16? (${afterVal})`;
        else enc = `other (${afterVal})`;
        ampEncodings.push(enc);
        console.log(`  ${pos.toString().padStart(3)} | ${before.toString().padStart(6)} | ${afterVal.toString().padStart(8)} | ${enc}`);
      }

      // Restore.
      for (const f of buildTripleFrames(AMP_1, ampBase.values, 0x01)) output.sendMessage(f);
      await sleep(300);

      const ampWire = ampEncodings.filter(e => e.startsWith('wire16')).length;
      console.log(`\n  Summary: ${ampWire} wire16 out of 16 tested`);
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════\n');

  } finally {
    input.closePort();
    output.closePort();
  }
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
