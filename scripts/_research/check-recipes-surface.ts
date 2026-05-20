/**
 * Quick smoke test: confirm describe_device returns the new recipes[]
 * field, across all 4 registered devices. Hand-runnable; not a golden.
 *
 * Run: npx tsx scripts/_research/check-recipes-surface.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface RecipeEntry {
  id: string;
  family: string;
  description: string;
  target_block?: string;
  params: Record<string, number | string>;
  modifier_needed?: boolean;
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['packages/server-all/dist/server/index.js'],
    env: { ...process.env, MCP_MOCK_TRANSPORT: 'true' },
  });

  const client = new Client({ name: 'check', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);

  for (const port of ['am4', 'axe-fx-ii', 'axe-fx-iii', 'hydrasynth']) {
    const r = await client.callTool({ name: 'describe_device', arguments: { port } });
    const content = (r as { content?: Array<{ text?: string }> }).content;
    const text = content?.[0]?.text ?? '';
    let recipes: RecipeEntry[] = [];
    try {
      const j = JSON.parse(text);
      recipes = j.recipes ?? [];
    } catch {
      console.log(`${port}: failed to parse describe_device response`);
      continue;
    }
    console.log(`${port}: ${recipes.length} recipes`);
    if (recipes.length === 0) continue;
    const families: Record<string, number> = {};
    for (const e of recipes) families[e.family] = (families[e.family] ?? 0) + 1;
    console.log(`  families: ${JSON.stringify(families)}`);
    console.log(`  first id: ${recipes[0].id} (target_block=${recipes[0].target_block ?? '<none>'})`);
    const sample = recipes[0];
    const keys = Object.keys(sample.params);
    console.log(`  params keys (${keys.length}): ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? '...' : ''}`);
  }

  await client.close();
  process.exit(0);
}

void main();
