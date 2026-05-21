/**
 * mcp-midi-control — Decode 0x01-payload float packing scheme
 *
 * The 6-byte value field in a 0x01 WRITE carries a 32-bit IEEE 754 float
 * encoded with 10 bits of overhead. Session 04 + 05 captured 10
 * (float, wire) samples, including 0.0 (= all-zero wire) and -1.0
 * (the only sample that exercises the IEEE sign bit).
 *
 * `pack(0.0) = 0` and pairwise XOR checks show the encoding is linear
 * over GF(2): for any two samples a, b we have
 *   pack(a) XOR pack(b) = pack(a XOR b)   [bit-wise XOR of float reprs]
 *
 * That means the packer is a fixed 42x32 binary matrix M over GF(2):
 *   wire_bits = M . float_bits
 *
 * This script:
 *   1. Builds the augmented sample matrix [x | y].
 *   2. Verifies linearity by detecting any contradictions during RREF.
 *   3. Enumerates which IEEE-float bit positions are observable from the
 *      collected samples (rank check) and which are still unconstrained.
 *   4. Defines a brute-force packer over the observed subspace.
 *   5. Round-trips every sample to confirm the packer reproduces the
 *      captured wire bytes byte-for-byte.
 *   6. Probes a handful of MVP-relevant gain values (0.5, 1.0, 5.0, 10.0)
 *      and reports which ones the current sample set can pack.
 *
 * Tries both big-endian and little-endian float byte orderings — only one
 * will yield consistent linearity if the firmware reads the value with a
 * specific endianness.
 */

type Sample = { val: number; wire: number[] };

const SAMPLES: Sample[] = [
  { val: 0.0,   wire: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00] },
  { val: 0.25,  wire: [0x00, 0x66, 0x73, 0x19, 0x43, 0x60] },
  { val: 0.50,  wire: [0x00, 0x66, 0x73, 0x09, 0x43, 0x68] },
  { val: 1.00,  wire: [0x00, 0x66, 0x73, 0x19, 0x43, 0x68] },
  { val: 1.50,  wire: [0x00, 0x4D, 0x26, 0x23, 0x13, 0x70] },
  { val: 2.00,  wire: [0x00, 0x66, 0x73, 0x09, 0x43, 0x70] },
  { val: 2.50,  wire: [0x00, 0x00, 0x00, 0x10, 0x03, 0x70] },
  { val: 3.00,  wire: [0x00, 0x4D, 0x26, 0x33, 0x13, 0x70] },
  { val: 4.00,  wire: [0x00, 0x66, 0x73, 0x19, 0x43, 0x70] },
  { val: -1.00, wire: [0x00, 0x55, 0x6A, 0x55, 0x2B, 0x68] },
];

function floatToBits32(v: number, endian: 'BE' | 'LE'): number[] {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, v, endian === 'LE');
  const bytes = new Uint8Array(buf);
  const bits: number[] = [];
  for (let b = 0; b < 4; b++) {
    for (let bit = 7; bit >= 0; bit--) bits.push((bytes[b] >> bit) & 1);
  }
  return bits;
}

function wireToBits42(wire: number[]): number[] {
  const bits: number[] = [];
  for (const b of wire) {
    for (let bit = 6; bit >= 0; bit--) bits.push((b >> bit) & 1);
  }
  return bits;
}

function bits42ToWire(bits: number[]): number[] {
  const out: number[] = [];
  for (let s = 0; s < 6; s++) {
    let v = 0;
    for (let bit = 0; bit < 7; bit++) v = (v << 1) | bits[s * 7 + bit];
    out.push(v);
  }
  return out;
}

function hex(bytes: number[] | Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

type RrefResult = {
  linear: boolean;
  rank: number;
  observableBits: number[];
  unobservedBits: number[];
  pivotRow: number[]; // index into reduced rows, by input-col
  rows: number[][];   // RREF'd rows, each 32+42 = 74 bits
};

function rref(samples: Sample[], endian: 'BE' | 'LE'): RrefResult {
  const rows: number[][] = samples.map((s) => [
    ...floatToBits32(s.val, endian),
    ...wireToBits42(s.wire),
  ]);
  const N = rows.length;
  const W = 32 + 42;
  const pivotRow = new Array(32).fill(-1);
  let next = 0;
  for (let col = 0; col < 32 && next < N; col++) {
    let r = -1;
    for (let i = next; i < N; i++) if (rows[i][col] === 1) { r = i; break; }
    if (r < 0) continue;
    if (r !== next) [rows[next], rows[r]] = [rows[r], rows[next]];
    for (let i = 0; i < N; i++) {
      if (i !== next && rows[i][col] === 1) {
        for (let j = 0; j < W; j++) rows[i][j] ^= rows[next][j];
      }
    }
    pivotRow[col] = next;
    next++;
  }
  const rank = next;
  let linear = true;
  for (let i = rank; i < N; i++) {
    let allZero = true;
    for (let j = 0; j < W; j++) if (rows[i][j] !== 0) { allZero = false; break; }
    if (!allZero) {
      // Input portion is zero (post-RREF rank exhausted) but output portion non-zero
      // means the same input maps to different outputs → nonlinear or contradictory.
      let inpZero = true;
      for (let j = 0; j < 32; j++) if (rows[i][j] !== 0) { inpZero = false; break; }
      if (inpZero) linear = false;
    }
  }
  const observableBits = pivotRow.map((v, k) => (v >= 0 ? k : -1)).filter((v) => v >= 0);
  const unobservedBits = pivotRow.map((v, k) => (v < 0 ? k : -1)).filter((v) => v >= 0);
  return { linear, rank, observableBits, unobservedBits, pivotRow, rows };
}

function packBruteForce(value: number, endian: 'BE' | 'LE'): number[] | null {
  // Find a subset of samples whose XOR-of-inputs equals the float bits of value;
  // then XOR their outputs. Returns 6 wire bytes, or null if value isn't in the
  // GF(2)-span of the sample inputs.
  const target = floatToBits32(value, endian);
  const N = SAMPLES.length;
  const xs = SAMPLES.map((s) => floatToBits32(s.val, endian));
  const ys = SAMPLES.map((s) => wireToBits42(s.wire));
  for (let mask = 0; mask < 1 << N; mask++) {
    const x = new Array(32).fill(0);
    for (let i = 0; i < N; i++) if (mask & (1 << i)) for (let j = 0; j < 32; j++) x[j] ^= xs[i][j];
    let ok = true;
    for (let j = 0; j < 32; j++) if (x[j] !== target[j]) { ok = false; break; }
    if (!ok) continue;
    const y = new Array(42).fill(0);
    for (let i = 0; i < N; i++) if (mask & (1 << i)) for (let j = 0; j < 42; j++) y[j] ^= ys[i][j];
    return bits42ToWire(y);
  }
  return null;
}

function describeBit(k: number, endian: 'BE' | 'LE'): string {
  // k = position in the 32-bit input vector; bit at position 0 is the first
  // bit of the first byte (MSB of byte 0) under whichever endian we used.
  const byte = Math.floor(k / 8);
  const bitInByte = 7 - (k % 8); // 7 = MSB of that byte
  // Translate to IEEE 754 single-precision field:
  //   Under BE the byte order is sign|exp_hi|...|mant_lo
  //   Under LE it's mant_lo|...|exp_hi|sign
  const ieeeByteIndex = endian === 'BE' ? byte : 3 - byte;
  const ieeeBitFromMSB = ieeeByteIndex * 8 + (7 - bitInByte); // 0..31, 0=sign
  let role: string;
  if (ieeeBitFromMSB === 0) role = 'sign';
  else if (ieeeBitFromMSB <= 8) role = `exp[${ieeeBitFromMSB - 1}]`; // bit 1..8 → exp 0..7
  else role = `mant[${ieeeBitFromMSB - 9}]`; // bit 9..31 → mant 0..22
  return `byte ${byte} bit ${bitInByte}  (${role})`;
}

function findLinearityBreaker(samples: Sample[], endian: 'BE' | 'LE'): { mask: number; wireXor: number[] } | null {
  // Smallest non-empty subset whose input XOR is zero but wire XOR is non-zero.
  const N = samples.length;
  const xs = samples.map((s) => floatToBits32(s.val, endian));
  const ys = samples.map((s) => wireToBits42(s.wire));
  for (let mask = 1; mask < 1 << N; mask++) {
    const x = new Array(32).fill(0);
    for (let i = 0; i < N; i++) if (mask & (1 << i)) for (let j = 0; j < 32; j++) x[j] ^= xs[i][j];
    if (x.some((v) => v !== 0)) continue;
    const y = new Array(42).fill(0);
    for (let i = 0; i < N; i++) if (mask & (1 << i)) for (let j = 0; j < 42; j++) y[j] ^= ys[i][j];
    if (y.some((v) => v !== 0)) return { mask, wireXor: bits42ToWire(y) };
  }
  return null;
}

function tryEndian(endian: 'BE' | 'LE', samples: Sample[] = SAMPLES, label = ''): void {
  console.log(`\n=== Endian: ${endian}${label ? `  (${label})` : ''} ===`);
  const r = rref(samples, endian);
  const breaker = findLinearityBreaker(samples, endian);
  if (breaker) {
    const idxs = samples.map((_, i) => i).filter((i) => breaker.mask & (1 << i));
    const labels = idxs.map((i) => String(samples[i].val)).join(' ⊕ ');
    console.log(`LINEARITY BROKEN by subset {${labels}}  →  zero input XOR, wire XOR = [${hex(breaker.wireXor)}]`);
  } else {
    console.log(`No linearity-breaking subset found — encoding is linear over GF(2) for these samples.`);
  }
  console.log(`Rank of input matrix: ${r.rank} / 32`);
  console.log(`Observable input bits (${r.observableBits.length}): [${r.observableBits.join(', ')}]`);
  console.log(`Unobserved input bits (${r.unobservedBits.length}): [${r.unobservedBits.join(', ')}]`);

  console.log('\nRound-trip on every sample:');
  let pass = 0;
  for (const s of SAMPLES) {
    const got = packBruteForce(s.val, endian);
    const okStr = got && got.every((b, i) => b === s.wire[i]) ? 'OK' : 'FAIL';
    if (okStr === 'OK') pass++;
    console.log(`  ${String(s.val).padStart(6)}  expect [${hex(s.wire)}]  got [${got ? hex(got) : 'NULL'}]  ${okStr}`);
  }
  console.log(`Round-trip: ${pass}/${SAMPLES.length} pass`);

  console.log('\nObservable bit → wire mask (each row of the recovered M):');
  for (const k of r.observableBits) {
    const row = r.rows[r.pivotRow[k]];
    const mask = bits42ToWire(row.slice(32));
    console.log(`  in[${String(k).padStart(2)}] ${describeBit(k, endian)}  → [${hex(mask)}]`);
  }

  // Probe MVP-relevant Amp Gain values
  const probes = [0.0, 0.1, 0.5, 1.0, 2.5, 5.0, 7.5, 10.0, -0.5];
  console.log('\nMVP-relevant probe values (can we pack them with the current samples?):');
  for (const v of probes) {
    const got = packBruteForce(v, endian);
    console.log(`  ${String(v).padStart(6)}  →  ${got ? hex(got) : '  NEED MORE SAMPLES'}`);
  }
}

// Full set
tryEndian('BE', SAMPLES, 'all 10 samples');
// Same parameter only (Amp Gain) — drop the EQ-band -1.0 sample
const sameParamOnly = SAMPLES.filter((s) => s.val !== -1.0);
tryEndian('BE', sameParamOnly, 'Amp Gain only — 9 samples, no -1.0');
tryEndian('LE', sameParamOnly, 'Amp Gain only — 9 samples, no -1.0');
