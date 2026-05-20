/**
 * Analyze session-58-direct-sync.syx for fn 0x18 responses.
 *
 * Context: AxeEdit sends 24 outbound fn 0x18 frames during sync (one
 * per placed block ID 0x64..0x7B). Each outbound frame has the shape
 * `F0 00 01 74 07 18 [blockId] 00 00 00 00 00 00 00 [cs] F7` (16 bytes,
 * payload is just blockId + 7 zero bytes). The device's RESPONSE to
 * each is what we want to decode for BK-070 atomic-read.
 *
 * Three hypotheses to test:
 *
 *   1. Response is also fn 0x18 (bidirectional envelope, but with a
 *      non-zero payload carrying state data). Look for fn 0x18 frames
 *      with payload bytes != all zero.
 *
 *   2. Response is fn 0x0E PRESET_BLOCKS_DATA (the wiki name for the
 *      bulk envelope). We already saw 1 outbound fn 0x0E (the
 *      QUERY_STATES request). If there are MORE 0x0E frames with
 *      different shape (longer payloads), those are responses.
 *
 *   3. Response is fn 0x74/0x75/0x76 state-broadcast triples. The
 *      state-broadcast-decode-research doc says ZERO triples in
 *      direct-sync, but let's re-verify against the raw file.
 *
 * For each fn 0x18 frame, we also extract the blockId, then look for
 * the very NEXT frame after it (which would be the response if the
 * protocol is synchronous request/response).
 *
 * Output: prints findings to stdout.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const CAPTURE = path.resolve('samples/captured/session-58-direct-sync.syx');

interface Frame {
  index: number;
  offset: number;
  length: number;
  fn: number;
  payload: Uint8Array;
}

function walkFrames(buf: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== 0xf0) {
      i++;
      continue;
    }
    const start = i;
    let j = i + 1;
    while (j < buf.length && buf[j] !== 0xf7) j++;
    if (j >= buf.length) break;
    if (j - start + 1 >= 7
        && buf[start + 1] === 0x00
        && buf[start + 2] === 0x01
        && buf[start + 3] === 0x74
        && buf[start + 4] === 0x07) {
      frames.push({
        index: frames.length,
        offset: start,
        length: j - start + 1,
        fn: buf[start + 5],
        // Payload = bytes after fn, before checksum + F7
        payload: buf.subarray(start + 6, j - 1),
      });
    }
    i = j + 1;
  }
  return frames;
}

const buf = new Uint8Array(readFileSync(CAPTURE));
const frames = walkFrames(buf);
console.log(`Total Axe-Fx II frames: ${frames.length}`);

// ── Histogram: count + average length per fn byte ─────────────────
const stats = new Map<number, { count: number; totalLen: number; minLen: number; maxLen: number }>();
for (const f of frames) {
  const s = stats.get(f.fn);
  if (s) {
    s.count++;
    s.totalLen += f.length;
    s.minLen = Math.min(s.minLen, f.length);
    s.maxLen = Math.max(s.maxLen, f.length);
  } else {
    stats.set(f.fn, { count: 1, totalLen: f.length, minLen: f.length, maxLen: f.length });
  }
}
console.log('\nPer-fn-byte histogram (fn, count, lengths):');
const sortedFns = Array.from(stats.entries()).sort((a, b) => b[1].count - a[1].count);
for (const [fn, s] of sortedFns) {
  const lenDesc = s.minLen === s.maxLen
    ? `len=${s.minLen}`
    : `len=${s.minLen}..${s.maxLen} (avg ${Math.round(s.totalLen / s.count)})`;
  console.log(`  fn=0x${fn.toString(16).padStart(2, '0')}  count=${String(s.count).padStart(4)}  ${lenDesc}`);
}

// ── fn 0x18 frame analysis ────────────────────────────────────────
const fn18 = frames.filter((f) => f.fn === 0x18);
console.log(`\nfn 0x18 frames: ${fn18.length}`);
const fn18LenHist = new Map<number, number>();
for (const f of fn18) {
  fn18LenHist.set(f.length, (fn18LenHist.get(f.length) ?? 0) + 1);
}
console.log('  length histogram:');
for (const [len, cnt] of Array.from(fn18LenHist.entries()).sort((a, b) => a[0] - b[0])) {
  console.log(`    len=${len}: ${cnt} frames`);
}

// ── Are any fn 0x18 frames non-empty (non-zero payload)? ──────────
console.log('\nfn 0x18 payload byte-1 (post-blockId) values across all 24 frames:');
for (const f of fn18) {
  const p = f.payload;
  const blockId = p[0] | (p[1] << 7);
  const nonZeroPostBlockId = p.slice(2).some((b) => b !== 0);
  const tail = Array.from(p.slice(2)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`  [${f.index}] offset=0x${f.offset.toString(16)}  len=${f.length}  blockId=0x${blockId.toString(16)} (${blockId})  payload_tail=[${tail}]  has_data=${nonZeroPostBlockId}`);
}

// ── Look at frames that IMMEDIATELY FOLLOW each fn 0x18 ────────────
// Sync protocols often emit request→response pairs back-to-back; the
// frame after each fn 0x18 might be its response (under any fn byte).
console.log('\nFrame immediately following each fn 0x18 (potential response):');
for (const f of fn18) {
  const next = frames[f.index + 1];
  if (next) {
    const payloadPreview = Array.from(next.payload.slice(0, 12))
      .map((b) => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`  after [${f.index}] (blockId 0x${(f.payload[0] | (f.payload[1] << 7)).toString(16)}): next is fn=0x${next.fn.toString(16).padStart(2, '0')} len=${next.length} payload[0..12]=[${payloadPreview}${next.payload.length > 12 ? ' ...' : ''}]`);
  } else {
    console.log(`  after [${f.index}]: (no next frame)`);
  }
}

// ── 0x74/0x75/0x76 state-broadcast triple check ───────────────────
console.log('\nState-broadcast triples (0x74/0x75/0x76):');
const triples = { 0x74: 0, 0x75: 0, 0x76: 0 };
for (const f of frames) {
  if (f.fn === 0x74) triples[0x74]++;
  if (f.fn === 0x75) triples[0x75]++;
  if (f.fn === 0x76) triples[0x76]++;
}
console.log(`  fn=0x74 (HEADER): ${triples[0x74]}`);
console.log(`  fn=0x75 (CHUNK):  ${triples[0x75]}`);
console.log(`  fn=0x76 (FOOTER): ${triples[0x76]}`);

// ── fn 0x0E PRESET_BLOCKS_DATA analysis ───────────────────────────
const fn0e = frames.filter((f) => f.fn === 0x0e);
console.log(`\nfn 0x0E (PRESET_BLOCKS_DATA / QUERY_STATES) frames: ${fn0e.length}`);
for (const f of fn0e) {
  const payloadHex = Array.from(f.payload.slice(0, 24))
    .map((b) => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`  [${f.index}] offset=0x${f.offset.toString(16)}  len=${f.length}  payload[0..24]=[${payloadHex}${f.payload.length > 24 ? ' ...' : ''}]`);
}

// ── fn 0x21 SYSEX_RESYNC / FRONT_PANEL_CHANGE_DETECTED check ──────
console.log('\nfn 0x21 SYSEX_RESYNC / FRONT_PANEL_CHANGE_DETECTED frames:');
const fn21 = frames.filter((f) => f.fn === 0x21);
console.log(`  count: ${fn21.length}`);
for (const f of fn21.slice(0, 5)) {
  const payloadHex = Array.from(f.payload).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`  [${f.index}] offset=0x${f.offset.toString(16)} len=${f.length} payload=[${payloadHex}]`);
}
