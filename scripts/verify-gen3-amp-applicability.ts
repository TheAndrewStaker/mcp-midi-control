/**
 * Gen-3 amp type-knob applicability (findCompatibleTypes), backed by the
 * per-amp-model valid-param table adopted from the MIT `ai-tone-assistant`
 * project. Asserts the gen-3 descriptor now answers find_compatible_types /
 * the apply_preset pre-flight for the amp block (was applicability_known:false).
 */
import { createModernFractalDescriptor } from '../packages/fractal-gen3/dist/factory.js';
import { FM9_CONFIG } from '../packages/fractal-gen3/dist/configs/fm9.js';
import { AMP_TYPE_VALID_PARAMS } from '../packages/fractal-midi/dist/gen3/axe-fx-iii/index.js';

let ok = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) ok += 1;
  else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

const d = createModernFractalDescriptor(FM9_CONFIG);
const fct = d.findCompatibleTypes;
check('FM9 descriptor implements findCompatibleTypes', typeof fct === 'function');
if (typeof fct !== 'function') {
  console.log(`gen3-amp-applicability: ${ok} ok, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

// data table sanity
check('amp valid-param table has 331 ordinals', AMP_TYPE_VALID_PARAMS.length === 331, `got ${AMP_TYPE_VALID_PARAMS.length}`);

// 'drive' is universal — every amp model has a drive knob.
const drive = fct({ block: 'amp', params: ['drive'] });
check('amp+drive: applicability_known', drive.applicability_known === true);
// The FM9 fw 12 cache names 336 amps; the validity table covers the first 331.
// The 5 newer ones are named in the note as unfiltered, not counted as compatible.
check('amp+drive: all 331 covered amps expose drive', drive.compatible_types.length === 331 && drive.total_types === 336, `${drive.compatible_types.length}/${drive.total_types}`);
check('amp+drive: the 5 uncovered fw 12 amps are named in the note', /not filtered: .*Brit JVM Crunch Red/.test(drive.note ?? ''), String(drive.note));

// 'depth' (sag/depth) is NOT universal — a strict subset of amps expose it.
const depth = fct({ block: 'amp', params: ['depth'] });
check('amp+depth: applicability_known', depth.applicability_known === true);
check('amp+depth: a strict subset (fewer than all, more than none)', depth.compatible_types.length > 0 && depth.compatible_types.length < 331, `${depth.compatible_types.length}/331`);
check('amp+depth: narrower than amp+drive', depth.compatible_types.length < drive.compatible_types.length);

// AND-semantics: depth+drive ⊆ depth.
const both = fct({ block: 'amp', params: ['depth', 'drive'] });
check('amp+depth+drive ⊆ amp+depth (AND-narrowing)', both.compatible_types.length <= depth.compatible_types.length);

// Ground-truth ordinal check straight from the table: ord 0 has DEPTH, ord 1 does not
// (verified from the generated data — a power amp w/ sag vs a stripped model).
const ord0HasDepth = AMP_TYPE_VALID_PARAMS[0].includes('DISTORT_DEPTH');
const ord1HasDepth = AMP_TYPE_VALID_PARAMS[1].includes('DISTORT_DEPTH');
check('table: ordinal 0 exposes DEPTH, ordinal 1 does not (sanity)', ord0HasDepth && !ord1HasDepth, `ord0=${ord0HasDepth} ord1=${ord1HasDepth}`);

// Non-amp block: no table → applicability_known false (unfiltered passthrough).
const reverb = fct({ block: 'reverb', params: ['time'] });
check('reverb: applicability_known false (no amp table applies)', reverb.applicability_known === false);

// Unknown knob: resolves to nothing → known false, not a crash.
const bogus = fct({ block: 'amp', params: ['definitelynotaknob'] });
check('amp + unknown knob: applicability_known false', bogus.applicability_known === false);

console.log(`gen3-amp-applicability: ${ok} ok, ${fail} fail`);
if (fail > 0) process.exit(1);
