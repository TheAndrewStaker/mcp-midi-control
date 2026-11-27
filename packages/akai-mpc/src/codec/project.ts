/**
 * MPC 3 project file (`.xpj`) reader.
 *
 * Owns: opening the container and summarising what a song layer needs from it
 * (sequences in order, tempo, the Song playlists, track names). Read-only: this
 * file never builds or rewrites a project (`projectEdit.ts` does the edits).
 *
 * Container: gzip of a 5-line text header (`ACVS`, the app version, the data
 * kind, `json`, the platform) followed by one JSON document. Its sequences are
 * `data.sequences[]`, each `{ key, value }` where `key` is the 0-based index
 * and `value` carries `name`, `bpm`, `lengthBars`.
 *
 * Sequence NUMBER = index + 1, which is what the front panel shows and what a
 * Program Change selects (PC value = number - 1). Read the number from here
 * rather than assuming one sequence per song section: a project may interleave
 * fills and extras between its sections.
 *
 * Evidence: device-saved and generated projects on an MPC One G2 card (header
 * version 3.7.0.56), read 2026-11-11.
 */
import { gunzipSync } from 'node:zlib';

import { dbToXpmVolume, XPM_UNITY_VOLUME } from './drumProgram.js';

export interface XpjFile {
  /** The five header lines, in order. */
  header: string[];
  /** The JSON document (its content sits under `data`). */
  doc: { data: Record<string, unknown> };
}

export interface XpjSequence {
  /** 0-based position, the project's own `key`. */
  index: number;
  /** 1-based, as the front panel shows it. Program Change value = number - 1. */
  number: number;
  name: string;
  bpm?: number;
  lengthBars?: number;
}

export interface XpjSong {
  name: string;
  /** Play order: which sequence (0-based index) and how many times. */
  items: Array<{ sequenceIndex: number; repeats: number }>;
}

export interface XpjSummary {
  appVersion: string;
  platform: string;
  masterTempo?: number;
  /** 0-based index of the sequence the project opens on. */
  currentSequence?: number;
  sequences: XpjSequence[];
  songs: XpjSong[];
  tracks: string[];
}

/** Open a `.xpj` from its bytes. Throws a plain-words error when it is not one. */
export function parseXpj(bytes: Uint8Array): XpjFile {
  let text: string;
  try {
    text = gunzipSync(bytes).toString('utf8');
  } catch (e) {
    throw new SyntaxError(`not an MPC project: the file is not gzip (${(e as Error).message})`);
  }
  const lines: string[] = [];
  let at = 0;
  for (let i = 0; i < 5; i++) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) throw new SyntaxError('not an MPC project: the 5-line header is missing');
    lines.push(text.slice(at, nl).replace(/\r$/, ''));
    at = nl + 1;
  }
  if (lines[0] !== 'ACVS' || lines[3] !== 'json') {
    throw new SyntaxError(`not an MPC project: header is ${JSON.stringify(lines)} (expected "ACVS" ... "json")`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text.slice(at));
  } catch (e) {
    throw new SyntaxError(`not an MPC project: the body is not JSON (${(e as Error).message})`);
  }
  const data = (doc as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) {
    throw new SyntaxError('not an MPC project: the document has no "data" object');
  }
  return { header: lines, doc: doc as XpjFile['doc'] };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** What a song layer needs from a project: sequences in order, tempo, playlists, tracks. */
export function summarizeXpj(file: XpjFile): XpjSummary {
  const data = file.doc.data;
  const rawSeqs = Array.isArray(data.sequences) ? data.sequences as Array<{ key?: unknown; value?: Record<string, unknown> }> : [];
  const sequences: XpjSequence[] = rawSeqs.map((s, i) => {
    const index = num(s.key) ?? i;
    const v = s.value ?? {};
    const bpm = num(v.bpm);
    const lengthBars = num(v.lengthBars);
    return {
      index,
      number: index + 1,
      name: typeof v.name === 'string' ? v.name : '',
      ...(bpm !== undefined ? { bpm } : {}),
      ...(lengthBars !== undefined ? { lengthBars } : {}),
    };
  }).sort((a, b) => a.index - b.index);
  const rawSongs = Array.isArray(data.songs) ? data.songs as Array<Record<string, unknown>> : [];
  const songs: XpjSong[] = rawSongs.map((s) => ({
    name: typeof s.name === 'string' ? s.name : '',
    items: (Array.isArray(s.items) ? s.items as Array<Record<string, unknown>> : [])
      .map((it) => ({ sequenceIndex: num(it['item.sequenceIndex']) ?? -1, repeats: num(it['item.repeats']) ?? 1 }))
      .filter((it) => it.sequenceIndex >= 0),
  }));
  const tracks = (Array.isArray(data.tracks) ? data.tracks as Array<Record<string, unknown>> : [])
    .map((t) => (typeof t.name === 'string' ? t.name : ''))
    .filter((n) => n !== '');
  const masterTempo = num(data.masterTempo);
  const currentSequence = num(data.currentSequence);
  return {
    appVersion: file.header[1],
    platform: file.header[4],
    ...(masterTempo !== undefined ? { masterTempo } : {}),
    ...(currentSequence !== undefined ? { currentSequence } : {}),
    sequences,
    songs,
    tracks,
  };
}

/**
 * Track kind, from the program `type` code. Every code below was seen across
 * the 87 projects on an MPC One G2 card (MPC OS 3.7 to 3.9.1), read 2026-11-15.
 */
const TRACK_KINDS: Readonly<Record<number, string>> = {
  0: 'drum', 1: 'keygroup', 3: 'plugin', 4: 'midi', 6: 'audio', 7: 'return', 8: 'submix', 9: 'outputs',
};
const BUS_KINDS = new Set(['return', 'submix', 'outputs']);
/** Program volume at 0 dB. */
const UNITY = XPM_UNITY_VOLUME;
/** The top of the fader: program volume 1.0, +6 dB (the largest value on the card is 0.9921875). */
export const PROGRAM_VOLUME_MAX_DB = 6;

/** dB as the mixer shows it to program volume, the inverse of {@link programVolumeDb}. */
export function programVolumeFromDb(db: number | '-inf'): number {
  if (db === '-inf') return 0;
  return Math.min(1, dbToXpmVolume(db));
}

/**
 * Program volume to the dB the mixer shows: 40 * log10(v / 0.707946). Measured
 * on the device 2026-11-02 and confirmed within 0.3 dB on five keygroup
 * programs 2026-11-15. The track-level `volume` field is not the fader (it is
 * 1 on every track seen).
 */
export function programVolumeDb(v: number): number | '-inf' {
  if (!(v > 0)) return '-inf';
  return Math.round(40 * Math.log10(v / UNITY) * 10) / 10;
}

export interface XpjTrack {
  /** 1-based position in the project's track list. */
  track: number;
  name: string;
  kind: string;
  level_db: number | '-inf';
  /** -100 (left) .. 100 (right); omitted at centre. */
  pan?: number;
  muted?: true;
  /** Instrument plugin, and the preset loaded in it. */
  instrument?: string;
  preset?: string;
  /** Insert effects in slot order. */
  inserts?: string[];
  /** Returns this track feeds (non-zero send). */
  sends_to?: string[];
  midi_out?: { device: string; channel: number };
  /**
   * Outputs strips only: the project stores the strip twice, in the track and
   * in `mixer.outputs`, and the unit plays the track copy. Set when the two
   * copies carry different inserts.
   */
  inserts_differ_from_mixer_copy?: string[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function insertNames(mixable: Obj | undefined): string[] {
  const effects = obj(mixable?.inserts)?.effects;
  if (!Array.isArray(effects)) return [];
  return effects
    .map((e) => obj(e))
    .filter((e): e is Obj => e !== undefined)
    .sort((a, b) => (num(a.index) ?? 0) - (num(b.index) ?? 0))
    .map((e) => str(obj(obj(obj(e.plugin)?.description))?.name) ?? str(obj(e.plugin)?.name) ?? '?');
}

/**
 * Per-track mix and instrument state. `includeDefaultBuses` false (the default)
 * leaves out return / submix / outputs strips still at unity, centred, unmuted
 * and with no inserts; the count left out is returned beside the rows.
 */
export function describeTracks(file: XpjFile, includeDefaultBuses = false): { tracks: XpjTrack[]; omitted_default_buses: number } {
  const data = file.doc.data;
  const raw = Array.isArray(data.tracks) ? data.tracks as unknown[] : [];
  const returns = raw.map((t) => obj(t)).filter((t) => num(obj(t?.program)?.type) === 7).map((t) => str(t?.name) ?? 'Return');
  const mixerOutputs = Array.isArray(obj(data.mixer)?.outputs) ? obj(data.mixer)!.outputs as unknown[] : [];
  const tracks: XpjTrack[] = [];
  let omitted = 0;
  raw.forEach((t0, i) => {
    const t = obj(t0) ?? {};
    const program = obj(t.program) ?? {};
    const mixable = obj(program.mixable);
    const code = num(program.type);
    const kind = code !== undefined ? (TRACK_KINDS[code] ?? `type ${code}`) : 'unknown';
    const name = str(t.name) ?? str(program.name) ?? `Track ${i + 1}`;
    const volume = num(mixable?.volume) ?? UNITY;
    const panRaw = num(mixable?.pan);
    const pan = panRaw !== undefined ? Math.round((panRaw - 0.5) * 200) : 0;
    const muted = mixable?.mute === true;
    const inserts = insertNames(mixable);
    const sends = Array.isArray(mixable?.sends) ? (mixable!.sends as unknown[]).map((s) => num(s) ?? 0) : [];
    const sendsTo = sends.map((s, k) => (s > 0 ? returns[k] ?? `Return ${k + 1}` : undefined)).filter((s): s is string => s !== undefined);
    const level = programVolumeDb(volume);
    let twinDiff: string[] | undefined;
    if (kind === 'outputs') {
      const twin = mixerOutputs.map((m) => obj(m)).find((m) => str(m?.name) === name);
      const twinInserts = twin !== undefined ? insertNames(obj(twin.mixable)) : undefined;
      if (twinInserts !== undefined && JSON.stringify(twinInserts) !== JSON.stringify(inserts)) twinDiff = twinInserts;
    }
    if (!includeDefaultBuses && BUS_KINDS.has(kind) && level === 0 && pan === 0 && !muted
      && inserts.length === 0 && sendsTo.length === 0 && twinDiff === undefined) {
      omitted++;
      return;
    }
    const pluginDesc = obj(obj(obj(program.plugin)?.plugin)?.description);
    const instrument = str(pluginDesc?.name);
    const preset = str(obj(obj(program.plugin)?.plugin)?.presetName) ?? str(obj(program.plugin)?.presetName);
    const route = obj(t.midiOutputRoute);
    const device = str(obj(route?.outputPort)?.deviceName);
    const row: XpjTrack = {
      track: i + 1, name, kind, level_db: level,
      ...(pan !== 0 ? { pan } : {}),
      ...(muted ? { muted: true as const } : {}),
      ...(instrument !== undefined ? { instrument } : {}),
      ...(preset !== undefined ? { preset } : {}),
      ...(inserts.length > 0 ? { inserts } : {}),
      ...(sendsTo.length > 0 ? { sends_to: sendsTo } : {}),
      ...(device !== undefined && device !== '<none>' ? { midi_out: { device, channel: (num(route?.outputChannel) ?? 0) + 1 } } : {}),
    };
    if (twinDiff !== undefined) row.inserts_differ_from_mixer_copy = twinDiff;
    tracks.push(row);
  });
  return { tracks, omitted_default_buses: omitted };
}

/**
 * A sequence name without its ordering prefix: "06 Heavy Part" -> "Heavy Part",
 * "02b Verse 1 Fill" -> "Verse 1 Fill". Names with no such prefix come back as they are.
 */
export function sequenceTitle(name: string): string {
  const m = /^[A-Za-z]?\d{1,3}[a-z]?\s+(.+)$/.exec(name.trim());
  return m !== null ? m[1] : name.trim();
}
