/**
 * OpenRig L2: load a song book (an OpenRig `Repertoire`, spec §7) and turn one
 * song into a setup plan for `describe_rig`.
 *
 * Source: the `MCP_RIG_REPERTOIRE` env var, a path to a repertoire.json written
 * against the rig in `MCP_RIG_MANIFEST`. Env-var-driven only, like the manifest:
 * no default path, so the callers stay a pure function of (registry, env).
 * Cached per path and file stamp, so a hand edit is what the next call sees.
 *
 * Read-only. A plan is DATA (verbs for the agent to call in order); nothing
 * here touches a device and nothing in a plan saves.
 */
import * as fs from 'node:fs';
import {
  planSong,
  validatePerformance,
  validateRepertoire,
  type Performance,
  type Repertoire,
  type Rig,
  type Song,
  type SongPlan,
} from 'openrig';

import { sameStamp, stampFile, type FileStamp } from './fileStamp.js';
import { loadRigManifest } from './manifest.js';

export const RIG_REPERTOIRE_ENV = 'MCP_RIG_REPERTOIRE';

/** Song rows listed by `describe_rig`; past this the list says it was cut. */
export const REPERTOIRE_LIST_MAX = 150;

export type LoadedRepertoire =
  | { status: 'loaded'; repertoire: Repertoire; source: string }
  | { status: 'absent'; source: string }
  | { status: 'error'; error: string; source: string }
  | { status: 'unconfigured' };

let cache: LoadedRepertoire | undefined;
let cachedPath: string | undefined;
let cachedStamp: FileStamp | undefined;

function source(): string | undefined {
  const path = process.env[RIG_REPERTOIRE_ENV];
  return path === undefined || path.trim() === '' ? undefined : path.trim();
}

function load(path: string | undefined): LoadedRepertoire {
  if (path === undefined) return { status: 'unconfigured' };
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent', source: path };
    return { status: 'error', source: path, error: `cannot read the song book at ${path}: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { status: 'error', source: path, error: `the song book at ${path} is not valid JSON: ${(e as Error).message}` };
  }
  const obj = parsed as { rig?: unknown; songs?: unknown };
  if (typeof parsed !== 'object' || parsed === null || typeof obj.rig !== 'string' || !Array.isArray(obj.songs)) {
    return { status: 'error', source: path, error: `the song book at ${path} is not an OpenRig repertoire (expected { "rig": "<rig id>", "songs": [...] })` };
  }
  return { status: 'loaded', repertoire: parsed as Repertoire, source: path };
}

export function loadRepertoire(): LoadedRepertoire {
  const path = source();
  const stamp: FileStamp = path === undefined ? 'absent' : stampFile(path);
  if (cache === undefined || cachedPath !== path || !sameStamp(cachedStamp, stamp)) {
    cache = load(path);
    cachedPath = path;
    cachedStamp = stamp;
  }
  return cache;
}

export function clearRepertoireCache(): void {
  cache = undefined;
  cachedPath = undefined;
  cachedStamp = undefined;
}

export interface RepertoireSummary {
  source: string;
  error?: string;
  rig?: string;
  song_count?: number;
  /** `id` is what `describe_rig({song})` takes. `open` counts the song's undecided or by-hand items. */
  songs?: Array<{ id: string; title: string; artist?: string; status?: string }>;
  /** Present when the list was cut at REPERTOIRE_LIST_MAX. */
  truncated?: string;
  /** `id` is what `describe_rig({setlist})` takes. Absent when the song book holds no setlist. */
  setlists?: Array<{ id: string; name: string; song_count: number }>;
  /** Checked against the loaded rig manifest; absent when no manifest is loaded. */
  validation?: { ok: boolean; errors: string[]; warning_count: number };
}

function loadedRig(): Rig | undefined {
  const m = loadRigManifest();
  return m.status === 'loaded' ? m.rig : undefined;
}

/** The song book as `describe_rig` lists it, or undefined when none is configured. */
export function buildRepertoireSummary(): RepertoireSummary | undefined {
  const loaded = loadRepertoire();
  if (loaded.status === 'unconfigured') return undefined;
  if (loaded.status === 'absent') {
    return { source: loaded.source, error: `no song book exists yet at ${loaded.source}` };
  }
  if (loaded.status === 'error') return { source: loaded.source, error: loaded.error };
  const { repertoire } = loaded;
  const rig = loadedRig();
  const result = rig !== undefined ? validateRepertoire(rig, repertoire) : undefined;
  const rows = repertoire.songs.slice(0, REPERTOIRE_LIST_MAX).map((s) => ({
    id: s.id,
    title: s.title,
    ...(s.artist !== undefined ? { artist: s.artist } : {}),
    ...(s.status !== undefined ? { status: s.status } : {}),
  }));
  return {
    source: loaded.source,
    rig: repertoire.rig,
    song_count: repertoire.songs.length,
    songs: rows,
    ...(repertoire.songs.length > rows.length
      ? { truncated: `${repertoire.songs.length - rows.length} more song(s) not listed; pass a song title or id to describe_rig({song}) directly.` }
      : {}),
    ...(repertoire.performances !== undefined && repertoire.performances.length > 0
      ? { setlists: repertoire.performances.map((p) => ({ id: p.id, name: p.name, song_count: p.songs.length })) }
      : {}),
    ...(result !== undefined
      ? { validation: { ok: result.ok, errors: result.errors.slice(0, 10).map((e) => `${e.code}: ${e.message}`), warning_count: result.warnings.length } }
      : {}),
  };
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function findSong(repertoire: Repertoire, query: string): Song | { candidates: string[] } {
  const q = norm(query);
  const exact = repertoire.songs.filter((s) => s.id === query || norm(s.id) === q || norm(s.title) === q);
  if (exact.length === 1) return exact[0];
  const partial = exact.length > 1 ? exact : repertoire.songs.filter((s) => q !== '' && norm(s.title).includes(q));
  if (partial.length === 1) return partial[0];
  return { candidates: (partial.length > 0 ? partial : repertoire.songs).slice(0, 20).map((s) => s.id) };
}

/** The loaded song book and rig, or a display-shaped error naming what is missing. */
function loadedBook(what: string): { repertoire: Repertoire; rig: Rig } {
  const loaded = loadRepertoire();
  if (loaded.status === 'unconfigured') {
    throw new Error(`No song book is configured. Set ${RIG_REPERTOIRE_ENV} to an OpenRig repertoire.json written against the rig manifest.`);
  }
  if (loaded.status !== 'loaded') {
    throw new Error(loaded.status === 'absent' ? `No song book exists yet at ${loaded.source}.` : loaded.error);
  }
  const rig = loadedRig();
  if (rig === undefined) {
    throw new Error(`${what} needs the rig manifest (MCP_RIG_MANIFEST): a song names rig devices by their manifest id.`);
  }
  if (loaded.repertoire.rig !== rig.id) {
    throw new Error(`The song book is written for rig "${loaded.repertoire.rig}" but the loaded manifest is "${rig.id}". Point both at the same rig.`);
  }
  return { repertoire: loaded.repertoire, rig };
}

export interface SetlistPosition {
  position: number;
  song: string;
  title: string;
  tempo_bpm?: number;
  /** Verbs the song's plan holds. Fetch them with `describe_rig({song})`. */
  steps: number;
  /** Items still to be decided with the player (no tone chosen, no location recorded). */
  owed: number;
  /** What has to be done on a device by hand before the steps apply (a project to load). */
  by_hand?: string[];
  note?: string;
}

export interface SetlistPlanResponse {
  setlist: string;
  name: string;
  song_count: number;
  positions: SetlistPosition[];
  /** Setlist entries that name a song the book does not hold. */
  unknown_songs?: string[];
  truncated?: string;
  note: string;
}

/**
 * A setlist in play order: one row per position with what the song still needs.
 * Rows are summaries on purpose. A full plan per song would be paid for whether
 * or not the agent is about to set that song up; the steps for one song are one
 * `describe_rig({song})` away.
 */
export function executeSetlistPlan(query: string): SetlistPlanResponse {
  const { repertoire, rig } = loadedBook('A setlist');
  const all = repertoire.performances ?? [];
  if (all.length === 0) {
    throw new Error('The song book holds no setlist. Add a "performances" list to it: [{ "id", "name", "rig", "songs": [{ "ref": "<song id>" }] }].');
  }
  const q = norm(query);
  const exact = all.filter((p) => p.id === query || norm(p.id) === q || norm(p.name) === q);
  const hits: Performance[] = exact.length > 0 ? exact : all.filter((p) => q !== '' && norm(p.name).includes(q));
  if (hits.length !== 1) {
    throw new Error(`No single setlist matches "${query}". Setlist ids: ${all.map((p) => p.id).join(', ')}.`);
  }
  const perf = hits[0];
  const check = validatePerformance(repertoire, perf);
  const byId = new Map(repertoire.songs.map((s) => [s.id, s]));
  const unknown: string[] = [];
  const positions: SetlistPosition[] = [];
  perf.songs.forEach((entry, i) => {
    const song = byId.get(entry.ref);
    if (song === undefined) { unknown.push(entry.ref); return; }
    if (positions.length >= REPERTOIRE_LIST_MAX) return;
    const plan = planSong(rig, song, entry.tempo_override !== undefined ? { tempo_override: entry.tempo_override } : {});
    const byHand = plan.gaps.filter((g) => g.reason === 'by-hand').map((g) => g.detail);
    positions.push({
      position: i + 1,
      song: song.id,
      title: song.title,
      ...(plan.tempo_bpm !== undefined ? { tempo_bpm: plan.tempo_bpm } : {}),
      steps: plan.steps.length,
      owed: plan.gaps.filter((g) => g.reason === 'owed').length,
      ...(byHand.length > 0 ? { by_hand: byHand } : {}),
      ...(entry.note !== undefined ? { note: entry.note } : {}),
    });
  });
  const cut = perf.songs.length - unknown.length - positions.length;
  const owedSongs = positions.filter((p) => p.owed > 0).length;
  return {
    setlist: perf.id,
    name: perf.name,
    song_count: perf.songs.length,
    positions,
    ...(unknown.length > 0 ? { unknown_songs: unknown } : {}),
    ...(cut > 0 ? { truncated: `${cut} more position(s) not listed.` } : {}),
    note:
      'Play order. Each row counts what the song plan holds; call describe_rig({song}) for a song to get its steps, then call them. Nothing here saves or moves a device. '
      + (owedSongs > 0 ? `${owedSongs} song(s) still have something to decide with the player. ` : '')
      + (check.ok ? '' : `This setlist has errors: ${check.errors.slice(0, 5).map((e) => e.message).join(' ')}`),
  };
}

export interface SongPlanResponse extends SongPlan {
  artist?: string;
  section: string | undefined;
  sections?: string[];
  note: string;
}

/**
 * The setup plan for one song: the verbs to call, in order, and what is left
 * to do by hand or decide. Throws a display-shaped error when the song book or
 * the rig manifest is missing, or the song cannot be picked unambiguously.
 */
export function executeSongPlan(query: string, section?: string): SongPlanResponse {
  const { repertoire, rig } = loadedBook('A song plan');
  const found = findSong(repertoire, query);
  if ('candidates' in found) {
    throw new Error(`No single song matches "${query}". Song ids: ${found.candidates.join(', ')}.`);
  }
  const names = found.sections?.map((s) => s.name);
  if (section !== undefined && names !== undefined && !names.includes(section)) {
    throw new Error(`"${found.title}" has no section "${section}". Sections: ${names.join(', ')}.`);
  }
  const plan = planSong(rig, found, section !== undefined ? { section } : {});
  const owed = plan.gaps.filter((g) => g.reason === 'owed').length;
  return {
    ...plan,
    ...(found.artist !== undefined ? { artist: found.artist } : {}),
    section: section ?? names?.[0],
    ...(names !== undefined ? { sections: names } : {}),
    note:
      `Call the ${plan.steps.length} step(s) in order (each step's tool with its args); recalls come first because a recall replaces the working buffer. `
      + 'Nothing here saves. A step marked "proposed" has not been checked on the device, so confirm by ear or front panel. '
      + (plan.gaps.length > 0
        ? `${plan.gaps.length} gap(s) are not steps: ${owed} still to be decided with the player, the rest set by hand or already authored into a device. `
        : '')
      + (plan.tempo_bpm !== undefined && plan.tempo_node !== undefined
        ? `Tempo ${plan.tempo_bpm} BPM belongs on "${plan.tempo_node}", the clock master.`
        : ''),
  };
}
