/**
 * Layout executors — `set_block` and `set_bypass` full-lifecycle dispatch.
 *
 * `set_block` places (or clears) a block at a slot in the signal chain;
 * `set_bypass` toggles silence on a placed block on the active scene.
 */

import {
  DispatchError,
  type BlockChange,
  type WriteResult,
} from '../types.js';

import { invalidateBlockLayoutCache } from './blockLayoutCache.js';
import { assertInstanceSupported, openCtx, requireDevice, withHandleRetry } from './core.js';
import { resolveBlockName } from './resolvers.js';

/**
 * Full lifecycle for `set_block(port, slot, { block_type?, bypassed?,
 * channel? })`. v0.1.0 chunk 3 scope: block_type only (placement).
 * Bypass-via-slot requires reading the slot's current block first; for
 * now the dispatcher errors with a hint to use `set_bypass(port, block,
 * bypassed)` instead.
 */
export async function executeSetBlock(args: {
  port: string;
  slot: number | { row: number; col: number };
  change: BlockChange;
}): Promise<WriteResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  const setBlock = descriptor.writer.setBlock;
  if (setBlock === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `set_block is not implemented for ${descriptor.display_name}.`,
    );
  }
  assertInstanceSupported(
    descriptor,
    args.change.instance,
    args.change.block_type ? `set_block ${args.change.block_type}` : 'set_block',
  );
  const ctx = openCtx(descriptor);
  // Phase A.5 (connection-arbiter.md): reconnect-and-retry-once on a
  // handle-level fault (see dispatcher/core.ts withHandleRetry).
  const result = await withHandleRetry(ctx, (c) => setBlock(c, args.slot, args.change));
  // BK-075: block placement just changed; invalidate the cached layout
  // snapshot so the next set_param pre-flight re-reads.
  invalidateBlockLayoutCache(descriptor.id);
  return { ...result, device: descriptor.display_name };
}

/**
 * Full lifecycle for `set_bypass(port, block, bypassed)`. Capability
 * check: device must expose block-bypass writes (currently all
 * registered devices do, but the hook lives for future devices).
 */
export async function executeSetBypass(args: {
  port: string;
  block: string;
  bypassed: boolean;
  instance?: number;
}): Promise<WriteResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  const setBypass = descriptor.writer.setBypass;
  if (setBypass === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `set_bypass is not implemented for ${descriptor.display_name}.`,
    );
  }
  assertInstanceSupported(descriptor, args.instance, `set_bypass ${args.block}`);
  const canonical_block = resolveBlockName(descriptor, args.block);
  const ctx = openCtx(descriptor);
  // Phase A.5: reconnect-and-retry-once on a handle-level fault.
  const result = await withHandleRetry(ctx, (c) => setBypass(c, canonical_block, args.bypassed, args.instance));
  return { ...result, device: descriptor.display_name };
}

