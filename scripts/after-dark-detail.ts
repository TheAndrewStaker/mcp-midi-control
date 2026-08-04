/**
 * "After Dark" dry-run ADDENDUM. Read-only, no device.
 *
 * Three questions the main dry run leaves open:
 *   1. the drum part's raw GM percussion numbers (vs SPD-SX kit 40's pads),
 *   2. the raw `tie` count in the SOURCE per part (to check the prior census),
 *   3. what the P1 window looks like if it is split at the 16-bar project ceiling.
 *
 * Run:  npx tsx scripts/after-dark-detail.ts
 */

import { fetchSongsterrPart } from '../packages/core/src/protocol-generic/patterns/songsterrFetch.js';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, importSongsterrMelodic, importSongsterrDrums,
} from '../packages/core/src/protocol-generic/patterns/songsterr.js';
import { gateSixthsFromSteps } from '../packages/core/src/protocol-generic/patterns/types.js';

const SONG = '501859';
const KIT40_PADS = [36, 38, 42, 45, 46, 49, 51, 53, 56];
const PARTS = [
  { part: 0, name: 'Synth Bass 1' },
  { part: 1, name: 'Acoustic Grand Piano (UNASSIGNED in handoff)' },
  { part: 2, name: 'Pad 2 (warm)' },
  { part: 3, name: 'Lead 2 (sawtooth)' },
  { part: 4, name: 'Lead 1 (square)' },
  { part: 5, name: 'Acoustic Grand Piano "Track 1"' },
];

async function main(): Promise<void> {
  // 1. Drums: raw GM numbers, whole song + the two windows.
  const drums = await fetchSongsterrPart(SONG, { track: 6 });
  const flat = flattenSongsterrDrums(drums.part);
  const byVoice = new Map<string, number>();
  for (const e of flat.events) byVoice.set(e.voice, (byVoice.get(e.voice) ?? 0) + 1);
  console.log('DRUMS, whole song (135 measures)');
  console.log(`  events=${flat.events.length}  unmapped=${flat.unmapped} [${JSON.stringify(flat.unmapped_numbers)}]  ghosts=${flat.ghosts}  flams=${flat.flams_collapsed}`);
  console.log(`  voices: ${[...byVoice.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}×${n}`).join(', ')}`);
  const rawNums = new Map<number, number>();
  for (const m of drums.part.measures) {
    for (const v of m.voices ?? []) {
      for (const b of v.beats ?? []) {
        for (const n of b.notes ?? []) {
          if (typeof n.fret === 'number') rawNums.set(n.fret, (rawNums.get(n.fret) ?? 0) + 1);
        }
      }
    }
  }
  console.log(`  RAW source numbers: ${[...rawNums.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}×${c}${KIT40_PADS.includes(n) ? '' : ' (NOT a kit-40 pad)'}`).join(', ')}`);
  console.log(`  kit 40 pads: ${KIT40_PADS.join(', ')}`);

  for (const [label, win] of [['P1 m1-18', { fromMeasure: 1, toMeasure: 18 }], ['P2 m19-34', { fromMeasure: 19, toMeasure: 34 }]] as const) {
    const d = importSongsterrDrums(drums.part, { ...win, stepsPerBeat: 4 });
    const hits = Object.entries(d.voices).map(([v, s]) => `${v}×${s.filter((x) => x.on).length}`).filter((x) => !x.endsWith('×0'));
    console.log(`  ${label}: ${hits.join(', ') || '(silent)'}`);
  }

  // 2. Raw source `tie` per melodic part.
  console.log('\nRAW SOURCE TIE COUNT per melodic part (note.tie === true in the JSON)');
  for (const p of PARTS) {
    const f = await fetchSongsterrPart(SONG, { track: p.part });
    let ties = 0, notes = 0, letRing = 0;
    for (const m of f.part.measures) {
      for (const v of m.voices ?? []) {
        for (const b of v.beats ?? []) {
          if ((b as { letRing?: boolean }).letRing === true) letRing++;
          for (const n of b.notes ?? []) { notes++; if (n.tie === true) ties++; }
        }
      }
    }
    const mel = flattenSongsterrMelodic(f.part);
    console.log(`  [${p.part}] ${p.name}: source notes=${notes} tie-flagged=${ties} letRing-beats=${letRing} | flattener ties_folded=${mel.ties_folded} ties_orphaned=${mel.ties_orphaned} onsets=${mel.notes.length}`);
  }

  // 3. P1 split at the ceiling: m1-16 + m17-18, and m1-18 as-is.
  console.log('\nP1 SPLIT OPTIONS (piano, part 5), the 16-bar / 256-step project ceiling');
  const piano = await fetchSongsterrPart(SONG, { track: 5 });
  for (const [label, win] of [
    ['m1-18 (as handed off)', { fromMeasure: 1, toMeasure: 18 }],
    ['m1-16', { fromMeasure: 1, toMeasure: 16 }],
    ['m17-18', { fromMeasure: 17, toMeasure: 18 }],
    ['m3-18 (16 bars, drop the 2-bar lead-in)', { fromMeasure: 3, toMeasure: 18 }],
  ] as const) {
    const r = importSongsterrMelodic(piano.part, { ...win, stepsPerBeat: 4 });
    let clamped = 0;
    for (const c of r.cells) if (gateSixthsFromSteps(c.duration_steps).clamped) clamped++;
    console.log(`  ${label}: steps=${r.step_count}${r.step_count > 256 ? ' OVER' : ' fits'} cells=${r.cells.length} off_grid=${r.off_grid} clamped_gates=${clamped}`);
  }

  // 4. What the piano actually plays in m1-2 vs m17-18 (is the tail distinct?).
  const head = importSongsterrMelodic(piano.part, { fromMeasure: 1, toMeasure: 2, stepsPerBeat: 4 });
  const tail = importSongsterrMelodic(piano.part, { fromMeasure: 17, toMeasure: 18, stepsPerBeat: 4 });
  console.log(`  piano m1-2  : ${head.notation}`);
  console.log(`  piano m17-18: ${tail.notation}`);
  console.log(`  identical: ${head.notation === tail.notation}`);

  // 5. Pad chord detail in P2 (the clamp victims).
  const pad = await fetchSongsterrPart(SONG, { track: 2 });
  const pr = importSongsterrMelodic(pad.part, { fromMeasure: 19, toMeasure: 34, stepsPerBeat: 4 });
  console.log('\nPAD P2 cells (the gate-clamp victims)');
  for (const c of pr.cells) {
    const g = gateSixthsFromSteps(c.duration_steps);
    console.log(`  step ${String(c.step).padStart(3)} (bar ${Math.floor(c.step / 16) + 19})  ${c.token}  duration=${c.duration_steps} steps -> gate ${g.gate_sixths}/96 sixths${g.clamped ? `  CLAMPED (loses ${c.duration_steps - 16} steps = ${((c.duration_steps - 16) / 16).toFixed(2)} bars)` : ''}`);
  }

  // 6. Piano P1 cells over 16 steps.
  const pi = importSongsterrMelodic(piano.part, { fromMeasure: 1, toMeasure: 18, stepsPerBeat: 4 });
  console.log('\nPIANO P1 cells whose gate clamps');
  for (const c of pi.cells) {
    const g = gateSixthsFromSteps(c.duration_steps);
    if (g.clamped) console.log(`  step ${c.step} (bar ${Math.floor(c.step / 16) + 1})  ${c.token}  duration=${c.duration_steps} steps -> gate ${g.gate_sixths}/96`);
  }
  console.log(`  piano let_ring cells: ${pi.cells.filter((c) => c.letRing).length} / ${pi.cells.length}`);

  // 7. Occupancy of EVERY part across the three candidate windows.
  console.log('\nOCCUPANCY, every part, three windows (cells for melodic, hits for drums)');
  const W = [
    ['m1-16', { fromMeasure: 1, toMeasure: 16 }],
    ['m17-18', { fromMeasure: 17, toMeasure: 18 }],
    ['m19-34', { fromMeasure: 19, toMeasure: 34 }],
  ] as const;
  for (const p of [0, 1, 2, 3, 4, 5, 6]) {
    const f = await fetchSongsterrPart(SONG, { track: p });
    const out: string[] = [];
    for (const [lab, w] of W) {
      if (f.isMelodic) {
        const r = importSongsterrMelodic(f.part, { ...w, stepsPerBeat: 4 });
        out.push(`${lab}=${String(r.cells.length).padStart(3)}c${r.range ? ` [${r.range.low_name}..${r.range.high_name}]` : '            '}`);
      } else {
        const d = importSongsterrDrums(f.part, { ...w, stepsPerBeat: 4 });
        out.push(`${lab}=${String(Object.values(d.voices).flat().filter((s) => s.on).length).padStart(3)}h`);
      }
    }
    console.log(`  part ${p}  ${out.join('   ')}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
