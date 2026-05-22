/**
 * BK-086 before/after comparison.
 *
 * Shows the schema-layer behavior change side by side using the
 * worktree's `buildPresetShape()`:
 *
 *   BEFORE: `clearRegistry()` → factory falls back to z.string() for
 *           block_type and z.record() for params, matching main's
 *           behavior. Bad input PASSES schema validation; rejection
 *           lands at the dispatcher (one tool round-trip later) with
 *           the dispatcher's error format.
 *
 *   AFTER:  registries populated → factory builds z.enum() for
 *           block_type and discriminated union with typed params.type
 *           for type-bearing blocks. Bad input REJECTS at the MCP /
 *           Zod boundary with `Invalid option:` and the full enum
 *           listed inline. The tool handler never runs.
 *
 * Run: npx tsx scripts/compare-bk086-before-after.ts
 */

import { clearRegistry, registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { buildPresetShape } from '@mcp-midi-control/core/protocol-generic/tools/shared.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/axe-fx-iii/device.js';
import { HYDRASYNTH_DESCRIPTOR } from '@mcp-midi-control/hydrasynth/descriptor.js';

function tryParse(label: string, shape: ReturnType<typeof buildPresetShape>, spec: unknown): void {
  const result = shape.safeParse(spec);
  if (result.success) {
    console.log(`  ${label}: ACCEPTED at schema layer (dispatcher will reject later)`);
  } else {
    const firstIssue = result.error.issues[0];
    const code = (firstIssue as { code?: string }).code ?? 'unknown';
    const path = firstIssue.path.join('.') || '(root)';
    const message = firstIssue.message;
    const values = (firstIssue as { values?: unknown }).values;
    const valuesPreview = Array.isArray(values)
      ? values.length > 6
        ? `${values.slice(0, 6).join(', ')}, ... (+${values.length - 6} more)`
        : values.join(', ')
      : '(none)';
    console.log(`  ${label}: REJECTED at schema layer`);
    console.log(`    code:    ${code}`);
    console.log(`    path:    ${path}`);
    console.log(`    message: ${message.slice(0, 120)}${message.length > 120 ? '…' : ''}`);
    console.log(`    valid options: ${valuesPreview}`);
  }
}

// ── Scenario A: unknown block_type ────────────────────────────────
const badBlockType = {
  slots: [{ slot: 1, block_type: 'fnord', params: { gain: 5 } }],
};

console.log('Scenario A: agent guesses an unknown block_type ("fnord")\n');
clearRegistry();
const beforeShape1 = buildPresetShape();
tryParse('BEFORE (empty registry, z.string())', beforeShape1, badBlockType);

registerDevice(AM4_DESCRIPTOR);
registerDevice(AXEFX2_DESCRIPTOR);
registerDevice(AXEFX3_DESCRIPTOR);
registerDevice(HYDRASYNTH_DESCRIPTOR);
const afterShape1 = buildPresetShape();
tryParse('AFTER  (BK-086 Option A + B)        ', afterShape1, badBlockType);

// ── Scenario B: unknown amp.type value ────────────────────────────
const badAmpType = {
  slots: [{ slot: 1, block_type: 'amp', params: { type: 'NOT_A_REAL_AMP_2026' } }],
};

console.log('\nScenario B: agent guesses an unknown amp.type ("NOT_A_REAL_AMP_2026")\n');
clearRegistry();
const beforeShape2 = buildPresetShape();
tryParse('BEFORE (empty registry, loose params)', beforeShape2, badAmpType);

registerDevice(AM4_DESCRIPTOR);
registerDevice(AXEFX2_DESCRIPTOR);
registerDevice(AXEFX3_DESCRIPTOR);
registerDevice(HYDRASYNTH_DESCRIPTOR);
const afterShape2 = buildPresetShape();
tryParse('AFTER  (BK-086 Option A + B)         ', afterShape2, badAmpType);

// ── Scenario C: ambiguous reverb.type ("Spring") — agent's typical guess ──
const ambiguousReverb = {
  slots: [{ slot: 1, block_type: 'reverb', params: { type: 'Spring' } }],
};

console.log('\nScenario C: agent guesses an ambiguous reverb.type ("Spring", multiple matches in AM4 catalog)\n');
clearRegistry();
const beforeShape3 = buildPresetShape();
tryParse('BEFORE (empty registry, loose params)', beforeShape3, ambiguousReverb);

registerDevice(AM4_DESCRIPTOR);
registerDevice(AXEFX2_DESCRIPTOR);
registerDevice(AXEFX3_DESCRIPTOR);
registerDevice(HYDRASYNTH_DESCRIPTOR);
const afterShape3 = buildPresetShape();
tryParse('AFTER  (BK-086 Option A + B)         ', afterShape3, ambiguousReverb);

// ── Scenario D: canonical input (control) ─────────────────────────
const goodInput = {
  slots: [{ slot: 1, block_type: 'amp', params: { type: 'Plexi 100W Normal', gain: 5 } }],
};

console.log('\nScenario D (control): valid AM4 amp spec passes schema\n');
const afterShape4 = buildPresetShape();
tryParse('AFTER  (BK-086 Option A + B)         ', afterShape4, goodInput);

console.log('\n──────────────────────────────────────────────────────────────────');
console.log('Interpretation:');
console.log('- BEFORE rows pass schema; rejection lands at the dispatcher (one tool');
console.log('  round-trip later, with the dispatcher\'s "did you mean…" suggestion).');
console.log('- AFTER rows reject at the MCP boundary; the Zod issue carries the');
console.log('  legal-options list inline so Claude can correct on the next turn');
console.log('  without firing the wire writer.');
console.log('- The dispatcher\'s BK-066 four-tier resolution still runs for inputs');
console.log('  that DO pass schema (case-only differences, whitespace, alias maps).');
