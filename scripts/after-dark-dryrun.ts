/**
 * "After Dark" (Mr.Kitty): PRE-AUTHORING DRY RUN. Read-only, no device, no upload.
 *
 * Fetches the live Songsterr roster for song 501859, checks it against the settled
 * part→track mapping, and runs the melodic + drum importers over the two proposed
 * project windows (P1 = m1-18, P2 = m19-34) reporting fidelity counters, tie /
 * duration behaviour through `gateSixthsFromSteps`, pitch range, and the
 * `condense_drums` routing.
 *
 * Run:  npx tsx scripts/after-dark-dryrun.ts
 */

import {
  fetchSongsterrTracks, fetchSongsterrPart,
} from '../packages/core/src/protocol-generic/patterns/songsterrFetch.js';
import {
  importSongsterrMelodic, importSongsterrDrums, pitchToken,
} from '../packages/core/src/protocol-generic/patterns/songsterr.js';
import { condenseToKit, DEFAULT_CONDENSE_KIT } from '../packages/core/src/protocol-generic/patterns/drumCondense.js';
import { gateSixthsFromSteps } from '../packages/core/src/protocol-generic/patterns/types.js';
import type { NeutralPattern, Step } from '../packages/core/src/protocol-generic/patterns/types.js';

const SONG = '501859';
const EXPECTED_REVISION = 4102120;

/** The SETTLED mapping. Not re-derived here; checked against the live roster. */
const MAPPING = [
  { part: 0, instrument: 'Synth Bass 1', target: 'Synth 1 (ch1, + Hydrasynth)', windows: ['P1', 'P2'] as const },
  { part: 5, instrument: 'Acoustic Grand Piano', target: 'Synth 2 (ch2)', windows: ['P1'] as const },
  { part: 2, instrument: 'Pad 2 (warm)', target: 'Synth 2 (ch2)', windows: ['P2'] as const },
  { part: 4, instrument: 'Lead 1 (square)', target: 'MIDI 1 (ch3 → MicroFreak + VE-500)', windows: ['P1', 'P2'] as const },
  { part: 6, instrument: 'Drums', target: 'MIDI 2 (ch4 → SPD-SX) + condensed internal', windows: ['P1', 'P2'] as const },
  { part: 3, instrument: 'Lead 2 (sawtooth)', target: '(unused)', windows: [] as const },
];

const WINDOWS = {
  P1: { fromMeasure: 1, toMeasure: 18 },
  P2: { fromMeasure: 19, toMeasure: 34 },
} as const;

/** Circuit ceiling: 8 patterns/track × 32 steps = 256 steps = 16 bars at 16ths. */
const PROJECT_STEP_CEILING = 8 * 32;

function bar2(notation: string): string {
  return notation.split(' ').slice(0, 32).join(' ');
}

async function main(): Promise<void> {
  // ── 1. Live roster ────────────────────────────────────────────────
  const roster = await fetchSongsterrTracks(SONG);
  console.log('='.repeat(78));
  console.log(`ROSTER  "${roster.title}" by ${roster.artist}`);
  console.log(`song ${roster.songId}  revision ${roster.revisionId}` +
    (roster.revisionId === EXPECTED_REVISION ? '  (matches handoff)' : `  *** HANDOFF SAID ${EXPECTED_REVISION} ***`));
  console.log('='.repeat(78));
  console.log('| # | instrument | contributor name | kind |');
  console.log('|---|---|---|---|');
  for (const t of roster.allTracks) {
    console.log(`| ${t.partId} | ${t.instrument} | ${t.name || '(none)'} | ${t.isDrums ? 'DRUM' : 'melodic'}${t.isEmpty ? ' EMPTY' : ''} |`);
  }

  console.log('\nMAPPING CHECK');
  let disagreements = 0;
  for (const m of MAPPING) {
    const live = roster.allTracks[m.part];
    const ok = live !== undefined && live.instrument === m.instrument;
    if (!ok) { disagreements++; }
    console.log(`  [${m.part}] expect "${m.instrument}"  live "${live?.instrument ?? '(missing)'}"  ${ok ? 'OK' : '*** MISMATCH ***'}   -> ${m.target}`);
  }
  console.log(disagreements === 0
    ? '  ALL CLEAR: live roster matches the settled mapping exactly.'
    : `  *** ${disagreements} MISMATCH(ES). STOP, do not author. ***`);

  // ── 2. Per-part dry run ───────────────────────────────────────────
  for (const m of MAPPING) {
    if (m.windows.length === 0) {
      console.log(`\n${'─'.repeat(78)}\n[${m.part}] ${m.instrument}: intentionally UNUSED, not imported.`);
      continue;
    }
    const fetched = await fetchSongsterrPart(SONG, { track: m.part });
    console.log(`\n${'─'.repeat(78)}`);
    console.log(`[${m.part}] ${m.instrument}  ->  ${m.target}`);
    console.log(`     isMelodic=${fetched.isMelodic}  total measures=${fetched.flat.measures.length}  sections=${fetched.flat.sections.map((s) => `${s.name}@m${s.startMeasure + 1}`).join(', ') || '(none)'}`);

    for (const w of m.windows) {
      const win = WINDOWS[w];
      console.log(`\n  ${w}  (measures ${win.fromMeasure}-${win.toMeasure})`);

      if (!fetched.isMelodic) {
        const d = importSongsterrDrums(fetched.part, { ...win, stepsPerBeat: 4 });
        const hits = Object.entries(d.voices).map(([v, steps]) => [v, steps.filter((s) => s.on).length] as const)
          .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
        const total = hits.reduce((a, [, n]) => a + n, 0);
        console.log(`    steps=${d.steps}${d.steps > PROJECT_STEP_CEILING ? `  *** EXCEEDS ${PROJECT_STEP_CEILING}-step (16-bar) PROJECT CEILING ***` : ''}  bpm=${d.bpm}  sig=${d.signature.join('/')}`);
        console.log(`    hits=${total}  voices: ${hits.map(([v, n]) => `${v}×${n}`).join(', ')}`);
        const micro = Object.values(d.voices).flat().filter((s) => s.on && s.micro !== undefined && s.micro.length > 0).length;
        console.log(`    off-grid (micro-placed) steps=${micro}`);
        for (const wn of d.warnings) console.log(`    ! ${wn}`);

        // Condense onto the Circuit's four drum tracks.
        const np: NeutralPattern = {
          name: `after-dark-${w}`, steps: d.steps,
          voices: Object.fromEntries(Object.entries(d.voices).map(([v, steps]) => [v, { steps: steps as Step[] }])),
        };
        const c = condenseToKit(np, DEFAULT_CONDENSE_KIT);
        console.log(`    CONDENSE onto [${DEFAULT_CONDENSE_KIT.join(' / ')}]:`);
        for (const r of c.routings) {
          console.log(`      "${r.voice}" (${r.role}) -> ${r.track_role} track [Drum ${r.track + 1}]  placed=${r.placed} dropped=${r.dropped}${r.exact ? '  (own role)' : '  FLIP'}`);
        }
        if (c.unroutable.length > 0) console.log(`      UNROUTABLE (nothing placed): ${c.unroutable.join(', ')}`);
        if (c.ignored.length > 0) console.log(`      ignored (non-drum): ${c.ignored.join(', ')}`);
        console.log(`      collisions=${c.collisions.length}`);
        const flipCount = [...c.flips.values()].reduce((a, mm) => a + mm.size, 0);
        console.log(`      per-step sample flips=${flipCount}`);
        continue;
      }

      const r = importSongsterrMelodic(fetched.part, { ...win, stepsPerBeat: 4 });
      const noteCount = r.cells.length;
      const pitchCount = r.cells.reduce((a, c) => a + c.pitches.length, 0);
      console.log(`    steps=${r.step_count}${r.step_count > PROJECT_STEP_CEILING ? `  *** EXCEEDS ${PROJECT_STEP_CEILING}-step (16-bar) PROJECT CEILING ***` : ''}  bpm=${r.bpm}  sig=${r.signature.join('/')}`);
      console.log(`    onset cells=${noteCount}  sounding pitches=${pitchCount}  chords=${r.cells.filter((c) => c.pitches.length > 1).length}`);
      console.log(`    FIDELITY  off_grid=${r.off_grid}  merged=${r.merged}  chord_overflow=${r.chord_overflow}  unresolved=${r.unresolved}  out_of_window=${r.out_of_window}  ties_folded=${r.ties_folded}`);
      if (r.range) console.log(`    RANGE  ${r.range.low_name} (MIDI ${r.range.low}) .. ${r.range.high_name} (MIDI ${r.range.high})`);

      // Durations / ties through the gate encoder.
      const tied = r.cells.filter((c) => c.tie === true).length;
      const letRing = r.cells.filter((c) => c.letRing === true).length;
      let rounded = 0, clamped = 0;
      const durHist = new Map<number, number>();
      const gateHist = new Map<number, number>();
      for (const c of r.cells) {
        const g = gateSixthsFromSteps(c.duration_steps);
        if (g.rounded) rounded++;
        if (g.clamped) clamped++;
        durHist.set(c.duration_steps, (durHist.get(c.duration_steps) ?? 0) + 1);
        gateHist.set(g.gate_sixths, (gateHist.get(g.gate_sixths) ?? 0) + 1);
      }
      console.log(`    TIES  cells marked tie=${tied}  let_ring=${letRing}  (ties_folded counter=${r.ties_folded})`);
      console.log(`    DURATIONS steps: ${[...durHist.entries()].sort((a, b) => a[0] - b[0]).map(([d, n]) => `${d}×${n}`).join(' ')}`);
      console.log(`    GATE sixths:     ${[...gateHist.entries()].sort((a, b) => a[0] - b[0]).map(([g, n]) => `${g}×${n}`).join(' ')}`);
      console.log(`    gateSixthsFromSteps: rounded=${rounded}  clamped=${clamped}`);
      for (const wn of r.warnings) console.log(`    ! ${wn}`);
      console.log(`    FIRST TWO BARS: ${bar2(r.notation)}`);
    }
  }

  // ── 3. Whole-part range + tie census (for the transpose decision) ──
  console.log(`\n${'='.repeat(78)}\nWHOLE-TRACK CENSUS (all 135 measures, for range + tie totals)`);
  for (const m of MAPPING) {
    if (m.windows.length === 0) continue;
    const fetched = await fetchSongsterrPart(SONG, { track: m.part });
    if (!fetched.isMelodic) continue;
    const r = importSongsterrMelodic(fetched.part, { stepsPerBeat: 4 });
    console.log(`  [${m.part}] ${m.instrument}: cells=${r.cells.length} ties_folded=${r.ties_folded} off_grid=${r.off_grid} merged=${r.merged} ` +
      `range=${r.range ? `${r.range.low_name}..${r.range.high_name} (${r.range.low}..${r.range.high})` : 'n/a'}`);
    // Where the low notes are, so a transpose cost can be judged.
    if (r.range) {
      const lows = r.cells.filter((c) => c.pitches.some((p) => p < 36));
      console.log(`        cells with any pitch below c2 (36): ${lows.length}  distinct low pitches: ` +
        `${[...new Set(r.cells.flatMap((c) => c.pitches).filter((p) => p < 40))].sort((a, b) => a - b).map((p) => `${pitchToken(p)}(${p})`).join(' ')}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
