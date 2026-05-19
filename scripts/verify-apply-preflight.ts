/**
 * BK-059: structured pre-flight validation goldens.
 *
 * The dispatcher's `collectApplyPresetErrors` walks an apply_preset
 * spec and returns every shape/vocabulary problem in one pass: bad
 * param names, unknown enum values, malformed slot refs, scene index
 * out-of-range, dangling routing references. These cases assert the
 * walker catches every error WITHOUT opening a MIDI handle (no
 * hardware required).
 *
 * Run via:  npx tsx scripts/verify-apply-preflight.ts
 */

import { collectApplyPresetErrors } from '@mcp-midi-control/core/protocol-generic/dispatcher.js';
import type { PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
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

function hasError(errors: ReturnType<typeof collectApplyPresetErrors>, pathRegex: RegExp): boolean {
  return errors.some((e) => pathRegex.test(e.path));
}

function findError(
  errors: ReturnType<typeof collectApplyPresetErrors>,
  pathRegex: RegExp,
): (typeof errors)[number] | undefined {
  return errors.find((e) => pathRegex.test(e.path));
}

// ─────────────────────────────────────────────────────────────────
// Case 1 (AM4): three intentional errors land as three structured
// validation_errors[] entries. Zero wire ops, all problems surfaced
// at once.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 1: AM4 multi-error spec (bad param, bad enum, bad channel)');

const am4ThreeErrors: PresetSpec = {
  slots: [
    {
      slot: 1,
      block_type: 'amp',
      params: {
        A: {
          // Bad param name. AM4 amp has `master`, not `master_volume`.
          master_volume: 6,
          // Bad enum value. AM4 amp.type doesn't have "USA CLEAN" (the
          // canonical option is "USA Pre Clean" or similar; the exact
          // catalog is in the descriptor's enum_values).
          type: 'USA CLEAN',
        },
        // Bad channel letter. AM4 channels are A/B/C/D, not Z.
        Z: { gain: 5 },
      },
    },
  ],
};

const errs1 = collectApplyPresetErrors(am4ThreeErrors, AM4_DESCRIPTOR);

check(
  'AM4 multi-error spec surfaces >= 3 errors',
  errs1.length >= 3,
  `got ${errs1.length} errors: ${errs1.map((e) => e.path).join(' | ')}`,
);

check(
  'unknown param name flagged at slots[0].params.A.master_volume',
  hasError(errs1, /slots\[0\]\.params\.A\.master_volume/),
  errs1.map((e) => e.path).join(' | '),
);

check(
  'unknown enum value flagged at slots[0].params.A.type',
  hasError(errs1, /slots\[0\]\.params\.A\.type/),
  errs1.map((e) => e.path).join(' | '),
);

check(
  'bad channel letter Z flagged at slots[0].params.Z',
  hasError(errs1, /slots\[0\]\.params\.Z/),
  errs1.map((e) => e.path).join(' | '),
);

const masterVolumeErr = findError(errs1, /master_volume/);
check(
  'master_volume error carries suggestions[]',
  masterVolumeErr !== undefined && (masterVolumeErr.suggestions?.length ?? 0) > 0,
  masterVolumeErr ? JSON.stringify(masterVolumeErr.suggestions ?? []) : 'error not found',
);

const channelZErr = findError(errs1, /params\.Z$/);
check(
  'channel-Z error surfaces the valid channel list as suggestions',
  channelZErr !== undefined && (channelZErr.suggestions ?? []).some((s) => /^[ABCD]$/.test(s)),
  channelZErr ? JSON.stringify(channelZErr.suggestions ?? []) : 'error not found',
);

// ─────────────────────────────────────────────────────────────────
// Case 2 (AM4): clean spec produces zero errors.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 2: AM4 clean spec returns empty errors[]');

const am4Clean: PresetSpec = {
  slots: [{ slot: 1, block_type: 'amp', params: { gain: 5, master: 6 } }],
};

const errs2 = collectApplyPresetErrors(am4Clean, AM4_DESCRIPTOR);
check(
  'AM4 clean spec returns 0 errors',
  errs2.length === 0,
  `got ${errs2.length}: ${errs2.map((e) => `${e.path}: ${e.error}`).join(' | ')}`,
);

// ─────────────────────────────────────────────────────────────────
// Case 3 (AM4): bad slot ref shape (grid syntax on linear device).
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 3: AM4 rejects {row,col} slot ref');

const am4GridShape: PresetSpec = {
  slots: [{ slot: { row: 2, col: 1 } as unknown as number, block_type: 'amp' }],
};
const errs3 = collectApplyPresetErrors(am4GridShape, AM4_DESCRIPTOR);
check(
  'AM4 flags grid-shape slot ref',
  hasError(errs3, /slots\[0\]\.slot/),
  errs3.map((e) => e.path).join(' | '),
);

// ─────────────────────────────────────────────────────────────────
// Case 4 (Axe-Fx II): unknown block_type carries suggestions.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 4: Axe-Fx II unknown block_type w/ suggestions');

const aiiBadBlock: PresetSpec = {
  slots: [{ slot: { row: 2, col: 1 }, block_type: 'reverbo' }],
};
const errs4 = collectApplyPresetErrors(aiiBadBlock, AXEFX2_DESCRIPTOR);
check(
  'Axe-Fx II flags unknown block_type at slots[0].block_type',
  hasError(errs4, /slots\[0\]\.block_type/),
  errs4.map((e) => e.path).join(' | '),
);
const blockErr = findError(errs4, /block_type/);
check(
  'unknown block_type error includes suggestions[]',
  blockErr !== undefined && (blockErr.suggestions?.length ?? 0) > 0,
  blockErr ? JSON.stringify(blockErr.suggestions ?? []) : 'error not found',
);

// ─────────────────────────────────────────────────────────────────
// Case 5 (Axe-Fx II): scene index out of range.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 5: Axe-Fx II out-of-range scene index');

const aiiBadScene: PresetSpec = {
  slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }],
  scenes: [{ scene: 99, channels: { amp: 'X' } }],
};
const errs5 = collectApplyPresetErrors(aiiBadScene, AXEFX2_DESCRIPTOR);
check(
  'Axe-Fx II flags out-of-range scene index',
  hasError(errs5, /scenes\[0\]\.scene/),
  errs5.map((e) => `${e.path}: ${e.error}`).join(' | '),
);

// ─────────────────────────────────────────────────────────────────
// Case 6 (AM4): routing[] on linear device is rejected.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 6: AM4 routing[] rejected on linear device');

const am4Routing: PresetSpec = {
  slots: [
    { slot: 1, block_type: 'amp', id: 'amp_1' },
    { slot: 2, block_type: 'reverb', id: 'reverb_1' },
  ],
  routing: [{ from: 'amp_1', to: 'reverb_1' }],
};
const errs6 = collectApplyPresetErrors(am4Routing, AM4_DESCRIPTOR);
check(
  'AM4 flags routing[] usage as linear-device error',
  hasError(errs6, /^routing$/),
  errs6.map((e) => `${e.path}: ${e.error}`).join(' | '),
);

console.log('');
if (failed > 0) {
  console.error(`✗ ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('✓ apply_preset pre-flight validation verified.');
