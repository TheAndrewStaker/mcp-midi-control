/**
 * BK-064 part 2 goldens: scene-leveling recipe library.
 *
 * Unlike the pitch / wah / filter recipes, scene-leveling recipes
 * don't author per-block param dicts — they author per-role dB offset
 * profiles meant to be applied to the device's Output 1 block (or
 * Volume block on AM4) on each scene. The goldens here assert:
 *
 *   1. Every shipped recipe has a non-empty offsets_db table.
 *   2. Every offset is a finite number in a sane dB range (-24..+24).
 *   3. resolveSceneLevelingRecipe + lookupSceneRoleOffset behave per
 *      the documented contract (throw on unknown name, return
 *      undefined for unlisted roles, apply across each device port).
 *   4. Coverage: the BACKLOG task statement names exactly 4 recipes;
 *      regression-detect if anyone removes one silently.
 *
 * Run: npx tsx scripts/verify-scene-leveling.ts
 */

import {
  SCENE_LEVELING_RECIPES,
  resolveSceneLevelingRecipe,
  lookupSceneRoleOffset,
  type SceneRole,
} from '@mcp-midi-control/core/protocol-generic/recipes/index.js';
import type { RecipePort } from '@mcp-midi-control/core/protocol-generic/recipes/index.js';

const ALL_PORTS: readonly RecipePort[] = ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const;
const ALL_ROLES: readonly SceneRole[] = ['intro', 'clean', 'rhythm', 'build', 'solo', 'breakdown'] as const;

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `. ${detail}` : ''}`);
  }
}

const recipeCount = Object.keys(SCENE_LEVELING_RECIPES).length;
console.log(`Verifying ${recipeCount} scene-leveling recipe(s) across ${ALL_PORTS.length} ports.\n`);

check(
  'ships >= 4 scene-leveling recipes (per BACKLOG)',
  recipeCount >= 4,
  `got ${recipeCount}`,
);

// Required recipe coverage — names baked into the BACKLOG spec.
const REQUIRED_NAMES = [
  'arrangement_dynamic_rock',
  'arrangement_balanced_metal',
  'arrangement_loud_solo',
  'arrangement_modern_mix',
];
for (const name of REQUIRED_NAMES) {
  check(`recipe "${name}" is present`, name in SCENE_LEVELING_RECIPES);
}

for (const [name, spec] of Object.entries(SCENE_LEVELING_RECIPES)) {
  console.log(`\n[scene-leveling] ${name}`);

  check(
    `applicable_devices non-empty`,
    spec.applicable_devices.length > 0,
  );
  check(
    `offsets_db non-empty`,
    Object.keys(spec.offsets_db).length > 0,
  );
  check(
    `description non-empty`,
    typeof spec.description === 'string' && spec.description.length > 0,
  );

  // Each offset is a sane signed dB value.
  for (const [role, db] of Object.entries(spec.offsets_db)) {
    check(
      `${role} = ${db} dB is finite`,
      typeof db === 'number' && Number.isFinite(db),
    );
    check(
      `${role} = ${db} dB is in [-24, +24]`,
      typeof db === 'number' && db >= -24 && db <= 24,
    );
  }

  // resolve returns the offset table for each applicable device.
  for (const port of spec.applicable_devices) {
    let resolved: Readonly<Partial<Record<SceneRole, number>>> | null = null;
    try {
      resolved = resolveSceneLevelingRecipe(name, port);
    } catch (err) {
      check(
        `resolve(${name}, ${port}) does not throw`,
        false,
        (err as Error).message.slice(0, 80),
      );
      continue;
    }
    check(
      `resolve(${name}, ${port}) returns the offsets table`,
      resolved === spec.offsets_db || JSON.stringify(resolved) === JSON.stringify(spec.offsets_db),
    );
  }

  // resolve throws for non-applicable ports.
  const nonApplicable = ALL_PORTS.filter((p) => !spec.applicable_devices.includes(p));
  for (const port of nonApplicable) {
    let threw = false;
    try {
      resolveSceneLevelingRecipe(name, port);
    } catch {
      threw = true;
    }
    check(`resolve(${name}, ${port}) throws (non-applicable)`, threw);
  }

  // lookupSceneRoleOffset returns the right value for each defined role.
  for (const port of spec.applicable_devices) {
    for (const role of ALL_ROLES) {
      const got = lookupSceneRoleOffset(name, port, role);
      const expected = spec.offsets_db[role];
      check(
        `lookupSceneRoleOffset(${name}, ${port}, ${role}) === ${JSON.stringify(expected)}`,
        got === expected,
        `got ${JSON.stringify(got)}`,
      );
    }
  }
}

console.log('\nNegative cases');
{
  let threw = false;
  try {
    resolveSceneLevelingRecipe('not_a_recipe', 'am4');
  } catch {
    threw = true;
  }
  check('resolve(unknown_recipe) throws with a known-recipes list', threw);
}

console.log(`\n${failed === 0 ? 'all cases pass' : `${failed} case(s) failed`}.`);
if (failed > 0) process.exit(1);
