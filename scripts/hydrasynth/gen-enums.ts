/**
 * Hydrasynth Explorer — generate src/asm/hydrasynth-explorer/enums.ts
 * from edisyn's ASMHydrasynth.java.
 *
 * Source:
 *   docs/devices/hydrasynth-explorer/references/ASMHydrasynth.java
 *   (vendored from https://github.com/eclab/edisyn — Apache-2.0,
 *    © Sean Luke / GMU; see references/README.md for attribution)
 *
 * Output:
 *   src/asm/hydrasynth-explorer/enums.ts
 *
 * What this delivers: 49 named lookup tables — wave names (218+ waves),
 * filter types (16 + 2), FX types (10), mutant modes (8), envelope
 * triggers, ARP modes, vibrato rates, etc. Edisyn's NRPN spreadsheet
 * references these by ALL_CAPS names; this file makes them addressable
 * at runtime so Claude can write "filter1type=Vowel" instead of
 * "filter1type=10".
 *
 * Run:  npm run hydra:gen-enums
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.resolve(
  __dirname,
  '../../docs/devices/hydrasynth-explorer/references/ASMHydrasynth.java',
);
const OUTPUT_PATH = path.resolve(
  __dirname,
  '../../packages/hydrasynth/src/enums.ts',
);

interface JavaArrayLiteral {
  name: string;
  values: string[];
}

/**
 * Parse Java `static final String[] NAME = { "a", "b", ... };` declarations.
 * Handles multi-line arrays (OSC_WAVES is huge) and trailing commas.
 * Skips line / block comments inside the array body.
 */
function parseJavaStringArrays(text: string): JavaArrayLiteral[] {
  const out: JavaArrayLiteral[] = [];
  // Matches: static [final] String[] NAME = { ... };  (multi-line OK)
  const re = /static\s+(?:final\s+)?String\[\]\s+([A-Z_0-9]+)\s*=\s*\{([\s\S]*?)\}\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1]!;
    const body = m[2]!;
    // Strip line comments (`// ...` to end of line).
    const stripped = body.replace(/\/\/[^\n]*/g, '');
    // Pull every double-quoted string literal in order.
    const stringRe = /"((?:[^"\\]|\\.)*)"/g;
    const values: string[] = [];
    let s: RegExpExecArray | null;
    while ((s = stringRe.exec(stripped)) !== null) {
      values.push(s[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    }
    out.push({ name, values });
  }
  return out;
}

function main(): void {
  const raw = fs.readFileSync(SOURCE_PATH, 'utf8');
  const tables = parseJavaStringArrays(raw);

  // Sanity: a few expected tables should be present at expected sizes.
  const checks: Array<{ name: string; minLen: number }> = [
    { name: 'BANKS', minLen: 8 },
    { name: 'FILTER_1_TYPES', minLen: 16 },
    { name: 'FILTER_2_TYPES', minLen: 2 },
    { name: 'FX_TYPES', minLen: 10 },
    { name: 'OSC_WAVES', minLen: 200 },
    { name: 'MUTANT_MODES', minLen: 8 },
  ];
  for (const c of checks) {
    const t = tables.find((x) => x.name === c.name);
    if (!t) throw new Error(`expected enum table ${c.name} not found in source`);
    if (t.values.length < c.minLen) {
      throw new Error(`enum table ${c.name} has ${t.values.length} values, expected at least ${c.minLen}`);
    }
  }

  // Sort tables alphabetically for stable diffs.
  tables.sort((a, b) => a.name.localeCompare(b.name));

  const lines: string[] = [];
  lines.push('// AUTO-GENERATED FILE — do not edit by hand.');
  lines.push('// Source:  docs/devices/hydrasynth-explorer/references/ASMHydrasynth.java');
  lines.push('// Regen:   npm run hydra:gen-enums');
  lines.push('//');
  lines.push('// Vendored from eclab/edisyn (Apache-2.0, © Sean Luke / GMU).');
  lines.push('// See docs/devices/hydrasynth-explorer/references/README.md.');
  lines.push('//');
  lines.push('// Each map is keyed by numeric index → display name. Used by the');
  lines.push('// NRPN write tools to resolve user-supplied names ("Vowel", "Sine",');
  lines.push("// \"Lo-Fi\") to the integer the device expects. Edisyn's NRPN");
  lines.push('// spreadsheet references these by ALL_CAPS_WITH_UNDERSCORES names');
  lines.push('// in the Range/Notes column.');
  lines.push('');
  lines.push('export type HydrasynthEnum = Readonly<Record<number, string>>;');
  lines.push('');

  for (const t of tables) {
    lines.push(`export const ${t.name}: HydrasynthEnum = {`);
    for (let i = 0; i < t.values.length; i++) {
      lines.push(`  ${i}: ${JSON.stringify(t.values[i])},`);
    }
    lines.push('};');
    lines.push('');
  }

  // Lookup-by-name registry so callers can pull a table by its enum
  // table name without a hard-coded import per table.
  lines.push('export const HYDRASYNTH_ENUMS: Readonly<Record<string, HydrasynthEnum>> = {');
  for (const t of tables) {
    lines.push(`  ${t.name},`);
  }
  lines.push('};');
  lines.push('');

  lines.push('/**');
  lines.push(' * Resolve a user-supplied value to a numeric index in the named enum.');
  lines.push(' * Accepts numeric input directly, exact name match, and a relaxed');
  lines.push(' * case-insensitive match after collapsing non-alphanumerics — so');
  lines.push(' * "Lo-Fi", "lofi", "lo fi", and 5 all resolve the same FX_TYPES entry.');
  lines.push(' * Returns undefined if the input is unknown or the enum does not exist.');
  lines.push(' */');
  lines.push('export function resolveHydraEnum(enumName: string, input: number | string): number | undefined {');
  lines.push('  const table = HYDRASYNTH_ENUMS[enumName];');
  lines.push('  if (!table) return undefined;');
  lines.push("  if (typeof input === 'number') {");
  lines.push('    return table[input] !== undefined ? input : undefined;');
  lines.push('  }');
  lines.push('  const trimmed = input.trim();');
  lines.push("  if (trimmed === '') return undefined;");
  lines.push('  for (const [idx, name] of Object.entries(table)) {');
  lines.push('    if (name === trimmed) return Number(idx);');
  lines.push('  }');
  lines.push("  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();");
  lines.push('  const target = normalize(trimmed);');
  lines.push('  for (const [idx, name] of Object.entries(table)) {');
  lines.push('    if (normalize(name) === target) return Number(idx);');
  lines.push('  }');
  lines.push('  // Substring fallback: unique partial match on either side.');
  lines.push('  const hits: number[] = [];');
  lines.push('  for (const [idx, name] of Object.entries(table)) {');
  lines.push('    const n = normalize(name);');
  lines.push('    if (n.includes(target) || target.includes(n)) hits.push(Number(idx));');
  lines.push('  }');
  lines.push('  return hits.length === 1 ? hits[0] : undefined;');
  lines.push('}');
  lines.push('');

  fs.writeFileSync(OUTPUT_PATH, lines.join('\n'), 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
  console.log(`  tables: ${tables.length}`);
  let totalEntries = 0;
  for (const t of tables) totalEntries += t.values.length;
  console.log(`  total entries: ${totalEntries}`);
  for (const c of checks) {
    const t = tables.find((x) => x.name === c.name)!;
    console.log(`  ${c.name.padEnd(28)} ${t.values.length} entries`);
  }
}

main();
