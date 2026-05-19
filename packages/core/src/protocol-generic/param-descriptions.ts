/**
 * Per-param prose lookup helper for the unified `list_params` /
 * `get_param` tools.
 *
 * Reads `param-descriptions.json` (committed alongside this module) at
 * import time and exposes one accessor: `getParamDescription(port,
 * block, name)`. Returns the verbatim Blocks Guide / Owner's Manual
 * excerpt for the given (device, block, param) tuple, or undefined if
 * the extractor didn't have a clean join for that param.
 *
 * The JSON is produced by `scripts/extract-param-descriptions.ts` (run
 * via `npm run extract-param-descriptions`). Contributors who change
 * the extractor commit the regenerated JSON in the same PR. The data
 * file is read at module load and held in memory; the file is ~80 KB
 * so the cost is one-time and negligible.
 *
 * Missing-entry behavior: the tool layer must check for `undefined`
 * and OMIT the `description` field rather than returning an empty
 * string. The agent's JSON parser then doesn't render "Description: "
 * with nothing after.
 *
 * Port resolution: the descriptors expose three id-style values per
 * device (`id`, `connection_label`, port_match patterns). The JSON is
 * keyed by `descriptor.id`. Callers pass the original `port` string
 * from the MCP tool input; we resolve it to the descriptor id by
 * checking the registered descriptor at call time. Doing the resolve
 * inside this helper keeps the call sites in the dispatcher executors
 * untouched.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDevice } from './registry.js';

type DescriptionMap = Readonly<{
  [deviceId: string]: Readonly<{
    [blockSlug: string]: Readonly<{
      [paramName: string]: string;
    }>;
  }>;
}>;

/**
 * Load the param-descriptions.json sitting next to this module. We
 * read it via `fs.readFileSync` rather than a JSON `import` so the
 * build doesn't have to flag every consumer with import assertions
 * (and so the JSON copies into `dist/` via the copy-build-assets
 * post-build step rather than getting inlined into the JS).
 */
function loadDescriptions(): DescriptionMap {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, 'param-descriptions.json');
  try {
    const raw = readFileSync(file, 'utf8');
    return JSON.parse(raw) as DescriptionMap;
  } catch {
    // No JSON or corrupt JSON shouldn't take down the server; the
    // lookup just always returns undefined. Logged once at boot.
    // eslint-disable-next-line no-console
    console.warn(
      `[param-descriptions] could not load ${file}; descriptions disabled`,
    );
    return {};
  }
}

const DESCRIPTIONS: DescriptionMap = loadDescriptions();

/**
 * Look up the manual-derived prose for a (port, block, name) tuple.
 *
 * The `port` argument is a free-form string the agent passed to the
 * MCP tool (e.g. "axe-fx-ii", "AM4", a port-name substring). It's
 * resolved to a descriptor id via the registry so synonyms / port-
 * name matches all funnel into the same lookup key.
 *
 * Returns undefined when no description is on file. Callers should
 * omit the response field entirely in that case rather than emitting
 * an empty string.
 */
export function getParamDescription(
  port: string,
  block: string,
  name: string,
): string | undefined {
  const desc = resolveDevice(port);
  if (!desc) return undefined;
  return DESCRIPTIONS[desc.id]?.[block]?.[name];
}

/**
 * Diagnostic helper for goldens / tests — exposes the full loaded
 * lookup without re-reading the file. Not for the runtime hot path.
 */
export function getAllDescriptions(): DescriptionMap {
  return DESCRIPTIONS;
}
