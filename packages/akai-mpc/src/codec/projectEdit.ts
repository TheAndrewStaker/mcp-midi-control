/**
 * MPC project (`.xpj`) edits that change only the values asked for.
 *
 * Owns: locating a value in the project's JSON text by its path, splicing new
 * literals in at exactly those spans, and proving afterwards that nothing else
 * in the document moved.
 *
 * Why a splice and not parse + stringify: the MPC writes doubles with a
 * trailing `.0` (`"controlValue":0.0`), and JavaScript writes them back as
 * `0`. Every one of the 87 projects on an MPC One G2 card failed a
 * parse-and-stringify round trip for that reason (checked 2026-11-15). The
 * splice leaves every byte outside the edited values as the unit wrote it.
 *
 * The gzip container is re-compressed, so the file's bytes change throughout;
 * the decompressed text differs only at the edited spans.
 */
import { gunzipSync, gzipSync } from 'node:zlib';

import { parseXpj, programVolumeDb, programVolumeFromDb, PROGRAM_VOLUME_MAX_DB, type XpjFile } from './project.js';

export type JsonPath = ReadonlyArray<string | number>;

export interface XpjText {
  /** The five header lines plus their newlines, exactly as stored. */
  head: string;
  /** The JSON document text. */
  body: string;
}

/** Split a `.xpj` into its header and JSON text. Throws SyntaxError when it is not one. */
export function readXpjText(bytes: Uint8Array): XpjText {
  parseXpj(bytes); // the same plain-words errors as a read
  const text = gunzipSync(bytes).toString('utf8');
  let at = 0;
  for (let i = 0; i < 5; i++) at = text.indexOf('\n', at) + 1;
  return { head: text.slice(0, at), body: text.slice(at) };
}

export function encodeXpjText(t: XpjText): Uint8Array {
  return gzipSync(Buffer.from(t.head + t.body, 'utf8'));
}

const WS = new Set([' ', '\t', '\n', '\r']);

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.has(s[i])) i++;
  return i;
}

function stringEnd(s: string, i: number): number {
  // s[i] is the opening quote; returns the index after the closing quote.
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') j += 2;
    else if (c === '"') return j + 1;
    else j++;
  }
  throw new SyntaxError('unterminated string in project JSON');
}

/** Index just past the JSON value that starts at `i`. */
function valueEnd(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return stringEnd(s, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    let j = i;
    while (j < s.length) {
      const d = s[j];
      if (d === '"') { j = stringEnd(s, j); continue; }
      if (d === '{' || d === '[') depth++;
      else if (d === '}' || d === ']') { depth--; if (depth === 0) return j + 1; }
      j++;
    }
    throw new SyntaxError('unterminated object in project JSON');
  }
  let j = i;
  while (j < s.length && !WS.has(s[j]) && s[j] !== ',' && s[j] !== '}' && s[j] !== ']') j++;
  if (j === i) throw new SyntaxError(`unexpected "${c}" in project JSON`);
  return j;
}

/**
 * The [start, end) span of the value at `path` in JSON text `s`, or undefined
 * when the path does not exist. Subtrees off the path are skipped, not parsed.
 */
export function findJsonSpan(s: string, path: JsonPath): { start: number; end: number } | undefined {
  let i = skipWs(s, 0);
  for (const step of path) {
    if (typeof step === 'number') {
      if (s[i] !== '[') return undefined;
      i = skipWs(s, i + 1);
      let k = 0;
      if (s[i] === ']') return undefined;
      while (k < step) {
        i = skipWs(s, valueEnd(s, i));
        if (s[i] !== ',') return undefined;
        i = skipWs(s, i + 1);
        k++;
      }
    } else {
      if (s[i] !== '{') return undefined;
      i = skipWs(s, i + 1);
      let found = false;
      while (s[i] !== '}') {
        const kEnd = stringEnd(s, i);
        const key = JSON.parse(s.slice(i, kEnd)) as string;
        i = skipWs(s, kEnd);
        if (s[i] !== ':') throw new SyntaxError('expected ":" in project JSON');
        i = skipWs(s, i + 1);
        if (key === step) { found = true; break; }
        i = skipWs(s, valueEnd(s, i));
        if (s[i] === ',') i = skipWs(s, i + 1);
      }
      if (!found) return undefined;
    }
  }
  return { start: i, end: valueEnd(s, i) };
}

export interface JsonEdit {
  path: JsonPath;
  /** The value to store. Numbers keep a decimal point when the old literal had one. */
  value: number | string | boolean;
}

/** A number literal in the unit's style: a double keeps its decimal point. */
export function numberLiteral(v: number, oldLiteral: string): string {
  const text = String(Number(v.toPrecision(9)));
  const wasDouble = /[.eE]/.test(oldLiteral);
  return wasDouble && !/[.eE]/.test(text) ? `${text}.0` : text;
}

function literalFor(edit: JsonEdit, oldLiteral: string): string {
  if (typeof edit.value === 'number') {
    if (!Number.isFinite(edit.value)) throw new RangeError(`not a finite number at ${edit.path.join('.')}`);
    return numberLiteral(edit.value, oldLiteral);
  }
  return JSON.stringify(edit.value);
}

function setPath(root: unknown, path: JsonPath, value: unknown): void {
  let o = root as Record<string | number, unknown>;
  for (let k = 0; k < path.length - 1; k++) o = o[path[k]] as Record<string | number, unknown>;
  o[path[path.length - 1]] = value;
}

/**
 * Apply edits to the JSON text. Throws, with nothing changed, when a path is
 * missing, when an edit would change a value's JSON type, or when the result
 * differs from the original anywhere but the edited values.
 */
export function spliceJson(body: string, edits: readonly JsonEdit[]): string {
  const spans = edits.map((e) => {
    const span = findJsonSpan(body, e.path);
    if (span === undefined) throw new RangeError(`the project has no value at ${e.path.join('.')}`);
    const old = body.slice(span.start, span.end);
    const oldType = typeof JSON.parse(old);
    if (oldType !== typeof e.value) throw new TypeError(`${e.path.join('.')} holds a ${oldType}, not a ${typeof e.value}`);
    return { ...span, text: literalFor(e, old) };
  }).sort((a, b) => b.start - a.start);
  for (let k = 1; k < spans.length; k++) {
    if (spans[k].end > spans[k - 1].start) throw new RangeError('two edits touch the same value');
  }
  let out = body;
  for (const sp of spans) out = out.slice(0, sp.start) + sp.text + out.slice(sp.end);
  // Nothing else moved: the original with the edits applied as values equals the result.
  const expected = JSON.parse(body) as unknown;
  for (const e of edits) setPath(expected, e.path, JSON.parse(literalFor(e, '0')));
  if (JSON.stringify(expected) !== JSON.stringify(JSON.parse(out))) {
    throw new Error('the edited project differs from the original outside the edited values; nothing was written');
  }
  return out;
}

export interface TrackEditRequest {
  /** 1-based track number, as get_preset's mpc_project lists it. */
  track: number;
  level_db?: number | '-inf';
  /** -100 (left) .. 100 (right). */
  pan?: number;
  mute?: boolean;
}

export interface SequenceEditRequest {
  /** 1-based sequence number. */
  sequence: number;
  name?: string;
  bpm?: number;
  /** Read-only: accepted only when it matches the project, so a get_preset row round-trips. */
  bars?: number;
}

export interface ProjectEditPlan {
  edits: JsonEdit[];
  /** One line per value that changes. */
  changes: string[];
  /** Values asked for that already hold that value. */
  unchanged: string[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : undefined);
const fmtDb = (d: number | '-inf'): string => (d === '-inf' ? '-inf dB' : `${d.toFixed(1)} dB`);

/**
 * Turn track and sequence requests into JSON edits on one project. Throws a
 * RangeError naming the request when a track or sequence does not exist or a
 * value is out of range. An outputs strip is stored twice (the track and
 * `mixer.outputs`); both copies get the same edit, since the unit plays the
 * track copy and a stale twin is how the two came apart before.
 */
export function planProjectEdits(
  file: XpjFile,
  tracks: readonly TrackEditRequest[],
  sequences: readonly SequenceEditRequest[],
): ProjectEditPlan {
  const data = file.doc.data;
  const rawTracks = Array.isArray(data.tracks) ? data.tracks as unknown[] : [];
  const mixerOutputs = Array.isArray(obj(data.mixer)?.outputs) ? obj(data.mixer)!.outputs as unknown[] : [];
  const edits: JsonEdit[] = [];
  const changes: string[] = [];
  const unchanged: string[] = [];
  for (const r of tracks) {
    const t = obj(rawTracks[r.track - 1]);
    if (t === undefined) throw new RangeError(`track ${r.track}: the project has ${rawTracks.length} tracks`);
    const name = typeof t.name === 'string' ? t.name : `Track ${r.track}`;
    const program = obj(t.program);
    const mixable = obj(program?.mixable);
    if (mixable === undefined) throw new RangeError(`track ${r.track} "${name}" has no mixer strip in the file`);
    const base: JsonPath = ['data', 'tracks', r.track - 1, 'program', 'mixable'];
    const twinIndex = program?.type === 9 ? mixerOutputs.findIndex((m) => obj(m)?.name === name) : -1;
    const twinMix = twinIndex >= 0 ? obj(obj(mixerOutputs[twinIndex])?.mixable) : undefined;
    const twinBase: JsonPath = ['data', 'mixer', 'outputs', twinIndex, 'mixable'];
    const twinNote = twinMix !== undefined ? ' (and its mixer.outputs copy)' : '';
    const put = (field: string, value: number | boolean, line: string, same: boolean): void => {
      if (same) { unchanged.push(line); return; }
      edits.push({ path: [...base, field], value });
      if (twinMix !== undefined && field in twinMix) edits.push({ path: [...twinBase, field], value });
      changes.push(line + twinNote);
    };
    const label = `track ${r.track} "${name}"`;
    if (r.level_db !== undefined) {
      if (r.level_db !== '-inf' && !(r.level_db <= PROGRAM_VOLUME_MAX_DB)) {
        throw new RangeError(`${label}: level_db ${r.level_db} is above the fader's top (+${PROGRAM_VOLUME_MAX_DB} dB)`);
      }
      const now = programVolumeDb(typeof mixable.volume === 'number' ? mixable.volume : 0.707946);
      const v = programVolumeFromDb(r.level_db);
      const want = programVolumeDb(v);
      put('volume', v, `${label}: level ${fmtDb(now)} -> ${fmtDb(want)}`, now === want);
    }
    if (r.pan !== undefined) {
      if (!(r.pan >= -100 && r.pan <= 100)) throw new RangeError(`${label}: pan ${r.pan} is outside -100..100`);
      const nowPan = typeof mixable.pan === 'number' ? Math.round((mixable.pan - 0.5) * 200) : 0;
      put('pan', 0.5 + r.pan / 200, `${label}: pan ${nowPan} -> ${Math.round(r.pan)}`, nowPan === Math.round(r.pan));
    }
    if (r.mute !== undefined) {
      const nowMute = mixable.mute === true;
      put('mute', r.mute, `${label}: ${r.mute ? 'muted' : 'unmuted'}`, nowMute === r.mute);
    }
  }
  const rawSeqs = Array.isArray(data.sequences) ? data.sequences as unknown[] : [];
  for (const r of sequences) {
    const j = rawSeqs.findIndex((s, k) => (typeof obj(s)?.key === 'number' ? obj(s)!.key : k) === r.sequence - 1);
    const value = obj(obj(rawSeqs[j])?.value);
    if (j < 0 || value === undefined) throw new RangeError(`sequence ${r.sequence}: the project has ${rawSeqs.length} sequences`);
    const base: JsonPath = ['data', 'sequences', j, 'value'];
    const nowName = typeof value.name === 'string' ? value.name : '';
    const label = `sequence ${r.sequence} "${nowName}"`;
    if (r.bars !== undefined && r.bars !== value.lengthBars) {
      throw new RangeError(`${label}: its length is ${String(value.lengthBars)} bars; length is not edited here (it moves events), change it on the MPC`);
    }
    if (r.name !== undefined) {
      if (r.name.trim() === '') throw new RangeError(`${label}: a sequence name cannot be empty`);
      if (r.name === nowName) unchanged.push(`${label}: name`);
      else { edits.push({ path: [...base, 'name'], value: r.name }); changes.push(`${label}: renamed to "${r.name}"`); }
    }
    if (r.bpm !== undefined) {
      if (!(r.bpm >= 30 && r.bpm <= 300)) throw new RangeError(`${label}: bpm ${r.bpm} is outside 30..300`);
      if (typeof value.bpm !== 'number') throw new RangeError(`${label} stores no tempo of its own`);
      if (value.bpm === r.bpm) unchanged.push(`${label}: bpm`);
      else { edits.push({ path: [...base, 'bpm'], value: r.bpm }); changes.push(`${label}: tempo ${value.bpm} -> ${r.bpm} BPM`); }
    }
  }
  return { edits, changes, unchanged };
}

/** Edit a `.xpj` file's bytes; returns the new bytes and the re-parsed file. */
export function editXpj(bytes: Uint8Array, edits: readonly JsonEdit[]): { bytes: Uint8Array; file: XpjFile } {
  const t = readXpjText(bytes);
  const out = encodeXpjText({ head: t.head, body: spliceJson(t.body, edits) });
  return { bytes: out, file: parseXpj(out) };
}
