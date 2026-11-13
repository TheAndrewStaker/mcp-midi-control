/**
 * Mocked-agent regression for tool retry / error-recovery paths.
 *
 * Validates that the unified tool surface (get_param, set_param, set_bypass,
 * get_preset, list_params, set_system_param, apply_patch) surfaces structured
 * DispatchError details (`valid_options` / `valid_options_tool` /
 * `retry_action`) on vocabulary failures, AND emits `structuredContent`
 * alongside the human-readable text on successful calls. A handful of
 * device-namespaced legacy tools that remain registered are covered too.
 *
 * Spawns the shipped MCP server with `MCP_MOCK_TRANSPORT=1` so no USB
 * hardware is required. The mock devices ack successful writes (and, since
 * the fn 0x1F AM4 / fn 0x02 II read responders landed, answer the read
 * paths get_preset / get_param exercise); the vocabulary failures we test
 * fire BEFORE any MIDI send so the mock transport isn't even contacted on
 * the negative-path cases.
 *
 * Gated: this runs in `npm test` (test:server tier) and therefore in
 * `npm run preflight`. It was previously parked in test:release-extras
 * where it rotted stale-red (referenced the removed am4_get_block_bypass
 * tool + an obsolete AM4 get_preset capability_not_supported expectation).
 *
 * Run: `npm run build && npx tsx scripts/mcp-test-agent-retry-paths.ts`
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

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
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );

  try {
    await client.connect(transport);

    // ── Hydrasynth: bad System CC id ────────────────────────────────
    console.log('\nHydrasynth — vocabulary retry path');
    {
      const r = await client.callTool({
        name: 'set_system_param',
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
      record('set_system_param(bad id) → structured DispatchError', pass, notes);
    }

    // ── Hydrasynth: success on valid id ─────────────────────────────
    {
      const r = await client.callTool({
        name: 'set_system_param',
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
      record('set_system_param(good id) → structuredContent emitted', pass, notes);
    }

    // ── Hydrasynth: engine id rejected with steer-to-unified hint ───
    {
      const r = await client.callTool({
        name: 'set_system_param',
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
      record('set_system_param(engine id) → steers agent to unified surface', pass, notes);
    }

    // ── AM4: unknown block name on the unified get_param ────────────
    // Replaces the removed am4_get_block_bypass(bad name) case. The
    // unified surface resolves the block via resolveBlockName, which
    // throws a structured `unknown_block` DispatchError naming the bad
    // input and steering the agent to the block vocabulary (inline list
    // for ≤8 blocks, or a list_params pointer when there are more).
    console.log('\nAM4 — vocabulary retry path (unified surface)');
    {
      const r = await client.callTool({
        name: 'get_param',
        arguments: { port: 'am4', block: 'NotAnAm4Block', name: 'gain' },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const namesBlock = /NotAnAm4Block/.test(t);
      const namesDevice = /not valid on Fractal AM4/i.test(t);
      const steersToVocab = /list_params/i.test(t) || /Blocks:/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text quotes bad block → ${namesBlock}`);
      notes.push(`text names the device + "not valid" → ${namesDevice}`);
      notes.push(`text steers to block vocabulary (list_params/Blocks:) → ${steersToVocab}`);
      const pass = isErr && namesBlock && namesDevice && steersToVocab;
      record('get_param(am4, bad block) → structured unknown_block DispatchError', pass, notes);
    }

    // ── AM4: unknown param name on a real block ─────────────────────
    // Replaces the removed am4_get_block_bypass("none") sentinel case
    // with the other vocabulary dimension: a valid block but an unknown
    // param. resolveParamName throws `unknown_param` and steers the agent
    // to list_params(port, block) for the param vocabulary.
    {
      const r = await client.callTool({
        name: 'get_param',
        arguments: { port: 'am4', block: 'amp', name: 'notaparam' },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const namesParam = /notaparam/i.test(t);
      const steersToListParams = /list_params/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text quotes bad param → ${namesParam}`);
      notes.push(`text steers to list_params → ${steersToListParams}`);
      const pass = isErr && namesParam && steersToListParams;
      record('get_param(am4, amp, bad param) → structured unknown_param DispatchError', pass, notes);
    }

    // ── Hydrasynth: bad param name on apply_patch ───────────────────
    {
      const r = await client.callTool({
        name: 'apply_patch',
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
      record('apply_patch(bad param) → structured DispatchError', pass, notes);
    }

    // axefx2_test_apply removed 2026-05-21 (T-2). Its "DEPRECATED, use
    // apply_preset" deprecation-steering path tested here is gone too;
    // callers now find the unified apply_preset directly. No replacement
    // assertion needed.

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
        arguments: { port: 'axe-fx-ii', block: ['amp'], name: ['type'] },
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
        arguments: { port: 'am4', block: ['amp'], name: ['type'] },
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
        arguments: { port: 'am4', block: ['reverb'], name: ['type'] },
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

    // ── AM4 AMP-slot bypass quirk: set_bypass refuses ──
    // Note: companion toggle_bypass test removed 2026-05-23 — the
    // tool was cut entirely. set_bypass refusal stays as the canonical
    // agent-facing AMP-slot quirk message.
    console.log('\nAM4 AMP-slot bypass quirk refusal');
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
      // AM4 now implements getPreset (the old capability_not_supported
      // expectation was obsolete). Under the mock the AM4 fn 0x1F
      // GET_ALL_PARAMS triple responder lets getPreset read the 4 placed
      // blocks of the default mock working buffer (amp/chorus/reverb/delay),
      // so the unified get_preset returns a well-formed PresetSnapshot.
      // Asserts the dispatcher routes to descriptor.reader.getPreset and
      // the envelope carries the required slots + _meta contract fields.
      const r = await client.callTool({
        name: 'get_preset',
        arguments: { port: 'am4' },
      });
      const sc = structured(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const slots = sc?.['slots'] as unknown[] | undefined;
      const meta = sc?.['_meta'] as Record<string, unknown> | undefined;
      notes.push(`isError=${isErr}`);
      notes.push(`structuredContent present → ${sc !== undefined}`);
      if (sc) {
        notes.push(`  slots.length=${slots?.length ?? '<missing>'}`);
        notes.push(`  _meta.device=${JSON.stringify(meta?.['device'])}`);
      }
      const pass = !isErr
        && sc !== undefined
        && Array.isArray(slots)
        && meta !== undefined
        && meta['device'] !== undefined;
      record('get_preset(am4) → returns a well-formed PresetSnapshot (slots + _meta)', pass, notes);
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
