// verify-gen3-cab-polish.ts
//
// Golden for BK-103c: the gen-3 apply executor ENFORCES the mix-ready
// cab-polish defaults (low cut 80 Hz, high cut 6500 Hz, room 8%) on a
// fresh cab-bearing build, per written cab channel window, unless the
// spec expresses any cab cut/room/slope opinion of its own or bypasses
// the cab block. Mirrors the AM4's BK-103b golden with the gen-3
// device differences:
//   - the cab is its OWN grid block (injection keys on placing a cab
//     slot, never the amp; blocks are never auto-placed),
//   - injection is EVIDENCE-GATED per device: it fires only where the
//     cab cut params are display-calibrated in that device's own
//     catalog. Today that is the FM9 (device-true ranges from its own
//     editor cache); the Axe-Fx III and FM3 cab cuts are registered but
//     uncalibrated raw-wire passthrough, so those devices inject
//     NOTHING (writing "80" through their passthrough encode would be
//     a guessed near-zero normalized wire value, not 80 Hz),
//   - the filter-slope selector (order) is NEVER injected on gen-3 (no
//     verified value table on any device yet).
//
// Offline pure-function check over the real per-device catalogs
// (injectGen3CabPolish is the pre-pass writer.applyPreset runs before
// building writes; params-record insertion order IS write order on the
// gen-3 apply path). No MIDI I/O.
//
// Run: npx tsx scripts/verify-gen3-cab-polish.ts

import type { PresetSlotSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import { createModernFractalDescriptor } from '../packages/fractal-gen3/src/factory.js';
import { AXE_FX_III_CONFIG } from '../packages/fractal-gen3/src/configs/axe-fx-iii.js';
import { FM3_CONFIG } from '../packages/fractal-gen3/src/configs/fm3.js';
import { FM9_CONFIG } from '../packages/fractal-gen3/src/configs/fm9.js';
import { injectGen3CabPolish } from '../packages/fractal-gen3/src/cabPolish.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK   -- ${label}`);
  } else {
    failures++;
    console.error(`  FAIL -- ${label}${detail ? `: ${detail}` : ''}`);
  }
}

const INJECTED = ['locut', 'hicut', 'roommix'];

const fm9Blocks = createModernFractalDescriptor(FM9_CONFIG).blocks!;
const iiiBlocks = createModernFractalDescriptor(AXE_FX_III_CONFIG).blocks!;
const fm3Blocks = createModernFractalDescriptor(FM3_CONFIG).blocks!;

const fm9Cab = fm9Blocks['cab'];
const iiiCab = iiiBlocks['cab'];
const fm3Cab = fm3Blocks['cab'];

const inject = (
  slots: readonly PresetSlotSpec[],
  cab: typeof fm9Cab,
): ReturnType<typeof injectGen3CabPolish> => injectGen3CabPolish(slots, cab, 'A');

// ── Case 1: FM9 bare cab placement → defaults injected, pinned to channel A ──
console.log('Case 1: FM9 bare cab placement injects the defaults nested under channel A');
{
  const { slots, cabPolish } = inject(
    [
      { slot: { row: 2, col: 3 }, block_type: 'amp', params: { gain: 6 } },
      { slot: { row: 2, col: 4 }, block_type: 'cab' },
    ],
    fm9Cab,
  );
  const cabParams = slots[1].params as Record<string, Record<string, number>>;
  check('cab slot gained channel-A-nested params', cabParams !== undefined && typeof cabParams['A'] === 'object');
  check(
    'all 3 injectable defaults present (locut 80 / hicut 6500 / roommix 8)',
    cabParams?.['A']?.['locut'] === 80 && cabParams?.['A']?.['hicut'] === 6500 && cabParams?.['A']?.['roommix'] === 8,
    JSON.stringify(cabParams),
  );
  check('slope (order) NOT injected (no verified value table on gen-3)', cabParams?.['A']?.['order'] === undefined);
  check('cabPolish reports channel A', cabPolish !== undefined && cabPolish.channels.join(',') === 'A');
  check('cabPolish note carries the undo phrase', cabPolish !== undefined && /wide open/i.test(cabPolish.note));
  check(
    'report params carry display values',
    cabPolish?.params['locut'] === '80 Hz' && cabPolish?.params['hicut'] === '6500 Hz' && cabPolish?.params['roommix'] === '8%',
    JSON.stringify(cabPolish?.params),
  );
  check('amp slot untouched', JSON.stringify(slots[0].params) === JSON.stringify({ gain: 6 }));
}

// ── Case 2: FM9 flat cab params → defaults appended AFTER the spec params ──
console.log('Case 2: FM9 flat cab params get the defaults appended after them (write order)');
{
  const { slots, cabPolish } = inject(
    [{ slot: { row: 2, col: 4 }, block_type: 'cab', params: { level: 0 } }],
    fm9Cab,
  );
  const keys = Object.keys(slots[0].params as Record<string, number>);
  check('defaults appended', keys.length === 4, keys.join(','));
  check(
    'spec param first, injected after (insertion order = write order)',
    keys[0] === 'level' && keys.slice(1).every((k) => INJECTED.includes(k)),
    keys.join(','),
  );
  check('flat window reported as current channel', cabPolish !== undefined && cabPolish.channels.join(',') === 'current');
}

// ── Case 3: FM9 channel-nested cab params → injected per written channel window ──
console.log('Case 3: FM9 channel-nested params inject inside EACH written channel window');
{
  const { slots, cabPolish } = inject(
    [{
      slot: { row: 2, col: 4 },
      block_type: 'cab',
      params: { A: { level: 0 }, B: { level: -3 } },
    }],
    fm9Cab,
  );
  const nested = slots[0].params as Record<string, Record<string, number>>;
  const aKeys = Object.keys(nested['A']);
  const bKeys = Object.keys(nested['B']);
  check('channel A window: spec first, 3 defaults appended', aKeys.join(',') === 'level,locut,hicut,roommix', aKeys.join(','));
  check('channel B window: spec first, 3 defaults appended', bKeys.join(',') === 'level,locut,hicut,roommix', bKeys.join(','));
  check('cabPolish reports channels A and B', cabPolish !== undefined && cabPolish.channels.join(',') === 'A,B', cabPolish?.channels.join(','));
}

// ── Case 4: explicit cut suppresses ALL injection (canonical + alias spellings) ──
console.log('Case 4: any explicit cab cut/room/slope opinion suppresses injection');
{
  const spec: PresetSlotSpec[] = [
    { slot: { row: 2, col: 4 }, block_type: 'cab', params: { locut: 100 } },
  ];
  const { slots, cabPolish } = inject(spec, fm9Cab);
  check('slots returned untouched', slots === spec);
  check('cabPolish is undefined', cabPolish === undefined);

  // Alias spelling (full firmware symbol) counts as an opinion too.
  const aliasSpec: PresetSlotSpec[] = [
    { slot: { row: 2, col: 4 }, block_type: 'cab', params: { cabinet_locut: 100 } },
  ];
  const aliasResult = inject(aliasSpec, fm9Cab);
  check('alias spelling (cabinet_locut) suppresses too', aliasResult.cabPolish === undefined && aliasResult.slots === aliasSpec);

  // Slope opinion (order) suppresses even though we never inject it.
  const slopeSpec: PresetSlotSpec[] = [
    { slot: { row: 2, col: 4 }, block_type: 'cab', params: { order: 1 } },
  ];
  const slopeResult = inject(slopeSpec, fm9Cab);
  check('slope opinion (order) suppresses', slopeResult.cabPolish === undefined);

  // Nested-channel opinion suppresses the whole build.
  const nestedSpec: PresetSlotSpec[] = [
    { slot: { row: 2, col: 4 }, block_type: 'cab', params: { B: { hicut: 8000 } } },
  ];
  const nestedResult = inject(nestedSpec, fm9Cab);
  check('nested-channel opinion suppresses', nestedResult.cabPolish === undefined);
}

// ── Case 5: bypassed cab suppresses (4CM / real-cab case) ──
console.log('Case 5: cab bypassed:true suppresses injection');
{
  const spec: PresetSlotSpec[] = [
    { slot: { row: 2, col: 4 }, block_type: 'cab', bypassed: true },
  ];
  const { slots, cabPolish } = inject(spec, fm9Cab);
  check('slots returned untouched', slots === spec);
  check('cabPolish is undefined', cabPolish === undefined);
}

// ── Case 6: no cab block → nothing injected, non-cab slots untouched ──
console.log('Case 6: no cab block placed injects NOTHING (never auto-place)');
{
  const spec: PresetSlotSpec[] = [
    { slot: { row: 2, col: 3 }, block_type: 'amp', params: { gain: 6 } },
    { slot: { row: 2, col: 5 }, block_type: 'reverb', params: { mix: 30 } },
  ];
  const { slots, cabPolish } = inject(spec, fm9Cab);
  check('slots returned untouched', slots === spec);
  check('cabPolish is undefined', cabPolish === undefined);
}

// ── Case 7: III and FM3 are evidence-gated OFF (uncalibrated cab cuts) ──
console.log('Case 7: III + FM3 inject NOTHING (cab cuts registered but uncalibrated)');
{
  const spec: PresetSlotSpec[] = [
    { slot: { row: 2, col: 4 }, block_type: 'cab' },
  ];
  const iii = inject(spec, iiiCab);
  check('Axe-Fx III: no injection, slots untouched', iii.cabPolish === undefined && iii.slots === spec);
  const fm3 = inject(spec, fm3Cab);
  check('FM3: no injection, slots untouched', fm3.cabPolish === undefined && fm3.slots === spec);
  // Sanity-pin the gate premise so a future calibration drop flips this
  // case loudly instead of silently: III/FM3 locut has no display range,
  // FM9 locut does (device-true 20..2000 from its own editor cache).
  check('gate premise: III cab locut has no calibrated display range', iiiCab?.params['locut']?.display_min === undefined);
  check('gate premise: FM3 cab locut has no calibrated display range', fm3Cab?.params['locut']?.display_min === undefined);
  check(
    'gate premise: FM9 cab locut is display-calibrated 20..2000 Hz',
    fm9Cab?.params['locut']?.display_min === 20 && fm9Cab?.params['locut']?.display_max === 2000,
  );
}

// ── Case 8: input spec is never mutated (pure pre-pass) ──
console.log('Case 8: injection clones; the caller\'s spec objects are not mutated');
{
  const originalParams = { level: 0 };
  const spec: PresetSlotSpec[] = [
    { slot: { row: 2, col: 4 }, block_type: 'cab', params: originalParams },
  ];
  inject(spec, fm9Cab);
  check('original params object unchanged', Object.keys(originalParams).join(',') === 'level');
}

console.log('');
if (failures > 0) {
  console.error(`verify-gen3-cab-polish: ${failures} failure(s)`);
  process.exit(1);
}
console.log('verify-gen3-cab-polish: all checks passed');
