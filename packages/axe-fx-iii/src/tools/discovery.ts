/**
 * Axe-Fx III discovery tools:STATUS_DUMP + block roster.
 *
 * Tools registered:
 *   - axefx3_status_dump   (function 0x13)
 *   - axefx3_list_blocks   (pure data:block roster from blockTypes.ts)
 *
 * STATUS_DUMP returns one row per block currently placed in the
 * active preset. Per v1.4 spec, each row carries the effect ID
 * (from Appendix 1), the bypass state, the active channel, and
 * the channel count.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { AXE_FX_III_BLOCKS } from 'fractal-midi/axe-fx-iii';
import {
  buildStatusDump,
  isStatusDumpResponse,
  parseStatusDumpResponse,
} from 'fractal-midi/axe-fx-iii';

import {
  BETA_NOTE,
  BETA_PREFIX,
  GET_RESPONSE_TIMEOUT_MS,
  ensureConn,
  toHex,
} from './shared.js';

/** Lookup: effectId → block descriptor + instance number. */
function describeEffectId(effectId: number): string {
  for (const b of AXE_FX_III_BLOCKS) {
    if (b.firstId === null) continue;
    if (effectId >= b.firstId && effectId < b.firstId + b.instances) {
      const instance = effectId - b.firstId + 1;
      return b.instances > 1 ? `${b.name} ${instance}` : b.name;
    }
  }
  return `(unknown ID; possibly AMP / Dynamic Distortion / NAM)`;
}

export function registerAxeFxIIIDiscoveryTools(server: McpServer): void {

  server.registerTool('axefx3_status_dump', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Status dump of every block in the active preset on the Axe-Fx III. One row per block: effect_id | name | bypassed | channel.',
      'Use to (a) see which blocks the active preset contains and (b) capture unrecognized effect IDs (AMP / NAM / Dynamic Distortion show as "unknown") for the community decode workflow.',
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {},
  }, async () => {
    const reqBytes = buildStatusDump();
    const c = ensureConn();
    const responsePromise = c.receiveSysExMatching(
      isStatusDumpResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(reqBytes);
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `axefx3_status_dump failed: ${msg}\n` +
        `Sent ${reqBytes.length} bytes: ${toHex(reqBytes)}\n` +
        '\nMost likely causes: device not connected (check list_midi_ports), ' +
        'response framing differs from the v1.4 spec, or the input port ' +
        'isn\'t open. Try axefx3_reconnect_midi.',
      );
    }
    let entries;
    try {
      entries = parseStatusDumpResponse(response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `axefx3_status_dump: response decode failed: ${msg}\n` +
        `Raw response (${response.length}B): ${toHex(response)}\n`,
      );
    }

    const lines: string[] = [];
    lines.push(`STATUS_DUMP:${entries.length} block${entries.length === 1 ? '' : 's'} in active preset.`);
    lines.push('');
    lines.push('  effect_id | block (resolved)              | bypassed | channel');
    lines.push('  ' + '-'.repeat(68));
    for (const e of entries) {
      const id = e.effectId.toString().padStart(5);
      const name = describeEffectId(e.effectId).padEnd(30);
      const byp = e.bypassed ? 'yes' : 'no ';
      const ch = ['A', 'B', 'C', 'D'][e.channel] ?? `?(${e.channel})`;
      lines.push(`  ${id}     | ${name} | ${byp}      | ${ch}`);
    }
    lines.push('');
    lines.push(`Sent (${reqBytes.length}B): ${toHex(reqBytes)}`);
    lines.push(`Recv (${response.length}B): ${toHex(response)}`);
    lines.push('');
    lines.push(BETA_NOTE);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  });


  server.registerTool('axefx3_list_blocks', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Return the Axe-Fx III block roster: every block type the editor recognises, with names, group codes, and effect IDs where documented. Pure data, no MIDI.',
      'Blocks with firstId=null are absent from the public v1.4 spec (AMP) or added after firmware 1.13 (NAM, Dynamic Distortion); they are not SysEx-addressable.',
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {},
  }, async () => {
    const lines: string[] = [];
    lines.push(`Axe-Fx III block roster (${AXE_FX_III_BLOCKS.length} entries):`);
    lines.push('');
    lines.push('  group | name                       | instances | effect IDs       | confidence       | addressable?');
    lines.push('  ' + '-'.repeat(98));
    for (const b of AXE_FX_III_BLOCKS) {
      const code = b.groupCode.padEnd(5);
      const name = b.name.padEnd(26);
      const inst = b.instances.toString().padStart(2);
      const ids =
        b.firstId === null
          ? '(not in v1.4)   '
          : b.instances === 1
            ? `${b.firstId}              `.padEnd(16)
            : `${b.firstId}..${b.firstId + b.instances - 1}         `.padEnd(16);
      const conf = b.confidence.padEnd(16);
      const addr = b.firstId === null
        ? 'no (no ID)'
        : b.addressable === false
          ? 'no (FC-only)'
          : 'yes';
      lines.push(`  ${code} | ${name} |     ${inst}    | ${ids} | ${conf} | ${addr}`);
    }
    lines.push('');
    lines.push('To address a block via SysEx (bypass / channel writes), pass the');
    lines.push('block name + instance number to axefx3_set_bypass / axefx3_set_channel.');
    lines.push('Effect IDs are resolved internally from this table. Blocks marked');
    lines.push('"no (FC-only)" are listed in v1.4 but only respond to the Foot');
    lines.push('Controller interface:set_bypass / set_channel refuse for these.');
    lines.push('');
    lines.push(BETA_NOTE);
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  });

}
