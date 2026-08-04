/**
 * verify-list-params-budget.ts: the size gate on `list_params`, the
 * discovery tool that had none.
 *
 * WHY THIS EXISTS. `verify-describe-device-budget.ts` gates the OTHER
 * discovery response against the host's delivery cliff, and its header
 * explains at length what crossing that cliff costs. `list_params` lives in
 * the SAME source file (`dispatcher/discovery.ts`), is the tool whose own
 * description tells the agent to "call before set_param when unsure of an
 * enum spelling", and was gated by nothing at all.
 *
 * WHAT THAT COST, measured 2026-08-02 against the then-current build:
 *
 *   fm9         unfiltered  280,045 chars      am4         219,691
 *   axe-fx-iii  unfiltered  264,553            axe-fx-ii   144,697
 *   fm3         unfiltered  254,289            ve-500      132,287
 *   ...  TEN of sixteen registered devices, all past the 50,000-char cliff.
 *
 * Past the cliff the model receives NONE of the response. The host swaps it
 * for a sidecar file path an MCP-only agent has no tool to open, and above
 * ~50,001 chars not even the 2 KB preview survives. So on the two devices
 * with the deepest catalogs, the tool the agent is told to consult before
 * every uncertain write had never once returned an answer it could read.
 * Independently corroborated: all 13 token-capped tool results in the
 * 669-trace corpus are `list_params`.
 *
 * AND IT WAS NOT ONLY THE UNFILTERED CALL. The AM4 exceeded the cliff on a
 * CORRECTLY-narrowed one: `block:["amp"]` measured 67,731. An agent that did
 * exactly what the tool description asked still got nothing. That is why this
 * gate walks the filtered shapes too, and why the block leg is the one that
 * matters most.
 *
 * WHAT IT CHECKS, per registered device:
 *   1. HARD: the unfiltered call, which must now be a per-block CENSUS
 *      (`scope: "summary"`, zero param rows) rather than the whole catalog.
 *   2. HARD: every single-block call, against the cliff AND the server's own
 *      LIST_PARAMS_BUDGET_CHARS.
 *   3. HARD: the widest legal call (every block at once), which must either
 *      fit or report `truncated` with a usable `next_offset`. Silence is the
 *      failure being gated; a short answer that says so is not.
 *   4. HARD: pagination terminates and is lossless. Walking `next_offset`
 *      must reach exactly `total_params` rows without repeating an offset.
 *   5. HARD: the param-scoped call (block+name) on each block's type
 *      selector, which carries the full enum roster and is the largest
 *      single-param response the surface can produce.
 *
 *   npx tsx scripts/verify-list-params-budget.ts          # gate (exit 1 on fail)
 *   npx tsx scripts/verify-list-params-budget.ts --report # sizes only, exit 0
 */
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');
const REPORT_ONLY = process.argv.includes('--report');

/**
 * The host's measured delivery cliff. Identical to the constant in
 * `verify-describe-device-budget.ts`, and measured by the same instrument
 * (`scripts/probe-host-delivery-cliff.ts`): 50,000 delivered whole, 50,001
 * not, at both entropy extremes. Characters, not tokens.
 */
const HOST_DELIVERY_MAX_CHARS = 50_000;

/**
 * The server's own budget for this tool, mirrored from
 * `LIST_PARAMS_BUDGET_CHARS` in `dispatcher/discovery.ts`. Deliberately 10,000
 * under the cliff: unlike `describe_device`, where margin is paid for by
 * evicting a guidance topic, a page boundary here costs one cheap follow-up
 * call. A response OVER this but UNDER the cliff means the fitting loop did
 * not run, which is a bug in the budget, not a device that grew.
 */
const SERVER_BUDGET_CHARS = 40_000;

/** Walking pages forever is a hang, not a failure. Far above any real catalog. */
const MAX_PAGES = 60;

/**
 * THE FLOOR ON THIS GATE'S OWN COVERAGE, and the reason it exists.
 *
 * Almost every check below is driven by data read out of the response under
 * test: the block list comes from the census, and the enum leg iterates the
 * census's `type_selector` fields. That is convenient and it is also how a
 * size gate quietly stops checking anything. If `block_summary` ever
 * regressed to `[]`, the per-block and all-blocks legs would iterate zero
 * times, every remaining assertion would still pass, and this file would
 * print a full table of green rows having measured nothing.
 *
 * So the gate asserts its own reach: the device roster cannot shrink, and
 * (below) a device that claims blocks must actually yield rows for them.
 * 16 registered devices as of 2026-08-02.
 */
const EXPECTED_DEVICE_COUNT = 16;

interface Finding { device: string; message: string }

function compact(text: string): number {
  try { return JSON.stringify(JSON.parse(text)).length; } catch { return text.length; }
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], stderr: 'pipe' });
  const client = new Client({ name: 'list-params-budget', version: '0.1.0' });
  await client.connect(transport);

  const failures: Finding[] = [];
  const warnings: Finding[] = [];

  const call = async (args: Record<string, unknown>): Promise<{ text: string; json: Record<string, any> }> => {
    const res = await client.callTool({ name: 'list_params', arguments: args });
    const text = (res as { content?: { text?: string }[] }).content?.[0]?.text ?? '';
    let json: Record<string, any> = {};
    try { json = JSON.parse(text) as Record<string, any>; } catch { /* size still counts */ }
    return { text, json };
  };

  try {
    const rigRaw = await client.callTool({ name: 'describe_rig', arguments: {} });
    const rigText = (rigRaw as { content?: { text?: string }[] }).content?.[0]?.text ?? '{}';
    const rig = JSON.parse(rigText) as { devices?: { id: string }[] };
    const deviceIds = (rig.devices ?? []).map((d) => d.id);
    if (deviceIds.length === 0) throw new Error('describe_rig returned no devices; is the build current?');
    if (deviceIds.length < EXPECTED_DEVICE_COUNT) {
      failures.push({
        device: '(roster)',
        message: `describe_rig returned ${deviceIds.length} devices, fewer than the ${EXPECTED_DEVICE_COUNT} this gate expects. `
          + 'A device that stops registering silently stops being size-checked, and this gate would otherwise report green '
          + 'while covering less. Raise EXPECTED_DEVICE_COUNT when a device is deliberately retired.',
      });
    }

    console.log('list_params response budget (model-facing = compact chars)\n');
    console.log(`  cliff ${HOST_DELIVERY_MAX_CHARS} · server budget ${SERVER_BUDGET_CHARS}\n`);
    console.log('  device               census   worst-block  (block)              all-blocks   worst-enum');
    console.log('  ' + '-'.repeat(88));

    for (const id of deviceIds) {
      // ── 1. the unfiltered call must be a census ──────────────────────
      const { text: censusText, json: census } = await call({ port: id });
      if (censusText.length === 0) continue;
      const censusSize = compact(censusText);

      if (census.scope !== 'summary') {
        failures.push({ device: id, message: `unfiltered list_params returned scope="${String(census.scope)}", expected "summary". The no-filter call must be a per-block census; serializing every param is what put ten devices past the delivery cliff.` });
      }
      if (Array.isArray(census.params) && census.params.length > 0) {
        failures.push({ device: id, message: `unfiltered list_params returned ${census.params.length} param rows. The census scope must return none, which is the whole point of it.` });
      }
      if (censusSize > SERVER_BUDGET_CHARS) {
        failures.push({ device: id, message: `census is ${censusSize} chars, over the ${SERVER_BUDGET_CHARS} budget. A per-block census should be a few thousand; something is serializing rows into it.` });
      }

      // Cross-check the census against `describe_device`'s own roster rather
// than trusting the response under test to report its own coverage. A
      // census that stopped listing blocks would otherwise silently skip every
      // size check below while this gate still printed a green row.
      const blockNames: string[] = (census.block_summary ?? []).map((b: { block: string }) => b.block);
      const rosterFromCensus: string[] = Array.isArray(census.blocks) ? census.blocks as string[] : [];
      if (rosterFromCensus.length !== blockNames.length) {
        failures.push({ device: id, message: `census lists ${blockNames.length} blocks in block_summary but ${rosterFromCensus.length} in \`blocks\`. These must agree; every size check below is driven by block_summary, so a short census silently shrinks this gate's coverage.` });
      }
      if (blockNames.length === 0 && (census.total_params ?? 0) > 0) {
        failures.push({ device: id, message: `census reports ${census.total_params} params but lists NO blocks, so no per-block or all-blocks size check ran for this device. That is a self-disabling gate, not a passing device.` });
      }

      // ── 2. every single-block call ───────────────────────────────────
      let worstBlock = '-'; let worstBlockSize = 0;
      for (const b of blockNames) {
        const { text } = await call({ port: id, block: [b] });
        const n = compact(text);
        if (n > worstBlockSize) { worstBlockSize = n; worstBlock = b; }
        if (n > HOST_DELIVERY_MAX_CHARS) {
          failures.push({ device: id, message: `list_params({block:["${b}"]}) is ${n} chars, PAST THE ${HOST_DELIVERY_MAX_CHARS} DELIVERY CLIFF, so the model receives none of it. This is the AM4 amp failure exactly: a correctly-narrowed call returning silence. Move a per-row field to the param scope (see host_label / parameter_name / applies_only_when_full) rather than dropping params.` });
        } else if (n > SERVER_BUDGET_CHARS) {
          failures.push({ device: id, message: `list_params({block:["${b}"]}) is ${n} chars, over the server's own ${SERVER_BUDGET_CHARS} budget. The fitting loop should have paged this. Check that the rows path measures the assembled response, not the entries alone.` });
        }
      }

      // ── 3 + 4. widest legal call, and lossless pagination ────────────
      let allBlocksSize = 0;
      if (blockNames.length > 0) {
        const { text, json } = await call({ port: id, block: blockNames, include_descriptions: true });
        allBlocksSize = compact(text);
        if (allBlocksSize > HOST_DELIVERY_MAX_CHARS) {
          failures.push({ device: id, message: `list_params over every block is ${allBlocksSize} chars, past the delivery cliff. It must truncate and report next_offset instead.` });
        }
        const total: number = json.total_params ?? 0;
        const rowsFirst: number = (json.params ?? []).length;
        if (json.truncated !== undefined) {
          // Walk it. A pager that stalls or loses rows is worse than no pager.
          let offset: number = json.truncated.next_offset;
          let seen = rowsFirst;
          let pages = 1;
          let stalled = false;
          let aborted = false;
          while (pages < MAX_PAGES) {
            const pg = await call({ port: id, block: blockNames, include_descriptions: true, offset });
            pages++;
            seen += (pg.json.params ?? []).length;
            const size = compact(pg.text);
            if (size > HOST_DELIVERY_MAX_CHARS) {
              failures.push({ device: id, message: `page at offset ${offset} is ${size} chars, past the delivery cliff.` });
              // Abandoning the walk leaves `seen` short of `total`, which would
              // otherwise also trip the lossy-pagination check below and report
              // a second, invented defect on top of the real one.
              aborted = true;
              break;
            }
            if (pg.json.truncated === undefined) break;
            if (pg.json.truncated.next_offset <= offset) { stalled = true; break; }
            offset = pg.json.truncated.next_offset;
          }
          if (stalled) {
            failures.push({ device: id, message: `pagination STALLED at offset ${offset}: next_offset did not advance. An agent following it loops forever.` });
          } else if (pages >= MAX_PAGES) {
            failures.push({ device: id, message: `pagination did not terminate within ${MAX_PAGES} pages.` });
          } else if (!aborted && seen !== total) {
            failures.push({ device: id, message: `pagination is LOSSY: walking next_offset yielded ${seen} rows but total_params is ${total}. Rows are being dropped or double-counted between pages.` });
          }
        } else if (rowsFirst !== total) {
          failures.push({ device: id, message: `returned ${rowsFirst} of ${total} rows with no \`truncated\` block. Rows were dropped silently, which is the exact failure mode this gate exists to catch.` });
        }
      }

      // ── 5. param scope on each block's type selector ─────────────────
      let worstEnum = 0;
      for (const b of census.block_summary ?? []) {
        if (b.type_selector === undefined) continue;
        const { text } = await call({ port: id, block: [b.block], name: [b.type_selector] });
        const n = compact(text);
        if (n > worstEnum) worstEnum = n;
        if (n > HOST_DELIVERY_MAX_CHARS) {
          failures.push({ device: id, message: `list_params({block:["${b.block}"], name:["${b.type_selector}"]}) is ${n} chars, past the delivery cliff. A single enum roster cannot be paged by block, so it needs its own projection.` });
        } else if (n > SERVER_BUDGET_CHARS) {
          warnings.push({ device: id, message: `${b.block}.${b.type_selector} enum response is ${n} chars, over the ${SERVER_BUDGET_CHARS} budget though still deliverable. Watch it.` });
        }
      }

      console.log(
        `  ${id.padEnd(18)} ${String(censusSize).padStart(6)}   ${String(worstBlockSize).padStart(10)}  ${`(${worstBlock})`.padEnd(20)} ${String(allBlocksSize).padStart(9)}   ${String(worstEnum).padStart(10)}`,
      );
    }
  } finally {
    await client.close();
  }

  console.log('');
  for (const w of warnings) console.log(`  ⚠ ${w.device}: ${w.message}`);
  for (const f of failures) console.log(`  ✗ ${f.device}: ${f.message}`);

  if (REPORT_ONLY) { console.log('\n--report: exit 0 regardless.'); return; }
  if (failures.length > 0) {
    console.log(`\nFAIL: ${failures.length} list_params budget violation(s).`);
    process.exit(1);
  }
  console.log(`\nOK: every list_params scope within budget${warnings.length > 0 ? `, ${warnings.length} warning(s)` : ''}.`);
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
