/**
 * Realizer A, live-stream.
 *
 * The host (Claude) IS the sequencer: it streams the compiled note events
 * in real time and the target plays them as a sound module. Works on any
 * note-capable device with a voice_map, zero device-specific code.
 *
 * TIER: AUDITION / PROTOTYPE, NOT A PERFORMANCE TOOL. The scheduler is
 * setTimeout-based, so it carries JS event-loop jitter (GC pauses, etc.)
 * that is audible on a tight groove. For a gig the beat belongs ON the
 * device, landed via record_capture (B) so the device's own clock plays
 * it, or authored as a project via ncs_upload (C). Live-stream exists to
 * audition a pattern, not to drive a set.
 */

import type { MidiConnection } from '../../../midi/transport.js';
import type { RealizePlan, RealizeResult } from '../../types.js';
import { streamEvents } from './stream.js';

export async function realizeLiveStream(
  conn: MidiConnection,
  plan: RealizePlan,
): Promise<RealizeResult> {
  const notesSent = await streamEvents(conn, plan.events, plan.cycle_ms, plan.repeat);
  return {
    ok: true,
    mode: 'live_stream',
    status: 'played',
    notes_sent: notesSent,
    source: 'played',
    info:
      `Streamed "${plan.pattern_name}" live at ${plan.bpm} BPM ` +
      `(${plan.repeat} cycle(s), ${plan.cycle_ms} ms each). Audition tier, ` +
      `nothing was stored on the device; timing is host-clocked (JS jitter).`,
  };
}
