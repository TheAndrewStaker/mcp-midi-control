// VE-500 parameter catalog lookup over the generated address map.

import { VE500_PARAMS, type Ve500ParamDef } from './catalog.generated.js';

const byKey = new Map<string, Ve500ParamDef>();
const byBlock = new Map<string, Ve500ParamDef[]>();

for (const p of VE500_PARAMS) {
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

export { VE500_PARAMS };
export type { Ve500ParamDef };
