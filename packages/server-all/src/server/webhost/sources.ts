/**
 * The console-host's SOURCES SEAM: what fills the three panels.
 *
 * The CLI generator (`scripts/rig-console.ts`) loads three things: the rig
 * manifest, the newest card capture, and the newest setlist. The rig loader
 * lives in core (`loadRigManifest`, env-configured) and is fully reachable
 * from this compiled package, so the rig panel is LIVE here: every call
 * re-reads through the same path-aware cache every tool read uses.
 *
 * The card and setlist loaders are deliberately NOT here. They live
 * script-side (`scripts/_lib/console-sources.ts`) beside the gitignored
 * maintainer data they read, and their decode stack (the card scan + the
 * roster) is repo-side by charter. So the DEFAULT provider reports those two
 * sources `absent` with a detail that names where the full page comes from,
 * and the provider is injectable: a repo-run standalone entry (P5) passes the
 * script-side loaders in, and the served page becomes the full three-panel
 * console with no change to this host. Absent-but-labelled is the console's
 * own contract for missing sources (never a crash, never an empty mystery).
 */
import type { RenderInput, SourceStatus } from '@mcp-midi-control/rig-console-render';
import { joinSongs } from '@mcp-midi-control/rig-console-render';
import { buildRigView } from 'openrig';

import { loadRigManifest } from '@mcp-midi-control/core/protocol-generic/openrig/index.js';

/** Supplies the render model for one request. Called fresh per `/api/panels` hit. */
export type ConsoleSourcesProvider = () => RenderInput;

function rigSource(): { view?: RenderInput['view']; status: SourceStatus } {
  const loaded = loadRigManifest();
  const base = { id: 'rig' as const, label: 'Rig manifest' };
  switch (loaded.status) {
    case 'unconfigured':
      return { status: { ...base, path: '(MCP_RIG_MANIFEST unset)', state: 'absent', detail: 'No rig manifest is configured. Set MCP_RIG_MANIFEST, or create one via edit_rig.' } };
    case 'absent':
      return { status: { ...base, path: loaded.source, state: 'absent', detail: 'Configured, but no file exists there yet. Create it via edit_rig / bootstrapRig.' } };
    case 'error':
      return { status: { ...base, path: loaded.source, state: 'error', detail: loaded.error } };
    case 'loaded': {
      const view = buildRigView(loaded.rig);
      const errors = view.findings.filter((f) => f.severity === 'error').length;
      return {
        view,
        status: {
          ...base, path: loaded.source, state: 'loaded',
          detail: `${view.counts.devices} devices, ${view.counts.links} cables, ${view.counts.bindings} bindings` +
            (errors > 0 ? `, ${errors} validation error${errors === 1 ? '' : 's'}` : ''),
        },
      };
    }
  }
}

/**
 * The provider the in-server `open_rig_editor` launch uses: a live rig panel,
 * card + setlist honestly absent (their loaders are repo-side; see header).
 */
export function defaultConsoleSources(): RenderInput {
  const rig = rigSource();
  const card: SourceStatus = {
    id: 'card', label: 'Circuit Tracks card capture', path: '(repo-side)', state: 'absent',
    detail: 'Card captures load in the repo-run console (npm run rig-console), not from the packaged server.',
  };
  const setlist: SourceStatus = {
    id: 'setlist', label: 'Setlist', path: '(repo-side)', state: 'absent',
    detail: 'Setlists load in the repo-run console (npm run rig-console), not from the packaged server.',
  };
  return {
    view: rig.view,
    card: undefined,
    join: joinSongs([], undefined),
    sources: [rig.status, card, setlist],
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
    command: 'open_rig_editor',
  };
}
