/**
 * Smoke test for the MCP server — spawns it as a child process, does the
 * MCP initialize handshake over stdio, lists tools, and checks every
 * registered tool shows up. Does NOT call any tool that touches MIDI;
 * this is a harness-level check.
 *
 *   npx tsx scripts/smoke-server.ts
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';

interface JsonRpc {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

async function main(): Promise<void> {
  // Smoke test verifies the FULL registered tool surface, not the
  // default `core` profile (T-17 / T-5 / Pass 3 default flip). Set
  // MCP_TOOLS_PROFILE=full on the spawned server so this check sees
  // every tool ever registered.
  const child = spawn('npx', ['tsx', 'packages/server-all/src/server/index.ts'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // Windows needs shell=true for npx
    env: { ...process.env, MCP_TOOLS_PROFILE: 'full' },
  });

  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  child.on('error', (err) => {
    console.error('spawn error:', err);
    process.exit(1);
  });

  // Buffer stdout and extract complete line-delimited JSON-RPC messages.
  let stdoutBuf = '';
  const pending = new Map<number, (msg: JsonRpc) => void>();
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpc;
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch (err) {
        console.error(`bad json line: ${line}`);
        throw err;
      }
    }
  });

  let nextId = 1;
  function request(method: string, params?: unknown): Promise<JsonRpc> {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      const msg = { jsonrpc: '2.0', id, method, params };
      child.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  function notify(method: string, params?: unknown): void {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  // MCP handshake: initialize -> notifications/initialized -> tools/list.
  const initResp = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'am4-smoke-test', version: '0.0.1' },
  });
  if (initResp.error) throw new Error(`initialize error: ${initResp.error.message}`);
  console.log('✓ initialize handshake OK');

  notify('notifications/initialized');

  const toolsResp = await request('tools/list', {});
  if (toolsResp.error) throw new Error(`tools/list error: ${toolsResp.error.message}`);
  const tools = (toolsResp.result as { tools: { name: string }[] }).tools;
  const names = tools.map((t) => t.name).sort();
  console.log(`✓ tools/list returned: ${names.join(', ')}`);

  const expected = [
    // am4_apply_preset, am4_apply_preset_at, am4_apply_setlist removed v0.3
    // — use apply_preset / apply_setlist with port="am4".
    'am4_get_active_location',
    'am4_get_active_scene',
    'am4_get_block_bypass',
    'am4_get_block_layout',
    'am4_request_active_buffer_dump',
    // am4_get_param, am4_get_params, am4_lookup_lineage, am4_scan_locations
    // removed v0.3 — use unified get_param / get_params / lookup_lineage /
    // scan_locations with port="am4".
    'list_midi_ports',
    // am4_list_params removed v0.3 — use list_params({port:'am4'}).
    'reconnect_midi',
    // am4_save_preset, am4_save_to_location, am4_switch_preset,
    // am4_switch_scene, am4_set_preset_name, am4_set_scene_name removed
    // v0.3 — use unified save_preset / switch_preset / switch_scene /
    // rename with port="am4".
    'send_cc',
    'send_channel_pressure',
    'send_clock_continue',
    'send_clock_start',
    'send_clock_stop',
    'send_note',
    'send_nrpn',
    'send_panic',
    'send_pitch_bend',
    'send_program_change',
    'send_reset_controllers',
    'send_song_position',
    'send_sysex',
    // AM4 device-namespaced write tools removed v0.3 — use unified
    // set_param / set_params / set_block / set_bypass with port="am4".
    // (am4_set_param, am4_set_params, am4_set_block_type,
    // am4_set_block_bypass, am4_restore_factory, am4_restore_factory_range)
    // Hydrasynth Explorer tools — registered alongside AM4 tools per
    // the single-MCP-project model. `hydra_` prefix avoids name
    // collisions; tools work when a Hydrasynth is plugged in.
    'hydra_apply_init',
    'hydra_apply_init_to',
    'hydra_apply_patch',
    'hydra_get_active_patch',
    // hydra_list_enum_values, hydra_param_catalog, hydra_switch_patch
    // removed v0.3 — use unified list_params / switch_preset with
    // port="hydrasynth".
    'hydra_navigate_to',
    // hydra_play_note removed — use unified play_note({port:'hydrasynth',...}).
    'hydra_reconnect_midi',
    // hydra_set_engine_param, hydra_set_engine_params removed 2026-05-18
    // — use unified set_param / set_params with port="hydrasynth".
    'hydra_set_macro',
    'hydra_set_param',
    // Fractal Axe-Fx II tools — registered alongside AM4 + Hydrasynth on
    // the single MCP server. `axefx2_` prefix avoids name collisions; the
    // surface is wiki-documented (🟡) until HW-074 lands the live capture.
    // axefx2_apply_preset, axefx2_apply_preset_at, axefx2_apply_setlist
    // removed v0.3 — use unified apply_preset / apply_setlist with
    // port="axe-fx-ii".
    'axefx2_get_active_preset_number',
    'axefx2_get_block_channel',
    'axefx2_get_grid_layout',
    // axefx2_get_param removed v0.3 — use get_param({port:'axe-fx-ii',...}).
    'axefx2_get_preset_name',
    // axefx2_list_params, axefx2_list_enum_values, axefx2_lookup_lineage
    // removed v0.3 — use unified list_params / lookup_lineage with
    // port="axe-fx-ii".
    'axefx2_probe_sysex',
    'axefx2_reconnect_midi',
    // axefx2_set_block_bypass, axefx2_switch_preset, axefx2_switch_scene,
    // axefx2_set_preset_name, axefx2_save_preset, axefx2_scan_preset_range
    // removed v0.3 — use unified set_bypass / switch_preset / switch_scene
    // / rename / save_preset / scan_locations with port="axe-fx-ii".
    'axefx2_set_block_at_cell',
    'axefx2_set_block_channel',
    // axefx2_set_param removed v0.3 — use set_param({port:'axe-fx-ii',...}).
    // axefx2_test_apply removed 2026-05-21 (T-2) — use apply_preset({port:'axe-fx-ii',
    // spec, verify_chain:true}) for the same working-buffer apply + chain integrity check.
    // BK-051 unified tool surface — port-dispatched, device-agnostic.
    // Session B chunk 1 (2026-05-11): describe_device, list_params,
    // get_param, set_param.
    // Session B chunk 2: set_params, get_params, switch_preset,
    // save_preset, switch_scene, rename.
    // Session B chunk 3: set_block, set_bypass, scan_locations,
    // lookup_lineage.
    // Session B-cont (2026-05-12): apply_preset, apply_setlist,
    // restore_defaults — wrap the AM4 apply executor and factoryBank.
    'apply_preset',
    'apply_setlist',
    'describe_device',
    'find_compatible_types',
    'get_param',
    'get_params',
    'list_params',
    'lookup_lineage',
    'play_chord',
    'play_note',
    'rename',
    'restore_defaults',
    'save_preset',
    'scan_locations',
    'set_block',
    'set_bypass',
    'set_param',
    'set_params',
    'switch_preset',
    'switch_scene',
  ];
  for (const exp of expected) {
    if (!names.includes(exp)) throw new Error(`missing tool: ${exp}`);
  }
  console.log(`✓ all ${expected.length} expected tools registered`);

  // Exercise list_midi_ports — enumerates ports but doesn't open the AM4.
  // Runs green regardless of whether an AM4 is actually connected; we're
  // asserting the tool is wired up and returns structured port info.
  const portsResp = await request('tools/call', {
    name: 'list_midi_ports',
    arguments: {},
  });
  if (portsResp.error) throw new Error(`list_midi_ports error: ${portsResp.error.message}`);
  const portsText = (portsResp.result as { content: { text: string }[] }).content[0].text;
  if (!portsText.includes('Inputs') || !portsText.includes('Outputs')) {
    throw new Error(`list_midi_ports missing Inputs/Outputs sections:\n${portsText}`);
  }
  console.log(`✓ list_midi_ports call returned port enumeration`);

  // BK-030 Session A — list_midi_ports accepts an optional `pattern` arg
  // for tagging non-AM4 devices. Smoke just exercises the input-schema
  // path; the response text adapts to the supplied pattern.
  const patternResp = await request('tools/call', {
    name: 'list_midi_ports',
    arguments: { pattern: 'hydra' },
  });
  if (patternResp.error) throw new Error(`list_midi_ports(pattern) error: ${patternResp.error.message}`);
  const patternText = (patternResp.result as { content: { text: string }[] }).content[0].text;
  if (!patternText.includes('hydra')) {
    throw new Error(`list_midi_ports(pattern="hydra") response missing pattern echo:\n${patternText}`);
  }
  console.log(`✓ list_midi_ports accepts custom pattern argument`);

  // Exercise MCP resources — agent_guidance is exposed as resources
  // per-device per-topic. Confirms resources/list returns the expected
  // shape and a known topic is readable.
  const resourcesListResp = await request('resources/list', {});
  if (resourcesListResp.error) {
    throw new Error(`resources/list error: ${resourcesListResp.error.message}`);
  }
  const resources = (resourcesListResp.result as { resources: { uri: string }[] }).resources ?? [];
  const guidanceResources = resources.filter((r) => r.uri.startsWith('guidance://'));
  if (guidanceResources.length === 0) {
    throw new Error(`resources/list returned no guidance:// resources`);
  }
  const sampleUri = guidanceResources.find((r) => r.uri.startsWith('guidance://am4/'))?.uri;
  if (!sampleUri) {
    throw new Error(`no guidance://am4/* resources found`);
  }
  const readResp = await request('resources/read', { uri: sampleUri });
  if (readResp.error) throw new Error(`resources/read(${sampleUri}) error: ${readResp.error.message}`);
  const contents = (readResp.result as { contents: { text?: string }[] }).contents;
  if (!contents || contents.length === 0 || !contents[0].text || contents[0].text.length === 0) {
    throw new Error(`resources/read(${sampleUri}) returned empty content`);
  }
  console.log(`✓ resources/list returned ${guidanceResources.length} guidance resources; ${sampleUri} readable`);

  // Exercise unified list_params — doesn't touch MIDI. Confirms the
  // dispatcher routes port='am4' correctly and the catalog reaches
  // the MCP response.
  const callResp = await request('tools/call', {
    name: 'list_params',
    arguments: { port: 'am4' },
  });
  if (callResp.error) throw new Error(`tools/call error: ${callResp.error.message}`);
  const content = (callResp.result as { content: { type: string; text: string }[] }).content;
  const text = content[0].text;
  if (!text.includes('amp')) throw new Error(`list_params output missing amp block:\n${text}`);
  if (!text.includes('gain')) throw new Error(`list_params output missing gain param:\n${text}`);
  console.log(`✓ list_params call returned catalog`);

  // Exercise lookup_lineage forward + reverse — doesn't touch MIDI, just
  // reads src/knowledge/*.json. Confirms the tool is wired up and the data
  // is present.
  const forwardResp = await request('tools/call', {
    name: 'lookup_lineage',
    arguments: { port: 'am4', block_type: 'drive', name: 'T808 OD' },
  });
  if (forwardResp.error) throw new Error(`lookup_lineage forward error: ${forwardResp.error.message}`);
  const forwardText = (forwardResp.result as { content: { text: string }[] }).content[0].text;
  if (!forwardText.includes('T808 OD')) throw new Error(`lookup_lineage forward missing T808 OD:\n${forwardText}`);
  if (!forwardText.includes('Tube Screamer')) throw new Error(`lookup_lineage forward missing Tube Screamer lineage:\n${forwardText}`);
  console.log(`✓ lookup_lineage forward (drive/T808 OD) returned record with Tube Screamer lineage`);

  const reverseResp = await request('tools/call', {
    name: 'lookup_lineage',
    arguments: { port: 'am4', block_type: 'compressor', real_gear: '1176', include_quotes: false },
  });
  if (reverseResp.error) throw new Error(`lookup_lineage reverse error: ${reverseResp.error.message}`);
  const reverseText = (reverseResp.result as { content: { text: string }[] }).content[0].text;
  if (!reverseText.includes('JFET Studio Compressor')) {
    throw new Error(`lookup_lineage reverse (compressor/1176) missing JFET Studio Compressor:\n${reverseText}`);
  }
  console.log(`✓ lookup_lineage reverse (compressor/"1176") found JFET Studio Compressor`);

  // Structured filter: compressor by manufacturer ("MXR").
  const mfrResp = await request('tools/call', {
    name: 'lookup_lineage',
    arguments: { port: 'am4', block_type: 'compressor', manufacturer: 'MXR', include_quotes: false },
  });
  if (mfrResp.error) throw new Error(`lookup_lineage manufacturer error: ${mfrResp.error.message}`);
  const mfrText = (mfrResp.result as { content: { text: string }[] }).content[0].text;
  if (!mfrText.includes('Dynami-Comp')) {
    throw new Error(`lookup_lineage manufacturer (MXR) missing Dynami-Comp variants:\n${mfrText}`);
  }
  console.log(`✓ lookup_lineage structured (compressor/manufacturer="MXR") found Dynami-Comp`);

  // Phaser block: "classic MXR phaser block" use case from BK-021 spec.
  const phaserResp = await request('tools/call', {
    name: 'lookup_lineage',
    arguments: { port: 'am4', block_type: 'phaser', manufacturer: 'MXR', include_quotes: false },
  });
  if (phaserResp.error) throw new Error(`lookup_lineage phaser error: ${phaserResp.error.message}`);
  const phaserText = (phaserResp.result as { content: { text: string }[] }).content[0].text;
  if (!phaserText.includes('Block 90')) {
    throw new Error(`lookup_lineage phaser (MXR) missing Block 90:\n${phaserText}`);
  }
  console.log(`✓ lookup_lineage structured (phaser/manufacturer="MXR") found Block 90`);

  // Wah block by forward lookup.
  const wahResp = await request('tools/call', {
    name: 'lookup_lineage',
    arguments: { port: 'am4', block_type: 'wah', name: 'Cry Babe', include_quotes: false },
  });
  if (wahResp.error) throw new Error(`lookup_lineage wah error: ${wahResp.error.message}`);
  const wahText = (wahResp.result as { content: { text: string }[] }).content[0].text;
  if (!wahText.includes('Dunlop') || !wahText.includes('Cry Baby')) {
    throw new Error(`lookup_lineage wah (Cry Babe) missing Dunlop Cry Baby lineage:\n${wahText}`);
  }
  console.log(`✓ lookup_lineage forward (wah/"Cry Babe") returned Dunlop Cry Baby`);

  // apply_preset validation (BK-027 phase 1 + 2). Exercises the pre-MIDI
  // validation path so the smoke test runs without a connected AM4.
  // v0.3: tests now exercise the unified apply_preset tool with port="am4"
  // (the legacy am4_apply_preset / am4_apply_preset_at were removed).
  // The unified spec shape uses {slots[].slot, slots[].params:{channel:{...}},
  // scenes[].scene, scenes[].bypassed}. The applyExecutor's AM4-specific
  // validation still fires below the dispatcher.
  const assertApplyPresetError = async (
    label: string,
    spec: unknown,
    expectedFragment: string,
  ): Promise<void> => {
    const resp = await request('tools/call', {
      name: 'apply_preset',
      arguments: { port: 'am4', spec },
    });
    const result = resp.result as
      | {
          isError?: boolean;
          content: { type: string; text: string }[];
          structuredContent?: {
            ok?: boolean;
            validation_errors?: { path: string; error: string }[];
          };
        }
      | undefined;
    const structured = result?.structuredContent;
    // BK-059: validation now returns ok:false + validation_errors[] as a
    // structured success response rather than throwing. Treat that as
    // rejection and search across every error's `path` + `error` strings.
    const validationErrors = structured?.validation_errors ?? [];
    const isValidationRejection =
      structured?.ok === false && validationErrors.length > 0;
    const errMessage =
      resp.error?.message
      ?? (isValidationRejection
        ? validationErrors.map((v) => `${v.path}: ${v.error}`).join(' | ')
        : (result?.content?.[0]?.text ?? ''));
    const rejected = !!resp.error || result?.isError === true || isValidationRejection;
    if (!rejected) {
      throw new Error(`apply_preset ${label}: expected rejection, got success: ${JSON.stringify(resp.result)}`);
    }
    if (!errMessage.includes(expectedFragment)) {
      throw new Error(
        `apply_preset ${label}: expected error to include "${expectedFragment}", got:\n${errMessage}`,
      );
    }
  };

  await assertApplyPresetError(
    'channels on a block without channels',
    { slots: [{ slot: 1, block_type: 'compressor', params_by_channel: { A: { ratio: 4 } } }] },
    'does not expose channels',
  );
  console.log(`✓ apply_preset rejects channels on compressor (no channel register)`);

  await assertApplyPresetError(
    'unknown channel letter',
    { slots: [{ slot: 1, block_type: 'amp', params_by_channel: { E: { gain: 6 } } }] },
    'unknown channel "E"',
  );
  console.log(`✓ apply_preset rejects unknown channel letter E`);

  await assertApplyPresetError(
    'unknown param inside channels.<letter>',
    { slots: [{ slot: 1, block_type: 'amp', params_by_channel: { A: { not_a_real_param: 6 } } }] },
    'slots[0].params.A.not_a_real_param',
  );
  console.log(`✓ apply_preset surfaces path-like error for unknown param inside channels`);

  // Name-field validation — zod max rejects the 33-char name at input.
  await assertApplyPresetError(
    'overlong name',
    { slots: [{ slot: 1, block_type: 'amp' }], name: 'x'.repeat(33) },
    '32',
  );
  console.log(`✓ apply_preset rejects overlong name (33 chars)`);

  // scenes[] validation (BK-027 phase 2). Like the slot validation, these
  // fail in the pre-MIDI validation layer so no hardware is required.
  await assertApplyPresetError(
    'scenes: empty scene entry',
    { slots: [{ slot: 1, block_type: 'amp' }], scenes: [{ scene: 1 }] },
    'at least one of channels / bypass / name',
  );
  console.log(`✓ apply_preset rejects scene entry with no channels/bypass/name`);

  await assertApplyPresetError(
    'scenes: duplicate index',
    {
      slots: [{ slot: 1, block_type: 'amp' }],
      scenes: [
        { scene: 2, channels: { amp: 'A' } },
        { scene: 2, channels: { amp: 'B' } },
      ],
    },
    'used twice',
  );
  console.log(`✓ apply_preset rejects duplicate scene index`);

  await assertApplyPresetError(
    'scenes: unknown block in channels map',
    {
      slots: [{ slot: 1, block_type: 'amp' }],
      scenes: [{ scene: 1, channels: { not_a_block: 'A' } }],
    },
    'channels.not_a_block',
  );
  console.log(`✓ apply_preset rejects unknown block in scenes[].channels`);

  await assertApplyPresetError(
    'scenes: channels on block without channels',
    {
      slots: [{ slot: 1, block_type: 'compressor' }],
      scenes: [{ scene: 1, channels: { compressor: 'A' } }],
    },
    "doesn't have channels",
  );
  console.log(`✓ apply_preset rejects scenes[].channels on compressor`);

  await assertApplyPresetError(
    'scenes: non-A/B/C/D letter',
    {
      slots: [{ slot: 1, block_type: 'amp' }],
      scenes: [{ scene: 1, channels: { amp: 'E' } }],
    },
    'is not valid on Fractal AM4',
  );
  console.log(`✓ apply_preset rejects non-A/B/C/D letter in scenes[].channels`);

  await assertApplyPresetError(
    'scenes: unknown block in bypass map',
    {
      slots: [{ slot: 1, block_type: 'amp' }],
      scenes: [{ scene: 1, bypassed: { not_a_block: true } }],
    },
    'bypassed.not_a_block',
  );
  console.log(`✓ apply_preset rejects unknown block in scenes[].bypass`);

  await assertApplyPresetError(
    'scenes: "none" in bypass map',
    {
      slots: [{ slot: 1, block_type: 'amp' }],
      scenes: [{ scene: 1, bypassed: { none: true } }],
    },
    'unknown block "none"',
  );
  console.log(`✓ apply_preset rejects "none" in scenes[].bypass`);

  // BK-030 Session B — generic-MIDI primitives. These tools fail in two
  // discrete places: zod input-schema validation (channel out of range,
  // missing required arg) which surfaces as a JSON-RPC error; and the
  // tool body's port-resolution / message-builder validation, which
  // surfaces as a structured tool-result with isError-equivalent text.
  // The bogus port name below is long enough that it can't accidentally
  // match a real MIDI device on the test machine.
  const BOGUS_PORT = 'definitely-not-a-real-midi-port-xyz';

  const assertSendError = async (
    label: string,
    toolName: string,
    args: unknown,
    expectedFragment: string,
  ): Promise<void> => {
    const resp = await request('tools/call', { name: toolName, arguments: args });
    const result = resp.result as
      | { isError?: boolean; content: { type: string; text: string }[] }
      | undefined;
    const errMessage = resp.error?.message ?? result?.content?.[0]?.text ?? '';
    if (!errMessage.includes(expectedFragment)) {
      throw new Error(
        `${toolName} ${label}: expected error to include "${expectedFragment}", got:\n${errMessage}`,
      );
    }
  };

  // Happy paths — port doesn't exist, so the message builder validates
  // (proving wiring is correct) and the connection layer surfaces a
  // port-not-found error (proving the connection registry took the call).
  await assertSendError(
    'happy path against missing port',
    'send_cc',
    { port: BOGUS_PORT, channel: 1, controller: 7, value: 100 },
    'No MIDI port matching',
  );
  console.log(`✓ send_cc happy path validates input + surfaces port-not-found`);

  await assertSendError(
    'happy path against missing port',
    'send_program_change',
    { port: BOGUS_PORT, channel: 1, program: 5 },
    'No MIDI port matching',
  );
  console.log(`✓ send_program_change happy path validates input + surfaces port-not-found`);

  await assertSendError(
    'happy path (high-res) against missing port',
    'send_nrpn',
    { port: BOGUS_PORT, channel: 1, parameter_msb: 0, parameter_lsb: 74, value: 8192, high_res: true },
    'No MIDI port matching',
  );
  console.log(`✓ send_nrpn happy path validates 14-bit value + surfaces port-not-found`);

  // Schema rejection (zod-level) — channel above 16 fails before the body
  // runs, so the wire-channel conversion never happens.
  await assertSendError(
    'channel out of range',
    'send_cc',
    { port: BOGUS_PORT, channel: 17, controller: 7, value: 100 },
    'channel',
  );
  console.log(`✓ send_cc rejects channel 17 (above 1..16)`);

  // Body-level rejection — F0/F7 framing is checked by validateSysEx,
  // which throws a clear message. The zod schema doesn't enforce framing.
  await assertSendError(
    'sysex missing F0',
    'send_sysex',
    { port: BOGUS_PORT, bytes: [0x12, 0x34, 0xF7] },
    'must start with F0',
  );
  console.log(`✓ send_sysex rejects missing F0 framing`);

  await assertSendError(
    'sysex missing F7',
    'send_sysex',
    { port: BOGUS_PORT, bytes: [0xF0, 0x12, 0x34] },
    'must end with F7',
  );
  console.log(`✓ send_sysex rejects missing F7 framing`);

  await assertSendError(
    'sysex body byte > 127',
    'send_sysex',
    { port: BOGUS_PORT, bytes: [0xF0, 0x80, 0xF7] },
    'must be 0..127',
  );
  console.log(`✓ send_sysex rejects body byte > 127`);

  // Note duration cap — schema rejects > 5000.
  await assertSendError(
    'note duration too long',
    'send_note',
    { port: BOGUS_PORT, channel: 1, note: 60, velocity: 100, duration_ms: 6000 },
    'duration_ms',
  );
  console.log(`✓ send_note rejects duration_ms > 5000`);

  // New MIDI primitive tools (pitch bend, clock, song position, panic,
  // reset controllers, channel pressure). Happy paths verify input
  // validation runs then the connection layer rejects the bogus port.
  await assertSendError(
    'pitch bend happy path against missing port',
    'send_pitch_bend',
    { port: BOGUS_PORT, channel: 1, value: 0 },
    'No MIDI port matching',
  );
  console.log(`✓ send_pitch_bend happy path validates input + surfaces port-not-found`);

  await assertSendError(
    'pitch bend value out of range',
    'send_pitch_bend',
    { port: BOGUS_PORT, channel: 1, value: 8192 },
    'value',
  );
  console.log(`✓ send_pitch_bend rejects value 8192 (above +8191)`);

  await assertSendError(
    'song position happy path',
    'send_song_position',
    { port: BOGUS_PORT, beats: 0 },
    'No MIDI port matching',
  );
  console.log(`✓ send_song_position happy path validates input + surfaces port-not-found`);

  await assertSendError(
    'song position 14-bit cap',
    'send_song_position',
    { port: BOGUS_PORT, beats: 16384 },
    'beats',
  );
  console.log(`✓ send_song_position rejects beats 16384 (above 0..16383)`);

  await assertSendError(
    'clock start (no channel)',
    'send_clock_start',
    { port: BOGUS_PORT },
    'No MIDI port matching',
  );
  console.log(`✓ send_clock_start happy path (no channel) surfaces port-not-found`);

  await assertSendError(
    'panic across all 16 channels',
    'send_panic',
    { port: BOGUS_PORT },
    'No MIDI port matching',
  );
  console.log(`✓ send_panic happy path (16-channel loop) surfaces port-not-found`);

  await assertSendError(
    'channel pressure happy path',
    'send_channel_pressure',
    { port: BOGUS_PORT, channel: 1, pressure: 64 },
    'No MIDI port matching',
  );
  console.log(`✓ send_channel_pressure happy path validates input + surfaces port-not-found`);

  await assertSendError(
    'reset controllers happy path',
    'send_reset_controllers',
    { port: BOGUS_PORT, channel: 1 },
    'No MIDI port matching',
  );
  console.log(`✓ send_reset_controllers happy path validates input + surfaces port-not-found`);

  child.stdin.end();
  await once(child, 'exit');
  const stderrStr = Buffer.concat(stderrChunks).toString('utf8');
  if (!stderrStr.includes('running on stdio')) {
    console.error('⚠ expected startup banner in stderr but saw:');
    console.error(stderrStr);
  } else {
    console.log('✓ startup banner present in stderr');
  }
  console.log('\nSmoke test PASS.');
}

main().catch((err) => {
  console.error('Smoke test FAIL:', err.message);
  process.exit(1);
});
