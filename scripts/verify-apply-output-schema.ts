// verify-apply-output-schema.ts
//
// The gate on every MCP tool in this repo that declares an `outputSchema`.
// Named for apply_preset because that is the tool the first incident hit; it
// now covers all of them.
//
// It asserts TWO INDEPENDENT PROPERTIES, and they must not be collapsed into
// one, because they fail for different reasons and cost different things:
//
//   1. SAFETY: the JSON Schema the SDK renders from the declared shape must be
//      PERMISSIVE at every nesting level, so a client-side validator can never
//      reject a real response. A red here means a live tool can hard-fail
//      AFTER its writes have landed on hardware.
//   2. FRESHNESS: the declared shape must still describe the result type the
//      dispatcher actually returns. A red here means the schema has become
//      stale documentation. Nothing breaks at runtime; it just stops being
//      true.
//
// Why the safety half exists (2026-07-16 incident, then the 2026-08-02 audit):
// apply_preset is an outputSchema-declared tool. The SDK renders a declared
// `z.object` to JSON Schema with `"additionalProperties": false` at EVERY
// nesting level (`server/mcp.js` -> `toJsonSchemaCompat(obj, { pipeStrategy:
// 'output' })`), and the MCP *client* compiles that into an Ajv validator and
// THROWS `McpError(InvalidParams)` on a mismatch (`client/index.js`,
// `callTool` -> `getToolOutputValidator`). When BK-103b added `auto_applied`
// to `ApplyResult` without adding it to the schema, EVERY apply_preset
// response was rejected client-side by Claude Desktop with a generic "Tool
// execution failed" AFTER the wire writes had landed: a false-negative failure
// invisible to server logs, launch-verify, and every offline suite. A full
// hardware bench day chased it as host flakiness.
//
// The 2026-07-16 fix was a lockstep gate (property 2 below), which stops that
// EXACT drift. It does not stop the class: any future field added to a result
// type between one session and the next re-arms the same trap, and three more
// tools carried the same strictness. So the shapes are now declared with
// `z.looseObject` and this gate proves it, tool by tool, by rendering the
// schema through the SDK's own converter and running the SDK's own Ajv
// validator over it. Then the strictness cannot come back by accident, and the
// lockstep check downgrades from "prevents an outage" to "keeps the docs
// honest", which is what it should have been all along.
//
// Note on `required`: it is NOT dropped, and that is deliberate. A response
// missing a required key cannot drift silently the way an extra key can,
// because the dispatcher's return type declares those keys non-optional and
// every return path has to satisfy the compiler. `additionalProperties: false`
// was the half of the strictness with nothing behind it.
//
// Run:  npx tsx scripts/verify-apply-output-schema.ts

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import * as z from 'zod/v4';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

// Source imports, not the published `@mcp-midi-control/*` subpaths (which
// resolve to `dist/`). This gate has to see the shape a developer just edited,
// not the one from the last build; a schema gate that can only go red after a
// rebuild would not have caught the drift it exists for. Same convention as
// scripts/verify-recipe-tables.ts.
import {
  APPLY_PRESET_OUTPUT_SCHEMA,
  APPLY_PRESET_OUTPUT_SHAPE,
} from '../packages/core/src/protocol-generic/tools/preset.js';
import {
  DELETE_PROJECT_OUTPUT_SCHEMA,
  DELETE_PROJECT_OUTPUT_SHAPE,
} from '../packages/core/src/protocol-generic/tools/uploads.js';
import {
  SET_MACRO_OUTPUT_SCHEMA,
  SET_SYSTEM_PARAM_OUTPUT_SCHEMA,
} from '../packages/hydrasynth/src/tools/params.js';
import { HYDRA_NAVIGATE_TO_OUTPUT_SCHEMA } from '../packages/hydrasynth/src/tools/navigation.js';
import type {
  ApplyResult,
  PresetSpec,
  ProjectDeleteOutcome,
} from '../packages/core/src/protocol-generic/types.js';

let failures = 0;
const ok = (msg: string) => console.log(`  OK   ${msg}`);
const fail = (msg: string) => { console.error(`  FAIL ${msg}`); failures++; };

// ── The registry of declared output schemas ─────────────────────────
//
// Every entry is checked for permissiveness. `maximal` is a maximal instance
// of what the tool returns; where the tool has a named result type the literal
// is TYPED against it, so the root typecheck forces the literal to track the
// type and the strict-parse below then forces the schema to track the literal.
//
// The set is asserted complete against a source scan at the end of this file,
// so a fifth tool cannot start declaring an outputSchema without landing here.

interface DeclaredOutputSchema {
  tool: string;
  /** Source file that declares it, for the completeness assertion. */
  file: string;
  /** The exact schema object passed to `registerTool({ outputSchema })`. */
  schema: unknown;
  /** A maximal response, every field populated. */
  maximal: Record<string, unknown>;
  /**
   * The raw shape, when the tool has a named result type worth holding the
   * schema against. Absent means "safety-checked only, no lockstep": the
   * tool builds its structuredContent as an inline literal and there is no
   * type to compare with.
   */
  lockstepShape?: z.ZodRawShape;
}

// Every ApplyResult field populated. `Required<>` means: if ApplyResult gains
// a field, this literal stops compiling (root tsconfig typecheck) until it is
// added here, and then the strict parse below fails until the schema learns it
// too. `device` rides on top because the dispatcher adds it to the tool
// payload after the writer returns.
const maximalApplyResult: Required<ApplyResult> & { device: string } = {
  ok: true,
  steps: 3,
  duration_ms: 1234,
  failed_step: { index: 1, description: 'apply', error: 'x' },
  nacked_steps: [{ index: 2, description: 'cable', error: 'nack', kind: 'cable' }],
  warning: 'w',
  saved: false,
  validation_errors: [{
    slot_index: 0,
    scene_index: 1,
    routing_index: 2,
    path: 'slots[0].params.gain',
    error: 'out of range',
    suggestions: ['use 0..10'],
    suggested_substitution: '9.5',
  }],
  validation_info: [{
    slot_index: 0,
    scene_index: 1,
    path: 'slots[0].params.volume',
    info: 'alias resolved',
    alias_used: 'volume',
    original_value: 'volume',
    canonical: 'level',
    level: 'info',
    dropped_param: 'mid',
    reason: 'not exposed',
    retry_action: 'none',
  }],
  chain_integrity: {
    ok: true,
    breaks: [{ slot_ref: { row: 2, col: 3 }, reason: 'routing_mask 0' }],
    notes: [{ slot_ref: { row: 2, col: 4 }, note: 'shunt' }],
    summary: 'intact',
    extra_round_trips: 2,
  },
  applied_spec: { slots: [] } as unknown as PresetSpec,
  recipe_id: 'edge_dotted_eighth_lead',
  auto_applied: {
    params: { master_low_cut: '80 Hz' },
    channels: ['A'],
    note: 'THE SERVER auto-applied ...',
  },
  device: 'Fractal AM4',
};

// Same discipline for delete_project: typed against ProjectDeleteOutcome, so
// a new field on the erase receipt has to be added here (typecheck) and then
// to the schema (strict parse).
const maximalDeleteOutcome: Required<ProjectDeleteOutcome> = {
  ok: true,
  pack: 5,
  deleted: [{
    slot: 61,
    ok: true,
    name: 'AFTER DARK',
    backup_path: 'C:/Users/x/mcp-midi-backups/pack5-project61.ncs',
    gone_by_query: true,
    gone_by_directory: true,
    matches_free_control: true,
    error: 'not erased',
  }],
  info: 'Erased 1 project. Backups in ...',
  warning: 'one slot unconfirmed',
};

const DECLARED: readonly DeclaredOutputSchema[] = [
  {
    tool: 'apply_preset',
    file: 'packages/core/src/protocol-generic/tools/preset.ts',
    schema: APPLY_PRESET_OUTPUT_SCHEMA,
    maximal: maximalApplyResult as unknown as Record<string, unknown>,
    lockstepShape: APPLY_PRESET_OUTPUT_SHAPE,
  },
  {
    tool: 'delete_project',
    file: 'packages/core/src/protocol-generic/tools/uploads.ts',
    schema: DELETE_PROJECT_OUTPUT_SCHEMA,
    maximal: maximalDeleteOutcome as unknown as Record<string, unknown>,
    lockstepShape: DELETE_PROJECT_OUTPUT_SHAPE,
  },
  {
    tool: 'set_system_param',
    file: 'packages/hydrasynth/src/tools/params.ts',
    schema: SET_SYSTEM_PARAM_OUTPUT_SCHEMA,
    maximal: { id: 'system.master_volume', cc: 7, value: 100, module: 'System', parameter: 'Master Volume' },
  },
  {
    tool: 'set_macro',
    file: 'packages/hydrasynth/src/tools/params.ts',
    schema: SET_MACRO_OUTPUT_SCHEMA,
    maximal: { macro: 1, cc: 16, value: 64, port: 'hydrasynth' },
  },
  {
    // Not on the live surface (registration commented out in
    // packages/hydrasynth/src/server.ts). Gated anyway so re-registering it
    // cannot re-open the hazard silently.
    tool: 'hydra_navigate_to',
    file: 'packages/hydrasynth/src/tools/navigation.ts',
    schema: HYDRA_NAVIGATE_TO_OUTPUT_SCHEMA,
    maximal: {
      target_slot: 'A001',
      target_bank: 0,
      target_patch: 1,
      elapsed_ms: 213,
      inbound_message_count: 2,
      has_input: true,
    },
  },
];

/**
 * Render a declared outputSchema exactly the way the SDK does when it answers
 * `tools/list`. Kept byte-for-byte identical to `server/mcp.js`:
 *
 *   toJsonSchemaCompat(normalizeObjectSchema(tool.outputSchema),
 *                      { strictUnions: true, pipeStrategy: 'output' })
 *
 * If that call ever changes shape in a new SDK, this gate must change with it,
 * or it starts testing something the client never sees.
 */
function renderJsonSchema(schema: unknown): Record<string, unknown> {
  return toJsonSchemaCompat(schema as never, {
    strictUnions: true,
    pipeStrategy: 'output',
  }) as Record<string, unknown>;
}

/** Every JSON-pointer-ish path in `node` where `additionalProperties` is literally false. */
function findClosedObjects(node: unknown, at: string, out: string[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => findClosedObjects(child, `${at}[${i}]`, out));
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.additionalProperties === false) out.push(at === '' ? '(root)' : at);
  for (const [key, child] of Object.entries(obj)) {
    findClosedObjects(child, at === '' ? key : `${at}.${key}`, out);
  }
}

console.log('outputSchema safety (a client validator must not be able to reject a real response):');

for (const entry of DECLARED) {
  const json = renderJsonSchema(entry.schema);

  // 1a. Structural: no closed object anywhere in the rendered schema.
  const closed: string[] = [];
  findClosedObjects(json, '', closed);
  if (closed.length === 0) {
    ok(`${entry.tool}: rendered JSON Schema is permissive at every level`);
  } else {
    fail(
      `${entry.tool}: rendered JSON Schema has "additionalProperties": false at ` +
      `${closed.length} place(s) [${closed.join(', ')}]. A response carrying a field the ` +
      `schema does not name will be REJECTED client-side AFTER the tool has already run. ` +
      `Declare the object(s) with z.looseObject, not z.object (nested objects too). ` +
      `See the block comment in packages/core/src/protocol-generic/tools/preset.ts.`,
    );
  }

  // 1b. Behavioural: run the SDK's own Ajv validator, the exact class
  //     `Client` constructs, over the maximal response AND over that response
  //     plus a field nobody has declared yet. Both must pass.
  //
  //     1a and 1b are complementary, keep both. 1b proves the real client
  //     path accepts real drift, but only injects the drift at the TOP level;
  //     1a is the one that reaches nested objects, where a stray `z.object`
  //     inside a loose parent still renders closed (verified 2026-08-02: a
  //     strict `chain_integrity.breaks[]` item passes 1b and fails 1a).
  const validate = new AjvJsonSchemaValidator().getValidator(json as never);

  const maximalResult = validate(entry.maximal);
  if (maximalResult.valid) {
    ok(`${entry.tool}: maximal response passes the client's own validator`);
  } else {
    fail(
      `${entry.tool}: the client's validator REJECTS a maximal response ` +
      `(${maximalResult.errorMessage}). Every call to this tool would surface as a ` +
      `protocol error with the work already done.`,
    );
  }

  const driftedResult = validate({ ...entry.maximal, a_field_added_next_session: 'x' });
  if (driftedResult.valid) {
    ok(`${entry.tool}: a NEW result field the schema has never seen still passes`);
  } else {
    fail(
      `${entry.tool}: adding one field to the result makes the client's validator ` +
      `reject the whole response (${driftedResult.errorMessage}). This is the 2026-07-16 ` +
      `failure mode, re-armed.`,
    );
  }

  // 1c. Premise: the validator must be enforcing SOMETHING, else the two
  //     checks above pass vacuously (e.g. against an empty schema).
  const nonsense = validate('not an object at all');
  if (!nonsense.valid) {
    ok(`${entry.tool}: the validator still rejects a non-object (checks are not vacuous)`);
  } else {
    fail(`${entry.tool}: the validator accepts a bare string. It is validating nothing; the checks above prove nothing.`);
  }
}

console.log('');
console.log('outputSchema freshness (the declared shape still describes the result type):');

for (const entry of DECLARED) {
  if (!entry.lockstepShape) {
    ok(`${entry.tool}: no named result type, lockstep not applicable (safety-checked only)`);
    continue;
  }
  const strictSchema = z.object(entry.lockstepShape).strict();

  const parsed = strictSchema.safeParse(entry.maximal);
  if (parsed.success) {
    ok(`${entry.tool}: maximal typed result strict-parses against the declared shape`);
  } else {
    fail(
      `${entry.tool}: the maximal typed result has a field the declared shape does not ` +
      `name, so the schema now under-describes what the tool returns: ${parsed.error.message}. ` +
      `Add the field to the shape. (Since 2026-08-02 this no longer breaks the tool at ` +
      `runtime, the schema is permissive; it makes the schema wrong.)`,
    );
  }

  // Prove the strictness premise: an unknown key must be rejected here, else
  // this half of the gate would pass vacuously.
  const negative = strictSchema.safeParse({ ...entry.maximal, not_a_real_field: 1 });
  if (!negative.success) {
    ok(`${entry.tool}: strict parse rejects an unknown field (lockstep premise holds)`);
  } else {
    fail(`${entry.tool}: strict parse ACCEPTED an unknown field, the lockstep is vacuous; fix the schema mode.`);
  }
}

// ── Completeness: nothing declares an outputSchema off this list ─────
//
// The registry above is hand-written, so it can go stale the moment someone
// adds a sixth outputSchema-declaring tool, and a stale registry means a new
// tool ships with the strictness nobody checked. Scan the source for the
// declaration site and assert set equality, the same shape as
// verify-recipe-tables' FAMILY_ID_FLOOR <-> FAMILY_TABLES assertion: a new
// declaration cannot exist without being walked.

console.log('');
console.log('outputSchema registry completeness:');

const REPO_ROOT = process.cwd();

function sourceFilesUnder(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      sourceFilesUnder(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

const packagesDir = path.join(REPO_ROOT, 'packages');
const sourceFiles: string[] = [];
for (const pkg of readdirSync(packagesDir)) {
  const srcDir = path.join(packagesDir, pkg, 'src');
  try {
    if (!statSync(srcDir).isDirectory()) continue;
  } catch {
    continue;
  }
  sourceFilesUnder(srcDir, sourceFiles);
}

const declaringFiles = new Set<string>();
for (const file of sourceFiles) {
  const text = readFileSync(file, 'utf8');
  // The declaration site: `outputSchema:` as an object key. Excludes prose
  // mentions in comments, which never carry the colon in column position.
  if (/^\s*outputSchema:/m.test(text)) {
    declaringFiles.add(path.relative(REPO_ROOT, file).split(path.sep).join('/'));
  }
}

const gatedFiles = new Set(DECLARED.map((d) => d.file));
const ungated = [...declaringFiles].filter((f) => !gatedFiles.has(f)).sort();
const phantom = [...gatedFiles].filter((f) => !declaringFiles.has(f)).sort();

if (ungated.length === 0 && phantom.length === 0) {
  ok(`every file declaring an outputSchema is in the registry (${declaringFiles.size} file(s), ${DECLARED.length} tool(s))`);
} else {
  if (ungated.length > 0) {
    fail(
      `${ungated.length} file(s) declare an outputSchema but are not gated here: ${ungated.join(', ')}. ` +
      `Add an entry to DECLARED (schema + a maximal response, plus a lockstepShape if the tool ` +
      `has a named result type), or the new schema ships with nobody checking it is permissive.`,
    );
  }
  if (phantom.length > 0) {
    fail(
      `${phantom.length} registry entr(y/ies) point at a file that no longer declares an ` +
      `outputSchema: ${phantom.join(', ')}. Remove the stale entry.`,
    );
  }
}

console.log('');
if (failures > 0) {
  console.error(`verify-apply-output-schema: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`verify-apply-output-schema: all checks passed (${DECLARED.length} declared output schemas)`);
