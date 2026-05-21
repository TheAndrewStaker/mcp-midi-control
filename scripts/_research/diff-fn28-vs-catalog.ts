/**
 * Diff fn 0x28 hardware-captured amp.type enum strings against the
 * current fractal-midi II `AMP_EFFECT_TYPE_VALUES` catalog.
 *
 * Both sources order amp models by wire-index. A match means the
 * wiki-sourced catalog and the live device firmware emit IDENTICAL
 * display strings at the same wire index — high-confidence validation
 * that the catalog is byte-correct for the indexes captured.
 *
 * Mismatches by index point at one of:
 *   - Wiki entry stale (catalog wrong, hardware right).
 *   - Firmware revision drift (current Q8.02 differs from the wiki's
 *     reference firmware).
 *   - Decoder bug (we mis-split a NULL boundary).
 *
 * Per CLAUDE.md "Verification sources of truth": hardware ground
 * truth wins.
 *
 * Run:
 *   npx tsx scripts/_research/diff-fn28-vs-catalog.ts
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { AMP_EFFECT_TYPE_VALUES } from 'fractal-midi/axe-fx-ii';

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
  const openFence = lines.findIndex(
    (l, i) => i > frame0Idx && l.trim() === '```',
  );
  const closeFence = lines.findIndex(
    (l, i) => i > openFence && l.trim() === '```',
  );
  return lines.slice(openFence + 1, closeFence);
}

function hexLinesToBytes(lines: string[]): number[] {
  const bytes: number[] = [];
  for (const ln of lines) {
    for (const tok of ln.trim().split(/\s+/)) {
      if (tok) bytes.push(parseInt(tok, 16));
    }
  }
  return bytes;
}

function decodeEnumStrings(frameBytes: number[]): string[] {
  const payload = frameBytes.slice(6);
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
  // discard trailing partial (truncated by node-midi buffer cap)
  return strings;
}

async function main(): Promise<void> {
  const md = readFileSync(FINDINGS_PATH, 'utf8');
  const hex = extractFrameHex(
    md,
    '### fn 0x28 GET_PARAM_STRINGS (AMP 1, paramId=0, padded)',
  );
  const hardware = decodeEnumStrings(hexLinesToBytes(hex));
  console.log(`Hardware-captured: ${hardware.length} complete strings`);
  console.log(`Catalog size:      ${Object.keys(AMP_EFFECT_TYPE_VALUES).length} entries`);

  let exact = 0;
  let mismatch = 0;
  let absent = 0;
  const diffs: { idx: number; hw: string; cat: string | undefined }[] = [];
  for (let i = 0; i < hardware.length; i++) {
    const hw = hardware[i]!;
    const cat = AMP_EFFECT_TYPE_VALUES[i];
    if (cat === undefined) {
      absent++;
      diffs.push({ idx: i, hw, cat });
    } else if (cat === hw) {
      exact++;
    } else {
      mismatch++;
      diffs.push({ idx: i, hw, cat });
    }
  }

  console.log(`\nByte-exact match through index ${hardware.length - 1}:`);
  console.log(`  ✅ exact   : ${exact}`);
  console.log(`  ❌ mismatch: ${mismatch}`);
  console.log(`  ⚠️  absent  : ${absent} (catalog missing entry the device emits)`);

  if (diffs.length > 0) {
    console.log('\nDelta list:');
    console.log('idx | hardware                          | catalog');
    console.log('----+-----------------------------------+-----------------------------------');
    for (const d of diffs) {
      console.log(
        `${d.idx.toString().padStart(3)} | ${(d.hw || '').padEnd(33)} | ${d.cat ?? '(absent)'}`,
      );
    }
  }

  // Show catalog entries BEYOND the captured range — these came from
  // the wiki and we couldn't validate.
  const catSize = Object.keys(AMP_EFFECT_TYPE_VALUES).length;
  if (catSize > hardware.length) {
    console.log(
      `\nCatalog entries ${hardware.length}..${catSize - 1} are unvalidated by this capture (frame truncated at node-midi cap).`,
    );
    console.log('To validate, run probe-axefx2-new-opcodes.ts again — the device may chunk the rest in subsequent frames.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
