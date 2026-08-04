/**
 * verify-tools-list-budget.ts: a size budget on the WHOLE `tools/list` payload,
 * per tool, because the gate that was supposed to control this measured half of
 * it and told you to move the rest into the other half.
 *
 * WHY THIS EXISTS, AND WHY THE EXISTING GATE DID NOT PREVENT IT.
 * `scripts/list-tools.ts` caps each tool's `.description` at 600 warn / 1000
 * hard, and preflight enforces it. Its own failure message says:
 *
 *     "Move anything that describes ONE argument into that argument's
 *      description, which is not counted here."
 *
 * That advice is right about where the text BELONGS and wrong about what it
 * costs, because both fields ship in the same `tools/list` response and the
 * model pays for both. So the documented remediation is: go over the cap, move
 * prose from the counted field into the uncounted field, go green, ship the
 * same number of bytes. Measured 2026-08-02, that is exactly the shape of the
 * surface:
 *
 *     tool `.description`   45,746 chars   26%   <- the gated half
 *     schema `.description` 75,868 chars   44%   <- the ungated half
 *     everything else       ~51,700 chars  30%
 *     tools/list TOTAL     173,341 chars         55 tools
 *
 * The gated half averages 832 chars against a 1,000 cap, so almost everything
 * passes while the ungated half is nearly twice as large. That is why "the tool
 * descriptions are too big" kept recurring across sessions despite the cap being
 * green: the number being watched was not the number that governs the cost.
 *
 * WHAT THIS GATE MEASURES INSTEAD: `JSON.stringify(tool).length` for each entry
 * in `tools/list`. Name, description, the whole `inputSchema` including every
 * argument description and enum roster, `outputSchema`, and annotations. There
 * is no half left over to push prose into.
 *
 * AND IT IS NOT SPREAD EVENLY, which changes what to do about it. Four tools are
 * 38% of the payload (apply_pattern 26,700; apply_preset 17,000;
 * import_songsterr 11,700; apply_patch 9,900) and the bottom 30 are all under
 * 2,100. Trimming prose across the small tools cannot compete with splitting the
 * big ones. `apply_pattern` alone (37 top-level params, 1 required) is 15% of
 * everything the model reads before it can call anything.
 *
 * WHY A TOTAL CEILING TOO. `tools/list` is paid on EVERY session, before the
 * first tool call, unlike a response budget which is paid per call. At roughly
 * 4 chars per token this surface is ~43k tokens of context before any work
 * starts.
 *
 *   npx tsx scripts/verify-tools-list-budget.ts          # gate (exit 1 on fail)
 *   npx tsx scripts/verify-tools-list-budget.ts --report # sizes only, exit 0
 */
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');
const REPORT_ONLY = process.argv.includes('--report');

/**
 * PER-TOOL CEILINGS, frozen at what each measured on 2026-08-02, rounded UP to
 * the next 100 so a one-word edit does not fail the build.
 *
 * Same instrument and same reasoning as `DEVICE_CEILINGS` in
 * verify-describe-device-budget.ts: a single global cap either lands red and
 * gets ignored, or is loose enough to permit the growth it exists to stop. Each
 * tool is frozen where it stands, so ANY growth fails on the tool that grew.
 *
 * RAISING ONE NEEDS A RECORDED REASON, in a comment next to it, and the fix is
 * almost always to move an argument's prose into `describe_device` guidance or
 * an error message rather than to widen the door. Both of those are paid only
 * when they are needed; `tools/list` is paid on every session.
 *
 * LOWERING one is free and always welcome. The four large entries carry a note
 * because they are where the surface actually is.
 *
 * ── RE-FROZEN 2026-08-02 (second pass), and why every number MOVED ──────
 *
 * Two deliberate changes landed together, and the table was re-measured after
 * both rather than per-tool:
 *
 *   (+) A `title` was added to all 55 tools. MCP clients show a bare tool NAME
 *       in their UI otherwise, so a guitarist reading Claude Desktop saw
 *       `send_reset_controllers`. That is ~1,570 chars of permanent, deliberate
 *       growth spread thinly, and it pushed 13 tools past ceilings that had
 *       been frozen with only round-up-to-100 slack. THAT is the recorded
 *       reason for every raise in this table; there is no other.
 *
 *   (-) Two measured duplications were consolidated, for a much larger saving:
 *       `PORT_DESC` (270 chars on THIRTY tools = 8,100, the single largest
 *       duplication on the surface) lost a session-start instruction that was
 *       not about the argument at all and is stated twice elsewhere; and the
 *       seven copies of the `pack` argument lost prose already carried by the
 *       Circuit's `agentGuidance`, its descriptor, and the `list_samples`
 *       result text.
 *
 * Net: 173,341 -> 170,543. The surface got SMALLER by 2,798 chars while
 * gaining 55 titles. Most per-tool numbers here are therefore LOWER than the
 * first freeze; the handful that are higher are the title cost on small tools
 * where it exceeded the rounding slack.
 */
const TOOL_CEILINGS: Readonly<Record<string, number>> = {
  // THE BIG FOUR, 38% of the payload between them. These are the ones worth
  // structural work; the rest of the table is maintenance.
  //
  // apply_pattern: 37 top-level params and 1 required, which is a sign the tool
  // is several tools. The standing recommendation (queue item 6 in
  // HANDOFF-2026-08-02-discovery-surface.md) is to split it along input source:
  // apply_pattern (recipe/voices/steps/bpm), author_project (ncs_*, pack,
  // backup_first), and fold the MIDI/tab ingest into import_songsterr.
  apply_pattern: 25_800,
  apply_preset: 17_100,
  import_songsterr: 11_700,
  apply_patch: 9_900,

  translate_preset: 7_000,
  author_kit: 5_800,
  delete_project: 5_100,
  edit_rig: 4_300,
  list_params: 3_800,
  upload_project: 3_500,
  get_preset: 3_300,
  describe_device: 3_200,
  backup_device: 3_200,
  export_preset: 3_000,
  set_block: 3_000,
  upload_sample: 3_000,
  upload_kit: 2_800,
  set_macro_route: 2_500,
  save_preset: 2_400,
  set_param: 2_400,
  lookup_lineage: 2_300,
  scan_locations: 2_200,
  get_param: 2_100,
  list_samples: 2_100,
  import_preset: 2_100,
  set_mod_route: 2_000,
  measure_loudness: 2_000,
  list_backups: 2_000,
  switch_preset: 1_900,
  describe_rig: 1_800,
  send_sequence: 1_700,
  set_macro: 1_600,
  find_compatible_types: 1_600,
  set_params: 1_600,
  list_packs: 1_500,
  set_system_param: 1_500,
  send_cc: 1_500,
  send_program_change: 1_400,
  set_bypass: 1_400,
  reconnect_midi: 1_400,
  get_params: 1_400,
  send_nrpn: 1_300,
  send_chord: 1_300,
  list_midi_ports: 1_200,
  send_note: 1_100,
  switch_scene: 1_100,
  send_sysex: 1_000,
  send_song_position: 900,
  list_pattern_recipes: 800,
  send_reset_controllers: 800,
  init_patch: 800,
  send_clock_start: 800,
  send_panic: 700,
  send_clock_continue: 700,
  send_clock_stop: 600,
};

/** A tool with no ceiling yet gets this, so a NEW tool cannot land oversized. */
const DEFAULT_TOOL_CEILING = 3_000;

/**
 * TOTAL ceiling for the whole `tools/list` response. This is the number that
 * matters to a session's context budget, and it can creep even while every
 * individual tool stays inside its own ceiling.
 *
 * LOWERED 2026-08-02 from 175,000 to 171,500 after the duplication pass took
 * the measured total to 170,543 (from 173,341, while ADDING 55 titles). A
 * ceiling left at the old value would have banked the saving as permission to
 * grow back into it, which is exactly what a frozen budget exists to prevent.
 * ~1,000 chars of headroom, same posture as the per-tool entries.
 */
const TOTAL_CEILING = 171_500;

/**
 * The gate's own coverage floor. Every check below is driven by the response
 * under test, so a `tools/list` that returned two tools would pass every
 * per-tool assertion having measured almost nothing. 55 tools as of 2026-08-02.
 */
const EXPECTED_TOOL_COUNT = 55;

interface Row { name: string; size: number; ceiling: number; descr: number; schema: number }

/** Sum every `description` string anywhere inside a JSON Schema. */
function schemaDescriptionChars(node: unknown): number {
  if (node === null || typeof node !== 'object') return 0;
  let n = 0;
  const rec = node as Record<string, unknown>;
  if (typeof rec.description === 'string') n += rec.description.length;
  for (const v of Object.values(rec)) n += schemaDescriptionChars(v);
  return n;
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], stderr: 'pipe' });
  const client = new Client({ name: 'tools-list-budget', version: '0.1.0' });
  await client.connect(transport);

  const failures: string[] = [];
  const warnings: string[] = [];
  let rows: Row[] = [];
  let total = 0;

  try {
    const tools = (await client.listTools()).tools;
    total = JSON.stringify(tools).length;

    if (tools.length < EXPECTED_TOOL_COUNT) {
      failures.push(
        `tools/list returned ${tools.length} tools, fewer than the ${EXPECTED_TOOL_COUNT} this gate expects. `
        + 'A tool that stops registering silently stops being size-checked, and every per-tool assertion below '
        + 'would still pass. Lower EXPECTED_TOOL_COUNT only when a tool is deliberately retired.',
      );
    }

    rows = tools.map((t) => {
      const schema = schemaDescriptionChars(t.inputSchema)
        + schemaDescriptionChars((t as { outputSchema?: unknown }).outputSchema);
      return {
        name: t.name,
        size: JSON.stringify(t).length,
        ceiling: TOOL_CEILINGS[t.name] ?? DEFAULT_TOOL_CEILING,
        descr: (t.description ?? '').length,
        schema,
      };
    }).sort((a, b) => b.size - a.size);

    for (const r of rows) {
      if (r.size > r.ceiling) {
        const known = TOOL_CEILINGS[r.name] !== undefined;
        failures.push(
          `${r.name}: ${r.size} chars in tools/list, past its frozen ceiling of ${r.ceiling}. `
          + (known
            ? 'Moving prose from the tool description into an argument description does NOT reduce this number; '
            + 'both ship in the same response. Move it to describe_device guidance or an error message, which are '
            + 'paid only when needed, or split the tool.'
            : 'This tool has no recorded ceiling, so it landed against the default. Add an entry once its size is deliberate.'),
        );
      }
    }

    if (total > TOTAL_CEILING) {
      failures.push(
        `tools/list totals ${total} chars, past the ${TOTAL_CEILING} ceiling. This is paid on EVERY session before `
        + 'the first tool call, so it is the most expensive text in the product. The four largest tools are '
        + `${rows.slice(0, 4).map((r) => `${r.name} ${r.size}`).join(', ')}.`,
      );
    }
  } finally {
    await client.close();
  }

  const sumDescr = rows.reduce((a, r) => a + r.descr, 0);
  const sumSchema = rows.reduce((a, r) => a + r.schema, 0);

  console.log('tools/list size budget (whole per-tool payload, not just .description)\n');
  console.log(`  total ${total} / ${TOTAL_CEILING} across ${rows.length} tool(s)`);
  console.log(`  tool .description ${sumDescr} (${Math.round(sumDescr / total * 100)}%)   `
    + `schema .description ${sumSchema} (${Math.round(sumSchema / total * 100)}%)\n`);
  console.log('  tool                        size / ceiling    descr   schema');
  console.log('  ' + '-'.repeat(66));
  for (const r of rows.slice(0, 12)) {
    console.log(`  ${r.name.padEnd(26)} ${String(r.size).padStart(6)} / ${String(r.ceiling).padStart(6)}   `
      + `${String(r.descr).padStart(6)}   ${String(r.schema).padStart(6)}${r.size > r.ceiling ? '  X' : ''}`);
  }
  if (rows.length > 12) console.log(`  ... and ${rows.length - 12} more, all under 7,100`);

  // Advisory: a tool whose prose is mostly in the schema is the shape this gate
  // was written to expose. Not a failure; plenty of tools legitimately have
  // many arguments.
  for (const r of rows) {
    if (r.size >= 5_000 && r.schema > r.descr * 3) {
      warnings.push(`${r.name}: ${r.schema} chars of argument prose against ${r.descr} of tool description. `
        + 'Most of this tool is its arguments, which the old .description cap could not see.');
    }
  }

  console.log('');
  for (const w of warnings) console.log(`  ! ${w}`);
  for (const f of failures) console.log(`  X ${f}`);

  if (REPORT_ONLY) { console.log('\n--report: exit 0 regardless.'); return; }
  if (failures.length > 0) {
    console.log(`\nFAIL: ${failures.length} tools/list budget violation(s).`);
    process.exit(1);
  }
  console.log(`\nOK: ${rows.length} tool(s) within budget, total ${total} / ${TOTAL_CEILING}`
    + `${warnings.length > 0 ? `, ${warnings.length} advisory` : ''}.`);
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
