/**
 * Non-destructive launch verification battery, hardware-present.
 *
 * Drives the shipped MCP server (dist/server/index.js) via
 * StdioClientTransport, the same JSON-RPC path Claude Desktop uses.
 * Runs read-only and working-buffer-only checks: no flash saves, no
 * save_preset. Working-buffer changes revert naturally when the user
 * switches presets. Each device's checks run only if its port is visible
 * in list_midi_ports; an absent device is skipped, not failed.
 *
 * What it verifies, per device:
 *   • AM4: read surface (get_param, list_params, scan_locations,
 *     lookup_lineage with frontPanelKnobs / notExposed annotations),
 *     unpadded location format (A1..Z4), audition apply_preset (with and
 *     without target_location), and linear-device-contract rejections
 *     (routing[] and instance != 1 refused, type-gated params skip-warn).
 *   • Axe-Fx II: read surface, audition apply_preset, routing-walk
 *     audition (wet/dry parallel chain via explicit routing[] edges).
 *   • Axe-Fx Standard/Ultra (gen-1): describe_device + community-beta
 *     guidance, list_params, set_param (fire-and-forget), get_param wired
 *     (read-back), save_preset refuses with capability_not_supported.
 *   • FM9 (gen-3): describe_device + community-beta guidance that
 *     advertises set-by-name, list_params, set_param amp/drive type
 *     BY MODEL NAME (device-true rosters), get_param wired.
 *   • Axe-Fx III (gen-3): describe_device + save_note + set-by-name
 *     guidance, list_params, set_param amp.type by name, get_param wired.
 *   • FM3 (gen-3, USB-CDC serial): describe_device (4×12 grid note +
 *     save_note), list_params, set_param amp.type by name (FM3-hardware-
 *     confirmed leg), get_param wired. NOTE: the FM3 is a SERIAL device —
 *     it appears in list_midi_ports only via the serial-candidates section
 *     (or a DIN/loopMIDI port named "FM3"); absence skips, never fails.
 *   • Hydrasynth: describe_device, NRPN apply_patch (no flash-save claim).
 *
 * NOT covered (would require flash writes):
 *   • save_preset wire path, exercised by mcp-test-safe-edit-scenarios --write.
 *   • Persisted routing-walk + audio sign-off (needs an overwritable slot).
 *
 * USAGE:
 *   npm run launch-verify                       # all default ports
 *   npm run launch-verify -- --port am4         # AM4 only
 *   npm run launch-verify -- --port axefx2      # Axe-Fx II only
 *   npm run launch-verify -- --port axefx-gen1  # gen-1 only
 *   npm run launch-verify -- --port fm9         # FM9 only
 *   npm run launch-verify -- --port axe-fx-iii  # Axe-Fx III only
 *   npm run launch-verify -- --port fm3         # FM3 only
 *   npm run launch-verify -- --port hydrasynth  # Hydrasynth only
 *
 * EXIT CODES:
 *   0 — every applicable check passed
 *   1 — one or more checks failed
 *   2 — server handshake failed
 */

import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');

// ── CLI ────────────────────────────────────────────────────────────

interface CliOpts {
  ports: string[];
}

function parseCli(argv: string[]): CliOpts {
  const opts: CliOpts = { ports: ['am4', 'axefx2', 'axefx-gen1', 'axe-fx-iii', 'fm3', 'fm9', 'hydrasynth', 'circuit'] };
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
    // BK-103 (2026-07-15): mix-ready cab polish defaults must reach the agent,
    // reference the CORRECT registers (master_low_cut, NOT the old misnamed
    // cab_master_low_cut = proximity), and carry the amp-type reset trap.
    const guidance = (parsed as { agent_guidance?: Record<string, string> })?.agent_guidance;
    record(
      'am4 agent_guidance carries cab_polish with correct keys + reset trap',
      !!guidance?.cab_polish &&
        /master_low_cut/.test(guidance.cab_polish) &&
        !/cab_master_low_cut/.test(guidance.cab_polish) &&
        /room_level/.test(guidance.cab_polish) &&
        /RESETS/.test(guidance.cab_polish) &&
        /wide open/.test(guidance.cab_polish),
      `cab_polish present=${!!guidance?.cab_polish}`,
    );
    record(
      'am4 agent_guidance cab_polish advertises DynaCab selection by name',
      !!guidance?.cab_polish && /dynacab_1_cab/.test(guidance.cab_polish),
      `cab_polish present=${!!guidance?.cab_polish}`,
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
      arguments: { port: 'am4', block: ['amp'] },
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

  // lookup_lineage forward — `name` is always an array (batch-only).
  // Returns { entries: [...] } with one entry per name, even for N=1.
  // Verifies multi-name fanning + per-entry loudness attachment.
  {
    const r = await client.callTool({
      name: 'lookup_lineage',
      arguments: {
        port: 'am4',
        block_type: 'amp',
        name: ['USA MK IIC+', 'Double Verb Normal'],
      },
    });
    const t = extractText(r);
    const parsed = (() => { try { return JSON.parse(t); } catch { return undefined; } })();
    const entries = parsed?.entries;
    record(
      'lookup_lineage forward (array name) returns one entry per name with loudness',
      !isError(r)
        && Array.isArray(entries)
        && entries.length === 2
        && entries[0]?.name === 'USA MK IIC+'
        && entries[1]?.name === 'Double Verb Normal'
        && entries.every((e: { loudness?: unknown }) => e.loudness !== undefined),
      t.slice(0, 600),
    );
  }

  // lookup_lineage N=1 — confirms single-name still works via the array
  // form. Single-string form was removed; `["X"]` is the only forward path.
  {
    const r = await client.callTool({
      name: 'lookup_lineage',
      arguments: { port: 'am4', block_type: 'drive', name: ['T808 OD'] },
    });
    const t = extractText(r);
    const parsed = (() => { try { return JSON.parse(t); } catch { return undefined; } })();
    const entries = parsed?.entries;
    record(
      'lookup_lineage forward N=1 (["T808 OD"]) returns single-entry array',
      !isError(r)
        && Array.isArray(entries)
        && entries.length === 1
        && entries[0]?.name === 'T808 OD'
        && /Tube Screamer/.test(entries[0]?.text ?? ''),
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
            { slot: 1, block_type: 'amp', params_by_channel: { A: { type: 'Plexi 100W High', gain: 4 } } },
            { slot: 2, block_type: 'reverb', params_by_channel: { A: { type: 'Room, Medium', mix: 25 } } },
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
            { slot: 1, block_type: 'amp', params_by_channel: { A: { type: '1959SLP Normal', gain: 5 } } },
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
              params_by_channel: { A: { type: '5F8 Tweed Normal', gain: 5, master: 5 } },
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

  // BK-075 phantom-param pre-flight (Session 112): set_param targeting a
  // block not placed in any slot wire-acks but the device silently no-ops.
  // The dispatcher surfaces a validation_info[] warning with the unplaced-
  // block + retry_action. AM4 mock default layout is amp/chorus/reverb/
  // delay, so 'phaser' is guaranteed-absent.
  //
  // Sequence (matters):
  //   1. switch_preset to Z3 with discard — flushes any dirty state from
  //      earlier tests AND invalidates the cached layout snapshot.
  //   2. set_param targeting an absent block — pre-flight should fire.
  //
  // Without the switch_preset, an earlier set_block in this run may have
  // placed a phaser somewhere, defeating the absent-block test.
  {
    await client.callTool({
      name: 'switch_preset',
      arguments: { port: 'am4', location: 'Z3', on_active_preset_edited: 'discard' },
    });
    const r = await client.callTool({
      name: 'set_param',
      arguments: { port: 'am4', block: 'phaser', name: 'rate', value: 3 },
    });
    const t = extractText(r);
    record(
      'set_param on unplaced block (phaser) surfaces validation_info[] warning',
      !isError(r) && /validation_info/.test(t)
        && /"dropped_param"\s*:\s*"rate"/.test(t)
        && /"level"\s*:\s*"warning"/.test(t),
      t.slice(0, 500),
    );
    record(
      'phantom-param warning names retry_action with set_block',
      !isError(r) && /set_block/.test(t) && /phaser/.test(t),
      t.slice(0, 500),
    );
  }

  // BK-075 negative case: set_param on a PLACED block should NOT carry a
  // phantom-param warning. Deterministically place amp at slot 1 first —
  // the battery may run against real hardware whose stored Z3 preset
  // doesn't include amp (the mock invariant places amp/chorus/reverb/
  // delay, but a user-edited Z3 carries whatever the founder last saved).
  // set_block invalidates the block-layout cache, so the next set_param
  // re-reads placement and observes the just-placed amp.
  {
    await client.callTool({
      name: 'set_block',
      arguments: { port: 'am4', slot: 1, block_type: 'amp' },
    });
    const r = await client.callTool({
      name: 'set_param',
      arguments: { port: 'am4', block: 'amp', name: 'gain', value: 5 },
    });
    const t = extractText(r);
    record(
      'set_param on placed block (amp.gain) has no phantom-param warning',
      !isError(r) && !/validation_info/.test(t),
      t.slice(0, 300),
    );
  }

  // export_preset → import_preset round trip on the working buffer.
  // AM4 PRESET_DUMP is a 6-message stream totaling 12,352 bytes. Export is
  // read-only; import pushes the same bytes back to the working buffer
  // (non-destructive, reverts on the next preset switch).
  {
    const dir = path.join(tmpdir(), 'mcp-midi-launch-verify');
    const r = await client.callTool({ name: 'export_preset', arguments: { port: 'am4', directory: dir } });
    const t = extractText(r);
    let parsed: { ok?: boolean; byte_length?: number; file_path?: string } | undefined;
    try { parsed = JSON.parse(t); } catch { parsed = undefined; }
    record(
      'export_preset writes a 12,352-byte AM4 .syx backup',
      !isError(r) && parsed?.ok === true && parsed?.byte_length === 12352 && typeof parsed?.file_path === 'string',
      t.slice(0, 300),
    );
    if (parsed?.file_path) {
      const ir = await client.callTool({ name: 'import_preset', arguments: { port: 'am4', file_path: parsed.file_path } });
      const it = extractText(ir);
      let ip: { ok?: boolean; frames_sent?: number; nacks?: unknown[] } | undefined;
      try { ip = JSON.parse(it); } catch { ip = undefined; }
      record(
        'import_preset re-applies the AM4 backup (6 frames, 0 NACKs)',
        !isError(ir) && ip?.ok === true && ip?.frames_sent === 6 && Array.isArray(ip?.nacks) && ip.nacks.length === 0,
        it.slice(0, 300),
      );
    }
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
            { slot: 1, block_type: 'amp', params_by_channel: { X: { input_drive: 4, master_volume: 5 } } },
            { slot: 2, block_type: 'cab' },
            { slot: 3, block_type: 'reverb', params_by_channel: { X: { mix: 25 } } },
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

  // BK-077 channel-Y inactive pre-flight (Session 113): apply_preset
  // spec carries channel-nested amp params for both X and Y, but the
  // single authored scene routes amp→X. Dispatcher surfaces a
  // validation_info[] warning naming the inactive Y channel.
  {
    const r = await client.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'axefx2',
        spec: {
          name: 'YINACTIVE',
          slots: [
            { slot: 1, block_type: 'amp', params_by_channel: { X: { input_drive: 3, master_volume: 5 }, Y: { input_drive: 8, master_volume: 6 } } },
            { slot: 2, block_type: 'cab' },
          ],
          scenes: [{ scene: 1, channels: { amp: 'X' } }],
        },
        on_active_preset_edited: 'discard',
      },
    });
    const t = extractText(r);
    record(
      'axefx2 apply_preset channel-Y inactive surfaces validation_info[] warning',
      !isError(r) && /validation_info/.test(t)
        && /"level"\s*:\s*"warning"/.test(t)
        && /channel-Y|channel Y/i.test(t),
      t.slice(0, 500),
    );
    record(
      'axefx2 channel-Y warning retry_action mentions scenes[N] mapping',
      !isError(r) && /scenes\[/.test(t),
      t.slice(0, 500),
    );
  }

  // BK-077 negative case: same spec but with a scene that DOES route
  // amp→Y. Both X and Y are active across the scenes; no warning fires.
  {
    const r = await client.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'axefx2',
        spec: {
          name: 'XYACTIVE',
          slots: [
            { slot: 1, block_type: 'amp', params_by_channel: { X: { input_drive: 3, master_volume: 5 }, Y: { input_drive: 8, master_volume: 6 } } },
            { slot: 2, block_type: 'cab' },
          ],
          scenes: [
            { scene: 1, channels: { amp: 'X' } },
            { scene: 2, channels: { amp: 'Y' } },
          ],
        },
        on_active_preset_edited: 'discard',
      },
    });
    const t = extractText(r);
    record(
      'axefx2 apply_preset X+Y with scene→Y has no channel-Y inactive warning',
      !isError(r) && !/channel-Y|channel Y/i.test(t),
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

  // export_preset → import_preset round trip on the working buffer.
  // Axe-Fx II PATCH_DUMP is a 66-message stream totaling 12,951 bytes. Import
  // pushes the same bytes back (non-destructive, self-verifying via ACK count).
  {
    const dir = path.join(tmpdir(), 'mcp-midi-launch-verify');
    const r = await client.callTool({ name: 'export_preset', arguments: { port: 'axefx2', directory: dir } });
    const t = extractText(r);
    let parsed: { ok?: boolean; byte_length?: number; file_path?: string } | undefined;
    try { parsed = JSON.parse(t); } catch { parsed = undefined; }
    record(
      'export_preset writes a 12,951-byte Axe-Fx II .syx backup',
      !isError(r) && parsed?.ok === true && parsed?.byte_length === 12951 && typeof parsed?.file_path === 'string',
      t.slice(0, 300),
    );
    if (parsed?.file_path) {
      const ir = await client.callTool({ name: 'import_preset', arguments: { port: 'axefx2', file_path: parsed.file_path } });
      const it = extractText(ir);
      let ip: { ok?: boolean; frames_sent?: number; nacks?: unknown[] } | undefined;
      try { ip = JSON.parse(it); } catch { ip = undefined; }
      record(
        'import_preset re-applies the Axe-Fx II backup (66 frames, 0 NACKs)',
        !isError(ir) && ip?.ok === true && ip?.frames_sent === 66 && Array.isArray(ip?.nacks) && ip.nacks.length === 0,
        it.slice(0, 300),
      );
    }
  }
}

async function verifyAxefxGen1(client: Client): Promise<void> {
  console.log('\n── Axe-Fx Standard/Ultra (gen-1) ────────────────────────────');

  // describe_device — capabilities, support_tier, read-back guidance.
  {
    const r = await client.callTool({ name: 'describe_device', arguments: { port: 'axe-fx-gen1' } });
    const t = extractText(r);
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { parsed = undefined; }
    const caps = (parsed as { capabilities?: Record<string, unknown> })?.capabilities;
    const guidance = (parsed as { agent_guidance?: Record<string, string> })?.agent_guidance;
    record('gen1 describe_device returns capabilities', !isError(r) && !!caps, t.slice(0, 200));
    record(
      'gen1 support_tier is community-beta',
      (caps as { support_tier?: string } | undefined)?.support_tier === 'community-beta',
      `support_tier=${String((caps as Record<string, unknown> | undefined)?.support_tier)}`,
    );
    record(
      'gen1 agent_guidance carries read_back key (reads supported, community-beta)',
      !!guidance?.read_back && /read-back|get_param/i.test(guidance.read_back) && /community-beta|unconfirmed/i.test(guidance.read_back),
      `read_back present=${!!guidance?.read_back}`,
    );
    record(
      'gen1 agent_guidance carries capabilities key',
      !!guidance?.capabilities && /set_param|get_param/i.test(guidance.capabilities),
      `capabilities present=${!!guidance?.capabilities}`,
    );
  }

  // list_params — confirm amp block is present in the catalog.
  {
    const r = await client.callTool({
      name: 'list_params',
      arguments: { port: 'axe-fx-gen1', block: 'amp' },
    });
    const t = extractText(r);
    record('gen1 list_params amp returns catalog', !isError(r) && /type|gain|level/i.test(t), t.slice(0, 200));
  }

  // set_param — a simple linear dB knob (compressor.threshold).
  // This verifies the SET wire path builds without error (the read path is
  // exercised separately below).
  //
  // COVERAGE BOUNDARY: this exercises a LINEAR param only. The gen-1 non-linear
  // params (scaling:"pending" in fractal-midi/gen1/params.ts — e.g.
  // compressor.sustain, parametric_eq.freq_*) have a known display range but an
  // UNKNOWN display→wire curve, so their display-first coercion is unverified by
  // design and is NOT asserted here. There is nothing to golden-test until a
  // hardware capture pins the curve; treat their display values as pass-through
  // until then. Tracked by the scaling:"pending" marker, not a skipped test.
  {
    const r = await client.callTool({
      name: 'set_param',
      arguments: { port: 'axe-fx-gen1', block: 'compressor', name: 'threshold', value: -20 },
    });
    const t = extractText(r);
    record('gen1 set_param compressor.threshold succeeds', !isError(r), t.slice(0, 200));
    record(
      'gen1 set_param response does NOT claim read-back confirmation',
      !isError(r) && !/confirmed|read back|verified.*device|device.*verified/i.test(t),
      t.slice(0, 400),
    );
  }

  // get_param is now WIRED on gen-1 (fn 0x02 query -> MIDI_PARAM_VALUE,
  // community-beta). Without a responding gen-1 unit in the harness the read
  // times out and returns `no_ack`; the key assertion is that it no longer
  // refuses with capability_not_supported (the read path exists).
  {
    const r = await client.callTool({
      name: 'get_param',
      arguments: { port: 'axe-fx-gen1', block: 'compressor', name: 'threshold' },
    });
    const t = extractText(r);
    record(
      'gen1 get_param is wired (not capability_not_supported)',
      !/capability_not_supported/i.test(t),
      t.slice(0, 200),
    );
  }

  // get_preset is now WIRED on gen-1 (fn 0x03 -> fn 0x04 patch dump, SPEC-
  // PINNED SUBSET: name + effect-grid layout; per-param values NOT decoded).
  // Without a responding gen-1 unit in the harness the dump request times out
  // and returns `no_ack` — that is a clean skip; the key assertion is that it
  // no longer refuses with capability_not_supported (the dump path exists).
  {
    const r = await client.callTool({
      name: 'get_preset',
      arguments: { port: 'axe-fx-gen1' },
    });
    const t = extractText(r);
    record(
      'gen1 get_preset is wired (not capability_not_supported)',
      !/capability_not_supported/i.test(t),
      t.slice(0, 200),
    );
    if (/no_ack/i.test(t)) {
      console.log('  ⊘ gen1 get_preset: no device answered the fn 0x03 dump request (expected without gen-1 hardware) — dump content not verified.');
    }
  }

  // get_preset bank-C stored reads must refuse BEFORE any wire bytes: the
  // spec flags the bank-C request byte as OR'd with an unknown value, so
  // presets >= 256 are unpinned. Deterministic — needs no device reply.
  {
    const r = await client.callTool({
      name: 'get_preset',
      arguments: { port: 'axe-fx-gen1', location: 300 },
    });
    const t = extractText(r);
    record(
      'gen1 get_preset refuses bank-C locations (>=256, unpinned request byte)',
      /capability_not_supported|bank.?c/i.test(t),
      t.slice(0, 200),
    );
  }

  // save_preset must refuse (no save on gen-1).
  {
    const r = await client.callTool({
      name: 'save_preset',
      arguments: { port: 'axe-fx-gen1', location: 'A01' },
    });
    const t = extractText(r);
    record(
      'gen1 save_preset refuses with capability_not_supported',
      isError(r) || /capability_not_supported|not.*support/i.test(t),
      t.slice(0, 200),
    );
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

  // hydra_get_active_patch removed; Hydrasynth has no SysEx for reading
  // the active slot. Users read the front panel directly.

  // Audition apply_patch via apply_patch — slot omitted means
  // the tool navigates to H128 scratch and dumps the patch to that
  // working buffer. NOT a flash save. The audition_slot_honesty
  // guidance prevents the agent from narrating this as "saved to H128"
  // — but the response itself can mention H128 as the navigation
  // target (factual). We only fail if the response uses save-intent
  // wording.
  {
    const r = await client.callTool({
      name: 'apply_patch',
      arguments: {
        params: [{ name: 'amplevel', value: 90 }],
      },
    });
    const t = extractText(r);
    record('apply_patch (working-buffer audition) succeeds', !isError(r), t.slice(0, 400));
    record(
      'apply_patch response does NOT claim flash save',
      !isError(r) && !/saved to flash|persisted to|wrote to flash|stored in flash/i.test(t),
      t.slice(0, 400),
    );
  }
}

async function verifyFm9(client: Client): Promise<void> {
  console.log('\n── FM9 (gen-3) ───────────────────────────────────────────────');

  // describe_device — capabilities + device_note advertises set-by-name.
  {
    const r = await client.callTool({ name: 'describe_device', arguments: { port: 'fm9' } });
    const t = extractText(r);
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { parsed = undefined; }
    const caps = (parsed as { capabilities?: Record<string, unknown> })?.capabilities;
    const guidance = (parsed as { agent_guidance?: Record<string, string> })?.agent_guidance;
    record('fm9 describe_device returns capabilities', !isError(r) && !!caps, t.slice(0, 200));
    record(
      'fm9 support_tier is community-beta',
      (caps as { support_tier?: string } | undefined)?.support_tier === 'community-beta',
      `support_tier=${String((caps as Record<string, unknown> | undefined)?.support_tier)}`,
    );
    // The guidance must ADVERTISE set-by-name, not undersell it.
    record(
      'fm9 device_note advertises set-by-name with model names (not numeric-only)',
      !!guidance?.device_note && /by name/i.test(guidance.device_note) && /Texas Star Clean|Blues OD|Music Hall/i.test(guidance.device_note),
      `device_note present=${!!guidance?.device_note}`,
    );
    // supports_save=false must come WITH the save_note clarification, or an
    // agent reading capabilities concludes save_preset is unavailable (the
    // 0.3.0 underselling class: the tool works, only auto-save is gated).
    const saveNote = (caps as { save_note?: string } | undefined)?.save_note;
    record(
      'fm9 capabilities.save_note clarifies that explicit save_preset works',
      typeof saveNote === 'string' && /save_preset/.test(saveNote) && /ARE available|does NOT mean/i.test(saveNote),
      `save_note=${String(saveNote).slice(0, 120)}`,
    );
  }

  // list_params amp — catalog present.
  {
    const r = await client.callTool({ name: 'list_params', arguments: { port: 'fm9', block: 'amp' } });
    const t = extractText(r);
    record('fm9 list_params amp returns catalog', !isError(r) && /type|gain|drive|level/i.test(t), t.slice(0, 200));
  }

  // set_param amp.type BY NAME — the headline 0.3.0 capability. The dispatch
  // must resolve the FM9-true roster name to its ordinal and build the wire
  // without error (no capability gate, no "numeric only" rejection).
  {
    const r = await client.callTool({
      name: 'set_param',
      arguments: { port: 'fm9', block: 'amp', name: 'type', value: 'Texas Star Clean' },
    });
    const t = extractText(r);
    record('fm9 set_param amp.type "Texas Star Clean" (set-by-name) succeeds', !isError(r), t.slice(0, 300));
    record(
      'fm9 set_param response does NOT claim flash save',
      !isError(r) && !/saved to|persisted to|stored to|wrote to flash/i.test(t),
      t.slice(0, 300),
    );
  }

  // set_param drive.type BY NAME.
  {
    const r = await client.callTool({
      name: 'set_param',
      arguments: { port: 'fm9', block: 'drive', name: 'type', value: 'Blues OD' },
    });
    const t = extractText(r);
    record('fm9 set_param drive.type "Blues OD" (set-by-name) succeeds', !isError(r), t.slice(0, 300));
  }

  // get_param amp.type — read leg labels the ordinal back to a model name.
  {
    const r = await client.callTool({
      name: 'get_param',
      arguments: { port: 'fm9', block: 'amp', name: 'type' },
    });
    const t = extractText(r);
    record('fm9 get_param amp.type is wired (not capability_not_supported)',
      !/capability_not_supported/i.test(t), t.slice(0, 300));
  }
}

async function verifyAxefxIii(client: Client): Promise<void> {
  console.log('\n── Axe-Fx III (gen-3) ────────────────────────────────────────');

  // describe_device — capabilities + guidance advertises set-by-name.
  {
    const r = await client.callTool({ name: 'describe_device', arguments: { port: 'axe-fx-iii' } });
    const t = extractText(r);
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { parsed = undefined; }
    const caps = (parsed as { capabilities?: Record<string, unknown> })?.capabilities;
    const guidance = (parsed as { agent_guidance?: Record<string, string> })?.agent_guidance;
    record('axe-fx-iii describe_device returns capabilities', !isError(r) && !!caps, t.slice(0, 200));
    record(
      'axe-fx-iii support_tier is community-beta',
      (caps as { support_tier?: string } | undefined)?.support_tier === 'community-beta',
      `support_tier=${String((caps as Record<string, unknown> | undefined)?.support_tier)}`,
    );
    // The III's device_note is device-specific (the gen-3 byte-identity anchor,
    // 6x14 grid); set-by-name is advertised family-wide via param_addressing.
    record(
      'axe-fx-iii device_note names the 6x14 grid',
      !!guidance?.device_note && /6x14|6×14/i.test(guidance.device_note),
      `device_note present=${!!guidance?.device_note}`,
    );
    record(
      'axe-fx-iii param_addressing advertises set-by-name (not numeric-only)',
      !!guidance?.param_addressing && /by name/i.test(guidance.param_addressing) && /Texas Star/i.test(guidance.param_addressing),
      `param_addressing present=${!!guidance?.param_addressing}`,
    );
    // supports_save=false must come WITH the save_note clarification (same
    // family-wide contract as the FM9 check above).
    const saveNote = (caps as { save_note?: string } | undefined)?.save_note;
    record(
      'axe-fx-iii capabilities.save_note clarifies that explicit save_preset works',
      typeof saveNote === 'string' && /save_preset/.test(saveNote) && /ARE available|does NOT mean/i.test(saveNote),
      `save_note=${String(saveNote).slice(0, 120)}`,
    );
  }

  // list_params amp — catalog present.
  {
    const r = await client.callTool({ name: 'list_params', arguments: { port: 'axe-fx-iii', block: 'amp' } });
    const t = extractText(r);
    record('axe-fx-iii list_params amp returns catalog', !isError(r) && /type|gain|drive|level/i.test(t), t.slice(0, 200));
  }

  // set_param amp.type BY NAME — the shared gen-3 read rosters resolve the
  // model name to its ordinal; the dispatch must build the wire without a
  // capability gate or a "numeric only" rejection. Working-buffer only.
  {
    const r = await client.callTool({
      name: 'set_param',
      arguments: { port: 'axe-fx-iii', block: 'amp', name: 'type', value: 'Texas Star Clean' },
    });
    const t = extractText(r);
    record('axe-fx-iii set_param amp.type "Texas Star Clean" (set-by-name) succeeds', !isError(r), t.slice(0, 300));
    record(
      'axe-fx-iii set_param response does NOT claim flash save',
      !isError(r) && !/saved to|persisted to|stored to|wrote to flash/i.test(t),
      t.slice(0, 300),
    );
  }

  // get_param amp.type — read leg wired (III read path is hardware-confirmed).
  {
    const r = await client.callTool({
      name: 'get_param',
      arguments: { port: 'axe-fx-iii', block: 'amp', name: 'type' },
    });
    const t = extractText(r);
    record('axe-fx-iii get_param amp.type is wired (not capability_not_supported)',
      !/capability_not_supported/i.test(t), t.slice(0, 300));
  }
}

async function verifyFm3(client: Client): Promise<void> {
  console.log('\n── FM3 (gen-3, USB-CDC serial) ───────────────────────────────');

  // describe_device — capabilities + FM3-specific guidance (4×12 grid).
  {
    const r = await client.callTool({ name: 'describe_device', arguments: { port: 'fm3' } });
    const t = extractText(r);
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { parsed = undefined; }
    const caps = (parsed as { capabilities?: Record<string, unknown> })?.capabilities;
    const guidance = (parsed as { agent_guidance?: Record<string, string> })?.agent_guidance;
    record('fm3 describe_device returns capabilities', !isError(r) && !!caps, t.slice(0, 200));
    record(
      'fm3 support_tier is community-beta',
      (caps as { support_tier?: string } | undefined)?.support_tier === 'community-beta',
      `support_tier=${String((caps as Record<string, unknown> | undefined)?.support_tier)}`,
    );
    // The FM3 grid is 4×12 (NOT the III/FM9 6×14) — the device_note must say
    // so, or an agent authors specs against the wrong grid.
    record(
      'fm3 device_note names the smaller 4×12 grid',
      !!guidance?.device_note && /4×12|4x12/i.test(guidance.device_note),
      `device_note present=${!!guidance?.device_note}`,
    );
    record(
      'fm3 param_addressing advertises set-by-name (not numeric-only)',
      !!guidance?.param_addressing && /by name/i.test(guidance.param_addressing) && /Texas Star/i.test(guidance.param_addressing),
      `param_addressing present=${!!guidance?.param_addressing}`,
    );
    const saveNote = (caps as { save_note?: string } | undefined)?.save_note;
    record(
      'fm3 capabilities.save_note clarifies that explicit save_preset works',
      typeof saveNote === 'string' && /save_preset/.test(saveNote) && /ARE available|does NOT mean/i.test(saveNote),
      `save_note=${String(saveNote).slice(0, 120)}`,
    );
  }

  // list_params amp — FM3-true catalog present.
  {
    const r = await client.callTool({ name: 'list_params', arguments: { port: 'fm3', block: 'amp' } });
    const t = extractText(r);
    record('fm3 list_params amp returns catalog', !isError(r) && /type|gain|drive|level/i.test(t), t.slice(0, 200));
  }

  // set_param amp.type BY NAME — discrete set-by-name is FM3-hardware-
  // confirmed (2026-06-10 community session: frames byte-identical to this
  // server's encoder). Working-buffer only, reverts on preset switch.
  {
    const r = await client.callTool({
      name: 'set_param',
      arguments: { port: 'fm3', block: 'amp', name: 'type', value: 'Texas Star Clean' },
    });
    const t = extractText(r);
    record('fm3 set_param amp.type "Texas Star Clean" (set-by-name) succeeds', !isError(r), t.slice(0, 300));
    record(
      'fm3 set_param response does NOT claim flash save',
      !isError(r) && !/saved to|persisted to|stored to|wrote to flash/i.test(t),
      t.slice(0, 300),
    );
  }

  // get_param amp.type — read leg wired (FM3 reads are hardware-confirmed,
  // 2026-06-12 serial field test).
  {
    const r = await client.callTool({
      name: 'get_param',
      arguments: { port: 'fm3', block: 'amp', name: 'type' },
    });
    const t = extractText(r);
    record('fm3 get_param amp.type is wired (not capability_not_supported)',
      !/capability_not_supported/i.test(t), t.slice(0, 300));
  }
}

async function verifyCircuit(client: Client): Promise<void> {
  console.log('\n── Novation Circuit Tracks ───────────────────────────────────');

  // describe_device — capabilities + agent_guidance. The project_upload guidance
  // must carry the overwrite-gate contract (confirm_overwrite), the #0 first-class
  // gate; a regression that dropped it would let an agent clobber a slot silently.
  {
    const r = await client.callTool({ name: 'describe_device', arguments: { port: 'circuit' } });
    const t = extractText(r);
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { parsed = undefined; }
    const caps = (parsed as { capabilities?: Record<string, unknown> })?.capabilities;
    const guidance = (parsed as { agent_guidance?: Record<string, string> })?.agent_guidance;
    record('circuit describe_device returns capabilities', !isError(r) && !!caps, t.slice(0, 200));
    record(
      'circuit project_upload guidance carries the overwrite gate (confirm_overwrite)',
      !!guidance?.project_upload && /confirm_overwrite/i.test(guidance.project_upload),
      `project_upload present=${!!guidance?.project_upload}`,
    );
    record(
      'circuit sample_upload guidance carries the overwrite gate (confirm_overwrite)',
      !!guidance?.sample_upload && /confirm_overwrite/i.test(guidance.sample_upload),
      `sample_upload present=${!!guidance?.sample_upload}`,
    );
  }

  // list_params filter — catalog present (a real Circuit synth block).
  {
    const r = await client.callTool({ name: 'list_params', arguments: { port: 'circuit', block: 'filter' } });
    const t = extractText(r);
    record('circuit list_params filter returns catalog', !isError(r) && /frequency|resonance|cutoff/i.test(t), t.slice(0, 200));
  }

  // get_param reads SYNTH patch params (osc/filter/env/lfo/mixer/fx/eq) off the
  // working-buffer patch decode (HW-CIRCUIT-001); drum/project/macro/mod-matrix
  // have no readback and refuse. Verify a synth param READS a decoded value
  // (not a refusal, not a fabricated blank).
  {
    const r = await client.callTool({ name: 'get_param', arguments: { port: 'circuit', block: 'filter', name: 'frequency' } });
    const t = extractText(r);
    record('circuit get_param reads a synth param (filter.frequency) via patch decode',
      !isError(r) && /frequency/i.test(t) && /(wire_value|display_value)/i.test(t), t.slice(0, 200));
  }

  // list_pattern_recipes(port) — Circuit is a pattern target advertising the
  // live_stream + ncs_upload realizers.
  {
    const r = await client.callTool({ name: 'list_pattern_recipes', arguments: { port: 'circuit' } });
    const t = extractText(r);
    record('circuit is a pattern target advertising live_stream + ncs_upload',
      !isError(r) && /live_stream/.test(t) && /ncs_upload/.test(t), t.slice(0, 250));
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
    const hasAxefxGen1 = /axe[- ]fx.*(ultra|standard)/i.test(portsText);
    const hasAxefxIii = /axe[- ]?fx ?iii|axefx ?3/i.test(portsText);
    const hasFm9 = /fm9/i.test(portsText);
    // FM3 presence differs from every other device: the FM3 is a USB-CDC
    // SERIAL device, not USB MIDI, so it appears either as a MIDI port line
    // (DIN-via-interface / loopMIDI test rigs) or in the serial-candidates
    // section list_midi_ports appends ("Serial (USB-CDC) ports — FM3 control
    // channel"). The tool's escape-hatch line ("If one of these is an FM3,
    // set MCP_FM3_SERIAL_PATH=…") prints whenever NON-Fractal serial ports
    // exist, so a bare /fm3/i would false-positive — exclude that line.
    const hasFm3 = portsText
      .split('\n')
      .some((line) => /fm[- ]?3/i.test(line) && !/MCP_FM3_SERIAL_PATH/.test(line));
    const hasHydra = /hydrasynth|hydra/i.test(portsText);
    const hasCircuit = /circuit/i.test(portsText);

    // measure_loudness (BK-105): hardware-independent contract check. With
    // no input_device the tool must return the OS input roster and ask (the
    // agent-as-UX shape), never capture. On a machine whose audio backend
    // is unavailable (Linux CI has no device), a graceful capture-engine
    // error is also a pass; a thrown/hung call is the only failure.
    console.log('\n── measure_loudness (device-independent) ─────────────────────');
    {
      const res = await client.callTool({ name: 'measure_loudness', arguments: {} });
      const text = extractText(res);
      const listShape = /"devices"\s*:/.test(text) && /input_device/i.test(text);
      const gracefulUnavailable = /failed to load|unavailable/i.test(text);
      record(
        'measure_loudness with no args returns the input roster (or a graceful engine error)',
        listShape || gracefulUnavailable,
        text.slice(0, 300),
      );
    }

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
    if (opts.ports.includes('axefx-gen1')) {
      if (!hasAxefxGen1) {
        console.log('\n── Axe-Fx Standard/Ultra (gen-1) ────────────────────────────');
        console.log('  ⊘ Axe-Fx Ultra/Standard not visible in list_midi_ports — skipping checks.');
        console.log('  Note: gen-1 verification runs against a real port matching /axe-?fx.*(ultra|standard)/i.');
        console.log('  For offline verification, run with a virtual port named "Axe-Fx Ultra".');
      } else {
        await verifyAxefxGen1(client);
      }
    }
    if (opts.ports.includes('fm9')) {
      if (!hasFm9) {
        console.log('\n── FM9 (gen-3) ───────────────────────────────────────────────');
        console.log('  ⊘ FM9 not visible in list_midi_ports — skipping checks.');
        console.log('  Note: FM9 verification runs against a real port matching /fm9/i (or a loopMIDI port named "FM9").');
      } else {
        await verifyFm9(client);
      }
    }
    if (opts.ports.includes('axe-fx-iii')) {
      if (!hasAxefxIii) {
        console.log('\n── Axe-Fx III (gen-3) ────────────────────────────────────────');
        console.log('  ⊘ Axe-Fx III not visible in list_midi_ports — skipping checks.');
        console.log('  Note: III verification runs against a real port matching /axe-?fx ?iii/i (or a loopMIDI port named "Axe-Fx III").');
      } else {
        await verifyAxefxIii(client);
      }
    }
    if (opts.ports.includes('fm3')) {
      if (!hasFm3) {
        console.log('\n── FM3 (gen-3, USB-CDC serial) ───────────────────────────────');
        console.log('  ⊘ FM3 not visible in list_midi_ports — skipping checks.');
        console.log('  Note: the FM3 is a SERIAL device over USB (not USB MIDI). It shows up either as a');
        console.log('  Fractal-looking serial candidate in list_midi_ports, a DIN/loopMIDI port named "FM3",');
        console.log('  or via MCP_FM3_SERIAL_PATH=<COMx or /dev/...> when it enumerates without metadata.');
      } else {
        await verifyFm3(client);
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
    if (opts.ports.includes('circuit')) {
      if (!hasCircuit) {
        console.log('\n── Novation Circuit Tracks ───────────────────────────────────');
        console.log('  ⊘ Circuit Tracks not visible in list_midi_ports — skipping checks.');
        console.log('  Note: Circuit verification runs against a real port matching /circuit/i.');
      } else {
        await verifyCircuit(client);
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
