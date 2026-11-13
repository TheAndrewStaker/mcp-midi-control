/**
 * Annotate every params.ts entry with `displayLabel` (AM4-Edit's on-
 * screen label) where the cross-reference audit finds a clean match.
 *
 * Algorithm:
 *   1. Load XML controls (parameterName → display name + effect context).
 *   2. Load Ghidra catalog (family → [{paramId, symbol}]).
 *   3. Load params.ts text. For each entry whose (block, pidLow, pidHigh)
 *      resolves to a catalog symbol that has an XML display label, insert
 *      `displayLabel: '<label>',` right after the `name:` line.
 *   4. Skip entries that already have a displayLabel (idempotent).
 *   5. Skip generic pidHigh range (0..9) and the channel register
 *      (0x07D2) — those are cross-block conventions, not catalog params.
 *   6. Write the modified file back.
 *
 * The block→family→pidLow map matches scripts/coverage-audit.ts and
 * scripts/_research/coverage-cross-ref-audit.ts; keep all three in sync
 * when a new family lands.
 *
 * Idempotent. Re-run after catalog or XML refresh to pick up new labels.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const PARAMS_TS = 'packages/am4/src/params.ts';
const GHIDRA_AM4 = 'samples/captured/decoded/ghidra-am4-paramnames.json';
const XML_REG = 'samples/captured/decoded/binarydata/extracted/__block_layout.xml';
const XML_EXPERT = 'samples/captured/decoded/binarydata/extracted/__block_layout_expert.xml';

const BLOCK_TO_FAMILY: Record<string, string> = {
  amp: 'DISTORT',
  drive: 'FUZZ', // NOT 'DISTORT' (the amp family): that mapping gave every drive knob an amp label
  reverb: 'REVERB',
  delay: 'DELAY',
  chorus: 'CHORUS',
  flanger: 'FLANGER',
  phaser: 'PHASER',
  rotary: 'ROTARY',
  tremolo: 'TREMOLO',
  wah: 'WAH',
  filter: 'FILTER',
  compressor: 'COMP',
  geq: 'GEQ',
  peq: 'PEQ',
  gate: 'GATE',
  enhancer: 'ENHANCER',
  volpan: 'VOLUME',
  ingate: 'INPUT',
  cab: 'CABINET',
  preset: 'PATCH',
};
const PIDLOW_TO_FAMILY: Record<number, string> = { 0x003e: 'CABINET' };

// 1. Load XML: parameterName → first display label found.
function loadXmlLabels(): Map<string, string> {
  const result = new Map<string, string>();
  const tagRe = /<EditorControl\b([^>]*?)\/?>/g;
  for (const path of [XML_REG, XML_EXPERT]) {
    const xml = readFileSync(path, 'utf-8');
    for (const m of xml.matchAll(tagRe)) {
      const attrs = m[1];
      const symMatch = attrs.match(/parameterName="([A-Z][A-Z0-9_]*)"/);
      if (!symMatch) continue;
      const sym = symMatch[1];
      if (result.has(sym)) continue; // first wins
      const nameMatch = attrs.match(/\bname="([^"]+)"/);
      if (!nameMatch) continue;
      const display = nameMatch[1].replace(/&#10;/g, ' ').trim();
      if (!display) continue;
      result.set(sym, display);
    }
  }
  return result;
}

// 2. Load catalog: (family, paramId) → symbol.
function loadCatalog(): Map<string, string> {
  const data = JSON.parse(readFileSync(GHIDRA_AM4, 'utf-8'));
  const out = new Map<string, string>();
  for (const eff of Object.values(data.effect_types) as any[]) {
    if (!eff.effectFamily || !eff.params) continue;
    for (const p of eff.params) {
      if (!p.name || p.name === '?') continue;
      out.set(`${eff.effectFamily}:${p.paramId}`, p.name);
    }
  }
  return out;
}

// 3. Build (block, pidLow, pidHigh) → display label.
function buildEntryLabelMap(
  xmlLabels: Map<string, string>,
  catalog: Map<string, string>,
): Map<string, string> {
  // We don't know each entry's pidLow upfront — we discover it while
  // walking params.ts. Instead, for each catalog (family, paramId),
  // pre-resolve the display label and look up by family+paramId during
  // the walk.
  const out = new Map<string, string>(); // key: `${family}:${paramId}` → display
  for (const [k, sym] of catalog) {
    const disp = xmlLabels.get(sym);
    if (disp) out.set(k, disp);
  }
  return out;
}

// 4. Walk params.ts text, insert displayLabel after the `name:` line for
// each entry that resolves to a known label.

interface EntryHit {
  startIdx: number;            // start of entry block
  bodyStart: number;           // first char after `{`
  bodyEnd: number;             // position of closing `}` (no nesting)
  nameMatchStart: number;      // absolute idx of `name: 'X',` start
  nameMatchEnd: number;        // absolute idx after the trailing comma
  followsNewline: boolean;     // true if name: ends with a newline (multi-line entry)
  baseIndent: string;          // indentation of body (e.g. "    ")
  hasDisplayLabel: boolean;
  block: string;
  pidLow: number;
  pidHigh: number;
}
function findEntries(src: string): EntryHit[] {
  // For each `  'block.name': {` start, find the matching `}` (entries
  // have no nested braces — enumValues etc. reference CONSTs, not inline
  // objects). Within the body, locate the `name: 'X',` substring; that's
  // our insertion anchor.
  const out: EntryHit[] = [];
  const propStart = /^( {2,})'[a-z]+\.[a-z0-9_]+':\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = propStart.exec(src)) !== null) {
    const entryStart = m.index;
    const baseIndent = m[1] + '  '; // body is one level deeper
    // Find the next `}` — no nesting in this file.
    const bodyStart = propStart.lastIndex;
    const bodyEnd = src.indexOf('}', bodyStart);
    if (bodyEnd < 0) break;
    const body = src.slice(bodyStart, bodyEnd);

    const blockM = body.match(/\bblock:\s*'([a-z]+)'/);
    const nameM = body.match(/\bname:\s*'([a-z0-9_]+)',?/);
    const pidLowM = body.match(/\bpidLow:\s*(0x[0-9a-fA-F]+)/);
    const pidHighM = body.match(/\bpidHigh:\s*(0x[0-9a-fA-F]+)/);
    const hasDisplayLabel = /\bdisplayLabel:/.test(body);

    if (!blockM || !nameM || !pidLowM || !pidHighM) {
      propStart.lastIndex = bodyEnd;
      continue;
    }

    const nameRel = body.indexOf(nameM[0]);
    const nameAbs = bodyStart + nameRel;
    const nameEndAbs = nameAbs + nameM[0].length;
    // Check whether what follows is a newline (multi-line entry) or a
    // space (compact entry).
    const next = src.slice(nameEndAbs, nameEndAbs + 2);
    const followsNewline = /^\s*\r?\n/.test(next) === false ? false : true;

    out.push({
      startIdx: entryStart,
      bodyStart,
      bodyEnd,
      nameMatchStart: nameAbs,
      nameMatchEnd: nameEndAbs,
      followsNewline,
      baseIndent,
      hasDisplayLabel,
      block: blockM[1],
      pidLow: parseInt(pidLowM[1], 16),
      pidHigh: parseInt(pidHighM[1], 16),
    });
    propStart.lastIndex = bodyEnd;
  }
  return out;
}

// 5. Resolve display label for an entry.
function resolveLabel(
  hit: EntryHit,
  catalogByFamPid: Map<string, string>,
): string | undefined {
  // Skip generic + channel-register pidHighs.
  if (hit.pidHigh < 10) return undefined;
  if (hit.pidHigh === 0x07d2) return undefined;
  const family = PIDLOW_TO_FAMILY[hit.pidLow] ?? BLOCK_TO_FAMILY[hit.block];
  if (!family) return undefined;
  return catalogByFamPid.get(`${family}:${hit.pidHigh}`);
}

// 6. Main.
const xmlLabels = loadXmlLabels();
const catalog = loadCatalog();
const catalogByFamPid = buildEntryLabelMap(xmlLabels, catalog);
console.log(`Loaded ${xmlLabels.size} XML labels, ${catalog.size} catalog entries, ${catalogByFamPid.size} family-paramId → label mappings`);

const original = readFileSync(PARAMS_TS, 'utf-8');
const entries = findEntries(original);
console.log(`Found ${entries.length} entries in params.ts`);

// Plan inserts. Process in reverse order so indices don't shift.
interface Insert { atIdx: number; text: string; key: string; }
const inserts: Insert[] = [];
let withLabel = 0, withoutLabel = 0, alreadyHas = 0;
for (const hit of entries) {
  const label = resolveLabel(hit, catalogByFamPid);
  const keyForLog = `${hit.block} pidLow=0x${hit.pidLow.toString(16)} pidHigh=0x${hit.pidHigh.toString(16)}`;
  if (!label) {
    withoutLabel++;
    continue;
  }
  if (hit.hasDisplayLabel) {
    alreadyHas++;
    continue;
  }
  // Escape single quotes in the label.
  const escaped = label.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const insertText = hit.followsNewline
    ? `\n${hit.baseIndent}displayLabel: '${escaped}',`
    : ` displayLabel: '${escaped}',`;
  inserts.push({ atIdx: hit.nameMatchEnd, text: insertText, key: keyForLog });
  withLabel++;
}
console.log(`Will add displayLabel to ${withLabel} entries (${alreadyHas} already had it, ${withoutLabel} had no XML match)`);

// Apply inserts in reverse order.
inserts.sort((a, b) => b.atIdx - a.atIdx);
let result = original;
for (const ins of inserts) {
  result = result.slice(0, ins.atIdx) + ins.text + result.slice(ins.atIdx);
}
writeFileSync(PARAMS_TS, result);
console.log(`Wrote ${PARAMS_TS}`);
