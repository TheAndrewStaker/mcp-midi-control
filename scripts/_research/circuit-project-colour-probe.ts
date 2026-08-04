/**
 * Circuit Tracks `.ncs` — focused PROJECT-COLOUR probe (stage 2).
 *
 * Stage 1 (`circuit-project-colour-diff.ts`) showed one corpus file differs from
 * the other 97 at essentially every offset, which floods a naive per-offset
 * distinct-value count. This script:
 *   1. ranks files by Hamming distance to the corpus consensus, to name the
 *      outlier(s) explicitly rather than silently absorbing them;
 *   2. re-runs the differential over the CONSENSUS group only;
 *   3. dumps the file header (0x000..0x2e3) as a per-project matrix for every
 *      offset that varies, so a 14-entry palette index is visible by eye;
 *   4. checks the specific structural question: does any single byte partition
 *      the corpus into a handful of classes the way a colour index would?
 *
 * Read-only. No device. Run: npx tsx scripts/_research/circuit-project-colour-probe.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { NCS_FILE_SIZE, META_OFFSETS, NOTE_STEP_REGION, DRUM_STEP_REGION, DRUM_BLOCK_START }
  from '../../packages/circuit-tracks/src/ncs/format.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const BACKUP = join(ROOT, 'samples/circuit-ncs/card-backup-2026-07-27T16-49Z');
const BLANK = join(ROOT, 'samples/circuit-tracks/blank_slot20.ncs');
const HEADER_END = 0x2e4;

interface Proj { file: string; pack: number; slot: number; name: string; buf: Uint8Array }

const nameOf = (buf: Uint8Array): string =>
  Array.from(buf.slice(0x10, 0x20)).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '')).join('').trimEnd();

function load(): Proj[] {
  const out: Proj[] = [];
  for (let p = 1; p <= 5; p++) {
    const dir = join(BACKUP, `pack${p}`);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ncs')).sort()) {
      const buf = new Uint8Array(readFileSync(join(dir, f)));
      if (buf.length !== NCS_FILE_SIZE) continue;
      out.push({ file: f, pack: p, slot: Number(/proj(\d+)__/.exec(f)?.[1] ?? 0), name: nameOf(buf), buf });
    }
  }
  return out;
}

function stepMask(): Uint8Array {
  const mask = new Uint8Array(NCS_FILE_SIZE);
  META_OFFSETS.forEach((meta, i) => {
    const region = i >= DRUM_BLOCK_START && i < DRUM_BLOCK_START + 32 ? DRUM_STEP_REGION : NOTE_STEP_REGION;
    for (let o = meta - region; o < meta; o++) mask[o] = 1;
  });
  return mask;
}

function main(): void {
  const all = load();
  const blank = existsSync(BLANK) ? new Uint8Array(readFileSync(BLANK)) : undefined;
  console.log(`corpus: ${all.length} projects\n`);

  // ---- 1. consensus + outlier ranking -------------------------------------
  const consensus = new Uint8Array(NCS_FILE_SIZE);
  for (let off = 0; off < NCS_FILE_SIZE; off++) {
    const tally = new Map<number, number>();
    for (const p of all) tally.set(p.buf[off], (tally.get(p.buf[off]) ?? 0) + 1);
    consensus[off] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  const dist = all.map((p) => {
    let d = 0;
    for (let off = 0; off < NCS_FILE_SIZE; off++) if (p.buf[off] !== consensus[off]) d++;
    return { p, d };
  }).sort((a, b) => b.d - a.d);
  console.log('=== distance to corpus consensus (top 6 + bottom 3) ===');
  for (const { p, d } of [...dist.slice(0, 6), ...dist.slice(-3)]) {
    console.log(`  ${d.toString().padStart(7)}  pack${p.pack} proj${p.slot} "${p.name}"  ${p.file}`);
  }

  // Anything more than 3x the median distance is treated as structurally other.
  const median = dist[Math.floor(dist.length / 2)].d;
  const outliers = dist.filter((x) => x.d > 3 * median).map((x) => x.p);
  const core = all.filter((p) => !outliers.includes(p));
  console.log(`\nmedian distance ${median}; ${outliers.length} outlier(s) excluded -> core corpus ${core.length}\n`);

  // ---- 2. varying offsets over the CORE corpus, config region only ---------
  const mask = stepMask();
  const varying: { off: number; vals: Map<number, number> }[] = [];
  for (let off = 0; off < NCS_FILE_SIZE; off++) {
    if (mask[off]) continue;
    const vals = new Map<number, number>();
    for (const p of core) vals.set(p.buf[off], (vals.get(p.buf[off]) ?? 0) + 1);
    if (vals.size > 1) varying.push({ off, vals });
  }
  console.log(`core-corpus config-region offsets that vary: ${varying.length}`);
  const varyingSetEarly = new Set(varying.map((v) => v.off));

  const fmt = (m: Map<number, number>): string =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([v, c]) => `${v}×${c}`).join(' ')
    + (m.size > 10 ? ` …(${m.size} distinct)` : ` (${m.size})`);

  // ---- 3. header matrix ---------------------------------------------------
  console.log(`\n=== HEADER 0x000..0x${(HEADER_END - 1).toString(16)}: every varying offset ===`);
  const hdr = varying.filter((v) => v.off < HEADER_END);
  for (const v of hdr) {
    console.log(`  0x${v.off.toString(16).padStart(3, '0')}  blank=${blank ? blank[v.off] : '-'}  ${fmt(v.vals)}`);
  }
  console.log(`  (${hdr.length} varying header offsets)`);

  // ---- 4. palette-shaped candidates over the whole config region ----------
  //  A 14-colour index is: >1 distinct value, all values < 16, and (crucially)
  //  CONSTANT WITHIN a project rather than per-pattern. Rank by how few distinct
  //  values it takes: a real palette index over 97 projects that were never
  //  recoloured should show 1-3 values, not 40.
  console.log('\n=== EVERY varying config byte OUTSIDE the header (the whole remaining search space) ===');
  for (const c of varying.filter((v) => v.off >= HEADER_END)) {
    console.log(`  0x${c.off.toString(16).padStart(5, '0')}  blank=${blank ? blank[c.off] : '-'}  ${fmt(c.vals)}`);
  }

  // ---- 4b. SECOND, INDEPENDENT CORPUS --------------------------------------
  // Projects extracted from a Novation Components pack-READ capture (Novation's
  // own factory demo pack, a different device and firmware). Pass the directory
  // produced by `circuit-extract-capture-projects.py` as argv[2]. Files carry
  // 12 bytes of trailing block padding; truncate to NCS_FILE_SIZE.
  const capDir = process.argv[2];
  if (capDir && existsSync(capDir)) {
    const cap = readdirSync(capDir).filter((f) => f.endsWith('.ncs')).map((f) => {
      const raw = new Uint8Array(readFileSync(join(capDir, f)));
      return { f, buf: raw.subarray(0, NCS_FILE_SIZE), ok: raw.length >= NCS_FILE_SIZE && raw.length <= NCS_FILE_SIZE + 16 };
    }).filter((x) => x.ok);
    console.log(`\n=== SECOND CORPUS: ${cap.length} factory-pack projects from the Components read capture ===`);
    for (const c of cap) console.log(`  ${c.f}  name="${nameOf(c.buf)}"`);

    // (a) does the factory corpus vary anywhere the card corpus does not?
    const capVarying: number[] = [];
    for (let off = 0; off < NCS_FILE_SIZE; off++) {
      if (mask[off]) continue;
      const s = new Set(cap.map((c) => c.buf[off]));
      if (s.size > 1) capVarying.push(off);
    }
    const newOffsets = capVarying.filter((o) => !varyingSetEarly.has(o));
    console.log(`\n  factory-corpus varying config offsets: ${capVarying.length}; NOT already varying on the card: ${newOffsets.length}`);
    // Bucket them, so "58 new offsets in the scene block" does not read as 58
    // independent colour candidates.
    const region = (o: number): string =>
      o < 0x40 ? 'A pre-scene header 0x000-0x03f'
      : o < 0x2c4 ? 'B scene block 0x040-0x2c3'
      : o < 0x2e4 ? 'C chain table 0x2c4-0x2e3'
      : o < 0x26d00 ? 'D per-block metadata'
      : 'E tail config 0x26d00+';
    const buckets = new Map<string, number[]>();
    for (const o of newOffsets) buckets.set(region(o), [...(buckets.get(region(o)) ?? []), o]);
    for (const k of [...buckets.keys()].sort()) {
      const offs = buckets.get(k)!;
      console.log(`    ${k}: ${offs.length} offset(s)`);
      // Only the non-scene regions are colour-relevant; print those in full.
      if (!k.startsWith('B') && !k.startsWith('D')) {
        for (const o of offs) {
          console.log(`      0x${o.toString(16).padStart(5, '0')}  card=${consensus[o]}  factory=[${cap.map((c) => c.buf[o]).join(',')}]`);
        }
      }
    }

    // (b) where does the factory CONSENSUS differ from the card consensus, in
    // the header? A per-project display attribute defaulted differently by two
    // independent origins would show up here.
    console.log('\n  header offsets where factory consensus != card consensus:');
    let n = 0;
    for (let off = 0; off < HEADER_END; off++) {
      const vals = cap.map((c) => c.buf[off]);
      const uniq = [...new Set(vals)];
      if (uniq.length === 1 && uniq[0] !== consensus[off]) {
        console.log(`    0x${off.toString(16).padStart(3, '0')}  card=${consensus[off]}  factory=${uniq[0]}`);
        n++;
      }
    }
    console.log(`    (${n} such offsets)`);
  }

  // ---- 5. the null-result guard -------------------------------------------
  // A colour the owner never set is CONSTANT across the corpus and therefore
  // invisible above. So also report every config byte that is CONSTANT across
  // all 97 and small-valued: those are the offsets a colour COULD be hiding in
  // at its default. Report only how many, plus the ones adjacent to known
  // project-scope fields (name/tempo/swing), which is where a per-project
  // display attribute would plausibly sit.
  // Every corpus project carries the DEFAULT colour (the owner has never
  // recoloured one), so a real colour field is CONSTANT here and invisible to
  // the differential above. The shortlist is therefore: project-scope header
  // bytes that are constant across BOTH origins, small-valued (a 14-entry
  // palette index fits 0..15), and not already claimed by a decoded field.
  console.log('\n=== SHORTLIST: where a default-valued 14-colour palette index could hide ===');
  const claimed = new Map<number, string>();
  for (let o = 0x00; o <= 0x03; o++) claimed.set(o, 'magic "USER"');
  for (let o = 0x10; o <= 0x2f; o++) claimed.set(o, 'project name (32B)');
  claimed.set(0x34, 'tempo'); claimed.set(0x35, 'swing');
  claimed.set(0x0c, 'format/version (10 factory vs 11 card)');

  const capDir2 = process.argv[2];
  const cap2 = capDir2 && existsSync(capDir2)
    ? readdirSync(capDir2).filter((f) => f.endsWith('.ncs'))
        .map((f) => new Uint8Array(readFileSync(join(capDir2, f))))
        .filter((b) => b.length >= NCS_FILE_SIZE && b.length <= NCS_FILE_SIZE + 16)
        .map((b) => b.subarray(0, NCS_FILE_SIZE))
    : [];

  for (let off = 0; off < 0x40; off++) {
    const cardVals = new Set(core.map((p) => p.buf[off]));
    const capVals = new Set(cap2.map((b) => b[off]));
    const allSame = cardVals.size === 1 && capVals.size <= 1
      && (capVals.size === 0 || [...capVals][0] === [...cardVals][0]);
    const v = core[0].buf[off];
    const tag = claimed.get(off);
    const verdict = tag ? `claimed: ${tag}`
      : !allSame ? 'varies -> not a never-set colour'
      : v > 15 ? 'value > 15 -> not a 14-entry palette index'
      : '*** CANDIDATE ***';
    console.log(`  0x${off.toString(16).padStart(2, '0')} = ${v.toString().padStart(3)}  card{${[...cardVals].slice(0, 4).join(',')}} factory{${[...capVals].slice(0, 4).join(',')}}  ${verdict}`);
  }
}

main();
