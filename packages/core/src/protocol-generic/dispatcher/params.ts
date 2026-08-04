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
import { assertInstanceSupported, openCtx, requireDevice, withHandleRetry } from './core.js';
import {
  encodeValue,
  resolveBlockName,
  resolveChannel,
  resolveParamName,
} from './resolvers.js';
import { collectTempoLockCowriteWarnings, collectTempoLockStandaloneWarnings, type TempoLockWrite } from './tempoLock.js';

/**
 * BK-075 phantom-param pre-flight. Returns a `validation_info[]` entry
 * when the descriptor exposes `getBlockLayoutSnapshot` and the target
 * block isn't placed in the active working buffer. Returns an empty
 * array otherwise (block placed, or device doesn't model placement).
 *
 * The write proceeds regardless — same display-first / user-agency
 * rationale as BK-071. Surface the trap, don't refuse.
 */
/**
 * A "pseudo-block" carries params (device/preset config like the AM4
 * `global` MIDI map or `preset` scene-MIDI slots) but is NOT a placeable
 * chain block — it never occupies a slot, so its param-register writes
 * always land and the "unplaced block" / "unrouted block" pre-flights are
 * false positives (BUG-7, 2026-07-04 AM4 hardware session). A block is a
 * pseudo-block when the descriptor exposes typed slots (`block_types`) and
 * this block isn't one of them. When `block_types` is absent we can't
 * tell, so we treat every block as real (the pre-flight runs as before).
 */
function isPseudoBlock(descriptor: DeviceDescriptor, canonicalBlock: string): boolean {
  if (descriptor.block_types === undefined) return false;
  // block_types keys are the bare block slug on AM4 ("amp") but INSTANCE-
  // suffixed on grid devices with multiple instances per type ("amp 1",
  // "reverb 2" on Axe-Fx II). canonicalBlock is always the bare slug
  // (resolveBlockName strips the instance), so strip any trailing " N" from
  // each block_types key before comparing — otherwise every real II block
  // reads as a pseudo-block and its unplaced/unrouted warnings are lost.
  const slug = canonicalBlock.trim().toLowerCase();
  for (const key of Object.keys(descriptor.block_types)) {
    if (key.trim().toLowerCase().replace(/\s+\d+$/, '') === slug) return false;
  }
  return true;
}

export async function collectPhantomParamWarnings(
  descriptor: DeviceDescriptor,
  ctx: DispatchCtx,
  canonicalBlock: string,
  canonicalName: string,
): Promise<ValidationInfo[]> {
  if (descriptor.reader.getBlockLayoutSnapshot === undefined) return [];
  if (isPseudoBlock(descriptor, canonicalBlock)) return [];
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
 * BK-076 routing-mask pre-flight. Returns a `validation_info[]` entry
 * when the descriptor exposes `getBlockLayoutSnapshot` with a populated
 * `unroutedBlocks` set AND the target block is in it (placed but no
 * cable feeds any of its cells past col 1). Returns an empty array
 * otherwise — block is routed, device doesn't model routing, or block
 * isn't placed (phantom-param handles that case).
 *
 * Soft-warn (level='warning'), not refusal: a user mid-build might
 * place a block before cabling it, knowing they'll wire it up next.
 * Refusing the param write robs them of that flow. Surface the trap
 * so the agent self-corrects (call set_cell_routing or apply_preset
 * with a routing[] array).
 *
 * Shares the cached snapshot with collectPhantomParamWarnings; both
 * collectors run off the same single grid read.
 */
export async function collectRoutingMaskWarnings(
  descriptor: DeviceDescriptor,
  ctx: DispatchCtx,
  canonicalBlock: string,
  canonicalName: string,
): Promise<ValidationInfo[]> {
  if (descriptor.reader.getBlockLayoutSnapshot === undefined) return [];
  if (isPseudoBlock(descriptor, canonicalBlock)) return [];
  let snapshot;
  try {
    snapshot = await getCachedBlockLayout(descriptor.id, ctx, () =>
      descriptor.reader.getBlockLayoutSnapshot!(ctx),
    );
  } catch {
    return [];
  }
  if (snapshot.unroutedBlocks === undefined) return [];
  if (!snapshot.unroutedBlocks.has(canonicalBlock)) return [];
  return [{
    path: `${canonicalBlock}.${canonicalName}`,
    info:
      `${canonicalBlock}.${canonicalName} write acked on the wire, but '${canonicalBlock}' ` +
      `is placed in a grid cell with no input cable on ${descriptor.display_name} ` +
      `(routing_mask=0 past col 1). Signal does not flow through the block, so the param ` +
      `has no audible effect until a previous-column cell is cabled into its input.`,
    level: 'warning',
    dropped_param: canonicalName,
    reason:
      `'${canonicalBlock}' is placed but its grid cell has routing_mask=0 ` +
      `on ${descriptor.display_name}. No previous-column cell feeds its input, ` +
      `so audio bypasses the block entirely; param-register writes have no audible effect.`,
    retry_action:
      `Use apply_preset with a routing[] array to place and cable '${canonicalBlock}' into a ` +
      `previous-column cell in one call, then retry the set_param.`,
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
  instance?: number;
}): Promise<WriteResult & { device: string; aliased_param_from?: string }> {
  const descriptor = requireDevice(args.port);
  assertInstanceSupported(descriptor, args.instance, `${args.block}.${args.name}`);
  const canonical_block = resolveBlockName(descriptor, args.block);
  const { name: canonical_name, aliased_from } = resolveParamName(descriptor, canonical_block, args.name);
  const channel = resolveChannel(descriptor, canonical_block, args.channel);
  const wire_value = encodeValue(descriptor, canonical_block, canonical_name, args.value);
  const instance = args.instance;
  // Captured in a local so TS narrows it through the withHandleRetry closure
  // below (property narrowing on `descriptor.writer.setParam` doesn't survive
  // a closure boundary — same pattern as `applyTypeKnobApplicabilityPreflight`).
  const setParam = descriptor.writer.setParam;
  if (setParam === undefined) {
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
  // BK-076 routing-mask pre-flight. Mutually exclusive with phantom-
  // param (a block in `unroutedBlocks` is by construction in
  // `placedBlocks` too) but both calls are safe: phantom returns empty
  // when the block is placed, routing returns empty when the block
  // isn't unrouted. Shares the cached snapshot — no extra wire read.
  const routingWarnings = await collectRoutingMaskWarnings(
    descriptor,
    ctx,
    canonical_block,
    canonical_name,
  );
  // Tempo-lock standalone advisory: a single set_param on a tempo-locked
  // timing param (delay.time / <mod>.rate) can't carry its own tempo, so
  // the co-write inspection can't see it. Read the block's current tempo;
  // if synced, the write lands in the register but is inaudible (BUG-2).
  // One extra read, only for timing params.
  const tempoLockWarnings = await collectTempoLockStandaloneWarnings(descriptor, ctx, [
    { block: canonical_block, name: canonical_name, value: wire_value, channel, instance },
  ]);
  // Phase A.5 (connection-arbiter.md): a HANDLE-level fault on this write (a
  // thrown send, e.g. a clean Windows USB replug where the acquire-time
  // canary's own signals all still read healthy) reconnects the endpoint by
  // connection_label and retries this SAME write once on the fresh handle.
  // A device-level rejection (no-ACK, a DispatchError) is NOT retried.
  const result = await withHandleRetry(ctx, (c) =>
    setParam(c, canonical_block, canonical_name, wire_value, channel, instance));
  const combinedWarnings = [...phantomWarnings, ...routingWarnings, ...tempoLockWarnings];
  const validation_info = combinedWarnings.length > 0 ? combinedWarnings : undefined;
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
  instance?: number;
  include_description?: boolean;
}): Promise<ReadResult & { device: string; aliased_param_from?: string; description?: string }> {
  const descriptor = requireDevice(args.port);
  assertInstanceSupported(descriptor, args.instance, `${args.block}.${args.name}`);
  const canonical_block = resolveBlockName(descriptor, args.block);
  const { name: canonical_name, aliased_from } = resolveParamName(descriptor, canonical_block, args.name);
  const channel = resolveChannel(descriptor, canonical_block, args.channel);
  const instance = args.instance;
  const ctx = openCtx(descriptor);
  // Phase A.5: same handle-fault reconnect-and-retry-once as executeSetParam,
  // on the read side (the exact "list_samples succeeded, next call threw"
  // hardware repro applies equally to a bare get_param after a replug).
  const result = await withHandleRetry(ctx, (c) =>
    descriptor.reader.getParam(c, canonical_block, canonical_name, channel, instance));
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
 * Full lifecycle for `set_params` — batch write. Validates EVERY entry
 * up-front before sending any MIDI, so a bad value at index 7 doesn't
 * leave indices 0..6 half-sent.
 */
export async function executeSetParams(args: {
  port: string;
  ops: readonly { block: string; name: string; value: number | string; channel?: string | number; instance?: number }[];
}): Promise<BatchWriteResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  const setParams = descriptor.writer.setParams;
  if (setParams === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `set_params is not implemented for ${descriptor.display_name}.`,
    );
  }
  const validated: WriteOp[] = [];
  // Resolved display-shaped writes, kept alongside the wire-encoded ops
  // so the tempo-lock co-write check can inspect the un-encoded values
  // (NONE detection needs the display label, not the wire integer).
  const displayWrites: TempoLockWrite[] = [];
  for (let i = 0; i < args.ops.length; i++) {
    const op = args.ops[i];
    try {
      assertInstanceSupported(descriptor, op.instance, `ops[${i}] (${op.block}.${op.name})`);
      const block = resolveBlockName(descriptor, op.block);
      const { name } = resolveParamName(descriptor, block, op.name);
      const channel = resolveChannel(descriptor, block, op.channel);
      const value = encodeValue(descriptor, block, name, op.value);
      validated.push({ block, name, value, channel, instance: op.instance });
      displayWrites.push({ block, name, value: op.value, channel, instance: op.instance });
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
  // BK-075/BK-076 phantom-param + routing-mask pre-flight, per batch entry.
  // executeSetParam has run these BEFORE its write since BK-075/BK-076
  // shipped; set_params never ran them at all until this fix, so a batch
  // write to an unplaced or uncabled block returned a clean ok:true with no
  // hint that the write landed on the wire but not on the audible signal
  // path. Collected here, before the write, to match executeSetParam's
  // ordering — these are genuinely pre-flight, not post-hoc. Both
  // collectors share one cached getBlockLayoutSnapshot read per device (5s
  // TTL), so looping over the batch costs no extra wire round-trips beyond
  // the first.
  const phantomWarnings: ValidationInfo[] = [];
  const routingWarnings: ValidationInfo[] = [];
  for (const op of validated) {
    phantomWarnings.push(...await collectPhantomParamWarnings(descriptor, ctx, op.block, op.name));
    routingWarnings.push(...await collectRoutingMaskWarnings(descriptor, ctx, op.block, op.name));
  }
  // Tempo-lock co-write advisory: if this batch set a tempo division AND
  // the absolute time/rate it locks, the absolute write is silently
  // ignored on the hardware. Pure inspection of the resolved writes —
  // no extra wire read. Additive `validation_info[]`; write proceeds.
  const tempoWarnings = collectTempoLockCowriteWarnings(descriptor, displayWrites);
  // Standalone case: timing params in the batch whose tempo isn't also in
  // the batch — read the live tempo and warn if synced (BUG-2). The
  // collector skips co-write cases internally, so the two don't double-warn.
  const tempoStandaloneWarnings = await collectTempoLockStandaloneWarnings(descriptor, ctx, displayWrites);
  // Phase A.5: reconnect-and-retry-once on a handle-level fault. `setParams`
  // is a batch of independent single-param writes (not a stateful multi-block
  // transfer session), so restarting the whole batch on a fresh handle is
  // safe — each write is idempotent (setting the same param to the same
  // value twice is a no-op the second time).
  const result = await withHandleRetry(ctx, (c) => setParams(c, validated));
  const allWarnings = [...phantomWarnings, ...routingWarnings, ...tempoWarnings, ...tempoStandaloneWarnings];
  return {
    ...result,
    ...(allWarnings.length > 0 ? { validation_info: allWarnings } : {}),
    device: descriptor.display_name,
  };
}

/**
 * Most queries one `get_params` call may carry.
 *
 * TWO INDEPENDENTLY MEASURED CONSTRAINTS LAND HERE, and the tighter one wins.
 *
 * 1. WIRE TIME. Every reader implements `getParams` as a per-query loop around
 *    `getParam` (checked across am4 / gen1 / gen2 / arturia / circuit-tracks /
 *    ve-500), so N queries is N SysEx round-trips at roughly 50 ms each.
 *    CLAUDE.md's performance budget puts "> 5 s of wire work in a single
 *    conversational turn" under "avoid altogether", which is ~100 reads. An
 *    uncapped batch was minutes of silence in a chat window with no progress
 *    channel to report it on.
 *
 * 2. RESPONSE SIZE. `scripts/verify-response-budget.ts` measured the whole AM4
 *    catalog (894 queries) at 149,443 chars and the Axe-Fx II's (1,126) at
 *    208,649, both far past the host's 50,000-char delivery cliff, i.e. the
 *    model received NOTHING back from a read the device had genuinely
 *    performed. That is ~167 chars per read on the AM4 and ~185 on the II, so
 *    a 40,000-char response holds roughly 215-240 of them.
 *
 * 100 satisfies both with about a 2x margin on size, and it is twenty times
 * the tool description's own worked example (gain + master + bass + mid +
 * treble).
 *
 * AND IT BREAKS NOTHING AN AGENT HAS EVER ACTUALLY DONE. Measured over the 707
 * archived agent-regression traces: 41 real `get_params` calls, the widest of
 * them **23 queries** (`cross-am4-get-preset-state-anchor`), none over 100. The
 * catalog-sized batches that blew past the cliff came from a size gate probing
 * the worst legal call, not from any observed agent behaviour, so this cap
 * costs no real workflow. Re-derive that figure before lowering it.
 *
 * WHY A REFUSAL RATHER THAN THE FIT-AND-PAGE USED ON `list_params`,
 * `lookup_lineage` AND `list_backups`. Those three read from tables already in
 * memory, so trimming a response costs nothing but the rows trimmed. A batch
 * READ has already spent the wire time by the time there is a response to
 * trim: fitting 894 reads into 240 rows would mean performing 654 SysEx
 * round-trips, roughly half a minute of the user's time, and discarding them.
 * Refusing BEFORE the first frame goes out costs nothing and tells the caller
 * something true. It is also the one shape here that cannot be made silent:
 * there is no partial answer to mistake for a whole one.
 */
export const GET_PARAMS_MAX_QUERIES = 100;

/**
 * Full lifecycle for `get_params` — batch read. Continues past individual
 * failures (a failed read for op[3] doesn't abort op[4..N]).
 */
export async function executeGetParams(args: {
  port: string;
  queries: readonly { block: string; name: string; channel?: string | number; instance?: number }[];
}): Promise<BatchReadResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  if (args.queries.length > GET_PARAMS_MAX_QUERIES) {
    throw new DispatchError(
      'value_out_of_range',
      descriptor.display_name,
      `get_params: ${args.queries.length} queries is more than the ${GET_PARAMS_MAX_QUERIES} one call can answer, so NOTHING was read and nothing was sent to the device. `
      + `Each query is its own round-trip (~50 ms), and a response this wide also exceeds what the host will deliver, so the answer would not reach you. `
      + `Split it into calls of ${GET_PARAMS_MAX_QUERIES} or fewer, or (usually better) ask for the knobs you actually need rather than a whole catalog: `
      // The census call, deliberately, and NOT a `block:["amp"]` template: this
      // message reaches every registered device and most of them have no amp
      // block, so a template naming one would hand the agent a call that
      // errors. Agents paste our literals verbatim (commit `4c9c94a`), and the
      // 2026-08-02 review found five model-facing templates that did not run.
      + `list_params({port:"${descriptor.id}"}) returns a per-block census with no device I/O, and get_preset returns the loaded blocks in one round-trip.`,
    );
  }
  const validated: ParamQuery[] = [];
  for (let i = 0; i < args.queries.length; i++) {
    const q = args.queries[i];
    try {
      assertInstanceSupported(descriptor, q.instance, `queries[${i}] (${q.block}.${q.name})`);
      const block = resolveBlockName(descriptor, q.block);
      const { name } = resolveParamName(descriptor, block, q.name);
      const channel = resolveChannel(descriptor, block, q.channel);
      validated.push({ block, name, channel, instance: q.instance });
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
  // Phase A.5: reconnect-and-retry-once on a handle-level fault. Same
  // rationale as executeSetParams — a batch of independent reads restarts
  // cleanly on a fresh handle.
  const result = await withHandleRetry(ctx, (c) => descriptor.reader.getParams(c, validated));
  return { ...result, device: descriptor.display_name };
}
