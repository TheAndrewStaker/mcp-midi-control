/**
 * Golden for the param-descriptions feature.
 *
 * Asserts the committed `param-descriptions.json` is:
 *   1. Well-formed JSON.
 *   2. Shaped as { device: { block: { param: string } } } at every
 *      level, with non-empty string values.
 *   3. Sorted deterministically (keys at every level in lexicographic
 *      order) so re-running the extractor produces a byte-identical
 *      diff.
 *   4. Dash-clean (no em / en dashes, no Unicode replacement chars,
 *      no inline ASCII double-dash em-substitutes).
 *   5. Provides minimum-coverage entries for the known-good lookups
 *      the runtime depends on. If these break, the extractor's
 *      label-join regressed and `list_params(include_descriptions:
 *      true)` will silently return nothing for the affected entries.
 *
 * Run via `npm run verify-param-descriptions`. Wired into the root
 * `npm test` chain so preflight catches drift before it reaches a
 * release.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Register all devices so getParamDescription can resolve `port` to a
// descriptor id at lookup time. The descriptor modules don't auto-
// register (registration is explicit in `server-all/index.ts`); we
// mirror that here so the helper has a populated registry to resolve
// against.
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/axe-fx-iii/device.js';
import { HYDRASYNTH_DESCRIPTOR } from '@mcp-midi-control/hydrasynth/descriptor.js';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';

import { getParamDescription } from '@mcp-midi-control/core/protocol-generic/param-descriptions.js';

registerDevice(AXEFX3_DESCRIPTOR);
registerDevice(AXEFX2_DESCRIPTOR);
registerDevice(AM4_DESCRIPTOR);
registerDevice(HYDRASYNTH_DESCRIPTOR);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const JSON_PATH = path.join(
  ROOT,
  'packages',
  'core',
  'src',
  'protocol-generic',
  'param-descriptions.json',
);

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ── 1. Well-formed JSON ────────────────────────────────────────────

const raw = readFileSync(JSON_PATH, 'utf8');
let data: unknown;
try {
  data = JSON.parse(raw);
} catch (err) {
  console.log(`FATAL: ${JSON_PATH} is not valid JSON: ${(err as Error).message}`);
  process.exit(1);
}

// ── 2. Shape ───────────────────────────────────────────────────────

interface Shape {
  [device: string]: { [block: string]: { [param: string]: string } };
}

function isShape(v: unknown): v is Shape {
  if (typeof v !== 'object' || v === null) return false;
  for (const blocks of Object.values(v as Record<string, unknown>)) {
    if (typeof blocks !== 'object' || blocks === null) return false;
    for (const params of Object.values(blocks as Record<string, unknown>)) {
      if (typeof params !== 'object' || params === null) return false;
      for (const desc of Object.values(params as Record<string, unknown>)) {
        if (typeof desc !== 'string' || desc.length === 0) return false;
      }
    }
  }
  return true;
}

check('shape: { device: { block: { param: non-empty-string } } }', isShape(data));

const shaped = data as Shape;
let totalEntries = 0;
for (const blocks of Object.values(shaped)) {
  for (const params of Object.values(blocks)) {
    totalEntries += Object.keys(params).length;
  }
}
check(`entry count >= 100 (got ${totalEntries})`, totalEntries >= 100, String(totalEntries));

// ── 3. Sort order ──────────────────────────────────────────────────

function isSorted(keys: string[]): boolean {
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] <= keys[i - 1]) return false;
  }
  return true;
}

const deviceKeys = Object.keys(shaped);
check('device keys sorted', isSorted(deviceKeys), deviceKeys.join(','));
for (const dev of deviceKeys) {
  const blockKeys = Object.keys(shaped[dev]);
  check(`${dev}: block keys sorted`, isSorted(blockKeys));
  for (const block of blockKeys) {
    const paramKeys = Object.keys(shaped[dev][block]);
    check(`${dev}.${block}: param keys sorted`, isSorted(paramKeys));
  }
}

// ── 4. Dash-cleanliness ────────────────────────────────────────────

check('no em-dashes', !raw.includes('—'));
check('no en-dashes', !raw.includes('–'));
check('no replacement chars', !raw.includes('�'));
// Single dashes inside identifiers are fine; an inline em-dash
// substitute is `text--text` (no space, two dashes). The cleaner
// normalizes those out.
check('no inline double-dash em substitutes', !/\w--\w/.test(raw));

// ── 5. Known-good lookups via the runtime helper ──────────────────

interface LookupCase {
  port: string;
  block: string;
  name: string;
  /** Substring that must appear in the description if present. */
  mustInclude?: string;
}

// Each case is a (device, block, param) tuple where the extractor
// produced a usable join. If any of these regress, the extractor's
// join logic has changed in a way that broke the runtime lookup.
const lookupCases: LookupCase[] = [
  {
    port: 'am4',
    block: 'amp',
    name: 'gain',
    mustInclude: 'preamp gain',
  },
  {
    port: 'am4',
    block: 'reverb',
    name: 'time',
  },
  {
    port: 'am4',
    block: 'amp',
    name: 'presence',
  },
  {
    port: 'axe-fx-ii',
    block: 'amp',
    name: 'master_volume',
  },
  {
    port: 'axe-fx-ii',
    block: 'reverb',
    name: 'time',
  },
];

for (const c of lookupCases) {
  const d = getParamDescription(c.port, c.block, c.name);
  if (!d) {
    check(`lookup ${c.port}.${c.block}.${c.name}`, false, 'no description on file');
    continue;
  }
  if (c.mustInclude && !d.toLowerCase().includes(c.mustInclude.toLowerCase())) {
    check(
      `lookup ${c.port}.${c.block}.${c.name} contains "${c.mustInclude}"`,
      false,
      `got: ${d.slice(0, 80)}...`,
    );
    continue;
  }
  check(`lookup ${c.port}.${c.block}.${c.name}`, true);
}

// Negative case: a clearly-unknown param returns undefined (not '').
check(
  'unknown param returns undefined',
  getParamDescription('axe-fx-ii', 'amp', 'this_param_does_not_exist') === undefined,
);
check(
  'unknown port returns undefined',
  getParamDescription('not-a-real-port', 'amp', 'gain') === undefined,
);

// ── Summary ────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
