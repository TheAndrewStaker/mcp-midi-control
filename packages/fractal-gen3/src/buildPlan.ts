/**
 * Gen-3 fresh-build PLANNER (pure, no I/O): turns an apply_preset spec into
 * the exact grid a build will lay down on an EMPTY edit buffer, or into
 * validation errors with zero writes sent.
 *
 * Owns:
 *  - block resolution (slug + instance -> effect id), grid bounds, duplicate
 *    blocks and duplicate cells, and per-device instance limits
 *    (instanceLimits.ts);
 *  - ROUTING INFERENCE when `routing` is omitted: the chain is the blocks on
 *    one row, left to right. Input 1 (effect 37) goes in column 1, Output 1
 *    (effect 42) in the column after the last block, both on the chain's row;
 *    every empty column between them gets a shunt; every adjacent pair is
 *    cabled. An empty gen-3 preset has NO Input / Output block (the bundled
 *    templates), so a build that skips them passes no audio. Prior art that
 *    builds the same shape: ai-tone-assistant fm9_apply_graph (MIT),
 *    fractal-remote planBuild (reference only, Input c1 / Output next col);
 *  - EXPLICIT routing: edges resolved by slot id (a miss is an error, never a
 *    skipped edge), `to: "OUTPUT"` places Output 1 after the right-most block
 *    unless the spec places one, and a non-adjacent edge is bridged with
 *    shunts on the destination row (ai-tone-assistant / Axis planConnect: first
 *    cable (r1,c1) -> (r2,c1+1), then along r2). A bridge through an occupied
 *    cell is an error;
 *  - SHUNTS: effect id 1024 + n, n unique and lowest-free from 0 (the grid is
 *    cleared first). Evidence: our FM9-Edit capture inserts shunts as
 *    sub=0x32 with id hi byte 0x08 and lo byte 0, 1, 2 (primitive
 *    gen3-fn01-grid-set-position-insert); ai-tone-assistant add_shunt_at
 *    numbers from 0; the live grid read decodes 1024 + index;
 *  - SCENE COMPLETION: every scene of the device states channel + bypass for
 *    every placed block. Scene 1: what the spec says, else channel A, and
 *    engaged unless the slot is `bypassed`. An authored scene fills what it
 *    leaves out from scene 1; an unauthored scene copies scene 1.
 *
 * Grid coordinates here are 1-based (the tool surface); the live grid read is
 * 0-based and converted by the caller.
 */
import type { PresetSpec, ValidationError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { instanceLimitFor } from './instanceLimits.js';

export const INPUT_1_EFFECT_ID = 37;
export const OUTPUT_1_EFFECT_ID = 42;
export const SHUNT_EFFECT_ID_BASE = 1024;
const INPUT_IDS = new Set([37, 38, 39, 40, 41]);
const OUTPUT_IDS = new Set([42, 43, 44, 45]);

export type PlannedCellKind = 'block' | 'input' | 'output' | 'shunt';

export interface PlannedCell {
  row: number;
  col: number;
  /** Effect id, or 1024 + n for a shunt. */
  effectId: number;
  kind: PlannedCellKind;
  /** Index into spec.slots when the cell came from the spec. */
  slotIndex?: number;
  /** Catalog slug ('amp', 'input', ...); undefined for a shunt. */
  block?: string;
  instance?: number;
  /** Canonical slot id (explicit id, else slug / slug_N). */
  id?: string;
  /** Added by the planner (Input / Output / shunt the spec did not place). */
  auto?: boolean;
}

export interface PlannedCable {
  from: { row: number; col: number };
  to: { row: number; col: number };
}

export interface SceneBlockState {
  effectId: number;
  /** Canonical slot id (for receipts). */
  id: string;
  /** Wire channel index (0 = A). */
  channel: number;
  bypassed: boolean;
}

export interface PlannedScene {
  /** 1-based scene number. */
  scene: number;
  name?: string;
  /** True when the spec authored this scene (false: copied from scene 1). */
  authored: boolean;
  blocks: SceneBlockState[];
}

export interface BuildPlan {
  mode: 'inferred' | 'explicit';
  cells: PlannedCell[];
  cables: PlannedCable[];
  scenes: PlannedScene[];
  /** True when any scene state differs from a fresh insert (channel A, engaged). */
  scenesNeedWriting: boolean;
  /** The chain row (inferred mode), 1-based. */
  chainRow?: number;
  notes: string[];
  /** Canonical slot id -> cell, for every placed spec slot. */
  byId: Map<string, PlannedCell>;
}

export interface PlanContext {
  rows: number;
  cols: number;
  modelByte: number;
  sceneCount: number;
  channelNames: readonly string[];
  deviceLabel: string;
  /** Resolve a catalog slug + instance to its effect id; throws on an unknown block / instance. */
  resolveEffectId: (slug: string, instance: number) => number;
}

const isEmptyType = (t: string): boolean => t === '' || t === 'none' || t === 'empty';

/** Canonical id of a slot, plus the aliases scene maps / edges may use for it. */
export function slotIdsFor(s: { block_type: string; instance?: number; id?: string }): { canonical: string; aliases: string[] } {
  const slug = s.block_type.trim().toLowerCase();
  const inst = s.instance ?? 1;
  const derived = inst === 1 ? slug : `${slug}_${inst}`;
  const canonical = s.id ?? derived;
  const aliases = new Set<string>([canonical, derived, `${slug}_${inst}`]);
  if (inst === 1) aliases.add(slug);
  return { canonical, aliases: [...aliases] };
}

/** Plan a fresh build. Returns errors (nothing to send) or the plan. */
export function planGen3Build(spec: PresetSpec, ctx: PlanContext): { plan?: BuildPlan; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const notes: string[] = [];
  const cells: PlannedCell[] = [];
  const at = new Map<string, PlannedCell>();
  const key = (r: number, c: number): string => `${r},${c}`;
  const byId = new Map<string, PlannedCell>();
  const aliasTo = new Map<string, string>();
  const usedEffect = new Map<number, number>();
  const instancesByBlock = new Map<string, number>();
  let nextShunt = 0;
  const usedShunts = new Set<number>();
  const allocShunt = (): number => {
    while (usedShunts.has(nextShunt)) nextShunt++;
    usedShunts.add(nextShunt);
    return SHUNT_EFFECT_ID_BASE + nextShunt;
  };

  // 1. Slots -> cells.
  spec.slots.forEach((s, i) => {
    const path = `slots[${i}]`;
    const slug = s.block_type.trim().toLowerCase();
    if (typeof s.slot !== 'object' || s.slot === null) {
      errors.push({ slot_index: i, path: `${path}.slot`, error: `${ctx.deviceLabel} places blocks on a grid: slot must be {row, col}, got ${JSON.stringify(s.slot)}.` });
      return;
    }
    const { row, col } = s.slot as { row: number; col: number };
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 1 || row > ctx.rows || col < 1 || col > ctx.cols) {
      errors.push({ slot_index: i, path: `${path}.slot`, error: `{row:${row}, col:${col}} is outside ${ctx.deviceLabel}'s ${ctx.rows}x${ctx.cols} grid (row 1..${ctx.rows}, col 1..${ctx.cols}).` });
      return;
    }
    if (isEmptyType(slug)) return; // an explicitly empty cell: nothing to place on a cleared grid
    const prior = at.get(key(row, col));
    if (prior) {
      errors.push({ slot_index: i, path: `${path}.slot`, error: `r${row}c${col} is already taken by slots[${prior.slotIndex}] (${prior.block ?? 'shunt'}). One block per grid location.` });
      return;
    }
    let cell: PlannedCell;
    if (slug === 'shunt') {
      cell = { row, col, effectId: allocShunt(), kind: 'shunt', slotIndex: i };
    } else {
      const inst = s.instance ?? 1;
      let effectId: number;
      try {
        effectId = ctx.resolveEffectId(slug, inst);
      } catch (err) {
        errors.push({ slot_index: i, path: `${path}.block_type`, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const limit = instanceLimitFor(ctx.modelByte, slug);
      if (limit !== undefined && inst > limit.limit) {
        errors.push({
          slot_index: i, path: `${path}.instance`,
          error: `${ctx.deviceLabel} allows ${limit.limit} ${slug} block${limit.limit === 1 ? '' : 's'}; instance ${inst} does not exist on the unit (source: ${limit.evidence}).`,
        });
        return;
      }
      const dup = usedEffect.get(effectId);
      if (dup !== undefined) {
        errors.push({
          slot_index: i, path: `${path}.instance`,
          error: `slots[${dup}] already places ${slug} ${inst}. A block can sit in one grid location only: give this one instance ${(instancesByBlock.get(slug) ?? inst) + 1}, or remove the duplicate.`,
        });
        return;
      }
      usedEffect.set(effectId, i);
      instancesByBlock.set(slug, Math.max(instancesByBlock.get(slug) ?? 0, inst));
      const kind: PlannedCellKind = INPUT_IDS.has(effectId) ? 'input' : OUTPUT_IDS.has(effectId) ? 'output' : 'block';
      const ids = slotIdsFor(s);
      cell = { row, col, effectId, kind, slotIndex: i, block: slug, instance: inst, id: ids.canonical };
      if (byId.has(ids.canonical)) {
        errors.push({ slot_index: i, path: `${path}.id`, error: `slot id "${ids.canonical}" is used twice; ids must be unique.` });
        return;
      }
      byId.set(ids.canonical, cell);
      for (const a of ids.aliases) if (!aliasTo.has(a)) aliasTo.set(a, ids.canonical);
    }
    cells.push(cell);
    at.set(key(row, col), cell);
  });
  if (errors.length) return { errors };

  const resolveRef = (ref: string): PlannedCell | undefined => {
    const c = aliasTo.get(ref) ?? aliasTo.get(ref.trim().toLowerCase());
    return c !== undefined ? byId.get(c) : undefined;
  };
  const place = (c: PlannedCell): void => { cells.push(c); at.set(key(c.row, c.col), c); };
  const cables: PlannedCable[] = [];
  const cableKey = new Set<string>();
  const addCable = (from: { row: number; col: number }, to: { row: number; col: number }): void => {
    const k = `${from.row},${from.col}>${to.row},${to.col}`;
    if (cableKey.has(k)) return;
    cableKey.add(k);
    cables.push({ from: { ...from }, to: { ...to } });
  };
  /** Cable src -> dst, bridging empty columns with shunts on dst's row. */
  const connect = (src: PlannedCell, dst: PlannedCell, path: string, routingIndex?: number): boolean => {
    if (dst.col <= src.col) {
      errors.push({ routing_index: routingIndex, path, error: `${src.id ?? `r${src.row}c${src.col}`} (col ${src.col}) -> ${dst.id ?? `r${dst.row}c${dst.col}`} (col ${dst.col}): signal flows left to right, the destination must be in a later column.` });
      return false;
    }
    let prev: { row: number; col: number } = src;
    for (let c = src.col + 1; c < dst.col; c++) {
      const occupant = at.get(key(dst.row, c));
      if (occupant && occupant.kind !== 'shunt') {
        errors.push({ routing_index: routingIndex, path, error: `bridging ${src.id ?? 'source'} -> ${dst.id ?? 'destination'} needs a shunt at r${dst.row}c${c}, but ${occupant.id ?? occupant.block} sits there. Move one of them, or route around it explicitly.` });
        return false;
      }
      const shunt = occupant ?? { row: dst.row, col: c, effectId: allocShunt(), kind: 'shunt' as const, auto: true };
      if (!occupant) place(shunt);
      addCable(prev, shunt);
      prev = shunt;
    }
    addCable(prev, dst);
    return true;
  };

  const content = cells.filter((c) => c.kind !== 'shunt');
  const specInput = cells.filter((c) => c.kind === 'input');
  const specOutput = cells.filter((c) => c.kind === 'output');
  let mode: 'inferred' | 'explicit';
  let chainRow: number | undefined;

  if (!spec.routing || spec.routing.length === 0) {
    mode = 'inferred';
    const placed = cells.filter((c) => c.kind === 'block' || c.kind === 'shunt');
    const rowsUsed = [...new Set(cells.map((c) => c.row))];
    if (rowsUsed.length > 1) {
      errors.push({
        path: 'routing',
        error: `routing is omitted, so the chain is inferred along ONE row, but the blocks sit on rows ${rowsUsed.sort((a, b) => a - b).join(', ')}. Put the chain on one row, or pass routing[] edges (use {to:"OUTPUT"} on the last block).`,
      });
      return { errors };
    }
    chainRow = rowsUsed[0] ?? Math.min(ctx.rows, ctx.rows === 4 ? 2 : 3);
    const firstNonInput = placed.length ? Math.min(...placed.map((c) => c.col)) : Infinity;
    if (specInput.length > 1 || specOutput.length > 1) {
      errors.push({ path: 'routing', error: 'an inferred chain has one Input and one Output; with more, pass routing[] edges.' });
      return { errors };
    }
    let input = specInput[0];
    if (input && placed.some((c) => c.col <= input!.col)) {
      errors.push({ slot_index: input.slotIndex, path: `slots[${input.slotIndex}].slot`, error: 'the Input block must be left of every other block in an inferred chain.' });
      return { errors };
    }
    if (!input) {
      if (firstNonInput === 1) {
        const c1 = placed.find((c) => c.col === 1)!;
        errors.push({
          slot_index: c1.slotIndex, path: `slots[${c1.slotIndex}].slot`,
          error: `routing is omitted, so Input 1 goes in column 1, but ${c1.id ?? 'a shunt'} is there. Start the chain at column 2 (the build adds Input 1 at r${chainRow}c1 and Output 1 after the last block), or place an "input" block yourself.`,
        });
        return { errors };
      }
      input = { row: chainRow, col: 1, effectId: INPUT_1_EFFECT_ID, kind: 'input', block: 'input', instance: 1, id: 'input', auto: true };
      place(input);
      notes.push(`added Input 1 at r${chainRow}c1`);
    }
    let output = specOutput[0];
    const lastCol = Math.max(input.col, ...placed.map((c) => c.col));
    if (output && output.col <= lastCol) {
      errors.push({ slot_index: output.slotIndex, path: `slots[${output.slotIndex}].slot`, error: 'the Output block must be right of every other block in an inferred chain.' });
      return { errors };
    }
    if (!output) {
      if (lastCol + 1 > ctx.cols) {
        errors.push({ path: 'slots', error: `the chain reaches column ${lastCol}, the last column of ${ctx.deviceLabel}'s grid, so there is no room for Output 1. End the chain at column ${ctx.cols - 1} or earlier.` });
        return { errors };
      }
      output = { row: chainRow, col: lastCol + 1, effectId: OUTPUT_1_EFFECT_ID, kind: 'output', block: 'output', instance: 1, id: 'output', auto: true };
      place(output);
      notes.push(`added Output 1 at r${chainRow}c${lastCol + 1}`);
    }
    // Walk the row left to right, shunting every gap.
    const ordered = [input, ...placed.sort((a, b) => a.col - b.col), output];
    for (let k = 0; k + 1 < ordered.length; k++) {
      if (!connect(ordered[k], ordered[k + 1], 'routing')) return { errors };
    }
  } else {
    mode = 'explicit';
    // OUTPUT sentinel -> the spec's Output, else Output 1 after the right-most block.
    let output = specOutput[0];
    const outputEdge = spec.routing.findIndex((e) => e.to === 'OUTPUT');
    if (!output && outputEdge >= 0) {
      const src = resolveRef(spec.routing[outputEdge].from);
      const maxCol = Math.max(0, ...content.map((c) => c.col), ...cells.map((c) => c.col));
      if (maxCol + 1 > ctx.cols) {
        errors.push({ routing_index: outputEdge, path: `routing[${outputEdge}].to`, error: `{to:"OUTPUT"} places Output 1 after the right-most block (column ${maxCol}), but that is the last column. End the chain at column ${ctx.cols - 1} or earlier.` });
        return { errors };
      }
      if (src) {
        output = { row: src.row, col: maxCol + 1, effectId: OUTPUT_1_EFFECT_ID, kind: 'output', block: 'output', instance: 1, id: 'output', auto: true };
        place(output);
        notes.push(`added Output 1 at r${src.row}c${maxCol + 1} for {to:"OUTPUT"}`);
      }
    }
    const incoming = new Set<PlannedCell>();
    spec.routing.forEach((e, i) => {
      const path = `routing[${i}]`;
      if (e.from === 'OUTPUT') {
        errors.push({ routing_index: i, path: `${path}.from`, error: '"OUTPUT" can only be a destination.' });
        return;
      }
      const src = resolveRef(e.from);
      const dst = e.to === 'OUTPUT' ? output : resolveRef(e.to);
      if (!src) errors.push({ routing_index: i, path: `${path}.from`, error: `no slot has id "${e.from}". Valid ids: ${[...byId.keys()].join(', ') || '(none)'}.` });
      if (!dst) errors.push({ routing_index: i, path: `${path}.to`, error: `no slot has id "${e.to}". Valid ids: ${[...byId.keys()].join(', ') || '(none)'}, or "OUTPUT".` });
      if (!src || !dst) return;
      if (e.connect === false) {
        notes.push(`routing[${i}] {connect:false} skipped: the build starts from an empty grid, so there is no cable to remove`);
        return;
      }
      if (connect(src, dst, path, i)) incoming.add(dst);
    });
    if (errors.length) return { errors };
    // Feed every block nothing feeds from Input 1 (added when the spec has none).
    const roots = content.filter((c) => c.kind === 'block' && !incoming.has(c));
    if (specInput.length === 0 && roots.length > 0) {
      const leftmost = roots.reduce((a, b) => (b.col < a.col ? b : a));
      const atCol1 = roots.find((c) => c.col === 1);
      if (atCol1) {
        errors.push({ slot_index: atCol1.slotIndex, path: `slots[${atCol1.slotIndex}].slot`, error: `${atCol1.id} is in column 1 and nothing feeds it, so it gets no signal: Input 1 needs column 1. Move the chain one column right, or place an "input" block and route it.` });
        return { errors };
      }
      const occupant = at.get(key(leftmost.row, 1));
      if (occupant) {
        errors.push({ path: 'slots', error: `Input 1 would go at r${leftmost.row}c1 to feed ${leftmost.id}, but ${occupant.id ?? 'a shunt'} is there. Place an "input" block and route it explicitly.` });
        return { errors };
      }
      const input: PlannedCell = { row: leftmost.row, col: 1, effectId: INPUT_1_EFFECT_ID, kind: 'input', block: 'input', instance: 1, id: 'input', auto: true };
      place(input);
      notes.push(`added Input 1 at r${leftmost.row}c1 feeding ${roots.map((r) => r.id).join(', ')}`);
      for (const r of roots) if (!connect(input, r, 'routing')) return { errors };
    }
    if (!output && outputEdge < 0) notes.push('no edge reaches "OUTPUT" and the spec places no Output block, so this preset passes no audio');
  }

  // 3. Scenes.
  const sceneBlocks = cells.filter((c) => c.kind === 'block');
  const channelIndex = (v: string | number): number | undefined => {
    if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v < ctx.channelNames.length ? v : undefined;
    const i = ctx.channelNames.findIndex((n) => n.toUpperCase() === String(v).trim().toUpperCase());
    return i >= 0 ? i : undefined;
  };
  const authored = new Map<number, { index: number; s: NonNullable<PresetSpec['scenes']>[number] }>();
  (spec.scenes ?? []).forEach((s, i) => {
    if (!Number.isInteger(s.scene) || s.scene < 1 || s.scene > ctx.sceneCount) {
      errors.push({ scene_index: i, path: `scenes[${i}].scene`, error: `scene ${s.scene} is out of range (1..${ctx.sceneCount}).` });
      return;
    }
    if (authored.has(s.scene)) {
      errors.push({ scene_index: i, path: `scenes[${i}].scene`, error: `scene ${s.scene} is authored twice.` });
      return;
    }
    authored.set(s.scene, { index: i, s });
    for (const [k, v] of Object.entries(s.channels ?? {})) {
      const c = resolveRef(k);
      if (!c || c.kind !== 'block') errors.push({ scene_index: i, path: `scenes[${i}].channels.${k}`, error: `"${k}" is not a placed block. Valid ids: ${sceneBlocks.map((b) => b.id).join(', ') || '(none)'}.` });
      else if (channelIndex(v) === undefined) errors.push({ scene_index: i, path: `scenes[${i}].channels.${k}`, error: `channel ${JSON.stringify(v)} is not valid (use ${ctx.channelNames.join('/')}).` });
    }
    for (const k of Object.keys(s.bypassed ?? {})) {
      const c = resolveRef(k);
      if (!c || c.kind !== 'block') errors.push({ scene_index: i, path: `scenes[${i}].bypassed.${k}`, error: `"${k}" is not a placed block. Valid ids: ${sceneBlocks.map((b) => b.id).join(', ') || '(none)'}.` });
    }
  });
  if (errors.length) return { errors };
  const stateFrom = (s: NonNullable<PresetSpec['scenes']>[number] | undefined, base: (c: PlannedCell) => { channel: number; bypassed: boolean }): SceneBlockState[] =>
    sceneBlocks.map((c) => {
      const b = base(c);
      let channel = b.channel;
      let bypassed = b.bypassed;
      for (const [k, v] of Object.entries(s?.channels ?? {})) if (resolveRef(k) === c) channel = channelIndex(v)!;
      for (const [k, v] of Object.entries(s?.bypassed ?? {})) if (resolveRef(k) === c) bypassed = v;
      return { effectId: c.effectId, id: c.id!, channel, bypassed };
    });
  const scene1 = stateFrom(authored.get(1)?.s, (c) => ({ channel: 0, bypassed: spec.slots[c.slotIndex!]?.bypassed === true }));
  const scenes: PlannedScene[] = [];
  for (let n = 1; n <= ctx.sceneCount; n++) {
    const a = authored.get(n);
    const blocks = n === 1 ? scene1 : stateFrom(a?.s, (c) => scene1.find((x) => x.effectId === c.effectId)!);
    scenes.push({ scene: n, ...(a?.s.name !== undefined ? { name: a.s.name } : {}), authored: a !== undefined, blocks });
  }
  const scenesNeedWriting = scenes.some((s) => s.blocks.some((b) => b.channel !== 0 || b.bypassed));
  return { plan: { mode, cells, cables, scenes, scenesNeedWriting, chainRow, notes, byId }, errors };
}

/** Per destination cell, the input mask the plan expects (bit k = row k+1 of the previous column). */
export function expectedInputMasks(plan: BuildPlan): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of plan.cables) {
    const k = `${c.to.row},${c.to.col}`;
    m.set(k, (m.get(k) ?? 0) | (1 << (c.from.row - 1)));
  }
  return m;
}
