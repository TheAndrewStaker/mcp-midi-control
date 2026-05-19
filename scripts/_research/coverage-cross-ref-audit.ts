/**
 * Coverage cross-reference audit — three-way join over Ghidra catalog,
 * AM4-Edit UI XML, and params.ts. Catches the OUTPUT_SCENE1 class of
 * false-coverage gap: existing per-block audit joins on (block, paramId)
 * alone and missed cases where the catalog symbol differs from the
 * AM4-Edit display name AND params.ts uses the display-name-derived key.
 *
 * Sources joined:
 *   1. samples/captured/decoded/ghidra-am4-paramnames.json
 *      — for each family: { paramId, symbol }.
 *   2. samples/captured/decoded/binarydata/extracted/__block_layout*.xml
 *      — for each UI control: parameterName (binary symbol) + name
 *      (display string) + optional effectName (block id).
 *   3. packages/am4/src/params.ts
 *      — every shipped entry: block, name, pidLow, pidHigh.
 *
 * Classification per catalog (family, paramId, symbol):
 *   • WIRED-MATCHED   — params.ts has an entry at this pidLow+paramId,
 *                       its name matches the XML display string.
 *   • WIRED-MISLABEL  — params.ts has an entry at this pidLow+paramId,
 *                       but its name doesn't match the XML display.
 *                       (Earlier audit would call this "wired correctly,"
 *                       the existing per-block audit would call this
 *                       "decoded" without flagging the rename.)
 *   • UI-MISSING      — XML exposes this symbol with a display name,
 *                       params.ts has nothing at the matching pidLow+
 *                       paramId. Real wiring gap.
 *   • GHOST           — catalog has the symbol, XML doesn't expose it.
 *                       Likely firmware-internal; don't count against
 *                       UI coverage.
 *   • PIDLOW-UNKNOWN  — family has no derivable pidLow from params.ts
 *                       (entire family un-bound — common for families
 *                       like PITCH/MULTITAP that aren't AM4 blocks).
 *
 * Output: samples/captured/decoded/coverage-cross-ref-audit.md
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// AM4 params now live in the `fractal-midi` npm package. Resolve via the
// package's subpath export so the path works regardless of where the
// consumer cloned mcp-midi-control. The compiled `.js` preserves the
// object-literal entry shape this script's regex matches.
const require = createRequire(import.meta.url);
const FRACTAL_MIDI_AM4_DIR = dirname(require.resolve('fractal-midi/am4'));

const GHIDRA_AM4 = 'samples/captured/decoded/ghidra-am4-paramnames.json';
const PARAMS_TS = join(FRACTAL_MIDI_AM4_DIR, 'params.js');
const XML_REG = 'samples/captured/decoded/binarydata/extracted/__block_layout.xml';
const XML_EXPERT = 'samples/captured/decoded/binarydata/extracted/__block_layout_expert.xml';
const OUTPUT = 'samples/captured/decoded/coverage-cross-ref-audit.md';

// --- 1. Load XML controls ----------------------------------------------

interface XmlControl {
  displayName: string;
  effectName?: string;
}
function loadXmlControls(): Map<string, XmlControl[]> {
  const result = new Map<string, XmlControl[]>();
  const xmls = [readFileSync(XML_REG, 'utf-8'), readFileSync(XML_EXPERT, 'utf-8')];
  // Each EditorControl is a single tag (self-closing). Extract attrs.
  const tagRe = /<EditorControl\b([^>]*?)\/?>/g;
  for (const xml of xmls) {
    for (const m of xml.matchAll(tagRe)) {
      const attrs = m[1];
      const symMatch = attrs.match(/parameterName="([A-Z][A-Z0-9_]*)"/);
      if (!symMatch) continue;
      const sym = symMatch[1];
      const nameMatch = attrs.match(/\bname="([^"]+)"/);
      const effMatch = attrs.match(/effectName="([^"]+)"/);
      const displayName = (nameMatch?.[1] ?? '').replace(/&#10;/g, ' ');
      const ctrl: XmlControl = { displayName };
      if (effMatch) ctrl.effectName = effMatch[1];
      const list = result.get(sym) ?? [];
      list.push(ctrl);
      result.set(sym, list);
    }
  }
  return result;
}

// --- 2. Load Ghidra catalog --------------------------------------------

interface CatalogEntry {
  paramId: number;
  symbol: string;
}
function loadCatalog(): Map<string, CatalogEntry[]> {
  const data = JSON.parse(readFileSync(GHIDRA_AM4, 'utf-8'));
  const result = new Map<string, CatalogEntry[]>();
  for (const eff of Object.values(data.effect_types) as any[]) {
    if (!eff.effectFamily || !eff.params) continue;
    const arr: CatalogEntry[] = eff.params
      .filter((p: any) => p.name && p.name !== '?')
      .map((p: any) => ({ paramId: p.paramId, symbol: p.name }));
    result.set(eff.effectFamily, arr);
  }
  return result;
}

// --- 3. Load params.ts entries -----------------------------------------

interface ParamEntry {
  key: string;       // e.g. "amp.gain"
  block: string;     // e.g. "amp"
  name: string;      // e.g. "gain"
  pidLow: number;
  pidHigh: number;
}
function loadParamsTs(): ParamEntry[] {
  const ts = readFileSync(PARAMS_TS, 'utf-8');
  const re =
    /^\s+'([a-z]+\.[a-z0-9_]+)':\s*\{[\s\S]*?block:\s*'([a-z]+)',\s*name:\s*'([a-z0-9_]+)',[\s\S]*?pidLow:\s*(0x[0-9a-fA-F]+),\s*pidHigh:\s*(0x[0-9a-fA-F]+)/gm;
  const result: ParamEntry[] = [];
  for (const m of ts.matchAll(re)) {
    result.push({
      key: m[1],
      block: m[2],
      name: m[3],
      pidLow: parseInt(m[4], 16),
      pidHigh: parseInt(m[5], 16),
    });
  }
  return result;
}

// --- 4. Family → pidLow map -------------------------------------------
//
// Built from BLOCK_TO_FAMILY (block name → family) + PIDLOW_TO_FAMILY
// override (for the amp/cabinet split where one user-facing block name
// spans two protocol pidLows). The actual pidLow values are derived
// from params.ts entries: for each block, find the pidLow of its
// entries; that's the family's pidLow. Families with no block mapping
// → PIDLOW-UNKNOWN (not placeable on AM4 — PITCH / MULTITAP / etc.).
//
// Stays in sync with scripts/coverage-audit.ts's BLOCK_TO_FAMILY +
// PIDLOW_TO_FAMILY tables. Keep both files updated together when a
// new block family lands.

const BLOCK_TO_FAMILY: Record<string, string> = {
  amp: 'DISTORT',
  drive: 'DISTORT',
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
// pidLow → family override. Wins over BLOCK_TO_FAMILY when an
// entry's pidLow matches (e.g. amp.cabinet_* under block='amp' but
// at pidLow=0x003e belongs to CABINET, not DISTORT).
const PIDLOW_TO_FAMILY: Record<number, string> = {
  0x003e: 'CABINET',
  // GLOBAL (case 0x1 in dispatcher) — Session 96 (HW-112) cracked
  // pidLow=0x0001; 98 entries shipped under block:'global' in params.ts.
  // BLOCK_TO_FAMILY can't reach this because 'global' isn't a placeable
  // AM4 block, and the family-detection majority-vote needs the override
  // to count it as anything but PIDLOW-UNKNOWN. See docs/devices/am4/SYSEX-MAP.md §6bb.
  0x0001: 'GLOBAL',
};

function derivePidlowMap(params: ParamEntry[]): Map<string, number> {
  // family → pidLow → count
  const counts = new Map<string, Map<number, number>>();
  for (const p of params) {
    const fam = PIDLOW_TO_FAMILY[p.pidLow] ?? BLOCK_TO_FAMILY[p.block];
    if (!fam) continue;
    const inner = counts.get(fam) ?? new Map<number, number>();
    inner.set(p.pidLow, (inner.get(p.pidLow) ?? 0) + 1);
    counts.set(fam, inner);
  }
  const result = new Map<string, number>();
  for (const [fam, inner] of counts) {
    let best: [number, number] = [-1, 0];
    for (const [pl, count] of inner) {
      if (count > best[1]) best = [pl, count];
    }
    if (best[0] >= 0) result.set(fam, best[0]);
  }
  return result;
}

function familyForEntry(p: ParamEntry): string | undefined {
  return PIDLOW_TO_FAMILY[p.pidLow] ?? BLOCK_TO_FAMILY[p.block];
}

// --- 5. Name normalization --------------------------------------------

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function namesMatch(paramName: string, xmlDisplay: string): boolean {
  return norm(paramName) === norm(xmlDisplay);
}
function symMatchesName(symbol: string, paramName: string): boolean {
  // Catalog symbol → snake-case-ish. Strip common prefixes that map to
  // block-name (DISTORT_, REVERB_, etc.) and any trailing _N digit.
  const stripped = symbol.replace(/^[A-Z]+_/, '').toLowerCase();
  return stripped === paramName || norm(stripped) === norm(paramName);
}

// --- 6. Main ----------------------------------------------------------

const xml = loadXmlControls();
const catalog = loadCatalog();
const params = loadParamsTs();
const pidlowMap = derivePidlowMap(params);

// Index params.ts by (pidLow, pidHigh) for fast lookup.
const paramsByAddr = new Map<string, ParamEntry>();
for (const p of params) paramsByAddr.set(`${p.pidLow}.${p.pidHigh}`, p);

type Status = 'WIRED-MATCHED' | 'WIRED-MISLABEL' | 'UI-MISSING' | 'UI-WIDGET' | 'GHOST' | 'PIDLOW-UNKNOWN';

/**
 * Heuristic: is this catalog entry a UI widget (button/menu/label/meter
 * chrome) rather than a writable preset parameter? Detected by either:
 *   - paramId >= 65000 — AM4-Edit's internal range for ZeroAll buttons,
 *     name fields, label slots, copy-menu triggers, ALIGN graph widgets,
 *     etc. Confirmed via the Session 96 b67e23f UI-MISSING closeout
 *     which explicitly skipped: CABINET_NAME{1,2}, CABINET_LABEL{1,2},
 *     CABINET_ALIGN_*, CABINET_COPY_MENU{1,2}, DISTORT_ZEROEQ.
 *   - empty XML display name — the XML control exists but carries no
 *     user-facing label (e.g. VOLUME_METER paramId 20, an output level
 *     meter widget shown as bars not numbers).
 *
 * These addresses back AM4-Edit chrome, not preset data. params.ts
 * intentionally doesn't wire them — they should be counted separately
 * from real UI-MISSING wiring gaps.
 */
function isUiWidget(paramId: number, xmlDisplay: string | undefined): boolean {
  if (paramId >= 65000) return true;
  if (xmlDisplay !== undefined && xmlDisplay.trim() === '') return true;
  return false;
}
interface Finding {
  family: string;
  paramId: number;
  symbol: string;
  status: Status;
  xmlDisplay?: string;
  xmlEffectName?: string;
  paramsTsKey?: string;
  paramsTsName?: string;
  notes?: string;
}
const findings: Finding[] = [];

for (const [family, entries] of catalog) {
  const pidLow = pidlowMap.get(family);
  for (const { paramId, symbol } of entries) {
    const xmlList = xml.get(symbol);
    const xmlDisplay = xmlList?.[0]?.displayName;
    const xmlEffectName = xmlList?.[0]?.effectName;

    if (pidLow === undefined) {
      findings.push({
        family,
        paramId,
        symbol,
        status: 'PIDLOW-UNKNOWN',
        xmlDisplay,
        xmlEffectName,
        notes: 'Family has no derivable pidLow from params.ts (likely not an AM4 block).',
      });
      continue;
    }

    const paramEntry = paramsByAddr.get(`${pidLow}.${paramId}`);
    if (paramEntry) {
      // Only flag mismatch when AM4-Edit ACTUALLY displays a label. The
      // catalog symbol is Fractal's internal name; the agent doesn't see
      // it. If there's no UI display, there's no user-facing label to
      // mismatch against, so treat as WIRED-MATCHED.
      //
      // GLOBAL family carve-out (Session 96): GLOBAL paramIds were wired
      // Session 96 (HW-112) by mechanical generation from the Ghidra
      // catalog's GLOBAL_* symbols (e.g. GLOBAL_TUNINGREF → name='tuningref').
      // The AM4-Edit XML carries a UI label for some of these (e.g.
      // "Calibration" for TUNINGREF), but GLOBAL controls live on the
      // device's Settings page rather than the per-block effect editor.
      // The user-facing label is surfaced through the displayLabel field
      // on each param entry; the name field is the stable wire symbol.
      // Comparing wire-name vs Settings-page UI label here would
      // misclassify ~70 entries as MISLABEL even though the wire name is
      // canonical (and the agent reads the UI label via displayLabel).
      // Treat GLOBAL like the no-XML case: WIRED-MATCHED whenever the
      // (pidLow, paramId) address is bound.
      const skipXmlNameMatch = family === 'GLOBAL';
      const matched = (xmlDisplay && !skipXmlNameMatch) ? namesMatch(paramEntry.name, xmlDisplay) : true;
      findings.push({
        family,
        paramId,
        symbol,
        status: matched ? 'WIRED-MATCHED' : 'WIRED-MISLABEL',
        xmlDisplay,
        xmlEffectName,
        paramsTsKey: paramEntry.key,
        paramsTsName: paramEntry.name,
      });
    } else if (xmlList) {
      // XML exposes a control but params.ts has nothing at this address.
      // If it's a UI widget (chrome — name/label/menu/button/meter
      // sentinels), classify separately so it doesn't count against
      // the real wiring-gap headline.
      const widget = isUiWidget(paramId, xmlDisplay);
      findings.push({
        family,
        paramId,
        symbol,
        status: widget ? 'UI-WIDGET' : 'UI-MISSING',
        xmlDisplay,
        xmlEffectName,
      });
    } else {
      findings.push({
        family,
        paramId,
        symbol,
        status: 'GHOST',
      });
    }
  }
}

// --- 7. Emit markdown report ------------------------------------------

const lines: string[] = [];
const w = (s = '') => lines.push(s);

w('# AM4 coverage cross-reference audit');
w('');
w('Three-way join over the Ghidra catalog, AM4-Edit UI XML, and');
w('`packages/am4/src/params.ts`. Generated by `scripts/_research/');
w('coverage-cross-ref-audit.ts` — re-run any time params.ts or the');
w('Ghidra catalog changes.');
w('');
w('## Classification key');
w('');
w('| Status | Meaning |');
w('|---|---|');
w('| **WIRED-MATCHED** | params.ts has the param at the catalog-derived (pidLow, paramId) and its `name` matches the AM4-Edit display label. Healthy. |');
w('| **WIRED-MISLABEL** | params.ts has the entry, but its `name` does NOT match the AM4-Edit display. Wired, but the LLM-facing key may not surface naturally from a "make Scene 1 Level louder" prompt. **Highest-priority class to inspect.** |');
w('| **UI-MISSING** | AM4-Edit exposes the control AS A REAL KNOB, params.ts has no entry at the matching address. Real wiring gap. |');
w('| **UI-WIDGET** | AM4-Edit exposes the control as UI chrome — paramId ≥ 65000 (NAME/LABEL/MENU/BUTTON/GRAPH/COPY widgets) or empty XML display name (METER sentinels). Not preset data; params.ts intentionally skips. |');
w('| **GHOST** | catalog symbol with no AM4-Edit UI. Firmware-internal; don\'t count against UI coverage. |');
w('| **PIDLOW-UNKNOWN** | family has no derivable pidLow (not placeable on AM4 or never captured). |');
w('');

// Family → pidLow table
w('## Inferred family → pidLow (from params.ts entries)');
w('');
w('| Family | pidLow | Notes |');
w('|---|---|---|');
const fams = Array.from(pidlowMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
for (const [fam, pl] of fams) {
  w(`| ${fam} | \`0x${pl.toString(16).padStart(4, '0')}\` | derived from majority pidLow of params.ts entries whose pidHigh appears in catalog |`);
}
const unbound = Array.from(catalog.keys()).filter((f) => !pidlowMap.has(f)).sort();
if (unbound.length) {
  w('');
  w(`Families with no derivable pidLow (${unbound.length}): ${unbound.join(', ')}`);
}
w('');

// Summary counts per family
w('## Summary per family');
w('');
w('| Family | WIRED-MATCHED | WIRED-MISLABEL | UI-MISSING | UI-WIDGET | GHOST | PIDLOW-UNKNOWN |');
w('|---|---|---|---|---|---|---|');
const counts: Record<string, Record<Status, number>> = {};
for (const f of findings) {
  counts[f.family] ??= { 'WIRED-MATCHED': 0, 'WIRED-MISLABEL': 0, 'UI-MISSING': 0, 'UI-WIDGET': 0, 'GHOST': 0, 'PIDLOW-UNKNOWN': 0 };
  counts[f.family][f.status] += 1;
}
const famsSorted = Object.keys(counts).sort((a, b) => {
  const ax = counts[a], bx = counts[b];
  // Sort by WIRED-MISLABEL desc, then UI-MISSING desc — the actionable rows first.
  if (bx['WIRED-MISLABEL'] !== ax['WIRED-MISLABEL']) return bx['WIRED-MISLABEL'] - ax['WIRED-MISLABEL'];
  return bx['UI-MISSING'] - ax['UI-MISSING'];
});
for (const f of famsSorted) {
  const c = counts[f];
  w(`| ${f} | ${c['WIRED-MATCHED'] || '—'} | ${c['WIRED-MISLABEL'] || '—'} | ${c['UI-MISSING'] || '—'} | ${c['UI-WIDGET'] || '—'} | ${c['GHOST'] || '—'} | ${c['PIDLOW-UNKNOWN'] || '—'} |`);
}
w('');

// WIRED-MISLABEL section — most actionable
w('## WIRED-MISLABEL findings (rename candidates)');
w('');
w('These are wired and write fine over the wire. The risk is that the');
w('LLM-facing key (`block.name`) doesn\'t match the AM4-Edit display, so');
w('the agent may fail to find it when the user describes the knob by its');
w('on-screen label. Review each: rename the `name` field to match the');
w('display, or document why the divergence is intentional.');
w('');
const ml = findings.filter((f) => f.status === 'WIRED-MISLABEL');
if (ml.length === 0) {
  w('_None found._');
} else {
  w('| Family | paramId | Catalog symbol | XML display | params.ts key | params.ts name |');
  w('|---|---|---|---|---|---|');
  for (const f of ml.sort((a, b) => a.family.localeCompare(b.family) || a.paramId - b.paramId)) {
    w(`| ${f.family} | ${f.paramId} | \`${f.symbol}\` | ${f.xmlDisplay ? `"${f.xmlDisplay}"` : '—'} | \`${f.paramsTsKey}\` | \`${f.paramsTsName}\` |`);
  }
}
w('');

// UI-MISSING section
w('## UI-MISSING findings (real wiring gaps)');
w('');
w('AM4-Edit exposes these controls but params.ts has nothing at the');
w('catalog-derived address. Each row is one knob the agent currently');
w('cannot read or write.');
w('');
const um = findings.filter((f) => f.status === 'UI-MISSING');
if (um.length === 0) {
  w('_None found._');
} else {
  w(`Total: ${um.length} controls. Top 50 by family / paramId:`);
  w('');
  w('| Family | paramId | Catalog symbol | XML display |');
  w('|---|---|---|---|');
  const top = um.sort((a, b) => a.family.localeCompare(b.family) || a.paramId - b.paramId).slice(0, 50);
  for (const f of top) {
    w(`| ${f.family} | ${f.paramId} | \`${f.symbol}\` | ${f.xmlDisplay ? `"${f.xmlDisplay}"` : '—'} |`);
  }
}
w('');

// UI-WIDGET section — intentional skips, short summary
w('## UI-WIDGET findings (chrome, not preset data — intentional skips)');
w('');
w('AM4-Edit exposes these as UI elements (button labels, name fields,');
w('menu triggers, ALIGN graphs, copy-menus, METER readouts) but they\'re');
w('not user-writable preset parameters. params.ts intentionally omits.');
w('Detected by paramId ≥ 65000 OR empty XML display name.');
w('');
const uw = findings.filter((f) => f.status === 'UI-WIDGET');
w(`${uw.length} widgets. Examples by family:`);
w('');
w('| Family | paramId | Catalog symbol | XML display |');
w('|---|---|---|---|');
for (const f of uw.sort((a, b) => a.family.localeCompare(b.family) || a.paramId - b.paramId)) {
  w(`| ${f.family} | ${f.paramId} | \`${f.symbol}\` | ${f.xmlDisplay ? `"${f.xmlDisplay}"` : '_(empty)_'} |`);
}
w('');

// GHOST section — short summary only
w('## GHOST findings (catalog only, no AM4-Edit UI)');
w('');
const gh = findings.filter((f) => f.status === 'GHOST');
w(`${gh.length} catalog symbols with no UI exposure. These are firmware-`);
w('internal (modifier slots, scene-only state, internal calc state).');
w('Examples: `' + gh.slice(0, 15).map((f) => f.symbol).join('`, `') + '`...');
w('');
w('PATCH_4CM specifically: catalog has it, XML lacks it → confirmed ghost.');
w('Do not count against UI coverage; firmware-only flag with no AM4-Edit');
w('control.');
w('');

writeFileSync(OUTPUT, lines.join('\n'));

// Console summary
console.log(`Wrote ${lines.length} lines to ${OUTPUT}`);
console.log('');
console.log('Headline counts:');
const totals = { 'WIRED-MATCHED': 0, 'WIRED-MISLABEL': 0, 'UI-MISSING': 0, 'UI-WIDGET': 0, 'GHOST': 0, 'PIDLOW-UNKNOWN': 0 };
for (const f of findings) totals[f.status]++;
for (const [k, v] of Object.entries(totals)) console.log(`  ${k.padEnd(18)} ${v}`);
console.log('');
console.log(`Total catalog entries audited: ${findings.length}`);
console.log(`Inferred pidLow for ${pidlowMap.size} families.`);

// --- 8. Drift guard for preflight -------------------------------------
//
// Ceiling for WIRED-MISLABEL. Set to the count at the time this guard
// was wired in. Should monotonically decrease as renames land. If a
// params.ts edit increases the count, the audit fails preflight so the
// drift can't ship silently.
//
// To lower: confirm the new count is intentional (renamed param matches
// XML display), then update this constant.

// Session 89 (2026-05-16): bumped 135 → 143 for the DISTORT UI-MISSING
// closeout (16 new amp params under pidLow=0x003a). 8 of the 16 have
// `name` divergent from the AM4-Edit XML display label by design:
//   - amp.spkr_drive ≠ "Drive"            — disambiguates vs drive.drive
//   - amp.input_eq_frequency ≠ "Frequency"  — mirrors input_eq_q / _gain family
//   - amp.overdrive ≠ "Normal Gain"       — resolver name (variant-stable);
//                                            "Normal Gain" is variant-specific
//   - amp.b_plus_monitor ≠ "B+"           — _monitor suffix marks read-only
//   - amp.gain_monitor ≠ "Gain"           — disambiguates vs amp.gain (id=11)
//   - amp.headroom_monitor ≠ "HEADROOM"   — _monitor suffix marks read-only
//   - amp.presence_prepresence ≠ "Treble" — XML label misleading; resolver
//                                            keeps the dedupe suffix
//   - amp.pa_high_cut ≠ "Tone"            — pa_ prefix mirrors power-amp family
// Session 90 (2026-05-16): tightened 143 → 112 after Session A's
// WIRED-MISLABEL review pass (renames moved 23 entries from MISLABEL
// to MATCHED). Drift guard remains tight against future regressions.
// Session 90 cont (2026-05-17): bumped 112 → 137 for the REVERB+DELAY
// UI-MISSING closeout (63 mirror entries + 22 hand-authored enums took
// AM4 TOTAL 57% → 75%+). Most new mismatches are intentional
// disambiguation where multiple distinct registers share an AM4-Edit
// display label (e.g. four `delay.lfo_{1,2,3,4}_type` entries all
// display as "LFO Type"; four `delay.lfo_{1,2,3,4}_tempo` all display
// as "Tempo"). Cannot collapse to a single key without losing
// addressability. Pure mismatches were renamed inline (delay.mode →
// delay.trigger_restart; delay.max_depth → delay.depth_range;
// delay.svf_type → delay.sweep_filter).
// Session 90 cont (2026-05-17): bumped 137 → 140 for the CHORUS /
// FLANGER / PHASER / FILTER / TREMOLO / ENHANCER / COMPRESSOR mirror
// batch (53 new entries). Same disambiguation pattern — names
// generated by gen-params-from-cache.ts from paramNamesGenerated.ts
// already absorbed the XML-label dedup suffixes (e.g. `shape_vcrk`,
// `high_cut_lpf`, `ratio_compansion`, `threshold_thresh2`) — these
// don't match the AM4-Edit display verbatim, but they preserve
// addressability where two registers share the same UI label.
// Session 91 (2026-05-17): bumped 140 → 144 for the FLANGER / PHASER /
// FILTER UI-MISSING closeout (28 hand-authored entries). Four are
// intentional disambiguations of AM4-Edit labels that collide with
// existing keys:
//   • phaser.lfo_type    (XML "Type"  vs existing phaser.type at 0x0a)
//   • phaser.vcr_curve   (XML "Type"  — alpha-curve "Type" on Config page)
//   • phaser.lfo_mode    (XML "Mode"  vs phaser.mode at 0x15 unlabeled)
//   • filter.order_2     (XML "Order" vs cache-pipeline filter.order at 0x1c)
// Session 92 (2026-05-17): bumped 144 → 158 for the CABINET UI-MISSING
// closeout (24 hand-authored entries at pidLow=0x003e; AM4 TOTAL 81%
// → 84%). All 14 new MISLABELs are intentional `_1`/`_2` disambig
// suffixes — each second-cab entry shares an AM4-Edit display label
// with the existing first-cab entry, so collapsing to a single key
// would lose addressability for the stereo cab. Per-cab `_1`/`_2`
// affixes follow the established `cab_1_blend`/`cab_2_blend` and
// `low_slope`/`high_slope` patterns. Concretely:
//   • amp.bank_2          (XML "Bank"        vs amp.bank at 0x000a)
//   • amp.cab_2           (XML "Cab #"       vs amp.cab at 0x000c)
//   • amp.pan_2           (XML "Pan"         vs amp.pan at 0x0010)
//   • amp.low_slope_2     (XML "Low Slope"   vs amp.low_slope at 0x003b)
//   • amp.high_slope_2    (XML "High Slope"  vs amp.high_slope at 0x003d)
//   • amp.dynacab_2       (XML "DynaCab"     vs amp.dynacab at 0x0045)
//   • amp.proximity_1     (XML "Proximity"   vs cacheParams amp.proximity
//                          which covers PROXIMITY2 via cross-block resolver)
//   • amp.cab_mute_1      (XML "M"           vs amp.cab_mute_2 — both share
//                          the cryptic single-letter editor label)
//   • amp.cab_mute_2      (XML "M")
//   • amp.master_low_cut  (XML "Low Cut" / "Master Low Cut" — first XML hit
//                          is regular layout "Low Cut")
//   • amp.cab_1_low_cut   (XML "Low Cut"     vs amp.master_low_cut above)
//   • amp.cab_pretype     (XML "Type"        — disambig from amp.type at
//                          pidLow=0x003a / pidHigh=0x000a)
//   • amp.cab_bass        (XML "Bass"        vs amp.bass at 0x000c on the
//                          DISTORT register — separate tone stack)
//   • amp.cab_mid         (XML "Mid"         vs amp.mid at 0x000d ditto)
// Session 95 (2026-05-17): tightened 158 → 154 after a focused review pass
// over the WIRED-MISLABEL findings. Four REVERB entries were renamed to
// match the AM4-Edit XML display exactly:
//   • reverb.low_slope  → reverb.low_cut_slope  (XML "Low Cut Slope")
//   • reverb.high_slope → reverb.high_cut_slope (XML "High Cut Slope")
//   • reverb.pitch_dir  → reverb.pitch_direction (XML "Pitch Direction")
//   • reverb.pitch_pos  → reverb.pitch_position  (XML "Pitch Position")
// All four were hand-authored in params.ts (Session 90 cont) and had no
// downstream consumers outside params.ts + the two AM4/III catalog
// generator NAMING_ALIAS tables (updated in the same commit). The
// remaining 154 are documented intentional disambiguations (cabinet
// _1/_2 pairs, LFO N target/tempo pairs, GEQ/WAH numeric bands, etc.) —
// see the earlier per-session notes for the specific shapes.
// Session 96 (2026-05-17): bumped 154 → 161 for the PATCH/CABINET/
// DISTORT UI-MISSING closeout (50 hand-authored entries; AM4 TOTAL
// 84% → 91%). All 7 new MISLABELs are intentional context-disambig
// names where the AM4-Edit XML label alone would be too generic for
// LLM key lookup ("Type", "Location", "Distance", "Off / On", "Breakup",
// "Proximity"). Concretely:
//   • amp.cab_proximity_2  (XML "Proximity"  — sibling of amp.proximity_1)
//   • amp.cab_dynacab_z_1  (XML "Distance"   — DynaCab Z = mic distance,
//                            sibling of existing amp.cab_dynacab_z patterns)
//   • amp.cab_dynacab_z_2  (XML "Distance")
//   • amp.in_eq_type       (XML "Type"       — disambig from amp.type at
//                            pidLow=0x003a / pidHigh=0x000a)
//   • amp.eq_location      (XML "Location"   — input-EQ position selector)
//   • amp.eq_onoff         (XML "Off / On"   — input-EQ enable toggle,
//                            name explains WHAT toggle vs the generic XML)
//   • amp.spkr_breakup     (XML "Breakup"    — speaker breakup knob on
//                            the Speaker page, spkr_ prefix mirrors
//                            sibling amp.spkr_imp_curve)
// LLM still surfaces the friendly XML label via param.displayLabel — the
// rename is purely about the lookup key being discoverable from the
// natural-language prompt ("turn on the input EQ" → amp.eq_onoff is more
// findable than amp.off_on which is what XML-direct would produce).
// Session 97 (2026-05-18): bumped 161 → 167 for the PEQ/COMP/GATE/INPUT/
// CHORUS/TREMOLO/ENHANCER UI-MISSING residual closeout (15 hand-authored
// entries; AM4 TOTAL 91% → 93%). All 6 new MISLABELs are intentional
// context-disambig names where the AM4-Edit XML label alone would be too
// generic for LLM key lookup (three "Gain" meters that collide with the
// block's main gain knob, "Auto Att/Rel" → readable auto_attack_release,
// two "Slope N" entries that follow the existing channel_N_* pattern):
//   • compressor.gain_monitor      (XML "Gain" — _monitor suffix mirrors
//                                    amp.gain_monitor / b_plus_monitor
//                                    convention from Session 89)
//   • gate.gain_monitor            (XML "Gain")
//   • ingate.gain_monitor          (XML "Gain")
//   • compressor.auto_attack_release (XML "Auto Att/Rel" — readable form)
//   • peq.channel_1_slope          (XML "Slope 1" — slots into the existing
//                                    channel_N_{frequency,q,gain,type,solo}
//                                    family-prefix pattern)
//   • peq.channel_5_slope          (XML "Slope 5")
const WIRED_MISLABEL_CEILING = 167;
if (totals['WIRED-MISLABEL'] > WIRED_MISLABEL_CEILING) {
  console.error('');
  console.error(`FAIL: WIRED-MISLABEL count is ${totals['WIRED-MISLABEL']}, ceiling is ${WIRED_MISLABEL_CEILING}.`);
  console.error(`A recent params.ts change introduced ${totals['WIRED-MISLABEL'] - WIRED_MISLABEL_CEILING} new mismatch(es)`);
  console.error(`between the entry \`name\` field and the AM4-Edit display label. See`);
  console.error(`${OUTPUT} "WIRED-MISLABEL findings" section to identify them.`);
  console.error(`Either rename the params.ts \`name\` to match the display, or raise`);
  console.error(`the ceiling in this script if the divergence is intentional.`);
  process.exit(1);
}
console.log('');
console.log(`Drift guard: WIRED-MISLABEL=${totals['WIRED-MISLABEL']} ≤ ceiling=${WIRED_MISLABEL_CEILING} ✓`);
