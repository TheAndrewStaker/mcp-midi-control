/**
 * Param executors — `set_param`, `get_param`, `set_params`, `get_params`
 * full-lifecycle dispatch.
 *
 * Each wrapper runs the 6-step lifecycle: requireDevice → resolveBlock →
 * resolveParam → resolveChannel → encodeValue → open connection →
 * delegate to descriptor.writer / descriptor.reader.
 */

import { getParamDescription } from '../param-descriptions.js';
import {
  DispatchError,
  type BatchReadResult,
  type BatchWriteResult,
  type DispatchCtx,
  type DeviceDescriptor,
  type ParamQuery,
  type ReadResult,
  type ValidationInfo,
  type WriteOp,
  type WriteResult,
} from '../types.js';

import { getCachedBlockLayout } from './blockLayoutCache.js';
import { openCtx, requireDevice } from './core.js';
import {
  encodeValue,
  resolveBlockName,
  resolveChannel,
  resolveParamName,
} from './resolvers.js';

/**
 * BK-075 phantom-param pre-flight. Returns a `validation_info[]` entry
 * when the descriptor exposes `getBlockLayoutSnapshot` and the target
 * block isn't placed in the active working buffer. Returns an empty
 * array otherwise (block placed, or device doesn't model placement).
 *
 * The write proceeds regardless — same display-first / user-agency
 * rationale as BK-071. Surface the trap, don't refuse.
 */
async function collectPhantomParamWarnings(
  descriptor: DeviceDescriptor,
  ctx: DispatchCtx,
  canonicalBlock: string,
  canonicalName: string,
): Promise<ValidationInfo[]> {
  if (descriptor.reader.getBlockLayoutSnapshot === undefined) return [];
  let snapshot;
  try {
    snapshot = await getCachedBlockLayout(descriptor.id, ctx, () =>
      descriptor.reader.getBlockLayoutSnapshot!(ctx),
    );
  } catch {
    // A failed layout read shouldn't block the write. The pre-flight is
    // advisory; if we can't read placement we proceed silently rather
    // than masking the user's intended write with a read error.
    return [];
  }
  if (snapshot.placedBlocks.has(canonicalBlock)) return [];
  return [{
    path: `${canonicalBlock}.${canonicalName}`,
    info:
      `${canonicalBlock}.${canonicalName} write acked on the wire, but no '${canonicalBlock}' ` +
      `block is placed in the active working buffer on ${descriptor.display_name}. ` +
      `The device's audible state will not change. ` +
      `Call set_block to place '${canonicalBlock}' first, then re-issue set_param.`,
    level: 'warning',
    dropped_param: canonicalName,
    reason:
      `No '${canonicalBlock}' block is placed in any slot/cell of the active working buffer on ` +
      `${descriptor.display_name}. Param-register writes for unplaced blocks ack on the wire ` +
      `but the param never reaches an active block, so the audible state stays put.`,
    retry_action:
      `Call set_block({port:"${descriptor.id}", block_type:"${canonicalBlock}", ...}) to place ` +
      `the block in a slot, OR use apply_preset with a structural spec that includes ` +
      `'${canonicalBlock}'. Then retry the set_param.`,
  }];
}

/**
 * Full lifecycle for `set_param`. Steps 1–4 are the same validation
 * pipeline used by the pure `encodeSetParam`; steps 5–6 open the MIDI
 * connection and delegate to `descriptor.writer.setParam`.
 */
export async function executeSetParam(args: {
  port: string;
  block: string;
  name: string;
  value: number | string;
  channel?: string | number;
}): Promise<WriteResult & { device: string; aliased_param_from?: string }> {
  const descriptor = requireDevice(args.port);
  const canonical_block = resolveBlockName(descriptor, args.block);
  const { name: canonical_name, aliased_from } = resolveParamName(descriptor, canonical_block, args.name);
  const channel = resolveChannel(descriptor, canonical_block, args.channel);
  const wire_value = encodeValue(descriptor, canonical_block, canonical_name, args.value);
  if (descriptor.writer.setParam === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `set_param is not yet implemented for ${descriptor.display_name}.`,
    );
  }
  const ctx = openCtx(descriptor);
  // BK-075 phantom-param pre-flight: consult the cached block-layout
  // snapshot to surface a `validation_info[]` warning when the target
  // block isn't placed in the active working buffer. The write still
  // proceeds (display-first / user-agency, same shape as BK-071).
  // Devices without a placement model (Hydra) get an empty array.
  const phantomWarnings = await collectPhantomParamWarnings(
    descriptor,
    ctx,
    canonical_block,
    canonical_name,
  );
  const result = await descriptor.writer.setParam(ctx, canonical_block, canonical_name, wire_value, channel);
  const validation_info = phantomWarnings.length > 0 ? phantomWarnings : undefined;
  return {
    ...result,
    ...(validation_info !== undefined ? { validation_info } : {}),
    device: descriptor.display_name,
    aliased_param_from: aliased_from,
  };
}

/**
 * Full lifecycle for `get_param`. Same shape as executeSetParam but
 * routes to descriptor.reader.getParam.
 *
 * When `include_description: true` is passed, the response carries an
 * extra `description` field with the verbatim Blocks Guide / Owner's
 * Manual excerpt for the param (when one is on file). Omitted when
 * the extractor didn't have a clean (block, param) join — never an
 * empty string — so the agent doesn't render "Description: " with
 * nothing after it.
 */
export async function executeGetParam(args: {
  port: string;
  block: string;
  name: string;
  channel?: string | number;
  include_description?: boolean;
}): Promise<ReadResult & { device: string; aliased_param_from?: string; description?: string }> {
  const descriptor = requireDevice(args.port);
  const canonical_block = resolveBlockName(descriptor, args.block);
  const { name: canonical_name, aliased_from } = resolveParamName(descriptor, canonical_block, args.name);
  const channel = resolveChannel(descriptor, canonical_block, args.channel);
  const ctx = openCtx(descriptor);
  const result = await descriptor.reader.getParam(ctx, canonical_block, canonical_name, channel);
  const description = args.include_description
    ? getParamDescription(args.port, canonical_block, canonical_name)
    : undefined;
  return {
    ...result,
    device: descriptor.display_name,
    aliased_param_from: aliased_from,
    description,
  };
}

/**
 * Full lifecycle for `nudge_param`. Same resolve pipeline as set_param
 * but no display→wire encode step — the device knows its own step
 * quantum per param so the wire envelope is payload-free. Devices
 * without a wire nudge primitive error with capability_not_supported.
 */
export async function executeNudgeParam(args: {
  port: string;
  block: string;
  name: string;
  direction: 'up' | 'down';
  granularity?: 'fine' | 'coarse';
  channel?: string | number;
}): Promise<WriteResult & { device: string; aliased_param_from?: string }> {
  const descriptor = requireDevice(args.port);
  if (descriptor.writer.nudgeParam === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `nudge_param is not implemented for ${descriptor.display_name}. Use set_param with an explicit value instead.`,
    );
  }
  const canonical_block = resolveBlockName(descriptor, args.block);
  const { name: canonical_name, aliased_from } = resolveParamName(descriptor, canonical_block, args.name);
  const channel = resolveChannel(descriptor, canonical_block, args.channel);
  const granularity = args.granularity ?? 'fine';
  const ctx = openCtx(descriptor);
  const result = await descriptor.writer.nudgeParam(
    ctx,
    canonical_block,
    canonical_name,
    args.direction,
    granularity,
    channel,
  );
  return {
    ...result,
    device: descriptor.display_name,
    aliased_param_from: aliased_from,
  };
}

/**
 * Full lifecycle for `set_params` — batch write. Validates EVERY entry
 * up-front before sending any MIDI, so a bad value at index 7 doesn't
 * leave indices 0..6 half-sent.
 */
export async function executeSetParams(args: {
  port: string;
  ops: readonly { block: string; name: string; value: number | string; channel?: string | number }[];
}): Promise<BatchWriteResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  if (descriptor.writer.setParams === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `set_params is not implemented for ${descriptor.display_name}.`,
    );
  }
  const validated: WriteOp[] = [];
  for (let i = 0; i < args.ops.length; i++) {
    const op = args.ops[i];
    try {
      const block = resolveBlockName(descriptor, op.block);
      const { name } = resolveParamName(descriptor, block, op.name);
      const channel = resolveChannel(descriptor, block, op.channel);
      const value = encodeValue(descriptor, block, name, op.value);
      validated.push({ block, name, value, channel });
    } catch (err) {
      if (err instanceof DispatchError) {
        throw new DispatchError(
          err.code,
          err.device,
          `ops[${i}] (${op.block}.${op.name}): ${err.message}`,
          err.details,
        );
      }
      throw err;
    }
  }
  const ctx = openCtx(descriptor);
  const result = await descriptor.writer.setParams(ctx, validated);
  return { ...result, device: descriptor.display_name };
}

/**
 * Full lifecycle for `get_params` — batch read. Continues past individual
 * failures (a failed read for op[3] doesn't abort op[4..N]).
 */
export async function executeGetParams(args: {
  port: string;
  queries: readonly { block: string; name: string; channel?: string | number }[];
}): Promise<BatchReadResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  const validated: ParamQuery[] = [];
  for (let i = 0; i < args.queries.length; i++) {
    const q = args.queries[i];
    try {
      const block = resolveBlockName(descriptor, q.block);
      const { name } = resolveParamName(descriptor, block, q.name);
      const channel = resolveChannel(descriptor, block, q.channel);
      validated.push({ block, name, channel });
    } catch (err) {
      if (err instanceof DispatchError) {
        throw new DispatchError(
          err.code,
          err.device,
          `queries[${i}] (${q.block}.${q.name}): ${err.message}`,
          err.details,
        );
      }
      throw err;
    }
  }
  const ctx = openCtx(descriptor);
  const result = await descriptor.reader.getParams(ctx, validated);
  return { ...result, device: descriptor.display_name };
}
