/**
 * Two authoring surfaces, both compiling to `Step[]`:
 *
 *  1. CHAR GRID, one character per step, length = resolution:
 *       "x...x...x...x..."   ('x'/'X' hit, '.'/'~' rest; 'X' = accent)
 *     Dense and exact; the named library (`library.ts`) is authored this way.
 *
 *  2. MINI-NOTATION, a speakable subset of TidalCycles/Strudel notation:
 *       "bd ~ ~ ~ bd ~ ~ ~"   space-separated tokens
 *       "hh*8"                 repeat (8 hats over the slot)
 *       "bd [sd sd]"           subgroup (subdivides one slot)
 *       "bd*4, hh*8, ~ sd ~ sd" comma-stacks several voices
 *     Tokens are placed by even time-division and mapped onto the grid.
 *     A few hundred lines, no Strudel/Tidal dependency (deliberate).
 *
 *  PITCHED tokens (melodic voices, for the note tracks): a token can be a
 *  scientific-pitch NOTE name instead of a drum word, carrying the pitch the
 *  step plays:
 *       "c2 ~ g2 ~ eb2 ~ ~ ~"   a bassline (one note per step)
 *       "c3+eb3+g3 ~ ~ ~"       a chord (notes joined by '+', up to 6)
 *       "c3 eb3 g3 c4"          an arpeggio
 *     Names are case-insensitive, accidental `#`/`s` (sharp) or `b` (flat),
 *     octave an integer (`c-1` = 0 is the floor, `g9` = 127 the ceiling; a
 *     higher note like `a9` is out of MIDI range and throws); middle C = C4 =
 *     MIDI 60. A pitched hit
 *     sets `Step.notes`; an `x`/`X` hit stays un-pitched (drum semantics),
 *     taking its note from the target's voice_map. `c3*4` repeats the note.
 *
 * `parseVoice` auto-detects: a string with whitespace, `[`/`]`, `*`, or `+`,
 * or a single bare pitch/chord token, is mini-notation; otherwise it's a char
 * grid.
 */

import type { Step } from './types.js';
import { PatternError } from './types.js';
import { euclid } from './euclid.js';

const REST_TOKENS = new Set(['~', '.', '-', '0']);

// ── Pitch tokens (melodic voices) ──────────────────────────────────────

/** Semitone offset within an octave for each note letter (C = 0). */
const SEMITONE: Readonly<Record<string, number>> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/**
 * A single scientific-pitch token: letter, optional accidental, octave.
 * A trailing octave digit is REQUIRED, so bare drum words (`bd`, `hh`, `s`,
 * `b`) are never mistaken for pitches. Middle C = C4 = 60.
 */
const PITCH_RE = /^([a-gA-G])(#|s|b)?(-?\d+)$/;

/** Parse one pitch token to a MIDI note 0..127, or undefined if not a pitch. */
export function parsePitch(token: string): number | undefined {
  const m = PITCH_RE.exec(token);
  if (!m) return undefined;
  const semitone = SEMITONE[m[1].toLowerCase()];
  const accidental = m[2] === '#' || m[2] === 's' ? 1 : m[2] === 'b' ? -1 : 0;
  const octave = Number.parseInt(m[3], 10);
  const note = (octave + 1) * 12 + semitone + accidental;
  if (note < 0 || note > 127) {
    throw new PatternError('parse_error', `Pitch "${token}" is out of MIDI range 0..127 (got ${note}).`, { token, note });
  }
  return note;
}

/**
 * A key name → its semitone offset from C (0..11), for transposing the
 * C-based library recipes into any key. Only the ROOT is read; a mode suffix
 * (`m`, `min`, `maj`, `minor`, `major`) is ignored — the recipe already
 * carries its mode (you pick `minor_triad` vs `major_triad`), the key just
 * sets the root. `"C"`→0, `"G"`/`"Gm"`/`"G minor"`→7, `"Eb"`→3, `"F#"`→6.
 */
const KEY_RE = /^([a-gA-G])(#|s|b)?/;
export function keyToSemitones(key: string): number {
  const m = KEY_RE.exec(key.trim());
  if (!m) {
    throw new PatternError('parse_error', `Unrecognized key "${key}" (expected a root note like C, G, Eb, F#).`, { key });
  }
  const semitone = SEMITONE[m[1].toLowerCase()];
  const accidental = m[2] === '#' || m[2] === 's' ? 1 : m[2] === 'b' ? -1 : 0;
  return ((semitone + accidental) % 12 + 12) % 12;
}

/**
 * Resolve the effective semitone transpose for a melodic realize: an explicit
 * `transpose` wins; else derive it from a `key` root (its offset from C); else
 * 0. The shared rule behind `apply_pattern`'s `key`/`transpose` args — kept
 * here (next to `keyToSemitones`, in the testable pattern module) so the
 * dispatcher is a thin caller and the precedence is golden-locked.
 */
export function resolveTranspose(transpose?: number, key?: string): number {
  if (transpose !== undefined) return transpose;
  if (key !== undefined) return keyToSemitones(key);
  return 0;
}

/**
 * Parse a (possibly chord) pitch token: `"c3"` → `[48]`, `"c3+eb3+g3"` →
 * `[48,51,55]`. Returns undefined if the token is not pitched at all (so the
 * caller falls back to drum-word handling). Throws if it LOOKS pitched (has a
 * `+` or a leading pitch) but a member is malformed — no silent drop.
 */
export function tryParsePitchChord(token: string): number[] | undefined {
  if (token.includes('+')) {
    const parts = token.split('+');
    const notes = parts.map((p) => {
      const n = parsePitch(p);
      if (n === undefined) {
        throw new PatternError('parse_error', `Bad note "${p}" in chord token "${token}".`, { token, part: p });
      }
      return n;
    });
    return notes;
  }
  const single = parsePitch(token);
  return single === undefined ? undefined : [single];
}

/** `E(k,n)` or `E(k,n,rotation)`, a Euclidean rhythm as a whole voice line. */
const EUCLID_RE = /^E\(\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(-?\d+)\s*)?\)$/i;
function tryEuclid(src: string, steps?: number): Step[] | undefined {
  const m = EUCLID_RE.exec(src.trim());
  if (!m) return undefined;
  const k = Number(m[1]);
  const n = Number(m[2]);
  const rot = m[3] !== undefined ? Number(m[3]) : 0;
  const out = euclid(k, n, rot);
  if (steps !== undefined && out.length !== steps) {
    throw new PatternError('bad_grid', `Euclid E(${k},${n}) yields ${n} steps, expected ${steps}.`);
  }
  return out;
}

/** A leaf timing event emitted by the mini-notation walker. */
interface LeafEvent {
  frac: number;        // [0,1) start position within the cycle
  hit: boolean;
  accent: boolean;
  notes?: number[];    // pitched hit: the MIDI note(s) this step plays
}

// ── Char grid ────────────────────────────────────────────────────────

/** Parse a dense char grid ("x..X.x..") into a Step[]; length defines the resolution. */
export function charGridToSteps(grid: string): Step[] {
  const trimmed = grid.trim();
  if (trimmed.length === 0) {
    throw new PatternError('parse_error', 'Empty char grid.');
  }
  const out: Step[] = [];
  for (const ch of trimmed) {
    if (ch === 'x') out.push({ on: true });
    else if (ch === 'X') out.push({ on: true, accent: true });
    else if (ch === '.' || ch === '~' || ch === '-' || ch === '0') out.push({ on: false });
    // Micro-step roll digits 1..6: n evenly-spaced sub-hits within the step
    // (6 = the full "buzz"). The full range is authorable since the 2026-07-03
    // capture HW-confirmed the drum micro-hit mask is POSITIONAL and additive
    // (drumPattern.ts cites it): a roll fans to evenly-spaced micro-ticks —
    // e.g. 3 → ticks {0,3,5}, never the front-loaded contiguous burst the old
    // refusal guarded against. Note tracks fan the same spacing via per-slot
    // delay, so internal and external copies of a roll stay aligned.
    else if (ch >= '1' && ch <= '6') out.push({ on: true, roll: ch.charCodeAt(0) - 48 });
    else {
      throw new PatternError('parse_error', `Bad char-grid character '${ch}' in "${grid}".`, {
        valid: ['x', 'X', '.', '~', '-', '0', '1-6 (micro-step roll: n evenly-spaced sub-hits, 6 = buzz)'],
      });
    }
  }
  return out;
}

// ── Mini-notation ──────────────────────────────────────────────────────

type Node = SeqNode | LeafNode;
interface SeqNode { kind: 'seq'; children: Node[]; }
interface LeafNode { kind: 'leaf'; hit: boolean; accent: boolean; repeat: number; notes?: number[]; }

/** Tokenize a mini-notation line into brackets + atom tokens. */
function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  const flush = (): void => { if (buf) { tokens.push(buf); buf = ''; } };
  for (const ch of src) {
    if (ch === '[' || ch === ']') { flush(); tokens.push(ch); }
    else if (ch === ' ' || ch === '\t' || ch === '\n') { flush(); }
    else { buf += ch; }
  }
  flush();
  return tokens;
}

function parseAtom(tok: string): LeafNode {
  const star = tok.indexOf('*');
  const word = star === -1 ? tok : tok.slice(0, star);
  let repeat = 1;
  if (star !== -1) {
    const rep = tok.slice(star + 1);
    if (!/^\d+$/.test(rep)) {
      throw new PatternError('parse_error', `Bad repeat count in token "${tok}".`);
    }
    repeat = Number.parseInt(rep, 10);
    if (repeat < 1) {
      throw new PatternError('parse_error', `Repeat count must be ≥ 1 in token "${tok}".`);
    }
  }
  if (word.length === 0) {
    throw new PatternError('parse_error', `Empty token before '*' in "${tok}".`);
  }
  if (REST_TOKENS.has(word)) {
    return { kind: 'leaf', hit: false, accent: false, repeat };
  }
  // Pitched token (melodic voice): the word is a note name or `+`-joined chord.
  const notes = tryParsePitchChord(word);
  if (notes) {
    return { kind: 'leaf', hit: true, accent: false, repeat, notes };
  }
  // Drum word / rhythmic hit. Accent is the literal marker 'X' only (matches
  // the char-grid 'X'). Other hit tokens, including uppercased drum names like
  // 'BD' / 'K', are plain hits; casing must NOT imply accent (it collides with
  // voice-token casing).
  const accent = word === 'X';
  return { kind: 'leaf', hit: true, accent, repeat };
}

/** Recursive-descent: parse a sequence until end or a closing ']'. */
function parseSeq(tokens: string[], start: number): { node: SeqNode; next: number } {
  const children: Node[] = [];
  let i = start;
  while (i < tokens.length && tokens[i] !== ']') {
    if (tokens[i] === '[') {
      const inner = parseSeq(tokens, i + 1);
      if (tokens[inner.next] !== ']') {
        throw new PatternError('parse_error', 'Unbalanced "[", missing "]".');
      }
      children.push(inner.node);
      i = inner.next + 1;
    } else {
      children.push(parseAtom(tokens[i]));
      i += 1;
    }
  }
  return { node: { kind: 'seq', children }, next: i };
}

/** Walk the tree, assigning each leaf an even time slice; collect hit events. */
function walk(node: Node, start: number, span: number, out: LeafEvent[]): void {
  if (node.kind === 'seq') {
    const n = node.children.length;
    if (n === 0) return;
    const childSpan = span / n;
    node.children.forEach((child, idx) => walk(child, start + idx * childSpan, childSpan, out));
  } else {
    const repSpan = span / node.repeat;
    for (let r = 0; r < node.repeat; r++) {
      out.push({ frac: start + r * repSpan, hit: node.hit, accent: node.accent, notes: node.notes });
    }
  }
}

/** Parse a single mini-notation line onto a `steps`-cell grid. */
export function parseVoiceLine(src: string, steps: number): Step[] {
  if (!Number.isInteger(steps) || steps <= 0) {
    throw new PatternError('bad_grid', `Grid resolution must be a positive integer, got ${steps}.`);
  }
  const eu = tryEuclid(src, steps);
  if (eu) return eu;
  const tokens = tokenize(src);
  if (tokens.length === 0) {
    throw new PatternError('parse_error', `Empty mini-notation line: "${src}".`);
  }
  const { node, next } = parseSeq(tokens, 0);
  if (next !== tokens.length) {
    // A leftover ']' (no matching '[') stops parseSeq early, surface it.
    throw new PatternError('parse_error', 'Unbalanced "]", no matching "[".');
  }
  const events: LeafEvent[] = [];
  walk(node, 0, 1, events);

  const grid: Step[] = Array.from({ length: steps }, () => ({ on: false } as Step));
  const claimed = new Set<number>();
  for (const ev of events) {
    if (!ev.hit) continue;
    const cell = Math.min(steps - 1, Math.max(0, Math.floor(ev.frac * steps)));
    // No silent drop: two distinct hits quantizing to the same cell means the
    // line is denser than the grid can hold. Fail loudly (raise step count).
    if (claimed.has(cell)) {
      throw new PatternError(
        'bad_grid',
        `mini-notation "${src}" places more hits than ${steps} steps can hold without collision; raise the step count.`,
        { src, steps },
      );
    }
    claimed.add(cell);
    const step: Step = { on: true };
    if (ev.accent) step.accent = true;
    if (ev.notes) step.notes = ev.notes.length === 1 ? ev.notes[0] : ev.notes;
    grid[cell] = step;
  }
  return grid;
}

/** Auto-detect char-grid vs mini-notation (or a Euclidean E(k,n[,r]) line) and parse to a Step[]. */
export function parseVoice(src: string, steps?: number): Step[] {
  const eu = tryEuclid(src, steps);
  if (eu) return eu;
  const trimmed = src.trim();
  // Mini-notation if it has whitespace / brackets / repeat / chord-join, OR is
  // a single pitched token (`c3`, `c3+eb3+g3`) that a char grid can't express.
  const isMini = /[\s[\]*+]/.test(trimmed) || tryParsePitchChord(trimmed) !== undefined;
  if (isMini) {
    if (steps === undefined) {
      throw new PatternError('bad_grid', 'Mini-notation requires an explicit step count.');
    }
    return parseVoiceLine(src, steps);
  }
  const grid = charGridToSteps(src);
  if (steps !== undefined && grid.length !== steps) {
    throw new PatternError('bad_grid', `Char grid "${src}" has ${grid.length} steps, expected ${steps}.`);
  }
  return grid;
}

// ── Comma-stack form (multi-voice in one string) ──────────────────────

/**
 * Neutral drum-token → voice-name aliases for the comma-stack mini-notation
 * form, where each voice is anonymous and identified by its hit token
 * (`bd ~ ~ ~, hh*8`). Musical vocabulary, not device vocabulary. Tokens
 * with no alias key by their lowercased token.
 */
const DRUM_TOKEN_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  bd: 'kick', kick: 'kick', k: 'kick',
  sd: 'snare', sn: 'snare', snare: 'snare', s: 'snare',
  hh: 'hat', ch: 'hat', hat: 'hat', h: 'hat',
  oh: 'openhat', cp: 'clap', clap: 'clap',
  rs: 'perc', perc: 'perc', tom: 'tom', rd: 'ride', cr: 'crash',
});

/** Find the voice name for a line from its first hit token. */
function voiceNameForLine(src: string): string {
  for (const tok of tokenize(src)) {
    if (tok === '[' || tok === ']') continue;
    const word = (tok.split('*')[0] || '').toLowerCase();
    if (word && !REST_TOKENS.has(word)) {
      return DRUM_TOKEN_ALIASES[word] ?? word;
    }
  }
  return 'voice';
}

/** Parse a comma-stack ("bd*4, hh*8, ~ sd ~ sd") into a per-voice grid map. */
export function parseMiniNotation(src: string, steps: number): Record<string, Step[]> {
  const lines = src.split(',').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new PatternError('parse_error', `Empty mini-notation: "${src}".`);
  }
  const out: Record<string, Step[]> = {};
  lines.forEach((line, idx) => {
    let name = voiceNameForLine(line);
    if (out[name]) name = `${name}_${idx + 1}`; // disambiguate duplicate voice names
    out[name] = parseVoiceLine(line, steps);
  });
  return out;
}
