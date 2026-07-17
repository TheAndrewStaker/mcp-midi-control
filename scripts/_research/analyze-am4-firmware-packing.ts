/**
 * Analyze the AM4 firmware raw payload (packed 7-bit) to identify the
 * correct unpacking scheme.
 *
 * The naive 8→7 MSB-first unpack produced a vector table that doesn't
 * look ARM Cortex-M (reset handler even, no Thumb bit). This script
 * tries multiple unpacking variants and scores each one against:
 *   - byte-distribution entropy (random-looking ≈ encrypted/compressed;
 *     skewed-low ≈ plain ARM code/data)
 *   - ARM Thumb-2 prologue/epilogue byte-pair counts (push {lr} = b5 ..,
 *     bx lr = 47 70, ldr rN, [pc, #..] = 4F xx, etc.)
 *   - vector-table sanity (initial SP plausible RAM address, reset
 *     handler odd address in plausible flash region)
 *
 * Output:
 *   samples/captured/decoded/am4-firmware-packing-analysis.json
 *     — scores for each variant; top scorer is the winner.
 *
 * Variants tested:
 *   1. msb-first-8to7 (already wired in extract-am4-firmware-syx.ts)
 *   2. msb-last-8to7
 *   3. 3-to-2 (preset-binary septet shape)
 *   4. raw (no unpack — just take the 7-bit bytes as-is)
 *   5. msb-first-8to7-reverse-bits (data[0] gets MSB bit 6)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const RAW = join(
  ROOT,
  'packages/fractal-midi/samples/captured/decoded/am4-firmware-extracted-raw.bin'
);

const packed = readFileSync(RAW);
console.log(`[analyze] packed input: ${packed.length} bytes`);

// ----- unpackers -----
function unpack8to7MsbFirst(p: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < p.length) {
    const groupLen = Math.min(8, p.length - i);
    if (groupLen < 2) break;
    const msbByte = p[i];
    for (let k = 0; k < groupLen - 1; k++) {
      const lo7 = p[i + 1 + k] & 0x7f;
      const hi1 = (msbByte >> k) & 0x01;
      out.push((hi1 << 7) | lo7);
    }
    i += groupLen;
  }
  return Buffer.from(out);
}
function unpack8to7MsbFirstReverseBits(p: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < p.length) {
    const groupLen = Math.min(8, p.length - i);
    if (groupLen < 2) break;
    const msbByte = p[i];
    for (let k = 0; k < groupLen - 1; k++) {
      const lo7 = p[i + 1 + k] & 0x7f;
      const hi1 = (msbByte >> (6 - k)) & 0x01;
      out.push((hi1 << 7) | lo7);
    }
    i += groupLen;
  }
  return Buffer.from(out);
}
function unpack8to7MsbLast(p: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < p.length) {
    const groupLen = Math.min(8, p.length - i);
    if (groupLen < 2) break;
    const dataLen = groupLen - 1;
    const msbByte = p[i + dataLen];
    for (let k = 0; k < dataLen; k++) {
      const lo7 = p[i + k] & 0x7f;
      const hi1 = (msbByte >> k) & 0x01;
      out.push((hi1 << 7) | lo7);
    }
    i += groupLen;
  }
  return Buffer.from(out);
}
function unpack3to2(p: Buffer): Buffer {
  // 3-byte → 2-byte (14-bit ushort packing used for preset binary).
  // Produces ushort stream; we serialize little-endian.
  const out: number[] = [];
  for (let i = 0; i + 2 < p.length; i += 3) {
    const b0 = p[i] & 0x7f;
    const b1 = p[i + 1] & 0x7f;
    const b2 = p[i + 2] & 0x7f; // mask byte
    const u =
      (b0 | (b1 << 7)) & 0xffff;
    // b2 carries high bits — apply per primitive septet-21bit-byte2-mask-preservation
    const hi = ((b2 & 0x03) << 14) | (u & 0x3fff);
    out.push(hi & 0xff);
    out.push((hi >> 8) & 0xff);
  }
  return Buffer.from(out);
}
function unpackRaw(p: Buffer): Buffer {
  return Buffer.from(p);
}

// ----- scorers -----
function entropyBits(b: Buffer): number {
  const counts = new Array(256).fill(0);
  for (const x of b) counts[x]++;
  const N = b.length;
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / N;
    h -= p * Math.log2(p);
  }
  return h;
}
function highBitDensity(b: Buffer): number {
  let n = 0;
  for (const x of b) if (x & 0x80) n++;
  return n / b.length;
}

// ARM Thumb-2 signatures
const SIG_PUSH_LR = [0x00, 0xb5]; // push {lr} encoded as 2 bytes, but bit 0 of opcode varies
function countThumbSignatures(b: Buffer): {
  push_b5: number;
  bx_lr_4770: number;
  ldr_pc_48xx: number;
  ldr_pc_4exx: number;
  mov_rN_imm_2xxx: number;
} {
  let push_b5 = 0;
  let bx_lr_4770 = 0;
  let ldr_pc_48xx = 0;
  let ldr_pc_4exx = 0;
  let mov_rN_imm_2xxx = 0;
  // Thumb is little-endian: the byte at offset N is the low byte of the 16-bit halfword.
  // push {..., lr} = B5 xx (high byte) ; in LE the bytes are: [xx, B5].
  // bx lr = 4770 → LE [70, 47].
  // ldr r0, [pc, #imm] = 48xx → LE [xx, 48].
  // ldr r6, [pc, #imm] = 4Exx → LE [xx, 4E].
  // mov r0, #imm = 20xx → LE [xx, 20].
  for (let i = 0; i + 1 < b.length; i += 2) {
    const hi = b[i + 1];
    if (hi === 0xb5) push_b5++;
    if (b[i] === 0x70 && hi === 0x47) bx_lr_4770++;
    if (hi === 0x48) ldr_pc_48xx++;
    if (hi === 0x4e) ldr_pc_4exx++;
    if (hi === 0x20) mov_rN_imm_2xxx++;
  }
  return { push_b5, bx_lr_4770, ldr_pc_48xx, ldr_pc_4exx, mov_rN_imm_2xxx };
}

function magic(b: Buffer): {
  initial_sp: string;
  reset_handler: string;
  reset_thumb_bit: boolean;
  reset_in_flash_low: boolean;
  reset_in_flash_stm32: boolean;
  sp_in_sram_x20: boolean;
  sp_in_sram_x10: boolean;
} {
  function u32(o: number): number {
    return (
      (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
    );
  }
  const sp = u32(0);
  const reset = u32(4);
  return {
    initial_sp: '0x' + sp.toString(16).padStart(8, '0'),
    reset_handler: '0x' + reset.toString(16).padStart(8, '0'),
    reset_thumb_bit: (reset & 1) === 1,
    reset_in_flash_low: reset > 0 && reset < 0x01000000,
    reset_in_flash_stm32: reset >= 0x08000000 && reset < 0x09000000,
    sp_in_sram_x20: sp >= 0x20000000 && sp < 0x20100000,
    sp_in_sram_x10: sp >= 0x10000000 && sp < 0x10010000,
  };
}

// ----- run -----
const variants = [
  { name: 'msb-first-8to7', fn: unpack8to7MsbFirst },
  { name: 'msb-first-8to7-reverse-bits', fn: unpack8to7MsbFirstReverseBits },
  { name: 'msb-last-8to7', fn: unpack8to7MsbLast },
  { name: '3to2-ushort', fn: unpack3to2 },
  { name: 'raw-no-unpack', fn: unpackRaw },
];

const report: any[] = [];
for (const v of variants) {
  const u = v.fn(packed);
  const ent = entropyBits(u);
  const hb = highBitDensity(u);
  const sigs = countThumbSignatures(u);
  const m = magic(u);

  // Score:
  //   +sigs per million bytes (higher = more ARM-Thumb-shaped)
  //   +5 if reset_thumb_bit
  //   +5 if reset_in_flash_low OR reset_in_flash_stm32
  //   +3 if sp_in_sram_x20 OR sp_in_sram_x10
  //   penalty if entropy > 7.8 (looks encrypted/compressed)
  const sigsPerMb =
    ((sigs.push_b5 + sigs.bx_lr_4770 + sigs.ldr_pc_48xx + sigs.ldr_pc_4exx + sigs.mov_rN_imm_2xxx) /
      u.length) *
    1_000_000;
  let score = sigsPerMb;
  if (m.reset_thumb_bit) score += 5;
  if (m.reset_in_flash_low || m.reset_in_flash_stm32) score += 5;
  if (m.sp_in_sram_x20 || m.sp_in_sram_x10) score += 3;
  if (ent > 7.8) score -= 10;

  console.log(
    `\n[${v.name}] len=${u.length} entropy=${ent.toFixed(3)} highbit-density=${hb.toFixed(3)}`
  );
  console.log(`   magic: SP=${m.initial_sp}, reset=${m.reset_handler}`);
  console.log(
    `          thumb-bit=${m.reset_thumb_bit}, flash-low=${m.reset_in_flash_low}, flash-stm32=${m.reset_in_flash_stm32}, sp-x20=${m.sp_in_sram_x20}, sp-x10=${m.sp_in_sram_x10}`
  );
  console.log(
    `   thumb-sigs: push_b5=${sigs.push_b5}, bx_lr=${sigs.bx_lr_4770}, ldr_48=${sigs.ldr_pc_48xx}, ldr_4e=${sigs.ldr_pc_4exx}, mov_20=${sigs.mov_rN_imm_2xxx}`
  );
  console.log(`   score: ${score.toFixed(2)}`);
  console.log(`   first-32 bytes: ${u.subarray(0, 32).toString('hex')}`);

  report.push({
    variant: v.name,
    bytes: u.length,
    entropy: ent,
    high_bit_density: hb,
    magic: m,
    thumb_signatures: sigs,
    sigs_per_million_bytes: sigsPerMb,
    score,
    first_32_hex: u.subarray(0, 32).toString('hex'),
  });
}

report.sort((a, b) => b.score - a.score);
console.log('\n[analyze] ranked:');
for (const r of report) {
  console.log(`   ${r.score.toFixed(2)}  ${r.variant}`);
}

writeFileSync(
  join(
    ROOT,
    'packages/fractal-midi/samples/captured/decoded/am4-firmware-packing-analysis.json'
  ),
  JSON.stringify(report, null, 2)
);
console.log(
  '\n[analyze] wrote packages/fractal-midi/samples/captured/decoded/am4-firmware-packing-analysis.json'
);
