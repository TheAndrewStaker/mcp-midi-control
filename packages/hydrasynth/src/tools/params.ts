/**
 * Hydrasynth param tools — system CC + macro CC writes.
 *
 * `hydra_set_engine_param` / `hydra_set_engine_params` removed
 * 2026-05-18 — the unified `set_param({port:'hydrasynth', block,
 * name, value})` / `set_params(...)` cover engine NRPN via the
 * descriptor writer.setParam path.
 *
 * Tools registered:
 *   - hydra_set_param          — system CCs (master vol, sustain, …)
 *   - hydra_set_macro          — Macros 1-8 (CCs 16-23)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { HYDRASYNTH_PARAMS, HYDRASYNTH_PARAMS_BY_ID } from '../params.js';

import {
  HYDRA_DEV_MODE_PREAMBLE,
  DEFAULT_CHANNEL,
  ccBytes,
  ensureMidi,
} from './shared.js';

export function registerHydrasynthParamTools(server: McpServer): void {

// hydra_set_param --------------------------------------------------------

server.registerTool('hydra_set_param', {
  description: HYDRA_DEV_MODE_PREAMBLE + [
    'Use this tool to set a SYSTEM CC on the user\'s ASM Hydrasynth Explorer — these are',
    'the always-on MIDI controls that work regardless of the device\'s Param TX/RX setting:',
    'Master Volume (system.master_volume), Modulation Wheel (system.modulation_wheel),',
    'Sustain Pedal (system.sustain_pedal), Expression Pedal (system.expression_pedal),',
    'Bank Select MSB/LSB (system.bank_select_msb / .bank_select_lsb), All Notes Off',
    '(system.all_notes_off). 7 parameters total.',
    '',
    'For ANY OTHER engine parameter (oscillators, filters, envelopes, mixer, FX, etc.)',
    'use hydra_set_engine_param (single) or hydra_set_engine_params (batch) — those use',
    'NRPN, which is the device\'s standard mode for engine control and covers 1175',
    'parameters including the wave/filter/FX type selectors that aren\'t on CCs at all.',
    '',
    'Values are 0..127 (raw MIDI CC range). No wire-ack is expected.',
  ].join('\n'),
  inputSchema: {
    id: z.string().describe(
      'System parameter id — one of: system.master_volume, system.modulation_wheel, system.sustain_pedal, system.expression_pedal, system.bank_select_msb, system.bank_select_lsb, system.all_notes_off.',
    ),
    value: z.number().int().min(0).max(127).describe(
      'Raw MIDI CC value 0..127.',
    ),
  },
}, async ({ id, value }) => {
  const param = HYDRASYNTH_PARAMS_BY_ID.get(id);
  if (!param) {
    const suggestions = HYDRASYNTH_PARAMS
      .filter((p) => p.category === 'system')
      .map((p) => p.id);
    throw new Error(
      `Unknown parameter id "${id}". hydra_set_param only handles System CCs. Available ids: ${suggestions.join(', ')}. For engine parameters use hydra_set_engine_param.`,
    );
  }
  if (param.category !== 'system') {
    throw new Error(
      `"${id}" is an engine parameter, not a System CC. Use hydra_set_engine_param("${id}", value) instead — it sends NRPN, accepts the same name, and the device listens on NRPN for engine control. CC-style and canonical NRPN names both resolve.`,
    );
  }
  const conn = ensureMidi();
  conn.send(ccBytes(DEFAULT_CHANNEL, param.cc, value));
  return {
    content: [{
      type: 'text',
      text: `Sent CC ${param.cc} = ${value} (${param.module} → ${param.parameter}). System CC — always responds.`,
    }],
  };
});

// hydra_set_macro --------------------------------------------------------

server.registerTool('hydra_set_macro', {
  description: HYDRA_DEV_MODE_PREAMBLE + [
    'Use this tool to set one of the user\'s Macro controls on the Hydrasynth Explorer.',
    'Macros 1-8 are patch-defined: each loaded patch wires its 8 Macros to whatever',
    'synthesis parameters the patch designer chose, via the mod matrix. So "Macro 1"',
    'might be filter sweep on one patch and reverb mix on another — there\'s no fixed',
    'mapping. Macros are an excellent first lever for tone tweaks because they\'re',
    'curated by the patch designer to be musically useful for that patch.',
    '',
    'Macros are CCs 16-23 internally. Like other engine CCs they require Param TX/RX = CC',
    'on the device.',
  ].join('\n'),
  inputSchema: {
    macro: z.number().int().min(1).max(8).describe('Macro number 1..8 (1-indexed, matching the device\'s display).'),
    value: z.number().int().min(0).max(127).describe('Macro value 0..127.'),
  },
}, async ({ macro, value }) => {
  const cc = 15 + macro; // Macro 1 = CC 16, Macro 8 = CC 23
  const conn = ensureMidi();
  conn.send(ccBytes(DEFAULT_CHANNEL, cc, value));
  return {
    content: [{
      type: 'text',
      text: `Sent Macro ${macro} = ${value} (CC ${cc}). The audible effect depends on the currently-loaded patch's mod matrix routing.`,
    }],
  };
});

}
