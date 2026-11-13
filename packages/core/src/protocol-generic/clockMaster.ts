/**
 * Clock-master lookup from the configured rig manifest.
 *
 * A slaved rig runs ONE tempo: the node holding the OpenRig `clock_master` role
 * (§3) sets the MIDI clock, and every `clock_follower` plays at whatever tempo it
 * transmits. So a song's tempo has to be set on THAT device, not guessed. This
 * resolves the master by ROLE, so it is never hardwired to a specific box:
 * whichever node the manifest gives the role (a groovebox sequencer, a looper,
 * anything) is the one named, and re-wiring the rig re-points the guidance with
 * no code change. That is what keeps the tempo guidance a generic rig-control
 * feature rather than a special case for any one device.
 *
 * Manifest-only (`MCP_RIG_MANIFEST`), by the same discipline as `rigLinks.ts`:
 * there is no env fallback and no hardcoded default. When no manifest is
 * configured, or no node holds the role, the caller falls back to a generic
 * "your clock master" phrase (the feature still works, it just cannot name the
 * device).
 */
import { loadRigManifest } from './openrig/manifest.js';

/** The clock-master and clock-follower device NAMES resolved from the manifest. */
export interface ClockMasterInfo {
  /** Nodes holding the `clock_master` role (normally one; more = an ambiguous rig). */
  masters: string[];
  /** Nodes holding the `clock_follower` role (the devices slaved to the master's clock). */
  followers: string[];
}

/**
 * Resolve the rig's clock master + followers by role from the loaded manifest.
 * Returns empty lists when no manifest is configured or no node holds the role,
 * so a caller can fall back to generic phrasing without special-casing the
 * unconfigured path.
 */
export function resolveClockMaster(): ClockMasterInfo {
  const manifest = loadRigManifest();
  if (manifest.status !== 'loaded') return { masters: [], followers: [] };
  const masters: string[] = [];
  const followers: string[] = [];
  for (const node of manifest.rig.nodes) {
    if (node.roles.includes('clock_master')) masters.push(node.name);
    if (node.roles.includes('clock_follower')) followers.push(node.name);
  }
  return { masters, followers };
}
