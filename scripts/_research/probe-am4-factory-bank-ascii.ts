/**
 * BK-036 entry-point — AM4 factory bank ASCII-string probe
 * =========================================================
 *
 * 5-minute exploratory probe to test the "preset names are plaintext or
 * simply-masked in the §11 binary" hypothesis. The factory bank file
 * (`samples/factory/AM4-Factory-Presets-1p01.syx`, 1,284,608 bytes = 104
 * × 12,352-byte preset dumps) is a stored-form corpus of every factory
 * preset with known names, layouts, and parameter values. If names
 * survive the chunk-payload mask, they jump out as ASCII strings here
 * and we get a per-location preset-name lookup for free (unblocking
 * `list_locations` UX).
 *
 * # What this does
 *
 *   - Slices the bank file into 104 preset frames (each 12,352 bytes).
 *   - For each frame: extracts runs of printable-ASCII bytes (>= 5
 *     chars) and prints their offset within the frame + content.
 *   - Cross-references with known factory preset names from the AM4
 *     Owner's Manual (A01..D04 well-known: "Clean Combo", "Crunch",
 *     "Hi Gain", etc) to confirm whether plaintext names exist.
 *
 * # Output
 *
 *   - stdout: per-frame ASCII findings.
 *   - samples/captured/bk-036-ascii-findings.md: full report with
 *     per-frame offset table + cross-reference verdict.
 *
 * # Interpretation
 *
 *   - If preset names appear as plaintext at a stable offset across
 *     all 104 frames → names survive the mask, decode is trivial.
 *   - If no plaintext strings appear OR they only appear at scattered
 *     offsets → names are within the masked region; need to invert
 *     the mask first (BK-036 §11 main workstream).
 *   - If short strings appear at stable offsets but don't match
 *     known names → they may be different metadata (block-type
 *     labels, scene names, etc.) worth catalogueing separately.
 *
 * # Run
 *
 *   npx tsx scripts/_research/probe-am4-factory-bank-ascii.ts
 *
 * Local-only, no hardware needed.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const BANK_PATH = path.resolve('samples/factory/AM4-Factory-Presets-1p01.syx');
const FRAME_SIZE = 12_352;
const EXPECTED_FRAME_COUNT = 104;
const MIN_ASCII_RUN = 5;

// Known AM4 factory preset names from the Owner's Manual.
// Used to score whether plaintext names actually appear in the binary.
// Only the first few banks listed — enough to disambiguate plaintext vs
// masked output without hand-typing all 104.
const KNOWN_FACTORY_NAMES: Record<string, string> = {
  A01: 'Clean Combo',
  A02: 'Crunch',
  A03: 'Hi Gain',
  A04: 'Drive Pedal',
  B01: '1959SLP',
  B02: 'Brit JM45',
  B03: 'USA Clean',
  B04: 'USA Lead',
  // (rest omitted — these are sufficient to test the hypothesis)
};

function locFromIndex(idx: number): string {
  const bank = String.fromCharCode('A'.charCodeAt(0) + Math.floor(idx / 4));
  const sub = (idx % 4) + 1;
  return `${bank}${sub.toString().padStart(2, '0')}`;
}

interface AsciiRun {
  offset: number;
  text: string;
}

function extractAsciiRuns(frame: Buffer, minLen: number): AsciiRun[] {
  const runs: AsciiRun[] = [];
  let start = -1;
  for (let i = 0; i < frame.length; i++) {
    const b = frame[i]!;
    const isPrintable = b >= 0x20 && b <= 0x7e;
    if (isPrintable) {
      if (start === -1) start = i;
    } else {
      if (start !== -1) {
        const len = i - start;
        if (len >= minLen) {
          runs.push({ offset: start, text: frame.slice(start, i).toString('ascii') });
        }
        start = -1;
      }
    }
  }
  if (start !== -1 && frame.length - start >= minLen) {
    runs.push({ offset: start, text: frame.slice(start).toString('ascii') });
  }
  return runs;
}

function main(): void {
  console.log('BK-036 — AM4 factory bank ASCII-string probe');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log(`Bank file: ${BANK_PATH}`);

  const data = readFileSync(BANK_PATH);
  console.log(`Total bytes: ${data.length}`);

  if (data.length !== FRAME_SIZE * EXPECTED_FRAME_COUNT) {
    console.warn(`WARNING: expected ${FRAME_SIZE * EXPECTED_FRAME_COUNT} bytes (${EXPECTED_FRAME_COUNT} × ${FRAME_SIZE}), got ${data.length}`);
  }

  const frameCount = Math.floor(data.length / FRAME_SIZE);
  console.log(`Frames: ${frameCount} (assuming ${FRAME_SIZE} bytes each)`);
  console.log(`Min ASCII run length: ${MIN_ASCII_RUN}\n`);

  // Per-frame run analysis.
  interface FrameReport {
    idx: number;
    loc: string;
    runs: AsciiRun[];
  }
  const reports: FrameReport[] = [];

  for (let idx = 0; idx < frameCount; idx++) {
    const frame = data.subarray(idx * FRAME_SIZE, (idx + 1) * FRAME_SIZE);
    const runs = extractAsciiRuns(frame, MIN_ASCII_RUN);
    reports.push({ idx, loc: locFromIndex(idx), runs });
  }

  // Total runs.
  const totalRuns = reports.reduce((s, r) => s + r.runs.length, 0);
  console.log(`Total ASCII runs across all frames (≥ ${MIN_ASCII_RUN} chars): ${totalRuns}`);

  // First 8 frames — print all runs so we can eyeball patterns.
  console.log('\n── Detailed ASCII runs (first 8 frames) ──\n');
  for (let i = 0; i < Math.min(8, reports.length); i++) {
    const r = reports[i]!;
    const expectedName = KNOWN_FACTORY_NAMES[r.loc];
    console.log(`Frame ${r.idx} = ${r.loc} (expected: ${expectedName ?? '?'}) — ${r.runs.length} ASCII runs`);
    for (const run of r.runs) {
      const matchesExpected = expectedName && run.text.includes(expectedName);
      const marker = matchesExpected ? ' 🟢 MATCHES expected name!' : '';
      console.log(`  +0x${run.offset.toString(16).padStart(5, '0')} (off=${run.offset}): "${run.text}"${marker}`);
    }
    console.log('');
  }

  // Stable-offset check: do any of the ASCII runs appear at the SAME offset
  // across all (or most) frames? That would be a strong "plaintext name
  // lives here" signal.
  const offsetCounts = new Map<number, number>();
  for (const r of reports) {
    for (const run of r.runs) {
      offsetCounts.set(run.offset, (offsetCounts.get(run.offset) ?? 0) + 1);
    }
  }
  const stableOffsets = [...offsetCounts.entries()]
    .filter(([, count]) => count >= Math.floor(frameCount * 0.5)) // appears in ≥ 50% of frames
    .sort((a, b) => b[1] - a[1]);
  console.log(`Offsets appearing in ≥ 50% of frames: ${stableOffsets.length}`);
  for (const [off, count] of stableOffsets.slice(0, 20)) {
    console.log(`  +0x${off.toString(16).padStart(5, '0')} appears in ${count}/${frameCount} frames`);
    // Show what the run looks like in a sample frame.
    for (let i = 0; i < reports.length; i++) {
      const matchingRun = reports[i]!.runs.find((r) => r.offset === off);
      if (matchingRun) {
        console.log(`    e.g. frame ${i} (${locFromIndex(i)}): "${matchingRun.text}"`);
        break;
      }
    }
  }

  // Known-name correlation: scan all runs for any that match a known
  // factory preset name. If we find "Clean Combo" anywhere in the A01
  // frame, names ARE plaintext.
  console.log('\n── Known-name correlation ──\n');
  let nameMatchCount = 0;
  for (const [loc, expectedName] of Object.entries(KNOWN_FACTORY_NAMES)) {
    const idx = (loc.charCodeAt(0) - 'A'.charCodeAt(0)) * 4 + (parseInt(loc.slice(1), 10) - 1);
    if (idx < 0 || idx >= reports.length) continue;
    const frameRuns = reports[idx]!.runs;
    const match = frameRuns.find((r) => r.text.toLowerCase().includes(expectedName.toLowerCase()));
    if (match) {
      console.log(`  ${loc}: 🟢 PLAINTEXT MATCH "${expectedName}" at offset 0x${match.offset.toString(16)}`);
      nameMatchCount++;
    } else {
      console.log(`  ${loc}: 🔴 no plaintext match for "${expectedName}"`);
    }
  }

  // ── Markdown report ────────────────────────────────────────────
  mkdirSync('samples/captured', { recursive: true });
  const md: string[] = [
    `# BK-036 — AM4 factory bank ASCII-string probe`,
    ``,
    `> ${new Date().toISOString()}`,
    ``,
    `## Setup`,
    ``,
    `- File: \`${BANK_PATH}\``,
    `- Size: ${data.length} bytes (${frameCount} frames × ${FRAME_SIZE} bytes)`,
    `- Minimum ASCII run length: ${MIN_ASCII_RUN}`,
    ``,
    `## Headline metrics`,
    ``,
    `- Total ASCII runs across all frames: ${totalRuns}`,
    `- Stable-offset runs (appearing in ≥ 50% of frames): ${stableOffsets.length}`,
    `- Known-name plaintext matches: ${nameMatchCount} / ${Object.keys(KNOWN_FACTORY_NAMES).length}`,
    ``,
    `## Verdict`,
    ``,
    nameMatchCount > 0
      ? `🟢 **Preset names are plaintext** in the binary at decodable offsets. Decoding names is trivial — extract ASCII runs at the identified stable offset(s). This unblocks \`list_locations\` UX immediately.`
      : `🔴 **No plaintext preset names found** in the factory bank. Names are within the masked region per §11. Proceed with BK-036 main workstream: diff bank A01 against \`samples/factory/A01-original.syx\` to isolate the chunk-payload mask, then re-attempt extraction.`,
    ``,
    `## Stable offsets (≥ 50% frame coverage)`,
    ``,
    `| Offset (hex) | Offset (dec) | Frame coverage | Sample frame 0 text |`,
    `|---|---|---|---|`,
  ];
  for (const [off, count] of stableOffsets.slice(0, 30)) {
    const sampleRun = reports[0]?.runs.find((r) => r.offset === off);
    md.push(`| \`0x${off.toString(16).padStart(5, '0')}\` | ${off} | ${count}/${frameCount} | \`${(sampleRun?.text ?? '—').slice(0, 80)}\` |`);
  }

  md.push('', '## Known-name correlation', '');
  md.push('| Location | Expected name | Match? | Offset |');
  md.push('|---|---|---|---|');
  for (const [loc, expectedName] of Object.entries(KNOWN_FACTORY_NAMES)) {
    const idx = (loc.charCodeAt(0) - 'A'.charCodeAt(0)) * 4 + (parseInt(loc.slice(1), 10) - 1);
    if (idx < 0 || idx >= reports.length) continue;
    const frameRuns = reports[idx]!.runs;
    const match = frameRuns.find((r) => r.text.toLowerCase().includes(expectedName.toLowerCase()));
    md.push(`| ${loc} | ${expectedName} | ${match ? '🟢' : '🔴'} | ${match ? `0x${match.offset.toString(16)}` : '—'} |`);
  }

  md.push('', '## Per-frame ASCII runs (first 12 frames)', '');
  for (let i = 0; i < Math.min(12, reports.length); i++) {
    const r = reports[i]!;
    md.push(`### Frame ${r.idx} — ${r.loc}`, '');
    if (r.runs.length === 0) {
      md.push('_No ASCII runs._', '');
    } else {
      md.push('| Offset | Text |');
      md.push('|---|---|');
      for (const run of r.runs) {
        md.push(`| \`0x${run.offset.toString(16).padStart(5, '0')}\` | \`${run.text.slice(0, 80)}${run.text.length > 80 ? '…' : ''}\` |`);
      }
      md.push('');
    }
  }

  const mdOut = path.resolve('samples/captured/bk-036-ascii-findings.md');
  writeFileSync(mdOut, md.join('\n'));
  console.log(`\nWrote ${mdOut}`);
}

main();
