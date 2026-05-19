/**
 * AM4 navigation tools — v0.3 cleanup.
 *
 * Only `am4_request_active_buffer_dump` survives — it's a unique
 * diagnostic probe with no unified equivalent (BK-036 binary-format
 * probe series, HW-045).
 *
 * The following device-namespaced navigation tools were removed v0.3,
 * superseded by the unified surface:
 *   - am4_switch_preset      → switch_preset({ port:'am4', location, on_active_preset_edited? })
 *   - am4_switch_scene       → switch_scene({ port:'am4', scene })
 *   - am4_save_preset        → save_preset({ port:'am4', location, name? })
 *   - am4_save_to_location   → save_preset({ port:'am4', location })
 *   - am4_set_preset_name    → rename({ port:'am4', target:'preset', name }) + save_preset
 *   - am4_set_scene_name     → rename({ port:'am4', target:'scene:N', name }) + save_preset
 *
 * Behavioral guidance previously carried by these descriptions
 * (save-intent rule, write-safety locations, rename-persistence) is now
 * surfaced via describe_device({ port:'am4' }).agent_guidance.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { buildRequestActiveBufferDump } from 'fractal-midi/am4';
import { receivePresetDumpStream } from '../presetDump.js';
import { toHex } from '@mcp-midi-control/core/midi/transport.js';

import { ensureMidi } from '@mcp-midi-control/core/server-shared/connections.js';

const PRESET_DUMP_RECEIVE_TIMEOUT_MS = 2000;

export function registerNavigationTools(server: McpServer): void {
    // -- am4_request_active_buffer_dump ----------------------------------------
    //
    // HW-045 / Session 51 (2026-05-08): byte-exact decode of AM4-Edit's
    // File -> Export Preset request when no stored preset is selected (active
    // working buffer export). Wire shape: F0 00 01 74 15 03 7F 7F 00 13 F7,
    // fn=0x03, payload `7F 7F 00`. Response is the canonical 6-message
    // 0x77 / 0x78 / 0x79 stream (header + 4 chunks + footer, 12,352 bytes
    // total) — same shape as a single preset's slice in the factory bank file
    // (see SYSEX-MAP §10b and §6o).
    //
    // Primary purpose: BK-036 binary-format probe series. apply_preset sets
    // the working buffer to a known state; this tool dumps the masked
    // stored-form bytes; the harness diffs against a baseline to map byte-
    // to-param relationships. The chunk content is NOT decoded here — v0.1.0
    // surfaces the raw bytes for the probe harness.
    server.registerTool('am4_request_active_buffer_dump', {
        description: [
            'Dump the AM4 working buffer as raw stored-form bytes (6-message stream: 0x77 header + 4x 0x78 chunks + 0x79 footer). No parsing of the masked content.',
            'Non-destructive: working buffer, active location, and playback are preserved.',
            'Primary use: diff-based probe series for decoding the preset binary format. Returns ~12 KB in ~150-200 ms.',
        ].join(' '),
        inputSchema: {},
    }, async () => {
        const startMs = Date.now();
        const conn = ensureMidi();
        const bytes = buildRequestActiveBufferDump();
        // Register the listener BEFORE the send so the response can't race ahead.
        const streamPromise = receivePresetDumpStream(conn, {
            timeoutMs: PRESET_DUMP_RECEIVE_TIMEOUT_MS,
        });
        try {
            conn.send(bytes);
            const stream = await streamPromise;
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(
                        {
                            bank: stream.bank,
                            sub: stream.sub,
                            totalBytes: stream.totalBytes,
                            messageCount: stream.messageCount,
                            headerBytes: stream.headerBytes,
                            chunkBytes: stream.chunkBytes,
                            footerBytes: stream.footerBytes,
                            wallTimeMs: Date.now() - startMs,
                        },
                        null,
                        2,
                    ),
                }],
            };
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return {
                content: [{
                    type: 'text',
                    text:
                        `Active-buffer dump failed: ${reason}. ` +
                        `Sent ${bytes.length}B request: ${toHex(bytes)}. ` +
                        `If this is the first failed dump in a while, the MIDI handle may be stale - call reconnect_midi.`,
                }],
                isError: true,
            };
        }
    });
}
