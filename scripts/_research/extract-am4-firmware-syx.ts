/**
 * Extract raw AM4 firmware bytes from the SysEx envelope wrapper.
 *
 * Envelope (parallel to the preset binary 0x77/0x78/0x79 three-frame
 * pattern, just with fn=0x7D/0x7E/0x7F):
 *
 *   F0 00 01 74 15 7D <5-byte header payload> <cksum> F7
 *   F0 00 01 74 15 7E <packed chunk payload>   <cksum> F7    (xN)
 *   F0 00 01 74 15 7F <5-byte footer payload>  <cksum> F7
 *
 * The packed payload of every 0x7E chunk is MIDI 7-bit clean (high bit
 * always zero) — the standard Fractal septet-7-bit packing applies.
 *
 * Output:
 *   samples/captured/decoded/am4-firmware-extracted-raw.bin
 *     — the full concatenated 0x7E payload (still septet-packed; this
 *       is what AM4-Edit / the device reads off the wire).
 *   samples/captured/decoded/am4-firmware-extracted-unpacked.bin
 *     — the same payload after septet→byte unpacking
 *       (8 bytes of packed → 7 bytes of raw firmware), the binary that
 *       Ghidra ingests.
 *   samples/captured/decoded/am4-firmware-extracted-meta.json
 *     — envelope structure summary + magic-byte verification.
 *
 * Primitives: the 8→7 septet unpack here matches
 * `[[septet-21bit-byte2-mask-preservation]]` for byte ordering.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'samples/factory/AM4_firmware_v2p00.syx');
const OUT_DIR = join(
  ROOT,
  'packages/fractal-midi/samples/captured/decoded'
);

mkdirSync(OUT_DIR, { recursive: true });

const buf = readFileSync(SRC);
console.log(`[am4-fw] read ${buf.length} bytes from ${SRC}`);

const ENVELOPE = [0xf0, 0x00, 0x01, 0x74, 0x15] as const;

type Frame = {
  fn: number;
  payloadStart: number;
  payloadEnd: number; // exclusive
  payload: Buffer;
  cksum: number;
  computedCksum: number;
  cksumOk: boolean;
};

function splitFrames(): Frame[] {
  const frames: Frame[] = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== 0xf0) {
      throw new Error(
        `[am4-fw] expected F0 at byte ${i}, found 0x${buf[i].toString(16)}`
      );
    }
    for (let k = 0; k < ENVELOPE.length; k++) {
      if (buf[i + k] !== ENVELOPE[k]) {
        throw new Error(
          `[am4-fw] envelope mismatch at byte ${i + k}: expected 0x${ENVELOPE[k].toString(16)}, found 0x${buf[i + k].toString(16)}`
        );
      }
    }
    const fn = buf[i + 5];
    // find next F7
    let j = i + 6;
    while (j < buf.length && buf[j] !== 0xf7) j++;
    if (j >= buf.length) {
      throw new Error(`[am4-fw] no F7 terminator after byte ${i}`);
    }
    const cksum = buf[j - 1];
    const payloadStart = i + 6;
    const payloadEnd = j - 1;
    const payload = buf.subarray(payloadStart, payloadEnd);

    // Fractal checksum: XOR over F0..lastPayloadByte, masked 0x7F.
    let cs = 0;
    for (let k = i; k <= payloadEnd - 1; k++) cs ^= buf[k];
    cs &= 0x7f;

    frames.push({
      fn,
      payloadStart,
      payloadEnd,
      payload: Buffer.from(payload),
      cksum,
      computedCksum: cs,
      cksumOk: cs === cksum,
    });
    i = j + 1;
  }
  return frames;
}

const frames = splitFrames();

const fnCounts = new Map<number, number>();
for (const f of frames) {
  fnCounts.set(f.fn, (fnCounts.get(f.fn) ?? 0) + 1);
}
console.log(`[am4-fw] frame count: ${frames.length}`);
for (const [fn, count] of [...fnCounts.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`[am4-fw]   fn=0x${fn.toString(16).padStart(2, '0')}  ${count}`);
}

const csOk = frames.filter((f) => f.cksumOk).length;
const csBad = frames.length - csOk;
console.log(`[am4-fw] checksum OK ${csOk}/${frames.length}; bad ${csBad}`);
if (csBad > 0) {
  for (const [idx, f] of frames.entries()) {
    if (!f.cksumOk) {
      console.log(
        `[am4-fw]   bad-cksum frame ${idx} fn=0x${f.fn.toString(16)} stored=0x${f.cksum.toString(16)} computed=0x${f.computedCksum.toString(16)}`
      );
    }
  }
}

// fn=0x7D header is first; fn=0x7F footer is last; everything else fn=0x7E.
const header = frames[0];
const footer = frames[frames.length - 1];
const chunks = frames.slice(1, -1);

if (header.fn !== 0x7d) {
  console.warn(
    `[am4-fw] WARN: expected header fn=0x7d, got 0x${header.fn.toString(16)}`
  );
}
if (footer.fn !== 0x7f) {
  console.warn(
    `[am4-fw] WARN: expected footer fn=0x7f, got 0x${footer.fn.toString(16)}`
  );
}
for (const c of chunks) {
  if (c.fn !== 0x7e) {
    console.warn(
      `[am4-fw] WARN: expected chunk fn=0x7e, got 0x${c.fn.toString(16)} at byte ${c.payloadStart}`
    );
  }
}

console.log(`[am4-fw] header payload (${header.payload.length} B): ${header.payload.toString('hex')}`);
console.log(`[am4-fw] footer payload (${footer.payload.length} B): ${footer.payload.toString('hex')}`);

// Each fn=0x7E chunk's payload has the shape:
//   payload[0..1] = septet-packed 14-bit chunk-data-byte-count
//                   (empirically 0x60 0x03 = 0x60 | (0x03 << 7) = 480
//                    for every chunk in v2.00; sanity-checked below)
//   payload[2..]  = N bytes of packed firmware data (N == count above)
//
// We strip the 2-byte length prefix from every chunk before
// concatenating + unpacking.
const PACKED_DATA_OFFSET = 2;
function unpackChunkLen(p: Buffer): number {
  return (p[0] & 0x7f) | ((p[1] & 0x7f) << 7);
}

const chunkDataLens = chunks.map((c) => unpackChunkLen(c.payload));
const uniqDataLens = new Set(chunkDataLens);
console.log(`[am4-fw] declared chunk-data lengths (septet of payload[0..1]): ${[...uniqDataLens].sort((a, b) => a - b).join(', ')}`);

for (let idx = 0; idx < chunks.length; idx++) {
  const c = chunks[idx];
  const declared = chunkDataLens[idx];
  const actual = c.payload.length - PACKED_DATA_OFFSET;
  if (declared !== actual) {
    console.warn(
      `[am4-fw] WARN chunk ${idx}: declared len=${declared} but payload-after-prefix=${actual}`
    );
  }
}

const rawConcatLen = chunks.reduce(
  (a, c) => a + (c.payload.length - PACKED_DATA_OFFSET),
  0
);
const raw = Buffer.alloc(rawConcatLen);
{
  let off = 0;
  for (const c of chunks) {
    const body = c.payload.subarray(PACKED_DATA_OFFSET);
    body.copy(raw, off);
    off += body.length;
  }
}
console.log(`[am4-fw] raw packed concat (after stripping 2-byte length prefix per chunk): ${raw.length} bytes across ${chunks.length} chunks`);

const chunkLengths = chunks.map((c) => c.payload.length);
const uniqLengths = new Set(chunkLengths);
console.log(`[am4-fw] chunk payload lengths: ${[...uniqLengths].sort((a, b) => a - b).join(', ')}`);

const allMidiClean = raw.every((b) => (b & 0x80) === 0);
console.log(`[am4-fw] raw all 7-bit clean: ${allMidiClean}`);

// Septet-unpack: standard Fractal pattern.
//
// The bulk preset binary uses a 3-byte-packed-to-2-byte (decode16Packed)
// shape because its payload is ushorts. For firmware (raw byte stream),
// the canonical Fractal packing is 8-bytes-packed-to-7-bytes:
//   - one MSB byte holding bits 7 of each of the next 7 data bytes
//   - 7 data bytes with their MSB cleared
// That's the same scheme MIDI standard uses for SDS / "MIDI File
// SysEx" payloads. We try that first.
function unpack8to7(packed: Buffer): Buffer {
  // packed length should be N*8 (possibly with a short final group)
  const out: number[] = [];
  let i = 0;
  while (i < packed.length) {
    const groupLen = Math.min(8, packed.length - i);
    if (groupLen === 0) break;
    const msbByte = packed[i];
    // remaining bytes in this group (up to 7)
    const dataLen = groupLen - 1;
    for (let k = 0; k < dataLen; k++) {
      const lo7 = packed[i + 1 + k] & 0x7f;
      const hi1 = (msbByte >> k) & 0x01;
      out.push((hi1 << 7) | lo7);
    }
    i += groupLen;
  }
  return Buffer.from(out);
}

const unpacked = unpack8to7(raw);
console.log(`[am4-fw] unpacked (8→7) length: ${unpacked.length} bytes`);

// ARM Cortex magic-byte check: first 4 bytes = initial SP (typically
// near top of SRAM, ~0x20000000..0x20080000 range for STM32 / Cortex
// M-class parts). Next 4 bytes = reset handler — should be an odd
// address (Thumb bit set) inside the flash region.
function hexU32LE(b: Buffer, off: number): string {
  const v =
    (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>>
    0;
  return '0x' + v.toString(16).padStart(8, '0');
}

const magic = {
  first16_unpacked: unpacked.subarray(0, 16).toString('hex'),
  initial_sp_le: hexU32LE(unpacked, 0),
  reset_handler_le: hexU32LE(unpacked, 4),
  nmi_handler_le: hexU32LE(unpacked, 8),
  hardfault_handler_le: hexU32LE(unpacked, 12),
};
console.log(`[am4-fw] magic check (unpacked, ARM Cortex vector table interpretation):`);
console.log(`         initial_sp      = ${magic.initial_sp_le}`);
console.log(`         reset_handler   = ${magic.reset_handler_le}`);
console.log(`         nmi_handler     = ${magic.nmi_handler_le}`);
console.log(`         hardfault       = ${magic.hardfault_handler_le}`);

const rawMagic = {
  first16: raw.subarray(0, 16).toString('hex'),
  initial_sp_le: hexU32LE(raw, 0),
  reset_handler_le: hexU32LE(raw, 4),
};
console.log(`[am4-fw] magic check (raw packed, for comparison):`);
console.log(`         initial_sp      = ${rawMagic.initial_sp_le}`);
console.log(`         reset_handler   = ${rawMagic.reset_handler_le}`);

const RAW_OUT = join(OUT_DIR, 'am4-firmware-extracted-raw.bin');
const UNPACK_OUT = join(OUT_DIR, 'am4-firmware-extracted-unpacked.bin');
const META_OUT = join(OUT_DIR, 'am4-firmware-extracted-meta.json');

writeFileSync(RAW_OUT, raw);
writeFileSync(UNPACK_OUT, unpacked);

const meta = {
  source: SRC,
  source_bytes: buf.length,
  frame_count: frames.length,
  fn_counts: Object.fromEntries(
    [...fnCounts.entries()].map(([k, v]) => [
      '0x' + k.toString(16).padStart(2, '0'),
      v,
    ])
  ),
  checksum_ok: csOk,
  checksum_bad: csBad,
  header_payload_hex: header.payload.toString('hex'),
  footer_payload_hex: footer.payload.toString('hex'),
  chunk_count: chunks.length,
  chunk_lengths_unique: [...uniqLengths].sort((a, b) => a - b),
  raw_packed_bytes: raw.length,
  raw_all_7bit_clean: allMidiClean,
  unpacked_8to7_bytes: unpacked.length,
  magic_unpacked: magic,
  magic_raw: rawMagic,
  outputs: {
    raw: RAW_OUT,
    unpacked: UNPACK_OUT,
  },
};

writeFileSync(META_OUT, JSON.stringify(meta, null, 2));
console.log(`[am4-fw] wrote ${RAW_OUT}`);
console.log(`[am4-fw] wrote ${UNPACK_OUT}`);
console.log(`[am4-fw] wrote ${META_OUT}`);
