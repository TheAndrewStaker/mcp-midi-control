/**
 * Analyze the NEW fn=0x01 sub-actions that appear in the 2026-06-04 FM9
 * "enum label sweep" capture but were ABSENT from capture3 (2026-06-03):
 *   sub = 0x19, 0x1a, 0x1b, 0x22, 0x23
 * These fire on block-open (the editor enumerating a block). The hypothesis is
 * that one of them is the getBlockString family — the device-resident
 * {effectId, paramId, index → name} dictionary that closes the BK-093 write leg.
 *
 * For each sub-action we:
 *   - pair each OUT request with the next IN response on the same sub
 *   - print the request fields (effectId, paramId, extra bytes)
 *   - dump the response body in several string decodings:
 *       raw ASCII, low-7-bit ASCII, streaming MSB-first 8→7 septet unpack,
 *       2-chars/16-bit-word (the gen-3 preset name packing)
 *
 * Run: npx tsx scripts/_research/analyze-fm9-blockstring-subactions.ts <frames.json> [sub]
 */
import { readFileSync, existsSync } from 'node:fs';

interface Frame { dir: 'IN' | 'OUT'; t: string; fn: number; sub: number; len: number; hex: string; }
const PATH = process.argv[2];
const ONLY_SUB = process.argv[3] ? parseInt(process.argv[3], 16) : undefined;
if (!PATH || !existsSync(PATH)) { console.error('usage: <frames.json> [subHex]'); process.exit(1); }
const frames = JSON.parse(readFileSync(PATH, 'utf8')) as Frame[];
const bytes = (f: Frame): number[] => f.hex.split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16));
const dec14 = (lo: number, hi: number): number => (lo & 0x7f) | ((hi & 0x7f) << 7);

// ── string decoders ──
function rawAscii(b: number[]): string {
  return b.map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.')).join('');
}
function low7Ascii(b: number[]): string {
  return b.map((c) => { const x = c & 0x7f; return x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.'; }).join('');
}
// streaming MSB-first 8→7 regroup (primitive iii-byte-stream-septet-pack-8to7), UNPACK 7→8
function septetUnpack(septets: number[]): number[] {
  let acc = 0, bits = 0; const out: number[] = [];
  for (const s of septets) {
    acc = (acc << 7) | (s & 0x7f); bits += 7;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return out;
}
function asciiOf(b: number[]): string {
  return b.map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.')).join('');
}
// 2 ASCII chars per 16-bit word, 3-septet packValue16 (gen-3 preset-name packing)
function wordPackedName(b: number[]): string {
  let out = '';
  for (let i = 0; i + 3 <= b.length; i += 3) {
    const w = (b[i] & 0x7f) | ((b[i + 1] & 0x7f) << 7) | ((b[i + 2] & 0x7f) << 14);
    const lo = w & 0xff, hi = (w >> 8) & 0xff;
    out += (lo >= 0x20 && lo < 0x7f ? String.fromCharCode(lo) : '.');
    out += (hi >= 0x20 && hi < 0x7f ? String.fromCharCode(hi) : '.');
  }
  return out;
}

const NEW_SUBS = [0x19, 0x1a, 0x1b, 0x22, 0x23];
const subs = ONLY_SUB !== undefined ? [ONLY_SUB] : NEW_SUBS;

for (const sub of subs) {
  const fs = frames.filter((f) => f.fn === 0x01 && f.sub === sub);
  const outs = fs.filter((f) => f.dir === 'OUT');
  const ins = fs.filter((f) => f.dir === 'IN');
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`sub=0x${sub.toString(16)}  OUT=${outs.length} IN=${ins.length}  lenset(IN)=${[...new Set(ins.map((f) => f.len))].sort((a, b) => a - b).join(',')}`);
  console.log('═'.repeat(70));

  // pair each OUT with the chronologically next IN (same sub)
  let inIdx = 0;
  const samples = Math.min(outs.length, 14);
  for (let k = 0; k < samples; k++) {
    const req = outs[k];
    // find next IN after this request's time
    while (inIdx < ins.length && parseFloat(ins[inIdx].t) < parseFloat(req.t)) inIdx++;
    const resp = ins[inIdx];
    const rb = bytes(req);
    const reqEff = dec14(rb[8], rb[9]);
    const reqPid = dec14(rb[10], rb[11]);
    console.log(`\n[REQ +${req.t}s] eff=${reqEff} pid=${reqPid}  ${req.hex}`);
    if (!resp) { console.log('  (no IN response)'); continue; }
    const ab = bytes(resp);
    const body = ab.slice(8, ab.length - 2); // after F0 00 01 74 model fn sub xx
    console.log(`[RSP +${resp.t}s len=${resp.len}] ${resp.hex.slice(0, 90)}${resp.hex.length > 90 ? ' …' : ''}`);
    console.log(`  raw : ${rawAscii(body).slice(0, 70)}`);
    console.log(`  low7: ${low7Ascii(body).slice(0, 70)}`);
    console.log(`  7→8 : ${asciiOf(septetUnpack(body)).slice(0, 70)}`);
    console.log(`  word: ${wordPackedName(body).slice(0, 70)}`);
  }
}
