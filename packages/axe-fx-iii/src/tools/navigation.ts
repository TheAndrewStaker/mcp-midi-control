/**
 * Axe-Fx III navigation tools,read tools per v1.4 PDF spec.
 *
 * NOTE: there is NO `axefx3_switch_preset` tool because the III's
 * v1.4 spec does NOT include a SysEx preset-switch function. III
 * preset switching is done via standard MIDI Program Change (with
 * CC 0 / CC 32 Bank Select for slots > 127), which is outside this
 * SysEx-focused tool surface.
 *
 * `axefx3_switch_scene` was removed 2026-05-18,the unified
 * `switch_scene({port:'axe-fx-iii', scene})` covers it via the
 * descriptor writer.switchScene path.
 *
 * Tools registered:
 *   - axefx3_get_active_scene   (function 0x0C query)
 *   - axefx3_get_preset_name    (function 0x0D,returns preset # + name)
 *   - axefx3_get_scene_name     (function 0x0E)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  buildGetScene,
  buildQueryPatchName,
  buildQuerySceneName,
  isSetGetSceneResponse,
  isQueryPatchNameResponse,
  isQuerySceneNameResponse,
  parseSceneResponse,
  parseQueryPatchNameResponse,
  parseQuerySceneNameResponse,
} from 'fractal-midi/axe-fx-iii';

import {
  BETA_NOTE,
  BETA_PREFIX,
  GET_RESPONSE_TIMEOUT_MS,
  ensureConn,
  toHex,
} from './shared.js';

export function registerAxeFxIIINavigationTools(server: McpServer): void {

  server.registerTool('axefx3_get_active_scene', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Read the currently-active scene (1-based) within the active Axe-Fx III preset.',
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {},
  }, async () => {
    const reqBytes = buildGetScene();
    const c = ensureConn();
    const responsePromise = c.receiveSysExMatching(
      isSetGetSceneResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(reqBytes);
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `axefx3_get_active_scene failed: ${msg}\n` +
        `Sent ${reqBytes.length} bytes: ${toHex(reqBytes)}`,
      );
    }
    const { scene } = parseSceneResponse(response);
    return {
      content: [{
        type: 'text',
        text:
          `Active scene: ${scene + 1} (wire ${scene}).\n` +
          `Sent (${reqBytes.length}B): ${toHex(reqBytes)}\n` +
          `Recv (${response.length}B): ${toHex(response)}\n` +
          `\n${BETA_NOTE}`,
      }],
    };
  });


  server.registerTool('axefx3_get_preset_name', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Read a preset\'s name + number on the Axe-Fx III in one round-trip. Default reads the active preset; pass `preset` (0..1023) to look up a stored preset by number.',
      'There is no separate "get preset number" function on the III; this is how you get both.',
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {
      preset: z.number().int().min(0).max(1023).optional().describe(
        '0-based preset number to query. Omit to query the active preset.',
      ),
    },
  }, async ({ preset }) => {
    const target = preset ?? 'current';
    const reqBytes = buildQueryPatchName(target);
    const c = ensureConn();
    const responsePromise = c.receiveSysExMatching(
      isQueryPatchNameResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(reqBytes);
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `axefx3_get_preset_name failed: ${msg}\n` +
        `Sent ${reqBytes.length} bytes: ${toHex(reqBytes)}`,
      );
    }
    const parsed = parseQueryPatchNameResponse(response);
    return {
      content: [{
        type: 'text',
        text:
          `${target === 'current' ? 'Active' : `Preset ${preset}`}: ` +
          `"${parsed.name}" (preset number ${parsed.presetNumber}, ` +
          `display slot ${parsed.presetNumber + 1}).\n` +
          `Sent (${reqBytes.length}B): ${toHex(reqBytes)}\n` +
          `Recv (${response.length}B): ${toHex(response)}\n` +
          `\n${BETA_NOTE}`,
      }],
    };
  });


  server.registerTool('axefx3_get_scene_name', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      BETA_PREFIX + 'Read a scene\'s name (1..8) in the active Axe-Fx III preset, or pass scene="current" for the active scene.',
      'Read-only: the public spec has no SET_SCENE_NAME envelope.',
      BETA_NOTE,
    ].join('\n'),
    inputSchema: {
      scene: z.union([
        z.literal('current'),
        z.number().int().min(1).max(8),
      ]).describe(
        '1-indexed scene number (1..8), or "current" to read the active scene\'s name.',
      ),
    },
  }, async ({ scene }) => {
    const wireSentinel = scene === 'current' ? 'current' as const : (scene - 1);
    const reqBytes = buildQuerySceneName(wireSentinel);
    const c = ensureConn();
    const responsePromise = c.receiveSysExMatching(
      isQuerySceneNameResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    c.send(reqBytes);
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `axefx3_get_scene_name failed: ${msg}\n` +
        `Sent ${reqBytes.length} bytes: ${toHex(reqBytes)}`,
      );
    }
    const parsed = parseQuerySceneNameResponse(response);
    const displayScene = parsed.scene + 1;
    return {
      content: [{
        type: 'text',
        text:
          `Scene ${displayScene} name: "${parsed.name}".\n` +
          `Sent (${reqBytes.length}B): ${toHex(reqBytes)}\n` +
          `Recv (${response.length}B): ${toHex(response)}\n` +
          `\n${BETA_NOTE}`,
      }],
    };
  });

}
