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
 *  GATE (note length) and TIE, suffixes on any hit token:
 *       "c3:4 ~ ~ ~"            hold C3 for 4 STEPS (a pad, not a blip)
 *       "c3:0.5 c3:0.5"         staccato, half a step each
 *       "c3:1/6"                the shortest the device holds (one sixth)
 *       "c3:16_ ~ … c3"         held 16 steps AND tied forward into the next
 *                               onset (a drone)
 *       "c3_ ~ ~ ~ c3 ~ ~ ~"    bare `_` = tie, with the gate COMPUTED to reach
 *                               the next onset exactly (wrapping to the next
 *                               cycle's first onset when it is the last note)
 *     `:len` is in STEPS, the unit the device's own Gate View shows; it may be
 *     an integer, a decimal ("0.5"), or a fraction ("1/6"), and it must land
 *     exactly on a sixth of a step (the field's real resolution) or it throws
 *     rather than silently rounding your note length. A chord takes ONE suffix
 *     for the whole token ("c3+eb3+g3:8"), because the device's tie is a
 *     per-STEP control. Combine with repeat as "c3:2*4" (gate first).
 *     Char grids cannot express a gate: one character per step leaves nowhere
 *     to put a length, so a pattern that needs note lengths is mini-notation.
 *
 *  VELOCITY, a third suffix on any hit token:
 *       "c3@110 c3@70 c3@95"    per-note dynamics, 1..127
 *       "c3:4@110_"             combine with the length and the tie, in any order
 *     Written `@` + the MIDI velocity. It exists because the grammar's only
 *     dynamic used to be the char-grid `X` accent, which is one bit, and one bit
 *     cannot carry a source's five-level dynamic ladder or a per-note accent.
 *     A row imported from a real score resolved its velocities correctly, put
 *     them in `Step.velocity`, and then lost every one of them at THIS boundary,
 *     because the row is what gets pasted into `apply_pattern` and the row said
 *     nothing about loudness. Char grids again cannot express it (`X` is the
 *     nearest they get). Absent = the realize-time default / accent table, so
 *     nothing authored before this existed moves.
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
 * `parseVoice` auto-detects: a string with whitespace, `[`/`]`, `*`, `+`, `:`,
 * `@` or `_`, or a single bare pitch/chord token, is mini-notation; otherwise
 * it's a char grid.
 */

import type { Step } from './types.js';
import {
  GATE_SIXTHS_PER_STEP,
  MAX_GATE_SIXTHS,
  MIN_GATE_SIXTHS,
  PatternError,
} from './types.js';
import { euclid } from './euclid.js';

const REST_TOKENS = new Set(['~', '.', '-', '0']);

// ── Gate / tie suffixes ────────────────────────────────────────────────

/**
 * Note-length suffix marker. `:` is the one punctuation free across every
 * authoring surface here: it is not a rest char (`~ . - 0`), not the repeat
 * (`*`), not the chord join (`+`), not a subgroup bracket, and it cannot occur
 * inside a pitch name or a drum word, so adding it changes the meaning of no
 * string that parsed before.
 */
const GATE_MARK = ':';
/**
 * Tie-forward marker. `_` is likewise unused by every surface, it is the
 * hold/elongate glyph in the TidalCycles/Strudel dialect this notation is a
 * subset of, and it reads on the page as the note carrying on.
 */
const TIE_MARK = '_';
/**
 * Velocity suffix marker. `@` is the next punctuation free across every surface
 * here: it is not a rest char, not the repeat, not the chord join, not a bracket,
 * not the gate or tie mark, and it cannot occur inside a pitch name, a drum word
 * or a length, so adding it changes the meaning of no string that parsed before.
 */
const VELOCITY_MARK = '@';

/** A note length written in STEPS: "4", "0.5", "1/6". */
const GATE_LEN_RE = /^(?:(\d+)\/(\d+)|(\d+)(?:\.(\d+))?)$/;

/**
 * Convert a length written in STEPS to the neutral unit, sixths of a step,
 * EXACTLY. Rational arithmetic throughout: "1/3" is 2 sixths and "0.5" is 3,
 * while "0.4" is 2.4 sixths, which the field cannot hold. That throws instead
 * of rounding, because a silently shortened note is exactly the failure this
 * whole field exists to stop.
 */
function stepsToSixths(len: string, token: string): number {
  const m = GATE_LEN_RE.exec(len);
  if (!m) {
    throw new PatternError(
      'parse_error',
      `Bad note length "${len}" in token "${token}". Write it in STEPS: an integer ("c3:4"), a decimal ("c3:0.5"), or a fraction ("c3:1/6").`,
      { token, length: len },
    );
  }
  let num: number;
  let den: number;
  if (m[1] !== undefined) {
    num = Number.parseInt(m[1], 10);
    den = Number.parseInt(m[2], 10);
    if (den === 0) {
      throw new PatternError('parse_error', `Note length "${len}" in token "${token}" divides by zero.`, { token });
    }
  } else {
    const frac = m[4] ?? '';
    den = 10 ** frac.length;
    num = Number.parseInt(m[3] + frac, 10);
  }
  const sixths = (num * GATE_SIXTHS_PER_STEP) / den;
  if (!Number.isInteger(sixths)) {
    const lo = Math.floor(sixths);
    throw new PatternError(
      'parse_error',
      `Note length "${len}" in token "${token}" is ${sixths} sixths of a step, and the gate field only holds whole sixths. ` +
      `Use ${lo / GATE_SIXTHS_PER_STEP} or ${(lo + 1) / GATE_SIXTHS_PER_STEP} steps (every length is a multiple of 1/6).`,
      { token, length: len, sixths },
    );
  }
  if (sixths < MIN_GATE_SIXTHS || sixths > MAX_GATE_SIXTHS) {
    throw new PatternError(
      'parse_error',
      `Note length "${len}" in token "${token}" is ${sixths / GATE_SIXTHS_PER_STEP} step(s); the range is ` +
      `${MIN_GATE_SIXTHS / GATE_SIXTHS_PER_STEP} (one sixth) to ${MAX_GATE_SIXTHS / GATE_SIXTHS_PER_STEP} steps.`,
      { token, length: len, sixths },
    );
  }
  return sixths;
}

/** A token's word with its gate/velocity/tie suffixes stripped off and decoded. */
interface GateSuffix {
  word: string;
  gate_sixths?: number;
  /** `@vel` was present: this step's explicit MIDI velocity, 1..127. */
  velocity?: number;
  /** `_` was present: this step ties forward. */
  tie: boolean;
  /** `_` with no `:len`: the gate is computed to reach the next onset. */
  autoGate: boolean;
}

/** Pull `@vel` out of a token, wherever it sits, and validate it. */
function splitVelocitySuffix(rest: string, token: string): { rest: string; velocity?: number } {
  const mark = rest.indexOf(VELOCITY_MARK);
  if (mark === -1) return { rest };
  // Digits only, and only up to the next suffix mark, so `"c3@85:1/6"` and
  // `"c3:1/6@85"` both read the same and neither eats into the length.
  const m = /^@(\d*)/.exec(rest.slice(mark));
  const digits = m?.[1] ?? '';
  if (digits.length === 0) {
    throw new PatternError(
      'parse_error',
      `Token "${token}" ends in "@" with no velocity. Write the MIDI velocity 1..127, e.g. "${rest.slice(0, mark) || 'c3'}@110".`,
      { token },
    );
  }
  const velocity = Number.parseInt(digits, 10);
  if (velocity < 1 || velocity > 127) {
    throw new PatternError(
      'parse_error',
      `Velocity ${velocity} in token "${token}" is outside 1..127. Velocity 0 is a note-OFF on the wire, not a quiet note: `
      + 'use 1 for the quietest audible hit, or a rest ("~") for silence.',
      { token, velocity },
    );
  }
  return { rest: rest.slice(0, mark) + rest.slice(mark + 1 + digits.length), velocity };
}

/** Split `word[:len][@vel][_]` (suffixes in any order) into the bare word plus its decoded suffixes. */
function splitGateSuffix(word: string): GateSuffix {
  let rest = word;
  let tie = false;
  if (rest.endsWith(TIE_MARK)) {
    tie = true;
    rest = rest.slice(0, -1);
    if (rest.length === 0) {
      throw new PatternError(
        'parse_error',
        `"${word}" is a bare tie marker. "_" is a SUFFIX on the note it ties forward ("c3_" or "c3:16_"), not a token of its own.`,
        { token: word },
      );
    }
  }
  const vel = splitVelocitySuffix(rest, word);
  rest = vel.rest;
  const velocity = vel.velocity !== undefined ? { velocity: vel.velocity } : {};
  if (rest.length === 0) {
    throw new PatternError('parse_error', `Token "${word}" has a velocity but no note before it.`, { token: word });
  }
  const mark = rest.indexOf(GATE_MARK);
  if (mark === -1) return { word: rest, ...velocity, tie, autoGate: tie };
  const len = rest.slice(mark + 1);
  const bare = rest.slice(0, mark);
  if (bare.length === 0) {
    throw new PatternError('parse_error', `Token "${word}" has a note length but no note before it.`, { token: word });
  }
  if (len.length === 0) {
    throw new PatternError('parse_error', `Token "${word}" ends in ":" with no length. Write the length in steps, e.g. "${bare}:4".`, { token: word });
  }
  return { word: bare, gate_sixths: stepsToSixths(len, word), ...velocity, tie, autoGate: false };
}

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
  gate_sixths?: number; // explicit note length, in sixths of a step
  velocity?: number;    // explicit MIDI velocity from `@vel`
  tie?: boolean;        // tie-forward into the next onset
  autoGate?: boolean;   // bare `_`: derive the gate from the distance to that onset
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
interface LeafNode {
  kind: 'leaf'; hit: boolean; accent: boolean; repeat: number; notes?: number[];
  gate_sixths?: number; velocity?: number; tie?: boolean; autoGate?: boolean;
}

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
  const withSuffix = star === -1 ? tok : tok.slice(0, star);
  let repeat = 1;
  if (star !== -1) {
    const rep = tok.slice(star + 1);
    if (!/^\d+$/.test(rep)) {
      throw new PatternError(
        'parse_error',
        `Bad repeat count in token "${tok}".` +
        (rep.includes(GATE_MARK) || rep.includes(TIE_MARK)
          ? ' A note length or tie goes BEFORE the repeat, e.g. "c3:2*4", not "c3*4:2".'
          : ''),
      );
    }
    repeat = Number.parseInt(rep, 10);
    if (repeat < 1) {
      throw new PatternError('parse_error', `Repeat count must be ≥ 1 in token "${tok}".`);
    }
  }
  if (withSuffix.length === 0) {
    throw new PatternError('parse_error', `Empty token before '*' in "${tok}".`);
  }
  // Note LENGTH / TIE suffixes come off first, so the word underneath is the
  // plain pitch, chord or drum word every other branch already understands.
  const { word, gate_sixths, velocity, tie, autoGate } = splitGateSuffix(withSuffix);
  const gated = gate_sixths !== undefined || tie || velocity !== undefined;
  if (REST_TOKENS.has(word)) {
    if (gated) {
      throw new PatternError(
        'parse_error',
        `Token "${tok}" puts a note length, velocity or tie on a REST. A rest has none of those; move the suffix onto the note that sounds.`,
        { token: tok },
      );
    }
    return { kind: 'leaf', hit: false, accent: false, repeat };
  }
  const extras = {
    ...(gate_sixths !== undefined ? { gate_sixths } : {}),
    ...(velocity !== undefined ? { velocity } : {}),
    ...(tie ? { tie: true } : {}),
    ...(autoGate ? { autoGate: true } : {}),
  };
  // Pitched token (melodic voice): the word is a note name or `+`-joined chord.
  const notes = tryParsePitchChord(word);
  if (notes) {
    return { kind: 'leaf', hit: true, accent: false, repeat, notes, ...extras };
  }
  // Drum word / rhythmic hit. Accent is the literal marker 'X' only (matches
  // the char-grid 'X'). Other hit tokens, including uppercased drum names like
  // 'BD' / 'K', are plain hits; casing must NOT imply accent (it collides with
  // voice-token casing).
  const accent = word === 'X';
  return { kind: 'leaf', hit: true, accent, repeat, ...extras };
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
      out.push({
        frac: start + r * repSpan, hit: node.hit, accent: node.accent, notes: node.notes,
        gate_sixths: node.gate_sixths, velocity: node.velocity, tie: node.tie, autoGate: node.autoGate,
      });
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
  // Cells whose tie was written as a bare `_`; their gate is derived from the
  // finished grid (below), not from the token, so it always reaches its onset.
  const autoGate = new Set<number>();
  for (const ev of events) {
    if (!ev.hit) continue;
    // The epsilon is load-bearing, not defensive. `walk` builds each leaf's
    // position as `index * (1/n)`, which is NOT the same double as `index / n`:
    // at 12, 24 and 48 tokens, indices 7 and 14 (and 25, 28, 31 at 48) come back
    // a hair LOW, so a bare floor lands them on the previous cell and the line
    // dies with "places more hits than N steps can hold". A 24-step row is a
    // 6/8 or 12/8 bar at a 16th grid, which is not exotic: it is every measure of
    // a song like Schism, and importing one threw before this epsilon existed.
    const cell = Math.min(steps - 1, Math.max(0, Math.floor(ev.frac * steps + 1e-9)));
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
    if (ev.gate_sixths !== undefined) step.gate_sixths = ev.gate_sixths;
    if (ev.velocity !== undefined) step.velocity = ev.velocity;
    if (ev.tie) step.tie = true;
    if (ev.autoGate) autoGate.add(cell);
    grid[cell] = step;
  }
  resolveAutoGates(grid, autoGate, src);
  return grid;
}

/**
 * Resolve every bare-`_` tie into the gate that actually reaches the onset it
 * ties into. The device's rule (manual, and 524 of 524 real ties in a 274-file
 * corpus) is that a tied note's gate must end EXACTLY where the next onset
 * begins; anything shorter is a silent no-op and anything longer overlaps. So
 * `_` computes the length rather than making the writer trust two numbers a
 * caller supplied independently.
 *
 * Wrapping counts: a tie on the LAST onset reaches the next cycle's first
 * onset, which is the manual's own worked example (a note at step 0 tied into
 * the same note 16 steps later) and the shape of the maintainer's GateTest16
 * probe project.
 */
function resolveAutoGates(grid: Step[], autoGate: ReadonlySet<number>, src: string): void {
  if (autoGate.size === 0) return;
  const onsets: number[] = [];
  for (let i = 0; i < grid.length; i++) if (grid[i].on) onsets.push(i);
  for (const cell of autoGate) {
    const later = onsets.find((o) => o > cell);
    // Only one onset in the row ⇒ it ties into its own next repeat, a full cycle.
    const distance = (later ?? onsets[0] + grid.length) - cell;
    const sixths = distance * GATE_SIXTHS_PER_STEP;
    if (sixths > MAX_GATE_SIXTHS) {
      throw new PatternError(
        'bad_grid',
        `A tie ("_") at step ${cell + 1} of "${src}" would have to hold ${distance} steps to reach the next onset, and the ` +
        `longest note the gate field holds is ${MAX_GATE_SIXTHS / GATE_SIXTHS_PER_STEP} steps. Put an onset closer, or state ` +
        `an explicit length instead (e.g. ":16").`,
        { src, step: cell, distance },
      );
    }
    grid[cell] = { ...grid[cell], gate_sixths: sixths, tie: true };
  }
}

/** Auto-detect char-grid vs mini-notation (or a Euclidean E(k,n[,r]) line) and parse to a Step[]. */
export function parseVoice(src: string, steps?: number): Step[] {
  const eu = tryEuclid(src, steps);
  if (eu) return eu;
  const trimmed = src.trim();
  // Mini-notation if it has whitespace / brackets / repeat / chord-join / a
  // gate, velocity or tie suffix, OR is a single pitched token (`c3`,
  // `c3+eb3+g3`) that a char grid can't express. `:`, `@` and `_` are in the set
  // because a char grid has no character that can carry a note length or a
  // velocity, so a lone "c3:4" or "c3@110" is unambiguous.
  const isMini = /[\s[\]*+:@_]/.test(trimmed) || tryParsePitchChord(trimmed) !== undefined;
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
    // Strip the repeat AND every suffix: "bd:2@70*4" names the `bd` voice, not a
    // voice called "bd:2@70".
    const bare = (tok.split('*')[0] || '').replace(/_$/, '').split(GATE_MARK)[0].split(VELOCITY_MARK)[0];
    const word = bare.toLowerCase();
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
