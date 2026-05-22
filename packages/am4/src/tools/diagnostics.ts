/**
 * `am4_test_navigate`, bypass-the-stack diagnostic primitive.
 *
 * Confirms the wire path is alive when a high-level tool fails inscrutably.
 * Sends a raw mode-switch SysEx with no high-level mediation, no param
 * resolution, no channel-cache updates, just F0 00 01 74 15 12 [mode]
 * [cksum] F7 → captures inbound → reports.
 *
 * Mode-switch bytes are documented in CLAUDE.md (AM4 SysEx Quick
 * Reference). They're the simplest commands the AM4 supports, if these
 * don't ack with a 0x64 OK, no other tool will work either, and the
 * caller knows the problem is below the protocol layer (USB driver,
 * stale handle, AM4 powered off, AM4-Edit holding the port). Equivalent
 * in role to Hydra-explorer's `hydra_navigate_to`.
 *
 * Checksums verified against CLAUDE.md fixed bytes, XOR of [F0 .. last
 * payload byte] masked & 0x7F. We use the literal bytes from the docs
 * rather than reconstructing them so this tool stays correct even if a
 * downstream regression breaks the checksum builder.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { toHex } from '@mcp-midi-control/core/midi/transport.js';

import { ensureMidi } from '@mcp-midi-control/core/server-shared/connections.js';
import { recordInbound, formatInboundCapture } from '../shared/wireOps.js';

const AM4_MODE_SWITCH_BYTES: Record<'presets' | 'scenes' | 'effects' | 'amp' | 'tuner', number[]> = {
    presets: [0xf0, 0x00, 0x01, 0x74, 0x15, 0x12, 0x48, 0x4a, 0xf7],
    scenes: [0xf0, 0x00, 0x01, 0x74, 0x15, 0x12, 0x49, 0x4b, 0xf7],
    effects: [0xf0, 0x00, 0x01, 0x74, 0x15, 0x12, 0x4a, 0x48, 0xf7],
    amp: [0xf0, 0x00, 0x01, 0x74, 0x15, 0x12, 0x58, 0x5a, 0xf7],
    tuner: [0xf0, 0x00, 0x01, 0x74, 0x15, 0x12, 0x18, 0x1a, 0xf7],
};

/**
 * How long we wait for the device's inbound response after sending a
 * mode-switch. The expected ack is a 0x64 MULTIPURPOSE_RESPONSE with
 * RC=0x00, typically arriving within 30-60 ms (per `CLAUDE.md` SysEx
 * round-trip note). 250 ms is a generous window, long enough that
 * a slow driver still completes, short enough that a hung device
 * surfaces as "no inbound" within a quarter second.
 */
const MODE_SWITCH_DRAIN_MS = 250;

export function registerDiagnosticsTools(_server: McpServer): void {
    // am4_test_navigate removed Phase G, same effect via `send_sysex`
    // with the documented mode-switch bytes from CLAUDE.md "Known
    // Working Commands" section. The diagnostic value (one raw send,
    // capture inbound, report timing) is preserved by send_sysex
    // because the inbound capture is a server-wide concern, not a
    // device-specific one.
}
