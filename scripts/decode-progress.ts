/**
 * Cookbook decode-progress snapshot.
 *
 * Emits a JSON snapshot of the encoding-cookbook state for the current
 * working tree. Designed to be diffed session-over-session to expose
 * regressions, status demotions, or primitives that quietly stopped
 * being referenced in `consumed_in:` source code.
 *
 * Snapshot fields:
 *   - generated         ISO timestamp at run time.
 *   - schema_version    bumped on schema changes; consumers should fail
 *                       loudly on version mismatch.
 *   - totals            aggregates: by_status, by_class, by_firmware,
 *                       by_category (main/_scratch/_partial/_negative).
 *   - entries           per-primitive snapshot (slug, status, class,
 *                       firmware_count, consumed_in resolution counts,
 *                       category, last-discovered note).
 *
 * Usage:
 *   npx tsx scripts/decode-progress.ts                 (print JSON to stdout)
 *   npx tsx scripts/decode-progress.ts --pretty        (indent for human read)
 *   npx tsx scripts/decode-progress.ts --output P.json (write to file)
 *   npx tsx scripts/decode-progress.ts --diff OLD.json (compute drift vs OLD)
 *
 * Diff mode prints a short table summarizing status promotions /
 * demotions, fixture-count changes, and consumed_in resolution shifts.
 * Exits 0 always when run as a snapshot generator. In --diff mode,
 * exits 1 when any primitive demoted (matched -> matched-singleton ->
 * partial-N1) or a previously-resolving consumed_in path stopped
 * resolving.
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(HERE, '..');
const REPO_PARENT = path.resolve(MCP_ROOT, '..');
const FRACTAL_MIDI_ROOT = path.join(REPO_PARENT, 'fractal-midi');
const COOKBOOK_ROOT = path.join(FRACTAL_MIDI_ROOT, 'docs', 'research', 'cookbook');

const SCHEMA_VERSION = 1;

interface Entry {
  slug: string;
  status: string;
  class: string | null;
  firmware: string[];
  consumed_in_total: number;
  consumed_in_resolved: number;
  category: 'main' | '_scratch' | '_partial' | '_negative';
  discovered: string | null;
}

interface Snapshot {
  generated: string;
  schema_version: number;
  totals: {
    entries: number;
    by_status: Record<string, number>;
    by_class: Record<string, number>;
    by_firmware: Record<string, number>;
    by_category: Record<string, number>;
  };
  entries: Entry[];
}

function parseFrontmatter(source: string): Record<string, string | string[]> {
  if (!source.startsWith('---')) return {};
  const lines = source.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end < 0) return {};
  const fm: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  let list: string[] = [];
  const flush = () => {
    if (listKey !== null) { fm[listKey] = list; listKey = null; list = []; }
  };
  const strip = (s: string): string => {
    const t = s.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };
  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (raw.startsWith('  - ') || raw.startsWith('\t- ')) {
      if (listKey !== null) list.push(strip(raw.replace(/^\s*-\s*/, '')));
      continue;
    }
    flush();
    const colon = raw.indexOf(':');
    if (colon < 0) continue;
    const key = raw.slice(0, colon).trim();
    const rest = raw.slice(colon + 1).trim();
    if (rest === '') { listKey = key; list = []; continue; }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      fm[key] = inner === '' ? [] : inner.split(',').map(strip);
      continue;
    }
    fm[key] = strip(rest);
  }
  flush();
  return fm;
}

function categoryOf(filePath: string): Entry['category'] {
  const rel = path.relative(COOKBOOK_ROOT, filePath);
  const parts = rel.split(/[\\/]/);
  if (parts.length === 1) return 'main';
  if (parts[0] === '_scratch') return '_scratch';
  if (parts[0] === '_partial') return '_partial';
  if (parts[0] === '_negative') return '_negative';
  return 'main';
}

function listCookbookFiles(): string[] {
  if (!existsSync(COOKBOOK_ROOT)) {
    throw new Error(`cookbook root not found: ${COOKBOOK_ROOT}`);
  }
  const out: string[] = [];
  for (const name of readdirSync(COOKBOOK_ROOT)) {
    const full = path.join(COOKBOOK_ROOT, name);
    const st = statSync(full);
    if (st.isFile() && name.endsWith('.md') && name !== 'INDEX.md') {
      out.push(full);
    } else if (st.isDirectory() && ['_scratch', '_partial', '_negative'].includes(name)) {
      for (const inner of readdirSync(full)) {
        if (inner.endsWith('.md') && inner !== 'INDEX.md') {
          out.push(path.join(full, inner));
        }
      }
    }
  }
  return out.sort();
}

function asList(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function resolvesAsPath(line: string): boolean {
  let raw = line.trim();
  if (raw.startsWith('(')) return false;
  const parenIdx = raw.indexOf('(');
  if (parenIdx > 0) raw = raw.slice(0, parenIdx).trim();
  if (raw === '') return false;
  const candidates: string[] = [
    path.resolve(MCP_ROOT, raw),
    path.resolve(FRACTAL_MIDI_ROOT, raw),
    path.resolve(REPO_PARENT, raw),
  ];
  for (const prefix of ['mcp-midi-tools/', 'fractal-midi/']) {
    if (raw.startsWith(prefix)) {
      const stripped = raw.slice(prefix.length);
      candidates.push(
        prefix === 'mcp-midi-tools/'
          ? path.resolve(MCP_ROOT, stripped)
          : path.resolve(FRACTAL_MIDI_ROOT, stripped),
      );
    }
  }
  return candidates.some((c) => existsSync(c));
}

function buildSnapshot(): Snapshot {
  const files = listCookbookFiles();
  const entries: Entry[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const fm = parseFrontmatter(src);
    const slug = path.basename(f, '.md');
    const status = typeof fm.status === 'string' ? fm.status : 'unknown';
    const klass = typeof fm.class === 'string' ? fm.class : null;
    const discovered = typeof fm.discovered === 'string' ? fm.discovered : null;
    const firmware = asList(fm.verified_on).map((s) => s.split(' ')[0]);
    const consumedIn = asList(fm.consumed_in);
    const resolvedCount = consumedIn.filter(resolvesAsPath).length;
    entries.push({
      slug,
      status,
      class: klass,
      firmware,
      consumed_in_total: consumedIn.length,
      consumed_in_resolved: resolvedCount,
      category: categoryOf(f),
      discovered,
    });
  }
  const by_status: Record<string, number> = {};
  const by_class: Record<string, number> = {};
  const by_firmware: Record<string, number> = {};
  const by_category: Record<string, number> = {};
  for (const e of entries) {
    by_status[e.status] = (by_status[e.status] ?? 0) + 1;
    if (e.class !== null) by_class[e.class] = (by_class[e.class] ?? 0) + 1;
    for (const fw of e.firmware) by_firmware[fw] = (by_firmware[fw] ?? 0) + 1;
    by_category[e.category] = (by_category[e.category] ?? 0) + 1;
  }
  return {
    generated: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
    totals: {
      entries: entries.length,
      by_status,
      by_class,
      by_firmware,
      by_category,
    },
    entries,
  };
}

const STATUS_RANK: Record<string, number> = {
  'non-matching': 0,
  scratch: 1,
  regression: 1,
  wip: 2,
  'partial-N1': 3,
  'matched-singleton': 4,
  matched: 5,
};

function diff(prev: Snapshot, curr: Snapshot): { regressions: string[]; promotions: string[]; resolution_shifts: string[] } {
  if (prev.schema_version !== curr.schema_version) {
    throw new Error(
      `schema version mismatch: prev=${prev.schema_version}, curr=${curr.schema_version}. Re-run generator after schema bump.`,
    );
  }
  const byPrevSlug = new Map(prev.entries.map((e) => [e.slug, e]));
  const regressions: string[] = [];
  const promotions: string[] = [];
  const resolution_shifts: string[] = [];
  for (const c of curr.entries) {
    const p = byPrevSlug.get(c.slug);
    if (!p) {
      promotions.push(`+ ${c.slug} (new) status=${c.status}`);
      continue;
    }
    const pr = STATUS_RANK[p.status] ?? -1;
    const cr = STATUS_RANK[c.status] ?? -1;
    if (cr < pr) {
      regressions.push(`! ${c.slug} demoted: ${p.status} -> ${c.status}`);
    } else if (cr > pr) {
      promotions.push(`+ ${c.slug} promoted: ${p.status} -> ${c.status}`);
    }
    if (c.consumed_in_resolved < p.consumed_in_resolved) {
      resolution_shifts.push(
        `! ${c.slug} consumed_in resolution dropped: ${p.consumed_in_resolved}/${p.consumed_in_total} -> ${c.consumed_in_resolved}/${c.consumed_in_total}`,
      );
    }
    if (c.firmware.length < p.firmware.length) {
      regressions.push(
        `! ${c.slug} verified_on count dropped: ${p.firmware.length} -> ${c.firmware.length}`,
      );
    }
  }
  const currSlugs = new Set(curr.entries.map((e) => e.slug));
  for (const p of prev.entries) {
    if (!currSlugs.has(p.slug)) {
      regressions.push(`! ${p.slug} REMOVED from cookbook`);
    }
  }
  return { regressions, promotions, resolution_shifts };
}

function main(): void {
  const args = process.argv.slice(2);
  let outputPath: string | null = null;
  let diffPath: string | null = null;
  let pretty = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--output' || a === '-o') { outputPath = args[++i]; continue; }
    if (a === '--diff' || a === '-d') { diffPath = args[++i]; continue; }
    if (a === '--pretty' || a === '-p') { pretty = true; continue; }
    console.error(`unknown arg: ${a}`);
    process.exit(2);
  }
  const snapshot = buildSnapshot();
  const json = pretty ? JSON.stringify(snapshot, null, 2) : JSON.stringify(snapshot);
  if (outputPath) {
    writeFileSync(outputPath, json + '\n', 'utf8');
    console.log(`wrote snapshot to ${outputPath} (${snapshot.entries.length} entries)`);
  } else if (!diffPath) {
    console.log(json);
  }
  if (diffPath) {
    if (!existsSync(diffPath)) {
      console.error(`prior snapshot not found: ${diffPath}`);
      process.exit(2);
    }
    const prev: Snapshot = JSON.parse(readFileSync(diffPath, 'utf8'));
    const d = diff(prev, snapshot);
    console.log(`decode-progress diff: ${diffPath} -> current`);
    console.log(`prev generated: ${prev.generated}`);
    console.log(`curr generated: ${snapshot.generated}`);
    console.log('');
    if (d.promotions.length === 0 && d.regressions.length === 0 && d.resolution_shifts.length === 0) {
      console.log('no changes.');
      process.exit(0);
    }
    if (d.promotions.length > 0) {
      console.log(`promotions (${d.promotions.length}):`);
      for (const x of d.promotions) console.log(`  ${x}`);
    }
    if (d.regressions.length > 0) {
      console.log(`regressions (${d.regressions.length}):`);
      for (const x of d.regressions) console.log(`  ${x}`);
    }
    if (d.resolution_shifts.length > 0) {
      console.log(`resolution shifts (${d.resolution_shifts.length}):`);
      for (const x of d.resolution_shifts) console.log(`  ${x}`);
    }
    process.exit(d.regressions.length === 0 && d.resolution_shifts.length === 0 ? 0 : 1);
  }
}

main();
