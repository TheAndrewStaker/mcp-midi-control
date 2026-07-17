/**
 * OpenRig L1 domain model: a musician's rig as a directed multigraph of
 * instruments (nodes) connected by typed audio + MIDI cables (edges), with an
 * optional capability layer and editable cross-device bindings.
 *
 * This is the TypeScript projection of the normative JSON Schema
 * (`schema/rig.schema.json`). Section references (§) point at the design doc
 * `docs/design/OPENRIG-SCHEMA.md` in the reference-implementation repo.
 *
 * Design invariants encoded here:
 *   - A physical cable carries a SET of logical signals, never a single "midi"
 *     type (§5.1). One edge = one physical link with `signal.signals[]`.
 *   - A MIDI channel (1-16) is a property of a SIGNAL, never a port or node
 *     (§5.2). `clock` and `transport` carry no channel and are DISTINCT (§3).
 *   - A node transforms signals: `routing` records consume / pass / originate so
 *     reachability is computed THROUGH a node, not by assuming a cable's signals
 *     arrive intact downstream (§5.6).
 *   - Capability is OPTIONAL and progressive; opaque gear is a first-class node
 *     with `capabilities: null` (§4).
 *   - A cross-device contract lives ONCE in a `binding`; edges/routing derive
 *     from it (§4). The binding is the single source of truth for a governed
 *     signal.
 */

/** Current OpenRig spec major.minor. Consumers MUST reject a higher MAJOR. */
export const OPENRIG_VERSION = '0.1';

// ---------------------------------------------------------------------------
// Enums (grow only in a MINOR bump; a removal/retype is a MAJOR bump, §3)
// ---------------------------------------------------------------------------

/** Physical endpoint kind on a node (§3, `ports[].kind`). */
export type PortKind =
  | 'audio_out'
  | 'audio_in'
  | 'midi_din_in'
  | 'midi_din_out'
  | 'midi_thru'
  | 'usb_midi'
  | 'usb_serial'
  | 'expression'
  | 'footswitch'
  | 'cv'
  | 'analog_clock';

/**
 * Fixed core role enum (§3). Multi-valued: a node holds every role that
 * applies. Stored flat; grouped here by dimension for readability. Comparison
 * and diff key on this set, never on `extra_roles`.
 */
export type Role =
  // audio
  | 'sound_source'
  | 'effect'
  | 'mixer'
  | 'monitor'
  | 'audio_interface'
  // control
  | 'controller'
  | 'clock_master'
  | 'clock_follower'
  | 'midi_router'
  | 'host'
  // performance
  | 'looper'
  | 'sequencer'
  | 'sampler';

export const ROLES: readonly Role[] = [
  'sound_source', 'effect', 'mixer', 'monitor', 'audio_interface',
  'controller', 'clock_master', 'clock_follower', 'midi_router', 'host',
  'looper', 'sequencer', 'sampler',
];

/**
 * Signal kind on an edge (§3). A strict superset of the non-audio, non-MIDI
 * port kinds, so every port kind has an edge type that can attach to it.
 */
export type SignalKind =
  | 'audio'
  | 'midi'
  | 'control_voltage'
  | 'expression'
  | 'footswitch'
  | 'analog_clock';

/**
 * MIDI message type for a `kind: "midi"` signal (§3). `clock` and `transport`
 * are DISTINCT (a rig runs clock with transport off); folding them would make
 * two differently-configured rigs diff as identical.
 */
export type MidiSignalType =
  | 'clock'
  | 'transport'
  | 'spp'
  | 'song_select'
  | 'pc'
  | 'cc'
  | 'nrpn'
  | 'note'
  | 'sysex'
  | 'active_sensing';

/** A MIDI channel is 1-16 (a property of a signal, never a port/node, §5.2). */
export type MidiChannel = number;

/** Audio channel label on an audio edge: L, R, or M (mono). */
export type AudioChannel = 'L' | 'R' | 'M';

/**
 * The role an OUTPUT port plays in the rig's output stage (§3). Advisory: it
 * gives tools a hook to reason about + guide output routing (output is a
 * first-class setup concern, e.g. the RC-505's MAIN vs SUB vs PHONES). `main` =
 * the primary front-of-house send; `monitor` = a performer monitor / headphones
 * feed; `sub` = a sub/aux output; `stem` = a separated stem (a single source
 * sent out on its own for separate processing, e.g. the guitar loop); `cue` = a
 * cue/click feed.
 */
export type OutputRole = 'main' | 'monitor' | 'sub' | 'stem' | 'cue';

export const OUTPUT_ROLES: readonly OutputRole[] = ['main', 'monitor', 'sub', 'stem', 'cue'];

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

/**
 * Stable TYPE key (borrowed from the SysEx Identity Reply triple, §2). Distinct
 * from a node's per-rig instance `id`; this is what makes rigs comparable.
 */
export interface Identity {
  manufacturer: string | null;
  family: string | null;
  /** Optional external gear-DB id. Stripped by `sanitize()` before sharing (§9). */
  catalog_id?: string | null;
}

/** A physical connection point on a node (§3). Edges attach to ports, not nodes. */
export interface Port {
  /** Unique within the node. */
  id: string;
  kind: PortKind;
  label?: string;
  /** For audio ports: is this a mono or stereo jack. */
  audio?: 'mono' | 'stereo';
  /**
   * Sub-address on a USB endpoint (Circuit MIDI1/MIDI2, FM3 virtual cables are
   * addressable groups on one USB port).
   */
  group?: string;
  /** Two mono ports that form one stereo pair share a `pair` id. */
  pair?: string;
  /**
   * For an audio OUTPUT port: its role in the rig's output stage (§3). Advisory,
   * so a tool can reason about and guide output routing (output is a first-class
   * setup concern). See {@link OutputRole}.
   */
  output_role?: OutputRole;
}

/**
 * One node-internal routing rule: how a node treats a signal on one of its
 * ports (§3, §5.6). A governed signal references a `binding` id instead of
 * restating channel/type.
 */
export interface RoutingRule {
  /** The port this rule applies to (an in-port for consume/pass, out for originate). */
  port: string;
  /** For `pass`: the out-port the signal is relayed to (soft-thru). */
  to?: string;
  kind?: SignalKind;
  type?: MidiSignalType;
  channel?: MidiChannel;
  /** A governed signal: derive the details from this binding rather than restating. */
  binding?: string;
}

/**
 * How a node treats signals arriving on its input ports (§3, §5.6). Absent =
 * "unknown / pass-through". This is the load-bearing fact topology alone cannot
 * hold: the same nodes+edges behave differently by THRU / RX-channel settings.
 */
export interface Routing {
  /** Acts on it, does NOT relay (e.g. RC-505 scene CC -> track flip). */
  consume?: RoutingRule[];
  /** Soft-thru relays it to an out-port (e.g. the ch16 PC -> Circuit). */
  pass?: RoutingRule[];
  /** Merges its OWN generated signal onto an out-port (e.g. the RC-505 clock). */
  originate?: RoutingRule[];
  /** Clock-merge conflict resolution when a node has multiple clock sources. */
  priority?: string;
}

/**
 * Optional capability block, mirroring MIDI-CI Property Exchange resources (§4)
 * so a MIDI 2.0 device could auto-populate it later. OPTIONAL and progressive:
 * `null` on a node = "not declared", which is correct for opaque/passive gear,
 * never a schema error. When a node's `server_device_id` resolves, the
 * descriptor is authoritative for capability and this is not restated.
 */
export interface Capability {
  device_info?: Record<string, unknown>;
  channel_list?: Record<string, unknown>;
  program_list?: Record<string, unknown>;
  mode_list?: Record<string, unknown>;
  controllers?: Record<string, unknown>;
}

/** An instrument or role in the rig (§3). */
export interface Node {
  /** Instance id, unique within the rig. Stable + opaque (never regenerated, §8). */
  id: string;
  /** Display name. */
  name: string;
  identity: Identity;
  /**
   * Soft reference to a registered server descriptor. When it resolves, the
   * descriptor is authoritative for capability/roles/channel-bearing signals
   * (§4). When it does not resolve, the node degrades to opaque (a warning, not
   * an error). `null` for opaque gear.
   */
  server_device_id?: string | null;
  /** Fixed-enum roles this node holds (multi-valued, §3). */
  roles: Role[];
  /**
   * Advisory free-form roles the core enum misses. NEVER keys diff/compare, so
   * extensions cannot fragment comparison (§3).
   */
  extra_roles?: string[];
  ports: Port[];
  routing?: Routing;
  /** `null` = not declared (opaque gear). See {@link Capability}. */
  capabilities?: Capability | null;
  /**
   * Free-form human note. The schema carries no status vocabulary, so this is
   * where an instance records provenance the graph cannot: a `[planned]` /
   * `[trialing]` tag, a "not yet patched" caveat, a settings reminder. Advisory
   * only; never keys diff/compare.
   */
  note?: string;
}

// ---------------------------------------------------------------------------
// Edge + signals
// ---------------------------------------------------------------------------

/** One endpoint of an edge: a specific port on a specific node. */
export interface Endpoint {
  node: string;
  port: string;
}

/**
 * One logical MIDI signal on a cable (§3). The payload fields make an edge
 * self-documenting: it states the full cross-device contract, not just the
 * channel.
 */
export interface MidiSignal {
  type: MidiSignalType;
  /** 1-16. Omitted for `clock` / `transport` (they carry no channel). */
  channel?: MidiChannel;
  /** For `cc`: the CC numbers carried. */
  cc_numbers?: number[];
  /** For `pc`: the program values / range. */
  values?: number[];
  /** For `note`: the specific note numbers carried. */
  notes?: number[];
  /**
   * For `note`: note number -> voice/pad, e.g. {36:"kick",38:"snare"}. For a
   * supported device the source of truth is the descriptor `voice_map`; the
   * manifest declares the subset on the wire. `"GM"` is a shorthand alias.
   */
  note_map?: Record<string, string> | 'GM';
  /**
   * A governed signal: this signal is PROJECTED from the named binding at
   * load/render time (§4). When set, channel/cc/etc. derive from the binding.
   */
  binding?: string;
}

/** The signal payload on an edge (§3). Audio vs MIDI vs the other kinds. */
export type EdgeSignal =
  | { kind: 'audio'; channels: AudioChannel[] }
  | { kind: 'midi'; signals: MidiSignal[] }
  | { kind: 'control_voltage' | 'expression' | 'footswitch' | 'analog_clock'; label?: string };

/** One physical link between two ports, carrying a signal payload (§3, §5). */
export interface Edge {
  /**
   * Stable, opaque id. Pin a SEMANTIC convention (`am4-scene-cc`), not an
   * endpoint-derived one, so re-cabling stays a modify, not delete+add (§8).
   */
  id: string;
  from: Endpoint;
  to: Endpoint;
  /** Shared by the two directed edges of one physical cable (§5.3). */
  physical_link_id?: string;
  directed: boolean;
  signal: EdgeSignal;
  /**
   * Default true. An edge whose MEANING changes per song (a re-patched
   * patchbay, a per-memory ASSIGN/THRU change) toggles here so a performance
   * step can activate a different sub-graph on the same cabling (§3).
   */
  enabled?: boolean;
  /** A governed edge references its binding; its signals project from it (§4). */
  binding?: string;
  /**
   * Free-form human note the graph cannot hold: a `[planned]` cable not yet
   * patched, a "verify on hardware" caveat. Advisory only; never keys diff.
   */
  note?: string;
}

// ---------------------------------------------------------------------------
// Binding (the cross-device contract the tool keeps matched, §4)
// ---------------------------------------------------------------------------

/** One side of a binding: what a node emits or expects. */
export interface BindingEnd {
  node: string;
  type: MidiSignalType;
  channel?: MidiChannel;
  cc?: number;
  note_map?: Record<string, string> | 'GM';
  /** The receiver-side target this drives (e.g. RC-505 "TRK3 REC/PLY"). */
  target?: string;
  /** Program / value range where relevant. */
  values?: number[];
}

/**
 * A named, editable cross-device contract (§4): a sender's emitted signal must
 * equal a receiver's expectation on the same channel. The binding is the SINGLE
 * authoritative source for a governed signal; edges and node routing DERIVE
 * from it. Editing the binding (CC#80 -> CC#20, GM -> another map) updates every
 * projection, so there is no second copy to drift.
 */
export interface Binding {
  id: string;
  from: { node: string; emits: BindingEnd };
  to: { node: string; expects: BindingEnd };
  /** Free-form note for the human (e.g. "AM4 scene 2 flips looper track 3"). */
  note?: string;
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

/** A full OpenRig L1 manifest: a directed multigraph plus its bindings (§3). */
export interface Rig {
  /** Reserved future URL; not live until graduation (§9). */
  $schema?: string;
  /** Semver major.minor. Consumers reject a higher MAJOR, ignore unknown fields. */
  openrig_version: string;
  id: string;
  name: string;
  nodes: Node[];
  edges: Edge[];
  /** The cross-device contracts kept matched (§4). Optional. */
  bindings?: Binding[];
}
