/**
 * Cross-check probe: fetch ONLY the bass parts of s688943 (backup source) and
 * s4973603 (third roster entry) to compare the riff contour against s287014's.
 * Paced ~4 s between requests; caches to samples/songsterr-cache/<id>-bassonly.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchSongsterrPart, fetchSongsterrTracks,
} from '@mcp-midi-control/core/protocol-generic/patterns/songsterrFetch.js';
import {
  flattenSongsterrMelodic, pitchToken, type SongsterrPart,
} from '@mcp-midi-control/core/protocol-generic/patterns/songsterr.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function bassOf(id: string): Promise<{ rev: number; partId: number; part: SongsterrPart } | undefined> {
  const dir = `samples/songsterr-cache/${id}-bassonly`;
  const metaPath = join(dir, 'meta.json');
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { revisionId: number; bassPartId: number };
    const part = JSON.parse(readFileSync(join(dir, `part-${meta.bassPartId}.json`), 'utf8')) as SongsterrPart;
    return { rev: meta.revisionId, partId: meta.bassPartId, part };
  }
  const list = await fetchSongsterrTracks(id);
  await sleep(4000);
  const bass = list.allTracks.find((t) => t.isEmpty !== true && /bass/i.test(t.instrument));
  if (bass === undefined) { console.log(`${id}: no bass track (roster: ${list.allTracks.map((t) => t.instrument).join(', ')})`); return undefined; }
  const got = await fetchSongsterrPart(String(list.songId), { track: bass.partId });
  await sleep(4000);
  mkdirSync(dir, { recursive: true });
  writeFileSync(metaPath, JSON.stringify({ songId: list.songId, revisionId: list.revisionId, title: list.title, artist: list.artist, bassPartId: bass.partId, roster: list.allTracks }, null, 1));
  writeFileSync(join(dir, `part-${bass.partId}.json`), JSON.stringify(got.part));
  return { rev: got.revisionId, partId: bass.partId, part: got.part };
}

function firstBars(tag: string, part: SongsterrPart, bars: number): void {
  const m = flattenSongsterrMelodic(part);
  const measures = m.measures;
  const barOf = (beat: number): number => {
    let lo = 0;
    for (let i = 0; i < measures.length; i++) if (beat >= measures[i].startBeat - 1e-6) lo = i;
    return lo;
  };
  console.log(`--- ${tag}: first sounding ${bars} bars ---`);
  let shown = 0;
  let lastBar = -1;
  for (const n of m.notes) {
    const b = barOf(n.beat);
    if (b !== lastBar) { shown++; lastBar = b; }
    if (shown > bars) break;
    const off = n.beat - measures[b].startBeat;
    console.log(`  m${b + 1} b${off.toFixed(2)}: ${pitchToken(n.pitch)}:${n.durationBeats.toFixed(2)}`);
  }
}

async function main(): Promise<void> {
  for (const id of ['688943', '4973603']) {
    const got = await bassOf(id);
    if (got === undefined) continue;
    console.log(`\n=== s${id} rev ${got.rev} bass part ${got.partId} ===`);
    firstBars(`s${id}`, got.part, 6);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
