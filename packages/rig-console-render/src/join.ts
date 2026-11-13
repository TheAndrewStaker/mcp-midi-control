/**
 * join.ts: the pure half of the console's source handling: parse a setlist
 * table out of markdown, and JOIN the setlist against the card capture.
 *
 * WHY THE JOIN IS THE POINT. The setlist carries a hand-maintained `Built?`
 * column that its own notes admit "was originally inferred and was WRONG three
 * times". This module never reads that column to decide anything. Build state
 * is COMPUTED from the capture: a song is built if the roster places song-kind
 * projects for it and those slots are occupied in the capture. That is the
 * design's own rule ("build state lives on the Song and is read through, never
 * restated on a setlist entry") made mechanical.
 *
 * NOTHING IS SILENTLY DROPPED. A setlist row that matches no card entry, and a
 * card song absent from the setlist, are both reported as such. A join that
 * quietly loses a row reads as "your rig is fine" when it is not.
 *
 * The DISK loaders (find the newest capture, read the setlist file) stay
 * script-side in `scripts/_lib/console-sources.ts`, where the gitignored
 * maintainer data lives; everything here takes its inputs as values.
 */
import type { BuildClaim, ConsoleCard, ConsoleSlot, ConsoleSong, ConsoleVoice, SetlistEntry, SongJoin } from './types.js';

// ─── setlist parsing ────────────────────────────────────────────────────────

function readClaim(cell: string): BuildClaim | undefined {
  const t = cell.toLowerCase().trim();
  if (t === '' || t === '-' || t === '?') return undefined;
  if (/^no\b|not built|absent/.test(t)) return 'no';
  if (/^yes\b|built|done|^y$/.test(t)) return 'yes';
  return 'unclear';
}

/**
 * Parse the FIRST pipe table under an `## The order` heading (or the first
 * table in the file) for position / song / artist / build claim.
 */
export function parseSetlist(md: string): SetlistEntry[] {
  const lines = md.split(/\r?\n/);
  const entries: SetlistEntry[] = [];
  let header: string[] | undefined;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('|')) { if (header !== undefined && entries.length > 0) break; continue; }
    const cells = t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (header === undefined) { header = cells.map((c) => c.toLowerCase()); continue; }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const idx = (...names: string[]): number => header!.findIndex((h) => names.some((n) => h.includes(n)));
    const iNum = idx('#');
    const iSong = idx('song', 'title');
    const iArtist = idx('artist');
    const title = (iSong >= 0 ? cells[iSong] : cells[1] ?? '').replace(/\*\*/g, '').trim();
    if (title === '') continue;
    // `built` must not match `ear-checked`, and after a sync the legacy column
    // is gone entirely, so both are looked up independently and either may be
    // absent.
    const iBuilt = header.findIndex((h) => /built|^done/.test(h) && !h.includes('ear'));
    const iEar = idx('ear');
    const num = Number.parseInt(iNum >= 0 ? cells[iNum] : '', 10);
    const claimText = iBuilt >= 0 ? cells[iBuilt] : '';
    const ear = iEar >= 0 ? cells[iEar] : '';
    entries.push({
      position: Number.isFinite(num) ? num : entries.length + 1,
      title,
      artist: iArtist >= 0 && cells[iArtist] !== '' ? cells[iArtist] : undefined,
      claim: readClaim(claimText),
      claim_text: claimText !== '' ? claimText : undefined,
      ear_checked: ear !== '' && ear !== '?' ? ear : undefined,
    });
  }
  return entries;
}

// ─── pack helpers ───────────────────────────────────────────────────────────

/** Collapse a pack's free slots into contiguous runs; a list of blanks answers nothing. */
export function freeRuns(slots: ConsoleSlot[]): { from: number; to: number }[] {
  const runs: { from: number; to: number }[] = [];
  let start: number | undefined;
  for (let i = 1; i <= slots.length + 1; i++) {
    const free = slots[i - 1]?.occupied === false;
    if (free && start === undefined) start = i;
    if (!free && start !== undefined) { runs.push({ from: start, to: i - 1 }); start = undefined; }
  }
  return runs;
}

// ─── the join ───────────────────────────────────────────────────────────────

/**
 * Join key. The two sources spell the same song differently: the setlist
 * carries `Song Title (feat. Guest)` and `A Song in a Long Title`
 * where the roster has `Song Title` and `A Song In A Long Title`. Case,
 * featured artists, and punctuation are therefore all normalised away, and
 * nothing else is: a fuzzier key would start matching songs that are not the
 * same song.
 */
export function songKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\((feat|ft)\.?[^)]*\)/g, '')
    .replace(/\b(feat|ft)\.?\s.*$/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Markers worth raising to the song row. See {@link ConsoleSong.alerts}. */
const SONG_LEVEL_MARKERS = new Set(['CORRUPT', 'NAME MISMATCH', 'NOT IN THE CAPTURE', 'NAME SHARED', 'UNCLASSIFIED']);

/** `[1,2,3,5]` -> `1-3, 5`. */
function collapse(nums: number[]): string {
  const s = [...nums].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return parts.join(', ');
}

function whereText(slots: ConsoleSlot[]): string {
  const byPack = new Map<number, number[]>();
  for (const s of slots) byPack.set(s.pack, [...(byPack.get(s.pack) ?? []), s.slot]);
  return [...byPack.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([p, ns]) => `Pack ${p} project${ns.length === 1 ? '' : 's'} ${collapse(ns)}`)
    .join(' · ');
}

/**
 * Join the setlist against the card. Setlist order wins; card-only songs are
 * appended, flagged, so the panel is a superset of both sources rather than an
 * intersection that silently loses whichever side is behind.
 */
export function joinSongs(setlist: SetlistEntry[], card: ConsoleCard | undefined): SongJoin {
  const byKey = new Map<string, ConsoleSlot[]>();
  for (const pack of card?.packs ?? []) {
    for (const s of pack.slots) {
      if (s.kind !== 'song' || s.song === undefined) continue;
      const k = songKey(s.song);
      byKey.set(k, [...(byKey.get(k) ?? []), s]);
    }
  }

  const build = (entry: SetlistEntry | undefined, title: string, artist: string | undefined, position: number | undefined, slots: ConsoleSlot[]): ConsoleSong => {
    const placed = slots.filter((s) => s.occupied);
    const onCard = placed.length > 0;
    const disagreement = entry?.claim === 'no' && onCard ? 'stale_claim' as const
      : entry?.claim === 'yes' && !onCard ? 'missing' as const
        : undefined;
    // A slot the device was re-tempoed on after the capture reports the written
    // value, not the captured byte; the captured byte is knowably stale there.
    const tempos = [...new Set(placed.map((s) => s.tempo_post_capture ?? s.tempo).filter((t): t is number => t !== undefined))];
    return {
      position,
      title,
      artist: artist ?? slots.find((s) => s.artist !== undefined)?.artist,
      doc: slots.find((s) => s.doc !== undefined)?.doc,
      slots: [...slots].sort((a, b) => a.pack - b.pack || a.slot - b.slot),
      where: whereText(placed),
      tempo: tempos.length === 1 ? tempos[0] : undefined,
      tempo_disagreement: tempos.length > 1 ? tempos.sort((a, b) => a - b) : undefined,
      on_card: onCard,
      project_count: placed.length,
      claim: entry?.claim,
      claim_text: entry?.claim_text,
      ear_checked: entry?.ear_checked,
      disagreement,
      alerts: [...new Set(placed.flatMap((s) => s.markers))].filter((m) => SONG_LEVEL_MARKERS.has(m)),
      hazards: [...new Set(placed.map((s) => s.hazard).filter((h): h is string => h !== undefined))],
    };
  };

  const used = new Set<string>();
  const songs: ConsoleSong[] = [];
  const unplaced: SetlistEntry[] = [];
  for (const e of setlist) {
    const k = songKey(e.title);
    const slots = byKey.get(k);
    if (slots === undefined) unplaced.push(e);
    else used.add(k);
    songs.push(build(e, e.title, e.artist, e.position, slots ?? []));
  }

  const notInSetlist: string[] = [];
  for (const [k, slots] of byKey) {
    if (used.has(k)) continue;
    const title = slots[0].song ?? k;
    notInSetlist.push(title);
    songs.push(build(undefined, title, undefined, undefined, slots));
  }

  return { songs, unplaced, not_in_setlist: notInSetlist.sort() };
}

/**
 * The shape of one song's entry in the mapping registry
 * (docs/_private/rig/song-mappings.json `songs[]`), as far as the console
 * reads it. The registry carries more (assignments[], provenance); the
 * console's voices panel only needs the stored-content claims.
 */
export interface VoiceMappingEntry {
  song: string;
  claims?: Array<{
    device: string;
    pack?: number;
    slot?: string | number;
    expected_name?: string;
    role?: string;
    status?: string;
  }>;
}

/**
 * Attach the registry's per-song voice claims onto an existing join, matched
 * by songKey (same case-insensitive key the card join uses). Mutates the
 * join's songs in place and returns how many songs matched — songs without
 * claims keep `voices` undefined, which the panel reports as "not filed yet"
 * rather than hiding.
 */
export function attachVoices(join: SongJoin, mappings: VoiceMappingEntry[]): number {
  const byKey = new Map<string, ConsoleVoice[]>();
  for (const m of mappings) {
    const voices: ConsoleVoice[] = (m.claims ?? []).map((c) => ({
      device: c.device,
      // Circuit claims address a pack+slot pair; instrument claims a bare
      // front-panel location. One display string either way.
      slot: c.pack !== undefined ? `P${c.pack}·${c.slot}` : String(c.slot ?? ''),
      name: c.expected_name,
      role: c.role,
      status: c.status,
    }));
    if (voices.length > 0) byKey.set(songKey(m.song), voices);
  }
  let matched = 0;
  const claimed = new Set<string>();
  for (const s of join.songs) {
    const v = byKey.get(songKey(s.title));
    if (v !== undefined) { s.voices = v; claimed.add(songKey(s.title)); matched += 1; }
  }
  const unmatched = mappings
    .filter((m) => byKey.has(songKey(m.song)) && !claimed.has(songKey(m.song)))
    .map((m) => m.song);
  if (unmatched.length > 0) join.voices_unmatched = unmatched;
  return matched;
}
