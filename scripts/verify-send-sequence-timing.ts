/**
 * Regression gate for note-off scheduling in BOTH streaming paths: the
 * `send_sequence` primitive and the pattern realizers' live streamer.
 *
 * The bug this exists to prevent (shipped, found 2026-07-25): every note-off in
 * a sequence was deferred to `max(time_ms + duration_ms)` and fired as one batch,
 * so per-event `duration_ms` was silently discarded. A sequence of
 * single-note / chord / single-note played as one accumulating chord, because the
 * first note never released until the last one did. It was caught by ear on a
 * MicroFreak, not by any test, which is why this file exists.
 *
 * The second half covers `buildStreamTimeline` (the pattern live-stream /
 * record-capture scheduler) once patterns gained authored note lengths and
 * tie-forward. A note can now outlive the cycle it starts in, so the cases here
 * pin the wrap: an overhanging note releases exactly once at the right absolute
 * time, a note-off from cycle N cannot choke cycle N+1's re-trigger of the same
 * pitch, a tie holds THROUGH the loop point into the next cycle's first onset,
 * and every note-on has exactly one note-off. That failure mode is silent on
 * disk and only audible as a drone on hardware, which is why it is pinned by
 * exact event sequence and not by totals.
 *
 * Offline + hardware-free: asserts against the pure timeline builders.
 *
 * Run: npx tsx scripts/verify-send-sequence-timing.ts
 */
import type { DeviceCapabilities, RealizeNoteEvent } from '../packages/core/src/protocol-generic/types.js';
import type { NeutralPattern, Step } from '../packages/core/src/protocol-generic/patterns/index.js';
import { compileToPlan } from '../packages/core/src/protocol-generic/patterns/index.js';
import {
    buildStreamTimeline,
    type StreamAction,
} from '../packages/core/src/protocol-generic/patterns/realizers/stream.js';
import { buildSequenceTimeline } from '../packages/server-all/src/server/tools/midi-primitives.js';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.log(`  FAIL  ${name}${detail !== undefined ? ` -- ${detail}` : ''}`); }
}

const CH = 2; // wire channel (0-based), i.e. musician channel 3
const isOn = (b: readonly number[]): boolean => (b[0] & 0xf0) === 0x90;
const isOff = (b: readonly number[]): boolean => (b[0] & 0xf0) === 0x80;

console.log('send_sequence timeline:');

// The exact shape that exposed the bug: single note, chord, single note.
{
    const events = [
        { note: 60, velocity: 100, time_ms: 0, duration_ms: 2000 },
        { note: 48, velocity: 100, time_ms: 7000, duration_ms: 2000 },
        { note: 55, velocity: 100, time_ms: 7000, duration_ms: 2000 },
        { note: 60, velocity: 100, time_ms: 7000, duration_ms: 2000 },
        { note: 64, velocity: 100, time_ms: 7000, duration_ms: 2000 },
        { note: 60, velocity: 100, time_ms: 14000, duration_ms: 2000 },
    ];
    const t = buildSequenceTimeline(events, CH);

    check('every event yields exactly one note-on and one note-off', t.length === events.length * 2);

    // THE regression: the first note must release at its OWN duration, long
    // before the sequence ends. Under the bug it released at 16000.
    const firstOff = t.find((e) => e.off && e.bytes[1] === 60);
    check('first note releases at its own duration (2000), not at the sequence end',
        firstOff?.at === 2000, `got ${String(firstOff?.at)}`);

    // No note may still be sounding during the gap between events.
    const soundingAt = (ms: number): number => {
        let n = 0;
        for (const e of t) {
            if (e.at > ms) break;
            if (isOn(e.bytes)) n++;
            if (isOff(e.bytes)) n--;
        }
        return n;
    };
    check('silence in the gap after the first note (t=4000)', soundingAt(4000) === 0, `${soundingAt(4000)} sounding`);
    check('four voices sounding during the chord (t=8000)', soundingAt(8000) === 4, `${soundingAt(8000)} sounding`);
    check('silence in the gap after the chord (t=12000)', soundingAt(12000) === 0, `${soundingAt(12000)} sounding`);
    check('exactly ONE voice during the final single note (t=15000)', soundingAt(15000) === 1, `${soundingAt(15000)} sounding`);
    check('everything released by the end', soundingAt(999999) === 0);
}

// Ordering: a note-off must precede a note-on at the same instant, so the same
// note retriggered back-to-back sounds twice instead of being cancelled.
{
    const t = buildSequenceTimeline([
        { note: 60, velocity: 100, time_ms: 0, duration_ms: 500 },
        { note: 60, velocity: 100, time_ms: 500, duration_ms: 500 },
    ], CH);
    const at500 = t.filter((e) => e.at === 500);
    check('at equal timestamps the note-off is emitted before the note-on',
        at500.length === 2 && isOff(at500[0].bytes) && isOn(at500[1].bytes));
}

// Timeline must be monotonically ordered, since the emitter sleeps between events.
{
    const t = buildSequenceTimeline([
        { note: 72, velocity: 90, time_ms: 900, duration_ms: 100 },
        { note: 60, velocity: 90, time_ms: 0, duration_ms: 3000 },
        { note: 64, velocity: 90, time_ms: 100, duration_ms: 100 },
    ], CH);
    check('timeline is sorted ascending by time', t.every((e, i) => i === 0 || t[i - 1].at <= e.at));
    check('a long note overlaps the short ones inside it',
        t.findIndex((e) => e.off && e.bytes[1] === 60) === t.length - 1);
}

// The channel must survive into every message.
{
    const t = buildSequenceTimeline([{ note: 60, velocity: 100, time_ms: 0, duration_ms: 100 }], CH);
    check('wire channel is carried on both the on and the off', t.every((e) => (e.bytes[0] & 0x0f) === CH));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern live-stream timeline: cycle wrap, ties, and the no-stuck-note proof.
// ─────────────────────────────────────────────────────────────────────────────

console.log('\npattern live-stream timeline:');

/** One action as `"<ms> on|off ch<1-16> n<note>"`, so a wrong ORDER fails too. */
const render = (t: readonly StreamAction[]): string[] =>
    t.map((a) => `${a.at} ${(a.bytes[0] & 0xf0) === 0x90 ? 'on' : 'off'} ch${(a.bytes[0] & 0x0f) + 1} n${a.bytes[1]}`);

const same = (got: readonly string[], want: readonly string[]): boolean =>
    got.length === want.length && got.every((g, i) => g === want[i]);

/**
 * THE invariant: walking the timeline, no pitch is ever turned on twice without
 * a release between, no note-off arrives for a pitch that is not sounding, and
 * nothing is left sounding at the end. A violation is a hung note on hardware.
 */
function balanceFault(t: readonly StreamAction[]): string | undefined {
    const sounding = new Set<number>();
    for (const a of t) {
        const key = ((a.bytes[0] & 0x0f) << 7) | a.bytes[1];
        if ((a.bytes[0] & 0xf0) === 0x90) {
            if (sounding.has(key)) return `re-triggered ch${(a.bytes[0] & 0x0f) + 1} n${a.bytes[1]} at ${a.at} with no release`;
            sounding.add(key);
        } else {
            if (!sounding.has(key)) return `released ch${(a.bytes[0] & 0x0f) + 1} n${a.bytes[1]} at ${a.at} while silent`;
            sounding.delete(key);
        }
    }
    return sounding.size === 0 ? undefined : `${sounding.size} note(s) left sounding at the end`;
}

const ev = (e: Partial<RealizeNoteEvent> & Pick<RealizeNoteEvent, 'time_ms' | 'duration_ms'>): RealizeNoteEvent =>
    ({ channel: 1, note: 60, velocity: 100, ...e });

// A note whose length runs past the end of its cycle. Its release belongs at the
// real absolute instant (1250, i.e. 250 ms INTO the next cycle), not modulo the
// cycle (which would put it at 250, before its own onset) and not dropped.
{
    const t = buildStreamTimeline([ev({ time_ms: 750, duration_ms: 500 })], 1000, 2);
    check('a note overhanging the cycle end releases at its true absolute time', same(render(t), [
        '750 on ch1 n60',
        '1250 off ch1 n60',
        '1750 on ch1 n60',
        '2000 off ch1 n60',
    ]), render(t).join(' | '));
    check('overhanging note: last release is clamped to the end of the stream (no ring past it)',
        t[t.length - 1].at === 2000);
    check('overhanging note: balanced', balanceFault(t) === undefined, balanceFault(t));
}

// A note LONGER than a whole cycle, re-triggered on the same pitch every cycle.
// Cycle N's off must not land after (and cancel) cycle N+1's on: the sounding
// note is released AT the re-trigger, off-then-on at the same instant.
{
    const t = buildStreamTimeline([ev({ time_ms: 0, duration_ms: 2500 })], 1000, 3);
    check('a note longer than the cycle is released by the next cycle\'s re-trigger, off before on', same(render(t), [
        '0 on ch1 n60',
        '1000 off ch1 n60',
        '1000 on ch1 n60',
        '2000 off ch1 n60',
        '2000 on ch1 n60',
        '3000 off ch1 n60',
    ]), render(t).join(' | '));
    check('note longer than a cycle: balanced', balanceFault(t) === undefined, balanceFault(t));
}

// TIE on the LAST onset of a looping cycle: it reaches the cycle's own first
// onset (the device's wrap rule), so the note sounds CONTINUOUSLY across the
// loop point at 1000 and the next cycle's onset does not re-articulate.
{
    const t = buildStreamTimeline([
        ev({ time_ms: 0, duration_ms: 500 }),
        ev({ time_ms: 500, duration_ms: 500, gate_sixths: 6, tie: true }),
    ], 1000, 2);
    check('a tie on the last onset holds through the loop point into the next cycle', same(render(t), [
        '0 on ch1 n60',
        '500 off ch1 n60',
        '500 on ch1 n60',
        '1500 off ch1 n60',
        '1500 on ch1 n60',
        '2000 off ch1 n60',
    ]), render(t).join(' | '));
    check('the wrapped tie merges two onsets: 3 note-ons over 2 cycles, not 4',
        t.filter((a) => (a.bytes[0] & 0xf0) === 0x90).length === 3);
    check('a tie with nowhere left to go releases at the end of the stream',
        t[t.length - 1].at === 2000 && (t[t.length - 1].bytes[0] & 0xf0) === 0x80);
    check('wrapped tie: balanced', balanceFault(t) === undefined, balanceFault(t));
}

// The worst case: a DRONE, one tied onset per cycle whose gate reaches the loop
// point, so the tie chain wraps on every repeat. One note-on for the whole
// stream and one note-off at the very end. If the chain walk could not
// terminate, or emitted an off per cycle, this is where it shows.
{
    const t = buildStreamTimeline([
        ev({ time_ms: 0, duration_ms: 1000, gate_sixths: 96, tie: true }),
    ], 1000, 3);
    check('a tie that wraps every cycle sounds ONCE and releases at the stream end', same(render(t), [
        '0 on ch1 n60',
        '3000 off ch1 n60',
    ]), render(t).join(' | '));
    check('drone: balanced', balanceFault(t) === undefined, balanceFault(t));
}

// A tie at a NON-maximum magnitude (gate 48 = 8 steps of a 16-step cycle, the
// hardware-confirmed byte 176 shape). Tie and gate are independent fields, so
// this must hold exactly like a full-length one.
{
    const t = buildStreamTimeline([
        ev({ note: 62, time_ms: 0, duration_ms: 800, gate_sixths: 48, tie: true }),
        ev({ note: 62, time_ms: 800, duration_ms: 800, gate_sixths: 48 }),
    ], 1600, 2);
    check('a tie at gate 48 (not the full 96) holds into the next onset', same(render(t), [
        '0 on ch1 n62',
        '1600 off ch1 n62',
        '1600 on ch1 n62',
        '3200 off ch1 n62',
    ]), render(t).join(' | '));
    check('non-maximum tie: balanced', balanceFault(t) === undefined, balanceFault(t));
}

// A tie whose gate does NOT end on the next onset is dropped (the device's own
// reachability rule, `dropUnreachableTies`): the note keeps its length and the
// next onset re-articulates.
{
    const t = buildStreamTimeline([
        ev({ time_ms: 0, duration_ms: 800, gate_sixths: 48, tie: true }),
        ev({ time_ms: 400, duration_ms: 200 }),
    ], 1600, 1);
    check('an unreachable tie is dropped, the length is kept and truncated by the re-trigger', same(render(t), [
        '0 on ch1 n60',
        '400 off ch1 n60',
        '400 on ch1 n60',
        '600 off ch1 n60',
    ]), render(t).join(' | '));
    check('unreachable tie: balanced', balanceFault(t) === undefined, balanceFault(t));
}

// A tie that reaches the next onset but finds a DIFFERENT pitch there does not
// hold either: the device ties a note into the same note, never into a chord change.
{
    const t = buildStreamTimeline([
        ev({ note: 62, time_ms: 0, duration_ms: 500 }),
        ev({ note: 60, time_ms: 500, duration_ms: 500, tie: true }),
    ], 1000, 2);
    check('a tie into a different pitch is dropped', same(render(t), [
        '0 on ch1 n62',
        '500 off ch1 n62',
        '500 on ch1 n60',
        '1000 off ch1 n60',
        '1000 on ch1 n62',
        '1500 off ch1 n62',
        '1500 on ch1 n60',
        '2000 off ch1 n60',
    ]), render(t).join(' | '));
    check('tie into a different pitch: balanced', balanceFault(t) === undefined, balanceFault(t));
}

// A micro-step roll must stay a BUZZ inside one step even when the step states a
// multi-step gate: the sub-hits fan across one step (gate 24 ⇒ 800 ms is four
// steps, so the step is 200 ms), never across the whole authored length.
{
    const t = buildStreamTimeline([
        ev({ time_ms: 0, duration_ms: 800, gate_sixths: 24, micro_hits: 4 }),
    ], 1600, 1);
    check('a roll on a long-gate step buzzes within ONE step', same(render(t), [
        '0 on ch1 n60',
        '40 off ch1 n60',
        '50 on ch1 n60',
        '90 off ch1 n60',
        '100 on ch1 n60',
        '140 off ch1 n60',
        '150 on ch1 n60',
        '190 off ch1 n60',
    ]), render(t).join(' | '));
    check('roll: balanced', balanceFault(t) === undefined, balanceFault(t));
}

// End to end through the compiler, at a BPM whose step time does not divide into
// whole milliseconds (133 BPM ⇒ 112.78 ms/step), so the tie's end lands 1 ms off
// the cycle boundary and only survives because reachability has a rounding
// tolerance. Two channels: the bass tie must look at ITS OWN channel's onsets,
// not the kick's (the kick has a later onset at step 15 that would defeat the wrap).
{
    const hit = (extra?: Partial<Step>): Step => ({ on: true, ...extra });
    const rest: Step = { on: false };
    const row = (on: readonly number[], extra?: (i: number) => Partial<Step> | undefined): Step[] =>
        Array.from({ length: 16 }, (_, i) => (on.includes(i) ? hit(extra?.(i)) : rest));
    const pattern: NeutralPattern = {
        name: 'tie-wrap',
        steps: 16,
        voices: {
            bass: { steps: row([0, 12], (i) => (i === 12 ? { gate_sixths: 24, tie: true } : { gate_sixths: 24 })) },
            kick: { steps: row([0, 4, 8, 12, 14]) },
        },
    };
    const caps: DeviceCapabilities = {
        slot_model: 'linear', has_scenes: false, has_channels: false,
        supports_save: false, supports_lineage: false,
        pattern_realizers: ['live_stream'],
        voice_map: { bass: { channel: 1, note: 36 }, kick: { channel: 10, note: 60 } },
    };
    const plan = compileToPlan(pattern, caps, { bpm: 133, mode: 'live_stream', repeat: 3 });
    const t = buildStreamTimeline(plan.events, plan.cycle_ms, plan.repeat);

    check('compiled cycle is 1805 ms and the tied bass note ends at 1804 (1 ms of rounding)',
        plan.cycle_ms === 1805, `cycle_ms=${plan.cycle_ms}`);

    const bass = render(t).filter((s) => s.includes('ch1 '));
    check('the bass tie holds across every loop point, releasing only at the stream end', same(bass, [
        '0 on ch1 n36',
        '451 off ch1 n36',
        '1353 on ch1 n36',
        '2256 off ch1 n36',
        '3158 on ch1 n36',
        '4061 off ch1 n36',
        '4963 on ch1 n36',
        '5415 off ch1 n36',
    ]), bass.join(' | '));

    const ons = t.filter((a) => (a.bytes[0] & 0xf0) === 0x90);
    const offs = t.filter((a) => (a.bytes[0] & 0xf0) === 0x80);
    check('note-on and note-off counts balance over 3 cycles',
        ons.length === offs.length && ons.length === 19, `${ons.length} on / ${offs.length} off`);
    check('the untied kick still fires on every step of every cycle',
        t.filter((a) => (a.bytes[0] & 0xf0) === 0x90 && (a.bytes[0] & 0x0f) === 9).length === 15);
    check('multi-channel, multi-cycle: balanced', balanceFault(t) === undefined, balanceFault(t));
    check('timeline is sorted ascending', t.every((a, i) => i === 0 || t[i - 1].at <= a.at));
}

console.log(failures === 0 ? '\nverify-send-sequence-timing: all checks passed' : `\nverify-send-sequence-timing: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
