/**
 * mixer-region-variance.ts — READ-ONLY structural scan of the .ncs MIXER regions,
 * hunting for a per-track MUTE/ENABLE flag distinct from the LEVEL byte.
 *
 * WHY: the maintainer's architecture is "tracks ENABLED, volume ZERO". We have
 * only ever decoded the LEVEL byte (0x2701c/d synths, 0x26fbd+n*11 drums). If the
 * file ALSO stores a mute bit, a project could be silent for the WRONG reason
 * (muted) and raising the fader would do nothing.
 *
 * METHOD: walk every capture, keep the newest per (pack, slot), and for a window
 * spanning the whole mixer neighbourhood report, per byte offset, the set of
 * distinct values observed across the corpus. A field that is constant corpus-wide
 * is either unused or universally default; a field that VARIES is a real per-project
 * field and a mute-flag candidate (especially if its value set is binary-ish).
 *
 * READ-ONLY. Writes nothing, touches no device.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

import { getProjectName, NCS_FILE_SIZE } from '../../packages/circuit-tracks/src/ncs/format.js';

const ROOT = 'samples/circuit-ncs';
const PACKS_OF_INTEREST = new Set([2, 4, 5]);

/** Drum-record region: drum1 level is 0x26fbd, stride 11, drum4 level 0x26fde. */
const DRUM_WIN_START = 0x26f80;
const DRUM_WIN_END = 0x26ff0;
/** Synth/audio mixer region: levels 0x2701c..f, pans 0x27020.. */
const SYNTH_WIN_START = 0x26ff0;
const SYNTH_WIN_END = 0x27060;

interface Cap { path: string; pack: number; slot: number; when: number; source: string }

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ncs')) out.push(p);
  }
  return out;
}

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
            m.set(r.file_name, { pack: r.pack, slot: r.location, when: Date.parse(r.created_at ?? '') || 0 });
          }
        } catch { /* ignore */ }
      }
    }
    indexCache.set(dir, m);
  }
  return indexCache.get(dir)!;
}

const FN_RE = /-pack(\d+)-project(\d+)-.*?-(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.ncs$/;
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
    const mf = join(p.split(/[\\/]pack\d+[\\/]/)[0], 'manifest.json');
    let when = statSync(p).mtimeMs;
    if (existsSync(mf)) {
      try { when = Date.parse(JSON.parse(readFileSync(mf, 'utf8')).captured_at) || when; } catch { /* */ }
    }
    return { path: p, pack: Number(c[1]), slot: Number(c[2]), when, source: 'card-backup' };
  }
  return undefined;
}

const all = walk(ROOT);
const newest = new Map<string, Cap>();
for (const p of all) {
  const c = classify(p);
  if (!c || !PACKS_OF_INTEREST.has(c.pack)) continue;
  const key = `${c.pack}/${c.slot}`;
  const prev = newest.get(key);
  if (!prev || c.when > prev.when) newest.set(key, c);
}

const files: { key: string; name: string; u8: Uint8Array }[] = [];
for (const c of [...newest.values()].sort((a, b) => a.pack - b.pack || a.slot - b.slot)) {
  const buf = readFileSync(c.path);
  if (buf.length !== NCS_FILE_SIZE) continue;
  const u8 = new Uint8Array(buf);
  files.push({ key: `${c.pack}/${String(c.slot).padStart(2, '0')}`, name: getProjectName(u8), u8 });
}

console.log(`Corpus: ${files.length} newest-per-slot projects on packs 2/4/5.\n`);

function scanWindow(label: string, start: number, end: number) {
  console.log(`\n=== ${label}: 0x${start.toString(16)}..0x${end.toString(16)} ===`);
  console.log('offset    distinct values (value×count)                                  verdict');
  console.log('-'.repeat(110));
  for (let off = start; off < end; off++) {
    const counts = new Map<number, number>();
    for (const f of files) counts.set(f.u8[off], (counts.get(f.u8[off]) ?? 0) + 1);
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const varies = entries.length > 1;
    const desc = entries.slice(0, 8).map(([v, n]) => `${v}×${n}`).join(' ');
    const binary = varies && entries.length <= 2 && entries.every(([v]) => v === 0 || v === 1);
    const verdict = binary ? '<== BINARY, MUTE CANDIDATE'
      : varies ? 'varies'
      : `constant ${entries[0][0]}`;
    // only print varying offsets, plus the known level offsets for orientation
    const known = off === 0x2701c || off === 0x2701d || off === 0x2701e || off === 0x2701f
      || [0, 1, 2, 3].some(t => off === 0x26fbd + t * 11);
    if (varies || known) {
      console.log(
        `0x${off.toString(16).padStart(5, '0')}  ${desc.padEnd(60)}  ${verdict}${known ? '  [KNOWN LEVEL FIELD]' : ''}`,
      );
    }
  }
}

scanWindow('DRUM RECORD REGION', DRUM_WIN_START, DRUM_WIN_END);
scanWindow('SYNTH/AUDIO MIXER REGION', SYNTH_WIN_START, SYNTH_WIN_END);

// Structural view: lay out the four 11-byte drum records side by side for a
// handful of projects so the record shape is visible.
console.log('\n\n=== DRUM RECORD SHAPE (11 bytes per track, level at index 0) ===');
console.log('Showing the first 6 projects; each row is one track record.');
for (const f of files.slice(0, 6)) {
  console.log(`\n${f.key} "${f.name}"`);
  for (let t = 0; t < 4; t++) {
    const base = 0x26fbd + t * 11;
    const bytes = [...f.u8.slice(base, base + 11)].map(b => b.toString().padStart(3));
    console.log(`  drum${t + 1} @0x${base.toString(16)}: [${bytes.join(' ')}]   (index0 = level)`);
  }
}

// Whole-file: are there ANY binary-valued bytes that split the corpus? Broad sweep
// for a mute bitmask anywhere in the file would be too noisy, so instead report
// how many offsets in the whole file vary at all, as a sanity bound.
let varyCount = 0;
for (let off = 0; off < NCS_FILE_SIZE; off++) {
  const first = files[0].u8[off];
  for (const f of files) { if (f.u8[off] !== first) { varyCount++; break; } }
}
console.log(`\n\nWhole-file: ${varyCount} of ${NCS_FILE_SIZE} byte offsets vary across the corpus.`);
