/**
 * Tempo-division spelling goldens. Pins the 2026-11-27 fix: "1/8." used to
 * resolve to plain "1/8" (the dot was stripped by the relaxed enum match).
 * Every dotted / triplet spelling must keep its modifier or be refused, and
 * the AM4 resolver must land on the roster's own index for each.
 */
import { spellTempoDivision } from '../../src/shared/tempoSpelling.js';
import { resolveEnumValue, KNOWN_PARAMS } from '../../src/am4/params.js';

const ROSTER = ['NONE ', '1/8 TRIP', '1/8', '1/8 DOT', '1/4 TRIP', '1/4', '1/4 DOT', '1', '2'];

const SPELL_CASES: Array<[string, string | undefined | null]> = [
  // [input, expected canonical]; null = not a division spelling (caller matches as usual)
  ['1/8.', '1/8 DOT'],
  ['1/8 dotted', '1/8 DOT'],
  ['dotted 1/8', '1/8 DOT'],
  ['dotted eighth', '1/8 DOT'],
  ['dotted 8th note', '1/8 DOT'],
  ['1/8d', '1/8 DOT'],
  ['1/8t', '1/8 TRIP'],
  ['eighth triplet', '1/8 TRIP'],
  ['quarter', '1/4'],
  ['1/16.', undefined], // dotted 1/16 not in this roster: refuse, never drop the dot
  ['1/8', null],
  ['2', null],
  ['Plexi 100W', null],
];

const AM4_INDEX_CASES: Array<[string, number]> = [
  ['1/8.', 12],
  ['dotted eighth', 12],
  ['1/8', 11],
  ['1/4.', 15],
  ['1/8t', 10],
];

export const TEMPOSPELLING_CASE_COUNT = SPELL_CASES.length + AM4_INDEX_CASES.length + 1;

export function runTempoSpellingTests(): void {
  const failures: string[] = [];
  for (const [input, expected] of SPELL_CASES) {
    const got = spellTempoDivision(input, ROSTER);
    const canonical = got === undefined ? null : got.canonical;
    if (canonical !== expected) failures.push(`spell ${JSON.stringify(input)}: expected ${String(expected)}, got ${String(canonical)}`);
  }
  // Non-tempo roster: never engages.
  if (spellTempoDivision('1/8.', ['Plexi', 'Brit 800']) !== undefined) failures.push('engaged on a non-tempo roster');

  const tempo = KNOWN_PARAMS['delay.tempo'];
  if (tempo === undefined) throw new Error('am4 delay.tempo missing');
  for (const [input, expected] of AM4_INDEX_CASES) {
    const got = resolveEnumValue(tempo, input);
    if (got !== expected) failures.push(`am4 ${JSON.stringify(input)}: expected ${expected}, got ${String(got)}`);
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
}
