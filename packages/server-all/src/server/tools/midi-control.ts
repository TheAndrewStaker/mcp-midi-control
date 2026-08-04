/**
 * MIDI port enumeration + reconnect tools — `list_midi_ports` and
 * `reconnect_midi`. Both are device-agnostic and operate on the shared
 * connection registry.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { listMidiPorts } from '@mcp-midi-control/core/midi/transport.js';
import { listSerialCandidates } from '@mcp-midi-control/core/midi/serialTransport.js';
import { AM4_PORT_NEEDLES } from '@mcp-midi-control/am4/midi.js';

import {
    AM4_LABEL,
    STALE_HANDLE_TIMEOUT_THRESHOLD,
    ensureConnection,
} from '@mcp-midi-control/core/server-shared/connections.js';
import {
    listRegisteredDevices,
    resolveDevice,
} from '@mcp-midi-control/core/protocol-generic/registry.js';
import { invalidateChannelCache } from '@mcp-midi-control/am4/shared/channels.js';

export function registerMidiControlTools(server: McpServer): void {
    server.registerTool('list_midi_ports', {
        title: 'List MIDI Ports',
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        description: [
            'List every MIDI input + output port the OS exposes. Safe any time; opens no connection.',
            'Call when the user reports a device isn\'t connected, to diagnose whether the device is visible, the driver is installed, or another app holds the port.',
            '- Default tags AM4 (needles "am4"/"fractal"). Pass `pattern` to tag a different device (e.g. "hydra", "axe-fx").',
            '- If a port shows up here, just call the tool you want and the server binds to it on the next call. You do NOT need to call reconnect_midi first; that tool is only for recovering a handle that died after a physical USB replug.',
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
                        ? `No MIDI ports of any kind are visible, so nothing to match "${needles!.join('" / "')}" against. This usually means no MIDI driver is installed.`
                        : `No MIDI ports match "${needles!.join('" / "')}". Check USB cable, power, and driver.`
            : matchedInput && matchedOutput
                ? 'AM4 input + output both visible. The server will connect to these on the next tool call.'
                : matchedInput || matchedOutput
                    ? 'Only one of AM4 input/output is visible. The AM4 needs both directions; check the USB cable and driver.'
                    : inputs.length === 0 && outputs.length === 0
                        ? 'No MIDI ports of any kind are visible. This usually means no MIDI driver is installed.'
                        : 'AM4 not visible. Check USB cable, power, and that the AM4 driver is installed (https://www.fractalaudio.com/am4-downloads/).';
        // Serial (USB-CDC) candidates — the FM3 is a serial device over USB,
        // not a MIDI device, so it never appears in the MIDI lists above.
        // Surface Fractal-looking serial ports here so "is my FM3 visible?"
        // is answerable from this one tool. Time-boxed: SerialPort.list()
        // can stall for seconds on Windows boxes with Bluetooth COM ports,
        // and this tool promises to be safe/fast any time.
        let serialSection = '';
        try {
            const serial = await Promise.race([
                listSerialCandidates(),
                new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1500)),
            ]);
            if (serial !== undefined) {
                const fractalSerial = serial.filter((c) => c.matchReason !== undefined);
                if (fractalSerial.length > 0) {
                    serialSection =
                        `\n\nSerial (USB-CDC) ports, the FM3 control channel (the FM3 is not a USB MIDI device):\n` +
                        fractalSerial
                            .map((c) => `  ${c.path}  ← ${c.matchReason}${c.friendlyName ? ` (${c.friendlyName})` : ''}`)
                            .join('\n');
                } else if (serial.length > 0) {
                    // No Fractal metadata matched, but serial ports exist: an FM3
                    // can enumerate metadata-less. Name the escape hatch here so
                    // this one tool fully answers "is my FM3 visible?".
                    serialSection =
                        `\n\nSerial (USB-CDC) ports visible (none look Fractal): ` +
                        serial.map((c) => c.path).join(', ') +
                        `\nIf one of these is an FM3, set MCP_FM3_SERIAL_PATH=<path> in the server's environment.`;
                }
            }
        } catch {
            // Serial enumeration is best-effort; MIDI listing stays authoritative.
        }
        return {
            content: [{
                type: 'text',
                text:
                    `${verdict}\n\n` +
                    `Inputs (${inputs.length}):\n` +
                    (inputs.length ? inputs.map(format).join('\n') : '  (none)') +
                    `\n\nOutputs (${outputs.length}):\n` +
                    (outputs.length ? outputs.map(format).join('\n') : '  (none)') +
                    serialSection,
            }],
        };
    });

    server.registerTool('reconnect_midi', {
        title: 'Reconnect MIDI',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: `You almost never need this. The server opens or refreshes the MIDI handle on EVERY tool call, binds to whatever device is present, and auto-reconnects after ${STALE_HANDLE_TIMEOUT_THRESHOLD} consecutive ack-less writes. After plugging in or switching a device, do NOT call this first; just call the tool you want (get_preset, apply_preset, etc.) and it connects. Use it ONLY to recover a handle that genuinely died mid-session (physical USB replug or power-cycle the auto-reconnect missed). It is not a warm-up step and does not fix cold-start ack drops; for those, just retry the call once. - Without \`port\`: reconnects every registered device currently visible on the bus; if none are visible, returns registered devices + visible ports to diagnose. - With \`port\`: case-insensitive needle to target one device (e.g. "am4", "hydra", "axe-fx").`,
        inputSchema: {
            port: z.string().optional().describe(
                'Optional port-name needle to reconnect. Omit to reconnect every registered device currently visible on the MIDI bus. Pass a substring of the port name to target one device.',
            ),
        },
    }, async ({ port }) => {
        // When called with no port, scan visible MIDI ports and reconnect
        // every registered device that's present. Pre-fix the tool
        // defaulted to AM4 — agents on a non-AM4 setup (e.g. only the
        // Hydrasynth connected during a session swap) got an AM4-specific
        // error and the tool was unusable. Bug E in the alpha.13 report.
        //
        // 2026-05-23 history (still applies to the named-port path):
        // resolve the port to a registered descriptor FIRST so we clear
        // the cache under the canonical connection_label, not the agent's
        // literal port string. Pre-fix: agent passed `port:"hydra"`,
        // reconnect_midi cleared cache under "hydra" (no-op), while the
        // real stale entries were under "hydrasynth" — the stale error
        // survived the reconnect and every subsequent get_params re-threw
        // it. Now we resolve via the registry's port_match patterns and
        // clear under the descriptor's connection_label.
        if (port === undefined) {
            const devices = listRegisteredDevices();
            const { outputs } = listMidiPorts();
            type Attempted = { display: string; label: string; error?: string };
            const attempted: Attempted[] = [];
            const skipped: string[] = [];
            for (const desc of devices) {
                const visible = desc.port_match.some((m) => {
                    if (m.pattern instanceof RegExp) {
                        const re = m.pattern;
                        return outputs.some((p) => re.test(p.name));
                    }
                    const needle = m.pattern.toLowerCase();
                    return outputs.some((p) => p.name.toLowerCase().includes(needle));
                });
                if (!visible) {
                    skipped.push(desc.display_name);
                    continue;
                }
                const label = desc.connection_label ?? desc.id;
                try {
                    ensureConnection(label, true);
                    if (label === AM4_LABEL) invalidateChannelCache();
                    attempted.push({ display: desc.display_name, label });
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    attempted.push({ display: desc.display_name, label, error: msg });
                }
            }
            const okList = attempted.filter((a) => a.error === undefined);
            const failList = attempted.filter((a) => a.error !== undefined);
            const lines: string[] = [];
            if (okList.length > 0) {
                lines.push(
                    `Reconnected ${okList.length} visible device(s): ${okList.map((a) => a.display).join(', ')}. ` +
                    'Next tool call for each will use a fresh port handle.',
                );
            }
            if (failList.length > 0) {
                lines.push('Reconnect attempts that errored:');
                for (const a of failList) lines.push(`  ${a.display}: ${a.error}`);
            }
            if (okList.length === 0 && failList.length === 0) {
                lines.push(
                    `No registered devices are currently visible on the MIDI bus. ` +
                    `Registered: ${skipped.join(', ') || '(none)'}. ` +
                    `Visible MIDI outputs: ${outputs.length === 0 ? '(none)' : outputs.map((p) => p.name).join(', ')}. ` +
                    'Check USB cable, device power, and driver install.',
                );
            } else if (skipped.length > 0) {
                lines.push(`Skipped (not visible on bus): ${skipped.join(', ')}.`);
            }
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        const descriptor = resolveDevice(port);
        const label = descriptor?.connection_label ?? descriptor?.id ?? port;
        const isAM4 = label === AM4_LABEL;
        try {
            ensureConnection(label, true);
            if (isAM4) {
                // Fresh AM4 connection = we don't know anything about the hardware
                // state, so the channel cache is no longer trustworthy. Channels
                // are AM4-specific; non-AM4 reconnects don't touch this cache.
                invalidateChannelCache();
            }
            const deviceName = descriptor?.display_name ?? `port matching "${port}"`;
            return {
                content: [{
                    type: 'text',
                    text: isAM4
                        ? `MIDI connection reset (${deviceName}). Next tool call will use a fresh port handle. ` +
                            'Channel cache cleared. If writes still don\'t ack after this, the issue ' +
                            'is below the server (device powered off, USB unplugged, or driver wedged).'
                        : `MIDI connection reset (${deviceName}). Next call to that ` +
                            'device will use a fresh handle. If writes still don\'t ack, check the ' +
                            'device is powered and the cable is seated.',
                }],
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const deviceName = descriptor?.display_name ?? `port matching "${port}"`;
            return {
                content: [{
                    type: 'text',
                    text: `Reconnect failed for ${deviceName}: ${msg}\n\n` +
                        'Most common causes:\n' +
                        '  - device is off or not connected by USB\n' +
                        '  - device driver not installed' +
                        (isAM4 ? '\n  - AM4 driver: https://www.fractalaudio.com/am4-downloads/' : ''),
                }],
            };
        }
    });
}
