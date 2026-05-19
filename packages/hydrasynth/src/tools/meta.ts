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
    'Drop and re-open the Hydrasynth MIDI connection. Use when the device was unplugged at server start but is now connected, when calls report "no Hydrasynth output port" after a confirmed replug, or when USB enumeration has been flaky.',
    'Safe to call any time. No device-side effect.',
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
    'Informational only: Hydrasynth has no SysEx command for reading the current patch slot. Returns a fixed explanation, no wire round-trip.',
    'Use when the user asks "what slot am I on?" (answer: ask them to read the front-panel display, or call hydra_apply_patch with `slot` omitted which auto-targets H128 scratch with dance:"both").',
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
