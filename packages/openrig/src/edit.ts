/**
 * OpenRig structured EDIT: apply a small, well-typed change to a rig and return
 * the new rig. Pure and immutable (deep-clones, never mutates the input), so the
 * caller validates the RESULT before persisting. The reference implementation
 * (server) wraps this with file I/O + a backup + a validate-before-write gate.
 *
 * Op families:
 *   - cables: `add_cable` picks a FREE jack facing the right way on each device
 *     (or the one named by `from_port` / `to_port`), refuses a busy or
 *     wrong-direction jack instead of guessing, and CREATES a jack only on a
 *     device that declares none of a usable kind, so "connect the Hydra's audio
 *     to the RC-505" still just works on a skeletal rig; `update_cable`
 *     patches an existing edge IN PLACE (the §8 contract: re-cabling is a
 *     modify, the id is never regenerated); `add_signal` / `remove_signal`
 *     manage the multi-signal set one physical MIDI cable carries (§5.1).
 *   - devices: `add_device` / `update_device` / `remove_device`.
 *   - ports: `add_port` / `update_port` / `remove_port`; `update_port` carries
 *     `output_role`, without which an authored rig can never satisfy
 *     `checkAudioOutput`.
 *   - bindings: `add_binding` / `update_binding` / `remove_binding`, the §4
 *     authoring surface for the contract the schema calls authoritative.
 *   - routing: `set_routing` declares how a node transforms signals (§5.6).
 */
import {
  cablesOnPort, liveCablesOnPort, portAcceptsMultipleCables, portDirection,
} from './portRules.js';
import type {
  AudioChannel, Binding, BindingEnd, Edge, EdgeSignal, MidiSignal, MidiSignalType,
  Node, OutputRole, Port, PortKind, Rig, Role, Routing, SignalKind,
} from './types.js';

/**
 * What a physical cable IS, jack-to-jack. Wider than `SignalKind`: three cable
 * kinds carry MIDI (`midi` DIN out->in, `usb_midi`, `midi_thru` THRU->in), and
 * `cv` is the cable name for a `control_voltage` signal.
 */
export type CableKind =
  | 'audio'
  | 'midi'
  | 'usb_midi'
  | 'midi_thru'
  | 'cv'
  | 'expression'
  | 'footswitch'
  | 'analog_clock';

/** The MidiSignal payload fields an edit op states inline (no node/binding refs). */
export interface MidiSignalSpec {
  midi_type: MidiSignalType;
  channel?: number;
  cc?: number[];
  notes?: number[];
  note_map?: Record<string, string> | 'GM';
}

/** One end of a binding as an edit op states it (the node ref lives on the op). */
export interface BindingEndSpec {
  type: MidiSignalType;
  channel?: number;
  cc?: number;
  note_map?: Record<string, string> | 'GM';
  /** The receiver-side target this drives (e.g. RC-505 "TRK3 REC/PLY"). */
  target?: string;
  values?: number[];
}

export type RigEditOp =
  | {
      op: 'add_cable';
      /** Source device: node id or display name. */
      from: string;
      /** Destination device: node id or display name. */
      to: string;
      kind: CableKind;
      /**
       * The source jack, by port id. Omitted: the first FREE jack of a matching
       * kind that faces outward; refused when every such jack is busy or faces
       * inward. Given: used as-is, but refused when it cannot send this cable
       * (wrong kind, an input) or already holds a live cable while this one is
       * enabled.
       */
      from_port?: string;
      /** The destination jack, by port id. Same rules as `from_port`, facing inward. */
      to_port?: string;
      /** For MIDI-carrying kinds: the message type (default 'cc'). */
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
       * Patch an existing cable IN PLACE. The edge id is preserved (§8:
       * re-cabling is a modify, never delete+add, so `note` and identity
       * survive). MIDI payload fields patch ONE signal on the cable
       * (`signal_index`, default 0); `audio_channels` patches an audio edge.
       * Patching `midi_type` to a channelless type drops the signal's channel.
       */
      op: 'update_cable';
      cable_id: string;
      /** Which signal to patch when the cable carries several (default 0). */
      signal_index?: number;
      midi_type?: MidiSignalType;
      channel?: number;
      cc?: number[];
      notes?: number[];
      note_map?: Record<string, string> | 'GM';
      audio_channels?: AudioChannel[];
      enabled?: boolean;
      note?: string;
    }
  | {
      /** Append one more logical signal to a MIDI cable (§5.1: a physical cable carries a SET). */
      op: 'add_signal';
      cable_id: string;
      midi_type: MidiSignalType;
      channel?: number;
      cc?: number[];
      notes?: number[];
      note_map?: Record<string, string> | 'GM';
    }
  | {
      /**
       * Remove one logical signal from a MIDI cable, by index or by
       * type (+channel). Removing the LAST signal is refused: an empty cable is
       * a `remove_cable`, not a signal edit.
       */
      op: 'remove_signal';
      cable_id: string;
      signal_index?: number;
      midi_type?: MidiSignalType;
      channel?: number;
    }
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
      ports?: Array<Pick<Port, 'id' | 'kind' | 'label' | 'audio' | 'output_role' | 'direction'>>;
      note?: string;
    }
  | {
      /**
       * Patch a device in place: rename, re-role, bind/unbind the server
       * descriptor. The node id is preserved (§8). `roles`, when given, is the
       * full replacement set and must be non-empty. `server_device_id: null`
       * detaches the descriptor (the node degrades to opaque).
       */
      op: 'update_device';
      /** Node id or display name. */
      device: string;
      name?: string;
      roles?: Role[];
      manufacturer?: string | null;
      family?: string | null;
      server_device_id?: string | null;
      note?: string;
    }
  | {
      /** Remove a device AND every cable touching it (leaving them would dangle). */
      op: 'remove_device';
      /** Node id or display name. */
      device: string;
    }
  | {
      /** Add a jack to an existing device. */
      op: 'add_port';
      /** Node id or display name. */
      device: string;
      /** Port id, unique on the device. */
      id: string;
      kind: PortKind;
      label?: string;
      audio?: 'mono' | 'stereo';
      group?: string;
      pair?: string;
      output_role?: OutputRole;
      /** Which way the jack faces (see `Port.direction`). */
      direction?: 'in' | 'out';
    }
  | {
      /**
       * Patch a port in place. `output_role` is the field that lets an authored
       * rig satisfy `checkAudioOutput` (§3); `null` clears it. A port's KIND is
       * identity, not a patch: a different jack is remove_port + add_port.
       */
      op: 'update_port';
      device: string;
      port_id: string;
      label?: string;
      audio?: 'mono' | 'stereo';
      group?: string;
      pair?: string;
      output_role?: OutputRole | null;
      /** Correct which way the jack faces; `null` clears it (back to "either"). */
      direction?: 'in' | 'out' | null;
    }
  | {
      /**
       * Remove a port AND every cable attached to it (they would dangle), plus
       * any routing rule naming it. The caller is told which cables went.
       */
      op: 'remove_port';
      device: string;
      port_id: string;
    }
  | {
      /**
       * Author a §4 binding: the single authoritative contract for a governed
       * cross-device signal. `expects` defaults to the same signal as `emits`
       * (the contract's two ends agree by construction); state it only when the
       * receiver side genuinely differs or carries a `target`.
       */
      op: 'add_binding';
      /** Stable binding id, unique in the rig. */
      id: string;
      /** Sender device: node id or display name. */
      from: string;
      /** Receiver device: node id or display name. */
      to: string;
      emits: BindingEndSpec;
      expects?: BindingEndSpec;
      note?: string;
    }
  | {
      /**
       * Edit the CONTRACT: signal-level patches apply to BOTH ends at once
       * (CC#80 -> CC#20 updates emits and expects together, so the two ends
       * cannot drift apart through this op). `target` patches the receiver end
       * only. Patching `midi_type` to a channelless type drops both channels.
       */
      op: 'update_binding';
      binding_id: string;
      midi_type?: MidiSignalType;
      channel?: number;
      cc?: number;
      note_map?: Record<string, string> | 'GM';
      values?: number[];
      /** Receiver-side target label (expects end only). */
      target?: string;
      note?: string;
    }
  | {
      /**
       * Remove a binding. REFUSED while an edge, signal, or routing rule still
       * references it: silently de-governing a projection would change what a
       * routing rule matches, so the references must be updated or removed
       * first (batch the ops).
       */
      op: 'remove_binding';
      binding_id: string;
    }
  | {
      /**
       * Declare (or clear, with null) how a node transforms signals (§5.6:
       * consume / pass / originate). The FULL declaration replaces the node's
       * routing; absent routing means UNDECLARED, which every check treats
       * loudly (assumed to relay and to act).
       */
      op: 'set_routing';
      /** Node id or display name. */
      device: string;
      routing: Routing | null;
    };

export interface RigEditResult {
  ok: boolean;
  /** The new rig (when ok). Deep clone of the input with the edit applied. */
  rig?: Rig;
  /** Human one-line description of what changed. */
  summary?: string;
  /** The edge id added / removed / patched / toggled. */
  edge_id?: string;
  /** The node id added / patched / removed (device + port + routing ops). */
  node_id?: string;
  /** The port id added / patched / removed (port ops). */
  port_id?: string;
  /** The binding id added / patched / removed (binding ops). */
  binding_id?: string;
  /** Cable ids removed as collateral by `remove_device` / `remove_port`. */
  removed_edge_ids?: string[];
  /**
   * Applied, but worth saying: e.g. a [planned] cable that reserves a jack a
   * live cable still occupies (a re-cable in progress). Absent when empty.
   */
  warnings?: string[];
  /** Set when the edit could not be applied (device not found, cable not found). */
  error?: string;
}

/**
 * The port kinds a cable of each kind may leave from (`out`) and arrive at
 * (`in`), primary kind first. `auto` narrows `out` for implicit selection where
 * a legal jack would be the wrong GUESS: a MIDI THRU socket can carry a `midi`
 * cable (a sequencer in duplicate-out mode), but only the caller knows that, so
 * it must be named with `from_port`. The TRS control kinds accept each other
 * (dual-mode "CTL/EXP" jacks), matching validate.ts.
 */
const CABLE_PORT_KINDS: Record<CableKind, { out: PortKind[]; in: PortKind[]; autoOut?: PortKind[] }> = {
  audio: { out: ['audio_out'], in: ['audio_in'] },
  midi: { out: ['midi_din_out', 'midi_thru'], in: ['midi_din_in'], autoOut: ['midi_din_out'] },
  usb_midi: { out: ['usb_midi'], in: ['usb_midi'] },
  midi_thru: { out: ['midi_thru'], in: ['midi_din_in'] },
  cv: { out: ['cv'], in: ['cv'] },
  expression: { out: ['expression', 'footswitch'], in: ['expression', 'footswitch'] },
  footswitch: { out: ['footswitch', 'expression'], in: ['footswitch', 'expression'] },
  analog_clock: { out: ['analog_clock'], in: ['analog_clock'] },
};
/** Kinds whose jacks face either way, so a CREATED one is stamped with the side it was created for. */
const DIRECTIONLESS_KINDS = new Set<PortKind>(['expression', 'footswitch', 'cv', 'analog_clock']);
const KIND_LABEL: Record<CableKind, string> = {
  audio: 'audio', midi: 'MIDI', usb_midi: 'USB MIDI', midi_thru: 'MIDI THRU',
  cv: 'CV', expression: 'expression', footswitch: 'footswitch', analog_clock: 'analog clock',
};
/** The signal kind a cable of each kind carries (three cable kinds carry MIDI). */
const SIGNAL_KIND: Record<CableKind, SignalKind> = {
  audio: 'audio', midi: 'midi', usb_midi: 'midi', midi_thru: 'midi',
  cv: 'control_voltage', expression: 'expression', footswitch: 'footswitch', analog_clock: 'analog_clock',
};
/** MIDI signal types that carry NO channel (§3); mirrors validate.ts. */
const CHANNELLESS_MIDI = new Set<MidiSignalType>(['clock', 'transport', 'active_sensing', 'sysex', 'spp', 'song_select']);

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

/** Create a jack of `kind` on a node that declares none (the skeletal-node convenience). */
function createPort(node: Node, kind: PortKind, dir: 'out' | 'in'): string {
  let id: string;
  if (kind === 'footswitch') id = dir === 'out' ? 'sw' : 'footswitch_in';
  else if (kind === 'midi_thru') id = 'thru';
  else if (kind === 'usb_midi') id = 'usb';
  else {
    const base = kind.replace('_din', '').replace('_out', '').replace('_in', '');
    id = `${base}_${dir}`;
  }
  const taken = new Set(node.ports.map((p) => p.id));
  let n = 2;
  const root = id;
  while (taken.has(id)) id = `${root}${n++}`;
  const port: Port = { id, kind, label: id.replace(/_/g, ' ').toUpperCase() };
  if (DIRECTIONLESS_KINDS.has(kind)) port.direction = dir;
  node.ports.push(port);
  return id;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** `out1 (quadra-to-hydra), out4 (quadra-to-am4 [planned])`: what occupies each jack. */
function describeOccupants(rig: Rig, node: Node, ports: Port[]): string {
  return ports.map((p) => {
    const occ = cablesOnPort(rig, node.id, p.id);
    return `${p.id} (${occ.map((o) => `${o.edge_id}${o.enabled ? '' : ' [planned]'}`).join(', ')})`;
  }).join(', ');
}

/**
 * Pick (or check) the jack one end of a new cable plugs into. The rules
 * (portRules.ts): the jack must be a kind this cable can use, must face the
 * right way, and must not already hold a live cable unless it is a summing input
 * or the new cable is only [planned]. Implicit selection takes the first FREE
 * jack (no cable at all, planned included) and REFUSES rather than guess when
 * every candidate is busy; it creates a jack only when the device declares none
 * of a usable kind.
 */
function resolveCableEnd(
  rig: Rig, node: Node, kind: CableKind, end: 'out' | 'in', explicit: string | undefined,
  enabled: boolean, warnings: string[],
): { port: string } | { error: string } {
  const rules = CABLE_PORT_KINDS[kind];
  const legal = end === 'out' ? rules.out : rules.in;
  const endWord = end === 'out' ? 'output' : 'input';
  const argName = end === 'out' ? 'from_port' : 'to_port';
  const wrongWay = end === 'out' ? 'sink' : 'source';
  const facingWord = end === 'out' ? 'an INPUT' : 'an OUTPUT';
  const cableWord = `${KIND_LABEL[kind]} cable`;

  if (explicit !== undefined) {
    const port = node.ports.find((p) => p.id === explicit);
    if (port === undefined) {
      const usable = node.ports.filter((p) => legal.includes(p.kind)).map((p) => p.id);
      return { error: `${node.name} has no port "${explicit}"${usable.length > 0 ? `; its ports this ${cableWord} can use: ${usable.join(', ')}` : ''}` };
    }
    if (!legal.includes(port.kind)) {
      return { error: `${node.name}.${port.id} is a jack of kind ${port.kind}; this ${cableWord} can only ${end === 'out' ? 'leave from' : 'arrive at'} ${legal.join(' or ')}` };
    }
    if (portDirection(port) === wrongWay) {
      return { error: `${node.name}.${port.id} is ${facingWord} (${port.kind}); a cable cannot ${end === 'out' ? 'leave from' : 'arrive at'} it` };
    }
    const live = liveCablesOnPort(rig, node.id, port.id);
    if (live.length > 0 && !portAcceptsMultipleCables(node, port)) {
      const ids = live.map((o) => o.edge_id).join(', ');
      if (enabled) {
        return { error: `${node.name}.${port.id} already holds live cable ${ids}, and a jack takes one plug. Remove or disable ${ids} first, or add this cable with enabled:false as a planned re-cable.` };
      }
      warnings.push(`${node.name}.${port.id} still holds live cable ${ids}; this [planned] cable reserves the same jack. When you re-cable, disable ${ids} before enabling this one.`);
    }
    return { port: port.id };
  }

  const autoKinds = end === 'out' ? (rules.autoOut ?? rules.out) : rules.in;
  const candidates = autoKinds.flatMap((k) => node.ports.filter((p) => p.kind === k));
  if (candidates.length === 0) return { port: createPort(node, autoKinds[0], end) };

  const facing = candidates.filter((p) => portDirection(p) !== wrongWay);
  if (facing.length === 0) {
    const ids = candidates.map((p) => p.id).join(', ');
    const many = candidates.length > 1;
    const faces = end === 'out' ? (many ? 'are INPUTS' : 'is an INPUT') : (many ? 'are OUTPUTS' : 'is an OUTPUT');
    return {
      error: `The ${plural(candidates.length, 'jack', 'jacks')} on ${node.name} this ${cableWord} could use (${ids}) ${faces}: a cable cannot ${end === 'out' ? 'leave from' : 'arrive at'} ${many ? 'them' : 'it'}, so ${node.name} has no ${KIND_LABEL[kind]} ${endWord} to cable ${end === 'out' ? 'from' : 'into'}.`,
    };
  }
  const free = facing.find((p) => cablesOnPort(rig, node.id, p.id).length === 0);
  if (free !== undefined) return { port: free.id };
  const summing = facing.find((p) => portAcceptsMultipleCables(node, p));
  if (summing !== undefined) return { port: summing.id };
  return {
    error: `${node.name} has no free ${KIND_LABEL[kind]} ${endWord}: ${describeOccupants(rig, node, facing)}. Pass ${argName} to choose a jack deliberately (with enabled:false for a planned re-cable), or free one with remove_cable / set_cable_enabled first.`,
  };
}

/**
 * Why a cable cannot go live: another live cable already plugs into one of its
 * jacks (a duplex partner does not count). Undefined when it can.
 */
function enableConflict(rig: Rig, edge: Edge): string | undefined {
  for (const end of [edge.from, edge.to]) {
    const node = rig.nodes.find((n) => n.id === end.node);
    const port = node?.ports.find((p) => p.id === end.port);
    if (node === undefined || port === undefined || portAcceptsMultipleCables(node, port)) continue;
    const live = liveCablesOnPort(rig, node.id, port.id, edge);
    if (live.length > 0) {
      const ids = live.map((o) => o.edge_id).join(', ');
      return `cannot enable cable ${edge.id}: ${node.name}.${port.id} already holds live cable ${ids}, and a jack takes one plug. Disable or remove ${ids} first.`;
    }
  }
  return undefined;
}

/** A stable-but-unique id derived from a semantic base. */
function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function buildMidiSignal(spec: MidiSignalSpec): MidiSignal {
  const sig: MidiSignal = { type: spec.midi_type };
  if (spec.channel !== undefined) sig.channel = spec.channel;
  if (spec.cc !== undefined) sig.cc_numbers = spec.cc;
  if (spec.notes !== undefined) sig.notes = spec.notes;
  if (spec.note_map !== undefined) sig.note_map = spec.note_map;
  return sig;
}

function buildSignal(op: Extract<RigEditOp, { op: 'add_cable' }>): EdgeSignal {
  if (op.kind === 'audio') {
    return { kind: 'audio', channels: op.audio_channels ?? ['L', 'R'] };
  }
  if (op.kind === 'footswitch' || op.kind === 'expression' || op.kind === 'analog_clock' || op.kind === 'cv') {
    const kind = op.kind === 'cv' ? 'control_voltage' : op.kind;
    return { kind, label: op.note ?? KIND_LABEL[op.kind] };
  }
  // midi / usb_midi / midi_thru all carry a MIDI signal set
  return { kind: 'midi', signals: [buildMidiSignal({ midi_type: op.midi_type ?? 'cc', channel: op.channel, cc: op.cc, notes: op.notes, note_map: op.note_map })] };
}

/** `cc ch5` / `clock`: a signal in the shape a summary should name it. */
function describeSignal(sig: MidiSignal): string {
  return sig.channel !== undefined ? `${sig.type} ch${sig.channel}` : sig.type;
}

/** Apply a structured edit to a rig. Pure: returns a new rig, never mutates input. */
export function applyRigEdit(rig: Rig, op: RigEditOp): RigEditResult {
  const next = clone(rig);

  switch (op.op) {
    case 'add_cable': {
      const from = findNode(next, op.from);
      const to = findNode(next, op.to);
      if (from === undefined) return { ok: false, error: `no device matches "${op.from}"` };
      if (to === undefined) return { ok: false, error: `no device matches "${op.to}"` };
      if (from.id === to.id) return { ok: false, error: 'a cable must connect two different devices' };
      const enabled = op.enabled !== false;
      const warnings: string[] = [];
      const fromEnd = resolveCableEnd(next, from, op.kind, 'out', op.from_port, enabled, warnings);
      if ('error' in fromEnd) return { ok: false, error: fromEnd.error };
      const toEnd = resolveCableEnd(next, to, op.kind, 'in', op.to_port, enabled, warnings);
      if ('error' in toEnd) return { ok: false, error: toEnd.error };
      const fromPort = fromEnd.port;
      const toPort = toEnd.port;
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
      return {
        ok: true, rig: next, edge_id: id,
        summary: `added ${KIND_LABEL[op.kind]} cable ${from.name}.${fromPort} -> ${to.name}.${toPort}${op.enabled === false ? ' [planned]' : ''}`,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    case 'update_cable': {
      const edge = next.edges.find((e) => e.id === op.cable_id);
      if (edge === undefined) return { ok: false, error: `no cable with id "${op.cable_id}"` };
      const midiFields = op.midi_type !== undefined || op.channel !== undefined || op.cc !== undefined
        || op.notes !== undefined || op.note_map !== undefined;
      if (!midiFields && op.audio_channels === undefined && op.enabled === undefined && op.note === undefined
        && op.signal_index === undefined) {
        return { ok: false, error: `update_cable "${op.cable_id}": nothing to change (pass at least one field to patch)` };
      }
      const changed: string[] = [];
      if (midiFields || op.signal_index !== undefined) {
        if (edge.signal.kind !== 'midi') {
          return { ok: false, error: `cable "${edge.id}" carries ${edge.signal.kind}, not MIDI; midi_type/channel/cc/notes/note_map do not apply` };
        }
        const idx = op.signal_index ?? 0;
        const sig = edge.signal.signals[idx];
        if (sig === undefined) {
          return { ok: false, error: `cable "${edge.id}" has ${edge.signal.signals.length} signal(s); signal_index ${idx} does not exist` };
        }
        if (op.midi_type !== undefined) {
          sig.type = op.midi_type;
          if (CHANNELLESS_MIDI.has(op.midi_type)) delete sig.channel;
          changed.push(`type=${op.midi_type}`);
        }
        if (op.channel !== undefined) { sig.channel = op.channel; changed.push(`ch${op.channel}`); }
        if (op.cc !== undefined) { sig.cc_numbers = op.cc; changed.push(`cc=[${op.cc.join(',')}]`); }
        if (op.notes !== undefined) { sig.notes = op.notes; changed.push(`notes=[${op.notes.join(',')}]`); }
        if (op.note_map !== undefined) { sig.note_map = op.note_map; changed.push('note_map'); }
      }
      if (op.audio_channels !== undefined) {
        if (edge.signal.kind !== 'audio') {
          return { ok: false, error: `cable "${edge.id}" carries ${edge.signal.kind}, not audio; audio_channels does not apply` };
        }
        edge.signal.channels = [...op.audio_channels];
        changed.push(`channels=[${op.audio_channels.join(',')}]`);
      }
      if (op.enabled !== undefined) {
        if (op.enabled && edge.enabled === false) {
          const conflict = enableConflict(next, edge);
          if (conflict !== undefined) return { ok: false, error: conflict };
        }
        if (op.enabled) delete edge.enabled; else edge.enabled = false;
        changed.push(op.enabled ? 'enabled' : 'disabled ([planned])');
      }
      if (op.note !== undefined) { edge.note = op.note; changed.push('note'); }
      return { ok: true, rig: next, edge_id: edge.id, summary: `updated cable ${edge.id}: ${changed.join(', ')}` };
    }

    case 'add_signal': {
      const edge = next.edges.find((e) => e.id === op.cable_id);
      if (edge === undefined) return { ok: false, error: `no cable with id "${op.cable_id}"` };
      if (edge.signal.kind !== 'midi') {
        return { ok: false, error: `cable "${edge.id}" carries ${edge.signal.kind}, not MIDI; only a MIDI cable carries a signal set (§5.1)` };
      }
      const sig = buildMidiSignal({ midi_type: op.midi_type, channel: op.channel, cc: op.cc, notes: op.notes, note_map: op.note_map });
      edge.signal.signals.push(sig);
      return {
        ok: true, rig: next, edge_id: edge.id,
        summary: `added ${describeSignal(sig)} signal to cable ${edge.id} (now ${edge.signal.signals.length} signals)`,
      };
    }

    case 'remove_signal': {
      const edge = next.edges.find((e) => e.id === op.cable_id);
      if (edge === undefined) return { ok: false, error: `no cable with id "${op.cable_id}"` };
      if (edge.signal.kind !== 'midi') {
        return { ok: false, error: `cable "${edge.id}" carries ${edge.signal.kind}, not MIDI; there is no signal set to edit` };
      }
      const signals = edge.signal.signals;
      let idx: number;
      if (op.signal_index !== undefined) {
        if (signals[op.signal_index] === undefined) {
          return { ok: false, error: `cable "${edge.id}" has ${signals.length} signal(s); signal_index ${op.signal_index} does not exist` };
        }
        idx = op.signal_index;
      } else if (op.midi_type !== undefined) {
        const matches = signals
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => s.type === op.midi_type && (op.channel === undefined || s.channel === op.channel));
        if (matches.length === 0) {
          return { ok: false, error: `cable "${edge.id}" has no ${op.midi_type}${op.channel !== undefined ? ` ch${op.channel}` : ''} signal` };
        }
        if (matches.length > 1) {
          return { ok: false, error: `cable "${edge.id}" has ${matches.length} ${op.midi_type} signals; disambiguate with channel or signal_index` };
        }
        idx = matches[0].i;
      } else {
        return { ok: false, error: 'remove_signal needs signal_index, or midi_type (with optional channel)' };
      }
      if (signals.length === 1) {
        return { ok: false, error: `cable "${edge.id}" carries only that one signal; a cable with no signals is malformed, so remove the cable itself (remove_cable)` };
      }
      const [removed] = signals.splice(idx, 1);
      return {
        ok: true, rig: next, edge_id: edge.id,
        summary: `removed ${describeSignal(removed)} signal from cable ${edge.id} (${signals.length} remain)`,
      };
    }

    case 'add_device': {
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

    case 'update_device': {
      const node = findNode(next, op.device);
      if (node === undefined) return { ok: false, error: `no device matches "${op.device}"` };
      if (op.name === undefined && op.roles === undefined && op.manufacturer === undefined
        && op.family === undefined && op.server_device_id === undefined && op.note === undefined) {
        return { ok: false, error: `update_device "${node.name}": nothing to change (pass at least one field to patch)` };
      }
      const changed: string[] = [];
      if (op.name !== undefined) {
        changed.push(`renamed "${node.name}" -> "${op.name}"`);
        node.name = op.name;
      }
      if (op.roles !== undefined) {
        if (op.roles.length === 0) {
          return { ok: false, error: 'a device needs at least one role (the checks key on roles: an instrument with no sound_source role is invisible to the audio check)' };
        }
        node.roles = [...op.roles];
        changed.push(`roles=[${op.roles.join(', ')}]`);
      }
      if (op.manufacturer !== undefined) { node.identity.manufacturer = op.manufacturer; changed.push('manufacturer'); }
      if (op.family !== undefined) { node.identity.family = op.family; changed.push('family'); }
      if (op.server_device_id !== undefined) {
        node.server_device_id = op.server_device_id;
        changed.push(op.server_device_id === null ? 'detached server descriptor (opaque)' : `server_device_id=${op.server_device_id}`);
      }
      if (op.note !== undefined) { node.note = op.note; changed.push('note'); }
      return { ok: true, rig: next, node_id: node.id, summary: `updated device ${node.name}: ${changed.join(', ')}` };
    }

    case 'remove_device': {
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

    case 'add_port': {
      const node = findNode(next, op.device);
      if (node === undefined) return { ok: false, error: `no device matches "${op.device}"` };
      if (op.id.trim().length === 0) return { ok: false, error: 'a port needs a non-empty id' };
      if (node.ports.some((p) => p.id === op.id)) {
        return { ok: false, error: `device ${node.name} already has a port "${op.id}"` };
      }
      const port: Port = { id: op.id, kind: op.kind };
      if (op.label !== undefined) port.label = op.label;
      if (op.audio !== undefined) port.audio = op.audio;
      if (op.group !== undefined) port.group = op.group;
      if (op.pair !== undefined) port.pair = op.pair;
      if (op.output_role !== undefined) port.output_role = op.output_role;
      if (op.direction !== undefined) port.direction = op.direction;
      node.ports.push(port);
      return {
        ok: true, rig: next, node_id: node.id, port_id: port.id,
        summary: `added ${op.kind} port "${port.id}" to ${node.name}${op.output_role !== undefined ? ` (output_role: ${op.output_role})` : ''}`,
      };
    }

    case 'update_port': {
      const node = findNode(next, op.device);
      if (node === undefined) return { ok: false, error: `no device matches "${op.device}"` };
      const port = node.ports.find((p) => p.id === op.port_id);
      if (port === undefined) return { ok: false, error: `device ${node.name} has no port "${op.port_id}"` };
      if (op.label === undefined && op.audio === undefined && op.group === undefined
        && op.pair === undefined && op.output_role === undefined && op.direction === undefined) {
        return { ok: false, error: `update_port "${port.id}": nothing to change (pass at least one field to patch)` };
      }
      const changed: string[] = [];
      if (op.label !== undefined) { port.label = op.label; changed.push('label'); }
      if (op.audio !== undefined) { port.audio = op.audio; changed.push(`audio=${op.audio}`); }
      if (op.group !== undefined) { port.group = op.group; changed.push(`group=${op.group}`); }
      if (op.pair !== undefined) { port.pair = op.pair; changed.push(`pair=${op.pair}`); }
      if (op.output_role !== undefined) {
        if (op.output_role === null) { delete port.output_role; changed.push('output_role cleared'); }
        else { port.output_role = op.output_role; changed.push(`output_role=${op.output_role}`); }
      }
      if (op.direction !== undefined) {
        if (op.direction === null) { delete port.direction; changed.push('direction cleared'); }
        else { port.direction = op.direction; changed.push(`direction=${op.direction}`); }
      }
      return { ok: true, rig: next, node_id: node.id, port_id: port.id, summary: `updated port ${node.name}.${port.id}: ${changed.join(', ')}` };
    }

    case 'remove_port': {
      const node = findNode(next, op.device);
      if (node === undefined) return { ok: false, error: `no device matches "${op.device}"` };
      const port = node.ports.find((p) => p.id === op.port_id);
      if (port === undefined) return { ok: false, error: `device ${node.name} has no port "${op.port_id}"` };
      // Cables attached to a removed port would dangle, so they go with it.
      const doomed = next.edges.filter((e) =>
        (e.from.node === node.id && e.from.port === port.id)
        || (e.to.node === node.id && e.to.port === port.id));
      next.edges = next.edges.filter((e) => !doomed.includes(e));
      node.ports = node.ports.filter((p) => p.id !== port.id);
      // A routing rule naming the removed port would dangle (routing-dangling-port).
      const routing = node.routing;
      if (routing !== undefined) {
        for (const key of ['consume', 'pass', 'originate'] as const) {
          const rules = routing[key];
          if (rules !== undefined) {
            routing[key] = rules.filter((r) => r.port !== port.id && r.to !== port.id);
          }
        }
      }
      return {
        ok: true, rig: next, node_id: node.id, port_id: port.id, removed_edge_ids: doomed.map((e) => e.id),
        summary: `removed port ${node.name}.${port.id}${doomed.length > 0 ? ` and ${doomed.length} cable${doomed.length === 1 ? '' : 's'} attached to it` : ''}`,
      };
    }

    case 'add_binding': {
      const from = findNode(next, op.from);
      const to = findNode(next, op.to);
      if (from === undefined) return { ok: false, error: `no device matches "${op.from}"` };
      if (to === undefined) return { ok: false, error: `no device matches "${op.to}"` };
      if (op.id.trim().length === 0) return { ok: false, error: 'a binding needs a non-empty id' };
      if ((next.bindings ?? []).some((b) => b.id === op.id)) {
        return { ok: false, error: `a binding with id "${op.id}" is already in this rig. Binding ids are stable; edit it with update_binding.` };
      }
      const emits: BindingEnd = { node: from.id, ...bindingEndFields(op.emits) };
      // The contract's two ends agree by construction when `expects` is omitted
      // (target is receiver-side, so it never copies over from emits).
      const expectsSpec = op.expects ?? { ...op.emits, target: undefined };
      const expects: BindingEnd = { node: to.id, ...bindingEndFields(expectsSpec) };
      const binding: Binding = { id: op.id, from: { node: from.id, emits }, to: { node: to.id, expects } };
      if (op.note !== undefined) binding.note = op.note;
      next.bindings = [...(next.bindings ?? []), binding];
      return {
        ok: true, rig: next, binding_id: binding.id,
        summary: `added binding ${binding.id}: ${from.name} ${describeBindingEnd(emits)} -> ${to.name}${expects.target !== undefined ? ` (${expects.target})` : ''}`,
      };
    }

    case 'update_binding': {
      const binding = (next.bindings ?? []).find((b) => b.id === op.binding_id);
      if (binding === undefined) return { ok: false, error: `no binding with id "${op.binding_id}"` };
      if (op.midi_type === undefined && op.channel === undefined && op.cc === undefined
        && op.note_map === undefined && op.values === undefined && op.target === undefined && op.note === undefined) {
        return { ok: false, error: `update_binding "${binding.id}": nothing to change (pass at least one field to patch)` };
      }
      const changed: string[] = [];
      const both = [binding.from.emits, binding.to.expects];
      if (op.midi_type !== undefined) {
        for (const end of both) {
          end.type = op.midi_type;
          if (CHANNELLESS_MIDI.has(op.midi_type)) delete end.channel;
        }
        changed.push(`type=${op.midi_type}`);
      }
      if (op.channel !== undefined) { for (const end of both) end.channel = op.channel; changed.push(`ch${op.channel}`); }
      if (op.cc !== undefined) { for (const end of both) end.cc = op.cc; changed.push(`cc#${op.cc}`); }
      if (op.note_map !== undefined) { for (const end of both) end.note_map = op.note_map; changed.push('note_map'); }
      if (op.values !== undefined) { for (const end of both) end.values = [...op.values]; changed.push('values'); }
      if (op.target !== undefined) { binding.to.expects.target = op.target; changed.push(`target=${op.target}`); }
      if (op.note !== undefined) { binding.note = op.note; changed.push('note'); }
      return { ok: true, rig: next, binding_id: binding.id, summary: `updated binding ${binding.id}: ${changed.join(', ')} (both ends stay in agreement)` };
    }

    case 'remove_binding': {
      const binding = (next.bindings ?? []).find((b) => b.id === op.binding_id);
      if (binding === undefined) return { ok: false, error: `no binding with id "${op.binding_id}"` };
      const referents: string[] = [];
      for (const e of next.edges) {
        if (e.binding === binding.id) referents.push(`cable ${e.id}`);
        else if (e.signal.kind === 'midi' && e.signal.signals.some((s) => s.binding === binding.id)) {
          referents.push(`cable ${e.id} (signal)`);
        }
      }
      for (const n of next.nodes) {
        const rules = [...(n.routing?.consume ?? []), ...(n.routing?.pass ?? []), ...(n.routing?.originate ?? [])];
        if (rules.some((r) => r.binding === binding.id)) referents.push(`device ${n.id} routing`);
      }
      if (referents.length > 0) {
        return {
          ok: false,
          error: `binding "${binding.id}" is still referenced by: ${referents.join(', ')}. De-govern or remove those first (update_cable / set_routing / remove_cable), then remove the binding; the ops can ride one batch.`,
        };
      }
      next.bindings = (next.bindings ?? []).filter((b) => b.id !== binding.id);
      return { ok: true, rig: next, binding_id: binding.id, summary: `removed binding ${binding.id}` };
    }

    case 'set_routing': {
      const node = findNode(next, op.device);
      if (node === undefined) return { ok: false, error: `no device matches "${op.device}"` };
      if (op.routing === null) {
        const had = node.routing !== undefined;
        delete node.routing;
        return {
          ok: true, rig: next, node_id: node.id,
          summary: had
            ? `cleared routing on ${node.name} (back to undeclared: every check treats it loudly)`
            : `${node.name} had no routing declared; nothing to clear`,
        };
      }
      const counts = (['consume', 'pass', 'originate'] as const)
        .map((key) => {
          const rules = op.routing?.[key];
          return rules !== undefined && rules.length > 0 ? `${rules.length} ${key}` : undefined;
        })
        .filter((s): s is string => s !== undefined);
      node.routing = JSON.parse(JSON.stringify(op.routing)) as Routing;
      return {
        ok: true, rig: next, node_id: node.id,
        summary: `declared routing on ${node.name}${counts.length > 0 ? ` (${counts.join(', ')})` : ''}`,
      };
    }

    case 'remove_cable': {
      const edge = resolveEdge(next, op);
      if (edge === undefined) return { ok: false, error: describeMissingEdge(op) };
      next.edges = next.edges.filter((e) => e.id !== edge.id);
      return { ok: true, rig: next, edge_id: edge.id, summary: `removed cable ${edge.id} (${nodeName(next, edge.from.node)} -> ${nodeName(next, edge.to.node)})` };
    }

    case 'set_cable_enabled': {
      const edge = next.edges.find((e) => e.id === op.cable_id);
      if (edge === undefined) return { ok: false, error: `no cable with id "${op.cable_id}"` };
      if (op.enabled && edge.enabled === false) {
        const conflict = enableConflict(next, edge);
        if (conflict !== undefined) return { ok: false, error: conflict };
      }
      if (op.enabled) delete edge.enabled; else edge.enabled = false;
      return { ok: true, rig: next, edge_id: edge.id, summary: `cable ${edge.id} set ${op.enabled ? 'enabled' : 'disabled ([planned])'}` };
    }

    default: {
      // Exhaustiveness gate: a new RigEditOp variant fails to compile here
      // instead of silently falling through to some other op's handler.
      const unhandled: never = op;
      return { ok: false, error: `unknown edit op "${(unhandled as { op: string }).op}"` };
    }
  }
}

/** The signal fields of a BindingEndSpec, shaped for a BindingEnd (no node ref). */
function bindingEndFields(spec: BindingEndSpec): Omit<BindingEnd, 'node'> {
  const out: Omit<BindingEnd, 'node'> = { type: spec.type };
  if (spec.channel !== undefined) out.channel = spec.channel;
  if (spec.cc !== undefined) out.cc = spec.cc;
  if (spec.note_map !== undefined) out.note_map = spec.note_map;
  if (spec.target !== undefined) out.target = spec.target;
  if (spec.values !== undefined) out.values = [...spec.values];
  return out;
}

function describeBindingEnd(end: BindingEnd): string {
  const bits: string[] = [end.type];
  if (end.cc !== undefined) bits.push(`#${end.cc}`);
  if (end.channel !== undefined) bits.push(`ch${end.channel}`);
  return bits.join(' ');
}

function resolveEdge(rig: Rig, op: Extract<RigEditOp, { op: 'remove_cable' }>): Edge | undefined {
  if (op.cable_id !== undefined) return rig.edges.find((e) => e.id === op.cable_id);
  const from = op.from !== undefined ? findNode(rig, op.from) : undefined;
  const to = op.to !== undefined ? findNode(rig, op.to) : undefined;
  return rig.edges.find((e) =>
    (from === undefined || e.from.node === from.id)
    && (to === undefined || e.to.node === to.id)
    && (op.kind === undefined || e.signal.kind === SIGNAL_KIND[op.kind]));
}

function describeMissingEdge(op: Extract<RigEditOp, { op: 'remove_cable' }>): string {
  if (op.cable_id !== undefined) return `no cable with id "${op.cable_id}"`;
  return `no cable matches from="${op.from ?? '*'}" to="${op.to ?? '*'}" kind="${op.kind ?? '*'}"`;
}

function nodeName(rig: Rig, id: string): string {
  return rig.nodes.find((n) => n.id === id)?.name ?? id;
}
