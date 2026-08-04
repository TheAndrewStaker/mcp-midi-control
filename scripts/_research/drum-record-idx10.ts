/**
 * drum-record-idx10.ts — READ-ONLY. Identify the ONE unexplained byte in each
 * 11-byte drum-track record (index 10, i.e. the byte before the next record's
 * level), to rule it in or out as a MUTE/ENABLE flag.
 *
 * Bytes 0..7 of the record are accounted for by documented drum params with
 * matching defaults (level 100, pitch 64, decay 127, distortion 0, EQ 64, pan 64,
 * reverb send 0, delay send 0). Index 10 varies across the corpus and is the only
 * candidate left. This prints it per project alongside identity so the pattern is
 * visible.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

import { getProjectName, getDrumLevel, NCS_FILE_SIZE } from '../../packages/circuit-tracks/src/ncs/format.js';
import { getDrumSampleBinding } from '../../packages/circuit-tracks/src/ncs/drumBinding.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';

const ROOT = 'samples/circuit-ncs';
const PACKS = new Set([2, 4, 5]);
const DRUM_LEVEL_BASE = 0x26fbd;
const STRIDE = 11;

interface Cap { path: string; pack: number; slot: number; when: number }

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.ncs')) out.push(p);
  }
  return out;
}
const idxCache = new Map<string, Map<string, { pack: number; slot: number; when: number }>>();
function indexFor(dir: string) {
  if (!idxCache.has(dir)) {
    const m = new Map<string, { pack: number; slot: number; when: number }>();
    const p = join(dir, 'index.jsonl');
    if (existsSync(p)) for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (typeof r.pack === 'number' && typeof r.location === 'number')
          m.set(r.file_name, { pack: r.pack, slot: r.location, when: Date.parse(r.created_at ?? '') || 0 });
      } catch { /* */ }
    }
    idxCache.set(dir, m);
  }
  return idxCache.get(dir)!;
}
const FN_RE = /-pack(\d+)-project(\d+)-.*?-(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.ncs$/;
const CARD_RE = /[\\/]pack(\d+)[\\/]proj(\d+)__/;
function classify(p: string): Cap | undefined {
  const idx = indexFor(dirname(p)).get(basename(p));
  if (idx) return { path: p, ...idx };
  const m = FN_RE.exec(basename(p));
  if (m) return { path: p, pack: +m[1], slot: +m[2], when: Date.parse(`${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) || statSync(p).mtimeMs };
  const c = CARD_RE.exec(p);
  if (c) {
    const mf = join(p.split(/[\\/]pack\d+[\\/]/)[0], 'manifest.json');
    let when = statSync(p).mtimeMs;
    if (existsSync(mf)) { try { when = Date.parse(JSON.parse(readFileSync(mf, 'utf8')).captured_at) || when; } catch { /* */ } }
    return { path: p, pack: +c[1], slot: +c[2], when };
  }
  return undefined;
}

const newest = new Map<string, Cap>();
for (const p of walk(ROOT)) {
  const c = classify(p);
  if (!c || !PACKS.has(c.pack)) continue;
  const k = `${c.pack}/${c.slot}`;
  const prev = newest.get(k);
  if (!prev || c.when > prev.when) newest.set(k, c);
}

const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
console.log(pad('pk/slot', 8), pad('name', 26), pad('idx10 d1/d2/d3/d4', 20), pad('levels', 16), pad('binding', 14), 'steps');
console.log('-'.repeat(110));

const rows: { key: string; name: string; idx10: number[]; steps: number[] }[] = [];
for (const c of [...newest.values()].sort((a, b) => a.pack - b.pack || a.slot - b.slot)) {
  const buf = readFileSync(c.path);
  if (buf.length !== NCS_FILE_SIZE) continue;
  const u8 = new Uint8Array(buf);
  const idx10 = [0, 1, 2, 3].map(t => u8[DRUM_LEVEL_BASE + t * STRIDE + 10]);
  const levels = [0, 1, 2, 3].map(t => getDrumLevel(u8, t));
  const steps = [0, 1, 2, 3].map(t => {
    let n = 0; for (let p = 0; p < 8; p++) n += decodeDrumPattern(u8, t, p).filter(s => s.active).length; return n;
  });
  const key = `${c.pack}/${String(c.slot).padStart(2, '0')}`;
  const name = getProjectName(u8);
  rows.push({ key, name, idx10, steps });
  console.log(
    pad(key, 8), pad(name, 26), pad(idx10.join('/'), 20),
    pad(levels.join('/'), 16), pad('[' + getDrumSampleBinding(u8).join(',') + ']', 14), steps.join('/'),
  );
}

// Correlation test: does idx10 track drum CONTENT (a mute would plausibly follow
// "has this track got anything on it"), or is it independent?
console.log('\n=== CORRELATION: idx10 value vs whether that track has steps ===');
for (let t = 0; t < 4; t++) {
  const buckets = new Map<string, number>();
  for (const r of rows) {
    const k = `idx10=${r.idx10[t]} steps${r.steps[t] > 0 ? '>0' : '=0'}`;
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  console.log(`drum${t + 1}:`, [...buckets.entries()].sort().map(([k, v]) => `${k}:${v}`).join('  '));
}
