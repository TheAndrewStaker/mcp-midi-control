/**
 * rig-console.ts — generate the Rig Console: one self-contained HTML page
 * showing the rig, the set, and where every song lives on the sequencer.
 *
 * WHY A GENERATED FILE AND NOT A SERVER. Everything the console shows is
 * static: the rig is a manifest, the card map is a snapshot of a backup, the
 * setlist is a file. Nothing is read from a device. A local HTTP host would add
 * a listener, a per-launch token, a CSP, a Windows Firewall prompt, a
 * single-instance lock and a port that the vendor editors fight over, and would
 * buy exactly nothing for read-only data that does not change while you look at
 * it. `docs/design/RIG-CONSOLE-DESIGN.md` specifies that host for the EDITING
 * phases; this is the read-only half, and it ships first because it can.
 *
 * The page opens from `file://` with the MCP server stopped and Claude Desktop
 * closed. Double-clickable, no install, no network.
 *
 * USAGE
 *   npm run rig-console                 # generate and open
 *   npm run rig-console -- --no-open    # generate only
 *   npx tsx scripts/rig-console.ts --out <path> --rig <rig.json>
 *     --capture <dir> --setlist <file> --text    # print the text rendering too
 *
 * TOUCHES NO HARDWARE. Reads three files and writes one.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { buildRigView, renderRigText, type Rig, type RigView } from 'openrig';

import { renderConsole, type SourceStatus } from '@mcp-midi-control/rig-console-render';

import {
  attachVoices, joinSongs, latestCapture, latestSetlist, loadCard, loadSetlist, loadVoices,
} from './_lib/console-sources.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const has = (n: string): boolean => argv.includes(n);

const OUT = flag('--out') ?? 'docs/_private/rig/rig-console.html';
const RIG = flag('--rig') ?? process.env.MCP_RIG_MANIFEST ?? 'docs/_private/rig/rig.json';
const CAPTURE = flag('--capture') ?? latestCapture();
const SETLIST = flag('--setlist') ?? latestSetlist();
const OPEN = !has('--no-open');
const SHOW_TEXT = has('--text');

/**
 * Load the rig manifest. Status-shaped, never throwing: `absent` (nothing
 * there) is a different state from `error` (there and unreadable), and
 * collapsing them is what makes a first run look broken rather than empty.
 */
function loadRig(path: string): { view?: RigView; status: SourceStatus } {
  const base = { id: 'rig' as const, label: 'Rig manifest', path };
  if (!existsSync(path)) {
    return { status: { ...base, state: 'absent', detail: 'No file at this path. Pass --rig, or set MCP_RIG_MANIFEST.' } };
  }
  try {
    const rig = JSON.parse(readFileSync(path, 'utf8')) as Rig;
    const view = buildRigView(rig);
    const errors = view.findings.filter((f) => f.severity === 'error').length;
    return {
      view,
      status: {
        ...base, state: 'loaded',
        detail: `${view.counts.devices} devices, ${view.counts.links} cables, ${view.counts.bindings} bindings` +
          (errors > 0 ? `, ${errors} validation error${errors === 1 ? '' : 's'}` : ''),
      },
    };
  } catch (e) {
    return { status: { ...base, state: 'error', detail: e instanceof Error ? e.message : String(e) } };
  }
}

function openInBrowser(file: string): void {
  const abs = resolve(file);
  // `start` is a cmd builtin, so it needs a shell; the empty "" is the window
  // title argument `start` consumes when its first argument is quoted.
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', abs]]
    : process.platform === 'darwin' ? ['open', [abs]] : ['xdg-open', [abs]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

function main(): void {
  const rig = loadRig(RIG);
  const card = loadCard(CAPTURE);
  const setlist = loadSetlist(SETLIST);
  const join = joinSongs(setlist.entries, card.card);
  const voices = loadVoices();
  if (voices.note !== undefined) console.log(`!   ${voices.note}`);
  attachVoices(join, voices.mappings);

  const html = renderConsole({
    view: rig.view,
    card: card.card,
    join,
    sources: [rig.status, card.status, setlist.status],
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
    command: 'npm run rig-console',
  });

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, html, 'utf8');

  for (const s of [rig.status, card.status, setlist.status]) {
    const mark = s.state === 'loaded' ? 'ok  ' : s.state === 'absent' ? '--  ' : 'ERR ';
    console.log(`${mark}${s.label}: ${s.detail}`);
  }

  // Anything the join could not reconcile is reported, never dropped. A join
  // that quietly loses a row reads as "your set is fine" when it is not.
  if (join.unplaced.length > 0) {
    console.log(`\n!   ${join.unplaced.length} setlist song(s) with nothing on the card: ${join.unplaced.map((e) => e.title).join(', ')}`);
  }
  if (join.not_in_setlist.length > 0) {
    console.log(`    On the card but not in the setlist: ${join.not_in_setlist.join(', ')}`);
  }
  const disagreed = join.songs.filter((s) => s.disagreement !== undefined);
  if (disagreed.length > 0) {
    console.log(`\n!   ${disagreed.length} song(s) where the setlist and the card disagree:`);
    for (const s of disagreed) {
      console.log(s.disagreement === 'stale_claim'
        ? `      ${s.title}: setlist says "${s.claim_text ?? 'no'}", card holds ${s.project_count} project${s.project_count === 1 ? '' : 's'} at ${s.where}`
        : `      ${s.title}: setlist says "${s.claim_text ?? 'yes'}", card holds nothing`);
    }
  }
  const errors = rig.view?.findings.filter((f) => f.severity === 'error') ?? [];
  if (errors.length > 0) {
    console.log(`\n!   ${errors.length} rig validation error(s):`);
    for (const e of errors) console.log(`      ${e.code}${e.ref ? ` (${e.ref})` : ''}: ${e.message}`);
  }

  console.log(`\n    ${(html.length / 1024).toFixed(0)} KB -> ${OUT}`);

  if (SHOW_TEXT && rig.view !== undefined) console.log(`\n${renderRigText(rig.view)}`);
  if (OPEN) openInBrowser(OUT);
}

main();
