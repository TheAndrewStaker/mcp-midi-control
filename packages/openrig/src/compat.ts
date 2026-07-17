/**
 * OpenRig cross-device COMPATIBILITY check (§4). Pure, no hardware.
 *
 * `validateRig` (validate.ts) answers "is the graph well-formed?" This module
 * answers the DIFFERENT question the whole project exists for: "do the
 * cross-device contracts actually LINE UP, and are they legal for the gear?".
 * The AM4's scene CC must be a CC the RC-505 can source; the note the Circuit
 * sends must be a note an SPD-SX pad answers on the channel it listens on.
 *
 * A binding (§4) states both ends of a contract (`from.emits` / `to.expects`).
 * Since edges + routing are DERIVED from the binding, the check verifies the
 * binding, not the edges (they can't drift once projection is live). A plain
 * UNGOVERNED cable is legal to author too, though (`edit_rig add_cable` makes
 * them, and a hand-written manifest is full of them), so its inline signal gets
 * the same legality check its binding would have got: "connect the AM4 to the
 * RC-505 on CC#40" is caught here, not on stage. The check runs in two tiers,
 * honestly separated:
 *
 *   - TIER 1 (pure, manifest-only): the two ends AGREE (type / channel / cc /
 *     note_map); binding channels are 1-16 and channelless types carry none; a
 *     governed edge that still INLINES a signal matches its binding (the drift
 *     bindings are meant to prevent but can't until load-time projection lands).
 *   - TIER 2/3 (capability-backed, via an injected `CapabilityLookup` so this
 *     package stays zero-dependency + extractable): the mapping is legal for the
 *     gear. A `note` binding's notes resolve to real pads on the receiver's
 *     voice_map; a sequencer sender's channel matches one of its outward tracks;
 *     an assignable-CC receiver (Boss RC) only accepts a source CC in its legal
 *     set (a re-map to an illegal CC is REJECTED, the §4 headline).
 *
 * Source-of-truth rule (§4): a configuration channel OVERRIDES a descriptor
 * default, so the check never flags a `signal.channel` merely for differing from
 * a device default (the SPD-SX GLOBAL is ch4, not the voice_map's ch10 default);
 * capability bounds legality, it does not dictate the choice.
 */
import { consumesSignal } from './routing.js';
import type {
  Binding, BindingEnd, Edge, MidiSignal, MidiSignalType, Node, Rig,
} from './types.js';

export type CompatSeverity = 'error' | 'warning' | 'info';

export interface CompatIssue {
  severity: CompatSeverity;
  /** Stable machine code, e.g. `binding-channel-mismatch`, `assign-source-illegal`. */
  code: string;
  message: string;
  /** The binding id this issue is about, when applicable. */
  binding?: string;
  /** An offending edge / node id, when the issue is about a projection. */
  ref?: string;
}

/**
 * Whether the receiver-descriptor legality check could run for a binding, and
 * its outcome. Distinct from `status` so an agent can tell these apart:
 *   - `passed`         confirmed fully legal against the descriptor (no concern).
 *   - `warned`         checked and legal, but with a soft caveat (some notes have
 *                      no pad, an unknown target label, the sender is off its
 *                      declared track channel). The binding still works; read the
 *                      warning issue. Status stays `consistent`.
 *   - `failed`         a hard-illegal mapping (an out-of-range assignable CC, a
 *                      note map that resolves to NO pad). Status becomes `mismatch`.
 *   - `not_applicable` nothing to legality-check for this contract + receiver
 *                      (a plain Program-Change recall, or a device with no
 *                      assignable-CC / voice_map gate that receives directly).
 *   - `unavailable`    the receiver is opaque (no descriptor), so legality could
 *                      not be checked at all.
 */
export type CapabilityOutcome = 'passed' | 'failed' | 'warned' | 'not_applicable' | 'unavailable';

export interface BindingCompat {
  id: string;
  /** One-line human form: `cc#80 ch5 -> rc505 (TRK3 REC/PLY)`. */
  summary: string;
  /** `consistent` unless the ends disagree or a legality check failed. */
  status: 'consistent' | 'mismatch';
  /** Tier 1: the two ends line up. */
  agreement_ok: boolean;
  /** Tier 2/3: legality against the receiver's descriptor capability. */
  capability: CapabilityOutcome;
  /** Issues specific to this binding (a subset of the report's flat list). */
  issues: CompatIssue[];
}

export interface CompatibilityReport {
  /** True when no error-severity issue exists anywhere. */
  ok: boolean;
  /** Per-binding verdict, in manifest order. */
  bindings: BindingCompat[];
  /**
   * Every issue, flat. An issue with a `binding` is about that contract (or, with
   * a `ref` too, about an edge projecting it); an issue with only a `ref` is about
   * an UNGOVERNED cable, which no `bindings[]` entry covers.
   */
  issues: CompatIssue[];
  /** Whether a capability lookup was supplied (Tier 2/3 ran). */
  checked_capabilities: boolean;
}

/**
 * A device's compat-relevant capability profile: the subset of a server
 * descriptor the legality checks read. Kept small + server-agnostic so the
 * `openrig` package stays zero-dependency; the reference implementation builds
 * one of these per `server_device_id` from its registered descriptors.
 */
export interface DeviceCompatProfile {
  /** Human label for messages (e.g. "Boss RC-505mk2"). */
  label?: string;
  /** Abstract voice -> the {channel, note} the device answers (e.g. SPD-SX pads). */
  voice_map?: Readonly<Record<string, { channel: number; note: number }>>;
  /** Outward sequencer track -> the MIDI channel it transmits on (Circuit midi1:3, midi2:4). */
  external_tracks?: Readonly<Record<string, number>>;
  /** CC numbers legal as an assignable control SOURCE (Boss RC-505mk2: 64..95). */
  assignable_cc?: readonly number[];
  /** Legal control TARGET labels (Boss RC: "TRK1 REC/PLY".."TRK5 LEVEL"). */
  control_targets?: readonly string[];
}

/** Injected capability resolver: `server_device_id` -> profile, or undefined if opaque/unknown. */
export interface CapabilityLookup {
  get(serverDeviceId: string): DeviceCompatProfile | undefined;
}

export interface CompatOptions {
  capabilities?: CapabilityLookup;
}

/** MIDI signal types that carry NO channel (§3); mirrors validate.ts. */
const CHANNELLESS: ReadonlySet<MidiSignalType> = new Set<MidiSignalType>([
  'clock', 'transport', 'spp', 'song_select', 'sysex', 'active_sensing',
]);

/** The General MIDI drum notes a `note_map: "GM"` binding puts on the wire (kick..perc). */
const GM_DRUM_NOTES: readonly number[] = [36, 38, 42, 46, 39, 45, 51, 49, 56];

function isChannel(ch: unknown): boolean {
  return typeof ch === 'number' && Number.isInteger(ch) && ch >= 1 && ch <= 16;
}

/** Deep value-equality for a note_map (`"GM"` or a {note:voice} record). */
function noteMapEqual(a: BindingEnd['note_map'], b: BindingEnd['note_map']): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/** `cc#80 ch5 -> rc505 (TRK3 REC/PLY)`: a compact human summary of the contract. */
function summarizeBinding(b: Binding): string {
  const e = b.from.emits;
  const parts: string[] = [e.type];
  if (e.type === 'cc' && e.cc !== undefined) parts[0] = `cc#${e.cc}`;
  if (e.type === 'note' && e.note_map !== undefined) {
    parts[0] = typeof e.note_map === 'string' ? `note (${e.note_map})` : 'note';
  }
  if (e.channel !== undefined) parts.push(`ch${e.channel}`);
  const tgt = b.to.expects.target !== undefined ? ` (${b.to.expects.target})` : '';
  return `${parts.join(' ')} ${b.from.node} -> ${b.to.node}${tgt}`;
}

/**
 * Check every cross-device binding in a rig for agreement + capability-legality.
 * Pure. Pass `opts.capabilities` to run the Tier 2/3 descriptor checks; without
 * it only the Tier 1 (manifest-only) agreement + projection checks run.
 */
export function checkRigCompatibility(rig: Rig, opts: CompatOptions = {}): CompatibilityReport {
  const lookup = opts.capabilities;
  const flat: CompatIssue[] = [];
  const bindings: BindingCompat[] = [];
  const declared = new Map<string, Binding>();
  // Bindings whose two ends already disagree (a TIER 1a error). The governed-edge
  // drift pass skips these: the binding is already flagged, so comparing an edge
  // to the (broken) contract just adds redundant noise.
  const brokenBindings = new Set<string>();

  // Bindings reference NODE ids; a capability lookup is keyed by server_device_id.
  // Resolve node -> server_device_id here so the profile fetch works (an opaque
  // node with no server_device_id resolves to undefined -> 'unavailable').
  const sidByNode = new Map<string, string>();
  for (const node of rig.nodes) {
    if (node.server_device_id !== undefined && node.server_device_id !== null) {
      sidByNode.set(node.id, node.server_device_id);
    }
  }
  const profileOf = (nodeId: string): DeviceCompatProfile | undefined => {
    if (lookup === undefined) return undefined;
    const sid = sidByNode.get(nodeId);
    return sid === undefined ? undefined : lookup.get(sid);
  };

  for (const b of rig.bindings ?? []) {
    declared.set(b.id, b);
    const issues: CompatIssue[] = [];
    const push = (severity: CompatSeverity, code: string, message: string) => {
      const issue: CompatIssue = { severity, code, message, binding: b.id };
      issues.push(issue);
      flat.push(issue);
    };

    const emits = b.from.emits;
    const expects = b.to.expects;

    // --- TIER 1a: the two ends AGREE ------------------------------------
    let agreementOk = true;
    if (emits.type !== expects.type) {
      agreementOk = false;
      push('error', 'binding-type-mismatch',
        `binding "${b.id}" is broken: the sender emits a ${emits.type} but the receiver expects a ${expects.type}. Both ends must be the same message type.`);
    } else {
      const type = emits.type;
      const channelBearing = !CHANNELLESS.has(type);
      if (channelBearing && emits.channel !== expects.channel) {
        agreementOk = false;
        push('error', 'binding-channel-mismatch',
          `binding "${b.id}" is broken: the sender is on ch${emits.channel ?? '(none)'} but the receiver listens on ch${expects.channel ?? '(none)'}. They must match for the coordination to work.`);
      }
      if (type === 'cc' && emits.cc !== expects.cc) {
        agreementOk = false;
        push('error', 'binding-cc-mismatch',
          `binding "${b.id}" is broken: the sender emits CC#${emits.cc ?? '(none)'} but the receiver is assigned to CC#${expects.cc ?? '(none)'}.`);
      }
      if (type === 'note' && !noteMapEqual(emits.note_map, expects.note_map)) {
        agreementOk = false;
        push('error', 'binding-notemap-mismatch',
          `binding "${b.id}" is broken: the sender's note map differs from the receiver's. Both ends must use the same map (e.g. both "GM").`);
      }
      if (type === 'pc' && emits.values !== undefined && expects.values !== undefined
          && JSON.stringify(emits.values) !== JSON.stringify(expects.values)) {
        agreementOk = false;
        push('error', 'binding-values-mismatch',
          `binding "${b.id}" is broken: the sender emits program value(s) ${JSON.stringify(emits.values)} but the receiver expects ${JSON.stringify(expects.values)}.`);
      }
    }
    if (!agreementOk) brokenBindings.add(b.id);

    // --- TIER 1b: binding channel + addressability validity (validateRig leaves
    // bindings unchecked). Channel rules are mutually exclusive so one malformed
    // field yields one error; a cc/note contract that names no CC/map is not
    // addressable, so it is flagged even though the two ends technically "agree"
    // on being empty.
    for (const [side, end] of [['sender', emits], ['receiver', expects]] as const) {
      if (CHANNELLESS.has(end.type)) {
        if (end.channel !== undefined) {
          push('error', 'binding-channel-on-channelless',
            `binding "${b.id}" ${side} carries a channel on a ${end.type} signal; ${end.type} has no MIDI channel.`);
        }
      } else if (end.channel === undefined) {
        push('warning', 'binding-channel-missing',
          `binding "${b.id}" ${side} is a ${end.type} signal with no channel; a ${end.type} contract needs a MIDI channel to be addressable.`);
      } else if (!isChannel(end.channel)) {
        push('error', 'binding-bad-channel',
          `binding "${b.id}" ${side} channel ${end.channel} is out of range (1-16).`);
      }
      if (end.type === 'cc' && end.cc === undefined) {
        push('warning', 'binding-cc-missing',
          `binding "${b.id}" ${side} is a CC contract with no CC number; it is not addressable.`);
      }
      if (end.type === 'note' && end.note_map === undefined) {
        push('warning', 'binding-notemap-missing',
          `binding "${b.id}" ${side} is a note contract with no note map; there is nothing for the receiver to answer.`);
      }
    }

    // --- TIER 2/3: legality against the receiver's descriptor capability ---
    let capability: CapabilityOutcome = 'not_applicable';
    if (lookup !== undefined) {
      capability = checkCapabilityLegality(b, profileOf, push);
    } else {
      // No lookup at all: legality is simply unchecked. Leave 'not_applicable'
      // only when the contract type has nothing to legality-check regardless;
      // otherwise mark it unavailable so the agent knows a check was skipped.
      capability = contractHasCapabilityCheck(b) ? 'unavailable' : 'not_applicable';
    }

    const status: BindingCompat['status'] =
      agreementOk && capability !== 'failed' ? 'consistent' : 'mismatch';
    bindings.push({
      id: b.id,
      summary: summarizeBinding(b),
      status,
      agreement_ok: agreementOk,
      capability,
      issues,
    });
  }

  // --- TIER 1c: governed-edge projection drift ------------------------
  // A governed edge still INLINES its signal today (load-time projection from
  // the binding is a later phase). Until then, an inline signal that disagrees
  // with its binding is exactly the drift the binding is meant to prevent.
  for (const edge of rig.edges) {
    if (edge.signal.kind !== 'midi') continue;
    for (const sig of edge.signal.signals) {
      const bindingId = sig.binding ?? edge.binding;
      if (bindingId === undefined) continue;
      const b = declared.get(bindingId);
      if (b === undefined) continue; // dangling ref: validateRig already errors
      if (brokenBindings.has(bindingId)) continue; // ends already disagree; drift is redundant
      driftCheck(edge, sig, b, (severity, code, message) => {
        const issue: CompatIssue = { severity, code, message, binding: b.id, ref: edge.id };
        flat.push(issue);
      });
    }
  }

  // --- TIER 2/3 on UNGOVERNED cables ----------------------------------
  if (lookup !== undefined) {
    checkCableLegality(rig, profileOf, (issue) => flat.push(issue));
  }

  return {
    ok: flat.every((i) => i.severity !== 'error'),
    bindings,
    issues: flat,
    checked_capabilities: lookup !== undefined,
  };
}

/**
 * Tier 2/3 legality for cables no binding governs. Same gates, same issue codes
 * as the binding pass (an illegal CC is illegal however it was authored), keyed
 * by `ref` (the edge) instead of `binding`, so a caller can treat them uniformly.
 *
 * Two things scope it, and both matter:
 *   - A GOVERNED signal is skipped: its binding already carries the check, and
 *     re-reporting it against the edge would double every finding.
 *   - A RELAYED signal is skipped: legality is bounded by the device that ACTS on
 *     a signal, so a CC the RC-505 merely soft-thrus downstream is not the
 *     RC-505's to reject (§5.6). An undeclared node still acts, so this only goes
 *     quiet where the manifest says the signal is passing through.
 */
function checkCableLegality(
  rig: Rig,
  profileOf: (nodeId: string) => DeviceCompatProfile | undefined,
  emit: (issue: CompatIssue) => void,
): void {
  const nodeById = new Map<string, Node>(rig.nodes.map((n) => [n.id, n]));
  for (const edge of rig.edges) {
    if (edge.enabled === false) continue;
    if (edge.signal.kind !== 'midi') continue;
    const receiver = profileOf(edge.to.node);
    if (receiver === undefined) continue; // opaque receiver: nothing to check against
    const label = receiver.label ?? edge.to.node;

    for (const sig of edge.signal.signals) {
      if ((sig.binding ?? edge.binding) !== undefined) continue; // governed: the binding pass owns it
      if (!consumesSignal(nodeById.get(edge.to.node), edge.to.port, sig)) continue;

      if (sig.type === 'cc' && receiver.assignable_cc !== undefined && sig.cc_numbers !== undefined) {
        const illegal = sig.cc_numbers.filter((cc) => !receiver.assignable_cc!.includes(cc));
        if (illegal.length > 0) {
          emit({
            severity: 'error', code: 'assign-source-illegal', ref: edge.id,
            message: `cable "${edge.id}" sends CC#${illegal.join(', CC#')} to ${label}, which cannot use ${illegal.length > 1 ? 'those' : 'that'} as an assignable control source. Legal source CCs: ${summarizeCcSet(receiver.assignable_cc)}. Re-map to a legal CC.`,
          });
        }
      }

      if (sig.type === 'note' && receiver.voice_map !== undefined) {
        const padNotes = new Set(Object.values(receiver.voice_map).map((v) => v.note));
        const wanted = sig.notes ?? notesOf(sig.note_map);
        const missing = wanted.filter((n) => !padNotes.has(n));
        if (missing.length > 0 && missing.length === wanted.length) {
          emit({
            severity: 'error', code: 'note-no-pad', ref: edge.id,
            message: `cable "${edge.id}" sends note(s) ${missing.join(', ')} to ${label}, NONE of which map to a pad/voice; nothing will sound. Remap the notes or the pads.`,
          });
        } else if (missing.length > 0) {
          emit({
            severity: 'warning', code: 'note-no-pad', ref: edge.id,
            message: `cable "${edge.id}" sends note(s) ${missing.join(', ')} to ${label}, which has no pad/voice mapped to ${missing.length > 1 ? 'them' : 'it'}; ${missing.length > 1 ? 'those hits' : 'that hit'} will not sound. Remap the note or the pad.`,
          });
        }
      }
    }
  }
}

/** Does this contract type have anything to legality-check against a descriptor? */
function contractHasCapabilityCheck(b: Binding): boolean {
  const t = b.to.expects.type;
  return t === 'cc' || t === 'note';
}

/**
 * Tier 2/3 legality: verify the binding's ends against the gear's actual
 * capability. Returns the outcome and pushes any issue. The RECEIVER side bounds
 * what the contract may address (an assignable-CC source, a real pad); the
 * SENDER side is checked only where a descriptor pins it (a sequencer's outward
 * track channel). Honors the source-of-truth rule: a legal channel choice is
 * never flagged merely for differing from a device default.
 */
function checkCapabilityLegality(
  b: Binding,
  profileOf: (nodeId: string) => DeviceCompatProfile | undefined,
  push: (severity: CompatSeverity, code: string, message: string) => void,
): CapabilityOutcome {
  const expects = b.to.expects;
  const emits = b.from.emits;
  const receiver = profileOf(expects.node);
  const sender = profileOf(emits.node);

  let applicable = false;   // a real legality gate for this contract actually ran
  let failed = false;       // a hard-illegal mapping (error)
  let warned = false;       // a soft capability caveat (warning)
  let unavailable = false;  // the receiver is opaque, so nothing could be checked

  // RECEIVER: a `cc` contract to an ASSIGNABLE-CC device (Boss RC) must use a
  // legal source CC + (when known) a legal target label. A receiver with a
  // descriptor but NO assignable-CC gate receives the CC directly, so there is
  // no source-legality to violate (not_applicable, not unavailable). Only a
  // TRULY opaque receiver (no descriptor at all) is unavailable.
  if (expects.type === 'cc') {
    if (receiver === undefined) {
      unavailable = true;
    } else if (receiver.assignable_cc !== undefined) {
      applicable = true;
      if (expects.cc !== undefined && !receiver.assignable_cc.includes(expects.cc)) {
        failed = true;
        push('error', 'assign-source-illegal',
          `binding "${b.id}" targets ${receiver.label ?? expects.node} with CC#${expects.cc}, which it cannot use as an assignable control source. Legal source CCs: ${summarizeCcSet(receiver.assignable_cc)}. Re-map to a legal CC.`);
      }
      if (expects.target !== undefined && receiver.control_targets !== undefined
          && !receiver.control_targets.some((t) => t.toLowerCase() === expects.target!.toLowerCase())) {
        warned = true;
        push('warning', 'assign-target-unknown',
          `binding "${b.id}" target "${expects.target}" is not in ${receiver.label ?? expects.node}'s decoded target set; verify the target label on the device.`);
      }
    }
  }

  // RECEIVER: a `note` contract must resolve to real pads/voices when the device
  // HAS a voice_map. None matching = the map is wrong (a hard failure); some
  // matching = an advisory (those specific hits won't sound). A device with no
  // voice_map plays notes directly (a synth), so there is nothing to gate.
  if (expects.type === 'note') {
    if (receiver === undefined) {
      unavailable = true;
    } else if (receiver.voice_map !== undefined) {
      applicable = true;
      const padNotes = new Set(Object.values(receiver.voice_map).map((v) => v.note));
      const wanted = notesOf(expects.note_map);
      const missing = wanted.filter((n) => !padNotes.has(n));
      if (missing.length > 0 && missing.length === wanted.length) {
        failed = true;
        push('error', 'note-no-pad',
          `binding "${b.id}" sends note(s) ${missing.join(', ')} to ${receiver.label ?? expects.node}, NONE of which map to a pad/voice; nothing will sound. Remap the notes or the pads.`);
      } else if (missing.length > 0) {
        warned = true;
        push('warning', 'note-no-pad',
          `binding "${b.id}" sends note(s) ${missing.join(', ')} to ${receiver.label ?? expects.node}, which has no pad/voice mapped to ${missing.length > 1 ? 'them' : 'it'}; ${missing.length > 1 ? 'those hits' : 'that hit'} will not sound. Remap the note or the pad.`);
      }
    }
  }

  // SENDER: a sequencer's note contract should transmit on one of its outward
  // track channels (Circuit MIDI 2 = ch4). A mismatch means the wire channel
  // won't match the track you think is driving the receiver.
  if (emits.type === 'note' && sender?.external_tracks !== undefined && emits.channel !== undefined) {
    const trackChannels = Object.values(sender.external_tracks);
    if (!trackChannels.includes(emits.channel)) {
      warned = true;
      push('warning', 'sender-channel-not-a-track',
        `binding "${b.id}" transmits notes on ch${emits.channel}, but ${sender.label ?? emits.node}'s outward sequencer tracks transmit on ${trackChannels.map((c) => `ch${c}`).join(' / ')}. Confirm which track drives the receiver.`);
    }
  }

  if (failed) return 'failed';
  if (unavailable && !applicable) return 'unavailable';
  if (warned) return 'warned';
  if (applicable) return 'passed';
  return 'not_applicable';
}

/** The note numbers a note contract puts on the wire (`"GM"` expands to the GM drum set). */
function notesOf(noteMap: BindingEnd['note_map']): number[] {
  if (noteMap === undefined) return [];
  if (noteMap === 'GM') return [...GM_DRUM_NOTES];
  return Object.keys(noteMap).map((k) => Number(k)).filter((n) => Number.isInteger(n));
}

/** Collapse a sorted CC set into ranges for a readable message (e.g. `64-95`). */
function summarizeCcSet(ccs: readonly number[]): string {
  const sorted = [...ccs].sort((a, b) => a - b);
  const runs: string[] = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i] === prev + 1) { prev = sorted[i]; continue; }
    runs.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = sorted[i];
  }
  return runs.join(', ');
}

/**
 * A governed edge that inlines a signal must match its binding (until load-time
 * projection makes that impossible). Compares against the binding's transmitted
 * form (`from.emits`), which the two ends agree on when the binding is healthy.
 */
function driftCheck(
  edge: Edge,
  sig: MidiSignal,
  b: Binding,
  emit: (severity: CompatSeverity, code: string, message: string) => void,
): void {
  // Only a genuine CONFLICT is drift: an inline value that DIFFERS from the
  // binding. An edge that omits a field (channel/cc/note_map undefined) is
  // projecting-minimal, not drifting, so it is not flagged. This keeps the
  // check symmetric across fields (each fires only on defined-vs-defined-differ).
  const emits = b.from.emits;
  if (sig.type !== emits.type) {
    emit('warning', 'governed-edge-drift',
      `edge "${edge.id}" inlines a ${sig.type} signal governed by binding "${b.id}", which is a ${emits.type} contract. Edit the binding, not the edge.`);
    return;
  }
  if (!CHANNELLESS.has(sig.type) && sig.channel !== undefined && emits.channel !== undefined
      && sig.channel !== emits.channel) {
    emit('warning', 'governed-edge-drift',
      `edge "${edge.id}" carries binding "${b.id}" on ch${sig.channel} but the binding is ch${emits.channel}. The edge should project from the binding, not restate a different channel.`);
  }
  if (sig.type === 'cc' && emits.cc !== undefined && sig.cc_numbers !== undefined && sig.cc_numbers.length > 0
      && !sig.cc_numbers.includes(emits.cc)) {
    emit('warning', 'governed-edge-drift',
      `edge "${edge.id}" carries binding "${b.id}" (CC#${emits.cc}) but its cc_numbers ${JSON.stringify(sig.cc_numbers)} omit it.`);
  }
  if (sig.type === 'note' && sig.note_map !== undefined && emits.note_map !== undefined
      && !noteMapEqual(sig.note_map, emits.note_map)) {
    emit('warning', 'governed-edge-drift',
      `edge "${edge.id}" note map differs from binding "${b.id}". The edge should project the binding's map.`);
  }
}
