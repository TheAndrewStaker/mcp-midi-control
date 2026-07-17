// bridge-paramnames-to-xml.ts
//
// Join the hand-curated paramNames.ts to the XML-derived
// editorControlLabels.ts by (block, normalized-label) and report:
//
//   - Confirmed matches: paramNames entry has a corresponding
//     EditorControl with the same display label. These are the
//     anchor points for a parameterName ↔ pidHigh bridge.
//   - Mismatches: both sides have an entry but the labels differ.
//     Surfaces XML's canonical label for review (founder may have
//     used a more natural-language name; XML is firmware truth).
//   - Unmatched paramNames: no EditorControl found by block/label.
//     Likely block-name-mapping mismatch, label-formatting issue,
//     or the param doesn't appear on any AM4-Edit page.
//   - Unmatched EditorControls: parameterNames in the XML with no
//     paramNames entry. These are the ~1000+ params we don't have
//     hand-curated wire bindings for yet.
//
// Output:
//   samples/captured/decoded/labels/bridge-report.json
//   samples/captured/decoded/labels/bridge-report.md
//   src/protocol/parameterBridge.ts          (committed; consumed by server)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PARAM_NAMES, type ParamNameEntry } from 'fractal-midi/am4';
import { EDITOR_CONTROLS } from 'fractal-midi/am4';
import { PARAMETER_NAME_TO_CACHE_ID } from 'fractal-midi/am4';

const OUT_JSON = 'samples/captured/decoded/labels/bridge-report.json';
const OUT_MD   = 'samples/captured/decoded/labels/bridge-report.md';
// Post-monorepo-reorg path (was src/fractal/am4/ before packages/ split).
const OUT_TS   = 'packages/fractal-midi/src/am4/parameterBridge.ts';
mkdirSync('samples/captured/decoded/labels', { recursive: true });

// ── Block-name mapping: paramNames key → XML EditorControls "name" ──
// Verified by spot-check against the XML structure dump. Keep this in
// sync if either side adds blocks.
const BLOCK_TO_XML: Record<string, string[]> = {
    amp:        ['Amp'],
    drive:      ['Drive'],
    reverb:     ['Reverb'],
    delay:      ['Delay'],
    chorus:     ['Chorus'],
    flanger:    ['Flanger'],
    phaser:     ['Phaser'],
    wah:        ['Wah'],
    peq:        ['ParametricEQ'],
    rotary:     ['Rotary'],
    compressor: ['Compressor'],
    geq:        ['GraphicEQ'],
    filter:     ['Filter'],
    tremolo:    ['Tremolo'],
    enhancer:   ['Enhancer'],
    gate:       ['GateExpander'],
    volpan:     ['VolPan'],
    // Less-common in current paramNames coverage:
    pitch:      ['Synth', 'PitchShifter'],   // verify
    megatap:    ['MegaTap'],
    formant:    ['Formant'],
    ringmod:    ['RingMod'],
    resonator:  ['Resonator'],
    output:     ['Output'],
    input:      ['Input', 'Input1/Instr'],
    global:     ['Global'],
};

function normalizeLabel(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function getName(entry: ParamNameEntry): string {
    return typeof entry === 'string' ? entry : entry.name;
}

interface Match {
    block: string;
    cacheId: number;
    handName: string;          // paramNames hand-curated name
    parameterName: string;     // XML symbolic ID (firmware-truth via resolver when available)
    xmlLabel: string;          // XML canonical display label
    normalizedHand: string;
    normalizedXml: string;
    matched: boolean;          // hand-name equals XML label after normalization
    /** How the binding was made: 'label' = display-label match, 'positional' = pattern-derived,
     *  'resolver' = AM4-Edit.exe resolver table (cont 4 priority 2),
     *  'block-universal' = universal block-level register (mix/balance/level/bypass) that
     *  AM4-Edit's UI doesn't surface for this block but the firmware exposes uniformly. */
    via: 'label' | 'positional' | 'resolver' | 'block-universal';
}

// ── Reverse index: per-block, cache_id → resolver parameterNames.
// The resolver is firmware-truth for what parameterName(s) the AM4-Edit
// dispatcher binds to a given cache_id across variants.
const RESOLVER_BY_CACHE_ID: Record<string, Map<number, string[]>> = {};
for (const [block, paramMap] of Object.entries(PARAMETER_NAME_TO_CACHE_ID)) {
    RESOLVER_BY_CACHE_ID[block] = new Map();
    for (const [paramName, cids] of Object.entries(paramMap)) {
        for (const cid of cids) {
            const list = RESOLVER_BY_CACHE_ID[block].get(cid) ?? [];
            list.push(paramName);
            RESOLVER_BY_CACHE_ID[block].set(cid, list);
        }
    }
}

/**
 * Resolver-truth lookup: for a (block, cache_id), what parameterName(s)
 * does the AM4-Edit dispatcher bind? Returns [] if the resolver doesn't
 * cover this cache_id.
 */
function resolverParametersAt(block: string, cacheId: number): string[] {
    return RESOLVER_BY_CACHE_ID[block]?.get(cacheId) ?? [];
}

// ── Per-block family preference for resolver disambiguation ───────
// AM4-Edit's variant resolver maps every cache_id in `amp` to BOTH a
// CABINET_* and a DISTORT_* parameterName, because the same wire
// register is repurposed when CABINET_MODE switches (e.g. cache_id=11
// is DISTORT_DRIVE in normal mode AND CABINET_BANK2 in DynaCab mode).
// The earlier code grabbed `resolverNames[0]` blindly, which always
// won the alphabetical CABINET_* — labelling amp.gain as "Bank",
// amp.bass as "Cab #", etc.
//
// The fix: when multiple resolver entries exist, prefer a family
// matching the block's primary register namespace. For amp, that's
// DISTORT_*. The preference list is consulted in order; the first
// regex that matches at least one name in the resolver list wins.
//
// BLOCK_* (block-level controls — mix, balance, level) is intentionally
// last for every block, since per-block primaries should win when both
// are present.
const FAMILY_PREFERENCE: Record<string, RegExp[]> = {
    amp:        [/^DISTORT_/, /^CABINET_/, /^BLOCK_/],
    drive:      [/^FUZZ_/, /^BLOCK_/],
    compressor: [/^COMP_/, /^BLOCK_/],
    delay:      [/^DELAY_/, /^BLOCK_/],
    reverb:     [/^REVERB_/, /^BLOCK_/],
    chorus:     [/^CHORUS_/, /^BLOCK_/],
    flanger:    [/^FLANGER_/, /^BLOCK_/],
    phaser:     [/^PHASER_/, /^BLOCK_/],
    wah:        [/^WAH_/, /^BLOCK_/],
    tremolo:    [/^TREMOLO_/, /^BLOCK_/],
    enhancer:   [/^ENHANCER_/, /^BLOCK_/],
    gate:       [/^GATE_/, /^BLOCK_/],
    volpan:     [/^VOLUME_/, /^BLOCK_/],
    peq:        [/^PEQ_/, /^BLOCK_/],
    geq:        [/^GEQ_/, /^BLOCK_/],
    filter:     [/^FILTER_/, /^BLOCK_/],
    rotary:     [/^ROTARY_/, /^BLOCK_/],
};

/**
 * Pick one parameterName from a resolver list. If `preferred` is in
 * the list (e.g. came from a label match), return it — that's the
 * highest-confidence binding. Otherwise consult the per-block family
 * preference; first family that matches a name wins. Falls back to
 * names[0] only when no preference applies (unrecognised block).
 */
function pickFromResolver(
    block: string,
    names: string[],
    preferred?: string,
): string {
    if (names.length === 0) throw new Error('pickFromResolver: empty names');
    if (preferred && names.includes(preferred)) return preferred;
    const prefs = FAMILY_PREFERENCE[block];
    if (prefs) {
        for (const re of prefs) {
            const match = names.find(n => re.test(n));
            if (match) return match;
        }
    }
    return names[0];
}

// ── Positional alignments ─────────────────────────────────────────
// Some hand-curated names (e.g. `geq.band_1`) don't share a display
// label with their XML EditorControl because AM4-Edit labels GEQ
// sliders by frequency (`"125"`, `"320"`, `"800"`) rather than by
// position. The wire ID is positional in both worlds, so we can bind
// `<hand-name>` ↔ `<param-prefix><index>` mechanically.
//
// Each entry binds a hand-name regex (whose first capture group is the
// 1-based index) to an XML parameterName built as `${parameterPrefix}${index}`.
// The canonical label comes from EDITOR_CONTROLS[paramName] (the
// most-common XML label across variants/contexts).
const POSITIONAL_ALIGNMENTS: Array<{
    block: string;
    handPattern: RegExp;
    parameterPrefix: string;
}> = [
    // Standalone Graphic EQ block — 10 sliders.
    { block: 'geq',   handPattern: /^band_(\d+)$/,           parameterPrefix: 'GEQ_GAIN' },
    // Amp's GEQ section (Expert page) — up to 8 sliders.
    { block: 'amp',   handPattern: /^geq_band_(\d+)$/,       parameterPrefix: 'DISTORT_EQ' },
    // Drive's post-distort EQ (Expert page) — up to 10 sliders.
    { block: 'drive', handPattern: /^geq_band_(\d+)$/,       parameterPrefix: 'FUZZ_EQ' },
    // Wah's post-filter EQ (Expert page) — up to 8 sliders.
    { block: 'wah',   handPattern: /^graphic_eq_band_(\d+)$/, parameterPrefix: 'WAH_EQ' },
    // Parametric EQ — 5 channels × {frequency, q, gain}.
    { block: 'peq',   handPattern: /^channel_(\d+)_frequency$/, parameterPrefix: 'PEQ_FREQ' },
    { block: 'peq',   handPattern: /^channel_(\d+)_q$/,         parameterPrefix: 'PEQ_Q' },
    { block: 'peq',   handPattern: /^channel_(\d+)_gain$/,      parameterPrefix: 'PEQ_GAIN' },
    // Delay's pre/post EQ — 2 bands × {freq, q, gain}.
    { block: 'delay', handPattern: /^eq_freq_(\d+)$/,        parameterPrefix: 'DELAY_FREQ' },
    { block: 'delay', handPattern: /^eq_q_(\d+)$/,           parameterPrefix: 'DELAY_Q' },
    { block: 'delay', handPattern: /^eq_gain_(\d+)$/,        parameterPrefix: 'DELAY_GAIN' },
];

function tryPositional(block: string, handName: string):
    { parameterName: string; xmlLabel: string } | undefined
{
    for (const a of POSITIONAL_ALIGNMENTS) {
        if (a.block !== block) continue;
        const m = handName.match(a.handPattern);
        if (!m) continue;
        const parameterName = `${a.parameterPrefix}${m[1]}`;
        const entry = EDITOR_CONTROLS[parameterName];
        if (!entry) return undefined;
        return { parameterName, xmlLabel: entry.canonicalLabel };
    }
    return undefined;
}

// ── Universal block-level registers ───────────────────────────────
// BLOCK_MIX / BLOCK_PAN / BLOCK_LEVEL / BLOCK_BYPASS are wire registers
// the AM4 firmware exposes uniformly across every block, but AM4-Edit's
// UI only surfaces them in the blocks where they're musically relevant
// (e.g. Mix on a delay, not on a graphic EQ). The hand-curated registry
// knows the wire is there; we bridge the gap so agents can ask for
// `wah.mix` or `geq.balance` and get the canonical Mix / Balance label.
const BLOCK_UNIVERSAL_FALLBACK: Record<string, string> = {
    mix:     'BLOCK_MIX',
    balance: 'BLOCK_PAN',
    level:   'BLOCK_LEVEL',
    bypass:  'BLOCK_BYPASS',
};

function tryBlockUniversal(handName: string):
    { parameterName: string; xmlLabel: string } | undefined
{
    const parameterName = BLOCK_UNIVERSAL_FALLBACK[handName];
    if (!parameterName) return undefined;
    const entry = EDITOR_CONTROLS[parameterName];
    if (!entry) return undefined;
    return { parameterName, xmlLabel: entry.canonicalLabel };
}

const matches: Match[] = [];
const unmatchedHand: { block: string; cacheId: number; handName: string }[] = [];

// Build an index of EDITOR_CONTROLS by XML block: list of {parameterName, label}.
const xmlByBlock: Map<string, Array<{ parameterName: string; label: string; normalizedLabel: string }>> = new Map();
for (const [pname, entry] of Object.entries(EDITOR_CONTROLS)) {
    for (const ctx of entry.contexts) {
        const list = xmlByBlock.get(ctx.block) ?? [];
        list.push({
            parameterName: pname,
            label: ctx.label,
            normalizedLabel: normalizeLabel(ctx.label),
        });
        xmlByBlock.set(ctx.block, list);
    }
}

let totalHandEntries = 0;
let matchedCount = 0;

for (const [pBlock, blockEntries] of Object.entries(PARAM_NAMES)) {
    const xmlBlocks = BLOCK_TO_XML[pBlock] ?? [pBlock];
    const candidates = xmlBlocks.flatMap(xb => xmlByBlock.get(xb) ?? []);

    for (const [cacheIdStr, entry] of Object.entries(blockEntries)) {
        totalHandEntries++;
        const cacheId = Number(cacheIdStr);
        const handName = getName(entry);
        const normalizedHand = normalizeLabel(handName);

        // Pass 1: display-label match. The resolver is firmware-truth
        // for parameterName at (block, cache_id), so even when the label
        // matches an EditorControl, prefer the resolver's parameterName
        // for this cache_id when it's available — corrects cases where
        // the same display label binds to multiple parameterNames across
        // variants (e.g., "Bass" → FUZZ_LOW vs FUZZ_BASS in different
        // drive types; the cache_id picks the right one). When the
        // label-match candidate IS in the resolver list, prefer it
        // (highest confidence — both label and resolver agree).
        const cand = candidates.find(c => c.normalizedLabel === normalizedHand);
        if (cand) {
            const resolverNames = resolverParametersAt(pBlock, cacheId);
            const parameterName = resolverNames.length > 0
                ? pickFromResolver(pBlock, resolverNames, cand.parameterName)
                : cand.parameterName;
            const xmlLabel = EDITOR_CONTROLS[parameterName]?.canonicalLabel ?? cand.label;
            matchedCount++;
            matches.push({
                block: pBlock,
                cacheId,
                handName,
                parameterName,
                xmlLabel,
                normalizedHand,
                normalizedXml: normalizeLabel(xmlLabel),
                matched: true,
                via: 'label',
            });
            continue;
        }

        // Pass 2: positional alignment for known band/channel patterns
        // (GEQ sliders, PEQ channels, delay EQ bands). Same resolver
        // override applies — the positional candidate's parameterName
        // is the preferred binding when the resolver covers it.
        const pos = tryPositional(pBlock, handName);
        if (pos) {
            const resolverNames = resolverParametersAt(pBlock, cacheId);
            const parameterName = resolverNames.length > 0
                ? pickFromResolver(pBlock, resolverNames, pos.parameterName)
                : pos.parameterName;
            const xmlLabel = EDITOR_CONTROLS[parameterName]?.canonicalLabel ?? pos.xmlLabel;
            matchedCount++;
            matches.push({
                block: pBlock,
                cacheId,
                handName,
                parameterName,
                xmlLabel,
                normalizedHand,
                normalizedXml: normalizeLabel(xmlLabel),
                matched: true,
                via: 'positional',
            });
            continue;
        }

        // Pass 3: resolver-direct fallback. If the resolver knows this
        // (block, cache_id), bind to its parameterName even though we
        // couldn't match by label or position. This catches every
        // hand-curated entry the resolver covers — the previous two
        // passes were limited to entries whose hand name could be
        // resolved via XML display labels. With no preferred candidate,
        // pickFromResolver applies the per-block family preference
        // (e.g. amp prefers DISTORT_* over CABINET_*).
        const resolverNames = resolverParametersAt(pBlock, cacheId);
        if (resolverNames.length > 0) {
            const parameterName = pickFromResolver(pBlock, resolverNames);
            const xmlLabel = EDITOR_CONTROLS[parameterName]?.canonicalLabel ?? parameterName;
            matchedCount++;
            matches.push({
                block: pBlock,
                cacheId,
                handName,
                parameterName,
                xmlLabel,
                normalizedHand,
                normalizedXml: normalizeLabel(xmlLabel),
                matched: true,
                via: 'resolver',
            });
            continue;
        }

        // Pass 4: universal block-level register fallback. mix / balance /
        // level / bypass are wire-uniform across every block; bind them
        // to BLOCK_MIX / BLOCK_PAN / BLOCK_LEVEL / BLOCK_BYPASS even when
        // AM4-Edit's UI doesn't surface a knob in this particular block.
        const universal = tryBlockUniversal(handName);
        if (universal) {
            matchedCount++;
            matches.push({
                block: pBlock,
                cacheId,
                handName,
                parameterName: universal.parameterName,
                xmlLabel: universal.xmlLabel,
                normalizedHand,
                normalizedXml: normalizeLabel(universal.xmlLabel),
                matched: true,
                via: 'block-universal',
            });
            continue;
        }

        unmatchedHand.push({ block: pBlock, cacheId, handName });
    }
}

// Compute reverse: which XML parameterNames are matched and which aren't.
const matchedParameterNames = new Set(matches.map(m => m.parameterName));
const unmatchedXml: Array<{ parameterName: string; canonicalLabel: string; blocks: string[] }> = [];
for (const [pname, entry] of Object.entries(EDITOR_CONTROLS)) {
    if (matchedParameterNames.has(pname)) continue;
    const blocks = [...new Set(entry.contexts.map(c => c.block))];
    unmatchedXml.push({ parameterName: pname, canonicalLabel: entry.canonicalLabel, blocks });
}

const labelMatches      = matches.filter(m => m.via === 'label').length;
const positionalMatches = matches.filter(m => m.via === 'positional').length;
const resolverMatches   = matches.filter(m => m.via === 'resolver').length;
const universalMatches  = matches.filter(m => m.via === 'block-universal').length;

console.log(`paramNames entries:    ${totalHandEntries}`);
console.log(`bridge matches:        ${matchedCount} (${(100 * matchedCount / totalHandEntries).toFixed(1)}%)`);
console.log(`  via label:           ${labelMatches}`);
console.log(`  via positional:      ${positionalMatches}`);
console.log(`  via resolver:        ${resolverMatches}`);
console.log(`  via block-universal: ${universalMatches}`);
console.log(`unmatched hand entries:${unmatchedHand.length}`);
console.log(`unmatched XML params:  ${unmatchedXml.length}`);

// Per-block match summary
const perBlock: Record<string, { hand: number; matched: number }> = {};
for (const [pBlock] of Object.entries(PARAM_NAMES)) perBlock[pBlock] = { hand: 0, matched: 0 };
for (const [pBlock, entries] of Object.entries(PARAM_NAMES)) {
    perBlock[pBlock].hand = Object.keys(entries).length;
}
for (const m of matches) perBlock[m.block].matched++;

console.log('\nPer-block coverage:');
console.log('block           hand   matched    %');
for (const [b, s] of Object.entries(perBlock).sort((a, b) => b[1].hand - a[1].hand)) {
    const pct = s.hand === 0 ? '-' : (100 * s.matched / s.hand).toFixed(0);
    console.log(`  ${b.padEnd(12)} ${String(s.hand).padStart(5)}  ${String(s.matched).padStart(7)}  ${pct.padStart(3)}%`);
}

writeFileSync(OUT_JSON, JSON.stringify({
    summary: {
        totalHandEntries,
        matchedCount,
        matchPct: matchedCount / totalHandEntries,
        labelMatches,
        positionalMatches,
        resolverMatches,
        universalMatches,
        unmatchedHandCount: unmatchedHand.length,
        unmatchedXmlCount: unmatchedXml.length,
    },
    perBlock,
    matches,
    unmatchedHand,
    unmatchedXml,
}, null, 2));

const md: string[] = [];
md.push('# paramNames ↔ XML bridge report');
md.push('');
md.push(`- paramNames entries: **${totalHandEntries}**`);
md.push(`- bridge matches: **${matchedCount}** (${(100*matchedCount/totalHandEntries).toFixed(1)}%)`);
md.push(`  - via display label: ${labelMatches}`);
md.push(`  - via positional alignment: ${positionalMatches}`);
md.push(`  - via resolver fallback: ${resolverMatches}`);
md.push(`  - via block-universal register: ${universalMatches}`);
md.push(`- unmatched hand entries: ${unmatchedHand.length}`);
md.push(`- unmatched XML parameterNames: ${unmatchedXml.length}`);
md.push('');
md.push('## Per-block coverage');
md.push('');
md.push('| block | hand | matched | % |');
md.push('|---|---:|---:|---:|');
for (const [b, s] of Object.entries(perBlock).sort((a, b) => b[1].hand - a[1].hand)) {
    const pct = s.hand === 0 ? '-' : `${(100 * s.matched / s.hand).toFixed(0)}%`;
    md.push(`| ${b} | ${s.hand} | ${s.matched} | ${pct} |`);
}
md.push('');
md.push('## Confirmed matches (sample of first 30)');
md.push('');
md.push('| block | cacheId | hand name | parameterName | XML label |');
md.push('|---|---:|---|---|---|');
for (const m of matches.slice(0, 30)) {
    md.push(`| ${m.block} | ${m.cacheId} | \`${m.handName}\` | \`${m.parameterName}\` | ${m.xmlLabel} |`);
}
md.push('');
md.push('## Unmatched hand entries (first 30)');
md.push('');
md.push('| block | cacheId | hand name | (no XML match) |');
md.push('|---|---:|---|---|');
for (const u of unmatchedHand.slice(0, 30)) {
    md.push(`| ${u.block} | ${u.cacheId} | \`${u.handName}\` | |`);
}
md.push('');
md.push('## Unmatched XML parameterNames (first 30)');
md.push('');
md.push('| parameterName | canonicalLabel | blocks |');
md.push('|---|---|---|');
for (const x of unmatchedXml.slice(0, 30)) {
    md.push(`| \`${x.parameterName}\` | ${x.canonicalLabel} | ${x.blocks.join(', ')} |`);
}

writeFileSync(OUT_MD, md.join('\n'));
console.log(`\nWrote ${OUT_JSON}`);
console.log(`Wrote ${OUT_MD}`);

// ── Generate src/protocol/parameterBridge.ts ──────────────────────
// Static `(block, name) → { parameterName, canonicalLabel }` map
// derived from the matches above. This is the runtime-consumable
// artifact: server code calls resolveBridge('amp', 'bright_cap')
// and gets back the AM4-Edit canonical display label and symbolic
// ID for that parameter.

const tsLines: string[] = [];
tsLines.push('/**');
tsLines.push(' * Generated by scripts/bridge-paramnames-to-xml.ts. Do not hand-edit.');
tsLines.push(' *');
tsLines.push(' * Joins the hand-curated paramNames.ts to the XML-derived');
tsLines.push(' * editorControlLabels.ts and exposes the result as a runtime lookup');
tsLines.push(' * keyed by (block, snake_case_name). Each entry binds:');
tsLines.push(' *   - parameterName: AM4-Edit\'s internal symbolic ID');
tsLines.push(' *     (e.g. "DISTORT_BRIGHTCAP" — usable as a stable cross-firmware key)');
tsLines.push(' *   - canonicalLabel: the display label AM4-Edit shows on its UI');
tsLines.push(' *     (e.g. "Bright Cap" — used in tool descriptions and agent output');
tsLines.push(' *     so the agent\'s vocabulary matches what the user reads on screen)');
tsLines.push(' *');
tsLines.push(' * This module is a strict refinement layer over paramNames.ts: the');
tsLines.push(' * underlying wire IDs are unchanged. Only labels and parameterNames');
tsLines.push(' * are added. Coverage is reached via four passes: display-label');
tsLines.push(' * match, positional alignment (GEQ/PEQ band patterns), resolver-');
tsLines.push(' * direct fallback for entries the AM4-Edit dispatcher binds, and a');
tsLines.push(' * universal block-level register fallback (mix/balance/level/bypass)');
tsLines.push(' * for wire registers AM4-Edit does not surface in every block UI.');
tsLines.push(' */');
tsLines.push('');
tsLines.push('export interface ParameterBridgeEntry {');
tsLines.push('    block: string;');
tsLines.push('    name: string;');
tsLines.push('    parameterName: string;');
tsLines.push('    canonicalLabel: string;');
tsLines.push('}');
tsLines.push('');
tsLines.push(`export const PARAMETER_BRIDGE_FIRMWARE = 'AM4-Edit Mar 20 2026 build';`);
tsLines.push('');

const bridgeMap: Record<string, Record<string, { parameterName: string; canonicalLabel: string }>> = {};
for (const m of matches) {
    if (!bridgeMap[m.block]) bridgeMap[m.block] = {};
    bridgeMap[m.block][m.handName] = {
        parameterName: m.parameterName,
        canonicalLabel: m.xmlLabel,
    };
}
tsLines.push('export const PARAMETER_BRIDGE: Readonly<Record<string, Readonly<Record<string, { readonly parameterName: string; readonly canonicalLabel: string }>>>> = {');
for (const block of Object.keys(bridgeMap).sort()) {
    tsLines.push(`    ${block}: {`);
    for (const name of Object.keys(bridgeMap[block]).sort()) {
        const { parameterName, canonicalLabel } = bridgeMap[block][name];
        tsLines.push(`        ${JSON.stringify(name)}: { parameterName: ${JSON.stringify(parameterName)}, canonicalLabel: ${JSON.stringify(canonicalLabel)} },`);
    }
    tsLines.push('    },');
}
tsLines.push('};');
tsLines.push('');
tsLines.push('/**');
tsLines.push(' * Resolve the AM4-Edit canonical display label and symbolic');
tsLines.push(' * parameterName for a (block, name) pair from paramNames.ts.');
tsLines.push(' *');
tsLines.push(' * Returns undefined if the (block, name) has no XML correspondence');
tsLines.push(' * yet — the caller should fall back to the snake_case name from');
tsLines.push(' * paramNames.ts as the display label.');
tsLines.push(' */');
tsLines.push('export function resolveBridge(block: string, name: string):');
tsLines.push('    | { parameterName: string; canonicalLabel: string }');
tsLines.push('    | undefined');
tsLines.push('{');
tsLines.push('    return PARAMETER_BRIDGE[block]?.[name];');
tsLines.push('}');
tsLines.push('');
tsLines.push('/** Canonical label for a (block, name), or the original `name`. */');
tsLines.push('export function preferredDisplayLabel(block: string, name: string): string {');
tsLines.push('    return PARAMETER_BRIDGE[block]?.[name]?.canonicalLabel ?? name;');
tsLines.push('}');

writeFileSync(OUT_TS, tsLines.join('\n'));
console.log(`Wrote ${OUT_TS}  (${matchedCount} bound (block, name) pairs)`);
