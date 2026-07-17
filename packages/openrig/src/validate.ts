/**
 * OpenRig L1 validator (§6). Two tiers, both pure (no hardware, no descriptor
 * registry): structural referential-integrity, and the cheap high-value graph
 * checks (MIDI cycle detection + clock-subgraph well-formedness).
 *
 * Honestly scoped: this validates the MANIFEST's internal consistency and its
 * graph shape. It deliberately does NOT claim to "validate topology" against
 * the physical world (no edge/channel is server-observable, §6); descriptor
 * drift + device presence are the reference implementation's job (Phase C), not
 * this pure function's.
 */
import { relaysSignal } from './routing.js';
import type {
  Edge, MidiChannel, MidiSignal, Node, PortKind, Rig, Role, SignalKind,
} from './types.js';
import { OPENRIG_VERSION, ROLES } from './types.js';

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  severity: Severity;
  /** Stable machine code, e.g. `dangling-endpoint`, `port-signal-mismatch`. */
  code: string;
  message: string;
  /** The offending node / edge / binding id, when applicable. */
  ref?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** Which signal kinds may attach to a port of each kind (the §3 invariant). */
const PORT_SIGNAL_COMPAT: Record<PortKind, SignalKind[]> = {
  audio_out: ['audio'],
  audio_in: ['audio'],
  midi_din_in: ['midi'],
  midi_din_out: ['midi'],
  midi_thru: ['midi'],
  usb_midi: ['midi'],
  usb_serial: ['midi'],
  expression: ['expression'],
  footswitch: ['footswitch'],
  cv: ['control_voltage'],
  analog_clock: ['analog_clock'],
};

/** MIDI signal types that carry NO channel (§3). */
const CHANNELLESS_MIDI = new Set(['clock', 'transport', 'active_sensing', 'sysex', 'spp', 'song_select']);

function isValidChannel(ch: MidiChannel): boolean {
  return Number.isInteger(ch) && ch >= 1 && ch <= 16;
}

/**
 * Validate an OpenRig manifest. Returns errors (the manifest is malformed /
 * internally inconsistent) and warnings (legal but likely a mistake: a MIDI
 * feedback loop, a malformed clock topology).
 */
export function validateRig(rig: Rig): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: string, message: string, ref?: string) => errors.push({ severity: 'error', code, message, ref });
  const warn = (code: string, message: string, ref?: string) => warnings.push({ severity: 'warning', code, message, ref });

  // --- version contract (§3) ---
  if (typeof rig.openrig_version !== 'string') {
    err('missing-version', 'openrig_version is required (semver major.minor)');
  } else {
    const major = Number(rig.openrig_version.split('.')[0]);
    const ourMajor = Number(OPENRIG_VERSION.split('.')[0]);
    if (Number.isFinite(major) && major > ourMajor) {
      err('unsupported-major', `openrig_version ${rig.openrig_version} has a higher major than this tool supports (${OPENRIG_VERSION}); refusing to load`);
    }
  }

  // --- node + port referential integrity ---
  const nodeById = new Map<string, Node>();
  const portsByNode = new Map<string, Set<string>>();
  for (const node of rig.nodes) {
    if (nodeById.has(node.id)) err('duplicate-node-id', `duplicate node id "${node.id}"`, node.id);
    nodeById.set(node.id, node);

    const portIds = new Set<string>();
    for (const port of node.ports) {
      if (portIds.has(port.id)) err('duplicate-port-id', `node "${node.id}" has a duplicate port id "${port.id}"`, node.id);
      portIds.add(port.id);
    }
    portsByNode.set(node.id, portIds);

    for (const role of node.roles) {
      if (!ROLES.includes(role as Role)) err('unknown-role', `node "${node.id}" has an unknown role "${role}" (use extra_roles for non-core roles)`, node.id);
    }
  }

  const resolvePort = (nodeId: string, portId: string): PortKind | undefined => {
    const node = nodeById.get(nodeId);
    if (node === undefined) return undefined;
    return node.ports.find((p) => p.id === portId)?.kind;
  };

  // --- edge referential integrity + port/signal compatibility ---
  const edgeIds = new Set<string>();
  for (const edge of rig.edges) {
    if (edgeIds.has(edge.id)) err('duplicate-edge-id', `duplicate edge id "${edge.id}"`, edge.id);
    edgeIds.add(edge.id);

    const fromKind = resolvePort(edge.from.node, edge.from.port);
    const toKind = resolvePort(edge.to.node, edge.to.port);
    if (fromKind === undefined) err('dangling-endpoint', `edge "${edge.id}" from endpoint ${edge.from.node}.${edge.from.port} does not resolve to a declared node+port`, edge.id);
    if (toKind === undefined) err('dangling-endpoint', `edge "${edge.id}" to endpoint ${edge.to.node}.${edge.to.port} does not resolve to a declared node+port`, edge.id);

    const sigKind = edge.signal.kind;
    if (fromKind !== undefined && !PORT_SIGNAL_COMPAT[fromKind].includes(sigKind)) {
      err('port-signal-mismatch', `edge "${edge.id}" carries a ${sigKind} signal but its from-port is a ${fromKind} port`, edge.id);
    }
    if (toKind !== undefined && !PORT_SIGNAL_COMPAT[toKind].includes(sigKind)) {
      err('port-signal-mismatch', `edge "${edge.id}" carries a ${sigKind} signal but its to-port is a ${toKind} port`, edge.id);
    }

    // --- per-signal channel rules (§3) ---
    if (edge.signal.kind === 'midi') {
      for (const sig of edge.signal.signals) {
        checkMidiSignalChannel(sig, edge.id, err);
      }
    }

    // --- binding reference resolves (deferred to the binding pass below) ---
  }

  // --- binding referential integrity (§4) ---
  const bindingIds = new Set<string>();
  for (const b of rig.bindings ?? []) {
    if (bindingIds.has(b.id)) err('duplicate-binding-id', `duplicate binding id "${b.id}"`, b.id);
    bindingIds.add(b.id);
    if (!nodeById.has(b.from.node)) err('binding-dangling-node', `binding "${b.id}" from.node "${b.from.node}" is not a node`, b.id);
    if (!nodeById.has(b.to.node)) err('binding-dangling-node', `binding "${b.id}" to.node "${b.to.node}" is not a node`, b.id);
    // The inner BindingEnd carries its own node ref (emits/expects); check it too.
    if (!nodeById.has(b.from.emits.node)) err('binding-dangling-node', `binding "${b.id}" from.emits.node "${b.from.emits.node}" is not a node`, b.id);
    if (!nodeById.has(b.to.expects.node)) err('binding-dangling-node', `binding "${b.id}" to.expects.node "${b.to.expects.node}" is not a node`, b.id);
  }
  // edges / routing that reference a binding must resolve to a declared one
  for (const edge of rig.edges) {
    if (edge.binding !== undefined && !bindingIds.has(edge.binding)) {
      err('dangling-binding-ref', `edge "${edge.id}" references binding "${edge.binding}" which is not declared`, edge.id);
    }
    // A governed signal references its binding per-signal (MidiSignal.binding),
    // which is the form a rig actually uses; check those, not only edge.binding.
    if (edge.signal.kind === 'midi') {
      for (const sig of edge.signal.signals) {
        if (sig.binding !== undefined && !bindingIds.has(sig.binding)) {
          err('dangling-binding-ref', `edge "${edge.id}" has a ${sig.type} signal referencing binding "${sig.binding}" which is not declared`, edge.id);
        }
      }
    }
  }
  for (const node of rig.nodes) {
    for (const group of [node.routing?.consume, node.routing?.pass, node.routing?.originate]) {
      for (const rule of group ?? []) {
        if (rule.binding !== undefined && !bindingIds.has(rule.binding)) {
          err('dangling-binding-ref', `node "${node.id}" routing references binding "${rule.binding}" which is not declared`, node.id);
        }
        if (!(portsByNode.get(node.id)?.has(rule.port) ?? false)) {
          err('routing-dangling-port', `node "${node.id}" routing references its own port "${rule.port}" which is not declared`, node.id);
        }
        if (rule.to !== undefined && !(portsByNode.get(node.id)?.has(rule.to) ?? false)) {
          err('routing-dangling-port', `node "${node.id}" routing "pass to" port "${rule.to}" is not declared`, node.id);
        }
      }
    }
  }

  // --- cheap graph checks (§6) ---
  detectMidiCycles(rig, nodeById, warn);
  checkClockWellFormedness(rig, nodeById, warn);

  return { ok: errors.length === 0, errors, warnings };
}

function checkMidiSignalChannel(
  sig: MidiSignal,
  edgeId: string,
  err: (code: string, message: string, ref?: string) => void,
): void {
  const hasChannel = sig.channel !== undefined;
  if (CHANNELLESS_MIDI.has(sig.type) && hasChannel) {
    err('channel-on-channelless', `edge "${edgeId}" ${sig.type} signal carries a channel; ${sig.type} has no MIDI channel`, edgeId);
  }
  if (hasChannel && !isValidChannel(sig.channel as number)) {
    err('bad-channel', `edge "${edgeId}" ${sig.type} signal channel ${sig.channel} is out of range (1-16)`, edgeId);
  }
}

/** One live MIDI cable, paired with the signals it declares. */
interface MidiHop { edge: Edge; signals: MidiSignal[] }

/** The enabled MIDI cables a signal can travel along. */
function midiHops(rig: Rig): MidiHop[] {
  const hops: MidiHop[] = [];
  for (const edge of rig.edges) {
    if (edge.enabled === false) continue;
    if (edge.signal.kind !== 'midi') continue;
    if (edge.from.node === edge.to.node) continue; // self-edge: node-internal transform, not a hop
    hops.push({ edge, signals: edge.signal.signals });
  }
  return hops;
}

/**
 * Find one routing-aware MIDI feedback loop: a signal that, relayed hop by hop,
 * arrives back on a cable it already travelled. Returns the signal and the node
 * path it rings around, or undefined.
 *
 * The walk carries the SIGNAL, because relaying preserves it and because that is
 * what makes the answer honest in both directions. A loop is reported only when
 * ONE signal closes the ring, so a node that consumes it (the AM4 eating the
 * clock it follows, then emitting its own CCs) breaks the path rather than
 * completing it; and a node the manifest says nothing about still relays, so an
 * undeclared rig warns exactly as loudly as it did before.
 *
 * Cables are the graph, not nodes: which PORT a signal arrives on and leaves by
 * is what `routing` keys on, and a node-level adjacency cannot express it.
 */
function findSignalLoop(
  rig: Rig,
  nodeById: Map<string, Node>,
  accepts: (sig: MidiSignal) => boolean,
): { sig: MidiSignal; path: string[] } | undefined {
  const hops = midiHops(rig);
  const edgeById = new Map(hops.map((h) => [h.edge.id, h.edge]));

  for (const start of hops) {
    for (const sig of start.signals) {
      if (!accepts(sig)) continue;
      // Cable-to-cable adjacency for THIS signal: a -> b when the node between
      // them relays it from a's arrival port out of b's departure port.
      const adj = new Map<string, Set<string>>();
      for (const a of hops) {
        for (const b of hops) {
          if (a.edge.to.node !== b.edge.from.node) continue;
          if (!relaysSignal(nodeById.get(a.edge.to.node), a.edge.to.port, b.edge.from.port, sig)) continue;
          if (!adj.has(a.edge.id)) adj.set(a.edge.id, new Set());
          adj.get(a.edge.id)!.add(b.edge.id);
        }
      }
      const cycle = findCycle(adj, [start.edge.id]);
      // findCycle returns [e, ..., e]; each cable's SOURCE node, in order, is the
      // ring (the last repeat closes it back to the first).
      if (cycle !== undefined) return { sig, path: cycle.map((id) => edgeById.get(id)!.from.node) };
    }
  }
  return undefined;
}

/** `cc ch5` / `clock`: a signal in the shape a warning should name it. */
function describeSignal(sig: MidiSignal): string {
  return sig.channel !== undefined ? `${sig.type} ch${sig.channel}` : sig.type;
}

/** Return one directed cycle in the adjacency, or undefined if acyclic. */
function findCycle(adj: Map<string, Set<string>>, nodeIds: Iterable<string>): string[] | undefined {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  let cycle: string[] | undefined;

  const visit = (n: string): boolean => {
    color.set(n, GRAY);
    stack.push(n);
    for (const m of adj.get(n) ?? []) {
      const c = color.get(m) ?? WHITE;
      if (c === GRAY) {
        cycle = stack.slice(stack.indexOf(m)).concat(m);
        return true;
      }
      if (c === WHITE && visit(m)) return true;
    }
    stack.pop();
    color.set(n, BLACK);
    return false;
  };

  for (const n of nodeIds) {
    if ((color.get(n) ?? WHITE) === WHITE && visit(n)) break;
  }
  return cycle;
}

function detectMidiCycles(
  rig: Rig,
  nodeById: Map<string, Node>,
  warn: (code: string, message: string, ref?: string) => void,
): void {
  const loop = findSignalLoop(rig, nodeById, () => true);
  if (loop !== undefined) {
    warn(
      'midi-cycle',
      `MIDI feedback loop detected: a ${describeSignal(loop.sig)} signal travels ${loop.path.join(' -> ')} and arrives back where it started. This is a common cause of stuck notes / runaway messages; break it with a node that CONSUMES rather than passes the signal (routing.consume), or a Thru=OFF / RX-channel setting the manifest should record.`,
    );
  }
}

function checkClockWellFormedness(
  rig: Rig,
  nodeById: Map<string, Node>,
  warn: (code: string, message: string, ref?: string) => void,
): void {
  const masters = rig.nodes.filter((n) => n.roles.includes('clock_master'));
  const followers = rig.nodes.filter((n) => n.roles.includes('clock_follower'));

  if (masters.length === 0 && followers.length > 0) {
    warn('no-clock-master', 'the rig has clock_follower node(s) but no clock_master; nothing generates the clock they expect');
  }
  if (masters.length > 1) {
    warn('multiple-clock-masters', `${masters.length} nodes are tagged clock_master (${masters.map((m) => m.id).join(', ')}); a rig should have exactly one clock source`);
  }

  // each clock_follower must actually receive a clock edge
  const receivesClock = new Set<string>();
  for (const edge of rig.edges) {
    if (edge.enabled === false) continue;
    if (edge.signal.kind === 'midi' && edge.signal.signals.some((s) => s.type === 'clock')) {
      receivesClock.add(edge.to.node);
    }
  }
  for (const f of followers) {
    if (!receivesClock.has(f.id)) {
      warn('orphaned-clock-follower', `node "${f.id}" is a clock_follower but no clock edge reaches it`, f.id);
    }
  }

  // the clock sub-graph must be acyclic (routing-aware, like the general check:
  // a follower that consumes the clock is the normal shape, not a ring)
  const clockLoop = findSignalLoop(rig, nodeById, (s) => s.type === 'clock');
  if (clockLoop !== undefined) {
    warn('clock-cycle', `the clock sub-graph has a cycle: ${clockLoop.path.join(' -> ')}. Clock must flow acyclically from one master.`);
  }
}
