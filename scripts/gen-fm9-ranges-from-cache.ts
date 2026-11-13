/**
 * Generate `packages/fractal-midi/src/gen3/fm9/ranges.generated.ts` from the
 * FM9-Edit effectDefinitions cache walk JSON.
 *
 * Thin wrapper: the actual pipeline is the generalized gen-3 ranges engine in
 * `scripts/gen-gen3-ranges-from-cache.ts` (one engine, driven per device for
 * fm9 / fm3 / iii). This entry point is kept so the committed FM9 banner's
 * regenerate instructions stay true, and its output is asserted byte-identical
 * to the pre-generalization generator's.
 *
 * Pipeline (two steps, both offline):
 *   1. npx tsx scripts/_research/parse-effectdefinitions-cache.ts \
 *        samples/captured/fm9-community-2026-07-18/effectDefinitions_12_12p0.cache --verify
 *   2. npx tsx scripts/gen-fm9-ranges-from-cache.ts \
 *        [samples/captured/fm9-community-2026-07-18/effectDefinitions_12_12p0.walk.json]
 *
 * Cache grammar: docs/_private/CACHE-FORMAT-SOLVED-2026-06-09.md and
 * packages/fractal-midi/docs/research/primitives/editor-cache-section-record-grammar.md.
 * Gate: scripts/verify-fm9-ranges.ts.
 */
import { runGen3Ranges, GEN3_RANGES_DEVICES } from './gen-gen3-ranges-from-cache.js';

runGen3Ranges(GEN3_RANGES_DEVICES['fm9'], process.argv[2]);
