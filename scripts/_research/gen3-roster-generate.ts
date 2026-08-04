/**
 * P1 generator: emit packages/fractal-midi/src/gen3/axe-fx-iii/gen3ReadRosters.ts
 * from the validated fractal-syx-codec read-ordinal tables (Apache-2.0,
 * A. Mercurio). Run once; the emitted module is committed. Source JSON lives in
 * Drew's repo (gitignored under docs/_private), so this is a one-time import.
 *
 * 2026-07-21 addition: two independent, device-native effectDefinitions caches
 * (Axe-Fx III fw 32.06, GitHub issue #13; FM3 fw 12.0, GitHub issue #8) walked
 * via scripts/_research/parse-effectdefinitions-cache.ts and cross-validated
 * against this file's existing output before being layered in as AXEIII_ and
 * FM3_TYPE_ROSTER_GAPS below. See those consts' own comments for the per-family
 * cross-validation result and for three families deliberately withheld
 * (DISTORT_TYPE, REVERB_TYPE, DELAY_TYPE — real, explained conflicts, not
 * merged this pass; see packages/fractal-midi/docs/research/captured-artifacts.md).
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

// Device-native effectDefinitions cache mines, 2026-07-21 (GitHub issues #13
// Axe-Fx III fw 32.06, #8 FM3 fw 12.0). Walked with
// scripts/_research/parse-effectdefinitions-cache.ts (`.walk.json` under
// samples/captured/{axefx3-community-2026-07-02,fm3-community-2026-06-27}/,
// gitignored scratch) and cross-validated ordinal-by-ordinal against this
// generator's PRE-EXISTING output (i.e. against FM9 fw 11.0 cache + Drew's
// factory-preset tables) before being added here. section/id per family, both
// caches: DISTORT_TYPE section 10 (III id 0, FM3 id 6), FUZZ_TYPE section 25
// id 0, REVERB_TYPE section 12 id 0, DELAY_TYPE section 13 (III id 0, FM3 id
// 6), CHORUS_TYPE section 16 id 0, COMP_TYPE section 7 id 12, FLANGER_TYPE
// section 17 id 0, PHASER_TYPE section 19 id 0, TREMOLO_TYPE section 22 id 0,
// WAH_TYPE section 20 id 0, FILTER_TYPE section 24 id 0 (section tags are
// stable family-wide per CACHE-FORMAT-SOLVED-2026-06-09.md; ids are per-device,
// located by anchoring on known names, not assumed).
//
// Cross-validation result per family (both sources, zero conflicts unless
// noted): COMP_TYPE and WAH_TYPE were ALREADY fully dense (19/9 entries) and
// both caches reconfirm every existing ordinal byte-for-byte with nothing new
// to add (kept out of these tables — no-op). FUZZ_TYPE, CHORUS_TYPE,
// FLANGER_TYPE, PHASER_TYPE, TREMOLO_TYPE, FILTER_TYPE are clean on every
// shared ordinal against the existing table AND (where both caches cover an
// ordinal) against each other; new ordinals below are exactly that
// intersection/union of agreement.
//
// THREE families were NOT added despite new content, because cross-validation
// surfaced a real conflict and the established rule here is refuse-on-conflict,
// not prefer-one-source:
//   - DISTORT_TYPE: III fw 32.06 ordinal 283 = "Deluxe Tweed Bright" vs this
//     table's (FM9 fw 11.0-derived) "Deluxe Tweed" — FM3 fw 12.0 agrees with
//     the existing "Deluxe Tweed", so this reads as a fw-32.06-only rename
//     (paired with a new sibling "Deluxe Tweed Normal" at ordinal 331). The 5
//     new III-only ordinals (331-335) are withheld too, not just 283, per the
//     family-level (not ordinal-level) refuse-on-conflict rule.
//   - REVERB_TYPE: the III cache prefixes every name with its front-panel
//     category ("Room: Small Room", "Hall: Medium Hall", ...); FM3 does not
//     (plain "Small Room" matching this table exactly, 79/79). After stripping
//     the "Category: " prefix, III still disagrees with this table (and with
//     FM3) at 3 ordinals: 36 "Asylum" vs "Asylum Hall", 68/78 "Vibra-King..."
//     vs "Vibrato-King...". No new ordinals either way (both caches cap at 79).
//   - DELAY_TYPE: FM3 alone is clean and would add 3 gap ordinals (9 "Sweep
//     Delay", 21 "Worn Tape", 23 "Stereo Trem Delay"). But III's cache shows a
//     2-item insertion ("Diffused Delay", "Zephyr") beginning at ordinal 21 on
//     fw 32.06, shifting FM3/this-table's 21.."Wandering Delays"(26) up to
//     23..28 — so FM3's ordinal 21/23 fills are apparently fw-12.0-stale
//     labels for firmware >= 32.06. Ordinal 9 "Sweep Delay" is the only entry
//     BOTH caches agree on with no shift ambiguity, but the family as a whole
//     is not clean, so nothing was added.
// Full evidence in packages/fractal-midi/docs/research/captured-artifacts.md
// (UNMINED entry) for a future session to resolve.
const AXEIII_TYPE_ROSTER_GAPS: Record<string, Readonly<Record<number, string>>> = {
  FUZZ_TYPE: { 86: 'Swedish Metal' },
  CHORUS_TYPE: {
    17: 'Tape Flanger',
    18: 'Japan CE-1 Chorus',
    19: 'Japan CE-1 Vibrato',
    20: 'Japan CH-1',
    21: 'MX234',
    22: 'Small Copy',
    23: 'Japan CE-2 Bass',
    24: 'Vibrato',
    25: 'Rockguy',
    26: 'MX134 Stereo',
  },
  FLANGER_TYPE: {
    7: 'Pop Flanger',
    12: 'D/AD 185',
    16: 'Binary Flange',
    19: 'Cuda Flange',
    21: 'Hemisflange',
    23: 'Melodic Flange',
    25: 'Scion Stereo Flange',
    26: 'Spirit Flange',
    29: 'Tubular',
    30: 'Vowel Flanger',
  },
  PHASER_TYPE: { 7: 'Barber Pole', 9: 'Naughty Rock', 13: 'Borg Phaser' },
  TREMOLO_TYPE: { 5: 'Optical Trem 2' },
  FILTER_TYPE: {
    4: 'Low-Shelf',
    5: 'High-Shelf',
    7: 'Notch',
    9: 'Low-Shelf 2',
    10: 'High-Shelf 2',
    11: 'Peaking 2',
    12: 'Feedforward Comb',
    13: 'Feedback Comb',
  },
};
const FM3_TYPE_ROSTER_GAPS: Record<string, Readonly<Record<number, string>>> = {
  CHORUS_TYPE: { 17: 'Tape Flanger' },
  FLANGER_TYPE: {
    7: 'Pop Flanger',
    12: 'D/AD 185',
    16: 'Binary Flange',
    19: 'Cuda Flange',
    21: 'Hemisflange',
    23: 'Melodic Flange',
    25: 'Scion Stereo Flange',
    26: 'Spirit Flange',
    29: 'Tubular',
    30: 'Vowel Flanger',
  },
  PHASER_TYPE: { 7: 'Barber Pole', 9: 'Naughty Rock', 13: 'Borg Phaser' },
  TREMOLO_TYPE: { 5: 'Optical Trem 2' },
  FILTER_TYPE: {
    4: 'Low-Shelf',
    5: 'High-Shelf',
    7: 'Notch',
    9: 'Low-Shelf 2',
    10: 'High-Shelf 2',
    11: 'Peaking 2',
    12: 'Feedforward Comb',
    13: 'Feedback Comb',
  },
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
  const axeiiiExtra = AXEIII_TYPE_ROSTER_GAPS[symbol]; // device-true III cache (fw 32.06)
  const fm3Extra = FM3_TYPE_ROSTER_GAPS[symbol]; // device-true FM3 cache (fw 12.0)
  const wikiExtra = WIKI_TYPE_ROSTER_GAPS[symbol]; // Fractal wiki, agreement-verified
  const added: Record<string, number> = { fm9: 0, axeiii: 0, fm3: 0, wiki: 0 };
  for (const [src, extra] of [
    ['fm9', fm9Extra],
    ['axeiii', axeiiiExtra],
    ['fm3', fm3Extra],
    ['wiki', wikiExtra],
  ] as const) {
    if (extra === undefined) continue;
    for (const [idStr, name] of Object.entries(extra)) {
      const id = Number(idStr);
      const base = merged.get(id);
      if (base === undefined) {
        merged.set(id, name);
        added[src]++;
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
  if (added.fm9 > 0) provparts.push(`+${added.fm9} FM9 cache`);
  if (added.axeiii > 0) provparts.push(`+${added.axeiii} III cache`);
  if (added.fm3 > 0) provparts.push(`+${added.fm3} FM3 cache`);
  if (added.wiki > 0) provparts.push(`+${added.wiki} Fractal wiki`);
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
 * 2026-07-21: layered in two more independent device-native sources, an
 * Axe-Fx III fw 32.06 cache (GitHub issue #13) and an FM3 fw 12.0 cache
 * (issue #8), for FUZZ_TYPE/CHORUS_TYPE/FLANGER_TYPE/PHASER_TYPE/
 * TREMOLO_TYPE/FILTER_TYPE (new ordinals, zero conflicts against the existing
 * table and, where both caches cover an ordinal, against each other too;
 * COMP_TYPE/WAH_TYPE were already dense and both caches simply reconfirm
 * them). DISTORT_TYPE, REVERB_TYPE, and DELAY_TYPE were deliberately NOT
 * extended from these two caches despite each having new-looking content:
 * cross-validation surfaced real, explained conflicts (a fw-32.06-only amp
 * rename at DISTORT_TYPE[283], an III-only "Category: Name" formatting split
 * for REVERB_TYPE that disagrees at 3 ordinals once stripped, and a 2-item
 * mid-list DELAY_TYPE insertion on fw 32.06 that shifts ordinals 21+ relative
 * to fw 12.0/this table). See scripts/_research/gen3-roster-generate.ts's
 * AXEIII_TYPE_ROSTER_GAPS/FM3_TYPE_ROSTER_GAPS comment and
 * packages/fractal-midi/docs/research/captured-artifacts.md for the full
 * per-ordinal evidence.
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
