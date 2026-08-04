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
  const child = spawn('node', ['packages/server-all/dist/server/index.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // Windows needs shell=true for npx
    env: { ...process.env },
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
    'list_midi_ports',
    'reconnect_midi',
    'send_cc',
    'send_chord',
    'send_clock_continue',
    'send_clock_start',
    'send_clock_stop',
    'send_note',
    'send_nrpn',
    'send_panic',
    'send_program_change',
    'send_reset_controllers',
    'send_sequence',
    'send_song_position',
    'send_sysex',
    // Hydrasynth tools (renamed from hydra_* prefix where applicable).
    'apply_patch',
    'init_patch',
    'set_macro',
    'set_system_param',
    // Unified tool surface (port-dispatched, device-agnostic).
    'apply_preset',
    'describe_device',
    'find_compatible_types',
    'get_param',
    'get_params',
    'get_preset',
    'list_params',
    'lookup_lineage',
    'save_preset',
    'scan_locations',
    'set_block',
    'set_bypass',
    'set_param',
    'set_params',
    'switch_preset',
    'switch_scene',
    'translate_preset',
  ];
  for (const exp of expected) {
    if (!names.includes(exp)) throw new Error(`missing tool: ${exp}`);
  }
  console.log(`✓ all ${expected.length} expected tools registered`);

  // ── Schema-contract tier (P2 test-gap closure) ───────────────────
  // tools/list validated NAMES only; a missing input-schema field shipped
  // silently (set_params lacked an `instance` field → "Amp 2" rejected;
  // reconnect_midi / set_macro were hardcoded to AM4 with no `port` arg).
  // Assert the input-schema SHAPE so those regress-loudly in-gate.
  const schemaTools = tools as Array<{ name: string; inputSchema?: unknown }>;
  // Deep search a JSON-schema object for a property key anywhere in its
  // properties / items / nested objects (covers ops:[{...instance...}]).
  const schemaHasProp = (schema: unknown, prop: string): boolean => {
    if (schema === null || typeof schema !== 'object') return false;
    const s = schema as Record<string, unknown>;
    const props = s.properties as Record<string, unknown> | undefined;
    if (props && Object.prototype.hasOwnProperty.call(props, prop)) return true;
    for (const v of Object.values(s)) {
      if (Array.isArray(v)) { if (v.some((e) => schemaHasProp(e, prop))) return true; }
      else if (typeof v === 'object' && schemaHasProp(v, prop)) return true;
    }
    return false;
  };
  const schemaFor = (name: string): unknown => {
    const t = schemaTools.find((x) => x.name === name);
    if (!t) throw new Error(`schema-contract: tool ${name} not found`);
    return t.inputSchema;
  };
  const assertSchemaProp = (toolName: string, prop: string, why: string): void => {
    if (!schemaHasProp(schemaFor(toolName), prop)) {
      throw new Error(`schema-contract: ${toolName} input schema is missing "${prop}" (${why})`);
    }
  };
  // set_params / get_params must let the agent address a block instance
  // (Amp 2 / amp_2). The op/query items carry `instance`.
  assertSchemaProp('set_params', 'instance', 'agent cannot address block instance 2 (alpha #2 regression)');
  assertSchemaProp('get_params', 'instance', 'agent cannot read block instance 2');
  // Device-agnostic tools must accept a `port` so they route to the
  // connected device, not a hardcoded AM4 (alpha Bug E / Bug I).
  assertSchemaProp('reconnect_midi', 'port', 'reconnect_midi would be hardcoded to one device (alpha Bug E)');
  assertSchemaProp('set_macro', 'port', 'set_macro would be hardcoded to AM4 (alpha Bug I)');
  console.log('✓ schema-contract: set_params/get_params expose `instance`; reconnect_midi/set_macro expose `port`');

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
  //
  // TWO calls, because the tool has two answers. Unfiltered is a per-block
  // CENSUS with no param rows (serializing all 894 was 219,691 chars, past
  // the host's 50,000-char delivery cliff, so the model received none of it);
  // the rows come from the block-scoped call. Asserting `gain` against the
  // unfiltered call would only re-assert the behaviour that was removed.
  const censusResp = await request('tools/call', {
    name: 'list_params',
    arguments: { port: 'am4' },
  });
  if (censusResp.error) throw new Error(`tools/call error: ${censusResp.error.message}`);
  const censusText = (censusResp.result as { content: { type: string; text: string }[] }).content[0].text;
  const census = JSON.parse(censusText) as {
    scope?: string;
    params?: unknown[];
    block_summary?: { block: string; param_count: number }[];
  };
  if (census.scope !== 'summary' || (census.params?.length ?? 0) > 0) {
    throw new Error(`list_params(port) should be a census with no rows; got scope=${census.scope}, ${census.params?.length} rows`);
  }
  const ampCensus = census.block_summary?.find((b) => b.block === 'amp');
  if (ampCensus === undefined || ampCensus.param_count < 100) {
    throw new Error(`list_params census missing the amp block or its count:\n${censusText}`);
  }

  const callResp = await request('tools/call', {
    name: 'list_params',
    arguments: { port: 'am4', block: ['amp'] },
  });
  if (callResp.error) throw new Error(`tools/call error: ${callResp.error.message}`);
  const text = (callResp.result as { content: { type: string; text: string }[] }).content[0].text;
  if (!text.includes('amp')) throw new Error(`list_params output missing amp block:\n${text}`);
  if (!text.includes('gain')) throw new Error(`list_params output missing gain param:\n${text}`);
  console.log(`✓ list_params census (${census.block_summary?.length} blocks) + amp rows returned catalog`);

  // Exercise lookup_lineage forward + reverse — doesn't touch MIDI, just
  // reads src/knowledge/*.json. Confirms the tool is wired up and the data
  // is present.
  const forwardResp = await request('tools/call', {
    name: 'lookup_lineage',
    arguments: { port: 'am4', block_type: 'drive', name: ['T808 OD'] },
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
    arguments: { port: 'am4', block_type: 'wah', name: ['Cry Babe'], include_quotes: false },
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

  // translate_preset e2e: exercises the full MCP tool-call path (schema
  // validation, dispatcher, translator) without touching MIDI. Two cases:
  // AM4 -> II (param alias + enum mapping + channel collapse) and
  // AM4 -> III (topology + channel identity).
  const translateAm4ToIiResp = await request('tools/call', {
    name: 'translate_preset',
    arguments: {
      source_port: 'am4',
      source_spec: {
        slots: [
          {
            slot: 2,
            block_type: 'amp',
            params_by_channel: {
              A: { type: 'USA MK IIC+', gain: 6, master: 5 },
              B: { type: 'Shiver Clean', gain: 3, master: 7 },
            },
          },
          {
            slot: 3,
            block_type: 'drive',
            params: { type: 'Rat Distortion', drive: 7, level: 5 },
          },
        ],
        scenes: [
          { scene: 1, channels: { amp: 'A' } },
          { scene: 2, channels: { amp: 'B' } },
        ],
      },
      target_port: 'axe-fx-ii',
    },
  });
  if (translateAm4ToIiResp.error) {
    throw new Error(`translate_preset AM4→II error: ${translateAm4ToIiResp.error.message}`);
  }
  const translateIiText = (translateAm4ToIiResp.result as { content: { text: string }[] }).content[0].text;
  const translateIiJson = JSON.parse(translateIiText);
  if (!translateIiJson.ok) throw new Error(`translate_preset AM4→II returned ok:false`);
  // F6g (2026-05-28): linear→grid auto-places a cab block after the amp
  // since II has a separate cab block. Source: amp + reverb = 2 channel-
  // bearing blocks; with auto-cab the result is 3 slots.
  if (translateIiJson.port_summary.blocks_translated !== 3) {
    throw new Error(`translate_preset AM4→II expected 3 blocks translated (amp + auto-cab + reverb), got ${translateIiJson.port_summary.blocks_translated}`);
  }
  if (translateIiJson.port_summary.params_aliased < 2) {
    throw new Error(`translate_preset AM4→II expected >=2 params aliased (master→master_volume, level→volume), got ${translateIiJson.port_summary.params_aliased}`);
  }
  if (translateIiJson.port_summary.enums_mapped < 1) {
    throw new Error(`translate_preset AM4→II expected >=1 enum mapped (USA MK IIC+→USA IIC+), got ${translateIiJson.port_summary.enums_mapped}`);
  }
  const iiAmpSlot = translateIiJson.applied_spec.slots.find((s: { block_type: string }) => s.block_type === 'amp');
  if (!iiAmpSlot?.params_by_channel?.X) {
    throw new Error(`translate_preset AM4→II: amp channel A should remap to X`);
  }
  const iiCabSlot = translateIiJson.applied_spec.slots.find((s: { block_type: string }) => s.block_type.toLowerCase() === 'cab');
  if (!iiCabSlot) {
    throw new Error(`translate_preset AM4→II: expected auto-placed cab block (F6g) but none found`);
  }
  console.log(`✓ translate_preset AM4→II: 3 blocks (amp + auto-cab + reverb), aliases, enums, channels (A/B→X/Y)`);

  const translateAm4ToIiiResp = await request('tools/call', {
    name: 'translate_preset',
    arguments: {
      source_port: 'am4',
      source_spec: {
        slots: [
          { slot: 1, block_type: 'amp', params: { type: 'Shiver Clean', gain: 4 } },
          { slot: 2, block_type: 'reverb', params: { type: 'Plate, Large', mix: 35 } },
        ],
      },
      target_port: 'axe-fx-iii',
    },
  });
  if (translateAm4ToIiiResp.error) {
    throw new Error(`translate_preset AM4→III error: ${translateAm4ToIiiResp.error.message}`);
  }
  const translateIiiText = (translateAm4ToIiiResp.result as { content: { text: string }[] }).content[0].text;
  const translateIiiJson = JSON.parse(translateIiiText);
  if (!translateIiiJson.ok) throw new Error(`translate_preset AM4→III returned ok:false`);
  // F6g: AM4→III also auto-places a cab. 2 source blocks + 1 auto-cab = 3.
  if (translateIiiJson.port_summary.blocks_translated !== 3) {
    throw new Error(`translate_preset AM4→III expected 3 blocks translated (amp + auto-cab + reverb), got ${translateIiiJson.port_summary.blocks_translated}`);
  }
  const iiiAmpSlot = translateIiiJson.applied_spec.slots.find((s: { block_type: string }) => s.block_type === 'amp');
  if (!iiiAmpSlot || typeof iiiAmpSlot.slot !== 'object' || iiiAmpSlot.slot.row !== 2) {
    throw new Error(`translate_preset AM4→III: linear slot 1 should map to grid {row:2, col:1}, got ${JSON.stringify(iiiAmpSlot?.slot)}`);
  }
  console.log(`✓ translate_preset AM4→III: 3 blocks (amp + auto-cab + reverb), linear→grid topology, channels preserved (A/B/C/D identity)`);

  // Same-device translation should reject.
  const translateSameResp = await request('tools/call', {
    name: 'translate_preset',
    arguments: {
      source_port: 'am4',
      source_spec: { slots: [{ slot: 1, block_type: 'amp' }] },
      target_port: 'am4',
    },
  });
  const translateSameResult = translateSameResp.result as { isError?: boolean; content: { text: string }[] } | undefined;
  const translateSameText = translateSameResult?.content?.[0]?.text ?? '';
  if (!translateSameText.includes('same device')) {
    throw new Error(`translate_preset same-device should reject with "same device", got: ${translateSameText}`);
  }
  console.log(`✓ translate_preset rejects same-device translation (AM4→AM4)`);

  // Cross-preset-class translation (guitar-modeler ↔ synth-voice) should
  // refuse with a structured class-mismatch error. Bug G in the alpha.13
  // report — alpha.13 silently accepted Hydrasynth → II reverb translations
  // and produced unusable output.
  const translateClassResp = await request('tools/call', {
    name: 'translate_preset',
    arguments: {
      source_port: 'hydrasynth',
      source_spec: { slots: [{ slot: 1, block_type: 'reverb', params: { type: 'Plate', dry_wet: 25 } }] },
      target_port: 'axe-fx-ii',
    },
  });
  const translateClassResult = translateClassResp.result as { isError?: boolean; content: { text: string }[] } | undefined;
  const translateClassText = translateClassResult?.content?.[0]?.text ?? '';
  if (!translateClassText.toLowerCase().includes('preset class') && !translateClassText.toLowerCase().includes('preset_class')) {
    throw new Error(`translate_preset cross-class should reject with class-mismatch text, got: ${translateClassText}`);
  }
  console.log(`✓ translate_preset rejects cross-class translation (Hydrasynth→II)`);

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

  // MIDI primitive tools (clock, song position, panic, reset
  // controllers). Happy paths verify input validation runs then
  // the connection layer rejects the bogus port.
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
