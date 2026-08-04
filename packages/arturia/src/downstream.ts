/**
 * "Is anything plugged into this synth's MIDI Out?", answered from the rig
 * manifest.
 *
 * WHY THIS EXISTS. A device setting can be harmless on one rig and break a
 * performance on another, and the difference is a cable the server cannot see.
 * The MicroFreak forced the question: its `midi_thru` and `output_dest` globals
 * decide whether its 5-pin MIDI Out relays anything at all, and on the
 * maintainer's rig that leg carries note targets into a VE-500's Pitch Correct
 * block, so turning either off silences his vocal chain while every read over
 * USB keeps reporting a perfectly healthy synth. On a MicroFreak with nothing in
 * its MIDI Out, the identical write is a non-event.
 *
 * WHY THE MANIFEST IS THE ORACLE, and not a capability flag on the descriptor:
 *
 *   - A descriptor describes what a device CAN do, never what it is plugged
 *     into. Baking "this device usually feeds something" into one would be a
 *     guess about a stranger's studio, and it would fire for every owner. A
 *     warning that fires for everyone is noise people learn to skip past, which
 *     is worse than no warning at the moment it finally matters.
 *   - The rig manifest (`MCP_RIG_MANIFEST`, OpenRig L1) is where a user has
 *     ALREADY declared their cabling, explicitly, cable by cable. It names the
 *     actual victim, so the warning can say "this feeds your Boss VE-500"
 *     instead of "this may feed something".
 *   - It is opt-in by construction. No manifest means no edges means no
 *     warnings, which is exactly right for the common case.
 *
 * Advisory ONLY. Nothing here refuses a write. Absence of a declaration is never
 * read as "nothing is plugged in", only as "we were not told", so a guard built
 * on this degrades to silence, never to a refusal.
 *
 * Not Arturia-specific in substance; it lives here because the MicroFreak is the
 * only device that needs it today. Lift it into `@mcp-midi-control/core` the
 * moment a second device wants the same question answered.
 */
import { loadRigManifest } from '@mcp-midi-control/core/protocol-generic/openrig/manifest.js';

/** One device sitting downstream of a source device's physical MIDI out. */
export interface DownstreamMidiConsumer {
  /** Registered descriptor id when the node has one, else the manifest node id. */
  device: string;
  /** Display name from the manifest, for user-facing text. */
  name: string;
  /** Port on the SOURCE device the cable leaves from (e.g. `midi_out`). */
  from_port: string;
  /** Manifest edge id, so the user can find the row this came from. */
  edge: string;
}

/** Out-port kinds that leave the device on a physical MIDI cable. USB is excluded on purpose: that is the server's own path, and the existing `usb_critical` guard already owns it. */
const DIN_OUT_PORT_KINDS = new Set(['midi_din_out', 'midi_thru']);

/**
 * The rig manifest, narrowed to the shape this walk dereferences. Declared
 * structurally rather than importing OpenRig's `Rig` so this module stays a leaf
 * with no schema dependency, and so a test can hand it a two-node literal.
 */
export interface RigTopology {
  nodes: readonly {
    id: string;
    name: string;
    server_device_id?: string | null;
    ports: readonly { id: string; kind: string }[];
  }[];
  edges: readonly {
    id: string;
    from: { node: string; port: string };
    to: { node: string; port: string };
    signal: { kind: string };
    enabled?: boolean;
  }[];
}

/**
 * Every device reachable over ONE enabled MIDI cable out of `sourceDeviceId`'s
 * physical MIDI out ports.
 *
 * One hop, deliberately. Following a second hop would depend on the intermediate
 * device's own thru setting, which is the very class of fact a manifest records
 * hopefully rather than observes. A warning assembled from a chain of hopeful
 * facts is worse than one built on the single cable we were told about.
 *
 * `sourceDeviceId` matches a node's `server_device_id` first, then its node id,
 * so it works for a registered device and for opaque gear alike.
 */
export function downstreamMidiConsumersIn(
  rig: RigTopology,
  sourceDeviceId: string,
): DownstreamMidiConsumer[] {
  const want = sourceDeviceId.trim().toLowerCase();
  const sources = rig.nodes.filter(
    (n) => (n.server_device_id ?? '').toLowerCase() === want || n.id.toLowerCase() === want,
  );
  if (sources.length === 0) return [];

  const nodeById = new Map(rig.nodes.map((n) => [n.id, n]));
  const out: DownstreamMidiConsumer[] = [];
  const seenEdges = new Set<string>();

  for (const source of sources) {
    const dinPorts = new Set(
      source.ports.filter((p) => DIN_OUT_PORT_KINDS.has(p.kind)).map((p) => p.id),
    );
    if (dinPorts.size === 0) continue;
    for (const edge of rig.edges) {
      if (edge.enabled === false) continue;        // a planned cable is not a patched one
      if (edge.signal.kind !== 'midi') continue;
      if (edge.from.node !== source.id) continue;
      if (!dinPorts.has(edge.from.port)) continue;
      if (seenEdges.has(edge.id)) continue;
      const to = nodeById.get(edge.to.node);
      if (to === undefined) continue;              // dangling ref; validateRig reports it
      seenEdges.add(edge.id);
      out.push({
        device: to.server_device_id ?? to.id,
        name: to.name,
        from_port: edge.from.port,
        edge: edge.id,
      });
    }
  }
  return out;
}

/** Same question, against the configured rig manifest. Empty when none is configured or it failed to load. */
export function downstreamMidiConsumers(sourceDeviceId: string): DownstreamMidiConsumer[] {
  const manifest = loadRigManifest();
  if (manifest.status !== 'loaded') return [];
  return downstreamMidiConsumersIn(manifest.rig as unknown as RigTopology, sourceDeviceId);
}
