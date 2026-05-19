/**
 * BK-065 + BK-066 Phase 1 goldens.
 *
 * Two helpers, two test groups:
 *
 *   1. `resolveParamAlias(port, blockType, paramName)` from
 *      `packages/core/src/protocol-generic/cross-device-aliases.ts`.
 *      Asserts that the alias table maps cross-device foreign words
 *      to each device's canonical name, that canonical names pass
 *      through unchanged, and that unknown names pass through.
 *
 *   2. `findEnumMatch(input, validValues)` from
 *      `packages/core/src/protocol-generic/cross-device-enums.ts`.
 *      Asserts the four-tier match cascade: `exact`, `case_or_space`,
 *      `fuzzy`, and `none`, plus the top-3 candidates returned for
 *      the disambiguation path.
 *
 * Run:  npx tsx scripts/verify-cross-device-aliases.ts
 *
 * Wired into root `package.json` `test` script so it runs as part
 * of `npm test` / `npm run preflight`. Dispatcher integration of
 * both helpers is deferred until Stream A finishes rebuilding the
 * validation codepath (BK-059 territory).
 */

import {
  resolveParamAlias,
  type ResolvedParamAlias,
} from '@mcp-midi-control/core/protocol-generic/cross-device-aliases.js';
import {
  findEnumMatch,
  type EnumMatchCertainty,
} from '@mcp-midi-control/core/protocol-generic/cross-device-enums.js';

// ── BK-065 alias cases ──────────────────────────────────────────────

interface AliasCase {
  port: string;
  block: string;
  input: string;
  expected: ResolvedParamAlias;
  desc: string;
}

const aliasCases: AliasCase[] = [
  // ── AM4: II-vocabulary inputs resolve to AM4 canonicals ──────────
  {
    port: 'am4',
    block: 'drive',
    input: 'volume',
    expected: { canonical: 'level', aliasUsed: 'volume' },
    desc: 'AM4 drive.volume -> level (II vocabulary)',
  },
  {
    port: 'am4',
    block: 'drive',
    input: 'output',
    expected: { canonical: 'level', aliasUsed: 'output' },
    desc: 'AM4 drive.output -> level',
  },
  {
    port: 'am4',
    block: 'drive',
    input: 'output_level',
    expected: { canonical: 'level', aliasUsed: 'output_level' },
    desc: 'AM4 drive.output_level -> level',
  },
  {
    port: 'am4',
    block: 'drive',
    input: 'gain',
    expected: { canonical: 'drive', aliasUsed: 'gain' },
    desc: 'AM4 drive.gain -> drive (II canonical)',
  },
  {
    port: 'am4',
    block: 'amp',
    input: 'master_volume',
    expected: { canonical: 'master', aliasUsed: 'master_volume' },
    desc: 'AM4 amp.master_volume -> master (II canonical)',
  },
  {
    port: 'am4',
    block: 'wah',
    input: 'effect_type',
    expected: { canonical: 'type', aliasUsed: 'effect_type' },
    desc: 'AM4 wah.effect_type -> type (II canonical)',
  },
  {
    port: 'am4',
    block: 'reverb',
    input: 'effect_type',
    expected: { canonical: 'type', aliasUsed: 'effect_type' },
    desc: 'AM4 reverb.effect_type -> type',
  },

  // ── II: AM4-vocabulary inputs resolve to II canonicals ───────────
  {
    port: 'axe-fx-ii',
    block: 'drive',
    input: 'level',
    expected: { canonical: 'volume', aliasUsed: 'level' },
    desc: 'II drive.level -> volume (AM4 vocabulary)',
  },
  {
    port: 'axe-fx-ii',
    block: 'drive',
    input: 'drive',
    expected: { canonical: 'gain', aliasUsed: 'drive' },
    desc: 'II drive.drive -> gain (AM4 vocabulary)',
  },
  {
    port: 'axe-fx-ii',
    block: 'amp',
    input: 'master',
    expected: { canonical: 'master_volume', aliasUsed: 'master' },
    desc: 'II amp.master -> master_volume (AM4 vocabulary)',
  },
  {
    port: 'axe-fx-ii',
    block: 'wah',
    input: 'type',
    expected: { canonical: 'effect_type', aliasUsed: 'type' },
    desc: 'II wah.type -> effect_type (AM4 vocabulary)',
  },

  // ── III: cross-device aliases ────────────────────────────────────
  {
    port: 'axe-fx-iii',
    block: 'drive',
    input: 'volume',
    expected: { canonical: 'level', aliasUsed: 'volume' },
    desc: 'III drive.volume -> level (II vocabulary)',
  },
  {
    port: 'axe-fx-iii',
    block: 'wah',
    input: 'effect_type',
    expected: { canonical: 'type', aliasUsed: 'effect_type' },
    desc: 'III wah.effect_type -> type (II vocabulary)',
  },

  // ── Canonical names pass through unchanged (no aliasUsed) ────────
  {
    port: 'am4',
    block: 'drive',
    input: 'level',
    expected: { canonical: 'level' },
    desc: 'AM4 drive.level (canonical) passes through',
  },
  {
    port: 'axe-fx-ii',
    block: 'drive',
    input: 'volume',
    expected: { canonical: 'volume' },
    desc: 'II drive.volume (canonical) passes through',
  },
  {
    port: 'axe-fx-ii',
    block: 'amp',
    input: 'master_volume',
    expected: { canonical: 'master_volume' },
    desc: 'II amp.master_volume (canonical) passes through',
  },

  // ── Unknown names pass through unchanged ─────────────────────────
  {
    port: 'am4',
    block: 'drive',
    input: 'mystery_knob',
    expected: { canonical: 'mystery_knob' },
    desc: 'unknown name passes through unchanged',
  },
  {
    port: 'am4',
    block: 'unknown_block',
    input: 'anything',
    expected: { canonical: 'anything' },
    desc: 'unknown block passes through',
  },
  {
    port: 'unregistered_port',
    block: 'drive',
    input: 'volume',
    expected: { canonical: 'volume' },
    desc: 'unknown port passes through',
  },

  // ── Case + whitespace tolerance on input ─────────────────────────
  {
    port: 'AM4',
    block: 'Drive',
    input: 'VOLUME',
    expected: { canonical: 'level', aliasUsed: 'VOLUME' },
    desc: 'case-insensitive port + block + name lookup',
  },
  {
    port: 'am4',
    block: 'drive',
    input: '  volume  ',
    expected: { canonical: 'level', aliasUsed: '  volume  ' },
    desc: 'whitespace-tolerant name lookup',
  },
];

// ── BK-066 enum matcher cases ───────────────────────────────────────

interface EnumCase {
  input: string;
  valid: string[];
  expectedMatch: string | undefined;
  expectedCertainty: EnumMatchCertainty;
  expectedTopCandidate?: string;
  desc: string;
}

// Realistic-ish vocabulary slices drawn from fractal-midi packed
// catalogs (II all-caps, AM4 mixed-case). Each test below picks the
// minimum slice that disambiguates the case.
const AM4_AMPS: string[] = [
  'USA Pre Clean',
  'USA MK IIC+',
  'USA MK IV Rhythm 1',
  'USA Lead',
  'Brit 800',
];

const II_AMPS: string[] = [
  'USA CLEAN',
  'USA PRE CLEAN',
  'USA IIC+',
  'USA IIC+ BRight',
  'BRIT 800',
];

const enumCases: EnumCase[] = [
  // ── Tier 1: exact ─────────────────────────────────────────────────
  {
    input: 'USA Pre Clean',
    valid: AM4_AMPS,
    expectedMatch: 'USA Pre Clean',
    expectedCertainty: 'exact',
    expectedTopCandidate: 'USA Pre Clean',
    desc: 'AM4 USA Pre Clean exact match',
  },
  {
    input: 'BRIT 800',
    valid: II_AMPS,
    expectedMatch: 'BRIT 800',
    expectedCertainty: 'exact',
    desc: 'II BRIT 800 exact match',
  },

  // ── Tier 2: case + whitespace collapse ───────────────────────────
  {
    input: 'usa pre clean',
    valid: AM4_AMPS,
    expectedMatch: 'USA Pre Clean',
    expectedCertainty: 'case_or_space',
    desc: 'AM4 lowercase USA Pre Clean',
  },
  {
    input: '  USA  PRE  CLEAN  ',
    valid: II_AMPS,
    expectedMatch: 'USA PRE CLEAN',
    expectedCertainty: 'case_or_space',
    desc: 'II whitespace-collapsed USA PRE CLEAN',
  },
  {
    input: 'usa iic+',
    valid: II_AMPS,
    expectedMatch: 'USA IIC+',
    expectedCertainty: 'case_or_space',
    desc: 'II lowercase USA IIC+ preserves punctuation',
  },
  {
    input: 'USA MK IIC+',
    valid: AM4_AMPS,
    expectedMatch: 'USA MK IIC+',
    expectedCertainty: 'exact',
    desc: 'AM4 USA MK IIC+ exact (control for tier 2 punctuation)',
  },

  // ── Tier 3: fuzzy distance <= 2 ──────────────────────────────────
  // "Brit 80" -> "Brit 800" is distance 1 (insert '0'). Within tier.
  {
    input: 'Brit 80',
    valid: AM4_AMPS,
    expectedMatch: 'Brit 800',
    expectedCertainty: 'fuzzy',
    expectedTopCandidate: 'Brit 800',
    desc: 'AM4 Brit 80 -> Brit 800 (distance 1)',
  },
  // "USA IIC" -> "USA IIC+" is distance 1 (insert '+'). Tier 3.
  {
    input: 'USA IIC',
    valid: II_AMPS,
    expectedMatch: 'USA IIC+',
    expectedCertainty: 'fuzzy',
    desc: 'II USA IIC -> USA IIC+ (distance 1)',
  },

  // ── Tier 4: none (top-3 candidates returned) ─────────────────────
  // "Vox AC30" not in vocab and too far from anything. Tier 4.
  {
    input: 'Vox AC30',
    valid: AM4_AMPS,
    expectedMatch: undefined,
    expectedCertainty: 'none',
    desc: 'AM4 Vox AC30 -> none (out of distance)',
  },
  // "USA CLEAN" on AM4 vocab: normalized "usa clean" vs "usa lead"
  // is distance 2 (sub + sub + delete; algorithm aligns "_lean" with
  // "lead"), inside the fuzzy tier, so we get a fuzzy match. The
  // closest match is `USA Lead` and the candidates list surfaces
  // `USA Pre Clean` and `USA MK IIC+` as the next-nearest options.
  // BK-066 Phase 2 is the cross-device concept-key table that would
  // promote "USA CLEAN" -> "USA Pre Clean" via a semantic mapping
  // instead of edit distance; until then, the disambiguation hint
  // is exactly what the helper should surface.
  {
    input: 'USA CLEAN',
    valid: AM4_AMPS,
    expectedMatch: 'USA Lead',
    expectedCertainty: 'fuzzy',
    expectedTopCandidate: 'USA Lead',
    desc: 'AM4 USA CLEAN fuzzy -> USA Lead (BK-066 Phase 2 concept map will refine)',
  },
  // True tier-4 case where nothing is within fuzzy range. "Random
  // synth thing" is far from every AM4 amp; the helper should
  // return `match: undefined` with the three closest values as
  // candidates so the caller can render a "did you mean ..." list.
  {
    input: 'Random Synth Thing',
    valid: AM4_AMPS,
    expectedMatch: undefined,
    expectedCertainty: 'none',
    desc: 'AM4 Random Synth Thing -> none with 3 candidates',
  },
];

// ── Run ─────────────────────────────────────────────────────────────

function deepEqualAlias(a: ResolvedParamAlias, b: ResolvedParamAlias): boolean {
  return a.canonical === b.canonical && a.aliasUsed === b.aliasUsed;
}

let passed = 0;
let failed = 0;

console.log('── BK-065 resolveParamAlias goldens ──');
for (const c of aliasCases) {
  const got = resolveParamAlias(c.port, c.block, c.input);
  const ok = deepEqualAlias(got, c.expected);
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${c.desc}`);
  if (!ok) {
    console.log(`    port=${c.port} block=${c.block} input=${JSON.stringify(c.input)}`);
    console.log(`    expected: ${JSON.stringify(c.expected)}`);
    console.log(`    got:      ${JSON.stringify(got)}`);
    failed++;
  } else {
    passed++;
  }
}

console.log('\n── BK-066 findEnumMatch goldens ──');
for (const c of enumCases) {
  const got = findEnumMatch(c.input, c.valid);
  let ok = got.match === c.expectedMatch && got.certainty === c.expectedCertainty;
  if (ok && c.expectedTopCandidate !== undefined) {
    ok = got.candidates[0] === c.expectedTopCandidate;
  }
  // Tier 4 must always return up to 3 candidates so callers can
  // render a "did you mean ..." message; assert that property.
  if (ok && c.expectedCertainty === 'none') {
    ok = got.candidates.length > 0 && got.candidates.length <= 3;
  }
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${c.desc}`);
  if (!ok) {
    console.log(`    input=${JSON.stringify(c.input)}`);
    console.log(`    expected: match=${JSON.stringify(c.expectedMatch)} certainty=${c.expectedCertainty} top=${JSON.stringify(c.expectedTopCandidate)}`);
    console.log(`    got:      ${JSON.stringify(got)}`);
    failed++;
  } else {
    passed++;
  }
}

const total = aliasCases.length + enumCases.length;
console.log(`\n${passed}/${total} cases pass.`);
if (failed > 0) process.exit(1);
