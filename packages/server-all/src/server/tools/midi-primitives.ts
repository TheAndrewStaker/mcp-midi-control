/**
 * Generic-MIDI primitive tools (BK-030 Session B).
 *
 * Device-agnostic — these tools build standard MIDI messages from caller-
 * supplied parameters and emit them on a port resolved by name substring.
 * Designed for devices with published CC / NRPN charts (e.g. the Hydrasynth)
 * where Claude can drive the device usefully without any device-specific
 * protocol code.
 *
 * Convention reminders:
 *   - Channels are presented as 1..16 (musician convention) at the tool
 *     boundary; the wire uses 0..15. The conversion happens here, once.
 *   - send_* primitives don't require an ack to count as success — most
 *     non-Fractal MIDI devices don't echo writes, so the stale-handle
 *     counter that AM4 tools use does not apply. We send and return.
 *   - `port` is required: these tools target a specific device by name,
 *     intentionally distinct from the AM4-default convenience of the
 *     AM4-specific tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
    buildChannelPressure,
    buildControlChange,
    buildNoteOff,
    buildNoteOn,
    buildNRPN,
    buildPitchBend,
    buildProgramChange,
    buildSongPosition,
    buildTimingClockContinue,
    buildTimingClockStart,
    buildTimingClockStop,
    validateSysEx,
} from '@mcp-midi-control/core/midi/messages.js';
import { toHex } from '@mcp-midi-control/core/midi/transport.js';

import { ensureConnection } from '@mcp-midi-control/core/server-shared/connections.js';

const channelArg = z.number().int().min(1).max(16);

function userChannelToWire(channel: number): number {
    return channel - 1;
}

/**
 * Catch-all error reporter for the send_* tools. Validation errors
 * from the message builders surface as structured tool results so
 * Claude can see the rejection and recover, rather than the server
 * returning a 500-equivalent. `isError: true` is mandatory per the
 * MCP spec — without it a failed send_cc looks identical to a
 * successful one that returned the error text in its content.
 */
function sendErrorResponse(
    toolName: string,
    port: string,
    err: unknown,
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
    const msg = err instanceof Error ? err.message : String(err);
    return {
        content: [{
            type: 'text',
            text: `${toolName} failed for port "${port}": ${msg}`,
        }],
        isError: true,
    };
}

export function registerMidiPrimitiveTools(server: McpServer): void {
    server.registerTool('send_cc', {
        description: [
            'Send a MIDI Control Change to any CC-responsive device. Channel 1..16 (musician convention), controller 0..127, value 0..127.',
            'Prefer the unified set_param tools for registered devices (AM4 / Axe-Fx / Hydrasynth) which understand block/param semantics; use send_cc for devices without a dedicated wrapper.',
        ].join(' '),
        inputSchema: {
            port: z.string().describe(
                'Case-insensitive name-substring identifying the target MIDI port (e.g. "hydra", "jd-xi", "ve-500").',
            ),
            channel: channelArg.describe('MIDI channel 1..16 (musician-friendly; converted to 0..15 internally).'),
            controller: z.number().int().min(0).max(127).describe('CC number 0..127.'),
            value: z.number().int().min(0).max(127).describe('CC value 0..127.'),
        },
    }, async ({ port, channel, controller, value }) => {
        try {
            const bytes = buildControlChange(userChannelToWire(channel), controller, value);
            const conn = ensureConnection(port);
            conn.send(bytes);
            return {
                content: [{
                    type: 'text',
                    text: `Sent CC ${controller} = ${value} on channel ${channel} to "${port}". Bytes: ${toHex(bytes)}.`,
                }],
            };
        } catch (err) {
            return sendErrorResponse('send_cc', port, err);
        }
    });

    server.registerTool('send_note', {
        description: [
            'Play one MIDI note on any note-responsive device (synth, drum pad, sampler). Sends Note On, waits `duration_ms` (default 500, max 5000), sends Note Off.',
            'Channel 1..16, note 0..127 (60 = middle C), velocity 0..127.',
        ].join(' '),
        inputSchema: {
            port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
            channel: channelArg,
            note: z.number().int().min(0).max(127).describe('MIDI note number 0..127 (60 = middle C).'),
            velocity: z.number().int().min(0).max(127).describe('Note-On velocity 0..127.'),
            duration_ms: z.number().int().min(1).max(5000).optional().describe(
                'How long to hold the note before Note Off, in milliseconds. Default 500. Capped at 5000.',
            ),
        },
    }, async ({ port, channel, note, velocity, duration_ms }) => {
        const duration = duration_ms ?? 500;
        try {
            const wireChannel = userChannelToWire(channel);
            const onBytes = buildNoteOn(wireChannel, note, velocity);
            const offBytes = buildNoteOff(wireChannel, note, 0);
            const conn = ensureConnection(port);
            conn.send(onBytes);
            await new Promise<void>((resolve) => setTimeout(resolve, duration));
            conn.send(offBytes);
            return {
                content: [{
                    type: 'text',
                    text: `Played note ${note} (vel ${velocity}) on channel ${channel} to "${port}" for ${duration}ms.`,
                }],
            };
        } catch (err) {
            return sendErrorResponse('send_note', port, err);
        }
    });

    server.registerTool('send_program_change', {
        description: [
            'Switch patches on any PC-responsive device. Sends optional Bank Select (CC 0 MSB + CC 32 LSB), then Program Change.',
            'Channel 1..16, program 0..127, banks 0..127 (omit unused bank args).',
        ].join(' '),
        inputSchema: {
            port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
            channel: channelArg,
            program: z.number().int().min(0).max(127).describe('Program number 0..127.'),
            bank_msb: z.number().int().min(0).max(127).optional().describe(
                'Optional Bank Select MSB (CC 0). Sent before the PC if supplied.',
            ),
            bank_lsb: z.number().int().min(0).max(127).optional().describe(
                'Optional Bank Select LSB (CC 32). Sent before the PC if supplied.',
            ),
        },
    }, async ({ port, channel, program, bank_msb, bank_lsb }) => {
        try {
            const wireChannel = userChannelToWire(channel);
            const conn = ensureConnection(port);
            const sent: string[] = [];
            if (bank_msb !== undefined) {
                const bytes = buildControlChange(wireChannel, 0, bank_msb);
                conn.send(bytes);
                sent.push(`Bank MSB ${bank_msb} (${toHex(bytes)})`);
            }
            if (bank_lsb !== undefined) {
                const bytes = buildControlChange(wireChannel, 32, bank_lsb);
                conn.send(bytes);
                sent.push(`Bank LSB ${bank_lsb} (${toHex(bytes)})`);
            }
            const pcBytes = buildProgramChange(wireChannel, program);
            conn.send(pcBytes);
            sent.push(`Program Change ${program} (${toHex(pcBytes)})`);
            return {
                content: [{
                    type: 'text',
                    text: `Sent on channel ${channel} to "${port}": ${sent.join(', ')}.`,
                }],
            };
        } catch (err) {
            return sendErrorResponse('send_program_change', port, err);
        }
    });

    server.registerTool('send_nrpn', {
        description: [
            'Write an NRPN on any NRPN-responsive device. Emits the standard 3- or 4-message sequence (CC 99, CC 98, CC 6, optional CC 38).',
            '- value: 0..127 in 7-bit mode (default), or 0..16383 when high_res=true (14-bit, e.g. Hydrasynth engine NRPN).',
        ].join(' '),
        inputSchema: {
            port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
            channel: channelArg,
            parameter_msb: z.number().int().min(0).max(127).describe('NRPN parameter MSB (CC 99 data).'),
            parameter_lsb: z.number().int().min(0).max(127).describe('NRPN parameter LSB (CC 98 data).'),
            value: z.number().int().min(0).max(16383).describe(
                'Parameter value. 0..127 in 7-bit mode (default), 0..16383 when high_res is true.',
            ),
            high_res: z.boolean().optional().describe(
                'When true, emit a 14-bit data sequence (CC 6 MSB + CC 38 LSB). Default false.',
            ),
        },
    }, async ({ port, channel, parameter_msb, parameter_lsb, value, high_res }) => {
        try {
            const wireChannel = userChannelToWire(channel);
            const bytes = buildNRPN(wireChannel, parameter_msb, parameter_lsb, value, high_res ?? false);
            const conn = ensureConnection(port);
            conn.send(bytes);
            return {
                content: [{
                    type: 'text',
                    text:
                        `Sent NRPN (${parameter_msb}, ${parameter_lsb}) = ${value}` +
                        (high_res ? ' [14-bit]' : ' [7-bit]') +
                        ` on channel ${channel} to "${port}". Bytes: ${toHex(bytes)}.`,
                }],
            };
        } catch (err) {
            return sendErrorResponse('send_nrpn', port, err);
        }
    });

    server.registerTool('send_pitch_bend', {
        description: [
            'Send a MIDI Pitch Bend on a channel. value is signed -8192..+8191 (0 = no bend, +8191 = max up, -8192 = max down). Per-synth bend range typically defaults to +/-2 semitones at full deflection.',
        ].join(' '),
        inputSchema: {
            port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
            channel: channelArg,
            value: z.number().int().min(-8192).max(8191).describe(
                'Signed pitch bend -8192..+8191. 0 = no bend, +8191 = max up, -8192 = max down.',
            ),
        },
    }, async ({ port, channel, value }) => {
        try {
            const bytes = buildPitchBend(userChannelToWire(channel), value);
            const conn = ensureConnection(port);
            conn.send(bytes);
            const sign = value > 0 ? '+' : '';
            return {
                content: [{
                    type: 'text',
                    text: `Sent Pitch Bend ${sign}${value} on channel ${channel} to "${port}". Bytes: ${toHex(bytes)}.`,
                }],
            };
        } catch (err) {
            return sendErrorResponse('send_pitch_bend', port, err);
        }
    });

    server.registerTool('send_channel_pressure', {
        description: [
            'Send MIDI Channel Pressure (aftertouch) on a channel: one pressure value affecting every held note. For per-key aftertouch use Polyphonic Pressure (not yet exposed).',
        ].join(' '),
        inputSchema: {
            port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
            channel: channelArg,
            pressure: z.number().int().min(0).max(127).describe('Aftertouch pressure 0..127.'),
        },
    }, async ({ port, channel, pressure }) => {
        try {
            const bytes = buildChannelPressure(userChannelToWire(channel), pressure);
            const conn = ensureConnection(port);
            conn.send(bytes);
            return {
                content: [{
                    type: 'text',
                    text: `Sent Channel Pressure ${pressure} on channel ${channel} to "${port}". Bytes: ${toHex(bytes)}.`,
                }],
            };
        } catch (err) {
            return sendErrorResponse('send_channel_pressure', port, err);
        }
    });

    server.registerTool('send_clock_start', {
        description: [
            'Send MIDI Timing Clock Start (0xFA) to start a sequencer / drum machine / clock-aware synth from the beginning. System message; affects every receiver on the port.',
            'For mid-song restart use send_clock_continue; for jump-to-bar precede send_clock_continue with send_song_position.',
        ].join(' '),
        inputSchema: {
            port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
        },
    }, async ({ port }) => {
        try {
            const bytes = buildTimingClockStart();
            const conn = ensureConnection(port);
            conn.send(bytes);
            return {
                content: [{
                    type: 'text',
                    text: `Sent MIDI Clock Start (0xFA) to "${port}".`,
                }],
            };
        } catch (err) {
            return sendErrorResponse('send_clock_start', port, err);
        }
    });

    server.registerTool('send_clock_stop', {
        description: [
            'Send MIDI Timing Clock Stop (0xFC) to halt a running sequencer / drum machine / clock-aware synth. System message; affects every receiver on the port.',
        ].join(' '),
        inputSchema: {
            port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
        },
    }, async ({ port }) => {
        try {
            const bytes = buildTimingClockStop();
            const conn = ensureConnection(port);
            conn.send(bytes);
            return {
                content: [{
                    type: 'text',
                    text: `Sent MIDI Clock Stop (0xFC) to "${port}".`,
                }],
            };
        } catch (err) {
            return sendErrorResponse('send_clock_stop', port, err);
        }
    });

    server.registerTool('send_clock_continue', {
        description: [
            'Send MIDI Timing Clock Continue (0xFB) to resume a stopped sequencer / drum machine from its current position. System message.',
            'Precede with send_song_position to jump to a specific bar before resuming.',
        ].join(' '),
        inputSchema: {
            port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
        },
    }, async ({ port }) => {
        try {
            const bytes = buildTimingClockContinue();
            const conn = ensureConnection(port);
            conn.send(bytes);
            return {
                content: [{
                    type: 'text',
                    text: `Sent MIDI Clock Continue (0xFB) to "${port}".`,
                }],
            };
        } catch (err) {
            return sendErrorResponse('send_clock_continue', port, err);
        }
    });

    server.registerTool('send_song_position', {
        description: [
            'Send MIDI Song Position Pointer (0xF2): jump a sequencer / drum machine to a specific beat.',
            '- beats: 14-bit 0..16383. One beat = 6 MIDI Timing Clock pulses (a sixteenth-note at 24 PPQN).',
            '- Most receivers do nothing until a subsequent Start or Continue.',
        ].join(' '),
        inputSchema: {
            port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
            beats: z.number().int().min(0).max(16383).describe(
                '14-bit beat position 0..16383 (one beat = 6 MIDI clock pulses = a sixteenth-note).',
            ),
        },
    }, async ({ port, beats }) => {
        try {
            const bytes = buildSongPosition(beats);
            const conn = ensureConnection(port);
            conn.send(bytes);
            return {
                content: [{
                    type: 'text',
                    text: `Sent Song Position beat=${beats} to "${port}". Bytes: ${toHex(bytes)}.`,
                }],
            };
        } catch (err) {
            return sendErrorResponse('send_song_position', port, err);
        }
    });

    server.registerTool('send_panic', {
        description: [
            'MIDI panic: silence every stuck note on every channel of a device. Sends All Sound Off (CC 120) + All Notes Off (CC 123) on all 16 channels (32 messages). CC 120 cuts release tails; CC 123 lets natural release finish; doing both covers every receiver.',
        ].join(' '),
        inputSchema: {
            port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
        },
    }, async ({ port }) => {
        try {
            const conn = ensureConnection(port);
            // Send All Sound Off (CC 120) and All Notes Off (CC 123) on every
            // channel. Two CC messages × 16 channels = 32 messages. Bundle to
            // one conn.send sequence so the port writes them in order without
            // a JS event-loop yield between each.
            for (let ch = 0; ch < 16; ch++) {
                conn.send(buildControlChange(ch, 120, 0));
                conn.send(buildControlChange(ch, 123, 0));
            }
            return {
                content: [{
                    type: 'text',
                    text: `Sent MIDI Panic to "${port}": All Sound Off (CC 120) + All Notes Off (CC 123) on all 16 channels (32 messages total).`,
                }],
            };
        } catch (err) {
            return sendErrorResponse('send_panic', port, err);
        }
    });

    server.registerTool('send_reset_controllers', {
        description: [
            'Reset All Controllers (CC 121) on a channel: pitch bend, mod wheel, expression, channel pressure, etc. revert to defaults.',
            'Use after a take where mod wheel was pushed up or pitch bend was held, to restore a clean baseline without a full panic.',
        ].join(' '),
        inputSchema: {
            port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
            channel: channelArg,
        },
    }, async ({ port, channel }) => {
        try {
            const bytes = buildControlChange(userChannelToWire(channel), 121, 0);
            const conn = ensureConnection(port);
            conn.send(bytes);
            return {
                content: [{
                    type: 'text',
                    text: `Sent Reset All Controllers (CC 121) on channel ${channel} to "${port}". Bytes: ${toHex(bytes)}.`,
                }],
            };
        } catch (err) {
            return sendErrorResponse('send_reset_controllers', port, err);
        }
    });

    server.registerTool('send_sysex', {
        description: [
            'Send a raw SysEx frame. Power-user escape hatch: validates F0/F7 framing + 7-bit body, then sends verbatim. Useful for ad-hoc RE and device one-offs without a wrapper.',
            'WARNING: malformed SysEx can put devices into unexpected states. Prefer the unified set_param / apply_preset / device-specific tools when available.',
        ].join(' '),
        inputSchema: {
            port: z.string().describe('Case-insensitive name-substring identifying the target MIDI port.'),
            bytes: z.array(z.number().int().min(0).max(255)).min(2).describe(
                'Full SysEx frame including F0 / F7 framing. Each byte 0..255 (the validator further restricts body bytes to 0..127).',
            ),
        },
    }, async ({ port, bytes }) => {
        try {
            const validated = validateSysEx(bytes);
            const conn = ensureConnection(port);
            conn.send(validated);
            return {
                content: [{
                    type: 'text',
                    text: `Sent SysEx (${validated.length}B) to "${port}": ${toHex(validated)}.`,
                }],
            };
        } catch (err) {
            return sendErrorResponse('send_sysex', port, err);
        }
    });
}
