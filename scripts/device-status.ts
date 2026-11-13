/**
 * Device-status block generator for README.md.
 *
 * The README's device-support table is GENERATED from the registered
 * descriptors (the single source of truth for support tiers), so the
 * roster and tier words in the README cannot drift from what the server
 * actually registers. This kills the drift class where README prose
 * promised a tier the descriptor no longer declared.
 *
 * The descriptor set is imported exactly the way
 * `scripts/verify-contribution-guides.ts` imports it (which itself
 * mirrors `packages/server-all/src/server/createServer.ts`), so a newly
 * registered device shows up here the moment that gate learns about it.
 *
 * Run:
 *   npm run device-status          # rewrite the README block
 *   npm run device-status-check    # exit 1 on drift (in preflight)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR, AX8_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { AXEFXGEN1_DESCRIPTOR } from '@mcp-midi-control/fractal-gen1/descriptor.js';
import { MODERN_FRACTAL_DESCRIPTORS } from '@mcp-midi-control/fractal-gen3/device.js';
import { HYDRASYNTH_DESCRIPTOR } from '@mcp-midi-control/hydrasynth/descriptor.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '@mcp-midi-control/circuit-tracks/descriptor.js';
import { SPD_SX_DESCRIPTOR } from '@mcp-midi-control/spd-sx/descriptor.js';
import { VE500_DESCRIPTOR } from '@mcp-midi-control/ve-500/descriptor.js';
import { MICROFREAK_DESCRIPTOR, MINIFREAK_DESCRIPTOR } from '@mcp-midi-control/arturia/descriptor.js';
import { RC_505_MK2_DESCRIPTOR, RC_600_DESCRIPTOR } from '@mcp-midi-control/boss-rc/descriptor.js';
import { MPC_ONE_G2_DESCRIPTOR } from '@mcp-midi-control/akai-mpc/descriptor.js';
import type { DeviceDescriptor } from '@mcp-midi-control/core/protocol-generic/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const README = path.join(ROOT, 'README.md');

const START = '<!-- device-status:generated:start -->';
const END = '<!-- device-status:generated:end -->';

/**
 * Keyed by the EXACT identifier server-all uses at its registration
 * site, so `assertRosterMatchesServer()` can diff this map against a
 * scan of createServer.ts (same technique as
 * verify-contribution-guides.ts). Registering a device without teaching
 * this script about it fails the check rather than silently shipping a
 * README table that is one device short.
 */
const SYMBOLS: Record<string, DeviceDescriptor | readonly DeviceDescriptor[]> = {
  MODERN_FRACTAL_DESCRIPTORS,
  AXEFXGEN1_DESCRIPTOR,
  AX8_DESCRIPTOR,
  AXEFX2_DESCRIPTOR,
  AM4_DESCRIPTOR,
  HYDRASYNTH_DESCRIPTOR,
  CIRCUIT_TRACKS_DESCRIPTOR,
  SPD_SX_DESCRIPTOR,
  VE500_DESCRIPTOR,
  MICROFREAK_DESCRIPTOR,
  MINIFREAK_DESCRIPTOR,
  RC_505_MK2_DESCRIPTOR,
  RC_600_DESCRIPTOR,
  MPC_ONE_G2_DESCRIPTOR,
};

const ROSTER: DeviceDescriptor[] = Object.values(SYMBOLS).flatMap((v) =>
  Array.isArray(v) ? [...v] : [v],
);

const SERVER_INDEX = path.join(
  ROOT, 'packages', 'server-all', 'src', 'server', 'createServer.ts',
);

/** Scan createServer.ts for registered descriptor identifiers and assert
 * set equality with SYMBOLS. Mirrors verify-contribution-guides.ts. */
function assertRosterMatchesServer(): void {
  const src = readFileSync(SERVER_INDEX, 'utf8');
  const registered = new Set<string>();
  for (const m of src.matchAll(/registerMcpDevice\(\s*([A-Z][A-Z0-9_]*)\s*\)/g)) {
    registered.add(m[1]!);
  }
  // The gen-3 family registers through a loop over its exported array.
  for (const m of src.matchAll(/for \(const \w+ of ([A-Z][A-Z0-9_]*)\)/g)) {
    if (m[1]! in SYMBOLS) registered.add(m[1]!);
  }
  const known = new Set(Object.keys(SYMBOLS));
  const unknown = [...registered].filter((n) => !known.has(n)).sort();
  const stale = [...known].filter((n) => !registered.has(n)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `server-all registers descriptor(s) this script does not know: ` +
        `${unknown.join(', ')}. Add them to SYMBOLS (and CAPABILITY_PHRASE) ` +
        `in scripts/device-status.ts, then run npm run device-status.`,
    );
  }
  if (stale.length > 0) {
    throw new Error(
      `scripts/device-status.ts lists descriptor(s) server-all does not ` +
        `register: ${stale.join(', ')}. Remove them from SYMBOLS.`,
    );
  }
}

/**
 * The three tier words descriptors actually declare (every descriptor
 * source under packages/ uses exactly these), mapped to the
 * reader-facing label. An unknown tier fails loudly rather than
 * guessing a label.
 */
const TIER_LABEL: Record<string, string> = {
  'verified': 'Verified',
  'community-beta': 'Community beta',
  'generic-only': 'Generic MIDI only',
};
const TIER_ORDER: Record<string, number> = {
  'verified': 0,
  'community-beta': 1,
  'generic-only': 2,
};

/**
 * Hand-written one-phrase capability summaries, keyed by descriptor id.
 * Prose only; the tier and the link are descriptor-derived. A device
 * without an entry gets an empty cell, never invented prose.
 */
const CAPABILITY_PHRASE: Record<string, string> = {
  'am4': 'Whole-preset authoring, scenes, lineage data, tone translation',
  'axe-fx-ii': 'Whole-preset authoring, scenes, X/Y channels, tone translation',
  'hydrasynth': 'Whole-patch authoring with mod-matrix and macro wiring',
  'circuit-tracks': 'Pattern and song authoring, sample and project transfer, any storage pack',
  'spd-sx': 'Kit and sample authoring over USB storage, pad triggering over MIDI',
  've-500': 'Parameter set/read, whole-patch build, user-memory recall and save',
  'rc-505mk2': 'Memory recall and looper control over MIDI; loop, tempo, track and MIDI-menu reads plus assign authoring over USB storage',
  'microfreak': 'Byte-exact preset read/write, full-library restore, globals',
  'axe-fx-iii': 'Reads, writes, scenes, block placement, preset switching',
  'fm3': 'The same gen-3 surface over its USB-serial control channel',
  'fm9': 'Reads, writes, scenes, block placement, preset switching',
  'vp4': 'Reads, continuous-knob writes, bypass, save',
  'ax8': 'Axe-Fx II codec surface, preset and setlist authoring',
  'axe-fx-gen1': 'Parameter set and read, preset-structure read',
  'minifreak': 'CC and Program Change with a curated control map',
  'rc-600': 'Memory recall over MIDI, memory-file reads over USB storage',
  'mpc-one-g2': 'Sequence recall by Program Change, live drum patterns over MIDI, project reads from the SD card and internal storage',
};

function tierOf(d: DeviceDescriptor): string {
  const tier = d.capabilities.support_tier;
  if (tier === undefined) {
    throw new Error(`${d.id}: descriptor declares no support_tier (preflight requires one)`);
  }
  if (!(tier in TIER_LABEL)) {
    throw new Error(`${d.id}: unknown support_tier "${tier}"; teach TIER_LABEL about it`);
  }
  return tier;
}

function renderBlock(): string {
  const rows = [...ROSTER].sort((a, b) => {
    const t = TIER_ORDER[tierOf(a)] - TIER_ORDER[tierOf(b)];
    return t !== 0 ? t : a.display_name.localeCompare(b.display_name);
  });
  const lines: string[] = [];
  lines.push(START);
  lines.push('');
  lines.push('| Device | Support | What works today | Owner\'s page |');
  lines.push('|---|---|---|---|');
  for (const d of rows) {
    const phrase = CAPABILITY_PHRASE[d.id] ?? '';
    const link = `[${d.id}](docs/contributing/devices/${d.id}.md)`;
    lines.push(`| **${d.display_name}** | ${TIER_LABEL[tierOf(d)]} | ${phrase} | ${link} |`);
  }
  lines.push('');
  lines.push(`${ROSTER.length} registered devices. Generated by \`npm run device-status\` from each device's descriptor; preflight fails on drift.`);
  lines.push('');
  lines.push(END);
  return lines.join('\n');
}

function main(): void {
  const checkMode = process.argv.includes('--check');
  assertRosterMatchesServer();
  const block = renderBlock();
  const readme = readFileSync(README, 'utf8');
  const startIdx = readme.indexOf(START);
  const endIdx = readme.indexOf(END);
  if (startIdx === -1 || endIdx === -1) {
    console.error(`README.md is missing the ${START} / ${END} markers.`);
    process.exit(1);
  }
  const updated =
    readme.slice(0, startIdx) + block + readme.slice(endIdx + END.length);

  if (checkMode) {
    const norm = (s: string) => s.replace(/\r\n/g, '\n');
    if (norm(updated) !== norm(readme)) {
      console.error('Drift: README.md device-status block is out of sync. Run npm run device-status.');
      process.exit(1);
    }
    console.log(`No drift (${ROSTER.length} devices).`);
    return;
  }

  if (updated !== readme) {
    writeFileSync(README, updated, 'utf8');
    console.log(`Updated README.md device-status block (${ROSTER.length} devices).`);
  } else {
    console.log('README.md device-status block is already up to date.');
  }
}

main();
