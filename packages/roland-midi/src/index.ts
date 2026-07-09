// roland-midi public entry point.
//
// Consumers import from the subpath that matches their layer/device:
//   import { buildDT1, rolandChecksum } from 'roland-midi/shared';
//   import { VE500 } from 'roland-midi/ve-500';
//
// Pure-TypeScript Roland/Boss codec. No MIDI transport, no MCP.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(HERE, '..', 'package.json'), 'utf8'),
) as { version: string };

export const VERSION: string = pkg.version;
