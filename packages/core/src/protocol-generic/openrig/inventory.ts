/**
 * OpenRig INVENTORY loader (§11): load the gear the user OWNS from an
 * `MCP_RIG_INVENTORY` rig-inventory JSON, independent of the rig manifest (a rig
 * is a wiring of a SUBSET of what you own). Mirrors the rig-manifest loader:
 * env-var-driven only, cached per path + file stamp (a hand edit reloads, same as
 * the manifest), `status`-shaped so a bad file degrades gracefully instead of
 * crashing `describe_rig`.
 */
import * as fs from 'node:fs';
import type { Inventory } from 'openrig';

import { sameStamp, stampFile, type FileStamp } from './fileStamp.js';

export const RIG_INVENTORY_ENV = 'MCP_RIG_INVENTORY';

export type LoadedInventory =
  | { status: 'loaded'; inventory: Inventory; source: string }
  | { status: 'error'; error: string; source: string }
  | { status: 'unconfigured' };

let cache: LoadedInventory | undefined;
let cachedPath: string | undefined;
let cachedStamp: FileStamp | undefined;

function load(): LoadedInventory {
  const path = process.env[RIG_INVENTORY_ENV];
  if (path === undefined || path.trim() === '') return { status: 'unconfigured' };
  const source = path.trim();
  let raw: string;
  try {
    raw = fs.readFileSync(source, 'utf8');
  } catch (e) {
    return { status: 'error', source, error: `cannot read rig inventory at ${source}: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { status: 'error', source, error: `rig inventory at ${source} is not valid JSON: ${(e as Error).message}` };
  }
  const obj = parsed as { devices?: unknown };
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(obj.devices)) {
    return { status: 'error', source, error: `rig inventory at ${source} is not a valid OpenRig inventory (expected a JSON object with a "devices" array)` };
  }
  return { status: 'loaded', inventory: parsed as Inventory, source };
}

/** The configured inventory, or `unconfigured` when `MCP_RIG_INVENTORY` is unset. Cached per path + file stamp. */
export function loadRigInventory(): LoadedInventory {
  const raw = process.env[RIG_INVENTORY_ENV];
  const path = raw === undefined || raw.trim() === '' ? undefined : raw.trim();
  const stamp: FileStamp = path === undefined ? 'absent' : stampFile(path);
  if (cache === undefined || cachedPath !== path || !sameStamp(cachedStamp, stamp)) {
    cache = load();
    cachedPath = path;
    cachedStamp = stamp;
  }
  return cache;
}

/** Clear the parsed-inventory cache (tests). */
export function clearRigInventoryCache(): void {
  cache = undefined;
  cachedPath = undefined;
  cachedStamp = undefined;
}
