/**
 * verify-response-budget.ts: the size gate on the READ tools whose response
 * length is driven by data volume rather than by design.
 *
 * WHY THIS EXISTS. `verify-describe-device-budget.ts` gates one discovery
 * response against the host's 50,000-char delivery cliff, and
 * `verify-list-params-budget.ts` gates the other. Their headers explain at
 * length what crossing that cliff costs; read either one first. Both were
 * written after a SILENT outage, and the second was written because the first
 * lesson had been read as being about `describe_device` specifically. The
 * lesson is not about a tool. It is:
 *
 *   The ceiling belongs to EVERY response whose length is driven by data
 *   volume rather than by design.
 *
 * NOBODY HAD MEASURED THE REST OF THE SURFACE. This file is that measurement,
 * turned into a gate. Census taken 2026-08-02 across all 18 `readOnlyHint`
 * tools, at the WIDEST LEGAL ARGUMENTS of each (a figure without its argument
 * shape is not reproducible, so every number below carries its call):
 *
 *   get_params      am4  894 queries (whole catalog)         149,443
 *                   am4  406 queries (amp+drive+delay+reverb) 69,044
 *                   axe-fx-ii 1,126 queries                  208,649
 *   lookup_lineage  am4  amp, all 248 names, quotes on       219,171
 *                   axe-fx-ii amp, all 266 names, quotes on  182,114
 *                   ax8  amp, all 266 names, quotes on       182,104
 *   list_backups    limit:500 (folder held 1,539 indexed)    212,623
 *   import_songsterr whole_song + parts:"all" (17 parts)      72,927
 *
 * FOUR MORE TOOLS PAST THE CLIFF, none of them previously measured. And the
 * crossings are not exotic: `get_params` crosses at 294 queries on the AM4 and
 * 278 on the Axe-Fx II; `lookup_lineage` forward crosses at FORTY-TWO amp
 * names; `list_backups` crosses at limit=135 against a `limit` whose schema
 * maximum is 500. Every one of those is a call the tool's own description
 * invites ("Batch all names in one call", "batch-read parameters ... for
 * state-anchoring before a tone-edit").
 *
 * RULE 6 AGAIN, AND IT KEEPS BEING TRUE. Narrowing is not a defence.
 * `list_backups({device:"circuit", limit:500})` measured 221,739, LARGER than
 * the unfiltered call at the same limit, because the filter selects the
 * heavier rows. So the gate measures filtered shapes too.
 *
 * THREE OF THE FOUR ARE NOW FIXED, and this file is what holds them fixed.
 * `lookup_lineage` (forward) and `list_backups` fit their rows to a
 * 40,000-char budget and page the remainder with `truncated` / `next_offset`,
 * the treatment `list_params` already had. `get_params` instead REFUSES a
 * batch over `GET_PARAMS_MAX_QUERIES` before any wire work, because it is the
 * one shape here that has already spent the wire by the time there is a
 * response to trim. The fourth, `import_songsterr`, is measured and
 * deliberately ungated (live network fetch; see below).
 *
 * So the legs check two properties, not one: that a response FITS, and that a
 * response which was SHORTENED says so. The second matters more. A blackout is
 * at least visibly broken; a silently-cut list is an agent telling the user it
 * has read the whole roster when it has read a third of it.
 *
 * WHAT IT CHECKS:
 *   1. HARD, no hardware: `lookup_lineage` FORWARD with every canonical name
 *      for every lineage block on every lineage-capable device, then the PAGER
 *      it now returns, walked to the end and required to advance and to lose
 *      nothing. The REVERSE path was already bounded (`matches.slice(0, 10)`
 *      in fractal-midi/src/shared/lineageLookup.ts) and measures 8-12 KB even
 *      on a one-letter substring; the FORWARD path, the one the description
 *      tells agents to batch, had no cap at all. That asymmetry was the
 *      finding.
 *   2. HARD, no hardware: `list_backups` at its SCHEMA CEILING, filtered and
 *      not, plus its pager. The chars-per-entry PROJECTION is kept because it
 *      is the one leg independent of how many backups this machine holds, but
 *      it now asserts the consequence rather than the size: if the schema
 *      still invites a selection too wide for one response, the paging
 *      machinery must be present and must fire. A folder too small to reach
 *      that crossing reports UNCHECKED rather than a green it did not earn.
 *   3. HARD, connected devices only: `get_params` over the cap (must be
 *      REFUSED, and refused fast enough to prove no reads happened first), at
 *      the cap (must fit), and the four-block tone-build anchor. The measured
 *      blackout was 149,443 chars on a full AM4 catalog read and 208,649 on
 *      the Axe-Fx II. **This leg has never met hardware**: the cap shipped
 *      with no device connected, so a run without one reports UNCHECKED rather
 *      than green. Re-run with the AM4 and Axe-Fx II attached.
 *   4. Measured and warned, not gated: `get_preset`, `describe_rig`,
 *      `find_compatible_types`. See MEASURED_NOT_GATED below for why each.
 *
 * SELF-COVERAGE, WHICH IS THE POINT OF THE FLOORS BELOW. Almost every leg
 * derives its work list from a response under test: the lineage rosters come
 * from `list_params`, the query list comes from the census, the device list
 * comes from `describe_rig`. That is convenient and it is also exactly how a
 * size gate quietly stops checking anything. If the census regressed to zero
 * blocks, every loop here would iterate zero times, every assertion would
 * still pass, and this file would print a table of green rows having measured
 * nothing. So the gate asserts its own reach: the roster cannot shrink, a
 * device that claims lineage must yield lineage shapes, and the run as a whole
 * must measure at least MIN_SHAPES_MEASURED responses.
 *
 *   npx tsx scripts/verify-response-budget.ts          # gate (exit 1 on fail)
 *   npx tsx scripts/verify-response-budget.ts --report # sizes only, exit 0
 */
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Imported, not restated: a gate that hardcodes the number it is checking
// stops checking anything the moment the number moves.
import { GET_PARAMS_MAX_QUERIES } from '@mcp-midi-control/core/protocol-generic/dispatcher.js';
import { LIST_BACKUPS_LIMIT_MAX } from '@mcp-midi-control/core/protocol-generic/dispatcher/backupIndex.js';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');
const REPORT_ONLY = process.argv.includes('--report');

/**
 * The host's measured delivery cliff, identical to the constant in both
 * sibling gates and measured by the same instrument
 * (`scripts/probe-host-delivery-cliff.ts`): 50,000 delivered whole, 50,001
 * not, at both entropy extremes. Characters, not tokens.
 */
const HOST_DELIVERY_MAX_CHARS = 50_000;

/** Inside this much of the cliff, a response is one content addition from a blackout. */
const WARN_MARGIN_CHARS = 10_000;

// LIST_BACKUPS_LIMIT_MAX is imported at the top of this file rather than
// restated: the gate projects against the schema's own ceiling rather than
// against whatever happens to be on the machine running it, because the folder
// is the one input a maintainer cannot reproduce and the schema is the one
// they can. A local copy would go on projecting against 500 after the real cap
// moved, which is a gate measuring a limit the tool does not have.

/** Sample size for deriving chars-per-entry. Small enough to be under the cliff anywhere. */
const LIST_BACKUPS_PROBE_LIMIT = 50;

/**
 * THE FLOOR ON THE DEVICE ROSTER. 16 registered devices as of 2026-08-02.
 * A device that stops registering silently stops being size-checked. Raise
 * this when a device is deliberately retired, never to make a run go green.
 */
const EXPECTED_DEVICE_COUNT = 16;

/**
 * THE FLOOR ON THIS GATE'S OWN WORK. A full 2026-08-02 run measured 69
 * responses with an AM4 and an Axe-Fx II attached, of which 8 came from the
 * hardware legs, so a run with nothing plugged in measures 61. Set below that
 * so a legitimately shrinking catalog does not fail, but far above zero so a
 * self-disabling regression does. Do not lower this to make a run go green:
 * the number dropping IS the signal.
 */
const MIN_SHAPES_MEASURED = 50;

/**
 * The lineage block types (fractal-midi/src/shared/lineageLookup.ts
 * LINEAGE_BLOCKS). The block NAME is stable across devices; the name of the
 * knob that selects the type is NOT, so it is read per device from the
 * census's own `type_selector` rather than assumed.
 *
 * THAT IS NOT A STYLE POINT, IT IS THE FIRST BUG THIS GATE CAUGHT. The first
 * draft hardcoded `"type"`, which is right on the AM4 and the Axe-Fx II and
 * WRONG on the AX8, where the selector is `effect_type`. The AX8's roster came
 * back empty, every forward shape for that device was skipped, and the run
 * would have reported green for a device whose amp forward lookup carries the
 * same 266-name corpus as the Axe-Fx II. The self-coverage assertion below is
 * what surfaced it, which is the entire argument for having one.
 *
 * `dynacab` is the exception: it is not a device block at all, its roster
 * lives on `amp.dynacab_1_cab`, so it carries an explicit source.
 */
const LINEAGE_BLOCK_TYPES: readonly string[] = [
  'amp', 'drive', 'reverb', 'delay', 'compressor', 'phaser', 'chorus', 'flanger', 'wah',
];
const DYNACAB_SOURCE = { blockType: 'dynacab', block: 'amp', param: 'dynacab_1_cab' } as const;

/**
 * MEASURED, NOT GATED, and each for a stated reason. Recorded here so the next
 * pass does not have to re-derive why a number in the table has no ✗ next to
 * it.
 *
 *   get_preset       Its size is driven by what is CURRENTLY LOADED on the
 *                    device, which this gate cannot set (placing a block is a
 *                    write). Measured 23,691 on a 4-block AM4 preset (5,859
 *                    chars/block) and 8,607 on a 5-block Axe-Fx II preset
 *                    (1,635 chars/block, include_channel_state:true). Both
 *                    under. The per-block cost is the number that matters: a
 *                    grid device carries up to 4x12 cells, so a dense preset
 *                    projects past 40 KB, and the gen-3 `location` read
 *                    (`whole_preset`: routing grid, per-channel A/B/C/D types,
 *                    8 scene names, modifiers, scene controllers) is larger
 *                    still and was UNMEASURABLE here because no gen-3 device
 *                    was connected. Warned when close; not failed.
 *   describe_rig     14,915 with the maintainer's rig manifest loaded (the
 *                    manifest is 11,089 of it), 3,442 without. Scales with the
 *                    rig, which is user data this gate cannot reproduce.
 *   find_compatible_types  Worst measured 6,109 (axe-fx-iii amp). Bounded by
 *                    the type roster, which is a few hundred short strings.
 *                    Measured so a future roster explosion is visible.
 *   import_songsterr OVER (72,927 on Michael Jackson "Billie Jean", songsterr
 *                    10586, 17 parts, `{whole_song:true, parts:"all"}`; 42,883
 *                    on 311 "Amber", 24430, 11 parts). NOT gated here because
 *                    it is a live network fetch: a gate that hits songsterr.com
 *                    is flaky by construction and fails on a plane. It needs a
 *                    recorded fixture before it can be gated, and it should be:
 *                    filed as BK-SONGSTERR-RESPONSE-FIXTURE. This is the one
 *                    of the four original findings still unfixed.
 *   scan_locations   5,933 for the AM4's full A01-Z04 range (all 104
 *                    locations), comfortably under. NOT called on the Axe-Fx II
 *                    by this gate: the gen-2 reader implements it as a
 *                    switch_preset + GET_PRESET_NAME loop
 *                    (packages/fractal-gen2/src/descriptor/reader.ts), so it
 *                    moves the player's active preset. Its range is capped at
 *                    64 there anyway.
 */
const MEASURED_NOT_GATED = true;
void MEASURED_NOT_GATED;

interface Finding { where: string; message: string }
interface Row {
  tool: string;
  shape: string;
  chars: number;
  gated: boolean;
  /**
   * True for a row that is a PROJECTION rather than a measured response. A
   * projection over the cliff is the reason paging has to exist, not a
   * violation of it, so it must not render with the same ✗ as a real response
   * that blacked out. A table row that contradicts the verdict printed under
   * it is how a future reader concludes the gate is broken and stops trusting
   * it.
   */
  projection?: boolean;
}

const compact = (text: string): number => {
  try { return JSON.stringify(JSON.parse(text)).length; } catch { return text.length; }
};

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], stderr: 'pipe' });
  const client = new Client({ name: 'response-budget', version: '0.1.0' });
  await client.connect(transport);

  const failures: Finding[] = [];
  const warnings: Finding[] = [];
  const unchecked: string[] = [];
  const rows: Row[] = [];
  let measured = 0;

  const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; json: any; threw: boolean }> => {
    try {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
      const text = (res as { content?: { text?: string }[] }).content?.[0]?.text ?? '';
      let json: any; try { json = JSON.parse(text); } catch { /* size still counts */ }
      return { text, json, threw: false };
    } catch (e) {
      return { text: e instanceof Error ? e.message : String(e), json: undefined, threw: true };
    }
  };

  /** Measure one response, table it, and return its compact size (-1 if it refused). */
  const size = (tool: string, shape: string, r: { text: string; threw: boolean }, gated: boolean): number => {
    if (r.threw) return -1;
    const n = compact(r.text);
    measured++;
    rows.push({ tool, shape, chars: n, gated });
    return n;
  };

  const checkCliff = (tool: string, shape: string, n: number, remedy: string): void => {
    if (n < 0) return;
    if (n > HOST_DELIVERY_MAX_CHARS) {
      failures.push({
        where: tool,
        message: `${shape} is ${n} chars, PAST THE ${HOST_DELIVERY_MAX_CHARS} DELIVERY CLIFF, so the model receives NONE of it. `
          + 'The host swaps the whole result for a sidecar file path an MCP-only agent has no tool to open, and past 50,001 chars '
          + `not even a preview survives. ${remedy}`,
      });
    } else if (n > HOST_DELIVERY_MAX_CHARS - WARN_MARGIN_CHARS) {
      warnings.push({ where: tool, message: `${shape} is ${n} chars, only ${HOST_DELIVERY_MAX_CHARS - n} under the cliff. The next content addition here costs the whole response, not part of it.` });
    }
  };

  /** Every (block, name) the device registers, walking the list_params pager. */
  const everyParam = async (id: string, blocks: string[]): Promise<{ block: string; name: string }[]> => {
    const out: { block: string; name: string }[] = [];
    for (const b of blocks) {
      let json = (await call('list_params', { port: id, block: [b] })).json;
      let names: string[] = (json?.params ?? []).map((x: { name: string }) => x.name);
      let guard = 0;
      while (json?.truncated !== undefined && guard++ < 40) {
        const pg = await call('list_params', { port: id, block: [b], offset: json.truncated.next_offset });
        json = pg.json;
        names = names.concat((json?.params ?? []).map((x: { name: string }) => x.name));
      }
      for (const n of names) out.push({ block: b, name: n });
    }
    return out;
  };

  try {
    const rig = await call('describe_rig', {});
    const devices: { id: string; connected?: boolean }[] = rig.json?.devices ?? [];
    if (devices.length === 0) throw new Error('describe_rig returned no devices; is the build current?');
    if (devices.length < EXPECTED_DEVICE_COUNT) {
      failures.push({
        where: '(roster)',
        message: `describe_rig returned ${devices.length} devices, fewer than the ${EXPECTED_DEVICE_COUNT} this gate expects. `
          + 'Every leg below is driven by that roster, so a device that stops registering silently stops being size-checked while '
          + 'this gate still reports green. Raise EXPECTED_DEVICE_COUNT only when a device is deliberately retired.',
      });
    }
    size('describe_rig', '{} (manifest as configured)', rig, false);
    checkCliff('describe_rig', '{}', compact(rig.text), 'The rig manifest is the growing part; move declared-but-unconnected detail behind describe_device.');

    // ── LEG 1: lookup_lineage FORWARD ────────────────────────────────
    let lineageDevices = 0;
    let lineageShapes = 0;
    for (const d of devices) {
      const dd = await call('describe_device', { port: d.id });
      if (dd.json?.capabilities?.supports_lineage !== true) continue;
      lineageDevices++;
      let shapesHere = 0;

      // The type-selector name is per device (`type` on AM4/II, `effect_type`
      // on AX8), so take it from the census rather than assuming it.
      const census = await call('list_params', { port: d.id });
      const summary: { block: string; type_selector?: string }[] = census.json?.block_summary ?? [];
      const sources: { blockType: string; block: string; param: string }[] = [];
      for (const bt of LINEAGE_BLOCK_TYPES) {
        const entry = summary.find((s) => s.block === bt);
        if (entry?.type_selector === undefined) continue;
        sources.push({ blockType: bt, block: entry.block, param: entry.type_selector });
      }
      if (summary.some((s) => s.block === DYNACAB_SOURCE.block)) sources.push({ ...DYNACAB_SOURCE });

      for (const src of sources) {
        const lp = await call('list_params', { port: d.id, block: [src.block], name: [src.param] });
        const ev = (lp.json?.params ?? [])[0]?.enum_values;
        // enum_values is an ORDINAL-KEYED OBJECT, not an array. Reading it as
        // an array yields [] and silently skips the whole leg, which is how
        // the first pass at this measurement missed the biggest finding in it.
        const names: string[] = ev === undefined ? [] : Array.isArray(ev) ? ev : Object.values(ev as Record<string, string>);
        if (names.length === 0) continue;

        for (const quotes of [true, false]) {
          const shape = `lookup_lineage({port:"${d.id}", block_type:"${src.blockType}", name:[ALL ${names.length} values of ${src.block}.${src.param}], include_quotes:${quotes}})`;
          const first = await call('lookup_lineage', { port: d.id, block_type: src.blockType, name: names, include_quotes: quotes });
          const n = size('lookup_lineage', shape, first, true);
          if (n >= 0) { shapesHere++; lineageShapes++; }
          checkCliff('lookup_lineage', shape, n,
            'The FORWARD path materialises one full record per name, while the REVERSE path is capped at 10 hits '
            + '(matches.slice(0, 10) in fractal-midi/src/shared/lineageLookup.ts). `include_quotes:false` does NOT rescue it '
            + '(the AM4 amp roster is still 117,451 chars without quotes). Fit the forward batch to a budget and report the '
            + 'remainder the way list_params reports `truncated` / `next_offset`. Note that the tool description actively tells '
            + 'agents to "Batch all names in one call", so the cap must come with the argument that fetches the rest.');
          if (first.threw || first.json === undefined) continue;

          // Silent shortening, checked before the pager walk: a response that
          // carries fewer entries than the caller asked for and does not say
          // so is the failure this whole gate exists to prevent, one layer in.
          const firstEntries = (first.json.entries ?? []) as { name?: string }[];
          if (firstEntries.length < names.length && first.json.truncated === undefined) {
            failures.push({
              where: `lookup_lineage/${d.id}`,
              message: `${shape} returned ${firstEntries.length} of the ${names.length} names asked for and did NOT set \`truncated\`. `
                + 'The agent has no way to know the batch was cut, so it reports a partial roster to the user as the whole one.',
            });
            continue;
          }
          if (first.json.truncated === undefined) continue;

          // The pager itself. Walk it to the end and require that it advances
          // and loses nothing: an agent that follows a stalled `next_offset`
          // loops, and one that follows a lossy pager believes it has read a
          // roster it has not.
          const seen = new Set<string>(firstEntries.map((e) => String(e.name)));
          let cursor: number = first.json.truncated.next_offset;
          let guard = 0;
          let broken = false;
          while (guard++ < 40) {
            const pg = await call('lookup_lineage', { port: d.id, block_type: src.blockType, name: names, include_quotes: quotes, offset: cursor });
            const pgChars = size('lookup_lineage', `PAGE ${d.id}/${src.blockType} at offset:${cursor} (include_quotes:${quotes})`, pg, true);
            if (pgChars >= 0) lineageShapes++;
            checkCliff('lookup_lineage', `page at offset:${cursor} of ${d.id} ${src.blockType}`, pgChars, 'Every page has to fit, not only the first one.');
            const got = (pg.json?.entries ?? []) as { name?: string }[];
            if (got.length === 0) {
              failures.push({ where: `lookup_lineage/${d.id}`, message: `paging ${src.blockType} at offset:${cursor} returned zero entries while ${names.length - seen.size} names were still outstanding. The pager dead-ends before the roster does.` });
              broken = true;
              break;
            }
            for (const e of got) seen.add(String(e.name));
            const next = pg.json?.truncated?.next_offset;
            if (typeof next !== 'number') break;
            if (next <= cursor) {
              failures.push({ where: `lookup_lineage/${d.id}`, message: `the ${src.blockType} pager STALLED: offset ${cursor} answered with next_offset ${next}, which does not advance. An agent following it loops forever.` });
              broken = true;
              break;
            }
            cursor = next;
          }
          if (!broken && seen.size < names.length) {
            failures.push({
              where: `lookup_lineage/${d.id}`,
              message: `walking the ${src.blockType} pager to the end yielded ${seen.size} distinct names of the ${names.length} requested. `
                + 'A pager that silently drops entries is worse than no pager: the agent believes it has seen the whole roster.',
            });
          }
        }
      }

      if (shapesHere === 0) {
        failures.push({
          where: `lookup_lineage/${d.id}`,
          message: `${d.id} reports capabilities.supports_lineage:true but yielded NO measurable forward shape, so this leg `
            + 'iterated zero times for it and nothing was size-checked. That is a self-disabling gate, not a passing device. '
            + 'Two things produce exactly this silence, and both have happened here: the census stopped reporting a '
            + '`type_selector` for the lineage blocks (the AX8 calls its selector `effect_type`, not `type`), or `enum_values` '
            + 'stopped being an ordinal-keyed OBJECT and was read as an array.',
        });
      }
    }
    if (lineageDevices === 0) {
      failures.push({ where: 'lookup_lineage', message: 'No device reported capabilities.supports_lineage:true, so LEG 1 checked nothing at all. The AM4, Axe-Fx II and AX8 all carry a lineage corpus; if that is genuinely gone, delete this leg deliberately rather than letting it pass empty.' });
    }

    // ── LEG 2: list_backups at the schema ceiling ────────────────────
    const probe = await call('list_backups', { limit: LIST_BACKUPS_PROBE_LIMIT });
    const probeEntries: unknown[] = probe.json?.backups ?? [];
    const probeChars = size('list_backups', `{limit:${LIST_BACKUPS_PROBE_LIMIT}}`, probe, true);
    if (probeEntries.length === 0) {
      unchecked.push(`list_backups: the backup folder (${String(probe.json?.directory ?? 'default')}) holds no indexed entries, so the per-entry cost could not be derived and LEG 2 measured nothing. Run this on a machine that has taken a backup.`);
    } else {
      const perEntry = probeChars / probeEntries.length;
      const projected = Math.round(perEntry * LIST_BACKUPS_LIMIT_MAX);
      const crossingAt = Math.max(1, Math.floor(HOST_DELIVERY_MAX_CHARS / perEntry) + 1);
      rows.push({
        tool: 'list_backups',
        shape: `PROJECTION (not a response): ${Math.round(perEntry)} chars/entry x the schema's limit max of ${LIST_BACKUPS_LIMIT_MAX}`
          + `, which is over the cliff, so limit:${LIST_BACKUPS_LIMIT_MAX} MUST page; crossing at limit=${crossingAt}`,
        chars: projected,
        gated: true,
        projection: true,
      });

      // WHAT THE PROJECTION ASSERTS, AND WHY IT CHANGED. It used to demand
      // that perEntry x the schema max fit under the cliff, i.e. that the max
      // be lowered to whatever fits. `executeListBackups` now FITS the rows to
      // a 40,000-char budget and pages the remainder, which bounds the
      // response whatever the per-entry cost turns out to be, so demanding a
      // small max would now be demanding the wrong fix (and would re-break the
      // day an entry grew a field: per-entry cost is not fixed, and a
      // `device` filter measured HEAVIER per row than no filter at all).
      //
      // The projection still earns its place, because it is the one leg that
      // does not depend on how many backups this particular machine holds. It
      // now asserts the CONSEQUENCE rather than the size: if the schema still
      // invites a selection that cannot fit in one response, then the paging
      // machinery must actually be there and must actually fire. A machine
      // without enough entries to reach the crossing cannot witness that, and
      // says so in `unchecked` rather than reporting a green it did not earn.
      const ceilingCall = await call('list_backups', { limit: LIST_BACKUPS_LIMIT_MAX });
      const ceilingTruncated = ceilingCall.json?.truncated;
      if (projected > HOST_DELIVERY_MAX_CHARS) {
        const selected = (ceilingCall.json?.backups ?? []).length;
        const reachable = Number(ceilingCall.json?.total ?? 0) >= crossingAt;
        if (!reachable) {
          unchecked.push(
            `list_backups: at ${Math.round(perEntry)} chars/entry the schema's own limit:${LIST_BACKUPS_LIMIT_MAX} projects to ${projected} chars, `
            + `so a full page CANNOT be delivered and the response must page. This folder holds ${String(ceilingCall.json?.total ?? 0)} entries, `
            + `short of the ${crossingAt} needed to reach the crossing, so the paging leg did not fire and was not witnessed here. `
            + 'Re-run on a machine with a fuller backup folder before calling this surface clean.',
          );
        } else if (ceilingTruncated === undefined) {
          failures.push({
            where: 'list_backups',
            message: `at ${Math.round(perEntry)} chars per entry (measured over ${probeEntries.length} entries at limit:${LIST_BACKUPS_PROBE_LIMIT}), the schema's own maximum of `
              + `limit:${LIST_BACKUPS_LIMIT_MAX} cannot fit one response (projects to ${projected} chars against a ${HOST_DELIVERY_MAX_CHARS} cliff, crossing at limit=${crossingAt}), `
              + `yet the call returned ${selected} entries with NO \`truncated\` block. Either the fit-and-page loop stopped running or it cut the list silently. `
              + 'A page that does not say it is a page is worse than the blackout it replaced: the agent believes it holds every backup and reports so to the user.',
          });
        } else if (typeof ceilingTruncated.next_offset !== 'number' || ceilingTruncated.next_offset <= 0) {
          failures.push({
            where: 'list_backups',
            message: `the ceiling call reported \`truncated\` but its next_offset is ${JSON.stringify(ceilingTruncated.next_offset)}, which cannot advance a pager. `
              + 'A truncation marker whose continuation argument does not move is a loop, not a page.',
          });
        }
      }

      // And the real folder, at the real ceiling, filtered and not: rule 6
      // says a narrowed call is not automatically the smaller one.
      for (const args of [{ limit: LIST_BACKUPS_LIMIT_MAX }, { limit: LIST_BACKUPS_LIMIT_MAX, device: 'circuit' }, { limit: LIST_BACKUPS_LIMIT_MAX, include_missing: true }]) {
        const r = await call('list_backups', args);
        const shape = `list_backups(${JSON.stringify(args)})`;
        const n = size('list_backups', shape, r, true);
        const returned = (r.json?.backups ?? []).length;
        checkCliff('list_backups', `${shape} over ${returned} entries of ${String(r.json?.total ?? '?')} indexed`, n,
          'The response must fit its budget and page the remainder the way list_params does; returning exactly as many entries '
          + 'as `limit` asks for, however heavy they are, is what put it over.');
        // Silent shortening is the failure this leg exists for, not size alone.
        if (!r.threw && returned > 0 && returned < Math.min(LIST_BACKUPS_LIMIT_MAX, Number(r.json?.total ?? 0)) && r.json?.truncated === undefined) {
          failures.push({
            where: 'list_backups',
            message: `${shape} returned ${returned} of ${String(r.json?.total ?? '?')} indexed entries and did NOT set \`truncated\`. `
              + 'Whatever cut the list, the caller has no way to know it was cut or how to ask for the rest, and every downstream '
              + '"here is everything you have backed up" is then wrong.',
          });
        }
      }

      // The pager itself, on the widest selection. A pager that stalls or
      // drops rows is worse than none: the agent believes it walked the list.
      if (ceilingTruncated !== undefined && typeof ceilingTruncated.next_offset === 'number' && ceilingTruncated.next_offset > 0) {
        const seen = new Set<string>();
        for (const b of (ceilingCall.json?.backups ?? []) as { file_name?: string }[]) seen.add(String(b.file_name));
        let cursor: number = ceilingTruncated.next_offset;
        let guard = 0;
        let lossy = false;
        while (guard++ < 40) {
          const pg = await call('list_backups', { limit: LIST_BACKUPS_LIMIT_MAX, offset: cursor });
          const pgChars = size('list_backups', `PAGE at offset:${cursor}`, pg, true);
          checkCliff('list_backups', `page at offset:${cursor}`, pgChars, 'Every page must fit, not just the first.');
          const got = (pg.json?.backups ?? []) as { file_name?: string }[];
          if (got.length === 0) { lossy = true; break; }
          for (const b of got) seen.add(String(b.file_name));
          const next = pg.json?.truncated?.next_offset;
          if (typeof next !== 'number') break;
          if (next <= cursor) {
            failures.push({ where: 'list_backups', message: `the pager STALLED: offset ${cursor} answered with next_offset ${next}, which does not advance. An agent following it loops forever.` });
            lossy = true;
            break;
          }
          cursor = next;
        }
        const expected = Math.min(LIST_BACKUPS_LIMIT_MAX, Number(ceilingCall.json?.total ?? 0));
        if (!lossy && seen.size < expected) {
          failures.push({
            where: 'list_backups',
            message: `walking the pager to the end yielded ${seen.size} distinct entries where the selection held ${expected}. `
              + 'A pager that silently drops rows is worse than no pager, because the agent believes it holds the whole list.',
          });
        }
      }
    }

    // ── LEG 3: get_params, connected devices only ────────────────────
    const connected = devices.filter((d) => d.connected === true);
    if (connected.length === 0) {
      unchecked.push(
        `get_params / get_preset: no device reported connected, so the hardware legs measured nothing. get_params now REFUSES a batch over `
        + `${GET_PARAMS_MAX_QUERIES} queries, which is what closes the 149,443-char (AM4) / 208,649-char (Axe-Fx II) whole-catalog blackout, but that refusal `
        + 'and the size of a batch AT the cap have not been exercised against real hardware. A clean run without these legs is not a clean surface.',
      );
    }
    for (const d of connected) {
      const census = await call('list_params', { port: d.id });
      const blocks: string[] = (census.json?.block_summary ?? []).map((b: { block: string }) => b.block);
      if (blocks.length === 0) {
        failures.push({ where: `get_params/${d.id}`, message: 'the list_params census listed no blocks, so no get_params batch could be built and this device was not size-checked at all.' });
        continue;
      }
      const all = await everyParam(d.id, blocks);
      if (all.length === 0) {
        failures.push({ where: `get_params/${d.id}`, message: `the census lists ${blocks.length} blocks but yielded zero param rows, so the get_params leg iterated zero times for this device.` });
        continue;
      }

      // A batch wider than the cap must be REFUSED, not attempted. Unlike the
      // other three tools, trimming this one's response after the fact would
      // mean spending the wire time and throwing the reads away, so the
      // contract is a refusal before the first frame goes out. What this leg
      // checks is that the refusal actually happens and that it happens
      // WITHOUT reading: a cap that still performs 894 round-trips before
      // saying no has fixed the size and left the half-minute of silence.
      const overCap = all.slice(0, GET_PARAMS_MAX_QUERIES + 1);
      if (all.length > GET_PARAMS_MAX_QUERIES) {
        const startedAt = process.hrtime.bigint();
        const refusal = await call('get_params', { port: d.id, queries: overCap });
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const refused = refusal.threw || refusal.json?.ok === false || /more than the/.test(refusal.text);
        if (!refused) {
          failures.push({
            where: `get_params/${d.id}`,
            message: `a batch of ${overCap.length} queries (cap ${GET_PARAMS_MAX_QUERIES}) was ACCEPTED. The whole-catalog read measured 149,443 chars on the AM4 `
              + 'and 208,649 on the Axe-Fx II, both past the delivery cliff, so the device performs every round-trip and the model receives nothing at all.',
          });
        } else if (elapsedMs > 1_000) {
          failures.push({
            where: `get_params/${d.id}`,
            message: `the over-cap batch was refused, but only after ${Math.round(elapsedMs)} ms, which is long enough that reads were performed first. `
              + 'The refusal has to come before any wire work: its whole point is that the user does not wait for an answer that cannot be delivered.',
          });
        }
      }

      // At the cap, on a real device: the largest batch the contract permits
      // must actually fit. This is the number that would move if a reader
      // grew its per-read payload (`raw_response` is roughly 40% of a row).
      const atCap = all.slice(0, Math.min(GET_PARAMS_MAX_QUERIES, all.length));
      const shapeCap = `get_params({port:"${d.id}", queries: ${atCap.length} = the ${GET_PARAMS_MAX_QUERIES}-query cap})`;
      const nCap = size('get_params', shapeCap, await call('get_params', { port: d.id, queries: atCap }), true);
      checkCliff('get_params', shapeCap, nCap,
        `The cap is set at ${GET_PARAMS_MAX_QUERIES} against a measured ~167 chars/read on the AM4 and ~185 on the Axe-Fx II, which left about 2x of margin. `
        + 'If the largest permitted batch no longer fits, the per-read payload grew (`raw_response` is the bulk of a row) and the cap has to come down with it.');

      const anchorBlocks = ['amp', 'drive', 'delay', 'reverb'].filter((b) => blocks.includes(b));
      const anchor = all.filter((q) => anchorBlocks.includes(q.block)).slice(0, GET_PARAMS_MAX_QUERIES);
      if (anchor.length > 0) {
        const shape = `get_params({port:"${d.id}", queries: ${anchor.length} x params of ${anchorBlocks.join('+')}, capped})`;
        const n = size('get_params', shape, await call('get_params', { port: d.id, queries: anchor }), true);
        checkCliff('get_params', `${shape} (the tone-build state anchor its own description names)`, n,
          'Note what is IN each row: `raw_response` carries the full SysEx byte array per read, which is wire-format detail the '
          + 'display-first contract says never leaks through tool I/O, and it is roughly 40% of the payload. Moving it behind a '
          + 'flag is the cheapest remaining saving and costs no capability, but it is a contract change with a live consumer '
          + '(scripts/probe-ii-pitch-domain.ts decodes the II pitch map out of exactly that frame), so it needs a caller audit first.');
      }

      // Measured, not gated. See MEASURED_NOT_GATED.
      for (const ics of [false, true]) {
        const r = await call('get_preset', { port: d.id, include_channel_state: ics });
        const shape = `get_preset({port:"${d.id}", include_channel_state:${ics}})`;
        const n = size('get_preset', shape, r, false);
        const slots = (r.json?.slots ?? []) as unknown[];
        if (n > HOST_DELIVERY_MAX_CHARS) {
          failures.push({ where: 'get_preset', message: `${shape} is ${n} chars over ${slots.length} block(s), past the cliff. Unlike the other legs this one is driven by what is loaded on the device, so it is normally only warned about: if it FAILED, a real preset just blacked out.` });
        } else if (n > HOST_DELIVERY_MAX_CHARS - WARN_MARGIN_CHARS) {
          warnings.push({ where: 'get_preset', message: `${shape} is ${n} chars over ${slots.length} block(s), inside ${WARN_MARGIN_CHARS} of the cliff.` });
        }
        if (slots.length > 0) {
          const perBlock = Math.round(JSON.stringify(slots).length / slots.length);
          rows.push({ tool: 'get_preset', shape: `PER-BLOCK COST on ${d.id} (include_channel_state:${ics}): ${perBlock} chars x ${slots.length} loaded block(s)`, chars: perBlock, gated: false });
        }
      }
    }
  } finally {
    await client.close();
  }

  // ── output ────────────────────────────────────────────────────────
  rows.sort((a, b) => b.chars - a.chars);
  console.log('unbounded read-response budget (model-facing = compact chars)\n');
  console.log(`  cliff ${HOST_DELIVERY_MAX_CHARS} · every row states the ARGUMENT SHAPE it measured\n`);
  console.log('  tool                 chars   gated  shape');
  console.log('  ' + '-'.repeat(116));
  for (const r of rows) {
    const flag = r.projection === true
      ? (r.chars > HOST_DELIVERY_MAX_CHARS ? '→ pages' : '       ')
      : r.chars > HOST_DELIVERY_MAX_CHARS ? '✗ OVER' : r.chars > HOST_DELIVERY_MAX_CHARS - WARN_MARGIN_CHARS ? '~close' : '      ';
    console.log(`  ${r.tool.padEnd(18)} ${String(r.chars).padStart(7)}  ${r.gated ? 'hard' : 'soft'}  ${flag} ${r.shape}`);
  }

  console.log('');
  if (measured < MIN_SHAPES_MEASURED) {
    failures.push({
      where: '(coverage)',
      message: `this run measured only ${measured} responses, below the ${MIN_SHAPES_MEASURED} floor. Every leg here derives its `
        + 'work list from a response under test, so a shrinking census or an empty roster makes the whole file pass while checking '
        + 'nothing. Find out what stopped yielding shapes before lowering this number.',
    });
  }
  console.log(`  measured ${measured} response shapes (floor ${MIN_SHAPES_MEASURED})`);
  for (const u of unchecked) console.log(`  ○ UNCHECKED: ${u}`);
  for (const w of warnings) console.log(`  ⚠ ${w.where}: ${w.message}`);
  for (const f of failures) console.log(`  ✗ ${f.where}: ${f.message}`);

  if (REPORT_ONLY) { console.log('\n--report: exit 0 regardless.'); return; }
  if (failures.length > 0) {
    console.log(`\nFAIL: ${failures.length} response-budget violation(s).`);
    process.exit(1);
  }
  console.log(`\nOK: every measured response within budget${warnings.length > 0 ? `, ${warnings.length} warning(s)` : ''}${unchecked.length > 0 ? `, ${unchecked.length} leg(s) UNCHECKED (see above; this is not a clean surface)` : ''}.`);
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
