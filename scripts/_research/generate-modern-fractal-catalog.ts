/**
 * Generate a committed device-true param catalog (`.ts`) for a modern-
 * Fractal device (FM3 / FM9 / VP4) from its mined device-true JSON.
 *
 * Mirrors how the Axe-Fx III's `params.ts` ships: this generator runs
 * OFFLINE (reading the gitignored
 * `samples/captured/decoded/modern-fractal-devicetrue-<dev>.json`) and
 * emits a committed `.ts` module. CI never regenerates; the `.ts` is the
 * source of truth once committed.
 *
 * paramId provenance: the device's OWN editor binary (validated 100% vs
 * the III Ghidra control). NOT reused from the III — reuse mis-addresses
 * FM3 6.9% / FM9 18.6% / VP4 99.5% of shared params. See primitives
 * `_negative/gen3-paramid-reuse-across-model-bytes` and
 * `docs/_private/MINING-FINDINGS-FM-VP4.md`.
 *
 * Display calibration: the SAME AM4 symbol-name overlay the III catalog
 * uses (`./axefx3-am4-overrides.ts`) is applied here. The join is by
 * `(family, SCREAMING_SNAKE name)` and is device-agnostic — FM3/FM9 share
 * the III's Fractal naming convention, so an `amp.gain` display range
 * verified on the AM4 ports cleanly onto FM3/FM9's device-true paramId for
 * the same symbol. Wire addressing stays device-true (paramId from this
 * device's own editor binary); only the user-facing display shape is
 * inherited. Entries with no AM4 / convention / XML match stay
 * `unit: 'unverified'` (raw 16-bit wire passthrough), same as the III.
 *
 * Guardrails (this is a data + plumbing change, not a wire change):
 *   - paramId stays device-true (mined from THIS device's editor binary).
 *   - calibration is inherited by symbol name, never by paramId.
 *   - paramId === null entries (roster-only, no wire id) are excluded.
 *
 * Usage:
 *   npx tsx scripts/_research/generate-modern-fractal-catalog.ts <dev> <CONST_PREFIX>
 * Example:
 *   npx tsx scripts/_research/generate-modern-fractal-catalog.ts fm3 FM3
 *   -> packages/fractal-midi/src/gen3/fm3/params.ts
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  findAm4Override,
  loadAm4ParamOverrides,
  loadXmlLabels,
  type Am4Override,
} from './axefx3-am4-overrides.js';

const dev = process.argv[2];
const prefix = process.argv[3];
if (!dev || !prefix) {
  console.error('usage: generate-modern-fractal-catalog.ts <dev> <CONST_PREFIX>');
  process.exit(1);
}

interface DTParam {
  family: string;
  name: string;
  paramId: number | null;
  paramIdSource: string;
  displayLabel?: string;
  controlType: string;
  iiiParamId?: number;
  reuseWouldMisaddress?: boolean;
}
const src = JSON.parse(
  readFileSync(`samples/captured/decoded/modern-fractal-devicetrue-${dev}.json`, 'utf-8'),
) as { summary: Record<string, unknown>; params: DTParam[] };

// Keep only wire-addressable entries (have a device-true paramId), sort
// stably (family asc, paramId asc, name asc) for byte-stable regen.
const wire = src.params
  .filter((p) => p.paramId !== null && p.paramId !== undefined)
  .sort(
    (a, b) =>
      a.family.localeCompare(b.family) ||
      (a.paramId! - b.paramId!) ||
      a.name.localeCompare(b.name),
  );

// Reuse-audit numbers for the header (how wrong the III stopgap was).
const sharedAudited = src.params.filter((p) => p.reuseWouldMisaddress !== undefined);
const reuseWrong = sharedAudited.filter((p) => p.reuseWouldMisaddress === true);

const families = [...new Set(wire.map((p) => p.family))].sort();

// AM4 symbol-name calibration overlay — the SAME resolver the III catalog
// uses. The join is by (family, SCREAMING_SNAKE name), which is shared
// across the gen-3 family, so the AM4's hardware-verified display ranges
// inherit onto this device's device-true paramIds. Loaded once.
const am4Overrides = loadAm4ParamOverrides();
const xmlLabels = loadXmlLabels();

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
function fmtNum(n: number): string {
  return String(n);
}

/**
 * Resolve the AM4-overlay calibration for one device-true param. Returns
 * undefined when no calibration tier matched (unit stays 'unverified'). A
 * label-only XML synthetic (unit === 'unverified' but carries a displayLabel)
 * is treated as no-calibration here — FM3/FM9 already carry the device's own
 * displayLabel, so we don't need the III XML label.
 */
function calibrationOf(p: DTParam): Am4Override | undefined {
  const ov = findAm4Override(p.family, p.name, am4Overrides, xmlLabels);
  return ov && ov.unit !== 'unverified' ? ov : undefined;
}

function provComment(ov: Am4Override): string {
  switch (ov.source) {
    case 'am4': return 'inferred from AM4';
    case 'universal': return 'inferred from Fractal convention';
    case 'xml': return 'inferred from AxeEdit III XML controlType';
    default: return 'inferred';
  }
}

function entry(p: DTParam): string {
  const ov = calibrationOf(p);
  // Prefer the device's OWN mined label; fall back to the overlay's label.
  const labelText =
    p.displayLabel !== undefined && p.displayLabel.length > 0
      ? p.displayLabel
      : ov?.displayLabel;
  const label = labelText ? `, displayLabel: '${esc(labelText)}'` : '';

  // unit / range clause, mirroring the III generator's emit rules:
  //   - no calibration            -> unit: 'unverified' (raw wire passthrough)
  //   - enum                      -> unit: 'enum' (no range; vocab is device-specific)
  //   - unit but no range (XML)   -> unit: '<unit>'
  //   - unit + range              -> unit, displayMin, displayMax, [scaling]
  let unitClause: string;
  let prov = '';
  if (!ov) {
    unitClause = `unit: 'unverified'`;
  } else if (ov.enum || ov.unit === 'enum') {
    unitClause = `unit: 'enum'`;
    prov = provComment(ov);
  } else if (ov.displayMin === undefined || ov.displayMax === undefined) {
    unitClause = `unit: '${esc(ov.unit)}'`;
    prov = provComment(ov);
  } else {
    const scalingClause = ov.scaling ? `, scaling: '${esc(ov.scaling)}'` : '';
    unitClause = `unit: '${esc(ov.unit)}', displayMin: ${fmtNum(ov.displayMin)}, displayMax: ${fmtNum(ov.displayMax)}${scalingClause}`;
    prov = provComment(ov);
  }

  // Trailing comment: calibration provenance + reuse-misaddress audit.
  const audit =
    p.reuseWouldMisaddress === true
      ? `device-true ${p.paramId} (III ${p.iiiParamId} would mis-address)`
      : '';
  const comment = [prov, audit].filter(Boolean).join('; ');
  return (
    `  { family: '${esc(p.family)}', paramId: ${p.paramId}, name: '${esc(p.name)}'${label}, ${unitClause} },` +
    (comment ? ` // ${comment}` : '')
  );
}

const calibratedCount = wire.filter((p) => calibrationOf(p) !== undefined).length;

const lines: string[] = [];
lines.push(`/**`);
lines.push(` * ${prefix} parameter catalog — DEVICE-TRUE, mined from ${prefix}-Edit's own binary.`);
lines.push(` *`);
lines.push(` * AUTO-GENERATED by`);
lines.push(` *   scripts/_research/generate-modern-fractal-catalog.ts ${dev} ${prefix}`);
lines.push(` * from`);
lines.push(` *   samples/captured/decoded/modern-fractal-devicetrue-${dev}.json`);
lines.push(` * (offline, no hardware). DO NOT HAND-EDIT — re-run the generator.`);
lines.push(` *`);
lines.push(` * paramId provenance: ${prefix}-Edit's OWN param tables (direct PE pattern`);
lines.push(` * scan, validated 100% vs the III Ghidra control). NOT reused from the`);
lines.push(` * Axe-Fx III: reusing III paramIds would mis-address ${reuseWrong.length}/${sharedAudited.length}`);
lines.push(` * (${sharedAudited.length ? ((100 * reuseWrong.length) / sharedAudited.length).toFixed(1) : '0'}%) of this device's shared-with-III params. See`);
lines.push(` * docs/_private/MINING-FINDINGS-FM-VP4.md and the primitives negative entry`);
lines.push(` * gen3-paramid-reuse-across-model-bytes.`);
lines.push(` *`);
lines.push(` * Coverage: ${wire.length} wire-addressable params across ${families.length} families.`);
lines.push(` * Display calibration: ${calibratedCount}/${wire.length} params carry a display unit`);
lines.push(` * (inherited from the AM4 symbol-name overlay — the same resolver the III`);
lines.push(` * catalog uses; join by name, not paramId). The rest stay 'unverified' and pass`);
lines.push(` * the raw 16-bit wire integer through, same as the III's uncalibrated path.`);
lines.push(` */`);
lines.push(`import type { Param } from '../types.js';`);
lines.push(``);
lines.push(`export const ${prefix}_PARAMS: readonly Param[] = [`);
for (const p of wire) lines.push(entry(p));
lines.push(`];`);
lines.push(``);
lines.push(`/** Params grouped by effect family (built once at module load). */`);
lines.push(`export const ${prefix}_PARAMS_BY_FAMILY: Readonly<Record<string, readonly Param[]>> = (() => {`);
lines.push(`  const map: Record<string, Param[]> = {};`);
lines.push(`  for (const p of ${prefix}_PARAMS) {`);
lines.push(`    (map[p.family] ??= []).push(p);`);
lines.push(`  }`);
lines.push(`  return Object.freeze(map);`);
lines.push(`})();`);
lines.push(``);
lines.push(`/** Effect families present in this device's catalog. */`);
lines.push(`export const ${prefix}_FAMILIES: readonly string[] = ${JSON.stringify(families)};`);
lines.push(``);

// Catalogs live under the gen-3 generation bucket (src/gen3/<dev>/)
// since the gen1/gen2/gen3 reorg.
const outDir = `packages/fractal-midi/src/gen3/${dev}`;
mkdirSync(outDir, { recursive: true });
const outPath = `${outDir}/params.ts`;
writeFileSync(outPath, lines.join('\n'), 'utf-8');

// index.ts re-export — seeded only if absent: device dirs with a codec
// (vp4) curate their own index.ts; never clobber it.
const idxPath = `${outDir}/index.ts`;
if (!existsSync(idxPath)) {
  const idx = `export { ${prefix}_PARAMS, ${prefix}_PARAMS_BY_FAMILY, ${prefix}_FAMILIES } from './params.js';\n`;
  writeFileSync(idxPath, idx, 'utf-8');
}

console.log(
  `${dev}: wrote ${outPath} (${wire.length} params, ${families.length} families; ` +
    `${calibratedCount} display-calibrated via AM4 name-join; ` +
    `III-reuse would mis-address ${reuseWrong.length}/${sharedAudited.length})`,
);
