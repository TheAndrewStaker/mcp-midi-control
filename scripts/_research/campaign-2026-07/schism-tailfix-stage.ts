/**
 * Schism tail-fix (Option C) Phase-0 staging. READ-ONLY: no device, no writes.
 * Run: npx tsx samples/_scratch/schism-tailfix-stage.ts   (from repo root)
 *
 * Builds the six re-author arrangements (slots 17,18,19,20,23,24) from the
 * PINNED cache (samples/songsterr-cache/s6700, rev 8009215) via the EXACT
 * import path the MCP tool uses (importSongsterrMelodic / importSongsterrDrums
 * + quantizedToGrids, codec-default options), asserts:
 *   - live-fetch oracle: slot 17 w1 row == the row the live MCP fetch returned
 *   - Option C packings match the defect doc
 *   - every final pattern carries its cycle-closing bar (defect doc enumerations)
 * and emits samples/_scratch/schism-tailfix-staged.json for the apply_pattern calls.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  importSongsterrMelodic, importSongsterrDrums, flattenSongsterrMelodic,
  type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { quantizedToGrids } from '../../packages/core/src/protocol-generic/patterns/midiFile.js';
import { packPatternsOnBarLines } from '../../packages/core/src/protocol-generic/patterns/songChop.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s6700';
const load = (id: number) => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const part2 = load(2); // Synth 1 (t2)
const part3 = load(3); // MIDI 1 -> MicroFreak (t3)
const part5 = load(5); // drums -> MIDI 2 + condensed internal (t5)
const measures = flattenSongsterrMelodic(part2).measures;

interface SlotSpec {
  slot: number; template: string; project_name: string;
  from: number; to: number; expectSteps: number[];
  midi1: boolean; drums: boolean;
}
const SLOTS: SlotSpec[] = [
  { slot: 17, template: 'samples/circuit-tracks/schism/09-int1.ncs', project_name: 'Schism 09 Int1', from: 118, to: 137, expectSteps: [24, 30, 24, 30, 24, 30, 24, 30], midi1: false, drums: false },
  { slot: 18, template: 'samples/circuit-tracks/schism/10-int2.ncs', project_name: 'Schism 10 Int2', from: 138, to: 157, expectSteps: [24, 30, 24, 30, 24, 30, 24, 30], midi1: true, drums: false },
  { slot: 19, template: 'samples/circuit-tracks/schism/11-int3.ncs', project_name: 'Schism 11 Int3', from: 158, to: 174, expectSteps: [24, 30, 24, 30, 24, 30, 24], midi1: true, drums: false },
  { slot: 20, template: 'samples/circuit-tracks/schism/12-int4.ncs', project_name: 'Schism 12 Int4', from: 175, to: 191, expectSteps: [30, 32, 24, 28, 32, 32, 6], midi1: false, drums: true },
  { slot: 23, template: 'samples/circuit-tracks/schism/15-out1.ncs', project_name: 'Schism 15 Out1', from: 214, to: 227, expectSteps: [24, 24, 24, 24, 24, 24, 24], midi1: false, drums: true },
  { slot: 24, template: 'samples/circuit-tracks/schism/16-out2.ncs', project_name: 'Schism 16 Out2', from: 228, to: 238, expectSteps: [24, 32, 32, 32, 32, 16], midi1: false, drums: true },
];

// the row the ONE live MCP fetch returned for m118-119 (rev 8009215): the
// live-vs-cache oracle for this whole offline run.
const LIVE_ORACLE_17W1 =
  '~ ~ ~ ~ e4:2@40 ~ a2:1/2@34 ~ a2:1/2@34 ~ g4:2@40 ~ a2:1/2@34 ~ a2:1/2@34 ~ e4:2@40 ~ a2:1/2@34 ~ a2:1/2@34 ~ a4:2@40 ~';

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`  FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`  ok: ${msg}`);

const tokensOf = (row: string): string[] => row.trim().split(/\s+/);
const pitchAt = (row: string, step: number): string => {
  const t = tokensOf(row)[step] ?? '~';
  return t === '~' ? '~' : t.split(/[:@_]/)[0];
};
const onsetSteps = (row: string): number[] =>
  tokensOf(row).flatMap((t, i) => (t !== '~' && !t.startsWith('~') ? [i] : []));

interface Section { name: string; steps: number; voices: Record<string, string> }
interface Staged { slot: number; template: string; project_name: string; drums: boolean; sections: Section[] }
const staged: Staged[] = [];

for (const s of SLOTS) {
  console.log(`\n=== slot ${s.slot} "${s.project_name}" m${s.from}-${s.to} ===`);
  const wins = packPatternsOnBarLines(measures, s.from - 1, s.to - 1, 4, 32);
  const steps = wins.map((w) => w.steps);
  if (JSON.stringify(steps) !== JSON.stringify(s.expectSteps)) {
    fail(`packing [${steps}] != expected [${s.expectSteps}]`);
  } else ok(`packing [${steps}] (${wins.map((w) => `m${w.from_measure}-${w.to_measure}`).join(' ')})`);

  const sections: Section[] = [];
  for (const w of wins) {
    const name = `m${w.from_measure}${w.to_measure !== w.from_measure ? '-' + w.to_measure : ''}`;
    const voices: Record<string, string> = {};
    const s1 = importSongsterrMelodic(part2, { stepsPerBeat: 4, fromMeasure: w.from_measure, toMeasure: w.to_measure });
    if (s1.step_count !== w.steps) fail(`${name} synth1 step_count ${s1.step_count} != ${w.steps}`);
    if (onsetSteps(s1.notation).length > 0) voices.synth1 = s1.notation;
    if (s.midi1) {
      const m1 = importSongsterrMelodic(part3, { stepsPerBeat: 4, fromMeasure: w.from_measure, toMeasure: w.to_measure });
      if (m1.step_count !== w.steps) fail(`${name} midi1 step_count ${m1.step_count} != ${w.steps}`);
      if (onsetSteps(m1.notation).length > 0) voices.midi1 = m1.notation;
    }
    if (s.drums) {
      const dr = importSongsterrDrums(part5, { stepsPerBeat: 4, fromMeasure: w.from_measure, toMeasure: w.to_measure });
      if (dr.steps !== w.steps) fail(`${name} drums steps ${dr.steps} != ${w.steps}`);
      const grids = quantizedToGrids(dr);
      for (const [voice, grid] of Object.entries(grids)) {
        if (/[^.]/.test(grid)) voices[voice] = grid;
      }
    }
    if (Object.keys(voices).length === 0) {
      voices.kick = '.'.repeat(w.steps); // all-rest hold: the pattern must exist at length
      console.log(`  note: ${name} is an all-rest hold (${w.steps} steps)`);
    }
    sections.push({ name, steps: w.steps, voices });
  }
  staged.push({ slot: s.slot, template: s.template, project_name: s.project_name, drums: s.drums, sections });
}

// ── assertions ───────────────────────────────────────────────────────
console.log('\n=== assertions ===');

// 0) live-fetch oracle
const st17 = staged.find((x) => x.slot === 17)!;
if (st17.sections[0].voices.synth1 === LIVE_ORACLE_17W1) ok('slot 17 w1 row == live MCP fetch row (cache==live oracle)');
else fail(`slot 17 w1 row != live fetch row:\n    offline: ${st17.sections[0].voices.synth1}\n    live:    ${LIVE_ORACLE_17W1}`);

// 1) slot 17 final pattern (m135-137, 30 steps): m137 closer a2 a2 d4 a2 c4 a2 at 18,20,22,24,26,28
{
  const row = st17.sections[7].voices.synth1 ?? '';
  const want: Array<[number, string]> = [[18, 'a2'], [20, 'a2'], [22, 'd4'], [24, 'a2'], [26, 'c4'], [28, 'a2']];
  const bad = want.filter(([st, p]) => pitchAt(row, st) !== p);
  if (bad.length === 0) ok('slot 17 pat8 carries the m137 closer (a2 a2 d4 a2 c4 a2 @ 18/20/22/24/26/28)');
  else fail(`slot 17 pat8 closer wrong at ${bad.map(([st, p]) => `${st}(want ${p} got ${pitchAt(row, st)})`).join(' ')}`);
}

// 2) slot 18 final pattern (m155-157, 30): S1 3/8 closer a2 a2 c4 at 12/14/16; M1 close present (c3@12 c4@13 + m157 onsets)
{
  const st18 = staged.find((x) => x.slot === 18)!;
  const s1 = st18.sections[7].voices.synth1 ?? '';
  const want: Array<[number, string]> = [[12, 'a2'], [14, 'a2'], [16, 'c4']];
  const bad = want.filter(([st, p]) => pitchAt(s1, st) !== p);
  if (bad.length === 0) ok('slot 18 pat8 S1 carries the 3/8 closer (a2 a2 c4 @ 12/14/16)');
  else fail(`slot 18 pat8 S1 closer wrong at ${bad.map(([st, p]) => `${st}(want ${p} got ${pitchAt(s1, st)})`).join(' ')}`);
  const m1 = st18.sections[7].voices.midi1 ?? '';
  const m1on = onsetSteps(m1);
  const m157on = m1on.filter((x) => x >= 18);
  if (pitchAt(m1, 12) === 'c3' && pitchAt(m1, 13) === 'c4' && m157on.length > 0)
    ok(`slot 18 pat8 M1 carries the close (c3@12 c4@13 + m157 onsets @ [${m157on}] = [${m157on.map((x) => pitchAt(m1, x))}])`);
  else fail(`slot 18 pat8 M1 close missing: @12=${pitchAt(m1, 12)} @13=${pitchAt(m1, 13)} m157 onsets=[${m157on}] row="${m1}"`);
}

// 3) slot 19 final pattern (m173-174, 24): m174 = a2 a2 e4 a2 a2 a4 at 12/14/16/18/20/22
{
  const st19 = staged.find((x) => x.slot === 19)!;
  const row = st19.sections[6].voices.synth1 ?? '';
  const want: Array<[number, string]> = [[12, 'a2'], [14, 'a2'], [16, 'e4'], [18, 'a2'], [20, 'a2'], [22, 'a4']];
  const bad = want.filter(([st, p]) => pitchAt(row, st) !== p);
  if (bad.length === 0) ok('slot 19 pat7 carries m174 (a2 a2 e4 a2 a2 a4 @ 12..22)');
  else fail(`slot 19 pat7 m174 wrong at ${bad.map(([st, p]) => `${st}(want ${p} got ${pitchAt(row, st)})`).join(' ')}`);
  const m1w1 = st19.sections[0].voices.midi1;
  console.log(`  info: slot 19 w1 midi1 ${m1w1 ? `= "${m1w1}"` : 'is EMPTY (close fully in slot 18)'} `);
}

// 4) slot 23 final pattern (m226-227, 24): m227 7/8 chord bar = 11 chord cells at steps 10..23, f2+c3 first, g2+d3 in the bar
{
  const st23 = staged.find((x) => x.slot === 23)!;
  const row = st23.sections[6].voices.synth1 ?? '';
  const on = onsetSteps(row).filter((x) => x >= 10);
  const t10 = tokensOf(row)[10] ?? '~';
  const hasG2D3 = tokensOf(row).slice(10).some((t) => t.includes('g2') && t.includes('d3'));
  if (on.length === 11 && t10.includes('f2') && t10.includes('c3') && hasG2D3)
    ok(`slot 23 pat7 carries the m227 7/8 chord bar (11 cells @ [${on}], opens f2+c3, has g2+d3)`);
  else fail(`slot 23 pat7 m227 bar wrong: ${on.length} cells @ [${on}], step10="${t10}", g2+d3=${hasG2D3} row="${row}"`);
}

// 5) slot 20 + 24 shape notes (wraps were already clean; verify content exists where expected)
{
  const st20 = staged.find((x) => x.slot === 20)!;
  const st24 = staged.find((x) => x.slot === 24)!;
  console.log(`  info: slot 20 sections: ${st20.sections.map((x) => `${x.name}(${x.steps}:[${Object.keys(x.voices)}])`).join(' ')}`);
  console.log(`  info: slot 24 sections: ${st24.sections.map((x) => `${x.name}(${x.steps}:[${Object.keys(x.voices)}])`).join(' ')}`);
}

writeFileSync('C:/dev/mcp-midi-tools/samples/_scratch/schism-tailfix-staged.json', JSON.stringify(staged, null, 2));
console.log(`\n${failures === 0 ? 'ALL STAGING CHECKS PASS' : failures + ' FAILURES'} — staged JSON written to samples/_scratch/schism-tailfix-staged.json`);
process.exitCode = failures === 0 ? 0 : 1;
