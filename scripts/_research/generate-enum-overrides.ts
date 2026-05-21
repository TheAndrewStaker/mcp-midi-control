/**
 * Mechanical override-entry generator.
 *
 * Reads `samples/captured/probe-axefx2-enum-dump-findings.md` and emits
 * `ENUM_VALUE_OVERRIDES` entries ready to paste into
 * `scripts/extract-axe-fx-ii-params.ts` for every mismatch row where
 * the catalog has an existing label at that wire index. Skips rows
 * where catalog says `(absent)` — those need a generator extension
 * to ADD entries (not just override), tracked as a follow-up.
 *
 * Run:  npx tsx scripts/_research/generate-enum-overrides.ts
 *
 * Output is TypeScript source for the override entries, including
 * a per-block heuristic `note:` field categorizing the change as
 * casing / wiki typo / wrong-value.
 */

import { readFileSync } from 'node:fs';

const FINDINGS = 'samples/captured/probe-axefx2-enum-dump-findings.md';

interface Override {
  block: string;
  paramId: number;
  wireIndex: number;
  hardwareLabel: string;
  wikiLabel: string;
  note: string;
}

function classify(hw: string, wiki: string): string {
  if (hw.toUpperCase() === wiki.toUpperCase()) {
    return 'Wiki MIDI_SysEx page used title-case; device emits all-caps.';
  }
  if (hw.replace(/\s+/g, '').toUpperCase() === wiki.replace(/\s+/g, '').toUpperCase()) {
    return 'Wiki MIDI_SysEx page has whitespace artifact; device label is clean.';
  }
  if (hw.length > wiki.length && hw.toUpperCase().includes(wiki.toUpperCase())) {
    return `Wiki MIDI_SysEx page truncated/abbreviated label; device emits full form (${JSON.stringify(hw)}).`;
  }
  if (wiki.length > hw.length && wiki.toUpperCase().includes(hw.toUpperCase())) {
    return `Wiki MIDI_SysEx page added a prefix/suffix not on device; device label is ${JSON.stringify(hw)}.`;
  }
  return `Wiki MIDI_SysEx page had wrong label; device emits ${JSON.stringify(hw)}.`;
}

function main(): void {
  const text = readFileSync(FINDINGS, 'utf8');
  const overrides: Override[] = [];
  const sections = text.split(/^### /m).slice(1);
  for (const section of sections) {
    const headerMatch = /^([a-z_]+)\.([a-z_0-9]+)\s+\(effId=(\d+),\s*paramId=(\d+)\)/.exec(section);
    if (!headerMatch) continue;
    const block = headerMatch[1];
    const paramId = Number(headerMatch[4]);
    const tableStart = section.indexOf('**Mismatches:**');
    if (tableStart < 0) continue;
    const tableText = section.slice(tableStart);
    const rowRe = /^\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(tableText)) !== null) {
      const idx = Number(m[1]);
      const hw = m[2].trim();
      const wiki = m[3].trim();
      if (wiki === '(absent)') continue;
      if (hw === wiki) continue;
      overrides.push({
        block,
        paramId,
        wireIndex: idx,
        hardwareLabel: hw,
        wikiLabel: wiki,
        note: classify(hw, wiki),
      });
    }
  }

  console.log(`// Auto-generated from ${FINDINGS}`);
  console.log(`// ${overrides.length} override entries (mismatches with existing catalog wireIndex).`);
  console.log(``);
  for (const o of overrides) {
    console.log(`  {`);
    console.log(`    block: ${JSON.stringify(o.block)}, paramId: ${o.paramId}, wireIndex: ${o.wireIndex},`);
    console.log(`    hardwareLabel: ${JSON.stringify(o.hardwareLabel)}, wikiLabel: ${JSON.stringify(o.wikiLabel)},`);
    console.log(`    note: ${JSON.stringify(o.note)},`);
    console.log(`  },`);
  }
  console.log(``);
  console.log(`// Total override entries: ${overrides.length}`);

  // Skipped — needs catalog-extension support in generator.
  const text2 = readFileSync(FINDINGS, 'utf8');
  const sections2 = text2.split(/^### /m).slice(1);
  const missingEntries: { block: string; paramId: number; idx: number; hw: string }[] = [];
  for (const section of sections2) {
    const hm = /^([a-z_]+)\.([a-z_0-9]+)\s+\(effId=(\d+),\s*paramId=(\d+)\)/.exec(section);
    if (!hm) continue;
    const block = hm[1];
    const paramId = Number(hm[4]);
    const tableStart = section.indexOf('**Mismatches:**');
    if (tableStart < 0) continue;
    const tableText = section.slice(tableStart);
    const rowRe = /^\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|\s*\(absent\)\s*\|\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(tableText)) !== null) {
      missingEntries.push({ block, paramId, idx: Number(m[1]), hw: m[2].trim() });
    }
  }
  console.log(``);
  console.log(`// === SKIPPED: ${missingEntries.length} catalog-missing entries ===`);
  console.log(`// These need a generator extension to ADD new wireIndexes (not just`);
  console.log(`// override existing labels). Tracked as follow-up.`);
  for (const e of missingEntries) {
    console.log(`//   ${e.block}.paramId=${e.paramId} idx ${e.idx}: ${JSON.stringify(e.hw)}`);
  }
}

main();
