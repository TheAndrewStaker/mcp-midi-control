/**
 * FINAL decode: records aligned to effectId-sorted order. Solve the
 * (b1,b2) field as a function of effectId. READ-ONLY.
 */

// Records (probe), in WIRE order:
const RECS: number[][] = [
  [0x03, 0x4a, 0x10, 0x53, 0x06],
  [0x03, 0x4e, 0x18, 0x63, 0x06],
  [0x02, 0x52, 0x20, 0x23, 0x07],
  [0x02, 0x56, 0x00, 0x20, 0x06],
  [0x02, 0x5e, 0x28, 0x03, 0x07],
  [0x02, 0x62, 0x30, 0x2b, 0x78],
  [0x02, 0x70, 0x38, 0x33, 0x07],
  [0x02, 0x0a, 0x7d, 0x17, 0x07],
  [0x03, 0x26, 0x51, 0x73, 0x06],
  [0x02, 0x2c, 0x75, 0x43, 0x07],
  [0x02, 0x42, 0x59, 0x63, 0x07],
];
// effectId-sorted alignment (wire order IS effectId-sorted order):
const IDS = [100, 106, 108, 110, 112, 116, 118, 120, 122, 124, 133];
const NAMES = ['Compressor 1', 'Amp 1', 'Cab 1', 'Reverb 1', 'Delay 1', 'Chorus 1', 'Flanger 1', 'Rotary Speaker 1', 'Phaser 1', 'Wah 1', 'Drive 1'];
const hex = (b: number) => b.toString(16).padStart(2, '0');
const dec14lo = (lo: number, hi: number) => (lo & 0x7f) | ((hi & 0x7f) << 7);
const dec14hi = (hi: number, lo: number) => (lo & 0x7f) | ((hi & 0x7f) << 7);

console.log('=== (b1,b2) as 14-bit, both endian, vs effectId ===');
for (let r = 0; r < RECS.length; r++) {
  const [, b1, b2] = RECS[r];
  const lo = dec14lo(b1, b2);
  const hi = dec14hi(b1, b2);
  console.log(`id=${IDS[r]} (${NAMES[r].padEnd(16)})  b1=${hex(b1)} b2=${hex(b2)}  loFirst=${lo} hiFirst=${hi}  hiFirst/id=${(hi / IDS[r]).toFixed(3)}  hiFirst-id*92=${hi - IDS[r] * 92}`);
}

// Is (b1,b2)hiFirst linear in effectId? Compute slope between consecutive.
console.log('\n=== linearity of (b1,b2) hi-first vs effectId ===');
const hiVals = RECS.map((r) => dec14hi(r[1], r[2]));
for (let r = 1; r < RECS.length; r++) {
  const dV = hiVals[r] - hiVals[r - 1];
  const dId = IDS[r] - IDS[r - 1];
  console.log(`  id ${IDS[r - 1]}->${IDS[r]} (d=${dId}): dHiVal=${dV}  slope=${(dV / dId).toFixed(2)}`);
}
// slope looks like ~520/6, ~520/2... let's get exact: hiVal = m*id + c ?
// Use first and last:
const m = (hiVals[10] - hiVals[0]) / (IDS[10] - IDS[0]);
const c = hiVals[0] - m * IDS[0];
console.log(`\nLinear fit (endpoints): hiVal = ${m.toFixed(4)} * id + ${c.toFixed(4)}`);
console.log('Predicted vs actual:');
for (let r = 0; r < RECS.length; r++) {
  const pred = m * IDS[r] + c;
  console.log(`  id=${IDS[r]} actual=${hiVals[r]} pred=${pred.toFixed(1)} ${Math.abs(pred - hiVals[r]) < 2 ? 'OK' : 'OFF'}`);
}

// Try: effectId encoded such that (b1,b2) = effectId * 4 (septet-packed 14-bit)?
// effectId 100 -> 400 -> septet lo,hi = 400&0x7f=0x10, 400>>7=3. but b1=0x4a not 0x10.
// Hmm. Try effectId*K and compare septet packing to (b1,b2) loFirst.
console.log('\n=== test (b1,b2) loFirst == effectId * K for K ===');
for (const K of [2, 4, 8, 16, 20, 32, 64, 92, 128]) {
  const ok = RECS.every((r, i) => dec14lo(r[1], r[2]) === IDS[i] * K);
  const close = RECS.map((r, i) => dec14lo(r[1], r[2]) - IDS[i] * K);
  if (ok) console.log(`  K=${K}: EXACT MATCH loFirst == id*${K}`);
  // also test offset
  const offs = RECS.map((r, i) => dec14lo(r[1], r[2]) - IDS[i] * K);
  if (new Set(offs).size === 1) console.log(`  K=${K}: loFirst == id*${K} + ${offs[0]} (CONSTANT OFFSET!)`);
}
console.log('\n=== test (b1,b2) hiFirst == effectId * K + C ===');
for (const K of [2, 4, 8, 16, 20, 32, 64, 92, 128, 130]) {
  const offs = RECS.map((r, i) => dec14hi(r[1], r[2]) - IDS[i] * K);
  if (new Set(offs).size === 1) console.log(`  K=${K}: hiFirst == id*${K} + ${offs[0]} (CONSTANT OFFSET!)`);
}

// Maybe the field is NOT effectId but a byte-offset into the preset binary
// (paramBase). Either way, what matters for the perf goal is the STATE field.
// Decode (b3,b4) loFirst as the scene-state ushort per the primitives corpus.
console.log('\n=== (b3,b4) as scene-state ushort (loFirst) ===');
for (let r = 0; r < RECS.length; r++) {
  const [, , , b3, b4] = RECS[r];
  const us = dec14lo(b3, b4);
  console.log(`id=${IDS[r]} (${NAMES[r].padEnd(16)})  b3=${hex(b3)} b4=${hex(b4)}  ushort=0x${us.toString(16).padStart(4,'0')}  bypassMask=0x${(us & 0xff).toString(16)} chanYMask=0x${((us >> 8) & 0xff).toString(16)}`);
}

// And tag b0 (2 or 3) — correlate with block?
console.log('\n=== tag b0 vs block ===');
for (let r = 0; r < RECS.length; r++) console.log(`  id=${IDS[r]} (${NAMES[r].padEnd(16)}) tag=${RECS[r][0]}`);
