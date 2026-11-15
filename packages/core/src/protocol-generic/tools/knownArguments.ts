/**
 * Server-wide refusal of UNKNOWN tool arguments.
 *
 * The SDK wraps a raw zod shape in `z.object(shape)`, and a zod object STRIPS
 * keys it does not declare. So a misremembered argument name was
 * indistinguishable from not passing it: `measure_loudness({path})` answered
 * with the input-device roster, `backup_device({out_dir})` wrote 28 projects to
 * the default folder and reported success. On a write the same silence lands a
 * default the caller never chose.
 *
 * ONE mechanism for every tool: `enforceKnownArguments(server)` wraps
 * `server.registerTool` once, before any family registers, so every tool
 * registered on that server (unified surface, send_* primitives, Hydrasynth
 * tools, the Rig Console) gets the check with no per-call-site edit.
 *
 * Why a wrapping Standard Schema and not `z.strictObject(shape)`: the wrapper
 * reuses the inner schema's own `~standard.jsonSchema`, so the `tools/list`
 * payload stays byte-identical (it is budgeted per tool, and a strict object
 * would add `additionalProperties:false` to all 55), and the refusal text is
 * ours: display-shaped, naming the bad key, the valid ones, and a close match.
 * Only TOP-LEVEL keys are checked; nested objects keep their own schemas.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

interface StandardLike {
  '~standard': {
    version: 1;
    vendor: string;
    validate: (value: unknown) => unknown;
    jsonSchema?: unknown;
  };
}

function isStandardSchema(v: unknown): v is StandardLike {
  return typeof v === 'object' && v !== null && '~standard' in v
    && typeof (v as StandardLike)['~standard']?.validate === 'function';
}

/** Levenshtein distance, for the "did you mean" hint. Keys are short. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** The closest valid key, when it is plausibly a misspelling or a renamed argument. */
function closestKey(bad: string, valid: readonly string[]): string | undefined {
  const lower = bad.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const k of valid) {
    const kl = k.toLowerCase();
    // Containment counts as close: "dir" -> "directory", "slot" -> "ncs_slot".
    const score = kl.includes(lower) || lower.includes(kl) ? 1 : editDistance(lower, kl);
    if (score < bestScore) { bestScore = score; best = k; }
  }
  return best !== undefined && bestScore <= Math.max(2, Math.floor(bad.length / 3)) ? best : undefined;
}

/**
 * The refusal text for unknown keys, or undefined when every key is known.
 * Exported for the gate that pins the wording.
 */
export function unknownArgumentMessage(args: unknown, valid: readonly string[]): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const known = new Set(valid);
  const unknown = Object.keys(args).filter((k) => !known.has(k));
  if (unknown.length === 0) return undefined;
  const named = unknown.map((k) => `"${k}"`).join(', ');
  const hints = unknown
    .map((k) => [k, closestKey(k, valid)] as const)
    .filter(([, c]) => c !== undefined)
    .map(([k, c]) => `"${k}" -> ${c}?`);
  return `unknown argument${unknown.length > 1 ? 's' : ''} ${named}. `
    + `Valid: ${valid.length > 0 ? valid.join(', ') : '(none, this tool takes no arguments)'}`
    + (hints.length > 0 ? `. Did you mean ${hints.join(', ')}` : '');
}

/**
 * Wrap one tool's input schema so an unknown top-level key fails validation.
 * Returns the schema unchanged when its keys cannot be known (a non-object
 * Standard Schema from another library).
 */
export function withKnownArguments(inputSchema: unknown): unknown {
  if (inputSchema === undefined) return undefined;
  let inner: StandardLike;
  let valid: string[];
  if (isStandardSchema(inputSchema)) {
    const shape = (inputSchema as { shape?: unknown }).shape;
    if (typeof shape !== 'object' || shape === null) return inputSchema;
    inner = inputSchema;
    valid = Object.keys(shape);
  } else if (typeof inputSchema === 'object' && inputSchema !== null) {
    inner = z.object(inputSchema as z.ZodRawShape) as unknown as StandardLike;
    valid = Object.keys(inputSchema);
  } else {
    return inputSchema;
  }
  const std = inner['~standard'];
  return {
    '~standard': {
      version: 1,
      vendor: std.vendor,
      validate: (value: unknown) => {
        const message = unknownArgumentMessage(value, valid);
        return message !== undefined ? { issues: [{ message }] } : std.validate(value);
      },
      // Same JSON Schema as the inner object, so tools/list does not change.
      ...(std.jsonSchema !== undefined ? { jsonSchema: std.jsonSchema } : {}),
    },
  };
}

/**
 * Make every tool registered on `server` from here on refuse unknown
 * arguments. Call once, right after constructing the server and before any
 * `register*Tools(server)`.
 */
export function enforceKnownArguments(server: McpServer): McpServer {
  const original = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: unknown) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (
    name: string,
    config: Record<string, unknown>,
    cb: unknown,
  ) => original(name, { ...config, inputSchema: withKnownArguments(config.inputSchema) }, cb);
  return server;
}
