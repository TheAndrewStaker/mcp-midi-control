/**
 * Strip publisher-specific boilerplate from extracted manual `.txt`
 * files (Declaration of Conformity, FCC / EMC, EULA, Warranty,
 * marketing intros, repeated page-footer copyright lines) and prepend
 * a standardized source-attribution header.
 *
 * Run after `pdftotext -layout` on a fresh extraction, or any time
 * the cleanup rules change.
 *
 * Why trim: fair-use posture for the committed `.txt` extracts is
 * stronger when we keep the technical reference (factual content,
 * low copyright protection) and drop the marketing prose +
 * regulatory boilerplate (creative + functional content not needed
 * for interoperability research). See docs/manuals/README.md for
 * policy.
 *
 * Per-manual recipes live in MANUAL_RECIPES below: each entry names
 * the strip patterns and section boundaries that apply to a given
 * manual. Conservative by default; missing a pattern just leaves a
 * little fluff in the extract (low cost). Over-stripping a real
 * section would lose technical content (high cost), so the patterns
 * are scoped narrowly.
 *
 * Usage:
 *
 *   npx tsx scripts/strip-manual-fluff.ts
 *
 * Idempotent. Re-running against an already-trimmed file produces
 * byte-identical output because the attribution header acts as a
 * sentinel: if it's already present, the file is skipped.
 */

import * as fs from 'fs';
import * as path from 'path';

const SENTINEL = '<!-- mcp-midi-control: source attribution + trimmed extract -->';

interface ManualRecipe {
  /** Path relative to repo root. */
  file: string;
  /** Publisher attribution for the header. */
  publisher: string;
  /** Document title for the header. */
  title: string;
  /** Optional copyright year span. */
  copyrightYear?: string;
  /**
   * Drop everything UP TO AND INCLUDING the first line that matches
   * this regex (drops front-matter: title page, Declaration of
   * Conformity, FCC notices, marketing intros). Leave undefined to
   * keep the head of the file.
   */
  stripUntil?: RegExp;
  /**
   * Drop everything FROM the first line that matches this regex
   * onward (drops back-matter: warranty, EULA, contact info).
   * Leave undefined to keep the tail.
   */
  stripFrom?: RegExp;
  /**
   * Additional line-level patterns to drop wherever they appear.
   * Useful for repeated page-footer copyright notices and similar
   * boilerplate that pdftotext interleaves throughout.
   */
  dropLinePatterns?: RegExp[];
}

const MANUAL_RECIPES: ManualRecipe[] = [
  {
    file: 'docs/devices/am4/manuals/AM4-Owners-Manual.txt',
    publisher: 'Fractal Audio Systems',
    title: 'AM4 Owner\'s Manual',
    copyrightYear: '2025',
    stripUntil: /^\s*AM4 in 60 Seconds\s*$/,
    stripFrom: /^\s*Warranty\s*$/i,
    dropLinePatterns: [
      /Contact sales@fractalaudio\.com to obtain a commercial license/,
      /^\s*©\s*\d{4}\s+Fractal Audio Systems/,
    ],
  },
  {
    file: 'docs/devices/axe-fx-ii/manuals/Axe-Fx-II-Owners-Manual.txt',
    publisher: 'Fractal Audio Systems',
    title: 'Axe-Fx II Owner\'s Manual',
    stripUntil: /^\s*TABLE OF CONTENTS\s*$/,
    stripFrom: /^\s*WARRANTY\s*$/i,
    dropLinePatterns: [
      /Contact sales@fractalaudio\.com to obtain a commercial license/,
    ],
  },
  {
    file: 'docs/devices/axe-fx-ii/manuals/Axe-Fx-II-Scenes-Mini-Manual-1.02.txt',
    publisher: 'Fractal Audio Systems',
    title: 'Axe-Fx II Scenes Mini-Manual v1.02',
  },
  {
    file: 'docs/devices/axe-fx-ii/manuals/Axe-Fx-II-Tone-Match-Manual.txt',
    publisher: 'Fractal Audio Systems',
    title: 'Axe-Fx II Tone Match Manual',
  },
  {
    file: 'docs/devices/axe-fx-ii/manuals/Axe-Fx-II-ir-capture.txt',
    publisher: 'Fractal Audio Systems',
    title: 'Axe-Fx II IR Capture Guide',
  },
  {
    file: 'docs/devices/axe-fx-ii/manuals/Axe-Fx_II_XL_MIDI_THRU_Guide.txt',
    publisher: 'Fractal Audio Systems',
    title: 'Axe-Fx II XL MIDI Thru Guide',
  },
  {
    file: 'docs/devices/axe-fx-iii/manuals/Axe-Fx-III-Owners-Manual.txt',
    publisher: 'Fractal Audio Systems',
    title: 'Axe-Fx III Owner\'s Manual',
    stripUntil: /^\s*TABLE OF CONTENTS\s*$/,
    stripFrom: /^\s*WARRANTY\s*$/i,
    dropLinePatterns: [
      /Contact sales@fractalaudio\.com to obtain a commercial license/,
    ],
  },
  {
    file: 'docs/devices/axe-fx-iii/manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.txt',
    publisher: 'Fractal Audio Systems',
    title: 'Axe-Fx III MIDI for 3rd-Party Devices',
  },
  {
    file: 'docs/manuals/Fractal-Audio-Blocks-Guide.txt',
    publisher: 'Fractal Audio Systems',
    title: 'Fractal Audio Blocks Guide',
  },
  {
    file: 'docs/manuals/Fractal-Audio-Systems-MIMIC-(tm)-Technology.txt',
    publisher: 'Fractal Audio Systems',
    title: 'MIMIC (tm) Speaker Simulation Technology',
    stripUntil: /^\s*Introduction\s*$/i,
  },
  {
    file: 'docs/devices/hydrasynth/manuals/Hydrasynth_Explorer_Owners_Manual_2.2.0.txt',
    publisher: 'Ashun Sound Machines (ASM)',
    title: 'Hydrasynth Explorer Owner\'s Manual v2.2.0',
  },
  {
    file: 'docs/devices/hydrasynth/manuals/Hydrasynth_KB_DR_Owners_Manual_2.2.0.txt',
    publisher: 'Ashun Sound Machines (ASM)',
    title: 'Hydrasynth Keyboard / Desktop / Deluxe Owner\'s Manual v2.2.0',
  },
];

function attribution(recipe: ManualRecipe): string {
  const yr = recipe.copyrightYear ? `Copyright (c) ${recipe.copyrightYear} ${recipe.publisher}.` : `Copyright (c) ${recipe.publisher}.`;
  return [
    SENTINEL,
    `Source: ${recipe.title} by ${recipe.publisher}.`,
    `${yr} All rights reserved.`,
    `This file contains selected technical reference content extracted under`,
    `fair-use interoperability research. Marketing, legal, and regulatory`,
    `front-matter / back-matter sections have been removed; the remaining`,
    `content is the technical reference relied on by the MCP MIDI Control`,
    `project for protocol decoding and tool authoring. See`,
    `docs/manuals/README.md for the policy.`,
    '',
    '---',
    '',
  ].join('\n');
}

function trimManual(recipe: ManualRecipe): { trimmed: boolean; stripped: number; reason?: string } {
  const fullPath = path.resolve(process.cwd(), recipe.file);
  if (!fs.existsSync(fullPath)) {
    return { trimmed: false, stripped: 0, reason: 'file not found' };
  }
  const original = fs.readFileSync(fullPath, 'utf8');
  if (original.includes(SENTINEL)) {
    return { trimmed: false, stripped: 0, reason: 'already trimmed' };
  }
  const originalLines = original.split(/\r?\n/);
  let lines = originalLines.slice();

  // 1. Strip front-matter up to (and including) the first stripUntil match.
  if (recipe.stripUntil) {
    const idx = lines.findIndex((l) => recipe.stripUntil!.test(l));
    if (idx >= 0) {
      lines = lines.slice(idx); // KEEP the boundary line (it's the start of the kept content)
    }
  }

  // 2. Strip back-matter from the first stripFrom match onward.
  if (recipe.stripFrom) {
    const idx = lines.findIndex((l) => recipe.stripFrom!.test(l));
    if (idx >= 0) {
      lines = lines.slice(0, idx);
    }
  }

  // 3. Drop line-level patterns wherever they appear.
  if (recipe.dropLinePatterns && recipe.dropLinePatterns.length > 0) {
    lines = lines.filter((l) => !recipe.dropLinePatterns!.some((p) => p.test(l)));
  }

  const stripped = originalLines.length - lines.length;
  const trimmedContent = attribution(recipe) + lines.join('\n');
  fs.writeFileSync(fullPath, trimmedContent);
  return { trimmed: true, stripped };
}

function main(): void {
  let total = 0;
  let trimmedFiles = 0;
  const skipped: string[] = [];
  for (const recipe of MANUAL_RECIPES) {
    const result = trimManual(recipe);
    if (result.trimmed) {
      trimmedFiles++;
      total += result.stripped;
      console.log(`  trimmed: ${recipe.file} (-${result.stripped} lines)`);
    } else {
      skipped.push(`${recipe.file} (${result.reason})`);
    }
  }
  console.log('');
  console.log(`Done. ${trimmedFiles} files trimmed; ${total} lines stripped total.`);
  if (skipped.length > 0) {
    console.log(`Skipped: ${skipped.length}`);
    for (const s of skipped) console.log(`  - ${s}`);
  }
}

main();
