/**
 * MIDI port enumeration + reconnect tools — `list_midi_ports` and
 * `reconnect_midi`. Both are device-agnostic and operate on the shared
 * connection registry.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { listMidiPorts } from '@mcp-midi-control/core/midi/transport.js';
import { AM4_PORT_NEEDLES } from '@mcp-midi-control/am4/midi.js';

import {
    AM4_LABEL,
    STALE_HANDLE_TIMEOUT_THRESHOLD,
    ensureConnection,
} from '@mcp-midi-control/core/server-shared/connections.js';
import { invalidateChannelCache } from '@mcp-midi-control/am4/shared/channels.js';

export function registerMidiControlTools(server: McpServer): void {
    server.registerTool('list_midi_ports', {
        description: [
            'List every MIDI input + output port the OS exposes. Safe any time; opens no connection.',
            'Call when the user reports a device isn\'t connected, to diagnose whether the device is visible, the driver is installed, or another app holds the port.',
            '- Default tags AM4 (needles "am4"/"fractal"). Pass `pattern` to tag a different device (e.g. "hydra", "axe-fx").',
            '- If a port shows up but writes still fail, call reconnect_midi (with matching `port` for non-AM4 devices).',
        ].join(' '),
        inputSchema: {
            pattern: z.union([z.string(), z.array(z.string())]).optional().describe(
                'Optional name-substring pattern for tagging matched ports. Defaults to AM4 needles ("am4"/"fractal"). Pass a string or array of strings (case-insensitive).',
            ),
        },
    }, async ({ pattern }) => {
        const needles = pattern === undefined
            ? undefined
            : Array.isArray(pattern) ? pattern : [pattern];
        const { inputs, outputs } = listMidiPorts(needles ?? AM4_PORT_NEEDLES);
        const isCustomPattern = needles !== undefined;
        const tagLabel = isCustomPattern ? `matches "${needles!.join('" / "')}"` : 'looks like the AM4';
        const format = (port: { index: number; name: string; matched: boolean }): string =>
            `  [${port.index}] ${port.name}${port.matched ? `  ← ${tagLabel}` : ''}`;
        const matchedInput = inputs.find((p) => p.matched);
        const matchedOutput = outputs.find((p) => p.matched);
        const verdict = isCustomPattern
            ? matchedInput && matchedOutput
                ? `Device matching "${needles!.join('" / "')}" visible on both input and output.`
                : matchedInput || matchedOutput
                    ? `Device matching "${needles!.join('" / "')}" partially visible (one direction missing). Check USB cable and driver.`
                    : inputs.length === 0 && outputs.length === 0
                        ? 'No MIDI ports of any kind are visible. This usually means no MIDI driver is installed.'
                        : `No MIDI ports match "${needles!.join('" / "')}". Check USB cable, power, and driver.`
            : matchedInput && matchedOutput
                ? 'AM4 input + output both visible. The server will connect to these on the next tool call.'
                : matchedInput || matchedOutput
                    ? 'Only one of AM4 input/output is visible. The AM4 needs both directions — check the USB cable and driver.'
                    : inputs.length === 0 && outputs.length === 0
                        ? 'No MIDI ports of any kind are visible. This usually means no MIDI driver is installed.'
                        : 'AM4 not visible. Check USB cable, power, and that the AM4 driver is installed (https://www.fractalaudio.com/am4-downloads/).';
        return {
            content: [{
                type: 'text',
                text:
                    `${verdict}\n\n` +
                    `Inputs (${inputs.length}):\n` +
                    (inputs.length ? inputs.map(format).join('\n') : '  (none)') +
                    `\n\nOutputs (${outputs.length}):\n` +
                    (outputs.length ? outputs.map(format).join('\n') : '  (none)'),
            }],
        };
    });

    server.registerTool('reconnect_midi', {
        description: [
            'Reset the MIDI connection: close the cached handle and open a fresh one. Use after USB replug, device power-cycle, or any event leaving the handle dead.',
            `The server auto-reconnects after ${STALE_HANDLE_TIMEOUT_THRESHOLD} consecutive ack-less writes; call this manually to force it sooner.`,
            '- Defaults to AM4. Pass `port` (case-insensitive substring needle) for other devices.',
        ].join(' '),
        inputSchema: {
            port: z.string().optional().describe(
                'Optional port-name needle to reconnect. Defaults to AM4 ("am4"/"fractal" needles). Pass a substring of the port name for non-AM4 devices.',
            ),
        },
    }, async ({ port }) => {
        const label = port ?? AM4_LABEL;
        const isAM4 = label === AM4_LABEL;
        try {
            ensureConnection(label, true);
            if (isAM4) {
                // Fresh AM4 connection = we don't know anything about the hardware
                // state, so the channel cache is no longer trustworthy. Channels
                // are AM4-specific; non-AM4 reconnects don't touch this cache.
                invalidateChannelCache();
            }
            return {
                content: [{
                    type: 'text',
                    text: isAM4
                        ? 'MIDI connection reset (AM4). Next tool call will use a fresh port handle. ' +
                            'Channel cache cleared. If writes still don\'t ack after this, the issue ' +
                            'is below the server (AM4 powered off, USB unplugged, or driver wedged).'
                        : `MIDI connection reset for port matching "${port}". Next call to that ` +
                            'device will use a fresh handle. If writes still don\'t ack, check the ' +
                            'device is powered and the cable is seated.',
                }],
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                content: [{
                    type: 'text',
                    text: isAM4
                        ? `Reconnect failed: ${msg}\n\n` +
                            'Most common causes:\n' +
                            '  - AM4 is off or not connected by USB\n' +
                            '  - Driver not installed (fractalaudio.com/am4-downloads/)'
                        : `Reconnect failed for port matching "${port}": ${msg}\n\n` +
                            'Most common causes:\n' +
                            '  - device is off or not connected by USB\n' +
                            '  - device driver not installed',
                }],
            };
        }
    });
}
