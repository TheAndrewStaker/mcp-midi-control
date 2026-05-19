/**
 * Hydrasynth navigation tools.
 *
 * 1 tool:
 *   - hydra_navigate_to   — diagnostic primitive (bank/PC, no SysEx) with
 *                           inbound MIDI capture
 *
 * hydra_switch_patch removed v0.3 — use unified
 *   switch_preset({ port:'hydrasynth', location })
 *
 * hydra_play_note removed — use unified
 *   play_note({ port:'hydrasynth', note, velocity?, duration_ms?, channel? })
 * The unified primitive sends the same Note On/Off bytes and works for
 * every registered device (default impl in dispatcher/audition.ts).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  DEFAULT_CHANNEL,
  HYDRA_DEV_MODE_PREAMBLE,
  ccBytes,
  describeInboundMessage,
  ensureMidi,
  parseSlot,
  programChangeBytes,
  sleep,
} from './shared.js';

export function registerHydrasynthNavigationTools(server: McpServer): void {

// hydra_navigate_to (diagnostic) ----------------------------------------

server.registerTool('hydra_navigate_to', {
  description: HYDRA_DEV_MODE_PREAMBLE + [
    '**Diagnostic primitive.** Sends Bank Select (CC0=0, CC32=bank) +',
    'Program Change to navigate the device\'s active patch to the named',
    'slot. Captures any inbound MIDI for 200 ms after.',
    '',
    'Use BEFORE any test that bundles bank/PC navigation with SysEx, to',
    'verify in isolation that the device responds to PC at all. If the',
    'device\'s front-panel display does not change to the named slot when',
    'this runs, navigation is broken upstream and any tool that bundles',
    'PC + SysEx (like `hydra_apply_init`) is testing the wrong thing.',
    '',
    'Does NOT send SysEx. Does NOT modify any patch contents — just',
    'changes which patch the device is currently playing.',
  ].join('\n'),
  inputSchema: {
    slot: z.string().describe(
      'Target slot in "A001".."H128" form. Letter A..H + patch 1..128.',
    ),
  },
}, async ({ slot }) => {
  const conn = ensureMidi();
  const target = parseSlot(slot);
  const startMs = Date.now();

  const observed: Array<{ ms: number; bytes: number[] }> = [];
  const unsubscribe = conn.onMessage((bytes) => {
    observed.push({ ms: Date.now() - startMs, bytes: [...bytes] });
  });

  const sent: Array<{ ms: number; label: string }> = [];
  function record(label: string): void {
    sent.push({ ms: Date.now() - startMs, label });
  }

  try {
    conn.send(ccBytes(DEFAULT_CHANNEL, 0, 0));
    record('CC0 (Bank MSB) = 0');
    conn.send(ccBytes(DEFAULT_CHANNEL, 32, target.bank));
    record(`CC32 (Bank LSB) = ${target.bank} (${target.display[0]})`);
    conn.send(programChangeBytes(DEFAULT_CHANNEL, target.patch));
    record(`PC = ${target.patch} (displayed ${target.display})`);
    await sleep(200);
  } finally {
    unsubscribe();
  }

  const elapsedMs = Date.now() - startMs;
  const lines: string[] = [];
  lines.push(`Navigation request sent to slot ${target.display} (bank=${target.bank}, patch=${target.patch}, ${elapsedMs} ms total).`);
  lines.push('');
  lines.push('CHECK THE DEVICE\'S FRONT-PANEL DISPLAY:');
  lines.push(`  - If it now reads "${target.display}" → navigation works. Move on to the SysEx test.`);
  lines.push(`  - If it still reads the old slot → device is not responding to bank/PC from MCP.`);
  lines.push('    Likely causes: wrong MIDI channel (we\'re sending on ch 1), Param TX/RX gating,');
  lines.push('    or the device is in a mode that locks the patch.');
  lines.push('');
  lines.push(`Sent (timeline, channel ${DEFAULT_CHANNEL}):`);
  for (const s of sent) {
    lines.push(`  [+${s.ms.toString().padStart(4)}ms] ${s.label}`);
  }
  lines.push('');
  lines.push(`Inbound MIDI (hasInput=${conn.hasInput}, ${observed.length} message${observed.length === 1 ? '' : 's'}):`);
  if (!conn.hasInput) {
    lines.push('  (no input port open — can\'t observe device-side responses)');
  } else if (observed.length === 0) {
    lines.push('  (none — device sent nothing back. PC echoes are not standard, so absence does not prove anything.)');
  } else {
    for (const { ms, bytes } of observed) {
      lines.push(`  [+${ms.toString().padStart(4)}ms] ${describeInboundMessage(bytes)}`);
    }
  }

  return {
    content: [{
      type: 'text',
      text: lines.join('\n'),
    }],
  };
});

}
