/**
 * drum-levels-audit.ts — OFFLINE audit of stored DRUM mixer levels and
 * drum→sample bindings for every project captured on packs 2, 4 and 5.
 *
 * WHY: the maintainer's 2026-07-30 correction extends the universal
 * stored-silent rule to DRUM levels, not just synths. The condensed internal
 * drum layer must store 0 on all four tracks and be raised by hand; anything
 * nonzero doubles the SPD-SX. This audit finds every project that violates it.
 *
 * It walks EVERY .ncs under samples/circuit-ncs, resolves (pack, slot) from
 * the sidecar index.jsonl / the backup_device filename / the card-backup tree,
 * keeps the NEWEST capture per (pack, slot), and prints drum levels
 * (0x26fbd + n*11), synth levels, and the drum→sample binding (0x1a278..b).
 *
 * READ-ONLY. Writes nothing, touches no device.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

import {
  getDrumLevel,
  getSynthLevel,
  getProjectName,
  NCS_FILE_SIZE,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { getDrumSampleBinding } from '../../packages/circuit-tracks/src/ncs/drumBinding.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';

/** Active drum steps per track, summed over all 8 patterns. Zero = the track is silent whatever its level. */
function drumStepCounts(u8: Uint8Array): number[] {
  return [0, 1, 2, 3].map(t => {
    let n = 0;
    for (let p = 0; p < 8; p++) n += decodeDrumPattern(u8, t, p).filter(s => s.active).length;
    return n;
  });
}

const ROOT = 'samples/circuit-ncs';
const PACKS_OF_INTEREST = new Set([2, 4, 5]);

interface Cap {
  path: string;
  pack: number;
  slot: number;
  when: number;      // ms epoch
  source: string;    // provenance label
}

/** Recursively collect every .ncs file under a directory. */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ncs')) out.push(p);
  }
  return out;
}

/** Sidecar index.jsonl gives authoritative pack/slot/created_at. */
const indexCache = new Map<string, Map<string, { pack: number; slot: number; when: number }>>();
function indexFor(dir: string) {
  if (!indexCache.has(dir)) {
    const m = new Map<string, { pack: number; slot: number; when: number }>();
    const p = join(dir, 'index.jsonl');
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (typeof r.pack === 'number' && typeof r.location === 'number') {
            m.set(r.file_name, {
              pack: r.pack,
              slot: r.location,
              when: Date.parse(r.created_at ?? '') || 0,
            });
          }
        } catch { /* ignore malformed line */ }
      }
    }
    indexCache.set(dir, m);
  }
  return indexCache.get(dir)!;
}

/** backup_device filename: Novation_Circuit_Tracks-pack5-project19-Name-2026-07-30_19-18-02.ncs */
const FN_RE = /-pack(\d+)-project(\d+)-.*?-(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.ncs$/;
/** card-backup tree: <root>/card-backup-DATE/packN/projNN__MM_Name.ncs */
const CARD_RE = /[\\/]pack(\d+)[\\/]proj(\d+)__/;

function classify(p: string): Cap | undefined {
  const dir = dirname(p);
  const name = basename(p);

  const idx = indexFor(dir).get(name);
  if (idx) return { path: p, pack: idx.pack, slot: idx.slot, when: idx.when, source: 'index.jsonl' };

  const m = FN_RE.exec(name);
  if (m) {
    const when = Date.parse(`${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) || statSync(p).mtimeMs;
    return { path: p, pack: Number(m[1]), slot: Number(m[2]), when, source: 'filename' };
  }

  const c = CARD_RE.exec(p);
  if (c) {
    // card-backup manifest captured_at; fall back to mtime.
    const mf = join(p.split(/[\\/]pack\d+[\\/]/)[0], 'manifest.json');
    let when = statSync(p).mtimeMs;
    if (existsSync(mf)) {
      try { when = Date.parse(JSON.parse(readFileSync(mf, 'utf8')).captured_at) || when; } catch { /* */ }
    }
    return { path: p, pack: Number(c[1]), slot: Number(c[2]), when, source: 'card-backup' };
  }
  return undefined; // staged/ad-hoc files with no resolvable pack+slot
}

const all = walk(ROOT);
const newest = new Map<string, Cap>();
let unresolved = 0;

for (const p of all) {
  const c = classify(p);
  if (!c) { unresolved++; continue; }
  if (!PACKS_OF_INTEREST.has(c.pack)) continue;
  const key = `${c.pack}/${c.slot}`;
  const prev = newest.get(key);
  if (!prev || c.when > prev.when) newest.set(key, c);
}

console.log(`Scanned ${all.length} .ncs files; ${unresolved} had no resolvable pack+slot (staged/ad-hoc).`);
console.log(`Newest canonical per slot on packs 2/4/5: ${newest.size} slots.\n`);

interface Row {
  pack: number; slot: number; name: string;
  drums: number[]; synths: number[]; binding: number[]; steps: number[];
  when: string; src: string; file: string;
}
const rows: Row[] = [];

for (const c of [...newest.values()].sort((a, b) => a.pack - b.pack || a.slot - b.slot)) {
  const buf = readFileSync(c.path);
  if (buf.length !== NCS_FILE_SIZE) {
    console.log(`SKIP (bad size ${buf.length}): ${c.path}`);
    continue;
  }
  const u8 = new Uint8Array(buf);
  rows.push({
    pack: c.pack,
    slot: c.slot,
    name: getProjectName(u8),
    drums: [0, 1, 2, 3].map(t => getDrumLevel(u8, t)),
    synths: [getSynthLevel(u8, 1), getSynthLevel(u8, 2)],
    binding: getDrumSampleBinding(u8),
    steps: drumStepCounts(u8),
    when: new Date(c.when).toISOString().replace('.000Z', 'Z'),
    src: c.source,
    file: c.path,
  });
}

const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
console.log(pad('pk/slot', 8), pad('name', 24), pad('drum1-4', 20), pad('syn1/2', 9), pad('binding', 16), pad('steps1-4', 18), 'newest capture');
console.log('-'.repeat(120));
for (const r of rows) {
  const hot = r.drums.some(d => d !== 0);
  console.log(
    pad(`${r.pack}/${String(r.slot).padStart(2, '0')}`, 8),
    pad(r.name, 24),
    pad(r.drums.join('/'), 20),
    pad(r.synths.join('/'), 9),
    pad('[' + r.binding.join(',') + ']', 16),
    pad(r.steps.join('/'), 18),
    r.when,
    hot ? '  <== NONZERO DRUM' : '',
  );
}

const hot = rows.filter(r => r.drums.some(d => d !== 0));
console.log(`\n=== IN SCOPE (nonzero drum level): ${hot.length} projects ===`);
for (const r of hot) console.log(`  pack${r.pack} slot${r.slot} "${r.name}" drums=${r.drums.join('/')} steps=${r.steps.join('/')} binding=[${r.binding.join(',')}]\n      ${r.file}`);

const bound0123 = rows.filter(r => r.binding.join(',') === '0,1,2,3');
console.log(`\n=== BINDING [0,1,2,3] (default/unset): ${bound0123.length} projects ===`);
for (const r of bound0123) console.log(`  pack${r.pack} slot${r.slot} "${r.name}" drums=${r.drums.join('/')}`);

console.log('\n=== JSON ===');
console.log(JSON.stringify(rows.map(r => ({ pack: r.pack, slot: r.slot, name: r.name, drums: r.drums, synths: r.synths, binding: r.binding, steps: r.steps, when: r.when, file: r.file })), null, 0));
