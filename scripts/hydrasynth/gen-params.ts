/**
 * Hydrasynth Explorer — generate src/asm/hydrasynth-explorer/params.ts
 * from the manual's MIDI CC chart.
 *
 * Source:
 *   docs/devices/hydrasynth-explorer/cc-chart-raw.txt
 *   (extracted from the official Owner's Manual via
 *    `pdftotext -f 94 -l 96 -raw …` — see MIDI-MAP.md)
 *
 * Output:
 *   src/asm/hydrasynth-explorer/params.ts
 *
 * Validation:
 *   - The chart contains both sort orders ("by Module" + "by CC Number").
 *     Each CC must appear in BOTH lists with consistent module + parameter.
 *   - All CC numbers must be in 0..127.
 *   - No duplicate CCs within a single sort order.
 *
 * Run:  npm run hydra:gen-params
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHART_PATH = path.resolve(
  __dirname,
  '../../docs/devices/hydrasynth-explorer/cc-chart-raw.txt',
);
const OUTPUT_PATH = path.resolve(
  __dirname,
  '../../packages/hydrasynth/src/params.ts',
);

interface RawEntry {
  module: string;
  parameter: string;
  cc: number;
}

const KNOWN_MODULE_PATTERNS: Array<{ re: RegExp; canonical: string }> = [
  { re: /^OSC (\d)/, canonical: 'OSC $1' },
  { re: /^Filter (\d)/, canonical: 'Filter $1' },
  { re: /^ENV (\d)/, canonical: 'ENV $1' },
  { re: /^LFO (\d)/, canonical: 'LFO $1' },
  { re: /^Mutator (\d)/, canonical: 'Mutator $1' },
  { re: /^Pre-fx\b/i, canonical: 'Pre-FX' },
  { re: /^Post-fx\b/i, canonical: 'Post-FX' },
  { re: /^Macros\b/, canonical: 'Macros' },
  { re: /^Mixer\b/, canonical: 'Mixer' },
  { re: /^Voice\b/, canonical: 'Voice' },
  { re: /^Reverb\b/, canonical: 'Reverb' },
  { re: /^Delay\b/, canonical: 'Delay' },
  { re: /^Amp\b/, canonical: 'Amp' },
  { re: /^ARP\b/, canonical: 'ARP' },
  { re: /^System\b/, canonical: 'System' },
];

/** Hand-curated normalisation for awkward parameter spellings in the chart. */
const PARAMETER_NORMALIZATION: Record<string, string> = {
  'Modulation wheel.': 'Modulation Wheel',
  'Bank select MSB': 'Bank Select MSB',
  'Bank select LSB': 'Bank Select LSB',
  'Expression pedal': 'Expression Pedal',
  'Sustain pedal': 'Sustain Pedal',
  'All notes off': 'All Notes Off',
  'OSC1 wavscan': 'OSC1 WaveScan',
  'OSC2 WavScan': 'OSC2 WaveScan',
  'Flt2 Cutoff': 'Filter 2 Cutoff',
  'Flt2 Res': 'Filter 2 Res',
  'Flt2 Type': 'Filter 2 Type',
  'Filter1 Drive': 'Filter 1 Drive',
  'Filter1 Keytrack': 'Filter 1 Keytrack',
  'Filter1 LFO1amt': 'Filter 1 LFO1amt',
  'Filter1 Vel Env': 'Filter 1 Vel Env',
  'Filter1 ENV1amt': 'Filter 1 ENV1amt',
  'Filter1 Res': 'Filter 1 Res',
  'Filter1 Cutoff': 'Filter 1 Cutoff',
  'Filter2 Keytrack': 'Filter 2 Keytrack',
  'Filter2 LFO1amt': 'Filter 2 LFO1amt',
  'Filter2 Vel Env': 'Filter 2 Vel Env',
  'Filter2 ENV1amt': 'Filter 2 ENV1amt',
  // OSC FRate / Cent: chart spells these inconsistently. Canonical = no space
  // ("OSC1 FRate") to match OSC1/OSC2/OSC3 Vol/Pan which all drop the space.
  'OSC 3 FRate': 'OSC3 FRate',
  'OSC 1 Cent': 'OSC1 Cent',
  'OSC 2 Cent': 'OSC2 Cent',
  'OSC 3 Cent': 'OSC3 Cent',
  // Ring Mod / RM12: by-CC abbreviates as "RM12"; by-Module spells out
  // "Ring Mod". RM12 is the chart's compact form ("Ring Mod 1+2"). Canonical
  // = "RM12 FRate" so the slug matches the existing "RM12 Depth" entry at CC 43.
  'Ring Mod FRate': 'RM12 FRate',
  // Cosmetic / casing fixes — chart inconsistencies that make for awkward
  // IDs or user-facing text.
  'GlidTime': 'Glide Time',                    // body of manual spells it out
  'Delay Wet tone': 'Delay Wet Tone',          // capitalize Tone
  'POST FX Mix': 'POST-FX Mix',                // match CC 68/69 "POST-FX" form
};

function canonicaliseModule(raw: string): string {
  for (const { re, canonical } of KNOWN_MODULE_PATTERNS) {
    const m = raw.match(re);
    if (m) {
      return canonical.replace('$1', m[1] ?? '');
    }
  }
  throw new Error(`Unknown module token: "${raw}"`);
}

function canonicaliseParameter(raw: string): string {
  return PARAMETER_NORMALIZATION[raw] ?? raw;
}

function parseLine(line: string): RawEntry | null {
  // "<module-tokens> <parameter-tokens> <cc-number>"
  // Module tokens are the first 1-2 words matching a known module prefix.
  const match = line.match(/^(.+?)\s+(\d{1,3})$/);
  if (!match) return null;
  const cc = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(cc) || cc < 0 || cc > 127) return null;
  const rest = match[1]!;

  let moduleToken = '';
  for (const { re } of KNOWN_MODULE_PATTERNS) {
    const m = rest.match(re);
    if (m) {
      moduleToken = m[0];
      break;
    }
  }
  if (!moduleToken) return null;

  const parameterRaw = rest.slice(moduleToken.length).trim();
  if (!parameterRaw) return null;

  return {
    module: canonicaliseModule(moduleToken),
    parameter: canonicaliseParameter(parameterRaw),
    cc,
  };
}

function parseChart(text: string): { byModule: RawEntry[]; byCC: RawEntry[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const byModule: RawEntry[] = [];
  const byCC: RawEntry[] = [];
  let section: 'none' | 'module' | 'cc' = 'none';

  for (const line of lines) {
    if (line === 'Sorted by Module') {
      section = 'module';
      continue;
    }
    if (line === 'Sorted by CC Number') {
      section = 'cc';
      continue;
    }
    if (line === 'Module Parameter CC') continue;
    if (line === 'MIDI CC Charts') continue;
    if (/^\d+$/.test(line)) continue; // page numbers

    const entry = parseLine(line);
    if (!entry) continue;

    if (section === 'module') byModule.push(entry);
    else if (section === 'cc') byCC.push(entry);
  }
  return { byModule, byCC };
}

function crossValidate(byModule: RawEntry[], byCC: RawEntry[]): void {
  const fromCC = new Map<number, RawEntry>();
  for (const e of byCC) {
    if (fromCC.has(e.cc)) {
      throw new Error(`Duplicate CC ${e.cc} in by-CC list`);
    }
    fromCC.set(e.cc, e);
  }

  const fromModule = new Map<number, RawEntry>();
  for (const e of byModule) {
    if (fromModule.has(e.cc)) {
      throw new Error(`Duplicate CC ${e.cc} in by-Module list`);
    }
    fromModule.set(e.cc, e);
  }

  if (fromCC.size !== fromModule.size) {
    throw new Error(
      `Sort orders disagree on count: by-CC=${fromCC.size}, by-Module=${fromModule.size}`,
    );
  }

  const mismatches: string[] = [];
  for (const [cc, ccEntry] of fromCC) {
    const modEntry = fromModule.get(cc);
    if (!modEntry) {
      mismatches.push(`CC ${cc}: present in by-CC but missing from by-Module`);
      continue;
    }
    if (ccEntry.module !== modEntry.module) {
      mismatches.push(
        `CC ${cc}: module mismatch — by-CC="${ccEntry.module}", by-Module="${modEntry.module}"`,
      );
    }
    if (ccEntry.parameter !== modEntry.parameter) {
      mismatches.push(
        `CC ${cc}: parameter mismatch — by-CC="${ccEntry.parameter}", by-Module="${modEntry.parameter}"`,
      );
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Cross-validation failed:\n  ${mismatches.join('\n  ')}`);
  }
}

function moduleSlug(module: string): string {
  return module.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function paramSlug(parameter: string, module: string): string {
  // Strip a leading module name from the parameter (e.g. "Filter 1 Cutoff" → "Cutoff").
  let p = parameter;
  if (p.toLowerCase().startsWith(module.toLowerCase() + ' ')) {
    p = p.slice(module.length + 1);
  }
  // Also strip lowercased / no-space module forms ("Filter1 Drive" → "Drive").
  const compact = module.replace(/\s+/g, '').toLowerCase();
  if (p.toLowerCase().startsWith(compact + ' ')) {
    p = p.slice(compact.length + 1);
  }
  return p
    .toLowerCase()
    .replace(/\//g, '_')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function buildId(module: string, parameter: string): string {
  return `${moduleSlug(module)}.${paramSlug(parameter, module)}`;
}

const SYSTEM_MODULE = 'System';

function emit(entries: RawEntry[]): string {
  // Stable order: by CC ascending.
  const sorted = [...entries].sort((a, b) => a.cc - b.cc);

  const lines: string[] = [];
  lines.push('// AUTO-GENERATED FILE — do not edit by hand.');
  lines.push('// Source:  docs/devices/hydrasynth-explorer/cc-chart-raw.txt');
  lines.push('// Regen:   npm run hydra:gen-params');
  lines.push('//');
  lines.push('// The chart in the source comes from pp. 94-96 of the official');
  lines.push('// ASM Hydrasynth Explorer Owner\'s Manual v2.2.0. Both sort');
  lines.push('// orders ("by Module" and "by CC Number") are cross-validated');
  lines.push('// at generation time before this file is emitted.');
  lines.push('');
  lines.push('export type HydrasynthCategory = \'system\' | \'engine\';');
  lines.push('');
  lines.push('export interface HydrasynthParam {');
  lines.push('  /** MIDI CC number (0..127). Primary key. */');
  lines.push('  readonly cc: number;');
  lines.push('  /** Module the parameter belongs to (e.g. "Filter 1", "ARP"). */');
  lines.push('  readonly module: string;');
  lines.push('  /** Parameter name as shown on the device UI. */');
  lines.push('  readonly parameter: string;');
  lines.push('  /** Canonical lookup id, e.g. "filter1.cutoff". Stable across sessions. */');
  lines.push('  readonly id: string;');
  lines.push('  /**');
  lines.push('   * `system` = always-on (CC 0/1/7/11/32/64/123 — exempt from the');
  lines.push('   *            device\'s Param TX/RX setting per manual p. 82).');
  lines.push('   * `engine` = synthesis-engine parameter (only responsive when');
  lines.push('   *            Param TX/RX = CC on MIDI page 10).');
  lines.push('   */');
  lines.push('  readonly category: HydrasynthCategory;');
  lines.push('}');
  lines.push('');
  lines.push(`export const HYDRASYNTH_PARAMS: readonly HydrasynthParam[] = [`);
  for (const e of sorted) {
    const id = buildId(e.module, e.parameter);
    const category = e.module === SYSTEM_MODULE ? 'system' : 'engine';
    const ccPad = String(e.cc).padStart(3, ' ');
    lines.push(
      `  { cc: ${ccPad}, module: ${JSON.stringify(e.module).padEnd(13)}, parameter: ${JSON.stringify(e.parameter).padEnd(28)}, id: ${JSON.stringify(id).padEnd(28)}, category: '${category}' },`,
    );
  }
  lines.push('] as const;');
  lines.push('');
  lines.push('/** Lookup by CC number. */');
  lines.push('export const HYDRASYNTH_PARAMS_BY_CC: ReadonlyMap<number, HydrasynthParam> =');
  lines.push('  new Map(HYDRASYNTH_PARAMS.map((p) => [p.cc, p]));');
  lines.push('');
  lines.push('/** Lookup by canonical id (e.g. "filter1.cutoff"). */');
  lines.push('export const HYDRASYNTH_PARAMS_BY_ID: ReadonlyMap<string, HydrasynthParam> =');
  lines.push('  new Map(HYDRASYNTH_PARAMS.map((p) => [p.id, p]));');
  lines.push('');
  lines.push('/** All distinct module names, in stable order (matches the manual). */');
  const seenModules = new Set<string>();
  const modulesOrdered: string[] = [];
  for (const e of sorted) {
    if (!seenModules.has(e.module)) {
      seenModules.add(e.module);
      modulesOrdered.push(e.module);
    }
  }
  lines.push('export const HYDRASYNTH_MODULES: readonly string[] = [');
  for (const m of modulesOrdered) lines.push(`  ${JSON.stringify(m)},`);
  lines.push('] as const;');
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const text = fs.readFileSync(CHART_PATH, 'utf8');
  const { byModule, byCC } = parseChart(text);

  console.log(`Parsed ${byModule.length} entries from "Sorted by Module"`);
  console.log(`Parsed ${byCC.length} entries from "Sorted by CC Number"`);

  crossValidate(byModule, byCC);
  console.log('Cross-validation: OK (both sort orders agree)');

  // Use by-CC as canonical (it's the wire-key sort order).
  const code = emit(byCC);
  const outDir = path.dirname(OUTPUT_PATH);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, code, 'utf8');
  console.log(`Wrote ${OUTPUT_PATH} (${byCC.length} entries)`);
}

main();
