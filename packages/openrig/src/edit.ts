/**
 * OpenRig structured EDIT: apply a small, well-typed change to a rig and return
 * the new rig. Pure and immutable (deep-clones, never mutates the input), so the
 * caller validates the RESULT before persisting. The reference implementation
 * (server) wraps this with file I/O + a backup + a validate-before-write gate.
 *
 * Scope v1: cables (edges). `add_cable` resolves or CREATES the needed ports on
 * each device so "connect the Hydra's audio to the RC-505" just works; the
 * caller can pass a device by `id` OR display `name`. `remove_cable` and
 * `set_cable_enabled` operate on an existing edge (by id, or by from/to/kind).
 * Node add/remove is a later increment.
 */
import type {
  AudioChannel, Edge, EdgeSignal, MidiSignal, MidiSignalType, Node, Port, PortKind, Rig, Role,
} from './types.js';

export type CableKind = 'audio' | 'midi' | 'footswitch';

export type RigEditOp =
  | {
      op: 'add_cable';
      /** Source device: node id or display name. */
      from: string;
      /** Destination device: node id or display name. */
      to: string;
      kind: CableKind;
      /** For midi: the message type (default 'cc'). */
      midi_type?: MidiSignalType;
      channel?: number;
      cc?: number[];
      notes?: number[];
      note_map?: Record<string, string> | 'GM';
      /** For audio: L/R (default) or M. */
      audio_channels?: AudioChannel[];
      /** Default true; pass false for a [planned] cable. */
      enabled?: boolean;
      note?: string;
    }
  | { op: 'remove_cable'; cable_id?: string; from?: string; to?: string; kind?: CableKind }
  | { op: 'set_cable_enabled'; cable_id: string; enabled: boolean }
  | {
      /**
       * Add a DEVICE (node) to the rig, with no cables. Cabling is a separate
       * `add_cable`, deliberately: a device usually arrives before you have
       * decided where it plugs in, and `rankAttachments` is what answers that.
       */
      op: 'add_device';
      /** Stable, opaque node id, unique in the rig (§8: authored once, never regenerated). */
      id: string;
      name: string;
      roles: Role[];
      manufacturer?: string;
      family?: string;
      /** Registered server descriptor id, or null/omitted for opaque gear. */
      server_device_id?: string | null;
      /** Jacks on the device. Omit to add a node with no ports yet. */
      ports?: Array<Pick<Port, 'id' | 'kind' | 'label' | 'audio' | 'output_role'>>;
      note?: string;
    }
  | {
      /** Remove a device AND every cable touching it (leaving them would dangle). */
      op: 'remove_device';
      /** Node id or display name. */
      device: string;
    };

export interface RigEditResult {
  ok: boolean;
  /** The new rig (when ok). Deep clone of the input with the edit applied. */
  rig?: Rig;
  /** Human one-line description of what changed. */
  summary?: string;
  /** The edge id added / removed / toggled. */
  edge_id?: string;
  /** The node id added / removed (device ops). */
  node_id?: string;
  /** Cable ids removed as collateral by `remove_device`. */
  removed_edge_ids?: string[];
  /** Set when the edit could not be applied (device not found, cable not found). */
  error?: string;
}

const OUT_KIND: Record<CableKind, PortKind> = { audio: 'audio_out', midi: 'midi_din_out', footswitch: 'footswitch' };
const IN_KIND: Record<CableKind, PortKind> = { audio: 'audio_in', midi: 'midi_din_in', footswitch: 'footswitch' };
const KIND_LABEL: Record<CableKind, string> = { audio: 'audio', midi: 'MIDI', footswitch: 'footswitch' };

function clone(rig: Rig): Rig {
  return JSON.parse(JSON.stringify(rig)) as Rig;
}

/** Resolve a device reference (id or display name, case-insensitive) to a node. */
function findNode(rig: Rig, ref: string): Node | undefined {
  const byId = rig.nodes.find((n) => n.id === ref);
  if (byId !== undefined) return byId;
  const lower = ref.trim().toLowerCase();
  return rig.nodes.find((n) => n.name.toLowerCase() === lower)
    ?? rig.nodes.find((n) => n.name.toLowerCase().includes(lower));
}

/** Find an existing port of `kind` on a node, or create + return a new one. */
function ensurePort(node: Node, kind: PortKind, dir: 'out' | 'in'): string {
  const existing = node.ports.find((p) => p.kind === kind);
  if (existing !== undefined) return existing.id;
  // create a sensible default port
  const base = kind.replace('_din', '').replace('_out', '').replace('_in', '');
  let id = kind === 'footswitch' ? (dir === 'out' ? 'sw' : `${base}_in`) : `${base}_${dir}`;
  const taken = new Set(node.ports.map((p) => p.id));
  let n = 2;
  const root = id;
  while (taken.has(id)) id = `${root}${n++}`;
  node.ports.push({ id, kind, label: id.replace(/_/g, ' ').toUpperCase() });
  return id;
}

/** A stable-but-unique id derived from a semantic base. */
function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function buildSignal(op: Extract<RigEditOp, { op: 'add_cable' }>): EdgeSignal {
  if (op.kind === 'audio') {
    return { kind: 'audio', channels: op.audio_channels ?? ['L', 'R'] };
  }
  if (op.kind === 'footswitch') {
    return { kind: 'footswitch', label: op.note ?? 'footswitch' };
  }
  const sig: MidiSignal = { type: op.midi_type ?? 'cc' };
  if (op.channel !== undefined) sig.channel = op.channel;
  if (op.cc !== undefined) sig.cc_numbers = op.cc;
  if (op.notes !== undefined) sig.notes = op.notes;
  if (op.note_map !== undefined) sig.note_map = op.note_map;
  return { kind: 'midi', signals: [sig] };
}

/** Apply a structured edit to a rig. Pure: returns a new rig, never mutates input. */
export function applyRigEdit(rig: Rig, op: RigEditOp): RigEditResult {
  const next = clone(rig);

  if (op.op === 'add_cable') {
    const from = findNode(next, op.from);
    const to = findNode(next, op.to);
    if (from === undefined) return { ok: false, error: `no device matches "${op.from}"` };
    if (to === undefined) return { ok: false, error: `no device matches "${op.to}"` };
    if (from.id === to.id) return { ok: false, error: 'a cable must connect two different devices' };
    const fromPort = ensurePort(from, OUT_KIND[op.kind], 'out');
    const toPort = ensurePort(to, IN_KIND[op.kind], 'in');
    const takenEdge = new Set(next.edges.map((e) => e.id));
    const id = uniqueId(`cable-${from.id}-${to.id}-${op.kind}`, takenEdge);
    const edge: Edge = {
      id,
      from: { node: from.id, port: fromPort },
      to: { node: to.id, port: toPort },
      physical_link_id: `link-${from.id}-${to.id}-${op.kind}`,
      directed: true,
      signal: buildSignal(op),
    };
    if (op.enabled === false) edge.enabled = false;
    if (op.note !== undefined) edge.note = op.note;
    next.edges.push(edge);
    return { ok: true, rig: next, edge_id: id, summary: `added ${KIND_LABEL[op.kind]} cable ${from.name} -> ${to.name}${op.enabled === false ? ' [planned]' : ''}` };
  }

  if (op.op === 'add_device') {
    if (op.id.trim().length === 0) return { ok: false, error: 'a device needs a non-empty id' };
    if (next.nodes.some((n) => n.id === op.id)) {
      return { ok: false, error: `a device with id "${op.id}" is already in this rig. Node ids are stable and opaque, so reuse is a collision, not an update.` };
    }
    if (op.roles.length === 0) {
      return { ok: false, error: 'a device needs at least one role (the checks key on roles: an instrument with no sound_source role is invisible to the audio check)' };
    }
    const seen = new Set<string>();
    for (const p of op.ports ?? []) {
      if (seen.has(p.id)) return { ok: false, error: `duplicate port id "${p.id}" on ${op.name}` };
      seen.add(p.id);
    }
    const node: Node = {
      id: op.id,
      name: op.name,
      identity: { manufacturer: op.manufacturer ?? null, family: op.family ?? null },
      server_device_id: op.server_device_id ?? null,
      roles: [...op.roles],
      ports: (op.ports ?? []).map((p) => ({ ...p })),
    };
    if (op.note !== undefined) node.note = op.note;
    next.nodes.push(node);
    return {
      ok: true, rig: next, node_id: node.id,
      summary: `added device ${node.name} (${node.ports.length} port${node.ports.length === 1 ? '' : 's'}, no cables yet)`,
    };
  }

  if (op.op === 'remove_device') {
    const node = findNode(next, op.device);
    if (node === undefined) return { ok: false, error: `no device matches "${op.device}"` };
    // Cables to a removed device would dangle (validateRig: dangling-endpoint),
    // so they go with it, and the caller is told exactly which.
    const doomed = next.edges.filter((e) => e.from.node === node.id || e.to.node === node.id);
    next.edges = next.edges.filter((e) => !doomed.includes(e));
    next.nodes = next.nodes.filter((n) => n.id !== node.id);
    // A binding naming the removed device is likewise left invalid, so drop it.
    const bindings = next.bindings;
    if (bindings !== undefined) {
      next.bindings = bindings.filter((b) => b.from.node !== node.id && b.to.node !== node.id);
    }
    return {
      ok: true, rig: next, node_id: node.id, removed_edge_ids: doomed.map((e) => e.id),
      summary: `removed device ${node.name}${doomed.length > 0 ? ` and ${doomed.length} cable${doomed.length === 1 ? '' : 's'} touching it` : ''}`,
    };
  }

  if (op.op === 'remove_cable') {
    const edge = resolveEdge(next, op);
    if (edge === undefined) return { ok: false, error: describeMissingEdge(op) };
    next.edges = next.edges.filter((e) => e.id !== edge.id);
    return { ok: true, rig: next, edge_id: edge.id, summary: `removed cable ${edge.id} (${nodeName(next, edge.from.node)} -> ${nodeName(next, edge.to.node)})` };
  }

  // set_cable_enabled
  const edge = next.edges.find((e) => e.id === op.cable_id);
  if (edge === undefined) return { ok: false, error: `no cable with id "${op.cable_id}"` };
  if (op.enabled) delete edge.enabled; else edge.enabled = false;
  return { ok: true, rig: next, edge_id: edge.id, summary: `cable ${edge.id} set ${op.enabled ? 'enabled' : 'disabled ([planned])'}` };
}

function resolveEdge(rig: Rig, op: Extract<RigEditOp, { op: 'remove_cable' }>): Edge | undefined {
  if (op.cable_id !== undefined) return rig.edges.find((e) => e.id === op.cable_id);
  const from = op.from !== undefined ? findNode(rig, op.from) : undefined;
  const to = op.to !== undefined ? findNode(rig, op.to) : undefined;
  return rig.edges.find((e) =>
    (from === undefined || e.from.node === from.id)
    && (to === undefined || e.to.node === to.id)
    && (op.kind === undefined || e.signal.kind === op.kind));
}

function describeMissingEdge(op: Extract<RigEditOp, { op: 'remove_cable' }>): string {
  if (op.cable_id !== undefined) return `no cable with id "${op.cable_id}"`;
  return `no cable matches from="${op.from ?? '*'}" to="${op.to ?? '*'}" kind="${op.kind ?? '*'}"`;
}

function nodeName(rig: Rig, id: string): string {
  return rig.nodes.find((n) => n.id === id)?.name ?? id;
}
