/**
 * AM4 working-buffer + device-state read tools (4 tools).
 *
 * - `am4_get_block_layout`, 4-slot block-type read (HW-044).
 * - `am4_get_active_scene` / `am4_get_active_location`, device-state reads
 *   (HW-047).
 * - `am4_get_block_bypass`, long-form bypass-flag read (HW-066).
 *
 * Param reads (am4_get_param / am4_get_params) and bulk name scans
 * (am4_scan_locations) were removed v0.3, use the unified
 * get_param / get_params / scan_locations tools with port="am4".
 *
 * Remaining tools share `sendReadAndParse` from `@/server/shared/readOps.js`.
 * They never modify device state or the connection cache.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
    BLOCK_NAMES_BY_VALUE,
    BLOCK_TYPE_VALUES,
    resolveBlockType,
} from 'fractal-midi/am4';
import { formatLocationDisplay } from 'fractal-midi/am4';
import {
    BLOCK_SLOT_PID_HIGH_BASE,
    BLOCK_SLOT_PID_LOW,
    buildReadParam,
    isReadResponseLong,
    parseLongReadBypassFlag,
    READ_TYPE_LONG,
} from 'fractal-midi/am4';

import { ensureMidi } from '@mcp-midi-control/core/server-shared/connections.js';
import { READ_RESPONSE_TIMEOUT_MS, sendReadAndParse } from '../shared/readOps.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { asError } from '@mcp-midi-control/core/protocol-generic/tools/shared.js';

// -- Device-state register addresses (HW-047, Session 43) -------------------
//
// Three "what is the device currently doing" reads, decoded HW-047:
// active scene, active preset location, per-block bypass. Each register
// uses a different encoding (scene + preset = raw u32 LE int; bypass =
// inverted Q15-ish where 0 = bypassed, 32767 = active). The fourth
// register we tried (per-block channel at pidHigh=0x07D2) returned an
// encoding we couldn't decode in HW-047, `get_active_channel` is queued
// as HW-048 for follow-up.

const SCENE_STATE_PID_LOW = 0x00ce;
const SCENE_STATE_PID_HIGH = 0x000d;
const LOCATION_STATE_PID_LOW = 0x00ce;
const LOCATION_STATE_PID_HIGH = 0x000a;
const BYPASS_STATE_PID_HIGH = 0x0003;

export function registerReadTools(server: McpServer): void {
    server.registerTool('am4_get_block_layout', {
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        description: [
            'Read the AM4 working-buffer block layout (4 slots). Returns the block type at each signal-chain position 1..4, or "none" for empty slots.',
            'Call before proposing layout changes so the user can see the diff in chat ("currently drive->amp->delay->reverb; changing slot 1 to compressor").',
            '- Read-only, 4 wire round-trips, < 200 ms.',
            '- Block bypass state is NOT included; use am4_get_block_bypass for that.',
        ].join(' '),
        inputSchema: {},
    }, async () => {
        const conn = ensureMidi();
        const slots: { position: 1 | 2 | 3 | 4; name: string; pidLow: number }[] = [];
        for (const position of [1, 2, 3, 4] as const) {
            const pidHigh = BLOCK_SLOT_PID_HIGH_BASE + (position - 1);
            try {
                const parsed = await sendReadAndParse(conn, BLOCK_SLOT_PID_LOW, pidHigh);
                const u32 = parsed.asUInt32LE();
                const name = BLOCK_NAMES_BY_VALUE[u32] ?? `unknown(0x${u32.toString(16)})`;
                slots.push({ position, name, pidLow: u32 });
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                return {
                    content: [{
                        type: 'text',
                        text:
                            `Slot-${position} read failed: ${reason}. ` +
                            `Stopped after reading ${slots.length}/4 slots. ` +
                            `If this is the first failed read in a while, the MIDI handle ` +
                            `may be stale; call reconnect_midi and retry.`,
                    }],
                    isError: true,
                };
            }
        }
        const summary = slots
            .map((s) => `  Slot ${s.position}: ${s.name} (pidLow=0x${s.pidLow.toString(16).padStart(4, '0')})`)
            .join('\n');
        return {
            content: [{
                type: 'text',
                text:
                    `Working-buffer block layout (read from AM4):\n${summary}\n\n` +
                    `Note: this tool reads which block occupies each slot, not whether ` +
                    `each block is bypassed in the current scene. "none" = empty slot.`,
            }],
        };
    });

    // am4_get_param / am4_get_params removed v0.3, use unified
    // get_param({ port: 'am4', block, name, channel? }) and
    // get_params({ port: 'am4', queries: [...] }). The relative-change /
    // tempo-pairing guidance migrated into describe_device.agent_guidance
    // (keys: relative_change, tempo_time_discipline).

    server.registerTool('am4_get_active_scene', {
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        description: [
            'Read the AM4\'s currently active scene (1..4). Use for "what scene am I on?" or session-opener state summaries. Read-only, single round-trip, < 100 ms.',
        ].join(' '),
        inputSchema: {},
    }, async () => {
        const conn = ensureMidi();
        try {
            const parsed = await sendReadAndParse(conn, SCENE_STATE_PID_LOW, SCENE_STATE_PID_HIGH);
            const sceneIndex = parsed.asUInt32LE();
            if (sceneIndex < 0 || sceneIndex > 3) {
                return {
                    content: [{
                        type: 'text',
                        text: `AM4 returned an unexpected scene index ${sceneIndex} (expected 0..3). Raw u32 = 0x${sceneIndex.toString(16)}.`,
                    }],
                    isError: true,
                };
            }
            return {
                content: [{
                    type: 'text',
                    text: `Active scene: ${sceneIndex + 1}`,
                }],
            };
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return {
                content: [{
                    type: 'text',
                    text: `Active-scene read failed: ${reason}. If this is the first failed read in a while, the MIDI handle may be stale; call reconnect_midi.`,
                }],
                isError: true,
            };
        }
    });

    server.registerTool('am4_get_active_location', {
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        description: [
            'Read the AM4\'s currently active preset location (e.g. "W4", "A1"). Use for "what preset am I on?" or to anchor "tweak this preset" requests. Read-only, single round-trip, < 100 ms.',
        ].join(' '),
        inputSchema: {},
    }, async () => {
        const conn = ensureMidi();
        try {
            const parsed = await sendReadAndParse(conn, LOCATION_STATE_PID_LOW, LOCATION_STATE_PID_HIGH);
            const locationIndex = parsed.asUInt32LE();
            if (locationIndex < 0 || locationIndex > 103) {
                return {
                    content: [{
                        type: 'text',
                        text: `AM4 returned an unexpected location index ${locationIndex} (expected 0..103). Raw u32 = 0x${locationIndex.toString(16)}.`,
                    }],
                    isError: true,
                };
            }
            const code = formatLocationDisplay(locationIndex);
            return {
                content: [{
                    type: 'text',
                    text: `Active preset location: ${code}`,
                }],
            };
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return {
                content: [{
                    type: 'text',
                    text: `Active-location read failed: ${reason}. If this is the first failed read in a while, the MIDI handle may be stale; call reconnect_midi.`,
                }],
                isError: true,
            };
        }
    });

    // am4_get_preset_name removed Phase G, same data via
    // scan_locations({ port: 'am4', from: 'M03', to: 'M03' }) which
    // returns a single-entry results array with the same shape. The
    // unified scan_locations handles single-location reads; the
    // device-namespaced tool was a thin convenience that's no longer
    // load-bearing.

    // am4_scan_locations removed v0.3, use unified
    // scan_locations({ port: 'am4', from, to }).

    server.registerTool('am4_get_block_bypass', {
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        description: [
            'Read whether an AM4 block is bypassed or active in the currently-selected scene. Returns "active" or "bypassed".',
            'Call for "is the amp on?" or before changing a param on a block the user may have toggled off. Tracks live state regardless of source (this tool, front panel, or AM4-Edit). Read-only, < 100 ms.',
        ].join(' '),
        inputSchema: {
            block: z.string().describe('Block name, e.g. "amp", "drive", "reverb", "delay", "compressor", "filter"'),
        },
        outputSchema: {
            block: z.string(),
            bypassed: z.boolean(),
        },
    }, async ({ block }) => {
        const blockTypeValue = resolveBlockType(block);
        if (blockTypeValue === undefined) {
            const known = Object.keys(BLOCK_TYPE_VALUES).filter((k) => k !== 'none');
            return asError(new DispatchError(
                'unknown_block',
                'Fractal AM4',
                `Unknown block "${block}".`,
                {
                    valid_options: known.slice(0, 8),
                    retry_action: 'Re-invoke with one verbatim block name from valid_options. The unified describe_device({port:"am4"}).blocks lists every block on AM4.',
                },
            ));
        }
        if (blockTypeValue === BLOCK_TYPE_VALUES.none) {
            return asError(new DispatchError(
                'unknown_block',
                'Fractal AM4',
                `"none" isn't a real block; it represents an empty slot.`,
                {
                    retry_action: 'Pass a real block name like "amp" or "drive".',
                },
            ));
        }
        const conn = ensureMidi();
        try {
            const readBytes = buildReadParam(
                { pidLow: blockTypeValue, pidHigh: BYPASS_STATE_PID_HIGH },
                READ_TYPE_LONG,
            );
            const respPromise = conn.receiveSysExMatching(
                (resp) => isReadResponseLong(readBytes, resp),
                READ_RESPONSE_TIMEOUT_MS,
            );
            conn.send(readBytes);
            const resp = await respPromise;
            const bypassed = parseLongReadBypassFlag(resp);
            return {
                content: [{
                    type: 'text',
                    text: `${block} is ${bypassed ? 'bypassed' : 'active'} in the current scene.`,
                }],
                structuredContent: {
                    block,
                    bypassed,
                },
            };
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return {
                content: [{
                    type: 'text',
                    text: `Bypass read for ${block} failed: ${reason}. If this is the first failed read in a while, the MIDI handle may be stale; call reconnect_midi.`,
                }],
                isError: true,
            };
        }
    });
}
