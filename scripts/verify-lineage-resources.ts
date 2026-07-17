/**
 * Verify lineage-as-resources via stdio. Spawns the shipped server,
 * lists resources, asserts that `lineage://am4/<block-type>` URIs
 * are present, then reads one corpus blob and prints a preview.
 *
 * Hardware-free (no MIDI I/O). Reads the AM4 lineage JSON from
 * dist/fractal/shared/lineage/.
 *
 * Usage: npm run build && tsx scripts/verify-lineage-resources.ts
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');

const EXPECTED_AM4_LINEAGE_BLOCKS = [
  'amp', 'drive', 'reverb', 'delay', 'compressor',
  'phaser', 'chorus', 'flanger', 'wah',
  // 2026-07-15 (BK-104): stock DynaCab corpus.
  'dynacab',
];

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'inherit',
  });
  const client = new Client({ name: 'lineage-resource-verifier', version: '0.1.0' });
  await client.connect(transport);

  const resources = await client.listResources();
  const lineageResources = resources.resources.filter((r) => r.uri.startsWith('lineage://'));
  const guidanceResources = resources.resources.filter((r) => r.uri.startsWith('guidance://'));

  console.log(`Total resources: ${resources.resources.length}`);
  console.log(`  guidance://: ${guidanceResources.length}`);
  console.log(`  lineage://:  ${lineageResources.length}`);
  console.log('');

  console.log('Lineage resources advertised:');
  for (const r of lineageResources) {
    console.log(`  ${r.uri}  — ${r.title ?? r.name}`);
  }
  console.log('');

  // Assert: every expected AM4 block type has a resource.
  let failed = 0;
  for (const block of EXPECTED_AM4_LINEAGE_BLOCKS) {
    const uri = `lineage://am4/${block}`;
    const found = lineageResources.find((r) => r.uri === uri);
    if (!found) {
      console.error(`  ❌ missing: ${uri}`);
      failed++;
    }
  }

  // Read one corpus to confirm content is real.
  const sample = 'lineage://am4/amp';
  const read = await client.readResource({ uri: sample });
  const content = read.contents[0];
  const text = content && 'text' in content && typeof content.text === 'string'
    ? content.text
    : undefined;
  if (text === undefined) {
    console.error(`  ❌ read ${sample} returned no text content`);
    failed++;
  } else {
    const head = text.split('\n').slice(0, 8).join('\n');
    console.log(`Sample read (${sample}, ${text.length} chars):`);
    console.log(head);
    console.log('  ...');
    if (!text.match(/^\d+\s+amp\s+records:/)) {
      console.error(`  ❌ ${sample} text does not start with "N amp records:"`);
      failed++;
    }
  }

  await transport.close();

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log('\n✓ Lineage-as-resources verified.');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
