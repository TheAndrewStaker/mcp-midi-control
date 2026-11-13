/**
 * diagram.ts — the rig as a vertical signal-flow diagram, emitted as
 * STATIC SVG.
 *
 * THE DIRECTION IS PINNED, not chosen here. `docs/_private/rig/prototypes/README.md`
 * records the maintainer's 2026-07-12 ruling: "roll with the vertical flow
 * diagram alone", devices stacked one per row, cables routed in the side
 * gutters (audio right, control left) as orthogonal runs so they never cross a
 * device. This module reproduces that layout from the view model instead of
 * from the hand-pasted literal the prototypes carry.
 *
 * SERVER-SIDE, NOT CLIENT-SIDE. The prototypes computed layout in browser JS.
 * Emitting finished SVG means the diagram survives with scripting off, prints,
 * and can be dropped into a chat artifact unchanged. The only JavaScript on the
 * page is highlight-on-click, which is an enhancement rather than a dependency.
 *
 * NO GRAPH LIBRARY. `toCytoscapeElements` exists for a future Cytoscape-based
 * renderer and would cost ~400 KB of vendored library inside a self-contained
 * file to draw twelve boxes in a column.
 */
import type { RigView, RigViewDevice, RigViewLink } from 'openrig';

// ─── layout constants ───────────────────────────────────────────────────────

const ROW_H = 74;          // vertical pitch between device rows
const BOX_H = 54;
const BOX_W = 300;
const GUTTER = 132;        // width of each cable gutter
const LANE = 15;           // horizontal pitch between cable lanes
const PAD_TOP = 20;
const PAD_BOTTOM = 24;
const RADIUS = 8;          // corner radius on cable elbows

const WIDTH = BOX_W + GUTTER * 2;
const BOX_X = GUTTER;

/**
 * Reading order down the page. Signal flows top to bottom: what generates the
 * timing, what distributes it, what makes sound, what shapes it, what a foot
 * operates, what sums it, where it leaves for the audience.
 *
 * A topological sort is the obvious alternative and is wrong here: this rig has
 * a genuine cycle (the Circuit sends note data out to the MicroFreak and takes
 * its audio back in), so no topological order exists and any tie-break would be
 * arbitrary. Role tiers are stable, explainable, and match how a musician
 * describes their own signal chain.
 */
const ROLE_TIER: [string, number][] = [
  ['clock_master', 0], ['sequencer', 0],
  ['midi_router', 1],
  ['sound_source', 2], ['sampler', 2],
  ['effect', 3],
  ['controller', 4],
  ['looper', 5], ['mixer', 5],
  ['monitor', 6],
];

function tierOf(d: RigViewDevice): number {
  let best = 9;
  for (const [role, tier] of ROLE_TIER) if (d.roles.some((r) => r === role)) best = Math.min(best, tier);
  return best;
}

/**
 * THE signal-priority order, shared by the diagram column AND the device
 * list (Phase B: one comparator so the two panels can never disagree).
 * Stable within a tier: manifest order breaks ties, so two same-tier
 * devices keep the order the owner wrote them in.
 */
export function signalOrder(devices: readonly RigViewDevice[]): RigViewDevice[] {
  return [...devices]
    .map((d, i) => ({ d, tier: tierOf(d), i }))
    .sort((a, b) => a.tier - b.tier || a.i - b.i)
    .map((x) => x.d);
}

/** A glyph per device, drawn from what the thing IS. Never the only channel: every box carries its roles in text too. */
function glyphOf(d: RigViewDevice): string {
  const has = (r: string): boolean => d.roles.some((x) => x === r);
  if (has('monitor') && !has('looper')) return '▶';       // play / front of house
  if (has('looper')) return '↻';                          // loop
  if (has('midi_router')) return '⑂';                     // fan-out
  if (has('clock_master') || has('sequencer')) return '▦'; // step grid
  if (has('controller')) return '◎';                      // footswitch
  if (has('sampler')) return '▣';                         // pads
  if (has('effect') && !has('sound_source')) return '∿';   // waveform
  return '♪';                                             // instrument
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Trim to a width the box can hold without an ellipsis mid-word. */
function fit(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

// ─── cable lanes ────────────────────────────────────────────────────────────

interface Run { link: RigViewLink; y1: number; y2: number; lane: number; side: 'left' | 'right' }

/**
 * Spread the cables that meet one device on one side across the height of its
 * box instead of converging them on a single point.
 *
 * This rig's looper takes NINE inbound cables. Landing them all at the box's
 * vertical centre draws nine arrowheads on top of each other, which reads as
 * one thick smudge and makes the busiest device in the rig the least legible
 * one. Endpoints are ordered by where the OTHER end sits, so the fan does not
 * cross itself.
 */
function spreadEndpoints(runs: Run[], centre: Map<string, number>): void {
  const groups = new Map<string, { run: Run; end: 1 | 2 }[]>();
  for (const run of runs) {
    const push = (node: string, end: 1 | 2): void => {
      const key = `${node}|${run.side}`;
      groups.set(key, [...(groups.get(key) ?? []), { run, end }]);
    };
    push(run.link.from.node, 1);
    push(run.link.to.node, 2);
  }
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const cy = centre.get(key.split('|')[0]);
    if (cy === undefined) continue;
    const span = Math.min(BOX_H - 18, (members.length - 1) * 11);
    const step = members.length > 1 ? span / (members.length - 1) : 0;
    members
      .sort((a, b) => (a.end === 1 ? a.run.y2 : a.run.y1) - (b.end === 1 ? b.run.y2 : b.run.y1))
      .forEach((m, i) => {
        const y = cy - span / 2 + i * step;
        if (m.end === 1) m.run.y1 = y; else m.run.y2 = y;
      });
  }
}

/**
 * Assign each cable a gutter lane so two cables never share a vertical line
 * over the same rows. Interval-graph colouring, greedy, longest span first: the
 * long runs take the outer lanes and short hops sit close to the boxes, which
 * is what makes a dense diagram legible rather than a bundle.
 */
function assignLanes(runs: Run[]): void {
  for (const side of ['left', 'right'] as const) {
    const lanes: { top: number; bottom: number }[][] = [];
    const mine = runs.filter((r) => r.side === side)
      .sort((a, b) => Math.abs(b.y2 - b.y1) - Math.abs(a.y2 - a.y1));
    for (const run of mine) {
      const top = Math.min(run.y1, run.y2);
      const bottom = Math.max(run.y1, run.y2);
      let lane = lanes.findIndex((occupied) => occupied.every((o) => bottom <= o.top || top >= o.bottom));
      if (lane === -1) { lanes.push([]); lane = lanes.length - 1; }
      lanes[lane].push({ top, bottom });
      run.lane = lane;
    }
  }
}

/** Orthogonal path from a box edge, out to the lane, down/up, and back in. */
function cablePath(run: Run): string {
  const { y1, y2, lane, side } = run;
  const edge = side === 'left' ? BOX_X : BOX_X + BOX_W;
  const dir = side === 'left' ? -1 : 1;
  const x = edge + dir * (18 + lane * LANE);
  const down = y2 > y1;
  const r = Math.min(RADIUS, Math.abs(y2 - y1) / 2);
  const vy1 = y1 + (down ? r : -r);
  const vy2 = y2 + (down ? -r : r);
  const sweep1 = (down ? dir < 0 : dir > 0) ? 0 : 1;
  const sweep2 = (down ? dir > 0 : dir < 0) ? 0 : 1;
  // out, elbow, vertical run, elbow, back in to the arrowhead
  return [
    `M ${edge + dir * 2} ${y1}`,
    `H ${x - dir * r}`,
    `A ${r} ${r} 0 0 ${sweep1} ${x} ${vy1}`,
    `V ${vy2}`,
    `A ${r} ${r} 0 0 ${sweep2} ${x - dir * r} ${y2}`,
    `H ${edge + dir * 9}`,
  ].join(' ');
}

/** Which gutter a signal belongs in: audio right, everything that controls left. */
const sideOf = (l: RigViewLink): 'left' | 'right' => (l.kind === 'audio' ? 'right' : 'left');

function cableClass(l: RigViewLink): string {
  const c = ['cable', l.kind];
  if (l.timing) c.push('timing');
  if (l.governed) c.push('governed');
  if (!l.enabled) c.push('planned');
  return c.join(' ');
}

// ─── render ─────────────────────────────────────────────────────────────────

export interface DiagramResult { svg: string; height: number }

/**
 * Emit the whole diagram. `role="img"` with a summarising label, because the
 * accessible content is the text rendering and the device list, not
 * node-by-node keyboard navigation inside an SVG.
 */
export function renderDiagram(view: RigView): DiagramResult {
  const ordered = signalOrder(view.devices);

  const yOf = new Map<string, number>();
  ordered.forEach((d, i) => yOf.set(d.id, PAD_TOP + i * ROW_H + BOX_H / 2));
  const height = PAD_TOP + ordered.length * ROW_H + PAD_BOTTOM;

  const runs: Run[] = view.links
    .filter((l) => yOf.has(l.from.node) && yOf.has(l.to.node) && l.from.node !== l.to.node)
    .map((l) => ({ link: l, y1: yOf.get(l.from.node)!, y2: yOf.get(l.to.node)!, lane: 0, side: sideOf(l) }));
  spreadEndpoints(runs, yOf);
  assignLanes(runs);

  const cables = runs.map((run) => {
    const l = run.link;
    const title = `${l.from.node_name} (${l.from.port_label}) to ${l.to.node_name} (${l.to.port_label}): ${l.label}` +
      (l.enabled ? '' : ' [planned, not patched]') + (l.governed ? ` [governed by ${l.binding}]` : '');
    return `<g class="${cableClass(l)}" data-from="${esc(l.from.node)}" data-to="${esc(l.to.node)}">` +
      `<title>${esc(title)}</title>` +
      `<path d="${cablePath(run)}" marker-end="url(#tip-${l.kind === 'audio' ? 'a' : l.timing ? 'c' : l.kind === 'footswitch' ? 'f' : 'm'})" />` +
      `</g>`;
  }).join('');

  const boxes = ordered.map((d) => {
    const y = yOf.get(d.id)! - BOX_H / 2;
    const cls = ['device', d.opaque ? 'opaque' : ''].filter(Boolean).join(' ');
    const roles = fit(d.roles.join(' · '), 40);
    const heard = d.audio_status === 'reaches_output';
    const unheard = d.audio_status === 'no_output' || d.audio_status === 'dead_end';
    return `<g class="${cls}" data-device="${esc(d.id)}" tabindex="0" role="button" ` +
      `aria-label="${esc(`${d.name}. ${d.roles.join(', ')}. ${d.sends.length} out, ${d.receives.length} in.`)}">` +
      `<rect x="${BOX_X}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="10" />` +
      `<text class="ico" x="${BOX_X + 20}" y="${y + BOX_H / 2 + 6}">${glyphOf(d)}</text>` +
      `<text class="nm" x="${BOX_X + 44}" y="${y + 23}">${esc(fit(d.name, 34))}</text>` +
      `<text class="rl" x="${BOX_X + 44}" y="${y + 39}">${esc(roles)}</text>` +
      (heard ? `<rect class="heard" x="${BOX_X + BOX_W - 20}" y="${y + BOX_H / 2 - 4}" width="8" height="8"><title>Audio reaches front of house</title></rect>` : '') +
      (unheard ? `<rect class="unheard" x="${BOX_X + BOX_W - 20}" y="${y + BOX_H / 2 - 4}" width="8" height="8"><title>Will not be heard</title></rect>` : '') +
      `</g>`;
  }).join('');

  const marker = (id: string, cls: string): string =>
    `<marker id="tip-${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5.5" markerHeight="5.5" orient="auto">` +
    `<path class="${cls}" d="M0 0 L8 4 L0 8 z" /></marker>`;

  const label = `Signal-flow diagram: ${view.counts.devices} devices, ${view.counts.links} cables. ` +
    `Control signals run down the left gutter, audio down the right. The same information is in the device list and the text rendering below.`;

  const svg = `<svg viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" ` +
    `role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs>${marker('a', 'tip-audio')}${marker('m', 'tip-midi')}${marker('c', 'tip-timing')}${marker('f', 'tip-fsw')}</defs>` +
    `<g class="cables">${cables}</g><g class="devices">${boxes}</g></svg>`;

  return { svg, height };
}
