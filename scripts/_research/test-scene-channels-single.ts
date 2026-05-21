import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAxeFxIISceneChannelsTool } from '@mcp-midi-control/axe-fx-ii/tools/sceneChannels.js';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { executeSwitchPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';

registerDevice(AXEFX2_DESCRIPTOR);

const handlers = new Map<string, (i: unknown) => Promise<{ structuredContent?: unknown }>>();
const server = {
  registerTool(n: string, _m: unknown, h: (i: unknown) => Promise<{ structuredContent?: unknown }>) {
    handlers.set(n, h);
  },
} as unknown as McpServer;

async function main(): Promise<void> {
  registerAxeFxIISceneChannelsTool(server);
  await executeSwitchPreset({ port: 'axe-fx-ii', location: 666, on_active_preset_edited: 'discard' });
  await new Promise(r => setTimeout(r, 250));

  console.log('=== Test: SINGLE block (Drive 1, scenes 2,4,6,8 → Y) ===');
  const r1 = await handlers.get('axefx2_set_scene_channels')!({
    location: 666,
    assignments: [{ block: 'Drive 1', scenes_on_y: [2, 4, 6, 8] }],
    save_authorized: true,
  });
  console.log(JSON.stringify(r1.structuredContent, null, 2));

  await new Promise(r => setTimeout(r, 500));

  console.log('\n=== Test: TWO blocks (Drive 1 + Amp 1) ===');
  const r2 = await handlers.get('axefx2_set_scene_channels')!({
    location: 666,
    assignments: [
      { block: 'Drive 1', scenes_on_y: [1, 5] },
      { block: 'Amp 1', scenes_on_y: [3, 7] },
    ],
    save_authorized: true,
  });
  console.log(JSON.stringify(r2.structuredContent, null, 2));

  setTimeout(() => process.exit(0), 200);
}

main().catch(e => { console.error(e); process.exit(1); });
