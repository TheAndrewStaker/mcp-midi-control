/**
 * OpenRig manifest EDIT executor (server side): load the configured rig.json,
 * apply a structured edit (openrig `applyRigEdit`), VALIDATE the result, and
 * (unless dry_run) back up + write it back, re-running the compat + audio checks
 * so the caller sees the effect. This is the transport-agnostic write path the
 * `edit_rig` tool exposes: it works headless / by conversation on any host, and
 * it is the foundation any future editor UI sits on (the UI would call the same
 * tool via the host's tool-call bridge).
 *
 * Safety: a structurally-invalid edit (validateRig errors) is REFUSED and never
 * written; the existing file is backed up before any overwrite (writeRigManifest).
 * Compatibility / audio issues are advisory (surfaced, not blocking) since a rig
 * is legitimately mid-construction while editing.
 */
import {
  applyRigEdit, validateRig, checkRigCompatibility, checkAudioOutput, checkRigCapacity,
  type Rig, type RigEditOp, type RigEditResult, type ValidationIssue, type CompatibilityReport,
  type AudioOutputReport, type CapacityReport,
} from 'openrig';

import {
  loadRigManifest, loadedRigManifestStamp, writeRigManifest, RigManifestChangedError,
} from './manifest.js';
import { descriptorCapabilityLookup } from './capabilities.js';

export interface RigEditExecResult {
  ok: boolean;
  /** Present when the edit could not be applied / would be invalid. */
  error?: string;
  /** Human one-line description of the change (batch: the LAST op's). */
  summary?: string;
  edge_id?: string;
  /** The node id added / patched / removed (device + port + routing ops). */
  node_id?: string;
  /** The port id added / patched / removed (port ops). */
  port_id?: string;
  /** The binding id added / patched / removed (binding ops). */
  binding_id?: string;
  /** Cables removed as collateral by remove_device / remove_port. */
  removed_edge_ids?: string[];
  /**
   * Applied, but worth saying (e.g. a [planned] cable reserving a jack a live
   * cable still holds). Every op's, in order. Absent when empty.
   */
  warnings?: string[];
  /** Batch call: one summary per applied op, in order. */
  summaries?: string[];
  /** Batch call: every edge id added / removed / patched / toggled, in op order. */
  edge_ids?: string[];
  /** Batch call: every node id added / patched / removed, in op order. */
  node_ids?: string[];
  /** Batch call: every port id added / patched / removed, in op order. */
  port_ids?: string[];
  /** Batch call: every binding id added / patched / removed, in op order. */
  binding_ids?: string[];
  /** Batch call: index (into the submitted op array) of the op that failed. */
  failed_op_index?: number;
  /** True when this was a preview (nothing written). */
  dry_run: boolean;
  saved: boolean;
  /** The manifest path written (when saved). */
  source?: string;
  /** The backup copy made before overwriting (when saved and a prior file existed). */
  backup?: string;
  /** Old backups deleted by retention pruning (when saved; newest 20 + < 7 days survive). */
  pruned?: string[];
  validation?: { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] };
  compatibility?: CompatibilityReport;
  audio?: AudioOutputReport;
  /**
   * Post-edit free/used capacity. Included because the most common follow-up to
   * `add_device` is "so where does it plug in", and the answer is a fact of the
   * manifest that should not have to be inferred. `free_by_kind` and `issues`
   * cover the WHOLE rig; `devices` lists only the devices this edit touched
   * (the full per-device table is `describe_rig`'s): echoing every device on
   * every edit cost ~15,000 characters for a one-node change.
   */
  capacity?: CapacityReport;
}

/**
 * Apply a structured rig edit, or an ORDERED BATCH of them, and (unless
 * dry_run) persist the result. A batch is all-or-nothing: each op's output rig
 * feeds the next, any failure aborts with `failed_op_index` and nothing
 * written, validation runs once over the final rig, and the file is written
 * (with ONE backup) once. A single non-array op keeps today's exact response
 * shape (no plural fields).
 */
export function executeRigEdit(op: RigEditOp | RigEditOp[], opts: { dry_run?: boolean } = {}): RigEditExecResult {
  const dry_run = opts.dry_run === true;
  const batch = Array.isArray(op);
  const ops: RigEditOp[] = batch ? op : [op];
  if (ops.length === 0) {
    return { ok: false, dry_run, saved: false, error: 'the edit batch is empty; there is nothing to apply' };
  }
  const loaded = loadRigManifest();
  if (loaded.status === 'unconfigured') {
    return { ok: false, dry_run, saved: false, error: 'No rig manifest is configured (set MCP_RIG_MANIFEST). There is nothing to edit.' };
  }
  if (loaded.status === 'absent') {
    return {
      ok: false, dry_run, saved: false,
      error: `The configured rig manifest does not exist yet (${loaded.source}). Nothing to edit: create it first via createRigManifest (e.g. from bootstrapRigFromRegistry), then re-run the edit.`,
    };
  }
  if (loaded.status === 'error') {
    return { ok: false, dry_run, saved: false, error: `The configured rig manifest failed to load: ${loaded.error}` };
  }

  // The stamp of the file this edit is built on: the write below refuses if the
  // file changed after this point, rather than landing over edits it never saw.
  const readStamp = loadedRigManifestStamp();
  let rig: Rig = loaded.rig;
  const summaries: string[] = [];
  const edge_ids: string[] = [];
  const node_ids: string[] = [];
  const port_ids: string[] = [];
  const binding_ids: string[] = [];
  const warnings: string[] = [];
  const touched = new Set<string>();
  let last: RigEditResult | undefined;
  for (let i = 0; i < ops.length; i++) {
    const res = applyRigEdit(rig, ops[i]);
    if (!res.ok || res.rig === undefined) {
      return {
        ok: false, dry_run, saved: false,
        error: res.error ?? 'the edit could not be applied',
        ...(batch ? { failed_op_index: i } : {}),
      };
    }
    rig = res.rig;
    if (res.summary !== undefined) summaries.push(res.summary);
    if (res.edge_id !== undefined) {
      edge_ids.push(res.edge_id);
      const edge = rig.edges.find((e) => e.id === res.edge_id);
      if (edge !== undefined) { touched.add(edge.from.node); touched.add(edge.to.node); }
    }
    if (res.node_id !== undefined) { node_ids.push(res.node_id); touched.add(res.node_id); }
    if (res.port_id !== undefined) port_ids.push(res.port_id);
    if (res.binding_id !== undefined) binding_ids.push(res.binding_id);
    if (res.warnings !== undefined) warnings.push(...res.warnings);
    last = res;
  }

  const v = validateRig(rig);
  if (v.errors.length > 0) {
    return {
      ok: false, dry_run, saved: false,
      error: `the edit would make the rig invalid (${v.errors.map((e) => e.code).join(', ')}); nothing was written`,
      validation: { ok: v.ok, errors: v.errors, warnings: v.warnings },
    };
  }

  const compatibility = checkRigCompatibility(rig, { capabilities: descriptorCapabilityLookup() });
  const audio = checkAudioOutput(rig);
  const fullCapacity = checkRigCapacity(rig);
  const capacity: CapacityReport = { ...fullCapacity, devices: fullCapacity.devices.filter((d) => touched.has(d.id)) };
  const common = {
    ok: true as const,
    summary: last?.summary,
    edge_id: last?.edge_id,
    node_id: last?.node_id,
    port_id: last?.port_id,
    binding_id: last?.binding_id,
    removed_edge_ids: last?.removed_edge_ids,
    ...(warnings.length > 0 ? { warnings } : {}),
    // Plural fields ride only a batch call so a single-op response stays
    // byte-identical to the pre-batch shape.
    ...(batch ? { summaries, edge_ids, node_ids, port_ids, binding_ids } : {}),
    validation: { ok: v.ok, errors: v.errors, warnings: v.warnings },
    compatibility,
    audio,
    capacity,
  };

  if (dry_run) return { ...common, dry_run: true, saved: false };
  try {
    const { source, backup, pruned } = writeRigManifest(rig, { ifUnchangedSince: readStamp });
    return { ...common, dry_run: false, saved: true, source, backup, pruned };
  } catch (e) {
    if (e instanceof RigManifestChangedError) return { ok: false, dry_run: false, saved: false, error: e.message };
    throw e;
  }
}
