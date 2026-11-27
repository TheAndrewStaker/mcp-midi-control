/**
 * Decode audit against AM4-Edit, no MIDI traffic.
 *
 * Every AM4-Edit slider reports (via UI Automation) the text it shows and its
 * position 0..10, which is exactly 10 x the normalized register `get_param`
 * returns (amp Low Reso: pos 5.291604, register 0.5291604). So decoding pos/10
 * through our catalog must reproduce the editor's text, for every control on
 * every page, with the device untouched. Dropdown text is checked against the
 * param's enum roster.
 *
 * Usage (AM4-Edit open, may be minimized):
 *   npx tsx scripts/_research/editor-driver/audit-am4.ts            # current page
 *   npx tsx scripts/_research/editor-driver/audit-am4.ts --all-tabs # every tab
 *   npx tsx scripts/_research/editor-driver/audit-am4.ts --blocks Amp,Reverb --all-tabs
 * Prints only problems: MISMATCH (decode differs), UNMAPPED (no catalog param
 * with that label in the block), ROSTER (dropdown text not in our enum names).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { KNOWN_PARAMS, decode, preferredDisplayLabel, type Param } from 'fractal-midi/am4';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UIA = path.join(HERE, 'uia.ps1');

interface Control { label: string; kind: 'slider' | 'dropdown'; display: string; pos?: number; enabled?: boolean }
interface Page { block: string; tab?: string; tabs: string[]; channel?: string; controls: Control[] }

function uia(script: string): string {
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', UIA, script], { encoding: 'utf8' });
}
function readPage(prefix = ''): Page {
  const out = uia(`${prefix}read`).trim().split(/\r?\n/).pop()!;
  const page = JSON.parse(out) as Page;
  page.tabs = page.tabs ?? []; page.controls = page.controls ?? [];
  return page;
}

// Editor block titles ("FX2: Amp") -> catalog block keys.
const BLOCK_KEYS: Record<string, string> = {
  'Amp': 'amp', 'Reverb': 'reverb', 'Delay': 'delay', 'Chorus': 'chorus', 'Flanger': 'flanger',
  'Phaser': 'phaser', 'Wahwah': 'wah', 'Wah': 'wah', 'Compressor': 'compressor', 'Graphic EQ': 'geq',
  'Filter': 'filter', 'Tremolo/Panner': 'tremolo', 'Enhancer': 'enhancer', 'Gate/Expander': 'gate',
  'Volume/Pan': 'volpan', 'Parametric EQ': 'peq', 'Rotary': 'rotary', 'Drive': 'drive',
};
function blockKey(title: string): string | undefined {
  const name = title.replace(/^FX\d+:\s*/, '').replace(/\s+\d+$/, '').trim();
  return BLOCK_KEYS[name];
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9+]/g, '');

function candidates(block: string, label: string): Array<[string, Param]> {
  const want = norm(label);
  return Object.entries(KNOWN_PARAMS as Record<string, Param>).filter(([, p]) => {
    if (p.block !== block) return false;
    const labels = [p.displayLabel, preferredDisplayLabel(p.block, p.name)].filter(Boolean) as string[];
    return labels.some((l) => norm(l) === want);
  });
}

/** Number + unit suffix from the editor text, scaled into the catalog unit. */
function parseShown(text: string, p: Param): number | undefined {
  const m = text.trim().match(/^([-+]?\d+(?:\.\d+)?)\s*(.*)$/);
  if (!m) return undefined;
  let v = Number(m[1]);
  const suffix = m[2].trim().toLowerCase();
  if (suffix === 'sec' || suffix === 's') { if (p.unit === 'ms') v *= 1000; }
  if (suffix === 'khz' && p.unit === 'hz') v *= 1000;
  return v;
}
const decimalsOf = (text: string): number => (text.match(/\.(\d+)/)?.[1].length ?? 0);

function checkSlider(c: Control, p: Param): string | undefined {
  const shown = parseShown(c.display, p);
  if (shown === undefined || c.pos === undefined) return `unparsed "${c.display}"`;
  const ours = decode(p, c.pos / 10) as number;
  let shownScaled = shown;
  const suffix = c.display.trim().toLowerCase();
  const dec = decimalsOf(c.display) + (/\bsec$/.test(suffix) && p.unit === 'ms' ? 3 : 0);
  const step = Math.pow(10, -dec);
  // Accept within one display step (the editor rounds, we compare unrounded).
  if (Math.abs(ours - shownScaled) <= step * 0.51 + 1e-9) return undefined;
  return `editor "${c.display}" vs ours ${Number(ours.toPrecision(6))} ${p.unit} (pos ${c.pos})`;
}

function checkDropdown(c: Control, p: Param): string | undefined {
  if (p.unit !== 'enum') {
    // Stepped numbers (reverb Density) show as a dropdown of numbers: fine.
    return /^[-+]?\d+(\.\d+)?\b/.test(c.display.trim()) ? undefined : `editor dropdown "${c.display}" but catalog unit ${p.unit}`;
  }
  const names = Object.values((p.enumValues ?? {}) as Record<number, string>);
  const want = norm(c.display.replace(/^\d+:\s*/, ''));
  return names.some((n) => norm(n) === want) ? undefined : `"${c.display}" not in roster (${names.length} names)`;
}

/** Triage aid: other params of the block whose decode of this slider position matches the editor. */
function hint(block: string, c: Control): string {
  if (c.kind !== 'slider' || c.pos === undefined) return '';
  const hits = Object.entries(KNOWN_PARAMS as Record<string, Param>)
    .filter(([, p]) => p.block === block && p.unit !== 'enum' && checkSlider(c, p) === undefined)
    .map(([k]) => k);
  return hits.length ? `  [decodes OK as: ${hits.slice(0, 6).join(', ')}${hits.length > 6 ? ', ...' : ''}]` : '  [no param decodes to this]';
}

function auditPage(page: Page): string[] {
  const block = blockKey(page.block ?? '');
  const where = `${page.block}${page.tab ? ' / ' + page.tab : ''}`;
  if (!block) return [`SKIP ${where}: unknown block title`];
  const problems: string[] = [];
  for (const c of page.controls) {
    if (c.label === 'Level' && c.kind === 'slider') { /* block level: checked like any other */ }
    const cands = candidates(block, c.label);
    if (cands.length === 0) { problems.push(`UNMAPPED ${where}: ${c.kind} "${c.label}" = "${c.display}"${hint(block, c)}`); continue; }
    const results = cands.map(([k, p]) => [k, c.kind === 'slider' ? (p.unit === 'enum' ? checkDropdown(c, p) : checkSlider(c, p)) : checkDropdown(c, p)] as const);
    if (results.some(([, r]) => r === undefined)) continue;
    const tag = c.kind === 'dropdown' ? 'ROSTER' : 'MISMATCH';
    problems.push(`${tag} ${where}: "${c.label}"${c.enabled === false ? ' (greyed)' : ''} ` + results.map(([k, r]) => `${k}: ${r}`).join(' | ') + hint(block, c));
  }
  return problems;
}

const args = process.argv.slice(2);
const allTabs = args.includes('--all-tabs');
const blocksArg = args.includes('--blocks') ? args[args.indexOf('--blocks') + 1].split(',') : [undefined];

let pages = 0, controls = 0;
const problems: string[] = [];
for (const b of blocksArg) {
  const first = readPage(b ? `block ${b}; ` : '');
  const tabs = allTabs && first.tabs.length > 0 ? first.tabs : [undefined];
  for (const t of tabs) {
    const page = t === undefined || t === first.tab ? (t === undefined ? first : readPage()) : readPage(`press ${t}; `);
    pages++; controls += page.controls.length;
    problems.push(...auditPage(page));
  }
}
for (const p of problems) console.log(p);
console.log(`${pages} page(s), ${controls} control(s), ${problems.length} problem(s).`);
