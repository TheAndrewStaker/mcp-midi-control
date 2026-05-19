/**
 * AM4 working-buffer + device-state read tools (4 tools).
 *
 * - `am4_get_block_layout` — 4-slot block-type read (HW-044).
 * - `am4_get_active_scene` / `am4_get_active_location` — device-state reads
 *   (HW-047).
 * - `am4_get_block_bypass` — long-form bypass-flag read (HW-066).
 *
 * Param reads (am4_get_param / am4_get_params) and bulk name scans
 * (am4_scan_locations) were removed v0.3 — use the unified
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

// -- Device-state register addresses (HW-047, Session 43) -------------------
//
// Three "what is the device currently doing" reads, decoded HW-047:
// active scene, active preset location, per-block bypass. Each register
// uses a different encoding (scene + preset = raw u32 LE int; bypass =
// inverted Q15-ish where 0 = bypassed, 32767 = active). The fourth
// register we tried (per-block channel at pidHigh=0x07D2) returned an
// encoding we couldn't decode in HW-047 — `get_active_channel` is queued
// as HW-048 for follow-up.

const SCENE_STATE_PID_LOW = 0x00ce;
const SCENE_STATE_PID_HIGH = 0x000d;
const LOCATION_STATE_PID_LOW = 0x00ce;
const LOCATION_STATE_PID_HIGH = 0x000a;
const BYPASS_STATE_PID_HIGH = 0x0003;

export function registerReadTools(server: McpServer): void {
    server.registerTool('am4_get_block_layout', {
        description: [
            'Read the current 4-slot block layout from the AM4 working buffer.',
            'Returns the block type at each signal-chain position 1..4 — e.g.',
            '"Slot 1: filter, Slot 2: amp, Slot 3: delay, Slot 4: reverb" — or',
            '"none" for empty slots. Use this BEFORE proposing layout changes so',
            'the user can see the diff in chat ("you currently have drive→amp→',
            'delay→reverb; I\'ll change slot 1 from drive to compressor").',
            'Read-only, ~4 wire round-trips, < 200 ms total. Does not affect any',
            'audible state. Block names match the dictionary in list_block_types.',
            'For per-block bypass state (which slots are off in the current scene)',
            'this tool does not yet read; use the AM4 display or AM4-Edit for that',
            'until the bypass-read decode lands.',
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
                            `may be stale — call reconnect_midi and retry.`,
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

    // am4_get_param / am4_get_params removed v0.3 — use unified
    // get_param({ port: 'am4', block, name, channel? }) and
    // get_params({ port: 'am4', queries: [...] }). The relative-change /
    // tempo-pairing guidance migrated into describe_device.agent_guidance
    // (keys: relative_change, tempo_time_discipline).

    server.registerTool('am4_get_active_scene', {
        description: [
            'Read the AM4\'s currently active scene number (1..4). Use this when',
            'the user asks "what scene am I on?" or as part of a session-opener',
            'that summarizes current device state. Read-only, single round-trip,',
            '< 100 ms. Wire address: pidLow=0x00CE, pidHigh=0x000D — same family',
            'as preset switch and block placement. Encoding: raw u32 little-',
            'endian integer = scene index (0..3); display = index + 1.',
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
                    text: `Active scene: ${sceneIndex + 1} (wire index ${sceneIndex})`,
                }],
            };
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return {
                content: [{
                    type: 'text',
                    text: `Active-scene read failed: ${reason}. If this is the first failed read in a while, the MIDI handle may be stale — call reconnect_midi.`,
                }],
                isError: true,
            };
        }
    });

    server.registerTool('am4_get_active_location', {
        description: [
            'Read the AM4\'s currently active preset location code (e.g. "W04",',
            '"A01", "Z04"). Use this when the user asks "what preset am I on?"',
            'or to anchor "tweak this preset" requests. Read-only, single round-',
            'trip, < 100 ms. Wire address: pidLow=0x00CE, pidHigh=0x000A. Encoding:',
            'raw u32 little-endian integer = location index 0..103, mapped to',
            'A01..Z04 via the standard 4-per-bank scheme.',
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
                    text: `Active preset location: ${code} (wire index ${locationIndex})`,
                }],
            };
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return {
                content: [{
                    type: 'text',
                    text: `Active-location read failed: ${reason}. If this is the first failed read in a while, the MIDI handle may be stale — call reconnect_midi.`,
                }],
                isError: true,
            };
        }
    });

    // am4_get_preset_name removed Phase G — same data via
    // scan_locations({ port: 'am4', from: 'M03', to: 'M03' }) which
    // returns a single-entry results array with the same shape. The
    // unified scan_locations handles single-location reads; the
    // device-namespaced tool was a thin convenience that's no longer
    // load-bearing.

    // am4_scan_locations removed v0.3 — use unified
    // scan_locations({ port: 'am4', from, to }).

    server.registerTool('am4_get_block_bypass', {
        description: [
            'Read whether a block is bypassed (silent) or active in the AM4\'s',
            'currently-selected scene. Returns "active" or "bypassed". Use this',
            'when the user asks "is the amp on?" or before changing a param on a',
            'block they may have toggled off. Read-only, single round-trip,',
            '< 100 ms. Wire address: pidLow=blockTypeValue (e.g. amp=0x003A),',
            'pidHigh=0x0003, action=0x0d (long-form param descriptor read — the',
            'same poll AM4-Edit uses to keep its UI in sync with front-panel',
            'bypass toggles). Bypass flag is byte 22 of the 64-byte response;',
            'value 1 = bypassed, value 0 = active. Tracks live state regardless',
            'of whether the bypass last changed via this MCP tool, the front',
            'panel, or AM4-Edit.',
        ].join(' '),
        inputSchema: {
            block: z.string().describe('Block name, e.g. "amp", "drive", "reverb", "delay", "compressor", "filter"'),
        },
    }, async ({ block }) => {
        const blockTypeValue = resolveBlockType(block);
        if (blockTypeValue === undefined) {
            const known = Object.keys(BLOCK_TYPE_VALUES).join(', ');
            return {
                content: [{
                    type: 'text',
                    text: `Unknown block "${block}". Known: ${known}.`,
                }],
                isError: true,
            };
        }
        if (blockTypeValue === BLOCK_TYPE_VALUES.none) {
            return {
                content: [{
                    type: 'text',
                    text: `"none" isn't a real block — it represents an empty slot. Pass a real block name like "amp" or "drive".`,
                }],
                isError: true,
            };
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
            };
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return {
                content: [{
                    type: 'text',
                    text: `Bypass read for ${block} failed: ${reason}. If this is the first failed read in a while, the MIDI handle may be stale — call reconnect_midi.`,
                }],
                isError: true,
            };
        }
    });
}
