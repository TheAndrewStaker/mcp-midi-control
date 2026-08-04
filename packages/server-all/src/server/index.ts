#!/usr/bin/env node
/**
 * MCP MIDI Control: MCP server (stdio).
 *
 * The boot + register-loop. One `register*Tools(server)` call per
 * supported device, plus a couple of generic-MIDI primitive families.
 *
 * Where things live (npm workspace layout):
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
 * `register<Device>Tools(server)`, and register it below. The unified
 * surface (set_param, apply_preset, ...) dispatches automatically once
 * the descriptor is registered.
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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { listMidiPorts } from '@mcp-midi-control/core/midi/transport.js';
import { AM4_PORT_NEEDLES } from '@mcp-midi-control/am4/midi.js';

import { registerMidiControlTools } from './tools/midi-control.js';
import { registerMidiPrimitiveTools } from './tools/midi-primitives.js';

import { describeAxeFxIIPortStatus } from '@mcp-midi-control/fractal-gen2/tools.js';
import {
  describeAxeFxIIIPortStatus,
  describeFM3PortStatus,
  describeFM9PortStatus,
  describeVP4PortStatus,
} from '@mcp-midi-control/fractal-gen3/device.js';
import { registerHydrasynthTools, describeHydrasynthPortStatus } from '@mcp-midi-control/hydrasynth/server.js';

// Unified tool surface — descriptor registration. The dispatcher
// resolves a tool call's `port` to a registered descriptor; per-device
// behavior lives in the descriptor's schema + reader/writer adapters.
import { registerDevice as registerMcpDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { registerDeviceResources } from '@mcp-midi-control/core/protocol-generic/resources.js';
import { registerUnifiedTools } from '@mcp-midi-control/core/protocol-generic/tools.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR, AX8_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { AXEFXGEN1_DESCRIPTOR } from '@mcp-midi-control/fractal-gen1/descriptor.js';
import { MODERN_FRACTAL_DESCRIPTORS } from '@mcp-midi-control/fractal-gen3/device.js';
import { HYDRASYNTH_DESCRIPTOR } from '@mcp-midi-control/hydrasynth/descriptor.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '@mcp-midi-control/circuit-tracks/descriptor.js';
import { SPD_SX_DESCRIPTOR } from '@mcp-midi-control/spd-sx/descriptor.js';
import { VE500_DESCRIPTOR } from '@mcp-midi-control/ve-500/descriptor.js';
import {
  MICROFREAK_DESCRIPTOR,
  MINIFREAK_DESCRIPTOR,
} from '@mcp-midi-control/arturia/descriptor.js';
import { RC_505_MK2_DESCRIPTOR, RC_600_DESCRIPTOR } from '@mcp-midi-control/boss-rc/descriptor.js';

// -- Server setup -----------------------------------------------------------

/**
 * Server-level instructions — sent once at the MCP `initialize`
 * handshake, ahead of any tool call. Cross-cutting agent contracts
 * that apply to the entire MIDI tool surface live here instead of
 * being copy-pasted into every tool description.
 *
 * ── WHAT BELONGS HERE, AND WHAT DOES NOT (2026-08-02) ────────────────
 *
 * This block is paid on EVERY session before the first tool call, so the
 * test for a line is: does it change what the model DOES? Behavioural
 * contracts (call the tools; the save vocabulary; describe for ears;
 * session-start describe_device) earn their place and are unchanged below.
 *
 * CAPTURE DATES AND FIRMWARE PROVENANCE DO NOT. Roughly half of this block
 * used to be sentences like "a 2026-06-19 Windows verify probe saw the
 * placed block in the device's fn=0x13 status dump" — real, valuable, and
 * changing nothing about how the model should behave. Every one of those
 * facts is ALREADY carried, in fuller form, on each descriptor's
 * `capabilities.verification`, which `describe_device(port)` returns, and in
 * `docs/contributing/devices/<id>.md`. An agent that needs the evidence for
 * ONE device gets it there, when it is working on that device, instead of
 * every session paying for all sixteen.
 *
 * So the device roster below states only what changes behaviour: which
 * devices exist, that community-beta ones are FULLY DRIVABLE, and which
 * verbs each one answers. Do not re-add provenance here; add it to the
 * descriptor's `verification` string, which is where it is read on demand.
 */
const SERVER_INSTRUCTIONS = [
  'mcp-midi-control is a USB MIDI control server for Fractal and ASM gear',
  'plus any generic MIDI device the OS exposes. First-class devices:',
  'Fractal AM4, Fractal Axe-Fx II XL+, ASM Hydrasynth Explorer.',
  '',
  'COMMUNITY BETA MEANS FULLY DRIVABLE. Drive those tools normally and ask',
  'the user to confirm by ear / front panel; do NOT withhold tool calls or',
  'substitute a written spec. For a device\'s exact evidence and which of',
  'its verbs are still gated, call describe_device(port) and read',
  'capabilities.verification. Community-beta devices:',
  '- Fractal Axe-Fx III / FM3 / FM9: full build / edit / save / scene /',
  '  preset surface, same tools as the first-class Fractals.',
  '- Fractal VP4: reads, continuous-knob set_param, set_bypass, save_preset.',
  '  Enum/TYPE set refuses; set_block / switch_scene are gated.',
  '- Axe-Fx Standard/Ultra (gen-1): set_param / set_params / get_param /',
  '  get_params, and get_preset. No save, scene, or channel ops.',
  '- Novation Circuit Tracks: a groovebox sequencer. apply_pattern authors',
  '  drum + melodic note-track patterns (live-streamed over MIDI clock or',
  '  written into a .ncs project uploaded to a slot); upload_sample /',
  '  upload_project transfer WAVs + projects; external_targets routes a',
  '  pattern out to outboard gear (e.g. the SPD-SX).',
  '- Roland SPD-SX: a sample pad on a HYBRID transport. In WAVE MGR mode it',
  '  is a mounted USB drive: scan_locations lists kits, get_preset reads a',
  '  kit, list_samples reads the wave pool, export_preset backs up a kit,',
  '  upload_sample appends a wave, author_kit writes the pad→wave map. In',
  '  AUDIO/MIDI mode switch_preset recalls a kit and apply_pattern triggers',
  '  pads. A verb in the wrong USB mode returns a clear capability error.',
  '- Boss VE-500: a vocal processor (harmony / pitch correct / FX / reverb).',
  '  set_param / set_params / get_param / set_bypass / switch_preset (user',
  '  memories), apply_preset, save_preset. Factory-preset recall and',
  '  whole-patch reads are not available.',
  '- Boss RC-505mk2 / RC-600: loop stations on a HYBRID transport. Live',
  '  MIDI: switch_preset recalls a memory; looper/track functions ride CC',
  '  through the memory\'s ASSIGN table. Storage: scan_locations /',
  '  get_preset read a memory\'s .RC0, apply_preset authors its name +',
  '  ASSIGN table. The unit never echoes state, so confirm by ear.',
  '- Arturia MicroFreak: SysEx preset-name + dump reads, system globals',
  '  read/write, CC + Program Change. MiniFreak is CC/PC only (no SysEx).',
  'Pick tools by intent, not by name length.',
  '',
  'DEFAULT BEHAVIOR: call the tools, do not write specs.',
  'When the user asks for an audible change on connected hardware (build a',
  'tone, tweak a param, switch a preset, switch a scene, save a patch), USE',
  'THE TOOLS. Do not produce a written spec / preset doc / parameter table',
  'instead of calling the tools unless the user explicitly asked for a dry',
  'run, design exercise, or "what would the params look like" preview.',
  'Audible-change requests are tool-call requests by default.',
  '',
  'SESSION-START SETUP: call describe_device(port) ONCE.',
  'Before the first tone-building or apply_preset call against a device,',
  'call describe_device({port}) once. The response carries device-specific',
  'agent_guidance (channel/scene model, applicability rules, iconic-amp',
  'shortcuts, enum-name conventions, tempo-sync discipline, save-language',
  'anti-patterns, read-vs-navigate constraints); load it into context',
  'and refer to it while planning. Skipping this is the #1 cause of "the',
  'AI changed something but it doesn\'t sound right."',
  'This server is OPINIONATED about musical defaults: on every device that',
  'supports them it prefers tempo-synced timing (musical note divisions like',
  '1/4 and 1/8, dotted variants, over raw ms/Hz) and gain-staged loudness',
  '(display-first levels, data-driven scene leveling, audible-by-construction',
  'patches). Reach for those defaults unless the user asks otherwise; the',
  'per-device agent_guidance carries the specifics.',
  '',
  'ONE TOOL SURFACE.',
  'The unified surface (apply_preset, set_param, get_param, switch_preset,',
  'save_preset, switch_scene, set_block, set_bypass, set_params, get_params,',
  'list_params, lookup_lineage, scan_locations, describe_device, describe_rig,',
  'find_compatible_types, get_preset, translate_preset, init_patch,',
  'set_system_param, set_macro, apply_patch, apply_pattern, author_kit,',
  'upload_sample, upload_project, list_samples, import_songsterr,',
  'list_pattern_recipes, send_chord, send_sequence)',
  'routes via the `port` argument and works against any registered device.',
  'describe_rig gives a read-only overview of every registered device (use it',
  'to plan a multi-device setup). All tools are unified; there are no',
  'device-namespaced alternatives.',
  '',
  'SAVE LANGUAGE: strict vocabulary list.',
  'Persisting to flash is destructive and gated. Only set save_authorized=',
  'true when the user used explicit save vocab: save, store, keep, put on,',
  'persist, commit to flash. State descriptions ("I want X to have a copy',
  'of Y", "make X look/sound like Y", "create at X based on Y") describe',
  'the desired audition state, NOT save intent; leave save_authorized=false',
  'and audition. When ambiguous, audition and ASK before persisting.',
  '',
  'DESCRIBE FOR EARS: present results so they read cleanly aloud.',
  'Many users drive this server entirely by voice / screen reader; the',
  'conversational surface IS the accessibility win, so phrase every reply',
  'to be spoken, not scanned. This is general good practice (it is clearer',
  'for everyone), not a mode that toggles on:',
  '- Spatial layouts as a linear path, never a table. Describe a signal',
  '  chain or routing grid as prose ("signal flows: drive into amp into',
  '  cab into reverb; reverb is bypassed in scene 1"). Never render a',
  '  row/column grid or aligned ASCII table; the tools return structured',
  '  display-unit data precisely so you can narrate it as a path.',
  '- Confirm each change in one short sentence with the device-confirmed',
  '  value ("amp gain set to 5.0, confirmed on the device"). Not a JSON',
  '  blob, not a field table.',
  '- State uncertainty in words. When a write is sent but the device did',
  '  not echo it, say so in a sentence ("sent, but the device did not',
  '  confirm it, please check the front panel"), rather than surfacing',
  '  acked:false or a raw rejection code.',
  '- Read safety / overwrite prompts as plain, unambiguous sentences that',
  '  name the target and the exact phrase to proceed ("this would',
  '  overwrite preset A03, named \'Lead Tone\'; say \'overwrite\' to',
  '  proceed").',
  'Keep it short: spoken sentences, not essays.',
].join('\n');

// Report the package's real version in serverInfo. Read it from the
// package manifest rather than hardcoding so it can never drift behind a
// release bump (the 0.2.0 release ZIP shipped reporting "0.1.0" because
// this was hardcoded). From dist/server/index.js, ../../package.json is the
// server-all manifest; in the release ZIP that's the installed package's
// own package.json. Falls back gracefully if the read ever fails.
const SERVER_VERSION = ((): string => {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const server = new McpServer({
  name: 'mcp-midi-control',
  version: SERVER_VERSION,
}, {
  instructions: SERVER_INSTRUCTIONS,
});

// -- Generic-MIDI tool families (any device) --------------------------------
//
// These tools target a port by name substring and don't carry any
// device-specific protocol logic. Useful when a device has a published
// CC / NRPN / SysEx chart but no dedicated wrapper yet.

registerMidiControlTools(server);   // list_midi_ports, reconnect_midi
registerMidiPrimitiveTools(server); // send_cc / _note / _program_change / _nrpn / _sysex

// -- Per-device tool families -----------------------------------------------
//
// Device-namespaced tools (am4_*, axefx2_*, hydra_*) have been removed
// from the registered surface. Code is preserved in the device packages
// for reference. Hydrasynth-specific tools that haven't migrated to the
// unified surface are still registered below.
registerHydrasynthTools(server);    // Hydra-specific tools not yet on unified surface
// SPD-SX needs no device-specific tools: it is a HYBRID-transport descriptor
// (registered below) driven entirely by the unified surface. In WAVE MGR storage
// mode the dispatcher resolves its mounted drive and routes scan_locations /
// get_preset / list_samples / export_preset / upload_sample / author_kit to the
// descriptor's storage reader/writer; in AUDIO/MIDI mode switch_preset recalls a
// kit over MIDI. See packages/spd-sx/src/descriptor.ts.

// -- Unified-surface descriptor registration --------------------------------
//
// Order matters: register MORE SPECIFIC port_match regexes FIRST so
// tiebreaking favors the narrower pattern.
//
//   1. Modern Fractal family  /axe-?fx ?iii/i, /fm ?3/i, /fm ?9/i, /vp ?4/i
//                             (most specific — win on "Axe-Fx III" / "FM3" / "FM9" / "VP4")
//   2. Axe-Fx II   /axe-?fx/i        (would also match III if III didn't win first)
//   3. AM4         /Fractal/i        (catch-all for the modern Fractal family)
//   4. Hydrasynth  /hydrasynth/i     (different vendor — order doesn't matter for it)
//
// The modern Fractal devices (Axe-Fx III / FM3 / FM9 / VP4) are
// community-beta: one gen-3 codec factory, scaffolded from Fractal's
// published v1.4 PDF + AxeEdit III assets, reused across the family by
// model byte. Hardware confirmation varies per device: the FM3 is
// field-confirmed end-to-end for transport / reads / continuous param
// writes / bypass / scene / preset switching (2026-06-12) with set-by-name
// discrete writes confirmed via byte-identical frames (2026-06-10);
// III / FM9 / VP4 have less confirmation. capabilities.support_tier and
// each config carry the machine-readable signal; each response carries a
// brief beta marker.
// Registering via MODERN_FRACTAL_DESCRIPTORS (its declared order is the
// registration order) means a newly-added family member is covered here
// without editing this loop.
for (const descriptor of MODERN_FRACTAL_DESCRIPTORS) {
  registerMcpDevice(descriptor);
}
// gen-1 (Axe-Fx Standard/Ultra) registers BEFORE the II so a port named
// "Axe-Fx Ultra" matches the more-specific /axe-?fx.*(ultra|standard)/i
// pattern instead of the II's broad /axe-?fx/i.
registerMcpDevice(AXEFXGEN1_DESCRIPTOR);
// AX8 (BK-094, community-beta: no AX8 hardware on hand, evidence-backed;
// see packages/fractal-gen2/src/configs/ax8.ts + docs/_private/
// AX8-RESEARCH-2026-07-09.md) registers BEFORE the II: its port_match
// /ax8/i is the more-specific pattern (AX8 ports name themselves "AX8"),
// same discipline as the gen-1-before-II ordering above. /ax8/i cannot
// match the II's broad /axe-?fx/i (no "axefx"/"axe-fx" substring in "AX8"),
// so the two patterns don't actually collide either way, but registering
// the more-specific one first keeps this file's ordering discipline
// consistent for future readers.
registerMcpDevice(AX8_DESCRIPTOR);
registerMcpDevice(AXEFX2_DESCRIPTOR);
registerMcpDevice(AM4_DESCRIPTOR);
// Hydrasynth registers after the Fractal devices — its port_match
// regex (/hydrasynth|asm.*hydra/i) can't collide with the Fractal
// patterns, so ordering doesn't matter for correctness.
registerMcpDevice(HYDRASYNTH_DESCRIPTOR);
// Novation Circuit Tracks (synth/drum control + pattern-target) and Roland
// SPD-SX (minimal kit-recall + pattern-target). Their port_match patterns
// (/circuit/i, /spd-?sx/i) can't collide with the Fractal or Hydra
// patterns, so registration order doesn't matter for correctness.
registerMcpDevice(CIRCUIT_TRACKS_DESCRIPTOR);
registerMcpDevice(SPD_SX_DESCRIPTOR);
// Boss VE-500 (vocal multi-FX). port_match /VE-?500/i can't collide with the
// Fractal / Hydra / Circuit / SPD-SX patterns, so registration order is free.
registerMcpDevice(VE500_DESCRIPTOR);
registerMcpDevice(MICROFREAK_DESCRIPTOR);
// Registration order is the port-match tiebreaker, so the model-specific
// matchers matter: MicroFreak is /micro\s*freak/i and MiniFreak /mini\s*freak/i.
// Neither uses a broad /arturia/i, which would capture the other model and drive
// it with CC numbers that address different parameters on it.
registerMcpDevice(MINIFREAK_DESCRIPTOR);
// Boss RC-505mk2 (looper, hybrid live-MIDI + .RC0 storage). port_match /rc-?505/i
// can't collide with the other devices' patterns, so registration order is free.
registerMcpDevice(RC_505_MK2_DESCRIPTOR);
// Boss RC-600 (looper sibling, same .RC0 storage generation + hybrid transport
// as the mk2; live surface community-beta, storage surface reads-only pending
// a decoded ASSIGN ordinal map; see packages/boss-rc/src/codec/rc600.ts).
// port_match /rc-?600/i can't collide with the mk2's /rc-?505/i, so
// registration order is free.
registerMcpDevice(RC_600_DESCRIPTOR);
registerUnifiedTools(server);
// Expose each device's agent_guidance topics as MCP resources so the
// agent can pull individual topics on demand rather than receiving the
// whole bag via describe_device. (Hosts do not auto-read resources, so
// this is not the primary path: the tool-surface equivalent is
// `describe_device({port, guidance:[...topics]})`, which is what the
// withheld-topic notice points at.)
registerDeviceResources(server);

// -- Start ------------------------------------------------------------------

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
 */
let closing = false;
function shutdown(reason: string): void {
  if (closing) return;
  closing = true;
  console.error(`MCP MIDI Control server shutting down (${reason}); releasing MIDI ports.`);
  // Process exit hands all open node-midi port handles back to the OS.
  process.exit(0);
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Self-terminate on client disconnect (the stdio pipe closes when
  // Claude exits or reconnects) and on OS signals, so we never accumulate
  // orphaned servers fighting over the MIDI port. stdin close/end is the
  // disconnect signal for a stdio MCP server.
  process.stdin.on('close', () => shutdown('stdin closed'));
  process.stdin.on('end', () => shutdown('stdin ended'));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => shutdown(sig));
  }
  // MCP servers log to stderr — stdout is owned by the transport.
  // The port enumeration mirrors what list_midi_ports would return at
  // this moment; if the user reports "AM4 not connected" later, the
  // startup banner captures whatever state the server started with.
  console.error('MCP MIDI Control MCP server running on stdio.');
  try {
    const { inputs, outputs } = listMidiPorts(AM4_PORT_NEEDLES);
    const am4In = inputs.find((p) => p.matched);
    const am4Out = outputs.find((p) => p.matched);
    const verdict = am4In && am4Out
      ? `AM4 detected (in: "${am4In.name}", out: "${am4Out.name}")`
      : am4In || am4Out
        ? 'AM4 partially visible — one direction missing; check driver'
        : inputs.length === 0 && outputs.length === 0
          ? 'no MIDI ports visible (driver likely not installed)'
          : `AM4 not visible among ${inputs.length} inputs / ${outputs.length} outputs`;
    console.error(`Startup port scan: ${verdict}.`);
  } catch (err) {
    // Port enumeration shouldn't throw, but if node-midi barfs on this
    // platform we don't want startup to die — log and continue.
    console.error(`Startup port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Hydrasynth port-scan banner — separate from the AM4 scan because
  // they're independent devices that may both be plugged in (or just
  // one, or neither). Honest reporting of what's actually connected.
  try {
    console.error(`Hydrasynth port scan: ${describeHydrasynthPortStatus()}.`);
  } catch (err) {
    console.error(`Hydrasynth port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Axe-Fx II port-scan banner — same independence rationale as above.
  try {
    console.error(`Axe-Fx II port scan: ${describeAxeFxIIPortStatus()}.`);
  } catch (err) {
    console.error(`Axe-Fx II port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Axe-Fx III port-scan banner — 🟡 community beta (BK-015). Banner
  // surfaces the device's presence + beta status so users see in the
  // MCP log panel that the III is registered and what tier of support
  // ships today.
  try {
    console.error(`Axe-Fx III port scan: ${describeAxeFxIIIPortStatus()}.`);
  } catch (err) {
    console.error(`Axe-Fx III port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // FM3 / FM9 port-scan banners — gen-3 siblings of the III, 🟡 community
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
  // VP4 port-scan banner — gen-3 effects pedal (AM4-shape, reads + mode switch
  // only, device-state writes gated). Same independence rationale as above.
  try {
    console.error(`VP4 port scan: ${describeVP4PortStatus()}.`);
  } catch (err) {
    console.error(`VP4 port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main().catch((err) => {
  console.error('Fatal server error:', err);
  process.exit(1);
});
