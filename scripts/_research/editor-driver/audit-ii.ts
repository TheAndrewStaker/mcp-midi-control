/**
 * Axe-Edit (Axe-Fx II) read-back audit, focus-free.
 *
 *   npx tsx scripts/_research/editor-driver/audit-ii.ts dump [--blocks Amp,Cab]
 *     Walks every block (or the named ones) and every page of the loaded
 *     preset: selects the block through UI Automation, switches pages with a
 *     posted click (postclick.py, no focus or cursor change), and records each
 *     slider's editor text. Writes editor-ii.json and prints get_params query
 *     batches (<= 100 each) for the mapped params.
 *
 *   npx tsx scripts/_research/editor-driver/audit-ii.ts compare <reads.json>...
 *     Compares the editor text with get_params results saved as JSON (the
 *     `reads` arrays of one or more get_params responses).
 *
 * Axe-Edit sliders expose no position, only "Label: value", so the check is
 * "our decode of the device register" vs "the editor's text", via get_params.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_PARAMS, type AxeFxIIParam } from 'fractal-midi/gen2/axe-fx-ii';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.EDITOR_II_OUT ?? join(process.env.TEMP ?? HERE, 'editor-ii.json');

interface Node { type: string; name: string; x: number; y: number; w: number; h: number }
interface Row { block: string; editorBlock: string; page: string; label: string; display: string; modifier: boolean; candidates: string[] }

function tree(prefix = ''): Node[] {
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'uia.ps1'), '-Title', 'Axe-Edit', `${prefix}tree`], { encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean).map((ln) => {
    const parts = ln.split(' | ');
    const [x, y, w, h] = (parts[parts.length - 1] ?? '').split(',').map(Number);
    return { type: parts[0], name: parts[1] ?? '', x, y, w, h };
  });
}

function click(x: number, y: number): void {
  execFileSync(process.env.PYTHON ?? 'python', ['-I', join(HERE, 'postclick.py'), 'Axe-Edit', String(Math.round(x)), String(Math.round(y))], { shell: true });
}
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const BLOCK_SLUGS: Record<string, string> = {
  'Amp': 'amp', 'Cab': 'cab', 'Compressor': 'compressor', 'Wahwah': 'wah', 'Drive': 'drive', 'Chorus': 'chorus',
  'Flanger': 'flanger', 'Delay': 'delay', 'Rotary': 'rotary', 'Reverb': 'reverb', 'Phaser': 'phaser',
  'Pitch': 'pitch', 'Filter': 'filter', 'Graphic EQ': 'graphiceq', 'Parametric EQ': 'parametriceq',
  'Multi Delay': 'multidelay', 'Multitap Delay': 'megatap', 'Megatap Delay': 'megatap', 'Gate/Expander': 'gateexpander',
  'Pan/Trem': 'pantrem', 'Tremolo/Panner': 'pantrem', 'Vol/Pan': 'volpan', 'Volume/Pan': 'volpan', 'Enhancer': 'enhancer',
  'Formant': 'formant', 'Ring Mod': 'ringmod', 'Ring Modulator': 'ringmod', 'Resonator': 'resonator', 'Synth': 'synth',
  'Vocoder': 'vocoder', 'Looper': 'looper', 'Crossover': 'crossover', 'Mixer': 'mixer', 'Effects Loop': 'effectsloop',
  'Multiband Comp': 'multibandcomp', 'Feedback Send': 'feedbacksend', 'Feedback Return': 'feedbackreturn',
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+]/g, '');
const PARAMS = Object.entries(KNOWN_PARAMS as Record<string, AxeFxIIParam>);
function candidates(block: string, label: string): string[] {
  const want = norm(label);
  return PARAMS.filter(([, p]) => p.block === block && p.xmlLabel !== undefined && norm(p.xmlLabel) === want).map(([, p]) => p.name);
}

function readPage(nodes: Node[]) {
  const sliders = nodes.filter((n) => n.type === 'Slider' && n.name.includes(':'))
    .map((n) => {
      const m = n.name.match(/^(.*?): (.*?)(, Modifier .*)?$/);
      return m ? { label: m[1], display: m[2], modifier: m[3] !== undefined && !/Disabled/.test(m[3]) } : undefined;
    }).filter((s): s is { label: string; display: string; modifier: boolean } => s !== undefined);
  return sliders;
}

function dump(blockFilter?: string[]): void {
  const grid = tree().filter((n) => n.type === 'RadioButton' && /^Grid row \d+ column \d+: (?!Empty|Shunt)/.test(n.name));
  const blocks = grid.map((n) => n.name.replace(/^Grid row \d+ column \d+: /, '').replace(/ \d+[A-Z]?, .*$/, ''))
    .filter((b) => !blockFilter || blockFilter.includes(b));
  const rows: Row[] = [];
  const unmapped: string[] = [];
  for (const b of blocks) {
    const slug = BLOCK_SLUGS[b];
    if (!slug) { unmapped.push(`block ${b}: no slug`); continue; }
    let nodes = tree(`block ${b}; wait 900; `);
    const tabs = nodes.filter((n) => n.type === 'Custom' && n.name && n.w >= 95 && n.w <= 130 && n.h >= 28 && n.h <= 44 && n.x < 760);
    const pages = tabs.length ? tabs : [{ name: '(single)', x: 0, y: 0, w: 0, h: 0, type: '' }];
    for (const t of pages) {
      if (t.w) { click(t.x + t.w / 2, t.y + t.h / 2); sleep(700); nodes = tree(); }
      for (const s of readPage(nodes)) {
        const cands = candidates(slug, s.label);
        rows.push({ block: slug, editorBlock: b, page: t.name, ...s, candidates: cands });
        if (!cands.length) unmapped.push(`${b} / ${t.name}: "${s.label}" = "${s.display}"`);
      }
    }
  }
  writeFileSync(OUT, JSON.stringify(rows, null, 1));
  const queries = [...new Set(rows.flatMap((r) => r.candidates.map((c) => `${r.block}.${c}`)))]
    .map((k) => ({ block: k.split('.')[0], name: k.split('.').slice(1).join('.') }));
  console.log(`${rows.length} controls on ${new Set(rows.map((r) => r.editorBlock + r.page)).size} pages -> ${OUT}`);
  for (const u of unmapped) console.log(`UNMAPPED ${u}`);
  for (let i = 0; i < queries.length; i += 100) console.log(`QUERIES ${JSON.stringify(queries.slice(i, i + 100))}`);
}

/** Editor text -> number in the same unit our read reports. */
function parseShown(text: string): { num?: number; text: string } {
  const m = text.trim().match(/^([-+]?\d+(?:\.\d+)?)\s*(.*)$/);
  if (!m) return { text: text.trim() };
  let v = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'khz') v *= 1000;
  return { num: v, text: text.trim() };
}

function compare(files: string[]): void {
  const rows: Row[] = JSON.parse(readFileSync(OUT, 'utf8'));
  const reads = new Map<string, unknown>();
  for (const f of files) {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    for (const r of (j.reads ?? j) as Array<{ block: string; name: string; display_value: unknown }>) reads.set(`${r.block}.${r.name}`, r.display_value);
  }
  let ok = 0; const bad: string[] = [];
  for (const r of rows) {
    if (!r.candidates.length) continue;
    const shown = parseShown(r.display);
    const dec = (r.display.match(/\.(\d+)/)?.[1].length ?? 0);
    const step = Math.pow(10, -dec) * (/khz/i.test(r.display) ? 1000 : 1);
    const verdicts = r.candidates.map((c) => {
      const ours = reads.get(`${r.block}.${c}`);
      if (ours === undefined) return [c, 'not read'] as const;
      if (typeof ours === 'number' && shown.num !== undefined) return [c, Math.abs(ours - shown.num) <= step * 0.51 + 1e-9 ? 'ok' : `ours ${ours}`] as const;
      return [c, norm(String(ours)) === norm(shown.text) ? 'ok' : `ours "${ours}"`] as const;
    });
    if (verdicts.some(([, v]) => v === 'ok')) { ok++; continue; }
    bad.push(`MISMATCH ${r.editorBlock} / ${r.page}: "${r.label}" editor "${r.display}" | ` + verdicts.map(([c, v]) => `${c}: ${v}`).join(' | '));
  }
  for (const b of bad) console.log(b);
  console.log(`${ok} match, ${bad.length} mismatch.`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'dump') dump(rest.includes('--blocks') ? rest[rest.indexOf('--blocks') + 1].split(',') : undefined);
else if (cmd === 'compare') compare(rest);
else console.log('usage: audit-ii.ts dump [--blocks A,B] | compare <reads.json>...');
