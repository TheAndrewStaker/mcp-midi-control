/**
 * Scratch runner: drive executeImportSongsterr OFFLINE against a
 * samples/songsterr-cache/<sN> directory (part-<id>.json, optional meta.json),
 * writing the full result JSON to a file. Used to prove byte-stable receipts
 * across the window-identity re-key (2026-07-29 defect) and to re-run the
 * planner on the cached fetches.
 *
 *   npx tsx samples/_scratch/rekey-rerun.ts <cacheDir> <out.json> <argsJson>
 *
 * argsJson example: {"url":"6700","track":5,"whole_song":true,"fuzz":0}
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { executeImportSongsterr } from '../../packages/core/src/protocol-generic/dispatcher/songsterr.js';

const [cacheDir, outPath, argsJson] = process.argv.slice(2);
if (!cacheDir || !outPath || !argsJson) {
  console.error('usage: npx tsx samples/_scratch/rekey-rerun.ts <cacheDir> <out.json> <argsJson>');
  process.exit(1);
}
const args = JSON.parse(argsJson) as Record<string, unknown>;

const partFiles = readdirSync(cacheDir).filter((f) => /^part-\d+\.json$/.test(f));
const parts = new Map<number, unknown>();
for (const f of partFiles) parts.set(Number(f.match(/\d+/)![0]), JSON.parse(readFileSync(join(cacheDir, f), 'utf8')));

// META: real one when the cache carries it, else a FIXED synthesized roster
// (deterministic across runs, which is all byte-stability needs).
let meta: Record<string, unknown>;
const metaPath = join(cacheDir, 'meta.json');
if (existsSync(metaPath)) {
  meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
} else {
  const ids = [...parts.keys()].sort((a, b) => a - b);
  const drumId = ids.find((id) => (parts.get(id) as { tuningFlat?: boolean }).tuningFlat === true);
  meta = {
    songId: Number(String(args.url).replace(/\D/g, '')), revisionId: 1, image: 'img',
    title: 'Cached Song', artist: 'Cached Artist', popularTrackDrum: drumId,
    tracks: ids.map((id) => {
      const p = parts.get(id) as { tuningFlat?: boolean };
      return p.tuningFlat === true
        ? { instrumentId: 1024, instrument: 'Drums', name: `Part ${id}`, hash: `h${id}` }
        : { instrumentId: 25, instrument: 'Guitar', name: `Part ${id}`, hash: `h${id}` };
    }),
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request) => {
  const s = String(url);
  if (s.includes('/api/meta/')) return { ok: true, status: 200, json: async () => meta };
  const m = s.match(/\/(\d+)\.json$/);
  const part = m ? parts.get(Number(m[1])) : undefined;
  if (part === undefined) return { ok: false, status: 404 };
  return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(part)).buffer };
}) as unknown as typeof globalThis.fetch;

try {
  const result = await executeImportSongsterr(args as never);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  const r = result as { arrangement?: { sections: unknown[]; order: string[]; summary: string; project_plan?: { projects: unknown[] } }; song_plan?: { projects: unknown[] } };
  console.log(JSON.stringify({
    out: outPath,
    sections: r.arrangement?.sections.length,
    plays: r.arrangement?.order.length,
    summary: r.arrangement?.summary,
    project_plan_projects: r.arrangement?.project_plan?.projects.length,
    song_plan_projects: r.song_plan?.projects.length,
  }));
} finally {
  globalThis.fetch = realFetch;
}
