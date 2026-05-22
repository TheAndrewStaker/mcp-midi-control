/**
 * Axe-Fx III meta tools,reconnect_midi + probe_sysex.
 *
 * Mirrors axe-fx-ii/tools/meta.ts. `axefx3_probe_sysex` is the
 * workhorse for the community-capture decode workflow: testers can
 * fire raw SysEx at the III and capture the device's response,
 * letting maintainers decode undecoded function bytes without
 * touching their physical hardware.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { describeAxeFxIIIPortStatus } from '../midi.js';
import { BETA_NOTE, BETA_PREFIX, ensureConn, resetAxeFxIIIConnection, toHex } from './shared.js';

export { describeAxeFxIIIPortStatus };

export function registerAxeFxIIIMetaTools(server: McpServer): void {

  server.registerTool('axefx3_reconnect_midi', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Drop the cached Axe-Fx III MIDI handle and force a fresh port-open on the next axefx3_* call. Use after a mid-session replug or a timeout that left the USB handle stale. Does NOT affect AM4 / II / Hydrasynth.',
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {},
  }, async () => {
    const result = resetAxeFxIIIConnection();
    const lines = [
      'Axe-Fx III connection cache cleared.',
      `  Was connected: ${result.wasConnected ? 'yes' : 'no'}`,
    ];
    if (result.previousError) {
      lines.push(`  Previous cached error: ${result.previousError}`);
    }
    lines.push(
      '',
      'The next axefx3_* tool call will re-attempt connectAxeFxIII().',
      'Run list_midi_ports if you want to confirm the OS is currently',
      'exposing an Axe-Fx III port before retrying.',
    );
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  });


  server.registerTool('axefx3_probe_sysex', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Send raw SysEx to the Axe-Fx III AND capture inbound MIDI in the response window. Primary tool for the community-capture decode workflow; not for production preset edits.',
      'Workflow: subscribes to inbound BEFORE sending so responses can\'t race ahead, sends, drains for capture_ms, returns each message with timestamps.',
      '- bytes: hex string, F0..F7 framing. Caller owns the checksum (XOR of body, AND 0x7F).',
      '- capture_ms: 50..2000, default 250.',
      '- III auto-emits fn 0x21 on front-panel touch and fn 0x13 on preset/scene load; these show up in the capture if active.',
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {
      bytes: z.string().describe(
        'SysEx byte sequence as a hex string. Spaces / commas / 0x prefixes tolerated. Must start with F0 and end with F7. Example: "F0 00 01 74 10 13 06 F7" (STATUS_DUMP).',
      ),
      capture_ms: z.number().int().min(50).max(2000).optional().describe(
        'How long (ms) to listen for the device\'s response after sending. Default 250 ms,enough for a typical ACK or STATUS_DUMP; bump to 500-1000 ms for whole-preset dumps. Capped at 2000 ms to prevent runaway.',
      ),
    },
  }, async ({ bytes, capture_ms }) => {
    const captureMs = capture_ms ?? 250;
    const cleaned = bytes
      .replace(/0x/gi, '')
      .replace(/[,\s]+/g, '')
      .toLowerCase();
    if (!/^[0-9a-f]*$/.test(cleaned)) {
      return {
        content: [{ type: 'text', text: `Invalid hex string,non-hex characters present. Cleaned input: "${cleaned}".` }],
        isError: true,
      };
    }
    if (cleaned.length === 0 || cleaned.length % 2 !== 0) {
      return {
        content: [{ type: 'text', text: `Invalid hex string,empty or odd character count after stripping whitespace. Cleaned length: ${cleaned.length}.` }],
        isError: true,
      };
    }
    const sendBytes: number[] = [];
    for (let i = 0; i < cleaned.length; i += 2) {
      sendBytes.push(Number.parseInt(cleaned.slice(i, i + 2), 16));
    }
    if (sendBytes[0] !== 0xf0 || sendBytes[sendBytes.length - 1] !== 0xf7) {
      return {
        content: [{ type: 'text', text: `SysEx framing invalid,must start with F0 and end with F7. Got [${toHex(sendBytes.slice(0, 3))}…${toHex(sendBytes.slice(-2))}].` }],
        isError: true,
      };
    }

    const c = ensureConn();
    if (!c.hasInput) {
      return {
        content: [{
          type: 'text',
          text:
            'No input port available,can\'t capture inbound. Sending bytes anyway as fire-and-forget.\n' +
            `Sent (${sendBytes.length}B): ${toHex(sendBytes)}\n` +
            '\nFor probe work the input port MUST be open. Check list_midi_ports,Axe-Fx III should expose both an input and an output port.',
        }],
      };
    }

    const start = Date.now();
    const observed: Array<{ ms: number; bytes: number[] }> = [];
    const unsubscribe = c.onMessage((b) => {
      observed.push({ ms: Date.now() - start, bytes: [...b] });
    });

    try {
      c.send(sendBytes);
      await new Promise((res) => setTimeout(res, captureMs));
    } finally {
      unsubscribe();
    }

    const lines: string[] = [];
    lines.push(`Sent (${sendBytes.length}B): ${toHex(sendBytes)}`);
    lines.push('');
    lines.push(`Inbound capture (${captureMs}ms window, ${observed.length} message${observed.length === 1 ? '' : 's'}):`);
    if (observed.length === 0) {
      lines.push('  (none,device sent nothing back during the window)');
      lines.push('');
      lines.push('Three possible interpretations:');
      lines.push('  1. Device silently ignored the function byte (unknown to firmware).');
      lines.push('  2. Response arrived AFTER the window closed,bump capture_ms and retry.');
      lines.push('  3. Function ran successfully with no return value (rare).');
    } else {
      for (const { ms, bytes: b } of observed) {
        lines.push(`  [+${ms.toString().padStart(4)}ms] (${b.length}B) ${toHex(b)}`);
      }
    }
    lines.push('');
    lines.push(BETA_NOTE);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  });

}
