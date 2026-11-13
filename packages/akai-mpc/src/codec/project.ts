/**
 * MPC 3 project file (`.xpj`) reader.
 *
 * Owns: opening the container and summarising what a song layer needs from it
 * (sequences in order, tempo, the Song playlists, track names). Read-only: this
 * file never builds or rewrites a project.
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
 * A sequence name without its ordering prefix: "06 Heavy Part" -> "Heavy Part",
 * "02b Verse 1 Fill" -> "Verse 1 Fill". Names with no such prefix come back as they are.
 */
export function sequenceTitle(name: string): string {
  const m = /^[A-Za-z]?\d{1,3}[a-z]?\s+(.+)$/.exec(name.trim());
  return m !== null ? m[1] : name.trim();
}
