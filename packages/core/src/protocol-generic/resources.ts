/**
 * MCP resources for device agent guidance + lineage corpora.
 *
 * Per-MCP-spec, **tools** are for actions and **resources** are for
 * data the agent might want to read independently. Two families of
 * reference data are exposed here:
 *
 *   - `guidance://<deviceId>/<topic>` — the static `agent_guidance`
 *     blocks on each device descriptor (channel/scene model, save-
 *     language anti-patterns, tempo discipline, applicability rules,
 *     iconic-tone tables, etc.). Shipped before MCP resources had
 *     SDK conventions for cross-device data; back-compat surface on
 *     `describe_device.agent_guidance` stays for now.
 *
 *   - `lineage://<deviceId>/<block-type>` — the Fractal-authored
 *     lineage corpus per block type (amp / drive / reverb / delay /
 *     compressor / phaser / chorus / flanger / wah). Each resource
 *     is the full formatted corpus for that block type, suitable for
 *     bulk loading into the agent's context when planning a build
 *     against a specific block family. The `lookup_lineage` tool
 *     stays for targeted queries against the same data.
 *
 * Both families let the agent:
 *   - Discover topics/corpora via `resources/list` without burning
 *     a tool call.
 *   - Read a specific blob independently — load only the slice
 *     relevant to the current planning step.
 *   - Pin docs in MCP-aware UIs (Claude Desktop's connector panel,
 *     etc.) the way users pin documentation.
 *
 * Static — one resource registration per (device, topic) and
 * (device, block-type) pair at server startup.
 */

import type { McpServer } from '@modelcontextprotocol/server';

import { listRegisteredDevices } from './registry.js';

/**
 * Compact device label for resource titles in MCP-aware UIs. The full
 * display_name (e.g. "Fractal Axe-Fx II XL+") is too long for menu
 * dropdowns once the topic name is appended. The compact label keeps
 * each resource title short enough to read in the Claude Desktop
 * "Add from <server>" submenu without truncation.
 */
function compactDeviceLabel(deviceId: string, displayName: string): string {
  switch (deviceId) {
    case 'am4': return 'AM4';
    case 'axe-fx-ii': return 'Axe-Fx II';
    case 'hydrasynth': return 'Hydrasynth';
    default: return displayName;
  }
}

export function registerDeviceResources(server: McpServer): void {
  for (const descriptor of listRegisteredDevices()) {
    const compactLabel = compactDeviceLabel(descriptor.id, descriptor.display_name);

    // agent_guidance — one resource per topic.
    const guidance = descriptor.agent_guidance;
    if (guidance !== undefined) {
      for (const [topic, content] of Object.entries(guidance)) {
        if (typeof content !== 'string' || content.length === 0) continue;
        const uri = `guidance://${descriptor.id}/${topic}`;
        // Internal name stays unique + technical so resources/list can be
        // disambiguated unambiguously. Title is what users see in the
        // Add-from dropdown — kept short by leading with the topic name
        // (the part users actually care about) and using the compact
        // device label.
        const name = `${descriptor.display_name} — ${topic}`;
        const title = `${topic}  (${compactLabel})`;
        const description = firstSentence(content, 200);
        server.registerResource(
          name,
          uri,
          {
            title,
            description,
            mimeType: 'text/plain',
          },
          async (readUri) => ({
            contents: [{
              uri: typeof readUri === 'string' ? readUri : uri,
              mimeType: 'text/plain',
              text: content,
            }],
          }),
        );
      }
    }

    // lineage corpus — one resource per block-type that has lineage data.
    // Only AM4 ships lineage today; Axe-Fx II and Hydrasynth omit the
    // reader.lineageCorpus method, so they skip this loop entirely.
    const corpus = descriptor.reader.lineageCorpus?.();
    if (corpus !== undefined) {
      for (const [blockType, content] of Object.entries(corpus)) {
        if (typeof content !== 'string' || content.length === 0) continue;
        const uri = `lineage://${descriptor.id}/${blockType}`;
        const name = `${descriptor.display_name} — ${blockType} lineage`;
        const title = `${blockType} lineage  (${compactLabel})`;
        const description = `Fractal-authored ${blockType} lineage corpus (${countRecords(content)} entries). Each entry covers the block's modeled source — manufacturer, model, era, signature tone characteristics.`;
        server.registerResource(
          name,
          uri,
          {
            title,
            description,
            mimeType: 'text/plain',
          },
          async (readUri) => ({
            contents: [{
              uri: typeof readUri === 'string' ? readUri : uri,
              mimeType: 'text/plain',
              text: content,
            }],
          }),
        );
      }
    }
  }
}

/** Best-effort entry count for a corpus blob — reads "N <block-type> records:" header. */
function countRecords(text: string): number {
  const match = text.match(/^(\d+)\s+\S+\s+records:/);
  return match ? Number(match[1]) : 0;
}

function firstSentence(text: string, maxLen: number): string {
  const sentenceEnd = text.search(/[.!?]\s/);
  const cut = sentenceEnd >= 0 && sentenceEnd < maxLen
    ? sentenceEnd + 1
    : Math.min(maxLen, text.length);
  return text.slice(0, cut).trim();
}
