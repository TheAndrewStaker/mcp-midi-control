/**
 * Audition tools — `play_note` and `play_chord`.
 *
 * Tools registered here:
 *   - `play_note(port, note, velocity?, duration_ms?, channel?)` — single-
 *                                                                  note audition
 *   - `play_chord(port, notes[], velocity?, duration_ms?, strum_ms?, channel?)`
 *                                                                — multi-note audition
 *
 * Both are vendor-agnostic — every MIDI device accepts Note On/Off as
 * valid input. Whether the bytes produce audible sound is per-device;
 * see `describe_device.agent_guidance.note_response` for the expected
 * behavior of each registered device before calling.
 *
 * Notes accept either MIDI integers (0..127, middle C = 60) or
 * scientific pitch names ("C4", "F#3", "Bb-1"). C4 = 60 in the Yamaha
 * convention used by most modern synthesizers and DAWs.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { executePlayChord, executePlayNote } from '../dispatcher.js';

import { PORT_DESC, asError, asText } from './shared.js';

const SEMITONE_BY_LETTER: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

/**
 * Accept a raw MIDI note number (60) or a scientific pitch name ("C4",
 * "F#3", "Bb-1"). Returns the 0..127 note. Middle C = C4 = 60 (Yamaha
 * convention, matches Hydrasynth manual and most DAWs).
 *
 * Mirrors `parseNote` in `packages/hydrasynth/src/tools/shared.ts`
 * — kept inline here so the unified surface has no cross-device package
 * dependency for a primitive that's fundamentally vendor-agnostic.
 */
function parseNoteInput(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0 || input > 127) {
      throw new Error(`Note number out of range 0..127: ${input}`);
    }
    return Math.round(input);
  }
  const m = input.trim().match(/^([A-G])([#b]?)(-?\d+)$/i);
  if (!m) {
    throw new Error(
      `Cannot parse note "${input}". Expected a number 0..127 or a name like "C4", "F#3", "Bb-1".`,
    );
  }
  const semitone = SEMITONE_BY_LETTER[m[1]!.toUpperCase()]!;
  const accidental = m[2] === '#' ? 1 : m[2]?.toLowerCase() === 'b' ? -1 : 0;
  const octave = Number.parseInt(m[3]!, 10);
  const note = (octave + 1) * 12 + semitone + accidental;
  if (note < 0 || note > 127) {
    throw new Error(`Note "${input}" resolves to ${note}, outside MIDI range 0..127.`);
  }
  return note;
}

export function registerAuditionTools(server: McpServer): void {
  server.registerTool('play_note', {
    description: [
      'Audition the active patch on the named device by playing a single',
      'MIDI note for a specified duration. Sends Note On, waits, sends',
      'Note Off. Useful after editing parameters to hear the result',
      'without asking the user to play a key.',
      '',
      'Whether the note produces audible sound is per-device. Synthesizers',
      '(Hydrasynth) sound the current patch. Audio processors (AM4,',
      'Axe-Fx II) typically produce no sound — they process guitar input,',
      'not MIDI notes. Axe-Fx III sounds only when the Synth block is',
      'placed in the active preset. Call describe_device(port).agent_',
      'guidance.note_response to see what to expect before calling.',
      '',
      'Notes accept MIDI numbers (0..127, middle C = 60) or scientific',
      'pitch names ("C4", "F#3", "Bb-1"). C4 = 60 (Yamaha convention).',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      note: z.union([z.string(), z.number()]).describe(
        'Note as MIDI number (0..127) or pitch name ("C4", "F#3", "Bb-1"). Middle C = C4 = 60.',
      ),
      velocity: z.number().int().min(1).max(127).default(96).describe(
        'Note velocity 1..127. Default 96 (mezzo-forte).',
      ),
      duration_ms: z.number().int().min(50).max(5000).default(800).describe(
        'How long to hold the note before releasing, in milliseconds. Capped at 5000 ms to prevent runaway.',
      ),
      channel: z.number().int().min(1).max(16).default(1).describe(
        'MIDI channel 1..16. Default 1 — matches every current device. Override only for MPE or multi-timbral setups.',
      ),
    },
  }, async ({ port, note, velocity, duration_ms, channel }) => {
    try {
      const noteNum = parseNoteInput(note);
      const result = await executePlayNote({
        port,
        note: noteNum,
        velocity,
        duration_ms,
        channel,
      });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('play_chord', {
    description: [
      'Audition the active patch on the named device by playing multiple',
      'simultaneous MIDI notes for a specified duration. Sends Note On for',
      'each note (optionally staggered by `strum_ms` to simulate a strum),',
      'waits `duration_ms`, then sends Note Off for each.',
      '',
      'USE THIS over play_note when the patch is designed to be played as',
      'a chord (orchestral stabs, pads, brass stacks, supersaw recipes).',
      'Auditioning a chord patch with single notes hides stack-detuning',
      'behavior and inter-note filter dynamics that the patch was tuned',
      'for. Common voicings: minor stab (C-Eb-G, F-Ab-C), root-fifth pad',
      '(C-G), full triad with octave (C-E-G-C).',
      '',
      'Same per-device audibility caveats as play_note. See describe_',
      'device(port).agent_guidance.note_response.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      notes: z.array(z.union([z.string(), z.number()])).min(1).max(16).describe(
        'Notes as an array of MIDI numbers or pitch names — e.g. ["C3","Eb3","G3"] or [48,51,55]. 1..16 notes; most patches sound best with 3..6.',
      ),
      velocity: z.number().int().min(1).max(127).default(96).describe(
        'Note velocity 1..127, applied uniformly to every note. Default 96.',
      ),
      duration_ms: z.number().int().min(50).max(5000).default(800).describe(
        'How long to hold the chord before releasing, in milliseconds. Capped at 5000 ms.',
      ),
      strum_ms: z.number().int().min(0).max(500).default(0).describe(
        'Delay between successive Note Ons, in milliseconds. 0 = simultaneous (block chord). 20..50 = subtle strum. 80..200 = arpeggio attack.',
      ),
      channel: z.number().int().min(1).max(16).default(1).describe(
        'MIDI channel 1..16. Default 1. All notes share the channel — MPE / multi-timbral splits not supported on this primitive.',
      ),
    },
  }, async ({ port, notes, velocity, duration_ms, strum_ms, channel }) => {
    try {
      const noteNums = notes.map((n) => parseNoteInput(n));
      const result = await executePlayChord({
        port,
        notes: noteNums,
        velocity,
        duration_ms,
        strum_ms,
        channel,
      });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });
}
