/**
 * "After Dark" section builder + TIE SPLIT verification. Read-only, no device.
 *
 * Turns each mapped part's import window into the 32-step `arrangement` sections
 * `apply_pattern` actually authors, carrying REAL note lengths from the source:
 *
 *   - a cell's `duration_steps` becomes a `:len` suffix (len in steps),
 *   - a length over the 16-step gate ceiling becomes a TIE SPLIT: `:16_` plus a
 *     re-articulation of the identical token 16 steps later, which is the
 *     device's own documented drone recipe (notePattern.ts: 524/524 corpus ties
 *     end exactly where the next onset begins, holding the identical chord).
 *
 * Every emitted line is parsed back with `parseVoice` and asserted against the
 * gate magnitude + tie flag it should produce, so the payload is checked here
 * rather than on the device.
 *
 * Run:  npx tsx scripts/after-dark-sections.ts
 */

import { fetchSongsterrPart } from '../packages/core/src/protocol-generic/patterns/songsterrFetch.js';
import { importSongsterrMelodic, importSongsterrDrums, pitchToken, type MelodicCell } from '../packages/core/src/protocol-generic/patterns/songsterr.js';
import { parseVoice } from '../packages/core/src/protocol-generic/patterns/miniNotation.js';
import { GATE_SIXTHS_PER_STEP, MAX_GATE_SIXTHS } from '../packages/core/src/protocol-generic/patterns/types.js';

const SONG = '501859';
const SECTION_STEPS = 32;
/** 96 sixths / 6 = the longest note one gate byte holds, in steps. */
const MAX_GATE_STEPS = MAX_GATE_SIXTHS / GATE_SIXTHS_PER_STEP;

interface Emitted { token: string; gateSteps: number; tie: boolean }

/**
 * Lay one section's cells out as `tokens[32]`, splitting any length past the
 * gate ceiling into a tied chain. Returns the row plus what it had to do.
 */
function layoutSection(cells: MelodicCell[], base: number): { row: (Emitted | undefined)[]; splits: string[]; clamps: string[] } {
  const row: (Emitted | undefined)[] = Array.from({ length: SECTION_STEPS }, () => undefined);
  const splits: string[] = [];
  const clamps: string[] = [];
  for (const c of cells) {
    const local = c.step - base;
    const token = c.pitches.map(pitchToken).join('+');
    if (c.duration_steps <= MAX_GATE_STEPS) {
      row[local] = { token, gateSteps: c.duration_steps, tie: false };
      continue;
    }
    // Too long for one gate. Chain 16-step tied pieces while the next landing
    // step is inside this section and unoccupied.
    let remaining = c.duration_steps;
    let at = local;
    const pieces: number[] = [];
    while (remaining > MAX_GATE_STEPS) {
      const next = at + MAX_GATE_STEPS;
      if (next >= SECTION_STEPS || row[next] !== undefined) break;
      row[at] = { token, gateSteps: MAX_GATE_STEPS, tie: true };
      pieces.push(MAX_GATE_STEPS);
      remaining -= MAX_GATE_STEPS;
      at = next;
    }
    if (remaining > MAX_GATE_STEPS) {
      // No room to chain: take the ceiling and say so.
      row[at] = { token, gateSteps: MAX_GATE_STEPS, tie: false };
      clamps.push(`step ${local} ${token}: wanted ${c.duration_steps} steps, no room to chain inside the section, emitted ${MAX_GATE_STEPS}`);
    } else {
      row[at] = { token, gateSteps: remaining, tie: false };
      pieces.push(remaining);
      splits.push(`step ${local} ${token}: ${c.duration_steps} steps -> ${pieces.join(' + ')} (${pieces.length} pieces, ${pieces.length - 1} tie flag(s))`);
    }
  }
  return { row, splits, clamps };
}

function render(row: (Emitted | undefined)[]): string {
  return row.map((e) => (e === undefined ? '~' : `${e.token}:${e.gateSteps}${e.tie ? '_' : ''}`)).join(' ');
}

/** Parse the line back and check every gate magnitude + tie flag. */
function verify(line: string, row: (Emitted | undefined)[], label: string): string {
  const steps = parseVoice(line, SECTION_STEPS);
  const problems: string[] = [];
  for (let i = 0; i < SECTION_STEPS; i++) {
    const want = row[i];
    const got = steps[i];
    if (want === undefined) {
      if (got.on) problems.push(`step ${i}: expected rest, parsed a hit`);
      continue;
    }
    if (!got.on) { problems.push(`step ${i}: expected a hit, parsed a rest`); continue; }
    const wantSixths = want.gateSteps * GATE_SIXTHS_PER_STEP;
    if (got.gate_sixths !== wantSixths) problems.push(`step ${i}: gate ${got.gate_sixths} != ${wantSixths} sixths`);
    if ((got.tie === true) !== want.tie) problems.push(`step ${i}: tie ${got.tie === true} != ${want.tie}`);
  }
  return problems.length === 0 ? `${label}: OK` : `${label}: ${problems.length} PROBLEM(S)\n      ${problems.join('\n      ')}`;
}

const PLAN = [
  { part: 5, voice: 'synth2', label: 'piano', window: { fromMeasure: 1, toMeasure: 16 }, project: 'P1' },
  { part: 0, voice: 'synth1', label: 'bass', window: { fromMeasure: 19, toMeasure: 34 }, project: 'P2' },
  { part: 2, voice: 'synth2', label: 'pad', window: { fromMeasure: 19, toMeasure: 34 }, project: 'P2' },
  { part: 4, voice: 'midi1', label: 'square lead', window: { fromMeasure: 19, toMeasure: 34 }, project: 'P2' },
];

async function main(): Promise<void> {
  let totalSplits = 0, totalClamps = 0, totalProblems = 0;

  for (const p of PLAN) {
    const f = await fetchSongsterrPart(SONG, { track: p.part });
    const r = importSongsterrMelodic(f.part, { ...p.window, stepsPerBeat: 4 });
    const sections = Math.ceil(r.step_count / SECTION_STEPS);
    console.log(`\n${'='.repeat(78)}`);
    console.log(`${p.project}  voice "${p.voice}"  part ${p.part} (${p.label})  ${r.step_count} steps = ${sections} sections`);
    console.log('='.repeat(78));
    for (let s = 0; s < sections; s++) {
      const base = s * SECTION_STEPS;
      const cells = r.cells.filter((c) => c.step >= base && c.step < base + SECTION_STEPS);
      const { row, splits, clamps } = layoutSection(cells, base);
      const line = render(row);
      const bars = `m${p.window.fromMeasure + s * 2}-${p.window.fromMeasure + s * 2 + 1}`;
      if (cells.length === 0) { console.log(`  S${s + 1} ${bars}: (silent)`); continue; }
      console.log(`  S${s + 1} ${bars}: ${line}`);
      for (const x of splits) { console.log(`      TIE SPLIT  ${x}`); totalSplits++; }
      for (const x of clamps) { console.log(`      CLAMP      ${x}`); totalClamps++; }
      const v = verify(line, row, '      verify');
      console.log(v);
      if (v.includes('PROBLEM')) totalProblems++;
    }
  }

  // Drums, P2 only: the char grid per section.
  const drums = await fetchSongsterrPart(SONG, { track: 6 });
  const d = importSongsterrDrums(drums.part, { fromMeasure: 19, toMeasure: 34, stepsPerBeat: 4 });
  console.log(`\n${'='.repeat(78)}`);
  console.log(`P2  drums  part 6  ${d.steps} steps = ${d.steps / SECTION_STEPS} sections`);
  console.log('='.repeat(78));
  for (let s = 0; s < d.steps / SECTION_STEPS; s++) {
    const base = s * SECTION_STEPS;
    const lines: string[] = [];
    for (const [voice, steps] of Object.entries(d.voices)) {
      const slice = steps.slice(base, base + SECTION_STEPS);
      if (!slice.some((x) => x.on)) continue;
      lines.push(`${voice.padEnd(6)} "${slice.map((x) => (x.on ? 'x' : '.')).join('')}"`);
    }
    console.log(`  S${s + 1} m${19 + s * 2}-${20 + s * 2}:`);
    for (const l of lines) console.log(`      ${l}`);
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(`TOTALS  tie splits=${totalSplits}  unresolvable clamps=${totalClamps}  verification problems=${totalProblems}`);
  console.log(totalProblems === 0 ? 'Every emitted line re-parses to the intended gate + tie.' : 'VERIFICATION FAILED, do not author.');
}

main().catch((e) => { console.error(e); process.exit(1); });
