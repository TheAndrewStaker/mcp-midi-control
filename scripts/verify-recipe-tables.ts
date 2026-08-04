/**
 * Golden: BK-061 + BK-062 recipe-table integrity check.
 *
 * For every single-block recipe:
 *   1. `resolveXxxRecipe(name, port)` returns a non-empty params dict
 *      for each port listed in `applicable_devices`.
 *   2. `resolveXxxRecipe(name, port)` THROWS for every port NOT listed
 *      in `applicable_devices` (recipe is gated correctly).
 *   3. Every param name in every per-device params dict resolves to a
 *      real param in that device's catalog (fractal-midi's
 *      `KNOWN_PARAMS` for II, `CACHE_PARAMS` for AM4, `PARAM_BY_KEY`
 *      for III). Catches typos + drift between recipe authoring and
 *      the device's actual param dictionary.
 *   4. Every param VALUE encodes through the real descriptor + the real
 *      dispatcher resolver (`[encodability]` below).
 *
 * EVERY FAMILY IS WALKED. `walkRecipes()` must enumerate all NINE recipe
 * families exported from `recipes/index.ts`. It did not until 2026-08-02:
 * it covered pitch / wah / filter / amp / reverb and silently omitted
 * `AUTO_WAH_RECIPES` and `SCENE_LEVELING_RECIPES`, so 9 shipped recipes
 * had never been validated by anything. That is how `auto_wah_funk` shipped
 * AM4 `filter.sensitivity = 65` against a param declared [0.1..40]: the
 * refusal reproduced 19 times across `scripts/agent-regression/traces/`
 * without ever failing a build. `FAMILY_ID_FLOOR` below pins the id count
 * per family so a NEW family cannot be added without being walked.
 *
 * No hardware, no MIDI. Pure-data sanity check over the recipe library
 * + fractal-midi param catalogs.
 *
 * Run via:  npx tsx scripts/verify-recipe-tables.ts
 * Wired into npm test for regression coverage.
 */

import { KNOWN_PARAMS as AXE_FX_II_KNOWN_PARAMS } from 'fractal-midi/gen2/axe-fx-ii';
import { CACHE_PARAMS as AM4_CACHE_PARAMS } from 'fractal-midi/am4';
import { PARAM_BY_KEY as AXE_FX_III_PARAM_BY_KEY } from 'fractal-midi/gen3/axe-fx-iii';
import { FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import { FM9_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm9';

import {
  PITCH_RECIPES,
  resolvePitchRecipe,
  WAH_RECIPES,
  resolveWahRecipe,
  FILTER_RECIPES,
  resolveFilterRecipe,
  AMP_RECIPES,
  resolveAmpRecipe,
  REVERB_RECIPES,
  resolveReverbRecipe,
  AUTO_WAH_RECIPES,
  resolveAutoWahRecipe,
  SCENE_LEVELING_RECIPES,
  resolveSceneLevelingRecipe,
  lookupSceneRoleOffset,
  summarizeRecipesForPort,
  BLOCK_STACK_RECIPES,
  materializeBlockStackRecipe,
  HYDRA_PATCH_RECIPES,
  materializeHydraPatchRecipe,
  RecipeMaterializeError,
  type HydraCategory,
  type RecipePort,
} from '../packages/core/src/protocol-generic/recipes/index.js';
import { findPatchOffset } from '@mcp-midi-control/hydrasynth/patchEncoder.js';
import { findHydraNrpn } from '@mcp-midi-control/hydrasynth/nrpn.js';
import { resolveNrpnValue } from '@mcp-midi-control/hydrasynth/encoding.js';
import { HYDRASYNTH_DESCRIPTOR } from '@mcp-midi-control/hydrasynth/descriptor.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { MODERN_FRACTAL_DESCRIPTORS } from '@mcp-midi-control/fractal-gen3/device.js';
import { collectApplyPresetErrors } from '@mcp-midi-control/core/protocol-generic/dispatcher/preflight.js';
import { resolveBlockName, resolveParamName } from '@mcp-midi-control/core/protocol-generic/dispatcher/resolvers.js';
import { applyTypeKnobApplicabilityPreflight } from '@mcp-midi-control/core/protocol-generic/dispatcher/preset.js';
import type { DeviceDescriptor } from '@mcp-midi-control/core/protocol-generic/types.js';

// Descriptors for EVERY recipe port, so each recipe can be materialized and
// run through the REAL apply_preset preflight. This is the mechanical guard
// that catches recipe values drifting from a descriptor's block keys / enum
// labels (e.g. a slot block_type "parametric eq" that resolves on no device,
// or an amp label renamed in params.ts). Without it, broken recipes only
// surface when an agent picks one and the apply NACKs.
//
// MUST cover the full RecipePort union (am4 | axe-fx-ii | axe-fx-iii | fm3 |
// fm9) — a partial map silently SKIPS preflight for the omitted ports, which
// is how the gen3_* block-stack recipes (III/FM3/FM9) would go unchecked.
const modernById = new Map<string, DeviceDescriptor>(
  MODERN_FRACTAL_DESCRIPTORS.map((d) => [d.id, d]),
);
const RECIPE_PREFLIGHT_DESCRIPTORS: Record<RecipePort, DeviceDescriptor | undefined> = {
  am4: AM4_DESCRIPTOR,
  'axe-fx-ii': AXEFX2_DESCRIPTOR,
  'axe-fx-iii': modernById.get('axe-fx-iii'),
  fm3: modernById.get('fm3'),
  fm9: modernById.get('fm9'),
};
// Fail loudly if any recipe port lacks a descriptor — that would silently
// drop preflight coverage for that whole device.
for (const port of Object.keys(RECIPE_PREFLIGHT_DESCRIPTORS) as RecipePort[]) {
  if (RECIPE_PREFLIGHT_DESCRIPTORS[port] === undefined) {
    throw new Error(`verify-recipe-tables: no descriptor wired for recipe port "${port}" — recipe preflight would silently skip it.`);
  }
}

const HYDRA_CATEGORIES: readonly HydraCategory[] = [
  'Ambient', 'Arp', 'Bass', 'BassLead', 'Brass', 'Chord', 'Drum', 'E-piano',
  'FX', 'FxMusic', 'Keys', 'Lead', 'Organ', 'Pad', 'Perc', 'Rhythmic',
  'Sequence', 'Strings', 'Vocal',
];

/** Does a mod source/target name resolve on the Hydra descriptor? */
function hydraModNameResolves(kind: 'source' | 'target', name: string): boolean {
  const schema = HYDRASYNTH_DESCRIPTOR.blocks['modmatrix']?.params[kind === 'source' ? '1modsource' : '1modtarget'];
  if (!schema) return false;
  try { schema.encode(name); return true; } catch { return false; }
}

/** Does a macro target name resolve on the Hydra descriptor? */
function hydraMacroTargetResolves(macro: number, name: string): boolean {
  const schema = HYDRASYNTH_DESCRIPTOR.blocks['macros']?.params[`macro${macro}target1`];
  if (!schema) return false;
  try { schema.encode(name); return true; } catch { return false; }
}

const ALL_PORTS: readonly RecipePort[] = ['am4', 'axe-fx-ii', 'axe-fx-iii', 'fm3', 'fm9'] as const;

// Per-device "param name in this block exists?" predicates. Each recipe
// stores params by the device's canonical lowercase param name (II,
// AM4) or symbolic name (III); the lookup keys are the catalog's own.

function hasIIParam(block: string, name: string): boolean {
  // KNOWN_PARAMS is keyed by "block.name" lowercase.
  const key = `${block}.${name}`;
  return Object.prototype.hasOwnProperty.call(AXE_FX_II_KNOWN_PARAMS, key);
}

function hasAM4Param(block: string, name: string): boolean {
  const key = `${block}.${name}`;
  return Object.prototype.hasOwnProperty.call(AM4_CACHE_PARAMS, key);
}

function hasIIIParam(family: string, name: string): boolean {
  // PARAM_BY_KEY is keyed by "FAMILY.NAME" uppercase.
  const key = `${family.toUpperCase()}.${name.toUpperCase()}`;
  return Object.prototype.hasOwnProperty.call(AXE_FX_III_PARAM_BY_KEY, key);
}

// FM3 / FM9 carry their own device-true catalogs keyed by family; the recipe
// param names are the III's SCREAMING_SNAKE symbols (shared gen-3 naming).
function hasFamilyParam(
  byFamily: Readonly<Record<string, readonly { name: string }[]>>,
  family: string,
  name: string,
): boolean {
  const fam = byFamily[family.toUpperCase()] ?? [];
  return fam.some((p) => p.name.toUpperCase() === name.toUpperCase());
}

// Per-port "is this param name known on this block?" router.
function paramExists(port: RecipePort, block: string, name: string): boolean {
  if (port === 'axe-fx-ii') return hasIIParam(block, name);
  if (port === 'am4') return hasAM4Param(block, name);
  if (port === 'fm3') return hasFamilyParam(FM3_PARAMS_BY_FAMILY, block, name);
  if (port === 'fm9') return hasFamilyParam(FM9_PARAMS_BY_FAMILY, block, name);
  return hasIIIParam(block, name);
}

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK    ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// Recipe families, as exported from recipes/index.ts. EVERY family must
// appear here and be reachable from `walkRecipes()` (single-block +
// scene-leveling) or its own dedicated section (block_stack,
// patch_archetype). The id floor per family is asserted below so a
// family cannot be dropped from the walk without failing the build.
const FAMILY_ID_FLOOR: Readonly<Record<string, number>> = {
  amp: 5,
  autoWah: 4,
  filter: 3,
  pitch: 10,
  reverb: 3,
  sceneLeveling: 5,
  wah: 3,
  blockStack: 17,
  patchArchetype: 36,
};

// Block name per recipe category, per port. AM4 + II share lowercase
// `pitch`/`wah`/`filter`; III uses uppercase family symbols PITCH/WAH/
// FILTER.
//
// `auto_wah` is NOT in this table: it is the one family whose target
// block differs by port (FILTER on AM4's built-in env-follower types,
// WAH on II/III where the follower has to be a modifier). It carries its
// own `target_block_per_device` and each entry supplies the block via
// `RecipeEntry.blockFor`.
const BLOCK_NAME: Readonly<Record<string, Readonly<Record<RecipePort, string>>>> = {
  pitch:  { am4: 'pitch',  'axe-fx-ii': 'pitch',  'axe-fx-iii': 'PITCH',   fm3: 'PITCH',   fm9: 'PITCH'   },
  wah:    { am4: 'wah',    'axe-fx-ii': 'wah',    'axe-fx-iii': 'WAH',     fm3: 'WAH',     fm9: 'WAH'     },
  filter: { am4: 'filter', 'axe-fx-ii': 'filter', 'axe-fx-iii': 'FILTER',  fm3: 'FILTER',  fm9: 'FILTER'  },
  // amp recipes are gen-3-only; the III/FM3/FM9 amp block maps to the
  // DISTORT family. am4/ii entries are required by the type but never read
  // (the param-existence check only runs for a recipe's applicable_devices).
  amp:    { am4: 'amp',    'axe-fx-ii': 'amp',    'axe-fx-iii': 'DISTORT', fm3: 'DISTORT', fm9: 'DISTORT' },
  // reverb recipes are gen-3-only; the III/FM3/FM9 reverb block maps to the
  // REVERB family. am4/ii entries are required by the type but never read
  // (the param-existence check only runs for a recipe's applicable_devices).
  reverb: { am4: 'reverb', 'axe-fx-ii': 'reverb', 'axe-fx-iii': 'REVERB',  fm3: 'REVERB',  fm9: 'REVERB'  },
};

// Descriptor-side block key per recipe family per port. NOTE this is
// deliberately NOT `BLOCK_NAME` above: that table carries the codec
// catalog's family symbols (III `PITCH` / `DISTORT`), while the
// dispatcher resolves against the descriptor's own lowercase block keys.
// Conflating the two is how the gen-3 columns went unchecked.
const DESCRIPTOR_BLOCK: Readonly<Record<string, Readonly<Record<RecipePort, string>>>> = {
  pitch:  { am4: 'pitch',  'axe-fx-ii': 'pitch',  'axe-fx-iii': 'pitch',  fm3: 'pitch',  fm9: 'pitch'  },
  wah:    { am4: 'wah',    'axe-fx-ii': 'wah',    'axe-fx-iii': 'wah',    fm3: 'wah',    fm9: 'wah'    },
  filter: { am4: 'filter', 'axe-fx-ii': 'filter', 'axe-fx-iii': 'filter', fm3: 'filter', fm9: 'filter' },
  amp:    { am4: 'amp',    'axe-fx-ii': 'amp',    'axe-fx-iii': 'amp',    fm3: 'amp',    fm9: 'amp'    },
  reverb: { am4: 'reverb', 'axe-fx-ii': 'reverb', 'axe-fx-iii': 'reverb', fm3: 'reverb', fm9: 'reverb' },
};

type SingleBlockCategory = 'pitch' | 'wah' | 'filter' | 'amp' | 'reverb' | 'auto_wah';

interface RecipeEntry {
  readonly category: SingleBlockCategory;
  readonly name: string;
  readonly applicable_devices: readonly RecipePort[];
  readonly params_per_device: Readonly<Partial<Record<RecipePort, Readonly<Record<string, number | string>>>>>;
  readonly resolve: (recipeName: string, port: RecipePort) => {
    params: Readonly<Record<string, number | string>>;
    modifier_needed: boolean;
  };
  /** Codec-catalog block/family symbol for this recipe on this port. */
  readonly catalogBlockFor: (port: RecipePort) => string;
  /** Descriptor block key the dispatcher resolves against, on this port. */
  readonly descriptorBlockFor: (port: RecipePort) => string;
}

/**
 * Enumerate every single-block recipe family.
 *
 * ALL SIX single-block families belong here. `scene_leveling` is walked
 * separately (its payload is role-keyed dB offsets, not block params);
 * `block_stack` and `patch_archetype` have their own sections below.
 * Between the three, every family in `FAMILY_ID_FLOOR` is covered — the
 * floor assertions prove it.
 */
function walkRecipes(): RecipeEntry[] {
  const entries: RecipeEntry[] = [];
  const fixedBlock = (category: Exclude<SingleBlockCategory, 'auto_wah'>) => ({
    catalogBlockFor: (port: RecipePort) => BLOCK_NAME[category][port],
    descriptorBlockFor: (port: RecipePort) => DESCRIPTOR_BLOCK[category][port],
  });
  for (const [name, spec] of Object.entries(PITCH_RECIPES)) {
    entries.push({
      category: 'pitch',
      name,
      applicable_devices: spec.applicable_devices,
      params_per_device: spec.params_per_device,
      resolve: resolvePitchRecipe,
      ...fixedBlock('pitch'),
    });
  }
  for (const [name, spec] of Object.entries(WAH_RECIPES)) {
    entries.push({
      category: 'wah',
      name,
      applicable_devices: spec.applicable_devices,
      params_per_device: spec.params_per_device,
      resolve: resolveWahRecipe,
      ...fixedBlock('wah'),
    });
  }
  for (const [name, spec] of Object.entries(FILTER_RECIPES)) {
    entries.push({
      category: 'filter',
      name,
      applicable_devices: spec.applicable_devices,
      params_per_device: spec.params_per_device,
      resolve: resolveFilterRecipe,
      ...fixedBlock('filter'),
    });
  }
  for (const [name, spec] of Object.entries(AMP_RECIPES)) {
    entries.push({
      category: 'amp',
      name,
      applicable_devices: spec.applicable_devices,
      params_per_device: spec.params_per_device,
      // resolveAmpRecipe returns { params } (no modifier); adapt to the
      // shared RecipeEntry.resolve shape.
      resolve: (recipeName, port) => ({
        ...resolveAmpRecipe(recipeName, port),
        modifier_needed: false,
      }),
      ...fixedBlock('amp'),
    });
  }
  for (const [name, spec] of Object.entries(REVERB_RECIPES)) {
    entries.push({
      category: 'reverb',
      name,
      applicable_devices: spec.applicable_devices,
      params_per_device: spec.params_per_device,
      // resolveReverbRecipe returns { params } (no modifier); adapt to the
      // shared RecipeEntry.resolve shape.
      resolve: (recipeName, port) => ({
        ...resolveReverbRecipe(recipeName, port),
        modifier_needed: false,
      }),
      ...fixedBlock('reverb'),
    });
  }
  // auto_wah: per-PORT target block (FILTER on AM4, WAH on II/III), so
  // the block comes off the recipe itself rather than a category table.
  // The codec catalogs key gen-3 families in SCREAMING_SNAKE; the
  // descriptor keys blocks lowercase.
  for (const [name, spec] of Object.entries(AUTO_WAH_RECIPES)) {
    const target = (port: RecipePort): string => {
      const block = spec.target_block_per_device[port];
      if (block === undefined) {
        throw new Error(
          `verify-recipe-tables: auto_wah recipe '${name}' lists port '${port}' as applicable but has no target_block_per_device entry.`,
        );
      }
      return block;
    };
    entries.push({
      category: 'auto_wah',
      name,
      applicable_devices: spec.applicable_devices,
      params_per_device: spec.params_per_device,
      resolve: resolveAutoWahRecipe,
      catalogBlockFor: (port) => (port === 'am4' || port === 'axe-fx-ii' ? target(port) : target(port).toUpperCase()),
      descriptorBlockFor: (port) => target(port).toLowerCase(),
    });
  }
  return entries;
}

const entries = walkRecipes();

// ── Family census ───────────────────────────────────────────────────
//
// Every family exported from recipes/index.ts, its id count, and where
// this gate walks it. The census is printed BEFORE any per-recipe check
// so a reader can see at a glance that nothing is unwalked — the exact
// thing that was invisible while auto_wah and scene_leveling were
// missing from `walkRecipes()`.
const FAMILY_TABLES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  amp: AMP_RECIPES,
  autoWah: AUTO_WAH_RECIPES,
  filter: FILTER_RECIPES,
  pitch: PITCH_RECIPES,
  reverb: REVERB_RECIPES,
  sceneLeveling: SCENE_LEVELING_RECIPES,
  wah: WAH_RECIPES,
  blockStack: BLOCK_STACK_RECIPES,
  patchArchetype: HYDRA_PATCH_RECIPES,
};
const FAMILY_WALKED_BY: Readonly<Record<string, string>> = {
  amp: 'walkRecipes',
  autoWah: 'walkRecipes',
  filter: 'walkRecipes',
  pitch: 'walkRecipes',
  reverb: 'walkRecipes',
  sceneLeveling: '[scene_leveling] section',
  wah: 'walkRecipes',
  blockStack: '[block_stack] section',
  patchArchetype: '[patch_archetype] section',
};

const familyCounts: Record<string, number> = {};
let totalRecipeIds = 0;
for (const [family, table] of Object.entries(FAMILY_TABLES)) {
  const n = Object.keys(table).length;
  familyCounts[family] = n;
  totalRecipeIds += n;
}

console.log(`\nVerifying ${totalRecipeIds} recipe id(s) across ${Object.keys(FAMILY_TABLES).length} families / ${ALL_PORTS.length} ports.\n`);
for (const family of Object.keys(FAMILY_TABLES)) {
  console.log(
    `  ${family.padEnd(15)}: ${String(familyCounts[family]).padStart(3)} recipe(s)   walked by ${FAMILY_WALKED_BY[family]}`,
  );
}
console.log(`  ${'TOTAL'.padEnd(15)}: ${String(totalRecipeIds).padStart(3)} recipe id(s)\n`);

// Every family in FAMILY_ID_FLOOR must have a table, and vice versa.
// A new family added to recipes/index.ts without a floor row (or a floor
// row without a table) fails here rather than going silently unwalked.
check(
  'FAMILY_ID_FLOOR covers exactly the families in FAMILY_TABLES',
  Object.keys(FAMILY_ID_FLOOR).sort().join(',') === Object.keys(FAMILY_TABLES).sort().join(','),
  `floor=[${Object.keys(FAMILY_ID_FLOOR).sort().join(',')}] tables=[${Object.keys(FAMILY_TABLES).sort().join(',')}]`,
);
check(
  'every family declares where it is walked',
  Object.keys(FAMILY_TABLES).every((f) => FAMILY_WALKED_BY[f] !== undefined),
);

// Coverage floors, per family. Catch silent regressions if a recipe is
// later removed without an explicit scope change.
for (const [family, floor] of Object.entries(FAMILY_ID_FLOOR)) {
  check(
    `${family} family ships >= ${floor} recipe(s)`,
    (familyCounts[family] ?? 0) >= floor,
    `got ${familyCounts[family] ?? 0}`,
  );
}

// walkRecipes() must produce one entry per id across every single-block
// family — the direct assertion that no family was left out of the walk.
const SINGLE_BLOCK_FAMILIES = ['amp', 'autoWah', 'filter', 'pitch', 'reverb', 'wah'] as const;
const expectedWalked = SINGLE_BLOCK_FAMILIES.reduce((sum, f) => sum + (familyCounts[f] ?? 0), 0);
check(
  `walkRecipes() enumerates all ${expectedWalked} single-block recipe(s) (${SINGLE_BLOCK_FAMILIES.join(' + ')})`,
  entries.length === expectedWalked,
  `walked ${entries.length}`,
);

const pitchCount = familyCounts.pitch;
const wahCount = familyCounts.wah;
const filterCount = familyCounts.filter;
const ampCount = familyCounts.amp;
const reverbCount = familyCounts.reverb;
const autoWahCount = familyCounts.autoWah;
const sceneLevelingCount = familyCounts.sceneLeveling;

// Gen-3 recipe surfacing: summarizeRecipesForPort must return the amp +
// reverb recipes for III / FM3 / FM9 (guards the port allow-list that
// previously hard-rejected fm3/fm9). am4/ii must NOT surface them.
for (const port of ['axe-fx-iii', 'fm3', 'fm9'] as const) {
  const ampOnPort = summarizeRecipesForPort(port).filter((r) => r.family === 'amp');
  check(
    `summarizeRecipesForPort('${port}') surfaces all ${ampCount} amp recipes`,
    ampOnPort.length === ampCount,
    `got ${ampOnPort.length}`,
  );
  const reverbOnPort = summarizeRecipesForPort(port).filter((r) => r.family === 'reverb');
  check(
    `summarizeRecipesForPort('${port}') surfaces all ${reverbCount} reverb recipes`,
    reverbOnPort.length === reverbCount,
    `got ${reverbOnPort.length}`,
  );
}
for (const port of ['am4', 'axe-fx-ii'] as const) {
  const ampOnPort = summarizeRecipesForPort(port).filter((r) => r.family === 'amp');
  check(`summarizeRecipesForPort('${port}') surfaces no amp recipes (gen-3 only)`, ampOnPort.length === 0, `got ${ampOnPort.length}`);
  const reverbOnPort = summarizeRecipesForPort(port).filter((r) => r.family === 'reverb');
  check(`summarizeRecipesForPort('${port}') surfaces no reverb recipes (gen-3 only)`, reverbOnPort.length === 0, `got ${reverbOnPort.length}`);
}

// auto_wah + scene_leveling surfacing. Both families are am4 / II / III
// only; neither should appear on FM3 / FM9. These two are the families
// walkRecipes() used to omit, so pin their discovery surface too — an
// agent that cannot see a recipe cannot pick it, and a recipe nothing
// validates is how `filter.sensitivity = 65` shipped.
for (const port of ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const) {
  const autoWahOnPort = summarizeRecipesForPort(port).filter((r) => r.family === 'auto_wah');
  check(
    `summarizeRecipesForPort('${port}') surfaces all ${autoWahCount} auto_wah recipes`,
    autoWahOnPort.length === autoWahCount,
    `got ${autoWahOnPort.length}`,
  );
  const levelingOnPort = summarizeRecipesForPort(port).filter((r) => r.family === 'scene_leveling');
  check(
    `summarizeRecipesForPort('${port}') surfaces all ${sceneLevelingCount} scene_leveling recipes`,
    levelingOnPort.length === sceneLevelingCount,
    `got ${levelingOnPort.length}`,
  );
}
for (const port of ['fm3', 'fm9'] as const) {
  const autoWahOnPort = summarizeRecipesForPort(port).filter((r) => r.family === 'auto_wah');
  check(`summarizeRecipesForPort('${port}') surfaces no auto_wah recipes`, autoWahOnPort.length === 0, `got ${autoWahOnPort.length}`);
  const levelingOnPort = summarizeRecipesForPort(port).filter((r) => r.family === 'scene_leveling');
  check(`summarizeRecipesForPort('${port}') surfaces no scene_leveling recipes`, levelingOnPort.length === 0, `got ${levelingOnPort.length}`);
}

for (const entry of entries) {
  console.log(`\n[${entry.category}] ${entry.name}`);

  // 1. applicable_devices is non-empty.
  check(
    `applicable_devices non-empty`,
    entry.applicable_devices.length > 0,
    `${entry.category}.${entry.name}`,
  );

  // 2. For each applicable port, resolve returns a non-empty params dict.
  for (const port of entry.applicable_devices) {
    let resolved: { params: Readonly<Record<string, number | string>>; modifier_needed: boolean } | null = null;
    try {
      resolved = entry.resolve(entry.name, port);
    } catch (err) {
      check(
        `resolve(${entry.name}, ${port}) does not throw`,
        false,
        (err as Error).message.slice(0, 80),
      );
      continue;
    }
    check(
      `resolve(${entry.name}, ${port}) returns non-empty params`,
      Object.keys(resolved.params).length > 0,
      `got ${Object.keys(resolved.params).length} params`,
    );

    // 3. Every param name in the dict maps to a real catalog entry.
    const block = entry.catalogBlockFor(port);
    const missing: string[] = [];
    for (const paramName of Object.keys(resolved.params)) {
      if (!paramExists(port, block, paramName)) missing.push(paramName);
    }
    check(
      `every param in resolve(${entry.name}, ${port}) exists in catalog (block=${block})`,
      missing.length === 0,
      missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined,
    );
  }

  // 4. For each NON-applicable port, resolve throws.
  for (const port of ALL_PORTS) {
    if (entry.applicable_devices.includes(port)) continue;
    let threw = false;
    let errMsg = '';
    try {
      entry.resolve(entry.name, port);
    } catch (err) {
      threw = true;
      errMsg = (err as Error).message;
    }
    check(
      `resolve(${entry.name}, ${port}) throws (port not applicable)`,
      threw && /not applicable/i.test(errMsg),
      threw ? errMsg.slice(0, 80) : 'no error thrown',
    );
  }
}

// 5. Unknown recipe names throw with a list of known recipes. EVERY
// single-block resolver plus the scene-leveling resolver — the two that
// were missing (auto-wah, scene-leveling) are exactly the two families
// that went unwalked.
console.log('\n[unknown-recipe] negative cases');
for (const resolve of [
  resolvePitchRecipe,
  resolveWahRecipe,
  resolveFilterRecipe,
  resolveAmpRecipe,
  resolveReverbRecipe,
  resolveAutoWahRecipe,
  resolveSceneLevelingRecipe,
]) {
  let threw = false;
  let errMsg = '';
  try {
    resolve('this_recipe_does_not_exist', 'axe-fx-ii');
  } catch (err) {
    threw = true;
    errMsg = (err as Error).message;
  }
  check(
    `${resolve.name}('this_recipe_does_not_exist', 'axe-fx-ii') throws with 'unknown ... recipe'`,
    threw && /unknown .* recipe/i.test(errMsg),
    threw ? errMsg.slice(0, 80) : 'no error thrown',
  );
}

// ── 5b. scene_leveling family ───────────────────────────────────────
//
// Shape differs from every other family: the payload is a role-keyed dB
// OFFSET table, not a block param dict. There is no target block and no
// param name to look up, so the catalog / encodability checks above do
// not apply — but the resolver contract, the port gating, and the value
// sanity DO, and until 2026-08-02 nothing checked any of them.
//
// The dB window: these are offsets added to a device's main level knob
// (AM4 `volpan.volume`, II/III `output.level`). Anything beyond ±20 dB is
// not a mix decision, it is a typo — a scene at +30 dB is a blown PA and
// a scene at -30 dB is silence.
console.log('\n[scene_leveling] role-keyed dB offset integrity');
const SCENE_ROLES = new Set([
  'intro', 'clean', 'ambient_clean', 'rhythm', 'build', 'solo', 'breakdown',
]);
const SCENE_DB_LIMIT = 20;
for (const [name, recipe] of Object.entries(SCENE_LEVELING_RECIPES)) {
  console.log(`\n[scene_leveling] ${name}`);
  check('name matches table key', recipe.name === name, `name='${recipe.name}'`);
  check('description non-empty', recipe.description.length > 0);
  check('applicable_devices non-empty', recipe.applicable_devices.length > 0);

  for (const port of recipe.applicable_devices) {
    let offsets: Readonly<Partial<Record<string, number>>> | null = null;
    try {
      offsets = resolveSceneLevelingRecipe(name, port);
    } catch (err) {
      check(`resolve(${name}, ${port}) does not throw`, false, (err as Error).message.slice(0, 80));
      continue;
    }
    const roles = Object.keys(offsets);
    check(`resolve(${name}, ${port}) returns non-empty offsets`, roles.length > 0, `got ${roles.length}`);

    const badRoles = roles.filter((r) => !SCENE_ROLES.has(r));
    check(
      `every role in ${name}[${port}] is a declared SceneRole`,
      badRoles.length === 0,
      badRoles.length > 0 ? `unknown roles: ${badRoles.join(', ')}` : undefined,
    );

    const badValues: string[] = [];
    for (const [role, db] of Object.entries(offsets)) {
      if (typeof db !== 'number' || !Number.isFinite(db) || Math.abs(db) > SCENE_DB_LIMIT) {
        badValues.push(`${role}=${JSON.stringify(db)}`);
      }
    }
    check(
      `every offset in ${name}[${port}] is a finite dB within ±${SCENE_DB_LIMIT}`,
      badValues.length === 0,
      badValues.length > 0 ? `out of range: ${badValues.join(', ')}` : undefined,
    );

    // lookupSceneRoleOffset must agree with the table, and must return
    // undefined (not 0) for a role this recipe does not define — the
    // agent branches on that to decide "skip this scene" vs "write 0 dB".
    for (const role of roles) {
      const looked = lookupSceneRoleOffset(name, port, role as never);
      check(
        `lookupSceneRoleOffset(${name}, ${port}, '${role}') === ${JSON.stringify(offsets[role])}`,
        looked === offsets[role],
        `got ${JSON.stringify(looked)}`,
      );
    }
    const undefinedRole = [...SCENE_ROLES].find((r) => !roles.includes(r));
    if (undefinedRole !== undefined) {
      check(
        `lookupSceneRoleOffset(${name}, ${port}, '${undefinedRole}') === undefined (role not in recipe)`,
        lookupSceneRoleOffset(name, port, undefinedRole as never) === undefined,
      );
    }
  }

  // Non-applicable port rejection.
  for (const port of ALL_PORTS) {
    if (recipe.applicable_devices.includes(port)) continue;
    let threw = false;
    let errMsg = '';
    try {
      resolveSceneLevelingRecipe(name, port);
    } catch (err) {
      threw = true;
      errMsg = (err as Error).message;
    }
    check(
      `resolve(${name}, ${port}) throws (port not applicable)`,
      threw && /not applicable/i.test(errMsg),
      threw ? errMsg.slice(0, 80) : 'no error thrown',
    );
  }
}

// ── 6. Single-block recipe VALUE encodability (BK-PITCH-II) ─────────
//
// Check (3) above proves a recipe's param NAMES exist. It never encodes
// a VALUE, and it looks names up in the CODEC catalog
// (`PARAM_BY_KEY['PITCH.PITCH_SHIFT1']`, `FM3_PARAMS_BY_FAMILY`) rather
// than in the DESCRIPTOR the dispatcher actually resolves against
// (`descriptor.blocks['pitch'].params['shift1']` + its alias table).
// Both gaps are why `PITCH_RECIPES.octave_down` shipped for months with
// `voice_1_shift: -12` against an Axe-Fx II param declared [0..48]: the
// name resolved, the value could only ever throw, and nothing ran the
// encoder. Block-stack recipes already get this via
// `collectApplyPresetErrors`; single-block recipes had no equivalent.
//
// So: resolve every recipe param through the REAL dispatcher resolver
// against the REAL descriptor, then call the schema's own `encode`.
// A recipe value that its target device's encoder refuses is a product
// defect — the agent picks the recipe and apply_preset NACKs.
//
// This asserts only what can be asserted without hardware (the value is
// ACCEPTED), never musical correctness, which needs a device.
console.log('\n[encodability] every recipe value encodes on every device it claims');

// Frozen debt: (recipe/port : block.param) triples that do NOT encode
// today and were NOT in the scope that added this gate. Each entry is a
// real shipping defect, not a test artifact. The allowlist exists so the
// gate can go green and FREEZE the debt — a NEW unencodable value fails
// the build — not to bless these.
//
// wah_cocked_* : `wah.control` is uncalibrated on both the Axe-Fx II and
// gen-3, so there is no display value for a cocked-pedal position. The
// II boundary demands an integer 0..65534 (2.5 / 7.5 are refused), and
// gen-3 demands a RAW 0..65534 wire int, where 5 means ~0% of the sweep
// rather than a half-open pedal. Fixing it needs a display calibration
// on `wah.control` (the AM4's hardware-verified `wah.wah_control` is a
// 0..10 knob and is the obvious `am4-shared` donor), not a recipe edit.
const ENCODABILITY_DEBT = new Set<string>([
  'wah/wah_cocked_low/axe-fx-ii:wah.control',
  'wah/wah_cocked_low/axe-fx-iii:wah.control',
  'wah/wah_cocked_high/axe-fx-ii:wah.control',
  'wah/wah_cocked_high/axe-fx-iii:wah.control',
]);
const debtSeen = new Set<string>();

for (const entry of entries) {
  for (const port of entry.applicable_devices) {
    const descriptor = RECIPE_PREFLIGHT_DESCRIPTORS[port];
    if (descriptor === undefined) continue;
    let resolved: { params: Readonly<Record<string, number | string>> };
    try {
      resolved = entry.resolve(entry.name, port);
    } catch {
      continue; // already reported by the resolve check above
    }
    let block: string;
    try {
      block = resolveBlockName(descriptor, entry.descriptorBlockFor(port));
    } catch (err) {
      check(
        `${entry.category}/${entry.name}[${port}] block resolves on the descriptor`,
        false,
        (err as Error).message.slice(0, 100),
      );
      continue;
    }
    for (const [paramName, value] of Object.entries(resolved.params)) {
      const key = `${entry.category}/${entry.name}/${port}:${block}.${paramName}`;
      let canonical: string;
      try {
        canonical = resolveParamName(descriptor, block, paramName).name;
      } catch (err) {
        check(
          `${key} resolves through the dispatcher's own param resolver`,
          false,
          (err as Error).message.slice(0, 110),
        );
        continue;
      }
      const schema = descriptor.blocks[block]?.params[canonical];
      if (schema === undefined) {
        check(`${key} has a ParamSchema after resolution`, false, `canonical='${canonical}'`);
        continue;
      }
      let threw: string | undefined;
      try {
        schema.encode(value);
      } catch (err) {
        threw = err instanceof Error ? err.message : String(err);
      }
      const debtKey = `${entry.category}/${entry.name}/${port}:${block}.${canonical}`;
      if (ENCODABILITY_DEBT.has(debtKey)) {
        debtSeen.add(debtKey);
        // Inverted assertion: a frozen-debt entry that starts encoding
        // means someone fixed it — delete the allowlist row.
        check(
          `${debtKey} is STILL unencodable (frozen debt; delete the allowlist row once fixed)`,
          threw !== undefined,
          'now encodes — remove it from ENCODABILITY_DEBT',
        );
        continue;
      }
      check(
        `${entry.category}/${entry.name}[${port}] ${block}.${canonical} = ${JSON.stringify(value)} encodes`,
        threw === undefined,
        threw?.slice(0, 130),
      );
    }
  }
}
for (const stale of ENCODABILITY_DEBT) {
  check(
    `ENCODABILITY_DEBT entry '${stale}' still refers to a live recipe param`,
    debtSeen.has(stale),
    'not reached — the recipe/port/param no longer exists; delete the row',
  );
}

// ── Block-stack corpus integrity (2026-05-22 MCP migration) ─────────
//
// Per-recipe gates:
//   (a) applicable_devices is non-empty.
//   (b) For each applicable port: slots_per_device[port] is non-empty
//       AND signature_params_per_device[port] is present + non-empty.
//   (c) Every signature_params key (dot-path like `amp.type`) resolves
//       to a real slot+param in the materialized slots — guards against
//       slim-summary / full-slots drift.
//   (d) Every signature_params VALUE matches the slot's authored value
//       — slim shouldn't lie about what the recipe will write.
//   (e) Materializer round-trip: materializeBlockStackRecipe(name,
//       port, undefined) returns a PresetSpec whose slots length
//       matches slots_per_device[port] length.
//   (f) Overrides merge sanity: applying overrides to slot[0] knobs
//       produces a spec where the override knob took effect.
//   (g) Unknown recipe id => RecipeMaterializeError code:'unknown_recipe'.
//   (h) Non-applicable port => RecipeMaterializeError
//       code:'recipe_not_applicable'.

console.log('\n[block_stack] corpus integrity');
const blockStackCount = Object.keys(BLOCK_STACK_RECIPES).length;
console.log(`  block_stack : ${blockStackCount} recipe(s)`);

for (const [name, recipe] of Object.entries(BLOCK_STACK_RECIPES)) {
  console.log(`\n[block_stack] ${name}`);
  check(
    `applicable_devices non-empty`,
    recipe.applicable_devices.length > 0,
    `${name}`,
  );

  for (const port of recipe.applicable_devices) {
    const slots = recipe.slots_per_device[port];
    check(
      `slots_per_device[${port}] non-empty`,
      slots !== undefined && slots.length > 0,
      slots === undefined ? 'missing' : `length=${slots ? slots.length : 0}`,
    );
    if (!slots || slots.length === 0) continue;

    const sigParams = recipe.signature_params_per_device[port];
    check(
      `signature_params_per_device[${port}] present + non-empty`,
      sigParams !== undefined && Object.keys(sigParams).length > 0,
      sigParams === undefined ? 'missing (required for slim describe_device surface)' : 'empty (need at least one distinctive pick)',
    );
    if (!sigParams) continue;

    // Build a lookup from dot-path → authored value across the recipe's slots.
    const slotParamLookup = new Map<string, number | string>();
    for (const slot of slots) {
      if (!slot.params) continue;
      for (const [knob, value] of Object.entries(slot.params)) {
        slotParamLookup.set(`${slot.block_type}.${knob}`, value);
      }
    }

    const sigMissing: string[] = [];
    const sigDrift: { path: string; recipe: unknown; signature: unknown }[] = [];
    for (const [path, signatureValue] of Object.entries(sigParams)) {
      if (!slotParamLookup.has(path)) {
        sigMissing.push(path);
        continue;
      }
      const recipeValue = slotParamLookup.get(path);
      if (recipeValue !== signatureValue) {
        sigDrift.push({ path, recipe: recipeValue, signature: signatureValue });
      }
    }
    check(
      `signature_params[${port}] keys all resolve to authored slot params`,
      sigMissing.length === 0,
      sigMissing.length > 0 ? `missing in slots: ${sigMissing.join(', ')}` : undefined,
    );
    check(
      `signature_params[${port}] values match authored slot params`,
      sigDrift.length === 0,
      sigDrift.length > 0
        ? `drift: ${sigDrift.map((d) => `${d.path} recipe=${JSON.stringify(d.recipe)} signature=${JSON.stringify(d.signature)}`).join(' | ')}`
        : undefined,
    );

    // Tempo-first golden: the Edge dotted-8th recipe is tempo-synced by
    // construction. Its delay slot must bake `delay.tempo` and must NOT
    // ship an absolute `delay.time` (which the hardware would silently
    // ignore while tempo is synced — a dead param, see tempoLock.ts).
    if (name === 'edge_dotted_eighth_lead') {
      check(
        `${name}[${port}] delay slot bakes delay.tempo (tempo-synced by construction)`,
        slotParamLookup.has('delay.tempo'),
        `delay params: ${[...slotParamLookup.keys()].filter((k) => k.startsWith('delay.')).join(', ')}`,
      );
      check(
        `${name}[${port}] delay slot ships NO absolute delay.time (would be silently ignored)`,
        !slotParamLookup.has('delay.time'),
        `delay.time=${JSON.stringify(slotParamLookup.get('delay.time'))}`,
      );
    }

    // Materializer round-trip.
    try {
      const materialized = materializeBlockStackRecipe(name, port, undefined);
      check(
        `materialize(${name}, ${port}, undefined).slots.length === slots_per_device length`,
        materialized.slots.length === slots.length,
        `materialized=${materialized.slots.length} authored=${slots.length}`,
      );

      // Preflight the materialized recipe against the real descriptor: a
      // recipe applied verbatim (no overrides) MUST produce zero validation
      // errors. Catches block_type that resolves on no device + enum labels
      // that drifted from params.ts (the djent/recto recipe bug, 2026-06-06).
      const preflightDescriptor = RECIPE_PREFLIGHT_DESCRIPTORS[port];
      if (preflightDescriptor !== undefined) {
        const errors = collectApplyPresetErrors(materialized, preflightDescriptor);
        check(
          `${name}[${port}] materializes with ZERO preflight errors (verbatim apply is valid)`,
          errors.length === 0,
          errors.map((e) => `${e.path}: ${e.error}`).join(' | '),
        );
      }

      // Overrides merge sanity: take the first override-able knob and
      // confirm it took effect. Skip when slot[0] has no params or
      // params is channel-nested (unusual for recipes).
      const firstSlot = slots[0];
      const firstParams = firstSlot.params;
      if (firstParams && Object.keys(firstParams).length > 0) {
        const firstKnob = Object.keys(firstParams)[0];
        const recipeKnobValue = firstParams[firstKnob];
        const overrideValue = typeof recipeKnobValue === 'number' ? recipeKnobValue + 1 : recipeKnobValue;
        const overrides = {
          slots: [
            { slot: firstSlot.slot, block_type: firstSlot.block_type, params: { [firstKnob]: overrideValue } },
          ],
        };
        const overridden = materializeBlockStackRecipe(name, port, overrides);
        const overriddenSlot = overridden.slots[0];
        const overriddenParams = overriddenSlot.params as Record<string, number | string> | undefined;
        const observed = overriddenParams?.[firstKnob];
        check(
          `materialize(${name}, ${port}, overrides) applies override to slot[0].${firstKnob}`,
          observed === overrideValue,
          `expected ${JSON.stringify(overrideValue)}, got ${JSON.stringify(observed)}`,
        );
        check(
          `materialize(${name}, ${port}, overrides) preserves non-overridden slot[0] keys`,
          Object.keys(overriddenParams ?? {}).length >= Object.keys(firstParams).length,
          `overridden keys: ${Object.keys(overriddenParams ?? {}).length}, recipe keys: ${Object.keys(firstParams).length}`,
        );
      }
    } catch (err) {
      check(
        `materialize(${name}, ${port}, undefined) does not throw`,
        false,
        (err as Error).message.slice(0, 100),
      );
    }
  }

  // Non-applicable port rejection. Pick a port NOT in applicable_devices.
  for (const port of ALL_PORTS) {
    if (recipe.applicable_devices.includes(port)) continue;
    let threw = false;
    let code = '';
    try {
      materializeBlockStackRecipe(name, port, undefined);
    } catch (err) {
      threw = true;
      code = (err as { code?: string }).code ?? '';
    }
    check(
      `materialize(${name}, ${port}) throws recipe_not_applicable (port not in applicable_devices)`,
      threw && code === 'recipe_not_applicable',
      threw ? `code='${code}'` : 'no error thrown',
    );
  }
}

// ── gen-3 block_stack coverage + gating contract ────────────────────
//
// gen-3 (III / FM3 / FM9) block_stack recipes are MODEL-AGNOSTIC numeric
// voicings: amp/reverb/comp models are enum set-by-name gated, so a gen-3
// slot must NEVER carry an enum model string (`type` / `effect_type`).
// This guards the contract two ways: (a) a coverage floor so gen-3 recipes
// can't silently regress to zero, and (b) no slot leaks a gated enum-by-name
// param that apply_preset would refuse.
console.log('\n[block_stack] gen-3 coverage + no-enum-model gating');
for (const port of ['axe-fx-iii', 'fm3', 'fm9'] as const) {
  const gen3Recipes = Object.values(BLOCK_STACK_RECIPES).filter((r) =>
    r.applicable_devices.includes(port),
  );
  check(
    `${port}: at least 3 block_stack recipes (coverage floor)`,
    gen3Recipes.length >= 3,
    `got ${gen3Recipes.length}`,
  );
  for (const recipe of gen3Recipes) {
    const slots = recipe.slots_per_device[port] ?? [];
    const enumLeaks: string[] = [];
    for (const slot of slots) {
      for (const knob of Object.keys(slot.params ?? {})) {
        // `type` / `effect_type` are the enum model selectors, gated on gen-3.
        if (knob === 'type' || knob === 'effect_type') {
          enumLeaks.push(`${slot.block_type}.${knob}`);
        }
      }
    }
    check(
      `${recipe.name}[${port}] sets NO gated enum model string (type/effect_type)`,
      enumLeaks.length === 0,
      enumLeaks.length > 0 ? `leaked: ${enumLeaks.join(', ')}` : undefined,
    );
  }
}

// ── block_stack TYPE-GATE: no recipe ships a knob its own type hides ──
//
// BUG-5 (Desktop QA, 2026-07-04): `edge_dotted_eighth_lead` shipped
// `compressor.type = "JFET Pedal Compressor"` together with `ratio` and
// `threshold`, which that compressor model does not expose on the AM4.
// A type-gated knob is the project's flagship "wire-ack-not-audible"
// failure: the write is accepted and then dropped, so the recipe reads
// as applied while the tone is wrong.
//
// `applyTypeKnobApplicabilityPreflight` is the runtime guard that drops
// + warns on exactly this. Running it over every materialized recipe
// turns a runtime warning into a build-time gate: a recipe must
// materialize with ZERO dropped knobs.
console.log('\n[block_stack] type-gate (no knob suppressed by its own slot type)');

// Frozen debt, same contract as ENCODABILITY_DEBT above: knobs that the
// chosen block type genuinely does not expose, in recipes outside the
// scope that added this gate. These are real (a Fractal "Deluxe Verb"
// has no MID and no MASTER, a non-master-volume Plexi has no MASTER, a
// Peaking filter has no Q/GAIN on the AM4), the runtime preflight
// already drops them with a warning, and each needs a musical decision
// (pick a different model, or drop the knob) rather than a mechanical
// edit. The allowlist freezes the count so no NEW type-gated knob lands.
const TYPE_GATE_DEBT = new Set<string>([
  'eighties_clean_shimmer/am4:amp.mid',
  'eighties_clean_shimmer/am4:amp.master',
  'eighties_clean_shimmer/am4:chorus.rate',
  'eighties_clean_shimmer/am4:chorus.depth',
  'texas_blues_crunch/am4:amp.mid',
  'texas_blues_crunch/am4:amp.master',
  'glassy_clean/am4:amp.mid',
  'glassy_clean/am4:amp.master',
  'gilmour_phaser_clean/am4:phaser.rate',
  'gilmour_phaser_clean/am4:phaser.depth',
  'progressive_clean/am4:chorus.rate',
  'progressive_clean/am4:chorus.depth',
  'classic_rock_plexi/am4:amp.master',
  'modern_metal_recto/am4:filter.q',
  'modern_metal_recto/am4:filter.gain',
]);
const typeGateSeen = new Set<string>();

for (const [name, recipe] of Object.entries(BLOCK_STACK_RECIPES)) {
  for (const port of recipe.applicable_devices) {
    const descriptor = RECIPE_PREFLIGHT_DESCRIPTORS[port];
    if (descriptor === undefined) continue;
    // Devices without applicability data return no warnings at all.
    if (descriptor.findCompatibleTypes === undefined) continue;
    let warnings: { path: string; dropped_param?: string; reason?: string }[] = [];
    try {
      const materialized = materializeBlockStackRecipe(name, port, undefined);
      warnings = applyTypeKnobApplicabilityPreflight(materialized, descriptor).warnings;
    } catch {
      continue; // materialize failures are reported by the section above
    }
    const unexpected: string[] = [];
    for (const w of warnings) {
      const slotIdx = Number(/^slots\[(\d+)\]/.exec(w.path)?.[1] ?? -1);
      const blockType = recipe.slots_per_device[port]?.[slotIdx]?.block_type ?? 'unknown';
      const debtKey = `${name}/${port}:${blockType}.${w.dropped_param ?? '?'}`;
      if (TYPE_GATE_DEBT.has(debtKey)) {
        typeGateSeen.add(debtKey);
        continue;
      }
      unexpected.push(`${debtKey} (${w.reason ?? w.path})`);
    }
    check(
      `${name}[${port}] materializes with no type-gated knob drops`,
      unexpected.length === 0,
      unexpected.join(' | '),
    );
  }
}
for (const stale of TYPE_GATE_DEBT) {
  check(
    `TYPE_GATE_DEBT entry '${stale}' is still dropped (delete the row once the recipe is fixed)`,
    typeGateSeen.has(stale),
    'no longer dropped — remove it from TYPE_GATE_DEBT',
  );
}

// ── [single_block] type-gate ────────────────────────────────────────
//
// THE SAME CHECK AS THE BLOCK_STACK GATE ABOVE, AND ITS ABSENCE SHIPPED A
// BUG FOR MONTHS. The block_stack family got a type-gate on 2026-08-02
// (commit c94d7ae, BUG-5's class). Single-block recipes did not, and they
// are the family where the whole recipe IS one block plus its type.
//
// What slipped through: `auto_wah_funk` / `_cantrell` / `_hendrix` shipped
// `filter.type: 'Auto-Wah'` on the AM4. That is a real roster member at
// index 16 and every value was in range, so the name gate, the range gate
// and the encodability gate all passed it. But "Auto-Wah" on this device is
// the LFO-SWEPT wah (the Fractal wiki: "replaces the detector with an LFO"),
// and it exposes NONE of `sensitivity` / `attack_time` / `release_time`.
// FOUR of the eight params were refused at runtime on real hardware, and the
// recipe named for envelope-following selected a model deaf to the pick.
// All four also sent `filter.q`, whose gates are [1,2,3,7], so it applied to
// no wah type at all.
//
// Every one of those is exactly what `applyTypeKnobApplicabilityPreflight`
// reports. Nothing was checking.
console.log('\n[single_block] type-gate (no knob the recipe type suppresses)');

const SINGLE_BLOCK_TYPE_GATE_DEBT = new Set<string>([]);
const singleGateSeen = new Set<string>();

for (const entry of walkRecipes()) {
  for (const port of entry.applicable_devices) {
    const descriptor = RECIPE_PREFLIGHT_DESCRIPTORS[port];
    if (descriptor === undefined || descriptor.findCompatibleTypes === undefined) continue;
    const params = entry.params_per_device[port];
    if (params === undefined) continue;
    const block = entry.descriptorBlockFor(port);
    if (block === undefined) continue;
    // A recipe that does not choose a type cannot be type-gate-checked:
    // applicability is relative to the ACTIVE type, which is whatever the
    // user already had. Skip rather than assume a default and invent a
    // failure. (The gen-3 entries deliberately set no type; see autoWah.ts.)
    const typeValue = (params as Record<string, unknown>)['type']
      ?? (params as Record<string, unknown>)['effect_type'];
    if (typeof typeValue !== 'string') continue;

    let warnings: { path: string; dropped_param?: string; reason?: string }[] = [];
    try {
      warnings = applyTypeKnobApplicabilityPreflight(
        { slots: [{ slot: 1, block_type: block, params: params as Record<string, number | string> }] } as never,
        descriptor,
      ).warnings;
    } catch {
      continue; // encodability is the section above's problem, not this one
    }
    const unexpected: string[] = [];
    for (const w of warnings) {
      const debtKey = `${entry.name}/${port}:${block}.${w.dropped_param ?? '?'}`;
      if (SINGLE_BLOCK_TYPE_GATE_DEBT.has(debtKey)) { singleGateSeen.add(debtKey); continue; }
      unexpected.push(`${debtKey} on type '${typeValue}' (${w.reason ?? w.path})`);
    }
    check(
      `${entry.name}[${port}] has no knob its own type suppresses`,
      unexpected.length === 0,
      unexpected.join(' | '),
    );
  }
}
for (const stale of SINGLE_BLOCK_TYPE_GATE_DEBT) {
  check(
    `SINGLE_BLOCK_TYPE_GATE_DEBT entry '${stale}' is still dropped (delete the row once fixed)`,
    singleGateSeen.has(stale),
    'no longer dropped, remove it from SINGLE_BLOCK_TYPE_GATE_DEBT',
  );
}

// ── Materializer edge cases ─────────────────────────────────────────
//
// (i)  Verbatim equivalence: materialize(recipe, port, undefined).slots
//      deep-equals slots_per_device[port]. The slim describe_device
//      surface promises the agent that `recipe_id` is byte-equivalent
//      to a hand-pasted slots[]; the materializer is where that promise
//      lives.
// (ii) Slot-drop protection: overrides targeting a single slot must not
//      drop the recipe's other slots. The senior reviewer flagged this
//      as the nastiest expected bug class for the migration.
// (iii)Append behavior: an override slot whose ref matches NO recipe
//      slot is appended at the end (e.g. agent adds a 4th slot to a
//      3-slot recipe).

console.log('\n[block_stack] materializer edge cases');

interface LooseSlot {
  readonly slot: number | { readonly row: number; readonly col: number };
  readonly block_type: string;
  readonly params?: unknown;
}

function deepEqualSlots(
  a: ReadonlyArray<LooseSlot>,
  b: ReadonlyArray<LooseSlot>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.block_type !== y.block_type) return false;
    if (typeof x.slot === 'number' && typeof y.slot === 'number') {
      if (x.slot !== y.slot) return false;
    } else if (typeof x.slot === 'object' && typeof y.slot === 'object') {
      if (x.slot.row !== y.slot.row || x.slot.col !== y.slot.col) return false;
    } else {
      return false;
    }
    const xParams = (x.params ?? {}) as Record<string, unknown>;
    const yParams = (y.params ?? {}) as Record<string, unknown>;
    const xKeys = Object.keys(xParams);
    const yKeys = Object.keys(yParams);
    if (xKeys.length !== yKeys.length) return false;
    for (const k of xKeys) {
      if (xParams[k] !== yParams[k]) return false;
    }
  }
  return true;
}

// (i) Verbatim equivalence for every (recipe, applicable port) pair.
let verbatimChecked = 0;
for (const [name, recipe] of Object.entries(BLOCK_STACK_RECIPES)) {
  for (const port of recipe.applicable_devices) {
    const authored = recipe.slots_per_device[port];
    if (!authored) continue;
    const materialized = materializeBlockStackRecipe(name, port, undefined);
    check(
      `verbatim equivalence: materialize(${name}, ${port}, undefined).slots deep-equals slots_per_device[${port}]`,
      deepEqualSlots(materialized.slots, authored),
    );
    verbatimChecked++;
  }
}
console.log(`  (verbatim-equivalence pairs checked: ${verbatimChecked})`);

// (ii) Slot-drop protection. Pick a multi-slot recipe and apply an
// override targeting only its first slot; assert all other recipe slots
// survive.
const multiSlotRecipe = Object.values(BLOCK_STACK_RECIPES).find((r) => {
  const port = r.applicable_devices[0];
  return port !== undefined && (r.slots_per_device[port]?.length ?? 0) >= 2;
});
if (multiSlotRecipe) {
  const port = multiSlotRecipe.applicable_devices[0];
  const authored = multiSlotRecipe.slots_per_device[port]!;
  const firstSlot = authored[0];
  const firstKnob = firstSlot.params ? Object.keys(firstSlot.params)[0] : undefined;
  if (firstKnob !== undefined) {
    const overrides = {
      slots: [{ slot: firstSlot.slot, block_type: firstSlot.block_type, params: { [firstKnob]: 'overridden' } }],
    };
    const merged = materializeBlockStackRecipe(multiSlotRecipe.name, port, overrides);
    check(
      `slot-drop protection: targeting slot[0] with overrides preserves ${authored.length - 1} other recipe slot(s)`,
      merged.slots.length === authored.length,
      `expected ${authored.length} slots, got ${merged.slots.length}`,
    );
    for (let i = 1; i < authored.length; i++) {
      const recipeSlot = authored[i];
      const mergedSlot = merged.slots[i];
      check(
        `slot-drop: slot[${i}] block_type preserved (${recipeSlot.block_type})`,
        mergedSlot.block_type === recipeSlot.block_type,
      );
      const recipeParams = recipeSlot.params ?? {};
      const mergedParams = (mergedSlot.params ?? {}) as Record<string, number | string>;
      check(
        `slot-drop: slot[${i}] params count preserved (${Object.keys(recipeParams).length})`,
        Object.keys(mergedParams).length === Object.keys(recipeParams).length,
      );
    }
  }
}

// (iii) Append behavior. Override a slot ref that doesn't exist in
// the recipe; assert it lands at the end.
{
  const recipe = BLOCK_STACK_RECIPES['texas_blues_crunch'];
  const port: RecipePort = 'am4';
  const baseLen = recipe.slots_per_device[port]!.length;
  // texas_blues_crunch on AM4 has 3 slots (1, 2, 3). Append slot 4.
  const overrides = {
    slots: [{ slot: 4, block_type: 'reverb', params: { type: 'Plate, Medium', mix: 5 } }],
  };
  const merged = materializeBlockStackRecipe('texas_blues_crunch', port, overrides);
  check(
    `append: override slot=4 appended past recipe's ${baseLen} slots`,
    merged.slots.length === baseLen + 1,
    `expected ${baseLen + 1} slots, got ${merged.slots.length}`,
  );
  check(
    `append: appended slot lands at index ${baseLen} with the override's block_type`,
    merged.slots[baseLen]?.block_type === 'reverb',
    `appended block_type: ${merged.slots[baseLen]?.block_type}`,
  );
}

// Unknown recipe id surfaces the structured error.
console.log('\n[block_stack] unknown-recipe negative case');
{
  let threw = false;
  let code = '';
  let knownReturned: readonly string[] | undefined;
  try {
    materializeBlockStackRecipe('this_recipe_does_not_exist', 'axe-fx-ii', undefined);
  } catch (err) {
    threw = true;
    code = (err as { code?: string }).code ?? '';
    knownReturned = (err as { known_recipes?: readonly string[] }).known_recipes;
  }
  check(
    `materialize('this_recipe_does_not_exist', ...) throws unknown_recipe with known_recipes[]`,
    threw && code === 'unknown_recipe' && Array.isArray(knownReturned) && knownReturned.length > 0,
    threw ? `code='${code}', known_recipes=${knownReturned?.length ?? 0}` : 'no error thrown',
  );
}

// ---------------------------------------------------------------------------
// Hydrasynth patch-archetype family (BK-074).
// ---------------------------------------------------------------------------
console.log('\n[patch_archetype] Hydrasynth recipes');
let hydraCount = 0;
for (const [id, recipe] of Object.entries(HYDRA_PATCH_RECIPES)) {
  hydraCount++;
  check(`${id}: name matches key`, recipe.name === id, `name='${recipe.name}'`);
  check(`${id}: category in 19-enum`, HYDRA_CATEGORIES.includes(recipe.category), `category='${recipe.category}'`);
  check(`${id}: has non-empty params`, Object.keys(recipe.params).length > 0);

  // Every params key must be buildable via PATCH_OFFSETS.
  for (const key of Object.keys(recipe.params)) {
    check(`${id}: params['${key}'] in PATCH_OFFSETS`, findPatchOffset(key) !== undefined,
      'not buildable atomically — fall back to set_param or extend PATCH_OFFSETS');
  }

  // ...and every params VALUE must survive the Hydra's own value
  // resolver. The check above proves only that the NAME maps to a byte
  // offset; it says nothing about whether the value fits. That is the
  // same name-checked-but-never-encoded gap that let the Fractal
  // families ship `filter.sensitivity = 65` against a [0.1..40] param,
  // so it gets closed here too rather than left as the last unguarded
  // value surface in the library.
  //
  // `resolveNrpnValue` is what `apply_patch` calls for a plain param
  // (tools/patch.ts). FX SUB-params (`prefxparam1` &c) route through
  // `resolveFxAwareValue` there instead, because their scaling depends
  // on the selected fx type; no recipe currently authors one, and if a
  // recipe ever does, this check still catches an out-of-range value
  // under the generic encoding.
  for (const [key, value] of Object.entries(recipe.params)) {
    const nrpn = findHydraNrpn(key);
    if (nrpn === undefined) continue; // reported by the PATCH_OFFSETS check
    let threw: string | undefined;
    try {
      resolveNrpnValue(nrpn, value);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    check(
      `${id}: params['${key}'] = ${JSON.stringify(value)} resolves on the Hydrasynth`,
      threw === undefined,
      threw?.slice(0, 130),
    );
  }

  // signature_params ⊆ params, with equal values (slim summary can't lie).
  for (const [k, v] of Object.entries(recipe.signature_params)) {
    const inParams = Object.prototype.hasOwnProperty.call(recipe.params, k);
    check(`${id}: signature_params['${k}'] is a param`, inParams);
    if (inParams) {
      check(`${id}: signature_params['${k}'] value matches params`, recipe.params[k] === v,
        `signature=${JSON.stringify(v)} params=${JSON.stringify(recipe.params[k])}`);
    }
  }

  // requires_nrpn must reflect presence of routes.
  const hasRoutes = (recipe.mod_routes?.length ?? 0) > 0 || (recipe.macro_routes?.length ?? 0) > 0;
  const matRequires = materializeHydraPatchRecipe(id).requires_nrpn;
  check(`${id}: requires_nrpn reflects routes`, matRequires === (hasRoutes || recipe.requires_nrpn === true),
    `materialized=${matRequires} hasRoutes=${hasRoutes}`);

  // Route names resolve on the descriptor (catch typos at CI).
  for (const r of recipe.mod_routes ?? []) {
    check(`${id}: mod source "${r.source}" resolves`, hydraModNameResolves('source', r.source));
    check(`${id}: mod target "${r.target}" resolves`, hydraModNameResolves('target', r.target));
    check(`${id}: mod depth in -127..127`, Number.isInteger(r.depth) && r.depth >= -127 && r.depth <= 127, `depth=${r.depth}`);
  }
  for (const r of recipe.macro_routes ?? []) {
    check(`${id}: macro ${r.macro} in 1..8`, Number.isInteger(r.macro) && r.macro >= 1 && r.macro <= 8, `macro=${r.macro}`);
    check(`${id}: macro target "${r.target}" resolves`, hydraMacroTargetResolves(r.macro, r.target));
    check(`${id}: macro depth in -127..127`, Number.isInteger(r.depth) && r.depth >= -127 && r.depth <= 127, `depth=${r.depth}`);
  }

  // Materializer round-trip: param count = merged key count.
  const mat = materializeHydraPatchRecipe(id);
  check(`${id}: materialize param count = params key count`, mat.params.length === Object.keys(recipe.params).length,
    `materialized=${mat.params.length} keys=${Object.keys(recipe.params).length}`);
}

// Override merge + unknown-id negative case.
console.log('\n[patch_archetype] override + unknown-id');
{
  const firstId = Object.keys(HYDRA_PATCH_RECIPES)[0];
  const firstKey = Object.keys(HYDRA_PATCH_RECIPES[firstId].params)[0];
  const merged = materializeHydraPatchRecipe(firstId, { [firstKey]: 999 });
  const overridden = merged.params.find((p) => p.name === firstKey);
  check(`override '${firstKey}' takes effect`, overridden?.value === 999, `got ${JSON.stringify(overridden?.value)}`);

  let threw = false;
  let code = '';
  let known: readonly string[] | undefined;
  try {
    materializeHydraPatchRecipe('this_hydra_recipe_does_not_exist');
  } catch (err) {
    threw = true;
    code = err instanceof RecipeMaterializeError ? err.code : '';
    known = err instanceof RecipeMaterializeError ? err.known_recipes : undefined;
  }
  check('unknown hydra recipe id throws unknown_recipe with known_recipes[]',
    threw && code === 'unknown_recipe' && Array.isArray(known) && known.length > 0,
    threw ? `code='${code}', known=${known?.length ?? 0}` : 'no error');
}

// Final coverage reconciliation: the three walks (single-block,
// scene_leveling, block_stack, patch_archetype) must add up to the full
// census. If they don't, a family is being counted but not verified.
console.log('');
const verifiedTotal = entries.length + sceneLevelingCount + blockStackCount + hydraCount;
check(
  `all ${totalRecipeIds} recipe id(s) across ${Object.keys(FAMILY_TABLES).length} families are verified by this gate`,
  verifiedTotal === totalRecipeIds,
  `verified ${verifiedTotal} (single-block ${entries.length} + scene_leveling ${sceneLevelingCount} + block_stack ${blockStackCount} + patch_archetype ${hydraCount})`,
);

console.log('');
if (failed > 0) {
  console.error(`x ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log(
  `OK verify-recipe-tables: ${totalRecipeIds} recipe id(s) across ${Object.keys(FAMILY_TABLES).length} families verified ` +
    `(${entries.length} single-block + ${sceneLevelingCount} scene_leveling + ${blockStackCount} block_stack + ${hydraCount} patch_archetype).`,
);
