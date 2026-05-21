/**
 * BK-070 — verify the footer-hash hypothesis.
 *
 * Ghidra (DumpAxeEditIIFooterHash.java) revealed FUN_00544cc0 to be a
 * trivially simple 16-bit XOR-fold over a ushort buffer:
 *
 *   ushort uVar2 = 0;
 *   for (i = 0; i < n; i++) uVar2 ^= buf[i];
 *   return uVar2;
 *
 * Combined with the chunk-descriptor table's "(0,6,2)+(1,8,3072)" layout
 * for 0x78 PATCH_DATA, this script tests the hypothesis:
 *
 *   parsed footer (3 wire bytes → 21-bit value, low 16 bits) =
 *     XOR of all decoded native ushorts across 64 chunks
 *
 * Each chunk decodes its payload as `count_septet + N × 3-wire-bytes-per-
 * ushort`. The XOR-target is the concatenation of those decoded ushorts.
 *
 * Test corpus: the 384 factory presets in `samples/factory/Axe-Fx-II_XL+_
 * Bank-{A,B,C}_Q8p02.syx`. If the hypothesis holds, all 384 presets'
 * computed XOR matches their footer value.
 */

import { readFileSync, existsSync } from 'node:fs';
import {
  parsePresetBank,
  parsePresetDump,
  PRESET_DUMP_LEN,
  CHUNK_PAYLOAD_LEN,
  FOOTER_PAYLOAD_LEN,
} from '@mcp-midi-control/axe-fx-ii/presetDump.js';
import type { ParsedPresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

// Decode one chunk payload as N native ushorts following the
// (key=0, val_b=6, val_c=2) + (key=1, val_b=8, val_c=3072) descriptor.
// val_b is the WIRE OFFSET from F0 (start of envelope). The 6-byte envelope
// prefix (F0 00 01 74 07 78) means wire offset 6 = chunkPayload[0].
//
// So the layout is:
// - chunkPayload[0..1]  = 2-byte septet count N (14-bit)
// - chunkPayload[2..]   = N × 3 wire bytes per ushort (septet pack → low 16 bits)
function decodeChunkNative(payload: Uint8Array): Uint16Array {
  const count = (payload[0] & 0x7f) | ((payload[1] & 0x7f) << 7);
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const off = 2 + i * 3;
    const v =
      ((payload[off] & 0x7f) |
        ((payload[off + 1] & 0x7f) << 7) |
        ((payload[off + 2] & 0x7f) << 14)) &
      0xffff;
    out[i] = v;
  }
  return out;
}

// Parse the 3-byte footer payload as a 21-bit value (low 16 = ushort to
// compare against the XOR-fold).
function parseFooter(footer: Uint8Array): number {
  if (footer.length !== FOOTER_PAYLOAD_LEN) {
    throw new Error(`footer length: expected ${FOOTER_PAYLOAD_LEN}, got ${footer.length}`);
  }
  const v =
    (footer[0] & 0x7f) |
    ((footer[1] & 0x7f) << 7) |
    ((footer[2] & 0x7f) << 14);
  return v & 0xffff;
}

function decodeHeaderNative(headerPayload: Uint8Array): Uint16Array {
  // 4 wire bytes: assume same 3-bytes-per-ushort septet pack pattern
  // wouldn't fit. Per the descriptor table at 0xe033a0/0x7180c0 the 0x77
  // header reads (0,6,1)+(1,7,1)+(2,8,3) or (0,6,2)+(1,8,192). The actual
  // 4-byte payload appears to be (bank_lo, preset_lo, 0x00, 0x20). We
  // test multiple inclusion strategies below.
  const v0 = headerPayload[0] & 0x7f;
  const v1 = headerPayload[1] & 0x7f;
  const v2 = headerPayload[2] & 0x7f;
  const v3 = headerPayload[3] & 0x7f;
  return new Uint16Array([v0, v1, v2, v3]);
}

interface Variant {
  name: string;
  compute: (parsed: ParsedPresetDump) => number;
}

const VARIANTS: Variant[] = [
  {
    name: 'XOR-fold native ushorts (chunks only)',
    compute: (parsed) => {
      let xor = 0;
      for (const chunk of parsed.chunkPayloads) {
        const ushorts = decodeChunkNative(chunk);
        for (const v of ushorts) xor ^= v;
      }
      return xor & 0xffff;
    },
  },
  {
    name: 'XOR-fold native ushorts (chunks + count bytes)',
    compute: (parsed) => {
      let xor = 0;
      for (const chunk of parsed.chunkPayloads) {
        xor ^= (chunk[0] & 0x7f);
        const ushorts = decodeChunkNative(chunk);
        for (const v of ushorts) xor ^= v;
      }
      return xor & 0xffff;
    },
  },
  {
    name: 'XOR-fold native ushorts (header + chunks)',
    compute: (parsed) => {
      let xor = 0;
      for (const v of decodeHeaderNative(parsed.headerPayload)) xor ^= v;
      for (const chunk of parsed.chunkPayloads) {
        const ushorts = decodeChunkNative(chunk);
        for (const v of ushorts) xor ^= v;
      }
      return xor & 0xffff;
    },
  },
  {
    name: 'XOR-fold raw chunk-payload bytes-as-ushorts (LE pairs)',
    compute: (parsed) => {
      let xor = 0;
      for (const chunk of parsed.chunkPayloads) {
        for (let i = 0; i + 1 < chunk.length; i += 2) {
          xor ^= chunk[i] | (chunk[i + 1] << 8);
        }
      }
      return xor & 0xffff;
    },
  },
  {
    name: 'XOR-fold raw chunk-payload bytes-as-ushorts (BE pairs)',
    compute: (parsed) => {
      let xor = 0;
      for (const chunk of parsed.chunkPayloads) {
        for (let i = 0; i + 1 < chunk.length; i += 2) {
          xor ^= (chunk[i] << 8) | chunk[i + 1];
        }
      }
      return xor & 0xffff;
    },
  },
];

function dumpVariantResults(presets: ParsedPresetDump[], label: string): void {
  console.log(`\n========================================`);
  console.log(`Corpus: ${label} (${presets.length} preset${presets.length === 1 ? '' : 's'})`);
  console.log(`========================================`);

  for (const variant of VARIANTS) {
    let matches = 0;
    let total = presets.length;
    let firstFail: { idx: number; expected: number; got: number } | undefined;
    for (let i = 0; i < presets.length; i++) {
      const parsed = presets[i];
      const expected = parseFooter(parsed.footerPayload);
      const got = variant.compute(parsed);
      if (expected === got) matches++;
      else if (firstFail === undefined) firstFail = { idx: i, expected, got };
    }
    const status = matches === total ? '✅ MATCH ALL' : matches > 0 ? '⚠ PARTIAL' : '❌ NO MATCH';
    console.log(`${status}  ${variant.name}`);
    console.log(`   ${matches}/${total} match`);
    if (firstFail !== undefined) {
      console.log(
        `   first miss @ idx ${firstFail.idx}: ` +
          `expected 0x${firstFail.expected.toString(16).padStart(4, '0')}, ` +
          `got 0x${firstFail.got.toString(16).padStart(4, '0')}, ` +
          `xor 0x${(firstFail.expected ^ firstFail.got).toString(16).padStart(4, '0')}`,
      );
    }
  }
}

function loadBank(path: string): ParsedPresetDump[] {
  if (!existsSync(path)) {
    console.log(`(skip: ${path} not present)`);
    return [];
  }
  const bytes = new Uint8Array(readFileSync(path));
  console.log(`Loaded ${path} (${bytes.length} bytes = ${bytes.length / PRESET_DUMP_LEN} presets)`);
  return parsePresetBank(bytes);
}

function loadSingle(path: string): ParsedPresetDump | undefined {
  if (!existsSync(path)) return undefined;
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes.length !== PRESET_DUMP_LEN) {
    console.log(`(skip: ${path} length=${bytes.length}, expected ${PRESET_DUMP_LEN})`);
    return undefined;
  }
  return parsePresetDump(bytes);
}

function main(): void {
  console.log('BK-070 — verify footer XOR-fold hash hypothesis\n');
  console.log(`PRESET_DUMP_LEN = ${PRESET_DUMP_LEN}`);
  console.log(`CHUNK_PAYLOAD_LEN = ${CHUNK_PAYLOAD_LEN}`);

  // Bank A — primary test corpus (128 presets, all known good)
  const bankA = loadBank('samples/factory/Axe-Fx-II_XL+_Bank-A_Q8p02.syx');
  if (bankA.length > 0) dumpVariantResults(bankA, 'Bank A');

  const bankB = loadBank('samples/factory/Axe-Fx-II_XL+_Bank-B_Q8p02.syx');
  if (bankB.length > 0) dumpVariantResults(bankB, 'Bank B');

  const bankC = loadBank('samples/factory/Axe-Fx-II_XL+_Bank-C_Q8p02.syx');
  if (bankC.length > 0) dumpVariantResults(bankC, 'Bank C');

  // BK-070 captures — paired baseline/after (independent corpus)
  const captures: ParsedPresetDump[] = [];
  const captureNames: string[] = [];
  for (const name of [
    'bk070-loop-amp-master-vol-3-baseline.syx',
    'bk070-loop-amp-master-vol-3-after.syx',
    'bk070-loop-amp-bass-2-baseline.syx',
    'bk070-loop-amp-bass-2-after.syx',
    'bk070-loop-amp-scene1-Y-baseline.syx',
    'bk070-loop-amp-scene1-Y-after.syx',
  ]) {
    const p = loadSingle(`samples/captured/${name}`);
    if (p !== undefined) {
      captures.push(p);
      captureNames.push(name);
    }
  }
  if (captures.length > 0) {
    console.log('\nbk070 hardware capture corpus:');
    for (const n of captureNames) console.log(`  - ${n}`);
    dumpVariantResults(captures, 'bk070 hardware captures');
  }
}

main();
