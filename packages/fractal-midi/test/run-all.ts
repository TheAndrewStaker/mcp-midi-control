// fractal-midi test runner.
//
// tsx-runnable goldens, each printing PASS / FAIL and exiting non-zero
// on failure.

import { VERSION } from '../src/index.js';
import { runPackValueTests, runChecksumTests } from './shared/packvalue.test.js';
import { runLineageTests } from './shared/lineage.test.js';
import { runDisplayScaleTests, DISPLAYSCALE_CASE_COUNT } from './shared/displayscale.test.js';
import { runEffectIdTests, EFFECTID_CASE_COUNT } from './shared/effectid.test.js';
import { runAm4SetParamTests, AM4_GOLDEN_CASE_COUNT } from './am4/setparam.test.js';
import { runAm4BlockLayoutTests, AM4_BLOCK_LAYOUT_CASE_COUNT } from './am4/blocklayout.test.js';
import { runAm4DecodeTests, AM4_DECODE_CASE_COUNT } from './am4/decode.test.js';
import { runAm4MidiRegisterTests, AM4_MIDI_REGISTER_CASE_COUNT } from './am4/midiregisters.test.js';
import {
  runAm4PresetBinaryTests,
  AM4_PRESET_BINARY_CASE_COUNT,
} from './am4/presetbinary.test.js';
import {
  runAm4PresetContainerTests,
  AM4_PRESET_CONTAINER_CASE_COUNT,
} from './am4/presetcontainer.test.js';
import { runAxeFxIISetParamTests, AXEFX2_GOLDEN_CASE_COUNT } from './gen2/axe-fx-ii/setparam.test.js';
import { runAxeFxIIRoutingTests, AXEFX2_ROUTING_CASE_COUNT } from './gen2/axe-fx-ii/routing.test.js';
import { runAxeFxGen1SetParamTests, AXEFXGEN1_GOLDEN_CASE_COUNT } from './gen1/setparam.test.js';
import { runAxeFxGen1ReadParamTests, AXEFXGEN1_READ_CASE_COUNT } from './gen1/readparam.test.js';
import { runAxeFxGen1PatchDumpTests, AXEFXGEN1_PATCHDUMP_CASE_COUNT } from './gen1/patchdump.test.js';
import { runAxeFxIIAnnotationCoverageTests, AXEFX2_ANNOTATION_CASE_COUNT } from './gen2/axe-fx-ii/annotation-coverage.test.js';
import { runAxeFxIIApplicabilityTests, AXEFX2_APPLICABILITY_CASE_COUNT } from './gen2/axe-fx-ii/applicability.test.js';
import { runAxeFxIIISetParamTests, AXEFX3_GOLDEN_CASE_COUNT } from './gen3/axe-fx-iii/setparam.test.js';
import { runAxeFxIIICalibrationTest } from './gen3/axe-fx-iii/calibration.test.js';
import { runGen3RoutingTests, GEN3_ROUTING_CASE_COUNT } from './gen3/axe-fx-iii/routing.test.js';
import { runGen3SubactionTests, GEN3_SUBACTION_CASE_COUNT } from './gen3/axe-fx-iii/subactions.test.js';
import { runGen3GridLayoutTests, GEN3_GRIDLAYOUT_CASE_COUNT } from './gen3/axe-fx-iii/gridlayout.test.js';
import { runGen3LiveMetersTests, GEN3_LIVEMETERS_CASE_COUNT } from './gen3/axe-fx-iii/livemeters.test.js';
import { runGen3TypeNameTests, GEN3_TYPENAME_CASE_COUNT } from './gen3/axe-fx-iii/typename.test.js';
import { runGen3RoundtripDiscreteTests, GEN3_ROUNDTRIP_DISCRETE_CASE_COUNT } from './gen3/axe-fx-iii/roundtrip-discrete.test.js';
import { runModernFamilyTests, MODERN_FAMILY_CASE_COUNT } from './gen3/modern-family/catalog.test.js';
import { runFm9KindClassificationTests, FM9_KIND_CLASSIFICATION_CASE_COUNT } from './gen3/fm9/kind-classification.test.js';
import { runFm9CatalogTests, FM9_CATALOG_CASE_COUNT } from './gen3/fm9/catalog.test.js';
import { runFm9SetParamTests, FM9_SETPARAM_CASE_COUNT } from './gen3/fm9/setparam.test.js';
import { runFm9RangesTests, FM9_RANGES_CASE_COUNT } from './gen3/fm9/ranges.test.js';
import { runFm9CabRosterTests, FM9_CAB_ROSTER_CASE_COUNT } from './gen3/fm9/cab-rosters.test.js';
import { runFm3KindClassificationTests, FM3_KIND_CLASSIFICATION_CASE_COUNT } from './gen3/fm3/kind-classification.test.js';
import { runFm3CatalogTests, FM3_CATALOG_CASE_COUNT } from './gen3/fm3/catalog.test.js';
import { runFm3SetParamTests, FM3_SETPARAM_CASE_COUNT } from './gen3/fm3/setparam.test.js';
import { runVp4SetParamTests, VP4_SETPARAM_CASE_COUNT } from './gen3/vp4/setparam.test.js';
import { runVp4StructureBlobTests, VP4_STRUCTBLOB_CASE_COUNT } from './gen3/vp4/structureblob.test.js';

const tests: Array<{ name: string; run: () => void | Promise<void> }> = [
  {
    name: 'skeleton-smoke',
    run: () => {
      if (typeof VERSION !== 'string' || VERSION.length === 0) {
        throw new Error('VERSION export missing');
      }
    },
  },
  { name: 'shared/checksum', run: runChecksumTests },
  { name: 'shared/packvalue', run: runPackValueTests },
  { name: 'shared/lineage-load', run: runLineageTests },
  { name: `shared/displayscale (${DISPLAYSCALE_CASE_COUNT} goldens)`, run: runDisplayScaleTests },
  { name: `shared/effectid (${EFFECTID_CASE_COUNT} goldens)`, run: runEffectIdTests },
  { name: `am4/setparam (${AM4_GOLDEN_CASE_COUNT} goldens)`, run: runAm4SetParamTests },
  { name: `am4/blocklayout (${AM4_BLOCK_LAYOUT_CASE_COUNT} cases)`, run: runAm4BlockLayoutTests },
  { name: `am4/decode (${AM4_DECODE_CASE_COUNT} cases)`, run: runAm4DecodeTests },
  { name: `am4/midiregisters (${AM4_MIDI_REGISTER_CASE_COUNT} cases)`, run: runAm4MidiRegisterTests },
  {
    name: `am4/presetBinary (${AM4_PRESET_BINARY_CASE_COUNT} cases)`,
    run: runAm4PresetBinaryTests,
  },
  {
    name: `am4/presetContainer (${AM4_PRESET_CONTAINER_CASE_COUNT} cases)`,
    run: runAm4PresetContainerTests,
  },
  { name: `axe-fx-ii/setparam (${AXEFX2_GOLDEN_CASE_COUNT} goldens)`, run: runAxeFxIISetParamTests },
  { name: `axe-fx-ii/routing (${AXEFX2_ROUTING_CASE_COUNT} goldens)`, run: runAxeFxIIRoutingTests },
  { name: `axe-fx-gen1/setparam (${AXEFXGEN1_GOLDEN_CASE_COUNT} goldens)`, run: runAxeFxGen1SetParamTests },
  { name: `axe-fx-gen1/readparam (${AXEFXGEN1_READ_CASE_COUNT} goldens)`, run: runAxeFxGen1ReadParamTests },
  { name: `axe-fx-gen1/patchdump (${AXEFXGEN1_PATCHDUMP_CASE_COUNT} goldens)`, run: runAxeFxGen1PatchDumpTests },
  { name: `axe-fx-ii/annotation-coverage (${AXEFX2_ANNOTATION_CASE_COUNT} goldens)`, run: runAxeFxIIAnnotationCoverageTests },
  { name: `axe-fx-ii/applicability (${AXEFX2_APPLICABILITY_CASE_COUNT} goldens)`, run: runAxeFxIIApplicabilityTests },
  { name: `axe-fx-iii/setparam (${AXEFX3_GOLDEN_CASE_COUNT} goldens)`, run: runAxeFxIIISetParamTests },
  { name: 'axe-fx-iii/calibration', run: runAxeFxIIICalibrationTest },
  { name: `axe-fx-iii/routing (${GEN3_ROUTING_CASE_COUNT} goldens)`, run: runGen3RoutingTests },
  { name: `axe-fx-iii/subactions (${GEN3_SUBACTION_CASE_COUNT} goldens)`, run: runGen3SubactionTests },
  { name: `axe-fx-iii/gridlayout (${GEN3_GRIDLAYOUT_CASE_COUNT} goldens)`, run: runGen3GridLayoutTests },
  { name: `axe-fx-iii/livemeters (${GEN3_LIVEMETERS_CASE_COUNT} goldens)`, run: runGen3LiveMetersTests },
  { name: `axe-fx-iii/typename (${GEN3_TYPENAME_CASE_COUNT} goldens)`, run: runGen3TypeNameTests },
  { name: `axe-fx-iii/roundtrip-discrete (${GEN3_ROUNDTRIP_DISCRETE_CASE_COUNT} goldens)`, run: runGen3RoundtripDiscreteTests },
  { name: `modern-family/catalog (${MODERN_FAMILY_CASE_COUNT} goldens)`, run: runModernFamilyTests },
  { name: `fm9/kind-classification (${FM9_KIND_CLASSIFICATION_CASE_COUNT} goldens)`, run: runFm9KindClassificationTests },
  { name: `fm9/catalog (${FM9_CATALOG_CASE_COUNT} goldens)`, run: runFm9CatalogTests },
  { name: `fm9/setparam (${FM9_SETPARAM_CASE_COUNT} goldens)`, run: runFm9SetParamTests },
  { name: `fm9/ranges (${FM9_RANGES_CASE_COUNT} goldens)`, run: runFm9RangesTests },
  { name: `fm9/cab-rosters (${FM9_CAB_ROSTER_CASE_COUNT} goldens)`, run: runFm9CabRosterTests },
  { name: `fm3/kind-classification (${FM3_KIND_CLASSIFICATION_CASE_COUNT} goldens)`, run: runFm3KindClassificationTests },
  { name: `fm3/catalog (${FM3_CATALOG_CASE_COUNT} goldens)`, run: runFm3CatalogTests },
  { name: `fm3/setparam (${FM3_SETPARAM_CASE_COUNT} goldens)`, run: runFm3SetParamTests },
  { name: `vp4/setparam (${VP4_SETPARAM_CASE_COUNT} goldens)`, run: runVp4SetParamTests },
  { name: `vp4/structureblob (${VP4_STRUCTBLOB_CASE_COUNT} goldens)`, run: runVp4StructureBlobTests },
];

let failures = 0;

for (const { name, run } of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${tests.length} test(s) passed.`);
