/**
 * device-exports — pick a device export off disk CORRECTLY, and say which one you picked.
 *
 * ## The bug this exists to prevent
 *
 * `export_preset` / `backup_device` drop timestamped files into a backup directory
 * (`~/mcp-midi-backups` by default), so a directory accumulates many exports of the SAME project
 * taken on different days. An analysis script that wants "the current state of P2:1" has to choose
 * one, and the tempting one-liner is:
 *
 *     readdirSync(DIR).filter((f) => f.includes(name)).sort().pop()      // ← WRONG
 *
 * That sorts FILENAMES and takes the lexicographic last. It is wrong whenever the naming is not
 * strictly lexicographic-chronological, which is most of the time in practice: the prefix can change
 * between tool versions, a hand-renamed or derived file (`…-midi1fix.ncs`, `…-drumsup.ncs`) sorts
 * after its source, and a date embedded mid-name is only chronological if every other field before it
 * is identical.
 *
 * On 2026-09-12 exactly that line made an analysis read a **three-week-old** export and report a live
 * defect in a project whose card image was fine. Two follow-on conclusions were wrong, and a no-op
 * "repair" was written to the device before the provenance was checked. Nothing was damaged, but the
 * session burned a long detour. The committed tooling never had the bug — every `readdirSync` in
 * `scripts/` iterates ALL matches and sorts only for deterministic output — it was ad-hoc analysis
 * scripts that reached for the one-liner. This module is the correct one-liner, so the next one does
 * not have to re-derive it.
 *
 * ## The two rules
 *
 * 1. **Pick by mtime, never by filename.** The filesystem knows when the bytes arrived; the filename
 *    only knows what someone chose to call them.
 * 2. **Print what you loaded.** A decode that does not name its source file cannot be audited, and a
 *    wrong answer from the right code is indistinguishable from a right one. `describe()` is cheap;
 *    call it in every report.
 *
 * Usage:
 *
 *     import { newestExport, describeExport } from './_lib/device-exports.js';
 *     const e = newestExport({ match: 'Song_1_Chorus', ext: '.ncs' });
 *     console.log(describeExport(e));          // name, mtime, size, and how many it beat
 *     const buf = new Uint8Array(readFileSync(e.path));
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Where `export_preset` / `backup_device` write by default. */
export const DEFAULT_EXPORT_DIR = join(homedir(), 'mcp-midi-backups');

export interface ExportPick {
  /** Absolute path to the chosen file. */
  path: string;
  /** Bare filename, for receipts. */
  name: string;
  /** Modification time (ms since epoch) — the field the choice was actually made on. */
  mtimeMs: number;
  /** Size in bytes, so a truncated or wrong-kind file is visible in the receipt. */
  size: number;
  /** How many other candidates matched and were rejected as older. Zero means there was no ambiguity. */
  beat: number;
}

export interface PickOptions {
  /** Directory to search. Default: `~/mcp-midi-backups`. */
  dir?: string;
  /** Substring every candidate filename must contain (case-sensitive). */
  match: string;
  /** Required extension, e.g. `.ncs`. Case-insensitive. Omit to accept any. */
  ext?: string;
  /**
   * Substrings that DISQUALIFY a candidate. Derived files written beside their source
   * (`…-midi1fix.ncs`, `…-drumsup.ncs`, `…-pack3.ncs`) are the common case: they are newer than the
   * export they came from, so an mtime pick would select the patched file when the caller wanted the
   * device's own image.
   */
  exclude?: readonly string[];
  /** Exact byte size a candidate must have (a Circuit `.ncs` is always 160,780). */
  size?: number;
}

/**
 * The newest matching export by MTIME. Throws when nothing matches, naming the directory and the
 * filter, because silently returning `undefined` is how a "file not found" becomes a wrong decode.
 */
export function newestExport(opts: PickOptions): ExportPick {
  const dir = opts.dir ?? DEFAULT_EXPORT_DIR;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    throw new Error(`cannot read export directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const candidates: ExportPick[] = [];
  for (const name of names) {
    if (!name.includes(opts.match)) continue;
    if (opts.ext !== undefined && !name.toLowerCase().endsWith(opts.ext.toLowerCase())) continue;
    if (opts.exclude?.some((x) => name.includes(x)) === true) continue;
    const path = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile()) continue;
    if (opts.size !== undefined && st.size !== opts.size) continue;
    candidates.push({ path, name, mtimeMs: st.mtimeMs, size: st.size, beat: 0 });
  }
  if (candidates.length === 0) {
    const filters = [`match "${opts.match}"`, opts.ext !== undefined ? `ext ${opts.ext}` : undefined,
      opts.size !== undefined ? `size ${opts.size}` : undefined,
      opts.exclude !== undefined ? `excluding ${opts.exclude.join('/')}` : undefined].filter(Boolean).join(', ');
    throw new Error(`no export in ${dir} matching ${filters}`);
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const win = candidates[0]!;
  return { ...win, beat: candidates.length - 1 };
}

/** All matching exports, NEWEST FIRST — for when the question is "what changed between takes". */
export function allExports(opts: PickOptions): ExportPick[] {
  const first = newestExport(opts);       // reuses the filtering + the not-found error
  const dir = opts.dir ?? DEFAULT_EXPORT_DIR;
  const out: ExportPick[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.includes(opts.match)) continue;
    if (opts.ext !== undefined && !name.toLowerCase().endsWith(opts.ext.toLowerCase())) continue;
    if (opts.exclude?.some((x) => name.includes(x)) === true) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (!st.isFile()) continue;
    if (opts.size !== undefined && st.size !== opts.size) continue;
    out.push({ path, name, mtimeMs: st.mtimeMs, size: st.size, beat: 0 });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  void first;
  return out;
}

/** One-line provenance receipt. Print this in every report that reads an export. */
export function describeExport(e: ExportPick): string {
  const t = new Date(e.mtimeMs).toISOString().replace('T', ' ').slice(0, 19);
  return `${e.name}  (mtime ${t}, ${e.size} bytes${e.beat > 0 ? `, newest of ${e.beat + 1} matches` : ''})`;
}

/** Read the newest match and hand back both the bytes and the receipt, so neither can be forgotten. */
export function readNewestExport(opts: PickOptions): { bytes: Uint8Array; pick: ExportPick; receipt: string } {
  const pick = newestExport(opts);
  return { bytes: new Uint8Array(readFileSync(pick.path)), pick, receipt: describeExport(pick) };
}
