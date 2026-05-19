/**
 * Peek AM4-Edit's effectDefinitions cache to understand its schema.
 *
 * File location:
 *   %APPDATA%\Fractal Audio\AM4-Edit\effectDefinitions_15_2p0.cache
 *
 * Where:
 *   15 = AM4 model byte (matches docs/devices/am4/SYSEX-MAP.md)
 *   2p0 = current AM4 firmware version
 *
 * Session 09 finding: AM4-Edit queries the AM4 firmware for parameter
 * metadata at startup and caches it here. The cache contains parameter
 * ranges (min/max/default/step) and enum dropdown strings — i.e. the
 * entire block-params table we need to populate KNOWN_PARAMS in bulk.
 *
 * This script walks the file heuristically and prints a structured
 * summary so we can infer the full schema.
 *
 * Run: npx tsx scripts/peek-cache.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const appdata = process.env.APPDATA;
if (!appdata) throw new Error('APPDATA not set');
const path = join(appdata, 'Fractal Audio', 'AM4-Edit', 'effectDefinitions_15_2p0.cache');
const buf = readFileSync(path);

console.log(`size: ${buf.length} bytes`);
console.log(`first 16 bytes: ${buf.slice(0, 16).toString('hex')}`);
console.log(`  as two u64 LE: ${buf.readBigUInt64LE(0)}, ${buf.readBigUInt64LE(8)}`);

// Attempt to walk as a stream of [id:u16 LE][typecode:u16 LE] records.
// Enum payload shape (typecode 0x1d seen): fixed fields then
//   [count:u32][(len:u32, bytes)*count].
// Float-range payload shape (typecode 0x37 seen): fixed fields then 4 floats
// then zero padding.

function readLPString(off: number): { s: string; next: number } | null {
  if (off + 4 > buf.length) return null;
  const len = buf.readUInt32LE(off);
  if (len < 0 || len > 64) return null;
  if (off + 4 + len > buf.length) return null;
  let ok = true;
  for (let i = 0; i < len; i++) {
    const b = buf[off + 4 + i];
    if (b === 0 && i === len) continue;
    if (b < 0x20 || b > 0x7e) { ok = false; break; }
  }
  if (!ok) return null;
  return { s: buf.slice(off + 4, off + 4 + len).toString('ascii'), next: off + 4 + len };
}

// Walk & bucket records by typecode, showing examples of each.
const typeExamples = new Map<number, { count: number; firstOff: number; sample: string }>();

let i = 32; // skip plausible 32-byte header
const records: { off: number; id: number; typecode: number; strings: string[]; floats: number[] }[] = [];
let consecFailures = 0;

while (i + 4 <= buf.length && records.length < 2000) {
  const id = buf.readUInt16LE(i);
  const typecode = buf.readUInt16LE(i + 2);
  // Heuristic: id must be plausible (0..0x3fff), typecode must be small
  if (id > 0x3fff || typecode === 0 || typecode > 0x200) {
    i++;
    consecFailures++;
    if (consecFailures > 1024) break;
    continue;
  }
  consecFailures = 0;

  // Scan the next ~512 bytes for a small count-prefixed string list (enum)
  // and any 4-byte floats that look reasonable.
  const scanStart = i + 4;
  const scanEnd = Math.min(i + 4 + 512, buf.length);

  // Try each position within first 32 bytes as a possible count prefix.
  const strings: string[] = [];
  let usedOff = i + 4;
  for (let off = scanStart; off < scanStart + 64 && off + 4 <= buf.length; off++) {
    const maybeCount = buf.readUInt32LE(off);
    if (maybeCount < 2 || maybeCount > 512) continue;
    // Try parsing maybeCount length-prefixed strings in a row
    let p = off + 4;
    const collected: string[] = [];
    for (let k = 0; k < maybeCount; k++) {
      const r = readLPString(p);
      if (!r) { collected.length = 0; break; }
      collected.push(r.s);
      p = r.next;
    }
    if (collected.length === maybeCount && collected.length > 0) {
      strings.push(...collected);
      usedOff = p;
      break;
    }
  }

  const floats: number[] = [];
  for (let off = scanStart; off + 4 <= scanEnd; off += 4) {
    const f = buf.readFloatLE(off);
    if (!Number.isFinite(f)) continue;
    const abs = Math.abs(f);
    if ((abs > 1e-4 && abs < 1e6) || f === 0) floats.push(f);
    if (floats.length >= 8) break;
  }

  records.push({ off: i, id, typecode, strings, floats });

  // Advance: if we found enum strings, jump past them; else advance by a
  // heuristic step keyed on typecode value (often matches payload length).
  if (strings.length > 0) {
    i = usedOff;
  } else {
    i += Math.max(typecode, 4);
  }
}

console.log(`\nwalked ${records.length} records (first 2000; stopped at i=0x${i.toString(16)})`);

// Bucket by typecode
const byType = new Map<number, typeof records>();
for (const r of records) {
  if (!byType.has(r.typecode)) byType.set(r.typecode, []);
  byType.get(r.typecode)!.push(r);
}

console.log('\nrecords per typecode (top 20):');
const sorted = [...byType.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [tc, rs] of sorted.slice(0, 20)) {
  console.log(`  typecode 0x${tc.toString(16).padStart(4, '0')} (${tc}): ${rs.length} records; id range [0x${Math.min(...rs.map(r => r.id)).toString(16)}..0x${Math.max(...rs.map(r => r.id)).toString(16)}]`);
}

console.log('\nfirst record of each of the top 10 typecodes:');
for (const [tc, rs] of sorted.slice(0, 10)) {
  const r = rs[0];
  console.log(`  tc=0x${tc.toString(16)}  id=0x${r.id.toString(16).padStart(4,'0')}  @off=0x${r.off.toString(16)}`);
  console.log(`    floats: [${r.floats.slice(0,6).map(f => f.toFixed(4)).join(', ')}]`);
  if (r.strings.length) console.log(`    strings (${r.strings.length}): ${r.strings.slice(0,8).map(s => `"${s}"`).join(', ')}`);
}
