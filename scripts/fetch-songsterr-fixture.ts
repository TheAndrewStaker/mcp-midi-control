/**
 * Fetch a Songsterr song into an offline fixture directory: `tracklist.json` (the roster) plus
 * `part-<id>.json` for every non-empty part. This is the input every `scripts/map-<song>.ts` reads,
 * so a song mapping starts here and never touches the network again.
 *
 * Writes the `tracklist.json` + `part-N.json` layout the mapping scripts and planners read. The
 * folder is local scratch (gitignored, a transcription of a real song) and no gate reads it: the
 * song gates run on the invented songs of `scripts/syntheticSong.ts`. Paced at one part every 4 s,
 * the same courtesy the old helper used.
 *
 * Also prints the roster with each part's size and bend/slide counts, which is the first thing a
 * mapping session needs to know (which part is the bass, which carries the lead's bends).
 *
 * Run: npx tsx scripts/fetch-songsterr-fixture.ts <songsterr-url-or-id> <fixture-slug> [--force]
 *   e.g. npx tsx scripts/fetch-songsterr-fixture.ts https://www.songsterr.com/a/wsa/...-s123456 mysong
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchSongsterrTracks, fetchSongsterrPart } from '../packages/core/src/protocol-generic/patterns/songsterrFetch.js';
import type { SongsterrPart } from '../packages/core/src/protocol-generic/patterns/songsterr.js';

const [input, slug] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const force = process.argv.includes('--force');
if (!input || !slug || !/^[a-z0-9-]+$/.test(slug)) {
  console.error('usage: npx tsx scripts/fetch-songsterr-fixture.ts <songsterr-url-or-id> <fixture-slug (a-z0-9-)> [--force]');
  process.exit(1);
}
const dir = join(import.meta.dirname, 'fixtures', slug);
mkdirSync(dir, { recursive: true });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const roster = await fetchSongsterrTracks(input);
writeFileSync(join(dir, 'tracklist.json'), JSON.stringify({
  songId: roster.songId,
  revisionId: roster.revisionId,
  title: roster.title,
  artist: roster.artist,
  allTracks: roster.allTracks,
}, null, 1));
console.log(`s${roster.songId} rev ${roster.revisionId}: "${roster.title}" by ${roster.artist}, ${roster.allTracks.length} part(s) -> ${dir}\n`);

/** Per-part census: measures, pitched notes, and the articulations a mapping has to decide about. */
function census(p: SongsterrPart): string {
  let notes = 0, bends = 0, slides = 0, ties = 0;
  for (const m of p.measures ?? []) for (const v of m.voices ?? []) for (const b of v.beats ?? []) {
    for (const n of b.notes ?? []) {
      if (n.rest) continue;
      notes++;
      if (n.bend) bends++;
      if (n.slide) slides++;
      if (n.tie) ties++;
    }
  }
  return `${p.measures?.length ?? 0} measures, ${notes} notes` +
    (bends ? `, ${bends} BENDS` : '') + (slides ? `, ${slides} slides` : '') + (ties ? `, ${ties} ties` : '');
}

let first = true;
for (const t of roster.allTracks) {
  const label = `part ${t.partId}: ${t.instrument}${t.name ? ` "${t.name}"` : ''}${t.isDrums ? ' [drums]' : ''}`;
  if (t.isEmpty === true) { console.log(`  ${label} (empty, skipped)`); continue; }
  const out = join(dir, `part-${t.partId}.json`);
  let part: SongsterrPart;
  if (existsSync(out) && !force) {
    part = JSON.parse(readFileSync(out, 'utf8')) as SongsterrPart;
  } else {
    if (!first) await sleep(4000);
    first = false;
    part = (await fetchSongsterrPart(input, { track: t.partId })).part;
    writeFileSync(out, JSON.stringify(part));
  }
  console.log(`  ${label}  (${census(part)})`);
}
console.log('\ndone');
