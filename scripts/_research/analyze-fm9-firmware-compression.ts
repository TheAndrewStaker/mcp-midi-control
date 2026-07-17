/**
 * S4: FM9 DSP firmware compression analysis (offline, no hardware).
 *
 * The {raw-enum-id to name} table that closes the BK-093 WRITE leg is
 * device-resident (the `msg_getBlockString` strings live in firmware). Prior
 * mining used the WRONG septet algorithm (Roland group-of-8); the correct
 * Fractal scheme is the 8-to-7 packer in primitive
 * `iii-byte-stream-septet-pack-8to7`. Re-decoding with the correct inverse
 * gives entropy ~6.5 bits/byte, so the DSP image is COMPRESSED, not encrypted,
 * and the strings are recoverable IF the compression is identified.
 *
 * This script does NOT decompress. It characterizes the image so the next RE
 * session can pick a decompressor:
 *   1. Concat the septet payloads (frame[8:-2]) from every frame (the image is
 *      entirely fn=0x7d/0x7e/0x7f frames).
 *   2. Unpack 7-to-8 as a big-endian bitstream concat (the correct inverse of
 *      the primitive LSB-first-with-carry 8-to-7 packer; verified byte-exact
 *      against its golden: [0x7f,0x40] decodes to [0xFF]).
 *   3. Report: size, overall + windowed Shannon entropy, byte histogram skew.
 *   4. Scan for known compression container magic bytes (zlib/gzip/xz/lzma/
 *      lz4/zstd/bzip2) across the whole image, not just offset 0.
 *   5. Try Node zlib inflate/gunzip at every candidate offset (cheap, decisive).
 *   6. LZ-structure heuristic: distinct vs repeated 8-grams (low distinct
 *      fraction implies dictionary/back-reference structure, i.e. LZ-family).
 *
 * Run:  npx tsx scripts/_research/analyze-fm9-firmware-compression.ts
 * Out:  console + docs/_private/FM9-FIRMWARE-COMPRESSION-S4-2026-06-03.md
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { inflateSync, inflateRawSync, gunzipSync, brotliDecompressSync } from 'node:zlib';

const SYX = process.argv[2] ?? 'samples/captured/fm9-fw/fm9_dsp_rel_11p00.syx';
const OUT = 'docs/_private/FM9-FIRMWARE-COMPRESSION-S4-2026-06-03.md';

if (!existsSync(SYX)) {
  console.error(`firmware not found: ${SYX} (gitignored sample; nothing to do)`);
  process.exit(0);
}

// ── 1. Frame parse ─────────────────────────────────────────────────
const raw = readFileSync(SYX);
const frames: number[][] = [];
{
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== 0xf0) { i++; continue; }
    let j = i + 1;
    while (j < raw.length && raw[j] !== 0xf7) j++;
    frames.push([...raw.subarray(i, j + 1)]);
    i = j + 1;
  }
}
const fnHist = new Map<number, number>();
for (const f of frames) fnHist.set(f[5], (fnHist.get(f[5]) ?? 0) + 1);

// ── 2. Septet payload extract + 7→8 unpack ─────────────────────────
// Big-endian bitstream concat (the correct inverse of the primitive
// LSB-first-with-carry packer): concat each septet's low 7 bits into a
// bitstream, read 8 bits per output byte. (Self-test below.)
function unpackSeptetStream(septets: number[]): Uint8Array {
  let acc = 0, nbits = 0;
  const out: number[] = [];
  for (const s of septets) {
    acc = ((acc << 7) | (s & 0x7f)) >>> 0;
    nbits += 7;
    while (nbits >= 8) { nbits -= 8; out.push((acc >> nbits) & 0xff); }
  }
  return Uint8Array.from(out);
}
// Self-test against the primitive golden ([0xFF] packs to [0x7f,0x40]).
const selfTest = unpackSeptetStream([0x7f, 0x40]);
const unpackOk = selfTest.length >= 1 && selfTest[0] === 0xff;

const septets: number[] = [];
let nonSeptet = 0;
for (const f of frames) {
  const payload = f.slice(8, f.length - 2);
  for (const b of payload) {
    if (b & 0x80) { nonSeptet++; continue; }
    septets.push(b);
  }
}
const image = unpackSeptetStream(septets);

// ── 3. Entropy + histogram ─────────────────────────────────────────
function shannon(buf: Uint8Array): number {
  const counts = new Array(256).fill(0);
  for (const b of buf) counts[b]++;
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / buf.length;
    h -= p * Math.log2(p);
  }
  return h;
}
const overallEntropy = shannon(image);
const WIN = 4096;
const winEntropies: number[] = [];
for (let off = 0; off + WIN <= image.length; off += WIN) {
  winEntropies.push(shannon(image.subarray(off, off + WIN)));
}
winEntropies.sort((a, b) => a - b);
const pct = (arr: number[], p: number) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : 0;

const hist = new Array(256).fill(0);
for (const b of image) hist[b]++;
const topBytes = hist.map((c, v) => ({ v, c })).sort((a, b) => b.c - a.c).slice(0, 8);

// ── 4. Compression magic scan ──────────────────────────────────────
const MAGICS: { name: string; sig: number[] }[] = [
  { name: 'gzip', sig: [0x1f, 0x8b, 0x08] },
  { name: 'zlib(default)', sig: [0x78, 0x9c] },
  { name: 'zlib(best)', sig: [0x78, 0xda] },
  { name: 'zlib(fast/no)', sig: [0x78, 0x01] },
  { name: 'xz', sig: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { name: 'lzma-alone', sig: [0x5d, 0x00, 0x00] },
  { name: 'lz4-frame', sig: [0x04, 0x22, 0x4d, 0x18] },
  { name: 'zstd', sig: [0x28, 0xb5, 0x2f, 0xfd] },
  { name: 'bzip2', sig: [0x42, 0x5a, 0x68] },
];
function findSig(buf: Uint8Array, sig: number[], limit = 64): number[] {
  const hits: number[] = [];
  for (let i = 0; i + sig.length <= buf.length && hits.length < limit; i++) {
    let ok = true;
    for (let k = 0; k < sig.length; k++) if (buf[i + k] !== sig[k]) { ok = false; break; }
    if (ok) hits.push(i);
  }
  return hits;
}
const magicHits = MAGICS.map((m) => ({ name: m.name, offsets: findSig(image, m.sig) }))
  .filter((m) => m.offsets.length > 0);

// ── 5. Try inflate/gunzip/brotli at candidate offsets ──────────────
const candidateOffsets = new Set<number>([0]);
for (const m of magicHits) for (const o of m.offsets.slice(0, 8)) candidateOffsets.add(o);
// Also try a few fixed early offsets (a header may precede the stream).
for (const o of [2, 4, 8, 16, 32, 64, 128, 256]) candidateOffsets.add(o);

const decompressTries: { offset: number; method: string; ok: boolean; outLen?: number; sample?: string }[] = [];
for (const off of [...candidateOffsets].sort((a, b) => a - b)) {
  const slice = Buffer.from(image.subarray(off));
  for (const [method, fn] of [
    ['inflate', inflateSync],
    ['inflateRaw', inflateRawSync],
    ['gunzip', gunzipSync],
    ['brotli', brotliDecompressSync],
  ] as const) {
    try {
      const out = fn(slice);
      const ascii = [...out.subarray(0, 48)].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      decompressTries.push({ offset: off, method, ok: true, outLen: out.length, sample: ascii });
    } catch {
      decompressTries.push({ offset: off, method, ok: false });
    }
  }
}
const decompressWins = decompressTries.filter((t) => t.ok);

// ── 6. LZ-structure heuristic (8-gram distinctness on a sample) ────
const SAMPLE = Math.min(image.length, 1_000_000);
const seen = new Set<string>();
let grams = 0;
for (let i = 0; i + 8 <= SAMPLE; i += 8) {
  seen.add(Buffer.from(image.subarray(i, i + 8)).toString('latin1'));
  grams++;
}
const distinctFraction = grams ? seen.size / grams : 1;

// ── Report ─────────────────────────────────────────────────────────
const lines: string[] = [];
const p = (s = '') => lines.push(s);
p('# FM9 DSP firmware compression analysis (S4, 2026-06-03)');
p('');
p(`Source: \`${SYX}\` (${raw.length.toLocaleString()} bytes, ${frames.length.toLocaleString()} SysEx frames).`);
p(`Septet unpack self-test ([0x7f,0x40]→0xFF): **${unpackOk ? 'PASS' : 'FAIL'}**.`);
p('');
p('## Frame function bytes');
p('| fn | count |');
p('|---|---|');
for (const [fn, c] of [...fnHist.entries()].sort((a, b) => b[1] - a[1])) {
  p(`| 0x${fn.toString(16)} | ${c.toLocaleString()} |`);
}
p('');
p('## Unpacked DSP image');
p(`- septet payload bytes: **${septets.length.toLocaleString()}** (non-septet skipped: ${nonSeptet})`);
p(`- unpacked image size: **${image.length.toLocaleString()}** bytes`);
p(`- overall Shannon entropy: **${overallEntropy.toFixed(3)}** bits/byte`);
p(`- windowed entropy (${WIN}B windows, n=${winEntropies.length}): min ${pct(winEntropies, 0).toFixed(2)} / p10 ${pct(winEntropies, 0.1).toFixed(2)} / median ${pct(winEntropies, 0.5).toFixed(2)} / p90 ${pct(winEntropies, 0.9).toFixed(2)} / max ${winEntropies[winEntropies.length - 1]?.toFixed(2) ?? 'n/a'}`);
p(`- top byte values: ${topBytes.map((t) => `0x${t.v.toString(16)}×${t.c}`).join(', ')}`);
p(`- 8-gram distinct fraction (first ${SAMPLE.toLocaleString()}B): **${distinctFraction.toFixed(4)}** (≈1.0 ⇒ high-entropy/no literal repeats; <<1 ⇒ LZ-style repetition)`);
p('');
p('## Compression container magic scan');
if (magicHits.length === 0) {
  p('No standard container magic bytes (gzip/zlib/xz/lzma/lz4/zstd/bzip2) found anywhere in the image.');
} else {
  for (const m of magicHits) p(`- **${m.name}**: ${m.offsets.length} hit(s) @ ${m.offsets.slice(0, 8).join(', ')}${m.offsets.length > 8 ? ' …' : ''}`);
}
p('');
p('## Decompression attempts (inflate / inflateRaw / gunzip / brotli)');
if (decompressWins.length === 0) {
  p(`All ${decompressTries.length} attempts across ${candidateOffsets.size} offsets FAILED: not a raw deflate/gzip/brotli stream at any tried offset.`);
} else {
  for (const w of decompressWins) p(`- ✅ offset ${w.offset} via ${w.method}: ${w.outLen} bytes, \`${w.sample}\``);
}
p('');
p('## Verdict');
const compressed = overallEntropy > 6.0;
p(`- Entropy **${overallEntropy.toFixed(2)}** ⇒ ${compressed ? 'COMPRESSED (or encrypted); confirms the prior finding, the image is not plain code/strings.' : 'NOT high-entropy; image may be plain or lightly packed.'}`);
p(`- Standard containers: **${magicHits.length === 0 ? 'none detected' : magicHits.map((m) => m.name).join(', ')}**.`);
p(`- Off-the-shelf decompressors: **${decompressWins.length === 0 ? 'none succeeded' : `${decompressWins.length} succeeded`}**.`);
p('- Next: if no container, the scheme is custom/headered/block-wise. Lanes: (a) find the decompressor in a bootloader/editor binary (signature-scan for the inflate loop), (b) try per-frame/per-block decompression (each 0x7d/0x7e frame may be independently packed), (c) treat the capture route (S3 getBlockString sweep) as primary since it is offline-independent.');
p('');
p('_Generated by `scripts/_research/analyze-fm9-firmware-compression.ts`._');

const report = lines.join('\n') + '\n';
writeFileSync(OUT, report);
console.log(report);
console.log(`\nWrote ${OUT}`);
