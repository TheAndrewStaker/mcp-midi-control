/**
 * Probe: Which positions in the fn=0x1F state dump are per-channel vs shared?
 *
 * Method:
 *   1. Read baseline state on X via fn=0x1F
 *   2. Switch to Y, write a unique marker to EVERY position via fn=0x2e
 *   3. Switch to X, read fn=0x1F: positions that changed = SHARED
 *      (fn=0x1F is monolithic, so if writing on Y changed the fn=0x1F
 *      value, that position is shared between channels in the monolithic view)
 *   4. Switch to X, read each position via fn=0x02 GET
 *   5. Switch to Y, read each position via fn=0x02 GET
 *   6. Compare: positions where X GET != Y GET = PER-CHANNEL
 *
 * Actually simpler approach since fn=0x1F is monolithic:
 *   1. Switch to X, write marker value to first N positions via fn=0x2e
 *   2. Switch to Y, read those positions via fn=0x02 GET
 *   3. If GET on Y returns the marker = SHARED; if GET returns something else = PER-CHANNEL
 *
 * Tests Amp 1 (236 positions) and Drive 1 (78 positions).
 *
 * SAFETY: saves full state via fn=0x1F before modifying, restores via
 * per-param fn=0x2e writes at the end.
 *
 * Run:
 *   npx tsx scripts/_research/probe-axefx2-channel-position-map.ts
 */

import midi from "@julusian/midi";

const AXE_FX_II_MODEL = 0x07;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const SYSEX_START = 0xf0;

const FN_BLOCK_PARAM = 0x02;
const FN_BLOCK_CHANNEL = 0x11;
const FN_GET_ALL_PARAMS = 0x1f;
const FN_SET_PARAM_DIRECT = 0x2e;
const FN_STATE_HEADER = 0x74;
const FN_STATE_CHUNK = 0x75;
const FN_STATE_FOOTER = 0x76;
const FN_MULTIPURPOSE = 0x64;

const ACTION_QUERY = 0x00;
const TIMEOUT_MS = 3000;
const AMP_1 = 106;
const DRIVE_1 = 108;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}
function buildEnvelope(fn: number, payload: number[] = []): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, AXE_FX_II_MODEL, fn, ...payload];
  return [...head, fractalChecksum(head), 0xf7];
}
function encode14(n: number): [number, number] { return [n & 0x7f, (n >> 7) & 0x7f]; }
function decode14(lo: number, hi: number): number { return (lo & 0x7f) | ((hi & 0x7f) << 7); }
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
function isFractalFn(bytes: number[], fn: number): boolean {
  return bytes.length >= 7 && bytes[0] === 0xf0 && bytes[1] === 0x00
    && bytes[2] === 0x01 && bytes[3] === 0x74 && bytes[4] === AXE_FX_II_MODEL && bytes[5] === fn;
}

interface StateDump { values: number[] }

async function readAllParams(
  output: midi.Output, collected: number[][], effectId: number,
): Promise<StateDump | null> {
  const before = collected.length;
  output.sendMessage(buildEnvelope(FN_GET_ALL_PARAMS, [...encode14(effectId)]));
  const deadline = Date.now() + TIMEOUT_MS;
  let gotHeader = false;
  const values: number[] = [];
  while (Date.now() < deadline) {
    await sleep(50);
    for (let i = before; i < collected.length; i++) {
      const frame = collected[i];
      if (isFractalFn(frame, FN_STATE_HEADER)) {
        const tId = decode14(frame[6], frame[7]);
        if (tId === effectId && !gotHeader) gotHeader = true;
      } else if (isFractalFn(frame, FN_STATE_CHUNK) && gotHeader) {
        const n = decode14(frame[6], frame[7]);
        for (let j = 0; j < n; j++) {
          const off = 8 + j * 3;
          if (off + 2 < frame.length - 2) values.push(decode16Packed(frame[off], frame[off + 1], frame[off + 2]));
        }
      } else if (isFractalFn(frame, FN_STATE_FOOTER) && gotHeader) {
        return { values };
      } else if (isFractalFn(frame, FN_MULTIPURPOSE)) return null;
    }
  }
  if (gotHeader) return { values };
  return null;
}

function switchChannel(output: midi.Output, effectId: number, channel: 0 | 1): void {
  output.sendMessage(buildEnvelope(FN_BLOCK_CHANNEL, [...encode14(effectId), channel]));
}

interface GetResult { wire: number; label: string }

async function getParam(
  output: midi.Output, collected: number[][], effectId: number, paramId: number,
): Promise<GetResult | null> {
  const before = collected.length;
  output.sendMessage(buildEnvelope(FN_BLOCK_PARAM, [
    ...encode14(effectId), ...encode14(paramId), 0x00, 0x00, 0x00, ACTION_QUERY,
  ]));
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(20);
    for (let i = before; i < collected.length; i++) {
      const bytes = collected[i];
      if (!isFractalFn(bytes, FN_BLOCK_PARAM) || bytes.length < 17) continue;
      const eff = decode14(bytes[6], bytes[7]);
      const param = decode14(bytes[8], bytes[9]);
      if (eff !== effectId || param !== paramId) continue;
      const wire = decode16Packed(bytes[10], bytes[11], bytes[12]);
      const labelBytes: number[] = [];
      for (let j = 18; j < bytes.length - 2 && bytes[j] !== 0x00; j++) labelBytes.push(bytes[j]);
      return { wire, label: String.fromCharCode(...labelBytes) };
    }
  }
  return null;
}

async function probeBlock(
  output: midi.Output, collected: number[][],
  effectId: number, blockName: string, maxPositions: number,
): Promise<void> {
  console.log(`\n=== ${blockName} (effectId=${effectId}, ${maxPositions} positions) ===\n`);

  // Save original X and Y state.
  switchChannel(output, effectId, 0);
  await sleep(200);
  const origX = await readAllParams(output, collected, effectId);
  if (!origX) { console.log('  SKIP: cannot read X state'); return; }

  // Write a unique marker to each tested position on X.
  // Use display value 1.11 (distinctive, unlikely to be a default).
  const MARKER = 1.11;
  const testPositions = Math.min(maxPositions, origX.values.length);

  console.log(`  Writing marker ${MARKER} to positions 0..${testPositions - 1} on X...`);
  switchChannel(output, effectId, 0);
  await sleep(200);
  for (let pos = 0; pos < testPositions; pos++) {
    output.sendMessage(buildEnvelope(FN_SET_PARAM_DIRECT, [
      ...encode14(effectId), ...encode14(pos), ...packFloat32ForDirect(MARKER),
    ]));
    // Small delay every 10 writes to avoid overwhelming the USB buffer.
    if (pos % 10 === 9) await sleep(50);
  }
  await sleep(300);

  // Now read each position on Y via fn=0x02 GET.
  // If Y returns the marker, the position is shared.
  // If Y returns something different, it's per-channel.
  console.log(`  Reading positions on Y via fn=0x02 GET...`);
  switchChannel(output, effectId, 1);
  await sleep(200);

  const perChannel: number[] = [];
  const shared: number[] = [];
  const noResponse: number[] = [];
  const yValues: Map<number, GetResult> = new Map();

  for (let pos = 0; pos < testPositions; pos++) {
    const result = await getParam(output, collected, effectId, pos);
    if (!result) {
      noResponse.push(pos);
      continue;
    }
    yValues.set(pos, result);
  }

  // Also read X via fn=0x02 GET to compare.
  console.log(`  Reading positions on X via fn=0x02 GET...`);
  switchChannel(output, effectId, 0);
  await sleep(200);

  const xValues: Map<number, GetResult> = new Map();
  for (let pos = 0; pos < testPositions; pos++) {
    const result = await getParam(output, collected, effectId, pos);
    if (result) xValues.set(pos, result);
  }

  // Classify.
  for (let pos = 0; pos < testPositions; pos++) {
    const x = xValues.get(pos);
    const y = yValues.get(pos);
    if (!x || !y) continue;
    if (x.wire !== y.wire) {
      perChannel.push(pos);
    } else {
      shared.push(pos);
    }
  }

  console.log(`\n  Results for ${blockName}:`);
  console.log(`    Total positions tested: ${testPositions}`);
  console.log(`    Per-channel (X != Y): ${perChannel.length} positions`);
  console.log(`    Shared (X == Y):      ${shared.length} positions`);
  console.log(`    No response:          ${noResponse.length} positions`);
  if (perChannel.length > 0) {
    console.log(`\n    Per-channel positions: [${perChannel.join(', ')}]`);
  }
  if (noResponse.length > 0) {
    console.log(`    No-response positions: [${noResponse.join(', ')}]`);
  }

  // Restore original X state.
  console.log(`\n  Restoring original X state...`);
  switchChannel(output, effectId, 0);
  await sleep(200);
  for (let pos = 0; pos < origX.values.length; pos++) {
    output.sendMessage(buildEnvelope(FN_SET_PARAM_DIRECT, [
      ...encode14(effectId), ...encode14(pos), ...packFloat32ForDirect(origX.values[pos]),
    ]));
    if (pos % 10 === 9) await sleep(50);
  }
  await sleep(300);

  // Leave on X.
  switchChannel(output, effectId, 0);
  await sleep(100);
  console.log(`  Restore complete.\n`);
}

async function main(): Promise<void> {
  console.log('===================================================================');
  console.log('  Channel-Position Mapping: which positions are per-channel?');
  console.log('===================================================================\n');

  const input = new midi.Input();
  const output = new midi.Output();
  const needles = ['Axe-Fx II', 'AxeFxII', 'AXE-FX II', 'XL+'];
  const outIdx = findPort(output, needles);
  if (outIdx < 0) { console.error('ERROR: output port not found'); process.exit(1); }
  const inIdx = findPort(input, needles);
  if (inIdx < 0) { console.error('ERROR: input port not found'); process.exit(1); }

  console.log(`  Output: ${output.getPortName(outIdx)}`);
  console.log(`  Input:  ${input.getPortName(inIdx)}`);

  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);
  const collected: number[][] = [];
  input.on('message', (_dt, bytes) => { if (bytes[0] === 0xf0) collected.push(bytes.slice()); });
  input.openPort(inIdx);
  await sleep(500);
  collected.length = 0;

  try {
    await probeBlock(output, collected, AMP_1, 'Amp 1', 50);
    await probeBlock(output, collected, DRIVE_1, 'Drive 1', 30);
  } finally {
    input.closePort();
    output.closePort();
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
