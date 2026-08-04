/**
 * Circuit Tracks `.ncs` — hunt for a stored PROJECT COLOUR byte.
 *
 * The user guide (v3, p.96 "Changing Project Colours") documents 14 assignable
 * pad colours per project, chosen on the DEVICE during the Save procedure
 * (Macro 1 knob), and shown in Projects View. Question this script answers:
 * is that colour carried in the `.ncs` project file at all, and if so, where?
 *
 * METHOD (differential over a corpus, no hardware):
 *   - load every project of the CRC-verified card backup (98 files, 5 packs)
 *     plus the known-blank template,
 *   - per byte offset, collect the distinct values across the corpus,
 *   - drop the offsets inside the decoded step regions (they are pattern data
 *     and vary by construction), leaving the small per-project config payload,
 *   - flag any surviving offset whose value set looks like a 14-entry palette
 *     index (small ints, <= 13 or <= 15, more than one distinct value).
 *
 * Read-only. Touches no device. Run: npx tsx scripts/_research/circuit-project-colour-diff.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  NCS_FILE_SIZE,
  META_OFFSETS,
  NOTE_STEP_REGION,
  DRUM_STEP_REGION,
  DRUM_BLOCK_START,
} from '../../packages/circuit-tracks/src/ncs/format.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const BACKUP = join(ROOT, 'samples/circuit-ncs/card-backup-2026-07-27T16-49Z');
const BLANK = join(ROOT, 'samples/circuit-tracks/blank_slot20.ncs');

interface Proj { label: string; pack: number; slot: number; name: string; buf: Uint8Array }

function projectName(buf: Uint8Array): string {
  const bytes = Array.from(buf.slice(0x10, 0x20));
  return bytes.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '')).join('').trimEnd();
}

function load(): Proj[] {
  const out: Proj[] = [];
  for (let p = 1; p <= 5; p++) {
    const dir = join(BACKUP, `pack${p}`);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ncs')).sort()) {
      const buf = new Uint8Array(readFileSync(join(dir, f)));
      if (buf.length !== NCS_FILE_SIZE) { console.warn(`skip ${f}: ${buf.length} bytes`); continue; }
      const slot = Number(/proj(\d+)__/.exec(f)?.[1] ?? 0);
      out.push({ label: `p${p}/${f}`, pack: p, slot, name: projectName(buf), buf });
    }
  }
  return out;
}

/** Byte offsets that are decoded pattern-step data (expected to vary; not config). */
function stepMask(): Uint8Array {
  const mask = new Uint8Array(NCS_FILE_SIZE);
  META_OFFSETS.forEach((meta, i) => {
    const isDrum = i >= DRUM_BLOCK_START && i < DRUM_BLOCK_START + 32;
    const region = isDrum ? DRUM_STEP_REGION : NOTE_STEP_REGION;
    for (let o = meta - region; o < meta; o++) mask[o] = 1;
  });
  return mask;
}

function main(): void {
  const projects = load();
  const blank = existsSync(BLANK) ? new Uint8Array(readFileSync(BLANK)) : undefined;
  console.log(`loaded ${projects.length} projects${blank ? ' + blank template' : ''}\n`);

  const mask = stepMask();
  const maskedBytes = mask.reduce((a: number, b) => a + b, 0);
  console.log(`step-data mask covers ${maskedBytes} bytes (${(100 * maskedBytes / NCS_FILE_SIZE).toFixed(1)}%)`);

  // Per-offset distinct value sets, config region only.
  const varying: { off: number; vals: Map<number, number> }[] = [];
  for (let off = 0; off < NCS_FILE_SIZE; off++) {
    if (mask[off]) continue;
    const vals = new Map<number, number>();
    for (const p of projects) vals.set(p.buf[off], (vals.get(p.buf[off]) ?? 0) + 1);
    if (vals.size > 1) varying.push({ off, vals });
  }
  console.log(`config-region offsets that vary across the corpus: ${varying.length}\n`);

  // Contiguous runs, so the report reads as regions rather than a byte list.
  const runs: { start: number; end: number; offs: typeof varying }[] = [];
  for (const v of varying) {
    const last = runs[runs.length - 1];
    if (last && v.off === last.end + 1) { last.end = v.off; last.offs.push(v); }
    else runs.push({ start: v.off, end: v.off, offs: [v] });
  }
  console.log(`grouped into ${runs.length} runs\n`);

  const fmtVals = (m: Map<number, number>): string => {
    const e = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const head = e.slice(0, 8).map(([v, c]) => `${v}x${c}`).join(' ');
    return e.length > 8 ? `${head} …(${e.length} distinct)` : `${head} (${e.length} distinct)`;
  };

  console.log('=== ALL VARYING RUNS IN THE CONFIG REGION ===');
  for (const r of runs) {
    const len = r.end - r.start + 1;
    const blankNote = blank ? ` blank=${blank[r.start]}` : '';
    console.log(`0x${r.start.toString(16).padStart(5, '0')}..0x${r.end.toString(16).padStart(5, '0')} (${len}B)${blankNote}  first: ${fmtVals(r.offs[0].vals)}`);
  }

  // PALETTE SIGNATURE: 14 documented colours -> expect a byte whose whole corpus
  // value set is small ints. Report every candidate with its max value.
  console.log('\n=== PALETTE-SHAPED CANDIDATES (all values <= 15, >1 distinct) ===');
  const cands = varying.filter((v) => [...v.vals.keys()].every((k) => k <= 15));
  for (const c of cands) {
    console.log(`0x${c.off.toString(16).padStart(5, '0')}  max=${Math.max(...c.vals.keys())}  ${fmtVals(c.vals)}${blank ? `  blank=${blank[c.off]}` : ''}`);
  }
  console.log(`(${cands.length} candidates)`);

  // Also: offsets where the blank template disagrees with the majority of real
  // projects, restricted to the file header (0x000..0x2e3), which is where the
  // decoded per-project config (name/tempo/swing/scenes/chain) already lives.
  if (blank) {
    console.log('\n=== HEADER 0x000..0x2e3: varying offsets, full value map ===');
    for (const v of varying.filter((x) => x.off < 0x2e4)) {
      console.log(`0x${v.off.toString(16).padStart(3, '0')}  blank=${blank[v.off]}  ${fmtVals(v.vals)}`);
    }
  }
}

main();
