/**
 * Songsterr part fetch: the network front-end for the import path.
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
 * The fetch itself is INSTRUMENT-AGNOSTIC: hop 3 pulls whichever part index it
 * is handed, drum or melodic, which is why the entry point is
 * `fetchSongsterrPart` and not the older drum-shaped name (kept as an alias).
 * The layer below now has BOTH readings: `flattenSongsterrDrums` reads each
 * note's `fret` as a General-MIDI percussion number, and
 * `flattenSongsterrMelodic` reads `tuning[string] + fret` as a pitch. Which one
 * a part wants is decided by `isMelodic` here, off the part's own top-level
 * `tuning` array, so no extra hop and no instrument-name guessing.
 *
 * `flat` is the DRUM reading and is produced for every part: its events are
 * meaningful only for a drum part, but its measures / sections / tempo map are
 * correct either way (they come from the shared measure walk), which is what the
 * roster and discovery replies need.
 *
 * Read-only: it only GETs public endpoints. The track-selection + ref-parse
 * logic is split out as PURE functions (`parseSongRef`, `trackChoices`,
 * `selectDrumTrack`) so they are unit-testable without a network.
 */

import { gunzipSync } from 'node:zlib';
import { flattenSongsterrDrums, isMelodicPart, type SongsterrPart, type SongsterrFlat } from './songsterr.js';

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

/**
 * One part of a song, drum or otherwise. The general counterpart to
 * `DrumTrackChoice`, which only ever lists drum parts and therefore made the
 * rest of a song's tracks invisible to a caller.
 */
export interface TrackChoice {
  /** Index into `meta.tracks`; this is the value to pass as `track`. */
  partId: number;
  /** Contributor-supplied name, often empty. */
  name: string;
  /** General MIDI instrument name, e.g. "Synth Bass 1", "Lead 1 (square)". */
  instrument: string;
  instrumentId: number;
  isDrums: boolean;
  isEmpty?: boolean;
}

/**
 * The roster-only result of hops 1-2: what parts does this song have?
 *
 * Deliberately does NOT carry part data, so a caller can ask the discovery
 * question ("what is on this tab?") for the cost of one meta GET and without
 * committing to a track. It is also the ONLY shape that survives a song with no
 * drum track at all, which `fetchSongsterrPart`'s default path refuses.
 */
export interface SongsterrTrackList {
  songId: number;
  revisionId: number;
  title: string;
  artist: string;
  /** Every part in the song, in `meta.tracks` order. */
  allTracks: TrackChoice[];
  /** The drum subset, with the `popular` flag. A convenience view of `allTracks`. */
  drumTracks: DrumTrackChoice[];
  /** The `t`-selector from the input ref, if it carried one. */
  urlTrackId?: number;
}

export interface SongsterrFetched {
  songId: number;
  revisionId: number;
  title: string;
  artist: string;
  /** Every drum track (a song may have several: acoustic vs programmed). */
  drumTracks: DrumTrackChoice[];
  /**
   * EVERY track in the song, drum and melodic alike, with the `partId` to pass
   * back as `track`. This is the roster to show a user before choosing.
   *
   * It exists because `drumTracks` alone hid the melodic parts, which made this
   * fetcher look drum-only when it has always been able to import any part.
   */
  allTracks: TrackChoice[];
  /** The track this fetch resolved to (honoring t-selector / track / track_name / popular). */
  selectedPartId: number;
  /** The raw part (for windowing via importSongsterrDrums / importSongsterrMelodic). */
  part: SongsterrPart;
  /**
   * The DRUM flattening (events + sections + tempos + measures). Its `events`
   * are only musical for a drum part; its measures / sections / tempo map are
   * correct for any part. Check `isMelodic` before reading the events.
   */
  flat: SongsterrFlat;
  /**
   * This part stores PITCHED notes (it carries its own open-string `tuning`),
   * so it wants `importSongsterrMelodic`, not the GM-percussion reading.
   */
  isMelodic: boolean;
}

// ── Pure helpers (unit-testable, no network) ─────────────────────────

/**
 * Parse a Songsterr URL (…-s1467797t11) or bare id (1467797 / 1467797t11 /
 * s1467797 / s1467797t11). The s-prefixed bare form is accepted because it is
 * how Songsterr's own URLs spell the id and therefore how every doc in this
 * repo records one ("source: s6700"); rejecting it made the docs' canonical
 * spelling fail at the CLI (2026-07-29).
 */
export function parseSongRef(input: string): { songId: number; trackId?: number } {
  const m = input.match(/-s(\d+)(?:t(\d+))?\b/)
    ?? input.match(/^s?(\d+)(?:t(\d+))?$/i);
  if (!m) throw new Error(`Could not extract a song id from "${input}" (expected a …-s12345 URL or a bare id like 1467797 / s1467797 / 1467797t11).`);
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
 * Every track in the song, in `meta.tracks` order. Pure.
 *
 * Prefer this over `drumTrackChoices` whenever the caller might want a melodic
 * part, which is most of the time: bass, organ, piano and vocal-lead parts are
 * all importable by passing the returned `partId` as `track`.
 */
export function trackChoices(meta: SongMeta): TrackChoice[] {
  return meta.tracks.map((t, i) => ({
    partId: i,
    name: t.name ?? '',
    instrument: t.instrument,
    instrumentId: t.instrumentId,
    isDrums: t.instrumentId === DRUM_INSTRUMENT_ID || /drum/i.test(t.instrument),
    ...(t.isEmpty === true ? { isEmpty: true } : {}),
  }));
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

  // EXPLICIT selectors win before the drum-track requirement is enforced, and
  // the order matters. This function resolves ANY part, not only a drum one:
  // `fetchPart` is instrument-agnostic, so passing `track` or `trackId` is how
  // a bass, organ, piano or vocal-lead part gets imported, and that is already
  // how melodic parts have been mapped.
  //
  // Throwing "no drum track" ahead of these made a song with NO drum track
  // unimportable even when the caller had named the exact part they wanted,
  // which is a failure that reads as "this tool cannot do melodic parts" when
  // in fact it can. The drum requirement only belongs on the DEFAULT path,
  // where a drum track is genuinely what is being guessed at.
  if (opts.track !== undefined) return { partId: opts.track, ambiguous: false, choices };
  if (opts.trackId !== undefined) return { partId: opts.trackId, ambiguous: false, choices };

  if (choices.length === 0) throw new Error(`no drum track in "${meta.title}" by ${meta.artist}`);
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
async function fetchPart(songId: number, revisionId: number, image: string, partId: number): Promise<SongsterrPart> {
  const path = `/${songId}/${revisionId}/${image}/${partId}.json`;
  let lastErr: unknown;
  for (const cdn of [PRIMARY_CDN, FALLBACK_CDN]) {
    try {
      const res = await fetch(cdn + path, { headers: BROWSER_HEADERS });
      if (!res.ok) { lastErr = new Error(`${res.status} from ${cdn}`); continue; }
      const buf = new Uint8Array(await res.arrayBuffer());
      const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
      const text = isGzip ? gunzipSync(buf).toString('utf8') : Buffer.from(buf).toString('utf8');
      return JSON.parse(text) as SongsterrPart;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`part ${partId} fetch failed on both CDNs: ${String(lastErr)}`);
}

/**
 * Hops 1-2 ONLY: input (URL / id) → meta → the song's full track roster.
 *
 * No part JSON is downloaded, nothing is selected, and no drum track is
 * required, so this answers "what parts does this song have?" for a song of any
 * shape (including one with no drums). Pass a returned `partId` back as
 * `fetchSongsterrPart`'s `track` to pull that part.
 */
export async function fetchSongsterrTracks(input: string): Promise<SongsterrTrackList> {
  const { songId, trackId } = parseSongRef(input);
  const meta = await fetchMeta(songId);
  return {
    songId,
    revisionId: meta.revisionId,
    title: meta.title,
    artist: meta.artist,
    allTracks: trackChoices(meta),
    drumTracks: drumTrackChoices(meta),
    ...(trackId !== undefined ? { urlTrackId: trackId } : {}),
  };
}

/**
 * Full 3-hop fetch: input (URL / id) → meta → part → flattened track.
 * Honors a URL `t`-selector; `opts.track` / `opts.trackName` override.
 *
 * The part is whichever index resolves, drum or melodic. `flat` is produced by
 * the GM-percussion flattener, so treat its events as musical only for a drum
 * part (see the module header); `isMelodic` says which reading the part wants.
 */
export async function fetchSongsterrPart(input: string, opts: { track?: number; trackName?: string } = {}): Promise<SongsterrFetched> {
  const { songId, trackId } = parseSongRef(input);
  const meta = await fetchMeta(songId);
  const all = trackChoices(meta);
  // A name should resolve against EVERY part, not just the drum ones. Matching
  // only drum choices meant `trackName: 'organ'` failed on a song that has an
  // organ track, which is the exact case this fetcher is meant to serve.
  let named: number | undefined;
  if (opts.trackName !== undefined) {
    const want = opts.trackName.toLowerCase();
    named = all.find((c) => c.name.toLowerCase().includes(want) || c.instrument.toLowerCase().includes(want))?.partId;
    if (named === undefined) {
      throw new Error(
        `no track matching "${opts.trackName}" in "${meta.title}". Tracks: `
        + all.map((c) => `${c.partId}:"${c.instrument}"${c.name ? ` (${c.name})` : ''}`).join(', '),
      );
    }
  }
  const { partId, choices } = selectDrumTrack(meta, {
    track: opts.track ?? named, trackId, trackName: undefined,
  });
  if (meta.tracks[partId] === undefined) throw new Error(`track ${partId} out of range (song has ${meta.tracks.length} tracks)`);
  const part = await fetchPart(songId, meta.revisionId, meta.image, partId);
  return {
    songId, revisionId: meta.revisionId, title: meta.title, artist: meta.artist,
    drumTracks: choices, allTracks: all, selectedPartId: partId, part,
    flat: flattenSongsterrDrums(part), isMelodic: isMelodicPart(part),
  };
}

/**
 * Back-compat alias for `fetchSongsterrPart`.
 *
 * The old name said "drums" about a function that has always fetched whichever
 * part it was pointed at, and reading it as a constraint is exactly how a later
 * session concluded this path was drum-only. Kept so no caller breaks; prefer
 * `fetchSongsterrPart` in new code.
 */
export const fetchSongsterrDrums = fetchSongsterrPart;
