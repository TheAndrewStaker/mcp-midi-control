/**
 * parse-effectdefinitions-cache.ts
 *
 * Strict count-driven walker for Fractal editor `effectDefinitions_*.cache`
 * files (FM9-Edit, AM4-Edit, AxeEdit II/III, VP4-Edit). Faithful TypeScript
 * port of the reference Python implementation
 * (samples/captured/local-caches-2026-06-09/strict.py).
 *
 * File grammar (solved 2026-06-09, see docs/_private/CACHE-FORMAT-SOLVED-2026-06-09.md
 * and the primitive entry editor-cache-section-record-grammar.md):
 *
 *   file    := preamble , section+
 *   section := u32 sectionTag , u32 recordCount , record{recordCount}
 *   record  := u16 id , u16 typecode , u16 pad(=0) ,
 *              f32 min , f32 max , f32 default , f32 step ,
 *              ( enumTail | floatTail | tableTail )
 *   enumTail  := u32 count , count * (u32 len , ascii[len]) , u32 x , u16 0
 *   floatTail := u32 t1 , u32 t2 , u16 0          (record = 32 bytes)
 *   tableTail := (id in 0xfff0..0xfffe only)
 *                u32 count , count * (u32 len , ascii[len]) ,
 *                u16 0 , u32 idCount , idCount * u32 wireId
 *
 * Preamble: first section header at 0x2e (AM4/gen-3 caches) or 0x0e
 * (Axe-Fx II cache). Auto-detect: try 0x2e then 0x0e, accept where
 * 1<=tag<=64 && 1<=count<=8192. id=0xffff is a name table (plain enumTail);
 * ids 0xfff0..0xfffe are cab/IR tables (tableTail).
 *
 * The walk is fully deterministic: section headers carry exact record
 * counts. ZERO resync: any violation throws with a hex-context dump.
 *
 * Usage:
 *   npx tsx scripts/_research/parse-effectdefinitions-cache.ts <cache-file> [--out <json>] [--verify] [-v]
 *
 * Output JSON shape matches the Python walker's `.walk.json`:
 *   { sections: [{index, count, offset, records}], records: [...] }
 *
 * --verify re-asserts the hardware anchors (FM9 11p0 amp/FUZZ/REVERB
 * ordinals + REVERB_TIME range; II 266-entry amp roster) against the walk.
 */
import { readFileSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const positional: string[] = [];
let outPath: string | undefined;
let verify = false;
let verbose = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') {
    outPath = args[++i];
    if (!outPath) fail('--out requires a path argument');
  } else if (a === '--verify') {
    verify = true;
  } else if (a === '-v' || a === '--verbose') {
    verbose = true;
  } else {
    positional.push(a);
  }
}
if (positional.length !== 1) {
  fail('usage: npx tsx scripts/_research/parse-effectdefinitions-cache.ts <cache-file> [--out <json>] [--verify] [-v]');
}
const PATH = positional[0];

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Buffer helpers
// ---------------------------------------------------------------------------

const buf = readFileSync(PATH);
const N = buf.length;

const u16 = (o: number) => buf.readUInt16LE(o);
const u32 = (o: number) => buf.readUInt32LE(o);
const f32 = (o: number) => buf.readFloatLE(o);

function hexdump(start: number, length: number, mark?: number): string {
  const out: string[] = [];
  for (let base = Math.max(0, start) & ~0xf; base < Math.min(start + length, N); base += 16) {
    const bs = buf.subarray(base, base + 16);
    const hx = [...bs].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const asc = [...bs].map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('');
    const m = mark !== undefined && base <= mark && mark < base + 16 ? ' <<<' : '';
    out.push(`  0x${base.toString(16).padStart(6, '0')}: ${hx.padEnd(48)} ${asc}${m}`);
  }
  return out.join('\n');
}

function hex(n: number): string {
  return '0x' + n.toString(16);
}

/** ZERO-resync policy: any grammar violation throws with hex context. */
class WalkError extends Error {
  constructor(reason: string, offset: number, recordsWalked: number) {
    super(
      `cache walk VIOLATION: ${reason} at ${hex(offset)} ` +
        `(${recordsWalked} records walked, ${N - offset} bytes remaining)\n` +
        hexdump(offset - 64, 176, offset)
    );
  }
}

// ---------------------------------------------------------------------------
// Grammar primitives
// ---------------------------------------------------------------------------

function tryLpString(off: number, maxlen = 64): [string, number] | undefined {
  if (off + 4 > N) return undefined;
  const L = u32(off);
  if (L < 1 || L > maxlen || off + 4 + L > N) return undefined;
  const s = buf.subarray(off + 4, off + 4 + L);
  for (const c of s) if (c < 0x20 || c > 0x7e) return undefined;
  return [s.toString('ascii'), off + 4 + L];
}

function tryEnumBody(off: number, maxcount = 4096): [number, string[], number] | undefined {
  if (off + 4 > N) return undefined;
  const count = u32(off);
  if (count < 1 || count > maxcount) return undefined;
  let p = off + 4;
  const vals: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = tryLpString(p);
    if (r === undefined) return undefined;
    vals.push(r[0]);
    p = r[1];
  }
  return [count, vals, p];
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

interface Section {
  index: number;
  count: number;
  offset: number;
  records: number;
}

interface RecordBase {
  kind: 'enum' | 'float';
  section: number;
  offset: number;
  id: number;
  tc: number;
  min: number;
  max: number;
  def: number;
  step: number;
}

interface EnumRecord extends RecordBase {
  kind: 'enum';
  count: number;
  values: string[];
  x: number;
  wireIds?: number[];
}

interface FloatRecord extends RecordBase {
  kind: 'float';
  t1: number;
  t2: number;
}

type CacheRecord = EnumRecord | FloatRecord;

const sections: Section[] = [];
const records: CacheRecord[] = [];

console.log(`file: ${PATH}  size: ${N}`);
if (verbose) {
  console.log('header:');
  console.log(hexdump(0, 0x40));
}

// First section header position differs by editor generation:
// AM4/gen-3 caches: 0x2e (after 38-byte preamble); II cache: 0x0e.
let off: number | undefined;
for (const cand of [0x2e, 0x0e]) {
  if (cand + 8 > N) continue;
  const A0 = u32(cand);
  const B0 = u32(cand + 4);
  if (A0 >= 1 && A0 <= 64 && B0 >= 1 && B0 <= 8192) {
    off = cand;
    break;
  }
}
if (off === undefined) {
  fail('no initial section header found at 0x2e or 0x0e');
}

let sec: Section | undefined;
let remaining = 0;

try {
while (off < N) {
  if (remaining === 0) {
    if (off + 8 > N) {
      if (off === N) break;
      throw new WalkError('TRAILING-BYTES', off, records.length);
    }
    const A = u32(off);
    const B = u32(off + 4);
    if (A > 64 || B > 8192) {
      // Older cache revision marker: a standalone u16 0x8000 lands in the
      // would-be count field as 0x80000000 (seen on FM9 fw 9p0/9p1/9p2/10p0).
      if (A === 0 && B === 0x8000_0000) {
        throw new WalkError(
          'older cache revision (0x8000 markers), not supported',
          off,
          records.length
        );
      }
      throw new WalkError(`BAD-SECTION-HEADER A=${A} B=${B}`, off, records.length);
    }
    sec = { index: A, count: B, offset: off, records: 0 };
    sections.push(sec);
    remaining = B;
    off += 8;
    continue;
  }

  if (off + 22 > N) throw new WalkError('RECORD-EOF', off, records.length);
  const idv = u16(off);
  const tc = u16(off + 2);
  const pad = u16(off + 4);
  if (pad !== 0) {
    throw new WalkError(`BAD-PAD id=${hex(idv)} tc=${hex(tc)} pad=${hex(pad)}`, off, records.length);
  }
  const mn = f32(off + 6);
  const mx = f32(off + 10);
  const df = f32(off + 14);
  const st = f32(off + 18);

  const en = tryEnumBody(off + 22);
  if (en !== undefined) {
    const [count, vals, end] = en;
    if (end + 6 > N) throw new WalkError('ENUM-EOF', off, records.length);
    const rec: EnumRecord = {
      kind: 'enum',
      section: sec!.index,
      offset: off,
      id: idv,
      tc,
      min: mn,
      max: mx,
      def: df,
      step: st,
      count,
      values: vals,
      x: 0,
    };
    if (idv >= 0xfff0 && idv <= 0xfffe) {
      // cab/IR table record: tail = u16 0, u32 cnt, cnt x u32 wire-ids
      const z = u16(end);
      const cnt = u32(end + 2);
      if (z !== 0 || cnt > 8192) {
        throw new WalkError(`BAD-FFF0-TAIL z=${hex(z)} cnt=${cnt}`, end, records.length);
      }
      const idsEnd = end + 6 + 4 * cnt;
      if (idsEnd > N) throw new WalkError('FFF0-IDS-EOF', end, records.length);
      rec.wireIds = [];
      for (let i = 0; i < cnt; i++) rec.wireIds.push(u32(end + 6 + 4 * i));
      records.push(rec);
      off = idsEnd;
    } else {
      const x = u32(end);
      const z = u16(end + 4);
      if (z !== 0) {
        throw new WalkError(`BAD-ENUM-TRAILER x=${hex(x)} z=${hex(z)}`, end, records.length);
      }
      rec.x = x;
      records.push(rec);
      off = end + 6;
    }
  } else {
    if (off + 32 > N) throw new WalkError('FLOAT-EOF', off, records.length);
    const t1 = u32(off + 22);
    const t2 = u32(off + 26);
    const z = u16(off + 30);
    if (z !== 0) {
      throw new WalkError(`BAD-FLOAT-TAIL t1=${hex(t1)} t2=${hex(t2)} z=${hex(z)}`, off + 30, records.length);
    }
    records.push({
      kind: 'float',
      section: sec!.index,
      offset: off,
      id: idv,
      tc,
      min: mn,
      max: mx,
      def: df,
      step: st,
      t1,
      t2,
    });
    off += 32;
  }
  sec!.records += 1;
  remaining -= 1;
}
} catch (e) {
  if (e instanceof WalkError) {
    console.error(`\n${e.message}`);
    process.exit(1);
  }
  throw e;
}

console.log(`\nwalked ${records.length} records to CLEAN EOF (zero resync)`);

// ---------------------------------------------------------------------------
// Section summary
// ---------------------------------------------------------------------------

console.log(`\nsections (${sections.length}):`);
for (const s of sections) {
  const secrecs = records.filter((r) => r.section === s.index);
  const enCount = secrecs.filter((r) => r.kind === 'enum').length;
  const fl = secrecs.length - enCount;
  const ids = secrecs.filter((r) => r.id < 0xff00).map((r) => r.id);
  const rng = ids.length ? `ids ${hex(Math.min(...ids))}..${hex(Math.max(...ids))}` : 'no plain ids';
  const tables = secrecs.filter((r) => r.id >= 0xff00) as EnumRecord[];
  const tnote = tables.length
    ? ` tables=${JSON.stringify(tables.map((r) => [hex(r.id), r.count]))}`
    : '';
  console.log(
    `  @${hex(s.offset).padStart(7, ' ')} section ${s.index}: declared=${s.count} ` +
      `walked=${s.records} (enum=${enCount} float=${fl}) ${rng}${tnote}`
  );
}

if (verbose) {
  const counter = (vals: number[]) => {
    const c = new Map<number, number>();
    for (const v of vals) c.set(v, (c.get(v) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  };
  const enRecs = records.filter((r): r is EnumRecord => r.kind === 'enum');
  const flRecs = records.filter((r): r is FloatRecord => r.kind === 'float');
  console.log(`\nenum-x values: ${JSON.stringify(counter(enRecs.map((r) => r.x)))}`);
  console.log(`float t1 values: ${JSON.stringify(counter(flRecs.map((r) => r.t1)))}`);
  console.log(`float t2 values: ${JSON.stringify(counter(flRecs.map((r) => r.t2)))}`);
}

// ---------------------------------------------------------------------------
// --verify: hardware anchors
// ---------------------------------------------------------------------------

if (verify) {
  let pass = 0;
  let failCount = 0;
  const assertEq = (label: string, actual: unknown, expected: unknown) => {
    const ok = actual === expected;
    if (ok) pass++;
    else failCount++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
  };
  const assertClose = (label: string, actual: number, expected: number, eps = 1e-6) => {
    const ok = Math.abs(actual - expected) < eps;
    if (ok) pass++;
    else failCount++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}: ${actual}${ok ? '' : ` (expected ~${expected})`}`);
  };
  const findEnum = (section: number, id: number) =>
    records.find((r): r is EnumRecord => r.kind === 'enum' && r.section === section && r.id === id);
  const findFloat = (section: number, id: number) =>
    records.find((r): r is FloatRecord => r.kind === 'float' && r.section === section && r.id === id);

  const fm9Amp = findEnum(10, 10);
  const iiAmp = findEnum(5, 0);

  if (fm9Amp && fm9Amp.count === 331) {
    console.log('\nverify: FM9 anchor set (hardware-confirmed ordinals)');
    assertEq('amp-331 count (section 10 id 10)', fm9Amp.count, 331);
    assertEq('amp[65]', fm9Amp.values[65], 'SV Bass 2');
    assertEq('amp[179]', fm9Amp.values[179], 'Texas Star Clean');
    assertEq('amp[264]', fm9Amp.values[264], 'SV Bass 1');
    const fuzz = findEnum(25, 0);
    assertEq('FUZZ-86 count (section 25 id 0)', fuzz?.count, 86);
    assertEq('FUZZ[15]', fuzz?.values[15], 'Blues OD');
    assertEq('FUZZ[36]', fuzz?.values[36], 'Blackglass 7K');
    const rev = findEnum(12, 10);
    assertEq('REVERB-79 count (section 12 id 10)', rev?.count, 79);
    assertEq('REVERB[16]', rev?.values[16], 'Medium Spring');
    assertEq('REVERB[45]', rev?.values[45], 'Music Hall');
    const rt = findFloat(12, 11);
    if (rt) {
      assertClose('REVERB_TIME min (section 12 id 11)', rt.min, 0.1);
      assertClose('REVERB_TIME max', rt.max, 100);
    } else {
      failCount++;
      console.log('  FAIL REVERB_TIME float record (section 12 id 11) not found');
    }
  } else if (iiAmp) {
    console.log('\nverify: Axe-Fx II anchor set (cache==catalog roster)');
    assertEq('amp roster count (section 5 id 0)', iiAmp.count, 266);
    assertEq('amp[0]', iiAmp.values[0], '59 BASSGUY');
    assertEq('amp[259]', iiAmp.values[259], 'FRIEDMAN BE C45');
    assertEq('amp[264]', iiAmp.values[264], 'SV BASS 2');
    assertEq('amp[265]', iiAmp.values[265], 'SKULL CRUSHER');
  } else {
    fail('\n--verify: no known anchor set applies to this cache (need FM9 11p0-class or II cache)');
  }
  console.log(`\nverify: ${pass} pass, ${failCount} fail`);
  if (failCount > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

const out = outPath ?? PATH.replace(/\.[^.\\/]+$/, '') + '.walk.json';
writeFileSync(out, JSON.stringify({ sections, records }));
console.log(`wrote ${out}`);
