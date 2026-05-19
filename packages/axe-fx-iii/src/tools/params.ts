/**
 * Axe-Fx III SET / GET PARAMETER tools (function 0x01).
 *
 * 🟢 SET wire shape byte-verified against 10 public captures spanning
 * two effect blocks (Drive 1/2, Delay 1) and two sub-action codes
 * (`09 00` typed-input + `52 00` mouse-drag). See
 * `docs/devices/axe-fx-iii/set-parameter-captures.md` for the captured frames and
 * `../setParam.ts` on `FN_PARAMETER_SETGET` for the evidence chain.
 *
 * 🟡 GET wire shape is hypothesis-only — no public captures of a
 * device-emitted SET response (only outbound SET frames). The III's
 * actual state-feedback channel appears to be the unsolicited `04 01`
 * STATE_BROADCAST sub-action; callers should treat a GET timeout as
 * "device doesn't honor sync GET on this firmware," not a tool error.
 *
 * Tools registered:
 *   - axefx3_set_parameter(block, param_id, value) — write a raw 16-bit
 *     wire value into one paramId on one block instance.
 *   - axefx3_get_parameter(block, param_id) — query the same (hypothesis).
 *
 * Why "raw wire value" not "display value": the III has no public
 * per-param display calibration (the v1.4 PDF documents zero
 * parameter-level metadata). Until per-paramId display ranges land,
 * callers compute display↔wire themselves. The Ghidra catalog at
 * `samples/captured/decoded/ghidra-axeedit3-paramnames.json` lists
 * every paramId by symbolic name (e.g. paramId 0 of REVERB =
 * `REVERB_TYPE`); use that to figure out which paramId to target.
 *
 * Session 97 (2026-05-18): pivoted from the Session 84-era II→III
 * fn=0x02 port to the byte-verified fn=0x01 envelope. The pre-pivot
 * envelope was a reasonable hypothesis but contradicted every captured
 * III parameter-write on the open web.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { resolveEffectId } from 'fractal-midi/axe-fx-iii';
import {
  buildSetParameter,
  buildGetParameter,
  isSetGetParameterResponse,
  parseSetGetParameterResponse,
} from 'fractal-midi/axe-fx-iii';

import {
  AXEFX3_DIRTY_LABEL,
  BETA_NOTE,
  GET_RESPONSE_TIMEOUT_MS,
  NO_ACK_NOTE,
  ensureConn,
  formatMultipurposeError,
  sendAndWatchForError,
  toHex,
} from './shared.js';
import { markDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';

const BLOCK_INPUT_DESCRIPTION = [
  'Block reference. Accepts:',
  '  - "Reverb 1", "Drive 2", "Compressor 4" — name + instance number',
  '  - "Reverb" (no instance defaults to instance 1)',
  '  - "REV", "DRV", "CMP" — 3-letter group code',
  '',
  "AMP / Dynamic Distortion / NAM / Global Block / Shunt aren't",
  "addressable from the v1.4 spec (no effect ID) — these will refuse.",
  'Call axefx3_list_blocks for the full catalog.',
].join('\n');

const SET_VERIFIED_BANNER = [
  '0x01 PARAMETER_SETGET is NOT in the v1.4 spec — Fractal deliberately',
  'omits parameter writes from the third-party MIDI document. Wire shape',
  'is byte-verified against 10 public AxeEdit III captures spanning two',
  'effect blocks (Drive 1/2 boost, Delay 1 TIME) and two sub-actions',
  '(typed-input + mouse-drag). See docs/devices/axe-fx-iii/set-parameter-captures.md',
  'for the captured frames. If the device rejects the write you\'ll see',
  'a 0x64 MULTIPURPOSE_RESPONSE in the reply.',
].join('\n');

const GET_HYPOTHESIS_BANNER = [
  '⚠ GET is hypothesis-only — no captured III device-emitted SET response',
  'exists on the open web. The wire shape mirrors SET with the value field',
  'zeroed. Session 97 research (Fractal Forum thread #203336) revealed',
  'the III\'s `04 01` STATE_BROADCAST traffic is an AxeEdit-driven heartbeat',
  'poll, NOT a device-initiated push-on-edit. A bare III with no editor',
  'running will likely produce NO inbound `04 01` frames at all — so a',
  '250 ms timeout from this tool is the EXPECTED outcome on bare hardware,',
  'not a tool error. Fallback strategies: (1) hold the SET value',
  'optimistically and skip read-back; (2) use 0x13 STATUS_DUMP for the',
  'bypass+channel state surface that v1.4 actually documents; (3) if a',
  'user is running AxeEdit III alongside, listen for the heartbeat-poll',
  'broadcasts on idle.',
].join('\n');

export function registerAxeFxIIIParamTools(server: McpServer): void {

  server.registerTool('axefx3_set_parameter', {
    description: [
      'Set the wire-level value of one parameter on one block on the',
      'Axe-Fx III. Targets the ACTIVE scene only.',
      '',
      SET_VERIFIED_BANNER,
      '',
      'Wire: PARAMETER_SETGET (function 0x01, sub-action 09 00 typed-input).',
      'Envelope (23 bytes):',
      '  09 00     = sub-action: typed-input SET (clean, drag-context zero)',
      '  id id     = 14-bit effect ID per v1.4 Appendix 1 (LS-first)',
      '  pid pid   = 14-bit paramId (LS-first) — see Ghidra catalog at',
      '              samples/captured/decoded/ghidra-axeedit3-paramnames.json',
      '              for the paramId→symbolic-name table per effect family.',
      '  00 00 00  = drag-context bytes (zero for typed input)',
      '  v0 v1 v2  = 16-bit value (0..65534) packed into 3 septets:',
      '              v0 = bits 6..0, v1 = bits 13..7, v2 = bits 15..14',
      '              (All observed III params use 14-bit values; v2 zero.)',
      '  00 00 00  = reserved zeros',
      '',
      'Value range: raw wire 0..65534 (16-bit). Caller computes',
      'display↔wire — the III publishes no per-param display calibration.',
      '',
      NO_ACK_NOTE,
      '',
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {
      block: z.string().describe(BLOCK_INPUT_DESCRIPTION),
      param_id: z.number().int().min(0).max(0x3fff).describe(
        'Parameter ID within the block (0..16383). See the Ghidra catalog ' +
        'for the paramId→symbolic-name table.',
      ),
      value: z.number().int().min(0).max(65534).describe(
        'Raw 16-bit wire value (0..65534). Display→wire conversion is the ' +
        "caller's responsibility — III has no published display calibration.",
      ),
    },
  }, async ({ block, param_id, value }) => {
    const effectId = resolveEffectId(block);
    const bytes = buildSetParameter(effectId, param_id, value);
    const c = ensureConn();
    const errorReport = await sendAndWatchForError(c, bytes);
    // Call-site SET/GET discrimination — see EDIT_FUNCTIONS_III comment
    // in midi.ts. fn=0x01 is dual-purpose with no byte-level discriminator,
    // so SET handlers mark dirty explicitly; GET handlers don't.
    markDirty(AXEFX3_DIRTY_LABEL);
    const errorBlock = errorReport
      ? `\n${formatMultipurposeError(errorReport)}\n`
      : '';
    return {
      content: [{
        type: 'text',
        text:
          `Sent SET_PARAMETER → ${block} (effect ID ${effectId}), ` +
          `paramId ${param_id}, value ${value} (raw wire 0..65534).\n` +
          `Wrote ${bytes.length} bytes: ${toHex(bytes)}\n` +
          errorBlock +
          `\n${NO_ACK_NOTE}\n\n${BETA_NOTE}`,
      }],
    };
  });

  server.registerTool('axefx3_get_parameter', {
    description: [
      'Query the wire-level value of one parameter on one block on the',
      'Axe-Fx III. Targets the ACTIVE scene only.',
      '',
      GET_HYPOTHESIS_BANNER,
      '',
      'Wire: PARAMETER_SETGET (function 0x01, sub-action 09 00, value=0).',
      'Same 23-byte envelope as SET with the value field zeroed.',
      '',
      'Response (hypothesis, unverified): either a fn=0x01 frame echoing',
      'effectId + paramId + the actual 16-bit wire value, OR the III emits',
      'an unsolicited STATE_BROADCAST (sub-action 04 01) with the current',
      'value when a parameter changes. parseSetGetParameterResponse handles',
      'both shapes; on STATE_BROADCAST the paramId field is zero (caller',
      'tracks last-SET to attribute the broadcast).',
      '',
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {
      block: z.string().describe(BLOCK_INPUT_DESCRIPTION),
      param_id: z.number().int().min(0).max(0x3fff).describe(
        'Parameter ID within the block (0..16383).',
      ),
    },
  }, async ({ block, param_id }) => {
    const effectId = resolveEffectId(block);
    const reqBytes = buildGetParameter(effectId, param_id);
    const c = ensureConn();
    const responsePromise = c.receiveSysExMatching(
      isSetGetParameterResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(reqBytes);
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `axefx3_get_parameter(${block}, paramId=${param_id}) failed: ${msg}\n` +
        `Sent ${reqBytes.length} bytes: ${toHex(reqBytes)}\n` +
        `\nLikely cause: device doesn't honor 0x02 SET_PARAMETER on this firmware. ` +
        `If a 0x64 frame arrived but didn't match the predicate, run axefx3_probe_sysex with the same payload to see the raw bytes.`,
      );
    }
    const parsed = parseSetGetParameterResponse(response);
    return {
      content: [{
        type: 'text',
        text:
          `${block} (effect ID ${parsed.effectId}) paramId ${parsed.paramId} ` +
          `= ${parsed.value} (raw wire 0..65534).\n` +
          `Sent (${reqBytes.length}B): ${toHex(reqBytes)}\n` +
          `Recv (${response.length}B): ${toHex(response)}\n` +
          `\n${BETA_NOTE}`,
      }],
    };
  });
}
