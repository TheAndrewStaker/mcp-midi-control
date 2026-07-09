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

// --- section name -> clean block id ---
function blockId(section: string): string {
  const s = section.replace(/^Patch/, '');
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
  };
  if (direct[s]) return direct[s];
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^LFX_HRM(\d)(_MIDI)?$/)))
    return 'harmony' + m[1] + (m[2] ? '_midi' : '');
  if ((m = s.match(/^LFX_USRINT(\d)$/))) return 'user_interval' + m[1];
  if ((m = s.match(/^FX(\d)$/))) return 'fx' + m[1];
  if ((m = s.match(/^REV(\d)$/))) return 'reverb' + m[1];
  if ((m = s.match(/^ASSIGN(\d)$/))) return 'assign' + m[1];
  return s.toLowerCase();
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
}

const entries: Entry[] = [];
const temporary = map.layout.find((b) => b.name === 'Temporary');
if (!temporary) throw new Error('Temporary block not found in editor address map');

let collisions = 0;
let enumCount = 0;
for (const section of temporary.child as RawBlock[]) {
  const block = blockId(section.name);
  const seen = new Set<string>();
  for (const p of section.child as RawParam[]) {
    let param = paramSlug(p.name);
    if (seen.has(param)) {
      collisions++;
      param = `${param}_${p.addr}`; // disambiguate by relative addr
    }
    seen.add(param);
    const enum_values = matchEnum(p.name, p.min, p.max);
    if (enum_values) enumCount++;
    entries.push({
      block,
      param,
      display_name: p.name,
      section: section.name,
      addr: section.addr + p.addr,
      size: p.size,
      ofs: p.ofs,
      min: p.min,
      max: p.max,
      init: p.init,
      ...(enum_values ? { enum_values } : {}),
    });
  }
}

const blockCount = new Set(entries.map((e) => e.block)).size;
const banner =
  `// AUTO-GENERATED by scripts/generate-ve500-catalog.ts — DO NOT EDIT BY HAND.\n` +
  `// Source: BOSS VE-500 Editor address_map.js (the manufacturer's encoder).\n` +
  `// ${entries.length} params across ${blockCount} active-patch sections.\n\n`;

const body =
  `export interface Ve500ParamDef {\n` +
  `  /** Clean block id, e.g. 'enhancer', 'fx1', 'reverb1'. */\n  readonly block: string;\n` +
  `  /** Clean param id within the block, e.g. 'enhance', 'type'. */\n  readonly param: string;\n` +
  `  /** Display name from the editor, e.g. 'Enhancer Enhance'. */\n  readonly display_name: string;\n` +
  `  /** Raw editor section name, e.g. 'PatchEH'. */\n  readonly section: string;\n` +
  `  /** Patch-relative internal address (add the patch base to get the wire address). */\n  readonly addr: number;\n` +
  `  /** roland-midi Size constant (INTEGER1xN / INTEGERnx4 / PADDING|n / raw count). */\n  readonly size: number;\n` +
  `  /** Signed-value bias: display = wire - ofs. */\n  readonly ofs: number;\n` +
  `  readonly min: number;\n  readonly max: number;\n  readonly init: number | string;\n` +
  `  /** Wire-ordinal -> panel label, from the editor option tables (only when a\n` +
  `   *  named table exactly covers [min..max]). Absent = plain numeric param. */\n` +
  `  readonly enum_values?: Readonly<Record<number, string>>;\n}\n\n` +
  `export const VE500_PARAMS: readonly Ve500ParamDef[] = ${JSON.stringify(
    entries,
    null,
    0,
  )
    .replace(/\},\{/g, '},\n  {')
    .replace(/^\[/, '[\n  ')
    .replace(/\]$/, ',\n]')} as const;\n`;

writeFileSync(OUT, banner + body);
console.log(
  `Wrote ${entries.length} params (${blockCount} blocks, ${enumCount} with enum labels) -> ${OUT}` +
    (collisions ? `  [${collisions} slug collisions disambiguated by addr]` : ''),
);
