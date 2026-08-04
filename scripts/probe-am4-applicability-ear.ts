/**
 * probe-am4-applicability-ear.ts: does the AM4 actually honour the mined
 * applicability gates?
 *
 * TWO MODES, and `--visual` is the one you almost certainly want. See the
 * CORRECTED note below: the ear mode answers a different question than the one
 * the 112-param change actually made.
 *
 * WHY THIS EXISTS, AND WHY THE AUTOMATED VERSION DOES NOT.
 * On 2026-08-02 `describeApplicability` was corrected so that `list_params`
 * reports what `set_param` enforces: when a param carries primary-type gates,
 * that gate list is the authoritative set of amp types exposing the knob. 112
 * AM4 params changed from "applies to any type" to gated. That correction is
 * derived from `typeApplicability.ts`, which was MINED from AM4-Edit, not
 * measured on hardware. If the mined lists are wrong, `list_params` now tells
 * users a knob is unavailable when it works.
 *
 * `scripts/probe-am4-applicability-hw.ts` tried to settle this automatically
 * and CANNOT, by construction. The AM4 accepts and STORES a write to a knob the
 * active type does not expose; it just does not route the value to the DSP. So
 * `get_param` echoes the write back on gated and ungated types alike and the
 * off-gate leg can never fail. That probe reported "GATE TOO NARROW" on 5 of 5
 * params, which is an artifact of the wrong oracle, not a finding. The
 * codebase already said so: `preflightApplicabilityWarning` reads "The firmware
 * accepts the write on any type but it may not be audible on the current type."
 *
 * ⚠ CORRECTED 2026-08-04: THIS PROBE ANSWERS A DIFFERENT QUESTION THAN THE ONE
 * THE 112-PARAM CHANGE MADE, AND IT IS THE HARDER ONE. Read this before
 * reaching for it.
 *
 * Two propositions were being conflated:
 *
 *   P1  "AM4-Edit's UI exposes this control for these amp types."
 *       This is LITERALLY what TYPE_APPLICABILITY encodes: its own docstring
 *       says the table was decoded from the AM4-Edit BinaryData
 *       `__block_layout(.expert).xml` <Page>/<EditorControl> per-type filter
 *       attributes, and that `always: false` means "only these types expose
 *       the knob IN AM4-EDIT'S UI".
 *   P2  "An off-gate write is inaudible."
 *       This is what the WRITE-PATH warning claims ("The firmware accepts the
 *       write on any type but it may not be audible on the current type").
 *
 * The 2026-08-02 correction changed how `list_params` RENDERS P1. It re-mined
 * nothing: it re-read the existing table, branching on primary-type gates even
 * when `always: true`. So its failure mode is a READING error (wrong branch,
 * misjoined <Page>/<EditorControl> rows, wrong enum index), and the direct
 * oracle for a reading of the editor's own table is THE EDITOR'S UI. That is a
 * visual, deterministic check taking seconds per param, with no ears involved.
 *
 * This probe tests P2, which is a real and separate question but is NOT what
 * the 112 params asserted, and it is the noisier test by far. Prefer the UI
 * check for P1. Reach for this one only when the question genuinely is
 * "does an off-gate write do anything audible", which nothing currently ships
 * a claim about beyond that one warning sentence.
 *
 * WHAT THE UI CHECK CANNOT SETTLE: whether AM4-Edit is itself wrong about the
 * device. For that, the AM4's own FRONT PANEL parameter pages are the better
 * oracle (device-sourced, and still visual), and only then an ear. `--visual`
 * accepts either surface; it just asks whether the control is SHOWN.
 *
 * INTERACTIVE BY REQUIREMENT, not by preference. Per the CLAUDE.md probe rule,
 * a probe that asks the maintainer to judge the device waits on Enter and never
 * on a timer: you cannot reliably listen and watch a countdown at once.
 *
 * SAFETY. Working buffer only. Never calls `save_preset`. Restores `amp.type`
 * and every knob it touched on exit, including Ctrl-C. Switching presets on the
 * device discards everything this does anyway.
 *
 *   npx tsx scripts/probe-am4-applicability-ear.ts --visual      # START HERE
 *   npx tsx scripts/probe-am4-applicability-ear.ts --visual --params=fat,geq_band_1
 *   npx tsx scripts/probe-am4-applicability-ear.ts               # the P2 ear mode
 *
 * PRE-FLIGHT, BOTH MODES: AM4 connected and an AMP block PLACED on the active
 * preset. Writing to an UNPLACED block is invisible (the AM4 phantom-param
 * blind spot) and would read here as a false "gate honoured".
 *
 * PRE-FLIGHT, `--visual`: have AM4-Edit OPEN on the amp block (HW-052 confirms
 * it stays live while this drives the port), or watch the front panel. No
 * audio needed.
 *
 * PRE-FLIGHT, ear mode: AM4-Edit CLOSED, and you able to HEAR the device.
 */
import path from 'node:path';
import readline from 'node:readline';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TYPE_APPLICABILITY, AMP_TYPES } from 'fractal-midi/am4';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');
const PORT = 'am4';
const argParams = process.argv.find((a) => a.startsWith('--params='))?.split('=')[1];

/**
 * `--visual`: ask what is VISIBLE rather than what is audible.
 *
 * This is the mode to use for the 112-param correction, because that change is
 * about P1 ("AM4-Edit's UI exposes this control for these types"), which is
 * literally what TYPE_APPLICABILITY encodes. See the header.
 *
 * THE ORACLE IS AM4-EDIT, AND IT CAN BE OPEN WHILE THIS RUNS. That is
 * hardware-established, not assumed: HW-052 (closed 2026-05-04, "Outcome A,
 * works fine both ways") had AM4-Edit open and in focus while MCP
 * `apply_preset` writes landed, and AM4-Edit's display reflected them in REAL
 * TIME, with no port conflict. So the editor updates live as this probe
 * changes `amp.type`, which makes it both the correct oracle and a convenient
 * one. This probe deliberately does NOT use `scripts/_lib/editor-guard.ts`.
 *
 * The caveat that IS real, and the reason the guard exists elsewhere: the
 * 2026-06-09 wedge incident (a 43-minute harvest hang that froze the MIDI
 * layer) was editor contention under HEAVY SUSTAINED traffic. This probe sends
 * a handful of writes and waits on a human between each, so it is nothing like
 * that load. If the editor or the device does go unresponsive, quit both and
 * say so, because that would be new evidence against HW-052.
 *
 * The AM4 FRONT PANEL is the fallback oracle and the stronger one for a
 * different question (it is device-sourced, so it can catch AM4-Edit being
 * wrong about the device). Whether the panel filters its parameter pages by
 * amp type at all is NOT established, which is why the on-gate leg runs first
 * and aborts the param if the oracle cannot even say YES.
 */
const VISUAL = process.argv.includes('--visual');

/**
 * Defaults chosen for a SMALL exposed set. A knob exposed on 9 of 248 types
 * gives a decisive off-gate choice; one exposed on 246 of 248 would make the
 * off-gate leg hinge on two specific models being reachable.
 */
const DEFAULT_PARAMS = ['fat', 'geq_band_1', 'negative_fb'];

interface Verdict {
  param: string;
  exposed: number;
  offType: string;
  onType: string;
  offHeard: string;
  onHeard: string;
}

async function main(): Promise<void> {
  const wanted = (argParams ?? DEFAULT_PARAMS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], stderr: 'pipe' });
  const client = new Client({ name: 'am4-applicability-ear', version: '0.1.0' });
  await client.connect(transport);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    try {
      const r = await client.callTool({ name, arguments: args }) as { content?: { text?: string }[] };
      try { return JSON.parse(r.content?.[0]?.text ?? '{}'); } catch { return {}; }
    } catch { return {}; }
  };
  const write = (name: string, value: unknown) => call('set_param', { port: PORT, block: 'amp', name, value });

  let originalType: unknown;
  const restore: { name: string; value: unknown }[] = [];
  const cleanup = async (): Promise<void> => {
    for (const r of restore.reverse()) await write(r.name, r.value);
    if (originalType !== undefined) await write('type', originalType);
    console.log('\n  Restored amp.type and every knob touched. Nothing was saved.');
  };
  process.on('SIGINT', () => { void cleanup().then(() => { rl.close(); process.exit(130); }); });

  const verdicts: Verdict[] = [];
  try {
    const t0 = await call('get_param', { port: PORT, block: 'amp', name: 'type' });
    if (t0.display_value === undefined) {
      console.log('  Could not read amp.type. Is the AM4 connected, AM4-Edit closed, and an AMP block placed?');
      return;
    }
    originalType = t0.display_value;

    console.log('AM4 applicability, BY EAR (working buffer only, restored, never saved)\n');
    console.log(`  active amp.type at start: ${String(originalType)}`);
    console.log('  You will be asked, for each knob, whether sweeping it CHANGED THE SOUND.');
    console.log('  Answer y or n. "n" on the off-gate type and "y" on the on-gate type');
    console.log('  means the mined gate is CORRECT. Anything else is a finding.\n');
    await ask('  Press Enter when you can hear the AM4... ');

    for (const pname of wanted) {
      const a = TYPE_APPLICABILITY[`amp.${pname}`];
      if (a === undefined) { console.log(`  amp.${pname}: no applicability data, skipping`); continue; }
      const exposed = new Set<number>();
      for (const g of a.gates) {
        if (g.typeEnum === 'DISTORT_TYPE' || g.typeEnum === 'AMP_TYPE') for (const v of g.values) exposed.add(v);
      }
      if (exposed.size === 0 || exposed.size >= AMP_TYPES.length) {
        console.log(`  amp.${pname}: no primary gate, nothing to test`); continue;
      }
      const onIdx = [...exposed].sort((x, y) => x - y)[0];
      let offIdx = -1;
      for (let i = 0; i < AMP_TYPES.length; i++) if (!exposed.has(i)) { offIdx = i; break; }

      const cur = await call('get_param', { port: PORT, block: 'amp', name: pname });
      if (cur.display_value !== undefined && !restore.some((r) => r.name === pname)) {
        restore.push({ name: pname, value: cur.display_value });
      }
      const lo = Number(cur.display_min ?? 0);
      const hi = Number(cur.display_max ?? 10);

      console.log(`\n  === amp.${pname} (mined as exposed on ${exposed.size} of ${AMP_TYPES.length} amp types) ===`);

      let offHeard: string;
      let onHeard: string;

      if (VISUAL) {
        // ── VISUAL MODE: the ON-GATE leg runs FIRST, on purpose ──────────
        //
        // It is this probe's oracle check. The whole mode assumes the AM4's
        // FRONT PANEL hides a control that the active amp type does not
        // expose, and nobody has established that it does. If the control is
        // absent on a type the table says EXPOSES it, then the panel either
        // does not surface this knob at all or does not discriminate by type,
        // and every off-gate "it's absent" answer after that would be
        // meaningless agreement. So: prove the oracle can say YES before
        // trusting it to say NO.
        await write('type', AMP_TYPES[onIdx]);
        console.log(`  amp.type set to "${AMP_TYPES[onIdx]}" (table says this type EXPOSES ${pname}).`);
        onHeard = (await ask(`    Is "${pname}" shown for this amp in AM4-Edit (or the front panel)? (y/n) `)).trim().toLowerCase();
        if (!onHeard.startsWith('y')) {
          console.log(`    -> Oracle unusable for ${pname}: absent even where the table says it is EXPOSED.`);
          console.log('       Either this surface does not show the knob at all, or it does not filter by');
          console.log('       amp type. Skipping the off-gate leg, which could only produce a false pass.');
          verdicts.push({ param: pname, exposed: exposed.size, offType: AMP_TYPES[offIdx], onType: AMP_TYPES[onIdx], offHeard: 'skipped', onHeard });
          continue;
        }
        await write('type', AMP_TYPES[offIdx]);
        console.log(`  amp.type set to "${AMP_TYPES[offIdx]}" (table says this type does NOT expose it).`);
        offHeard = (await ask(`    Is "${pname}" STILL shown for this amp? (y/n) `)).trim().toLowerCase();
      } else {
        // OFF-GATE leg: the mined data says this knob does nothing here.
        await write('type', AMP_TYPES[offIdx]);
        console.log(`  amp.type set to "${AMP_TYPES[offIdx]}" (gate EXCLUDES this type).`);
        await ask('    Press Enter, then listen while I sweep the knob... ');
        await write(pname, lo); await ask(`    set to ${lo}. Enter to continue... `);
        await write(pname, hi);
        offHeard = (await ask(`    set to ${hi}. Did the SOUND change? (y/n) `)).trim().toLowerCase();

        // ON-GATE leg: the positive control. If this does not change the sound
        // either, the knob is inaudible for some other reason and the off-gate
        // answer proves nothing.
        await write('type', AMP_TYPES[onIdx]);
        console.log(`  amp.type set to "${AMP_TYPES[onIdx]}" (gate INCLUDES this type).`);
        await ask('    Press Enter, then listen while I sweep the same knob... ');
        await write(pname, lo); await ask(`    set to ${lo}. Enter to continue... `);
        await write(pname, hi);
        onHeard = (await ask(`    set to ${hi}. Did the SOUND change? (y/n) `)).trim().toLowerCase();
      }

      verdicts.push({
        param: pname, exposed: exposed.size,
        offType: AMP_TYPES[offIdx], onType: AMP_TYPES[onIdx],
        offHeard, onHeard,
      });
    }
  } finally {
    await cleanup();
    rl.close();
    await client.close();
  }

  console.log('\n  param             exposed   off-gate heard   on-gate heard   verdict');
  console.log('  ' + '-'.repeat(74));
  let confirmed = 0, contradicted = 0, inconclusive = 0;
  for (const v of verdicts) {
    const off = v.offHeard.startsWith('y');
    const on = v.onHeard.startsWith('y');
    let verdict: string;
    if (!off && on) { verdict = 'gate CONFIRMED'; confirmed++; }
    else if (off && on) { verdict = 'GATE TOO NARROW (knob works off-gate)'; contradicted++; }
    else if (!off && !on) { verdict = 'inconclusive: control failed, knob inaudible either way'; inconclusive++; }
    else { verdict = 'inconclusive: audible ONLY off-gate, investigate'; inconclusive++; }
    console.log(`  ${v.param.padEnd(17)} ${String(v.exposed).padStart(7)}   ${v.offHeard.padEnd(14)}   ${v.onHeard.padEnd(13)}   ${verdict}`);
  }
  console.log(`\n  ${confirmed} confirmed - ${contradicted} contradicted - ${inconclusive} inconclusive`);
  if (contradicted > 0) {
    console.log('\n  A CONTRADICTED row means the device honoured a knob on a type the mined gate');
    console.log('  EXCLUDES, so typeApplicability.ts under-reports and list_params is telling');
    console.log('  users a knob is unavailable when it works. Record the exact (param, type)');
    console.log('  pairs; do not edit the mined table from a single ear test.');
  }
  if (confirmed > 0 && contradicted === 0) {
    console.log('\n  Every tested gate behaved as mined. That is hardware support for the');
    console.log('  2026-08-02 applicability correction ON THIS SAMPLE. It is a sample, not');
    console.log('  the whole 112.');
  }
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
