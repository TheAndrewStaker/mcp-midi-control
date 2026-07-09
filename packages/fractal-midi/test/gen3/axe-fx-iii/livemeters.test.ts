/**
 * Gen-3 live-meters codec goldens (fn=0x01 sub=0x2E telemetry payload).
 *
 * The decode (`cpu% = 32 + f[37]*0.5`, `outL = f[35]/127`, `outR = f[36]/127`,
 * F0-included offsets) is cross-validated against our FM9 capture: across the
 * 10 same-preset sub=0x2E reads only [35]/[36] varied (output meters bouncing)
 * while [37] held constant at 66 (→ 65.0% CPU). These goldens lock the offsets
 * and arithmetic; the real-capture cross-validation runs in
 * `scripts/verify-gen3-grid-layout.ts` against the gitignored sample.
 */
import { parseGen3LiveMeters } from '../../../src/gen3/axe-fx-iii/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** Build a sub=0x2E frame (F0-included) with given meter bytes; padded long. */
function buildFrame(outL: number, outR: number, cpuRaw: number, len = 755): number[] {
  const f = new Array(len).fill(0);
  f[0] = 0xf0;
  f[1] = 0x00;
  f[2] = 0x01;
  f[3] = 0x74;
  f[4] = 0x12; // FM9 model byte
  f[5] = 0x01; // fn = parameter set/get
  f[6] = 0x2e; // sub = grid/meters
  f[35] = outL;
  f[36] = outR;
  f[37] = cpuRaw;
  f[len - 1] = 0xf7;
  return f;
}

const cases: Array<() => void> = [];

// 1. The exact FM9-capture values: [37]=66 → 65.0%, plus a representative
//    output-meter frame ([35]=97, [36]=7 from the first captured grid read).
cases.push(() => {
  const m = parseGen3LiveMeters(buildFrame(97, 7, 66));
  assert(m.cpu_percent === 65, `cpu_percent should be 65, got ${m.cpu_percent}`);
  assert(m.output_left === Math.round((97 / 127) * 1000) / 1000, `outL mismatch: ${m.output_left}`);
  assert(m.output_right === Math.round((7 / 127) * 1000) / 1000, `outR mismatch: ${m.output_right}`);
});

// 2. Boundaries: raw CPU 0 → 32.0%, raw 127 → 95.5%; full-scale meter → 1.
cases.push(() => {
  const lo = parseGen3LiveMeters(buildFrame(0, 0, 0));
  assert(lo.cpu_percent === 32, `cpu floor should be 32, got ${lo.cpu_percent}`);
  assert(lo.output_left === 0 && lo.output_right === 0, 'zero meters → 0');
  const hi = parseGen3LiveMeters(buildFrame(127, 127, 127));
  assert(hi.cpu_percent === 95.5, `cpu ceil should be 95.5, got ${hi.cpu_percent}`);
  assert(hi.output_left === 1 && hi.output_right === 1, 'full-scale meters → 1');
});

// 3. Works on an FM3-length frame too (offsets are pre-grid, device-invariant).
cases.push(() => {
  const m = parseGen3LiveMeters(buildFrame(64, 32, 40, 590));
  assert(m.cpu_percent === 52, `fm3-length cpu should be 52, got ${m.cpu_percent}`);
});

// 4. A non-sub=0x2E frame throws (no silent mis-decode of another frame type).
cases.push(() => {
  let threw = false;
  try {
    // fn=0x01 sub=0x09 (a set-value frame), not 0x2E.
    const f = buildFrame(10, 10, 10);
    f[6] = 0x09;
    parseGen3LiveMeters(f);
  } catch {
    threw = true;
  }
  assert(threw, 'a non-sub=0x2E frame must throw');
});

// 5. A frame too short for the CPU offset throws (no partial decode).
cases.push(() => {
  let threw = false;
  try {
    parseGen3LiveMeters([0xf0, 0x00, 0x01, 0x74, 0x12, 0x01, 0x2e, 0xf7]);
  } catch {
    threw = true;
  }
  assert(threw, 'a frame too short for the meter region must throw');
});

// 6. A BLOCK-TARGETED sub=0x2E frame (target bytes [8]/[10] populated) decodes
//    the SAME meters: in the FM3 capture (fm3-community-2026-06-12, job3,
//    three block-targeted reads of one static preset) f[35]/f[36] varied
//    (output meters) while f[37]=69 held constant (66.5% CPU). The earlier
//    refusal's premise ("bytes 35-37 are not meters there") was never
//    established. Parity with parseGen3GridLayout.
cases.push(() => {
  const f = buildFrame(38, 40, 69, 590);
  f[4] = 0x11; // FM3 model byte (the capture the evidence comes from)
  f[8] = 0x3a; // effectId populated → block-targeted
  f[10] = 0x0a; // paramId populated
  const m = parseGen3LiveMeters(f);
  assert(m.cpu_percent === 66.5, `block-targeted cpu should be 66.5, got ${m.cpu_percent}`);
  assert(m.output_left === Math.round((38 / 127) * 1000) / 1000, `block-targeted outL mismatch: ${m.output_left}`);
});

export function runGen3LiveMetersTests(): void {
  for (const c of cases) c();
}
export const GEN3_LIVEMETERS_CASE_COUNT = cases.length;
