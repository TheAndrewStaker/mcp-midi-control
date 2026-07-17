/**
 * OpenRig INVENTORY (§11): what you OWN, independent of any one rig's wiring. A
 * rig is a wiring of a SUBSET of the inventory. Rig-independent, so it is its own
 * artifact (loaded from a separate source), not a rig field.
 *
 * Pure model + two pure functions: `validateInventory` (light referential
 * checks) and `crossReferenceInventory` (which owned gear is IN the active rig
 * vs SPARE). The rig PROPOSER (inventory -> candidate rigs -> scored by the
 * checks) is deliberately NOT here: per the agent-as-UX boundary, the proposer
 * is composed by the agent from these primitives, not a server function.
 */
import type { Identity, Node, Rig } from './types.js';
import { OPENRIG_VERSION } from './types.js';

/** One device you OWN: a rig Node minus the wiring (identity + optional links). */
export interface InventoryDevice {
  /** Stable owned-device id (often equal to a rig node id when it is wired). */
  id: string;
  name: string;
  identity: Identity;
  /** Links to a registered server descriptor when supported; null for opaque gear. */
  server_device_id?: string | null;
  /** How many identical units you own (e.g. two FS-5U). */
  count?: number;
  note?: string;
}

/** The set of devices you own. The superset a rig draws a subset from. */
export interface Inventory {
  openrig_version: string;
  id: string;
  name?: string;
  note?: string;
  devices: InventoryDevice[];
}

export interface InventoryIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  ref?: string;
}

export interface InventoryValidation {
  ok: boolean;
  errors: InventoryIssue[];
  warnings: InventoryIssue[];
}

/** Light referential-integrity check for an inventory (mirrors validateRig's shape). */
export function validateInventory(inv: Inventory): InventoryValidation {
  const errors: InventoryIssue[] = [];
  const warnings: InventoryIssue[] = [];

  if (typeof inv.openrig_version !== 'string') {
    errors.push({ severity: 'error', code: 'missing-version', message: 'openrig_version is required (semver major.minor)' });
  } else {
    const major = Number(inv.openrig_version.split('.')[0]);
    const our = Number(OPENRIG_VERSION.split('.')[0]);
    if (Number.isFinite(major) && major > our) {
      errors.push({ severity: 'error', code: 'unsupported-major', message: `openrig_version ${inv.openrig_version} has a higher major than this tool supports (${OPENRIG_VERSION})` });
    }
  }
  const seen = new Set<string>();
  for (const d of inv.devices) {
    if (seen.has(d.id)) errors.push({ severity: 'error', code: 'duplicate-device-id', message: `duplicate inventory device id "${d.id}"`, ref: d.id });
    seen.add(d.id);
    if (d.identity === undefined || (d.identity.manufacturer === undefined && d.identity.family === undefined)) {
      warnings.push({ severity: 'warning', code: 'missing-identity', message: `inventory device "${d.id}" has no identity (manufacturer/family); it cannot be matched to a rig node by type`, ref: d.id });
    }
    if (d.count !== undefined && (!Number.isInteger(d.count) || d.count < 1)) {
      errors.push({ severity: 'error', code: 'bad-count', message: `inventory device "${d.id}" count ${d.count} must be a positive integer`, ref: d.id });
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export type InventoryStatus = 'in_rig' | 'spare';

export interface InventoryDeviceStatus {
  id: string;
  name: string;
  /** `in_rig` when this owned device maps to at least one node in the active rig, else `spare`. */
  status: InventoryStatus;
  /** The rig node ids this owned device appears as (a count-2 device can map to two). */
  in_rig_nodes: string[];
  server_device_id: string | null;
  count?: number;
  note?: string;
}

export interface InventoryReport {
  device_count: number;
  in_rig: number;
  spare: number;
  devices: InventoryDeviceStatus[];
  /**
   * Rig node ids whose device is NOT in the inventory (owned-gear gap, or an
   * abstract node like the front-of-house OUT that you do not own). Advisory.
   */
  rig_devices_not_in_inventory: string[];
}

/** Does a rig node correspond to this owned device? by server_device_id, then type-key, then id. */
function matchesNode(inv: InventoryDevice, node: Node): boolean {
  if (inv.server_device_id != null && node.server_device_id != null && inv.server_device_id === node.server_device_id) return true;
  const a = inv.identity, b = node.identity;
  if (a?.manufacturer != null && b?.manufacturer != null && a.family != null && b.family != null
      && a.manufacturer.toLowerCase() === b.manufacturer.toLowerCase()
      && a.family.toLowerCase() === b.family.toLowerCase()) return true;
  return inv.id === node.id;
}

/**
 * Cross-reference the inventory against a rig: which owned gear is wired into the
 * active rig (in_rig) vs on the shelf (spare), and which rig nodes are not owned.
 * Pure. The rig is one wiring of a subset of what you own.
 */
export function crossReferenceInventory(inventory: Inventory, rig: Rig): InventoryReport {
  const devices: InventoryDeviceStatus[] = inventory.devices.map((inv) => {
    const nodes = rig.nodes.filter((n) => matchesNode(inv, n));
    return {
      id: inv.id,
      name: inv.name,
      status: (nodes.length > 0 ? 'in_rig' : 'spare') as InventoryStatus,
      in_rig_nodes: nodes.map((n) => n.id),
      server_device_id: inv.server_device_id ?? null,
      count: inv.count,
      note: inv.note,
    };
  });
  const owned = new Set(devices.flatMap((d) => d.in_rig_nodes));
  return {
    device_count: devices.length,
    in_rig: devices.filter((d) => d.status === 'in_rig').length,
    spare: devices.filter((d) => d.status === 'spare').length,
    devices,
    rig_devices_not_in_inventory: rig.nodes.filter((n) => !owned.has(n.id)).map((n) => n.id),
  };
}
