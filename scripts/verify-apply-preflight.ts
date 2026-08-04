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
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/descriptor.js';

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

// ─────────────────────────────────────────────────────────────────
// Case 12: II grid device accepts bare-int slot shorthand. The
// presetSlotShape zod schema documents slot=N as shorthand for
// {row:2, col:N}; preflight should silently coerce instead of
// erroring "grid device, pass slot as {row, col}…". An info[] entry
// names the coercion so the agent learns the long form.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 12: Axe-Fx II auto-coerces bare-int slot=N -> {row:2, col:N}');

const iiBareIntSlot: PresetSpec = {
  slots: [{ slot: 3 as unknown as { row: number; col: number }, block_type: 'amp' }],
};
const preflight12 = collectApplyPresetPreflight(iiBareIntSlot, AXEFX2_DESCRIPTOR);
check(
  'bare-int slot on grid device returns 0 errors',
  preflight12.errors.length === 0,
  preflight12.errors.map((e) => `${e.path}: ${e.error}`).join(' | '),
);
check(
  'bare-int slot on grid device surfaces info[] entry advising the coercion',
  preflight12.info.some(
    (i) => i.path === 'slots[0].slot' && /coerced shorthand/i.test(i.info),
  ),
  JSON.stringify(preflight12.info),
);
const coercedSlot12 = preflight12.normalized_spec.slots[0]?.slot;
check(
  'normalized spec carries {row: 2, col: 3}',
  typeof coercedSlot12 === 'object'
    && coercedSlot12 !== null
    && (coercedSlot12 as { row: number; col: number }).row === 2
    && (coercedSlot12 as { row: number; col: number }).col === 3,
  JSON.stringify(coercedSlot12),
);

// ─────────────────────────────────────────────────────────────────
// Case 13: II unknown param uses the AM4-style canonical format.
// Format must:
//   - cite the slot context (row/col + block_type)
//   - cite "block_type" not "GROUP CODE"
//   - list known params for the block
//   - surface a top-3 "Did you mean…?" line for close candidates
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 13: Axe-Fx II unknown param uses AM4-style canonical format');

const iiUnknownParam: PresetSpec = {
  slots: [
    {
      slot: { row: 2, col: 1 },
      block_type: 'drive',
      // `wibblewam` is not an II drive param and is not in any
      // cross-device alias table; should hit the unknown-param path.
      params: { X: { wibblewam: 5 } },
    },
  ],
};
const preflight13 = collectApplyPresetPreflight(iiUnknownParam, AXEFX2_DESCRIPTOR);
const drive13Err = preflight13.errors.find((e) => /wibblewam/i.test(e.path));
check(
  'II unknown param produces an error',
  drive13Err !== undefined,
  preflight13.errors.map((e) => `${e.path}: ${e.error}`).join(' | '),
);
check(
  'II error names slot context "(row 2 col 1, drive)"',
  drive13Err !== undefined && /row 2 col 1, drive/i.test(drive13Err.error),
  drive13Err?.error,
);
check(
  'II error contains "unknown param" + the bad name',
  drive13Err !== undefined
    && /unknown param "wibblewam"/.test(drive13Err.error),
  drive13Err?.error,
);
check(
  'II error lists "Known params for drive: ..."',
  drive13Err !== undefined && /Known params for drive:/i.test(drive13Err.error),
  drive13Err?.error,
);
// A "Did you mean" suffix only appears when at least one candidate
// sits within Levenshtein distance 3 of the bad input. "wibblewam"
// is far from every II drive param name, so the suffix may be absent
// here — accept either presence or absence on this case.
check(
  'II error message is structured (slot + block + unknown param + known list)',
  drive13Err !== undefined,
  drive13Err?.error,
);

// ─────────────────────────────────────────────────────────────────
// Case 14: AM4 unknown enum value surfaces "Did you mean…?" line.
// Format must:
//   - cite the slot context (position + block_type)
//   - cite "<block>.<param>: unknown enum value …"
//   - list candidates ordered by closeness
//   - surface a top-3 "Did you mean…?" line for close candidates
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 14: AM4 unknown enum value uses AM4-style canonical format with "Did you mean"');

const am4EnumTypo: PresetSpec = {
  // Use a small typo of an exact catalog entry so the unknown-enum
  // formatter's "Did you mean…?" suffix fires (top-3 within
  // Levenshtein distance ≤ 3). "Plxi 2204" misses "Plexi 2204" by a
  // single insertion (distance 1) — solidly within the suffix
  // threshold. The four-tier matcher classifies this as `fuzzy` (≤2),
  // routes through the suggested_substitution branch, AND the
  // formatter also appends a "Did you mean" line.
  slots: [{ slot: 1, block_type: 'amp', params: { A: { type: 'Plxi 2204' } } }],
};
const preflight14 = collectApplyPresetPreflight(am4EnumTypo, AM4_DESCRIPTOR);
const enum14Err = preflight14.errors.find((e) => /amp\.type/i.test(e.path) || /amp\.type/i.test(e.error));
check(
  'AM4 unknown enum produces an error',
  enum14Err !== undefined,
  preflight14.errors.map((e) => `${e.path}: ${e.error}`).join(' | '),
);
check(
  'AM4 enum error cites slot context "(position 1, amp)"',
  enum14Err !== undefined && /position 1, amp/i.test(enum14Err.error),
  enum14Err?.error,
);
check(
  'AM4 enum error says "amp.type: unknown enum value"',
  enum14Err !== undefined
    && /amp\.type: unknown enum value/i.test(enum14Err.error),
  enum14Err?.error,
);
check(
  'AM4 enum error lists Candidates: ...',
  enum14Err !== undefined && /Candidates:/i.test(enum14Err.error),
  enum14Err?.error,
);
check(
  'AM4 enum error surfaces a closest-match hint ("Did you mean…" or "Closest match…")',
  enum14Err !== undefined && /(Did you mean:|Closest match is)/i.test(enum14Err.error),
  enum14Err?.error,
);

// ─────────────────────────────────────────────────────────────────
// Case 14b: a candidate list must stay PARSEABLE when the enum labels
// themselves contain commas.
//
// 69 of the AM4's 79 reverb type names contain a comma ("Room, Small",
// "Plate, Medium"). Comma-joined, "Room, Small, Room, Medium" reads as four
// values instead of two, and the agent has to reproduce one of these strings
// byte-exactly for its retry to resolve. This is a RECOVERY message: it is
// the only thing the agent has left to work from.
//
// The assertion is recoverability, not string shape: split the rendered
// candidate list on its separator and require every token to be a real
// roster member. Under ", " that fails immediately, because "Room" and
// "Small" are not reverb types.
//
// This bug was fixed once in `renderTypeNames` (the BROWSING list) and
// missed here (the RECOVERY list). Hence a standing check, at both sites
// where a roster is rendered.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 14b: comma-bearing enum labels stay parseable in the candidate list');

const AM4_REVERB_TYPES: readonly string[] = (() => {
  const p = AM4_DESCRIPTOR.blocks['reverb']?.params?.['type'];
  return p?.enum_values !== undefined ? Object.values(p.enum_values) : [];
})();
check(
  'AM4 reverb.type roster is comma-bearing (the precondition this case exists for)',
  AM4_REVERB_TYPES.filter((v) => v.includes(',')).length > 10,
  `${AM4_REVERB_TYPES.filter((v) => v.includes(',')).length} of ${AM4_REVERB_TYPES.length} contain a comma`,
);

const am4ReverbTypo: PresetSpec = {
  slots: [{ slot: 1, block_type: 'reverb', params: { A: { type: 'Hall, Enormous' } } }],
};
const preflight14b = collectApplyPresetPreflight(am4ReverbTypo, AM4_DESCRIPTOR);
const enum14bErr = preflight14b.errors.find((e) => /reverb\.type/i.test(e.error));
check(
  'AM4 unknown reverb type produces an error',
  enum14bErr !== undefined,
  preflight14b.errors.map((e) => `${e.path}: ${e.error}`).join(' | '),
);

/**
 * Pull the rendered roster out of a "Candidates: …" segment and return the
 * tokens the agent would parse. Stops at the "… (N options total)" tail and
 * at the sentence-ending period.
 */
function candidateTokens(message: string): string[] {
  const m = /Candidates: (.*?)(?: \.\.\. \(\d+ options total\))?\.(?: |$)/.exec(message);
  if (m === null) return [];
  return m[1].split(' | ').map((s) => s.trim()).filter((s) => s.length > 0);
}

const tokens14b = enum14bErr !== undefined ? candidateTokens(enum14bErr.error) : [];
const roster14b = new Set(AM4_REVERB_TYPES);
const orphans14b = tokens14b.filter((t) => !roster14b.has(t));
check(
  'every rendered candidate is a real reverb type (separator did not shred the labels)',
  tokens14b.length > 0 && orphans14b.length === 0,
  `parsed ${tokens14b.length} token(s); ${orphans14b.length} not in the roster: ${orphans14b.slice(0, 6).join(' / ')}`,
);

// The prose "Did you mean" and the structured suggestions[] answer the same
// question and must not rank it differently. Before this was wired, the prose
// came from errorFormat's Levenshtein ranking and suggestions[] came from the
// enum-resolution cascade, so one message could point two ways.
const didYouMean14b = enum14bErr !== undefined
  ? /Did you mean: (.*?)\?(?: |$)/.exec(enum14bErr.error)
  : null;
if (didYouMean14b !== null && enum14bErr !== undefined) {
  const prose = didYouMean14b[1].split(' | ').map((s) => s.trim());
  const structured = (enum14bErr.suggestions ?? []).slice(0, prose.length);
  check(
    'prose "Did you mean" mirrors the structured suggestions[] (same array, same order)',
    prose.length > 0 && prose.every((v, i) => v === structured[i]),
    `prose=${JSON.stringify(prose)} suggestions=${JSON.stringify(enum14bErr.suggestions)}`,
  );
  check(
    'every "Did you mean" value is a real reverb type',
    prose.every((v) => roster14b.has(v)),
    JSON.stringify(prose),
  );
}

// ─────────────────────────────────────────────────────────────────
// Case 13b: II close-typo unknown param surfaces "Did you mean".
// "voluem" → typo of "volume" (distance 2) on II drive should
// produce both the canonical "Known params: …" line AND a top-3
// "Did you mean: volume?" suffix via the shared formatter.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 13b: Axe-Fx II close-typo unknown param surfaces "Did you mean"');

const iiCloseTypo: PresetSpec = {
  slots: [
    {
      slot: { row: 2, col: 1 },
      block_type: 'drive',
      params: { X: { voluem: 5 } },
    },
  ],
};
const preflight13b = collectApplyPresetPreflight(iiCloseTypo, AXEFX2_DESCRIPTOR);
const drive13bErr = preflight13b.errors.find((e) => /voluem/i.test(e.path));
check(
  'II close-typo unknown param produces an error',
  drive13bErr !== undefined,
  preflight13b.errors.map((e) => `${e.path}: ${e.error}`).join(' | '),
);
check(
  'II close-typo error surfaces "Did you mean: ..." with a candidate',
  drive13bErr !== undefined && /Did you mean:.*volume/i.test(drive13bErr.error),
  drive13bErr?.error,
);
check(
  'II close-typo error carries suggestions[] for the agent to retry',
  drive13bErr !== undefined && (drive13bErr.suggestions?.length ?? 0) > 0,
  drive13bErr ? JSON.stringify(drive13bErr.suggestions) : 'no error',
);

// ─────────────────────────────────────────────────────────────────
// Case 15: III unknown param matches the AM4-style format. III uses
// the same shared formatter through resolveParamOrThrow / the
// dispatcher preflight walker.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 15: Axe-Fx III unknown param uses AM4-style canonical format');

const iiiUnknownParam: PresetSpec = {
  slots: [
    {
      slot: { row: 2, col: 1 },
      block_type: 'drive',
      // `wibblewam` is not a III drive param and not in any cross-
      // device alias table; should hit the unknown-param path.
      params: { wibblewam: 5 },
    },
  ],
};
const preflight15 = collectApplyPresetPreflight(iiiUnknownParam, AXEFX3_DESCRIPTOR);
const iii15Err = preflight15.errors.find((e) => /wibblewam/i.test(e.path));
check(
  'III unknown param produces an error',
  iii15Err !== undefined,
  preflight15.errors.map((e) => `${e.path}: ${e.error}`).join(' | '),
);
check(
  'III error names slot context "(row 2 col 1, drive)"',
  iii15Err !== undefined && /row 2 col 1, drive/i.test(iii15Err.error),
  iii15Err?.error,
);
check(
  'III error contains "unknown param" + the bad name',
  iii15Err !== undefined
    && /unknown param "wibblewam"/.test(iii15Err.error),
  iii15Err?.error,
);
check(
  'III error lists "Known params for drive: ..."',
  iii15Err !== undefined && /Known params for drive:/i.test(iii15Err.error),
  iii15Err?.error,
);

// ─────────────────────────────────────────────────────────────────
// Tempo-lock co-write advisory. A slot that sets BOTH a non-NONE tempo
// division AND the absolute time it locks gets a non-blocking
// validation_info warning (the absolute write is silently ignored on
// AM4 / II). The write is never refused — it lands in `info`, not
// `errors`. Setting the division alone, or the time with tempo=NONE,
// produces no warning.
// ─────────────────────────────────────────────────────────────────
console.log('\nCase 16: AM4 tempo-lock co-write (delay.tempo + delay.time in one slot)');

const am4TempoCowrite: PresetSpec = {
  slots: [
    {
      slot: 1,
      block_type: 'delay',
      params: { type: 'Digital Stereo', tempo: '1/8 DOT', time: 375, feedback: 25 },
    },
  ],
};
const preflight16 = collectApplyPresetPreflight(am4TempoCowrite, AM4_DESCRIPTOR);
check(
  'co-write produces no validation_errors (write still proceeds)',
  preflight16.errors.length === 0,
  preflight16.errors.map((e) => `${e.path}: ${e.error}`).join(' | '),
);
const tempoWarn16 = preflight16.info.find(
  (i) => i.level === 'warning' && i.dropped_param === "time",
);
check(
  'co-write surfaces a level="warning" validation_info on delay.time',
  tempoWarn16 !== undefined,
  JSON.stringify(preflight16.info),
);
check(
  'warning explains the stored-but-inaudible lock + retry (set tempo to NONE)',
  tempoWarn16 !== undefined
    && /stored/i.test(tempoWarn16.info)
    && /inaudible|tempo-derived/i.test(tempoWarn16.info)
    && /none/i.test(tempoWarn16.retry_action ?? ''),
  JSON.stringify(tempoWarn16),
);

console.log('\nCase 17: AM4 tempo division alone → no tempo-lock warning');
const am4TempoOnly: PresetSpec = {
  slots: [
    { slot: 1, block_type: 'delay', params: { type: 'Digital Stereo', tempo: '1/8 DOT', feedback: 25 } },
  ],
};
const preflight17 = collectApplyPresetPreflight(am4TempoOnly, AM4_DESCRIPTOR);
check(
  'tempo-synced-only slot produces no tempo-lock warning',
  !preflight17.info.some((i) => i.level === 'warning' && i.dropped_param === "time"),
  JSON.stringify(preflight17.info),
);

console.log('\nCase 18: AM4 absolute time with tempo=NONE → no tempo-lock warning');
const am4TimeNone: PresetSpec = {
  slots: [
    { slot: 1, block_type: 'delay', params: { type: 'Digital Stereo', tempo: 'NONE', time: 375, feedback: 25 } },
  ],
};
const preflight18 = collectApplyPresetPreflight(am4TimeNone, AM4_DESCRIPTOR);
check(
  'tempo=NONE + absolute time produces no tempo-lock warning',
  !preflight18.info.some((i) => i.level === 'warning' && i.dropped_param === "time"),
  JSON.stringify(preflight18.info),
);

console.log('\nCase 19: Axe-Fx II tempo-lock co-write parity');
const iiTempoCowrite: PresetSpec = {
  slots: [
    {
      slot: { row: 2, col: 1 },
      block_type: 'delay',
      params: { effect_type: 'DIGITAL STEREO', tempo: '1/8 DOT', time: 375, feedback: 25 },
    },
  ],
};
const preflight19 = collectApplyPresetPreflight(iiTempoCowrite, AXEFX2_DESCRIPTOR);
check(
  'II co-write surfaces a level="warning" validation_info on delay.time',
  preflight19.errors.length === 0
    && preflight19.info.some((i) => i.level === 'warning' && i.dropped_param === "time"),
  JSON.stringify({ errors: preflight19.errors, info: preflight19.info }),
);

console.log('');
if (failed > 0) {
  console.error(`✗ ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('✓ apply_preset pre-flight validation verified.');
