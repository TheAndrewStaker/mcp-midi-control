/**
 * Auto-wah recipe goldens.
 *
 * Auto-wah is the recipe-library entry the Session 99 install-test
 * agent rejected ("envelope-follower wiring is a separate operation").
 * The shape differs from pitch/wah/filter recipes because the target
 * block changes per device:
 *
 *   - AM4 targets the FILTER block with `filter.type='Auto-Wah'`
 *     (built-in env follower; modifier_needed = false).
 *   - II / III target the WAH block with a static position +
 *     `modifier_needed = true` until BK-063 lands.
 *
 * Cases:
 *   1. Every shipped recipe resolves to non-empty params for each
 *      applicable port.
 *   2. AM4 entries target block='filter'; II/III entries target
 *      block='wah'.
 *   3. AM4 entries have modifier_needed=false; II/III entries have
 *      modifier_needed=true.
 *   4. AM4 entries use `filter.type` with an enum value that lives in
 *      the AM4 FILTER_TYPES table (Auto-Wah / Envelope Filter /
 *      Touch-Wah).
 *   5. Unknown recipe name throws.
 *   6. Recipe ships >= 4 entries (BACKLOG candidates: funk, cantrell,
 *      hendrix, subtle).
 *
 * Run: npx tsx scripts/verify-auto-wah-recipes.ts
 */

import {
  AUTO_WAH_RECIPES,
  resolveAutoWahRecipe,
  type RecipePort,
} from '@mcp-midi-control/core/protocol-generic/recipes/index.js';

const ALL_PORTS: readonly RecipePort[] = ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const;

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `. ${detail}` : ''}`);
  }
}

const recipeCount = Object.keys(AUTO_WAH_RECIPES).length;
console.log(`Verifying ${recipeCount} auto-wah recipe(s) across ${ALL_PORTS.length} ports.\n`);

check(
  'ships >= 4 auto-wah recipes (funk, cantrell, hendrix, subtle)',
  recipeCount >= 4,
  `got ${recipeCount}`,
);

const REQUIRED_NAMES = [
  'auto_wah_funk',
  'auto_wah_cantrell',
  'auto_wah_hendrix',
  'auto_wah_subtle',
];
for (const name of REQUIRED_NAMES) {
  check(`recipe "${name}" is present`, name in AUTO_WAH_RECIPES);
}

// AM4 FILTER block enum values that count as "envelope-driven" modes.
const AM4_ENV_FILTER_TYPES = new Set(['Auto-Wah', 'Envelope Filter', 'Touch-Wah']);

for (const [name, spec] of Object.entries(AUTO_WAH_RECIPES)) {
  console.log(`\n[auto-wah] ${name}`);

  check('applicable_devices non-empty', spec.applicable_devices.length > 0);
  check('description non-empty', spec.description.length > 0);

  for (const port of spec.applicable_devices) {
    let resolved: ReturnType<typeof resolveAutoWahRecipe> | null = null;
    try {
      resolved = resolveAutoWahRecipe(name, port);
    } catch (err) {
      check(
        `resolve(${name}, ${port}) does not throw`,
        false,
        (err as Error).message.slice(0, 80),
      );
      continue;
    }
    check(
      `resolve(${name}, ${port}) returns non-empty params`,
      Object.keys(resolved.params).length > 0,
    );
    if (port === 'am4') {
      check(`AM4 target_block === 'filter'`, resolved.target_block === 'filter');
      check(`AM4 modifier_needed === false`, resolved.modifier_needed === false);
      const typeValue = resolved.params.type;
      check(
        `AM4 filter.type is an env-driven mode, got ${JSON.stringify(typeValue)}`,
        typeof typeValue === 'string' && AM4_ENV_FILTER_TYPES.has(typeValue),
      );
    } else {
      check(`${port} target_block === 'wah'`, resolved.target_block === 'wah');
      check(`${port} modifier_needed === true`, resolved.modifier_needed === true);
    }
  }

  // Non-applicable ports throw.
  for (const port of ALL_PORTS) {
    if (spec.applicable_devices.includes(port)) continue;
    let threw = false;
    try {
      resolveAutoWahRecipe(name, port);
    } catch {
      threw = true;
    }
    check(`resolve(${name}, ${port}) throws (non-applicable)`, threw);
  }
}

console.log('\nNegative case');
{
  let threw = false;
  try {
    resolveAutoWahRecipe('not_an_auto_wah_recipe', 'am4');
  } catch {
    threw = true;
  }
  check('resolve(unknown_recipe) throws', threw);
}

console.log(`\n${failed === 0 ? 'all cases pass' : `${failed} case(s) failed`}.`);
if (failed > 0) process.exit(1);
