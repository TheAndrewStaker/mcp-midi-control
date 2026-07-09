/**
 * Goldens for Axe-Fx II `findCompatibleTypes` (BUG-9 full).
 *
 * The II applicability table carries PRIMARY-type gates for only two blocks
 * (compressor / COMP_TYPE, multidelay / DELAY_MODEL); everything else is
 * always-on or sub-mode-gated. So these goldens assert two behaviors:
 *  - real narrowing for the two gated blocks (a param that only exists on a
 *    subset of types returns just that subset, applicability_known: true);
 *  - honest full-roster + applicability_known: false for ungated blocks
 *    (amp, reverb) and total_types: 0 for blocks with no type enum (mixer).
 * Structural assertions (length === total_types for unfiltered) keep the
 * goldens robust to catalog growth, with a few membership anchors that prove
 * the filtering is genuinely reading the gate data.
 */
import { findCompatibleTypes } from '../../../src/gen2/axe-fx-ii/applicability.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`applicability: ${msg}`);
}

export function runAxeFxIIApplicabilityTests(): void {
  // ── multidelay: DELAY_MODEL gates real narrowing ──
  const diff = findCompatibleTypes('multidelay', ['diffusion']);
  assert(diff.applicability_known === true, `multidelay.diffusion should be known-applicable, got ${diff.applicability_known}`);
  assert(diff.total_types === 10, `multidelay total_types expected 10, got ${diff.total_types}`);
  assert(diff.compatible_types.length < diff.total_types, 'multidelay.diffusion must narrow below the full roster');
  assert(diff.compatible_types.includes('PLEX DELAY'), `diffusion should be exposed on PLEX DELAY, got ${JSON.stringify(diff.compatible_types)}`);
  assert(!diff.compatible_types.includes('QUAD-TAP'), 'diffusion must NOT be exposed on QUAD-TAP');

  const t1 = findCompatibleTypes('multidelay', ['time_1']);
  assert(t1.applicability_known === true, 'multidelay.time_1 should be known-applicable');
  assert(t1.compatible_types.length >= diff.compatible_types.length, 'time_1 is exposed on at least as many types as diffusion');

  // Intersection narrows to a subset of the tighter param.
  const both = findCompatibleTypes('multidelay', ['diffusion', 'time_1']);
  assert(both.compatible_types.length <= diff.compatible_types.length, 'intersecting two params must not widen the set');

  // ── compressor: COMP_TYPE gates ──
  const ratio = findCompatibleTypes('compressor', ['ratio']);
  assert(ratio.applicability_known === true, 'compressor.ratio should be known-applicable');
  assert(ratio.compatible_types.length >= 1 && ratio.compatible_types.length < ratio.total_types, 'compressor.ratio must narrow the type roster');
  assert(ratio.compatible_types.includes('STUDIO COMP'), `compressor.ratio should be exposed on STUDIO COMP, got ${JSON.stringify(ratio.compatible_types)}`);

  // ── ungated blocks: honest full roster, applicability_known: false ──
  for (const block of ['amp', 'reverb', 'chorus', 'drive']) {
    const r = findCompatibleTypes(block, ['level']);
    assert(r.applicability_known === false, `${block}.level has no primary gates -> applicability_known must be false`);
    assert(r.total_types > 0, `${block} should expose a non-empty type roster`);
    assert(r.compatible_types.length === r.total_types, `${block} unfiltered result must return the full roster (len ${r.compatible_types.length} vs total ${r.total_types})`);
  }

  // ── block with no primary type enum ──
  const mixer = findCompatibleTypes('mixer', ['level']);
  assert(mixer.total_types === 0, `mixer has no primary type enum -> total_types 0, got ${mixer.total_types}`);
  assert(mixer.compatible_types.length === 0 && mixer.applicability_known === false, 'mixer must return empty + unknown');
}

export const AXEFX2_APPLICABILITY_CASE_COUNT = 6;
