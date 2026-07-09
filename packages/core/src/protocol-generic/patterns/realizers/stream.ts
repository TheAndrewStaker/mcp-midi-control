/**
 * Shared note-event streamer for the live realizers. Builds one merged,
 * time-ordered action timeline (note-ons + their note-offs across every
 * channel), then sleeps-and-sends through a MidiConnection, looping the
 * cycle `repeat` times. Multi-channel by construction (a pattern can drive
 * Circuit drums on ch10 and a synth voice on ch1 in the same cycle).
 *
 * This is the generalized superset of the `send_sequence` primitive's
 * scheduler: same setTimeout-based pacing, but per-event channel and a
 * merged off/on timeline so per-note gates are honored. JS-timer jitter
 * makes this AUDITION-tier, not a performance clock (documented on the
 * realizers).
 */

import type { MidiConnection } from '../../../midi/transport.js';
import type { RealizeNoteEvent } from '../../types.js';
import { buildNoteOff, buildNoteOn } from '../../../midi/messages.js';
import { rollVelocity } from '../rollDynamics.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Action { at: number; bytes: number[]; isOn: boolean; }

/** Stream `events` for `repeat` cycles of `cycleMs`. Returns note-ons sent. */
export async function streamEvents(
  conn: MidiConnection,
  events: readonly RealizeNoteEvent[],
  cycleMs: number,
  repeat: number,
): Promise<number> {
  // Pre-build one cycle's action timeline. Offs sort before ons at the same
  // instant so a same-note retrigger gets off-then-on (no hung note).
  const actions: Action[] = [];
  for (const e of events) {
    const wireCh = e.channel - 1;
    // Micro-step roll: expand into N evenly-spaced retriggers across the step
    // so a live audition actually buzzes (the .ncs author writes the real
    // micro-hit mask; this is the live-stream approximation). Absent ⇒ 1 hit.
    const n = e.micro_hits !== undefined && e.micro_hits > 1 ? Math.min(6, e.micro_hits) : 1;
    if (n === 1) {
      actions.push({ at: e.time_ms, bytes: buildNoteOn(wireCh, e.note, e.velocity), isOn: true });
      actions.push({ at: e.time_ms + e.duration_ms, bytes: buildNoteOff(wireCh, e.note, 0), isOn: false });
    } else {
      const sub = e.duration_ms / n;
      for (let k = 0; k < n; k++) {
        const at = e.time_ms + Math.round(k * sub);
        // Same decay curve the .ncs author writes (rollVelocity), so the live
        // audition sounds like the stored result, not a machine-gun.
        actions.push({ at, bytes: buildNoteOn(wireCh, e.note, rollVelocity(e.velocity, k)), isOn: true });
        actions.push({ at: at + Math.max(8, Math.round(sub * 0.8)), bytes: buildNoteOff(wireCh, e.note, 0), isOn: false });
      }
    }
  }
  actions.sort((a, b) => (a.at - b.at) || (a.isOn === b.isOn ? 0 : a.isOn ? 1 : -1));

  let notesSent = 0;
  for (let rep = 0; rep < repeat; rep++) {
    const base = Date.now();
    for (const act of actions) {
      const target = base + act.at;
      const now = Date.now();
      if (target > now) await sleep(target - now);
      conn.send(act.bytes);
      if (act.isOn) notesSent++;
    }
    // Pad out the remainder of the cycle so the next loop aligns to the grid.
    const elapsed = Date.now() - base;
    if (elapsed < cycleMs) await sleep(cycleMs - elapsed);
  }
  return notesSent;
}
