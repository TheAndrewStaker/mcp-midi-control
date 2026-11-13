/**
 * rig-console-serve.ts: run the Rig Console HTTP host from the repo, with the
 * FULL three-panel model (rig + card + setlist).
 *
 * The packaged server's `open_rig_editor` serves a live rig panel but reports
 * the card and setlist absent: their loaders live here, script-side, beside
 * the gitignored maintainer data they read. This entry injects those loaders
 * through the host's sources seam, so the served page equals the generated
 * file (`npm run rig-console`) while staying LIVE: every request re-reads the
 * manifest, and an agent-side `edit_rig` pushes a refresh over SSE.
 *
 * Security posture is the host's own (loopback, fragment token, cookie-scoped
 * assets, CSP, idle expiry): nothing here weakens it, this only swaps the
 * data provider.
 *
 * USAGE
 *   npm run rig-console:serve             # prints the tokenised URL
 *   npm run rig-console:serve -- --port 8737
 *   (MCP_RIG_MANIFEST defaults to docs/_private/rig/rig.json when unset)
 *
 * TOUCHES NO HARDWARE. Reads three files, serves loopback HTTP.
 */
import { buildRigView, type Rig } from 'openrig';
import type { RenderInput, SourceStatus } from '@mcp-midi-control/rig-console-render';
import { existsSync, readFileSync } from 'node:fs';

import { startRigConsoleHost } from '../packages/server-all/src/server/webhost/host.js';
import {
  attachVoices, joinSongs, latestCapture, latestSetlist, loadCard, loadSetlist, loadVoices,
} from './_lib/console-sources.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };

if (process.env.MCP_RIG_MANIFEST === undefined || process.env.MCP_RIG_MANIFEST.trim() === '') {
  process.env.MCP_RIG_MANIFEST = 'docs/_private/rig/rig.json';
}

/** Same status shape the CLI generator reports for the rig source. */
function loadRig(path: string): { view?: RenderInput['view']; status: SourceStatus } {
  const base = { id: 'rig' as const, label: 'Rig manifest', path };
  if (!existsSync(path)) {
    return { status: { ...base, state: 'absent', detail: 'No file at this path. Set MCP_RIG_MANIFEST.' } };
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

/** The full script-side model, loaded fresh per request (the host calls this per /api/panels hit). */
function repoSources(): RenderInput {
  const rig = loadRig(process.env.MCP_RIG_MANIFEST ?? '');
  const card = loadCard(latestCapture());
  const setlist = loadSetlist(latestSetlist());
  const join = joinSongs(setlist.entries, card.card);
  attachVoices(join, loadVoices().mappings);
  return {
    view: rig.view,
    card: card.card,
    join,
    sources: [rig.status, card.status, setlist.status],
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
    command: 'npm run rig-console:serve',
  };
}

const port = Number.parseInt(flag('--port') ?? '', 10);
const host = await startRigConsoleHost({
  ...(Number.isFinite(port) ? { port } : {}),
  sources: repoSources,
});
console.log(`Rig Console serving at ${host.url}`);
console.log('Loopback only; the #t= fragment is the per-launch access token. Ctrl+C stops it.');
