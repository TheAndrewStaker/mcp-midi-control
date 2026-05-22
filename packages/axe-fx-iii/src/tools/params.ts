/**
 * Axe-Fx III SET / GET PARAMETER tools (function 0x01).
 *
 * 🟢 SET wire shape byte-verified against 10 public captures spanning
 * two effect blocks (Drive 1/2, Delay 1) and two sub-action codes
 * (`09 00` typed-input + `52 00` mouse-drag). See
 * `docs/devices/axe-fx-iii/set-parameter-captures.md` for the captured frames and
 * `../setParam.ts` on `FN_PARAMETER_SETGET` for the evidence chain.
 *
 * 🟡 GET wire shape is hypothesis-only,no public captures of a
 * device-emitted SET response (only outbound SET frames). The III's
 * actual state-feedback channel appears to be the unsolicited `04 01`
 * STATE_BROADCAST sub-action; callers should treat a GET timeout as
 * "device doesn't honor sync GET on this firmware," not a tool error.
 *
 * Tools registered:
 *   - axefx3_set_parameter(block, param_id, value),write a raw 16-bit
 *     wire value into one paramId on one block instance.
 *   - axefx3_get_parameter(block, param_id),query the same (hypothesis).
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

import {
  buildSetParameter,
  buildGetParameter,
  isSetGetParameterResponse,
  parseSetGetParameterResponse,
} from 'fractal-midi/axe-fx-iii';

import {
  AXEFX3_DIRTY_LABEL,
  BETA_NOTE,
  BETA_PREFIX,
  GET_RESPONSE_TIMEOUT_MS,
  NO_ACK_NOTE,
  ensureConn,
  formatMultipurposeError,
  resolveBlockOrThrow,
  sendAndWatchForError,
  toHex,
} from './shared.js';
import { markDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';
import { asError } from '@mcp-midi-control/core/protocol-generic/tools/shared.js';

const BLOCK_INPUT_DESCRIPTION = [
  'Block reference. Accepts:',
  '  - "Reverb 1", "Drive 2", "Compressor 4",name + instance number',
  '  - "Reverb" (no instance defaults to instance 1)',
  '  - "REV", "DRV", "CMP",3-letter group code',
  '',
  "AMP / Dynamic Distortion / NAM / Global Block / Shunt aren't",
  "addressable from the v1.4 spec (no effect ID),these will refuse.",
  'Call axefx3_list_blocks for the full catalog.',
].join('\n');

const SET_VERIFIED_BANNER = [
  'Parameter SET is not in the published Fractal third-party MIDI spec. The wire shape used here is byte-verified against public AxeEdit III captures (typed-input + mouse-drag sub-actions across two effect blocks). If the device rejects the write, the reply carries an error code; surface it verbatim.',
].join('\n');

const GET_HYPOTHESIS_BANNER = [
  'GET is hypothesis-only. A bare Axe-Fx III with no editor running will likely produce NO inbound response, so a 250 ms timeout is the EXPECTED outcome on bare hardware, not a tool error. Fallbacks: (1) hold the SET value optimistically, (2) use axefx3_status_dump for bypass+channel state, (3) if AxeEdit III is running, listen for heartbeat-poll broadcasts.',
].join('\n');

export function registerAxeFxIIIParamTools(server: McpServer): void {

  server.registerTool('axefx3_set_parameter', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Write a raw 16-bit wire value to one paramId on one block on the Axe-Fx III. Targets the active scene only.',
      'EXCEPTION TO DISPLAY-FIRST CONTRACT: the Axe-Fx III ships without a published display calibration, so this tool exposes raw wire 0..65534 directly. AM4 and Axe-Fx II tools accept display units (knob 0..10, dB, %); do NOT generalise this raw-wire convention to those devices. When the III gets its calibration, this tool will switch to display units behind the same name.',
      SET_VERIFIED_BANNER,
      '- value: raw 0..65534. The III publishes no per-param display calibration, so display<->wire is the caller\'s responsibility.',
      '- param_id: see the param-name catalog shipped with the package for paramId -> symbolic-name tables per effect family.',
      NO_ACK_NOTE,
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {
      block: z.string().describe(BLOCK_INPUT_DESCRIPTION),
      param_id: z.number().int().min(0).max(0x3fff).describe(
        'Parameter ID within the block (0..16383). See the param-name catalog ' +
        'shipped with the package for the paramId→symbolic-name table.',
      ),
      value: z.number().int().min(0).max(65534).describe(
        'Raw 16-bit wire value (0..65534). Display→wire conversion is the ' +
        "caller's responsibility,III has no published display calibration.",
      ),
    },
    outputSchema: {
      block: z.string(),
      effect_id: z.number().int(),
      param_id: z.number().int(),
      value: z.number().int(),
      rejected: z.boolean(),
      error_result_code: z.number().int().optional(),
    },
  }, async ({ block, param_id, value }) => {
    let effectId: number;
    try {
      effectId = resolveBlockOrThrow(block);
    } catch (err) {
      return asError(err);
    }
    const bytes = buildSetParameter(effectId, param_id, value);
    const c = ensureConn();
    const errorReport = await sendAndWatchForError(c, bytes);
    // Call-site SET/GET discrimination, see EDIT_FUNCTIONS_III comment
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
      structuredContent: {
        block,
        effect_id: effectId,
        param_id,
        value,
        rejected: errorReport !== undefined,
        ...(errorReport ? { error_result_code: errorReport.resultCode } : {}),
      },
    };
  });

  server.registerTool('axefx3_get_parameter', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Query the wire-level value of one paramId on one block on the Axe-Fx III. Targets the active scene only.',
      GET_HYPOTHESIS_BANNER,
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {
      block: z.string().describe(BLOCK_INPUT_DESCRIPTION),
      param_id: z.number().int().min(0).max(0x3fff).describe(
        'Parameter ID within the block (0..16383).',
      ),
    },
    outputSchema: {
      block: z.string(),
      effect_id: z.number().int(),
      param_id: z.number().int(),
      value: z.number().int(),
    },
  }, async ({ block, param_id }) => {
    let effectId: number;
    try {
      effectId = resolveBlockOrThrow(block);
    } catch (err) {
      return asError(err);
    }
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
      return asError(new Error(
        `axefx3_get_parameter(${block}, paramId=${param_id}) failed: ${msg}\n` +
        `Sent ${reqBytes.length} bytes: ${toHex(reqBytes)}\n` +
        `\nLikely cause: device doesn't honor 0x02 SET_PARAMETER on this firmware. ` +
        `If a 0x64 frame arrived but didn't match the predicate, run axefx3_probe_sysex with the same payload to see the raw bytes.`,
      ));
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
      structuredContent: {
        block,
        effect_id: parsed.effectId,
        param_id: parsed.paramId,
        value: parsed.value,
      },
    };
  });
}
