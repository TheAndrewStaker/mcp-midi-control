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

import { openCtx, requireDevice } from './core.js';
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
  if (descriptor.writer.setBlock === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `set_block is not implemented for ${descriptor.display_name}.`,
    );
  }
  const ctx = openCtx(descriptor);
  const result = await descriptor.writer.setBlock(ctx, args.slot, args.change);
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
}): Promise<WriteResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  if (descriptor.writer.setBypass === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `set_bypass is not implemented for ${descriptor.display_name}.`,
    );
  }
  const canonical_block = resolveBlockName(descriptor, args.block);
  const ctx = openCtx(descriptor);
  const result = await descriptor.writer.setBypass(ctx, canonical_block, args.bypassed);
  return { ...result, device: descriptor.display_name };
}

/**
 * Full lifecycle for `toggle_bypass(port, block)`. Atomic bypass flip
 * via the device's native toggle opcode (AM4: MESSAGE_TOGGLE 0x07).
 * One wire round-trip; agents no longer need a read+write pair.
 */
export async function executeToggleBypass(args: {
  port: string;
  block: string;
}): Promise<WriteResult & { device: string }> {
  const descriptor = requireDevice(args.port);
  if (descriptor.writer.toggleBypass === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `toggle_bypass is not implemented for ${descriptor.display_name}. Use set_bypass(port, block, bypassed) instead.`,
    );
  }
  const canonical_block = resolveBlockName(descriptor, args.block);
  const ctx = openCtx(descriptor);
  const result = await descriptor.writer.toggleBypass(ctx, canonical_block);
  return { ...result, device: descriptor.display_name };
}
