/**
 * Audio-domain sensing tools. These are RIG capabilities, not device
 * tools: they read the OS audio layer (any input the OS exposes) and
 * never touch MIDI, so they are not port-dispatched or device-gated.
 *
 * Tools registered here:
 *   - `measure_loudness(input_device?, seconds?, channels?, first_channel?)`,
 *     BS.1770 loudness from an OS audio input (BK-105 phase 1)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { executeMeasureLoudness } from '../../audio/measureLoudness.js';

import { asError, asText } from './shared.js';

export function registerAudioTools(server: McpServer): void {
  server.registerTool('measure_loudness', {
    title: 'Measure Loudness',
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    description: [
      'Measure real loudness (BS.1770 LUFS + true peak) from any OS audio input: a modeler\'s USB audio (the AM4 is a 4x4 interface), a mic, an interface bus. Read-only, no MIDI; gives you ears on devices with no meter read.',
      'Call with no input_device first: returns the input roster; ask the user which to use (substring match).',
      'Capture blocks for `seconds` (default 8, max 30): ANNOUNCE FIRST in the same turn ("measuring for 8 seconds, play now"); the player\'s playing is the test signal.',
      'Returns lufs_integrated (perceived loudness, use for balancing), lufs_momentary_max, true_peak_dbtp, quality_flags (no-signal/too-quiet/clipped/short-gated-signal/short-capture).',
      'Scene leveling: measure each scene playing the SAME passage, delta vs the loudest scene, write trims via set_params (AM4 preset.scene_N_level), re-measure to confirm. Deltas cancel the capture chain, so absolute LUFS need no calibration.',
    ].join(' '),
    inputSchema: {
      input_device: z.string().optional().describe(
        'Substring of the audio input device name (case-insensitive). Omit to get the input list and ask the user; never guess.',
      ),
      seconds: z.number().min(1).max(30).optional().describe(
        'Capture length in seconds (default 8). Long enough for a played phrase; the tool blocks while listening.',
      ),
      channels: z.enum(['stereo', 'left', 'right']).optional().describe(
        'What to measure from the captured pair (default stereo). left/right isolates one side (mono measurement, reads ~3 LU low in absolute terms).',
      ),
      first_channel: z.number().int().min(0).optional().describe(
        '0-based first input channel (default 0). On a 4-in interface like the AM4, pass 2 to measure channels 3/4.',
      ),
    },
  }, async (args) => {
    try {
      return asText(await executeMeasureLoudness(args));
    } catch (err) {
      return asError(err);
    }
  });
}
