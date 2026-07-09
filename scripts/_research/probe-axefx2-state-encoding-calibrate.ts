/**
 * HW-125 decode: calibrate state-broadcast value encoding for failing blocks.
 *
 * For each of the 6 blocks that failed triple writes (Drive, Compressor,
 * Phaser, Filter, GEQ, PEQ), this script:
 *
 *   1. Picks a known continuous-knob param (display range 0..10 or similar)
 *   2. Writes a series of known display values via fn=0x2e (proven to work)
 *   3. After each write, reads back via fn=0x1F to see what wire value
 *      the state-dump reports at that position
 *   4. Builds a (display_value -> state_dump_value) mapping table
 *
 * This reveals whether the state-dump uses display-scale, wire-scale (0..65535),
 * or something else entirely.
 *
 * Also calibrates a WORKING block (Amp) as a control baseline.
 *
 * Run:
 *   npx tsx scripts/_research/probe-axefx2-state-encoding-calibrate.ts
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

interface CalibrationTarget {
  name: string;
  effectId: number;
  paramId: number;
  paramName: string;
  displayMin: number;
  displayMax: number;
  steps: number[];
}

const TARGETS: CalibrationTarget[] = [
  // Control: working block
  {
    name: 'Amp 1', effectId: 106, paramId: 2, paramName: 'bass',
    displayMin: 0, displayMax: 10,
    steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  },
  // Failing blocks
  {
    name: 'Drive 1', effectId: 108, paramId: 1, paramName: 'gain',
    displayMin: 0, displayMax: 10,
    steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  },
  {
    name: 'Compressor 1', effectId: 116, paramId: 1, paramName: 'threshold',
    displayMin: 0, displayMax: 10,
    steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  },
  {
    name: 'Phaser 1', effectId: 122, paramId: 1, paramName: 'rate',
    displayMin: 0, displayMax: 10,
    steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  },
  {
    name: 'Filter 1', effectId: 130, paramId: 1, paramName: 'frequency',
    displayMin: 0, displayMax: 10,
    steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  },
  {
    name: 'Graphic EQ 1', effectId: 146, paramId: 1, paramName: 'band1',
    displayMin: -12, displayMax: 12,
    steps: [-12, -9, -6, -3, 0, 3, 6, 9, 12],
  },
  {
    name: 'Parametric EQ 1', effectId: 148, paramId: 1, paramName: 'freq1',
    displayMin: 0, displayMax: 10,
    steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  },
];

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  HW-125 Decode: State-Broadcast Value Encoding Calibration');
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

  try {
    for (const target of TARGETS) {
      console.log(`┌─────────────────────────────────────────────────────────┐`);
      console.log(`│  ${target.name} — ${target.paramName} (pos ${target.paramId})`.padEnd(58) + '│');
      console.log(`└─────────────────────────────────────────────────────────┘`);

      // Check if block is placed.
      const check = await readAllParams(output, collected, target.effectId);
      if (!check) {
        console.log(`  SKIP: not placed (fn=0x1F NACK/timeout)\n`);
        continue;
      }
      console.log(`  Block has ${check.values.length} positions in state-dump`);

      // Save original value for restore.
      const originalValue = check.values[target.paramId];
      console.log(`  Original state-dump value at pos[${target.paramId}]: ${originalValue}`);

      // Sweep: write each display value, read back state-dump value.
      const mapping: { display: number; stateDump: number }[] = [];
      console.log(`\n  display -> state-dump mapping:`);

      for (const displayVal of target.steps) {
        output.sendMessage(buildSetParamDirect(target.effectId, target.paramId, displayVal));
        await sleep(200);

        const snap = await readAllParams(output, collected, target.effectId);
        if (!snap) {
          console.log(`    ${displayVal.toString().padStart(4)} -> READ FAILED`);
          continue;
        }
        const stateVal = snap.values[target.paramId];
        mapping.push({ display: displayVal, stateDump: stateVal });
        console.log(`    ${displayVal.toString().padStart(4)} -> ${stateVal}`);
      }

      // Analyze the mapping.
      if (mapping.length >= 2) {
        const first = mapping[0];
        const last = mapping[mapping.length - 1];
        const range = last.stateDump - first.stateDump;
        const displayRange = last.display - first.display;
        const scale = range / displayRange;

        console.log(`\n  Analysis:`);
        console.log(`    State-dump range: ${first.stateDump}..${last.stateDump} (span=${range})`);
        console.log(`    Display range:    ${first.display}..${last.display} (span=${displayRange})`);
        console.log(`    Scale factor:     ${scale.toFixed(4)} state-units per display-unit`);

        if (Math.abs(scale - 6553.5) < 100) {
          console.log(`    ENCODING: 16-bit linear (same as Amp) ≈ 65535/10`);
        } else if (Math.abs(scale - 1) < 0.1) {
          console.log(`    ENCODING: 1:1 display-scale (integer display values)`);
        } else {
          console.log(`    ENCODING: custom scale (${scale.toFixed(4)}x)`);
        }

        // Check linearity.
        let maxError = 0;
        for (const m of mapping) {
          const expected = first.stateDump + (m.display - first.display) * scale;
          const error = Math.abs(m.stateDump - expected);
          if (error > maxError) maxError = error;
        }
        console.log(`    Linearity error: max=${maxError.toFixed(2)} state-units`);
        if (maxError < 2) {
          console.log(`    Linear: YES`);
        } else {
          console.log(`    Linear: NO (might be log/exp or stepped)`);
          console.log(`    Raw pairs: ${mapping.map(m => `(${m.display},${m.stateDump})`).join(' ')}`);
        }
      }

      // Restore original.
      // Convert original state-dump value back to approximate display.
      if (mapping.length >= 2) {
        const first = mapping[0];
        const last = mapping[mapping.length - 1];
        const range = last.stateDump - first.stateDump;
        const displayRange = last.display - first.display;
        const restoreDisplay = range !== 0
          ? first.display + ((originalValue - first.stateDump) / range) * displayRange
          : first.display;
        output.sendMessage(buildSetParamDirect(target.effectId, target.paramId, restoreDisplay));
        await sleep(200);
      }

      console.log('');
    }

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  DONE. Ports closing.');
    console.log('═══════════════════════════════════════════════════════════════\n');

  } finally {
    input.closePort();
    output.closePort();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
