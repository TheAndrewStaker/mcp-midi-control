/**
 * Layout executors — `set_block` and `set_bypass` full-lifecycle dispatch.
 *
 * `set_block` places (or clears) a block at a slot in the signal chain;
 * `set_bypass` toggles silence on a placed block on the active scene.
 */

import {
  DispatchError,
  type BlockChange,
  type DeviceDescriptor,
  type WriteResult,
} from '../types.js';

import { invalidateBlockLayoutCache } from './blockLayoutCache.js';
import { assertInstanceSupported, requireDevice, withEndpoint, withHandleRetry } from './core.js';
import { resolveBlockName } from './resolvers.js';

/**
 * The block name `set_block` hands its writer. A short or typed name the
 * other block tools accept (vol_pan, "Tone Match") resolves to the catalog
 * block, as it does on set_param / set_bypass. A name that is no catalog
 * block ("none", "shunt", a writer-only placement name) passes through
 * unchanged, so the writer keeps its own handling and refusal text.
 */
export function resolveSetBlockType(descriptor: DeviceDescriptor, blockType: string): string {
  try {
    return resolveBlockName(descriptor, blockType);
  } catch (err) {
    if (err instanceof DispatchError && err.code === 'unknown_block') return blockType;
    throw err;
  }
}

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
  const change: BlockChange = args.change.block_type === undefined
    ? args.change
    : { ...args.change, block_type: resolveSetBlockType(descriptor, args.change.block_type) };
  // Phase B: exclusive per-endpoint visit (see dispatcher/core.ts withEndpoint).
  const result = await withEndpoint(descriptor, (ctx) =>
    // Phase A.5 (connection-arbiter.md): reconnect-and-retry-once on a
    // handle-level fault (see dispatcher/core.ts withHandleRetry).
    withHandleRetry(ctx, (c) => setBlock(c, args.slot, change)),
  { opName: 'set_block' });
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
  // Phase B: exclusive per-endpoint visit.
  const result = await withEndpoint(descriptor, (ctx) =>
    // Phase A.5: reconnect-and-retry-once on a handle-level fault.
    withHandleRetry(ctx, (c) => setBypass(c, canonical_block, args.bypassed, args.instance)),
  { opName: 'set_bypass' });
  return { ...result, device: descriptor.display_name };
}

