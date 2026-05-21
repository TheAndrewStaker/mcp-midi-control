/**
 * Decode fn 0x28 SYSEX_GET_PARAM_STRINGS response — enum-value display
 * strings from the live Axe-Fx II firmware.
 *
 * Source: `samples/captured/probe-axefx2-new-opcodes-findings.md` from
 * Session 104's `probe-axefx2-new-opcodes.ts` run (2026-05-20). The
 * device returned a 2048-byte SysEx frame containing NULL-delimited
 * 7-bit ASCII enum strings, payload starting after the standard
 * `f0 00 01 74 07 28` 6-byte fractal header.
 *
 * Wire shape (decoded here for the first time):
 *
 *   F0 00 01 74 07 28 [STR_0\0 STR_1\0 STR_2\0 ... STR_N\0] [<checksum>] F7
 *
 *   - Strings are raw 7-bit ASCII (no septet packing needed since
 *     ASCII letters/digits/space/dash fit in 0x00..0x7F).
 *   - Each string is NULL-terminated (`0x00`).
 *   - The string array fills the SysEx payload up to the device's
 *     internal cap. On Q8.02 this is at least 2048 bytes per frame.
 *     The probed frame did NOT terminate with `f7`, suggesting either
 *     (a) the response extends across multiple SysEx frames the node-
 *     midi buffer truncated, or (b) the device chunked at a 2048-byte
 *     boundary intentionally.
 *
 * This decoder treats the captured 2048-byte frame as a single chunk
 * and emits all complete NULL-delimited strings (final partial string
 * is dropped). Run from repo root:
 *
 *   npx tsx scripts/_research/decode-fn28-enum-strings.ts
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const FINDINGS_PATH = path.resolve(
  'samples/captured/probe-axefx2-new-opcodes-findings.md',
);

function extractFrameHex(md: string, sectionHeader: string): string[] {
  const lines = md.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim() === sectionHeader);
  if (idx < 0) throw new Error(`section not found: ${sectionHeader}`);
  const frame0Idx = lines.findIndex(
    (l, i) => i > idx && l.startsWith('Frame [0] (len='),
  );
  if (frame0Idx < 0) throw new Error('no Frame [0] under section');
  const openFence = lines.findIndex(
    (l, i) => i > frame0Idx && l.trim() === '```',
  );
  if (openFence < 0) throw new Error('no opening fence');
  const closeFence = lines.findIndex(
    (l, i) => i > openFence && l.trim() === '```',
  );
  if (closeFence < 0) throw new Error('no closing fence');
  return lines.slice(openFence + 1, closeFence);
}

function hexLinesToBytes(lines: string[]): number[] {
  const bytes: number[] = [];
  for (const ln of lines) {
    for (const tok of ln.trim().split(/\s+/)) {
      if (!tok) continue;
      bytes.push(parseInt(tok, 16));
    }
  }
  return bytes;
}

function decodeEnumStrings(frameBytes: number[]): {
  strings: string[];
  trailingPartial: string;
  payloadStart: number;
  payloadEnd: number;
} {
  // Fractal SysEx header: F0 00 01 74 <model> <fn>
  if (
    frameBytes[0] !== 0xf0 ||
    frameBytes[1] !== 0x00 ||
    frameBytes[2] !== 0x01 ||
    frameBytes[3] !== 0x74
  ) {
    throw new Error('not a Fractal SysEx frame');
  }
  const payloadStart = 6;
  // If the frame is properly terminated, drop checksum + F7.
  const lastByte = frameBytes[frameBytes.length - 1];
  const isTerminated = lastByte === 0xf7;
  const payloadEnd = isTerminated
    ? frameBytes.length - 2 // drop checksum + F7
    : frameBytes.length;
  const payload = frameBytes.slice(payloadStart, payloadEnd);

  const strings: string[] = [];
  let cur: number[] = [];
  for (const b of payload) {
    if (b === 0x00) {
      strings.push(String.fromCharCode(...cur));
      cur = [];
    } else {
      cur.push(b);
    }
  }
  // `cur` holds any partial string after the last NULL — may be
  // truncated by the SysEx frame cap.
  const trailingPartial = String.fromCharCode(...cur);
  return { strings, trailingPartial, payloadStart, payloadEnd };
}

async function main(): Promise<void> {
  const md = readFileSync(FINDINGS_PATH, 'utf8');

  // The padded probe is more informative (8-byte payload matches the
  // GET_MODIFIER_INFO convention). Use that section.
  const section = '### fn 0x28 GET_PARAM_STRINGS (AMP 1, paramId=0, padded)';
  const hexLines = extractFrameHex(md, section);
  const bytes = hexLinesToBytes(hexLines);

  console.log(`Captured frame: ${bytes.length} bytes`);
  console.log(
    `Frame head:  ${bytes
      .slice(0, 6)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')}`,
  );
  const tail = bytes.slice(-6);
  console.log(
    `Frame tail:  ${tail.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`,
  );
  console.log(`Frame terminated with F7? ${bytes[bytes.length - 1] === 0xf7}`);

  const decoded = decodeEnumStrings(bytes);
  console.log(
    `\nDecoded ${decoded.strings.length} complete NULL-delimited strings`,
  );
  console.log(
    `Trailing partial string (truncated at frame cap): "${decoded.trailingPartial}"`,
  );

  console.log('\nAll decoded strings (wire-index → label):');
  decoded.strings.forEach((s, i) => {
    console.log(`  ${i.toString().padStart(3)}: ${JSON.stringify(s)}`);
  });

  // Output as a JS object literal suitable for slotting into
  // params.ts AMP_EFFECT_TYPE_VALUES.
  const literalLines = decoded.strings.map(
    (s, i) => `    ${i}: ${JSON.stringify(s)},`,
  );
  console.log('\n--- TS literal (paste-ready) ---');
  console.log(`{\n${literalLines.join('\n')}\n}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
