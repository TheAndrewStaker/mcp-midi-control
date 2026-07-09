/**
 * P1 generator: emit packages/fractal-midi/src/gen3/axe-fx-iii/gen3ReadRosters.ts
 * from the validated fractal-syx-codec read-ordinal tables (Apache-2.0,
 * A. Mercurio). Run once; the emitted module is committed. Source JSON lives in
 * Drew's repo (gitignored under docs/_private), so this is a one-time import.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  FM9_AMP_ROSTER,
  FM9_DRIVE_ROSTER,
  FM9_REVERB_TYPE_ROSTER,
} from '../../packages/fractal-midi/src/gen3/fm9/rosters.generated.js';

const DREW = 'docs/_private/fractal-syx-codec-main/fractal-syx-codec-main/data';

// The amp/drive/reverb selectors share one ordinal space across the whole gen-3
// family (III/FM3/FM9 share one effect codec + block effect IDs). Drew's tables
// only name the models that appear in a factory preset; the FM9-Edit cache mine
// names the COMPLETE roster. Union them so III + FM3 gain the same names FM9
// already has. The two sources agree byte-for-byte on every shared ordinal — the
// merge below asserts that and refuses to emit on any conflict (a conflict would
// mean a genuine intra-gen-3 ordinal divergence, which would block sharing).
const FM9_SUPERSET: Record<string, Readonly<Record<number, string>>> = {
  DISTORT_TYPE: FM9_AMP_ROSTER,
  FUZZ_TYPE: FM9_DRIVE_ROSTER,
  REVERB_TYPE: FM9_REVERB_TYPE_ROSTER,
};

// Fractal-wiki type rosters (Fractal Audio wiki "<block> models" pages, mined by
// the third-party ForgeFX `NameSync` tool, Apache-2.0) for the gen-3 selectors
// that have NO FM9 editor-cache roster but where the wiki ordering AGREES with
// Drew's device-correlated base on EVERY shared ordinal — the same cross-source
// agreement that, for amp, the FM9 device cache then proved device-true. The
// gap ordinals below are the verified continuation (real Fractal models slotting
// contiguously into a sequence that matches the device-derived base on every
// neighbour). Community-beta: wiki + device-correlation agree, but no device
// cache confirms these exact ordinals. The merge below still asserts no conflict
// on any SHARED ordinal, so a mistake (e.g. ForgeFX's delay file, which is a
// factory-PRESET list that conflicts at ordinal 0) would throw, not silently
// relabel. delay/cab/geq are deliberately NOT here: delay conflicts, and cab/geq
// have no base roster to validate an ordinal mapping against.
const WIKI_TYPE_ROSTER_GAPS: Record<string, Readonly<Record<number, string>>> = {
  COMP_TYPE: { 9: 'VCA FF Sustainer', 11: 'VCA FB Sustainer', 18: 'Citrus Juicer' },
  WAH_TYPE: { 5: 'Funk Wah', 8: 'Paragon' },
};
// Drew block file -> our gen-3 param firmware symbol (the block's Type selector).
// cab/dynacab held back (uncertain CAB_TYPE mapping, no anchor).
const BLOCK_TO_SYMBOL: [string, string][] = [
  ['amp', 'DISTORT_TYPE'],
  ['drive', 'FUZZ_TYPE'],
  ['reverb', 'REVERB_TYPE'],
  ['delay', 'DELAY_TYPE'],
  ['chorus', 'CHORUS_TYPE'],
  ['comp', 'COMP_TYPE'],
  ['flanger', 'FLANGER_TYPE'],
  ['phaser', 'PHASER_TYPE'],
  ['tremolo', 'TREMOLO_TYPE'],
  ['wah', 'WAH_TYPE'],
  ['filter', 'FILTER_TYPE'],
];

let body = '';
let total = 0;
for (const [block, symbol] of BLOCK_TO_SYMBOL) {
  const table = JSON.parse(readFileSync(`${DREW}/${block}_type_binary_ids.json`, 'utf8')) as Record<string, string>;
  const merged = new Map<number, string>(
    Object.entries(table).map(([id, name]) => [Number(id), name] as [number, string]),
  );

  // Union extra named ordinals over Drew's device-correlated base. Drew's name
  // wins on shared ordinals (so the committed labels stay byte-identical); extra
  // ordinals are added. A disagreement on a SHARED ordinal is a hard error — we
  // never silently relabel (this is what catches a wrong-list source, e.g. the
  // ForgeFX delay file that conflicts at ordinal 0).
  const fm9Extra = FM9_SUPERSET[symbol]; // device-true FM9 editor cache
  const wikiExtra = WIKI_TYPE_ROSTER_GAPS[symbol]; // Fractal wiki, agreement-verified
  let addedFm9 = 0;
  let addedWiki = 0;
  for (const [src, extra] of [['fm9', fm9Extra], ['wiki', wikiExtra]] as const) {
    if (extra === undefined) continue;
    for (const [idStr, name] of Object.entries(extra)) {
      const id = Number(idStr);
      const base = merged.get(id);
      if (base === undefined) {
        merged.set(id, name);
        if (src === 'fm9') addedFm9++; else addedWiki++;
      } else if (base.trim() !== name.trim()) {
        throw new Error(
          `gen-3 roster conflict on ${symbol}[${id}]: base "${base}" != ${src} "${name}" — ` +
            `ordinal divergence, this source is NOT a safe fill; investigate before regenerating.`,
        );
      }
    }
  }

  const entries = [...merged.entries()].sort((a, b) => a[0] - b[0]);
  total += entries.length;
  const provparts: string[] = [];
  if (addedFm9 > 0) provparts.push(`+${addedFm9} FM9 cache`);
  if (addedWiki > 0) provparts.push(`+${addedWiki} Fractal wiki`);
  const provenance = provparts.length > 0 ? `, ${provparts.join(', ')}` : '';
  body += `  // ${block} block type selector (${entries.length} models${provenance})\n`;
  body += `  ${symbol}: {\n`;
  for (const [id, name] of entries) {
    body += `    ${id}: ${JSON.stringify(name)},\n`;
  }
  body += `  },\n`;
}

const out = `/**
 * Gen-3 read-leg enum rosters: broadcast/read ORDINAL -> display name, for the
 * shared Axe-Fx III / FM3 / FM9 effect catalog. These name every block's Type
 * selector (amp, drive, reverb, delay, chorus, comp, flanger, phaser, tremolo,
 * wah, filter) in get_param / get_preset / list_params responses.
 *
 * READ + SET. The keys are the file-stored / broadcast ORDINAL, which IS the
 * value a gen-3 discrete SET carries as float32(ordinal) at pos 12 (sub 09 00).
 * Verified 2026-06-08 on FM3 + FM9 (file id 31 = "Shiver Clean" = the SET value).
 * There is no separate typed-SET "raw id" space and no gating: catalog.ts merges
 * this roster into each Type param's enum_values so the SAME name->ordinal drives
 * both decode (read label) and encode (set-by-name). Numeric ordinals absent from
 * a table pass through unchanged. Per-device hardware-captured overrides are
 * layered on top of this shared base by mergeGen3EnumOverrides (captured points
 * win).
 *
 * SOURCE: the factory-preset-correlated read-ordinal tables from fractal-syx-codec
 * by Andrew Mercurio ("BoodieTraps", Apache-2.0), UNIONED for the amp/drive/reverb
 * model selectors with the device-true FM9-Edit cache rosters (FM9_AMP_ROSTER /
 * FM9_DRIVE_ROSTER / FM9_REVERB_TYPE_ROSTER). The two sources agree byte-for-byte
 * on every shared ordinal — the generator asserts this and refuses to emit on any
 * conflict — so those three selectors carry the COMPLETE gen-3 model lists. The
 * comp/wah selectors are likewise gap-filled from the Fractal wiki ("<block>
 * models" pages via the third-party ForgeFX NameSync tool) for the few ordinals
 * the factory base omits, accepted ONLY because the wiki agrees with the
 * device-correlated base on every shared ordinal there (delay/cab/geq are NOT:
 * ForgeFX's delay file is a factory-preset list that conflicts, and cab/geq have
 * no base roster to validate a mapping against). The gen-3 family (III/FM3/FM9)
 * shares one effect codec and one model-selector ordinal space, so these names
 * apply family-wide; ordinals beyond the factory-correlated subset (e.g. amp 65
 * "SV Bass 2", comp 9 "VCA FF Sustainer", wah 5 "Funk Wah") are evidence-strong
 * (device cache and/or wiki agree with the device-derived base) but untested on
 * hardware — community-beta. The "amp ordinals are device-specific" caveat
 * concerns AM4 — a different codec generation whose amp table is renumbered —
 * NOT divergence within the gen-3 family, where every shared ordinal matches.
 *
 * Cross-validated against our own FM9 hardware read-leg captures (Texas Star
 * Clean=179, SV Bass 1=264, Blues OD=15, Blackglass 7K=36, Peaking=6); see the
 * Credits section in the repo README. cab/DynaCab is deliberately ABSENT here
 * and always will be: CABINET_TYPE's ordinal space is BANK-CONDITIONED (the
 * same ordinal names a different IR per CABINET_BANK value), so a flat table
 * in this roster would mislabel. The factory cab name tables ship instead as
 * bank-keyed data + a name→(bank, ordinal) resolver in \`fractal-midi/gen3/fm9\`
 * (\`cabRosters.generated.ts\` / \`resolveFm9CabName\`, registered 2026-07-02).
 *
 * GENERATED by scripts/_research/gen3-roster-generate.ts from the source tables.
 * Do not hand-edit; re-run the generator to refresh.
 */
export const GEN3_READ_ROSTERS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
${body}};

/**
 * Deep-merge a device's hardware-captured enum overrides over the shared
 * read rosters. Device-captured points win per ordinal (hardware truth beats the
 * factory-correlated base, e.g. an FM9-specific amp at an ordinal absent from the
 * shared table). Returns the base unchanged when the device has no overrides.
 */
export function mergeGen3EnumOverrides(
  base: Readonly<Record<string, Readonly<Record<number, string>>>>,
  device?: Readonly<Record<string, Readonly<Record<number, string>>>>,
): Readonly<Record<string, Readonly<Record<number, string>>>> {
  if (device === undefined) return base;
  const out: Record<string, Record<number, string>> = {};
  for (const [sym, table] of Object.entries(base)) out[sym] = { ...table };
  for (const [sym, table] of Object.entries(device)) out[sym] = { ...(out[sym] ?? {}), ...table };
  return out;
}
`;

const target = 'packages/fractal-midi/src/gen3/axe-fx-iii/gen3ReadRosters.ts';
writeFileSync(target, out);
console.log(`Wrote ${target}: ${BLOCK_TO_SYMBOL.length} block tables, ${total} labels.`);
