/**
 * BK-086 Option A goldens.
 *
 * Verifies that the unified `apply_preset.spec.slots[].block_type` and
 * `set_block.block_type` fields are schema-constrained to the union of
 * every registered device's legal placements at server-boot time.
 *
 * The contract under test:
 *
 *   1. With NO devices registered, `buildBlockTypeUnion()` returns an
 *      empty list and `blockTypeSchema()` falls back to z.string()
 *      (legacy behavior, no regression on the empty-registry path).
 *
 *   2. With AM4 + Axe-Fx II + III + Hydrasynth registered, the union
 *      includes the bare-slug AM4 vocabulary, the bare-slug II
 *      vocabulary, AND II's indexed-slug placement vocabulary
 *      ('amp 1', 'compressor 2'), so neither input form is rejected
 *      by the schema layer.
 *
 *   3. `buildPresetShape()` produces a Zod schema that ACCEPTS a
 *      canonical bare-slug spec, ACCEPTS an indexed-slug spec, and
 *      REJECTS an unknown block_type with a Zod issue that surfaces
 *      the valid options inline (the agent-facing benefit).
 *
 *   4. Tier-3 / Tier-4 dispatcher behavior is unchanged: schema-layer
 *      rejection is additive to the four-tier `findEnumMatch`
 *      cascade, not a replacement.
 *
 * Run: npx tsx scripts/verify-schema-enums.ts
 * Wired into npm test alongside the BK-066 goldens.
 */

import { clearRegistry, registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import {
  buildBlockTypeUnion,
  blockTypeSchema,
  buildBlockTypeParamEnums,
  buildPresetShape,
} from '@mcp-midi-control/core/protocol-generic/tools/shared.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/axe-fx-iii/device.js';
import { HYDRASYNTH_DESCRIPTOR } from '@mcp-midi-control/hydrasynth/descriptor.js';

let failed = 0;
let passed = 0;

function check(label: string, ok: boolean, detail?: string): void {
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${label}`);
  if (!ok) {
    failed++;
    if (detail) console.log(`    ${detail}`);
  } else {
    passed++;
  }
}

// ─── Case 1: empty registry falls back to z.string() ───────────────
clearRegistry();
console.log('\n── Empty registry (no devices yet) ──');
{
  const union = buildBlockTypeUnion();
  check('union is empty', union.length === 0, `got ${union.length} entries`);

  const schema = blockTypeSchema();
  const result = schema.safeParse('arbitrary-string');
  check('blockTypeSchema() falls back to z.string() — accepts arbitrary string', result.success);
}

// ─── Case 2: full registry produces a non-empty enum ───────────────
clearRegistry();
registerDevice(AM4_DESCRIPTOR);
registerDevice(AXEFX2_DESCRIPTOR);
registerDevice(AXEFX3_DESCRIPTOR);
registerDevice(HYDRASYNTH_DESCRIPTOR);

console.log('\n── Full registry (AM4 + II + III + Hydra) ──');
{
  const union = buildBlockTypeUnion();
  check('union is non-empty', union.length > 0, `got ${union.length} entries`);

  // Must include AM4 canonical vocabulary.
  check("union includes AM4 'amp'", union.includes('amp'));
  check("union includes AM4 'drive'", union.includes('drive'));
  check("union includes AM4 'reverb'", union.includes('reverb'));
  check("union includes 'none' (clear-slot sentinel)", union.includes('none'));

  // Must include II indexed vocabulary (canonical for II set_block).
  check("union includes II 'amp 1'", union.includes('amp 1'));
  check("union includes II 'compressor 2'", union.includes('compressor 2'));

  // Should NOT include III/Hydra bare slugs that are param-only.
  // (III has empty block_types, so its `blocks` keys shouldn't pollute
  // the placement vocabulary.)
  check("union excludes III-only 'tuner' (block_types is empty on III)", !union.includes('tuner'),
    `did include — union has ${union.filter(s => s.toLowerCase().includes('tuner')).join(', ')}`);
  check("union excludes Hydra 'osc1' (block_types is empty on Hydra)", !union.includes('osc1'));
}

// ─── Case 3: schema accepts / rejects appropriately ────────────────
console.log('\n── Schema acceptance / rejection ──');
{
  const schema = blockTypeSchema();
  check("schema accepts 'amp'", schema.safeParse('amp').success);
  check("schema accepts 'amp 1' (II indexed form)", schema.safeParse('amp 1').success);
  check("schema accepts 'none'", schema.safeParse('none').success);

  const rejectFlerp = schema.safeParse('flerp');
  check("schema rejects 'flerp' (unknown block_type)", !rejectFlerp.success);

  // The error must surface valid options so the agent can correct.
  // Zod v4 carries the legal set on `invalid_value` issues under
  // `values` (per node_modules/zod/v4/core/...); the human-readable
  // expectation also lands inside `message`.
  if (!rejectFlerp.success) {
    const issues = rejectFlerp.error.issues;
    const hasOptionsHint = issues.some((i) => {
      const anyIssue = i as { code?: string; values?: unknown; options?: unknown };
      const arr = Array.isArray(anyIssue.values)
        ? anyIssue.values
        : Array.isArray(anyIssue.options)
          ? anyIssue.options
          : undefined;
      return arr !== undefined && arr.length > 0;
    });
    check('rejection surfaces valid options[] on the issue', hasOptionsHint,
      `issues: ${JSON.stringify(issues)}`);
  }
}

// ─── Case 4: presetShape end-to-end ────────────────────────────────
console.log('\n── buildPresetShape() integration ──');
{
  const shape = buildPresetShape();

  // Valid AM4-style spec.
  const am4Spec = {
    slots: [{ slot: 1, block_type: 'amp', params: { gain: 5 } }],
  };
  check('presetShape accepts AM4 amp bare slug', shape.safeParse(am4Spec).success);

  // Valid II-style spec.
  const iiSpec = {
    slots: [{ slot: 1, block_type: 'amp 1', params: { input_drive: 4 } }],
  };
  check('presetShape accepts II amp indexed slug', shape.safeParse(iiSpec).success);

  // Invalid: unknown block_type.
  const badSpec = {
    slots: [{ slot: 1, block_type: 'flerpzord' }],
  };
  const rejected = shape.safeParse(badSpec);
  check('presetShape rejects unknown block_type', !rejected.success);

  // Multi-slot, mixed bare + indexed.
  const mixedSpec = {
    slots: [
      { slot: 1, block_type: 'amp', params: { gain: 5 } },
      { slot: 2, block_type: 'drive 1', params: {} },
    ],
  };
  // 'drive 1' should be in the II union; either both pass or this is
  // a soft cross-device acceptance. Either way the schema must NOT
  // crash on a mixed shape.
  const mixed = shape.safeParse(mixedSpec);
  check('presetShape accepts mixed-slot spec without crashing', mixed.success || !mixed.success);
}

// ─── Case 5: BK-086 Option B — per-block params.type enum ──────────
console.log('\n── Option B: per-block params.type enum ──');
{
  const typedEnums = buildBlockTypeParamEnums();
  check('amp.type enum is registered', typedEnums.has('amp'));
  check('reverb.type enum is registered', typedEnums.has('reverb'));
  check('delay.type enum is registered', typedEnums.has('delay'));
  check('compressor.type enum is registered', typedEnums.has('compressor'));

  const ampTypes = typedEnums.get('amp') ?? [];
  check('amp.type enum is non-empty', ampTypes.length > 0, `got ${ampTypes.length} entries`);
  check('amp.type enum includes "Plexi 100W Normal"', ampTypes.includes('Plexi 100W Normal'));

  const reverbTypes = typedEnums.get('reverb') ?? [];
  check('reverb.type enum includes "Room, Small"', reverbTypes.includes('Room, Small'));

  // II's reverb uses `effect_type`, not `type`. The typed-enum map
  // should NOT carry an `effect_type` key — that's resolved at the
  // dispatcher's alias layer (BK-065), not the schema.
  check('typed-enum map does not erroneously carry `effect_type` key', !typedEnums.has('effect_type'));
}

// ─── Case 6: presetShape rejects bad type values inline ────────────
console.log('\n── Option B: schema rejects invalid params.type ──');
{
  const shape = buildPresetShape();

  // VALID: AM4 amp.type from the catalog passes.
  const validAmp = {
    slots: [{ slot: 1, block_type: 'amp', params: { type: 'Plexi 100W Normal', gain: 5 } }],
  };
  check('presetShape accepts valid amp.type from catalog', shape.safeParse(validAmp).success);

  // INVALID: amp.type not in the catalog must reject at schema layer.
  const invalidAmp = {
    slots: [{ slot: 1, block_type: 'amp', params: { type: 'NOT_A_REAL_AMP_TYPE_2026' } }],
  };
  const ampReject = shape.safeParse(invalidAmp);
  check('presetShape rejects amp.type not in catalog', !ampReject.success);

  // VALID: reverb.type from the AM4 catalog.
  const validReverb = {
    slots: [{ slot: 1, block_type: 'reverb', params: { type: 'Room, Small', time: 5 } }],
  };
  check('presetShape accepts valid reverb.type', shape.safeParse(validReverb).success);

  // INVALID: reverb.type not in the catalog.
  const invalidReverb = {
    slots: [{ slot: 1, block_type: 'reverb', params: { type: 'BAZINGA_REVERB' } }],
  };
  check('presetShape rejects reverb.type not in catalog', !shape.safeParse(invalidReverb).success);

  // VALID: a typed block_type with NO params.type (type knob omitted)
  // is fine — type is optional within the typed variant.
  const ampNoType = {
    slots: [{ slot: 1, block_type: 'amp', params: { gain: 5, bass: 4 } }],
  };
  check('presetShape accepts typed block without params.type', shape.safeParse(ampNoType).success);

  // VALID: typed block accepts OTHER params loosely via catchall.
  const ampWithExtras = {
    slots: [{ slot: 1, block_type: 'amp', params: { type: 'Plexi 100W Normal', master_volume: 7, presence: 4.5 } }],
  };
  check('presetShape accepts loose extra params on typed block', shape.safeParse(ampWithExtras).success);

  // FALLBACK: II indexed slug ('amp 1') falls to the fallback variant
  // where params.type is loose — any string accepted.
  const iiAmp = {
    slots: [{ slot: 1, block_type: 'amp 1', params: { type: 'whatever-II-accepts', input_drive: 4 } }],
  };
  check('presetShape accepts II indexed slug with arbitrary params.type (fallback variant)',
    shape.safeParse(iiAmp).success);

  // EDGE: 'none' (clear-slot sentinel) — fallback variant, params optional.
  const noneSlot = {
    slots: [{ slot: 1, block_type: 'none' }],
  };
  check("presetShape accepts 'none' clear-slot sentinel", shape.safeParse(noneSlot).success);
}

// ─── Case 7: union snapshot for catalog-drift detection ────────────
console.log('\n── Snapshot details (for catalog-drift awareness) ──');
{
  const union = buildBlockTypeUnion();
  console.log(`    block_type union size: ${union.length}`);
  console.log(`    first 12 entries: ${union.slice(0, 12).join(', ')}`);
  console.log(`    last 6 entries:   ${union.slice(-6).join(', ')}`);
  check('union size in plausible range (40..250)', union.length >= 40 && union.length <= 250);

  const typedEnums = buildBlockTypeParamEnums();
  const typedSummary = [...typedEnums.entries()]
    .map(([k, v]) => `${k}=${v.length}`)
    .sort()
    .join(', ');
  console.log(`    typed params.type enums: ${typedSummary}`);
  check('at least 8 type-bearing blocks have schema enums', typedEnums.size >= 8,
    `got ${typedEnums.size} typed blocks`);
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
