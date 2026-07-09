/**
 * Boss VE-500 DeviceReader.
 *
 * Parameter READ over Roland RQ1 → DT1: request the active-patch address, the
 * device replies with a DT1 carrying the current value. Decoded from the VE-500
 * Editor's own read path and HARDWARE-CONFIRMED (2026-06-28): the device's DT1
 * reply is byte-identical to the encoder. On no reply within the window the
 * reader fails with `no_ack` and points the user at the front panel.
 *
 * get_preset / whole-patch dump / save are out of scope for this first cut.
 */

import type {
  BatchReadResult,
  DeviceReader,
  DispatchCtx,
  ParamQuery,
  ReadResult,
  Unit,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  buildGetParam,
  decodeParamReply,
  findParam,
  paramReplyMatcher,
  type Ve500ParamDef,
} from 'roland-midi/ve-500';

const LABEL = 'Boss VE-500';
const READ_RESPONSE_TIMEOUT_MS = 300;

function resolve(block: string, name: string): Ve500ParamDef {
  const def = findParam(block, name);
  if (!def) {
    throw new DispatchError(
      'unknown_param',
      LABEL,
      `Unknown parameter '${block}.${name}' on ${LABEL}.`,
      {
        retry_action: `Call list_params({port, block:["${block}"]}) for the canonical names.`,
      },
    );
  }
  return def;
}

async function readOne(
  ctx: DispatchCtx,
  block: string,
  name: string,
): Promise<ReadResult> {
  const def = resolve(block, name);
  const req = buildGetParam(def);
  // Subscribe before sending so the reply cannot outrace the listener.
  const respPromise = ctx.conn.receiveSysExMatching(
    paramReplyMatcher(def),
    READ_RESPONSE_TIMEOUT_MS,
  );
  ctx.conn.send(req);

  let resp: number[];
  try {
    resp = await respPromise;
  } catch {
    throw new DispatchError(
      'no_ack',
      LABEL,
      `No DT1 reply from ${LABEL} for '${block}.${name}' within ${READ_RESPONSE_TIMEOUT_MS}ms. ` +
        `Check the USB connection and the VE-500's MIDI mode, or read the value off the front panel.`,
      {
        retry_action:
          'Check the USB-MIDI connection and try again, or read the value off the device display.',
      },
    );
  }

  const decoded = decodeParamReply(def, resp);
  if (typeof decoded !== 'number') {
    // Never fabricate a reading (a coerced 0 would render as a plausible 'OFF').
    throw new DispatchError(
      'no_ack',
      LABEL,
      `Malformed DT1 reply from ${LABEL} for '${block}.${name}' (could not decode the value). Confirm on the front panel.`,
      { retry_action: 'Read the value off the front panel.' },
    );
  }
  const wire = decoded;
  const ps = ctx.descriptor.blocks[block]?.params[name];
  const unit: Unit = ps?.unit ?? 'opaque';
  const display_value = ps?.decode ? ps.decode(wire) : wire;

  return {
    block,
    name,
    wire_value: wire,
    display_value,
    unit,
    raw_response: resp,
  };
}

export const reader: DeviceReader = {
  async getParam(ctx, block, name): Promise<ReadResult> {
    return readOne(ctx, block, name);
  },

  async getParams(
    ctx: DispatchCtx,
    queries: readonly ParamQuery[],
  ): Promise<BatchReadResult> {
    const reads: ReadResult[] = [];
    const failed_indices: number[] = [];
    const errors: Record<number, string> = {};
    for (let i = 0; i < queries.length; i++) {
      try {
        reads.push(await readOne(ctx, queries[i].block, queries[i].name));
      } catch (err) {
        failed_indices.push(i);
        errors[i] = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      reads,
      failed_indices,
      ...(failed_indices.length ? { errors } : {}),
    };
  },
};
