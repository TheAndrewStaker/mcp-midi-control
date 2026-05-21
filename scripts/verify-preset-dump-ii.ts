/**
 * Axe-Fx II preset-dump round-trip golden.
 *
 * Validates that `packages/axe-fx-ii/src/presetDump.ts` parses every byte
 * of the three factory banks (Q8.02 XL+, 384 presets total) and re-emits
 * a byte-identical stream. Same shape as `scripts/verify-preset-dump.ts`
 * but for the II envelope (12,951 bytes per preset, 64 chunks × 194-byte
 * payload, model byte 0x07).
 *
 * Test fixtures live under `samples/factory/` and are git-ignored Fractal
 * IP. Missing fixtures are skipped (with a clear notice) — keeps
 * `npm test` green on a fresh clone.
 *
 * Bonus output: the per-bank analysis prints preset-name extraction
 * across all 128 entries via `extractPresetName`. Confirms the name
 * decoding (chunk 0, offset 8, 3-byte triplets) works against the
 * factory corpus; surfaces any preset whose first-byte stride doesn't
 * decode cleanly to ASCII.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  PRESET_DUMP_LEN,
  extractPresetName,
  parsePresetBank,
  parsePresetDump,
  serializePresetDump,
} from '@mcp-midi-control/axe-fx-ii/presetDump.js';

const BANK_PATHS = [
  'samples/factory/Axe-Fx-II_XL+_Bank-A_Q8p02.syx',
  'samples/factory/Axe-Fx-II_XL+_Bank-B_Q8p02.syx',
  'samples/factory/Axe-Fx-II_XL+_Bank-C_Q8p02.syx',
];

let pass = 0;
let fail = 0;
let skipped = 0;

function ok(label: string): void {
  console.log(`  ok    ${label}`);
  pass++;
}

function bad(label: string, detail = ''): void {
  console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
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

console.log('Axe-Fx II preset-dump round-trip golden:');

for (const path of BANK_PATHS) {
  if (!existsSync(path)) {
    console.log(`  skip  ${path} (not present)`);
    skipped++;
    continue;
  }
  const bytes = new Uint8Array(readFileSync(path));
  const expectedCount = bytes.length / PRESET_DUMP_LEN;
  check(
    `${path} length is a multiple of ${PRESET_DUMP_LEN} (${bytes.length} bytes)`,
    bytes.length % PRESET_DUMP_LEN === 0,
    `got ${bytes.length} bytes (${bytes.length / PRESET_DUMP_LEN} dumps + remainder)`,
  );

  let parsed;
  try {
    parsed = parsePresetBank(bytes);
  } catch (err) {
    bad(`${path}: parsePresetBank threw`, err instanceof Error ? err.message : String(err));
    continue;
  }
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

  // Preset-name decoding sanity. Every name should decode to printable
  // ASCII (or empty); no nonprintable bytes mid-string.
  let nameFails = 0;
  let firstNameFail: { index: number; raw: string } | undefined;
  for (let i = 0; i < parsed.length; i++) {
    const name = extractPresetName(parsed[i]);
    // Names are usually 4-32 chars, all printable ASCII (32..126).
    if (name.length === 0) continue; // empty preset names are valid (factory may have blanks)
    const ok = /^[\x20-\x7e]+$/.test(name);
    if (!ok) {
      nameFails++;
      if (firstNameFail === undefined) {
        firstNameFail = { index: i, raw: name };
      }
    }
  }
  check(
    `${path}: ${parsed.length - nameFails}/${parsed.length} preset names decode to printable ASCII`,
    nameFails === 0,
    firstNameFail !== undefined
      ? `${nameFails} non-ASCII names; first at preset ${firstNameFail.index}: ${JSON.stringify(firstNameFail.raw)}`
      : '',
  );

  // Header payload sanity: bytes [2, 3] should be [0x00, 0x20] constant
  // across all 384 factory presets per the BK-070 design notes.
  let headerConstFails = 0;
  for (let i = 0; i < parsed.length; i++) {
    const h = parsed[i].headerPayload;
    if (h[2] !== 0x00 || h[3] !== 0x20) headerConstFails++;
  }
  check(
    `${path}: header payload bytes [2,3] = [0x00, 0x20] across all presets`,
    headerConstFails === 0,
    `${headerConstFails} presets violated the constant`,
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
}

console.log(`\n${pass} ok, ${fail} fail, ${skipped} skipped.`);
if (fail > 0) process.exit(1);
