/**
 * Hydrasynth meta tools — reconnect_midi, get_active_patch, and the
 * `describeHydrasynthPortStatus` startup-banner helper.
 *
 * 2 tools:
 *   - hydra_reconnect_midi    — drop cached MIDI handle, re-attempt connect
 *   - hydra_get_active_patch  — informational; Hydrasynth has no SysEx
 *                               read for the active slot, so this just
 *                               explains the workaround
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { listHydrasynthOutputs } from '../midi.js';

import {
  HYDRA_DEV_MODE_PREAMBLE,
  ensureMidi,
  resetMidiHandle,
} from './shared.js';

export function registerHydrasynthMetaTools(server: McpServer): void {

// hydra_reconnect_midi -------------------------------------------------

server.registerTool('hydra_reconnect_midi', {
  description: HYDRA_DEV_MODE_PREAMBLE + [
    'Drop and re-attempt the MIDI connection to the Hydrasynth Explorer.',
    'Use when:',
    '  - The device wasn\'t plugged in / powered on when the server',
    '    started, but is now connected. The server caches the initial',
    '    connect failure and won\'t retry until you call this tool.',
    '  - Tool calls report "no Hydrasynth output port" or similar after',
    '    you\'ve confirmed the device is plugged in.',
    '  - USB enumeration has been flaky and you want a clean re-bind.',
    '',
    'Mirrors the AM4-side `reconnect_midi` tool. After this returns,',
    'the next hydra_apply_patch / hydra_set_engine_param / etc. call',
    'will re-enumerate ports and try to open the Hydrasynth fresh.',
    '',
    'Safe to call any time. Cheap (~10ms). No device-side effect.',
  ].join('\n'),
  inputSchema: {},
}, async () => {
  const { wasConnected, previousError } = resetMidiHandle();
  // Try to re-establish immediately so the user gets a definitive
  // "yes/no" status from this single call instead of having to fire
  // another tool to discover whether the reconnect worked.
  let outcome: string;
  try {
    ensureMidi();
    outcome = 'Reconnected. Hydrasynth is now reachable.';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outcome = `Reconnect attempted but device still not visible: ${msg}\n\n` +
              `Things to check:\n` +
              `  - Hydrasynth is powered ON (front-panel display lit).\n` +
              `  - USB cable is seated firmly at both ends.\n` +
              `  - Windows hasn't disabled the device (check Device Manager).\n` +
              `  - No other DAW or editor (ASM Hydrasynth Manager, edisyn) holds the port.`;
  }
  const prefix = wasConnected
    ? 'Closed previous Hydrasynth handle. '
    : previousError
      ? `Cleared cached connect-error ("${previousError}"). `
      : '';
  return {
    content: [{ type: 'text', text: `${prefix}${outcome}` }],
  };
});

// hydra_get_active_patch (informational) -------------------------------

server.registerTool('hydra_get_active_patch', {
  description: HYDRA_DEV_MODE_PREAMBLE + [
    'Return information about the device\'s currently-active patch slot.',
    '',
    'IMPORTANT — this is an INFORMATIONAL tool, not a wire query. The',
    'ASM Hydrasynth\'s SysEx command set does NOT support reading the',
    'current patch slot from the device (per `SysexEncoding.txt`:',
    '"It is my understanding that the following CANNOT be done: Request',
    'and download patch from current working memory"). There is no MIDI',
    'message you can send that returns "I am on B042" — the device only',
    'echoes back patches you\'ve explicitly requested by bank+slot.',
    '',
    'When to call this tool:',
    '  - The user asks "what slot am I on?" — explain via this tool\'s',
    '    response that the device cannot answer; ask them to look at',
    '    the front-panel display.',
    '  - You\'re building a patch and don\'t know which slot to write —',
    '    do NOT use the AM4\'s `am4_get_active_location`; that tool',
    '    only speaks to the AM4. INSTEAD: call `hydra_apply_patch`',
    '    with `slot` OMITTED — the tool defaults to the H128 scratch',
    '    slot with `dance: "both"`, which navigates the device there',
    '    and applies the patch audibly. That\'s the canonical "I don\'t',
    '    know the current slot" workflow.',
    '',
    'No wire round-trip. Returns the same explanation every call.',
  ].join('\n'),
  inputSchema: {},
}, async () => {
  return {
    content: [{
      type: 'text',
      text: [
        'The Hydrasynth does not expose a SysEx command for reading the',
        'currently-active patch slot. Per SysexEncoding.txt, "request',
        'from current working memory" is explicitly NOT supported by',
        'the device. The only ways to know which slot is active:',
        '',
        '  1. Ask the user (they can look at the front-panel display).',
        '  2. Track our own navigations — if `hydra_navigate_to({slot:',
        '     "X"})` was called earlier in this session, the device is',
        '     now on X (assuming the user hasn\'t manually navigated).',
        '  3. Don\'t care about the current slot — call hydra_apply_patch',
        '     with `slot` OMITTED. The tool defaults to the H128 scratch',
        '     slot with `dance: "both"`, navigating the device there and',
        '     applying audibly. Recommended for test/iconic-tone workflows.',
        '',
        'The AM4\'s `am4_get_active_location` tool is FOR THE AM4 ONLY —',
        'do not call it expecting a Hydrasynth answer.',
      ].join('\n'),
    }],
  };
});

}

/**
 * Optional startup port-scan. The main mcp-midi-control server may call
 * this during its own startup to log a "Hydrasynth detected at port [N]"
 * line for observability. Returns the verdict string instead of writing
 * to stderr so the caller controls output.
 */
export function describeHydrasynthPortStatus(): string {
  try {
    const outputs = listHydrasynthOutputs();
    const hydra = outputs.find((p) => p.looksLikeHydrasynth);
    if (hydra) return `Hydrasynth detected at output [${hydra.index}]: "${hydra.name}"`;
    if (outputs.length === 0) return 'no MIDI outputs visible';
    return `Hydrasynth not visible among ${outputs.length} output(s): ${outputs.map((p) => p.name).join(', ')}`;
  } catch (err) {
    return `port scan failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
