/**
 * "After Dark" WHOLE-SONG occupancy analysis. Read-only, no device.
 *
 * The first build (`after-dark-dryrun.ts` / `-detail.ts` / `-sections.ts`) settled
 * measures 1-34 and stopped there, because from m35 the Synth 2 track has more
 * than one claimant. This script answers the question that was deferred:
 *
 *   1. per-MEASURE occupancy for all seven parts across all 135 measures,
 *   2. rolled up by the source's own section markers,
 *   3. a candidate project chop at the 16-bar / 256-step ceiling, snapped to
 *      section boundaries,
 *   4. for each candidate project, WHICH parts want Synth 2 and whether they
 *      actually overlap INSIDE that project (a shared track is only a conflict
 *      when two parts sound in the same project).
 *
 * Run:  npx tsx scripts/after-dark-fullsong.ts
 */

import { fetchSongsterrPart } from '../packages/core/src/protocol-generic/patterns/songsterrFetch.js';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, importSongsterrMelodic, importSongsterrDrums,
} from '../packages/core/src/protocol-generic/patterns/songsterr.js';

const SONG = '501859';
const EXPECTED_REVISION = 4102120;
const MEASURES = 135;
const PARTS = [
  { i: 0, label: 'bass', name: 'Synth Bass 1' },
  { i: 1, label: 'pno1', name: 'Acoustic Grand Piano (unmapped)' },
  { i: 2, label: 'pad ', name: 'Pad 2 (warm)' },
  { i: 3, label: 'saw ', name: 'Lead 2 (sawtooth)' },
  { i: 4, label: 'sqr ', name: 'Lead 1 (square)' },
  { i: 5, label: 'pno5', name: 'Acoustic Grand Piano "Track 1"' },
  { i: 6, label: 'drum', name: 'Drums' },
];

interface PartOcc {
  i: number;
  label: string;
  name: string;
  melodic: boolean;
  /** onsets per measure, index 0 = m1 */
  perMeasure: number[];
  /** lowest/highest MIDI per measure, undefined when silent */
  rangeByMeasure: ({ lo: number; hi: number } | undefined)[];
}

async function main(): Promise<void> {
  const fetched = new Map<number, Awaited<ReturnType<typeof fetchSongsterrPart>>>();
  for (const p of PARTS) fetched.set(p.i, await fetchSongsterrPart(SONG, { track: p.i }));
  const anchor = fetched.get(0)!;
  if (anchor.revisionId !== EXPECTED_REVISION) {
    console.log(`REFUSED: revision ${anchor.revisionId}, expected ${EXPECTED_REVISION}.`);
    process.exit(1);
  }
  const flat0 = flattenSongsterrDrums(anchor.part);
  console.log(`source OK: revision ${anchor.revisionId}, ${flat0.measures.length} measures, sig ${flat0.signature.join('/')}`);
  console.log(`sections: ${flat0.sections.map((s) => `${s.name} @m${s.startMeasure + 1}`).join(', ')}`);
  console.log('');

  // ── per-measure occupancy ─────────────────────────────────────────
  const occ: PartOcc[] = [];
  for (const p of PARTS) {
    const f = fetched.get(p.i)!;
    const perMeasure = Array.from({ length: MEASURES }, () => 0);
    const rangeByMeasure: ({ lo: number; hi: number } | undefined)[] = Array.from({ length: MEASURES }, () => undefined);
    const measureOf = (beat: number): number => {
      // measures[] are ascending startBeat; find the last one at or before `beat`
      let lo = 0, hi = flat0.measures.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (flat0.measures[mid].startBeat <= beat + 1e-6) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    };
    if (f.isMelodic) {
      const mel = flattenSongsterrMelodic(f.part);
      for (const n of mel.notes) {
        const m = measureOf(n.beat);
        if (m < 0 || m >= MEASURES) continue;
        perMeasure[m]++;
        const cur = rangeByMeasure[m];
        rangeByMeasure[m] = cur === undefined
          ? { lo: n.pitch, hi: n.pitch }
          : { lo: Math.min(cur.lo, n.pitch), hi: Math.max(cur.hi, n.pitch) };
      }
    } else {
      const fl = flattenSongsterrDrums(f.part);
      for (const e of fl.events) {
        const m = measureOf(e.beat);
        if (m < 0 || m >= MEASURES) continue;
        perMeasure[m]++;
      }
    }
    occ.push({ i: p.i, label: p.label, name: p.name, melodic: f.isMelodic, perMeasure, rangeByMeasure });
  }

  // ── section roll-up ───────────────────────────────────────────────
  const bounds: { name: string; from: number; to: number }[] = [];
  for (let s = 0; s < flat0.sections.length; s++) {
    const from = flat0.sections[s].startMeasure + 1;
    const to = s + 1 < flat0.sections.length ? flat0.sections[s + 1].startMeasure : MEASURES;
    bounds.push({ name: flat0.sections[s].name, from, to });
  }
  console.log('SECTION ROLL-UP (onsets per part; drums = hits)');
  console.log(`${'section'.padEnd(10)} ${'bars'.padEnd(9)} ${'len'.padStart(3)} ` + occ.map((o) => o.label.padStart(5)).join(' '));
  for (const b of bounds) {
    const cells = occ.map((o) => {
      let n = 0;
      for (let m = b.from; m <= b.to; m++) n += o.perMeasure[m - 1];
      return String(n).padStart(5);
    });
    console.log(`${b.name.padEnd(10)} ${`m${b.from}-${b.to}`.padEnd(9)} ${String(b.to - b.from + 1).padStart(3)} ` + cells.join(' '));
  }
  const totals = occ.map((o) => String(o.perMeasure.reduce((a, x) => a + x, 0)).padStart(5));
  console.log(`${'TOTAL'.padEnd(10)} ${`m1-${MEASURES}`.padEnd(9)} ${String(MEASURES).padStart(3)} ` + totals.join(' '));
  console.log('');

  // ── per-measure grid, compressed to runs ──────────────────────────
  console.log('PER-MEASURE ACTIVITY (. = silent, digit = onsets/10 capped, # = 100+)');
  const glyph = (n: number): string => (n === 0 ? '.' : n >= 100 ? '#' : n >= 10 ? String(Math.min(9, Math.floor(n / 10))) : 'x');
  for (const o of occ) {
    let row = '';
    for (let m = 1; m <= MEASURES; m++) row += glyph(o.perMeasure[m - 1]);
    console.log(`  ${o.label} ${row}`);
  }
  console.log('  bar   ' + Array.from({ length: MEASURES }, (_, i) => ((i + 1) % 10 === 0 ? String(Math.floor((i + 1) / 10) % 10) : ' ')).join('').slice(0));
  console.log('');

  // ── silent-measure map, which is where a chop can land losslessly ─
  console.log('MEASURES SILENT ON ALL SEVEN PARTS (lossless chop points)');
  const allSilent: number[] = [];
  for (let m = 1; m <= MEASURES; m++) if (occ.every((o) => o.perMeasure[m - 1] === 0)) allSilent.push(m);
  console.log(`  ${allSilent.length ? allSilent.join(', ') : '(none)'}`);
  console.log('');

  // ── candidate chop ────────────────────────────────────────────────
  // Sections start at m1, 19, 35, 51, 67, 83, 99, 115 -> every one is 16 bars
  // apart except the first (18) and the last (21). A 16-bar project therefore
  // aligns to section starts exactly, once m17-18 are dropped.
  const CHOP: { label: string; from: number; to: number; why: string }[] = [];
  CHOP.push({ label: 'P1', from: 1, to: 16, why: 'Intro. m17-18 dropped: silent on all 7 parts, and 18 bars is over the 16-bar ceiling.' });
  for (let s = 1; s < bounds.length; s++) {
    const b = bounds[s];
    const span = b.to - b.from + 1;
    if (span <= 16) {
      CHOP.push({ label: `P${s + 1}`, from: b.from, to: b.to, why: `${b.name}, ${span} bars, fits.` });
    } else {
      // split into 16-bar pieces
      let start = b.from;
      let piece = 0;
      while (start <= b.to) {
        const end = Math.min(start + 15, b.to);
        CHOP.push({ label: `P${s + 1}${piece === 0 ? 'a' : String.fromCharCode(98 + piece - 1)}`, from: start, to: end, why: `${b.name} part ${piece + 1}, ${end - start + 1} bars.` });
        start = end + 1; piece++;
      }
    }
  }
  console.log('CANDIDATE CHOP');
  console.log(`${'proj'.padEnd(5)} ${'bars'.padEnd(10)} ${'len'.padStart(3)} ${'steps'.padStart(5)}  parts active`);
  for (const c of CHOP) {
    const active = occ.filter((o) => {
      let n = 0; for (let m = c.from; m <= c.to; m++) n += o.perMeasure[m - 1];
      return n > 0;
    }).map((o) => `${o.i}${o.label.trim()}`);
    console.log(`${c.label.padEnd(5)} ${`m${c.from}-${c.to}`.padEnd(10)} ${String(c.to - c.from + 1).padStart(3)} ${String((c.to - c.from + 1) * 16).padStart(5)}  ${active.join(' ')}`);
  }
  console.log('');

  // ── Synth 2 contention, per candidate project ─────────────────────
  // Claimants for Synth 2: part 5 (piano), part 2 (pad). Part 3 (saw) is
  // unmapped everywhere, reported separately.
  console.log('SYNTH 2 CONTENTION per candidate project (parts 5 piano / 2 pad; part 3 saw shown for information)');
  console.log(`${'proj'.padEnd(5)} ${'bars'.padEnd(10)} ${'pno5'.padStart(6)} ${'pad'.padStart(6)} ${'saw'.padStart(6)}  verdict`);
  for (const c of CHOP) {
    const cnt = (i: number): number => { let n = 0; for (let m = c.from; m <= c.to; m++) n += occ.find((o) => o.i === i)!.perMeasure[m - 1]; return n; };
    const pno = cnt(5), pad = cnt(2), saw = cnt(3);
    let verdict: string;
    if (pno > 0 && pad > 0) {
      // measure-level overlap check
      const both: number[] = [];
      for (let m = c.from; m <= c.to; m++) {
        if (occ.find((o) => o.i === 5)!.perMeasure[m - 1] > 0 && occ.find((o) => o.i === 2)!.perMeasure[m - 1] > 0) both.push(m);
      }
      verdict = both.length
        ? `CONFLICT: both sound, overlapping in m${both[0]}-${both[both.length - 1]} (${both.length} bars)`
        : `both present but NEVER in the same bar (piano bars vs pad bars are disjoint) - still one track, needs a merge decision`;
    } else if (pno > 0) verdict = 'piano only, clean';
    else if (pad > 0) verdict = 'pad only, clean';
    else verdict = 'Synth 2 idle';
    console.log(`${c.label.padEnd(5)} ${`m${c.from}-${c.to}`.padEnd(10)} ${String(pno).padStart(6)} ${String(pad).padStart(6)} ${String(saw).padStart(6)}  ${verdict}`);
  }
  console.log('');

  // ── step-level collision test for any conflicted project ──────────
  console.log('STEP-LEVEL COLLISION TEST (16th grid) for projects where piano AND pad both sound');
  for (const c of CHOP) {
    const cnt = (i: number): number => { let n = 0; for (let m = c.from; m <= c.to; m++) n += occ.find((o) => o.i === i)!.perMeasure[m - 1]; return n; };
    if (cnt(5) === 0 || cnt(2) === 0) continue;
    const win = { fromMeasure: c.from, toMeasure: c.to, stepsPerBeat: 4 as const };
    const pi = importSongsterrMelodic(fetched.get(5)!.part, win);
    const pa = importSongsterrMelodic(fetched.get(2)!.part, win);
    const occupancy = new Map<number, string>();
    let collisions = 0;
    const detail: string[] = [];
    // a cell occupies [step, step+duration)
    const span = (cells: typeof pi.cells): Set<number> => {
      const s = new Set<number>();
      for (const cl of cells) for (let k = 0; k < cl.duration_steps; k++) s.add(cl.step + k);
      return s;
    };
    const sp = span(pi.cells), sa = span(pa.cells);
    const overlap = [...sp].filter((x) => sa.has(x)).sort((a, b) => a - b);
    // onset-only collision (both START on the same step) is the hard case
    const onsetPi = new Set(pi.cells.map((x) => x.step));
    const onsetPa = new Set(pa.cells.map((x) => x.step));
    const onsetBoth = [...onsetPi].filter((x) => onsetPa.has(x)).sort((a, b) => a - b);
    console.log(`  ${c.label} m${c.from}-${c.to}: piano ${pi.cells.length} cells, pad ${pa.cells.length} cells`);
    console.log(`     sounding-overlap steps: ${overlap.length} of ${pi.step_count}   same-step onsets: ${onsetBoth.length}`);
    if (onsetBoth.length) console.log(`     onset collisions at steps ${onsetBoth.slice(0, 20).join(',')}${onsetBoth.length > 20 ? ' ...' : ''}`);
    // chord-size check if merged onto one track
    let maxChord = 0;
    for (const step of new Set([...onsetPi, ...onsetPa])) {
      const a = pi.cells.find((x) => x.step === step)?.pitches.length ?? 0;
      const b = pa.cells.find((x) => x.step === step)?.pitches.length ?? 0;
      maxChord = Math.max(maxChord, a + b);
    }
    console.log(`     max merged chord size if both went on one track: ${maxChord} (device limit 6)`);
    void occupancy; void collisions; void detail;
  }
  console.log('');

  // ── first/last sounding bar per part, and per-part pitch range ────
  console.log('PART SPANS AND RANGES (whole song)');
  for (const o of occ) {
    const first = o.perMeasure.findIndex((n) => n > 0) + 1;
    let last = 0; for (let m = MEASURES; m >= 1; m--) if (o.perMeasure[m - 1] > 0) { last = m; break; }
    const lo = o.rangeByMeasure.filter((r) => r !== undefined).reduce((a, r) => Math.min(a, r!.lo), 999);
    const hi = o.rangeByMeasure.filter((r) => r !== undefined).reduce((a, r) => Math.max(a, r!.hi), -1);
    const bars = o.perMeasure.filter((n) => n > 0).length;
    console.log(`  [${o.i}] ${o.name.padEnd(34)} onsets=${String(o.perMeasure.reduce((a, x) => a + x, 0)).padStart(4)}  sounding bars=${String(bars).padStart(3)}  first=m${first || 0} last=m${last}  midi ${lo === 999 ? '-' : `${lo}..${hi}`}`);
  }

  // ── fidelity across the whole song, per candidate project ─────────
  console.log('\nFIDELITY PER CANDIDATE PROJECT (melodic parts that will be authored)');
  for (const c of CHOP) {
    const win = { fromMeasure: c.from, toMeasure: c.to, stepsPerBeat: 4 as const };
    const bits: string[] = [];
    for (const i of [0, 2, 4, 5]) {
      const r = importSongsterrMelodic(fetched.get(i)!.part, win);
      if (r.cells.length === 0) continue;
      bits.push(`p${i}:${r.cells.length}c og=${r.off_grid} mg=${r.merged} ov=${r.chord_overflow} un=${r.unresolved}`);
    }
    const d = importSongsterrDrums(fetched.get(6)!.part, win);
    const hits = Object.values(d.voices).flat().filter((s) => s.on).length;
    console.log(`  ${c.label.padEnd(5)} m${c.from}-${c.to}  steps=${(c.to - c.from + 1) * 16}  ${bits.join('  ')}  drums:${hits}h`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
