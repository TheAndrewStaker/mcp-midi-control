// Goldens + invariants for pitch-target legato welding.
//
// The property that matters is not "durations got bigger", it is "there is no
// moment between the first and last onset when nothing is held". A MIDI-driven
// pitch corrector falls back to NO correction in exactly those moments, so a
// single surviving gap is an audible burst of raw, out-of-tune voice.
//
// `findPitchTargetGaps` is therefore the real assertion, and it is deliberately
// implemented independently of `applyLegato` (a sweep over sounding-time, not a
// re-derivation of the same arithmetic) so a bug in the welder cannot hide
// inside its own checker.
//
// Run: npx tsx scripts/verify-legato.ts

import { applyLegato, findPitchTargetGaps } from '@mcp-midi-control/core/protocol-generic/patterns/legato.js';
import type { RealizeNoteEvent } from '@mcp-midi-control/core/protocol-generic/types.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
    console.log(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`);
  }
}

const ev = (
  time_ms: number, note: number, duration_ms: number, channel = 3, velocity = 100,
): RealizeNoteEvent => ({ channel, note, velocity, time_ms, duration_ms });

// The exact shape `compile.ts` produces: a 90% one-step gate. At 120bpm a
// 16th step is 125ms, so each note is 112ms and leaks 13ms per step.
const STEP = 125;
const GATE = Math.round(STEP * 0.9); // 113
const compiled: RealizeNoteEvent[] = [0, 1, 2, 3, 4, 5, 6, 7]
  .map((i) => ev(i * STEP, 60 + i, GATE));

// ── 1. The untouched compiler output LEAKS, which is the whole premise ──────
{
  const gaps = findPitchTargetGaps(compiled, 3);
  check('compiler output has a gap under every step but the last', gaps.length === 7,
    `got ${gaps.length} gaps`);
  const total = gaps.reduce((a, g) => a + (g.to_ms - g.from_ms), 0);
  check('the leak is real and measurable (>80ms across one bar)', total >= 80, `total ${total}ms`);
}

// ── 2. After welding there is NO gap at all ────────────────────────────────
{
  const { events, reports } = applyLegato(compiled, { channels: [3] });
  check('legato leaves zero gaps', findPitchTargetGaps(events, 3).length === 0,
    JSON.stringify(findPitchTargetGaps(events, 3)));
  check('event COUNT is unchanged (no note invented or dropped)', events.length === compiled.length);
  check('onsets are unchanged (rhythm is not rewritten)',
    events.map((e) => e.time_ms).join() === compiled.map((e) => e.time_ms).join());
  check('pitches are unchanged', events.map((e) => e.note).join() === compiled.map((e) => e.note).join());

  const r = reports[0];
  check('report names the channel', r.channel === 3);
  check('report counts every onset', r.onsets === 8);
  check('report counts the 7 extended notes', r.extended === 7, `got ${r.extended}`);
  check('report measures the removed gap', r.gap_removed_ms === 7 * (STEP - GATE),
    `got ${r.gap_removed_ms}, expected ${7 * (STEP - GATE)}`);

  // Each welded note ends exactly where the next begins.
  const sorted = [...events].sort((a, b) => a.time_ms - b.time_ms);
  for (let i = 0; i < sorted.length - 1; i++) {
    check(`note ${i} abuts note ${i + 1} exactly`,
      sorted[i].time_ms + sorted[i].duration_ms === sorted[i + 1].time_ms,
      `${sorted[i].time_ms}+${sorted[i].duration_ms} vs ${sorted[i + 1].time_ms}`);
  }
  check('the LAST note keeps its compiled duration by default',
    sorted[sorted.length - 1].duration_ms === GATE);
}

// ── 3. Purity: the input is never mutated ─────────────────────────────────
{
  const input = [ev(0, 60, GATE), ev(STEP, 62, GATE)];
  const snapshot = JSON.stringify(input);
  applyLegato(input, { channels: [3] });
  check('applyLegato does not mutate its input', JSON.stringify(input) === snapshot);
}

// ── 4. Channel isolation: a drum lane must NOT be welded into a drone ──────
{
  const mixed: RealizeNoteEvent[] = [
    ev(0, 60, GATE, 3), ev(STEP, 62, GATE, 3),          // vocal target, ch3
    ev(0, 36, 20, 10), ev(STEP, 38, 20, 10),            // drums, ch10
  ];
  const { events } = applyLegato(mixed, { channels: [3] });
  const drums = events.filter((e) => e.channel === 10);
  check('drum events pass through untouched', drums.every((d) => d.duration_ms === 20),
    JSON.stringify(drums));
  check('drum lane still has its gaps (correctly NOT welded)',
    findPitchTargetGaps(events, 10).length === 1);
  check('the vocal lane IS welded', findPitchTargetGaps(events, 3).length === 0);
  check('nothing was lost from the mixed stream', events.length === 4);
}

// ── 5. Chords: every voice of a chord extends together ────────────────────
{
  const chords: RealizeNoteEvent[] = [
    ev(0, 60, GATE), ev(0, 64, GATE), ev(0, 67, GATE),   // triad at t=0
    ev(STEP, 62, GATE), ev(STEP, 65, GATE),              // dyad at t=125
  ];
  const { events } = applyLegato(chords, { channels: [3] });
  const first = events.filter((e) => e.time_ms === 0);
  check('all three chord voices extend to the next onset',
    first.length === 3 && first.every((e) => e.duration_ms === STEP),
    JSON.stringify(first.map((e) => e.duration_ms)));
  check('a chord leaves no gap', findPitchTargetGaps(events, 3).length === 0);
}

// ── 6. Repeated pitches stay SEPARATE note-ons ────────────────────────────
{
  // Two quarter notes on the same pitch must not merge: the re-articulation is
  // what tells the corrector a new syllable started, and merging would silently
  // rewrite the rhythm.
  const repeated = [ev(0, 60, GATE), ev(STEP, 60, GATE), ev(2 * STEP, 60, GATE)];
  const { events } = applyLegato(repeated, { channels: [3] });
  check('three same-pitch notes remain three events', events.length === 3);
  check('their onsets are preserved', events.map((e) => e.time_ms).join() === `0,${STEP},${2 * STEP}`);
  check('repeated pitches leave no gap', findPitchTargetGaps(events, 3).length === 0);
}

// ── 7. Overlap and tail options ───────────────────────────────────────────
{
  const { events } = applyLegato(compiled, { channels: [3], overlap_ms: 10 });
  const sorted = [...events].sort((a, b) => a.time_ms - b.time_ms);
  check('overlap_ms holds each note past the next onset',
    sorted[0].time_ms + sorted[0].duration_ms === sorted[1].time_ms + 10);
  check('overlap still leaves no gap', findPitchTargetGaps(events, 3).length === 0);

  const tailed = applyLegato(compiled, { channels: [3], tail_ms: 2000 });
  const last = [...tailed.events].sort((a, b) => a.time_ms - b.time_ms).at(-1)!;
  check('tail_ms sets the final note length', last.duration_ms === 2000);
}

// ── 8. Already-legato input is left alone (idempotence) ───────────────────
{
  const once = applyLegato(compiled, { channels: [3] });
  const twice = applyLegato(once.events, { channels: [3] });
  check('applyLegato is idempotent', JSON.stringify(twice.events) === JSON.stringify(once.events));
  check('a second pass reports nothing left to extend', twice.reports[0].extended === 0);
  check('a second pass reports no remaining gap', twice.reports[0].gap_removed_ms === 0);
}

// ── 9. Degenerate inputs must not throw ───────────────────────────────────
{
  check('empty input returns empty', applyLegato([], { channels: [3] }).events.length === 0);
  check('empty input has no gaps', findPitchTargetGaps([], 3).length === 0);
  const single = applyLegato([ev(0, 60, GATE)], { channels: [3] });
  check('a single note is left untouched', single.events[0].duration_ms === GATE);
  check('a single note has no gaps', findPitchTargetGaps(single.events, 3).length === 0);
  // A note that already OVERHANGS the next onset gets pulled back, so an
  // overlong gate cannot smear two syllables into one target.
  const overhang = applyLegato([ev(0, 60, 500), ev(STEP, 62, GATE)], { channels: [3] });
  const firstEv = overhang.events.find((e) => e.time_ms === 0)!;
  check('an overhanging note is SHORTENED to the next onset', firstEv.duration_ms === STEP,
    `got ${firstEv.duration_ms}`);
  check('the overhang is reported as shortened', overhang.reports[0].shortened === 1);
}

// ── 10. Omitting `channels` welds everything present ──────────────────────
{
  const mixed = [ev(0, 60, GATE, 3), ev(STEP, 62, GATE, 3), ev(0, 36, 20, 10), ev(STEP, 38, 20, 10)];
  const { reports } = applyLegato(mixed);
  check('no channel filter reports both channels', reports.length === 2);
  check('reports are ordered by channel', reports[0].channel === 3 && reports[1].channel === 10);
}

console.log(failures === 0
  ? 'verify-legato: all checks passed'
  : `verify-legato: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
