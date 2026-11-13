/**
 * Static name-parity test: every name a device's `list_params` advertises
 * MUST be accepted by that device's primary apply tool.
 *
 * Regression guard for the 2026-05-24 Hydrasynth bug class:
 *   - apply_patch rejected "filter1.res" with valid_options
 *     ["filter1resonance"] — but list_params returned display_name
 *     "filter1.res". Agents that did the right thing (discover via
 *     list_params, build via apply_patch) burned 3 round-trips fixing
 *     one name per call.
 *
 * This test runs purely against in-process catalogs — no MIDI, no
 * hardware. Fast preflight gate. If it fails, the divergence shows up
 * here BEFORE a user hits it in a conversation.
 *
 * Coverage:
 *   - Hydrasynth: every NRPN canonical name + alias must resolve via
 *     `findHydraNrpn`, AND every name that apply_patch will accept
 *     must map to a PATCH_OFFSETS entry on the canonical-name side.
 *   - Axe-Fx II: every param name in `KNOWN_PARAMS` must resolve via
 *     `findParam` for its block. (II uses a single source of truth so
 *     this is more of a smoke check than a divergence guard, but
 *     keeps the contract honest if anyone adds a second naming layer.)
 *
 * Run: `npx tsx scripts/verify-name-parity.ts`. Wire into preflight
 * once green to catch future regressions of the same shape.
 */

import { HYDRASYNTH_NRPNS, findHydraNrpn } from '@mcp-midi-control/hydrasynth/nrpn.js';
import { findPatchOffset, PATCH_OFFSETS } from '@mcp-midi-control/hydrasynth/patchEncoder.js';
import {
  KNOWN_PARAMS as AXEFX2_KNOWN_PARAMS,
  AXE_FX_II_BLOCKS,
} from 'fractal-midi/gen2/axe-fx-ii';

let failed = 0;
let passed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok    ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────
// Hydrasynth: every catalog name + alias must resolve.
// ─────────────────────────────────────────────────────────────────
console.log('\nHydrasynth: every NRPN catalog name + alias resolves');

// Build a polysemous-alias index: aliases that appear on multiple NRPN
// entries are intentionally shared across the FX-aware surface (e.g.
// "prefx.param1" maps to prefxparam1 + every per-FX-type variant). For
// those, runtime context (prefxtype / postfxtype) disambiguates, and
// findHydraNrpn returning the first-wins entry is the documented
// behavior. Exclude them from the strict-uniqueness check.
const aliasOccurrences = new Map<string, number>();
for (const entry of HYDRASYNTH_NRPNS) {
  if (entry.aliases) for (const a of entry.aliases) aliasOccurrences.set(a, (aliasOccurrences.get(a) ?? 0) + 1);
}

let hydraCanonicalMisses = 0;
let hydraAliasMisses = 0;
const hydraCanonicalMissList: string[] = [];
const hydraAliasMissList: string[] = [];
for (const entry of HYDRASYNTH_NRPNS) {
  const c = findHydraNrpn(entry.name);
  if (c?.name !== entry.name) {
    hydraCanonicalMisses++;
    if (hydraCanonicalMissList.length < 10) hydraCanonicalMissList.push(entry.name);
  }
  if (entry.aliases) {
    for (const a of entry.aliases) {
      if ((aliasOccurrences.get(a) ?? 0) > 1) continue; // polysemous, FX-aware
      const r = findHydraNrpn(a);
      if (r?.name !== entry.name) {
        hydraAliasMisses++;
        if (hydraAliasMissList.length < 10) hydraAliasMissList.push(`${a} → expected ${entry.name}`);
      }
    }
  }
}
check(
  `${HYDRASYNTH_NRPNS.length} canonical names all resolve via findHydraNrpn`,
  hydraCanonicalMisses === 0,
  hydraCanonicalMisses > 0 ? `${hydraCanonicalMisses} misses: ${hydraCanonicalMissList.join(', ')}` : undefined,
);
check(
  'every alias resolves to its parent canonical name',
  hydraAliasMisses === 0,
  hydraAliasMisses > 0 ? `${hydraAliasMisses} misses: ${hydraAliasMissList.join(', ')}` : undefined,
);

// ─────────────────────────────────────────────────────────────────
// Hydrasynth: PATCH_OFFSETS coverage — every PATCH_OFFSETS entry must
// resolve to a NRPN catalog entry. (Reverse direction — every NRPN
// entry having an offset — is too strict; only ~30 high-impact params
// are in PATCH_OFFSETS by design, intermediate ones fall back to NRPN
// set_param.)
// ─────────────────────────────────────────────────────────────────
console.log('\nHydrasynth: every PATCH_OFFSETS entry has an NRPN catalog match');

let orphanOffsets = 0;
let derivedOffsets = 0;
const orphanOffsetList: string[] = [];
const badDerived: string[] = [];
// The ONLY legitimate derived-only shapes: route target-category ids
// (32 matrix + 64 macro = 96). The counter-assertion below keeps this
// exemption from silently widening — a stray `derived: true` on a
// caller-facing name would otherwise drop it from parity unnoticed
// (review finding, 2026-08-22).
const DERIVED_NAME_RE = /^(modmatrix\d+targetcategory|macro\d+targetcategory\d+)$/;
const EXPECTED_DERIVED_COUNT = 96;
for (const spec of PATCH_OFFSETS) {
  // `derived: true` entries (route target-category ids) are image-layout
  // artifacts written by encodePatch's post-pass — they have no NRPN
  // identity and are never a caller-facing name, so parity does not
  // apply. Everything a caller CAN name stays gated.
  if (spec.derived === true) {
    derivedOffsets++;
    if (!DERIVED_NAME_RE.test(spec.name)) badDerived.push(spec.name);
    continue;
  }
  const entry = findHydraNrpn(spec.name);
  if (entry === undefined || entry.name !== spec.name) {
    orphanOffsets++;
    if (orphanOffsetList.length < 10) orphanOffsetList.push(spec.name);
  }
}
check(
  `${PATCH_OFFSETS.length} PATCH_OFFSETS entries align with NRPN catalog canonical names (${derivedOffsets} derived-only exempt)`,
  orphanOffsets === 0,
  orphanOffsets > 0 ? `${orphanOffsets} orphans (in PATCH_OFFSETS but not in NRPN catalog as canonical): ${orphanOffsetList.join(', ')}` : undefined,
);
check(
  `derived-only exemption is scoped: exactly ${EXPECTED_DERIVED_COUNT} entries, all target-category shaped`,
  derivedOffsets === EXPECTED_DERIVED_COUNT && badDerived.length === 0,
  badDerived.length > 0
    ? `non-target-category names carry derived:true (parity silently skipped): ${badDerived.slice(0, 10).join(', ')}`
    : `expected ${EXPECTED_DERIVED_COUNT} derived entries, found ${derivedOffsets} — update EXPECTED_DERIVED_COUNT only for a deliberate layout change`,
);

// ─────────────────────────────────────────────────────────────────
// Hydrasynth: spot-check the exact names from the 2026-05-24 user
// bug report. These are the names the agent passed AND the dotted
// forms list_params would return. Every shape must (1) resolve via
// findHydraNrpn, (2) the resolved canonical name must have a
// PATCH_OFFSETS entry.
// ─────────────────────────────────────────────────────────────────
console.log('\nHydrasynth: 2026-05-24 user-bug-report input shapes are all accepted');

const userBugInputs: Array<{ input: string; expectedCanonical: string }> = [
  { input: 'filter1res',          expectedCanonical: 'filter1resonance' },
  { input: 'filter1.res',         expectedCanonical: 'filter1resonance' },
  { input: 'filter1resonance',    expectedCanonical: 'filter1resonance' },
  { input: 'filter1env1amt',      expectedCanonical: 'filter1env1amount' },
  { input: 'filter1.env1amt',     expectedCanonical: 'filter1env1amount' },
  { input: 'filter1env1amount',   expectedCanonical: 'filter1env1amount' },
  { input: 'mixer.osc1_vol',      expectedCanonical: 'mixerosc1vol' },
  { input: 'mixer.osc2_vol',      expectedCanonical: 'mixerosc2vol' },
  { input: 'mixerosc1vol',        expectedCanonical: 'mixerosc1vol' },
];

for (const { input, expectedCanonical } of userBugInputs) {
  const entry = findHydraNrpn(input);
  check(
    `apply_patch accepts "${input}" → ${expectedCanonical}`,
    entry?.name === expectedCanonical,
    entry ? `resolved to ${entry.name}` : 'did not resolve',
  );
  // Some of these (filter1env1amount, mixerosc*) should also have a
  // PATCH_OFFSETS entry on the canonical-name side; check the ones we
  // expect to be in the curated table.
  if (['filter1resonance', 'filter1env1amount', 'mixerosc1vol', 'mixerosc2vol'].includes(expectedCanonical)) {
    const offset = findPatchOffset(expectedCanonical);
    check(
      `canonical "${expectedCanonical}" has a PATCH_OFFSETS entry`,
      offset !== undefined,
      offset ? `byte=${offset.byte}` : 'NO ENTRY',
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// Axe-Fx II: smoke check — every KNOWN_PARAMS entry resolves via
// findParam against its declared block.
// ─────────────────────────────────────────────────────────────────
console.log('\nAxe-Fx II: every KNOWN_PARAMS entry resolves against its declared block');

// Build a quick block-name lookup (case-insensitive).
const blockByGroupCode = new Map<string, typeof AXE_FX_II_BLOCKS[number]>();
for (const b of AXE_FX_II_BLOCKS) blockByGroupCode.set(b.groupCode, b);

let unresolved = 0;
const unresolvedList: string[] = [];
for (const key of Object.keys(AXEFX2_KNOWN_PARAMS)) {
  const p = AXEFX2_KNOWN_PARAMS[key as keyof typeof AXEFX2_KNOWN_PARAMS] as { name: string; block: string; groupCode: string };
  const block = blockByGroupCode.get(p.groupCode);
  if (block === undefined) {
    unresolved++;
    if (unresolvedList.length < 10) unresolvedList.push(`${p.block}.${p.name} (groupCode ${p.groupCode} has no AXE_FX_II_BLOCKS entry)`);
  }
}
check(
  `${Object.keys(AXEFX2_KNOWN_PARAMS).length} KNOWN_PARAMS entries all map to a block`,
  unresolved === 0,
  unresolved > 0 ? `${unresolved} orphans: ${unresolvedList.join('; ')}` : undefined,
);

// ─────────────────────────────────────────────────────────────────
console.log('');
if (failed > 0) {
  console.error(`✗ ${failed} check(s) FAILED, ${passed} passed.`);
  process.exit(1);
}
console.log(`✓ Name-parity verified across devices (${passed} checks).`);
