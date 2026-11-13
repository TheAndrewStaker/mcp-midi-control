#!/usr/bin/env node
/**
 * MCP MIDI Control: MCP server (stdio).
 *
 * The process-lifecycle entry point. The server instance itself (identity,
 * instructions, tool/resource registrations, device-registry population)
 * lives in `createServer.ts`; this file owns serving it over stdio and
 * shutting the process down cleanly.
 *
 * Where things live (npm workspace layout):
 *   packages/server-all/src/server/createServer.ts  the McpServer factory +
 *                                               device-registry population
 *   packages/server-all/src/server/shared/    cross-tool helpers
 *                                               (connection registry, channel
 *                                                cache, wire-op helpers,
 *                                                paramKey resolution)
 *   packages/server-all/src/server/tools/     generic-MIDI tool families that
 *                                               work against any USB MIDI
 *                                               device (`send_*`,
 *                                               `list_midi_ports`,
 *                                               `reconnect_midi`)
 *   packages/am4/src/tools/                   AM4 tool family (split by family)
 *   packages/fractal-gen2/src/tools/             Axe-Fx II tool family
 *   packages/fractal-gen3/src/tools/            Axe-Fx III tool family (beta)
 *   packages/hydrasynth/src/                  Hydrasynth tool family
 *   packages/core/src/protocol-generic/       cross-device unified tools +
 *                                               dispatcher
 *
 * Adding a new device follows the same shape: stand up a new workspace
 * package under `packages/<device>/`, export a
 * `register<Device>Tools(server)`, and register it in createServer.ts. The
 * unified surface (set_param, apply_preset, ...) dispatches automatically
 * once the descriptor is registered.
 *
 * Run standalone for a quick sanity check (development only; picks up
 * source changes without rebuilding):
 *   npm run server          # tsx-based, requires project cwd
 *
 * Claude Desktop wiring: run `npm run setup-claude-desktop` (handles
 * build + config-file detection + idempotent merge), or hand-edit
 * `%APPDATA%\Claude\claude_desktop_config.json` after `npm run build`:
 *
 *   "mcp-midi-control": {
 *     "command": "node",
 *     "args": ["C:\\\\path\\\\to\\\\mcp-midi-control\\\\packages\\\\server-all\\\\dist\\\\server\\\\index.js"],
 *     "env": {}
 *   }
 *
 * `tsx`-against-source DOES NOT work as a Claude Desktop entry: Desktop
 * spawns the server with cwd = C:\Windows\System32, so tsx can't find
 * the workspace tsconfigs and intra-package imports fail to resolve.
 * Point Claude Desktop at the built `packages/server-all/dist/server/index.js`
 * instead.
 */

import { Writable } from 'node:stream';

import { serveStdio, StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import { setInstanceClientNameProvider } from '@mcp-midi-control/core/server-shared/instanceLock.js';

import { listMidiPorts } from '@mcp-midi-control/core/midi/transport.js';
import { AM4_PORT_NEEDLES } from '@mcp-midi-control/am4/midi.js';

import { createMcpServer } from './createServer.js';

import { describeAxeFxIIPortStatus } from '@mcp-midi-control/fractal-gen2/tools.js';
import {
  describeAxeFxIIIPortStatus,
  describeFM3PortStatus,
  describeFM9PortStatus,
  describeVP4PortStatus,
} from '@mcp-midi-control/fractal-gen3/device.js';
import { describeHydrasynthPortStatus } from '@mcp-midi-control/hydrasynth/server.js';

// -- Shutdown ---------------------------------------------------------------

/**
 * Exit the process when the MCP client disconnects or the OS signals
 * termination. A stdio MCP server child has no reason to outlive its
 * client, and lingering past disconnect is actively harmful here: each
 * orphaned instance keeps the USB-MIDI output port open, so a later
 * server's writes route through a dead/duplicate handle and silently
 * never reach the device (observed 2026-05-31: 5 stale `server-all`
 * processes held the Hydrasynth port; sends "succeeded" but the device
 * stayed deaf). Exiting releases the port back to the OS for the next
 * instance. Registered once; idempotent via the `closing` guard.
 *
 * The v2 `StdioServerHandle.close()` tears down server + transport but
 * deliberately does NOT exit the process, and exposes no EOF hook, so we
 * keep our own stdin close/end wiring: v2 clients escalate against (kill)
 * stdio servers that linger after EOF, and the MIDI ports must be released
 * by our own exit path, not by SIGKILL.
 */
let handle: StdioServerHandle | undefined;
let closing = false;
function shutdown(reason: string): void {
  if (closing) return;
  closing = true;
  console.error(`MCP MIDI Control server shutting down (${reason}); releasing MIDI ports.`);
  if (handle === undefined) {
    // Nothing was ever served; process exit hands any open node-midi port
    // handles back to the OS.
    process.exit(0);
  }
  // Bound the teardown: a wedged close() must not strand open MIDI handles,
  // so force-exit after ~2s even if it never settles. A curt teardown is
  // better than an orphaned server holding the port.
  setTimeout(() => process.exit(0), 2000);
  void handle.close().catch(() => { /* exit regardless */ }).finally(() => process.exit(0));
}

// -- Start ------------------------------------------------------------------

function main(): void {
  // stdout is the PROTOCOL channel (RIG-CONSOLE-DESIGN.md "Lifecycle"). The
  // webhost is the first feature with a legitimate URL to print, so take the
  // only defence that survives a future contributor: hand the sole fd-1
  // handle to the transport (a Writable bound to the ORIGINAL stdout write),
  // then point process.stdout.write at stderr. After these lines a stray
  // console.log physically cannot corrupt a JSON-RPC frame; it lands in the
  // MCP log panel instead. Backed by scripts/verify-stdout-discipline.ts.
  const rawStdoutWrite = process.stdout.write.bind(process.stdout);
  const protocolOut = new Writable({
    write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      rawStdoutWrite(chunk, encoding, callback);
    },
  });
  // v2 lifecycle: serveStdio owns the transport and the era decision, and
  // pins ONE instance from the factory per connection. The factory MUST
  // mint a fresh McpServer each call (v2 clients spawn a short-lived probe
  // process, and successive connections within a process each get their
  // own instance; a shared instance leaks, upstream #2607). `legacy` stays
  // on its 'serve' default: Claude Desktop and every current client speak
  // the 2025 dialect, as do this repo's own v1-client verification scripts.
  handle = serveStdio(() => {
    const server = createMcpServer();
    // Stamp this process's device leases with the MCP client's declared name
    // ("claude-code", "Claude Desktop"), so a refusal or list_midi_ports in
    // ANOTHER session says which of the user's sessions holds the device.
    // Read lazily: `initialize` has not run yet at this point.
    setInstanceClientNameProvider(() => server.server.getClientVersion()?.name);
    return server;
  }, {
    transport: new StdioServerTransport(process.stdin, protocolOut),
    onerror: (err) => {
      console.error(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
    },
  });
  process.stdout.write = ((chunk: Parameters<typeof process.stderr.write>[0], ...rest: unknown[]) =>
    (process.stderr.write as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  // Self-terminate on client disconnect (the stdio pipe closes when
  // Claude exits or reconnects) and on OS signals, so we never accumulate
  // orphaned servers fighting over the MIDI port. stdin close/end is the
  // disconnect signal for a stdio MCP server.
  process.stdin.on('close', () => shutdown('stdin closed'));
  process.stdin.on('end', () => shutdown('stdin ended'));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => shutdown(sig));
  }
  // MCP servers log to stderr; stdout is owned by the transport. This exact
  // banner line is load-bearing: the installer's merge script greps for it.
  // The port enumeration mirrors what list_midi_ports would return at
  // this moment; if the user reports "AM4 not connected" later, the
  // startup banner captures whatever state the server started with. These
  // scans are per-PROCESS diagnostics (enumerate-only, no device handle is
  // opened), so they run here rather than inside the per-connection factory.
  console.error('MCP MIDI Control MCP server running on stdio.');
  try {
    const { inputs, outputs } = listMidiPorts(AM4_PORT_NEEDLES);
    const am4In = inputs.find((p) => p.matched);
    const am4Out = outputs.find((p) => p.matched);
    const verdict = am4In && am4Out
      ? `AM4 detected (in: "${am4In.name}", out: "${am4Out.name}")`
      : am4In || am4Out
        ? 'AM4 partially visible, one direction missing; check driver'
        : inputs.length === 0 && outputs.length === 0
          ? 'no MIDI ports visible (driver likely not installed)'
          : `AM4 not visible among ${inputs.length} inputs / ${outputs.length} outputs`;
    console.error(`Startup port scan: ${verdict}.`);
  } catch (err) {
    // Port enumeration shouldn't throw, but if node-midi barfs on this
    // platform we don't want startup to die; log and continue.
    console.error(`Startup port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Hydrasynth port-scan banner, separate from the AM4 scan because
  // they're independent devices that may both be plugged in (or just
  // one, or neither). Honest reporting of what's actually connected.
  try {
    console.error(`Hydrasynth port scan: ${describeHydrasynthPortStatus()}.`);
  } catch (err) {
    console.error(`Hydrasynth port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Axe-Fx II port-scan banner, same independence rationale as above.
  try {
    console.error(`Axe-Fx II port scan: ${describeAxeFxIIPortStatus()}.`);
  } catch (err) {
    console.error(`Axe-Fx II port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Axe-Fx III port-scan banner, community beta (BK-015). Banner
  // surfaces the device's presence + beta status so users see in the
  // MCP log panel that the III is registered and what tier of support
  // ships today.
  try {
    console.error(`Axe-Fx III port scan: ${describeAxeFxIIIPortStatus()}.`);
  } catch (err) {
    console.error(`Axe-Fx III port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // FM3 / FM9 port-scan banners, gen-3 siblings of the III, community
  // beta. Same independence rationale as the other per-device scans.
  try {
    console.error(`FM3 port scan: ${describeFM3PortStatus()}.`);
  } catch (err) {
    console.error(`FM3 port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    console.error(`FM9 port scan: ${describeFM9PortStatus()}.`);
  } catch (err) {
    console.error(`FM9 port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // VP4 port-scan banner, gen-3 effects pedal (AM4-shape, reads + mode switch
  // only, device-state writes gated). Same independence rationale as above.
  try {
    console.error(`VP4 port scan: ${describeVP4PortStatus()}.`);
  } catch (err) {
    console.error(`VP4 port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

try {
  main();
} catch (err) {
  console.error('Fatal server error:', err);
  process.exit(1);
}
