// VE-500 parameter read/write wire builders.
//
// A per-patch parameter's wire address = patch base + the catalog's
// patch-relative addr. The active (temporary) patch is the default base;
// that's what live editing targets. Pass a user-patch base to read/write a
// stored memory directly.
//
// A SYSTEM (global) parameter (`def.region === 'system'`, address_map.js's
// System tree, base 0x02000000) has no per-instance base to add: its `addr`
// is already the FULL absolute internal address, so the base resolves to 0
// regardless of `opts.patchBase`.

import {
  buildDT1,
  buildRQ1,
  decodeWire,
  encodeWire,
  matchesDT1Addr,
  parseDT1,
  wireByteCount,
  type RolandTarget,
} from '../shared/index.js';
import { TEMP_PATCH_ADDR, VE500_TARGET } from './model.js';
import type { Ve500ParamDef } from './catalog.generated.js';

export interface WireOptions {
  /** Patch base address (default: active/temporary patch 0x04000000). Ignored
   *  for `region:'system'` params: `def.addr` is already the full absolute
   *  address (System has no per-instance base to re-base against). */
  readonly patchBase?: number;
  /** SysEx target (default: VE-500 model id + device id 0x10). */
  readonly target?: RolandTarget;
}

function resolve(
  def: Ve500ParamDef,
  opts?: WireOptions,
): { base: number; target: RolandTarget } {
  return {
    base: def.region === 'system' ? 0 : (opts?.patchBase ?? TEMP_PATCH_ADDR),
    target: opts?.target ?? VE500_TARGET,
  };
}

/** Build a DT1 to set `def` to the given wire-integer (or string for ASCII) value. */
export function buildSetParam(
  def: Ve500ParamDef,
  value: number | string,
  opts?: WireOptions,
): number[] {
  const { base, target } = resolve(def, opts);
  const data = encodeWire(def.size, value, def.ofs);
  return buildDT1(target, base + def.addr, data);
}

/** Build an RQ1 requesting the current value of `def`. */
export function buildGetParam(def: Ve500ParamDef, opts?: WireOptions): number[] {
  const { base, target } = resolve(def, opts);
  return buildRQ1(target, base + def.addr, wireByteCount(def.size));
}

/** Decode a DT1 reply's data payload back to the wire-integer (or string) value. */
export function decodeParam(
  def: Ve500ParamDef,
  data: readonly number[],
): number | string {
  return decodeWire(def.size, data, def.ofs);
}

/**
 * Decode a full inbound DT1 reply message (F0..F7) to `def`'s value.
 * Returns undefined if the message is not a DT1 for the target.
 */
export function decodeParamReply(
  def: Ve500ParamDef,
  msg: readonly number[],
  opts?: WireOptions,
): number | string | undefined {
  const target = opts?.target ?? VE500_TARGET;
  const parsed = parseDT1(target, msg);
  if (!parsed) return undefined;
  return decodeWire(def.size, parsed.data, def.ofs);
}

/** Predicate for `receiveSysExMatching`: does `msg` answer a read of `def`? */
export function paramReplyMatcher(
  def: Ve500ParamDef,
  opts?: WireOptions,
): (msg: readonly number[]) => boolean {
  const { base, target } = resolve(def, opts);
  const addr = base + def.addr;
  return (msg) => matchesDT1Addr(target, addr, msg);
}
