/**
 * Axe-Fx III utility tools,tempo, tuner, looper.
 *
 * Tools registered:
 *   - axefx3_tempo_tap                (function 0x10)
 *   - axefx3_set_tempo / get_tempo    (function 0x14)
 *   - axefx3_set_tuner                (function 0x11)
 *   - axefx3_set_looper / get_looper  (function 0x0F)
 *
 * All wire envelopes are v1.4 spec verbatim.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  buildTempoTap,
  buildSetTempo,
  buildGetTempo,
  buildSetTuner,
  buildSetLooper,
  buildGetLooperState,
  isSetGetTempoResponse,
  isSetGetLooperResponse,
  parseTempoResponse,
  parseLooperStateResponse,
  type LooperAction,
} from 'fractal-midi/axe-fx-iii';

import {
  BETA_NOTE,
  BETA_PREFIX,
  GET_RESPONSE_TIMEOUT_MS,
  NO_ACK_NOTE,
  ensureConn,
  formatMultipurposeError,
  sendAndWatchForError,
  toHex,
} from './shared.js';

export function registerAxeFxIIIUtilityTools(server: McpServer): void {

  server.registerTool('axefx3_tempo_tap', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Send one tempo-tap to the Axe-Fx III, equivalent to pressing the front-panel TAP button. The device computes BPM from the inter-tap interval.',
      NO_ACK_NOTE,
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {},
  }, async () => {
    const bytes = buildTempoTap();
    const c = ensureConn();
    const errorReport = await sendAndWatchForError(c, bytes);
    const errorBlock = errorReport
      ? `\n${formatMultipurposeError(errorReport)}\n`
      : '';
    return {
      content: [{
        type: 'text',
        text:
          `Sent TEMPO_TAP.\n` +
          `Wrote ${bytes.length} bytes: ${toHex(bytes)}\n` +
          errorBlock +
          `\n${NO_ACK_NOTE}\n\n${BETA_NOTE}`,
      }],
    };
  });


  server.registerTool('axefx3_set_tempo', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Set the master tempo (BPM) on the Axe-Fx III. Front-panel range is roughly 30..250; the device clamps out-of-range values.',
      NO_ACK_NOTE,
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {
      bpm: z.number().int().min(1).max(16383).describe(
        'Tempo in BPM (typical range 30..250).',
      ),
    },
  }, async ({ bpm }) => {
    const bytes = buildSetTempo(bpm);
    const c = ensureConn();
    const errorReport = await sendAndWatchForError(c, bytes);
    const errorBlock = errorReport
      ? `\n${formatMultipurposeError(errorReport)}\n`
      : '';
    return {
      content: [{
        type: 'text',
        text:
          `Sent SET_TEMPO → ${bpm} BPM.\n` +
          `Wrote ${bytes.length} bytes: ${toHex(bytes)}\n` +
          errorBlock +
          `\n${NO_ACK_NOTE}\n\n${BETA_NOTE}`,
      }],
    };
  });


  server.registerTool('axefx3_get_tempo', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Read the current master tempo (BPM) from the Axe-Fx III.',
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {},
  }, async () => {
    const reqBytes = buildGetTempo();
    const c = ensureConn();
    const responsePromise = c.receiveSysExMatching(
      isSetGetTempoResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(reqBytes);
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `axefx3_get_tempo failed: ${msg}\n` +
        `Sent ${reqBytes.length} bytes: ${toHex(reqBytes)}`,
      );
    }
    const { bpm } = parseTempoResponse(response);
    return {
      content: [{
        type: 'text',
        text:
          `Tempo: ${bpm} BPM.\n` +
          `Sent (${reqBytes.length}B): ${toHex(reqBytes)}\n` +
          `Recv (${response.length}B): ${toHex(response)}\n` +
          `\n${BETA_NOTE}`,
      }],
    };
  });


  server.registerTool('axefx3_set_tuner', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Turn the Axe-Fx III tuner display on or off.',
      NO_ACK_NOTE,
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {
      on: z.boolean().describe('true → tuner display on, false → tuner off.'),
    },
  }, async ({ on }) => {
    const bytes = buildSetTuner(on);
    const c = ensureConn();
    const errorReport = await sendAndWatchForError(c, bytes);
    const errorBlock = errorReport
      ? `\n${formatMultipurposeError(errorReport)}\n`
      : '';
    return {
      content: [{
        type: 'text',
        text:
          `Sent TUNER_ON_OFF → ${on ? 'ON' : 'OFF'}.\n` +
          `Wrote ${bytes.length} bytes: ${toHex(bytes)}\n` +
          errorBlock +
          `\n${NO_ACK_NOTE}\n\n${BETA_NOTE}`,
      }],
    };
  });


  const LOOPER_ACTIONS = ['record', 'play', 'undo', 'once', 'reverse', 'half_speed'] as const;

  server.registerTool('axefx3_set_looper', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Trigger a Looper button-press on the Axe-Fx III. Same effect as pressing the corresponding button on the III\'s Looper page (record, play, undo, once, reverse, half_speed).',
      NO_ACK_NOTE,
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {
      action: z.enum(LOOPER_ACTIONS).describe(
        'Looper button: record, play, undo, once, reverse, half_speed.',
      ),
    },
  }, async ({ action }) => {
    const bytes = buildSetLooper(action as LooperAction);
    const c = ensureConn();
    const errorReport = await sendAndWatchForError(c, bytes);
    const errorBlock = errorReport
      ? `\n${formatMultipurposeError(errorReport)}\n`
      : '';
    return {
      content: [{
        type: 'text',
        text:
          `Sent SET_LOOPER → ${action}.\n` +
          `Wrote ${bytes.length} bytes: ${toHex(bytes)}\n` +
          errorBlock +
          `\n${NO_ACK_NOTE}\n\n${BETA_NOTE}`,
      }],
    };
  });


  server.registerTool('axefx3_get_looper_state', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Read the Axe-Fx III Looper state. Returns flags: recording, playing, overdubbing, once, reverse, half-speed.',
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {},
  }, async () => {
    const reqBytes = buildGetLooperState();
    const c = ensureConn();
    const responsePromise = c.receiveSysExMatching(
      isSetGetLooperResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(reqBytes);
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `axefx3_get_looper_state failed: ${msg}\n` +
        `Sent ${reqBytes.length} bytes: ${toHex(reqBytes)}`,
      );
    }
    const s = parseLooperStateResponse(response);
    const active = [
      s.recording  && 'recording',
      s.playing    && 'playing',
      s.overdubbing && 'overdubbing',
      s.once       && 'once',
      s.reverse    && 'reverse',
      s.halfSpeed  && 'half-speed',
    ].filter(Boolean).join(', ') || '(idle)';
    return {
      content: [{
        type: 'text',
        text:
          `Looper state: ${active}.\n` +
          `Raw bitfield: 0x${s.raw.toString(16).padStart(2, '0')}\n` +
          `Sent (${reqBytes.length}B): ${toHex(reqBytes)}\n` +
          `Recv (${response.length}B): ${toHex(response)}\n` +
          `\n${BETA_NOTE}`,
      }],
    };
  });

}
