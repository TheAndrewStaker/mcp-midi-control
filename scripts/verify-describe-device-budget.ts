/**
 * verify-describe-device-budget.ts — a size budget on the DISCOVERY SURFACE.
 *
 * WHY THIS EXISTS. `scripts/list-tools.ts` gates all 36 tool DESCRIPTIONS at
 * 600 warn / 1000 hard chars, and preflight enforces it. Nothing gated the
 * `describe_device` RESPONSE, which is 50x that hard cap and is, by its own
 * description, the "REQUIRED first call for any device question". We were
 * budgeting the cheap artifact and ignoring the expensive one.
 *
 * THE REGRESSION THAT PROVED IT MATTERS (measured, not theorised).
 * `am4-recipe-block-stack-pickup` passed five times running at 2-3 tool calls,
 * then failed three times at 17 / 9 / 13 with the prompt byte-identical
 * throughout. In the failing traces the agent announces it will look for a
 * curated recipe, calls `describe_device`, and then never mentions recipes
 * again.
 *
 * THE MECHANISM. It is a CLIFF, not a gradient, and it belongs to the host, not
 * the model:
 *
 *   A tool result over 50,000 characters is not delivered to the model at all.
 *   The host replaces the entire result with a sidecar file path — and an
 *   MCP-only agent (Claude Desktop, and this repo's own harness, which runs
 *   `claude -p --tools ""`) has no filesystem tool with which to open it.
 *
 * `cab_polish` (2026-07-17) pushed the AM4 over that line and from that run
 * onward SEVEN AM4 regression cases were being answered from a stub — the
 * AM4's 36 KB of curated guidance and its whole recipes[] surface simply
 * stopped arriving. All 24 replaced results in the 651-trace corpus came from
 * `describe_device`.
 *
 * THE NUMBER IS MEASURED, NOT INFERRED (2026-08-02, second pass). It was
 * inferred first, and the inference was wrong by 1,200 characters in the
 * DANGEROUS direction. See HOST_DELIVERY_MAX_CHARS below for the experiment
 * and the full result; `scripts/probe-host-delivery-cliff.ts` reproduces it.
 *
 * MEASURE COMPACT. The host counts the compact serialization, and as of
 * 2026-08-02 that is the ONLY serialization we emit, so the two can no longer
 * disagree. Both facts were established from the same corpus:
 *
 *   - The host's own numbers are compact. The AM4's stub reported "50.9KB" =
 *     52,148 chars = the compact length, not the 59,365-char indented one; and
 *     the 13 token-limit errors in the corpus each state a character count
 *     matching compact(structuredContent) exactly, 13 for 13, never the
 *     indented length. Claude Code also discards our text block outright when
 *     `structuredContent` is present: not one of the 1,760 JSON results the
 *     model received across 661 traces was indented.
 *   - `asText` therefore stopped indenting. It used to emit a text copy 2-24%
 *     larger than this gate's number — axe-fx-ii measured 47,921 compact but
 *     59,165 indented, i.e. under the cliff on the metric we gate and OVER it
 *     on the metric a different host might count. Emitting one length instead
 *     of two makes this gate correct for either host behaviour rather than
 *     only for the one we measured. See `asText` in
 *     packages/core/src/protocol-generic/tools/shared.ts.
 *
 * `pretty` is still measured per row so a regression back to an indented text
 * copy shows up here as a divergence from `total` instead of silently.
 *
 * WHAT IT CHECKS, per registered device:
 *   1. HARD: model-facing (compact) size against the measured host cliff. This
 *      is the one that matters; over it, everything else is moot.
 *   2. Total size against a per-device frozen ceiling, so growth is deliberate.
 *   3. HARD: that `recipes[]` starts inside the 2 KB preview window — the only
 *      part of the payload that survives a stub.
 *   4. Advisory: the share taken by `agent_guidance`, and whether the device is
 *      withholding topics. Neither is hard; see each constant for why.
 *
 *   npx tsx scripts/verify-describe-device-budget.ts          # gate (exit 1 on hard fail)
 *   npx tsx scripts/verify-describe-device-budget.ts --report # sizes only, always exit 0
 */
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');
const REPORT_ONLY = process.argv.includes('--report');

/**
 * THE HOST CLIFF: the LARGEST compact payload that is delivered to the model
 * whole. Over it, the model receives NOTHING — no error, no warning, no
 * partial payload. This is the only check in this file that is about
 * correctness rather than hygiene.
 *
 * 50,000 IS MEASURED, TO THE CHARACTER (2026-08-02).
 * `scripts/probe-host-delivery-cliff.ts` stands up a synthetic MCP server that
 * returns a result of exactly N compact characters — same shape as `asText`,
 * with a canary token as the payload's LAST field so "delivered whole" is
 * proven rather than inferred — drives it through `claude -p` exactly as
 * `scripts/agent-regression/runner.ts` does, and reads the verdict off the
 * tool_result in the stream-json trace. Bisected to a single character:
 *
 *   50,000 → delivered whole, canary present, model echoed it   (lo AND hi)
 *   50,001 → NOT delivered                                      (lo AND hi)
 *
 * THIS REPLACED A GUESS, AND THE GUESS WAS UNSAFE. The previous value, 51,200,
 * was picked as "the only round number" inside an OBSERVATIONAL bracket
 * (largest payload ever seen delivered, smallest ever seen replaced). Both
 * endpoints were real; the number between them was not. It was 1,200 chars too
 * HIGH, so this gate would have passed any device between 50,001 and 51,199 —
 * a device delivering nothing at all — while reporting green. An observational
 * bracket bounds a value; it does not determine one. Measure the boundary.
 *
 * CHARACTERS, NOT TOKENS — verified by controlling for content density. The
 * probe's `--filler` picks the payload's entropy: `lo` repeats one character,
 * `hi` is random alphanumeric. Their true token counts differ by roughly an
 * order of magnitude, and BOTH cliff at exactly 50,000/50,001. So a character
 * budget is the correct instrument here, and this gate measures the right
 * quantity.
 *
 * That holds even though the host's own error message says "tokens", because
 * there are in fact TWO limits and neither one tokenizes anything:
 *
 *   1. A 50,000-CHARACTER output limit. Over it, the result is persisted to a
 *      file and replaced by a ~2 KB preview. Not configurable.
 *   2. MAX_MCP_OUTPUT_TOKENS (default 25,000), evaluated against an ESTIMATE of
 *      floor(chars / 2) — never against real tokenization. Over it, the result
 *      is replaced by a bare error with NO PREVIEW AT ALL.
 *
 * Confirmed by moving it: at the default, 50,001 → preview-stub while 50,002 →
 * bare error (floor(50002/2) = 25,001 > 25,000). Re-run with
 * MAX_MCP_OUTPUT_TOKENS=30000 and 50,002 / 51,199 / 60,001 ALL become
 * preview-stubs, i.e. limit 2 moved to floor(chars/2) > 30,000 exactly as
 * predicted while limit 1 stayed at 50,000. Both reduce to a character rule, so
 * raising MAX_MCP_OUTPUT_TOKENS does NOT buy a device more room: 50,000 is the
 * binding constraint either way.
 *
 * The server keeps itself under this on its own: `describeDevice` withholds
 * guidance topics (largest first, naming them, with a one-call fetch path) at
 * DESCRIBE_DEVICE_BUDGET_CHARS = 50,000, measured over the WHOLE assembled
 * response with the same `JSON.stringify().length` the host counts. That is
 * exactly the last deliverable size — correct, with zero margin. So a failure
 * here means a device blew through even that: its non-guidance surfaces alone
 * are now over budget and there was nothing left to evict.
 */
const HOST_DELIVERY_MAX_CHARS = 50_000;

/**
 * PER-DEVICE CEILINGS, in MODEL-FACING (compact) characters, frozen at what
 * each device measured on 2026-08-02 after the guidance budget landed.
 *
 * This is the same instrument `verify-display-first-fractal.ts` uses for its
 * parity-pending debt, and for the same reason: a single global budget either
 * lands red (and gets ignored) or gets set so loose it permits exactly the
 * growth that caused the regression.
 *
 * So each device is frozen where it stands. ANY growth fails, immediately, on
 * the device that grew. RAISING one requires a recorded reason — and the fix is
 * almost always to move a surface out of the default path, not to widen the
 * door.
 *
 * NOTE the device carrying real debt:
 *
 *   am4 48.6 KB — the largest device, and the one with the least room. Against
 *     the MEASURED cliff its margin is ~1,400 characters, not the ~2,600 this
 *     file claimed while the cliff was still a guess. It withholds nothing, so
 *     that margin is real; it is also about two paragraphs of prose wide.
 *
 * AND the one that was, until 2026-08-02, and how it was paid down — because
 * the lever generalizes and the wrong diagnosis was recorded here first.
 *
 *   hydrasynth was 49,814 — 186 chars under the measured cliff — with ALL 13 guidance topics
 *     withheld and nothing left to shed. This file previously blamed "36 patch
 *     archetypes that still ship their FULL params inline". That was wrong, and
 *     measurably so: `params` was `{}` on every archetype and totalled 432
 *     chars across all 36. The bulk was PROSE. `source_notes` — the citation
 *     provenance — ran 687 chars per recipe, 24,737 total, 53% of recipes[] and
 *     50% of the entire response, to answer a question ("where do these values
 *     come from?") that cannot be asked until after a recipe is chosen. Serving
 *     it from `describe_device({port, recipe:"<id>"})` instead of inline took
 *     the device to 41,984 with every guidance topic delivered.
 *
 * THE GENERAL LESSON, worth more than the fix: when a discovery surface is over
 * budget, ask of each FIELD whether it is read at MATCH time or after. Cutting
 * capability is the last resort and usually the wrong one; cutting post-choice
 * reference material out of a per-item loop costs nothing and pays 36x. Measure
 * per-field before deciding what to cut — the field everyone assumed was the
 * problem here was 2% of it.
 */
const DEVICE_CEILINGS: Readonly<Record<string, number>> = {
  // RECORDED REASON for the RISE from 41_900 (2026-08-02, second pass): this
  // device did not grow a surface — it stopped withholding one. The Fractal
  // block-stack summary shed its post-choice fields (see `axe-fx-ii` below),
  // which took the AM4's recipes[] down 3,562 chars, and `fitGuidanceToBudget`
  // immediately spent the room re-admitting `loudness` (~10.3 KB), the single
  // topic it had been holding back. Net +6,718, withheld 1 -> 0.
  //
  // READ THIS BEFORE TRYING TO "RECOVER MARGIN" ON A DEVICE THAT WITHHOLDS.
  // Guidance rationing is greedy against DESCRIBE_DEVICE_BUDGET_CHARS, so on a
  // withholding device a byte saved anywhere else is not banked, it is
  // re-spent on the largest topic that now fits. The AM4 went from 9,319 chars
  // under the host cliff to ~1,400 while getting strictly more content. That is
  // the policy working as written, not a defect, and the device is still
  // structurally safe (its NON-guidance surfaces are ~12 KB, and the ration
  // loop cannot emit more than 50,000 total). But if the intent is headroom
  // rather than more prose, the lever is the server budget or the topic, not
  // this table.
  am4: 48_700,

  // RECORDED REASON for the drop from 48_000 (2026-08-02, second pass): the
  // block_stack summary dropped the three fields an agent only reads AFTER it
  // has chosen a recipe — `target_blocks` (-2,485; the block roster is already
  // in `description` on 14 of 14, and the slot refs it also carried are what
  // `describe_device({port, recipe}).slots` is for), `source_notes` (-1,968,
  // the same field the Hydrasynth shed), and `params` (-182, `{}` on every
  // entry). Net -4,621, and unlike the AM4 this device withholds nothing, so
  // the saving is BANKED: the II now sits ~7,400 chars under the measured cliff.
  'axe-fx-ii': 43_400,

  // Dropped from 42_100 by the -432 of `params:{}` across 36 archetypes, the
  // last of the empty-dict debt the 2026-08-02 first pass measured and left.
  // The earlier drop from 49_900 stands: `source_notes` left the patch-
  // archetype summary for the `recipe` detail path (-24,737) and the 13
  // withheld guidance topics came back inline (+17,649). The thin headroom is
  // deliberate — this device's margin is what keeps its guidance delivered, so
  // a 37th archetype (~700 chars) must be a decision, not a drift.
  hydrasynth: 41_600,
  ax8: 31_400,

  // The three gen-3 devices went up ~400 chars in the 2026-08-02 first pass.
  // RECORDED REASON, and it is a fix rather than debt: the three
  // `gen3_*_platform` recipes used to end "pick a high-gain amp model
  // separately", which agents read as permission to abandon the recipe and
  // hand-author the same knobs (visible verbatim in the failing
  // `fm9-recipe-platform-pickup` traces: the agent says the recipe fits, then
  // never calls `recipe_id`). Each description now names the one-call
  // `apply_preset({recipe_id, overrides})` path instead. ~130 chars per recipe
  // bought the sensor. Do not spend it again for prose.
  //
  // They then came down ~930 each in the second pass, from the same
  // block_stack trim as the II (3 block_stack recipes x ~310 chars of
  // target_blocks + source_notes + empty params).
  'axe-fx-iii': 28_950,
  fm9: 24_750,
  fm3: 23_100,
  'circuit-tracks': 23_200,
  vp4: 15_300,
  've-500': 11_400,
  microfreak: 10_100,
  'rc-505mk2': 8_000,
  'rc-600': 7_700,
  'spd-sx': 6_800,
  'axe-fx-gen1': 5_300,
  minifreak: 3_100,
};

/** A device with no ceiling yet gets this, so a NEW device cannot land oversized. */
const DEFAULT_CEILING_BYTES = 40_000;

/**
 * `agent_guidance` is prose and grows fastest; past this share the payload is
 * mostly essay. ADVISORY ONLY, and deliberately so.
 *
 * IT IS TEMPTING TO MAKE THIS HARD. `agent_guidance` is 75-87% of the AM4 and
 * a guidance key (`cab_polish`) is what pushed that device over the host cliff
 * on 2026-07-17, so it reads like the variable to gate. It is not, for three
 * reasons, and the first is fatal on its own:
 *
 *   1. IT MOVES THE WRONG WAY. It is a ratio whose denominator is the number
 *      you are trying to reduce. In the 2026-08-02 second pass the Axe-Fx II
 *      shed 4,621 chars of post-choice recipe fields — the single healthiest
 *      change in this file's history — and its share went UP, 53% -> 58%,
 *      because only the denominator moved. The AM4 grew 6,718 chars in the
 *      same commit and its share went DOWN, 87% -> 75%. A hard gate here would
 *      have failed the device that improved and passed the device that grew.
 *   2. THE FAILURE MODE IT NAMES IS NOW STRUCTURALLY IMPOSSIBLE. `cab_polish`
 *      could cross the cliff because guidance was unbudgeted. Since the ration
 *      loop landed, `describeDevice` withholds topics largest-first at
 *      DESCRIBE_DEVICE_BUDGET_CHARS, so a new guidance key can no longer take
 *      a device over — it can only evict another key. What is left to watch is
 *      SILENT EVICTION, and the signal for that is the `withheld` count below,
 *      not this ratio.
 *   3. THE REAL CHECKS FIRE EARLIER AND MORE PRECISELY. The host cliff and the
 *      frozen per-device ceiling both trip on absolute growth, on the device
 *      that grew, the moment it grows. This ratio can move several points with
 *      nothing added to the corpus at all.
 *
 * So it stays a warning: "this device has authored a lot of prose relative to
 * its structured surfaces", which is worth a maintainer's eye and worth nobody's
 * build failing. A device that is legitimately almost all prose (the AX8 at 85%
 * — set-only, no recipes, thin block roster) is not doing anything wrong.
 *
 * Thresholds recalibrated from 0.60/0.80 when the denominator moved from the
 * pretty-printed length to the compact one. Indentation is spread over the whole
 * payload but guidance is long strings that carry almost none of it, so every
 * share reads ~6 points higher against the compact total. These numbers preserve
 * the old verdicts exactly; they are not a relaxation.
 */
const GUIDANCE_SHARE_WARN = 0.65;
const GUIDANCE_SHARE_HARD = 0.90;

/**
 * THE PREVIEW WINDOW. When a result crosses the host cliff the host does not
 * drop it silently — it emits a stub of this exact shape (verbatim, from
 * `traces/am4-recipe-block-stack-pickup-2026-08-02T08-20-55-371Z.ndjson`):
 *
 *   <persisted-output>
 *   Output too large (50.9KB). Full output saved to: ...\toolu_01K9....txt
 *
 *   Preview (first 2KB):
 *   {"device":"Fractal AM4","id":"am4","recipes":[{"id":"auto_wah_funk",...
 *   ...
 *   </persisted-output>
 *
 * The first 2,048 characters of the payload survive. Everything past them
 * reaches the model only through a file path, which an MCP-only agent has no
 * tool to open. So `recipes[]` — the one surface an agent must ACT on rather
 * than consult — has to start inside this window, and that is what is checked.
 *
 * DO NOT TREAT THIS AS A SAFETY NET. It is defence-in-depth and nothing more,
 * because the preview is NOT guaranteed to exist. Measured 2026-08-02 (see
 * HOST_DELIVERY_MAX_CHARS): at the default MAX_MCP_OUTPUT_TOKENS of 25,000, a
 * payload of exactly 50,001 chars gets this stub, but 50,002 and up get a BARE
 * ERROR with no preview whatsoever — the second limit fires first and it
 * renders nothing. Every realistically-over-budget device lands in that second
 * regime, so an over-cliff payload should be expected to deliver zero bytes,
 * not 2 KB of them. The 51,233-char AM4 stub quoted above is a real trace, but
 * it came from a host build whose token limit did not bite there; today the
 * same payload returns nothing at all. Keeping recipes[] first is still right
 * — it costs nothing and it is exactly what turned a 9-17-call AM4 stub run
 * into a 4-call one — but the check that MATTERS is the cliff itself.
 *
 * WHY AN ABSOLUTE OFFSET AND NOT A PERCENTAGE. This check used to be
 * `recipesAt > 10% of the payload`, justified as "this is the exact position at
 * which recipe pickup measurably regressed on the AM4". THAT JUSTIFICATION WAS
 * WRONG, and the same-case paired control in the trace corpus refutes it
 * directly:
 *
 *   am4-recipe-block-stack-pickup, recipes[] LAST, at 71-75% of a payload that
 *     was delivered whole: 5 runs, 5 passes, 2-3 tool calls. (2026-05-27 x2,
 *     06-06, 06-10, 06-28. The two 0-tool failures in that window are harness
 *     crashes, exit 3221225794, not pickup failures.)
 *   axefx2-recipe-genre-subtext, recipes[] LAST at 61-65%, always delivered
 *     whole: 9 runs, 8 clean passes at 3-6 calls; the one non-crash failure
 *     called apply_preset three times (a retry loop), i.e. it picked the recipe
 *     too.
 *
 * Burial did not suppress pickup. What suppressed it was STUBBING: the same
 * AM4 case failed 4/4 at 9-17 calls once `cab_polish` took the payload to
 * 51,233 and the model started receiving 2,253 characters of it.
 *
 * The reorder is still right — but for THIS reason, which the corpus also
 * demonstrates: at 2026-08-02T08:20Z the AM4 was still 50.9 KB and still
 * stubbed, yet with recipes[] moved to the front the preview carried seven
 * recipe ids, and the agent picked one (`texas_blues_srv`) in 4 calls instead
 * of the 9-17 it spent when the same stub carried `capabilities`. Recipes
 * belong at the front because the front is what survives, not because agents
 * skim.
 *
 * A percentage cannot express that. It is looser than the window on every
 * device that has recipes (10% of the smallest, fm3 at 23 KB, is 2.3 KB —
 * already past the cutoff) and tighter than it on small devices that have
 * none. Gate the offset the host actually truncates at.
 *
 * NOT claimed here: that the reorder alone fixes pickup. `fm9-recipe-platform-
 * pickup` failed at 08:56Z with recipes[] already at offset 0 and the payload
 * delivered whole; it went 2/2 only after the recipe DESCRIPTIONS stopped
 * saying "pick an amp model separately". Position gets the surface delivered.
 * It does not make the copy persuasive.
 */
const RECIPES_PREVIEW_WINDOW_CHARS = 2_048;

interface Row {
  device: string;
  total: number;
  pretty: number;
  guidance: number;
  guidanceShare: number;
  /** Absolute character offset of the `"recipes"` key. Undefined when absent. */
  recipesAt: number | undefined;
  recipeCount: number;
  withheld: number;
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], stderr: 'pipe' });
  const client = new Client({ name: 'describe-device-budget', version: '0.1.0' });
  await client.connect(transport);

  const rows: Row[] = [];
  try {
    const rigRaw = await client.callTool({ name: 'describe_rig', arguments: {} });
    const rigText = (rigRaw as { content?: { text?: string }[] }).content?.[0]?.text ?? '{}';
    const rig = JSON.parse(rigText) as { devices?: { id: string }[] };
    const deviceIds = (rig.devices ?? []).map((d) => d.id);
    if (deviceIds.length === 0) throw new Error('describe_rig returned no devices; is the build current?');

    for (const id of deviceIds) {
      let text: string;
      try {
        const res = await client.callTool({ name: 'describe_device', arguments: { port: id } });
        text = (res as { content?: { text?: string }[] }).content?.[0]?.text ?? '';
      } catch {
        continue; // a device that refuses to describe itself is another gate's problem
      }
      if (text.length === 0) continue;

      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* size still counts */ }

      // MODEL-FACING size is the compact serialization: the host counts that,
      // not our pretty-printer's indentation.
      const compact = Object.keys(parsed).length > 0 ? JSON.stringify(parsed) : text;

      // Measure the guidance share against the FULL corpus, not the inline
      // remainder. Measured inline, a device that is over budget reports a
      // SMALLER share the more guidance gets withheld — the Hydrasynth, when
      // it was withholding all 13 of its topics, would have read 0% and looked
      // like the healthiest device in the table. The share is a question about
      // how much prose the device has authored, so ask the corpus.
      let guidance = parsed.agent_guidance === undefined ? 0 : JSON.stringify(parsed.agent_guidance).length;
      const withheldHere = (parsed.agent_guidance_withheld as { topics?: unknown[] } | undefined)?.topics;
      if (Array.isArray(withheldHere) && withheldHere.length > 0) {
        try {
          const g = await client.callTool({ name: 'describe_device', arguments: { port: id, guidance: true } });
          const gText = (g as { content?: { text?: string }[] }).content?.[0]?.text ?? '{}';
          const full = (JSON.parse(gText) as { agent_guidance?: unknown }).agent_guidance;
          if (full !== undefined) guidance = JSON.stringify(full).length;
        } catch { /* fall back to the inline measure */ }
      }
      const recipesIdx = compact.indexOf('"recipes"');
      const recipes = Array.isArray(parsed.recipes) ? (parsed.recipes as unknown[]).length : 0;
      const withheldTopics = (parsed.agent_guidance_withheld as { topics?: unknown[] } | undefined)?.topics;

      rows.push({
        device: id,
        total: compact.length,
        pretty: text.length,
        guidance,
        guidanceShare: compact.length === 0 ? 0 : guidance / compact.length,
        recipesAt: recipesIdx === -1 ? undefined : recipesIdx,
        recipeCount: recipes,
        withheld: Array.isArray(withheldTopics) ? withheldTopics.length : 0,
      });
    }
  } finally {
    await client.close();
  }

  rows.sort((a, b) => b.total - a.total);

  console.log('describe_device response budget (model-facing = compact chars)\n');
  console.log(`  'at' = character offset of recipes[]; it must land inside the ${RECIPES_PREVIEW_WINDOW_CHARS}-char preview window.\n`);
  console.log('  device                model-facing   guidance   recipes     at   withheld');
  console.log('  ' + '-'.repeat(72));
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const r of rows) {
    const ceiling = DEVICE_CEILINGS[r.device] ?? DEFAULT_CEILING_BYTES;
    const startPct = r.recipesAt === undefined ? '-' : String(r.recipesAt);
    const flag = r.total > HOST_DELIVERY_MAX_CHARS ? ' ✗ CLIFF' : (r.total > ceiling ? ' ✗' : '');
    console.log(
      `  ${r.device.padEnd(18)} ${String(r.total).padStart(7)} / ${String(ceiling).padStart(6)}   ${String(Math.round(r.guidanceShare * 100)).padStart(6)}%   ${String(r.recipeCount).padStart(7)}  ${startPct.padStart(5)}   ${String(r.withheld).padStart(8)}${flag}`,
    );

    // A device inside 10% of the cliff is one content addition from a total
    // blackout, and the server's own guidance budget may have nothing left to
    // withhold. Say so before it happens rather than after.
    if (r.total <= HOST_DELIVERY_MAX_CHARS && r.total > HOST_DELIVERY_MAX_CHARS * 0.9) {
      warnings.push(
        `${r.device}: ${r.total} chars, only ${HOST_DELIVERY_MAX_CHARS - r.total} under the host delivery cliff`
        + `${r.withheld > 0 ? ' with ALL guidance already withheld (nothing left to shed)' : ''}. `
        + 'The next content addition here costs the whole payload, not part of it.',
      );
    }

    if (r.total > HOST_DELIVERY_MAX_CHARS) {
      failures.push(
        `${r.device}: describe_device is ${r.total} model-facing chars, past the measured host delivery cliff of `
        + `${HOST_DELIVERY_MAX_CHARS}. The model receives NONE of it — the host swaps the whole response for a `
        + 'sidecar file path an MCP-only agent cannot open (and past 50,001 chars, not even a preview). The guidance budget in '
        + 'describeDevice already withheld what it could, so the excess is in the non-guidance surfaces — usually '
        + 'recipes[]. Measure it per FIELD before cutting anything: the fix is almost always to move a field that is '
        + 'only read AFTER a recipe is chosen onto the detail path (describe_device({port, recipe})), not to drop a '
        + 'recipe. That is what took the Hydrasynth from 49,814 to 41,984 without losing a single capability.',
      );
    }

    if (r.total > ceiling) {
      const known = DEVICE_CEILINGS[r.device] !== undefined;
      failures.push(
        `${r.device}: describe_device GREW to ${r.total} bytes, past its frozen ceiling of ${ceiling}. `
        + (known
          ? 'Something was added to the default discovery path. Move a surface out of it (see list_pattern_recipes for the shape) rather than raising the ceiling — this is the exact growth that broke AM4 recipe retrieval.'
          : 'This device has no recorded ceiling, so it landed against the default. Add an entry once its size is deliberate.'),
      );
    } else if (ceiling - r.total > 8_000 && DEVICE_CEILINGS[r.device] !== undefined) {
      warnings.push(`${r.device}: ${r.total} bytes, comfortably under its ${ceiling} ceiling — tighten it to freeze the gain.`);
    }

    // ADVISORY, both branches. See GUIDANCE_SHARE_WARN for why this ratio must
    // not gate a build: it moves the wrong way when a payload is trimmed, and
    // the failure mode it names is now handled by the ration loop.
    if (r.guidanceShare > GUIDANCE_SHARE_HARD) {
      warnings.push(`${r.device}: agent_guidance is ${Math.round(r.guidanceShare * 100)}% of the payload (past the ${Math.round(GUIDANCE_SHARE_HARD * 100)}% mark). The response is mostly essay. Advisory — check the absolute numbers before acting on this one.`);
    } else if (r.guidanceShare > GUIDANCE_SHARE_WARN) {
      warnings.push(`${r.device}: agent_guidance is ${Math.round(r.guidanceShare * 100)}% of the payload.`);
    }

    // The honest replacement for a hard guidance check. A withheld topic is
    // REACHABLE but not DELIVERED: the agent sees it named in
    // agent_guidance_withheld.topics and must spend a call to read it. That is
    // the state the Hydrasynth sat in with all 13 of its topics for weeks
    // without anyone noticing, so name it every run.
    if (r.withheld > 0) {
      warnings.push(
        `${r.device}: ${r.withheld} guidance topic(s) withheld to fit the server budget — reachable via `
        + 'describe_device({port, guidance:[...topics]}), but not inline, so an agent only reads them if it asks. '
        + 'Shrinking any OTHER surface on this device will not bank margin; the ration loop re-spends it here.',
      );
    }

    if (r.recipeCount > 0 && r.recipesAt !== undefined && r.recipesAt >= RECIPES_PREVIEW_WINDOW_CHARS) {
      failures.push(
        `${r.device}: recipes[] starts at character ${r.recipesAt}, outside the ${RECIPES_PREVIEW_WINDOW_CHARS}-char preview `
        + 'window. If this device ever crosses the host cliff, the preview is the ONLY part of the payload the model '
        + 'receives, and recipes[] would not be in it — which is precisely the difference between the AM4 stub that got '
        + 'a recipe picked in 4 calls and the ones before it that took 9-17 and never picked one. Emit `recipes` '
        + 'immediately after the identity fields in describeDevice; do not reorder reference material in front of it.',
      );
    }
  }

  console.log('');
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  for (const f of failures) console.log(`  ✗ ${f}`);

  if (REPORT_ONLY) { console.log('\n--report: exit 0 regardless.'); return; }
  if (failures.length > 0) {
    console.log(`\nFAIL: ${failures.length} budget violation(s).`);
    process.exit(1);
  }
  console.log(`\nOK: ${rows.length} device(s) within budget${warnings.length > 0 ? `, ${warnings.length} warning(s)` : ''}.`);
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
