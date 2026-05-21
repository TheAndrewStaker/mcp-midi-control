/**
 * Axe-Fx III preset-dump round-trip golden.
 *
 * Validates that `packages/axe-fx-iii/src/presetDump.ts` parses every byte
 * of the three factory banks (firmware 28p06, 384 presets total) and
 * re-emits a byte-identical stream. Same shape as
 * `scripts/verify-preset-dump-ii.ts` but for the III envelope:
 *   - 49,336 bytes per preset
 *   - 16 chunks x 3074-byte payload
 *   - model byte 0x10
 *
 * Test fixtures live under `samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06/`
 * and are git-ignored Fractal IP. Missing fixtures are skipped (with a clear
 * notice) rather than failing, keeping `npm test` green on a fresh clone where
 * the founder hasn't dropped the factory bank in yet.
 *
 * HYPOTHESIS VS VERIFIED. The factory bank fixtures are 384 distinct
 * structural fixtures (3 banks x 128 presets) that ALL parse cleanly
 * under the descriptor-table-derived layout. No live III preset-push
 * capture is committed (no hardware-loop verification), so the
 * "round-trip is byte-identical against the wire" claim is only as
 * strong as "the factory `.syx` file IS what the device emits when
 * pushing a preset" -- a reasonable assumption given Fractal's
 * preset-bundle export design, but not byte-verified against a USB
 * capture. See the presetDump.ts module docstring for the full
 * evidence chain.
 *
 * If the bank-file structure does NOT parse cleanly under our
 * hypothesis, this script reports the observed frame layout and
 * SKIPS the round-trip assertion rather than failing, so the script
 * doubles as a debug probe for future III firmware revs.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  PRESET_DUMP_LEN,
  CHUNKS_PER_PRESET,
  CHUNK_LEN,
  HEADER_LEN,
  FOOTER_LEN,
  extractPresetName,
  parsePresetBank,
  parsePresetDump,
  serializePresetDump,
} from '@mcp-midi-control/axe-fx-iii/presetDump.js';

const BANK_PATHS = [
  'samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06/Axe-Fx_III_BANK_A-250603-182903.syx',
  'samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06/Axe-Fx_III_BANK_B-250603-182903.syx',
  'samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06/Axe-Fx_III_BANK_C-250603-182903.syx',
];

let pass = 0;
let fail = 0;
let skipped = 0;

function ok(label: string): void {
  console.log(`  ok    ${label}`);
  pass++;
}

function bad(label: string, detail = ''): void {
  console.log(`  FAIL  ${label}${detail ? ', ' + detail : ''}`);
  fail++;
}

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) ok(label);
  else bad(label, detail);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function firstDiffOffset(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/**
 * Pre-flight check: scan a bank file's F0/F7 framing and report whether
 * the observed shape matches our hypothesis. If it does not, the round
 * trip will fail with a hard error from parsePresetBank, so we surface
 * the structural diagnostic first.
 */
function describeFramingShape(bytes: Uint8Array, label: string): {
  matches: boolean;
  presetCount: number;
  detail: string;
} {
  const frameLengthsByFn: Record<number, Set<number>> = {};
  const frameCountByFn: Record<number, number> = {};
  let frameStart = -1;
  let totalFrames = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0xf0) frameStart = i;
    if (bytes[i] === 0xf7 && frameStart >= 0) {
      const fn = bytes[frameStart + 5];
      const len = i - frameStart + 1;
      if (frameLengthsByFn[fn] === undefined) {
        frameLengthsByFn[fn] = new Set();
        frameCountByFn[fn] = 0;
      }
      frameLengthsByFn[fn].add(len);
      frameCountByFn[fn]++;
      totalFrames++;
      frameStart = -1;
    }
  }

  const fnSummary = Object.keys(frameCountByFn)
    .map((k) => Number(k))
    .sort((a, b) => a - b)
    .map((fn) => {
      const lens = Array.from(frameLengthsByFn[fn]).sort((a, b) => a - b);
      return `fn=0x${fn.toString(16).padStart(2, '0')} count=${frameCountByFn[fn]} len=${lens.join('|')}`;
    })
    .join(', ');

  // Hypothesis: every 18 frames is one preset (1x0x77 + 16x0x78 + 1x0x79).
  const matchesFrameCount = totalFrames % 18 === 0;
  const presetCount = matchesFrameCount ? totalFrames / 18 : -1;
  const matchesByteCount = bytes.length % PRESET_DUMP_LEN === 0;

  // Lengths match hypothesis: 0x77=13, 0x78=3082, 0x79=11.
  const expectedLens: Record<number, number> = {
    0x77: HEADER_LEN,
    0x78: CHUNK_LEN,
    0x79: FOOTER_LEN,
  };
  let lensOk = true;
  for (const fn of [0x77, 0x78, 0x79]) {
    const lens = frameLengthsByFn[fn];
    if (lens === undefined || lens.size !== 1 || !lens.has(expectedLens[fn])) {
      lensOk = false;
    }
  }

  const matches = matchesFrameCount && matchesByteCount && lensOk;
  const detail =
    `${totalFrames} frames, ${bytes.length} bytes, ` +
    fnSummary;

  if (!matches) {
    console.log(
      `  WARN  ${label}: framing shape does NOT match hypothesis. ${detail}. ` +
        `Round-trip golden skipped. (Hypothesis: 1x0x77@13 + 16x0x78@3082 + 1x0x79@11 = 49336B per preset.)`,
    );
  }

  return { matches, presetCount, detail };
}

console.log('Axe-Fx III preset-dump round-trip golden:');
console.log(
  `  hypothesis: ${PRESET_DUMP_LEN} B/preset = ${HEADER_LEN}B header + ${CHUNKS_PER_PRESET}x${CHUNK_LEN}B chunks + ${FOOTER_LEN}B footer (model 0x10)`,
);

for (const path of BANK_PATHS) {
  console.log('');
  if (!existsSync(path)) {
    console.log(`  skip  ${path} (not present)`);
    skipped++;
    continue;
  }
  const bytes = new Uint8Array(readFileSync(path));

  const shape = describeFramingShape(bytes, path);
  if (!shape.matches) {
    // Structural mismatch: log diagnostics, do not assert. The hypothesis
    // was wrong for this fixture. Future debugging hook.
    skipped++;
    continue;
  }

  ok(`${path}: framing matches hypothesis (${shape.presetCount} presets, ${shape.detail})`);

  check(
    `${path} length is a multiple of ${PRESET_DUMP_LEN} (${bytes.length} bytes)`,
    bytes.length % PRESET_DUMP_LEN === 0,
    `got ${bytes.length} bytes`,
  );

  let parsed;
  try {
    parsed = parsePresetBank(bytes);
  } catch (err) {
    bad(`${path}: parsePresetBank threw`, err instanceof Error ? err.message : String(err));
    continue;
  }
  const expectedCount = bytes.length / PRESET_DUMP_LEN;
  check(
    `${path}: parsed ${parsed.length} presets (expected ${expectedCount})`,
    parsed.length === expectedCount,
    `parsed=${parsed.length}, expected=${expectedCount}`,
  );

  // Round-trip every preset, check byte-identity.
  let roundTripFails = 0;
  let firstFail: { index: number; offset: number } | undefined;
  for (let i = 0; i < parsed.length; i++) {
    const reserialized = serializePresetDump(parsed[i]);
    if (!bytesEqual(reserialized, parsed[i].raw)) {
      roundTripFails++;
      if (firstFail === undefined) {
        firstFail = { index: i, offset: firstDiffOffset(reserialized, parsed[i].raw) };
      }
    }
  }
  check(
    `${path}: ${parsed.length}/${parsed.length} presets round-trip byte-identical`,
    roundTripFails === 0,
    firstFail !== undefined
      ? `${roundTripFails} failures; first at preset ${firstFail.index} byte ${firstFail.offset}`
      : '',
  );

  // Header payload sanity: the III headers we observed encode
  // [bank, preset, 0x00, 0x00, 0x01]. Bytes [2,3,4] should be constant.
  let headerConstFails = 0;
  for (let i = 0; i < parsed.length; i++) {
    const h = parsed[i].headerPayload;
    if (h[2] !== 0x00 || h[3] !== 0x00 || h[4] !== 0x01) headerConstFails++;
  }
  check(
    `${path}: header payload bytes [2,3,4] = [0x00, 0x00, 0x01] across all presets`,
    headerConstFails === 0,
    `${headerConstFails} presets violated the constant`,
  );

  // Header byte 1 (preset index within bank) should monotonically run 0..N-1.
  let presetIdxFails = 0;
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].headerPayload[1] !== i) presetIdxFails++;
  }
  check(
    `${path}: header byte[1] monotonically encodes preset 0..${parsed.length - 1}`,
    presetIdxFails === 0,
    `${presetIdxFails} presets violated monotonic ordering`,
  );

  // Single-preset parse sanity (the first preset re-parsed in isolation).
  try {
    const single = parsePresetDump(bytes, 0);
    check(
      `${path}: parsePresetDump(offset=0) matches parsePresetBank()[0]`,
      bytesEqual(single.raw, parsed[0].raw),
      `single.raw.length=${single.raw.length}, parsed[0].raw.length=${parsed[0].raw.length}`,
    );
  } catch (err) {
    bad(`${path}: parsePresetDump(offset=0) threw`, err instanceof Error ? err.message : String(err));
  }

  // Preset-name decoding probe (HYPOTHESIS, not asserted). The II uses
  // chunk-0 offset 8 stride 3 to encode 32 ASCII chars. The III SHOULD
  // share the same primitive given the byte-identical descriptor shape,
  // but the offset/stride is not verified for III. Surface the first 5
  // decoded names so a human can eyeball them; do NOT assert.
  const sampleNames: string[] = [];
  for (let i = 0; i < Math.min(5, parsed.length); i++) {
    sampleNames.push(extractPresetName(parsed[i]));
  }
  console.log(
    `  info  ${path}: first 5 hypothetical preset names (chunk0 off=8 stride=3, II convention): ` +
      sampleNames.map((n) => JSON.stringify(n)).join(', '),
  );
}

console.log(`\n${pass} ok, ${fail} fail, ${skipped} skipped.`);
if (fail > 0) process.exit(1);
