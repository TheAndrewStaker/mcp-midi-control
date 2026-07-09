/**
 * Roland SPD-SX agent-regression cases (SAMPLER archetype — storage transport).
 *
 * The SPD-SX has no MIDI mock; it is a storage-transport device. The runner
 * injects `MCP_SPDSX_ROOT` pointing at a deterministic fixture tree (3 waves:
 * kick/snare/hat at indices 0/1/2; one kit "Demo Kit" at location 1 mapping pads
 * 1-3 → those waves). See `getSpdsxFixtureRoot` in runner.ts.
 *
 * The large-coverage case exercises the read + dry-author surface end to end
 * (scan_locations + get_preset + list_samples + author_kit dry-run) without
 * mutating the fixture, so it is deterministic across re-runs. The write path
 * (upload_sample / a real author_kit write) is hardware-confirmed separately and
 * would grow the fixture, so it is deliberately out of scope here.
 */

import type { AgentRegressionCase } from './types.js';

export const SPD_SX_CASES: AgentRegressionCase[] = [
  // ── Large coverage: full read + dry-author rundown ────────────────────────
  {
    id: 'spdsx-archetype-full-rundown',
    device: 'spd-sx',
    description:
      'Sampler archetype, large coverage: a "full rundown + dry-run build" request should walk the storage read surface — scan_locations (list kits), get_preset (one kit\'s pad→wave map), list_samples (the wave pool) — and then author_kit with dry_run:true to preview a kit WITHOUT writing it. Catches an agent that fabricates kit/wave contents, reaches for MIDI param tools on a storage device, or writes the kit when only a preview was asked. All reads hit the deterministic fixture (kits + waves), so the envelope is stable.',
    prompt:
      'Give me a full rundown of my SPD-SX over the storage connection: list the kits, show me what is on kit 1, and list the wave pool. ' +
      'Then do a DRY RUN of authoring a new kit called "Test" from the kick, snare and hat waves — preview it, do NOT actually write it to the device.',
    expectations: {
      must_call: ['scan_locations', 'list_samples', 'author_kit'],
      // Never mutate the wave pool, and never reach for MIDI param tools on a storage device.
      must_not_call: ['upload_sample', 'set_param', 'get_param'],
      max_tools: 10,
      min_tools: 3,
      tool_call_validators: [
        {
          tool: 'author_kit',
          call_index: 'last',
          check: (args) => {
            if (args.dry_run !== true) return `author_kit must use dry_run:true on a preview request, got ${JSON.stringify(args.dry_run)}.`;
            const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
            if (!port.includes('spd')) return `author_kit port should target the SPD-SX, got ${String(args.port)}.`;
            if (args.confirm_overwrite === true) return 'author_kit must not pass confirm_overwrite on a dry-run preview.';
            return true;
          },
        },
        {
          // If the agent reads a kit (it should), it must read kit 1, not fabricate.
          tool: 'get_preset',
          optional: true,
          check: (args) => {
            const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
            if (!port.includes('spd')) return `get_preset port should target the SPD-SX, got ${String(args.port)}.`;
            return true;
          },
        },
      ],
      text_contains: ['Demo Kit'], // kit 1's name comes off the fixture — proves a real read, not a fabrication
      max_wall_seconds: 150,
    },
  },
];
