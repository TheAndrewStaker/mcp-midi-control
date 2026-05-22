/**
 * Analyze the captured AM4 fn 0x1F probe output.
 *
 * Splits `samples/captured/probe-am4-fn1f.syx` into discrete SysEx
 * frames and, for each fn 0x74 / 0x75 / 0x76 frame, dumps:
 *
 *   - frame length
 *   - effectId (header) / chunk size header field
 *   - candidate decodes of the size field:
 *       * septet-14-bit (II convention: itemCount)
 *       * little-endian 16-bit (alternate hypothesis: payload byte count)
 *   - the implied 16-bit ushort sequence using II's `decode16Packed`
 *     on 3-byte groups starting at the chunk payload offset
 *
 * Goal: pick between
 *
 *   A. AM4 chunks follow II convention exactly (3-byte septet-21-bit
 *      packed ushorts; bytes[6,7] = itemCount in ushorts)
 *
 *   B. AM4 chunks announce a payload BYTE count in bytes[6,7]
 *      (decoded little-endian) and the body is still 3 bytes per
 *      ushort, so value count = byte_count / 3
 *
 *   C. Something else (different byte width, different encoding)
 *
 * If A or B fits the captured frame lengths exactly, we can ship the
 * decoder. If neither fits, the chunk shape needs more probing before
 * we can wire a descriptor reader.
 *
 * Run:
 *   npx tsx scripts/_research/analyze-am4-fn1f-chunks.ts
 */
import { readFileSync } from 'node:fs';

const PROBE_PATH = 'samples/captured/probe-am4-fn1f.syx';

function decode14Septet(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}

function decode16LE(lo: number, hi: number): number {
  return (lo & 0xff) | ((hi & 0xff) << 8);
}

function decode16Packed(b0: number, b1: number, b2: number): number {
  return (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
}

function hex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function splitFrames(bytes: Uint8Array): number[][] {
  const out: number[][] = [];
  let cur: number[] | null = null;
  for (const b of bytes) {
    if (b === 0xf0) {
      cur = [b];
    } else if (cur) {
      cur.push(b);
      if (b === 0xf7) {
        out.push(cur);
        cur = null;
      }
    }
  }
  return out;
}

const raw = readFileSync(PROBE_PATH);
const frames = splitFrames(new Uint8Array(raw));
console.log(`Total frames in ${PROBE_PATH}: ${frames.length}`);
console.log('');

let headerCount = 0;
let chunkCount = 0;
let footerCount = 0;
let nackCount = 0;

for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  if (f.length < 7) continue;
  // Validate Fractal AM4 prefix
  if (f[0] !== 0xf0 || f[1] !== 0x00 || f[2] !== 0x01 || f[3] !== 0x74 || f[4] !== 0x15) {
    console.log(`Frame ${i}: non-AM4 prefix; skipping (${hex(f.slice(0, 6))})`);
    continue;
  }
  const fn = f[5];
  switch (fn) {
    case 0x64: {
      nackCount++;
      console.log(`Frame ${i}: fn=0x64 NACK; echoed-fn=0x${f[6].toString(16).padStart(2, '0')} rc=0x${f[7].toString(16).padStart(2, '0')} (len=${f.length})`);
      break;
    }
    case 0x74: {
      headerCount++;
      const eid = decode14Septet(f[6], f[7]);
      const sizeSeptet = decode14Septet(f[8], f[9]);
      const sizeLE = decode16LE(f[8], f[9]);
      console.log(`Frame ${i}: HEADER fn=0x74 len=${f.length} eid=${eid} bytes[8,9]=0x${f[8].toString(16).padStart(2, '0')}${f[9].toString(16).padStart(2, '0')} → size_septet=${sizeSeptet}  size_LE=${sizeLE}`);
      break;
    }
    case 0x75: {
      chunkCount++;
      const payloadStart = 8;
      const payloadEndExclusive = f.length - 2; // cksum + F7
      const payloadLen = payloadEndExclusive - payloadStart;
      const sizeSeptet = decode14Septet(f[6], f[7]);
      const sizeLE = decode16LE(f[6], f[7]);
      const ushortsAtSeptetCount = sizeSeptet; // II convention: itemCount
      const ushortsAtLEByteCount = Math.floor(sizeLE / 3); // alternate: payload bytes / 3
      const ushortsFromActualBytes = Math.floor(payloadLen / 3);
      console.log(`Frame ${i}: CHUNK fn=0x75 len=${f.length} payload_len=${payloadLen} bytes[6,7]=0x${f[6].toString(16).padStart(2, '0')}${f[7].toString(16).padStart(2, '0')}`);
      console.log(`             size_septet=${sizeSeptet}  (II convention: itemCount)`);
      console.log(`             size_LE=${sizeLE}   (alternate: payload byte count)`);
      console.log(`             ushorts_from_actual_payload_div3=${ushortsFromActualBytes}`);
      // Sanity check: does the actual payload length match (size_LE) or (size_septet × 3)?
      const matchesLE = sizeLE === payloadLen;
      const matchesSeptetTimes3 = sizeSeptet * 3 === payloadLen;
      console.log(`             matches_LE_as_bytecount=${matchesLE}  matches_septet_x3=${matchesSeptetTimes3}`);
      // Decode first 8 ushorts using II's decode16Packed for inspection.
      const first8: number[] = [];
      for (let k = 0; k < 8 && payloadStart + k * 3 + 2 < payloadEndExclusive; k++) {
        const off = payloadStart + k * 3;
        first8.push(decode16Packed(f[off], f[off + 1], f[off + 2]));
      }
      console.log(`             first_8_ushorts_via_decode16Packed: [${first8.join(', ')}]`);
      // Show all decoded ushorts (cap at 50) for verification.
      const all: number[] = [];
      const limit = Math.min(ushortsFromActualBytes, 50);
      for (let k = 0; k < limit; k++) {
        const off = payloadStart + k * 3;
        all.push(decode16Packed(f[off], f[off + 1], f[off + 2]));
      }
      console.log(`             ushorts (first ${limit}): [${all.join(', ')}]`);
      break;
    }
    case 0x76: {
      footerCount++;
      console.log(`Frame ${i}: FOOTER fn=0x76 len=${f.length}`);
      break;
    }
    default:
      console.log(`Frame ${i}: unknown fn=0x${fn.toString(16).padStart(2, '0')} len=${f.length}`);
  }
}

console.log('');
console.log(`Summary: ${headerCount} headers, ${chunkCount} chunks, ${footerCount} footers, ${nackCount} NACKs`);
