/**
 * Gate: the Rig Console host's route modules may reach the dispatcher layer
 * and the pure renderer, and NOTHING deeper.
 *
 * RIG-CONSOLE-DESIGN.md ("The browser talks REST to the same dispatcher"):
 * parity between the browser and the agent stops being structural under REST
 * and is restored by this one mechanical check. It is an IMPORT ALLOWLIST
 * rather than a call-name rule because the `execute*` prefix is not a
 * reliable boundary marker (the design's scope section shows `describeDevice`
 * and friends reach the dispatcher under other names).
 *
 * A webhost module importing a device package's writer/reader, `fractal-midi`,
 * or the MIDI transport would give the browser a capability the tool surface
 * does not route identically, which is defect-by-construction. Fails loudly,
 * names the file and the specifier.
 *
 * Run: npx tsx scripts/verify-route-imports.ts   (registered in preflight)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WEBHOST_DIR = 'packages/server-all/src/server/webhost';

/** import specifier prefixes a webhost module may use. */
const ALLOWED_PREFIXES = [
  'node:',                                          // platform
  './',                                             // webhost-internal
  '@mcp-midi-control/core/protocol-generic/',       // the dispatcher layer + rig store
  '@mcp-midi-control/rig-console-render',           // the pure renderer
  'openrig',                                        // the pure schema/model package
];

/** Specifiers that must never appear, even if a prefix rule would someday admit them. */
const FORBIDDEN_SUBSTRINGS = [
  'fractal-midi',
  '@julusian/midi',
  '/midi/transport',
  '@mcp-midi-control/am4',
  '@mcp-midi-control/fractal',
  '@mcp-midi-control/hydrasynth',
  '@mcp-midi-control/circuit-tracks',
  '@mcp-midi-control/spd-sx',
  '@mcp-midi-control/arturia',
  '@mcp-midi-control/ve-500',
  '@mcp-midi-control/boss-rc',
  '@mcp-midi-control/akai-mpc',
];

let failures = 0;
const fail = (msg: string): void => { console.error(`  FAIL ${msg}`); failures++; };

const files = readdirSync(WEBHOST_DIR).filter((f) => f.endsWith('.ts'));
if (files.length === 0) {
  fail(`no .ts files under ${WEBHOST_DIR}; the gate is scanning the wrong place`);
}

for (const file of files) {
  const path = join(WEBHOST_DIR, file);
  const src = readFileSync(path, 'utf8');
  // Both `import ... from 'x'` and `export ... from 'x'` bring code in.
  const specifiers = [...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gms)]
    .map((m) => m[1]);
  for (const spec of specifiers) {
    if (FORBIDDEN_SUBSTRINGS.some((s) => spec.includes(s))) {
      fail(`${path} imports "${spec}", which is below the dispatcher boundary`);
      continue;
    }
    if (!ALLOWED_PREFIXES.some((p) => spec === p || spec.startsWith(p))) {
      fail(`${path} imports "${spec}", which is not on the webhost allowlist (${ALLOWED_PREFIXES.join(', ')})`);
    }
  }
  console.log(`  ok    ${path} (${specifiers.length} imports)`);
}

if (failures === 0) {
  console.log('verify-route-imports passed.');
  process.exit(0);
}
console.error(`${failures} verify-route-imports failure(s).`);
process.exit(1);
