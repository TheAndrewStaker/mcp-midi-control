/**
 * Axe-Fx II lineage extractor.
 *
 * Re-keys the AM4 lineage JSONs (already extracted from the Fractal
 * wiki by `scripts/extract-lineage.ts`) against the Axe-Fx II enum
 * tables in `src/fractal/axe-fx-ii/params.ts`. The wiki source is shared
 * across Fractal's product line, so we don't re-parse — we just match
 * each axefx2 enum entry to a wiki record and write a parallel JSON.
 *
 * Emits:
 *   src/fractal/shared/lineage/axefx2-amp-lineage.json
 *   src/fractal/shared/lineage/axefx2-drive-lineage.json
 *   src/fractal/shared/lineage/axefx2-reverb-lineage.json
 *   src/fractal/shared/lineage/axefx2-delay-lineage.json
 *
 * Matching heuristics (in order, first match wins):
 *   1. Direct normalized match (case + punctuation folded).
 *   2. Reverb word-order swap — Axe-Fx II "<SIZE> <FAMILY>" maps to
 *      AM4 "<FAMILY>, <SIZE>" (e.g. "MEDIUM HALL" → "Hall, Medium").
 *   3. Abbreviation expansion — Axe-Fx II's 16-char display constraint
 *      truncates words ("NRML"→"NORMAL", "VIB"→"VIBRATO", "BRT"→"BRIGHT",
 *      "BR"→"BRIGHT", "PRE"→"PRESET", "HI"→"HIGH", "LO"→"LOW").
 *   4. Prefix match — axefx2 name is a prefix of an AM4 wiki entry
 *      (e.g. "USA IIC+" matches "USA MARK IIC+ LEAD BRIGHT" — the
 *      family-level lineage applies even when axefx2 has a generic
 *      summary entry rather than per-variant ones).
 *
 * Unmatched entries get emitted with `flags: ['VERIFY: no wiki match']`
 * so the lookup_lineage tool can still surface the model name + flag
 * status. A future hardware/manual sweep can promote them.
 *
 * Status: 🟡 wiki-documented, not yet hardware-verified on Quantum 8.02.
 *
 * DO NOT EDIT THE OUTPUT JSONs BY HAND. Regenerate via:
 *   npx tsx scripts/extract-axe-fx-ii-lineage.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// Lineage data + Axe-Fx II param source live in the sibling `fractal-midi`
// repo (per the Phase-B extraction, 2026-05-18). This is a maintainer-
// only data-gen script — it edits source files in `fractal-midi/`, so it
// can't use `require.resolve('fractal-midi/shared')` (that points at the
// built dist). Assumes the sibling-repo layout `C:/dev/{mcp-midi-tools,
// fractal-midi}` documented in `docs/research/fractal-midi-extraction-plan.md`.
const FRACTAL_MIDI_REPO = path.resolve(ROOT, '..', 'fractal-midi');
const LINEAGE_DIR = path.join(FRACTAL_MIDI_REPO, 'src', 'shared', 'lineage');
const PARAMS_PATH = path.join(FRACTAL_MIDI_REPO, 'src', 'axe-fx-ii', 'params.ts');

if (!existsSync(FRACTAL_MIDI_REPO)) {
    console.error(
        `extract-axe-fx-ii-lineage: sibling fractal-midi repo not found at ${FRACTAL_MIDI_REPO}.\n` +
        `Set up the sibling layout (clone fractal-midi next to mcp-midi-tools) or run this script from elsewhere.`,
    );
    process.exit(1);
}

// ─── Matching helpers ────────────────────────────────────────────────────

/** Normalize for fuzzy comparison: lowercase, strip apostrophes / TM /
 *  ®, collapse non-alphanumeric (preserving `+` so "IIC+" stays
 *  distinct from "IIC++"). Same shape as the AM4 extractor's
 *  `normalizeForMatch`. */
function norm(s: string): string {
    return s
        .toLowerCase()
        .replace(/[’']/g, '')
        .replace(/[®™]/g, '')
        .replace(/[^a-z0-9+]+/g, ' ')
        .trim();
}

/** Common Axe-Fx II 16-char display abbreviations → expanded form.
 *  Each rule is applied as a token replacement in normalized space. */
const ABBREVS: ReadonlyArray<readonly [string, string]> = [
    ['nrml', 'normal'],
    ['nrm', 'normal'],
    ['vib', 'vibrato'],
    ['brt', 'bright'],
    ['br', 'bright'],         // applied AFTER 'brt' so "BRIGHT" doesn't get over-folded
    ['hi', 'high'],
    ['lo', 'low'],
    ['med', 'medium'],
    ['lg', 'large'],
    ['sm', 'small'],
    ['drv', 'drive'],
    ['dist', 'distortion'],
    ['nrmnl', 'normal'],
    ['nrm1', 'normal 1'],
    ['nrm2', 'normal 2'],
    ['ovrdrv', 'overdrive'],
    ['vntg', 'vintage'],
    ['mdrn', 'modern'],
    ['mod', 'modern'],
    ['blk', 'black'],
    ['orng', 'orange'],
    ['org', 'orange'],            // BK-047: "RECTO1 ORG MDRN" → "Recto1 Orange Modern". The Mesa Dual Rectifier's "Orange channel" is the Original channel — wiki convention is the color label, not the channel role.
    ['or', 'orange'],
    ['rd', 'red'],
    ['gn', 'green'],
    ['ylw', 'yellow'],
    ['silv', 'silver'],
    ['slvr', 'silver'],
    ['cln', 'clean'],
    ['rhy', 'rhythm'],
    ['ld', 'lead'],
    ['dp', 'deep'],
    ['clsc', 'classic'],
    ['jump', 'jumped'],
    ['lvrpool', 'liverpool'],
    ['blknshp', 'blankenship'],
    ['pwr', 'power'],
    ['pwramp', 'poweramp'],
    ['acus', 'acoustic'],
    ['tx', 'texas'],
    ['cali', 'cameron'],          // "CALI LEGGY" → "Cameron Leggy" per wiki
    ['ca', 'cameron'],            // "CA3+", "CA OD-2", "CA TRIPTIK ..."
    ['rec', 'recording'],
    ['btq', 'boutique'],
];

/** Expand abbreviations in a normalized name. Try multiple variants —
 *  axefx2's "65 BASSGUY NRML" expands to "65 BASSGUY NORMAL" + tries
 *  matching either way. */
function expandAbbrevs(normalized: string): string[] {
    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [normalized];
    const variants = new Set<string>();
    variants.add(normalized);
    // Apply each rule and collect all the expansion outcomes.
    for (const [from, to] of ABBREVS) {
        const next = tokens.map((t) => (t === from ? to : t)).join(' ');
        if (next !== normalized) variants.add(next);
    }
    // Also try double-expansion (handles "65 NRML BR" → "65 NORMAL BRIGHT").
    const second = tokens
        .map((t) => {
            const rule = ABBREVS.find((r) => r[0] === t);
            return rule ? rule[1] : t;
        })
        .join(' ');
    variants.add(second);
    return [...variants];
}

/** Reverb word-swap: "SMALL ROOM" → "Room, Small" so the swapped form
 *  matches the AM4 reverb-lineage `am4Name` convention. */
function reverbWordSwaps(name: string): string[] {
    const tokens = norm(name).split(/\s+/).filter(Boolean);
    if (tokens.length !== 2) return [];
    const [size, family] = tokens;
    return [`${family}, ${size}`, `${family} ${size}`];
}

// ─── Wiki record loader ──────────────────────────────────────────────────

interface LineageRecord {
    am4Name?: string;
    wikiName?: string;
    [key: string]: unknown;
}

interface LineageJSON {
    _source: string;
    _extractedAt: string;
    _catalogSize: number;
    _recordCount: number;
    records: LineageRecord[];
}

function loadLineage(block: 'amp' | 'drive' | 'reverb' | 'delay'): LineageJSON {
    return JSON.parse(readFileSync(path.join(LINEAGE_DIR, `${block}-lineage.json`), 'utf8'));
}

interface MatchIndex {
    /** Direct lookup by normalized full key (wikiName or am4Name). */
    byNorm: Map<string, LineageRecord>;
    /** Records sorted by normalized wikiName length descending — used
     *  for prefix matching ("USA IIC+" → "USA MARK IIC+ LEAD BRIGHT"). */
    forPrefixMatch: Array<{ key: string; record: LineageRecord }>;
}

function buildIndex(lineage: LineageJSON): MatchIndex {
    const byNorm = new Map<string, LineageRecord>();
    const forPrefixMatch: Array<{ key: string; record: LineageRecord }> = [];
    for (const r of lineage.records) {
        const keys = [r.wikiName, r.am4Name].filter(
            (s): s is string => typeof s === 'string' && s.length > 0,
        );
        for (const k of keys) {
            const n = norm(k);
            if (!byNorm.has(n)) byNorm.set(n, r);
            forPrefixMatch.push({ key: n, record: r });
        }
    }
    forPrefixMatch.sort((a, b) => b.key.length - a.key.length);
    return { byNorm, forPrefixMatch };
}

// ─── Axe-Fx II enum loader ───────────────────────────────────────────────

const PARAMS_SRC = readFileSync(PARAMS_PATH, 'utf8');

function extractEnum(name: string): { wireIndex: number; name: string }[] {
    const start = PARAMS_SRC.indexOf(`export const ${name}_EFFECT_TYPE_VALUES`);
    if (start < 0) return [];
    const open = PARAMS_SRC.indexOf('{', start);
    const close = PARAMS_SRC.indexOf('});', open);
    const body = PARAMS_SRC.slice(open + 1, close);
    const out: { wireIndex: number; name: string }[] = [];
    for (const line of body.split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+):\s*"([^"]+)"/);
        if (m) out.push({ wireIndex: Number(m[1]), name: m[2] });
    }
    return out;
}

// ─── Per-block extraction ────────────────────────────────────────────────

interface AxeFxIIRecord {
    /** UPPERCASE display name from the Axe-Fx II enum table. */
    axefx2Name: string;
    /** Wire index 0..N within the enum table. */
    wireIndex: number;
    /** Match strategy used (for diagnostics + agent confidence). */
    matchVia: 'direct' | 'reverb-swap' | 'abbrev-expand' | 'prefix' | 'unmatched';
    /** The matched AM4-lineage record's content, copied through.
     *  Empty for unmatched entries. */
    am4Name?: string;
    wikiName?: string;
    description?: string;
    family?: string;
    familyType?: string;
    basedOn?: unknown;
    fractalQuotes?: unknown[];
    artistNotes?: unknown[];
    originalCab?: string;
    matchingDynaCab?: string;
    powerTubes?: string;
    flags: string[];
}

function tryMatch(
    enumName: string,
    index: MatchIndex,
    block: string,
): { record: LineageRecord; matchVia: AxeFxIIRecord['matchVia'] } | undefined {
    // 1. Direct normalized match.
    const direct = index.byNorm.get(norm(enumName));
    if (direct) return { record: direct, matchVia: 'direct' };

    // 2. Reverb word-swap.
    if (block === 'reverb') {
        for (const swapped of reverbWordSwaps(enumName)) {
            const m = index.byNorm.get(norm(swapped));
            if (m) return { record: m, matchVia: 'reverb-swap' };
        }
    }

    // 3. Abbreviation expansion.
    for (const variant of expandAbbrevs(norm(enumName))) {
        if (variant === norm(enumName)) continue;
        const m = index.byNorm.get(variant);
        if (m) return { record: m, matchVia: 'abbrev-expand' };
    }

    // 3b. USA → "USA MK" injection (BK-047). Axe-Fx II's 16-char display
    //     drops the "MK" from Mesa Mark naming — `USA IIC+` corresponds
    //     to wiki's `USA MK IIC+`. Try the injected form against the
    //     direct index, then against abbrev-expand variants of the
    //     injected form (covers `USA IIC+ BRT` → `USA MK IIC+ BRIGHT`).
    //     Only fires when the enum name starts with `usa ` and doesn't
    //     already have `mk` as the second token.
    const enumNorm = norm(enumName);
    if (enumNorm.startsWith('usa ') && !enumNorm.startsWith('usa mk ')) {
        const injected = `usa mk ${enumNorm.slice(4)}`;
        const direct = index.byNorm.get(injected);
        if (direct) return { record: direct, matchVia: 'abbrev-expand' };
        for (const variant of expandAbbrevs(injected)) {
            if (variant === injected) continue;
            const m = index.byNorm.get(variant);
            if (m) return { record: m, matchVia: 'abbrev-expand' };
        }
    }

    // 4. Prefix match — axefx2 name is a prefix of the AM4 wiki entry.
    //    Useful when axefx2 has a "family head" entry summarizing many
    //    AM4 variants. Sorted longest-first so most specific wins.
    if (enumNorm.length >= 4) {
        for (const { key, record } of index.forPrefixMatch) {
            if (key === enumNorm) continue; // already tried in step 1
            if (key.startsWith(enumNorm + ' ')) return { record, matchVia: 'prefix' };
        }
    }

    return undefined;
}

function extractBlock(
    block: 'amp' | 'drive' | 'reverb' | 'delay',
    enumName: string,
): { records: AxeFxIIRecord[]; stats: { total: number; matched: number; unmatched: number; via: Record<string, number> } } {
    const lineage = loadLineage(block);
    const index = buildIndex(lineage);
    const entries = extractEnum(enumName);
    const records: AxeFxIIRecord[] = [];
    const via: Record<string, number> = {};
    for (const e of entries) {
        const m = tryMatch(e.name, index, block);
        if (!m) {
            records.push({
                axefx2Name: e.name,
                wireIndex: e.wireIndex,
                matchVia: 'unmatched',
                flags: ['VERIFY: no wiki match — Axe-Fx II enum entry has no AM4-lineage counterpart'],
            });
            via.unmatched = (via.unmatched ?? 0) + 1;
            continue;
        }
        const r = m.record;
        const rec: AxeFxIIRecord = {
            axefx2Name: e.name,
            wireIndex: e.wireIndex,
            matchVia: m.matchVia,
            flags: [],
        };
        // BK-046: detect AM4 records that themselves inherited their lineage
        // from a sibling. The upstream AM4 extractor copies authored prose
        // (description / fractalQuotes / artistNotes) along with structured
        // fields when it backfills, leaving mis-attributed prose that quotes
        // a different model (Cliff Chase Plexi quotes attached to a Bassman
        // record, for example). Split the field-copy: structured fields
        // (basedOn, family, hardware refs) inherit safely; authored prose
        // is skipped on inherited records and the omission surfaced via a
        // flag the agent can read.
        const upstreamFlags = Array.isArray(r.flags) ? (r.flags as string[]) : [];
        const isInheritedUpstream = upstreamFlags.some(
            (f) => typeof f === 'string' && f.startsWith('INHERITED:'),
        );
        // Structured fields — always inherit. Identify the algorithm/family
        // and physical hardware reference; safe to share across siblings.
        for (const k of [
            'am4Name', 'wikiName', 'family', 'familyType',
            'basedOn', 'originalCab', 'matchingDynaCab', 'powerTubes',
        ] as const) {
            if (r[k] !== undefined) (rec as unknown as Record<string, unknown>)[k] = r[k];
        }
        // Authored / context fields — skip when the AM4 source is itself
        // inherited (the prose belongs to the sibling it copied from, not
        // this model). When the AM4 source is original (no INHERITED flag),
        // these fields are trustworthy and pass through.
        if (!isInheritedUpstream) {
            for (const k of ['description', 'fractalQuotes', 'artistNotes'] as const) {
                if (r[k] !== undefined) (rec as unknown as Record<string, unknown>)[k] = r[k];
            }
        }
        // Carry the AM4 record's flags through. Often empty.
        rec.flags.push(...upstreamFlags);
        if (isInheritedUpstream) {
            rec.flags.push('inherited-prose-omitted: AM4 source carries sibling-inherited prose that may quote a different model — only structured fields (basedOn, family, powerTubes, originalCab) preserved.');
        }
        if (m.matchVia !== 'direct') {
            rec.flags.push(`VERIFY: matched via ${m.matchVia} — confirm wiki record applies to this Axe-Fx II model`);
        }
        records.push(rec);
        via[m.matchVia] = (via[m.matchVia] ?? 0) + 1;
    }
    return {
        records,
        stats: {
            total: entries.length,
            matched: entries.length - (via.unmatched ?? 0),
            unmatched: via.unmatched ?? 0,
            via,
        },
    };
}

// ─── Emit ────────────────────────────────────────────────────────────────

interface EmittedJSON {
    _source: string;
    _extractedAt: string;
    _enumSize: number;
    _matched: number;
    _unmatched: number;
    _matchedVia: Record<string, number>;
    _note: string;
    records: AxeFxIIRecord[];
}

function emit(
    block: 'amp' | 'drive' | 'reverb' | 'delay',
    enumName: string,
): void {
    const { records, stats } = extractBlock(block, enumName);
    const out: EmittedJSON = {
        _source: `Re-keyed from fractal-midi/src/shared/lineage/${block}-lineage.json against AMP_EFFECT_TYPE_VALUES from fractal-midi/src/axe-fx-ii/params.ts`,
        _extractedAt: new Date().toISOString(),
        _enumSize: stats.total,
        _matched: stats.matched,
        _unmatched: stats.unmatched,
        _matchedVia: stats.via,
        _note:
            'Status: wiki-documented (🟡), not yet hardware-verified on Q8.02. ' +
            'Records inherit lineage prose from the AM4 wiki entry; the ' +
            'matchVia field surfaces match-strategy confidence — `direct` is ' +
            'name-exact, `reverb-swap` / `abbrev-expand` / `prefix` should be ' +
            'spot-checked. Unmatched entries carry no lineage data; manual ' +
            'fill or a future hardware-aware extractor can promote them.',
        records,
    };
    const outPath = path.join(LINEAGE_DIR, `axefx2-${block}-lineage.json`);
    writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
    console.log(
        `${block.toUpperCase().padEnd(7)} ${stats.total} entries → ${stats.matched} matched (${Object.entries(stats.via).filter(([k]) => k !== 'unmatched').map(([k, v]) => `${k}=${v}`).join(', ')}), ${stats.unmatched} unmatched`,
    );
}

emit('amp', 'AMP');
emit('drive', 'DRIVE');
emit('reverb', 'REVERB');
emit('delay', 'DELAY');
console.log(`Done. Output: ${LINEAGE_DIR}/axefx2-{amp,drive,reverb,delay}-lineage.json`);
