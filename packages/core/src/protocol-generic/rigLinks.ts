/**
 * Rig topology links — which of a host sequencer's outward MIDI tracks drives
 * which external device.
 *
 * The Circuit Tracks has two outward MIDI tracks (MIDI 1 / MIDI 2). When the
 * user wires an external sound module (e.g. a Roland SPD-SX) to one of them, the
 * server can't see that cable. This optional config records it so the agent can
 * resolve "the SPD-SX connected to MIDI 2" without the user restating the wiring
 * every call: `apply_pattern external_targets` defaults a target's `track` from
 * it, and `describe_rig` surfaces it.
 *
 * Source: the `MCP_RIG_LINKS` env var, a JSON object mapping a host track name to
 * the connected device's id or name, e.g.
 *
 *     MCP_RIG_LINKS={"midi2":"spd-sx","midi1":"hydrasynth"}
 *
 * Absent / malformed ⇒ no links (the feature is purely additive; external_targets
 * still works with an explicit `track`). Parsed once and cached; call
 * `clearRigLinksCache()` in tests to re-read.
 *
 * Supersession (OpenRig Phase C): when a rig manifest is configured
 * (`MCP_RIG_MANIFEST`), it is the ONE source of truth for this wiring, and
 * `resolveRigLinks()` DERIVES the track -> device map from the manifest's
 * sequencer edges (OPENRIG-SCHEMA.md §4). `MCP_RIG_LINKS` remains the documented
 * fallback for a rig with no manifest. Both `describe_rig` and `apply_pattern`'s
 * external_targets read `resolveRigLinks()`, so there is no second env-var map.
 */
import type { Rig } from 'openrig';
import { getDeviceById } from './registry.js';
import { loadRigManifest } from './openrig/manifest.js';

export const RIG_LINKS_ENV = 'MCP_RIG_LINKS';

/** track name (lower-case) → external device id/name (verbatim). */
export type RigLinks = Readonly<Record<string, string>>;

let cache: RigLinks | undefined;

function parse(raw: string | undefined): RigLinks {
  if (raw === undefined || raw.trim() === '') return {};
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return {};
  const out: Record<string, string> = {};
  for (const [track, device] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof device === 'string' && device.trim() !== '') {
      out[track.trim().toLowerCase()] = device.trim();
    }
  }
  return out;
}

/** The configured rig links (track → external device id/name). Cached. */
export function getRigLinks(): RigLinks {
  if (cache === undefined) cache = parse(process.env[RIG_LINKS_ENV]);
  return cache;
}

/** Reverse lookup: the host track wired to `deviceIdOrName`, if any. */
export function trackForDevice(deviceIdOrName: string): string | undefined {
  const want = deviceIdOrName.trim().toLowerCase();
  for (const [track, device] of Object.entries(resolveRigLinks())) {
    if (device.toLowerCase() === want) return track;
  }
  return undefined;
}

/**
 * Derive the track -> device links from a rig manifest (§4). An edge from a
 * sequencer node's outward note-track port (a port whose id is one of the source
 * descriptor's `external_tracks`, carrying a `note` signal) records that the
 * host's MIDI track drives the destination device: e.g. the Circuit MIDI-2 ->
 * SPD-SX edge yields `{ midi2: 'spd-sx' }`. Disabled edges (a planned cable) are
 * skipped. Uses the descriptor registry so only real external tracks count.
 */
export function deriveRigLinks(rig: Rig): RigLinks {
  const out: Record<string, string> = {};
  const nodeById = new Map(rig.nodes.map((n) => [n.id, n]));
  for (const edge of rig.edges) {
    if (edge.enabled === false) continue;
    if (edge.signal.kind !== 'midi' || !edge.signal.signals.some((s) => s.type === 'note')) continue;
    const fromNode = nodeById.get(edge.from.node);
    if (fromNode?.server_device_id == null) continue;
    const ext = getDeviceById(fromNode.server_device_id)?.capabilities.external_tracks;
    if (ext === undefined || !(edge.from.port in ext)) continue;
    const toNode = nodeById.get(edge.to.node);
    if (toNode === undefined) continue;
    out[edge.from.port.trim().toLowerCase()] = toNode.server_device_id ?? toNode.id;
  }
  return out;
}

/**
 * The effective rig links: manifest-derived when a rig manifest is configured and
 * yields any links, else the `MCP_RIG_LINKS` env fallback. This is the single
 * accessor both `describe_rig` and external_targets use (the manifest supersedes
 * the env var, §4).
 */
export function resolveRigLinks(): RigLinks {
  const manifest = loadRigManifest();
  if (manifest.status === 'loaded') {
    const derived = deriveRigLinks(manifest.rig);
    if (Object.keys(derived).length > 0) return derived;
  }
  return getRigLinks();
}

/** Where `resolveRigLinks()` sourced its links from, for reporting. */
export function rigLinksSource(): 'manifest' | 'env' | 'none' {
  const manifest = loadRigManifest();
  if (manifest.status === 'loaded' && Object.keys(deriveRigLinks(manifest.rig)).length > 0) return 'manifest';
  if (Object.keys(getRigLinks()).length > 0) return 'env';
  return 'none';
}

/** Clear the parsed-env cache (tests). */
export function clearRigLinksCache(): void {
  cache = undefined;
}
