/**
 * Generator: ASM Hydrasynth mod-matrix + macro routing name/wire DATA tables.
 *
 * Emits DATA ONLY (the wire-value maps + ordered name arrays) into
 * `packages/hydrasynth/src/modRoutingTables.ts`. The resolver logic
 * (norm / aliasNorm / resolveModSource / resolveModDest / sample*) lives in
 * the hand-authored `packages/hydrasynth/src/modRouting.ts`, which re-exports
 * these tables. Keeping logic out of the generated file avoids the
 * code-generation escaping hazard (a regex backreference like `$1` does not
 * survive being emitted through a template) and keeps the generated artifact
 * pure data.
 *
 * Source of truth: the edisyn reference editor `ASMHydrasynth.java`
 * (Apache-2.0, (c) Sean Luke / GMU) - the SAME file the shipped 1655-param
 * `nrpn.csv` catalog was distilled from. Four parallel arrays:
 *
 *   MOD_SOURCES[i]                 -> human label for mod source index i
 *   MOD_SOURCE_NRPN_VALUES[i]      -> 14-bit wire value for that source
 *   MOD_DESTINATIONS[i]            -> human label for mod destination index i
 *   MOD_DESTINATION_NRPN_VALUES[i] -> 14-bit wire value for that destination
 *
 * Wire fact: the device distinguishes a route's source field from its target
 * field by the category prefix in the high byte of the 14-bit value (sources
 * carry 0x01/0x03 prefixes, destinations carry 0x02/0x04/0x05), NOT by a
 * separate NRPN register. So set_param must send the wire VALUE, never the
 * list index.
 *
 * Run: npx tsx scripts/hydrasynth/generate-mod-routing.ts
 *
 * Robustness: length-equality of names vs values is asserted per table, plus
 * six byte-exact anchor checks, so a future regen that shifts an array fails
 * the build before any wire bytes ship.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SRC = resolve(REPO, 'docs/_private/devices/hydrasynth-explorer/references/ASMHydrasynth.java');
const OUT = resolve(REPO, 'packages/hydrasynth/src/modRoutingTables.ts');

const java = readFileSync(SRC, 'utf8');
const lines = java.split(/\r?\n/);

/**
 * Extract the body lines of the Java array `TYPE[] NAME = { ... }` by line
 * scan. Anchoring on the TYPE prefix (`String[] NAME` / `int[] NAME`) stops
 * `MOD_SOURCES` from matching inside `RING_MOD_SOURCES` (the "RING_" sits
 * between, so `String[] MOD_SOURCES` is not a substring of
 * `String[] RING_MOD_SOURCES`). The `= null;` HashMap forward-declarations
 * carry different names and aren't `String[]`/`int[]`, so they're skipped.
 */
function extractBlock(name: string, kind: 'String' | 'int', mustContain: RegExp): string {
  const declRe = new RegExp(`${kind}\\[\\]\\s+${name}\\s*=`);
  for (let i = 0; i < lines.length; i++) {
    if (!declRe.test(lines[i]!)) continue;
    let j = i;
    while (j < lines.length && !lines[j]!.includes('{')) j++;
    if (j >= lines.length) continue;
    const body: string[] = [];
    for (let k = j + 1; k < lines.length; k++) {
      if (/^\s*\}\s*;?\s*$/.test(lines[k]!)) {
        const joined = body.join('\n');
        if (mustContain.test(joined)) return joined;
        break;
      }
      body.push(lines[k]!);
    }
  }
  throw new Error(`generate-mod-routing: no populated ${kind}[] block found for ${name}`);
}

/** Parse a Java String[] body into an ordered list of labels. */
function parseStrings(body: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1]!.replace(/\\"/g, '"'));
  return out;
}

/**
 * Parse a Java int[] body of `0xNN * 128 + 0xNN` (or decimal) expressions
 * into integers. We evaluate the arithmetic rather than copy the literal, so
 * a hand-typo in one factor can't silently pass.
 */
function parseValues(body: string): number[] {
  const out: number[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    for (const piece of line.split(',')) {
      const expr = piece.trim();
      if (!expr) continue;
      const mul = /^(0x[0-9a-fA-F]+|\d+)\s*\*\s*128\s*\+\s*(0x[0-9a-fA-F]+|\d+)$/.exec(expr);
      const bare = /^(0x[0-9a-fA-F]+|\d+)$/.exec(expr);
      if (mul) {
        out.push(Number(mul[1]) * 128 + Number(mul[2]));
      } else if (bare) {
        out.push(Number(bare[1]));
      } else {
        throw new Error(`generate-mod-routing: unparseable value expression "${expr}"`);
      }
    }
  }
  return out;
}

const sourceNames = parseStrings(extractBlock('MOD_SOURCES', 'String', /"/));
const sourceValues = parseValues(extractBlock('MOD_SOURCE_NRPN_VALUES', 'int', /0x/));
const destNames = parseStrings(extractBlock('MOD_DESTINATIONS', 'String', /"/));
const destValues = parseValues(extractBlock('MOD_DESTINATION_NRPN_VALUES', 'int', /0x/));
// Per-destination device CATEGORY ids (parallel to MOD_DESTINATIONS). The
// PATCH IMAGE stores a route's destination as (linear index, category id)
// across two regions (SysexPatchFormat.txt 966+/1030+), so the category
// array is load-bearing for apply_patch route persistence, not just UI.
const destCategories = parseValues(extractBlock('MOD_DESTINATION_CATEGORIES', 'int', /\d/));

// Hard correctness gates.
if (sourceNames.length !== sourceValues.length) {
  throw new Error(`generate-mod-routing: MOD_SOURCES (${sourceNames.length}) != MOD_SOURCE_NRPN_VALUES (${sourceValues.length})`);
}
if (destNames.length !== destValues.length) {
  throw new Error(`generate-mod-routing: MOD_DESTINATIONS (${destNames.length}) != MOD_DESTINATION_NRPN_VALUES (${destValues.length})`);
}
if (destNames.length !== destCategories.length) {
  throw new Error(`generate-mod-routing: MOD_DESTINATIONS (${destNames.length}) != MOD_DESTINATION_CATEGORIES (${destCategories.length})`);
}
// Category anchors, validated against the 1024-image flash-corpus census
// (2026-08-22): every (category, linear-index) pair observed on factory
// patches matched these parallel arrays.
function assertCategoryAnchor(name: string, expectCat: number): void {
  const idx = destNames.indexOf(name);
  if (idx < 0) throw new Error(`generate-mod-routing: category anchor "${name}" not found`);
  if (destCategories[idx] !== expectCat) {
    throw new Error(`generate-mod-routing: category anchor "${name}" cat ${destCategories[idx]} != expected ${expectCat}`);
  }
}
assertCategoryAnchor('Mut 1 Depth', 6);
assertCategoryAnchor('Filt 1 Cutoff', 12);
assertCategoryAnchor('Reverb Dry/Wet', 17);
assertCategoryAnchor('Noise Vol', 11);
function assertAnchor(table: 'src' | 'dest', name: string, expectWire: number): void {
  const names = table === 'src' ? sourceNames : destNames;
  const values = table === 'src' ? sourceValues : destValues;
  const idx = names.indexOf(name);
  if (idx < 0) throw new Error(`generate-mod-routing: anchor "${name}" not found in ${table}`);
  if (values[idx] !== expectWire) {
    throw new Error(`generate-mod-routing: anchor "${name}" wire ${values[idx]} != expected ${expectWire}`);
  }
}
assertAnchor('src', 'Off', 0x01 * 128 + 0x00);
assertAnchor('src', 'Env 1', 0x01 * 128 + 0x01); // 129
assertAnchor('src', 'Mod Wheel', 0x01 * 128 + 0x18);
assertAnchor('dest', 'Off', 0x02 * 128 + 0x00);
assertAnchor('dest', 'Osc 1 Pitch', 0x04 * 128 + 0x01); // 513
assertAnchor('dest', 'Filt 1 Cutoff', 0x02 * 128 + 0x28);

function emitMap(names: string[], values: number[]): { body: string; collisions: number } {
  // Wire value -> label. Some labels share a wire value (the device's own
  // aliasing, e.g. "CC 64 / Sustain" appears in both the dedicated source
  // slot and the CC list). First label wins so the object literal has unique
  // keys. The ordered NAMES arrays below keep every entry.
  const seen = new Set<number>();
  const out: string[] = [];
  let collisions = 0;
  for (let i = 0; i < names.length; i++) {
    const wire = values[i]!;
    if (seen.has(wire)) { collisions++; continue; }
    seen.add(wire);
    out.push(`  ${wire}: ${JSON.stringify(names[i])},`);
  }
  return { body: out.join('\n'), collisions };
}

const srcMap = emitMap(sourceNames, sourceValues);
const destMap = emitMap(destNames, destValues);

// Assemble the output by string concatenation (no template-literal escaping
// hazard, since this file emits only data, never regex / backreferences).
const out: string[] = [];
out.push('// AUTO-GENERATED FILE - do not edit by hand.');
out.push('// Source:  docs/_private/devices/hydrasynth-explorer/references/ASMHydrasynth.java');
out.push('//          (edisyn, Apache-2.0, (c) Sean Luke / GMU - same vendored reference');
out.push('//           the shipped nrpn.csv catalog was distilled from).');
out.push('// Regen:   npx tsx scripts/hydrasynth/generate-mod-routing.ts');
out.push('//');
out.push('// Mod-matrix SOURCE / DESTINATION name->wire tables. The wire value is the');
out.push('// 14-bit number the device expects in modmatrix<N>modsource / modtarget and');
out.push('// macro<N>target<S> NRPN data fields. It is NOT the list index; the device');
out.push("// reads the value's category prefix (high byte) to know which field it is.");
out.push('// Resolvers (name lookup, friendly aliases) live in the hand-authored');
out.push('// modRouting.ts, which re-exports everything here.');
out.push('//');
out.push(`// Counts at generation: ${sourceNames.length} sources, ${destNames.length} destinations.`);
out.push('');
out.push('/** Mod SOURCE wire value -> display label (for decode / list_params). */');
out.push('export const MOD_SOURCE_BY_WIRE: Readonly<Record<number, string>> = Object.freeze({');
out.push(srcMap.body);
out.push('});');
out.push('');
out.push('/** Mod DESTINATION wire value -> display label (for decode / list_params). */');
out.push('export const MOD_DEST_BY_WIRE: Readonly<Record<number, string>> = Object.freeze({');
out.push(destMap.body);
out.push('});');
out.push('');
out.push('/** Ordered SOURCE labels (index = edisyn list position; for discovery UIs). */');
out.push(`export const MOD_SOURCE_NAMES: readonly string[] = Object.freeze(${JSON.stringify(sourceNames)});`);
out.push('');
out.push('/** Ordered DESTINATION labels (index = edisyn list position; for discovery UIs). */');
out.push(`export const MOD_DEST_NAMES: readonly string[] = Object.freeze(${JSON.stringify(destNames)});`);
out.push('');
out.push('/**');
out.push(' * Per-destination device CATEGORY id, parallel to MOD_DEST_NAMES. The patch');
out.push(' * IMAGE stores a route destination as (linear index @966+/1222+, category');
out.push(' * @1030+/1478+) - see SysexPatchFormat.txt and the 2026-08-22 corpus census.');
out.push(' */');
out.push(`export const MOD_DEST_CATEGORIES: readonly number[] = Object.freeze(${JSON.stringify(destCategories)});`);
out.push('');

writeFileSync(OUT, out.join('\n'), 'utf8');
console.log(
  `generate-mod-routing: wrote ${OUT}\n` +
    `  ${sourceNames.length} sources (${srcMap.collisions} wire-collision(s)), Env 1 -> ${sourceValues[sourceNames.indexOf('Env 1')]}\n` +
    `  ${destNames.length} destinations (${destMap.collisions} wire-collision(s)), ` +
    `Osc 1 Pitch -> ${destValues[destNames.indexOf('Osc 1 Pitch')]}, ` +
    `Filt 1 Cutoff -> ${destValues[destNames.indexOf('Filt 1 Cutoff')]}`,
);
