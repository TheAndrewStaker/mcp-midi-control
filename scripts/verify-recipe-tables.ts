/**
 * Golden: BK-061 + BK-062 recipe-table integrity check.
 *
 * For every recipe (pitch / wah / filter):
 *   1. `resolveXxxRecipe(name, port)` returns a non-empty params dict
 *      for each port listed in `applicable_devices`.
 *   2. `resolveXxxRecipe(name, port)` THROWS for every port NOT listed
 *      in `applicable_devices` (recipe is gated correctly).
 *   3. Every param name in every per-device params dict resolves to a
 *      real param in that device's catalog (fractal-midi's
 *      `KNOWN_PARAMS` for II, `CACHE_PARAMS` for AM4, `PARAM_BY_KEY`
 *      for III). Catches typos + drift between recipe authoring and
 *      the device's actual param dictionary.
 *
 * No hardware, no MIDI. Pure-data sanity check over the recipe library
 * + fractal-midi param catalogs.
 *
 * Run via:  npx tsx scripts/verify-recipe-tables.ts
 * Wired into npm test for regression coverage.
 */

import { KNOWN_PARAMS as AXE_FX_II_KNOWN_PARAMS } from 'fractal-midi/axe-fx-ii';
import { CACHE_PARAMS as AM4_CACHE_PARAMS } from 'fractal-midi/am4';
import { PARAM_BY_KEY as AXE_FX_III_PARAM_BY_KEY } from 'fractal-midi/axe-fx-iii';

import {
  PITCH_RECIPES,
  resolvePitchRecipe,
  WAH_RECIPES,
  resolveWahRecipe,
  FILTER_RECIPES,
  resolveFilterRecipe,
  type RecipePort,
} from '../packages/core/src/protocol-generic/recipes/index.js';

const ALL_PORTS: readonly RecipePort[] = ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const;

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

// Per-port "is this param name known on this block?" router.
function paramExists(port: RecipePort, block: string, name: string): boolean {
  if (port === 'axe-fx-ii') return hasIIParam(block, name);
  if (port === 'am4') return hasAM4Param(block, name);
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

// Block name per recipe category, per port. AM4 + II share lowercase
// `pitch`/`wah`/`filter`; III uses uppercase family symbols PITCH/WAH/
// FILTER.
const BLOCK_NAME: Readonly<Record<string, Readonly<Record<RecipePort, string>>>> = {
  pitch:  { am4: 'pitch',  'axe-fx-ii': 'pitch',  'axe-fx-iii': 'PITCH'  },
  wah:    { am4: 'wah',    'axe-fx-ii': 'wah',    'axe-fx-iii': 'WAH'    },
  filter: { am4: 'filter', 'axe-fx-ii': 'filter', 'axe-fx-iii': 'FILTER' },
};

interface RecipeEntry {
  readonly category: 'pitch' | 'wah' | 'filter';
  readonly name: string;
  readonly applicable_devices: readonly RecipePort[];
  readonly params_per_device: Readonly<Partial<Record<RecipePort, Readonly<Record<string, number | string>>>>>;
  readonly resolve: (recipeName: string, port: RecipePort) => {
    params: Readonly<Record<string, number | string>>;
    modifier_needed: boolean;
  };
}

function walkRecipes(): RecipeEntry[] {
  const entries: RecipeEntry[] = [];
  for (const [name, spec] of Object.entries(PITCH_RECIPES)) {
    entries.push({
      category: 'pitch',
      name,
      applicable_devices: spec.applicable_devices,
      params_per_device: spec.params_per_device,
      resolve: resolvePitchRecipe,
    });
  }
  for (const [name, spec] of Object.entries(WAH_RECIPES)) {
    entries.push({
      category: 'wah',
      name,
      applicable_devices: spec.applicable_devices,
      params_per_device: spec.params_per_device,
      resolve: resolveWahRecipe,
    });
  }
  for (const [name, spec] of Object.entries(FILTER_RECIPES)) {
    entries.push({
      category: 'filter',
      name,
      applicable_devices: spec.applicable_devices,
      params_per_device: spec.params_per_device,
      resolve: resolveFilterRecipe,
    });
  }
  return entries;
}

const entries = walkRecipes();

console.log(`\nVerifying ${entries.length} recipe(s) across ${ALL_PORTS.length} ports.\n`);

const pitchCount = Object.keys(PITCH_RECIPES).length;
const wahCount = Object.keys(WAH_RECIPES).length;
const filterCount = Object.keys(FILTER_RECIPES).length;
console.log(`  pitch  : ${pitchCount} recipe(s)`);
console.log(`  wah    : ${wahCount} recipe(s)`);
console.log(`  filter : ${filterCount} recipe(s)\n`);

// Coverage assertions: the BK-061/BK-062 task statement lists 7 pitch
// + 6 wah/filter recipes. Catch silent regressions if a recipe is
// later removed without an explicit scope change.
check('pitch category ships >= 7 recipes', pitchCount >= 7, `got ${pitchCount}`);
check('wah category ships >= 3 recipes', wahCount >= 3, `got ${wahCount}`);
check('filter category ships >= 3 recipes', filterCount >= 3, `got ${filterCount}`);

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
    const block = BLOCK_NAME[entry.category][port];
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

// 5. Unknown recipe names throw with a list of known recipes.
console.log('\n[unknown-recipe] negative cases');
for (const resolve of [resolvePitchRecipe, resolveWahRecipe, resolveFilterRecipe]) {
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

console.log('');
if (failed > 0) {
  console.error(`x ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log(`OK verify-recipe-tables: ${entries.length} recipe(s) verified.`);
