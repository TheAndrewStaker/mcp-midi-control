/**
 * "After Dark": the TWO LEADS question, forced by the maintainer's whole-song
 * mapping correction (MIDI 1 = part 3 sawtooth, not part 4 square). Read-only.
 *
 * MIDI 1 drives the MicroFreak AND is the VE-500's vocal pitch target, so
 * whatever lands there is what he SINGS. Two things have to be measured, not
 * assumed:
 *
 *   1. Do parts 3 and 4 ever sound in the same measure? Per-measure, all 135.
 *   2. Where they DO, what is the interval? If it is a constant octave they are
 *      one line in two registers and picking either loses no music; if it is
 *      anything else they are two voices and the choice is a real one.
 *
 * Plus the second half of the correction: "pads" is PLURAL. Which parts can
 * share Synth 2 without ever overlapping?
 *
 * Run:  npx tsx scripts/after-dark-leads.ts
 */

import { fetchSongsterrPart } from '../packages/core/src/protocol-generic/patterns/songsterrFetch.js';
import {
  flattenSongsterrDrums, importSongsterrMelodic, pitchToken,
} from '../packages/core/src/protocol-generic/patterns/songsterr.js';

const SONG = '501859';
const MEASURES = 135;
const SECTIONS = [
  { name: 'Intro',    from: 1,   to: 18 },
  { name: "Verse 1'", from: 19,  to: 34 },
  { name: 'Chorus 1', from: 35,  to: 50 },
  { name: 'Verse 2',  from: 51,  to: 66 },
  { name: 'Chorus 2', from: 67,  to: 82 },
  { name: 'Break',    from: 83,  to: 98 },
  { name: 'Bridge',   from: 99,  to: 114 },
  { name: 'Chorus 3', from: 115, to: 135 },
];

async function main(): Promise<void> {
  const P: Record<number, Awaited<ReturnType<typeof fetchSongsterrPart>>> = {};
  for (const i of [1, 2, 3, 4, 5]) P[i] = await fetchSongsterrPart(SONG, { track: i });
  const flat = flattenSongsterrDrums(P[3].part);

  // whole-song cell grids, one import each so steps are comparable
  const whole = { fromMeasure: 1, toMeasure: MEASURES, stepsPerBeat: 4 as const };
  const G: Record<number, ReturnType<typeof importSongsterrMelodic>> = {};
  for (const i of [1, 2, 3, 4, 5]) G[i] = importSongsterrMelodic(P[i].part, whole);

  const perBar = (i: number): number[] => {
    const a = Array.from({ length: MEASURES }, () => 0);
    for (const c of G[i].cells) a[Math.floor(c.step / 16)]++;
    return a;
  };
  const B: Record<number, number[]> = {};
  for (const i of [1, 2, 3, 4, 5]) B[i] = perBar(i);

  // ── 1. parts 3 and 4, per measure, side by side ───────────────────
  console.log('PART 3 (sawtooth) vs PART 4 (square), CELLS PER MEASURE, all 135');
  console.log('  legend: "-" silent, a number = onset cells in that bar');
  for (const s of SECTIONS) {
    const rows = [3, 4].map((i) => {
      let out = '';
      for (let m = s.from; m <= s.to; m++) out += (B[i][m - 1] === 0 ? ' -' : String(B[i][m - 1]).padStart(2));
      return out;
    });
    const both: number[] = [];
    for (let m = s.from; m <= s.to; m++) if (B[3][m - 1] > 0 && B[4][m - 1] > 0) both.push(m);
    console.log(`  ${s.name.padEnd(9)} m${String(s.from).padStart(3)}-${String(s.to).padEnd(3)}`);
    console.log(`     saw(3) ${rows[0]}`);
    console.log(`     sqr(4) ${rows[1]}`);
    console.log(`     both sounding: ${both.length ? `${both.length} bars (m${both[0]}-m${both[both.length - 1]})` : 'NONE'}`);
  }
  const overlapBars: number[] = [];
  for (let m = 1; m <= MEASURES; m++) if (B[3][m - 1] > 0 && B[4][m - 1] > 0) overlapBars.push(m);
  console.log(`\n  TOTAL overlap: ${overlapBars.length} of ${MEASURES} measures`);
  console.log(`  saw sounds in ${B[3].filter((n) => n > 0).length} bars, square in ${B[4].filter((n) => n > 0).length} bars`);
  const sawOnly = B[3].map((n, i) => (n > 0 && B[4][i] === 0 ? i + 1 : 0)).filter(Boolean);
  const sqrOnly = B[4].map((n, i) => (n > 0 && B[3][i] === 0 ? i + 1 : 0)).filter(Boolean);
  console.log(`  saw-only bars: ${sawOnly.length ? sawOnly.join(',') : 'none'}`);
  console.log(`  square-only bars: ${sqrOnly.length} (${sqrOnly.length ? `m${sqrOnly[0]}..m${sqrOnly[sqrOnly.length - 1]}` : '-'})`);

  // ── 2. interval analysis on every overlapping step ────────────────
  console.log('\nINTERVAL between part 3 and part 4 on every step where BOTH have an onset');
  const sawAt = new Map(G[3].cells.map((c) => [c.step, c]));
  const sqrAt = new Map(G[4].cells.map((c) => [c.step, c]));
  const shared = [...sawAt.keys()].filter((s) => sqrAt.has(s)).sort((a, b) => a - b);
  const intervals = new Map<number, number>();
  let sameRhythm = true;
  for (const s of shared) {
    const a = sawAt.get(s)!, b = sqrAt.get(s)!;
    if (a.pitches.length !== 1 || b.pitches.length !== 1) { intervals.set(9999, (intervals.get(9999) ?? 0) + 1); continue; }
    intervals.set(b.pitches[0] - a.pitches[0], (intervals.get(b.pitches[0] - a.pitches[0]) ?? 0) + 1);
    if (a.duration_steps !== b.duration_steps) sameRhythm = false;
  }
  console.log(`  shared onset steps: ${shared.length}   saw onsets total ${G[3].cells.length}   square onsets total ${G[4].cells.length}`);
  console.log(`  saw onsets NOT shared with square: ${G[3].cells.length - shared.length}`);
  console.log(`  intervals (square minus saw, semitones): ${[...intervals.entries()].sort((a, b) => a[0] - b[0]).map(([iv, n]) => `${iv === 9999 ? 'chord' : `${iv >= 0 ? '+' : ''}${iv}`} x${n}`).join(', ')}`);
  console.log(`  identical note lengths on every shared step: ${sameRhythm}`);

  // ── 3. register: what MIDI 1 looks like under each assembly ───────
  console.log('\nMIDI 1 REGISTER under each candidate assembly (what he has to SING)');
  const rangeIn = (i: number, from: number, to: number): string => {
    const r = importSongsterrMelodic(P[i].part, { fromMeasure: from, toMeasure: to, stepsPerBeat: 4 });
    return r.range ? `${r.range.low_name}..${r.range.high_name} (${r.range.low}..${r.range.high})` : 'SILENT';
  };
  console.log(`  ${'section'.padEnd(10)} ${'bars'.padEnd(10)} ${'part 3 saw'.padEnd(26)} ${'part 4 square'.padEnd(26)}`);
  for (const s of SECTIONS) {
    console.log(`  ${s.name.padEnd(10)} ${`m${s.from}-${s.to}`.padEnd(10)} ${rangeIn(3, s.from, s.to).padEnd(26)} ${rangeIn(4, s.from, s.to).padEnd(26)}`);
  }
  console.log('\n  assembly A, "MIDI 1 = part 3 ONLY" (his sentence read literally):');
  for (const s of SECTIONS) {
    const r = rangeIn(3, s.from, s.to);
    console.log(`     ${s.name.padEnd(10)} ${r === 'SILENT' ? 'SILENT  <-- no retune target, nothing to sing to' : r}`);
  }
  console.log('\n  assembly B, "MIDI 1 = the LEAD LINE: saw where it exists, square where it does not":');
  for (const s of SECTIONS) {
    const a = rangeIn(3, s.from, s.to);
    console.log(`     ${s.name.padEnd(10)} ${a !== 'SILENT' ? `saw    ${a}` : `square ${rangeIn(4, s.from, s.to)}`}`);
  }

  // ── 4. "pads" is plural: who can share Synth 2 ────────────────────
  console.log('\nSYNTH 2 CANDIDATES ("pads", plural): per-part sounding bars and pairwise overlap');
  const names: Record<number, string> = { 1: 'part 1 piano (unmapped)', 2: 'part 2 Pad 2 (warm)', 5: 'part 5 piano "Track 1"' };
  for (const i of [1, 2, 5]) {
    const bars = B[i].map((n, k) => (n > 0 ? k + 1 : 0)).filter(Boolean);
    const runs: string[] = [];
    let a = bars[0], prev = bars[0];
    for (const m of bars.slice(1)) { if (m !== prev + 1) { runs.push(a === prev ? `m${a}` : `m${a}-${prev}`); a = m; } prev = m; }
    if (bars.length) runs.push(a === prev ? `m${a}` : `m${a}-${prev}`);
    console.log(`  ${names[i].padEnd(24)} ${String(G[i].cells.length).padStart(3)} cells  ${G[i].range ? `${G[i].range!.low_name}..${G[i].range!.high_name}` : '-'}  bars ${runs.join(', ')}`);
  }
  for (const [x, y] of [[1, 2], [1, 5], [2, 5]] as const) {
    const both: number[] = [];
    for (let m = 1; m <= MEASURES; m++) if (B[x][m - 1] > 0 && B[y][m - 1] > 0) both.push(m);
    let maxChord = 0, onsetClash = 0;
    if (both.length) {
      const ax = new Map(G[x].cells.map((c) => [c.step, c]));
      const ay = new Map(G[y].cells.map((c) => [c.step, c]));
      for (const st of new Set([...ax.keys(), ...ay.keys()])) {
        const n = (ax.get(st)?.pitches.length ?? 0) + (ay.get(st)?.pitches.length ?? 0);
        maxChord = Math.max(maxChord, n);
        if (ax.has(st) && ay.has(st)) onsetClash++;
      }
    }
    console.log(`  part ${x} vs part ${y}: overlap ${both.length ? `${both.length} bars (m${both[0]}-m${both[both.length - 1]})` : 'NONE - can share Synth 2 cleanly'}${both.length ? `, same-step onsets ${onsetClash}, max merged chord ${maxChord}/6` : ''}`);
  }

  // ── 5. what P2 (m19-34) holds vs what each reading wants ──────────
  console.log('\nPACK 2 PROJECT 2 ("AfterDark P2", m19-34) UNDER THE CORRECTION');
  const s3 = importSongsterrMelodic(P[3].part, { fromMeasure: 19, toMeasure: 34, stepsPerBeat: 4 });
  const s4 = importSongsterrMelodic(P[4].part, { fromMeasure: 19, toMeasure: 34, stepsPerBeat: 4 });
  console.log(`  part 3 sawtooth over m19-34: ${s3.cells.length} cells  ${s3.range ? `${s3.range.low_name}..${s3.range.high_name}` : 'SILENT'}`);
  console.log(`  part 4 square   over m19-34: ${s4.cells.length} cells  ${s4.range ? `${s4.range.low_name}..${s4.range.high_name}` : 'SILENT'}`);
  console.log(`  as built, MIDI 1 holds the SQUARE (48 notes, 46..51). Assembly A wants it EMPTY; assembly B wants exactly what is there.`);

  // ── 6. first bar of each lead, in a chorus and in a verse ─────────
  console.log('\nWHAT THE TWO LEADS ACTUALLY PLAY');
  for (const [lab, from] of [['Verse 1 m19', 19], ['Chorus 1 m35', 35], ['Bridge m99', 99]] as const) {
    for (const i of [3, 4]) {
      const r = importSongsterrMelodic(P[i].part, { fromMeasure: from, toMeasure: from + 1, stepsPerBeat: 4 });
      const bar = Array.from({ length: 32 }, (_, k) => { const c = r.cells.find((x) => x.step === k); return c ? c.pitches.map(pitchToken).join('+') : '~'; }).join(' ');
      console.log(`  ${lab.padEnd(13)} part ${i}: ${r.cells.length ? bar : '(silent)'}`);
    }
  }
  void flat;
}

main().catch((e) => { console.error(e); process.exit(1); });
