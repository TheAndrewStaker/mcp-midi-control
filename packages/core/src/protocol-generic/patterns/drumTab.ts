/**
 * ASCII drum-tablature parser → the neutral `Step[]` voice model.
 *
 * Drum tabs are the community text format for drum parts (forums, Ultimate
 * Guitar text tabs, drum-tab sites). One line per drum voice, identified by a
 * leading label, then a run of step characters. Bars are separated by `|`;
 * a song section is several stacked "systems" separated by blank lines, which
 * are CONCATENATED in order (not merged):
 *
 *   CC|x-------|--------|        <- system 1, bars 1-2
 *   HH|--x-x-x-|x-x-x-x-|
 *   SD|----o---|----o---|
 *   BD|o---o---|o-----o-|
 *                                <- blank line = next system
 *   HH|x-x-x-x-|x-x-x-x-|        <- system 2, bars 3-4
 *   SD|----o---|--o-o---|
 *   BD|o-------|o---o-o-|
 *
 * Output is device-neutral (`{ voices, steps }`): the TARGET's voice_map maps
 * abstract voices (kick/snare/hat/...) onto its pads at realize time, and a
 * device with fewer pads (the Circuit has 4) raises an honest unmapped-voice
 * error for the extras (crash/ride/tom) rather than silently dropping them.
 *
 * Step characters (community-standard): `-` `.` `_` space = rest; `x` `o` `0` =
 * hit; `X` `O` = accent; `g` = ghost (low velocity); `b` `B` = buzz roll
 * (→ roll 6, the full six-tick mask; partial rolls 2-5 are authorable via the
 * char-grid digits since the positional-mask confirmation); `f`/`d`/`r` =
 * flam/drag/ruff (no neutral representation → a plain hit). `|` = bar separator.
 */

import type { Step } from './types.js';
import { PatternError } from './types.js';

/**
 * Normalized drum-tab label → neutral voice name. The label is lowercased with
 * spaces / hyphens / dots stripped before lookup ("Hi-Hat" → "hihat", "BD" →
 * "bd", "Floor Tom" → "floortom").
 */
const TAB_VOICE_LEGEND: Readonly<Record<string, string>> = {
  // hi-hats
  hihat: 'hat', hh: 'hat', h: 'hat', closedhihat: 'hat', hhc: 'hat', hc: 'hat', chh: 'hat',
  openhihat: 'openhat', oh: 'openhat', ho: 'openhat', hho: 'openhat', ohh: 'openhat',
  // snare / kick
  snare: 'snare', sd: 'snare', sn: 'snare', s: 'snare', snaredrum: 'snare',
  bass: 'kick', bassdrum: 'kick', kick: 'kick', kickdrum: 'kick', bd: 'kick', kd: 'kick', k: 'kick', b: 'kick',
  // cymbals
  crash: 'crash', crashcymbal: 'crash', cc: 'crash', cr: 'crash', c: 'crash', crash1: 'crash', crash2: 'crash',
  ride: 'ride', ridecymbal: 'ride', rd: 'ride', rc: 'ride', r: 'ride', ridebell: 'ride',
  china: 'crash', splash: 'crash',
  // toms
  tom: 'tom', tom1: 'tom', tom2: 'tom', tom3: 'tom', hightom: 'tom', hitom: 'tom', midtom: 'tom',
  ht: 'tom', mt: 'tom', t1: 'tom', t2: 'tom', t3: 'tom', t: 'tom', racktom: 'tom',
  floortom: 'tom', ft: 'tom', lt: 'tom', lowtom: 'tom',
  // misc percussion
  rimshot: 'perc', rim: 'perc', rs: 'perc', crossstick: 'perc', cowbell: 'perc', cb: 'perc', perc: 'perc',
};

function lookupVoice(label: string): string | undefined {
  const key = label.toLowerCase().replace(/[\s.\-_]/g, '');
  return TAB_VOICE_LEGEND[key];
}

/** Map one step character to a Step, or undefined for a bar separator / ignorable. */
function tabCharToStep(ch: string): Step | undefined {
  switch (ch) {
    case '|': return undefined;                       // bar separator
    case '-': case '.': case '_': case ' ': return { on: false };
    case 'x': case 'o': case '0': return { on: true };
    case 'X': case 'O': return { on: true, accent: true };
    case 'g': return { on: true, velocity: 40 };      // ghost note
    case 'b': case 'B': return { on: true, roll: 6 }; // buzz roll (only verified micro-roll)
    case 'f': case 'd': case 'r': case 'F': case 'D': case 'R':
      return { on: true };                            // flam/drag/ruff → plain hit (no neutral form)
    default: return { on: true };                     // any other mark = a hit (lenient)
  }
}

/** Parse one tab line into { voice, steps }, or undefined if it isn't a drum line. */
function parseTabLine(raw: string): { voice: string; steps: Step[] } | undefined {
  const line = raw.trim();
  if (line === '') return undefined;
  // Form A (with bar pipe): "HH|x-x-x-x-|" — label, then everything after the first '|'.
  // Form B (no pipe):       "HH x-x-x-x-"  — label, whitespace, then the step run.
  let label: string;
  let body: string;
  const a = /^([A-Za-z][A-Za-z0-9 #]*?)\s*\|(.*)$/.exec(line);
  if (a) { label = a[1]; body = a[2]; } else {
    const b = /^([A-Za-z][A-Za-z0-9 #]*?)\s+([-xXoO0bBgGfFdDrR.\s|]+)$/.exec(line);
    if (!b) return undefined;
    label = b[1]; body = b[2];
  }
  const voice = lookupVoice(label);
  if (voice === undefined) return undefined; // not a recognized drum label (count line, prose, ...)
  const steps: Step[] = [];
  for (const ch of body) {
    const s = tabCharToStep(ch);
    if (s !== undefined) steps.push(s);
  }
  return steps.length > 0 ? { voice, steps } : undefined;
}

/** OR two equal-or-unequal step rows for the same voice in one system (a hit wins). */
function mergeRows(a: readonly Step[], b: readonly Step[]): Step[] {
  const n = Math.max(a.length, b.length);
  const out: Step[] = [];
  for (let i = 0; i < n; i++) {
    const x = a[i]; const y = b[i];
    if (x?.on && y?.on) out.push(x.accent || y.accent ? { on: true, accent: true } : { ...x });
    else out.push(x?.on ? { ...x } : y?.on ? { ...y } : { on: false });
  }
  return out;
}

/** Pad (or truncate) a row to exactly `width` steps. */
function padTo(row: readonly Step[], width: number): Step[] {
  const out = row.slice(0, width).map((s) => ({ ...s }));
  while (out.length < width) out.push({ on: false });
  return out;
}

export interface ParsedDrumTab {
  voices: Record<string, Step[]>;
  steps: number;
  /** Non-fatal observations (uneven system widths, voices on extra pads, ...). */
  warnings: string[];
}

/**
 * Parse a full ASCII drum tab into a neutral voice→step map. Systems (blank-line
 * separated bar groups) are concatenated in order; within a system, duplicate
 * voice lines (e.g. two tom rows) are OR-merged; a voice absent from a system is
 * filled with rests for that system's width.
 */
export function parseDrumTab(tab: string): ParsedDrumTab {
  const warnings: string[] = [];
  const systems = tab.split(/\r?\n[ \t]*\r?\n/).map((s) => s.replace(/\s+$/u, '')).filter((s) => s.trim() !== '');

  const parsedSystems: { rows: Record<string, Step[]>; width: number }[] = [];
  const allVoices = new Set<string>();
  for (const sys of systems) {
    const rows: Record<string, Step[]> = {};
    let width = 0;
    for (const raw of sys.split(/\r?\n/)) {
      const parsed = parseTabLine(raw);
      if (!parsed) continue;
      width = Math.max(width, parsed.steps.length);
      rows[parsed.voice] = rows[parsed.voice] ? mergeRows(rows[parsed.voice], parsed.steps) : parsed.steps;
      allVoices.add(parsed.voice);
    }
    if (width > 0) {
      const ragged = Object.entries(rows).filter(([, r]) => r.length !== width).map(([v]) => v);
      if (ragged.length > 0) {
        warnings.push(`A system has uneven line widths (voices ${ragged.join(', ')} padded to ${width} steps); check the tab is column-aligned.`);
      }
      parsedSystems.push({ rows, width });
    }
  }
  if (parsedSystems.length === 0) {
    throw new PatternError(
      'parse_error',
      'No drum-tab lines recognized. Expected lines like "HH|x-x-x-x-|" or "BD o---o---". ' +
      'Recognized voices: kick (BD/B/K), snare (SD/S), hat (HH/H), openhat (OH), crash (CC/C), ride (RD/R), tom (T/FT), perc (RS).',
    );
  }

  const voices: Record<string, Step[]> = {};
  for (const v of allVoices) voices[v] = [];
  for (const sys of parsedSystems) {
    for (const v of allVoices) {
      voices[v].push(...padTo(sys.rows[v] ?? [], sys.width));
    }
  }
  const steps = voices[[...allVoices][0]]?.length ?? 0;
  return { voices, steps, warnings };
}
