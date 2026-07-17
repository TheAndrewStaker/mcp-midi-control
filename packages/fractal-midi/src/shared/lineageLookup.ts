/**
 * Lineage-lookup helpers shared between `am4_lookup_lineage` (single ask)
 * and `am4_lookup_lineages` (batch). The actual lineage data lives in
 * `src/fractal/shared/lineage/*-lineage.json` (sourced from the Fractal
 * wiki + Blocks Guide PDF; only Fractal-authored content is stored).
 *
 * The MCP server (`src/server/index.ts`) wraps these helpers — single-ask
 * formats hits as a hint-rich text block, the batch tool collects per-ask
 * structured results so the agent can correlate without re-parsing prose.
 *
 * Tests cover this layer directly via `scripts/verify-msg.ts`, which is
 * why the surface is exported instead of inlined in the server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, 'lineage');

export const LINEAGE_BLOCKS = [
  'amp', 'drive', 'reverb', 'delay', 'compressor',
  'phaser', 'chorus', 'flanger', 'wah',
  // 2026-07-15 (BK-104): AM4 stock DynaCab roster (45 records; names match
  // AM4_DYNACAB_ROSTER / amp.dynacab_*_cab enum labels exactly). Facts from
  // the wiki Cab_models_list DynaCabs section: real cab, speaker, quotes.
  'dynacab',
] as const;
export type LineageBlock = typeof LINEAGE_BLOCKS[number];

export interface LineageRecord {
  am4Name: string;
  wikiName?: string;
  basedOn?: {
    primary: string;
    manufacturer?: string;
    model?: string;
    productName?: string;
    source: string;
  };
  description?: string;
  descriptionSource?: string;
  fractalQuotes?: Array<{ text: string; url?: string; attribution?: string }>;
  artistNotes?: string[];
  flags?: string[];
  // amp-specific
  family?: string;
  powerTubes?: string;
  matchingDynaCab?: string;
  originalCab?: string;
  // dynacab-specific: the physical speaker in the captured cab
  speaker?: string;
  // drive-specific
  categories?: string[];
  clipTypes?: string[];
  // reverb-specific
  familyType?: string;
}

const lineageCache: Partial<Record<LineageBlock, LineageRecord[]>> = {};

export function loadLineage(block: LineageBlock): LineageRecord[] {
  const cached = lineageCache[block];
  if (cached) return cached;
  const file = path.join(KNOWLEDGE_DIR, `${block}-lineage.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Lineage data missing at ${file}. Run \`npm run extract-lineage\` to regenerate from the wiki scrape + Blocks Guide PDF.`,
    );
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { records?: LineageRecord[] };
  const records = parsed.records ?? [];
  lineageCache[block] = records;
  return records;
}

export function scoreRecord(rec: LineageRecord, query: string): number {
  const q = query.toLowerCase();
  let score = 0;
  // Structured field hits score highest — they're deterministic, unlike
  // substring matches on prose.
  if (rec.basedOn?.manufacturer?.toLowerCase() === q) score += 20;
  if (rec.basedOn?.model?.toLowerCase() === q) score += 20;
  if (rec.basedOn?.productName?.toLowerCase().includes(q)) score += 12;
  if (rec.am4Name.toLowerCase().includes(q)) score += 10;
  if (rec.basedOn?.primary.toLowerCase().includes(q)) score += 8;
  // Speaker asks ("greenback", "V30", "EV12L", "alnico") are the natural
  // reverse-lookup entry point for the dynacab corpus.
  if (rec.speaker && rec.speaker.toLowerCase().includes(q)) score += 8;
  if (rec.wikiName && rec.wikiName.toLowerCase().includes(q)) score += 5;
  if (rec.description && rec.description.toLowerCase().includes(q)) score += 5;
  for (const an of rec.artistNotes ?? []) {
    if (an.toLowerCase().includes(q)) score += 8;
  }
  for (const qt of rec.fractalQuotes ?? []) {
    if (qt.text.toLowerCase().includes(q)) score += 2;
  }
  return score;
}

export function matchesStructured(
  rec: LineageRecord,
  filter: { manufacturer?: string; model?: string },
): boolean {
  if (!rec.basedOn) return false;
  const ci = (a: string | undefined, b: string | undefined): boolean =>
    !b || (a?.toLowerCase() === b.toLowerCase());
  return (
    ci(rec.basedOn.manufacturer, filter.manufacturer) &&
    ci(rec.basedOn.model, filter.model)
  );
}

export function formatLineageRecord(rec: LineageRecord, includeQuotes: boolean, maxQuotes = 5): string {
  const lines: string[] = [`am4Name: ${rec.am4Name}`];
  if (rec.wikiName && rec.wikiName !== rec.am4Name) lines.push(`wikiName: ${rec.wikiName}`);
  if (rec.family) lines.push(`family: ${rec.family}`);
  if (rec.familyType) lines.push(`familyType: ${rec.familyType}`);
  if (rec.categories?.length) lines.push(`categories: ${rec.categories.join(', ')}`);
  if (rec.clipTypes?.length) lines.push(`clipTypes: ${rec.clipTypes.join(', ')}`);
  if (rec.powerTubes) lines.push(`powerTubes: ${rec.powerTubes}`);
  if (rec.originalCab) lines.push(`originalCab: ${rec.originalCab}`);
  if (rec.matchingDynaCab) lines.push(`matchingDynaCab: ${rec.matchingDynaCab}`);
  if (rec.speaker) lines.push(`speaker: ${rec.speaker}`);
  if (rec.basedOn) {
    const parts: string[] = [`basedOn: ${rec.basedOn.primary}`];
    if (rec.basedOn.manufacturer) parts.push(`manufacturer=${rec.basedOn.manufacturer}`);
    if (rec.basedOn.model) parts.push(`model=${rec.basedOn.model}`);
    if (rec.basedOn.productName) parts.push(`productName="${rec.basedOn.productName}"`);
    parts.push(`source=${rec.basedOn.source}`);
    lines.push(parts.join(' | '));
  }
  if (rec.description) lines.push(`description: ${rec.description}`);
  if (includeQuotes && rec.fractalQuotes?.length) {
    const shown = rec.fractalQuotes.slice(0, maxQuotes);
    lines.push(`fractalQuotes (${shown.length}/${rec.fractalQuotes.length}):`);
    for (const q of shown) {
      const url = q.url ? ` [${q.url}]` : '';
      lines.push(`  - "${q.text}"${url}`);
    }
  }
  if (rec.flags?.length) lines.push(`flags: ${rec.flags.join('; ')}`);
  return lines.join('\n');
}

export type LineageLookupAsk = {
  block_type: LineageBlock;
  name?: string;
  real_gear?: string;
  manufacturer?: string;
  model?: string;
};

export type LineageLookupHit = {
  am4Name: string;
  record: LineageRecord;
  // Score is only present for fuzzy real_gear lookups; structured filter
  // matches and forward name lookups omit it.
  score?: number;
};

export type LineageLookupResult =
  | {
      ask: LineageLookupAsk;
      found: true;
      shape: 'forward' | 'reverse' | 'structured';
      // Forward (name) returns at most one hit; structured/reverse can
      // return up to 10. Top hit is always at index 0.
      hits: LineageLookupHit[];
      totalScanned: number;
    }
  | {
      ask: LineageLookupAsk;
      found: false;
      shape: 'forward' | 'reverse' | 'structured' | 'invalid';
      reason: string;
      totalScanned: number;
    };

/**
 * Run a single lineage lookup, returning a structured result. Throws
 * `Error` only for shape-validation failures the single-ask tool already
 * surfaces as a thrown error (exactly-one-call-shape, real_gear too
 * short). Lineage misses return `{ found: false, reason }` so the batch
 * caller can carry on processing the rest of the asks.
 */
export function runLineageLookup(ask: LineageLookupAsk): LineageLookupResult {
  const hasStructured = !!(ask.manufacturer || ask.model);
  const shapeCount = [ask.name !== undefined, ask.real_gear !== undefined, hasStructured].filter(Boolean).length;
  if (shapeCount !== 1) {
    throw new Error(
      'lookup_lineage requires exactly one call shape: `name` (forward), `real_gear` (fuzzy reverse), or at least one structured filter (`manufacturer` / `model`).',
    );
  }
  const records = loadLineage(ask.block_type);

  if (hasStructured) {
    const matches = records.filter((r) => matchesStructured(r, { manufacturer: ask.manufacturer, model: ask.model }));
    if (matches.length === 0) {
      const filter = [
        ask.manufacturer && `manufacturer="${ask.manufacturer}"`,
        ask.model && `model="${ask.model}"`,
      ].filter(Boolean).join(', ');
      return {
        ask,
        found: false,
        shape: 'structured',
        reason: `No ${ask.block_type} records match ${filter}.`,
        totalScanned: records.length,
      };
    }
    return {
      ask,
      found: true,
      shape: 'structured',
      hits: matches.slice(0, 10).map((r) => ({ am4Name: r.am4Name, record: r })),
      totalScanned: records.length,
    };
  }

  if (ask.name !== undefined) {
    const q = ask.name.toLowerCase().trim();
    const exact = records.find(
      (r) => r.am4Name.toLowerCase() === q || r.wikiName?.toLowerCase() === q,
    );
    const partial = exact ?? records.find(
      (r) => r.am4Name.toLowerCase().includes(q) || r.wikiName?.toLowerCase().includes(q),
    );
    if (!partial) {
      return {
        ask,
        found: false,
        shape: 'forward',
        reason: `No ${ask.block_type} lineage record matches "${ask.name}".`,
        totalScanned: records.length,
      };
    }
    return {
      ask,
      found: true,
      shape: 'forward',
      hits: [{ am4Name: partial.am4Name, record: partial }],
      totalScanned: records.length,
    };
  }

  // Reverse lookup.
  const query = ask.real_gear!.trim();
  if (query.length < 2) {
    throw new Error('`real_gear` query must be at least 2 characters.');
  }
  const scored = records
    .map((r) => ({ r, score: scoreRecord(r, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (scored.length === 0) {
    return {
      ask,
      found: false,
      shape: 'reverse',
      reason: `No ${ask.block_type} records mention "${query}".`,
      totalScanned: records.length,
    };
  }
  return {
    ask,
    found: true,
    shape: 'reverse',
    hits: scored.map(({ r, score }) => ({ am4Name: r.am4Name, record: r, score })),
    totalScanned: records.length,
  };
}
