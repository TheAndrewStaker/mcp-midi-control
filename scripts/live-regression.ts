/**
 * Live regression suite for the unified MCP tool surface, run end-to-end
 * via the shipped server.
 *
 * Spawns the server-all dist over stdio (real transport, no
 * MCP_MOCK_TRANSPORT) and exercises cross-device contracts against
 * whichever Fractal devices are physically connected. Each test case is
 * self-restoring so the user's preset state is unchanged after the run.
 *
 * Coverage:
 *
 *   AM4 path:
 *     - describe_device(am4).capabilities.atomic_read === false
 *     - set_bypass(amp) refuses with AMP-slot-quirk explanation
 *     - F5 (alpha.11): every channel-bearing get_preset slot uses
 *       params_by_channel (never flat params)
 *
 *   Axe-Fx II path:
 *     - describe_device(axe-fx-ii).capabilities.atomic_read === true
 *     - get_preset(axe-fx-ii) returns PresetSnapshot with _meta, name,
 *       active_scene, slots, channel_status
 *     - get_preset slots carry channel_status='active' on channel-
 *       bearing blocks
 *     - get_param + set_param round-trip lands within Q15 tolerance
 *     - F12 (alpha.11): apply_preset(landingScene:1) → set_params →
 *       set_bypass → get_preset must return active_scene === 1 (live
 *       repro of the alpha.11 scene-drift bug)
 *
 *   Cross-device:
 *     - get_preset(am4) refuses with capability_not_supported and
 *       points at get_param fallback
 *     - Removed tools (toggle_bypass / nudge_param / play_note /
 *       play_chord / rename / hydra_apply_patch) stay removed
 *
 * F12 / F5 added 2026-05-28 as the alpha.11 live-regression block. The
 * desktop-chat session caught both because it composed multi-step
 * sequences against real hardware; this file is where those same
 * sequences live as standing pre-release gates.
 *
 * Removed 2026-05-23 (Session 124): coverage for `toggle_bypass`,
 * `nudge_param`, `play_note`, `play_chord`, `rename`. Those tools
 * were cut entirely; capability-gate refusal tests no longer apply.
 * Replaced with a single "removed-tool regression guard" against
 * the tools/list catalog.
 *
 * Non-destructive: no saves issued, no preset locations overwritten.
 * Mutating tests revert before exit (nudge up then down; set_param
 * snapshot then restore).
 *
 * Run:
 *   npm run live-regression
 *
 * Devices not connected are reported as SKIPPED rather than FAIL.
 * Connection-layer failures (port held by AM4-Edit / AxeEdit, USB
 * disconnect) skip the affected device's cases; the script does not
 * try to reopen or retry.
 *
 * Maintenance: when adding a new MCP tool to the unified surface, add
 * the corresponding live case here. Mock-transport regressions live in
 * scripts/mcp-test-agent-retry-paths.ts (run via verify-agent-retry-paths).
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(
  process.cwd(),
  'packages',
  'server-all',
  'dist',
  'server',
  'index.js',
);

interface CallResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function extractText(r: unknown): string {
  if (!r || typeof r !== 'object') return '<no response>';
  const x = r as CallResult;
  const parts = (x.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!);
  return parts.join('\n');
}
function isError(r: unknown): boolean {
  return !!(r as CallResult)?.isError;
}
function structured(r: unknown): Record<string, unknown> | undefined {
  return (r as CallResult)?.structuredContent;
}

interface CaseResult {
  name: string;
  pass: boolean;
  notes: string[];
  skipped?: boolean;
}
const RESULTS: CaseResult[] = [];

function record(name: string, pass: boolean, notes: string[], skipped = false): void {
  RESULTS.push({ name, pass, notes, skipped });
  const tag = skipped ? '○ SKIP' : pass ? '✓ PASS' : '✗ FAIL';
  console.log(`  ${tag} ${name}`);
  for (const n of notes) console.log(`      ${n}`);
}

/**
 * On failure, dump the tool response's error text so the next reader
 * has context. The most common live-regression failure mode is
 * hardware-side ("AM4 not found in the MIDI device list" when AM4-Edit
 * has the port, USB disconnect, etc.); the error message tells the
 * operator whether it's their setup or a code bug.
 */
function debugOnFail(label: string, response: unknown): string[] {
  const isErr = isError(response);
  if (!isErr) return [];
  const t = extractText(response);
  return [`error_text: ${t.slice(0, 240).replace(/\s+/g, ' ')}`];
}

async function main(): Promise<void> {
  console.log('Session 105 live regression');
  console.log('===========================\n');
  console.log(`Server: ${SERVER_ENTRY}\n`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...(process.env as Record<string, string>) },
    stderr: 'pipe',
  });
  if (transport.stderr) {
    transport.stderr.on('data', (b: Buffer) => {
      const s = b.toString();
      if (/error|throw/i.test(s)) process.stderr.write(`[server] ${s}`);
    });
  }
  const client = new Client(
    { name: 'live-regression-session-105', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);

    // Probe which devices are visible by reading their describe_device.
    // capability_not_supported on the port-resolution layer means the
    // device isn't connected; we skip its cases instead of failing.
    const am4Available = await checkDevice(client, 'am4');
    const axefx2Available = await checkDevice(client, 'axe-fx-ii');
    console.log(`AM4 connected:        ${am4Available ? 'yes' : 'NO (cases will skip)'}`);
    console.log(`Axe-Fx II connected:  ${axefx2Available ? 'yes' : 'NO (cases will skip)'}\n`);

    // ── AM4 atomic_read flag ───────────────────────────────────────
    // Flipped from false → true in Session 122 once fn 0x1F was fully
    // decoded and the per-block chunk layout proved stable across all
    // 17 audio blocks (53/53 position-map matches against captured
    // golden). The reader.getPreset path uses it; updating the
    // assertion here matched that shipping change.
    if (am4Available) {
      console.log('AM4 atomic_read capability flag');
      const r = await client.callTool({ name: 'describe_device', arguments: { port: 'am4' } });
      const sc = structured(r);
      const caps = sc?.['capabilities'] as Record<string, unknown> | undefined;
      const flag = caps?.['atomic_read'];
      const notes = [`atomic_read = ${JSON.stringify(flag)}`];
      record('describe_device(am4).capabilities.atomic_read === true', flag === true, notes);
    } else {
      record('describe_device(am4).capabilities.atomic_read', false, [], true);
    }

    // ── AM4 AMP-slot refusal: set_bypass ────────────
    // Note: toggle_bypass and nudge_param removed entirely 2026-05-23.
    // The historical tests for those tools were deleted; this scenario
    // now only validates set_bypass's AMP-slot quirk refusal. If
    // toggle_bypass or nudge_param ever come back, write fresh tests
    // against the new behavior (don't resurrect the old ones — the
    // contract may have changed).
    if (am4Available) {
      console.log('\nAM4 AMP-slot refusal (no wire writes expected)');
      const r = await client.callTool({
        name: 'set_bypass',
        arguments: { port: 'am4', block: 'amp', bypassed: true },
      });
      const t = extractText(r);
      const isErr = isError(r);
      const namesQuirk = /no bypass register|always engaged/i.test(t);
      const pointsAtMaster = /amp\.master|amp\.level/i.test(t);
      const notes = [
        `isError=${isErr}`,
        `names AMP-slot quirk → ${namesQuirk}`,
        `points at amp.master fallback → ${pointsAtMaster}`,
        ...debugOnFail('set_bypass(amp)', r),
      ];
      record('set_bypass(am4, amp) refuses with quirk + retry hint',
        isErr && namesQuirk && pointsAtMaster, notes);
    } else {
      record('AM4 AMP-slot refusals', false, [], true);
    }

    // ── Axe-Fx II atomic_read flag ──────────────────────────────────
    if (axefx2Available) {
      console.log('\nAxe-Fx II atomic_read capability flag');
      const r = await client.callTool({ name: 'describe_device', arguments: { port: 'axe-fx-ii' } });
      const sc = structured(r);
      const caps = sc?.['capabilities'] as Record<string, unknown> | undefined;
      const flag = caps?.['atomic_read'];
      record('describe_device(axe-fx-ii).capabilities.atomic_read === true',
        flag === true, [`atomic_read = ${JSON.stringify(flag)}`]);
    } else {
      record('describe_device(axe-fx-ii).capabilities.atomic_read', false, [], true);
    }

    // ── Axe-Fx II get_preset live ───────────────────────────────────
    if (axefx2Available) {
      console.log('\nAxe-Fx II get_preset live (~1.5-2s expected)');
      const t0 = Date.now();
      const r = await client.callTool({ name: 'get_preset', arguments: { port: 'axe-fx-ii' } });
      const elapsed = Date.now() - t0;
      const sc = structured(r);
      const slots = sc?.['slots'] as unknown[] | undefined;
      const meta = sc?.['_meta'] as Record<string, unknown> | undefined;
      const name = sc?.['name'];
      const activeScene = sc?.['active_scene'];
      const notes = [
        `isError=${isError(r)}`,
        `wall=${elapsed}ms`,
        `preset name=${JSON.stringify(name)}`,
        `active_scene=${activeScene}`,
        `slots.length=${slots?.length ?? '<missing>'}`,
        `_meta.device=${meta?.['device']}`,
        `_meta.active_scene_only=${meta?.['active_scene_only']}`,
        `_meta.routing_omitted=${meta?.['routing_omitted']}`,
      ];

      // Sanity checks: response shape carries the new envelope fields.
      const hasMeta = meta !== undefined && typeof meta['device'] === 'string';
      const hasSlots = Array.isArray(slots);
      const pass = !isError(r) && hasMeta && hasSlots;
      record('get_preset(axe-fx-ii) returns PresetSnapshot with _meta + slots', pass, notes);

      // Sample-check the first channel-bearing slot for channel_status.
      if (slots && slots.length > 0) {
        const channelSlots = slots.filter((s) => {
          const slot = s as Record<string, unknown>;
          return slot['channel_status'] !== undefined;
        });
        const cstatusNotes = [
          `channel-bearing slot count=${channelSlots.length}`,
          channelSlots.length > 0
            ? `first channel_status=${(channelSlots[0] as Record<string, unknown>)['channel_status']}`
            : '(no channel-bearing slots placed)',
        ];
        record('get_preset slots carry channel_status on channel blocks',
          channelSlots.length > 0
            ? ['active', 'unknown', 'all_channels'].includes(
                (channelSlots[0] as Record<string, unknown>)['channel_status'] as string)
            : true,
          cstatusNotes);
      }
    } else {
      record('get_preset(axe-fx-ii) live', false, [], true);
    }

    // ── AM4 get_preset succeeds (atomic_read shipped Session 122) ────
    // F5 (alpha.11): the case immediately below already exercises the
    // response shape; this one just confirms the call succeeds at all.
    if (am4Available) {
      const r = await client.callTool({ name: 'get_preset', arguments: { port: 'am4' } });
      const sc = structured(r);
      const slots = sc?.['slots'] as unknown[] | undefined;
      record('get_preset(am4) succeeds (atomic_read shipped)',
        !isError(r) && Array.isArray(slots),
        [`isError=${isError(r)}`, `slots=${slots?.length}`]);
    }

    // ── F12 (alpha.11): active_scene drift after apply + writes ───────
    // Reproduces the alpha.11 desktop bug:
    //   apply_preset(landingScene: 1) → set_params → set_bypass → get_preset
    // returned active_scene: 4 (because the per-scene-authoring loop visits
    // scene 4 last and the final landing switch_scene was fire-and-forget).
    // The fix in applyExecutor adds a scene_verify read-back to the final
    // landing op. This case is the live guard.
    if (axefx2Available) {
      console.log('\nF12: II active_scene drift after apply + writes (live repro)');
      const driftSpec = buildAlpha11II4SceneSpec();
      const applyR = await client.callTool({
        name: 'apply_preset',
        arguments: { port: 'axe-fx-ii', spec: driftSpec, verify_chain: true },
      });
      const applyJson = structured(applyR);
      const applyOk = applyJson?.['ok'] === true;
      record('F12 setup: apply_preset(4-scene, landingScene:1) ok', applyOk,
        [`isError=${isError(applyR)}`, `steps=${applyJson?.['steps']}`, ...debugOnFail('apply_preset', applyR)]);

      if (applyOk) {
        // Reproduce the exact write sequence that triggered the drift.
        await client.callTool({
          name: 'set_params',
          arguments: {
            port: 'axe-fx-ii',
            ops: [
              { block: 'compressor', channel: 'X', name: 'treshold', value: -30 },
              { block: 'compressor', channel: 'X', name: 'ratio', value: 8 },
            ],
          },
        });
        await client.callTool({
          name: 'set_bypass',
          arguments: { port: 'axe-fx-ii', block: 'cab', bypassed: true },
        });

        const gr = await client.callTool({ name: 'get_preset', arguments: { port: 'axe-fx-ii' } });
        const grSc = structured(gr);
        const activeScene = grSc?.['active_scene'];
        record(
          'F12: get_preset.active_scene === 1 after apply+set_params+set_bypass',
          activeScene === 1,
          [`active_scene=${activeScene}`, '(pre-fix this drifted to 4)'],
        );

        // Restore to landing state so the user's working buffer isn't left
        // in an unexpected configuration.
        await client.callTool({
          name: 'set_bypass',
          arguments: { port: 'axe-fx-ii', block: 'cab', bypassed: false },
        });
        await client.callTool({
          name: 'set_params',
          arguments: {
            port: 'axe-fx-ii',
            ops: [
              { block: 'compressor', channel: 'X', name: 'treshold', value: -22 },
              { block: 'compressor', channel: 'X', name: 'ratio', value: 4 },
            ],
          },
        });
      }
    } else {
      record('F12: II active_scene drift', false, [], true);
    }

    // ── F5 (alpha.11): AM4 channel-bearing slots use params_by_channel ─
    // Pre-fix bug: when an amp.channel read returned an out-of-range or
    // failed value, the AM4 reader fell back to flat params + channel_status
    // 'unknown', while siblings (delay/reverb) returned params_by_channel +
    // channel_status 'active'. The shape divergence inside a single response
    // broke agent state-anchoring round-trips. Fix in am4 reader unifies on
    // params_by_channel for every channel-bearing slot. This case asserts
    // the invariant on whatever preset is currently loaded.
    if (am4Available) {
      console.log('\nF5: AM4 channel-bearing slots use params_by_channel');
      const gr = await client.callTool({ name: 'get_preset', arguments: { port: 'am4' } });
      const grSc = structured(gr);
      const slots = (grSc?.['slots'] as Array<Record<string, unknown>> | undefined) ?? [];
      const channelBlocks = new Set(['amp', 'drive', 'reverb', 'delay']);
      const offenders: string[] = [];
      for (const s of slots) {
        const blockType = (s['block_type'] as string)?.toLowerCase();
        if (!channelBlocks.has(blockType)) continue;
        const hasFlat = s['params'] !== undefined;
        const hasNested = s['params_by_channel'] !== undefined;
        if (hasFlat && !hasNested) {
          offenders.push(`${blockType} returned flat params (no params_by_channel)`);
        }
      }
      record(
        'F5: every channel-bearing AM4 slot exposes params_by_channel',
        offenders.length === 0,
        offenders.length === 0
          ? [`${slots.length} slot(s) checked, all channel-bearing slots conformant`]
          : offenders,
      );
    } else {
      record('F5: AM4 channel-bearing shape', false, [], true);
    }

    // ── Removed-tool regression guard ────────────────────────────────
    // toggle_bypass and nudge_param were removed entirely 2026-05-23.
    // If they reappear in the tool catalog, this assertion catches it
    // so we don't accidentally resurrect them.
    if (axefx2Available) {
      console.log('\nRemoved-tool regression guard');
      const toolsList = await client.listTools();
      const toolNames = toolsList.tools.map((t) => t.name);
      const stillPresent = ['toggle_bypass', 'nudge_param', 'play_note', 'play_chord', 'rename', 'hydra_apply_patch']
        .filter((name) => toolNames.includes(name));
      record(
        'removed tools (toggle_bypass / nudge_param / play_note / play_chord / rename / hydra_apply_patch) stay removed',
        stillPresent.length === 0,
        stillPresent.length === 0 ? [] : [`Still registered: ${stillPresent.join(', ')}`],
      );
    }

    // ── Axe-Fx II core read/write path still works ──────────────────
    // Validates that the BK-070 PresetSnapshot type change + the
    // capabilities.atomic_read addition didn't regress the existing
    // II surface. get_param + set_param round-trip on amp.input_drive.
    if (axefx2Available) {
      console.log('\nAxe-Fx II core read/write path (no regression from BK-070)');
      try {
        const before = await client.callTool({
          name: 'get_param',
          arguments: { port: 'axe-fx-ii', block: 'amp', name: 'input_drive' },
        });
        const beforeSc = structured(before);
        const beforeDisplay = beforeSc?.['display_value'];
        const beforeIsErr = isError(before);
        record('get_param(axe-fx-ii, amp, input_drive) succeeds',
          !beforeIsErr && typeof beforeDisplay === 'number',
          [`isError=${beforeIsErr}`, `display_value=${beforeDisplay}`]);

        if (!beforeIsErr && typeof beforeDisplay === 'number') {
          // Bump amp.input_drive by 0.5 display units and read back.
          // Then restore. Stays well within the knob's 0..10 range.
          const target = Math.min(10, Math.max(0, beforeDisplay + 0.5));
          const setR = await client.callTool({
            name: 'set_param',
            arguments: { port: 'axe-fx-ii', block: 'amp', name: 'input_drive', value: target },
          });
          const setIsErr = isError(setR);
          record(`set_param(axe-fx-ii, amp, input_drive, ${target.toFixed(2)}) acks`,
            !setIsErr, [`isError=${setIsErr}`, ...debugOnFail('set_param', setR)]);

          const after = await client.callTool({
            name: 'get_param',
            arguments: { port: 'axe-fx-ii', block: 'amp', name: 'input_drive' },
          });
          const afterSc = structured(after);
          const afterDisplay = afterSc?.['display_value'];
          // II's display rounding/Q15 quantization can drift the read-back
          // by ~0.01 display units; allow 0.1 tolerance.
          const landed = typeof afterDisplay === 'number'
            && Math.abs(afterDisplay - target) < 0.1;
          record(`get_param read-back lands within 0.1 of ${target.toFixed(2)}`,
            landed, [`display_value=${afterDisplay}`, `target=${target}`]);

          // Restore original value so the user's preset state is
          // unchanged after the regression.
          await client.callTool({
            name: 'set_param',
            arguments: { port: 'axe-fx-ii', block: 'amp', name: 'input_drive', value: beforeDisplay },
          });
        }
      } catch (err) {
        record('Axe-Fx II read/write round-trip', false,
          [`exception: ${err instanceof Error ? err.message : String(err)}`]);
      }
    }

    // ── Circuit Tracks ──────────────────────────────────────────────
    // Circuit is detected via list_midi_ports visibility (its get_param
    // refuses by design, so the get_param liveness probe the Fractal
    // devices use doesn't apply here). All Circuit cases are self-
    // restoring: the reads are read-only and the overwrite-gate case
    // exercises the REFUSAL path, which writes nothing to the device.
    const portsText = extractText(await client.callTool({ name: 'list_midi_ports', arguments: {} }));
    const circuitAvailable = /circuit/i.test(portsText);
    console.log(`\nCircuit Tracks connected: ${circuitAvailable ? 'yes' : 'NO (cases will skip)'}`);

    if (!circuitAvailable) {
      record('Circuit Tracks live cases', true, ['Circuit not visible in list_midi_ports'], true);
    } else {
      // get_param reads SYNTH patch params (osc/filter/env/lfo/mixer/fx/eq) off the
      // working-buffer patch decode (shipped 21f6a6b, HW-CIRCUIT-001); drum/project/
      // macro/mod-matrix have no readback and refuse. A synth param must READ a
      // decoded value (not refuse, not fabricate a blank).
      {
        const r = await client.callTool({ name: 'get_param', arguments: { port: 'circuit', block: 'filter', name: 'frequency' } });
        const t = extractText(r);
        record('Circuit get_param reads a synth param (filter.frequency) via patch decode',
          !isError(r) && /frequency/i.test(t) && /(wire_value|display_value)/i.test(t), debugOnFail('get_param', r));
      }

      // Find an occupied project slot by reading candidates (read-only).
      // get_preset decodes a stored project; an empty slot's snapshot name is
      // "(empty slot N)". Likely-occupied slots tried first to keep it quick.
      const nameOf = (t: string): string => /"name"\s*:\s*"([^"]+)"/.exec(t)?.[1] ?? '';
      const candidates = [0, 1, 2, 32, 33];
      let occupiedSlot: number | undefined;
      let occupiedName = '';
      for (const slot of candidates) {
        const r = await client.callTool({ name: 'get_preset', arguments: { port: 'circuit', location: slot } });
        if (isError(r)) continue;
        const t = extractText(r);
        if (!/empty slot/i.test(t)) { occupiedSlot = slot; occupiedName = nameOf(t); break; }
      }

      if (occupiedSlot === undefined) {
        record('Circuit get_preset reads a stored project', true,
          [`no occupied slot among candidates ${candidates.join(',')} — cannot test the gate non-destructively`], true);
      } else {
        record('Circuit get_preset reads a stored project off a slot', true,
          [`slot ${occupiedSlot} → "${occupiedName}"`]);

        // SELF-RESTORING overwrite-gate case: upload_project to the OCCUPIED
        // slot WITHOUT confirm_overwrite must REFUSE and write nothing (the #0
        // gate). Because it refuses, the slot is untouched (non-destructive).
        const ncs = path.resolve(process.cwd(), 'samples', 'circuit-tracks', 'grooves', 'aqua_regia.ncs');
        const r = await client.callTool({
          name: 'upload_project',
          arguments: { port: 'circuit', file: ncs, slot: occupiedSlot },
        });
        const t = extractText(r);
        const refused = isError(r) && /overwrit|confirm_overwrite/i.test(t);
        record('Circuit overwrite gate REFUSES an occupied slot without confirm_overwrite',
          refused, refused ? [`refused slot ${occupiedSlot}; nothing written`] : debugOnFail('upload_project', r).concat([`text=${t.slice(0, 160)}`]));

        // Confirm NON-DESTRUCTIVE: re-read the slot; the project name is unchanged.
        const after = await client.callTool({ name: 'get_preset', arguments: { port: 'circuit', location: occupiedSlot } });
        const afterName = nameOf(extractText(after));
        record('Circuit slot unchanged after the refused upload (self-restoring)',
          !isError(after) && afterName === occupiedName, [`name before="${occupiedName}" after="${afterName}"`]);
      }
    }
  } finally {
    await client.close();
  }

  // ── Summary ─────────────────────────────────────────────────────
  const passed = RESULTS.filter((r) => r.pass && !r.skipped).length;
  const failed = RESULTS.filter((r) => !r.pass && !r.skipped).length;
  const skipped = RESULTS.filter((r) => r.skipped).length;
  console.log(`\n────────────────────────────────────────`);
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const r of RESULTS.filter((r) => !r.pass && !r.skipped)) {
      console.log(`  ✗ ${r.name}`);
      for (const n of r.notes) console.log(`      ${n}`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * The canonical 4-scene II preset from the alpha.11 desktop session that
 * exposed the active_scene drift bug. Used by the F12 case to reproduce
 * the exact write workload that triggered the race in the wild.
 *
 * Layout: comp → amp_1 (Shiver Clean/Lead) → amp_2 (Brit 800/JVM) → cab
 *  → delay → reverb. Four scenes (Clean/Crunch/Rhythm/Lead) with per-
 * scene bypass + channel maps. landingScene: 1 means the device should
 * be sitting on scene 1 when apply_preset returns.
 */
function buildAlpha11II4SceneSpec(): Record<string, unknown> {
  return {
    landingScene: 1,
    name: 'Clean/Crunch/Rhythm/Lead',
    scenes: [
      {
        scene: 1, name: 'Clean',
        channels: { amp: 'X', amp_2: 'X', delay: 'X', reverb: 'X' },
        bypassed: { amp: false, amp_2: true, compressor: false, delay: false, reverb: false },
      },
      {
        scene: 2, name: 'Crunch',
        channels: { amp: 'Y', amp_2: 'X', delay: 'Y', reverb: 'Y' },
        bypassed: { amp: true, amp_2: false, compressor: true, delay: true, reverb: false },
      },
      {
        scene: 3, name: 'Rhythm',
        channels: { amp: 'X', amp_2: 'Y', delay: 'Y', reverb: 'Y' },
        bypassed: { amp: true, amp_2: false, compressor: true, delay: true, reverb: false },
      },
      {
        scene: 4, name: 'Lead',
        channels: { amp: 'Y', amp_2: 'Y', delay: 'Y', reverb: 'X' },
        bypassed: { amp: false, amp_2: true, compressor: true, delay: false, reverb: false },
      },
    ],
    slots: [
      { slot: { row: 2, col: 1 }, block_type: 'compressor', params_by_channel: { X: { effect_type: 'PEDAL COMP 1', treshold: -22, ratio: 4, mix: 100 } } },
      { slot: { row: 2, col: 2 }, block_type: 'amp', instance: 1, params_by_channel: { X: { type: 'SHIVER CLEAN', input_drive: 3, bass: 6, middle: 6, treble: 7, master_volume: 4, presence: 6, level: 2 }, Y: { type: 'SHIVER LEAD', input_drive: 7.5, bass: 5, middle: 7, treble: 6, master_volume: 5, presence: 6, level: 3 } } },
      { slot: { row: 2, col: 3 }, block_type: 'amp', instance: 2, params_by_channel: { X: { type: 'BRIT 800', input_drive: 6, bass: 5, middle: 7, treble: 6, master_volume: 4, presence: 6, level: 0 }, Y: { type: 'BRIT JVM OD1 GN', input_drive: 8, bass: 6, middle: 5, treble: 6, master_volume: 4, presence: 6, level: 0 } } },
      { slot: { row: 2, col: 4 }, block_type: 'cab' },
      { slot: { row: 2, col: 5 }, block_type: 'delay', params_by_channel: { X: { effect_type: 'DIGITAL STEREO', time: 450, feedback: 22, mix: 25 }, Y: { effect_type: 'DIGITAL STEREO', time: 420, feedback: 35, mix: 28 } } },
      { slot: { row: 2, col: 6 }, block_type: 'reverb', params_by_channel: { X: { effect_type: 'LARGE HALL', mix: 40 }, Y: { effect_type: 'MEDIUM ROOM', mix: 15 } } },
    ],
  };
}

async function checkDevice(client: Client, port: string): Promise<boolean> {
  // Probe whether the device is REACHABLE on MIDI, not just registered.
  // describe_device returns success on any registered descriptor (pure
  // metadata, no wire ops). The real liveness signal is whether a
  // wire-touching read like get_param can open the port. We try a
  // cheap read and inspect the error text. "X not found in the MIDI
  // device list" means the port isn't reachable; the device is either
  // unplugged or an exclusive-mode owner (e.g. AM4-Edit) is holding it.
  try {
    const r = await client.callTool({
      name: 'describe_device',
      arguments: { port },
    });
    if (isError(r)) return false;
    // Cheap wire-touching probe: get_param on a known param for the
    // device. Use the unified surface so it works for any registered
    // device. Falls back to "not found" semantics when the port can't
    // be opened.
    const probeReadParam = port === 'am4'
      ? { block: 'amp', name: 'gain' }
      : port === 'axe-fx-ii'
        ? { block: 'amp', name: 'input_drive' }
        : null;
    if (!probeReadParam) return !isError(r);
    const probe = await client.callTool({
      name: 'get_param',
      arguments: { port, ...probeReadParam },
    });
    if (isError(probe)) {
      const t = extractText(probe);
      // Connection-layer errors mean hardware is not reachable. Covers both the
      // legacy "not found in the MIDI device list" envelope and the current
      // "<Device> not found. Looked for any output port ..." one (else a
      // disconnected device false-positives as connected and its cases FAIL
      // instead of SKIP — observed on a Circuit-only rig, 2026-06-22).
      if (/not found in the MIDI device list|not found\. Looked for|No MIDI port matching|cannot open|stale handle/i.test(t)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(99);
});
