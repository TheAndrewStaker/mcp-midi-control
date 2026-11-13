/**
 * fixture.ts — render the Rig Console from SYNTHETIC inputs for the Playwright
 * gate (`npm run verify-console-flows`).
 *
 * WHY SYNTHETIC. The real console's inputs are the maintainer's gitignored
 * data (rig.json, a card capture, the setlist, song-mappings.json), so a gate
 * that read them could never run on a contributor clone or in CI. This fixture
 * feeds the SAME pure pipeline (buildRigView → joinSongs → attachVoices →
 * renderConsole) values constructed here, so the gate exercises the console's
 * code, not the maintainer's data. The rig is openrig's own §10 worked example
 * (LOOPER_HUB_RIG), which is already validateRig-clean and exercises both
 * flows: audio (guitar chain into the looper hub, hub to front of house) and
 * MIDI (clock + notes + a router).
 *
 * DETERMINISTIC BY CONSTRUCTION. No Date.now, no randomness, fixed strings;
 * the same inputs render byte-identical HTML, which is what makes the
 * screenshot baseline meaningful.
 *
 * The fixture deliberately covers every state the specs assert on:
 *   - a song across four occupied pads (selection lights a run),
 *   - a second on-card song with NO voices filed (the panel's honest message),
 *   - a setlist song with nothing on the card (the Staging group),
 *   - a voices entry matching nothing (voices_unmatched reporting),
 *   - claims in all three statuses (confirmed / proposed / owed),
 *   - an owed claim with NO slot (the BK-VOICES-FILING shape),
 *   - a flagged slot (marker → .flag) and a free-run report.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOOPER_HUB_RIG, buildRigView } from 'openrig';

import {
  attachVoices, joinSongs, parseSetlist, renderConsole,
  type ConsoleCard, type ConsolePack, type ConsoleSlot, type SourceStatus, type VoiceMappingEntry,
} from '@mcp-midi-control/rig-console-render';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_HTML = join(HERE, '.out', 'fixture-console.html');

function slot(pack: number, n: number, extra: Partial<ConsoleSlot> = {}): ConsoleSlot {
  return { pack, slot: n, occupied: false, tracks: [], markers: [], notes: [], ...extra };
}

function packOf(pack: number, name: string, used: Map<number, Partial<ConsoleSlot>>): ConsolePack {
  const slots = Array.from({ length: 64 }, (_, i) =>
    slot(pack, i + 1, used.get(i + 1) !== undefined ? { occupied: true, ...used.get(i + 1) } : {}));
  const occupied = slots.filter((s) => s.occupied).length;
  const runs: { from: number; to: number }[] = [];
  let start: number | undefined;
  for (let i = 1; i <= 65; i++) {
    const free = i <= 64 && !slots[i - 1]!.occupied;
    if (free && start === undefined) start = i;
    if (!free && start !== undefined) { runs.push({ from: start, to: i - 1 }); start = undefined; }
  }
  return { pack, name, occupied, free: 64 - occupied, free_runs: runs, slots };
}

export function buildFixtureHtml(): string {
  const view = buildRigView(LOOPER_HUB_RIG);

  const alpha = (n: number, part: string, extra: Partial<ConsoleSlot> = {}): Partial<ConsoleSlot> => ({
    name: `Alpha ${n} ${part}`, kind: 'song', song: 'Alpha', artist: 'The Fixtures',
    part: `P${n}`, tempo: 120, colour_index: 8, colour: 'Green', ...extra,
  });
  const pack1 = packOf(1, 'Fixture Pack One', new Map<number, Partial<ConsoleSlot>>([
    [1, alpha(1, 'Intro')],
    [2, alpha(2, 'Verse')],
    [3, alpha(3, 'Chorus')],
    [4, alpha(4, 'Outro', { markers: ['NAME MISMATCH'] })],
    [9, { name: 'Granite', kind: 'groove-mixwave', tempo: 96, colour_index: 11, colour: 'Blue' }],
  ]));
  const pack2 = packOf(2, 'Fixture Pack Two', new Map<number, Partial<ConsoleSlot>>([
    [1, { name: 'Bravo 1', kind: 'song', song: 'Bravo', artist: 'The Fixtures', part: 'P1', tempo: 84, colour_index: 10, colour: 'Cyan' }],
    [2, { name: 'Bravo 2', kind: 'song', song: 'Bravo', artist: 'The Fixtures', part: 'P2', tempo: 84, colour_index: 10, colour: 'Cyan' }],
  ]));
  const occupied = pack1.occupied + pack2.occupied;
  const card: ConsoleCard = {
    captured_at: '2026-01-01T00:00:00.000Z',
    capture_dir: 'tests/console-e2e (synthetic)',
    packs: [pack1, pack2],
    totals: { occupied, free: 128 - occupied, slots: 128 },
  };

  const setlist = parseSetlist(`## The order

| # | Song | Artist | Ear-checked |
|---|---|---|---|
| 1 | Alpha | The Fixtures | yes |
| 2 | Bravo | The Fixtures | ? |
| 3 | Charlie | The Fixtures | ? |
`);

  const join2 = joinSongs(setlist, card);
  const voices: VoiceMappingEntry[] = [
    {
      song: 'Alpha',
      claims: [
        { device: 'hydrasynth', slot: 'A002', expected_name: 'Warm Sub', role: 'Synth 1 bass', status: 'confirmed' },
        { device: 'microfreak', slot: 98, expected_name: 'Infini Pad', role: 'MIDI 1 pad', status: 'proposed' },
        { device: 'spd-sx', role: 'Drum kit never recorded', status: 'owed' },
      ],
    },
    { song: 'Delta', claims: [{ device: 'hydrasynth', slot: 'A001', expected_name: 'Fuzz Sub', status: 'proposed' }] },
  ];
  attachVoices(join2, voices);

  const sources: SourceStatus[] = [
    { id: 'rig', label: 'Rig manifest', path: 'fixture', state: 'loaded', detail: `${view.counts.devices} devices, ${view.counts.links} cables, ${view.counts.bindings} bindings` },
    { id: 'card', label: 'Circuit Tracks card capture', path: 'fixture', state: 'loaded', detail: `${occupied} of 128 slots occupied, captured 2026-01-01` },
    { id: 'setlist', label: 'Setlist', path: 'fixture', state: 'loaded', detail: '3 songs in performance order' },
  ];

  return renderConsole({
    view, card, join: join2, sources,
    generatedAt: '2026-01-01 00:00',
    command: 'npm run verify-console-flows (synthetic fixture)',
  });
}

export function writeFixture(): string {
  mkdirSync(dirname(FIXTURE_HTML), { recursive: true });
  writeFileSync(FIXTURE_HTML, buildFixtureHtml(), 'utf8');
  return FIXTURE_HTML;
}

// Allow `npx tsx tests/console-e2e/fixture.ts` for hand inspection.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(writeFixture());
}
