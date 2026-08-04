/**
 * OpenRig ATTACHMENT RANKING: "I have a new device and it needs to receive this
 * signal. Where do I plug it in, and why there?"
 *
 * Deterministic and total: it enumerates every feasible attachment point and
 * orders them by a fixed rule, so the same rig and the same request always give
 * the same answer with the same explanation. That is the entire point. This
 * exists because the ALTERNATIVE (an agent reasoning it out from the graph) was
 * tried on 2026-07-25 and got it wrong: it recommended daisy-chaining a new
 * synth through another synth while the sequencer's second DIN output sat free
 * and labelled `"MIDI Out (unused)"` in the manifest.
 *
 * ## Why this is not a shortest-path problem
 *
 * The obvious reach is Dijkstra. It is the wrong tool, for a specific reason: a
 * shortest-path algorithm answers "how do I get from A to B through a weighted
 * graph", and the new device is not yet IN the graph. There is no B to path to.
 * The real question is an ASSIGNMENT: of all ports that could host this cable,
 * which one should. Dijkstra's actual contribution, the cheapest-cost frontier
 * expansion, is still doing work here, but as **signal propagation** (which
 * ports does the required signal reach, and at what hop cost), which is one BFS
 * over the routing rules. The ranking that follows is not a path search.
 *
 * The search space also does not need to be clever. Candidates are bounded by
 * the number of free ports in a rig, which is single digits. Exhaustive
 * enumeration is therefore exact, instant, and trivially testable. Any heuristic
 * here would trade away provable optimality for nothing.
 *
 * ## Why tiers, not a weighted score
 *
 * The tempting design is to score each candidate and take the highest. It was
 * rejected. A weighted sum silently converts incomparable things into one
 * number: "one extra hop" and "one more device that has to be powered on" do not
 * share a unit, so any exchange rate between them is invented. Worse, enough
 * small advantages can outvote a decisive disadvantage, and the weights become
 * magic constants nobody can justify or test.
 *
 * Instead: hard constraints ELIMINATE (a candidate that cannot carry the signal
 * is not a low score, it is not a candidate), and survivors are ranked
 * LEXICOGRAPHICALLY, tier by tier. That yields a real reason for every decision
 * ("fewer relay dependencies") rather than "scored 0.82", is stable under adding
 * a tier, and each tier is independently testable.
 *
 * ## Why daisy-chaining loses, stated honestly
 *
 * The usual argument is latency. That argument is weak and should not be the one
 * encoded: a HARDWARE thru is an opto-isolated electrical repeat and its delay
 * is negligible. The real costs of putting a device in the middle of a chain are
 * (a) a firmware/soft thru re-transmits in software, adding jitter, and (b) the
 * intermediate device becomes a single point of failure, so if it is powered
 * off, asleep, or its thru setting is wrong, everything downstream of it dies.
 * On a stage, (b) is the one that ends a song. So the primary tier counts
 * **relay dependencies**, which names that risk directly, rather than a vague
 * "chain penalty". A chain is not banned, it is simply last.
 *
 * Song/repertoire requirements (OpenRig L2) deliberately do NOT feed in yet: the
 * tiers below decide the motivating case correctly with zero song data. L2 is
 * expected to refine tier ordering later, not replace it.
 */
import { ruleCoversSignal, relaysSignal } from './routing.js';
import { checkRigCapacity } from './capacity.js';
import type { MidiSignal, Node, PortKind, Rig } from './types.js';

export interface AttachmentRequest {
  /**
   * Node id of the device being attached. It must already exist in the rig (add
   * the node, then ask where its cable goes); it may have no edges at all.
   */
  device: string;
  /** The signal the device must RECEIVE. v1 scope is MIDI. */
  signal: MidiSignal;
  /**
   * Node id that originates the signal. Optional: when omitted, inferred from
   * the rig, and an ambiguous or absent origin is reported rather than guessed.
   */
  origin?: string;
}

export interface AttachmentCandidate {
  /** The source port to run the new cable FROM. */
  from: { node_id: string; node_name: string; port_id: string; label?: string };
  /** The port on the new device the cable lands on. */
  to: { node_id: string; port_id: string };
  /** Cables between the origin device and the new device, including this one. 1 = direct. */
  hops: number;
  /**
   * Devices that must be powered on AND relaying for this attachment to work.
   * Empty for a direct connection. THE primary ranking tier: each entry is a
   * box that can independently kill the signal on stage.
   */
  relay_dependencies: string[];
  /** Free source ports left on the host device if this one is taken. */
  host_spare_after: number;
  /** Plain-language statement of this candidate's cost. */
  rationale: string;
}

export interface AttachmentReport {
  ok: boolean;
  /** Feasible attachments, best first. Empty when nothing can carry the signal. */
  candidates: AttachmentCandidate[];
  /** The winner (candidates[0]), omitted when there are none. */
  best?: AttachmentCandidate;
  /** Why the winner beat the runner-up, or why there is no winner. */
  summary: string;
  /** Set when the request could not be evaluated (unknown device, no origin, no free input). */
  error?: string;
}

/** The port kind a device needs to RECEIVE each signal kind. */
const RECEIVING_KIND: Record<'midi', PortKind[]> = { midi: ['midi_din_in', 'usb_midi'] };
/** Port kinds that can SOURCE a MIDI cable. `midi_thru` counts: it is an output socket. */
const SOURCING_KINDS = new Set<PortKind>(['midi_din_out', 'midi_thru', 'usb_midi']);

/**
 * Does `node` emit this signal from `outPort`? Mirrors routing.ts's loud
 * default: a port no `originate` rule names is UNDECLARED, so it is assumed to
 * carry. Declaring routing is how a rig earns a narrower answer.
 */
function originatesSignal(node: Node, outPort: string, sig: MidiSignal): boolean {
  const rules = (node.routing?.originate ?? []).filter((r) => r.port === outPort);
  if (rules.length === 0) return true;
  return rules.some((r) => ruleCoversSignal(r, sig));
}

/** Nodes that originate `sig` on at least one port. */
function findOrigins(rig: Rig, sig: MidiSignal): string[] {
  const out: string[] = [];
  for (const node of rig.nodes) {
    const rules = node.routing?.originate ?? [];
    if (rules.some((r) => ruleCoversSignal(r, sig))) out.push(node.id);
  }
  return out;
}

/**
 * Rank every place a new device could be plugged in to receive `signal`.
 *
 * Pure: never mutates the rig, never adds an edge. The caller applies the chosen
 * attachment with `applyRigEdit({op:'add_cable'})` and validates the result.
 */
export function rankAttachments(rig: Rig, req: AttachmentRequest): AttachmentReport {
  const target = rig.nodes.find((n) => n.id === req.device);
  if (target === undefined) {
    return { ok: false, candidates: [], summary: '', error: `device "${req.device}" is not a node in this rig. Add the device first, then ask where its cable goes.` };
  }

  const capacity = checkRigCapacity(rig);
  const stateOf = new Map<string, string>();
  for (const d of capacity.devices) for (const p of d.ports) stateOf.set(`${d.id} ${p.port_id}`, p.state);

  // The new device needs a FREE port that can receive the signal.
  const receiving = target.ports.filter(
    (p) => RECEIVING_KIND.midi.includes(p.kind) && stateOf.get(`${target.id} ${p.id}`) === 'free',
  );
  if (receiving.length === 0) {
    return { ok: false, candidates: [], summary: '', error: `${target.name} has no free MIDI input port to receive on.` };
  }
  const inPort = receiving[0];

  // Resolve the origin. An ambiguous origin is reported, never guessed: picking
  // one silently would produce a confident answer to the wrong question.
  let origin = req.origin;
  if (origin === undefined) {
    const found = findOrigins(rig, req.signal).filter((id) => id !== target.id);
    if (found.length === 0) {
      return { ok: false, candidates: [], summary: '', error: `no node in this rig declares that it originates this signal, so there is nothing to attach to. Name the source explicitly with "origin".` };
    }
    if (found.length > 1) {
      return { ok: false, candidates: [], summary: '', error: `more than one node originates this signal (${found.join(', ')}). Name the intended source with "origin".` };
    }
    origin = found[0];
  }
  const originNode = rig.nodes.find((n) => n.id === origin);
  if (originNode === undefined) {
    return { ok: false, candidates: [], summary: '', error: `origin "${origin}" is not a node in this rig.` };
  }

  // --- signal propagation: which nodes does the signal reach, at what hop cost?
  // A cheapest-first frontier expansion (the one genuinely Dijkstra-shaped part),
  // walking ENABLED MIDI edges and consulting routing to decide whether a node
  // relays the signal onward. `cost` = cables traversed from the origin.
  const cost = new Map<string, number>([[origin, 0]]);
  const via = new Map<string, string[]>([[origin, []]]);
  const queue: string[] = [origin];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const node = rig.nodes.find((n) => n.id === nodeId);
    if (node === undefined) continue;
    const here = cost.get(nodeId)!;
    for (const e of rig.edges) {
      if (e.enabled === false) continue;
      if (e.signal.kind !== 'midi') continue;
      if (e.from.node !== nodeId) continue;
      if (!e.signal.signals.some((s) => sameSignal(s, req.signal))) continue;
      // Leaving the origin means originating; leaving any other node means relaying
      // what arrived. A node that CONSUMES the signal does not pass it on.
      if (nodeId === origin) {
        if (!originatesSignal(node, e.from.port, req.signal)) continue;
      } else {
        const arrival = incomingPort(rig, nodeId, req.signal);
        if (arrival === undefined) continue;
        if (!relaysSignal(node, arrival, e.from.port, req.signal)) continue;
      }
      const next = e.to.node;
      if (next === target.id) continue;          // already attached there
      if (cost.has(next)) continue;
      cost.set(next, here + 1);
      via.set(next, [...(via.get(nodeId) ?? []), next]);
      queue.push(next);
    }
  }

  // --- enumerate: every FREE sourcing port on a node the signal reaches.
  const candidates: AttachmentCandidate[] = [];
  for (const node of rig.nodes) {
    if (node.id === target.id) continue;
    const reachCost = cost.get(node.id);
    if (reachCost === undefined) continue;       // signal never gets here: eliminated, not penalised
    const spare = node.ports.filter(
      (p) => SOURCING_KINDS.has(p.kind) && stateOf.get(`${node.id} ${p.id}`) === 'free',
    );
    for (const port of spare) {
      // A port on the origin must actually emit the signal; a port further out
      // must relay it from whatever arrives.
      if (node.id === origin) {
        if (!originatesSignal(node, port.id, req.signal)) continue;
      } else {
        const arrival = incomingPort(rig, node.id, req.signal);
        if (arrival === undefined) continue;
        if (!relaysSignal(node, arrival, port.id, req.signal)) continue;
      }
      const relays = (via.get(node.id) ?? []).map(
        (id) => rig.nodes.find((n) => n.id === id)?.name ?? id,
      );
      const candidate: AttachmentCandidate = {
        from: { node_id: node.id, node_name: node.name, port_id: port.id },
        to: { node_id: target.id, port_id: inPort.id },
        hops: reachCost + 1,
        relay_dependencies: relays,
        host_spare_after: spare.length - 1,
        rationale: relays.length === 0
          ? `Direct from ${node.name}. Nothing sits in between, so no other device has to be powered on or configured for this to work.`
          : `Runs through ${relays.length} intermediate device${relays.length === 1 ? '' : 's'} (${relays.join(', ')}). Each one has to be powered on and relaying, and a soft thru re-transmits in software, so each is a way for this to fail mid-song.`,
      };
      if (port.label !== undefined) candidate.from.label = port.label;
      candidates.push(candidate);
    }
  }

  // --- rank lexicographically. Tier order is the design, so it is explicit:
  //   1. fewest relay dependencies  (fewest boxes that can kill the signal)
  //   2. most spare capacity left   (do not burn the last output on a hub)
  //   3. stable id order            (determinism, never a coin flip)
  candidates.sort((a, b) =>
    a.relay_dependencies.length - b.relay_dependencies.length
    || b.host_spare_after - a.host_spare_after
    || a.from.node_id.localeCompare(b.from.node_id)
    || a.from.port_id.localeCompare(b.from.port_id));

  if (candidates.length === 0) {
    return {
      ok: false, candidates: [],
      summary: `Nothing in this rig has a free output that carries this signal to ${target.name}. Every candidate was eliminated, so this needs new hardware (a thru box or splitter) rather than a better choice of port.`,
      error: 'no feasible attachment point',
    };
  }

  const best = candidates[0];
  const runnerUp = candidates[1];
  let summary = `Plug ${target.name} into ${best.from.node_name} ${best.from.port_id}${best.from.label !== undefined ? ` (${best.from.label})` : ''}. ${best.rationale}`;
  if (runnerUp !== undefined) {
    summary += ` Beats ${runnerUp.from.node_name} ${runnerUp.from.port_id} because `;
    summary += best.relay_dependencies.length < runnerUp.relay_dependencies.length
      ? `that route depends on ${runnerUp.relay_dependencies.length} intermediate device${runnerUp.relay_dependencies.length === 1 ? '' : 's'} and this one depends on none.`
      : `it leaves more spare capacity on the host (${best.host_spare_after} free vs ${runnerUp.host_spare_after}).`;
  }
  return { ok: true, candidates, best, summary };
}

/** Two signals match when type agrees and, for channel-bearing types, channel agrees. */
function sameSignal(a: MidiSignal, b: MidiSignal): boolean {
  if (a.type !== b.type) return false;
  if (a.channel === undefined || b.channel === undefined) return true;
  return a.channel === b.channel;
}

/** The in-port at which `sig` arrives at `nodeId`, if any enabled edge delivers it. */
function incomingPort(rig: Rig, nodeId: string, sig: MidiSignal): string | undefined {
  for (const e of rig.edges) {
    if (e.enabled === false) continue;
    if (e.signal.kind !== 'midi') continue;
    if (e.to.node !== nodeId) continue;
    if (e.signal.signals.some((s) => sameSignal(s, sig))) return e.to.port;
  }
  return undefined;
}
