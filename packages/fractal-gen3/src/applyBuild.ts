/**
 * Gen-3 grid apply_preset EXECUTOR: a fresh build on the edit buffer.
 *
 * Owns the ORDER of a build and its receipt. The layout comes from the pure
 * planner (buildPlan.ts), the read-back and judgement from buildVerify.ts,
 * and every wire op from the writer's own helpers.
 *
 * Seams (chunk C replaces step 4-6 with one whole-preset transfer):
 *  - planForDevice(spec)            -> BuildPlan          (pure)
 *  - targetStateFromPlan(plan, ...) -> Gen3TargetState    (pure: what the
 *                                       edit buffer must hold afterwards)
 *  - realizeTargetLive(...)         -> writes it cell by cell (this file)
 *  - judgeBuild(plan, readBack)     -> chain_integrity     (buildVerify.ts)
 *
 *  1. Plan (zero writes on any error).
 *  2. target_location: checkGen3ApplyTarget refuses a save over an occupied
 *     location that is not the loaded one (the dispatcher also runs it BEFORE
 *     its dirty guard), then switch and confirm the switch.
 *  3. Read the loaded preset's name.
 *  4. CLEAR: load the bundled empty template through the verified edit-buffer
 *     load (sent, read back, compared). Else clear every occupied cell, right
 *     column first, select + insert 0 with >= 40 ms around each
 *     (axefx-sysex-maps III TOPOLOGY: faster deletes drop), and re-read the
 *     grid to prove it is empty (ToneCommand issue #250 saw an FM9 fw 11 go
 *     silent after a per-cell clear and re-lay, so the receipt says so).
 *  5. Place every planned cell, cable every planned pair, write params. An
 *     insert answered with 0x64 code 0 or 2 is ambiguous (axefx-sysex-maps:
 *     the III's place ack carries 00 placed / 02 no-op), so the read-back
 *     judges it; a shunt answered 2 retries with the next index.
 *     Channel-nested params select each channel on the ACTIVE scene, so the
 *     planned channel is restored afterwards and the scene re-checked.
 *  6. Scenes: walk every scene when any scene differs from a fresh insert
 *     (channel A, engaged), scenes are authored, or the active scene's status
 *     read differs from the plan.
 *  7. Landing scene, preset name (spec.name, else the loaded preset's name;
 *     never "<EMPTY>"; a save with neither gets "New Preset").
 *  8. VERIFY (judgeBuild): live grid, else the edit-buffer dump. Cells,
 *     masks and the audio path. No read at all is NOT VERIFIED and ok:false.
 *  9. Save only when the build is fully ok, inside the budget, authorized.
 */
import type {
  ApplyPresetOptions,
  ApplyResult,
  ChainIntegrityResult,
  DeviceWriter,
  DispatchCtx,
  LocationRef,
  PresetSpec,
  ValidationError,
  WriteResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { markDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';
import { ROUTING_OP_CONNECT, type ModernFractalCodec } from 'fractal-midi/gen3/axe-fx-iii';
import type { ModernCatalog } from './catalog.js';
import type { WriterShape } from './writer.js';
import { injectGen3CabPolish } from './cabPolish.js';
import { planGen3Build, SHUNT_EFFECT_ID_BASE, type BuildPlan, type PlannedCell } from './buildPlan.js';
import { readActiveScene, readLiveGrid, readStatus } from './liveGrid.js';
import { loadPresetDumpVerified } from './presetDumpLoad.js';
import type { ParsedPresetDump } from './presetDump.js';
import { EMPTY_PRESET_TEMPLATES, loadEmptyPresetTemplate } from './emptyPresetTemplates.js';
import { describePlannedCell as describeCell, judgeBuild, readBackGrid } from './buildVerify.js';

// Kept importable from here for existing callers.
export { compareGridWithPlan, chainFromLiveGrid, verifyGen3Chain } from './buildVerify.js';

/** Insert / cable rejection window: a 0x64 lands in 30-60 ms; the read-back is the judge. */
export const PLACE_WINDOW_MS = 80;
export const CABLE_WINDOW_MS = 80;
export const SCENE_WRITE_WINDOW_MS = 60;
/** Select -> insert gap (writer.setBlock uses the same). */
export const SELECT_GAP_MS = 15;
/** Per-cell clear pacing (axefx-sysex-maps TOPOLOGY, III fw 32.02: >= 40 ms per delete or they drop). */
export const CLEAR_GAP_MS = 40;
/** Name a saved build gets when neither the spec nor the loaded preset names it. */
export const DEFAULT_SAVE_NAME = 'New Preset';

/**
 * Whole-build ceiling. Well under the MCP host's ~60 s tool timeout: the
 * verified template load alone may take up to 25 s on a slow serial unit.
 */
export const GEN3_APPLY_BUDGET_MS = (() => {
  const env = Number(process.env.MCP_APPLY_BUDGET_MS);
  return Number.isFinite(env) && env > 0 ? env : 40_000;
})();

export interface BuildDeps {
  writer: DeviceWriter;
  codec: ModernFractalCodec;
  catalog: ModernCatalog;
  shape: WriterShape;
  deviceLabel: string;
  connectionLabel: string;
  betaWarning: string;
  getResponseTimeoutMs: number;
  channelValues: Readonly<Record<string, number>>;
  sendAndWatchForError: (ctx: DispatchCtx, bytes: number[], windowMs?: number) => Promise<{ resultCode: number; description?: string } | undefined>;
  queryPatchName: (ctx: DispatchCtx, preset: number | 'current', timeoutMs?: number) => Promise<{ presetNumber: number; name: string } | undefined>;
  formatErrorCode: (r: { resultCode: number; description?: string }) => string;
  parseLocation: (l: LocationRef) => number;
  /** Test hooks. */
  sleep?: (ms: number) => Promise<void>;
  loadTemplate?: (modelByte: number) => ParsedPresetDump | undefined;
}

/** Plan a spec for this device (preflight + executor share it). */
export function planForDevice(deps: Pick<BuildDeps, 'catalog' | 'shape' | 'codec' | 'deviceLabel'>, spec: PresetSpec): { plan?: BuildPlan; errors: ValidationError[] } {
  const grid = deps.shape.grid;
  if (grid === undefined) return { errors: [{ path: 'slots', error: `${deps.deviceLabel} has no grid; a grid build does not apply.` }] };
  return planGen3Build(spec, {
    rows: grid.rows,
    cols: grid.cols,
    modelByte: deps.codec.modelByte,
    sceneCount: deps.shape.scene_count,
    channelNames: deps.shape.channel_names,
    deviceLabel: deps.deviceLabel,
    resolveEffectId: (slug, instance) => deps.catalog.resolveBlockOrThrow(slug, deps.deviceLabel, instance).effectId,
  });
}

/** A name a preset can keep: not blank, not the template's "<EMPTY>". */
export function usablePresetName(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t !== undefined && t !== '' && t.toUpperCase() !== '<EMPTY>' ? t : undefined;
}

/**
 * What the edit buffer must hold after the build: the planned grid + scenes,
 * the landing scene, and the name. Pure. Chunk C serializes this into one
 * whole-preset transfer instead of the cell-by-cell realization below.
 */
export interface Gen3TargetState {
  plan: BuildPlan;
  name?: string;
  /** True when `name` is DEFAULT_SAVE_NAME (no name anywhere, saving). */
  defaultedName: boolean;
  landingScene: number;
}

export function targetStateFromPlan(
  plan: BuildPlan,
  spec: PresetSpec,
  sceneCount: number,
  loadedName: string | undefined,
  saving: boolean,
): Gen3TargetState {
  const name = usablePresetName(spec.name) ?? usablePresetName(loadedName);
  return {
    plan,
    name: name ?? (saving ? DEFAULT_SAVE_NAME : undefined),
    defaultedName: name === undefined && saving,
    landingScene: Math.min(sceneCount, Math.max(1, Math.trunc(spec.landingScene ?? 1))),
  };
}

/**
 * Overwrite gate for apply_preset(target, save): refuse saving over an
 * occupied location that is not the loaded one. Read-only; the dispatcher
 * runs it before its dirty guard, and the build runs it again.
 */
export async function checkGen3ApplyTarget(
  deps: Pick<BuildDeps, 'queryPatchName' | 'parseLocation'>,
  ctx: DispatchCtx,
  target: LocationRef,
  options?: ApplyPresetOptions,
): Promise<ValidationError[] | undefined> {
  if (options?.save !== true) return undefined;
  const n = deps.parseLocation(target);
  const loaded = await deps.queryPatchName(ctx, 'current');
  if (loaded?.presetNumber === n) return undefined;
  const stored = await deps.queryPatchName(ctx, n);
  const name = stored?.name.trim();
  if (stored !== undefined && usablePresetName(name) === undefined) return undefined;
  return [{
    path: 'target_location',
    error: stored === undefined
      ? `could not read what location ${n} holds, so saving over it is refused. Nothing was sent.`
      : `location ${n} holds "${name}". apply_preset does not overwrite a stored preset: audition with target_location and no save_authorized, then call save_preset({location:${n}, confirm_overwrite:true}) once the user agrees.`,
  }];
}

interface BuildState {
  writes: WriteResult[];
  anyFailed: boolean;
  budgetExceeded: boolean;
  startedMs: number;
  frames: number;
}

type Rejection = { resultCode: number; description?: string };
/** 0x64 code 0 / 2 on a build write: ambiguous (placed / no-op acks), the read-back judges. */
const isAmbiguousCode = (r: Rejection): boolean => r.resultCode === 0 || r.resultCode === 2;

/** Run a gen-3 grid apply_preset. Never throws for a device-side failure. */
export async function runGen3Build(
  deps: BuildDeps,
  ctx: DispatchCtx,
  specIn: PresetSpec,
  target?: LocationRef,
  options?: ApplyPresetOptions,
): Promise<ApplyResult> {
  const { writer, codec, catalog, shape, deviceLabel, connectionLabel, betaWarning: BETA } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const grid = shape.grid!;
  const { slots: cabPolishedSlots, cabPolish } = injectGen3CabPolish(specIn.slots, catalog.blocks['cab'], shape.channel_names[0] ?? 'A');
  const spec: PresetSpec = { ...specIn, slots: cabPolishedSlots };
  const st: BuildState = { writes: [], anyFailed: false, budgetExceeded: false, startedMs: Date.now(), frames: 0 };
  const push = (w: WriteResult): void => {
    st.writes.push(w);
    if (!w.acked && !w.unconfirmed) st.anyFailed = true;
  };
  const overBudget = (): boolean => {
    if (st.budgetExceeded) return true;
    if (Date.now() - st.startedMs <= GEN3_APPLY_BUDGET_MS) return false;
    st.budgetExceeded = true;
    push({ op: 'apply_preset', target: 'apply_preset', acked: false, warning: `${shape.id} apply_preset: total budget (${GEN3_APPLY_BUDGET_MS} ms) exceeded; remaining writes skipped and nothing saved. ${BETA}` });
    return true;
  };
  const send = (bytes: number[]): void => { st.frames++; ctx.conn.send(bytes); };
  const watch = async (bytes: number[], windowMs: number): Promise<Rejection | undefined> => {
    st.frames++;
    return deps.sendAndWatchForError(ctx, bytes, windowMs);
  };
  const notes: string[] = [];
  const saving = target !== undefined && options?.save === true;
  console.error(`apply_preset start: device=${shape.id} mode=fresh-build slots=${spec.slots.length}${target !== undefined ? ` target=${String(target)}` : ''} save=${saving}`);

  const finish = (extra: Partial<ApplyResult> & { chain?: ChainIntegrityResult; savedFlag?: boolean; validation?: ValidationError[] }): ApplyResult => {
    const failedStepIdx = st.writes.findIndex((w) => !w.acked && !w.unconfirmed);
    const ok = !st.anyFailed && extra.validation === undefined && (extra.chain?.ok ?? true);
    const elapsed = Date.now() - st.startedMs;
    const unconfirmed = st.writes.filter((w) => !w.acked && w.unconfirmed);
    if (unconfirmed.length) {
      notes.push(`${unconfirmed.length} write(s) sent but UNCONFIRMED (the unit does not echo them; check on the device): ` +
        unconfirmed.slice(0, 6).map((w) => w.target ?? w.op).join(', ') + (unconfirmed.length > 6 ? ', ...' : ''));
    }
    console.error(`apply_preset done: device=${shape.id} mode=fresh-build ok=${ok} steps=${st.writes.length} frames=${st.frames} elapsed=${elapsed} ms`);
    return {
      ok,
      steps: st.writes.length,
      duration_ms: elapsed,
      auto_applied: cabPolish,
      ...(extra.validation ? { validation_errors: extra.validation } : {}),
      failed_step: failedStepIdx >= 0 ? {
        index: failedStepIdx,
        description: st.writes[failedStepIdx].target ?? st.writes[failedStepIdx].op ?? 'step',
        error: st.writes[failedStepIdx].warning ?? 'no warning recorded',
      } : undefined,
      ...(extra.chain ? { chain_integrity: extra.chain } : {}),
      warning: `${shape.id} apply_preset (fresh build, ${st.frames} frames, ${elapsed} ms): ` +
        (notes.length ? `${notes.join('; ')}. ` : '') + (extra.warning ?? '') + ` ${BETA}`,
      saved: extra.savedFlag,
    };
  };

  // 1. Plan.
  const planned = planForDevice(deps, spec);
  if (!planned.plan) return finish({ validation: planned.errors, warning: 'the spec does not describe a buildable grid; nothing was sent.' });
  const plan = planned.plan;
  notes.push(...plan.notes);

  // 2. target_location: overwrite gate, switch, confirm.
  let saveBlockedReason: string | undefined;
  let n: number | undefined;
  if (target !== undefined) {
    n = deps.parseLocation(target);
    const refusal = await checkGen3ApplyTarget(deps, ctx, target, options);
    if (refusal) return finish({ validation: refusal, warning: 'refused before any write.' });
    const loaded = await deps.queryPatchName(ctx, 'current');
    if (loaded?.presetNumber !== n) {
      const sw = await writer.switchPreset!(ctx, n);
      push({ ...sw, unconfirmed: sw.acked ? undefined : sw.unconfirmed });
      if (!sw.acked && !sw.unconfirmed) {
        return finish({ warning: `the switch to location ${n} did not land, so nothing was built.` });
      }
      if (!sw.acked) saveBlockedReason = `the switch to ${n} could not be confirmed`;
    }
  }

  // 3. Read the loaded preset's name; fix the target state.
  const before = await deps.queryPatchName(ctx, 'current');
  const state = targetStateFromPlan(plan, spec, shape.scene_count, before?.name, saving);
  if (state.defaultedName) notes.push(`no name in the spec and the location had none, so it is saved as "${DEFAULT_SAVE_NAME}"`);

  // 4-6. Realize it cell by cell.
  const realized = await realizeTargetLive(deps, ctx, spec, state, st, { push, overBudget, send, watch, sleep, notes });
  if (realized.aborted) return finish({ warning: realized.aborted });

  // 7. Name. The template load renames the buffer "<EMPTY>"; the fallback
  // clear keeps it, so restore either way.
  if (!st.budgetExceeded && state.name !== undefined) {
    const r = await writer.rename!(ctx, 'preset', state.name);
    st.frames += 2;
    push({ ...r, target: usablePresetName(spec.name) !== undefined ? 'preset name' : `preset name (${state.defaultedName ? 'default' : 'restored'} "${state.name}")` });
  }

  // 8. Verify: same read for the plan compare and the audio walk.
  const chain = judgeBuild(plan, await readBackGrid(deps, ctx), deviceLabel, grid.rows);
  st.frames += chain.extra_round_trips;
  if (chain.ok) {
    // The read-back is the placement + cable confirmation.
    for (const w of st.writes) if ((w.op === 'set_block' || w.op === 'routing') && w.unconfirmed) { w.acked = true; w.unconfirmed = undefined; }
  }
  const buildOk = !st.anyFailed && chain.ok;

  // 9. Save.
  let saved: boolean | undefined;
  if (saving) {
    const late = overBudget();
    if (!buildOk || late || saveBlockedReason !== undefined) {
      saved = false;
      notes.push(`NOT saved: ${saveBlockedReason ?? (late ? 'the build ran past its time budget' : chain.ok ? 'a write did not land' : 'the read-back did not confirm the build')}`);
    } else {
      const r = await writer.savePreset!(ctx, n!);
      st.frames += 3;
      push({ ...r });
      saved = r.acked;
    }
  }
  return finish({ chain, savedFlag: saved, warning: chain.ok ? '' : 'The build is NOT confirmed as specified; see chain_integrity.' });
}

interface RealizeHelpers {
  push: (w: WriteResult) => void;
  overBudget: () => boolean;
  send: (bytes: number[]) => void;
  watch: (bytes: number[], windowMs: number) => Promise<Rejection | undefined>;
  sleep: (ms: number) => Promise<void>;
  notes: string[];
}

/**
 * Steps 4-6: clear the edit buffer, place + cable the plan, write params,
 * write the scenes. Returns `aborted` with a reason when nothing further
 * should be attempted (the buffer could not be cleared).
 */
async function realizeTargetLive(
  deps: BuildDeps,
  ctx: DispatchCtx,
  spec: PresetSpec,
  state: Gen3TargetState,
  st: BuildState,
  h: RealizeHelpers,
): Promise<{ aborted?: string }> {
  const { writer, codec, shape, deviceLabel, connectionLabel } = deps;
  const { push, overBudget, send, watch, sleep, notes } = h;
  const plan = state.plan;
  const grid = shape.grid!;
  const timeout = deps.getResponseTimeoutMs;

  // 4. Clear.
  const tpl = deps.loadTemplate ? deps.loadTemplate(codec.modelByte) : EMPTY_PRESET_TEMPLATES[codec.modelByte] ? loadEmptyPresetTemplate(codec.modelByte).dump : undefined;
  let cleared = false;
  if (tpl) {
    const evidence = EMPTY_PRESET_TEMPLATES[codec.modelByte]?.evidence ?? 'unverified';
    const r = await loadPresetDumpVerified(ctx.conn, codec.modelByte, tpl, { deviceLabel, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
    st.frames += r.sends.reduce((a, s) => a + s.frames, 0) + (r.read_back ? 1 : 0);
    markDirty(connectionLabel);
    if (r.ok) {
      cleared = true;
      notes.push(`cleared by loading the empty template into the edit buffer (read back and compared; ${r.sends[r.sends.length - 1]?.acked ? 'frames acked' : 'frames un-acked'}${r.resent ? ', resent once' : ''}; template evidence ${evidence})`);
    } else {
      notes.push(`the empty-template load did not hold (${r.refused ?? r.read_error ?? r.compare?.detail ?? r.sends[r.sends.length - 1]?.failures[0]?.reason ?? 'unknown'}), so cells were cleared one by one`);
    }
  }
  if (!cleared) {
    const liveBefore = await readLiveGrid(ctx, codec.modelByte, timeout);
    st.frames++;
    if (liveBefore === undefined) {
      push({ op: 'set_block', target: 'clear', acked: false, warning: `${deviceLabel} did not answer the live grid read, so the edit buffer could not be cleared. Nothing was placed.` });
      return { aborted: 'could not clear the edit buffer.' };
    }
    const order = [...liveBefore].sort((a, b) => b.col - a.col || b.row - a.row);
    for (const c of order) {
      send(codec.buildSelectCell({ row: c.row, col: c.col, rows: grid.rows }));
      await sleep(CLEAR_GAP_MS);
      const rej = await watch(codec.buildSetGridCell({ row: c.row, col: c.col, blockId: 0, rows: grid.rows }), CLEAR_GAP_MS);
      if (rej && !isAmbiguousCode(rej)) push({ op: 'set_block', target: `clear r${c.row}c${c.col}`, acked: false, warning: `${deviceLabel} rejected clearing r${c.row}c${c.col}: ${deps.formatErrorCode(rej)}` });
    }
    markDirty(connectionLabel);
    const after = await readLiveGrid(ctx, codec.modelByte, timeout);
    st.frames++;
    if (after === undefined || after.length > 0) {
      push({ op: 'set_block', target: 'clear', acked: false, warning: after === undefined ? `${deviceLabel} did not answer the grid read after clearing.` : `${after.length} cell(s) are still occupied after clearing (${after.slice(0, 4).map((c) => `r${c.row}c${c.col}`).join(', ')}). Nothing was placed.` });
      return { aborted: 'could not clear the edit buffer.' };
    }
    notes.push(`cleared ${order.length} cell(s) one by one, right column first (ToneCommand issue #250 saw an FM9 fw 11 go silent after a per-cell clear and re-lay: check the unit passes audio)`);
  }

  // 5a. Place cells, left to right.
  const shuntIdx = new Set(plan.cells.filter((c) => c.kind === 'shunt').map((c) => c.effectId - SHUNT_EFFECT_ID_BASE));
  for (const c of [...plan.cells].sort((a, b) => a.col - b.col || a.row - b.row)) {
    if (overBudget()) break;
    let rej: Rejection | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      send(codec.buildSelectCell({ row: c.row, col: c.col, rows: grid.rows }));
      await sleep(SELECT_GAP_MS);
      rej = await watch(codec.buildSetGridCell({ row: c.row, col: c.col, blockId: c.effectId, rows: grid.rows }), PLACE_WINDOW_MS);
      // A shunt answered 2 ("no-op") means that index is in use: take the next free one.
      if (!(c.kind === 'shunt' && rej?.resultCode === 2)) break;
      let next = c.effectId - SHUNT_EFFECT_ID_BASE + 1;
      while (shuntIdx.has(next)) next++;
      shuntIdx.add(next);
      notes.push(`shunt index ${c.effectId - SHUNT_EFFECT_ID_BASE} at r${c.row}c${c.col} answered "no-op", retried as ${next}`);
      c.effectId = SHUNT_EFFECT_ID_BASE + next;
    }
    push(rej && !isAmbiguousCode(rej)
      ? { op: 'set_block', target: describeCell(c), acked: false, warning: `${deviceLabel} rejected placing ${describeCell(c)}: ${deps.formatErrorCode(rej)}` }
      : { op: 'set_block', target: describeCell(c), acked: false, unconfirmed: true, display_value: c.block ?? 'shunt' });
  }
  markDirty(connectionLabel);
  // 5b. Cables.
  for (const cab of plan.cables) {
    if (overBudget()) break;
    const t = `r${cab.from.row}c${cab.from.col}->r${cab.to.row}c${cab.to.col}`;
    const rej = await watch(codec.buildSetGridRouting({ srcRow: cab.from.row, srcCol: cab.from.col, destRow: cab.to.row, rows: grid.rows, op: ROUTING_OP_CONNECT }), CABLE_WINDOW_MS);
    push(rej && !isAmbiguousCode(rej)
      ? { op: 'routing', target: t, acked: false, warning: `${deviceLabel} rejected the cable ${t}: ${deps.formatErrorCode(rej)}` }
      : { op: 'routing', target: t, acked: false, unconfirmed: true });
  }

  // 5c. Params. Channel-nested params select channels on the ACTIVE scene;
  // put each block back on that scene's planned channel afterwards.
  const nestedChannels = spec.slots.some((s) => s.params !== undefined && Object.values(s.params).some((v) => typeof v === 'object' && v !== null));
  let active = 1;
  if (nestedChannels) {
    active = (await readActiveScene(ctx, codec, timeout)) ?? 1;
    st.frames++;
  }
  await writeSlotParams(deps, ctx, spec, st, push, overBudget, (effectId) => plan.scenes[active - 1]?.blocks.find((b) => b.effectId === effectId)?.channel ?? 0);

  // 6. Scenes. A default build reads the active scene once and walks every
  // scene only if it is not what the plan holds.
  let walkScenes = plan.scenesNeedWriting || (spec.scenes?.length ?? 0) > 0;
  if (!walkScenes && !st.budgetExceeded) {
    if (!nestedChannels) { active = (await readActiveScene(ctx, codec, timeout)) ?? 1; st.frames++; }
    const status = await readStatus(ctx, codec, timeout);
    st.frames++;
    const want = plan.scenes[active - 1]?.blocks ?? [];
    const differs = status === undefined || want.some((b) => {
      const l = status.find((e) => e.effectId === b.effectId);
      return l !== undefined && (l.channel !== b.channel || l.bypassed !== b.bypassed);
    });
    if (differs) {
      walkScenes = true;
      notes.push(status === undefined
        ? 'the scene status read did not answer, so every scene is written'
        : `scene ${active} did not hold the planned channel/bypass, so every scene is written`);
    }
  }
  const sceneStart = Date.now();
  if (walkScenes && !st.budgetExceeded) {
    await writeScenes(deps, ctx, plan, st, h);
    notes.push(`scenes: all ${plan.scenes.length} walked (${plan.scenes.filter((s) => s.authored).length} authored, the rest copy scene 1) in ${Date.now() - sceneStart} ms`);
  }
  if (!st.budgetExceeded && (walkScenes || spec.landingScene !== undefined)) {
    const r = await writer.switchScene!(ctx, state.landingScene);
    st.frames += 2;
    push({ ...r, target: `landing scene ${state.landingScene}` });
  }
  return {};
}

/** Walk every planned scene: select, read status, write the differences, re-read. */
async function writeScenes(deps: BuildDeps, ctx: DispatchCtx, plan: BuildPlan, st: BuildState, h: RealizeHelpers): Promise<void> {
  const { writer, codec, shape, deviceLabel, connectionLabel } = deps;
  const { push, overBudget, watch } = h;
  const timeout = deps.getResponseTimeoutMs;
  const chName = (i: number): string => shape.channel_names[i] ?? String(i);
  for (const sc of plan.scenes) {
    if (overBudget()) break;
    const sw = await writer.switchScene!(ctx, sc.scene);
    st.frames += 2;
    if (!sw.acked) {
      push({ ...sw, target: `scene ${sc.scene}`, unconfirmed: undefined, acked: false, warning: sw.warning ?? `scene ${sc.scene} could not be selected; its channel/bypass were not written.` });
      continue;
    }
    const status = await readStatus(ctx, codec, timeout);
    st.frames++;
    if (!status) {
      push({ op: 'switch_scene', target: `scene ${sc.scene} state`, acked: false, warning: `${deviceLabel} did not answer the status read on scene ${sc.scene}; its channel/bypass were not written.` });
      continue;
    }
    let wrote = 0;
    for (const b of sc.blocks) {
      const live = status.find((e) => e.effectId === b.effectId);
      if (!live) continue; // reported by the verify step (block not placed)
      if (live.channel !== b.channel) {
        const rej = await watch(codec.buildSetChannel(b.effectId, b.channel as 0 | 1 | 2 | 3), SCENE_WRITE_WINDOW_MS);
        wrote++;
        if (rej && !isAmbiguousCode(rej)) push({ op: 'set_channel', target: `scene ${sc.scene} ${b.id}`, acked: false, warning: `${deviceLabel} rejected the channel select: ${deps.formatErrorCode(rej)}` });
      }
      if (live.bypassed !== b.bypassed) {
        const rej = await watch(codec.buildSetBypass(b.effectId, b.bypassed), SCENE_WRITE_WINDOW_MS);
        wrote++;
        if (rej && !isAmbiguousCode(rej)) push({ op: 'set_bypass', target: `scene ${sc.scene} ${b.id}`, acked: false, warning: `${deviceLabel} rejected the bypass: ${deps.formatErrorCode(rej)}` });
      }
    }
    const check = wrote > 0 ? await readStatus(ctx, codec, timeout) : status;
    if (wrote > 0) { st.frames++; markDirty(connectionLabel); }
    const wrong = sc.blocks.filter((b) => {
      const l = check?.find((e) => e.effectId === b.effectId);
      return l !== undefined && (l.channel !== b.channel || l.bypassed !== b.bypassed);
    });
    push(check === undefined
      ? { op: 'switch_scene', target: `scene ${sc.scene} state`, acked: false, unconfirmed: true, warning: `scene ${sc.scene}: written but the re-read did not answer` }
      : wrong.length > 0
        ? { op: 'switch_scene', target: `scene ${sc.scene} state`, acked: false, warning: `scene ${sc.scene}: ${wrong.map((b) => `${b.id} should be ${chName(b.channel)}/${b.bypassed ? 'bypassed' : 'engaged'}`).join(', ')}, the unit holds otherwise` }
        : { op: 'switch_scene', target: `scene ${sc.scene} state`, acked: true, display_value: sc.blocks.map((b) => `${b.id}:${chName(b.channel)}${b.bypassed ? '/byp' : ''}`).join(' ') });
    if (sc.name !== undefined && !overBudget()) {
      const r = await writer.rename!(ctx, `scene:${sc.scene}`, sc.name);
      st.frames++;
      push({ ...r, target: `scene ${sc.scene} name` });
    }
  }
}

/**
 * Per-slot params: flat (current channel) or channel-nested. A nested slot
 * selects each channel in turn on the active scene, then selects
 * `restoreChannel(effectId)` again so the scene holds what the plan says.
 */
async function writeSlotParams(
  deps: BuildDeps,
  ctx: DispatchCtx,
  spec: PresetSpec,
  st: BuildState,
  push: (w: WriteResult) => void,
  overBudget: () => boolean,
  restoreChannel: (effectId: number) => number,
): Promise<void> {
  const { writer, codec, catalog, shape, deviceLabel, betaWarning: BETA } = deps;
  for (const slotSpec of spec.slots) {
    if (overBudget()) break;
    if (slotSpec.params === undefined) continue;
    const slug = slotSpec.block_type.trim().toLowerCase();
    const entries = Object.entries(slotSpec.params);
    const nested = entries.filter(([, v]) => typeof v === 'object' && v !== null && !Array.isArray(v)).length;
    if (nested > 0 && nested < entries.length) {
      push({ op: 'set_param', target: slug, acked: false, warning: `${shape.id} apply_preset: slot ${slug} mixes flat values and channel-nested objects. Use flat {gain: 6} or nested {A: {gain: 6}}.` });
      continue;
    }
    if (nested > 0) {
      let effectId: number;
      try {
        ({ effectId } = catalog.resolveBlockOrThrow(slug, deviceLabel, slotSpec.instance));
      } catch (err) {
        push({ op: 'set_channel', target: slug, acked: false, warning: `resolveBlock failed: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      let selected: number | undefined;
      for (const [channelKey, paramMap] of entries) {
        const upper = channelKey.trim().toUpperCase();
        const wireChannel = deps.channelValues[upper];
        if (wireChannel === undefined) {
          push({ op: 'set_channel', target: `${slug} (channel "${channelKey}")`, acked: false, warning: `unknown channel key "${channelKey}" on ${slug}. Valid channels: ${shape.channel_names.join(', ')}.` });
          continue;
        }
        st.frames++;
        const rej = await deps.sendAndWatchForError(ctx, codec.buildSetChannel(effectId, wireChannel as 0 | 1 | 2 | 3));
        if (rej && !isAmbiguousCode(rej)) {
          push({ op: 'set_channel', target: `${slug} (channel ${upper})`, acked: false, warning: `${deviceLabel} rejected set_channel: ${deps.formatErrorCode(rej)}. ${BETA}` });
          continue;
        }
        selected = wireChannel;
        // Silence is not an ack: the channel select has no echo.
        push({ op: 'set_channel', target: `${slug} (channel ${upper})`, acked: false, unconfirmed: true, display_value: upper });
        for (const [paramName, value] of Object.entries(paramMap as Record<string, number | string>)) {
          try {
            const wire = catalog.encodeParamOrThrow(slug, paramName, value, deviceLabel);
            st.frames++;
            const r = await writer.setParam!(ctx, slug, paramName, wire, undefined, slotSpec.instance);
            push({ ...r, target: `${slug}.${upper}.${paramName}` });
          } catch (err) {
            push({ op: 'set_param', target: `${slug}.${upper}.${paramName}`, acked: false, warning: `set_param failed: ${err instanceof Error ? err.message : String(err)}` });
          }
        }
      }
      const back = restoreChannel(effectId);
      if (selected !== undefined && selected !== back) {
        st.frames++;
        const rej = await deps.sendAndWatchForError(ctx, codec.buildSetChannel(effectId, back as 0 | 1 | 2 | 3));
        const name = shape.channel_names[back] ?? String(back);
        push(rej && !isAmbiguousCode(rej)
          ? { op: 'set_channel', target: `${slug} (restore channel ${name})`, acked: false, warning: `${deviceLabel} rejected restoring ${slug} to channel ${name}: ${deps.formatErrorCode(rej)}` }
          : { op: 'set_channel', target: `${slug} (restore channel ${name})`, acked: false, unconfirmed: true, display_value: name });
      }
      continue;
    }
    for (const [paramName, value] of entries) {
      try {
        const wire = catalog.encodeParamOrThrow(slug, paramName, value as number | string, deviceLabel);
        st.frames++;
        const r = await writer.setParam!(ctx, slug, paramName, wire, undefined, slotSpec.instance);
        push(r);
      } catch (err) {
        push({ op: 'set_param', target: `${slug}.${paramName}`, acked: false, warning: `set_param failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }
}

export type { PlannedCell };
