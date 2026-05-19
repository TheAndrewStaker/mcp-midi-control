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
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';

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
  check('3 blocks translated', result.port_summary.blocks_translated === 3);
  for (let i = 0; i < 3; i++) {
    const slot = result.applied_spec.slots[i] as PresetSlotSpec;
    const ref = slot.slot as { row: number; col: number };
    check(
      `slots[${i}].slot is {row:2, col:${i + 1}}, got ${JSON.stringify(ref)}`,
      typeof ref === 'object' && ref.row === 2 && ref.col === i + 1,
    );
  }
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
// Summary
// ─────────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? 'all cases pass' : `${failed} case(s) failed`}.`);
if (failed > 0) process.exit(1);
