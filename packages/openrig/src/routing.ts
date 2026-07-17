/**
 * §5.6 signal transform through a node: `routing` (consume / pass / originate)
 * is what makes reachability computable THROUGH a node, which is why topology
 * alone is not reachability. Two questions are asked of it, by two different
 * checks, so the logic lives here rather than in either:
 *
 *   - "does this cable's signal reach the NEXT cable?" (validate.ts, cycles)
 *   - "is this node the one that ACTS on the signal?" (compat.ts, legality)
 *
 * The default is deliberately LOUD, not quiet. `routing` absent, or an in-port
 * no rule names, means the node's treatment is UNDECLARED, and an undeclared
 * node is assumed both to relay and to act. A check therefore only goes quiet on
 * a path the manifest explicitly declares safe; opaque gear keeps every warning
 * it had. Declaring routing is how a rig earns silence.
 */
import type { MidiSignal, Node, RoutingRule } from './types.js';

/**
 * Does a routing rule cover this signal? Unspecified rule fields are wildcards,
 * so `{kind: "midi"}` alone covers every MIDI type (how a thru box is declared).
 * A rule naming a `binding` matches by binding IDENTITY: the governed signal
 * carries the same id (§4), and a binding-keyed rule says nothing about traffic
 * that binding does not govern.
 */
export function ruleCoversSignal(rule: RoutingRule, sig: MidiSignal): boolean {
  if (rule.kind !== undefined && rule.kind !== 'midi') return false;
  if (rule.binding !== undefined) return rule.binding === sig.binding;
  if (rule.type !== undefined && rule.type !== sig.type) return false;
  if (rule.channel !== undefined && sig.channel !== undefined && rule.channel !== sig.channel) return false;
  return true;
}

/**
 * Is this in-port's treatment declared at all? `consume` / `pass` name in-ports;
 * `originate` names an out-port, so it says nothing about arriving signals. A
 * node that declares routing for SOME ports stays unknown (and so stays loud)
 * on the ports it does not mention.
 */
function portIsDeclared(node: Node, inPort: string): boolean {
  const routing = node.routing;
  if (routing === undefined) return false;
  return [...(routing.consume ?? []), ...(routing.pass ?? [])].some((r) => r.port === inPort);
}

/**
 * Does `node` RELAY a signal arriving at `inPort` back out of `outPort`? Only a
 * `pass` rule relays (soft-thru). A consumed signal TERMINATES: the AM4 follows
 * the clock it receives and emits its own CCs rather than echoing what arrived,
 * so a path into the AM4 does not continue out of it. That is the difference
 * between a loop that is merely drawn and one that actually feeds back.
 */
export function relaysSignal(node: Node | undefined, inPort: string, outPort: string, sig: MidiSignal): boolean {
  if (node === undefined) return true;             // dangling ref: validateRig errors; stay loud
  if (!portIsDeclared(node, inPort)) return true;  // undeclared: unknown, assume soft-thru
  return (node.routing?.pass ?? []).some((r) =>
    r.port === inPort && (r.to === undefined || r.to === outPort) && ruleCoversSignal(r, sig));
}

/**
 * Does `node` ACT on a signal arriving at `inPort`, rather than merely relaying
 * it onward? This decides whether the node's own capability bounds the signal: a
 * CC the RC-505 consumes must be one it can assign, while a CC it only soft-thrus
 * is addressed to something downstream and is not the RC-505's to reject.
 *
 * A signal both consumed and passed (a legal split: act on it AND echo it) counts
 * as consumed, since the node does act on it.
 */
export function consumesSignal(node: Node | undefined, inPort: string, sig: MidiSignal): boolean {
  if (node === undefined) return true;
  if (!portIsDeclared(node, inPort)) return true;  // undeclared: unknown, assume it is for this device
  if ((node.routing?.consume ?? []).some((r) => r.port === inPort && ruleCoversSignal(r, sig))) return true;
  // Declared port, no consume rule: acted on unless a pass rule claims it as a relay.
  return !(node.routing?.pass ?? []).some((r) => r.port === inPort && ruleCoversSignal(r, sig));
}
