/**
 * Mocked-agent regression for bucket-4 changes (commit 9ca072b).
 *
 * Validates that device-namespaced tools on agent retry paths surface
 * structured DispatchError details (`valid_options` / `valid_options_tool`
 * / `retry_action`) on vocabulary failures, AND emit `structuredContent`
 * alongside the human-readable text on successful calls.
 *
 * Spawns the shipped MCP server with `MCP_MOCK_TRANSPORT=1` so no USB
 * hardware is required. The mock devices ack successful writes; the
 * vocabulary failures we test fire BEFORE any MIDI send so the mock
 * transport isn't even contacted on the negative-path cases.
 *
 * Run: `npm run build && npx tsx scripts/mcp-test-agent-retry-paths.ts`
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
}

const RESULTS: CaseResult[] = [];

function record(name: string, pass: boolean, notes: string[]): void {
  RESULTS.push({ name, pass, notes });
  const tag = pass ? '✓ PASS' : '✗ FAIL';
  console.log(`  ${tag} — ${name}`);
  for (const n of notes) console.log(`      ${n}`);
}

async function main(): Promise<void> {
  const env: Record<string, string> = { ...process.env as Record<string, string>, MCP_MOCK_TRANSPORT: '1' };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env,
    stderr: 'pipe',
  });
  if (transport.stderr) {
    transport.stderr.on('data', (b: Buffer) => {
      const s = b.toString();
      // Filter out the verbose smoke-server boot banner; keep errors visible.
      if (/error|throw/i.test(s)) process.stderr.write(`[server] ${s}`);
    });
  }
  const client = new Client(
    { name: 'mcp-test-agent-retry-paths', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);

    // ── Axe-Fx II: bad block name on set_block_channel ──────────────
    console.log('\nAxe-Fx II — vocabulary retry path');
    {
      const r = await client.callTool({
        name: 'axefx2_set_block_channel',
        arguments: { block: 'NonExistentBlockName', channel: 'X' },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const hasValidOptions = /Valid options:/i.test(t);
      const hasRetryAction = /Call axefx2_list_block_types|axefx2_list_block_types for the full list/i.test(t);
      const namesBlock = /Unknown block "NonExistentBlockName"/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text contains "Valid options:" → ${hasValidOptions}`);
      notes.push(`text contains list_block_types pointer → ${hasRetryAction}`);
      notes.push(`text quotes bad input → ${namesBlock}`);
      const pass = isErr && hasValidOptions && hasRetryAction && namesBlock;
      record('axefx2_set_block_channel(bad name) → structured DispatchError', pass, notes);
    }

    // ── Axe-Fx II: SUCCESS path on a valid block ────────────────────
    {
      const r = await client.callTool({
        name: 'axefx2_set_block_channel',
        arguments: { block: 'Amp 1', channel: 'X' },
      });
      const sc = structured(r);
      const notes: string[] = [];
      const isErr = isError(r);
      notes.push(`isError=${isErr}`);
      notes.push(`structuredContent present → ${sc !== undefined}`);
      if (sc) {
        notes.push(`  block=${JSON.stringify(sc['block'])} channel=${JSON.stringify(sc['channel'])} effect_id=${JSON.stringify(sc['effect_id'])}`);
      }
      const pass = !isErr
        && sc !== undefined
        && sc['block'] === 'Amp 1'
        && sc['channel'] === 'X'
        && typeof sc['effect_id'] === 'number';
      record('axefx2_set_block_channel(good name) → structuredContent emitted', pass, notes);
    }

    // ── Hydrasynth: bad System CC id ────────────────────────────────
    console.log('\nHydrasynth — vocabulary retry path');
    {
      const r = await client.callTool({
        name: 'hydra_set_param',
        arguments: { id: 'system.bogus', value: 64 },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const hasValidOptions = /Valid options:/i.test(t);
      const hasNRPNPointer = /set_param\(\{port:"hydrasynth"/i.test(t)
        || /set_param.*port.*hydrasynth/i.test(t);
      const namesId = /Unknown parameter id "system.bogus"/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text contains "Valid options:" → ${hasValidOptions}`);
      notes.push(`text steers engine writes to unified set_param → ${hasNRPNPointer}`);
      notes.push(`text quotes bad input → ${namesId}`);
      const pass = isErr && hasValidOptions && hasNRPNPointer && namesId;
      record('hydra_set_param(bad id) → structured DispatchError', pass, notes);
    }

    // ── Hydrasynth: success on valid id ─────────────────────────────
    {
      const r = await client.callTool({
        name: 'hydra_set_param',
        arguments: { id: 'system.master_volume', value: 100 },
      });
      const sc = structured(r);
      const notes: string[] = [];
      const isErr = isError(r);
      notes.push(`isError=${isErr}`);
      notes.push(`structuredContent present → ${sc !== undefined}`);
      if (sc) {
        notes.push(`  id=${JSON.stringify(sc['id'])} cc=${JSON.stringify(sc['cc'])} value=${JSON.stringify(sc['value'])}`);
      }
      const pass = !isErr
        && sc !== undefined
        && sc['id'] === 'system.master_volume'
        && typeof sc['cc'] === 'number'
        && sc['value'] === 100;
      record('hydra_set_param(good id) → structuredContent emitted', pass, notes);
    }

    // ── Hydrasynth: engine id rejected with steer-to-unified hint ───
    {
      const r = await client.callTool({
        name: 'hydra_set_param',
        arguments: { id: 'osc1type', value: 0 },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      // osc1type isn't in HYDRASYNTH_PARAMS at all (NRPN-only). It should
      // hit the "Unknown parameter id" branch with valid_options.
      const hasValidOptions = /Valid options:/i.test(t);
      const pointsAtUnified = /set_param\(\{port:"hydrasynth"/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text contains "Valid options:" → ${hasValidOptions}`);
      notes.push(`text steers to unified set_param → ${pointsAtUnified}`);
      const pass = isErr && hasValidOptions && pointsAtUnified;
      record('hydra_set_param(engine id) → steers agent to unified surface', pass, notes);
    }

    // ── Axe-Fx III: bad block name on get_bypass ────────────────────
    console.log('\nAxe-Fx III — vocabulary retry path');
    {
      const r = await client.callTool({
        name: 'axefx3_get_bypass',
        arguments: { block: 'NotARealBlockName' },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const hasRetryAction = /axefx3_list_blocks/i.test(t);
      const namesBlock = /Unknown Axe-Fx III block "NotARealBlockName"/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text contains axefx3_list_blocks pointer → ${hasRetryAction}`);
      notes.push(`text quotes bad input → ${namesBlock}`);
      const pass = isErr && hasRetryAction && namesBlock;
      record('axefx3_get_bypass(bad name) → structured DispatchError', pass, notes);
    }

    // ── Axe-Fx III: bad block on set_parameter (the raw-wire path) ──
    {
      const r = await client.callTool({
        name: 'axefx3_set_parameter',
        arguments: { block: 'Wibble 99', param_id: 1, value: 32767 },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const hasRetryAction = /axefx3_list_blocks/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text contains axefx3_list_blocks pointer → ${hasRetryAction}`);
      const pass = isErr && hasRetryAction;
      record('axefx3_set_parameter(bad name) → structured DispatchError', pass, notes);
    }

    // ── AM4: bad block name on get_block_bypass ─────────────────────
    console.log('\nAM4 — vocabulary retry path');
    {
      const r = await client.callTool({
        name: 'am4_get_block_bypass',
        arguments: { block: 'NotAnAm4Block' },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const hasValidOptions = /Valid options:/i.test(t);
      const namesBlock = /Unknown block "NotAnAm4Block"/i.test(t);
      const pointsAtDescribeDevice = /describe_device\(\{port:"am4"\}\)\.blocks/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text contains "Valid options:" → ${hasValidOptions}`);
      notes.push(`text quotes bad input → ${namesBlock}`);
      notes.push(`text points at describe_device → ${pointsAtDescribeDevice}`);
      const pass = isErr && hasValidOptions && namesBlock && pointsAtDescribeDevice;
      record('am4_get_block_bypass(bad name) → structured DispatchError', pass, notes);
    }

    // ── AM4: "none" block is structurally rejected ──────────────────
    {
      const r = await client.callTool({
        name: 'am4_get_block_bypass',
        arguments: { block: 'none' },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const explainsNone = /isn't a real block/i.test(t) && /Pass a real block name/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text explains "none" sentinel → ${explainsNone}`);
      const pass = isErr && explainsNone;
      record('am4_get_block_bypass("none") → structured DispatchError', pass, notes);
    }

    // ── Hydrasynth: bad slot string on navigate_to ──────────────────
    console.log('\nHydrasynth — slot retry path');
    {
      const r = await client.callTool({
        name: 'hydra_navigate_to',
        arguments: { slot: 'Z999' },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const pointsAtSlotFormat = /A001.*H128/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text points at A001..H128 slot format → ${pointsAtSlotFormat}`);
      const pass = isErr && pointsAtSlotFormat;
      record('hydra_navigate_to(bad slot) → structured DispatchError', pass, notes);
    }

    // ── Hydrasynth: bad param name on apply_patch ───────────────────
    {
      const r = await client.callTool({
        name: 'hydra_apply_patch',
        arguments: {
          slot: 'H128',
          dance: 'none',
          params: [{ name: 'NotARealParam', value: 64 }],
        },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const namesParam = /unknown param "NotARealParam"/i.test(t);
      const pointsAtListParams = /list_params\(\{port:"hydrasynth"\}\)/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text quotes bad input → ${namesParam}`);
      notes.push(`text points at list_params → ${pointsAtListParams}`);
      const pass = isErr && namesParam && pointsAtListParams;
      record('hydra_apply_patch(bad param) → structured DispatchError', pass, notes);
    }

    // ── Axe-Fx II: bad shape in test_apply ──────────────────────────
    console.log('\nAxe-Fx II — test_apply validation retry path');
    {
      const r = await client.callTool({
        name: 'axefx2_test_apply',
        arguments: {
          blocks: [
            { block: 'NotARealBlock' },
          ],
          on_active_preset_edited: 'discard',
        },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const pointsAtUnified = /apply_preset\(\{port:"axe-fx-ii", spec, verify_chain:true\}\)/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text steers to unified apply_preset → ${pointsAtUnified}`);
      const pass = isErr && pointsAtUnified;
      record('axefx2_test_apply(bad shape) → steers to unified apply_preset', pass, notes);
    }

    // ── Axe-Fx III: success on valid block (mock transport acks) ────
    console.log('\nAxe-Fx III — success path (continued)');
    {
      const r = await client.callTool({
        name: 'axefx3_set_parameter',
        arguments: { block: 'Reverb 1', param_id: 1, value: 32767 },
      });
      const sc = structured(r);
      const notes: string[] = [];
      const isErr = isError(r);
      notes.push(`isError=${isErr}`);
      notes.push(`structuredContent present → ${sc !== undefined}`);
      if (sc) {
        notes.push(`  block=${JSON.stringify(sc['block'])} param_id=${JSON.stringify(sc['param_id'])} value=${JSON.stringify(sc['value'])}`);
      }
      const pass = !isErr
        && sc !== undefined
        && sc['block'] === 'Reverb 1'
        && sc['param_id'] === 1
        && sc['value'] === 32767;
      record('axefx3_set_parameter(good name) → structuredContent emitted', pass, notes);
    }

    // ── Bucket 7: II channel-write safety (refusal on mismatch) ─────
    console.log('\nAxe-Fx II — bucket 7 channel-write safety');
    {
      // Mock reports every block on channel X. Writing with channel='Y'
      // must refuse with a structured DispatchError explaining the
      // cross-scene corruption hazard and naming switch_scene as the
      // safe alternative.
      const r = await client.callTool({
        name: 'set_param',
        arguments: { port: 'axe-fx-ii', block: 'amp', name: 'input_drive', value: 5, channel: 'Y' },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const refusesWrite = /refusing to write/i.test(t);
      const explainsHazard = /mutates the channel pointer across multiple scenes/i.test(t);
      const pointsAtSwitchScene = /switch_scene/i.test(t);
      const offersDropChannel = /omit the channel arg|drop the channel arg/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text refuses write → ${refusesWrite}`);
      notes.push(`text explains cross-scene hazard → ${explainsHazard}`);
      notes.push(`text points at switch_scene → ${pointsAtSwitchScene}`);
      notes.push(`text offers drop-channel alternative → ${offersDropChannel}`);
      const pass = isErr && refusesWrite && explainsHazard && pointsAtSwitchScene && offersDropChannel;
      record('set_param(axe-fx-ii, channel:Y when active=X) → channel-mismatch refusal', pass, notes);
    }

    {
      // Same call WITHOUT the channel arg — must NOT refuse. The mock
      // accepts the write and the dispatcher returns a success envelope
      // with the resolved display value.
      const r = await client.callTool({
        name: 'set_param',
        arguments: { port: 'axe-fx-ii', block: 'amp', name: 'input_drive', value: 5 },
      });
      const sc = structured(r);
      const notes: string[] = [];
      const isErr = isError(r);
      notes.push(`isError=${isErr}`);
      notes.push(`structuredContent present → ${sc !== undefined}`);
      // We don't gate on a specific wire_value here because the calibration
      // overlay maps display 5 → a calibrated wire integer; the test cares
      // that the write succeeded, not the exact wire shape.
      const pass = !isErr && sc !== undefined;
      record('set_param(axe-fx-ii, no channel arg) → write proceeds without safety gate', pass, notes);
    }

    {
      // Channel arg that MATCHES the mock's reported channel (X) must
      // also proceed — the gating is "refuse on mismatch", not "refuse
      // on any channel arg". This guards against an over-zealous future
      // refactor that breaks the matching-channel case.
      const r = await client.callTool({
        name: 'set_param',
        arguments: { port: 'axe-fx-ii', block: 'amp', name: 'input_drive', value: 5, channel: 'X' },
      });
      const sc = structured(r);
      const notes: string[] = [];
      const isErr = isError(r);
      notes.push(`isError=${isErr}`);
      notes.push(`structuredContent present → ${sc !== undefined}`);
      const pass = !isErr && sc !== undefined;
      record('set_param(axe-fx-ii, channel:X when active=X) → write proceeds (matching channel)', pass, notes);
    }

    // ── Bucket 7: loudness offsets surfaced on enum metadata ────────
    console.log('\nUnified — bucket 7 loudness offsets on enum');
    {
      // list_params for amp.type on Axe-Fx II must carry
      // enum_value_loudness_offsets_db with at least one known anchor
      // (DOUBLE VERB NRML maps to 0 dB — the reference amp).
      const r = await client.callTool({
        name: 'list_params',
        arguments: { port: 'axe-fx-ii', block: 'amp', name: 'type' },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const hasField = /enum_value_loudness_offsets_db/i.test(t);
      const hasReferenceAmp = /DOUBLE VERB NRM/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`response carries enum_value_loudness_offsets_db → ${hasField}`);
      notes.push(`response includes reference amp label "DOUBLE VERB NRM" → ${hasReferenceAmp}`);
      const pass = !isErr && hasField && hasReferenceAmp;
      record('list_params(axe-fx-ii, amp, type) → loudness offsets surfaced on enum', pass, notes);
    }

    {
      // Same for AM4 amp.type. AM4 labels are the corpus keys, so the
      // reference amp label is "Double Verb Normal" verbatim.
      const r = await client.callTool({
        name: 'list_params',
        arguments: { port: 'am4', block: 'amp', name: 'type' },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const hasField = /enum_value_loudness_offsets_db/i.test(t);
      const hasReferenceAmp = /Double Verb Normal/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`response carries enum_value_loudness_offsets_db → ${hasField}`);
      notes.push(`response includes reference amp label → ${hasReferenceAmp}`);
      const pass = !isErr && hasField && hasReferenceAmp;
      record('list_params(am4, amp, type) → loudness offsets surfaced on enum', pass, notes);
    }

    {
      // Non-amp/drive enums must NOT carry the offset field — keeps the
      // response shape minimal where the data doesn't apply.
      const r = await client.callTool({
        name: 'list_params',
        arguments: { port: 'am4', block: 'reverb', name: 'type' },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const hasField = /enum_value_loudness_offsets_db/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`response omits enum_value_loudness_offsets_db → ${!hasField}`);
      const pass = !isErr && !hasField;
      record('list_params(am4, reverb, type) → no loudness offsets (out of scope)', pass, notes);
    }

    // ── AM4 AMP-slot bypass quirk: both set_bypass + toggle_bypass refuse ──
    console.log('\nAM4 AMP-slot bypass quirk refusals');
    {
      // set_bypass(am4, amp, true) used to silently write to the BOOST
      // register. Must now refuse with capability_not_supported and a
      // retry_action pointing at set_param master/boost.
      const r = await client.callTool({
        name: 'set_bypass',
        arguments: { port: 'am4', block: 'amp', bypassed: true },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const namesQuirk = /no bypass register|always engaged/i.test(t);
      const pointsAtMaster = /amp\.master|amp\.level/i.test(t);
      const pointsAtBoost = /boost/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`names AMP-slot quirk → ${namesQuirk}`);
      notes.push(`points at amp.master/level fallback → ${pointsAtMaster}`);
      notes.push(`mentions boost retarget → ${pointsAtBoost}`);
      const pass = isErr && namesQuirk && pointsAtMaster && pointsAtBoost;
      record('set_bypass(am4, amp) → refuses with AMP-slot quirk explanation', pass, notes);
    }
    {
      // toggle_bypass(am4, amp) refuses for the same reason. Both refusals
      // should give the same fallback advice (don't loop the agent).
      const r = await client.callTool({
        name: 'toggle_bypass',
        arguments: { port: 'am4', block: 'amp' },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const namesQuirk = /no bypass register|always engaged/i.test(t);
      const pointsAtMaster = /amp\.master|amp\.level/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`names AMP-slot quirk → ${namesQuirk}`);
      notes.push(`points at amp.master/level fallback → ${pointsAtMaster}`);
      const pass = isErr && namesQuirk && pointsAtMaster;
      record('toggle_bypass(am4, amp) → refuses with AMP-slot quirk explanation', pass, notes);
    }
    {
      // set_bypass on a non-AMP block must still proceed normally.
      // Mock accepts the write; structuredContent should be present.
      const r = await client.callTool({
        name: 'set_bypass',
        arguments: { port: 'am4', block: 'reverb', bypassed: true },
      });
      const sc = structured(r);
      const notes: string[] = [];
      const isErr = isError(r);
      notes.push(`isError=${isErr}`);
      notes.push(`structuredContent present → ${sc !== undefined}`);
      const pass = !isErr && sc !== undefined;
      record('set_bypass(am4, reverb) → write proceeds on non-AMP block', pass, notes);
    }

    // ── BK-070: get_preset routes correctly + capability gating ─────
    console.log('\nBK-070 — unified get_preset routing');
    {
      // Axe-Fx II implements getPreset; mock returns an empty 48-cell
      // grid + a "Mock Preset" name, so the response should have an
      // empty slots array and the name populated. Verifies the dispatcher
      // routes to descriptor.reader.getPreset, the reader assembles
      // grid + name, and the unified tool envelope is well-formed.
      const r = await client.callTool({
        name: 'get_preset',
        arguments: { port: 'axe-fx-ii' },
      });
      const sc = structured(r);
      const notes: string[] = [];
      const isErr = isError(r);
      notes.push(`isError=${isErr}`);
      notes.push(`structuredContent present → ${sc !== undefined}`);
      if (sc) {
        notes.push(`  name=${JSON.stringify(sc['name'])}`);
        notes.push(`  slots.length=${(sc['slots'] as unknown[] | undefined)?.length ?? '<missing>'}`);
      }
      const slots = sc?.['slots'] as unknown[] | undefined;
      const pass = !isErr && sc !== undefined && sc['name'] === 'Mock Preset' && Array.isArray(slots) && slots.length === 0;
      record('get_preset(axe-fx-ii) → empty grid mock returns name + empty slots', pass, notes);
    }
    {
      // AM4 doesn't implement getPreset; dispatcher must surface
      // capability_not_supported with a clear retry_action pointing at
      // get_param. Validates the optional-method gate in the dispatcher.
      const r = await client.callTool({
        name: 'get_preset',
        arguments: { port: 'am4' },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const mentionsCapability = /not implemented for Fractal AM4|capability_not_supported/i.test(t);
      const pointsAtFallback = /get_param/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text mentions capability gap → ${mentionsCapability}`);
      notes.push(`text points at get_param fallback → ${pointsAtFallback}`);
      const pass = isErr && mentionsCapability && pointsAtFallback;
      record('get_preset(am4) → capability_not_supported with get_param fallback hint', pass, notes);
    }
  } finally {
    await client.close();
  }

  // ── Summary ─────────────────────────────────────────────────────
  const passed = RESULTS.filter((r) => r.pass).length;
  const failed = RESULTS.filter((r) => !r.pass).length;
  console.log(`\n────────────────────────────────────────`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const r of RESULTS.filter((r) => !r.pass)) {
      console.log(`  ✗ ${r.name}`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(99);
});
