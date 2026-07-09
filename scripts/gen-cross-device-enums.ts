/**
 * Generator: mine high-confidence AM4 ↔ Axe-Fx II enum name pairs from the
 * Axe-Fx II lineage JSON into `cross-device-enums.generated.ts`.
 *
 * WHY: translate_preset left model names unmapped (`enums_mapped: 0`) whenever
 * the AM4 and II strings are too far apart for the Phase-1 fuzzy matcher
 * (Levenshtein ≤ 2). The II lineage records (`axefx2-<block>-lineage.json`)
 * carry both `axefx2Name` (the II enum string) and `am4Name` (the matched AM4
 * model), so they are a ready cross-roster source — but `am4Name` is LINEAGE
 * PROSE, not guaranteed to be a real AM4 device-enum string. Emitting it
 * blindly would produce rows whose `am4` column the AM4 codec rejects, which
 * is worse than leaving the model unmapped.
 *
 * SAFETY GATES (every emitted row passes all):
 *   1. `axefx2Name` is an EXACT (case-insensitive) member of the II device
 *      enum (`*_EFFECT_TYPE_VALUES`). Canonical II string is stored.
 *   2. `am4Name` resolves to an EXACT (case-insensitive) member of the AM4
 *      device enum (`*_TYPES`). Canonical AM4 string is stored. No fuzzy AM4
 *      resolution — prose that isn't a real enum member is dropped.
 *   3. normalized Levenshtein(am4, ii) > 2 — Phase-1 fuzzy already handles
 *      anything closer, so only the pairs it CANNOT reconcile are emitted.
 *   4. Not already covered by the hand-curated CROSS_DEVICE_ENUMS (hand table
 *      wins; the generated set is purely additive).
 *
 * Run: `npm run gen:cross-device-enums`. It writes a file ONLY when it finds
 * safe rows; today it emits 0 (the hand table is already complete), so no
 * generated file is committed and there is no CI diff-gate yet. If a future
 * lineage update yields rows, add a verify step that re-runs this generator
 * and diffs the committed output before wiring the merge into runtime.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AMP_TYPES, DRIVE_TYPES, REVERB_TYPES } from 'fractal-midi/am4';
import {
  AMP_EFFECT_TYPE_VALUES,
  DRIVE_EFFECT_TYPE_VALUES,
  REVERB_EFFECT_TYPE_VALUES,
} from 'fractal-midi/gen2/axe-fx-ii';
import { CROSS_DEVICE_ENUMS } from '@mcp-midi-control/core/protocol-generic/cross-device-enums.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const LINEAGE_DIR = join(REPO, 'packages/fractal-midi/src/shared/lineage');
const OUT = join(REPO, 'packages/core/src/protocol-generic/cross-device-enums.generated.ts');

interface Block {
  block: 'amp' | 'drive' | 'reverb';
  lineageFile: string;
  am4Enum: readonly string[];
  iiEnum: readonly string[];
}
const BLOCKS: Block[] = [
  { block: 'amp', lineageFile: 'axefx2-amp-lineage.json', am4Enum: AMP_TYPES, iiEnum: Object.values(AMP_EFFECT_TYPE_VALUES) },
  { block: 'drive', lineageFile: 'axefx2-drive-lineage.json', am4Enum: DRIVE_TYPES, iiEnum: Object.values(DRIVE_EFFECT_TYPE_VALUES) },
  { block: 'reverb', lineageFile: 'axefx2-reverb-lineage.json', am4Enum: REVERB_TYPES, iiEnum: Object.values(REVERB_EFFECT_TYPE_VALUES) },
];

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

function levenshtein(a: string, b: string): number {
  a = a.replace(/\s+/g, ''); b = b.replace(/\s+/g, '');
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Exact (case-insensitive) enum membership → the canonical device string. */
function canonicalize(name: string, deviceEnum: readonly string[]): string | undefined {
  const n = norm(name);
  return deviceEnum.find((v) => norm(v) === n);
}

// Values already covered by the hand-curated table, per block (normalized).
const handCovered = new Map<string, Set<string>>();
for (const row of Object.values(CROSS_DEVICE_ENUMS)) {
  const set = handCovered.get(row.block) ?? new Set<string>();
  if (row.am4) set.add(norm(row.am4));
  if (row.axeFxII) set.add(norm(row.axeFxII));
  handCovered.set(row.block, set);
}

interface LineageRec { axefx2Name?: string; am4Name?: string; matchVia?: string; basedOn?: { primary?: string } }
interface GenRow { conceptKey: string; block: string; am4: string; axeFxII: string; description: string }

const rows: GenRow[] = [];
const seenKeys = new Set<string>();
const stats: Record<string, { scanned: number; emitted: number }> = {};

for (const { block, lineageFile, am4Enum, iiEnum } of BLOCKS) {
  const parsed = JSON.parse(readFileSync(join(LINEAGE_DIR, lineageFile), 'utf8')) as { records?: LineageRec[] };
  const recs = parsed.records ?? [];
  stats[block] = { scanned: recs.length, emitted: 0 };
  const covered = handCovered.get(block) ?? new Set<string>();

  for (const r of recs) {
    if (!r.axefx2Name || !r.am4Name) continue;
    if (r.matchVia === 'unmatched') continue;            // no reliable AM4 link
    const iiCanon = canonicalize(r.axefx2Name, iiEnum);
    const am4Canon = canonicalize(r.am4Name, am4Enum);   // exact device-enum member only
    if (iiCanon === undefined || am4Canon === undefined) continue;
    if (levenshtein(norm(am4Canon), norm(iiCanon)) <= 2) continue; // Phase-1 fuzzy handles it
    if (covered.has(norm(am4Canon)) || covered.has(norm(iiCanon))) continue;
    const conceptKey = `gen-${block}-${norm(am4Canon).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
    if (seenKeys.has(conceptKey)) continue;              // dedupe many-II-to-one-AM4
    seenKeys.add(conceptKey);
    covered.add(norm(am4Canon)); covered.add(norm(iiCanon));
    rows.push({
      conceptKey, block, am4: am4Canon, axeFxII: iiCanon,
      description: r.basedOn?.primary ? `${r.basedOn.primary} (lineage-derived)` : 'lineage-derived AM4↔II pair',
    });
    stats[block].emitted++;
  }
}

rows.sort((a, b) => (a.block === b.block ? a.am4.localeCompare(b.am4) : a.block.localeCompare(b.block)));

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const body = rows
  .map((r) =>
    `  '${r.conceptKey}': Object.freeze({\n` +
    `    block: '${r.block}', paramName: 'type',\n` +
    `    am4: '${esc(r.am4)}', axeFxII: '${esc(r.axeFxII)}', axeFxIII: null,\n` +
    `    description: '${esc(r.description)}',\n` +
    `  }),`,
  )
  .join('\n');

const out =
`/**
 * GENERATED FILE — do not edit by hand.
 *
 * Produced by \`npm run gen:cross-device-enums\` (scripts/gen-cross-device-enums.ts).
 * Re-run that generator after changing the lineage JSON, then review this diff.
 * NOTE: no CI diff-gate exists yet — add one before relying on this file.
 *
 * High-confidence AM4 ↔ Axe-Fx II enum name pairs mined from the II lineage
 * JSON. Every row's \`am4\` and \`axeFxII\` are EXACT members of their device's
 * runtime enum, and their normalized Levenshtein distance is > 2 (the Phase-1
 * fuzzy matcher cannot reconcile them). Rows already covered by the
 * hand-curated CROSS_DEVICE_ENUMS are excluded — this set is purely additive.
 *
 * Source records: ${BLOCKS.map((b) => `${b.block}=${stats[b.block].scanned}`).join(', ')}.
 * Emitted rows: ${rows.length} (${BLOCKS.map((b) => `${b.block}=${stats[b.block].emitted}`).join(', ')}).
 */
import type { CrossDeviceEnumRow } from './cross-device-enums.js';

export const CROSS_DEVICE_ENUMS_GENERATED: Readonly<Record<string, CrossDeviceEnumRow>> =
  Object.freeze({
${body}
  });
`;

if (rows.length > 0) {
  writeFileSync(OUT, out, 'utf8');
  console.log(`gen-cross-device-enums: wrote ${rows.length} rows → ${OUT}`);
  console.log('  NOTE: a generated file now exists — wire it into cross-device-enums.ts');
  console.log('  (merge CROSS_DEVICE_ENUMS_GENERATED into the reverse index, hand table wins)');
} else {
  console.log('gen-cross-device-enums: 0 safe rows to emit — no file written.');
  console.log('  The hand-curated CROSS_DEVICE_ENUMS already covers every AM4↔II pair that');
  console.log('  (a) validates against both device enums and (b) is > Levenshtein 2 apart');
  console.log('  (the pairs Phase-1 fuzzy cannot reconcile). Models still unmapped by');
  console.log('  translate_preset are not safely auto-mappable — they need manual AxeEdit +');
  console.log('  AM4-panel verification, which the misroute-safety policy withholds here.');
}
for (const b of BLOCKS) console.log(`  ${b.block}: ${stats[b.block].emitted} emitted / ${stats[b.block].scanned} scanned`);
