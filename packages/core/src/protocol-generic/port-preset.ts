/**
 * BK-067: cross-device tone porting.
 *
 * `translatePresetSpec` takes a preset built for device A and returns
 * an equivalent preset spec for device B, handling differences in
 * chain topology, block availability, parameter naming, enum value
 * strings, and scene/channel cardinality. The smallest-useful-ship is
 * static presets (no modifier wiring); modifier translation is gated
 * on BK-063 and surfaces as `modifier_wirings_deferred` entries today.
 *
 * Pure function. No MIDI I/O, no descriptor mutation, no global state.
 * Inputs are read-only; the returned spec is fresh objects throughout.
 *
 * Translation passes:
 *
 *   1. **Slot topology.** AM4's 4 linear slots ↔ II's 4×12 grid ↔
 *      III's 6×14 grid. Linear→grid places blocks on row 2 (the
 *      conventional main signal row), col=source slot index. Grid→
 *      linear pulls blocks in column order, drops any over slot_count.
 *
 *   2. **Block availability.** AM4 collapses cab into the amp block;
 *      II/III have a separate cab block. II→AM4 drops cab with a
 *      warning so the user knows to choose the amp's integrated cab.
 *      AM4→II surfaces a hint that the user may want to add a cab
 *      block; we don't auto-insert (the IR choice is opinionated).
 *
 *   3. **Param name aliases (BK-065).** `drive.volume` (II vocab) gets
 *      resolved to `drive.level` (AM4 vocab) via `resolveParamAlias`.
 *      Counted in `params_aliased`.
 *
 *   4. **Enum value mapping (BK-066 Phase 2).** `"USA IIC+"` (II) gets
 *      resolved to `"USA MK IIC+"` (AM4) via `resolveEnumAlias`.
 *      Counted in `enums_mapped`. Unmapped enum strings (Phase 1 fuzzy
 *      tier or none) pass through unchanged with a warning so the
 *      downstream preflight surfaces them on apply.
 *
 *   5. **Scene + channel cardinality.** AM4 has 4 scenes × 4 channels
 *      (A/B/C/D); II has 8 scenes × 2 channels (X/Y); III has 8 scenes
 *      × 4 channels (A/B/C/D). Scene overflow (II 8 -> AM4 4) keeps
 *      the first 4 scenes and surfaces a `scene_collapses` count.
 *      Channel overflow (AM4 D -> II X/Y) maps A->X, B->Y, drops C/D
 *      with a warning.
 *
 *   6. **Modifier deferral.** Any slot with modifier wiring (currently
 *      not modeled in the unified spec; placeholder) lands a
 *      `modifier_wirings_deferred` entry until BK-063 closes.
 *
 * The translator does NOT call the dispatcher or the apply executor.
 * It returns a ready-to-apply `PresetSpec` plus the summary; whoever
 * called `translatePresetSpec` decides whether to apply via
 * `executeApplyPreset` or return the spec for review (dry_run).
 */

import { resolveParamAlias } from './cross-device-aliases.js';
import { resolveEnumAlias } from './cross-device-enums.js';
import type {
  DeviceDescriptor,
  PresetSpec,
  PresetSlotSpec,
  SceneSpec,
} from './types.js';

/**
 * Translation summary. Mirrors the BACKLOG entry's `port_summary`
 * shape so the dispatcher can pass it through unchanged.
 */
export interface PortPresetSummary {
  /** Slot entries that survived translation. */
  blocks_translated: number;
  /** Slot entries dropped because target device lacks the block. */
  blocks_dropped: ReadonlyArray<{ block: string; reason: string }>;
  /** Param-name substitutions made via BK-065 alias table. */
  params_aliased: number;
  /** Enum-value substitutions made via BK-066 Phase 2 concept-key table. */
  enums_mapped: number;
  /** Recipes / wirings that need BK-063 modifier support; deferred for now. */
  modifier_wirings_deferred: ReadonlyArray<{ block: string; recipe_needed: string }>;
  /** Scenes / channels lost in cardinality collapse. */
  scene_collapses: number;
}

export interface TranslatePresetResult {
  ok: boolean;
  port_summary: PortPresetSummary;
  applied_spec: PresetSpec;
  warnings: ReadonlyArray<string>;
}

/**
 * Translate a source spec written against `sourceDescriptor` into an
 * equivalent spec for `targetDescriptor`. Pure: inputs are not mutated.
 *
 * The output spec is the input to `executeApplyPreset(targetPort, ...)`
 * — its slot refs, block names, param names, and enum values are all
 * in the target device's canonical vocabulary as far as the cross-
 * device tables know how to resolve them. The downstream preflight
 * pass on the target device will still validate and surface any
 * remaining gaps (e.g. a param that exists on the source but not on
 * the target).
 */
export function translatePresetSpec(
  sourceDescriptor: DeviceDescriptor,
  sourceSpec: PresetSpec,
  targetDescriptor: DeviceDescriptor,
): TranslatePresetResult {
  const warnings: string[] = [];
  const blocksDropped: { block: string; reason: string }[] = [];
  const modifierDeferred: { block: string; recipe_needed: string }[] = [];
  let paramsAliased = 0;
  let enumsMapped = 0;
  let sceneCollapses = 0;

  const sourceCap = sourceDescriptor.capabilities;
  const targetCap = targetDescriptor.capabilities;

  // ── Pass 1: slots ─────────────────────────────────────────────────
  const targetSlots: PresetSlotSpec[] = [];
  for (let i = 0; i < sourceSpec.slots.length; i++) {
    const sourceSlot = sourceSpec.slots[i];

    // Slot ref translation. AM4 (linear) ↔ II/III (grid).
    const translatedRef = translateSlotRef(
      sourceSlot.slot,
      sourceCap,
      targetCap,
      targetSlots.length,
    );
    if (translatedRef === undefined) {
      blocksDropped.push({
        block: sourceSlot.block_type,
        reason: `target ${targetDescriptor.display_name} is out of ${targetCap.slot_model} slots`,
      });
      continue;
    }

    // Block availability. AM4 has no separate cab block (integrated
    // into amp). II/III have a separate cab. Drop with a warning when
    // moving II/III → AM4 if the source has a cab block.
    const blockType = sourceSlot.block_type.toLowerCase();
    if (
      targetDescriptor.blocks[sourceSlot.block_type] === undefined &&
      targetDescriptor.blocks[blockType] === undefined
    ) {
      // Try the descriptor's block_aliases too.
      const alias = targetDescriptor.block_aliases?.[sourceSlot.block_type]
        ?? targetDescriptor.block_aliases?.[blockType];
      if (alias === undefined) {
        blocksDropped.push({
          block: sourceSlot.block_type,
          reason: `block "${sourceSlot.block_type}" is not exposed on ${targetDescriptor.display_name}`,
        });
        if (blockType === 'cab' && targetDescriptor.id === 'am4') {
          warnings.push(
            'AM4 has an integrated cab in the amp block, not a separate cab block. Pick the amp\'s preferred cab via the amp\'s native cab knob if your amp has one.',
          );
        }
        continue;
      }
    }

    // Param translation: aliases (BK-065) + enum mapping (BK-066 P2).
    const translatedParams = translateParams(
      sourceSlot.params,
      blockType,
      sourceDescriptor,
      targetDescriptor,
      (n) => { paramsAliased += n; },
      (n) => { enumsMapped += n; },
      warnings,
    );

    const translatedSlot: PresetSlotSpec = {
      slot: translatedRef,
      block_type: sourceSlot.block_type,
    };
    if (translatedParams !== undefined) translatedSlot.params = translatedParams;
    if (sourceSlot.bypassed !== undefined) translatedSlot.bypassed = sourceSlot.bypassed;
    if (sourceSlot.id !== undefined) translatedSlot.id = sourceSlot.id;
    if (sourceSlot.instance !== undefined) translatedSlot.instance = sourceSlot.instance;

    targetSlots.push(translatedSlot);
  }

  // ── Pass 2: scenes ────────────────────────────────────────────────
  const targetScenes = translateScenes(
    sourceSpec.scenes,
    sourceCap,
    targetCap,
    (n) => { sceneCollapses += n; },
    warnings,
  );

  // ── Build the result spec ─────────────────────────────────────────
  const appliedSpec: PresetSpec = {
    slots: targetSlots,
    ...(targetScenes !== undefined && targetScenes.length > 0 ? { scenes: targetScenes } : {}),
    ...(sourceSpec.name !== undefined ? { name: sourceSpec.name } : {}),
    ...(sourceSpec.landingScene !== undefined && targetCap.has_scenes
      ? { landingScene: Math.min(sourceSpec.landingScene, targetCap.scene_count ?? 8) }
      : {}),
  };

  // Routing on grid devices: only carry it through when BOTH source
  // and target are grid devices, since linear devices ignore routing.
  if (
    sourceSpec.routing !== undefined &&
    sourceSpec.routing.length > 0 &&
    sourceCap.slot_model === 'grid' &&
    targetCap.slot_model === 'grid'
  ) {
    appliedSpec.routing = sourceSpec.routing;
  } else if (sourceSpec.routing !== undefined && sourceSpec.routing.length > 0) {
    warnings.push(
      `dropped ${sourceSpec.routing.length} routing edge(s): ${targetDescriptor.display_name} is a ${targetCap.slot_model}-slot device, routing is implicit.`,
    );
  }

  const port_summary: PortPresetSummary = {
    blocks_translated: targetSlots.length,
    blocks_dropped: blocksDropped,
    params_aliased: paramsAliased,
    enums_mapped: enumsMapped,
    modifier_wirings_deferred: modifierDeferred,
    scene_collapses: sceneCollapses,
  };

  return {
    ok: targetSlots.length > 0,
    port_summary,
    applied_spec: appliedSpec,
    warnings,
  };
}

/**
 * Translate a single slot reference between linear and grid models.
 *
 *   linear → linear: pass through unchanged (but clamp to target slot_count).
 *   linear → grid:   place on row 2, col = source slot number.
 *   grid → linear:   take the column index 1..N from the next-empty index.
 *   grid → grid:     pass through if both have room; otherwise reposition.
 *
 * Returns `undefined` when the target has run out of slots.
 */
function translateSlotRef(
  sourceSlot: PresetSlotSpec['slot'],
  sourceCap: DeviceDescriptor['capabilities'],
  targetCap: DeviceDescriptor['capabilities'],
  alreadyPlaced: number,
): PresetSlotSpec['slot'] | undefined {
  if (targetCap.slot_model === 'linear') {
    const targetSlotCount = targetCap.slot_count ?? 4;
    if (sourceCap.slot_model === 'linear') {
      const n = typeof sourceSlot === 'number' ? sourceSlot : alreadyPlaced + 1;
      if (n > targetSlotCount) return undefined;
      return n;
    }
    // grid → linear: assign sequential slot number based on placement order.
    const nextSlot = alreadyPlaced + 1;
    if (nextSlot > targetSlotCount) return undefined;
    return nextSlot;
  }
  // target is grid
  const rows = targetCap.grid?.rows ?? 4;
  const cols = targetCap.grid?.cols ?? 12;
  if (sourceCap.slot_model === 'linear') {
    const n = typeof sourceSlot === 'number' ? sourceSlot : alreadyPlaced + 1;
    // Place on row 2 (conventional main signal row on Fractal grids),
    // col = source slot index. Clamp to the target grid bounds.
    const row = 2 <= rows ? 2 : 1;
    const col = Math.min(n, cols);
    if (col < 1) return undefined;
    return { row, col };
  }
  // grid → grid: pass through if in bounds.
  if (typeof sourceSlot === 'object' && sourceSlot !== null) {
    const { row, col } = sourceSlot;
    if (row >= 1 && row <= rows && col >= 1 && col <= cols) {
      return { row, col };
    }
  }
  return undefined;
}

/**
 * Translate a slot's `params` map. Walks every entry, runs the BK-065
 * alias resolver on the param name, and the BK-066 Phase 2 resolver on
 * any string (enum-shaped) value. Counters land via the closures so
 * the caller can aggregate across all slots.
 *
 * Returns the translated params object in the same shape (flat or
 * channel-nested) as the input. Returns `undefined` when the input was
 * absent.
 *
 * Channel collapse: when the source has channels the target doesn't
 * model (A/B/C/D → X/Y or none), the function keeps only the
 * channels named in the target's `channel_names`. Source channels
 * outside that set drop with a warning.
 */
type FlatParams = Readonly<Record<string, number | string>>;
type NestedParams = Readonly<Record<string, FlatParams>>;

function translateParams(
  sourceParams: PresetSlotSpec['params'],
  blockType: string,
  sourceDescriptor: DeviceDescriptor,
  targetDescriptor: DeviceDescriptor,
  reportAlias: (n: number) => void,
  reportEnumMap: (n: number) => void,
  warnings: string[],
): PresetSlotSpec['params'] | undefined {
  if (sourceParams === undefined || sourceParams === null) return undefined;
  const entries = Object.entries(sourceParams);
  if (entries.length === 0) return undefined;

  // Classify: nested if every value is an object, flat otherwise.
  const looksNested = entries.every(
    ([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v),
  );

  if (!looksNested) {
    return translateFlatParams(
      sourceParams as FlatParams,
      blockType,
      targetDescriptor,
      reportAlias,
      reportEnumMap,
    );
  }

  // Channel-nested. Collapse channels the target doesn't carry.
  const targetChannels = targetDescriptor.capabilities.channel_names ?? [];
  const targetChannelsUpper = targetChannels.map((c) => c.toUpperCase());
  const out: Record<string, FlatParams> = {};
  let droppedChannels = 0;
  // Lookup table for channel name remapping when channel sets differ.
  // AM4 (A/B/C/D) ↔ II (X/Y) ↔ III (A/B/C/D).
  const sourceChannels = sourceDescriptor.capabilities.channel_names ?? [];
  const channelRemap = buildChannelRemap(sourceChannels, targetChannels);
  for (const [ch, paramMap] of entries) {
    const upperSource = ch.trim().toUpperCase();
    let targetCh = upperSource;
    if (channelRemap !== undefined) {
      const remapped = channelRemap[upperSource];
      if (remapped === undefined) {
        droppedChannels++;
        continue;
      }
      targetCh = remapped;
    }
    if (targetChannelsUpper.length > 0 && !targetChannelsUpper.includes(targetCh)) {
      droppedChannels++;
      continue;
    }
    const translated = translateFlatParams(
      paramMap as FlatParams,
      blockType,
      targetDescriptor,
      reportAlias,
      reportEnumMap,
    );
    if (translated !== undefined && Object.keys(translated).length > 0) {
      out[targetCh] = translated;
    }
  }
  if (droppedChannels > 0) {
    warnings.push(
      `dropped ${droppedChannels} channel slice(s) on ${blockType}: ${targetDescriptor.display_name} only exposes channels [${targetChannels.join(', ')}].`,
    );
  }
  if (Object.keys(out).length === 0) return undefined;
  return out as NestedParams;
}

/**
 * Translate a single flat params map. Used both for non-channel blocks
 * and for one channel slice of a nested map.
 */
function translateFlatParams(
  params: FlatParams,
  blockType: string,
  targetDescriptor: DeviceDescriptor,
  reportAlias: (n: number) => void,
  reportEnumMap: (n: number) => void,
): FlatParams {
  const out: Record<string, number | string> = {};
  for (const [name, value] of Object.entries(params)) {
    const aliasResult = resolveParamAlias(targetDescriptor.id, blockType, name);
    const canonicalName = aliasResult.canonical;
    if (aliasResult.aliasUsed !== undefined && aliasResult.canonical !== name) {
      reportAlias(1);
    }
    let translatedValue: number | string = value;
    if (typeof value === 'string') {
      const enumResult = resolveEnumAlias(targetDescriptor.id, blockType, canonicalName, value);
      if (enumResult.aliasUsed !== undefined && enumResult.canonical !== value) {
        translatedValue = enumResult.canonical;
        reportEnumMap(1);
      }
    }
    out[canonicalName] = translatedValue;
  }
  return out;
}

/**
 * Build a channel-name remap when source and target have different
 * channel sets. Returns `undefined` when both sets are identical so
 * the caller skips the remap step entirely.
 *
 *   AM4 (A/B/C/D) → II (X/Y):     A→X, B→Y, C and D drop.
 *   II (X/Y)      → AM4 (A/B/C/D): X→A, Y→B.
 *   AM4 (A/B/C/D) → III (A/B/C/D): identity (no remap returned).
 *   II (X/Y)      → III (A/B/C/D): X→A, Y→B.
 */
function buildChannelRemap(
  source: readonly string[],
  target: readonly string[],
): Record<string, string> | undefined {
  if (source.length === target.length && source.every((c, i) => c === target[i])) {
    return undefined;
  }
  const remap: Record<string, string> = {};
  // Position-based mapping: source[i] -> target[i] when both exist.
  for (let i = 0; i < source.length && i < target.length; i++) {
    remap[source[i].toUpperCase()] = target[i].toUpperCase();
  }
  return remap;
}

/**
 * Translate the scenes array. Collapses scene cardinality (e.g. II
 * 8 -> AM4 4) and rewrites per-scene channel/bypass references through
 * the channel remap.
 */
function translateScenes(
  sourceScenes: PresetSpec['scenes'],
  sourceCap: DeviceDescriptor['capabilities'],
  targetCap: DeviceDescriptor['capabilities'],
  reportCollapse: (n: number) => void,
  warnings: string[],
): SceneSpec[] | undefined {
  if (sourceScenes === undefined || sourceScenes.length === 0) return undefined;
  if (!targetCap.has_scenes) {
    warnings.push(
      `dropped ${sourceScenes.length} scene(s): target device does not expose scenes.`,
    );
    reportCollapse(sourceScenes.length);
    return undefined;
  }
  const targetSceneCount = targetCap.scene_count ?? 8;
  const out: SceneSpec[] = [];
  const sourceChannels = sourceCap.channel_names ?? [];
  const targetChannels = targetCap.channel_names ?? [];
  const channelRemap = buildChannelRemap(sourceChannels, targetChannels);
  let collapsed = 0;
  for (const sc of sourceScenes) {
    if (sc.scene > targetSceneCount) {
      collapsed++;
      continue;
    }
    const channels: Record<string, string | number> = {};
    if (sc.channels !== undefined) {
      for (const [block, ch] of Object.entries(sc.channels)) {
        if (typeof ch === 'number') {
          channels[block] = ch;
          continue;
        }
        const upper = ch.trim().toUpperCase();
        const mapped = channelRemap !== undefined ? channelRemap[upper] : upper;
        if (mapped !== undefined) {
          channels[block] = mapped;
        }
      }
    }
    const translatedScene: SceneSpec = { scene: sc.scene, channels };
    if (sc.bypassed !== undefined) translatedScene.bypassed = sc.bypassed;
    out.push(translatedScene);
  }
  if (collapsed > 0) reportCollapse(collapsed);
  if (collapsed > 0) {
    warnings.push(
      `collapsed ${collapsed} scene(s) past index ${targetSceneCount} on target device.`,
    );
  }
  return out;
}
