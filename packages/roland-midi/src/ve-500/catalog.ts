// VE-500 parameter catalog lookup over the generated address map.
//
// Two catalogs: `VE500_PARAMS` (per-patch, Temporary region) and
// `VE500_SYSTEM_PARAMS` (global, System region: block ids prefixed
// `system_`, e.g. 'system_input', so they never collide with a per-patch
// block of the same underlying struct, e.g. 'system_enhancer' vs
// 'enhancer'). Kept as SEPARATE exported arrays (not merged into
// VE500_PARAMS) so existing catalog-wide counts/goldens are unaffected, but
// merged into ONE lookup map here so findParam/blockParams/allBlocks (and
// therefore set_param/get_param/list_params) see both regions uniformly;
// the wire builders in setParam.ts already dispatch on `def.region`.

import {
  VE500_PARAMS,
  VE500_SYSTEM_PARAMS,
  type Ve500ParamDef,
} from './catalog.generated.js';

const ALL_PARAMS: readonly Ve500ParamDef[] = [
  ...VE500_PARAMS,
  ...VE500_SYSTEM_PARAMS,
];

const byKey = new Map<string, Ve500ParamDef>();
const byBlock = new Map<string, Ve500ParamDef[]>();

for (const p of ALL_PARAMS) {
  byKey.set(`${p.block}.${p.param}`, p);
  let list = byBlock.get(p.block);
  if (!list) {
    list = [];
    byBlock.set(p.block, list);
  }
  list.push(p);
}

/** Look up a parameter definition by block + param id. */
export function findParam(
  block: string,
  param: string,
): Ve500ParamDef | undefined {
  return byKey.get(`${block}.${param}`);
}

/** All parameter definitions in a block (empty if unknown block). */
export function blockParams(block: string): readonly Ve500ParamDef[] {
  return byBlock.get(block) ?? [];
}

/** All block ids, in catalog order. */
export function allBlocks(): string[] {
  return [...byBlock.keys()];
}

export { VE500_PARAMS, VE500_SYSTEM_PARAMS };
export type { Ve500ParamDef };
