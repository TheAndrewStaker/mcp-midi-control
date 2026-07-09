/**
 * Realizer B, record-capture.
 *
 * The pattern lands ON the device: the host streams the notes while the
 * target's OWN sequencer records them into a pattern that then loops on
 * the device's own clock.
 *
 * SCOPE on Circuit Tracks (manual p.38 + on-device test 2026-06-18): this
 * works ONLY for the SYNTH tracks (ch1/ch2). "Recording from an external
 * controller" is documented for synth patterns only. DRUM tracks do NOT
 * record external MIDI, an external note on ch10 triggers the pad sound but
 * is never captured (confirmed: streamed kicks sounded but did not store;
 * only physical pad taps record). So this realizer is for MELODIC capture;
 * a drum beat cannot be landed on the device over MIDI (NCS upload, phase
 * C, is the only programmatic drum-onto-device path). The Circuit still
 * advertises only live_stream until the synth-track capture path is wired
 * to a synth voice_map.
 *
 * Two-phase, because arming Record is a HARDWARE button the host can't
 * press:
 *   1. plan.armed falsey ⇒ return an "arm Record now" instruction, send
 *      nothing. The agent relays it and waits for the user.
 *   2. plan.armed true ⇒ stream the events for the device to capture.
 *
 * There is no MIDI readback of a captured pattern, so the result is
 * reported honestly as `streamed_unverified` (we sent it; confirm by ear /
 * on the device), never a fabricated success. Caveats surfaced: the
 * device caps a pattern at 32 steps, and incoming notes snap to the track
 * Scale unless it is set to Chromatic.
 */

import type { MidiConnection } from '../../../midi/transport.js';
import type { RealizePlan, RealizeResult } from '../../types.js';
import { streamEvents } from './stream.js';

const DEVICE_STEP_CAP = 32;

function captureCaveats(plan: RealizePlan): string[] {
  const notes: string[] = [];
  if (plan.steps > DEVICE_STEP_CAP) {
    notes.push(
      `Pattern is ${plan.steps} steps; the device records at most ${DEVICE_STEP_CAP} per pattern, ` +
      `so it will be truncated on capture.`,
    );
  }
  notes.push(
    'Incoming notes snap to the track’s Scale/Root unless it is set to Chromatic, ' +
    'set Chromatic first if the pattern uses out-of-scale pitches.',
  );
  return notes;
}

export async function realizeRecordCapture(
  conn: MidiConnection,
  plan: RealizePlan,
): Promise<RealizeResult> {
  const caveats = captureCaveats(plan);

  if (!plan.armed) {
    return {
      ok: true,
      mode: 'record_capture',
      status: 'awaiting_arm',
      info:
        `Ready to capture "${plan.pattern_name}" (${plan.bpm} BPM) into the device. ` +
        'ON THE HARDWARE: select the target track and press Record to arm it, then ' +
        're-call apply_pattern with the same arguments plus armed:true to stream the take. ' +
        caveats.join(' '),
    };
  }

  const notesSent = await streamEvents(conn, plan.events, plan.cycle_ms, plan.repeat);
  return {
    ok: true,
    mode: 'record_capture',
    status: 'streamed_unverified',
    notes_sent: notesSent,
    source: 'streamed_unverified',
    warning:
      'Streamed for on-device capture, but the device gives no readback, confirm the ' +
      'pattern recorded by ear / on the front panel. ' + caveats.join(' '),
  };
}
