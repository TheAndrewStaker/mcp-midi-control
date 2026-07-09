/**
 * Songsterr drum fetch — the network front-end for the import path.
 *
 * The pure parse/flatten/decompose lives in `songsterr.ts` + `songStructure.ts`;
 * this module owns the one thing they can't: the 3-hop fetch off Songsterr's own
 * JSON (+ an optional name→song search). It lives in core (not the script) so
 * BOTH the `import_songsterr` MCP tool and `scripts/songsterr-drum-import.ts`
 * share one implementation.
 *
 *   1. name → songId      GET api/songs?pattern=<q>           (search, optional)
 *   2. songId → meta      GET api/meta/{songId}               revisionId, image, tracks[]
 *   3. part data          GET {cdn}/{songId}/{rev}/{image}/{partId}.json  (gzip JSON)
 *
 * Read-only: it only GETs public endpoints. The track-selection + ref-parse
 * logic is split out as PURE functions (`parseSongRef`, `selectDrumTrack`) so
 * they are unit-testable without a network.
 */

import { gunzipSync } from 'node:zlib';
import { flattenSongsterrDrums, type DrumPart, type SongsterrFlat } from './songsterr.js';

const DRUM_INSTRUMENT_ID = 1024;
const PRIMARY_CDN = 'https://dqsljvtekg760.cloudfront.net';
const FALLBACK_CDN = 'https://d3d3l6a6rcgkaf.cloudfront.net';
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  Accept: 'application/json',
};

export interface MetaTrack { instrumentId: number; instrument: string; name?: string; hash: string; isEmpty?: boolean; views?: number }
export interface SongMeta { songId: number; revisionId: number; image: string; title: string; artist: string; tracks: MetaTrack[]; popularTrackDrum?: number }

export interface DrumTrackChoice { partId: number; name: string; instrument: string; views?: number; popular: boolean }

export interface SearchHit { songId: number; title: string; artist: string }

export interface SongsterrFetched {
  songId: number;
  revisionId: number;
  title: string;
  artist: string;
  /** Every drum track (a song may have several — acoustic vs programmed). */
  drumTracks: DrumTrackChoice[];
  /** The track this fetch resolved to (honoring t-selector / track / track_name / popular). */
  selectedPartId: number;
  /** The raw part (for windowing via importSongsterrDrums). */
  part: DrumPart;
  /** The flattened track (events + sections + tempos + measures). */
  flat: SongsterrFlat;
}

// ── Pure helpers (unit-testable, no network) ─────────────────────────

/** Parse a Songsterr URL (…-s1467797t11) or bare id (1467797 / 1467797t11). */
export function parseSongRef(input: string): { songId: number; trackId?: number } {
  const m = input.match(/-s(\d+)(?:t(\d+))?\b/) ?? input.match(/^(\d+)(?:t(\d+))?$/);
  if (!m) throw new Error(`Could not extract a song id from "${input}" (expected a …-s12345 URL or a bare id like 1467797 / 1467797t11).`);
  return { songId: Number(m[1]), trackId: m[2] !== undefined ? Number(m[2]) : undefined };
}

/** All drum-track indices in a meta, as choices (name / views / popular flag). */
export function drumTrackChoices(meta: SongMeta): DrumTrackChoice[] {
  return meta.tracks.flatMap((t, i) =>
    (t.instrumentId === DRUM_INSTRUMENT_ID || /drum/i.test(t.instrument))
      ? [{ partId: i, name: t.name ?? '', instrument: t.instrument, views: t.views, popular: i === meta.popularTrackDrum }]
      : []);
}

/**
 * Resolve which drum track to use. Priority: explicit `track` index > URL
 * `t`-selector > `trackName` substring > the song's canonical `popularTrackDrum`
 * > the first drum track. Returns the partId plus whether the choice was
 * ambiguous (>1 drum track and nothing disambiguated it), so the caller can
 * surface the options instead of silently picking.
 */
export function selectDrumTrack(
  meta: SongMeta,
  opts: { track?: number; trackId?: number; trackName?: string } = {},
): { partId: number; ambiguous: boolean; choices: DrumTrackChoice[] } {
  const choices = drumTrackChoices(meta);
  if (choices.length === 0) throw new Error(`no drum track in "${meta.title}" by ${meta.artist}`);

  if (opts.track !== undefined) return { partId: opts.track, ambiguous: false, choices };
  if (opts.trackId !== undefined) return { partId: opts.trackId, ambiguous: false, choices };
  if (opts.trackName !== undefined) {
    const want = opts.trackName.toLowerCase();
    const hit = choices.find((c) => c.name.toLowerCase().includes(want) || c.instrument.toLowerCase().includes(want));
    if (!hit) throw new Error(`no drum track matching "${opts.trackName}". Names: ${choices.map((c) => `${c.partId}:"${c.name}"`).join(', ')}`);
    return { partId: hit.partId, ambiguous: false, choices };
  }
  if (choices.length === 1) return { partId: choices[0].partId, ambiguous: false, choices };
  const popular = choices.find((c) => c.popular);
  return { partId: popular ? popular.partId : choices[0].partId, ambiguous: true, choices };
}

// ── Network ──────────────────────────────────────────────────────────

/** Search Songsterr by "artist title"; returns the top hits (songId/title/artist). */
export async function searchSongsterr(query: string): Promise<SearchHit[]> {
  const res = await fetch(`https://www.songsterr.com/api/songs?pattern=${encodeURIComponent(query)}`, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`Songsterr search failed (${res.status}) for "${query}"`);
  const arr = (await res.json()) as { songId: number; title: string; artist: string }[];
  return (Array.isArray(arr) ? arr : []).map((s) => ({ songId: s.songId, title: s.title, artist: s.artist }));
}

async function fetchMeta(songId: number): Promise<SongMeta> {
  const res = await fetch(`https://www.songsterr.com/api/meta/${songId}`, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`meta fetch failed (${res.status}) for song ${songId}`);
  const j = (await res.json()) as SongMeta;
  if (!j.revisionId || !j.image || !Array.isArray(j.tracks)) throw new Error('meta response missing revisionId/image/tracks');
  return j;
}

/** Fetch a part JSON, robust to whether the runtime auto-inflated the gzip.
 *  (Node's fetch transparently decompresses `Content-Encoding: gzip`, so the
 *  magic-byte check is a fallback for non-fetch callers / future runtimes.) */
async function fetchPart(songId: number, revisionId: number, image: string, partId: number): Promise<DrumPart> {
  const path = `/${songId}/${revisionId}/${image}/${partId}.json`;
  let lastErr: unknown;
  for (const cdn of [PRIMARY_CDN, FALLBACK_CDN]) {
    try {
      const res = await fetch(cdn + path, { headers: BROWSER_HEADERS });
      if (!res.ok) { lastErr = new Error(`${res.status} from ${cdn}`); continue; }
      const buf = new Uint8Array(await res.arrayBuffer());
      const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
      const text = isGzip ? gunzipSync(buf).toString('utf8') : Buffer.from(buf).toString('utf8');
      return JSON.parse(text) as DrumPart;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`part ${partId} fetch failed on both CDNs: ${String(lastErr)}`);
}

/**
 * Full 3-hop fetch: input (URL / id) → meta → drum part → flattened track.
 * Honors a URL `t`-selector; `opts.track` / `opts.trackName` override.
 */
export async function fetchSongsterrDrums(input: string, opts: { track?: number; trackName?: string } = {}): Promise<SongsterrFetched> {
  const { songId, trackId } = parseSongRef(input);
  const meta = await fetchMeta(songId);
  const { partId, choices } = selectDrumTrack(meta, { track: opts.track, trackId, trackName: opts.trackName });
  if (meta.tracks[partId] === undefined) throw new Error(`track ${partId} out of range (song has ${meta.tracks.length} tracks)`);
  const part = await fetchPart(songId, meta.revisionId, meta.image, partId);
  return {
    songId, revisionId: meta.revisionId, title: meta.title, artist: meta.artist,
    drumTracks: choices, selectedPartId: partId, part, flat: flattenSongsterrDrums(part),
  };
}
