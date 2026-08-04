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
  type RigEditOp, type ValidationIssue, type CompatibilityReport, type AudioOutputReport,
  type CapacityReport,
} from 'openrig';

import { loadRigManifest, writeRigManifest } from './manifest.js';
import { descriptorCapabilityLookup } from './capabilities.js';

export interface RigEditExecResult {
  ok: boolean;
  /** Present when the edit could not be applied / would be invalid. */
  error?: string;
  /** Human one-line description of the change. */
  summary?: string;
  edge_id?: string;
  /** The node id added / removed (add_device / remove_device). */
  node_id?: string;
  /** Cables removed as collateral by remove_device. */
  removed_edge_ids?: string[];
  /** True when this was a preview (nothing written). */
  dry_run: boolean;
  saved: boolean;
  /** The manifest path written (when saved). */
  source?: string;
  /** The backup copy made before overwriting (when saved and a prior file existed). */
  backup?: string;
  validation?: { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] };
  compatibility?: CompatibilityReport;
  audio?: AudioOutputReport;
  /**
   * Post-edit free/used capacity. Included because the most common follow-up to
   * `add_device` is "so where does it plug in", and the answer is a fact of the
   * manifest that should not have to be inferred.
   */
  capacity?: CapacityReport;
}

/** Apply a structured rig edit and (unless dry_run) persist it. */
export function executeRigEdit(op: RigEditOp, opts: { dry_run?: boolean } = {}): RigEditExecResult {
  const dry_run = opts.dry_run === true;
  const loaded = loadRigManifest();
  if (loaded.status === 'unconfigured') {
    return { ok: false, dry_run, saved: false, error: 'No rig manifest is configured (set MCP_RIG_MANIFEST). There is nothing to edit.' };
  }
  if (loaded.status === 'error') {
    return { ok: false, dry_run, saved: false, error: `The configured rig manifest failed to load: ${loaded.error}` };
  }

  const res = applyRigEdit(loaded.rig, op);
  if (!res.ok || res.rig === undefined) {
    return { ok: false, dry_run, saved: false, error: res.error ?? 'the edit could not be applied' };
  }

  const v = validateRig(res.rig);
  if (v.errors.length > 0) {
    return {
      ok: false, dry_run, saved: false,
      error: `the edit would make the rig invalid (${v.errors.map((e) => e.code).join(', ')}); nothing was written`,
      validation: { ok: v.ok, errors: v.errors, warnings: v.warnings },
    };
  }

  const compatibility = checkRigCompatibility(res.rig, { capabilities: descriptorCapabilityLookup() });
  const audio = checkAudioOutput(res.rig);
  const capacity = checkRigCapacity(res.rig);
  const common = {
    ok: true as const,
    summary: res.summary,
    edge_id: res.edge_id,
    node_id: res.node_id,
    removed_edge_ids: res.removed_edge_ids,
    validation: { ok: v.ok, errors: v.errors, warnings: v.warnings },
    compatibility,
    audio,
    capacity,
  };

  if (dry_run) return { ...common, dry_run: true, saved: false };
  const { source, backup } = writeRigManifest(res.rig);
  return { ...common, dry_run: false, saved: true, source, backup };
}
