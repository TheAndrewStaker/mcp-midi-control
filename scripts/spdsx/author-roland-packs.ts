/**
 * SPD-SX Roland-pack importer / kit author — the "one command when you plug in".
 *
 * Reads the generated pack manifest (per-kit pad maps: short wave names, per-pad
 * LOOP flags + Roland volumes) and, given a mounted SPD-SX, imports every wave
 * ONCE into the shared pool and authors Pack 1 (curated favourites) + Pack 2
 * (full Roland demo library) as faithful 9-pad kits (loops loop, levels kept).
 *
 * Runs in three escalating modes:
 *   1. OFFLINE (no --root):  validates the whole plan with NO device — every
 *      source WAV present + 44.1k/16, every kit XML builds + validates, prints
 *      the slot plan. Safe to run right now.
 *   2. PLAN (--root <mounted>):  + reads the live pool & target-slot occupancy,
 *      reports what WOULD import (new vs already-present) and which slots are free.
 *   3. WRITE (--root <mounted> --write [--force]):  imports the new waves
 *      (append-only) and authors the kits. Power-cycle the SPD-SX after.
 *
 * Usage:
 *   npx tsx scripts/spdsx/author-roland-packs.ts
 *   npx tsx scripts/spdsx/author-roland-packs.ts --root "D:\Roland\SPD-SX"
 *   npx tsx scripts/spdsx/author-roland-packs.ts --root "D:\Roland\SPD-SX" --write
 *
 * Options: --manifest <path> (default docs/_private/SPDSX-ROLAND-MANIFEST.json),
 *   --library <path> (default = manifest.generated_from), --pack1-start N (3),
 *   --pack2-start N (13), --pack1 LF,MA (which packs are in Pack 1), --force
 *   (overwrite occupied kit slots; the prior kit is backed up to .spd.bak).
 *
 * The manifest is produced by the plan generator; regenerate it if the library
 * changes. Wave/kit codec: packages/spd-sx (loop pads use the 2026-07-06 loop
 * flag). Slots are PROVISIONAL — confirm the ranges against the printed occupancy
 * before --write so nothing (StokenII, the Yurt/Rich kits) is clobbered.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFullKit, type FullPad } from '@mcp-midi-control/spd-sx/codec/kitXml.js';
import { validateKit } from '@mcp-midi-control/spd-sx/codec/verifyKit.js';
import { addWaves } from '@mcp-midi-control/spd-sx/storage/waveStore.js';
import { authorKit } from '@mcp-midi-control/spd-sx/storage/authorKit.js';
import { readWaves, readKit, looksMounted } from '@mcp-midi-control/spd-sx/storage/inventory.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const optVal = (name: string, def?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name: string): boolean => argv.includes(`--${name}`);

const manifestPath = resolve(optVal('manifest', join(REPO, 'docs', '_private', 'SPDSX-ROLAND-MANIFEST.json'))!);
const root = optVal('root');
const doWrite = flag('write');
const force = flag('force');
const pack1Start = Number.parseInt(optVal('pack1-start', '3')!, 10);
const pack2Start = Number.parseInt(optVal('pack2-start', '13')!, 10);
const pack1Packs = optVal('pack1', 'LF,MA')!.split(',').map((s) => s.trim());

// ── load manifest ─────────────────────────────────────────────────────────────
if (!existsSync(manifestPath)) {
  console.error(`Manifest not found: ${manifestPath}\nRun the plan generator first (it writes SPDSX-ROLAND-MANIFEST.json).`);
  process.exit(1);
}
interface MPad { pad: number; wave: string; level: number; loop: boolean }
interface MKit { packDir: string; pfx: string; label: string; kit: number; kitName: string; tempo: number; pads: MPad[] }
interface MWave { name: string; pack: string; kit: number; pad: number; file: string; volume: number; template: string }
interface Manifest { generated_from: string; totals: { kits: number; waves: number }; kits: MKit[]; waves: MWave[] }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;
const library = resolve(optVal('library', manifest.generated_from)!);

// pfx -> packDir (from the kit rows) and a friendly <=8-char kit-name maker.
const packDirByPfx = new Map<string, string>();
for (const k of manifest.kits) packDirByPfx.set(k.pfx, k.packDir);
const FRIENDLY: Record<string, string> = { LF: 'LoFi', CS: 'CitySl', '8R': '80sRk', MA: 'Melamb' };
const kitDisplayName = (pfx: string, kit: number): string => `${FRIENDLY[pfx] ?? pfx} ${kit}`.slice(0, 8);

// source WAV path for a manifest wave
const waveSrc = (w: MWave): string =>
  join(library, packDirByPfx.get(w.pack)!, 'SPD-SX', 'KitData', `Kit${w.kit}`, w.file);

// ── the authoring set (which kit → which slot) ────────────────────────────────
interface KitPlan { pfx: string; kit: number; slot: number; pack: 1 | 2; name: string; mkit: MKit }
const byPfxKit = new Map<string, MKit>();
for (const k of manifest.kits) byPfxKit.set(`${k.pfx}${k.kit}`, k);

const plan: KitPlan[] = [];
// Pack 2 = all 20 Roland kits, in manifest order.
manifest.kits.forEach((k, i) => {
  plan.push({ pfx: k.pfx, kit: k.kit, slot: pack2Start + i, pack: 2, name: kitDisplayName(k.pfx, k.kit), mkit: k });
});
// Pack 1 = the curated favourites (default LF + MA), authored into their own block.
let p1 = pack1Start;
for (const pfx of pack1Packs) {
  for (const k of manifest.kits.filter((x) => x.pfx === pfx)) {
    plan.push({ pfx, kit: k.kit, slot: p1++, pack: 1, name: kitDisplayName(pfx, k.kit), mkit: k });
  }
}

// pads for a kit -> FullPad[] with wave as a NAME placeholder (resolved to an
// index at author time); note 60+i, Roland volume as level, LOOP flag preserved.
const kitPadsByName = (k: MKit): { wave: string; level: number; loop: boolean; note: number }[] =>
  k.pads.map((p, i) => ({ wave: p.wave, level: p.level, loop: p.loop, note: 60 + i }));

let problems = 0;
const warn = (m: string) => { console.log(`  ! ${m}`); problems++; };

// ── PHASE A: offline validation (always) ──────────────────────────────────────
console.log(`\n=== SPD-SX Roland-pack plan ===`);
console.log(`manifest: ${manifestPath}`);
console.log(`library : ${library}`);
console.log(`totals  : ${manifest.totals.kits} kits, ${manifest.totals.waves} waves`);

// Read rate/bits by WALKING the RIFF chunks to find 'fmt ' (some one-shot WAVs
// carry a JUNK/bext chunk before fmt, so a fixed offset misreads them).
function wavFmt(buf: Buffer): { rate: number; bits: number; ch: number } | undefined {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ' && o + 8 + 16 <= buf.length) {
      return { ch: buf.readUInt16LE(o + 10), rate: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) };
    }
    o += 8 + size + (size & 1); // chunks are word-aligned
  }
  return undefined;
}
console.log(`\n[A] source WAVs (existence + 44.1k/16 header):`);
let missing = 0, badFmt = 0;
for (const w of manifest.waves) {
  const p = waveSrc(w);
  if (!existsSync(p)) { missing++; if (missing <= 5) warn(`missing: ${p}`); continue; }
  const fmt = wavFmt(readFileSync(p).subarray(0, 4096) as Buffer);
  if (!fmt || fmt.rate !== 44100 || fmt.bits !== 16) { badFmt++; if (badFmt <= 5) warn(`not 44.1k/16 (${fmt ? `${fmt.rate}/${fmt.bits}` : 'unparsed'}): ${w.name}`); }
}
console.log(`  ${manifest.waves.length - missing - badFmt}/${manifest.waves.length} OK` +
  (missing ? `, ${missing} missing` : '') + (badFmt ? `, ${badFmt} wrong format` : ''));

console.log(`\n[B] kit XML build + validate (loop flags / levels / notes):`);
let kitFails = 0, loopPads = 0;
for (const kp of plan) {
  const pads: FullPad[] = kitPadsByName(kp.mkit).map((p, i) => ({ wv: i, level: p.level, loop: p.loop, note: p.note }));
  loopPads += pads.filter((p) => p.loop).length;
  const v = validateKit(buildFullKit(kp.name, pads));
  if (!v.ok) { kitFails++; warn(`kit '${kp.name}' (slot ${kp.slot}) INVALID: ${v.errors.join('; ')}`); }
}
console.log(`  ${plan.length - kitFails}/${plan.length} kits build+validate; ${loopPads} loop pads across the set`);

// ── slot plan table ───────────────────────────────────────────────────────────
console.log(`\n[C] slot plan (PROVISIONAL — confirm against occupancy before --write):`);
const p2 = plan.filter((k) => k.pack === 2), p1s = plan.filter((k) => k.pack === 1);
console.log(`  Pack 1 "Live favourites"  kits ${p1s[0]?.slot}..${p1s[p1s.length - 1]?.slot}: ${p1s.map((k) => `${k.slot}=${k.name}`).join('  ')}`);
console.log(`  Pack 2 "Roland demo"      kits ${p2[0].slot}..${p2[p2.length - 1].slot}: ${p2.map((k) => `${k.slot}=${k.name}`).join('  ')}`);
console.log(`  (Pack 1's 2 Sleep Token kits are existing — NOT authored here; place them at ${Math.max(1, pack1Start - 2)}..${pack1Start - 1}.)`);

// ── PHASE D: device plan / write (only with --root) ───────────────────────────
if (!root) {
  console.log(`\nOffline dry-run only (no --root). Plug in the SPD-SX in WAVE MGR mode, then re-run with --root "<drive>\\Roland\\SPD-SX" to plan, and add --write to execute.`);
  console.log(problems ? `\n${problems} issue(s) above — resolve before writing.` : `\nAll offline checks passed. ✅`);
  process.exit(problems ? 1 : 0);
}

const spdRoot = resolve(root);
console.log(`\n[D] device: ${spdRoot}`);
if (!looksMounted(spdRoot)) {
  console.error(`  Not a mounted SPD-SX tree (missing KIT/ or WAVE/PRM/). Put the device in WAVE MGR mode and pass the "...\\Roland\\SPD-SX" path.`);
  process.exit(1);
}

// pool + import plan (skip names already present so re-runs never duplicate)
const pool = readWaves(spdRoot);
const poolByName = new Map(pool.map((w) => [w.name.toLowerCase(), w.index] as const));
const toImport = manifest.waves.filter((w) => !poolByName.has(w.name.slice(0, 12).toLowerCase()));
console.log(`  pool: ${pool.length} waves present; ${toImport.length} to import, ${manifest.waves.length - toImport.length} already present.`);
const projectedTop = (pool.length ? Math.max(...pool.map((w) => w.index)) : -1) + toImport.length;
if (projectedTop >= 500) console.log(`  NOTE: imports land up to index ${projectedTop} (buckets 05+). Only buckets 00-04 are device-confirmed; 05+ has played in testing but is unconfirmed.`);

// target-slot occupancy
console.log(`  target-slot occupancy:`);
let occupied = 0;
for (const kp of plan) {
  const cur = readKit(spdRoot, kp.slot);
  if (cur && cur.assignedPads > 0) { occupied++; console.log(`    slot ${kp.slot} (${kp.name}) OCCUPIED by '${cur.name}' (${cur.assignedPads} pads)${force ? ' — will back up + overwrite' : ''}`); }
}
if (occupied && !force && doWrite) {
  console.error(`\n  ${occupied} target slot(s) are occupied and --force was not passed. Re-run with --force to back up (.spd.bak) + overwrite, or change --pack1-start/--pack2-start to empty slots.`);
  process.exit(1);
}

if (!doWrite) {
  console.log(`\nPLAN mode (no --write). Would import ${toImport.length} waves + author ${plan.length} kits. Add --write to execute.`);
  process.exit(occupied && !force ? 1 : 0);
}

// ── WRITE ─────────────────────────────────────────────────────────────────────
console.log(`\n[WRITE] BACK UP the whole Roland folder first if you have not. Importing + authoring now...`);

// 1) import the new waves (append-only, atomic, dedup-aware)
if (toImport.length) {
  const items = toImport.map((w) => ({ wav: new Uint8Array(readFileSync(waveSrc(w))), name: w.name }));
  const res = addWaves(spdRoot, items);
  res.forEach((r, i) => { poolByName.set(toImport[i].name.slice(0, 12).toLowerCase(), r.index); });
  const conv = res.filter((r) => r.converted).length, dup = res.filter((r) => r.duplicateOf).length;
  console.log(`  imported ${res.length} waves (indices ${res[0].index}..${res[res.length - 1].index})` +
    (conv ? `, ${conv} resampled` : '') + (dup ? `, ${dup} byte-dupes of existing (appended anyway)` : ''));
}

// 2) author each kit, resolving pad wave NAMES -> pool indices
let authored = 0;
for (const kp of plan) {
  const pads: FullPad[] = kitPadsByName(kp.mkit).map((p) => {
    const idx = poolByName.get(p.wave.slice(0, 12).toLowerCase());
    if (idx === undefined) throw new Error(`wave '${p.wave}' not in pool after import (kit ${kp.name})`);
    return { wv: idx, level: p.level, loop: p.loop, note: p.note };
  });
  const r = authorKit(spdRoot, kp.slot, kp.name, pads, { force });
  authored++;
  if (r.backedUp) console.log(`    slot ${kp.slot} '${kp.name}': wrote (prior kit backed up)`);
}
console.log(`  authored ${authored}/${plan.length} kits.`);
console.log(`\n✅ Done. EJECT the drive cleanly and POWER-CYCLE the SPD-SX to load the new waves + kits, then confirm a loop pad loops by ear (HW-SPDSX-009).`);
