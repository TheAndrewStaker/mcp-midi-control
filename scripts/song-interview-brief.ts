/**
 * Song-interview briefing skeleton generator.
 *
 * `docs/_private/rig/SONG-INTERVIEW-SCHEMA.md` demands that EVERY number in an
 * interview briefing be GENERATED, never estimated, yet the first three
 * briefings (Pneuma, Redbone, Schism) were hand-assembled from separate runs of
 * the fetcher, `songChop`, `song-superset.ts` and one-off passes. This script
 * generates the schema's Section 1 to Section 4 skeleton in one run, so an
 * interview costs the maintainer judgement, not table assembly.
 *
 * WHAT IT EMITS (mirrors the schema's section names exactly)
 *   Section 1: the whole-song briefing  (Source / Shape / Cost / Grid loss /
 *              Density / Playability)
 *   Section 2: squash proposals         (Merge / Loop / Trim, ranked, never
 *              merged into one list; a Trim always names its musical cost)
 *   Section 3: the default mapping      (destinations from the rig, part
 *              assignments LEFT BLANK: the script never guesses a musical
 *              assignment)
 *   Section 4: the per-part question block (one block per authored project,
 *              fixed four headings, at most ONE choice per block, deep links
 *              per the schema's verified rules)
 *
 * WHAT IT DOES NOT DO
 *   - answer anything (every ANSWER slot is blank),
 *   - assign parts to tracks,
 *   - touch a device or write anywhere except stdout / the named output file.
 *
 * ANALYSIS PROVENANCE: the chop is `planSongChop` (songChop.ts) with EXPLICIT
 * options (never defaults, so a default change elsewhere cannot move a number
 * here); the superset/density analysis is `scripts/_lib/song-superset-core.ts`,
 * factored verbatim from `scripts/song-superset.ts`. Nothing is reimplemented.
 *
 * DETERMINISM: same input, same output, byte for byte. The only date in the
 * output is the one passed via --date. A briefing fetched live and saved with
 * --save-cache regenerates byte-identically offline via --cached.
 *
 * Usage:
 *   npx tsx scripts/song-interview-brief.ts <url-or-id>
 *     [--revision N]        pin: refuse when the source resolves to a different revision
 *     [--parts a,b,c]       parts the RIG would sequence (chop + superset selection; default: all)
 *     [--mine a,b]          the maintainer's own part ids (playability block + "your X" links)
 *     [--cached DIR]        offline: read meta.json + part-<id>.json from DIR, no network
 *     [--save-cache DIR]    after a live fetch, write meta.json + part-<id>.json to DIR
 *     [--steps-per-beat 4]  grid resolution (4 = 16ths)
 *     [--date YYYY-MM-DD]   header date (absolute; the ONLY timestamp in the output)
 *     [--manifest PATH]     card backup manifest for the free-space line
 *     [--slug NAME]         output filename slug (default: derived from the title)
 *     [--write]             write docs/_private/rig/songs/<slug>-interview.md
 *                           (REFUSES to overwrite an existing interview: those
 *                           files carry the maintainer's answers)
 *
 * Read-only against the world: network GETs Songsterr's public JSON, reads the
 * local card-backup manifest, and writes at most one NEW markdown file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  flattenSongsterrDrums, pitchToken, unmappedSummary,
  type MeasureInfo, type SongsterrPart, type TempoMark,
} from '@mcp-midi-control/core/protocol-generic/patterns/songsterr.js';
import {
  planSongChop, toChopPart,
  type ChopPartFlat, type ChopProject, type SongChopPlan,
} from '@mcp-midi-control/core/protocol-generic/patterns/songChop.js';
import {
  fetchSongsterrPart, fetchSongsterrTracks, parseSongRef,
  type TrackChoice,
} from '@mcp-midi-control/core/protocol-generic/patterns/songsterrFetch.js';
import {
  buildPartWindow, buildWindows, census, classify, cover, dedupePairs, detectPeriod,
  measureOf, measureSteps, patternCensus, shortLabel, sigOf, windowEntropy,
  type Pair, type PartWindow, type Window,
} from './_lib/song-superset-core.js';

// ── CLI ──────────────────────────────────────────────────────────────

export interface Args {
  ref: string;
  revision?: number;
  parts?: number[];
  mine: number[];
  cached?: string;
  saveCache?: string;
  stepsPerBeat: number;
  date?: string;
  manifest: string;
  slug?: string;
  write: boolean;
}

const DEFAULT_MANIFEST = 'samples/circuit-ncs/card-backup-2026-07-29/manifest.json';
const OUT_DIR = 'docs/_private/rig/songs';
const SLOTS_PER_PACK = 64;
/** Tempo-mark drift threshold: a change under this fraction of the running bpm
 *  is the transcriber tracking a human performance, not a musical intent. */
const TEMPO_REAL_FRACTION = 0.10;

function usage(): never {
  console.error(
    'usage: npx tsx scripts/song-interview-brief.ts <url-or-id> [--revision N] [--parts a,b,c] '
    + '[--mine a,b] [--cached DIR] [--save-cache DIR] [--steps-per-beat 4] [--date YYYY-MM-DD] '
    + '[--manifest PATH] [--slug NAME] [--write]',
  );
  process.exit(1);
}

function parseArgs(argv: readonly string[]): Args {
  const ref = argv[0];
  if (ref === undefined || ref.startsWith('--')) usage();
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const ids = (s: string | undefined): number[] | undefined => {
    if (s === undefined) return undefined;
    const out = s.split(',').map((x) => Number(x.trim()));
    if (out.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`bad part-id list "${s}" (want e.g. 2,3,5)`);
    return out;
  };
  const revision = val('--revision');
  const date = val('--date');
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must be YYYY-MM-DD, got "${date}"`);
  return {
    ref,
    ...(revision !== undefined ? { revision: Number(revision) } : {}),
    ...(ids(val('--parts')) !== undefined ? { parts: ids(val('--parts'))! } : {}),
    mine: ids(val('--mine')) ?? [],
    ...(val('--cached') !== undefined ? { cached: val('--cached')! } : {}),
    ...(val('--save-cache') !== undefined ? { saveCache: val('--save-cache')! } : {}),
    stepsPerBeat: Number(val('--steps-per-beat') ?? 4),
    ...(date !== undefined ? { date } : {}),
    manifest: val('--manifest') ?? DEFAULT_MANIFEST,
    ...(val('--slug') !== undefined ? { slug: val('--slug')! } : {}),
    write: argv.includes('--write'),
  };
}

// ── source loading (live or cached) ──────────────────────────────────

export interface LoadedSong {
  songId: number;
  revisionId: number;
  title: string;
  artist: string;
  /** Every track in meta order, including empty ones. */
  tracks: TrackChoice[];
  /** Part JSON per partId; empty tracks are not fetched and have no entry. */
  raw: Map<number, SongsterrPart>;
}

/** meta.json shape written by --save-cache and read by --cached. */
interface CachedMeta { songId: number; revisionId: number; title: string; artist: string; allTracks: TrackChoice[] }

function loadCached(dir: string): LoadedSong {
  const metaPath = join(dir, 'meta.json');
  if (!existsSync(metaPath)) {
    throw new Error(
      `--cached ${dir}: no meta.json there. A cache dir needs meta.json + part-<id>.json; `
      + 'create one with a live run using --save-cache DIR.',
    );
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CachedMeta;
  const raw = new Map<number, SongsterrPart>();
  for (const t of meta.allTracks) {
    if (t.isEmpty === true) continue;
    const f = join(dir, `part-${t.partId}.json`);
    if (!existsSync(f)) throw new Error(`--cached ${dir}: missing ${f} for part ${t.partId} ("${t.instrument}").`);
    raw.set(t.partId, JSON.parse(readFileSync(f, 'utf8')) as SongsterrPart);
  }
  return { songId: meta.songId, revisionId: meta.revisionId, title: meta.title, artist: meta.artist, tracks: meta.allTracks, raw };
}

async function loadLive(ref: string, saveCache: string | undefined): Promise<LoadedSong> {
  const list = await fetchSongsterrTracks(ref);
  const raw = new Map<number, SongsterrPart>();
  for (const t of list.allTracks) {
    if (t.isEmpty === true) continue;
    const got = await fetchSongsterrPart(String(list.songId), { track: t.partId });
    if (got.revisionId !== list.revisionId) {
      throw new Error(
        `revision changed mid-fetch: roster is rev ${list.revisionId}, part ${t.partId} came back rev ${got.revisionId}. `
        + 'Re-run; if it persists the tab is being edited right now.',
      );
    }
    raw.set(t.partId, got.part);
  }
  if (saveCache !== undefined) {
    mkdirSync(saveCache, { recursive: true });
    const meta: CachedMeta = {
      songId: list.songId, revisionId: list.revisionId, title: list.title, artist: list.artist, allTracks: list.allTracks,
    };
    writeFileSync(join(saveCache, 'meta.json'), JSON.stringify(meta, null, 1));
    for (const [id, part] of raw) writeFileSync(join(saveCache, `part-${id}.json`), JSON.stringify(part));
  }
  return { songId: list.songId, revisionId: list.revisionId, title: list.title, artist: list.artist, tracks: list.allTracks, raw };
}

// ── small pure helpers ───────────────────────────────────────────────

const labelOfTrack = (t: TrackChoice): string => (t.name !== '' ? `${t.instrument} (${t.name})` : t.instrument);

function slugOf(title: string): string {
  const s = title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s === '' ? 'song' : s;
}

/** Run-length encode a list: ["5/8","7/8","7/8"] -> "5/8, 7/8 x2". */
function runLength(items: readonly string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < items.length) {
    let j = i;
    while (j + 1 < items.length && items[j + 1] === items[i]) j++;
    const n = j - i + 1;
    out.push(n > 1 ? `${items[i]} x${n}` : items[i]);
    i = j + 1;
  }
  return out.join(', ');
}

/** 0-based bar flags -> "m3-6, m8-10" (displayed, 1-based). */
function barRanges(flags: readonly boolean[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < flags.length) {
    if (!flags[i]) { i++; continue; }
    let j = i;
    while (j + 1 < flags.length && flags[j + 1]) j++;
    out.push(i === j ? `m${i + 1}` : `m${i + 1}-${j + 1}`);
    i = j + 1;
  }
  return out.join(', ');
}

function mmss(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Quarter-note beats one measure spans. */
const measureBeats = (m: MeasureInfo): number => (m.signature[0] * 4) / m.signature[1];

/**
 * Duration in seconds, integrated over the tab's own tempo map: each span
 * between tempo marks runs at that mark's bpm. Songsterr writes marks at beat
 * offsets; beats before the first mark run at the first mark's bpm (a tab that
 * carries no mark at all integrates at 120, and the caller says so).
 */
function integrateDuration(totalBeats: number, tempos: readonly TempoMark[]): { seconds: number; assumed120: boolean } {
  if (tempos.length === 0) return { seconds: (totalBeats * 60) / 120, assumed120: true };
  const marks = [...tempos].sort((a, b) => a.beat - b.beat);
  let seconds = 0;
  let atBeat = 0;
  let bpm = marks[0].bpm;
  for (const m of marks) {
    const upTo = Math.min(Math.max(m.beat, 0), totalBeats);
    if (upTo > atBeat) seconds += ((upTo - atBeat) * 60) / bpm;
    atBeat = Math.max(atBeat, upTo);
    bpm = m.bpm;
  }
  if (totalBeats > atBeat) seconds += ((totalBeats - atBeat) * 60) / bpm;
  return { seconds, assumed120: false };
}

/** Split tempo marks into REAL changes and transcription drift (see TEMPO_REAL_FRACTION). */
function tempoSplit(tempos: readonly TempoMark[]): { real: TempoMark[]; drift: TempoMark[] } {
  const real: TempoMark[] = [];
  const drift: TempoMark[] = [];
  const marks = [...tempos].sort((a, b) => a.beat - b.beat);
  for (let i = 1; i < marks.length; i++) {
    const prev = marks[i - 1].bpm;
    const frac = prev === 0 ? 1 : Math.abs(marks[i].bpm - prev) / prev;
    (frac >= TEMPO_REAL_FRACTION ? real : drift).push(marks[i]);
  }
  return { real, drift };
}

/** Most frequent bpm among marks (tie: lower bpm). Deterministic. */
function modalBpm(marks: readonly TempoMark[]): number | undefined {
  if (marks.length === 0) return undefined;
  const freq = new Map<number, number>();
  for (const m of marks) freq.set(m.bpm, (freq.get(m.bpm) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

/** Per-measure onset counts + first/last sounding bar for one part. */
function occupancyOf(p: ChopPartFlat, measures: readonly MeasureInfo[]): {
  counts: number[]; first?: number; last?: number; sounding: number;
} {
  const counts = Array.from({ length: measures.length }, () => 0);
  for (const o of p.onsets) {
    const mi = measureOf(measures, o.beat);
    if (mi >= 0 && mi < measures.length) counts[mi]++;
  }
  let first: number | undefined;
  let last: number | undefined;
  let sounding = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] === 0) continue;
    sounding++;
    if (first === undefined) first = i + 1;
    last = i + 1;
  }
  return { counts, ...(first !== undefined ? { first } : {}), ...(last !== undefined ? { last } : {}), sounding };
}

// ── card manifest ────────────────────────────────────────────────────

interface CardManifest { packs?: { device_pack: number; pack_name: string; projects_occupied: number }[] }

function cardFreeSpace(path: string): {
  found: boolean; totalSlots: number; occupied: number; free: number;
  largest: { free: number; pack: number; name: string } | undefined; perPack: string;
} {
  if (!existsSync(path)) return { found: false, totalSlots: 0, occupied: 0, free: 0, largest: undefined, perPack: '' };
  const m = JSON.parse(readFileSync(path, 'utf8')) as CardManifest;
  const packs = m.packs ?? [];
  const totalSlots = packs.length * SLOTS_PER_PACK;
  const occupied = packs.reduce((s, p) => s + p.projects_occupied, 0);
  let largest: { free: number; pack: number; name: string } | undefined;
  for (const p of packs) {
    const free = SLOTS_PER_PACK - p.projects_occupied;
    if (largest === undefined || free > largest.free) largest = { free, pack: p.device_pack, name: p.pack_name };
  }
  const perPack = packs.map((p) => `pack ${p.device_pack} "${p.pack_name}" ${SLOTS_PER_PACK - p.projects_occupied} free`).join('; ');
  return { found: true, totalSlots, occupied, free: totalSlots - occupied, largest, perPack };
}

// ── briefing assembly ────────────────────────────────────────────────

interface RosterRow {
  t: TrackChoice;
  label: string;
  onsets: number;
  first?: number;
  last?: number;
  sounding: number;
  range: string;
  offGrid: number;
  dynamics: number;
  unmapped: number;
  unmappedDetail: string;
}

export function buildBriefing(song: LoadedSong, args: Args): string {
  const spb = args.stepsPerBeat;
  const link = (partId: number, m: number): string => `https://www.songsterr.com/a/wsa/s${song.songId}t${partId}?measure=${m}`;

  // ── parts, chop, superset ─────────────────────────────────────────
  const fetchedTracks = song.tracks.filter((t) => song.raw.has(t.partId));
  const allChop: ChopPartFlat[] = fetchedTracks.map((t) => toChopPart(t.partId, labelOfTrack(t), song.raw.get(t.partId)!));
  const chopById = new Map(allChop.map((p) => [p.partId, p]));

  const selectedIds = args.parts ?? fetchedTracks.map((t) => t.partId);
  const missing = selectedIds.filter((id) => !chopById.has(id));
  if (missing.length > 0) throw new Error(`--parts names part(s) not on this tab (or empty): ${missing.join(', ')}. Roster has ${fetchedTracks.map((t) => t.partId).join(', ')}.`);
  const selectedChop = selectedIds.map((id) => chopById.get(id)!);

  const mineMissing = args.mine.filter((id) => !chopById.has(id));
  if (mineMissing.length > 0) throw new Error(`--mine names part(s) not on this tab (or empty): ${mineMissing.join(', ')}.`);

  // EXPLICIT options on purpose: a briefing's numbers must not move when a
  // library default changes. Never call this with implied defaults.
  const plan: SongChopPlan = planSongChop(selectedChop, { stepsPerBeat: spb, patternSlots: 8, stepsPerPattern: 32 });

  // The measure walk the chop anchored on: the longest SELECTED part's (same
  // rule as song-superset.ts). The whole-song walk anchors on the longest
  // fetched part; on a well-formed tab the two are identical.
  const anchorOf = (parts: readonly ChopPartFlat[]): ChopPartFlat => {
    let a = parts[0];
    for (const p of parts) if (p.measures.length > a.measures.length) a = p;
    return a;
  };
  const measuresSel = anchorOf(selectedChop).measures;
  const anchorAll = anchorOf(allChop);
  const measuresAll = anchorAll.measures;

  const partsW: PartWindow[] = selectedChop.map((p) => buildPartWindow(p.partId, p.label, song.raw.get(p.partId)!, measuresSel, spb));
  const label = (id: number): string => partsW.find((p) => p.partId === id)?.label ?? chopById.get(id)?.label ?? `part ${id}`;
  const short = (id: number): string => shortLabel(label(id));
  const windows: Window[] = buildWindows(plan, partsW);
  const rawPairs: Pair[] = [];
  for (const subject of windows) {
    for (const c of windows) {
      const p = classify(subject, c, partsW, label);
      if (p !== undefined) rawPairs.push(p);
    }
  }
  const pairs = dedupePairs(rawPairs);
  const { authored, absorbed } = cover(windows, pairs);
  const cen = census(partsW, measuresSel.length);
  const uniformMetre = new Set(measuresSel.map(sigOf)).size === 1;
  const patCensus = uniformMetre ? patternCensus(partsW, 2) : undefined;
  const entropy = windowEntropy(partsW, windows);
  const chopByProject = new Map<number, ChopProject>(plan.projects.map((p) => [p.project, p]));

  // ── roster over ALL fetched parts ─────────────────────────────────
  const occAll = new Map<number, ReturnType<typeof occupancyOf>>();
  for (const p of allChop) occAll.set(p.partId, occupancyOf(p, measuresAll));
  const roster: RosterRow[] = fetchedTracks.map((t) => {
    const cp = chopById.get(t.partId)!;
    const occ = occAll.get(t.partId)!;
    const w = buildPartWindow(t.partId, cp.label, song.raw.get(t.partId)!, measuresAll, spb);
    let range = '';
    if (cp.melodic) {
      const pitches = cp.onsets.map((o) => o.pitch).filter((p): p is number => p !== undefined);
      if (pitches.length > 0) range = `${pitchToken(Math.min(...pitches))}-${pitchToken(Math.max(...pitches))}`;
    }
    let unmappedDetail = '';
    if (!cp.melodic && (cp.unmapped ?? 0) > 0) {
      unmappedDetail = unmappedSummary(flattenSongsterrDrums(song.raw.get(t.partId)!));
    }
    return {
      t, label: cp.label, onsets: cp.onsets.length,
      ...(occ.first !== undefined ? { first: occ.first } : {}),
      ...(occ.last !== undefined ? { last: occ.last } : {}),
      sounding: occ.sounding, range,
      offGrid: w.quantMoved, dynamics: w.velocityBlind,
      unmapped: cp.unmapped ?? 0, unmappedDetail,
    };
  });

  // ── shape ─────────────────────────────────────────────────────────
  const bars = measuresAll.length;
  const flatAnchor = flattenSongsterrDrums(song.raw.get(anchorAll.partId)!);
  const totalBeats = measuresAll.reduce((s, m) => s + measureBeats(m), 0);
  const dur = integrateDuration(totalBeats, flatAnchor.tempos);
  const sigHist = new Map<string, number>();
  for (const m of measuresAll) sigHist.set(sigOf(m), (sigHist.get(sigOf(m)) ?? 0) + 1);
  const sigRows = [...sigHist.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  let metreChanges = 0;
  for (let i = 1; i < measuresAll.length; i++) if (sigOf(measuresAll[i]) !== sigOf(measuresAll[i - 1])) metreChanges++;
  const stepHist = new Map<number, number>();
  for (const m of measuresAll) stepHist.set(measureSteps(m, spb), (stepHist.get(measureSteps(m, spb)) ?? 0) + 1);
  const stepRows = [...stepHist.entries()].sort((a, b) => a[0] - b[0]);
  // Section markers, unioned across ALL fetched parts (Songsterr writes them per
  // part and not always on every staff), first writer wins, same as the chop.
  const markerName = new Map<number, string>();
  for (const p of allChop) {
    for (const s of p.sections) {
      if (s.startMeasure >= 0 && s.startMeasure < bars && !markerName.has(s.startMeasure)) markerName.set(s.startMeasure, s.name);
    }
  }
  const markers = [...markerName.entries()].sort((a, b) => a[0] - b[0]);
  const tempos = flatAnchor.tempos;
  const { real: realMarks, drift: driftMarks } = tempoSplit(tempos);
  const flattenTo = modalBpm(driftMarks.length > 0 ? driftMarks : tempos);

  // ── grid loss over the SELECTED parts ─────────────────────────────
  const totalQuant = partsW.reduce((s, p) => s + p.quantMoved, 0);
  const totalOnsetsSel = selectedChop.reduce((s, p) => s + p.onsets.length, 0);
  const totalDyn = partsW.reduce((s, p) => s + p.velocityBlind, 0);
  const unmappedRows = roster.filter((r) => selectedIds.includes(r.t.partId) && r.unmapped > 0);
  const totalUnmapped = unmappedRows.reduce((s, r) => s + r.unmapped, 0);

  // ── playability over ALL fetched parts ────────────────────────────
  const playability: { id: number; alone: string; duo: string; aloneBars: number; duoBars: number }[] = args.mine.map((id) => {
    const aloneFlags = Array.from({ length: bars }, () => false);
    const duoFlags = Array.from({ length: bars }, () => false);
    for (let mi = 0; mi < bars; mi++) {
      if ((occAll.get(id)?.counts[mi] ?? 0) === 0) continue;
      const others = allChop.filter((p) => p.partId !== id && (occAll.get(p.partId)?.counts[mi] ?? 0) > 0).length;
      if (others === 0) aloneFlags[mi] = true;
      else if (others === 1) duoFlags[mi] = true;
    }
    return {
      id, alone: barRanges(aloneFlags), duo: barRanges(duoFlags),
      aloneBars: aloneFlags.filter(Boolean).length, duoBars: duoFlags.filter(Boolean).length,
    };
  });

  // ── cost ──────────────────────────────────────────────────────────
  const worst = [...plan.sections].sort((a, b) => b.patterns - a.patterns || a.from_measure - b.from_measure)[0];
  const card = cardFreeSpace(args.manifest);

  // ── squash material ───────────────────────────────────────────────
  const mergePairs = pairs.filter((p) => (p.verdict === 'IDENTICAL' || p.verdict === 'EXACT') && p.saves);
  const prefixPairs = pairs.filter((p) => p.verdict === 'PREFIX');
  const nearPairs = pairs.filter((p) => p.verdict === 'NEAR');
  const transposePairs = pairs.filter((p) => p.verdict === 'TRANSPOSE');
  const loops = windows.filter((w) => w.period !== undefined && w.period < w.bars);
  // Per-part loop cells: the same period detection run over ONE part at a time.
  // A window that does not loop as a whole often loops on a single part (the
  // Schism Verse 1 drums are an 8-bar cell inside a 12-bar window), and that is
  // a pattern-slot saving plus a "loop it or write it out?" question.
  const partLoops: { w: Window; partId: number; cell: number }[] = [];
  for (const w of windows) {
    for (const id of w.sounding) {
      const p = partsW.find((x) => x.partId === id)!;
      const cell = detectPeriod(w.from, w.to, [p]);
      if (cell !== undefined && cell < w.bars) partLoops.push({ w, partId: id, cell });
    }
  }
  const winOf = (n: number): Window => windows.find((w) => w.project === n)!;
  const at = (w: Window): string => `m${w.from + 1}-${w.to + 1}`;
  // Single-bar entries: a part that sounds in exactly ONE bar of a window is a
  // computable trim candidate with a nameable cost (the Schism P4 case: one bar
  // of synth entry costing a whole track's presence in the project).
  const singleBar: { w: Window; partId: number; bar: number }[] = [];
  for (const w of windows) {
    for (const p of partsW) {
      if (!w.sounding.includes(p.partId)) continue;
      let count = 0; let where = -1;
      for (let i = w.from; i <= w.to; i++) if (p.bars[i].body !== '') { count++; where = i; }
      if (count === 1) singleBar.push({ w, partId: p.partId, bar: where + 1 });
    }
  }

  // ── document ──────────────────────────────────────────────────────
  const L: string[] = [];
  const push = (...lines: string[]): void => { L.push(...lines); };

  const canonicalRun = [
    `npx tsx scripts/song-interview-brief.ts ${song.songId}`,
    `--revision ${song.revisionId}`,
    ...(args.parts !== undefined ? [`--parts ${args.parts.join(',')}`] : []),
    ...(args.mine.length > 0 ? [`--mine ${args.mine.join(',')}`] : []),
    ...(spb !== 4 ? [`--steps-per-beat ${spb}`] : []),
    ...(args.date !== undefined ? [`--date ${args.date}`] : []),
  ].join(' ');

  push(`# Interview briefing skeleton: ${song.artist}, ${song.title}`);
  push('');
  push('**Status: GENERATED SKELETON, nothing answered yet.** Every number below is generated by');
  push('`scripts/song-interview-brief.ts`; nothing is estimated. The mapping table and every `ANSWER:`');
  push('slot are blank on purpose: musical assignments belong to the maintainer, never to this script.');
  push('Follows [`SONG-INTERVIEW-SCHEMA.md`](../SONG-INTERVIEW-SCHEMA.md).');
  push('');
  push(`**Source:** \`s${song.songId}\`, revision \`${song.revisionId}\`. ${fetchedTracks.length} part(s), ${bars} bars${args.date !== undefined ? `, generated ${args.date}` : ''}.`);
  push('A re-fetch returning a different revision is a different source and this briefing no longer');
  push('applies to it.');
  push('');
  push(`Run: \`${canonicalRun}\``);
  if (args.parts !== undefined) {
    push('');
    push(`Chop, superset and density are computed over the selected parts (${selectedIds.map((i) => `t${i}`).join(', ')});`);
    push('the roster and playability cover every part on the tab.');
  }
  push('');
  push('---');
  push('');

  // ── Section 1 ─────────────────────────────────────────────────────
  push('## Section 1: the whole-song briefing');
  push('');
  push('### Source');
  push('');
  push('| Part | Instrument | Contributor name | Drums? | Notes | First | Last | Sounding bars | Range | Off-grid | Dynamic marks |');
  push('|---|---|---|---|---:|---:|---:|---:|---|---:|---:|');
  // Contributor names carry literal "|" separators; escape them or the row breaks.
  const cell = (s: string): string => s.replace(/\|/g, '\\|');
  for (const r of roster) {
    push(`| t${r.t.partId} | ${cell(r.t.instrument)} | ${r.t.name !== '' ? cell(r.t.name) : '(none)'} | ${r.t.isDrums ? 'yes' : 'no'} `
      + `| ${r.onsets} | ${r.first !== undefined ? `m${r.first}` : '-'} | ${r.last !== undefined ? `m${r.last}` : '-'} `
      + `| ${r.sounding} | ${r.range !== '' ? r.range : '-'} | ${r.offGrid} | ${r.dynamics} |`);
  }
  const emptyTracks = song.tracks.filter((t) => !song.raw.has(t.partId));
  if (emptyTracks.length > 0) {
    push('');
    push(`Empty on the tab (no content, not fetched): ${emptyTracks.map((t) => `t${t.partId} ${t.instrument}`).join(', ')}.`);
  }
  const unmappedRoster = roster.filter((r) => r.unmapped > 0);
  for (const r of unmappedRoster) {
    push('');
    push(`t${r.t.partId} ${shortLabel(r.label)}: ${r.unmapped} hit(s) on non-GM percussion numbers (${r.unmappedDetail}); they do not sound unless re-imported with a drum_map.`);
  }
  push('');
  push('Off-grid counts the onsets a '
    + `${spb === 4 ? '16th' : `${spb}-steps-per-quarter`} grid moves; dynamic marks are the ones the authored image cannot carry.`);
  push('');

  push('### Shape');
  push('');
  push('| | |');
  push('|---|---|');
  push(`| Bars | ${bars} |`);
  push(`| Quarter-beats | ${Number(totalBeats.toFixed(2))} |`);
  push(`| Duration (integrated over the tab's tempo map) | ${mmss(dur.seconds)}${dur.assumed120 ? ' (no tempo marks on the tab; 120 bpm assumed)' : ''} |`);
  push(`| Section markers | ${markers.length} |`);
  push(`| Distinct time signatures | ${sigRows.length} |`);
  push(`| Bar-to-bar metre changes | ${metreChanges} of ${bars} (${bars > 0 ? Math.round((metreChanges / bars) * 100) : 0}%) |`);
  push(`| Tempo marks | ${tempos.length}${tempos.length > 0 ? `, of which ${realMarks.length} ${realMarks.length === 1 ? 'is' : 'are'} real` : ''} |`);
  push('');
  push(`**Metre histogram:** ${sigRows.map(([sig, n]) => `\`${sig}\` x${n}`).join(', ')}.`);
  push('');
  push(`Stated the way the device sees it, in steps per bar at ${spb} steps/beat: ${stepRows.map(([s, n]) => `${s} x${n}`).join(', ')}.`);
  push('');
  if (markers.length > 0) {
    push(`Sections: ${markers.map(([mi, name]) => `m${mi + 1} ${name}`).join(' | ')}.`);
  } else {
    push('Sections: NONE on any part. The chop falls back to fixed-length windows; check the boundaries against the song before authoring.');
  }
  push('');
  if (tempos.length > 0) {
    push(`Tempo marks: ${[...tempos].sort((a, b) => a.beat - b.beat).map((t) => `m${t.measure + 1}=${t.bpm}`).join(', ')}.`);
    if (realMarks.length > 0) {
      push(`Real change(s) (a step of ${Math.round(TEMPO_REAL_FRACTION * 100)}% or more against the running tempo): `
        + `${realMarks.map((t) => `m${t.measure + 1} to ${t.bpm}`).join(', ')}. The rest is transcription drift.`);
    } else if (tempos.length > 1) {
      push(`No mark steps ${Math.round(TEMPO_REAL_FRACTION * 100)}% or more against the running tempo: every change is transcription drift.`);
    }
  }
  push('');

  push('### Cost');
  push('');
  push('| | |');
  push('|---|---|');
  push(`| Naive project count, section-aligned (planSongChop, explicit 8 patterns x 32 steps at ${spb} steps/beat) | ${plan.projects.length} |`);
  push(`| Bar-aligned patterns planned | ${plan.patterns_planned} |`);
  push(`| Distinct pattern lengths | ${plan.pattern_lengths.length} (${plan.pattern_lengths.join(', ')}) |`);
  push(`| Mixed metre | ${plan.ceiling.mixed_metre ? 'YES: the 8-pattern budget is the real constraint, not a bar count' : 'no: every bar is ' + plan.ceiling.signature} |`);
  if (worst !== undefined) {
    push(`| Worst single section | ${worst.name} (m${worst.from_measure}-${worst.to_measure}): ${worst.bars} bars, ${worst.patterns} bar-aligned pattern(s), ${worst.projects} project(s)${worst.over_ceiling ? ', OVER the one-project ceiling' : ''} |`);
  }
  if (card.found) {
    push(`| Card free space (from \`${args.manifest.replace(/\\/g, '/')}\`) | ${card.free} free of ${card.totalSlots} slots (${card.perPack}) |`);
    push(`| This song against the card | ${plan.projects.length} naive project(s) = ${card.free > 0 ? Math.round((plan.projects.length / card.free) * 100) : 0}% of the free slots; largest single-pack block is ${card.largest !== undefined ? `${card.largest.free} (pack ${card.largest.pack} "${card.largest.name}")` : 'none'} |`);
  } else {
    push(`| Card free space | manifest not found at \`${args.manifest.replace(/\\/g, '/')}\`; pass --manifest to point at a card backup |`);
  }
  push('');
  if (plan.trims.length > 0) for (const t of plan.trims) push(`- Trim already applied by the chop: ${t}`);
  if (plan.splits.length > 0) for (const s of plan.splits) push(`- Split applied by the chop: ${s}`);
  if (plan.dropped_silent.length > 0) push(`- Section(s) dropped for holding no selected-part content: ${plan.dropped_silent.join('; ')}.`);
  if (plan.trims.length + plan.splits.length + plan.dropped_silent.length > 0) push('');

  push('### Grid loss');
  push('');
  push('| | |');
  push('|---|---|');
  push(`| Onsets moved by the grid, selected parts | ${totalQuant} of ${totalOnsetsSel}${totalOnsetsSel > 0 ? ` (${(totalQuant / totalOnsetsSel * 100).toFixed(1)}%)` : ''} |`);
  push(`| Dynamic marks the authored image cannot carry | ${totalDyn} |`);
  push(`| Hits outside the drum map | ${totalUnmapped}${unmappedRows.length > 0 ? ` (${unmappedRows.map((r) => `t${r.t.partId}: ${r.unmappedDetail}`).join('; ')})` : ''} |`);
  push('');
  push(`Per part: ${partsW.map((p) => `${shortLabel(p.label)} ${p.quantMoved}`).join(', ')}.`);
  push('');
  push('A merge resting on heavy quantisation is a different proposition from one that is exact;');
  push('these numbers are stated before any proposal below.');
  push('');

  push('### Density');
  push('');
  push(`Distinct-content census: ${cen.distinct_rows} distinct bar-rows across ${cen.bars} bars.`);
  push('');
  push('| Part | Distinct bars | Sounding bars |');
  push('|---|---:|---:|');
  for (const p of cen.per_part) push(`| ${shortLabel(p.label)} | ${p.distinct} | ${p.sounding} |`);
  push('');
  push('(Distinct-bar counts include a token per distinct rest bar, the same convention as');
  push('`scripts/song-superset.ts`, so the columns compare across songs counted the same way.)');
  push('');
  if (patCensus !== undefined) {
    push('Pattern census: distinct 2-bar blocks per part (a Circuit pattern holds 2 bars here; a track holds 8).');
    push('');
    push('| Part | Distinct 2-bar blocks | Sounding blocks |');
    push('|---|---:|---:|');
    for (const p of patCensus) push(`| ${shortLabel(p.label)} | ${p.distinct_blocks} | ${p.sounding_blocks} |`);
  } else {
    push('Pattern census: skipped, the metre is not uniform so a bar is not a fixed number of steps.');
  }
  push('');
  push(`Per-part window entropy (distinct cells across the ${windows.length} shared windows):`);
  push('');
  push('| Part | Distinct window cells | Silent windows |');
  push('|---|---:|---:|');
  for (const e of entropy) push(`| ${shortLabel(e.label)} | ${e.distinct_window_cells} | ${e.silent_windows} |`);
  push('');

  push('### Playability');
  push('');
  if (args.mine.length === 0) {
    push('No `--mine` part ids were supplied, so this block is empty. Re-run with `--mine <ids>` naming');
    push('the parts the maintainer plays himself to see where the song is about him.');
  } else {
    for (const p of playability) {
      push(`**t${p.id} ${shortLabel(label(p.id))}** (yours):`);
      push('');
      push(`- ALONE, no other part sounding: ${p.aloneBars} bar(s)${p.aloneBars > 0 ? `: ${p.alone}` : ''}.`);
      push(`- Exposed, exactly one other part sounding: ${p.duoBars} bar(s)${p.duoBars > 0 ? `: ${p.duo}` : ''}.`);
      push('');
    }
  }
  push('');
  push('---');
  push('');

  // ── Section 2 ─────────────────────────────────────────────────────
  push('## Section 2: squash proposals');
  push('');
  push(`Naive ${plan.projects.length} project(s), authored ${authored.length}, SAVED ${plan.projects.length - authored.length}.`);
  push('The cover is greedy, so the saving is achievable, not a proven minimum.');
  push('');
  push('### Merge (safe by construction)');
  push('');
  if (mergePairs.length === 0) {
    push('The list is EMPTY: zero automatic merges on this selection.');
  } else {
    for (const p of mergePairs) {
      const s = winOf(p.subject); const c = winOf(p.cover);
      const loop = p.loop_lengths !== undefined ? ` Same ${s.cellBars}-bar cell, looped ${p.loop_lengths[0]} vs ${p.loop_lengths[1]} bars.` : '';
      push(`- ${p.verdict}: author P${p.cover} "${c.name}" (${at(c)}), reach P${p.subject} "${s.name}" (${at(s)}) by muting`
        + `${p.mute.length > 0 ? ` ${p.mute.map(shortLabel).join(', ')}` : ' nothing (the two are indistinguishable)'}.${loop} Saves 1 project.`);
    }
  }
  if (prefixPairs.length > 0) {
    push('');
    for (const p of prefixPairs) {
      const s = winOf(p.subject); const c = winOf(p.cover);
      push(`- PREFIX: P${p.subject} "${s.name}" (${at(s)}) equals the opening bars of P${p.cover} "${c.name}" (${at(c)}); `
        + `tail_clear=${p.tail_clear === true ? 'yes, loop-safe' : 'NO: the cover keeps playing where the subject needs silence, so this is a proposal, not a merge'}.`);
    }
  }
  if (nearPairs.length > 0) {
    push('');
    push('Near-misses (interview questions, NEVER merged unanswered):');
    push('');
    for (const p of nearPairs) {
      const s = winOf(p.subject); const c = winOf(p.cover);
      push(`- NEAR: P${p.subject} "${s.name}" (${at(s)}) <= P${p.cover} "${c.name}" (${at(c)}), differs only on ${p.differs.map(shortLabel).join(' and ')}.`);
    }
  }
  if (transposePairs.length > 0) {
    push('');
    push('Transpositions (musically interesting; SAVE NOTHING today, the mixer cannot transpose):');
    push('');
    for (const p of transposePairs) {
      const s = winOf(p.subject); const c = winOf(p.cover);
      push(`- TRANSPOSE: P${p.subject} "${s.name}" (${at(s)}) is P${p.cover} "${c.name}" (${at(c)}) shifted ${p.semitones! > 0 ? '+' : ''}${p.semitones} semitone(s).`);
    }
  }
  push('');
  push('### Loop (safe by construction)');
  push('');
  if (loops.length === 0) {
    push('No window repeats on an internal bar-period as a whole. Nothing loops at project granularity.');
  } else {
    push('| Project | Window | Cell | Proposal |');
    push('|---|---|---|---|');
    for (const w of loops) {
      push(`| P${w.project} ${w.name} | ${at(w)}, ${w.bars} bars | **${w.period} bars**${w.partialCycle ? ' (last cycle cut short)' : ''} | author ${w.period} bar(s), let it run |`);
    }
  }
  if (partLoops.length > 0) {
    push('');
    push('Per-part loop cells (one part repeating inside a window that does not loop as a whole;');
    push('a pattern-slot saving, not a project saving):');
    push('');
    push('| Project | Part | Cell | Window |');
    push('|---|---|---:|---:|');
    for (const pl of partLoops) {
      push(`| P${pl.w.project} ${pl.w.name} | ${shortLabel(label(pl.partId))} | **${pl.cell} bars** | ${pl.w.bars} bars |`);
    }
  }
  push('');
  push('### Trim (a judgement with a named cost, never applied without an answer)');
  push('');
  push('| Drop | Musical cost, for you to judge |');
  push('|---|---|');
  if (driftMarks.length > 0) {
    push(`| The ${driftMarks.length} drift tempo mark(s)${flattenTo !== undefined ? `, flattened to ${flattenTo} bpm` : ''} | The transcriber's push and pull; nothing structural |`);
  }
  if (totalDyn > 0) {
    push(`| The ${totalDyn} dynamic mark(s) the rig sees | Real: the authored image flattens them, and nothing recovers that today |`);
  }
  if (totalUnmapped > 0) {
    push(`| The ${totalUnmapped} hit(s) outside the drum map | Those hits do not sound at all; re-import with a drum_map to keep them |`);
  }
  for (const sb of singleBar) {
    push(`| ${shortLabel(label(sb.partId))}'s single bar at m${sb.bar} in P${sb.w.project} "${sb.w.name}" | That bar is the part's only content in the project; dropping it frees the track there |`);
  }
  if (driftMarks.length === 0 && totalDyn === 0 && totalUnmapped === 0 && singleBar.length === 0) {
    push('| (nothing to propose) | The data surfaced no trim candidate |');
  }
  push('');
  push('---');
  push('');

  // ── Section 3 ─────────────────────────────────────────────────────
  push('## Section 3: the default mapping');
  push('');
  push('One table, agreed once, before the per-part walk. The part column is BLANK: assigning music');
  push('to destinations is the maintainer\'s call, and this script does not guess it.');
  push('');
  push('| Track | Channel | Destination | Songsterr part | Why |');
  push('|---|---|---|---|---|');
  push('| Synth 1 | ch1 | Circuit synth + Hydrasynth | ______ | ______ |');
  push('| Synth 2 | ch2 | Circuit synth | ______ | ______ |');
  push('| MIDI 1 | ch3 | MicroFreak | ______ | ______ |');
  push('| MIDI 2 | ch4 | SPD-SX | ______ | ______ |');
  push('| Drums 1-4 | -- | internal + external route | ______ | condensed to four voices |');
  const mineCell = args.mine.length > 0 ? args.mine.map((id) => `t${id} ${shortLabel(label(id))}`).join(', ') : '______';
  push(`| (not sequenced) | -- | the maintainer's hands | ${mineCell} | he plays it |`);
  push('');
  push('---');
  push('');

  // ── Section 4 ─────────────────────────────────────────────────────
  push('## Section 4: the per-part question block');
  push('');
  push('One block per project the chop produced, in song order; merged and looped projects share ONE');
  push('block. Four fixed headings; at most one choice per block. Deep links open Songsterr at the');
  push('exact bar.');
  push('');

  // Split-section boundaries, for the "keep the proposed split point?" choice.
  const splitBoundaries = new Map<string, number[]>();
  for (const w of windows) {
    const m = w.name.match(/\((\d+)\/(\d+)\)$/);
    if (m === null) continue;
    const list = splitBoundaries.get(w.section) ?? [];
    list.push(w.from + 1);
    splitBoundaries.set(w.section, list);
  }

  for (const w of windows) {
    if (absorbed.has(w.project)) continue; // merged windows share their cover's block
    const proj = chopByProject.get(w.project);
    const alsoCovers = [...absorbed.entries()].filter(([, c]) => c === w.project).map(([s]) => s);
    push(`### P${w.project}  ${w.name}  ${at(w)}  (${w.bars} bars, ${w.steps} steps)`);
    const linkParts = w.sounding.filter((id) => !args.mine.includes(id)).slice(0, 3)
      .map((id) => `[${short(id)}](${link(id, w.from + 1)})`);
    const mineLinks = args.mine.map((id) => `[your ${short(id)}](${link(id, w.from + 1)})`);
    push([...linkParts, ...mineLinks].join(' . ') || '(silent)');
    push('');
    push('```');
    push('WHAT IS HERE');
    push(`  ${w.sounding.length} of ${partsW.length} part(s) sound: ${w.sounding.map(short).join(', ') || 'none'}`);
    const silentHere = partsW.filter((p) => !w.sounding.includes(p.partId)).map((p) => shortLabel(p.label));
    if (silentHere.length > 0) push(`  silent: ${silentHere.join(', ')}`);
    if (proj !== undefined) {
      push(`  METRE ${runLength(w.metre.split(','))}.  PATTERNS ${proj.patterns} x [${proj.pattern_steps.join(', ')}] ${proj.uniform_patterns ? 'UNIFORM' : 'MIXED'}`);
    }
    push(w.period !== undefined && w.period < w.bars
      ? `  loop: a ${w.period}-bar cell, repeated${w.partialCycle ? ' (last cycle cut short)' : ''}. Author ${w.period} bar(s), let it run.`
      : `  loop: none as a whole. ${w.bars} distinct bar(s).`);
    const myLoops = partLoops.filter((pl) => pl.w.project === w.project);
    if (myLoops.length > 0 && !(w.period !== undefined && w.period < w.bars)) {
      push(`  part loops: ${myLoops.map((pl) => `${shortLabel(label(pl.partId))} a ${pl.cell}-bar cell`).join('; ')}.`);
    }
    if (alsoCovers.length > 0) {
      push(`  MERGED: this project also covers ${alsoCovers.map((a) => { const x = winOf(a); return `P${a} "${x.name}" (${at(x)})`; }).join(', ')}.`);
      for (const a of alsoCovers) {
        const pr = pairs.find((p) => p.subject === a && p.cover === w.project && p.saves);
        if (pr !== undefined && pr.mute.length > 0) push(`    to hear P${a}, mute: ${pr.mute.map(shortLabel).join(', ')}`);
      }
    }
    const near = nearPairs.filter((p) => p.subject === w.project);
    if (near.length > 0) {
      const n = near[0];
      push(`  NEAR-MISS: identical to P${n.cover} "${winOf(n.cover).name}" except on ${n.differs.map(shortLabel).join(' and ')}.`);
    }
    push('');
    push('DEFAULT');
    push('  Mapping unchanged (fill Section 3 first; every block inherits it).');
    if (alsoCovers.length > 0) push('  Author this window once; reach the merged window(s) above by muting.');
    push('');
    push('THE CHOICE');
    const splitM = w.name.match(/\((\d+)\/(\d+)\)$/);
    const mySingles = singleBar.filter((s) => s.w.project === w.project);
    if (near.length > 0) {
      push(`  Merge with P${near[0].cover} "${winOf(near[0].cover).name}" and accept the ${near[0].differs.map(shortLabel).join(' / ')} difference, or keep both?`);
    } else if (splitM !== null && splitM[1] === '1') {
      const bounds = (splitBoundaries.get(w.section) ?? []).slice(1);
      push(`  The section split into ${splitM[2]} projects${bounds.length > 0 ? `, cut at ${bounds.map((b) => `m${b}`).join(', ')}` : ''}. Keep the proposed cut(s), or move them?`);
    } else if (w.period !== undefined && w.period < w.bars) {
      push(`  Author the ${w.period}-bar cell and loop it, or write all ${w.bars} bars out?`);
    } else if (myLoops.length > 0) {
      const pl = myLoops[0];
      push(`  ${shortLabel(label(pl.partId))} is a ${pl.cell}-bar cell against this ${w.bars}-bar window. Author the cell and let it run, or write all ${w.bars} bars out?`);
    } else if (mySingles.length > 0) {
      const s = mySingles[0];
      push(`  ${shortLabel(label(s.partId))} sounds in exactly one bar here (m${s.bar}). Author the track for that one bar, or leave it empty?`);
    } else {
      push('  None. Default is fine.');
    }
    push('');
    push('ANSWER: ______');
    push('```');
    push('');
  }

  push('---');
  push('');
  push('Related: [`SONG-INTERVIEW-SCHEMA.md`](../SONG-INTERVIEW-SCHEMA.md),');
  push('[`SONG-DOC-SCHEMA.md`](../SONG-DOC-SCHEMA.md), `scripts/song-superset.ts`,');
  push('`scripts/song-interview-brief.ts`, `packages/core/src/protocol-generic/patterns/songChop.ts`.');
  push('');
  return L.join('\n');
}

// ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const song = args.cached !== undefined ? loadCached(args.cached) : await loadLive(args.ref, args.saveCache);

  // The ref must agree with what was loaded (a cache dir for song A used with a
  // ref for song B is a wrong-source hazard, same class as a revision drift).
  const { songId } = parseSongRef(args.ref);
  if (songId !== song.songId) {
    throw new Error(`ref says song ${songId} but the ${args.cached !== undefined ? 'cache' : 'fetch'} holds s${song.songId}.`);
  }
  if (args.revision !== undefined && song.revisionId !== args.revision) {
    throw new Error(
      `revision pin failed: wanted rev ${args.revision}, the ${args.cached !== undefined ? 'cache holds' : 'live fetch returned'} rev ${song.revisionId}. `
      + 'An interview answered against one revision does not transfer to another. '
      + (args.cached !== undefined
        ? 'Point --cached at a capture of the pinned revision.'
        : 'If you hold a cache of the pinned revision, re-run with --cached DIR; otherwise brief the new revision deliberately.'),
    );
  }

  const doc = buildBriefing(song, args);

  if (!args.write) {
    process.stdout.write(doc);
    return;
  }
  const slug = args.slug ?? slugOf(song.title);
  const outPath = join(OUT_DIR, `${slug}-interview.md`);
  if (existsSync(outPath)) {
    console.error(
      `REFUSED: ${outPath} already exists. Interview files carry the maintainer's answers and are `
      + 'never overwritten. Pass --slug for a different filename, or move the existing file yourself first.',
    );
    process.exit(2);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, doc);
  console.error(`wrote ${outPath}`);
}

// Self-execute only when invoked as the CLI, so `scripts/verify-interview-brief.ts`
// can import `buildBriefing` without triggering a network fetch.
const invokedDirectly = process.argv[1] !== undefined
  && /song-interview-brief\.(ts|js|mts|mjs)$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
