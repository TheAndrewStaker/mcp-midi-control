#!/usr/bin/env bash
# Axe-Fx II device-label calibration pipeline (see ii-label-fit.ts).
# The fitter must judge the SHIPPED decode, so the generated table is emptied
# and the codec rebuilt before fitting, then regenerated and rebuilt.
set -euo pipefail
cd "$(dirname "$0")/../.."
CORPUS="${1:-samples/captured/ii-label-sweep.jsonl}"
echo '{"numeric":[],"enums":[]}' > samples/captured/empty-proposals.json
npx tsx scripts/gen-ii-device-label-calibration.ts samples/captured/empty-proposals.json
(cd packages/fractal-midi && npx tsc -p tsconfig.json)
npx tsx scripts/_research/ii-label-score.ts "$CORPUS" --json samples/captured/ii-score-before.json | tail -2
npx tsx scripts/_research/ii-label-fit.ts "$CORPUS" > samples/captured/ii-label-fit.log
grep -E "^(numeric|enum) params|reliability" samples/captured/ii-label-fit.log
npx tsx scripts/gen-ii-device-label-calibration.ts
(cd packages/fractal-midi && npx tsc -p tsconfig.json)
npx tsx scripts/_research/ii-label-score.ts "$CORPUS" --json samples/captured/ii-score-after.json | tail -2
