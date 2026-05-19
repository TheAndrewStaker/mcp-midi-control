/**
 * Axe-Fx II meta tools — reconnect_midi + axefx2_probe_sysex +
 * describeAxeFxIIPortStatus.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { listAxeFxIIOutputs } from '../midi.js';

import { ensureConn, resetAxeFxIIConnection, toHex } from './shared.js';

export function registerAxeFxIIMetaTools(server: McpServer): void {


  // Kept (NOT removed Phase G) — generic reconnect_midi operates on
  // the shared connection registry (src/server/shared/connections.ts)
  // but the Axe-Fx II tools use their own module-level cache in
  // tools/shared.ts. Until the Axe-Fx II is migrated onto the shared
  // registry, this tool is the only way to drop the cached handle.
  server.registerTool('axefx2_reconnect_midi', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      'Drop the cached Axe-Fx II MIDI handle and force a fresh port-open on the next axefx2_* call. Use after a mid-session replug or a timeout that left the USB handle stale.',
      'Does NOT affect AM4 (use reconnect_midi) or Hydrasynth (use hydra_reconnect_midi).',
    ].join('\n'),
    inputSchema: {},
  }, async () => {
    const result = resetAxeFxIIConnection();
    const lines = [
      `Axe-Fx II connection cache cleared.`,
      `  Was connected: ${result.wasConnected ? 'yes' : 'no'}`,
    ];
    if (result.previousError) {
      lines.push(`  Previous cached error: ${result.previousError}`);
    }
    lines.push(
      '',
      'The next axefx2_* tool call will re-attempt connectAxeFxII().',
      'Run list_midi_ports if you want to confirm the OS is currently',
      'exposing an Axe-Fx II port before retrying.',
    );
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  });


  server.registerTool('axefx2_probe_sysex', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: [
      'Send raw SysEx to the Axe-Fx II AND capture inbound MIDI in the response window. Diagnostic analog of send_sysex with wire visibility for protocol RE; not for production preset edits.',
      'Workflow: subscribes to inbound BEFORE sending so responses can\'t race ahead, sends, drains for capture_ms, returns each message with timestamps.',
      '- bytes: hex string, F0..F7 framing. Caller owns the checksum (Fractal: XOR of body, AND 0x7F).',
      '- capture_ms: 50..2000, default 250.',
      '- If the payload is a write-class function, the buffer-dirty flag flips. Reload via switch_preset to reset before the next probe.',
    ].join('\n'),
    inputSchema: {
      bytes: z.string().describe(
        'SysEx byte sequence as a hex string. Spaces / commas / 0x prefixes tolerated. Must start with F0 and end with F7. Example: "F0 00 01 74 07 06 00 04 F7" or "f0,00,01,74,07,06,00,04,f7".',
      ),
      capture_ms: z.number().int().min(50).max(2000).optional().describe(
        'How long (ms) to listen for the device\'s response after sending. Default 250 ms — enough for a typical ACK frame; bump to 500-1000 ms for whole-preset dumps. Capped at 2000 ms to prevent runaway.',
      ),
    },
  }, async ({ bytes, capture_ms }) => {
    const captureMs = capture_ms ?? 250;
    // Parse hex string — tolerate spaces / commas / 0x prefixes.
    const cleaned = bytes
      .replace(/0x/gi, '')
      .replace(/[,\s]+/g, '')
      .toLowerCase();
    if (!/^[0-9a-f]*$/.test(cleaned)) {
      return {
        content: [{ type: 'text', text: `Invalid hex string — non-hex characters present. Cleaned input: "${cleaned}".` }],
        isError: true,
      };
    }
    if (cleaned.length === 0 || cleaned.length % 2 !== 0) {
      return {
        content: [{ type: 'text', text: `Invalid hex string — empty or odd character count after stripping whitespace. Cleaned length: ${cleaned.length}.` }],
        isError: true,
      };
    }
    const sendBytes: number[] = [];
    for (let i = 0; i < cleaned.length; i += 2) {
      sendBytes.push(Number.parseInt(cleaned.slice(i, i + 2), 16));
    }
    if (sendBytes[0] !== 0xf0 || sendBytes[sendBytes.length - 1] !== 0xf7) {
      return {
        content: [{ type: 'text', text: `SysEx framing invalid — must start with F0 and end with F7. Got [${toHex(sendBytes.slice(0, 3))}…${toHex(sendBytes.slice(-2))}].` }],
        isError: true,
      };
    }

    const c = ensureConn();
    if (!c.hasInput) {
      return {
        content: [{
          type: 'text',
          text:
            `No input port available — can\'t capture inbound. Sending bytes anyway as fire-and-forget.\n` +
            `Sent (${sendBytes.length}B): ${toHex(sendBytes)}\n` +
            `\nFor probe work the input port MUST be open. Check list_midi_ports — Axe-Fx II should expose both an input and an output port.`,
        }],
      };
    }

    // Subscribe FIRST so the response can't race ahead.
    const start = Date.now();
    const observed: Array<{ ms: number; bytes: number[] }> = [];
    const unsubscribe = c.onMessage((b) => {
      observed.push({ ms: Date.now() - start, bytes: [...b] });
    });

    try {
      c.send(sendBytes);
      // Drain the listener for capture_ms ms.
      await new Promise((res) => setTimeout(res, captureMs));
    } finally {
      unsubscribe();
    }

    const lines: string[] = [];
    lines.push(`Sent (${sendBytes.length}B): ${toHex(sendBytes)}`);
    lines.push('');
    lines.push(`Inbound capture (${captureMs}ms window, ${observed.length} message${observed.length === 1 ? '' : 's'}):`);
    if (observed.length === 0) {
      lines.push('  (none — device sent nothing back during the window)');
      lines.push('');
      lines.push('Three possible interpretations:');
      lines.push('  1. Device silently ignored the function byte (unknown to firmware).');
      lines.push('  2. Response arrived AFTER the window closed — bump capture_ms and retry.');
      lines.push('  3. Function ran successfully with no return value (rare; usually some ACK).');
    } else {
      for (const { ms, bytes: b } of observed) {
        lines.push(`  [+${ms.toString().padStart(4)}ms] (${b.length}B) ${toHex(b)}`);
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  });

}

/**
 * Startup-banner helper — describes whether an Axe-Fx II output port is
 * visible right now, without opening it.
 */
export function describeAxeFxIIPortStatus(): string {
  try {
    const outputs = listAxeFxIIOutputs();
    const axe = outputs.find((p) => p.looksLikeAxeFxII);
    if (axe) return `Axe-Fx II detected at output [${axe.index}]: "${axe.name}"`;
    if (outputs.length === 0) return 'no MIDI outputs visible';
    return `Axe-Fx II not visible among ${outputs.length} output(s)`;
  } catch (err) {
    return `port scan failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
