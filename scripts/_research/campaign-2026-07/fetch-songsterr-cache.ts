/**
 * Scratch: fetch a song's meta + every non-empty part into
 * samples/songsterr-cache/s<songId>/ (meta.json + part-<id>.json), paced.
 *
 *   npx tsx samples/_scratch/fetch-songsterr-cache.ts <songId>
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fetchSongsterrTracks, fetchSongsterrPart } from '../../packages/core/src/protocol-generic/patterns/songsterrFetch.js';

const songId = process.argv[2];
if (!songId) { console.error('usage: npx tsx samples/_scratch/fetch-songsterr-cache.ts <songId>'); process.exit(1); }
const dir = `samples/songsterr-cache/s${songId}`;
mkdirSync(dir, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const roster = await fetchSongsterrTracks(songId);
console.log(`s${songId}: "${roster.title}" by ${roster.artist}, revision ${roster.revisionId}, ${roster.allTracks.length} part(s)`);
writeFileSync(join(dir, 'meta.json'), JSON.stringify({
  songId: roster.songId, revisionId: roster.revisionId, image: 'img',
  title: roster.title, artist: roster.artist,
  popularTrackDrum: roster.allTracks.find((t) => t.isDrums)?.partId,
  tracks: roster.allTracks.map((t) => ({
    instrumentId: t.instrumentId, instrument: t.instrument,
    ...(t.name ? { name: t.name } : {}), hash: `h${t.partId}`,
    ...(t.isEmpty === true ? { isEmpty: true } : {}),
  })),
}, null, 2));

for (const t of roster.allTracks) {
  if (t.isEmpty === true) { console.log(`  part ${t.partId} (${t.instrument}) isEmpty, skipped`); continue; }
  const out = join(dir, `part-${t.partId}.json`);
  if (existsSync(out)) { console.log(`  part ${t.partId} already cached`); continue; }
  await sleep(4000);
  const got = await fetchSongsterrPart(songId, { track: t.partId });
  writeFileSync(out, JSON.stringify(got.part));
  console.log(`  part ${t.partId} (${t.instrument}${t.name ? ` "${t.name}"` : ''}) cached, ${got.part.measures?.length} measures`);
}
console.log('done');
