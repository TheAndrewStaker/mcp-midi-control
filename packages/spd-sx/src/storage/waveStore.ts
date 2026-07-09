/**
 * SPD-SX wave pool — filesystem index allocation + append-only wave import.
 *
 * Port of the filesystem half of `scripts/spdsx/spdsx_wave.py`. Adding a wave
 * touches ONLY two new files at the next free index (no SYSTEM edits — the
 * device rebuilds its wave list from the PRM tree on load):
 *   WAVE/DATA/<bucket>/<short>.wav   canonical 44.1k/16 PCM
 *   WAVE/PRM/<bucket>/<slot>.spd     <WvPrm>
 *
 * APPEND-ONLY: wave indices are positional and referenced by kits, so this
 * NEVER renumbers or overwrites an existing wave. A hard existence guard
 * enforces this even if a flaky USB link makes the index scan undercount.
 * Writes are atomic (temp on the same volume + fsync + rename).
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeToSpdsx } from '../codec/wav.js';
import { dataFilename, encodeWavePrm, nameToNm, nameTruncated } from '../codec/wavePrm.js';
import { readWaves } from './inventory.js';

/** Device-confirmed only for buckets 00-04 (indices 0-499). */
export const FIRST_UNOBSERVED_BUCKET = 5;

export interface WaveImportItem {
  /** Source WAV bytes; any PCM/float rate/depth (normalized to 44.1k/16 on import). */
  wav: Uint8Array;
  /** Wave name shown on the device (<=12 chars; truncated with a warning). */
  name: string;
}

export interface WaveImportResult {
  name: string;
  index: number;
  dataPath: string; // relative to WAVE/DATA, e.g. "04/Clap_.wav"
  truncated: boolean;
  /** True when the source was resampled/requantized to 44.1k/16 on import. */
  converted: boolean;
  /** What the normalize step changed (empty when already device-format). */
  conversionNote: string;
  /** Set when the imported audio is BYTE-IDENTICAL to an existing pool wave. */
  duplicateOf?: { index: number; name: string };
  /** Set when another wave already has this (truncated) name, but DIFFERENT audio. */
  nameCollisionWith?: { index: number; name: string };
  warning?: string;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Indices in use. Robust to AppleDouble (._*) + non-numeric entries on FAT. */
export function usedIndices(root: string): Set<number> {
  const idx = new Set<number>();
  const prmRoot = join(root, 'WAVE', 'PRM');
  let buckets: string[];
  try {
    buckets = readdirSync(prmRoot);
  } catch {
    return idx;
  }
  for (const bucket of buckets) {
    if (!/^\d+$/.test(bucket)) continue;
    let files: string[];
    try {
      files = readdirSync(join(prmRoot, bucket));
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.startsWith('.')) continue; // ._73.spd, .DS_Store
      const m = /^(\d+)\.spd$/.exec(f);
      if (!m) continue;
      idx.add(Number.parseInt(bucket, 10) * 100 + Number.parseInt(m[1], 10));
    }
  }
  return idx;
}

/**
 * Next free wave index. THROWS if the PRM tree reads empty (unmounted / wrong
 * path / a dropped USB link) so we never start at 0 and clobber the first wave.
 */
export function nextFreeIndex(root: string): number {
  const used = usedIndices(root);
  if (used.size === 0) {
    throw new Error(
      `no waves found under ${root}/WAVE/PRM (device unmounted, wrong path, or a dropped USB link). ` +
        `Refusing to allocate (would start at index 0 and overwrite wave 0).`,
    );
  }
  return Math.max(...used) + 1;
}

// ── Duplicate-detection pool index, cached per root ──────────────────────────
//
// Building the index (read every PRM's name/path + stat every DATA file for its
// size) is the expensive part of dedup. We do it ONCE per pool and cache it,
// then validate the cache for FREE against `used` — the cheap filename-only
// index enumeration addWaves already computes for allocation. If the on-disk
// index set is unchanged the cache is reused; if it changed (an external Wave
// Manager edit, a remount), it rebuilds. So N sequential uploads cost one scan,
// not N. Safe because dedup is advisory: a byte-match is re-confirmed against
// the real file, and index ALLOCATION never trusts this cache (it uses `used`).

interface PoolDedupIndex {
  indices: Set<number>;
  byName: Map<string, { index: number; name: string }>;
  bySize: Map<number, { index: number; name: string; abs: string }[]>;
}
const dedupCacheByRoot = new Map<string, PoolDedupIndex>();

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function getDedupIndex(root: string, used: Set<number>): PoolDedupIndex {
  const cached = dedupCacheByRoot.get(root);
  if (cached && setsEqual(cached.indices, used)) return cached;
  const byName = new Map<string, { index: number; name: string }>();
  const bySize = new Map<number, { index: number; name: string; abs: string }[]>();
  for (const w of readWaves(root)) {
    const abs = join(root, 'WAVE', 'DATA', w.path);
    let size = -1;
    try { size = statSync(abs).size; } catch { /* missing/unreadable DATA: skip */ }
    const lname = w.name.toLowerCase();
    if (!byName.has(lname)) byName.set(lname, { index: w.index, name: w.name });
    const list = bySize.get(size) ?? [];
    list.push({ index: w.index, name: w.name, abs });
    bySize.set(size, list);
  }
  const fresh: PoolDedupIndex = { indices: new Set(used), byName, bySize };
  dedupCacheByRoot.set(root, fresh);
  return fresh;
}

/** Fold a just-written wave into the cache so the next upload reuses it (no rescan). */
function noteAddedWave(cache: PoolDedupIndex, index: number, name: string, abs: string, size: number): void {
  cache.indices.add(index);
  const lname = name.toLowerCase();
  if (!cache.byName.has(lname)) cache.byName.set(lname, { index, name });
  const list = cache.bySize.get(size) ?? [];
  list.push({ index, name, abs });
  cache.bySize.set(size, list);
}

function atomicWrite(path: string, bytes: Uint8Array): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw e;
  }
}

const enc = new TextEncoder();

/**
 * Append waves to the pool. Append-only, fail-fast: validates every name + WAV
 * BEFORE any write (no partial batch from a late bad file). Each write is
 * guarded against overwriting an existing index and is atomic. DATA is written
 * before PRM (orphan-safe: a stray DATA file is harmless; an orphan PRM points
 * at nothing).
 */
export function addWaves(root: string, items: readonly WaveImportItem[], dryRun = false): WaveImportResult[] {
  // One cheap, filename-only index enumeration: drives allocation AND validates
  // the (cached) duplicate-detection index, so we never rescan all PRM content
  // per upload.
  const used = usedIndices(root);
  if (used.size === 0) {
    throw new Error(
      `no waves found under ${root}/WAVE/PRM (device unmounted, wrong path, or a dropped USB link). ` +
        `Refusing to allocate (would start at index 0 and overwrite wave 0).`,
    );
  }
  let idx = Math.max(...used) + 1;

  // Pre-flight: validate names + decode/normalize all audio up front (no partial
  // batch from a late bad file). Normalization happens ONCE here; the write loop
  // emits these already-canonical 44.1k/16 bytes.
  const prepared = items.map((it) => {
    const nm = nameToNm(it.name); // throws on bad name
    const norm = normalizeToSpdsx(it.wav, it.name); // throws on undecodable WAV; resamples otherwise
    return { name: it.name, nm, bytes: norm.bytes, converted: norm.converted, conversionNote: norm.note };
  });

  // Duplicate-detection index (cached per root; rebuilt only when the on-disk
  // index set changed). The per-item check reads existing audio ONLY for
  // same-byte-length candidates. Resilient to a flaky drive — a failed read just
  // drops that wave from the check, never aborts the import.
  const dedup = getDedupIndex(root, used);
  const dataCache = new Map<string, Uint8Array | undefined>();
  const readData = (p: string): Uint8Array | undefined => {
    if (dataCache.has(p)) return dataCache.get(p);
    let b: Uint8Array | undefined;
    try { b = new Uint8Array(readFileSync(p)); } catch { b = undefined; }
    dataCache.set(p, b);
    return b;
  };
  const batchSeen: { index: number; name: string; bytes: Uint8Array }[] = []; // intra-batch dups

  const results: WaveImportResult[] = [];
  const committed: number[] = [];
  const planned = new Set<string>(); // lower-cased DATA names this batch

  for (const { name, nm, bytes, converted, conversionNote } of prepared) {
    const bucket = Math.floor(idx / 100);
    const slot = idx % 100;
    const warnParts: string[] = [];
    if (bucket >= FIRST_UNOBSERVED_BUCKET) {
      warnParts.push(
        `index ${idx} falls in bucket ${String(bucket).padStart(2, '0')}, which is NOT device-confirmed ` +
        `(only 00-04 are). Device wave/memory ceiling unverified.`);
    }

    // Duplicate / name-collision detection (non-blocking — append-only still
    // appends). Byte-identical is checked first (certain); a same-name-different-
    // audio collision is a softer heads-up (the device allows duplicate names).
    let duplicateOf: { index: number; name: string } | undefined;
    for (const e of dedup.bySize.get(bytes.length) ?? []) { // size-bounded: read content only for same-length
      const eb = readData(e.abs);
      if (eb && bytesEqual(eb, bytes)) { duplicateOf = { index: e.index, name: e.name }; break; }
    }
    if (!duplicateOf) {
      for (const c of batchSeen) {
        if (bytesEqual(c.bytes, bytes)) { duplicateOf = { index: c.index, name: c.name }; break; }
      }
    }
    let nameCollisionWith: { index: number; name: string } | undefined;
    if (!duplicateOf) {
      const truncName = name.slice(0, 12).toLowerCase();
      nameCollisionWith = dedup.byName.get(truncName);
      if (!nameCollisionWith) {
        // Intra-batch: an earlier wave in THIS call with the same truncated name
        // (a byte-identical earlier item would already be a duplicateOf above).
        const earlier = batchSeen.find((c) => c.name.slice(0, 12).toLowerCase() === truncName);
        if (earlier) nameCollisionWith = { index: earlier.index, name: earlier.name };
      }
    }
    if (duplicateOf) {
      warnParts.push(
        `byte-identical to existing wave ${duplicateOf.index} '${duplicateOf.name}'; appended anyway ` +
        `(the pool is append-only). Reference index ${duplicateOf.index} from author_kit instead if you ` +
        `did not mean to add a second copy.`);
    } else if (nameCollisionWith) {
      warnParts.push(
        `another wave named '${nameCollisionWith.name}' already exists at index ${nameCollisionWith.index} ` +
        `(DIFFERENT audio); SPD-SX wave names are not unique, this is just a heads-up.`);
    }

    const bk = String(bucket).padStart(2, '0');
    const slotName = String(slot).padStart(2, '0');
    const dataDir = join(root, 'WAVE', 'DATA', bk);
    const prmDir = join(root, 'WAVE', 'PRM', bk);
    const fname = dataFilename(
      name,
      (cand) => existsSync(join(dataDir, cand)) || planned.has(cand.toLowerCase()),
    );
    planned.add(fname.toLowerCase());
    const prmPath = join(prmDir, `${slotName}.spd`);
    const dataPath = join(dataDir, fname);
    const rel = `${bk}/${fname}`;

    // Hard append-only guard: NEVER overwrite an existing index or DATA file.
    if (existsSync(prmPath) || existsSync(dataPath)) {
      throw new Error(
        `refusing to overwrite existing files at index ${idx} (${slotName}.spd / ${fname}); ` +
          `the index scan is inconsistent; aborting (committed ${committed.length} so far: ${JSON.stringify(committed)}).`,
      );
    }

    if (!dryRun) {
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(prmDir, { recursive: true });
      try {
        atomicWrite(dataPath, bytes); // DATA first (orphan-safe); already 44.1k/16
        atomicWrite(prmPath, enc.encode(encodeWavePrm(nm, rel, 0))); // then PRM
      } catch (e) {
        throw new Error(
          `failed at index ${idx} ('${name}'): ${e instanceof Error ? e.message : String(e)}. ` +
            `Committed: ${JSON.stringify(committed)}`,
        );
      }
    }

    committed.push(idx);
    batchSeen.push({ index: idx, name, bytes });
    // Keep the cached dedup index in sync with what we just wrote, so the next
    // upload reuses it instead of rescanning. Only on a real write.
    if (!dryRun) noteAddedWave(dedup, idx, name, dataPath, bytes.length);
    results.push({
      name, index: idx, dataPath: rel, truncated: nameTruncated(name), converted, conversionNote,
      duplicateOf, nameCollisionWith,
      warning: warnParts.length ? warnParts.join(' ') : undefined,
    });
    idx += 1;
  }
  return results;
}

/** Write a single kit `.spd` to KIT/kitNNN.spd (kitNumber is 1..100, device-facing). */
export function writeKitFile(root: string, kitNumber: number, text: string, opts: { force?: boolean } = {}): {
  path: string;
  backedUp?: string;
} {
  const base = `kit${String(kitNumber - 1).padStart(3, '0')}.spd`;
  const target = join(root, 'KIT', base);
  mkdirSync(join(root, 'KIT'), { recursive: true });
  let backedUp: string | undefined;
  if (existsSync(target)) {
    if (!opts.force) {
      throw new Error(`refusing to overwrite existing ${base} (pass force to replace)`);
    }
    // Back up the existing kit before a forced overwrite (no device-side undo).
    const bak = `${target}.bak`;
    atomicWrite(bak, new Uint8Array(readFileSync(target)));
    backedUp = bak;
  }
  atomicWrite(target, enc.encode(text));
  return { path: target, backedUp };
}
