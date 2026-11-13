/**
 * console-sources.ts: load the three things the rig console shows.
 *
 *   1. `rig.json`   the live OpenRig manifest (what is cabled to what).
 *   2. a card capture, decoded by `circuit-card-scan.ts` (what is actually
 *      stored in each of the sequencer's 320 slots).
 *   3. a setlist markdown (the intended performance ORDER).
 *
 * THIS FILE IS THE DISK HALF. The view-model types, the setlist parser, and
 * the setlist-vs-card JOIN are pure and live in
 * `@mcp-midi-control/rig-console-render` (re-exported here so script consumers
 * keep one import); what stays here is everything that touches the filesystem,
 * because the paths it reads (`samples/`, `docs/_private/rig/`) are the
 * maintainer's gitignored data. A contributor running this gets a labelled
 * empty panel and never a crash: `SourceStatus` distinguishes `absent`
 * (nothing configured / nothing there) from `error` (there and unreadable),
 * because collapsing those is what makes a first run unrecoverable.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  freeRuns, parseSetlist,
  type ConsoleCard, type ConsolePack, type ConsoleSlot, type SetlistEntry, type SourceStatus,
} from '@mcp-midi-control/rig-console-render';

import { PROJECT_COLOURS, getProjectColour } from '../../packages/circuit-tracks/src/ncs/format.js';

import { KIND_LABEL, type RosterEntry } from './circuit-card-roster.js';
import {
  PACKS, SLOTS_PER_PACK, buildRows, buildXref, findDrift,
  type Manifest, type Row,
} from './circuit-card-scan.js';

// The pure surface moved to the render package; script consumers keep this
// module as their one import for sources + join alike.
export {
  attachVoices, freeRuns, joinSongs, parseSetlist, songKey,
  type BuildClaim, type ConsoleCard, type ConsolePack, type ConsoleSlot, type ConsoleSong,
  type SetlistEntry, type SongJoin, type SourceState, type SourceStatus, type TrackContent,
  type VoiceMappingEntry,
} from '@mcp-midi-control/rig-console-render';

// ─── card ───────────────────────────────────────────────────────────────────

/** Strip the markdown emphasis the scan uses for its markers: `**CORRUPT**` -> `CORRUPT`. */
const plainMarker = (m: string): string => m.replace(/\*\*/g, '');

function toSlot(r: Row): ConsoleSlot {
  const ro: RosterEntry | undefined = r.roster;
  // Never throws: getProjectColour asserts a well-formed buffer, and a corrupt
  // project is exactly the case where the colour matters least and the crash
  // would cost most.
  let colourIndex: number | undefined;
  if (r.bytes !== undefined) {
    try { colourIndex = getProjectColour(r.bytes); } catch { colourIndex = undefined; }
  }
  return {
    pack: r.pack,
    slot: r.slot,
    occupied: r.occupied,
    name: r.decoded?.name,
    kind: ro?.kind,
    kind_label: ro ? KIND_LABEL[ro.kind] : undefined,
    what: ro?.what,
    song: ro?.song,
    artist: ro?.artist,
    part: ro?.part,
    doc: ro?.doc,
    tempo: r.decoded?.tempo,
    tempo_post_capture: ro?.postCapture?.bpm,
    tempo_post_capture_confidence: ro?.postCapture?.confidence,
    tracks: r.decoded?.tracks ?? [],
    markers: r.markers.map(plainMarker),
    notes: r.notes,
    hazard: ro?.hazard,
    colour_index: colourIndex,
    colour: colourIndex !== undefined ? PROJECT_COLOURS[colourIndex] : undefined,
  };
}

/** Newest `card-backup-*` directory holding a `manifest.json`, or undefined. */
export function latestCapture(root = 'samples/circuit-ncs'): string | undefined {
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith('card-backup-'))
    .map((d) => join(root, d))
    .filter((p) => existsSync(join(p, 'manifest.json')));
  if (dirs.length === 0) return undefined;
  // Sort by the manifest's own capture time, not the directory name: the names
  // mix two formats (`card-backup-2026-07-27T16-49Z`, `card-backup-2026-07-31`)
  // and a lexical sort across those is not a chronological one.
  return dirs.sort((a, b) => {
    const t = (p: string): number => {
      try { return Date.parse((JSON.parse(readFileSync(join(p, 'manifest.json'), 'utf8')) as Manifest).captured_at); }
      catch { return statSync(p).mtimeMs; }
    };
    return t(a) - t(b);
  }).at(-1);
}

export function loadCard(captureDir: string | undefined, xrefRoot = 'samples'): { card?: ConsoleCard; status: SourceStatus } {
  const base: Omit<SourceStatus, 'state' | 'detail'> = { id: 'card', label: 'Circuit Tracks card capture', path: captureDir ?? 'samples/circuit-ncs' };
  if (captureDir === undefined) {
    return { status: { ...base, state: 'absent', detail: 'No card-backup-* directory with a manifest.json under samples/circuit-ncs. Back the card up to populate the sequencer map.' } };
  }
  try {
    const man = JSON.parse(readFileSync(join(captureDir, 'manifest.json'), 'utf8')) as Manifest;
    const drift = findDrift(captureDir, Date.parse(man.captured_at));
    const rows = buildRows(captureDir, man, drift, buildXref(xrefRoot, captureDir));
    const packNames = new Map<number, string>(
      (man as Manifest & { card_packs?: { device_pack: number; name: string }[] }).card_packs?.map((p) => [p.device_pack, p.name]) ?? [],
    );

    const packs: ConsolePack[] = [];
    for (let p = 1; p <= PACKS; p++) {
      const slots = rows.filter((r) => r.pack === p).sort((a, b) => a.slot - b.slot).map(toSlot);
      const occupied = slots.filter((s) => s.occupied).length;
      packs.push({
        pack: p,
        name: packNames.get(p) ?? `Pack ${p}`,
        occupied,
        free: slots.length - occupied,
        free_runs: freeRuns(slots),
        slots,
      });
    }
    const occupied = packs.reduce((a, p) => a + p.occupied, 0);
    return {
      card: { captured_at: man.captured_at, capture_dir: captureDir, packs, totals: { occupied, free: PACKS * SLOTS_PER_PACK - occupied, slots: PACKS * SLOTS_PER_PACK } },
      status: { ...base, state: 'loaded', detail: `${occupied} of ${PACKS * SLOTS_PER_PACK} slots occupied, captured ${man.captured_at}` },
    };
  } catch (e) {
    return { status: { ...base, state: 'error', detail: e instanceof Error ? e.message : String(e) } };
  }
}

// ─── setlist ────────────────────────────────────────────────────────────────

/** Newest `*.md` under the setlists directory, by mtime. */
export function latestSetlist(dir = 'docs/_private/rig/setlists'): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f));
  if (files.length === 0) return undefined;
  return files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1);
}

export function loadSetlist(path: string | undefined): { entries: SetlistEntry[]; status: SourceStatus } {
  const base: Omit<SourceStatus, 'state' | 'detail'> = { id: 'setlist', label: 'Setlist', path: path ?? 'docs/_private/rig/setlists' };
  if (path === undefined) return { entries: [], status: { ...base, state: 'absent', detail: 'No .md file under docs/_private/rig/setlists.' } };
  try {
    const entries = parseSetlist(readFileSync(path, 'utf8'));
    return entries.length === 0
      ? { entries, status: { ...base, state: 'error', detail: 'No pipe table with a song column was found in the file.' } }
      : { entries, status: { ...base, state: 'loaded', detail: `${entries.length} songs in performance order` } };
  } catch (e) {
    return { entries: [], status: { ...base, state: 'error', detail: e instanceof Error ? e.message : String(e) } };
  }
}

// ─── voices ─────────────────────────────────────────────────────────────────

/**
 * The mapping registry's per-song claims (docs/_private/rig/song-mappings.json)
 * for the Voices panel. Absence is a normal state (fresh checkout, no rig
 * data), reported as an empty list rather than a crash; a parse error is
 * surfaced in the returned note so the caller can log it without dying.
 */
export function loadVoices(path = 'docs/_private/rig/song-mappings.json'):
  { mappings: import('@mcp-midi-control/rig-console-render').VoiceMappingEntry[]; note?: string } {
  if (!existsSync(path)) return { mappings: [], note: `${path} not found; the Voices panel reports nothing filed.` };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { songs?: unknown };
    return { mappings: Array.isArray(parsed.songs) ? parsed.songs as never : [] };
  } catch (e) {
    return { mappings: [], note: `song-mappings.json unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
}
