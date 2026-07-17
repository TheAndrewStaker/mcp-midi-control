/**
 * wf-ii-fn16-get-param-info-decode.ts  (READ-ONLY research scratch)
 *
 * Systematic decode of the Axe-Fx II fn 0x16 SYSEX_GET_PARAM_INFO
 * 33-byte response (25-byte payload). Tests competing layout
 * hypotheses against the shipped catalog for AMP paramId 0 + 10.
 *
 * NO hardware, NO MIDI port. Pure offline byte analysis.
 *
 * Run: npx tsx scripts/_research/wf-ii-fn16-get-param-info-decode.ts
 */

// Ground-truth payloads (post 6-byte header F0 00 01 74 07 16, pre cksum+F7).
// Source: samples/captured/probe-axefx2-new-opcodes-findings.md lines 33-34, 62-63.
const P0 = [
  0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x12, 0x1c, 0x04, 0x00, 0x00, 0x00, 0x7c, 0x03, 0x00, 0x00, 0x00, 0x00,
  0x00,
]; // paramId=0  (amp.effect_type, select/enum)
const P10 = [
  0x41, 0x10, 0x00, 0x00, 0x00, 0x2c, 0x0b, 0x1f, 0x39, 0x03, 0x0a, 0x2e,
  0x0f, 0x61, 0x03, 0x00, 0x48, 0x50, 0x4b, 0x04, 0x00, 0x00, 0x00, 0x00,
  0x00,
]; // paramId=10 (amp.bright_cap, knob)

const sept2 = (lo: number, hi: number) => (lo & 0x7f) | ((hi & 0x7f) << 7);
const sept3 = (a: number, b: number, c: number) =>
  (a & 0x7f) | ((b & 0x7f) << 7) | ((c & 0x7f) << 14);
const sept4 = (a: number, b: number, c: number, d: number) =>
  (a & 0x7f) | ((b & 0x7f) << 7) | ((c & 0x7f) << 14) | ((d & 0x7f) << 21);
const sept5 = (a: number, b: number, c: number, d: number, e: number) =>
  (a & 0x7f) |
  ((b & 0x7f) << 7) |
  ((c & 0x7f) << 14) |
  ((d & 0x7f) << 21) |
  (e & 0x7f) * 0x10000000; // >> avoid 32-bit sign issues

function hex(arr: number[]) {
  return arr.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

console.log('=== RAW ===');
console.log('P0  (pid=0 enum):', hex(P0));
console.log('P10 (pid=10 knob):', hex(P10));

console.log('\n=== Pairwise diff ===');
console.log('off | p0   | p10  | diff');
for (let i = 0; i < 25; i++) {
  const d = P0[i] !== P10[i];
  console.log(
    `${String(i).padStart(2)}  | 0x${P0[i].toString(16).padStart(2, '0')} | 0x${P10[
      i
    ]
      .toString(16)
      .padStart(2, '0')} | ${d ? 'X' : '.'}`,
  );
}

// ---- HYPOTHESIS A: 5 x 5-septet (35-bit) groups, MIDI 8-to-7 style? 25/5=5 ----
// 5 groups of 5 wire septets each. Each group decodes one native value.
console.log('\n=== HYP A: 5 groups of 5 septets (sept5 LE) ===');
for (let g = 0; g < 5; g++) {
  const o = g * 5;
  const v0 = sept5(P0[o], P0[o + 1], P0[o + 2], P0[o + 3], P0[o + 4]);
  const v10 = sept5(P10[o], P10[o + 1], P10[o + 2], P10[o + 3], P10[o + 4]);
  console.log(
    `group ${g} (off ${o}-${o + 4}): p0=${v0}  p10=${v10}`,
  );
}

// ---- HYPOTHESIS B: 5-septet groups but as MIDI 8-to-7 unpacked u32 ----
// 5 wire septets -> 4 raw bytes (the III/AM4 unpackValue stream).
console.log('\n=== HYP B: 5 groups of 5 septets -> u32 LE (8-to-7 unpack) ===');
function unpack5to4(w: number[]): number {
  // sliding-window 8-to-7 unpack (mirror of packValue) for 5 wire -> 4 raw
  const out = new Uint8Array(4);
  for (let i = 0; i < 5; i++) {
    const k = i + 1;
    const b = w[i] & 0x7f;
    if (i > 0 && i - 1 < 4) out[i - 1] |= ((~(0x7f >> k) & b) >> (8 - k)) & 0xff;
    if (i < 4) out[i] = (b << k) & 0xff;
  }
  return (out[0] | (out[1] << 8) | (out[2] << 16) | (out[3] << 24)) >>> 0;
}
for (let g = 0; g < 5; g++) {
  const o = g * 5;
  const v0 = unpack5to4(P0.slice(o, o + 5));
  const v10 = unpack5to4(P10.slice(o, o + 5));
  console.log(
    `group ${g} (off ${o}-${o + 4}): p0=${v0} (0x${v0
      .toString(16)
      .padStart(8, '0')})  p10=${v10} (0x${v10.toString(16).padStart(8, '0')})`,
  );
}

// ---- HYPOTHESIS C: 25 = 1 + 24; or fields of mixed width. Print 2-septet LE pairs over whole buffer ----
console.log('\n=== HYP C: rolling 2-septet LE at every offset ===');
console.log('off | p0 sept2 | p10 sept2');
for (let i = 0; i + 1 < 25; i++) {
  console.log(
    `${String(i).padStart(2)}  | ${String(sept2(P0[i], P0[i + 1])).padStart(
      6,
    )} | ${String(sept2(P10[i], P10[i + 1])).padStart(6)}`,
  );
}

// ---- HYPOTHESIS D: the III "store preset" descriptor shape: groups aligned to non-zero clusters ----
// p10 nonzero clusters: [0-1], [5-14], [16-19]. p0 nonzero: [0], [12-14], [18-19].
// Try sept3 LE decode at the cluster anchors that the diff highlights.
console.log('\n=== HYP D: candidate field reads ===');
const fields: Array<[string, number[], (p: number[]) => number]> = [
  ['off0-1 sept2 (current value?)', [0, 1], (p) => sept2(p[0], p[1])],
  ['off5-9 sept5 (min?)', [5, 9], (p) => sept5(p[5], p[6], p[7], p[8], p[9])],
  ['off5-9 u32(8to7)', [5, 9], (p) => unpack5to4(p.slice(5, 10))],
  ['off10-14 sept5 (max?)', [10, 14], (p) => sept5(p[10], p[11], p[12], p[13], p[14])],
  ['off10-14 u32(8to7)', [10, 14], (p) => unpack5to4(p.slice(10, 15))],
  ['off15-19 sept5 (default?)', [15, 19], (p) => sept5(p[15], p[16], p[17], p[18], p[19])],
  ['off15-19 u32(8to7)', [15, 19], (p) => unpack5to4(p.slice(15, 20))],
  ['off20-24 sept5 (step/units?)', [20, 24], (p) => sept5(p[20], p[21], p[22], p[23], p[24])],
  ['off12-14 sept3', [12, 14], (p) => sept3(p[12], p[13], p[14])],
  ['off16-19 sept4', [16, 19], (p) => sept4(p[16], p[17], p[18], p[19])],
  ['off18-19 sept2', [18, 19], (p) => sept2(p[18], p[19])],
  ['off5-7 sept3', [5, 7], (p) => sept3(p[5], p[6], p[7])],
  ['off7-9 sept3', [7, 9], (p) => sept3(p[7], p[8], p[9])],
  ['off10-12 sept3', [10, 12], (p) => sept3(p[10], p[11], p[12])],
];
for (const [name, , fn] of fields) {
  console.log(`${name.padEnd(34)} p0=${String(fn(P0)).padStart(12)}  p10=${String(fn(P10)).padStart(12)}`);
}

// ---- Catalog anchors ----
console.log('\n=== CATALOG ANCHORS ===');
console.log('amp.effect_type (pid0): select, 259 enum entries (0..258).');
console.log('amp.bright_cap  (pid10): knob, NO displayMin/displayMax in catalog.');
console.log('II continuous knob wire range: 0..65534 (per primitives display-q16-fixedpoint / ii-compressor-calibration-divergence).');
console.log('65534 = 0x FFFE; as sept5 8-to-7? as sept3? check group reads above for 258 and 65534.');
