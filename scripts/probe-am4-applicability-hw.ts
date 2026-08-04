/**
 * probe-am4-applicability-hw.ts: does the AM4 actually honour the gate lists
 * that `list_params` now reports?
 *
 * ============================================================================
 * THIS PROBE'S ORACLE IS INVALID. DO NOT ACT ON ITS VERDICTS. Kept as a
 * recorded negative result so the next person does not rebuild it.
 *
 * Run 2026-08-02 against a connected AM4 it reported "GATE TOO NARROW" on 5 of
 * 5 params, i.e. the device accepted every off-gate write. That is NOT evidence
 * the mined gate lists are wrong. It is the probe asking the wrong question.
 *
 * APPLICABILITY IS ABOUT AUDIBILITY, NOT STORAGE. The AM4 accepts and STORES a
 * write to a knob the active amp type does not expose; what it does not do is
 * route that value to the DSP. `get_param` reads the stored value, so it
 * echoes the write back on gated and ungated types alike, and the off-gate leg
 * below can never fail. The codebase already says this in as many words:
 * `preflightApplicabilityWarning` in `packages/am4/src/shared/channels.ts`
 * reads "The firmware accepts the write on any type but it may not be audible
 * on the current type." The 2026-05-13 founder observation that the AM4
 * "silently no-ops master writes" on 5F8 Tweed Normal was an observation about
 * SOUND, made at the device, not a readback.
 *
 * So a valid version of this experiment needs an oracle that sees audibility,
 * which means the front panel or an ear, which means a human. There is no
 * automated substitute, and `get_param` is specifically not one. See
 * CLAUDE.md "Verification sources of truth": the front panel is first for
 * exactly this reason.
 *
 * WHAT WOULD ACTUALLY SETTLE IT: an interactive probe (readline, per the
 * CLAUDE.md probe rule) that sets an off-gate type, writes a knob to both
 * extremes, and asks the maintainer whether the tone changed. That is a
 * different script and it should be filed as a hardware task, not automated.
 * ============================================================================
 *
 * WHY. On 2026-08-02 `describeApplicability` was corrected to match
 * `checkApplicability`: when a param carries primary-type gates, that gate list
 * is the AUTHORITATIVE set of amp types exposing the knob, and 112 AM4 params
 * that used to be described as universal are now described as gated. That
 * correction is derived from `typeApplicability.ts`, which was MINED from
 * AM4-Edit rather than measured on hardware. If the mined lists are wrong, the
 * fix replaced prose that was confidently wrong with prose that is confidently
 * wrong in a new direction, and `set_param` refuses writes it should allow.
 *
 * Only the device can settle that, and the device is the oracle here: it
 * echoes its own value back through `get_param`, so no human has to watch a
 * panel. The 2026-05-13 founder test established the MECHANISM (the AM4
 * silently no-ops `amp.master` on 5F8 Tweed Normal); this measures whether the
 * mined membership is right across a SAMPLE, and reports a coverage number
 * instead of a single anecdote.
 *
 * THE EXPERIMENT, per param, with a positive control so a null result cannot
 * be mistaken for a broken probe:
 *   OFF-GATE  set amp.type to a type the gate list EXCLUDES, write a distinct
 *             value, read back. Expect NO CHANGE (device absorbs it).
 *   ON-GATE   set amp.type to a type the gate list INCLUDES, write the same
 *             value, read back. Expect the CHANGE TO STICK.
 * A gate list is confirmed only when BOTH legs behave. Off-gate alone proves
 * nothing (a param could be read-only, or the write path broken); on-gate
 * alone proves nothing about the gate.
 *
 * SAFETY. Working buffer only. It NEVER calls save_preset, and it restores
 * `amp.type` and every param it touched before exiting, including on Ctrl-C.
 * Switching presets on the device discards everything this does anyway.
 *
 *   npx tsx scripts/probe-am4-applicability-hw.ts
 *   npx tsx scripts/probe-am4-applicability-hw.ts --params fat,geq_band_1
 *
 * PRE-FLIGHT: AM4 on and connected, AM4-Edit CLOSED, and an AMP block placed
 * on the active preset. Writing a param on an UNPLACED block is invisible
 * (the AM4 phantom-param blind spot), which would read here as a false
 * "device honoured the gate".
 */
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TYPE_APPLICABILITY, AMP_TYPES } from 'fractal-midi/am4';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');
const PORT = 'am4';
const argParams = process.argv.find((a) => a.startsWith('--params='))?.split('=')[1];

/**
 * Params to test. Chosen for a SMALL exposed set, because a knob exposed on 9
 * of 248 types gives a decisive off-gate choice, whereas one exposed on 246 of
 * 248 makes the off-gate leg depend on two specific models being reachable.
 */
const DEFAULT_PARAMS = ['fat', 'geq_band_1', 'negative_fb', 'overdrive_volume', 'presence_prepresence'];

interface Verdict {
  param: string;
  exposedCount: number;
  offGateType: string;
  onGateType: string;
  offGateHeld: boolean | undefined;
  onGateTook: boolean | undefined;
  note: string;
}

async function main(): Promise<void> {
  const wanted = (argParams ?? DEFAULT_PARAMS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], stderr: 'pipe' });
  const client = new Client({ name: 'am4-applicability-hw', version: '0.1.0' });
  await client.connect(transport);

  const call = async (name: string, args: Record<string, unknown>): Promise<{ ok: boolean; json: any; text: string }> => {
    try {
      const r = await client.callTool({ name, arguments: args }) as { content?: { text?: string }[]; isError?: boolean };
      const text = r.content?.[0]?.text ?? '';
      let json: any = {};
      try { json = JSON.parse(text); } catch { /* text-only */ }
      return { ok: r.isError !== true, json, text };
    } catch (err) {
      return { ok: false, json: {}, text: err instanceof Error ? err.message : String(err) };
    }
  };
  const readParam = async (name: string) => call('get_param', { port: PORT, block: 'amp', name });
  const writeParam = async (name: string, value: unknown) => call('set_param', { port: PORT, block: 'amp', name, value });

  let originalType: unknown;
  const restore: { name: string; value: unknown }[] = [];

  const cleanup = async (): Promise<void> => {
    for (const r of restore.reverse()) await writeParam(r.name, r.value);
    if (originalType !== undefined) await writeParam('type', originalType);
    console.log('\n  Restored amp.type and every param touched. Nothing was saved.');
  };
  process.on('SIGINT', () => { void cleanup().then(() => process.exit(130)); });

  const verdicts: Verdict[] = [];
  try {
    const t0 = await readParam('type');
    if (!t0.ok) {
      console.log(`  Could not read amp.type: ${t0.text.slice(0, 200)}`);
      console.log('  Is the AM4 connected, AM4-Edit closed, and an AMP block placed?');
      return;
    }
    originalType = t0.json.display_value;
    console.log(`AM4 applicability gate validation (working buffer only, no save)\n`);
    console.log(`  active amp.type at start: ${String(originalType)}\n`);

    for (const pname of wanted) {
      const key = `amp.${pname}`;
      const a = TYPE_APPLICABILITY[key];
      if (a === undefined) { verdicts.push({ param: pname, exposedCount: 0, offGateType: '-', onGateType: '-', offGateHeld: undefined, onGateTook: undefined, note: 'no applicability data' }); continue; }
      const exposed = new Set<number>();
      for (const g of a.gates) if (g.typeEnum === 'DISTORT_TYPE' || g.typeEnum === 'AMP_TYPE') for (const v of g.values) exposed.add(v);
      if (exposed.size === 0 || exposed.size >= AMP_TYPES.length) {
        verdicts.push({ param: pname, exposedCount: exposed.size, offGateType: '-', onGateType: '-', offGateHeld: undefined, onGateTook: undefined, note: 'no primary gate, nothing to test' });
        continue;
      }
      const onIdx = [...exposed].sort((x, y) => x - y)[0];
      let offIdx = -1;
      for (let i = 0; i < AMP_TYPES.length; i++) if (!exposed.has(i)) { offIdx = i; break; }
      const onType = AMP_TYPES[onIdx];
      const offType = AMP_TYPES[offIdx];

      const v: Verdict = { param: pname, exposedCount: exposed.size, offGateType: offType, onGateType: onType, offGateHeld: undefined, onGateTook: undefined, note: '' };

      // ── OFF-GATE leg ────────────────────────────────────────────────
      await writeParam('type', offType);
      const beforeOff = await readParam(pname);
      if (!beforeOff.ok) { v.note = `read failed off-gate: ${beforeOff.text.slice(0, 80)}`; verdicts.push(v); continue; }
      const baseline = beforeOff.json.wire_value;
      const probeValue = pickDistinct(beforeOff.json.display_value);
      if (!restore.some((r) => r.name === pname)) restore.push({ name: pname, value: beforeOff.json.display_value });
      const wOff = await writeParam(pname, probeValue);
      const afterOff = await readParam(pname);
      v.offGateHeld = wOff.ok === false || afterOff.json.wire_value === baseline;
      if (wOff.ok === false) v.note = 'server refused the off-gate write (its own gate fired before the wire)';

      // ── ON-GATE leg (positive control) ──────────────────────────────
      await writeParam('type', onType);
      const beforeOn = await readParam(pname);
      const baseOn = beforeOn.json.wire_value;
      const probeOn = pickDistinct(beforeOn.json.display_value);
      const wOn = await writeParam(pname, probeOn);
      const afterOn = await readParam(pname);
      v.onGateTook = wOn.ok && afterOn.json.wire_value !== baseOn;
      verdicts.push(v);
    }
  } finally {
    await cleanup();
    await client.close();
  }

  console.log('\n  param                  exposed  off-gate type          held?   on-gate type           took?   verdict');
  console.log('  ' + '-'.repeat(108));
  let confirmed = 0, contradicted = 0, inconclusive = 0;
  for (const v of verdicts) {
    let verdict: string;
    if (v.offGateHeld === undefined || v.onGateTook === undefined) { verdict = 'INCONCLUSIVE'; inconclusive++; }
    else if (v.offGateHeld && v.onGateTook) { verdict = 'gate CONFIRMED'; confirmed++; }
    else if (!v.offGateHeld && v.onGateTook) { verdict = 'GATE TOO NARROW'; contradicted++; }
    else if (v.offGateHeld && !v.onGateTook) { verdict = 'inconclusive (control failed)'; inconclusive++; }
    else { verdict = 'no write landed at all'; inconclusive++; }
    console.log(
      `  ${v.param.padEnd(22)} ${String(v.exposedCount).padStart(7)}  ${String(v.offGateType).padEnd(21)} ${String(v.offGateHeld ?? '-').padEnd(7)} ${String(v.onGateType).padEnd(22)} ${String(v.onGateTook ?? '-').padEnd(7)} ${verdict}`,
    );
    if (v.note !== '') console.log(`      note: ${v.note}`);
  }
  console.log('');
  console.log(`  ${confirmed} confirmed · ${contradicted} contradicted · ${inconclusive} inconclusive`);
  console.log('');
  console.log('  READ THE HEADER BEFORE BELIEVING ANY OF THE ABOVE. This probe uses get_param as');
  console.log('  its oracle, and get_param reads the STORED value. The AM4 stores off-gate writes');
  console.log('  and simply does not route them to the DSP, so the off-gate leg cannot fail and');
  console.log('  every row will read "GATE TOO NARROW" whether the gate list is right or wrong.');
  console.log('  Applicability is about AUDIBILITY. Settling it needs the front panel or an ear.');
  if (contradicted > 0) {
    console.log('\n  A "GATE TOO NARROW" row means the device ACCEPTED a write on a type the mined');
    console.log('  gate list excludes. That is evidence the mined applicability under-reports, and');
    console.log('  it makes list_params tell users a knob is unavailable when it works. Record the');
    console.log('  exact (param, type) pairs before changing typeApplicability.ts.');
  }
  if (confirmed > 0 && contradicted === 0) {
    console.log('\n  Every tested gate behaved as mined: off-gate writes were absorbed, on-gate writes');
    console.log('  stuck. That is hardware support for the 2026-08-02 applicability correction on');
    console.log('  this sample. It is a SAMPLE, not the whole 112.');
  }
}

/** A value clearly different from `current`, inside a conservative 0..10 band. */
function pickDistinct(current: unknown): number | string {
  const n = Number(current);
  if (Number.isFinite(n)) return n > 5 ? 1 : 9;
  return 1;
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
