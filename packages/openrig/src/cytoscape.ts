/**
 * Render projection (§6): a pure `toCytoscapeElements(rig)` that projects the
 * domain model (a labeled directed multigraph with ported endpoints and
 * multi-signal edges) to the Cytoscape.js `elements` shape, so a JS library can
 * render it directly. View-only: no editing in the UI, authoring stays voice.
 *
 * The projection is the actual work: device nodes become COMPOUND (parent)
 * nodes, each port becomes a child node parented to its device, and each edge
 * connects the two port child-nodes with a human-readable signal label plus the
 * typed metadata. A song's active routing is a highlighted sub-graph; a disabled
 * edge carries a `disabled` class.
 */
import type { AudioChannel, Edge, EdgeSignal, MidiSignal, Rig } from './types.js';

export interface CyNode {
  data: {
    id: string;
    label: string;
    parent?: string;
    kind?: string;
    roles?: string;
    server_device_id?: string | null;
    opaque?: boolean;
  };
  classes: string;
}

export interface CyEdge {
  data: {
    id: string;
    source: string;
    target: string;
    label: string;
    signal_kind: string;
    physical_link_id?: string;
    binding?: string;
  };
  classes: string;
}

export interface CyElements {
  nodes: CyNode[];
  edges: CyEdge[];
}

/** Stable id for a port child-node in the Cytoscape graph. */
function portGid(nodeId: string, portId: string): string {
  return `${nodeId}::${portId}`;
}

/** Compress a sorted-ish list of CC numbers to a compact range string. */
function compressNumbers(nums: number[]): string {
  if (nums.length === 0) return '';
  const sorted = [...nums].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const n = sorted[i];
    if (n === prev + 1) { prev = n; continue; }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  return parts.join(',');
}

function summarizeMidiSignal(sig: MidiSignal): string {
  const ch = sig.channel !== undefined ? ` ch${sig.channel}` : '';
  switch (sig.type) {
    case 'clock': return 'clock';
    case 'transport': return 'transport';
    case 'spp': return 'SPP';
    case 'song_select': return 'song select';
    case 'active_sensing': return 'active sensing';
    case 'sysex': return 'sysex';
    case 'nrpn': return `NRPN${ch}`;
    case 'pc': return `PC${ch}`;
    case 'cc': {
      const ccs = sig.cc_numbers && sig.cc_numbers.length ? ` ${compressNumbers(sig.cc_numbers)}` : '';
      return `CC${ccs}${ch}`;
    }
    case 'note': {
      const map = sig.note_map === 'GM' ? ' (GM)' : sig.note_map ? ' (mapped)' : '';
      return `note${ch}${map}`;
    }
    default: return sig.type;
  }
}

/** Human-readable one-line summary of an edge's signal payload. */
export function summarizeSignal(signal: EdgeSignal): string {
  if (signal.kind === 'audio') {
    return `audio ${(signal.channels as AudioChannel[]).join('/')}`;
  }
  if (signal.kind === 'midi') {
    return signal.signals.map(summarizeMidiSignal).join(', ');
  }
  return signal.label ?? signal.kind;
}

function edgeClasses(edge: Edge): string {
  const cls: string[] = [edge.signal.kind];
  if (edge.enabled === false) cls.push('disabled');
  if (edge.binding !== undefined) cls.push('governed');
  return cls.join(' ');
}

/**
 * Project a rig to Cytoscape `elements`. Pure and side-effect free. Returns
 * `{ nodes, edges }`; a renderer consumes `[...nodes, ...edges]`.
 */
export function toCytoscapeElements(rig: Rig): CyElements {
  const nodes: CyNode[] = [];
  const edges: CyEdge[] = [];

  for (const node of rig.nodes) {
    const opaque = node.server_device_id === null || node.server_device_id === undefined;
    nodes.push({
      data: {
        id: node.id,
        label: node.name,
        roles: node.roles.join(', '),
        server_device_id: node.server_device_id ?? null,
        opaque,
      },
      classes: opaque ? 'device opaque' : 'device',
    });
    for (const port of node.ports) {
      nodes.push({
        data: {
          id: portGid(node.id, port.id),
          parent: node.id,
          label: port.label ?? port.id,
          kind: port.kind,
        },
        classes: `port ${port.kind}`,
      });
    }
  }

  for (const edge of rig.edges) {
    edges.push({
      data: {
        id: edge.id,
        source: portGid(edge.from.node, edge.from.port),
        target: portGid(edge.to.node, edge.to.port),
        label: summarizeSignal(edge.signal),
        signal_kind: edge.signal.kind,
        physical_link_id: edge.physical_link_id,
        binding: edge.binding,
      },
      classes: edgeClasses(edge),
    });
  }

  return { nodes, edges };
}
