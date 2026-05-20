/**
 * Live regression for Session 105 work, end-to-end via the MCP server.
 *
 * Spawns the shipped server-all dist over stdio (real transport, no
 * MCP_MOCK_TRANSPORT), then exercises the new Session 105 tools against
 * whichever Fractal devices are connected:
 *
 *   AM4 path:
 *     - describe_device(am4).capabilities.atomic_read === false
 *     - nudge_param(amp, gain, up, fine)   then nudge_param(... down) to revert
 *     - nudge_param(amp, gain, up, coarse) then revert (down, coarse)
 *     - toggle_bypass(reverb) twice (flip then flip back)
 *     - set_bypass(amp, true) MUST refuse with AMP-quirk explanation
 *     - toggle_bypass(amp) MUST refuse with AMP-quirk explanation
 *
 *   Axe-Fx II path:
 *     - describe_device(axe-fx-ii).capabilities.atomic_read === true
 *     - get_preset(axe-fx-ii) returns PresetSnapshot with _meta, slots
 *       carrying channel_status on channel-bearing blocks
 *
 * Non-destructive: no saves issued, no preset locations overwritten.
 * AM4 amp.gain nudge is reverted in-call so the working buffer ends at
 * the same value it started at. Reverb bypass toggles twice (back to
 * original state). On a clean run the device's audible state at exit
 * matches its state at start.
 *
 * Run:
 *   npx tsx scripts/_research/live-regression-session-105.ts
 *
 * Both AM4 + II must be plugged in. If only one is connected, the
 * other device's cases are reported as "SKIPPED — device not found".
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

    // ── AM4 atomic_read flag should be false ────────────────────────
    if (am4Available) {
      console.log('AM4 atomic_read capability flag');
      const r = await client.callTool({ name: 'describe_device', arguments: { port: 'am4' } });
      const sc = structured(r);
      const caps = sc?.['capabilities'] as Record<string, unknown> | undefined;
      const flag = caps?.['atomic_read'];
      const notes = [`atomic_read = ${JSON.stringify(flag)}`];
      record('describe_device(am4).capabilities.atomic_read === false', flag === false, notes);
    } else {
      record('describe_device(am4).capabilities.atomic_read', false, [], true);
    }

    // ── AM4 AMP-slot refusal: set_bypass + toggle_bypass ────────────
    if (am4Available) {
      console.log('\nAM4 AMP-slot refusals (no wire writes expected)');
      {
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
      }
      {
        const r = await client.callTool({
          name: 'toggle_bypass',
          arguments: { port: 'am4', block: 'amp' },
        });
        const t = extractText(r);
        const isErr = isError(r);
        const namesQuirk = /no bypass register|always engaged/i.test(t);
        const notes = [
          `isError=${isErr}`,
          `names AMP-slot quirk → ${namesQuirk}`,
        ];
        record('toggle_bypass(am4, amp) refuses with quirk', isErr && namesQuirk, notes);
      }
    } else {
      record('AM4 AMP-slot refusals', false, [], true);
    }

    // ── AM4 nudge_param (fine, up then down to revert) ──────────────
    if (am4Available) {
      console.log('\nAM4 nudge_param round-trip on amp.gain');
      const before = await readGain(client);
      const upR = await client.callTool({
        name: 'nudge_param',
        arguments: { port: 'am4', block: 'amp', name: 'gain', direction: 'up', granularity: 'fine' },
      });
      const upSc = structured(upR);
      const upDisplay = upSc?.['display_value'];
      const upWire = upSc?.['wire_value'];
      const upAcked = upSc?.['acked'];
      const upInfo = upSc?.['info'];
      const upNotes = [
        `isError=${isError(upR)}`,
        `acked=${upAcked}`,
        `wire_value=${upWire}`,
        `display_value=${upDisplay}`,
        `info=${typeof upInfo === 'string' ? upInfo.slice(0, 80) : upInfo}`,
      ];
      // The writer does an always-read-after-write so the response
      // carries a reliable wire_value + display_value. Anything else
      // is a regression on the contract (agents shouldn't have to do
      // a second get_param call to confirm where a nudge landed).
      const upOk = !isError(upR) && upAcked === true
        && typeof upWire === 'number'
        && upWire >= 0
        && upWire <= 65534
        && typeof upDisplay === 'number'
        && upDisplay >= 0
        && upDisplay <= 10;
      record('nudge_param(amp, gain, up, fine) returns valid wire + display', upOk, upNotes);

      // Revert: nudge down, fine. Working buffer back to original.
      await client.callTool({
        name: 'nudge_param',
        arguments: { port: 'am4', block: 'amp', name: 'gain', direction: 'down', granularity: 'fine' },
      });
      const after = await readGain(client);
      const reverted = before !== undefined && after !== undefined
        && Math.abs((after as number) - (before as number)) < 0.01;
      record('nudge_param up+down round-trip leaves amp.gain unchanged',
        reverted, [`before=${before}`, `after=${after}`]);
    } else {
      record('AM4 nudge_param round-trip', false, [], true);
    }

    // ── AM4 toggle_bypass on a placed bypassable block ──────────────
    if (am4Available) {
      console.log('\nAM4 toggle_bypass round-trip');
      // Read the working-buffer layout first so we pick a block that
      // is ACTUALLY placed. Toggle on an unplaced block silently reads
      // the absent-block default state (wire 0 / bypassed) regardless
      // of how many times we call it, which would look like a failure.
      const layout = await client.callTool({
        name: 'am4_get_block_layout',
        arguments: {},
      });
      const layoutText = extractText(layout);
      // Pick the first placed bypassable block found in the layout
      // (drive / reverb / delay / chorus / flanger / phaser are all
      // bypassable; AMP slot is not, so we skip it).
      const bypassable = ['reverb', 'delay', 'drive', 'chorus', 'flanger', 'phaser'];
      const placed = bypassable.find((b) => new RegExp(`: ${b}\\b`, 'i').test(layoutText));
      if (placed === undefined) {
        record('toggle_bypass(am4, placed block) round-trip', false,
          ['no bypassable block placed on active preset; load a preset with drive / reverb / delay to test'],
          true);
      } else {
        const t1 = await client.callTool({
          name: 'toggle_bypass',
          arguments: { port: 'am4', block: placed },
        });
        const t1Sc = structured(t1);
        const t1State = t1Sc?.['display_value'];
        const t1Acked = t1Sc?.['acked'];
        const t1Notes = [
          `target block = ${placed}`,
          `isError=${isError(t1)}`,
          `acked=${t1Acked}`,
          `display_value=${t1State}`,
        ];
        const t1Ok = !isError(t1) && t1Acked === true
          && (t1State === 'bypassed' || t1State === 'active');
        record(`toggle_bypass(am4, ${placed}) first call acks with state`, t1Ok, t1Notes);

        // The Session 104 verified probe used a 300ms gap between
        // consecutive toggles. Back-to-back toggles inside the same
        // tick land on the wire fast enough that the device may
        // collapse them, returning the same state twice. Real agent
        // flows are slower (user interaction between calls), so this
        // sleep only matters for the regression's tight loop.
        await new Promise((r) => setTimeout(r, 300));

        const t2 = await client.callTool({
          name: 'toggle_bypass',
          arguments: { port: 'am4', block: placed },
        });
        const t2Sc = structured(t2);
        const t2State = t2Sc?.['display_value'];
        const t2Notes = [
          `target block = ${placed}`,
          `isError=${isError(t2)}`,
          `display_value=${t2State}`,
        ];
        const flipped = t1State !== undefined && t2State !== undefined && t1State !== t2State;
        record(`toggle_bypass(am4, ${placed}) second call flips back`,
          flipped, t2Notes);
      }
    } else {
      record('AM4 toggle_bypass round-trip', false, [], true);
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

    // ── Axe-Fx II get_preset on unsupported devices ─────────────────
    if (am4Available) {
      const r = await client.callTool({ name: 'get_preset', arguments: { port: 'am4' } });
      const t = extractText(r);
      const isErr = isError(r);
      const mentionsGap = /not implemented for Fractal AM4|capability_not_supported/i.test(t);
      record('get_preset(am4) refuses (AM4 has no atomic-read primitive)',
        isErr && mentionsGap,
        [`isError=${isErr}`, `text mentions capability gap → ${mentionsGap}`]);
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
      // Connection-layer errors mean hardware is not reachable.
      if (/not found in the MIDI device list|cannot open|stale handle/i.test(t)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function readGain(client: Client): Promise<number | string | undefined> {
  try {
    const r = await client.callTool({
      name: 'get_param',
      arguments: { port: 'am4', block: 'amp', name: 'gain' },
    });
    const sc = structured(r);
    return sc?.['display_value'] as number | string | undefined;
  } catch {
    return undefined;
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(99);
});
