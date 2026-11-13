/**
 * Deterministic song → Circuit-projects PLANNER, CLI (BK-SONG-PROJECTS-PLANNER).
 *
 * Thin network front-end over `planSongProjects` (`songPlanner.ts`): it fetches a
 * Songsterr song's parts, runs the planner, and prints the plan (human, or
 * `--json` for `bake-song-fills.ts`). The planner adds the five corrections the
 * owner used to make by hand on top of `import_songsterr whole_song`:
 *
 *   1. DROP the sections only the LIVE part (± decorative vocals) backs,
 *   2. DEDUP repeated grooves (identical / shared-groove / superset),
 *   3. flag FILL bars per section (candidates for owner confirm),
 *   4. report the distinct GM TOM LANES per section (doubled-tom drives),
 *   5. surface OVER-CEILING splits.
 *
 * READ-ONLY: fetches + prints. Authoring is a separate step (`apply_pattern`),
 * fill baking another (`bake-song-fills.ts` → `bouncer`).
 *
 * `--fixture <slug>` reads `scripts/fixtures/<slug>/` (written by
 * `fetch-songsterr-fixture.ts`) instead of the network, so a mapping session plans
 * from the same bytes its map script authors from.
 *
 * Run:  npx tsx scripts/plan-song-projects.ts <songsterr-url|id> [--live 0,1] [--json]
 *       npx tsx scripts/plan-song-projects.ts --fixture <slug> [--live 0,1] [--json]
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchSongsterrTracks,
  fetchSongsterrPart,
  toChopPart,
  planSongProjects,
  formatSongProjectPlan,
  type ChopPartFlat,
} from '../packages/core/src/protocol-generic/patterns/index.js';
import { type SongsterrPart } from '../packages/core/src/protocol-generic/patterns/songsterr.js';

interface Args { ref: string; fixture?: string; live: number[]; json: boolean; }
function parseArgs(argv: string[]): Args {
  const a: Args = { ref: '', live: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') a.json = true;
    else if (t === '--fixture') a.fixture = argv[++i];
    else if (t === '--live') a.live = (argv[++i] ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
    else if (!t.startsWith('--')) a.ref = t;
  }
  if (a.ref === '' && a.fixture === undefined) {
    throw new Error('usage: plan-song-projects <songsterr-url|id> | --fixture <slug>  [--live 0,1] [--json]');
  }
  return a;
}

interface Roster { songId: number; title: string; artist: string; allTracks: { partId: number; name: string; instrument: string; isEmpty?: boolean }[] }

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // SongsterrTrackList carries `allTracks` (+ `drumTracks`) and top-level
  // `title`/`artist` — NOT `list.tracks` / `list.song` (the shape the earlier
  // prototype guessed at and which never existed).
  const dir = args.fixture !== undefined ? join(import.meta.dirname, 'fixtures', args.fixture) : undefined;
  const list: Roster = dir !== undefined
    ? JSON.parse(readFileSync(join(dir, 'tracklist.json'), 'utf8')) as Roster
    : await fetchSongsterrTracks(args.ref);
  const rawParts = new Map<number, SongsterrPart>();
  const parts: ChopPartFlat[] = [];
  for (const t of list.allTracks) {
    if (t.isEmpty === true) continue;
    const part = dir !== undefined
      ? JSON.parse(readFileSync(join(dir, `part-${t.partId}.json`), 'utf8')) as SongsterrPart
      : (await fetchSongsterrPart(String(list.songId), { track: t.partId })).part;
    rawParts.set(t.partId, part);
    const label = t.name !== '' ? `${t.instrument} (${t.name})` : t.instrument;
    parts.push(toChopPart(t.partId, label, part));
  }

  const plan = planSongProjects(parts, rawParts, { live: args.live });

  if (args.json) { console.log(JSON.stringify(plan, null, 2)); return; }
  console.log(formatSongProjectPlan(plan, `${list.artist} - ${list.title} (s${list.songId})`));
}

main().catch((e) => { console.error(e); process.exit(1); });
