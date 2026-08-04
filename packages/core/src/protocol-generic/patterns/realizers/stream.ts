/**
 * Shared note-event streamer for the live realizers. Builds ONE merged,
 * time-ordered action timeline for the WHOLE stream (every repeat of the
 * cycle, every channel, note-ons and their note-offs), then sleeps-and-sends
 * it through a MidiConnection. Multi-channel by construction (a pattern can
 * drive Circuit drums on ch10 and a synth voice on ch1 in the same cycle).
 *
 * This is the generalized superset of the `send_sequence` primitive's
 * scheduler: same setTimeout-based pacing, but per-event channel and a
 * merged off/on timeline so per-note gates are honored. JS-timer jitter
 * makes this AUDITION-tier, not a performance clock (documented on the
 * realizers).
 *
 * WHY THE TIMELINE IS ABSOLUTE, NOT PER-CYCLE. Patterns now carry authored
 * note lengths (`gate_sixths`, up to sixteen steps) and a per-step TIE, so a
 * note can outlive the cycle it starts in. A per-cycle action list cannot
 * express that: an off scheduled past the cycle end either drifts the loop
 * (the pad-out is skipped, so every repeat starts late) or lands after the
 * next cycle's on for the same pitch and chokes it. Expanding all `repeat`
 * cycles onto one absolute grid makes an overhanging note ordinary, and one
 * `base` timestamp for the whole stream means send latency cannot accumulate
 * into loop drift.
 *
 * THE INVARIANT: every note-on in the emitted timeline has exactly one
 * note-off, at a strictly later instant. It is structural, notes are built as
 * spans (`Sounding`) and each span emits its pair, so no code path can emit a
 * lone on. Overlaps of the same (channel, note) are resolved by truncating the
 * earlier span to the later one's onset, which is the only way one MIDI pitch
 * can behave: a re-trigger releases what was sounding. `streamEvents` also
 * flushes any still-sounding note if a send throws part-way, because a hung
 * note on a looping audition drones until the user physically intervenes.
 */

import type { MidiConnection } from '../../../midi/transport.js';
import type { RealizeNoteEvent } from '../../types.js';
import { buildNoteOff, buildNoteOn } from '../../../midi/messages.js';
import { GATE_SIXTHS_PER_STEP } from '../types.js';
import { rollVelocity } from '../rollDynamics.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One scheduled wire message, `at` ms from the start of the WHOLE stream. */
export interface StreamAction { at: number; bytes: number[]; isOn: boolean; }

/**
 * How far a tie's end may miss the next onset and still count as reaching it.
 *
 * The device's rule is EXACT (see `dropUnreachableTies` in the Circuit writer:
 * a tie must end precisely on the next onset), but the compiler rounds each
 * time and each duration to whole milliseconds independently, so an exact gate
 * can land up to 2 ms off its target once both ends are rounded. 3 ms keeps a
 * millisecond of headroom and is still an order of magnitude under the
 * shortest real onset spacing (one sixth of a step is ~10 ms even at 960 BPM),
 * so it can never fuse two onsets that the author meant to hear separately.
 */
const TIE_REACH_TOLERANCE_MS = 3;

/** A note as it actually SOUNDS: one on at `start`, one off at `end`. */
interface Sounding { start: number; end: number; channel: number; note: number; velocity: number; }

/** Where a tie-forward lands: the cycle-relative event it holds into. */
interface TieLink { index: number; wraps: boolean; }

/** Sub-hits this event fans into. >1 only for a micro-step roll (capped at 6). */
function rollHits(e: RealizeNoteEvent): number {
  return e.micro_hits !== undefined && e.micro_hits > 1 ? Math.min(6, e.micro_hits) : 1;
}

/**
 * TIE REACHABILITY, the same rule the `.ncs` writer applies at the device
 * boundary (`dropUnreachableTies`), restated in milliseconds because that is
 * the unit this scheduler has: a tie holds only when its gate ends EXACTLY on
 * the next onset of its own channel AND that onset plays the same pitch.
 * Anything else is dropped, the note keeps its length and re-triggers normally.
 * One rule in two places rather than two interpretations that can drift.
 *
 * "Next onset" is per channel (a channel here is what a track is there) and is
 * any onset, not just a matching one, so a tie whose gate overshoots an
 * intervening note is dropped rather than swallowing it. With no later onset
 * in the cycle the tie WRAPS to the cycle's own first onset, the manual's
 * worked example and the writer's `onsets[0] + patternSteps`.
 *
 * A rolled step is neither a tie source nor a tie target: a roll is deliberate
 * re-triggers, so there is nothing to hold and nothing to hold into.
 */
function resolveTieLinks(
  events: readonly RealizeNoteEvent[],
  cycleMs: number,
): readonly (TieLink | undefined)[] {
  const onsetsByChannel = new Map<number, number[]>();
  for (const e of events) {
    const times = onsetsByChannel.get(e.channel);
    if (times === undefined) onsetsByChannel.set(e.channel, [e.time_ms]);
    else if (!times.includes(e.time_ms)) times.push(e.time_ms);
  }
  for (const times of onsetsByChannel.values()) times.sort((a, b) => a - b);

  return events.map((e) => {
    if (e.tie !== true || rollHits(e) > 1) return undefined;
    const times = onsetsByChannel.get(e.channel) ?? [];
    if (times.length === 0) return undefined;
    const later = times.find((t) => t > e.time_ms);
    const wraps = later === undefined;
    const targetTime = later ?? times[0];
    const reachAt = wraps ? targetTime + cycleMs : targetTime;
    if (Math.abs(e.time_ms + e.duration_ms - reachAt) > TIE_REACH_TOLERANCE_MS) return undefined;
    const index = events.findIndex((c) => c.time_ms === targetTime
      && c.channel === e.channel && c.note === e.note && rollHits(c) === 1);
    return index < 0 ? undefined : { index, wraps };
  });
}

/**
 * Expand `repeat` cycles of `events` into the absolute, ordered wire timeline.
 * Pure and hardware-free, which is what makes the timing goldens in
 * `scripts/verify-send-sequence-timing.ts` possible.
 */
export function buildStreamTimeline(
  events: readonly RealizeNoteEvent[],
  cycleMs: number,
  repeat: number,
): StreamAction[] {
  const total = cycleMs * repeat;
  const links = resolveTieLinks(events, cycleMs);
  // (cycle, event) pairs already absorbed as the continuation of a tie, so they
  // never sound a second time. Also what makes the chain walk terminate: every
  // hop consumes a fresh pair and there are finitely many.
  const absorbed = new Set<string>();
  const sounding: Sounding[] = [];

  for (let rep = 0; rep < repeat; rep++) {
    for (let i = 0; i < events.length; i++) {
      if (absorbed.has(`${rep}:${i}`)) continue;
      const e = events[i];
      const start = rep * cycleMs + e.time_ms;
      const hits = rollHits(e);

      if (hits > 1) {
        // Micro-step roll: N evenly-spaced re-triggers so a live audition
        // actually buzzes (the .ncs author writes the real micro-hit mask;
        // this is the live-stream approximation). The buzz belongs inside ONE
        // step, so an authored multi-step gate lengthens the note rather than
        // stretching the roll: derive the step from the event's own
        // `gate_sixths` and fan within it.
        const stepMs = e.gate_sixths !== undefined && e.gate_sixths > 0
          ? (e.duration_ms * GATE_SIXTHS_PER_STEP) / e.gate_sixths
          : e.duration_ms;
        const sub = Math.min(e.duration_ms, stepMs) / hits;
        for (let k = 0; k < hits; k++) {
          const at = start + Math.round(k * sub);
          sounding.push({
            start: at,
            end: at + Math.max(8, Math.round(sub * 0.8)),
            channel: e.channel,
            note: e.note,
            // Same decay curve the .ncs author writes (rollVelocity), so the
            // live audition sounds like the stored result, not a machine-gun.
            velocity: rollVelocity(e.velocity, k),
          });
        }
        continue;
      }

      // Follow the tie chain: a held note's release is the release of the LAST
      // note in the chain, and every note it holds through is absorbed (no
      // re-trigger). The chain may cross cycle boundaries, which is how a tie
      // on the last onset reaches the first onset of the next repeat.
      let end = start + e.duration_ms;
      let cursorRep = rep;
      let cursor = i;
      for (;;) {
        const link = links[cursor];
        if (link === undefined) break;
        const nextRep = cursorRep + (link.wraps ? 1 : 0);
        // The loop stops here, so there is no next onset to hold into. Release
        // at the end of the stream rather than ring on past it or hang.
        if (nextRep >= repeat) { end = total; break; }
        const nextKey = `${nextRep}:${link.index}`;
        if (absorbed.has(nextKey)) break;   // another chain already holds it
        absorbed.add(nextKey);
        cursorRep = nextRep;
        cursor = link.index;
        end = cursorRep * cycleMs + events[cursor].time_ms + events[cursor].duration_ms;
      }
      sounding.push({ start, end, channel: e.channel, note: e.note, velocity: e.velocity });
    }
  }

  // One MIDI pitch on one channel can only sound once at a time, so a span that
  // is still open when the same pitch re-triggers is released AT that re-trigger
  // (the off sorts before the on below, giving a clean re-articulation instead of
  // the later note being cancelled by the earlier note's off). Nothing sounds
  // past the end of the stream.
  const byPitch = new Map<number, Sounding[]>();
  for (const v of sounding) {
    const key = v.channel * 128 + v.note;
    const group = byPitch.get(key);
    if (group === undefined) byPitch.set(key, [v]);
    else group.push(v);
  }
  const actions: StreamAction[] = [];
  for (const group of byPitch.values()) {
    group.sort((a, b) => a.start - b.start);
    for (let k = 0; k < group.length; k++) {
      const v = group[k];
      const next = group[k + 1];
      let end = Math.min(v.end, total);
      if (next !== undefined && next.start < end) end = next.start;
      // Swallowed whole (a duplicate onset at the same instant). Emit NEITHER
      // message: a zero-length span would put its off before its own on.
      if (end <= v.start) continue;
      const wireCh = v.channel - 1;
      actions.push({ at: v.start, bytes: buildNoteOn(wireCh, v.note, v.velocity), isOn: true });
      actions.push({ at: end, bytes: buildNoteOff(wireCh, v.note, 0), isOn: false });
    }
  }
  // Offs sort before ons at the same instant so a same-pitch re-trigger gets
  // off-then-on (no hung note).
  actions.sort((a, b) => (a.at - b.at) || (a.isOn === b.isOn ? 0 : a.isOn ? 1 : -1));
  return actions;
}

/** Stream `events` for `repeat` cycles of `cycleMs`. Returns note-ons sent. */
export async function streamEvents(
  conn: MidiConnection,
  events: readonly RealizeNoteEvent[],
  cycleMs: number,
  repeat: number,
): Promise<number> {
  const actions = buildStreamTimeline(events, cycleMs, repeat);
  const total = cycleMs * repeat;
  // Note-offs owed for whatever is sounding right now. Empty on a clean finish
  // (the timeline pairs every on with an off); the flush below exists for the
  // path where `conn.send` throws mid-stream, where the alternative is a drone
  // that only stops when the user unplugs something.
  const owed = new Map<number, number[]>();
  let notesSent = 0;

  const base = Date.now();
  try {
    for (const act of actions) {
      const target = base + act.at;
      const now = Date.now();
      if (target > now) await sleep(target - now);
      conn.send(act.bytes);
      const key = ((act.bytes[0] & 0x0f) << 7) | act.bytes[1];
      if (act.isOn) {
        notesSent++;
        owed.set(key, [0x80 | (act.bytes[0] & 0x0f), act.bytes[1], 0]);
      } else {
        owed.delete(key);
      }
    }
    // Hold the stream to its stated length (repeat × cycleMs) even when the
    // last message lands early, so a caller's timing expectation holds.
    const elapsed = Date.now() - base;
    if (elapsed < total) await sleep(total - elapsed);
  } finally {
    for (const bytes of owed.values()) {
      try { conn.send(bytes); } catch { /* the port is already gone: nothing further to do */ }
    }
    owed.clear();
  }
  return notesSent;
}
