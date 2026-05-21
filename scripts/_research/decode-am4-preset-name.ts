/**
 * AM4 preset binary — name-field decoder
 * =======================================
 *
 * Recovered 2026-05-21 from BK-036 calibration captures
 * (`samples/exports/ABCDEFG.syx` and `Test 1234.syx`). Verified across
 * all 104 factory preset entries in `samples/factory/AM4-Factory-Presets-1p01.syx`
 * — every name decodes cleanly to the AM4-Edit-visible label.
 *
 * # Wire format
 *
 * AM4 preset binary stores the 32-char preset name at chunk-1 offset 0x0C
 * (= preset-frame offset 0x21). The name occupies 48 wire bytes encoded as
 * 16 independent 3-byte groups, each carrying 2 ASCII characters with 5
 * padding bits:
 *
 *     byte0 = char0 & 0x7F                                  (low 7 bits of char0)
 *     byte1 = (char0 >> 7) | ((char1 & 0x3F) << 1)          (high bit of char0 + low 6 bits of char1)
 *     byte2 = (char1 >> 6) & 0x03                           (high 2 bits of char1, in bits 0-1)
 *
 * Each 3-byte group is INDEPENDENT — high bits of char1 do NOT spill into
 * the next group. This is NOT the standard 8-to-7 sliding-window pack
 * from §6b; it's a discrete 2-char-per-3-byte chunked encoding.
 *
 * Names are 0x20-space padded out to 32 characters (per §6e).
 *
 * # Calibration
 *
 *   Input:    "ABCDEFG" + 25 spaces
 *   Encoded:  41 04 01 43 08 01 45 0c 01 47 40 00 20 40 00 20 40 00 20 ...
 *             ^A ^carry+B/2 ^B/64
 *
 *   Input:    "Test 1234" + 23 spaces
 *   Encoded:  54 4a 01 73 68 01 20 62 00 32 66 00 34 40 00 20 40 00 ...
 *             ^T ^carry+e/2 ^e/64
 *
 * # Application
 *
 * Apply this decoder to:
 *   - Bytes 0x21..0x50 of any AM4 active export (.syx) → working-buffer
 *     preset name.
 *   - Bytes (idx * 12352 + 0x21)..(idx * 12352 + 0x50) of the factory bank
 *     file → preset name at location idx.
 *   - The same chunk-1 offset in any future bulk-dump response that uses
 *     the §10b 0x77/0x78/0x79 format.
 *
 * # Run
 *
 *   npx tsx scripts/_research/decode-am4-preset-name.ts
 *
 * Outputs the full 104-preset factory name list as JSON + markdown.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

const FRAME_SIZE = 12_352;
const NAME_OFFSET_IN_FRAME = 0x21;
const NAME_WIRE_LENGTH = 48; // 32 chars × (3 bytes / 2 chars)
const NAME_CHAR_COUNT = 32;

/**
 * Decode an AM4 preset name from its 48-byte wire encoding.
 * Returns a trimmed string (trailing spaces stripped).
 */
export function decodeAm4Name(wire: Uint8Array, charCount = NAME_CHAR_COUNT): string {
  if (wire.length < (charCount / 2) * 3) {
    throw new Error(`AM4 name decode needs ${(charCount / 2) * 3} wire bytes, got ${wire.length}`);
  }
  const chars: number[] = [];
  for (let g = 0; g < charCount / 2; g++) {
    const b0 = wire[g * 3]!;
    const b1 = wire[g * 3 + 1]!;
    const b2 = wire[g * 3 + 2]!;
    const char0 = (b0 & 0x7f) | ((b1 & 0x01) << 7);
    const char1 = ((b1 >> 1) & 0x3f) | ((b2 & 0x03) << 6);
    chars.push(char0, char1);
  }
  return Buffer.from(chars).toString('ascii').replace(/\0+$/, '').trimEnd();
}

/**
 * Inverse: encode an AM4 preset name to its 48-byte wire form.
 * The input is space-padded to 32 characters first; ASCII only.
 */
export function encodeAm4Name(name: string, charCount = NAME_CHAR_COUNT): Uint8Array {
  const padded = (name + ' '.repeat(charCount)).slice(0, charCount);
  const buf = Buffer.from(padded, 'ascii');
  const out = new Uint8Array((charCount / 2) * 3);
  for (let g = 0; g < charCount / 2; g++) {
    const char0 = buf[g * 2]!;
    const char1 = buf[g * 2 + 1]!;
    out[g * 3] = char0 & 0x7f;
    out[g * 3 + 1] = ((char0 >> 7) & 0x01) | ((char1 & 0x3f) << 1);
    out[g * 3 + 2] = (char1 >> 6) & 0x03;
  }
  return out;
}

function locFromIndex(idx: number): string {
  const bank = String.fromCharCode('A'.charCodeAt(0) + Math.floor(idx / 4));
  const sub = (idx % 4) + 1;
  return `${bank}${sub.toString().padStart(2, '0')}`;
}

function main(): void {
  console.log('AM4 preset name decoder — calibration + factory bank dump');
  console.log('═══════════════════════════════════════════════════════════════════════════');

  // Round-trip verify against calibration captures.
  for (const [path_, expected] of [
    ['samples/exports/ABCDEFG.syx', 'ABCDEFG'],
    ['samples/exports/Test 1234.syx', 'Test 1234'],
  ] as const) {
    const data = readFileSync(path.resolve(path_));
    const wire = data.subarray(NAME_OFFSET_IN_FRAME, NAME_OFFSET_IN_FRAME + NAME_WIRE_LENGTH);
    const decoded = decodeAm4Name(wire);
    const reEncoded = encodeAm4Name(expected);
    const reEncodeMatch = Buffer.from(reEncoded).equals(wire);
    const ok = decoded === expected;
    console.log(`  ${path_}`);
    console.log(`    decoded:           "${decoded}"`);
    console.log(`    expected:          "${expected}"`);
    console.log(`    decode ok:         ${ok ? '✓' : '✗'}`);
    console.log(`    round-trip encode: ${reEncodeMatch ? '✓ (bytes match)' : '✗ (bytes differ)'}`);
  }

  // Decode the full factory bank.
  console.log('\n── Factory bank — all 104 preset names ──\n');
  const bank = readFileSync(path.resolve('samples/factory/AM4-Factory-Presets-1p01.syx'));
  const names: { location: string; name: string }[] = [];
  for (let idx = 0; idx < 104; idx++) {
    const frame = bank.subarray(idx * FRAME_SIZE, (idx + 1) * FRAME_SIZE);
    const wire = frame.subarray(NAME_OFFSET_IN_FRAME, NAME_OFFSET_IN_FRAME + NAME_WIRE_LENGTH);
    const name = decodeAm4Name(wire);
    const location = locFromIndex(idx);
    names.push({ location, name });
  }

  // Print in 4-column grid.
  for (let row = 0; row < 104; row += 4) {
    const parts: string[] = [];
    for (let col = 0; col < 4 && row + col < 104; col++) {
      const { location, name } = names[row + col]!;
      parts.push(`${location}: "${name}"`.padEnd(36));
    }
    console.log('  ' + parts.join(''));
  }

  // Save JSON.
  mkdirSync('samples/captured', { recursive: true });
  const jsonOut = path.resolve('samples/captured/am4-factory-preset-names.json');
  const lookup: Record<string, string> = {};
  for (const { location, name } of names) lookup[location] = name;
  writeFileSync(jsonOut, JSON.stringify(lookup, null, 2));
  console.log(`\nSaved 104 names → ${jsonOut}`);

  // Save markdown.
  const md: string[] = [
    `# AM4 factory bank — preset name lookup`,
    ``,
    `Decoded ${new Date().toISOString()} from \`samples/factory/AM4-Factory-Presets-1p01.syx\``,
    `via the 3-byte-per-2-char chunked name encoding recovered in BK-036.`,
    `Calibration source: \`samples/exports/{ABCDEFG, Test 1234}.syx\`.`,
    ``,
    `## Bank A..V — factory presets (96)`,
    ``,
    `| Location | Name |`,
    `|---|---|`,
  ];
  for (let idx = 0; idx < 88; idx++) {
    md.push(`| ${names[idx]!.location} | ${names[idx]!.name} |`);
  }
  md.push('', '## Banks W-Z — user / empty slots (8)', '');
  md.push('| Location | Name |');
  md.push('|---|---|');
  for (let idx = 88; idx < 104; idx++) {
    md.push(`| ${names[idx]!.location} | ${names[idx]!.name} |`);
  }
  const mdOut = path.resolve('samples/captured/am4-factory-preset-names.md');
  writeFileSync(mdOut, md.join('\n'));
  console.log(`Saved markdown → ${mdOut}`);
}

main();
