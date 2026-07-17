// Generate the VE-500 parameter catalog from the BOSS VE-500 Editor's own
// address_map.js (the manufacturer's authoritative encoder), by evaluating it
// in a sandbox and walking the active-patch (Temporary) section tree.
//
// Source (gitignored, maintainer-only): the editor's web app, copied to
//   docs/_private/devices/ve-500/editor-extract/js/
// Output (committed): packages/roland-midi/src/ve-500/catalog.generated.ts
//
// The generated catalog is functional data (addresses/ranges) — the same
// practice the Fractal catalogs use. The editor JS itself stays private.
//
// Run:  npx tsx scripts/generate-ve500-catalog.ts

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const EDITOR = join(
  process.cwd(),
  'docs/_private/devices/ve-500/editor-extract/js',
);
const OUT = join(
  process.cwd(),
  'packages/roland-midi/src/ve-500/catalog.generated.ts',
);

const constantJs = join(EDITOR, 'utilities/constant.js');
const addressJs = join(EDITOR, 'config/address_map.js');

if (!existsSync(constantJs) || !existsSync(addressJs)) {
  console.error(
    `VE-500 editor extract not found at ${EDITOR}\n` +
      `This generator is maintainer-only; the committed catalog.generated.ts is the\n` +
      `redistributable artifact. To regenerate, install the BOSS VE-500 Editor and copy\n` +
      `%LOCALAPPDATA%\\Roland\\VE-500 Editor\\html\\js -> the path above.`,
  );
  process.exit(1);
}

// --- evaluate the editor's pure config in a sandbox ---
const ctx: Record<string, unknown> = {};
vm.createContext(ctx);
vm.runInContext(readFileSync(constantJs, 'utf8'), ctx);
vm.runInContext(readFileSync(addressJs, 'utf8'), ctx);
vm.runInContext('var __map = new AddressMap();', ctx);
const map = (ctx as { __map: { layout: RawBlock[] } }).__map;

// --- evaluate the editor's option-label tables (option-tbl.js) ---
// Each param's display labels come from selectOptions['<Table Name>'], an
// ordered list of { value, disp }. We attach them as enum_values only when a
// table NAME matches the param AND its length exactly covers the param's value
// range — a wrong table is a different length and is rejected.
const optionJs = join(EDITOR, 'product/option-tbl.js');
type OptEntry = { value: number; disp: string | number };
let selectOptions: Record<string, OptEntry[]> = {};
if (existsSync(optionJs)) {
  (ctx as { dbg?: unknown }).dbg = { log: () => {} };
  vm.runInContext(readFileSync(optionJs, 'utf8'), ctx);
  selectOptions =
    (ctx as { selectOptions?: Record<string, OptEntry[]> }).selectOptions ?? {};
}

/**
 * Candidate table names for a param: the full display name, each front-stripped
 * suffix, AND each suffix with one interior word removed — so a position-
 * qualified param ("Enhancer EQ Low Gain") reaches its shared table ("EQ Gain").
 * Every candidate is still length-gated in matchEnum, so extra candidates can't
 * attach a wrong-length table.
 */
function tableCandidates(displayName: string): string[] {
  const words = displayName.trim().split(/\s+/);
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const suffix = words.slice(i);
    out.add(suffix.join(' '));
    for (let j = 1; j < suffix.length - 1; j++) {
      out.add([...suffix.slice(0, j), ...suffix.slice(j + 1)].join(' '));
    }
  }
  return [...out];
}

/** Resolve a param's enum labels from the option tables, or undefined. */
function matchEnum(
  displayName: string,
  min: number,
  max: number,
): Record<number, string> | undefined {
  if (min !== 0) return undefined;
  for (const cand of tableCandidates(displayName)) {
    const tbl = selectOptions[cand];
    if (!tbl || tbl.length !== max + 1) continue; // exact one-entry-per-value
    const out: Record<number, string> = {};
    let ok = true;
    for (const e of tbl) {
      if (typeof e.value !== 'number' || e.value < 0 || e.value > max) {
        ok = false;
        break;
      }
      out[e.value] = String(e.disp);
    }
    if (!ok || Object.keys(out).length !== max + 1) continue; // contiguous
    // Skip pure-index tables (disp === value everywhere): no semantic labels.
    if (!tbl.some((e) => String(e.disp) !== String(e.value))) continue;
    return out;
  }
  return undefined;
}

interface RawParam {
  addr: number;
  name: string;
  size: number;
  ofs: number;
  min: number;
  max: number;
  init: number | string;
}
interface RawBlock {
  addr: number;
  size: number;
  name: string;
  child: RawBlock[] | RawParam[];
}

// --- section suffix (root prefix already stripped) -> clean block id ---
// Shared between the Temporary tree ("Patch..." sections) and the System tree
// ("System..." sections): several System sections reuse the SAME struct as a
// Temporary section verbatim (e.g. SystemEH === PatchEH, address_map.js:556),
// so the suffix vocabulary is identical; System-only leaf sections (Common,
// MIDI, USB, TUNER, PREF, INPUT/OUTPUT + their EQs) are added alongside.
function sectionSuffixId(suffix: string): string {
  const direct: Record<string, string> = {
    Common: 'common',
    BEND: 'bend',
    EH: 'enhancer',
    PCR: 'pitch_correct',
    PCR_MIDI: 'pitch_correct_midi',
    LFX: 'lead_fx',
    LFX_HRM: 'harmony',
    LFX_VOC: 'vocoder',
    KEY: 'key',
    KEY_MIDI: 'key_midi',
    MST: 'master',
    MST_FX_HRM: 'master_fx_harmony',
    MST_FX_VOC: 'master_fx_vocoder',
    MST_REV: 'master_reverb',
    MST_BPM: 'master_bpm',
    CTL: 'ctl',
    ASSIGN_COM: 'assign_common',
    LOOP: 'loop',
    // System-only leaf sections (address_map.js:538-568)
    MIDI: 'midi',
    USB: 'usb',
    TUNER: 'tuner',
    PREF: 'pref',
    INPUT: 'input',
    OUTPUT: 'output',
  };
  if (direct[suffix]) return direct[suffix];
  let m: RegExpMatchArray | null;
  if ((m = suffix.match(/^LFX_HRM(\d)(_MIDI)?$/)))
    return 'harmony' + m[1] + (m[2] ? '_midi' : '');
  if ((m = suffix.match(/^LFX_USRINT(\d)$/))) return 'user_interval' + m[1];
  if ((m = suffix.match(/^FX(\d)$/))) return 'fx' + m[1];
  if ((m = suffix.match(/^REV(\d)$/))) return 'reverb' + m[1];
  if ((m = suffix.match(/^ASSIGN(\d)$/))) return 'assign' + m[1];
  if ((m = suffix.match(/^INPUT_EQ(\d)$/))) return 'input_eq' + m[1];
  if ((m = suffix.match(/^OUTPUT_EQ(\d)$/))) return 'output_eq' + m[1];
  return suffix.toLowerCase();
}

function blockId(section: string): string {
  return sectionSuffixId(section.replace(/^Patch/, ''));
}

/** System sections get a `system_` prefix so they never collide with the
 * Temporary block of the same underlying struct (e.g. SystemEH -> 'system_enhancer',
 * distinct from the Temporary 'enhancer' block). */
function systemBlockId(section: string): string {
  return 'system_' + sectionSuffixId(section.replace(/^System/, ''));
}

const PREFIXES = [
  'Pitch Correct',
  'Lead FX',
  'User Interval',
  'Enhancer',
  'Harmony',
  'Vocoder',
  'Reverb',
];

function paramSlug(name: string): string {
  let n = name;
  for (const p of PREFIXES) {
    if (n.startsWith(p + ' ')) {
      n = n.slice(p.length + 1);
      break;
    }
  }
  const slug = n
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'value';
}

interface Entry {
  block: string;
  param: string;
  display_name: string;
  section: string;
  addr: number; // patch-relative internal address (section base + param addr)
  size: number;
  ofs: number;
  min: number;
  max: number;
  init: number | string;
  enum_values?: Record<number, string>;
  /** 'system' = `addr` is the FULL absolute internal address (no patch base
   *  is added at wire-build time). Absent (default) = per-patch: `addr` is
   *  patch-relative, add the active/user-patch base. */
  region?: 'system';
}

function collectEntries(
  root: RawBlock,
  makeBlockId: (section: string) => string,
  region: 'system' | undefined,
): { entries: Entry[]; collisions: number; enumCount: number } {
  const entries: Entry[] = [];
  let collisions = 0;
  let enumCount = 0;
  for (const section of root.child as RawBlock[]) {
    const block = makeBlockId(section.name);
    const seen = new Set<string>();
    for (const p of section.child as RawParam[]) {
      let param = paramSlug(p.name);
      if (seen.has(param)) {
        collisions++;
        param = `${param}_${p.addr}`; // disambiguate by relative addr
      }
      seen.add(param);
      const displayName = p.name.trim(); // address_map.js:404 has a trailing space
      const enum_values = matchEnum(displayName, p.min, p.max);
      if (enum_values) enumCount++;
      entries.push({
        block,
        param,
        display_name: displayName,
        section: section.name,
        addr: root.addr + section.addr + p.addr,
        size: p.size,
        ofs: p.ofs,
        min: p.min,
        max: p.max,
        init: p.init,
        ...(enum_values ? { enum_values } : {}),
        ...(region ? { region } : {}),
      });
    }
  }
  return { entries, collisions, enumCount };
}

// Temporary (per-patch) region: `root.addr` is 0x04000000 (Temporary's own
// base, see address_map.js:576/591); entries stay PATCH-RELATIVE (as before
// this change) because callers add the active/user-patch base at wire-build
// time, so we subtract it back out to preserve that contract exactly.
const temporary = map.layout.find((b) => b.name === 'Temporary');
if (!temporary) throw new Error('Temporary block not found in editor address map');
const temporaryPatchRelative: RawBlock = { ...temporary, addr: 0 };
const {
  entries,
  collisions,
  enumCount,
} = collectEntries(temporaryPatchRelative, blockId, undefined);

// System (global) region: address_map.js:538-568. `root.addr` is 0x02000000
// (address_map.js:577/590), kept IN so `addr` is the full absolute internal
// address; System has no per-instance base to add at wire-build time (unlike
// Temporary, which is re-based per user patch).
const system = map.layout.find((b) => b.name === 'System');
if (!system) throw new Error('System block not found in editor address map');
const {
  entries: systemEntries,
  collisions: systemCollisions,
  enumCount: systemEnumCount,
} = collectEntries(system, systemBlockId, 'system');

const blockCount = new Set(entries.map((e) => e.block)).size;
const systemBlockCount = new Set(systemEntries.map((e) => e.block)).size;
const banner =
  `// AUTO-GENERATED by scripts/generate-ve500-catalog.ts — DO NOT EDIT BY HAND.\n` +
  `// Source: BOSS VE-500 Editor address_map.js (the manufacturer's encoder).\n` +
  `// ${entries.length} per-patch params across ${blockCount} active-patch sections,\n` +
  `// + ${systemEntries.length} SYSTEM (global) params across ${systemBlockCount} sections.\n\n`;

function renderArray(name: string, list: Entry[]): string {
  return (
    `export const ${name}: readonly Ve500ParamDef[] = ${JSON.stringify(
      list,
      null,
      0,
    )
      .replace(/\},\{/g, '},\n  {')
      .replace(/^\[/, '[\n  ')
      .replace(/\]$/, ',\n]')} as const;\n`
  );
}

const body =
  `export interface Ve500ParamDef {\n` +
  `  /** Clean block id, e.g. 'enhancer', 'fx1', 'reverb1'. */\n  readonly block: string;\n` +
  `  /** Clean param id within the block, e.g. 'enhance', 'type'. */\n  readonly param: string;\n` +
  `  /** Display name from the editor, e.g. 'Enhancer Enhance'. */\n  readonly display_name: string;\n` +
  `  /** Raw editor section name, e.g. 'PatchEH'. */\n  readonly section: string;\n` +
  `  /** Patch-relative internal address (add the patch base to get the wire address);\n` +
  `   *  FULL ABSOLUTE address when \`region\` is 'system'. */\n  readonly addr: number;\n` +
  `  /** roland-midi Size constant (INTEGER1xN / INTEGERnx4 / PADDING|n / raw count). */\n  readonly size: number;\n` +
  `  /** Signed-value bias: display = wire - ofs. */\n  readonly ofs: number;\n` +
  `  readonly min: number;\n  readonly max: number;\n  readonly init: number | string;\n` +
  `  /** Wire-ordinal -> panel label, from the editor option tables (only when a\n` +
  `   *  named table exactly covers [min..max]). Absent = plain numeric param. */\n` +
  `  readonly enum_values?: Readonly<Record<number, string>>;\n` +
  `  /** 'system' = \`addr\` is already the FULL absolute internal address (Setup/System\n` +
  `   *  root + section + param); no patch base is added at wire-build time. Absent\n` +
  `   *  (default) = per-patch: \`addr\` is patch-relative. */\n` +
  `  readonly region?: 'system';\n}\n\n` +
  renderArray('VE500_PARAMS', entries) +
  `\n` +
  renderArray('VE500_SYSTEM_PARAMS', systemEntries);

writeFileSync(OUT, banner + body);
console.log(
  `Wrote ${entries.length} params (${blockCount} blocks, ${enumCount} with enum labels) + ` +
    `${systemEntries.length} SYSTEM params (${systemBlockCount} blocks, ${systemEnumCount} with enum labels) -> ${OUT}` +
    (collisions || systemCollisions
      ? `  [${collisions + systemCollisions} slug collisions disambiguated by addr]`
      : ''),
);
