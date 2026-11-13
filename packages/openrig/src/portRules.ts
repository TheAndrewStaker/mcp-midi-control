/**
 * OpenRig PORT RULES: which way a jack faces, and how many cables it can hold.
 *
 * Owns the two physical facts about a port that every other module needs and
 * none should re-derive: its DIRECTION (can a cable leave it, arrive at it, or
 * either) and its OCCUPANCY (which live cables already plug into it, and whether
 * a second one is legal). `capacity.ts` reports them, `validate.ts` checks them
 * on a manifest, and `edit.ts` enforces them when an edit picks a jack.
 *
 * Motivating failure (2026-09-16, a real session). Asked to cable a new pedal,
 * `add_cable` took the FIRST port of the right kind and returned ok: it put a
 * thru box's feed onto the output already feeding a synth, and it accepted a
 * TRS cable between two expression INPUTS (a pedal's EXP jack to an amp
 * modeler's pedal jack), which is the exact wiring the user was asking whether
 * would work. Both answers were a fact of the manifest, computed nowhere.
 */
import type { Edge, Node, Port, PortKind, Rig } from './types.js';

/** Whether a port can originate a cable, receive one, or either. */
export type PortDirection = 'source' | 'sink' | 'either';

/**
 * Physical direction implied by each port kind. A `midi_thru` jack is a SOURCE:
 * it is an output socket you run a cable out of, whether it mirrors the In
 * (hardware thru) or the Out (duplicate mode).
 *
 * The control kinds and USB are `either` BY KIND because the same kind appears
 * on the sending pedal and the receiving unit. A port of those kinds narrows
 * that with its own `direction` (see {@link portDirection}).
 */
export const KIND_DIRECTION: Record<PortKind, PortDirection> = {
  audio_out: 'source',
  audio_in: 'sink',
  midi_din_in: 'sink',
  midi_din_out: 'source',
  midi_thru: 'source',
  usb_midi: 'either',
  usb_serial: 'either',
  expression: 'either',
  footswitch: 'either',
  cv: 'either',
  analog_clock: 'either',
};

/**
 * A port's effective direction: its declared `direction` when present
 * (`in` = sink, `out` = source), otherwise the direction its kind implies.
 * An expression jack on an effects pedal that ACCEPTS a pedal is `in`; the jack
 * on the expression pedal itself is `out`.
 */
export function portDirection(port: Pick<Port, 'kind' | 'direction'>): PortDirection {
  if (port.direction === 'in') return 'sink';
  if (port.direction === 'out') return 'source';
  return KIND_DIRECTION[port.kind];
}

/** True when a declared `direction` contradicts a fixed-direction kind (an `audio_in` declared `out`). */
export function directionContradictsKind(port: Pick<Port, 'kind' | 'direction'>): boolean {
  if (port.direction === undefined) return false;
  const byKind = KIND_DIRECTION[port.kind];
  if (byKind === 'either') return false;
  return (port.direction === 'in') !== (byKind === 'sink');
}

/**
 * Can this port legally hold more than one live cable?
 *
 * Only one shape, per the spec: an audio INPUT on a mixing destination (a node
 * with the `mixer` or `monitor` role) is a summing point, so N edges in is legal
 * (§3). Every other jack takes one plug. A duplex link (USB MIDI) is two directed
 * edges sharing one `physical_link_id`, which counts as ONE cable, so it needs no
 * exemption here (see {@link liveCablesOnPort}).
 */
export function portAcceptsMultipleCables(node: Pick<Node, 'roles'>, port: Pick<Port, 'kind'>): boolean {
  return port.kind === 'audio_in' && node.roles.some((r) => r === 'mixer' || r === 'monitor');
}

/** A cable already plugged into a port, as an occupancy report names it. */
export interface PortOccupant {
  edge_id: string;
  enabled: boolean;
  /** The device at the OTHER end of the cable. */
  other_node: string;
}

/**
 * The identity of the physical plug an edge represents. A duplex link (§8: two
 * directed edges sharing a `physical_link_id`) joins the SAME two jacks in
 * opposite directions, so both edges key identically. Two edges that share a
 * link id but join different jacks are two plugs, whatever the id says.
 */
function plugKey(e: Pick<Edge, 'id' | 'from' | 'to' | 'physical_link_id'>): string {
  const a = `${e.from.node}.${e.from.port}`;
  const b = `${e.to.node}.${e.to.port}`;
  return `${e.physical_link_id ?? `edge:${e.id}`}#${a < b ? `${a}|${b}` : `${b}|${a}`}`;
}

/**
 * Every cable touching `node.port`, live and planned. `except` leaves out one
 * edge AND its duplex partner (the cable being enabled must not count against
 * itself).
 */
export function cablesOnPort(
  rig: Rig, nodeId: string, portId: string, except?: Pick<Edge, 'id' | 'from' | 'to' | 'physical_link_id'>,
): PortOccupant[] {
  const skipKey = except !== undefined ? plugKey(except) : undefined;
  const out: PortOccupant[] = [];
  for (const e of rig.edges) {
    if (except !== undefined && (e.id === except.id || plugKey(e) === skipKey)) continue;
    const atFrom = e.from.node === nodeId && e.from.port === portId;
    const atTo = e.to.node === nodeId && e.to.port === portId;
    if (!atFrom && !atTo) continue;
    out.push({ edge_id: e.id, enabled: e.enabled !== false, other_node: atFrom ? e.to.node : e.from.node });
  }
  return out;
}

/**
 * The LIVE (enabled) cables on a port, one entry per physical plug: a duplex
 * pair is one plug, not two.
 */
export function liveCablesOnPort(
  rig: Rig, nodeId: string, portId: string, except?: Pick<Edge, 'id' | 'from' | 'to' | 'physical_link_id'>,
): PortOccupant[] {
  const edgeById = new Map(rig.edges.map((e) => [e.id, e]));
  const byPlug = new Map<string, PortOccupant>();
  for (const occ of cablesOnPort(rig, nodeId, portId, except)) {
    if (!occ.enabled) continue;
    const edge = edgeById.get(occ.edge_id);
    const key = edge !== undefined ? plugKey(edge) : `edge:${occ.edge_id}`;
    if (!byPlug.has(key)) byPlug.set(key, occ);
  }
  return [...byPlug.values()];
}
