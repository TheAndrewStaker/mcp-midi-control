/**
 * Non-destructive launch verification battery — AM4 + Axe-Fx II.
 *
 * Drives the shipped MCP server (dist/server/index.js) via
 * StdioClientTransport, the same JSON-RPC path Claude Desktop uses.
 * Runs read-only and working-buffer-only checks: no flash saves, no
 * save_preset, no restore_defaults. Working-buffer changes revert
 * naturally when the user switches presets.
 *
 * What it verifies:
 *   • Port discovery — both devices visible via list_midi_ports.
 *   • describe_device sanity per port (capabilities, location format).
 *   • AM4 read surface — get_param, list_params, scan_locations,
 *     lookup_lineage with v0.4 frontPanelKnobs / notExposed annotations.
 *   • AM4 unpadded location format (A1..Z4, matches device display).
 *   • AM4 audition apply_preset (no target_location, no save).
 *   • AM4 audition-at-target apply_preset (target_location, no
 *     save_authorized — v0.4 three-mode behavior).
 *   • AM4 apply_preset rejects routing[] (linear device contract).
 *   • AM4 apply_preset rejects instance≠1 (linear device contract).
 *   • AM4 apply_preset skip-with-warning on type-gated params.
 *   • Axe-Fx II read surface — describe_device, get_param.
 *   • Axe-Fx II audition apply_preset (no target_location).
 *   • Axe-Fx II v0.4 routing-walk audition (BK-054) — wet/dry parallel
 *     chain via explicit routing[] edges. Confirms the dispatcher
 *     accepts the topology and the device acks every cable.
 *
 * NOT covered (would require flash writes):
 *   • save_preset wire path — exercised by mcp-test-safe-edit-scenarios --write.
 *   • restore_defaults — destructive.
 *   • Axe-Fx II routing-walk persisted to a slot + audio sign-off — that
 *     requires a target slot the founder is willing to overwrite.
 *
 * USAGE:
 *   npm run launch-verify                    # both ports
 *   npm run launch-verify -- --port am4      # AM4 only
 *   npm run launch-verify -- --port axefx2   # Axe-Fx II only
 *
 * EXIT CODES:
 *   0 — every applicable check passed
 *   1 — one or more checks failed
 *   2 — server handshake failed
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');

// ── CLI ────────────────────────────────────────────────────────────

interface CliOpts {
  ports: string[];
}

function parseCli(argv: string[]): CliOpts {
  const opts: CliOpts = { ports: ['am4', 'axefx2', 'hydrasynth'] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.ports = [argv[++i]];
  }
  return opts;
}

// ── MCP helpers ────────────────────────────────────────────────────

function extractText(callResult: unknown): string {
  if (!callResult || typeof callResult !== 'object') return '<no response>';
  const r = callResult as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const parts = (r.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!);
  return parts.join('\n');
}
function isError(r: unknown): boolean { return !!(r as { isError?: boolean })?.isError; }

/**
 * True when the call returned either:
 *   - an MCP `isError: true` envelope (old throw-on-first-error path), OR
 *   - a structured `{ok: false, validation_errors: [...]}` body (BK-059
 *     all-errors-at-once preflight). The structured response is NOT
 *     marked isError because it's a normal tool result; the dispatcher
 *     surfaces the validation errors in the payload so the agent can
 *     fix the whole spec in one follow-up. For "must reject" checks
 *     either shape is correct rejection.
 */
function isRejection(r: unknown, t: string): boolean {
  if (isError(r)) return true;
  return /"ok"\s*:\s*false/.test(t) && /validation_errors/.test(t);
}

// ── Assertion tracking ─────────────────────────────────────────────

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  const icon = pass ? '✓' : '✗';
  console.log(`  ${icon} ${name}`);
  if (!pass) {
    for (const line of detail.split('\n').slice(0, 8)) {
      console.log(`      ${line}`);
    }
  }
}

// ── Per-port batteries ─────────────────────────────────────────────

async function verifyAm4(client: Client): Promise<void> {
  console.log('\n── AM4 ───────────────────────────────────────────────────────');

  // describe_device
  {
    const r = await client.callTool({ name: 'describe_device', arguments: { port: 'am4' } });
    const t = extractText(r);
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { parsed = undefined; }
    const caps = (parsed as { capabilities?: { preset_location_format?: string } })?.capabilities;
    const fmt = caps?.preset_location_format;
    const terms = (parsed as { canonical_terms?: { location?: string } })?.canonical_terms;
    record('describe_device returns capabilities', !isError(r) && !!caps, t.slice(0, 200));
    record(
      'preset_location_format serializes as string (not RegExp object)',
      typeof fmt === 'string' && /[A-Z]/.test(fmt),
      `format=${fmt}`,
    );
    record(
      'canonical_terms.location documents unpadded A1..Z4 form',
      typeof terms?.location === 'string' && /A1\.\.Z4/.test(terms.location),
      `location=${terms?.location}`,
    );
  }

  // get_param — amp.gain (works regardless of active type)
  {
    const r = await client.callTool({
      name: 'get_param',
      arguments: { port: 'am4', block: 'amp', name: 'gain' },
    });
    const t = extractText(r);
    record('get_param amp.gain', !isError(r), t.slice(0, 200));
  }

  // scan_locations — verify unpadded form accepted on input
  {
    const r = await client.callTool({
      name: 'scan_locations',
      arguments: { port: 'am4', from: 'A1', to: 'A4' },
    });
    const t = extractText(r);
    record('scan_locations accepts unpadded "A1".."A4"', !isError(r) && /A\d/.test(t), t.slice(0, 200));
    // Verify the response renders unpadded location strings.
    record(
      'scan_locations response uses unpadded location strings',
      !isError(r) && !/A0[1-4]\b/.test(t) && /A[1-4]\b/.test(t),
      t.slice(0, 200),
    );
  }

  // list_params — sanity
  {
    const r = await client.callTool({
      name: 'list_params',
      arguments: { port: 'am4', block: 'amp' },
    });
    const t = extractText(r);
    record('list_params amp returns catalog', !isError(r) && /gain|master|bass/i.test(t), t.slice(0, 200));
  }

  // lookup_lineage — verify v0.4 knob annotations
  {
    const r = await client.callTool({
      name: 'lookup_lineage',
      arguments: { port: 'am4', block_type: 'amp', real_gear: 'Tweed' },
    });
    const t = extractText(r);
    record(
      'lookup_lineage surfaces frontPanelKnobs / notExposed',
      !isError(r) && /frontPanelKnobs/.test(t),
      t.slice(0, 400),
    );
  }

  // AM4 audition (no target, no save) — minimal amp+reverb spec
  {
    const r = await client.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'am4',
        spec: {
          name: 'AUDITION',
          slots: [
            { slot: 1, block_type: 'amp', params: { A: { type: 'Plexi 100W High', gain: 4 } } },
            { slot: 2, block_type: 'reverb', params: { A: { type: 'Room, Medium', mix: 25 } } },
          ],
        },
        on_active_preset_edited: 'discard',
      },
    });
    const t = extractText(r);
    record('audition apply_preset (no target) succeeds', !isError(r), t.slice(0, 300));
    record(
      'audition response does NOT claim save',
      !isError(r) && !/saved|persisted|wrote to flash/i.test(t),
      t.slice(0, 300),
    );
  }

  // AM4 audition-at-target (target_location, no save_authorized) — v0.4 mode 2.
  // Type-applicability precheck (commit 179c974, 2026-05-15): the executor
  // rejects type+knob combinations the amp model doesn't expose. Use
  // "1959SLP Normal" — confirmed to expose `gain` per the precheck's
  // valid_options list and a canonical drive-amp pick.
  {
    const r = await client.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'am4',
        target_location: 'Z4',
        spec: {
          name: 'AUD-AT-Z4',
          slots: [
            { slot: 1, block_type: 'amp', params: { A: { type: '1959SLP Normal', gain: 5 } } },
          ],
        },
        on_active_preset_edited: 'discard',
      },
    });
    const t = extractText(r);
    record('audition-at-target apply_preset (Z4, no save) succeeds', !isError(r), t.slice(0, 300));
    record(
      'audition-at-target response does NOT claim save',
      !isError(r) && !/saved to|persisted/i.test(t),
      t.slice(0, 300),
    );
  }

  // AM4 rejects routing[] (linear-device contract)
  {
    const r = await client.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'am4',
        spec: {
          slots: [{ slot: 1, block_type: 'amp', id: 'amp_1' }],
          routing: [{ from: 'amp_1', to: 'amp_1' }],
        },
        on_active_preset_edited: 'discard',
      },
    });
    const t = extractText(r);
    record(
      'apply_preset rejects routing[] on AM4',
      isRejection(r, t) && /routing|linear|implicit/i.test(t),
      t.slice(0, 300),
    );
  }

  // AM4 rejects instance≠1
  {
    const r = await client.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'am4',
        spec: {
          slots: [{ slot: 1, block_type: 'amp', instance: 2 }],
        },
        on_active_preset_edited: 'discard',
      },
    });
    const t = extractText(r);
    record(
      'apply_preset rejects instance≠1 on AM4',
      isRejection(r, t) && /instance|one instance|single/i.test(t),
      t.slice(0, 300),
    );
  }

  // Dirty-buffer gate on switch_preset: dirty the working buffer via a
  // STRUCTURAL write (set_block), then try to switch_preset without
  // on_active_preset_edited. Expect refusal naming the working preset.
  //
  // Why set_block, not set_param: the AM4 stores per-block params (e.g.
  // amp.gain) in a "phantom" register that's readable via get_param even
  // when the block isn't actually placed in any slot — but those phantom
  // bytes are NOT included in the working-buffer dump. If Z3's stored
  // preset has all-empty slots (which happens after enough wipe/save
  // cycles), set_param amp.gain "succeeds" but doesn't change the dump
  // bytes, and the fingerprint-based dirty gate compares equal-to-equal
  // and silently proceeds. set_block places a block — that's a
  // structural change always captured in the dump regardless of starting
  // state, so the gate reliably trips.
  {
    // Discard-navigate to Z3 — the previous test's audition-at-Z4 will
    // have left the buffer dirty, so use discard mode.
    await client.callTool({
      name: 'switch_preset',
      arguments: { port: 'am4', location: 'Z3', on_active_preset_edited: 'discard' },
    });

    // Dirty the buffer with a structural write that always lands in the
    // dump regardless of Z3's stored slot layout.
    const setR = await client.callTool({
      name: 'set_block',
      arguments: { port: 'am4', slot: 1, block_type: 'amp' },
    });
    const setOk = !isError(setR);

    // Try to navigate without on_active_preset_edited — should refuse.
    const switchR = await client.callTool({
      name: 'switch_preset',
      arguments: { port: 'am4', location: 'A1' },
    });
    const switchText = extractText(switchR);
    record(
      'switch_preset refuses with dirty buffer (no on_active_preset_edited)',
      setOk && isError(switchR) && /unsaved|dirty|edited|discard|save_active_first/i.test(switchText),
      switchText.slice(0, 400),
    );

    // Cleanup: discard-switch so the next test starts clean.
    await client.callTool({
      name: 'switch_preset',
      arguments: { port: 'am4', location: 'Z3', on_active_preset_edited: 'discard' },
    });
  }

  // AM4 type-applicability pre-flight (BK-071, Session 109): when a slot
  // specifies a `type` enum AND knobs that type doesn't expose, the
  // dispatcher ACCEPTS the write but surfaces each dropped knob on
  // `validation_info[]` with level='warning' + retry_action. The agent
  // reads the structured warning and re-issues with a compatible type
  // on the next turn (display-first + user-agency). Prior behavior was
  // hard-refusal — replaced 2026-05-21 per MCP eng review (hard refusal
  // taught agents to retry-loop instead of reading the info surface).
  {
    const r = await client.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'am4',
        spec: {
          name: 'PRECHECK',
          slots: [
            {
              slot: 1,
              block_type: 'amp',
              params: { A: { type: '5F8 Tweed Normal', gain: 5, master: 5 } },
            },
          ],
        },
        on_active_preset_edited: 'discard',
      },
    });
    const t = extractText(r);
    record(
      'apply_preset pre-flight accepts type-gated incompatibility (soft-warn)',
      !isError(r) && /"ok"\s*:\s*true/.test(t) && /validation_info/.test(t),
      t.slice(0, 400),
    );
    record(
      'apply_preset pre-flight surfaces dropped_param=master + retry_action',
      !isError(r) && /"dropped_param"\s*:\s*"master"/.test(t)
        && /find_compatible_types/.test(t) && /"level"\s*:\s*"warning"/.test(t),
      t.slice(0, 500),
    );
  }
}

async function verifyAxefx2(client: Client): Promise<void> {
  console.log('\n── Axe-Fx II ─────────────────────────────────────────────────');

  // describe_device
  {
    const r = await client.callTool({ name: 'describe_device', arguments: { port: 'axefx2' } });
    const t = extractText(r);
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { parsed = undefined; }
    const fmt = (parsed as { capabilities?: { preset_location_format?: string } })?.capabilities?.preset_location_format;
    record('describe_device returns capabilities', !isError(r) && !!fmt, t.slice(0, 200));
  }

  // get_param — amp.input_drive
  {
    const r = await client.callTool({
      name: 'get_param',
      arguments: { port: 'axefx2', block: 'amp', name: 'input_drive' },
    });
    const t = extractText(r);
    record('get_param amp.input_drive', !isError(r), t.slice(0, 200));
  }

  // Audition apply_preset (no target) — minimal amp+cab+reverb chain
  {
    const r = await client.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'axefx2',
        spec: {
          name: 'AUDITION',
          slots: [
            { slot: 1, block_type: 'amp', params: { X: { input_drive: 4, master_volume: 5 } } },
            { slot: 2, block_type: 'cab' },
            { slot: 3, block_type: 'reverb', params: { X: { mix: 25 } } },
          ],
        },
        on_active_preset_edited: 'discard',
      },
    });
    const t = extractText(r);
    record('axefx2 audition apply_preset (no target) succeeds', !isError(r), t.slice(0, 300));
    record(
      'axefx2 audition response does NOT claim save',
      !isError(r) && !/saved|persisted/i.test(t),
      t.slice(0, 300),
    );
  }

  // Dirty-buffer gate on switch_preset. Axe-Fx II has a device-sourced
  // dirty signal (state-broadcast triple on every edit), so this exercises
  // a different code path than AM4 but checks the same contract: dirty
  // buffer + un-qualified switch_preset → refusal.
  {
    // Set a known starting location. Slot 600 is a long-standing scratch
    // slot from prior session work; switching there with discard cleans
    // any leftover dirty state.
    await client.callTool({
      name: 'switch_preset',
      arguments: { port: 'axefx2', location: 600, on_active_preset_edited: 'discard' },
    });

    // Dirty the buffer. Wait briefly so the device's state-broadcast
    // reaches the inbound listener before we test the gate.
    const setR = await client.callTool({
      name: 'set_param',
      arguments: { port: 'axefx2', block: 'amp', name: 'input_drive', value: 6 },
    });
    const setOk = !isError(setR);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Try to navigate without on_active_preset_edited — should refuse.
    const switchR = await client.callTool({
      name: 'switch_preset',
      arguments: { port: 'axefx2', location: 601 },
    });
    const switchText = extractText(switchR);
    record(
      'axefx2 switch_preset refuses with dirty buffer (no on_active_preset_edited)',
      setOk && isError(switchR) && /unsaved|dirty|edited|discard|save_active_first|REFUSING/i.test(switchText),
      switchText.slice(0, 400),
    );

    // Cleanup: discard-switch back to slot 600 so we leave a clean state.
    await client.callTool({
      name: 'switch_preset',
      arguments: { port: 'axefx2', location: 600, on_active_preset_edited: 'discard' },
    });
  }

  // v0.4 routing-walk audition (BK-054). Send a wet/dry parallel-chain
  // spec with explicit routing[] and verify the apply_preset (audition,
  // no target_location) succeeds. This exercises the full dispatcher
  // path: schema validation → descriptor.applyPreset → applyExecutor
  // routing walk → SET_CELL_ROUTING wire emits → device acks. Doesn't
  // assert audible behavior — that's the founder's hardware sign-off
  // at a target slot. Just confirms the routing[] code path is wired
  // end-to-end and the device accepts the cabling sequence without
  // NACKing.
  {
    const r = await client.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'axefx2',
        spec: {
          name: 'WETDRY',
          slots: [
            { id: 'comp',   slot: { row: 2, col: 1 }, block_type: 'Compressor 1' },
            { id: 'amp',    slot: { row: 2, col: 2 }, block_type: 'Amp 1' },
            { id: 'cab',    slot: { row: 2, col: 3 }, block_type: 'Cab 1' },
            { id: 'delay',  slot: { row: 1, col: 4 }, block_type: 'Delay 1' },
            { id: 'reverb', slot: { row: 3, col: 4 }, block_type: 'Reverb 1' },
            { id: 'mixer',  slot: { row: 2, col: 5 }, block_type: 'Mixer' },
          ],
          routing: [
            { from: 'comp',   to: 'amp' },
            { from: 'amp',    to: 'cab' },
            { from: 'cab',    to: 'delay' },
            { from: 'cab',    to: 'reverb' },
            { from: 'delay',  to: 'mixer' },
            { from: 'reverb', to: 'mixer' },
          ],
        },
        on_active_preset_edited: 'discard',
      },
    });
    const t = extractText(r);
    record(
      'axefx2 v0.4 routing-walk audition (wet/dry split) succeeds',
      !isError(r),
      t.slice(0, 400),
    );
    record(
      'axefx2 routing-walk audition response does NOT claim save',
      !isError(r) && !/saved|persisted/i.test(t),
      t.slice(0, 300),
    );

    // Cleanup: discard-switch so we leave a clean state.
    await client.callTool({
      name: 'switch_preset',
      arguments: { port: 'axefx2', location: 600, on_active_preset_edited: 'discard' },
    });
  }
}

async function verifyHydrasynth(client: Client): Promise<void> {
  console.log('\n── Hydrasynth ────────────────────────────────────────────────');

  // describe_device — sanity + verify v0.4 agent_guidance carries the
  // Session 73 confabulation patches.
  {
    const r = await client.callTool({ name: 'describe_device', arguments: { port: 'hydrasynth' } });
    const t = extractText(r);
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { parsed = undefined; }
    const caps = (parsed as { capabilities?: { preset_location_format?: string } })?.capabilities;
    const guidance = (parsed as { agent_guidance?: Record<string, string> })?.agent_guidance;
    record('describe_device returns capabilities', !isError(r) && !!caps, t.slice(0, 200));
    record(
      'agent_guidance carries audition_slot_honesty (Session 73 fix)',
      !!guidance?.audition_slot_honesty && /working buffer/i.test(guidance.audition_slot_honesty),
      `present=${!!guidance?.audition_slot_honesty}`,
    );
    record(
      'agent_guidance carries envelope_time_units (Session 73 fix)',
      !!guidance?.envelope_time_units && /knob units|not.*(milliseconds|seconds)/i.test(guidance.envelope_time_units),
      `present=${!!guidance?.envelope_time_units}`,
    );
    record(
      'agent_guidance carries device_precondition (NRPN TX/RX hint)',
      !!guidance?.device_precondition && /NRPN/i.test(guidance.device_precondition),
      `present=${!!guidance?.device_precondition}`,
    );
  }

  // get_active_patch — Hydrasynth's canonical read primitive (the
  // device has no SysEx response for individual param queries, so
  // unified get_param is intentionally not supported on Hydrasynth).
  {
    const r = await client.callTool({
      name: 'hydra_get_active_patch',
      arguments: {},
    });
    const t = extractText(r);
    record('hydra_get_active_patch returns bank+patch', !isError(r) && /bank|patch/i.test(t), t.slice(0, 200));
  }

  // Audition apply_patch via hydra_apply_patch — slot omitted means
  // the tool navigates to H128 scratch and dumps the patch to that
  // working buffer. NOT a flash save. The audition_slot_honesty
  // guidance prevents the agent from narrating this as "saved to H128"
  // — but the response itself can mention H128 as the navigation
  // target (factual). We only fail if the response uses save-intent
  // wording.
  {
    const r = await client.callTool({
      name: 'hydra_apply_patch',
      arguments: {
        params: [{ name: 'amplevel', value: 90 }],
      },
    });
    const t = extractText(r);
    record('hydra_apply_patch (working-buffer audition) succeeds', !isError(r), t.slice(0, 400));
    record(
      'hydra_apply_patch response does NOT claim flash save',
      !isError(r) && !/saved to flash|persisted to|wrote to flash|stored in flash/i.test(t),
      t.slice(0, 400),
    );
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCli(process.argv);

  console.log('Launch verification battery');
  console.log(`  ports: ${opts.ports.join(', ')}`);
  console.log(`  server: ${SERVER_ENTRY}`);
  console.log('');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'pipe',
  });
  if (transport.stderr) {
    transport.stderr.on('data', (buf: Buffer) => {
      process.stderr.write(`[server] ${buf.toString()}`);
    });
  }

  const client = new Client(
    { name: 'launch-verification', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    console.log('✓ Connected to MCP server\n');

    // list_midi_ports — confirm what hardware is visible.
    const ports = await client.callTool({ name: 'list_midi_ports', arguments: {} });
    const portsText = extractText(ports);
    console.log('── MIDI ports ────────────────────────────────────────────────');
    console.log(portsText);

    const hasAm4 = /am4/i.test(portsText);
    const hasAxefx = /axe[- ]fx/i.test(portsText);
    const hasHydra = /hydrasynth|hydra/i.test(portsText);

    if (opts.ports.includes('am4')) {
      if (!hasAm4) {
        console.log('\n── AM4 ───────────────────────────────────────────────────────');
        console.log('  ⊘ AM4 not visible in list_midi_ports — skipping checks.');
      } else {
        await verifyAm4(client);
      }
    }
    if (opts.ports.includes('axefx2')) {
      if (!hasAxefx) {
        console.log('\n── Axe-Fx II ─────────────────────────────────────────────────');
        console.log('  ⊘ Axe-Fx II not visible in list_midi_ports — skipping checks.');
      } else {
        await verifyAxefx2(client);
      }
    }
    if (opts.ports.includes('hydrasynth')) {
      if (!hasHydra) {
        console.log('\n── Hydrasynth ────────────────────────────────────────────────');
        console.log('  ⊘ Hydrasynth not visible in list_midi_ports — skipping checks.');
      } else {
        await verifyHydrasynth(client);
      }
    }

    console.log('\n══════════════════════════════════════════════════════════════');
    const passed = checks.filter((c) => c.pass).length;
    const failed = checks.length - passed;
    console.log(`Results: ${passed}/${checks.length} passed`);
    if (failed > 0) {
      console.log(`\nFailed checks:`);
      for (const c of checks.filter((x) => !x.pass)) {
        console.log(`  ✗ ${c.name}`);
      }
      process.exit(1);
    }
    console.log('🎯 All checks passed');
  } catch (err) {
    console.error('Fatal:', err);
    process.exit(2);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(99);
});
