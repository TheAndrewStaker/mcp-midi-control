// verify-apply-output-schema.ts
//
// Lockstep gate between `ApplyResult` (the type the device writers
// return) and `apply_preset`'s declared MCP outputSchema.
//
// Why this exists (2026-07-16 incident): apply_preset is an
// outputSchema-declared tool, and clients advertise/validate it with
// additionalProperties:false. When BK-103b added `auto_applied` to
// ApplyResult without adding it to the schema, EVERY apply_preset
// response was rejected client-side by Claude Desktop with a generic
// "Tool execution failed" AFTER the wire writes had landed: a
// false-negative failure invisible to server logs, launch-verify, and
// every offline suite. A full hardware bench day chased it as host
// flakiness.
//
// The gate: a maximal `Required<ApplyResult>`-typed literal (every
// field populated; the root typecheck enforces it tracks the type) must
// STRICT-parse against the exported schema shape. A new ApplyResult
// field without a schema entry fails here, at preflight, instead of at
// the user's rig.
//
// Run:  npx tsx scripts/verify-apply-output-schema.ts

import * as z from 'zod/v4';

import { APPLY_PRESET_OUTPUT_SHAPE } from '@mcp-midi-control/core/protocol-generic/tools/preset.js';
import type { ApplyResult, PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';

let failures = 0;
const ok = (msg: string) => console.log(`  OK   ${msg}`);
const fail = (msg: string) => { console.error(`  FAIL ${msg}`); failures++; };

// Every ApplyResult field populated. `Required<>` means: if ApplyResult
// gains a field, this literal stops compiling (root tsconfig typecheck)
// until it is added here, and then the strict parse below fails until
// the schema learns it too. `device` rides on top because the
// dispatcher adds it to the tool payload after the writer returns.
const maximal: Required<ApplyResult> & { device: string } = {
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

console.log('apply_preset outputSchema lockstep:');

const strictSchema = z.object(APPLY_PRESET_OUTPUT_SHAPE).strict();

const parsed = strictSchema.safeParse(maximal);
if (parsed.success) {
  ok('maximal Required<ApplyResult> strict-parses against the declared outputSchema');
} else {
  fail(
    'maximal ApplyResult REJECTED by the outputSchema - a result field is missing from ' +
    `APPLY_PRESET_OUTPUT_SHAPE and will hard-fail apply_preset in Claude Desktop: ${parsed.error.message}`,
  );
}

// Prove the strictness premise: an unknown key must be rejected, else
// this gate would pass vacuously.
const negative = strictSchema.safeParse({ ...maximal, not_a_real_field: 1 });
if (!negative.success) {
  ok('strict parse rejects an unknown field (gate premise holds)');
} else {
  fail('strict parse ACCEPTED an unknown field - the gate is vacuous, fix the schema mode');
}

console.log('');
if (failures > 0) {
  console.error(`verify-apply-output-schema: ${failures} failure(s)`);
  process.exit(1);
}
console.log('verify-apply-output-schema: all checks passed');
