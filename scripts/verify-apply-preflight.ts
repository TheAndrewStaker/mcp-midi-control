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

import {
  collectApplyPresetErrors,
  collectApplyPresetPreflight,
} from '@mcp-midi-control/core/protocol-generic/dispatcher.js';
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
//
// BK-065 wiring note: AM4's `master_volume` is a known cross-device
// alias for `master`, so a foreign-vocabulary name like that is now
// auto-resolved instead of rejected. To exercise the unknown-param
// path here we use `mastr`, a typo no alias table will rescue but
// that still lands close enough to canonical `master` for the
// suggestions[] field to fire.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 1: AM4 multi-error spec (bad param, bad enum, bad channel)');

const am4ThreeErrors: PresetSpec = {
  slots: [
    {
      slot: 1,
      block_type: 'amp',
      params: {
        A: {
          // Bad param name. Not a real AM4 amp param and not in any
          // cross-device alias table.
          mastr: 6,
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
  'unknown param name flagged at slots[0].params.A.mastr',
  hasError(errs1, /slots\[0\]\.params\.A\.mastr/),
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

const mastrErr = findError(errs1, /mastr/);
check(
  'mastr error carries suggestions[]',
  mastrErr !== undefined && (mastrErr.suggestions?.length ?? 0) > 0,
  mastrErr ? JSON.stringify(mastrErr.suggestions ?? []) : 'error not found',
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

// ─────────────────────────────────────────────────────────────────
// Case 7 (BK-065 alias): AM4 drive.volume -> drive.level. Preflight
// should auto-resolve the alias silently, return zero errors, and
// surface an info[] entry. The normalized spec should carry the
// canonical name so the writer never sees `volume`.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 7: AM4 drive.volume auto-resolves to drive.level (BK-065 alias)');

const am4DriveVolumeAlias: PresetSpec = {
  slots: [
    { slot: 1, block_type: 'drive', params: { volume: 6 } },
  ],
};

const preflight7 = collectApplyPresetPreflight(am4DriveVolumeAlias, AM4_DESCRIPTOR);
check(
  'AM4 drive.volume preflight returns 0 errors',
  preflight7.errors.length === 0,
  preflight7.errors.map((e) => `${e.path}: ${e.error}`).join(' | '),
);
check(
  'AM4 drive.volume surfaces info[] entry with alias_used',
  preflight7.info.some((i) => i.alias_used === 'volume' && i.canonical === 'level'),
  JSON.stringify(preflight7.info),
);
const normalizedSlot7 = preflight7.normalized_spec.slots[0];
const normalizedParams7 = normalizedSlot7.params as Record<string, unknown> | undefined;
check(
  'normalized spec carries canonical drive.level, not drive.volume',
  normalizedParams7 !== undefined && normalizedParams7['level'] === 6 && normalizedParams7['volume'] === undefined,
  JSON.stringify(normalizedParams7),
);

// ─────────────────────────────────────────────────────────────────
// Case 8 (BK-066 case-tolerance): AM4 amp.type "usa pre clean" matches
// the canonical "USA Pre Clean" via case/whitespace tolerance. Should
// produce zero errors, one info[] entry, and a normalized spec with
// the canonical casing.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 8: AM4 amp.type "usa pre clean" auto-resolves to "USA Pre Clean" (BK-066 case-tolerance)');

const am4AmpTypeCase: PresetSpec = {
  slots: [
    { slot: 1, block_type: 'amp', params: { A: { type: 'usa pre clean' } } },
  ],
};

const preflight8 = collectApplyPresetPreflight(am4AmpTypeCase, AM4_DESCRIPTOR);
check(
  'AM4 amp.type case-tolerant match returns 0 errors',
  preflight8.errors.length === 0,
  preflight8.errors.map((e) => `${e.path}: ${e.error}`).join(' | '),
);
check(
  'AM4 amp.type case-tolerant match surfaces info[] entry',
  preflight8.info.some((i) => i.original_value === 'usa pre clean' && i.canonical === 'USA Pre Clean'),
  JSON.stringify(preflight8.info),
);
const slot8 = preflight8.normalized_spec.slots[0];
const params8 = slot8.params as Record<string, Record<string, unknown>> | undefined;
check(
  'normalized spec carries canonical "USA Pre Clean" casing',
  params8 !== undefined && params8['A']?.['type'] === 'USA Pre Clean',
  JSON.stringify(params8),
);

// ─────────────────────────────────────────────────────────────────
// Case 9 (BK-066 fuzzy-rejection): AM4 amp.type "USA Pre Klean" is a
// fuzzy match (Levenshtein distance 1 from the canonical "USA Pre
// Clean": substitute 'K' for 'C'). The dispatcher rejects rather than
// auto-substitute to avoid silently changing intent, and supplies the
// top match as `suggested_substitution` so the agent can retry
// verbatim if it agrees with the inference.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 9: AM4 amp.type "USA Pre Klean" rejected with suggested_substitution (BK-066 fuzzy)');

const am4AmpTypeFuzzy: PresetSpec = {
  slots: [
    { slot: 1, block_type: 'amp', params: { A: { type: 'USA Pre Klean' } } },
  ],
};

const preflight9 = collectApplyPresetPreflight(am4AmpTypeFuzzy, AM4_DESCRIPTOR);
check(
  'AM4 amp.type fuzzy mismatch produces a validation error',
  preflight9.errors.length > 0,
  `errors: ${preflight9.errors.length}`,
);
const fuzzyErr = preflight9.errors.find((e) => /amp\.type/i.test(e.path) || /amp\.type/i.test(e.error));
check(
  'fuzzy error carries suggested_substitution',
  fuzzyErr !== undefined && typeof fuzzyErr.suggested_substitution === 'string' && fuzzyErr.suggested_substitution.length > 0,
  fuzzyErr ? JSON.stringify({ path: fuzzyErr.path, error: fuzzyErr.error, suggested_substitution: fuzzyErr.suggested_substitution }) : 'error not found',
);
check(
  'fuzzy error carries suggestions[] candidate list',
  fuzzyErr !== undefined && (fuzzyErr.suggestions?.length ?? 0) > 0,
  fuzzyErr ? JSON.stringify(fuzzyErr.suggestions) : 'error not found',
);

// ─────────────────────────────────────────────────────────────────
// Case 10 (BK-065 alias on Axe-Fx II): II drive.level -> drive.volume.
// Mirror direction of case 7, ensuring the alias resolver works on
// the II port too.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 10: Axe-Fx II drive.level auto-resolves to drive.volume (BK-065 alias, II direction)');

const iiDriveLevelAlias: PresetSpec = {
  slots: [
    { slot: { row: 2, col: 1 }, block_type: 'drive', params: { X: { level: 6 } } },
  ],
};

const preflight10 = collectApplyPresetPreflight(iiDriveLevelAlias, AXEFX2_DESCRIPTOR);
check(
  'II drive.level alias preflight returns 0 errors',
  preflight10.errors.length === 0,
  preflight10.errors.map((e) => `${e.path}: ${e.error}`).join(' | '),
);
check(
  'II drive.level surfaces info[] entry with alias_used',
  preflight10.info.some((i) => i.alias_used === 'level' && i.canonical === 'volume'),
  JSON.stringify(preflight10.info),
);
const slot10 = preflight10.normalized_spec.slots[0];
const params10 = slot10.params as Record<string, Record<string, unknown>> | undefined;
check(
  'II normalized spec carries canonical drive.volume, not drive.level',
  params10 !== undefined && params10['X']?.['volume'] === 6 && params10['X']?.['level'] === undefined,
  JSON.stringify(params10),
);

// ─────────────────────────────────────────────────────────────────
// Case 11 (back-compat): legacy `collectApplyPresetErrors` shim still
// returns just the errors array. Existing goldens rely on this shape.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 11: collectApplyPresetErrors back-compat shape');

const errs11 = collectApplyPresetErrors(am4DriveVolumeAlias, AM4_DESCRIPTOR);
check(
  'legacy shim returns an array, not an envelope',
  Array.isArray(errs11),
  `typeof: ${typeof errs11}`,
);
check(
  'legacy shim returns 0 errors for the alias-only spec',
  errs11.length === 0,
  errs11.map((e) => `${e.path}: ${e.error}`).join(' | '),
);

console.log('');
if (failed > 0) {
  console.error(`✗ ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('✓ apply_preset pre-flight validation verified.');
