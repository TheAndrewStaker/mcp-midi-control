/**
 * The rig VIEW MODEL: one serializable projection of a rig plus every check,
 * shaped for a renderer rather than for a graph library.
 *
 * WHY THIS EXISTS. `toCytoscapeElements` (cytoscape.ts) projects topology for
 * Cytoscape.js and nothing else: it drops the check results, flattens ports to
 * anonymous child nodes, and says nothing about which device is heard or which
 * binding disagrees. Every renderer that has ever been wanted (the vertical
 * flow diagram, the text list, a chat artifact) needs the checks joined ONTO
 * the topology, and each one was re-deriving that join by hand. Worse, the
 * prototypes never derived it at all: they carry a hand-pasted literal that has
 * been wrong since the rig was re-cabled.
 *
 * So this is the single join, computed once, and the renderers are pure
 * functions of it. `buildRigView` runs all four checks itself, because a caller
 * that runs three of four produces a view that is quietly missing a verdict.
 *
 * PURE AND ZERO-DEP, like the rest of this package. `renderRigText` lives here
 * rather than in a renderer package because a text rendering that answers the
 * same questions as the diagram is an accessibility ship gate
 * (`docs/design/accessibility-blind-support.md`), and a ship gate belongs where
 * the golden tests are.
 */
import { checkAudioOutput, type AudioOutputStatus } from './audio.js';
import { checkRigCapacity, type FreePort } from './capacity.js';
import { checkRigCompatibility, type CapabilityLookup, type CapabilityOutcome, type CompatIssue } from './compat.js';
import { summarizeSignal } from './cytoscape.js';
import type { OutputRole, PortKind, Rig, Role, SignalKind } from './types.js';
import { validateRig } from './validate.js';

/** Which check produced a finding. Kept so a reader can tell "malformed" from "will not be heard". */
export type FindingSource = 'validate' | 'audio' | 'compat' | 'capacity';

export interface RigFinding {
  severity: 'error' | 'warning' | 'info';
  source: FindingSource;
  code: string;
  message: string;
  /** The offending node / edge / binding id, when the check named one. */
  ref?: string;
}

export interface RigViewPort {
  id: string;
  /** `node::port`, the stable id a renderer can use as an element key. */
  gid: string;
  kind: PortKind;
  label: string;
  audio?: 'mono' | 'stereo';
  output_role?: OutputRole;
  /** From the capacity check: is anything plugged into it? */
  state: 'used' | 'reserved' | 'free';
}

export interface RigViewEndpoint {
  node: string;
  node_name: string;
  port: string;
  port_label: string;
}

export interface RigViewLink {
  id: string;
  /** Human one-liner: `CC 80 ch5`, `audio L/R`, `clock`. */
  label: string;
  kind: SignalKind;
  from: RigViewEndpoint;
  to: RigViewEndpoint;
  /** `false` means a `[planned]` / parked cable. Renderers fade these. */
  enabled: boolean;
  /** Carries a governed binding, so it is authoritative rather than incidental. */
  governed: boolean;
  /**
   * Every binding this cable projects, deduped, in encounter order.
   *
   * A binding can be named in TWO places and both are legal (§4): on the edge,
   * meaning the whole cable is governed, or on an individual `MidiSignal`,
   * meaning one signal among several on that cable is. Real manifests use the
   * signal-level form, because one DIN cable carries clock plus transport plus
   * three note streams and only one of them is the governed contract. Reading
   * only the edge-level field reports a fully governed rig as fully ungoverned.
   */
  bindings: string[];
  /** First binding, for the common single-contract case. */
  binding?: string;
  physical_link_id?: string;
  note?: string;
  /**
   * Carries clock or transport. Rendered distinctly because "who is the clock
   * master" is the question a rig diagram gets asked most and it is invisible
   * when clock is drawn the same as note data.
   */
  timing: boolean;
}

export interface RigViewDevice {
  id: string;
  name: string;
  roles: Role[];
  extra_roles: string[];
  server_device_id: string | null;
  /** No descriptor resolves, so the server can say nothing about it. */
  opaque: boolean;
  ports: RigViewPort[];
  note?: string;
  /** Present only for sound sources / samplers: does its audio reach an output? */
  audio_status?: AudioOutputStatus;
  /** Link ids leaving this device, in manifest order. */
  sends: string[];
  /** Link ids arriving at this device, in manifest order. */
  receives: string[];
  free_ports: number;
}

export interface RigViewBinding {
  id: string;
  summary: string;
  status: 'consistent' | 'mismatch';
  agreement_ok: boolean;
  capability: CapabilityOutcome;
  issues: CompatIssue[];
}

export interface RigViewCheck {
  id: 'validate' | 'audio' | 'compat' | 'capacity';
  /** The question the check answers, in the words the package's own docs use. */
  question: string;
  ok: boolean;
  /** One line a reader can act on, never just "3 issues". */
  detail: string;
}

export interface RigView {
  id: string;
  name: string;
  openrig_version: string;
  counts: {
    devices: number;
    links: number;
    enabled_links: number;
    planned_links: number;
    bindings: number;
    free_ports: number;
  };
  devices: RigViewDevice[];
  links: RigViewLink[];
  bindings: RigViewBinding[];
  checks: RigViewCheck[];
  findings: RigFinding[];
  free_by_kind: Partial<Record<PortKind, FreePort[]>>;
  /** True only when every check that can fail did not. */
  ok: boolean;
}

const TIMING_TYPES = new Set(['clock', 'transport', 'spp', 'song_select']);

/** Does this edge carry clock or transport, i.e. is it a timing spine? */
function carriesTiming(signalKind: SignalKind, signals: readonly { type: string }[]): boolean {
  if (signalKind === 'analog_clock') return true;
  return signals.some((s) => TIMING_TYPES.has(s.type));
}

function pluralise(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Project a rig plus all four checks into one renderable model.
 *
 * `capabilities` is the injected descriptor lookup the compat check needs to
 * run its tier-2/3 legality pass. Without it the binding rows still report
 * agreement, and `capability` reads `unavailable` rather than silently passing.
 */
export function buildRigView(rig: Rig, opts: { capabilities?: CapabilityLookup } = {}): RigView {
  const validation = validateRig(rig);
  const audio = checkAudioOutput(rig);
  const compat = checkRigCompatibility(rig, { capabilities: opts.capabilities });
  const capacity = checkRigCapacity(rig);

  const nodeName = new Map(rig.nodes.map((n) => [n.id, n.name]));
  const portLabel = new Map<string, string>();
  for (const n of rig.nodes) {
    for (const p of n.ports) portLabel.set(`${n.id}::${p.id}`, p.label ?? p.id);
  }
  const endpoint = (node: string, port: string): RigViewEndpoint => ({
    node,
    node_name: nodeName.get(node) ?? node,
    port,
    port_label: portLabel.get(`${node}::${port}`) ?? port,
  });

  const links: RigViewLink[] = rig.edges.map((edge) => {
    const signals = edge.signal.kind === 'midi' ? edge.signal.signals : [];
    const bindings = [...new Set([
      ...(edge.binding !== undefined ? [edge.binding] : []),
      ...signals.map((s) => s.binding).filter((b): b is string => b !== undefined),
    ])];
    return {
      id: edge.id,
      label: summarizeSignal(edge.signal),
      kind: edge.signal.kind,
      from: endpoint(edge.from.node, edge.from.port),
      to: endpoint(edge.to.node, edge.to.port),
      enabled: edge.enabled !== false,
      governed: bindings.length > 0,
      bindings,
      binding: bindings[0],
      physical_link_id: edge.physical_link_id,
      note: edge.note,
      timing: carriesTiming(edge.signal.kind, signals),
    };
  });

  const audioById = new Map(audio.instruments.map((i) => [i.id, i.status]));
  const capacityById = new Map(capacity.devices.map((d) => [d.id, d]));

  const devices: RigViewDevice[] = rig.nodes.map((node) => {
    const cap = capacityById.get(node.id);
    const portState = new Map(cap?.ports.map((p) => [p.port_id, p.state]) ?? []);
    return {
      id: node.id,
      name: node.name,
      roles: [...node.roles],
      extra_roles: [...(node.extra_roles ?? [])],
      server_device_id: node.server_device_id ?? null,
      opaque: node.server_device_id === null || node.server_device_id === undefined,
      ports: node.ports.map((p) => ({
        id: p.id,
        gid: `${node.id}::${p.id}`,
        kind: p.kind,
        label: p.label ?? p.id,
        audio: p.audio,
        output_role: p.output_role,
        state: portState.get(p.id) ?? 'free',
      })),
      note: node.note,
      audio_status: audioById.get(node.id),
      sends: links.filter((l) => l.from.node === node.id).map((l) => l.id),
      receives: links.filter((l) => l.to.node === node.id).map((l) => l.id),
      free_ports: cap?.totals.free ?? 0,
    };
  });

  const findings: RigFinding[] = [
    ...validation.errors.map((i) => ({ ...i, source: 'validate' as const })),
    ...validation.warnings.map((i) => ({ ...i, source: 'validate' as const })),
    ...audio.issues.map((i) => ({ ...i, source: 'audio' as const })),
    ...compat.issues.map((i) => ({
      severity: i.severity, source: 'compat' as const, code: i.code, message: i.message, ref: i.ref ?? i.binding,
    })),
    ...capacity.issues.map((i) => ({ ...i, source: 'capacity' as const })),
  ];

  const unheard = audio.instruments.filter((i) => i.status !== 'reaches_output');
  const freeCount = Object.values(capacity.free_by_kind).reduce((a, ps) => a + (ps?.length ?? 0), 0);
  const mismatched = compat.bindings.filter((b) => b.status === 'mismatch');

  const checks: RigViewCheck[] = [
    {
      id: 'validate',
      question: 'Is the graph well-formed?',
      ok: validation.ok,
      detail: validation.ok
        ? `No errors across ${pluralise(rig.nodes.length, 'device')} and ${pluralise(rig.edges.length, 'cable')}`
        : `${pluralise(validation.errors.length, 'error')}, ${pluralise(validation.warnings.length, 'warning')}`,
    },
    {
      id: 'audio',
      question: 'Will I actually hear each instrument?',
      ok: audio.ok,
      detail: !audio.has_output_node
        ? 'No monitor / front-of-house node declared, so reachability could not be judged'
        : unheard.length === 0
          ? `All ${pluralise(audio.instruments.length, 'instrument')} reach the output`
          : `${unheard.map((i) => i.name).join(', ')} will not be heard`,
    },
    {
      id: 'compat',
      question: 'Will the cross-device MIDI coordination work?',
      ok: compat.ok,
      detail: rig.bindings === undefined || rig.bindings.length === 0
        ? 'No governed bindings declared'
        : mismatched.length === 0
          ? `${pluralise(compat.bindings.length, 'binding')} agree${compat.bindings.length === 1 ? 's' : ''}${compat.checked_capabilities ? '' : ' (gear legality not checked: no descriptor lookup supplied)'}`
          : `${mismatched.map((b) => b.id).join(', ')} disagree`,
    },
    {
      id: 'capacity',
      question: 'Where is there room to plug something in?',
      ok: capacity.ok,
      detail: freeCount === 0
        ? 'Every port is claimed'
        : `${pluralise(freeCount, 'free port')} across ${pluralise(Object.keys(capacity.free_by_kind).length, 'jack type')}`,
    },
  ];

  return {
    id: rig.id,
    name: rig.name,
    openrig_version: rig.openrig_version,
    counts: {
      devices: rig.nodes.length,
      links: links.length,
      enabled_links: links.filter((l) => l.enabled).length,
      planned_links: links.filter((l) => !l.enabled).length,
      bindings: rig.bindings?.length ?? 0,
      free_ports: freeCount,
    },
    devices,
    links,
    bindings: compat.bindings.map((b) => ({
      id: b.id,
      summary: b.summary,
      status: b.status,
      agreement_ok: b.agreement_ok,
      capability: b.capability,
      issues: b.issues,
    })),
    checks,
    findings,
    free_by_kind: capacity.free_by_kind,
    ok: validation.ok && audio.ok && compat.ok,
  };
}

// ─── text rendering ─────────────────────────────────────────────────────────

const CAPABILITY_TEXT: Record<CapabilityOutcome, string> = {
  passed: 'gear-legal',
  warned: 'gear-legal with a caveat',
  failed: 'ILLEGAL for this gear',
  not_applicable: 'nothing to legality-check',
  unavailable: 'gear legality unknown (device is opaque)',
};

/**
 * Render the view as plain text that answers the SAME questions the diagram
 * does: what connects to what, on which channel, and what fails a check.
 *
 * This is not a fallback. `docs/design/accessibility-blind-support.md` makes it
 * a ship gate, and the rule it enforces is that a musician who cannot see the
 * graph is never told to look at it. So every fact the diagram encodes
 * positionally or by colour is stated here in words: signal type, direction,
 * planned-vs-live, governed-vs-incidental, and whether a device is heard.
 */
export function renderRigText(view: RigView): string {
  const out: string[] = [];
  const rule = (s: string): void => { out.push('', s, '='.repeat(s.length)); };

  out.push(view.name);
  out.push(`OpenRig ${view.openrig_version} · ${view.id}`);
  out.push(
    `${pluralise(view.counts.devices, 'device')}, ${pluralise(view.counts.links, 'cable')}` +
    (view.counts.planned_links > 0 ? ` (${view.counts.planned_links} planned, not patched)` : '') +
    `, ${pluralise(view.counts.bindings, 'governed binding')}, ${pluralise(view.counts.free_ports, 'free port')}`,
  );

  rule('Checks');
  for (const c of view.checks) {
    out.push(`${c.ok ? 'PASS' : 'ATTENTION'}  ${c.question}`);
    out.push(`        ${c.detail}`);
  }

  rule('Signal flow, device by device');
  for (const d of view.devices) {
    const tags: string[] = [d.roles.join(', ')];
    if (d.opaque) tags.push('opaque to the server');
    if (d.audio_status === 'no_output') tags.push('NOT HEARD: no audio cable out');
    if (d.audio_status === 'dead_end') tags.push('NOT HEARD: audio path dead-ends');
    if (d.audio_status === 'reaches_output') tags.push('heard at the output');
    out.push('', `${d.name}  [${tags.join(' · ')}]`);
    if (d.note) out.push(`  note: ${d.note}`);

    const byId = new Map(view.links.map((l) => [l.id, l]));
    const describe = (id: string, dir: 'out' | 'in'): string => {
      const l = byId.get(id);
      if (l === undefined) return `  ${id} (missing)`;
      const other = dir === 'out' ? l.to : l.from;
      const mine = dir === 'out' ? l.from : l.to;
      const arrow = dir === 'out' ? '-->' : '<--';
      const marks: string[] = [];
      if (!l.enabled) marks.push('PLANNED, not patched');
      if (l.governed) marks.push(`governed by ${l.bindings.join(', ')}`);
      if (l.timing) marks.push('timing');
      return `  ${arrow} ${other.node_name} (${other.port_label})` +
        `\n        ${l.kind}: ${l.label}, from ${mine.port_label}` +
        (marks.length > 0 ? `\n        ${marks.join(' · ')}` : '') +
        (l.note ? `\n        note: ${l.note}` : '');
    };
    if (d.sends.length === 0 && d.receives.length === 0) out.push('  nothing patched');
    for (const id of d.sends) out.push(describe(id, 'out'));
    for (const id of d.receives) out.push(describe(id, 'in'));
    if (d.free_ports > 0) out.push(`  ${pluralise(d.free_ports, 'free jack')}`);
  }

  if (view.bindings.length > 0) {
    rule('Cross-device bindings');
    for (const b of view.bindings) {
      out.push('', `${b.id}: ${b.summary}`);
      out.push(`  ends ${b.agreement_ok ? 'agree' : 'DISAGREE'} · ${CAPABILITY_TEXT[b.capability]}`);
      for (const i of b.issues) out.push(`  ${i.severity}: ${i.message}`);
    }
  }

  rule('Findings');
  if (view.findings.length === 0) out.push('None. Every check passed.');
  for (const f of view.findings) {
    out.push(`${f.severity.toUpperCase()} [${f.source}/${f.code}]${f.ref ? ` ${f.ref}` : ''}`);
    out.push(`  ${f.message}`);
  }

  return out.join('\n');
}
