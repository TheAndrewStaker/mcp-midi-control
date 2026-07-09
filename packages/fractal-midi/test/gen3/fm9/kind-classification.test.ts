/**
 * FM9 kind-classification regression guard (discrete vs continuous routing DATA).
 *
 * Owns: the FM9-side data that the catalog boundary's kind-classification is
 * gated on — the editor-cache enum rows (`FM9_RANGES` kind:'enum') and the
 * roundtrip-derived discrete-ordinal overlay (`FM9_ROUNDTRIP_DISCRETE`).
 *
 * Why: the 2026-06-18 incident. ~351 FM9 enum/type selectors were routing as
 * CONTINUOUS floats instead of discrete ordinals because kind-classification
 * was only anchored on the Axe-Fx III. The fix was gated on the FM9's OWN
 * editor-cache enum data (kind:'enum' + enumCount rows in ranges.generated.ts)
 * plus the chihotta 2026-06-18 full SET→GET hardware roundtrip
 * (samples/captured/chihotta-roundtrip-2026-06-18/fm9-roundtrip.json →
 * roundtripDiscrete.generated.ts). This suite pins that data device-side so a
 * catalog/cache regen that silently drops the enum kinds — the exact shape of
 * the original bug — fails loudly HERE, not on a user's FM9.
 *
 * Expectations are DERIVED from the generated oracle files (joined against the
 * device-true FM9 catalog), not hand-listed, except for the doc-cited anchors.
 */
import {
  FM9_PARAMS,
  FM9_RANGES,
  FM9_ROUNDTRIP_DISCRETE,
} from '../../../src/gen3/fm9/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const byName = new Map(FM9_PARAMS.map((p) => [p.name, p]));
function cacheRow(name: string) {
  const p = byName.get(name);
  if (!p) return undefined;
  return FM9_RANGES[p.family]?.[p.paramId];
}

const cases: Array<() => void> = [];

// ── Roundtrip overlay: derived invariants (oracle: chihotta 2026-06-18) ────
// Every overlay key must join to a real device-true FM9 catalog param — an
// orphan key means the catalog regen and the overlay drifted apart.
for (const name of Object.keys(FM9_ROUNDTRIP_DISCRETE)) {
  cases.push(() => assert(byName.has(name), `FM9 overlay key ${name} not in FM9_PARAMS (catalog/overlay drift)`));
}
// The overlay covers exactly what the editor-cache enum path MISSED: no overlay
// key may also be a cache kind:'enum' row (precedence would mask a regen bug).
for (const name of Object.keys(FM9_ROUNDTRIP_DISCRETE)) {
  cases.push(() => {
    const row = cacheRow(name);
    assert(row === undefined || row.kind !== 'enum', `FM9 overlay key ${name} is ALSO cache kind:'enum' — overlay/cache overlap`);
  });
}
// Regenerating from the same 2026-06-18 oracle is deterministic: 34 entries.
cases.push(() =>
  assert(
    Object.keys(FM9_ROUNDTRIP_DISCRETE).length === 34,
    `FM9 overlay size ${Object.keys(FM9_ROUNDTRIP_DISCRETE).length} != 34 (regen from the 2026-06-18 oracle must reproduce exactly 34)`,
  ),
);

// ── Direction spot checks: discrete params must be discrete ────────────────
// Roundtrip-proven ordinals (values from fm9-roundtrip.json via the generator).
cases.push(() => assert(FM9_ROUNDTRIP_DISCRETE['REVERB_BASETYPE'] === 8, `FM9 REVERB_BASETYPE overlay ordinal = ${FM9_ROUNDTRIP_DISCRETE['REVERB_BASETYPE']} (want 8)`));
cases.push(() => assert(FM9_ROUNDTRIP_DISCRETE['MEGATAP_NUMTAPS'] === 64, `FM9 MEGATAP_NUMTAPS overlay ordinal = ${FM9_ROUNDTRIP_DISCRETE['MEGATAP_NUMTAPS']} (want 64)`));
// Editor-cache enum anchors (asserted at generation time, re-pinned here):
// the amp MODEL selector is a 331-way enum, FUZZ_TYPE 86, REVERB_TYPE 79.
// These are the headline class of the 2026-06-18 bug: TYPE selectors that MUST
// route discrete.
cases.push(() => {
  const row = cacheRow('DISTORT_TYPE');
  assert(row?.kind === 'enum' && row.enumCount === 331, `FM9 DISTORT_TYPE (amp model) cache row ${JSON.stringify(row)} (want enum/331)`);
});
cases.push(() => {
  const row = cacheRow('FUZZ_TYPE');
  assert(row?.kind === 'enum' && row.enumCount === 86, `FM9 FUZZ_TYPE cache row ${JSON.stringify(row)} (want enum/86)`);
});
cases.push(() => {
  const row = cacheRow('REVERB_TYPE');
  assert(row?.kind === 'enum' && row.enumCount === 79, `FM9 REVERB_TYPE cache row ${JSON.stringify(row)} (want enum/79)`);
});

// ── Direction spot checks: knobs must stay continuous ──────────────────────
// A true continuous knob is neither cache-enum nor in the roundtrip overlay.
for (const name of ['REVERB_TIME', 'REVERB_MIX', 'DISTORT_DRIVE']) {
  cases.push(() => {
    const row = cacheRow(name);
    assert(row !== undefined && row.kind === 'float', `FM9 ${name} cache row ${JSON.stringify(row)} (must stay kind:'float')`);
    assert(FM9_ROUNDTRIP_DISCRETE[name] === undefined, `FM9 ${name} must NOT be in the roundtrip-discrete overlay (continuous knob)`);
  });
}

// ── Incident-magnitude floor ────────────────────────────────────────────────
// The 2026-06-18 fix corrected ~351 params by gating on cache kind:'enum'
// rows. The joined enum class (cache enum rows that address a real FM9 catalog
// param) is 507 today; if a cache regen drops below the incident magnitude,
// the discrete class collapsed and this fails.
cases.push(() => {
  let enumJoined = 0;
  for (const p of FM9_PARAMS) {
    const row = FM9_RANGES[p.family]?.[p.paramId];
    if (row?.kind === 'enum' && (row.enumCount ?? 0) > 1) enumJoined += 1;
  }
  assert(enumJoined >= 351, `FM9 cache-enum joined param count ${enumJoined} < 351 (the 2026-06-18 corrected class collapsed)`);
});

export function runFm9KindClassificationTests(): void {
  for (const c of cases) c();
}
export const FM9_KIND_CLASSIFICATION_CASE_COUNT = cases.length;
