// review scratch: print the cache rows behind a few gen-3 params
import { FM3_RANGES, FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import { FM9_RANGES, FM9_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm9';
import { III_RANGES, PARAMS_BY_FAMILY } from 'fractal-midi/gen3/axe-fx-iii';
import { DEVICE_LABEL_CALIBRATION } from 'fractal-midi/gen2/axe-fx-ii';
const names = process.argv.slice(2);
for (const [id, R, P] of [['fm3', FM3_RANGES, FM3_PARAMS_BY_FAMILY], ['fm9', FM9_RANGES, FM9_PARAMS_BY_FAMILY], ['iii', III_RANGES, PARAMS_BY_FAMILY]] as const)
  for (const [fam, ps] of Object.entries(P as any)) for (const p of ps as any[]) if (names.includes(p.name)) {
    const r = (R as any)[fam]?.[p.paramId];
    console.log(id, p.name, JSON.stringify(r), r ? 'inc=' + r.step * r.scale : '');
  }
for (const k of Object.keys(DEVICE_LABEL_CALIBRATION)) if (names.some((n) => k === n)) console.log('II', k, JSON.stringify(DEVICE_LABEL_CALIBRATION[k]));
