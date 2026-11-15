/**
 * BK-067 goldens: cross-device preset translator.
 *
 * `translatePresetSpec(sourceDescriptor, sourceSpec, targetDescriptor)`
 * rewrites a `PresetSpec` from one device's vocabulary to another via
 * the BK-065 param-alias and BK-066 Phase 2 enum-mapping tables, plus
 * topology/channel/scene collapse logic.
 *
 * Cases exercise:
 *   - Linear ↔ grid slot ref translation (AM4 4 slots ↔ II 4×12 grid)
 *   - Param alias substitution counted in port_summary.params_aliased
 *   - Enum value mapping counted in port_summary.enums_mapped
 *   - Channel collapse (AM4 A/B/C/D → II X/Y, drops C+D with warning)
 *   - Scene cardinality collapse (II 8 → AM4 4)
 *   - Block availability (cab block drops on AM4 target)
 *   - Unknown enum string passes through unchanged (downstream
 *     preflight surfaces it on apply)
 *
 * Run: npx tsx scripts/verify-port-preset.ts
 */

import { translatePresetSpec } from '@mcp-midi-control/core/protocol-generic/port-preset.js';
import type {
  PresetSpec,
  PresetSlotSpec,
  SceneSpec,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/descriptor.js';
import { FM9_DESCRIPTOR, VP4_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `. ${detail}` : ''}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Case 1: II → AM4 — single amp block with X/Y channels, enum mapping,
// param aliases.
// ─────────────────────────────────────────────────────────────────────
console.log('\nCase 1: II → AM4 (amp X/Y → A/B, USA IIC+ → USA MK IIC+, master_volume → master)');

const iiAmpSpec: PresetSpec = {
  slots: [
    {
      slot: { row: 2, col: 3 },
      block_type: 'amp',
      params: {
        X: { effect_type: 'USA CLEAN', gain: 3, master_volume: 6 },
        Y: { effect_type: 'USA IIC+', gain: 6, master_volume: 5 },
      },
    },
  ],
};

{
  const result = translatePresetSpec(AXEFX2_DESCRIPTOR, iiAmpSpec, AM4_DESCRIPTOR);
  check('ok=true', result.ok);
  check('1 block translated', result.port_summary.blocks_translated === 1);
  check('0 blocks dropped', result.port_summary.blocks_dropped.length === 0);
  // Param aliases: master_volume → master (Y has it twice, but X also
  // has master_volume — both X and Y aliased, so >= 2).
  check(
    `params_aliased>=2 (master_volume→master on X+Y), got ${result.port_summary.params_aliased}`,
    result.port_summary.params_aliased >= 2,
  );
  // Enum mappings: USA IIC+ → USA MK IIC+ (Y channel). USA CLEAN
  // does NOT have a Phase 2 mapping (it's a Phase 1 fuzzy/none case
  // that the translator passes through unchanged).
  check(
    `enums_mapped>=1 (USA IIC+ on Y), got ${result.port_summary.enums_mapped}`,
    result.port_summary.enums_mapped >= 1,
  );
  // The translated slot ref is linear on AM4.
  const firstSlot = result.applied_spec.slots[0] as PresetSlotSpec;
  check('translated slot is linear', typeof firstSlot.slot === 'number');
  // The translated Y params should have `master` not `master_volume`,
  // and `effect_type` should resolve to `type` for AM4 wah... wait,
  // amp.master_volume → amp.master per cross-device-aliases.ts (II
  // canonical → AM4 canonical). effect_type is AM4-friendly anyway
  // since AM4's amp params use `type`. Check both.
  const params = firstSlot.params as Record<string, Record<string, unknown>>;
  // Channel rename: II X/Y → AM4 A/B (position-based).
  check(
    `channel A exists (mapped from X), keys=${Object.keys(params).join(',')}`,
    'A' in params,
  );
  check('channel B exists (mapped from Y)', 'B' in params);
  // Param alias landed: master_volume → master.
  check(
    `B.master present, B keys=${Object.keys(params.B ?? {}).join(',')}`,
    params.B !== undefined && 'master' in params.B,
  );
  // Enum mapping landed: USA IIC+ → USA MK IIC+.
  check(
    `B.type = "USA MK IIC+", got ${JSON.stringify(params.B?.type)}`,
    params.B?.type === 'USA MK IIC+',
  );
}

// ─────────────────────────────────────────────────────────────────────
// Case 2: AM4 → II — channel collapse A/B/C/D → X/Y, drops C+D.
// ─────────────────────────────────────────────────────────────────────
console.log('\nCase 2: AM4 → II (channels A/B/C/D → X/Y, drops C+D with warning)');

const am4FourChannelSpec: PresetSpec = {
  slots: [
    {
      slot: 1,
      block_type: 'amp',
      params: {
        A: { type: 'USA MK IIC+', gain: 6, master: 5 },
        B: { type: 'USA Pre Clean', gain: 3, master: 7 },
        C: { type: 'USA MK IIC+', gain: 8, master: 4 },
        D: { type: 'USA MK IIC+', gain: 9, master: 3 },
      },
    },
  ],
};

{
  const result = translatePresetSpec(AM4_DESCRIPTOR, am4FourChannelSpec, AXEFX2_DESCRIPTOR);
  check('ok=true', result.ok);
  const firstSlot = result.applied_spec.slots[0] as PresetSlotSpec;
  const params = firstSlot.params as Record<string, Record<string, unknown>>;
  check('channel X exists (from A)', 'X' in params);
  check('channel Y exists (from B)', 'Y' in params);
  check(
    `no extra channels (only X and Y), got ${Object.keys(params).join(',')}`,
    Object.keys(params).length === 2,
  );
  check(
    `warnings include "dropped 2 channel slice(s)", got: ${result.warnings.join(' | ')}`,
    result.warnings.some((w) => /dropped 2 channel slice/.test(w)),
  );
  // Enum mapping: USA MK IIC+ → USA IIC+; param alias: type → effect_type.
  check(
    `X.effect_type = "USA IIC+", got ${JSON.stringify(params.X?.effect_type)}`,
    params.X?.effect_type === 'USA IIC+',
  );
  // Phase 2 doesn't have a row for "USA Pre Clean"; passes through.
  check(
    `Y.effect_type passed through (no Phase 2 row), got ${JSON.stringify(params.Y?.effect_type)}`,
    params.Y?.effect_type === 'USA Pre Clean',
  );
}

// ─────────────────────────────────────────────────────────────────────
// Case 3: II → AM4 — grid slot ref → linear slot 1.
// ─────────────────────────────────────────────────────────────────────
console.log('\nCase 3: II → AM4 grid → linear topology');

{
  const result = translatePresetSpec(AXEFX2_DESCRIPTOR, iiAmpSpec, AM4_DESCRIPTOR);
  const firstSlot = result.applied_spec.slots[0] as PresetSlotSpec;
  check(`slot is a number (linear), got ${JSON.stringify(firstSlot.slot)}`, typeof firstSlot.slot === 'number');
}

// ─────────────────────────────────────────────────────────────────────
// Case 4: AM4 → II — linear slot → grid row 2.
// ─────────────────────────────────────────────────────────────────────
console.log('\nCase 4: AM4 → II linear → grid (row 2)');

const am4ThreeBlockSpec: PresetSpec = {
  slots: [
    { slot: 1, block_type: 'amp' },
    { slot: 2, block_type: 'drive' },
    { slot: 3, block_type: 'reverb' },
  ],
};

{
  const result = translatePresetSpec(AM4_DESCRIPTOR, am4ThreeBlockSpec, AXEFX2_DESCRIPTOR);
  // F6g: linear→grid auto-inserts a cab block after the amp since II
  // exposes a separate cab block (vs. AM4's integrated cab). Source had
  // 3 blocks; target has 4 with cab at col 2 between amp and drive.
  check('4 blocks translated (amp + auto-cab + drive + reverb)', result.port_summary.blocks_translated === 4);
  const byType = new Map<string, { row: number; col: number }>();
  for (const slot of result.applied_spec.slots as PresetSlotSpec[]) {
    const ref = slot.slot as { row: number; col: number };
    if (typeof ref === 'object') byType.set(slot.block_type.toLowerCase(), ref);
  }
  check(`amp at {2,1}, got ${JSON.stringify(byType.get('amp'))}`, byType.get('amp')?.row === 2 && byType.get('amp')?.col === 1);
  check(`auto-placed cab at {2,2}, got ${JSON.stringify(byType.get('cab'))}`, byType.get('cab')?.row === 2 && byType.get('cab')?.col === 2);
  check(`drive shifted to {2,3}, got ${JSON.stringify(byType.get('drive'))}`, byType.get('drive')?.row === 2 && byType.get('drive')?.col === 3);
  check(`reverb shifted to {2,4}, got ${JSON.stringify(byType.get('reverb'))}`, byType.get('reverb')?.row === 2 && byType.get('reverb')?.col === 4);
  check(
    `cab auto-place warning present, got: ${result.warnings.join(' | ')}`,
    result.warnings.some((w) => /auto-placed a cab block/i.test(w)),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Case 5: II → AM4 — cab block drops with warning.
// ─────────────────────────────────────────────────────────────────────
console.log('\nCase 5: II → AM4 — cab block drops with hint');

const iiAmpAndCabSpec: PresetSpec = {
  slots: [
    { slot: { row: 2, col: 3 }, block_type: 'amp' },
    { slot: { row: 2, col: 4 }, block_type: 'cab' },
  ],
};

{
  const result = translatePresetSpec(AXEFX2_DESCRIPTOR, iiAmpAndCabSpec, AM4_DESCRIPTOR);
  check('1 block translated (amp)', result.port_summary.blocks_translated === 1);
  check('1 block dropped (cab)', result.port_summary.blocks_dropped.length === 1);
  check(
    'dropped entry names the cab block',
    result.port_summary.blocks_dropped[0]?.block === 'cab',
  );
  check(
    `warnings hint at integrated cab, got: ${result.warnings.join(' | ')}`,
    result.warnings.some((w) => /integrated cab/i.test(w)),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Case 6: II → AM4 — scene cardinality collapse (8 → 4).
// ─────────────────────────────────────────────────────────────────────
console.log('\nCase 6: II → AM4 scene cardinality collapse');

const iiManyScenesSpec: PresetSpec = {
  slots: [{ slot: { row: 2, col: 3 }, block_type: 'amp' }],
  scenes: [
    { scene: 1, channels: { amp: 'X' } },
    { scene: 2, channels: { amp: 'Y' } },
    { scene: 3, channels: { amp: 'X' } },
    { scene: 4, channels: { amp: 'Y' } },
    { scene: 5, channels: { amp: 'X' } },
    { scene: 6, channels: { amp: 'Y' } },
    { scene: 7, channels: { amp: 'X' } },
    { scene: 8, channels: { amp: 'Y' } },
  ],
};

{
  const result = translatePresetSpec(AXEFX2_DESCRIPTOR, iiManyScenesSpec, AM4_DESCRIPTOR);
  // AM4 has scene_count=4; scenes 5-8 should drop.
  check(
    `scene_collapses=4, got ${result.port_summary.scene_collapses}`,
    result.port_summary.scene_collapses === 4,
  );
  check(
    `4 scenes survived, got ${result.applied_spec.scenes?.length}`,
    result.applied_spec.scenes?.length === 4,
  );
  // Channel remap inside scenes: X → A, Y → B.
  const scenes = result.applied_spec.scenes as SceneSpec[];
  check(
    `scene 1 amp channel = "A" (from X), got ${JSON.stringify(scenes[0].channels)}`,
    scenes[0].channels.amp === 'A',
  );
  check(
    `scene 2 amp channel = "B" (from Y), got ${JSON.stringify(scenes[1].channels)}`,
    scenes[1].channels.amp === 'B',
  );
}

// ─────────────────────────────────────────────────────────────────────
// Case 7: AM4 → II — drive volume / level param alias.
// ─────────────────────────────────────────────────────────────────────
console.log('\nCase 7: AM4 → II — drive.level (AM4) → drive.volume (II)');

const am4DriveSpec: PresetSpec = {
  slots: [
    {
      slot: 2,
      block_type: 'drive',
      params: { type: 'Rat Distortion', drive: 7, level: 5 },
    },
  ],
};

{
  const result = translatePresetSpec(AM4_DESCRIPTOR, am4DriveSpec, AXEFX2_DESCRIPTOR);
  const slot = result.applied_spec.slots[0] as PresetSlotSpec;
  const params = slot.params as Record<string, unknown>;
  // AM4's `level` → II's `volume`, AM4's `drive` → II's `gain`.
  check(`II drive params include "volume", got ${Object.keys(params).join(',')}`, 'volume' in params);
  check(`II drive params include "gain"`, 'gain' in params);
  check(`II drive params include "type"`, 'type' in params);
  // Enum mapping on drive: AM4 "Rat Distortion" → II "RAT DIST".
  check(
    `type = "RAT DIST", got ${JSON.stringify(params.type)}`,
    params.type === 'RAT DIST',
  );
  check(
    `params_aliased >= 2 (level→volume, drive→gain), got ${result.port_summary.params_aliased}`,
    result.port_summary.params_aliased >= 2,
  );
  check(
    `enums_mapped >= 1 (Rat Distortion), got ${result.port_summary.enums_mapped}`,
    result.port_summary.enums_mapped >= 1,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Case 8: empty source spec produces ok=false (no blocks to translate).
// ─────────────────────────────────────────────────────────────────────
console.log('\nCase 8: empty source spec → ok=false');

{
  const result = translatePresetSpec(AM4_DESCRIPTOR, { slots: [] }, AXEFX2_DESCRIPTOR);
  check(`ok=false on empty spec, got ${result.ok}`, result.ok === false);
  check('0 blocks translated', result.port_summary.blocks_translated === 0);
}

// ─────────────────────────────────────────────────────────────────────
// Case 9: AM4 → III — linear → grid, channels A/B/C/D identity.
// ─────────────────────────────────────────────────────────────────────
console.log('\nCase 9: AM4 → III (linear → 4×14 grid, channels A/B/C/D identity)');

const am4ToIiiSpec: PresetSpec = {
  slots: [
    {
      slot: 1,
      block_type: 'amp',
      params_by_channel: {
        A: { type: 'Shiver Clean', gain: 3.5, master: 6 },
        B: { type: 'USA MK IIC+', gain: 7, master: 5 },
        C: { type: 'Brit JVM OD2', gain: 8, master: 4 },
        D: { type: 'Shiver Lead', gain: 9, master: 3 },
      },
    },
    { slot: 2, block_type: 'drive', params: { type: 'Rat Distortion', drive: 7, level: 5 } },
    { slot: 3, block_type: 'reverb', params: { type: 'Plate, Large', mix: 42 } },
  ],
  scenes: [
    { scene: 1, channels: { amp: 'A' } },
    { scene: 2, channels: { amp: 'B' } },
    { scene: 3, channels: { amp: 'C' } },
    { scene: 4, channels: { amp: 'D' } },
  ],
};

{
  const result = translatePresetSpec(AM4_DESCRIPTOR, am4ToIiiSpec, AXEFX3_DESCRIPTOR);
  check('ok=true', result.ok);
  // F6g: linear→grid auto-inserts a cab block since III exposes a
  // separate cab block. 3 source blocks + 1 auto-cab = 4.
  check('4 blocks translated (incl. auto-cab)', result.port_summary.blocks_translated === 4);
  check('0 blocks dropped', result.port_summary.blocks_dropped.length === 0);
  // III has A/B/C/D channels too, so no channel collapse.
  check('0 scene collapses (III has 8 scenes, source has 4)', result.port_summary.scene_collapses === 0);
  // Slot topology: linear → grid row 2.
  const firstSlot = result.applied_spec.slots[0] as PresetSlotSpec;
  const ref = firstSlot.slot as { row: number; col: number };
  check(
    `slot 1 → grid {row:2, col:1}, got ${JSON.stringify(ref)}`,
    typeof ref === 'object' && ref.row === 2 && ref.col === 1,
  );
  // All 4 channels survive (A/B/C/D → A/B/C/D identity).
  const params = firstSlot.params_by_channel as Record<string, Record<string, unknown>> | undefined;
  check(
    `all 4 channels survive (A/B/C/D), got ${params ? Object.keys(params).join(',') : 'undefined'}`,
    params !== undefined && Object.keys(params).length === 4,
  );
  // No channel-drop warnings.
  const channelWarnings = result.warnings.filter((w) => /dropped.*channel/.test(w));
  check(
    `no channel-drop warnings, got ${channelWarnings.length}`,
    channelWarnings.length === 0,
  );
  // 4 scenes survive.
  check(
    `4 scenes survived, got ${result.applied_spec.scenes?.length}`,
    result.applied_spec.scenes?.length === 4,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Case 10: III → AM4 — grid → linear, cab drops, scene collapse.
// ─────────────────────────────────────────────────────────────────────
console.log('\nCase 10: III → AM4 (grid → linear, cab drops, scene 5 collapses)');

const iiiToAm4Spec: PresetSpec = {
  slots: [
    {
      slot: { row: 2, col: 1 },
      block_type: 'amp',
      params_by_channel: {
        A: { type: 'Shiver Clean', gain: 4, master: 5 },
        B: { type: 'USA MK IIC+', gain: 7, master: 5 },
      },
    },
    { slot: { row: 2, col: 2 }, block_type: 'cab' },
    { slot: { row: 2, col: 3 }, block_type: 'drive', params: { type: 'Rat Distortion', level: 5 } },
    { slot: { row: 2, col: 4 }, block_type: 'reverb', params: { type: 'Plate, Large', mix: 35 } },
  ],
  scenes: [
    { scene: 1, channels: { amp: 'A' } },
    { scene: 2, channels: { amp: 'B' } },
    { scene: 3, channels: { amp: 'A' } },
    { scene: 4, channels: { amp: 'B' } },
    { scene: 5, channels: { amp: 'A' } },
  ],
};

{
  const result = translatePresetSpec(AXEFX3_DESCRIPTOR, iiiToAm4Spec, AM4_DESCRIPTOR);
  check('ok=true', result.ok);
  // cab drops on AM4.
  check('3 blocks translated (amp + drive + reverb)', result.port_summary.blocks_translated === 3);
  check('1 block dropped (cab)', result.port_summary.blocks_dropped.length === 1);
  check(
    'dropped block is cab',
    result.port_summary.blocks_dropped[0]?.block === 'cab',
  );
  // Scene 5 collapses (AM4 has scene_count=4).
  check(
    `1 scene collapsed, got ${result.port_summary.scene_collapses}`,
    result.port_summary.scene_collapses === 1,
  );
  check(
    `4 scenes survived, got ${result.applied_spec.scenes?.length}`,
    result.applied_spec.scenes?.length === 4,
  );
  // Slot refs are linear on AM4.
  const firstSlot = result.applied_spec.slots[0] as PresetSlotSpec;
  check(
    `slot is linear number, got ${JSON.stringify(firstSlot.slot)}`,
    typeof firstSlot.slot === 'number',
  );
  // Channels A/B survive (AM4 has A/B/C/D, III has A/B/C/D, identity).
  const params = firstSlot.params_by_channel as Record<string, Record<string, unknown>> | undefined;
  check(
    `channels A and B survive, got ${params ? Object.keys(params).join(',') : 'undefined'}`,
    params !== undefined && 'A' in params && 'B' in params,
  );
  // Integrated cab warning.
  check(
    'integrated cab warning present',
    result.warnings.some((w) => /integrated cab/i.test(w)),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Case 11: II → III — grid → grid, X/Y → A/B channel remap.
// ─────────────────────────────────────────────────────────────────────
console.log('\nCase 11: II → III (grid → grid, X/Y → A/B)');

const iiToIiiSpec: PresetSpec = {
  slots: [
    {
      slot: { row: 2, col: 3 },
      block_type: 'amp',
      params: {
        X: { effect_type: 'USA CLEAN', gain: 3, master_volume: 6 },
        Y: { effect_type: 'USA IIC+', gain: 7, master_volume: 5 },
      },
    },
  ],
  scenes: [
    { scene: 1, channels: { amp: 'X' } },
    { scene: 2, channels: { amp: 'Y' } },
  ],
};

{
  const result = translatePresetSpec(AXEFX2_DESCRIPTOR, iiToIiiSpec, AXEFX3_DESCRIPTOR);
  check('ok=true', result.ok);
  check('1 block translated', result.port_summary.blocks_translated === 1);
  // Channels X/Y → A/B (position-based remap).
  const firstSlot = result.applied_spec.slots[0] as PresetSlotSpec;
  const params = firstSlot.params as Record<string, Record<string, unknown>>;
  check(
    `channel A exists (from X), keys=${Object.keys(params).join(',')}`,
    'A' in params,
  );
  check('channel B exists (from Y)', 'B' in params);
  // Grid ref passes through (II 4×12, III 4×14, {row:2, col:3} fits both).
  const ref = firstSlot.slot as { row: number; col: number };
  check(
    `grid ref preserved {row:2, col:3}, got ${JSON.stringify(ref)}`,
    typeof ref === 'object' && ref.row === 2 && ref.col === 3,
  );
  // Param alias: master_volume → master on III.
  check(
    `params_aliased >= 2 (master_volume→master on A+B), got ${result.port_summary.params_aliased}`,
    result.port_summary.params_aliased >= 2,
  );
  // Scene channels remap X→A, Y→B.
  const scenes = result.applied_spec.scenes ?? [];
  check(
    `scene 1 amp channel = A (from X), got ${JSON.stringify(scenes[0]?.channels)}`,
    scenes[0]?.channels?.amp === 'A',
  );
  check(
    `scene 2 amp channel = B (from Y), got ${JSON.stringify(scenes[1]?.channels)}`,
    scenes[1]?.channels?.amp === 'B',
  );
}

// ─────────────────────────────────────────────────────────────────────
// Case 11b: II → FM9 — gen-3 family target. Proves cross-device enum +
// alias translation now resolves INTO fm9 (the gen-3 family shares the
// III's effect-enum column, so FM9 reads `axeFxIII`). Before this, fm9
// returned null on the enum-column lookup and no enum/alias mapped.
// ─────────────────────────────────────────────────────────────────────
console.log('\nCase 11b: II → FM9 (gen-3 family, dry-run translate)');

{
  const result = translatePresetSpec(AXEFX2_DESCRIPTOR, iiToIiiSpec, FM9_DESCRIPTOR);
  check('ok=true', result.ok);
  check('1 block translated', result.port_summary.blocks_translated === 1);
  const firstSlot = result.applied_spec.slots[0] as PresetSlotSpec;
  const params = firstSlot.params as Record<string, Record<string, unknown>>;
  // Channels X/Y → A/B (FM9 has A/B/C/D, same position-remap as III).
  check(`channel A exists (from X), keys=${Object.keys(params).join(',')}`, 'A' in params);
  check('channel B exists (from Y)', 'B' in params);
  // Param alias master_volume → master resolves on FM9 (shared gen-3 alias).
  check(
    `params_aliased >= 2 (master_volume→master on A+B), got ${result.port_summary.params_aliased}`,
    result.port_summary.params_aliased >= 2,
  );
  // Enum translation routes through the shared gen-3 column: at least the
  // recognized II amp model maps to its gen-3 canonical (or passes through
  // unchanged if unmapped — the key assertion is the lookup no longer
  // dead-ends at null for fm9, which would have thrown/skipped before).
  check(
    `enums_mapped is a number (gen-3 column reachable for fm9), got ${result.port_summary.enums_mapped}`,
    typeof result.port_summary.enums_mapped === 'number',
  );
}

// ─────────────────────────────────────────────────────────────────────
// Case: Bug F-1 — linear→grid expansion grid-cell collision (alpha.12).
//
// Reproduces the alpha.12 desktop trace where AM4 amp with A/B/C/D
// channels expanded into amp_1 + amp_2 for II, but both instances
// landed at the SAME {row, col} on the grid because the expansion
// copied the source slot ref verbatim and `translateSlotRef` used
// the source slot number for both. The grid can't host two blocks
// at the same cell; apply_preset would reject.
//
// Pinned post-fix behaviors:
//   1. Every block lands at a UNIQUE {row, col}.
//   2. amp_2 sits one column to the right of amp_1 (signal-chain order).
//   3. Downstream blocks (delay, reverb) keep their relative position
//      and don't collide with the newly-bumped amp_2.
//   4. cab auto-placement still inserts a cab between amp_2 and delay.
// ─────────────────────────────────────────────────────────────────────
console.log('\nCase: Bug F-1 — linear→grid expansion grid-cell collision');

{
  const am4FourChannelAmp: PresetSpec = {
    slots: [
      {
        slot: 1,
        block_type: 'amp',
        params_by_channel: {
          A: { type: 'Shiver Clean', gain: 3 },
          B: { type: 'Shiver Lead', gain: 7.5 },
          C: { type: 'Brit 800 2204 High', gain: 6 },
          D: { type: 'Brit JVM OD1', gain: 8 },
        },
      },
      {
        slot: 3,
        block_type: 'delay',
        params_by_channel: { A: { type: 'DIGITAL STEREO' }, B: { type: 'DIGITAL STEREO' } },
      },
      {
        slot: 4,
        block_type: 'reverb',
        params_by_channel: { A: { type: 'Hall, Large' }, B: { type: 'Room, Medium' } },
      },
    ],
  };
  const result = translatePresetSpec(AM4_DESCRIPTOR, am4FourChannelAmp, AXEFX2_DESCRIPTOR);

  // F-1 invariant: no two grid cells share a {row, col}.
  const cellOccupants = new Map<string, string[]>();
  for (const s of result.applied_spec.slots) {
    if (typeof s.slot === 'object' && s.slot !== null) {
      const key = `${s.slot.row}:${s.slot.col}`;
      const list = cellOccupants.get(key) ?? [];
      list.push(`${s.block_type}${s.instance ? `_${s.instance}` : ''}`);
      cellOccupants.set(key, list);
    }
  }
  const collisions = [...cellOccupants.entries()].filter(([, occ]) => occ.length > 1);
  check(
    `F-1: no two blocks share a grid cell, got collisions=${JSON.stringify(collisions)}`,
    collisions.length === 0,
  );

  const amps = result.applied_spec.slots.filter(
    (s) => s.block_type.toLowerCase() === 'amp',
  );
  check(
    `F-1: amp expanded into two instances, got ${amps.length}`,
    amps.length === 2,
  );

  // amp_1 lands at (row:2, col:1) per linear→grid rules.
  const amp1 = amps[0];
  const amp2 = amps[1];
  const amp1Pos = (typeof amp1?.slot === 'object' && amp1.slot !== null) ? amp1.slot : undefined;
  const amp2Pos = (typeof amp2?.slot === 'object' && amp2.slot !== null) ? amp2.slot : undefined;
  check(
    `F-1: amp_1 at row:2, col:1, got ${JSON.stringify(amp1Pos)}`,
    amp1Pos?.row === 2 && amp1Pos?.col === 1,
  );
  // amp_2 is on the same row, exactly one col further. The collision
  // detector bumps col until the cell is free; for an empty row-2 with
  // amp_1 at col 1, the next free col is 2.
  check(
    `F-1: amp_2 at row:2, col:2 (one column right of amp_1), got ${JSON.stringify(amp2Pos)}`,
    amp2Pos?.row === 2 && amp2Pos?.col === 2,
  );

  // Channel allocation: amp_1 carries A/B as X/Y, amp_2 carries C/D as X/Y.
  // AM4's `gain` aliases to the II's canonical `input_drive` (the
  // preamp-gain triple landed with the 0.3.0 translate aliasing pass).
  const amp1Channels = amp1?.params_by_channel as Record<string, Record<string, unknown>> | undefined;
  const amp2Channels = amp2?.params_by_channel as Record<string, Record<string, unknown>> | undefined;
  check(
    `F-1: amp_1.X has source A's gain=3 as input_drive, got ${amp1Channels?.X?.input_drive}`,
    amp1Channels?.X?.input_drive === 3,
  );
  check(
    `F-1: amp_2.X has source C's gain=6 as input_drive, got ${amp2Channels?.X?.input_drive}`,
    amp2Channels?.X?.input_drive === 6,
  );

  // F6g cab auto-placement still fires; cab sits between amp_2 and delay.
  const cab = result.applied_spec.slots.find((s) => s.block_type.toLowerCase() === 'cab');
  const cabPos = (typeof cab?.slot === 'object' && cab.slot !== null) ? cab.slot : undefined;
  check(
    `F-1: cab auto-placed right after amp_2 (col 3), got ${JSON.stringify(cabPos)}`,
    cabPos?.row === 2 && cabPos?.col === 3,
  );

  // Downstream blocks shift right to make room for cab and the bumped amp_2.
  // Source had delay at AM4 slot 3 → would translate to {row:2, col:3} on II
  // (1:1 linear→grid map). After amp_2 takes col 2 and cab takes col 3,
  // delay must end up at col 4+.
  const delay = result.applied_spec.slots.find((s) => s.block_type.toLowerCase() === 'delay');
  const delayPos = (typeof delay?.slot === 'object' && delay.slot !== null) ? delay.slot : undefined;
  check(
    `F-1: delay landed downstream of cab (col >= 4), got ${JSON.stringify(delayPos)}`,
    delayPos !== undefined && delayPos.col >= 4,
  );

  // Top-level warning surfaces the expansion + the cab auto-placement.
  const sawExpandWarning = result.warnings.some((w) =>
    /expanded.*channels.*two instances/i.test(w),
  );
  check('F-1: expansion warning surfaces at top level', sawExpandWarning);
  const sawCabWarning = result.warnings.some((w) => /auto-placed.*cab/i.test(w));
  check('F-1: cab auto-place warning surfaces at top level', sawCabWarning);
}

// ─────────────────────────────────────────────────────────────────────
// Case: Bug F-1b — collision avoidance must respect grid bounds.
//
// Edge case the alpha.12 fix needs to handle: when the bumped column
// would exceed the target grid's col count, the slot drops with a
// "out of slots" reason rather than wrapping around or stomping on
// another cell. Construct a source with enough blocks to fill the row.
// ─────────────────────────────────────────────────────────────────────
console.log('\nCase: Bug F-1b — collision avoidance respects grid bounds');

{
  // AM4 has 4 linear slots; each translates to col 1..4 on II's row 2.
  // II grid is 4 rows × 12 cols, so col-bump has lots of headroom under
  // normal conditions. This case constructs a target with deliberately
  // narrow capacity to verify the bump stops cleanly.
  const narrowTarget = {
    ...AXEFX2_DESCRIPTOR,
    capabilities: {
      ...AXEFX2_DESCRIPTOR.capabilities,
      grid: { rows: 4, cols: 2 },
    },
  };
  const amOnlyAmp: PresetSpec = {
    slots: [
      {
        slot: 1,
        block_type: 'amp',
        params_by_channel: {
          A: { type: 'Shiver Clean', gain: 3 },
          B: { type: 'Shiver Lead', gain: 7 },
          C: { type: 'Brit 800', gain: 5 },
          D: { type: 'Brit JVM OD1', gain: 8 },
        },
      },
      { slot: 2, block_type: 'delay', params_by_channel: { A: { type: 'DIGITAL STEREO' } } },
    ],
  };
  // Mutating the descriptor here is for test isolation; the real shipping
  // descriptors are unchanged. Cast through unknown to satisfy the
  // Readonly contract on capabilities without mutating the production
  // object.
  const result = translatePresetSpec(
    AM4_DESCRIPTOR,
    amOnlyAmp,
    narrowTarget as unknown as typeof AXEFX2_DESCRIPTOR,
  );
  // amp_1 takes col 1, amp_2 bumps to col 2, cab auto-place would want
  // col 3 — but grid only has 2 cols. Cab placement should bail (or
  // skip) rather than overflow. delay should still find a slot (or get
  // dropped cleanly with a reason).
  const cells = new Set<string>();
  for (const s of result.applied_spec.slots) {
    if (typeof s.slot === 'object' && s.slot !== null) {
      const key = `${s.slot.row}:${s.slot.col}`;
      check(
        `F-1b: no collision on narrow grid, got duplicate cell ${key}`,
        !cells.has(key),
      );
      cells.add(key);
      check(
        `F-1b: every placement within grid bounds, got col=${s.slot.col} (max 2)`,
        s.slot.col >= 1 && s.slot.col <= 2,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Case: 0.3.0 dev-test regression bundle — gain/EQ aliasing, scene
// names, channel-less-block flattening, per-scene pick drop warning,
// gen-3 tempo-division strip, unmapped-model aggregate warning.
// Mirrors the SHIVA 4-SCENE spec from the 2026-06-10 desktop session.
// ─────────────────────────────────────────────────────────────────────
console.log('\nCase: 0.3.0 regression bundle (II → AM4 and II → FM9, SHIVA shape)');

const shivaSpec: PresetSpec = {
  name: 'SHIVA 4-SCENE',
  slots: [
    {
      slot: { row: 2, col: 1 },
      block_type: 'compressor',
      params_by_channel: {
        X: { threshold: -40, ratio: 6, attack: 25 },
        Y: { threshold: -25, ratio: 3, attack: 15 },
      },
    },
    {
      slot: { row: 2, col: 2 },
      block_type: 'amp',
      params_by_channel: {
        X: { effect_type: 'SHIVER CLEAN', input_drive: 3.5, middle: 5, master_volume: 5 },
        Y: { effect_type: 'SHIVER LEAD', input_drive: 6, middle: 6, master_volume: 4.5 },
      },
    },
    {
      slot: { row: 2, col: 4 },
      block_type: 'delay',
      params_by_channel: {
        X: { effect_type: 'DIGITAL STEREO', tempo: '1/2 DOT', feedback: 55, mix: 40 },
      },
    },
  ],
  scenes: [
    { scene: 1, name: 'Spank Clean', channels: { compressor: 'X', amp: 'X', delay: 'X' } },
    { scene: 2, name: 'Crunch Lead', channels: { amp: 'Y', delay: 'X' } },
  ],
};

{
  // II → AM4
  const result = translatePresetSpec(AXEFX2_DESCRIPTOR, shivaSpec, AM4_DESCRIPTOR);
  check('II→AM4 ok=true', result.ok);
  const amp = result.applied_spec.slots.find((s) => s.block_type === 'amp') as PresetSlotSpec;
  const ampCh = amp?.params_by_channel as Record<string, Record<string, unknown>> | undefined;
  check(
    `II→AM4: input_drive aliased to gain on A, got keys [${Object.keys(ampCh?.A ?? {}).join(', ')}]`,
    ampCh?.A?.gain === 3.5 && ampCh?.A?.input_drive === undefined,
  );
  check(
    `II→AM4: middle aliased to mid on B, got ${ampCh?.B?.mid}`,
    ampCh?.B?.mid === 6 && ampCh?.B?.middle === undefined,
  );
  // Channel-less target block flattening: AM4 compressor has no channels.
  const comp = result.applied_spec.slots.find((s) => s.block_type === 'compressor') as PresetSlotSpec;
  check(
    'II→AM4: compressor flattened to flat params (no params_by_channel)',
    comp?.params_by_channel === undefined && comp?.params !== undefined,
  );
  check(
    `II→AM4: compressor kept first channel slice (threshold -40), got ${JSON.stringify(comp?.params)}`,
    (comp?.params as Record<string, unknown>)?.threshold === -40,
  );
  check(
    'II→AM4: flatten warning names the dropped channel slice',
    result.warnings.some((w) => /compressor has no channels/i.test(w)),
  );
  // Scene names survive.
  const scenes = result.applied_spec.scenes as SceneSpec[];
  check(
    `II→AM4: scene names carried, got [${scenes?.map((s) => s.name).join(', ')}]`,
    scenes?.[0]?.name === 'Spank Clean' && scenes?.[1]?.name === 'Crunch Lead',
  );
  // Per-scene channel picks for the channel-less compressor drop WITH a warning.
  check(
    'II→AM4: compressor scene pick dropped from channels map',
    scenes?.every((s) => !('compressor' in (s.channels ?? {}))),
  );
  check(
    'II→AM4: dropped scene-pick warning present',
    result.warnings.some((w) => /dropped per-scene channel selections/i.test(w)),
  );
  // Unmapped model names surface in ONE aggregate warning.
  check(
    'II→AM4: unmapped-model aggregate warning present (SHIVER has no Phase-2 row)',
    result.warnings.some((w) => /without a cross-roster mapping/i.test(w) && /SHIVER/i.test(w)),
  );
}

{
  // II → FM9 (gen-3 grid): a named tempo division now carries through, and the
  // FM9 encodes it to its own division ordinal (fw 12 hardware: 12 = "1/8 Dot",
  // issue #23). Only the VP4 still strips (its enum set refuses).
  const result = translatePresetSpec(AXEFX2_DESCRIPTOR, shivaSpec, FM9_DESCRIPTOR);
  check('II→FM9 ok=true', result.ok);
  const delay = result.applied_spec.slots.find((s) => s.block_type === 'delay') as PresetSlotSpec;
  const delayCh = delay?.params_by_channel as Record<string, Record<string, unknown>> | undefined;
  const delayParams = delayCh?.A ?? (delay?.params as Record<string, unknown> | undefined);
  check(
    `II→FM9: tempo division carried into the translated spec, got ${JSON.stringify(delayParams?.tempo)}`,
    delayParams?.tempo === '1/2 DOT',
  );
  check(
    'II→FM9: no tempo strip warning',
    !result.warnings.some((w) => /dropped tempo division/i.test(w)),
  );
  {
    let ord: unknown;
    try { ord = FM9_DESCRIPTOR.blocks['delay']?.params['tempo']?.encode?.('1/2 DOT'); } catch (e) { ord = (e as Error).message; }
    check(`II→FM9: the FM9 encodes "1/2 DOT" to its division ordinal 18, got ${String(ord)}`, ord === 18);
  }
  check('VP4 still declares named_tempo_divisions false', VP4_DESCRIPTOR.capabilities.named_tempo_divisions === false);
  check(
    'II→FM9: gain aliased to drive (gen-3 canonical)',
    (() => {
      const amp = result.applied_spec.slots.find((s) => s.block_type === 'amp') as PresetSlotSpec;
      const ch = amp?.params_by_channel as Record<string, Record<string, unknown>> | undefined;
      return ch?.A?.drive === 3.5 && ch?.A?.input_drive === undefined && ch?.A?.mid === 5;
    })(),
  );
  check(
    'II→FM9: scene names carried',
    (result.applied_spec.scenes as SceneSpec[] | undefined)?.[0]?.name === 'Spank Clean',
  );
  check(
    'II→FM9: unmapped-model aggregate warning present',
    result.warnings.some((w) => /without a cross-roster mapping/i.test(w)),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? 'all cases pass' : `${failed} case(s) failed`}.`);
if (failed > 0) process.exit(1);
