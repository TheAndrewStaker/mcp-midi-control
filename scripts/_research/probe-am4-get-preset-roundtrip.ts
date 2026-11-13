/**
 * Cross-check get_preset's per-param values against single get_param
 * reads of the same params. Validates that the atomic read returns the
 * same display values as the per-paramId GET path.
 *
 * Picks a few well-known knobs from each placed block (amp.gain,
 * drive.drive, reverb.mix, etc.) and reports any mismatches.
 *
 *   npx tsx scripts/_research/probe-am4-get-preset-roundtrip.ts
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['packages/server-all/dist/server/index.js'],
  });
  const client = new Client({ name: 'probe', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);

  const snapshotT0 = Date.now();
  const snapshot = await callTool(client, 'get_preset', { port: 'am4' }) as { slots: { slot: number; block_type: string; params?: Record<string, number | string> }[] };
  const snapshotMs = Date.now() - snapshotT0;

  const checks: { block: string; name: string }[] = [];
  for (const slot of snapshot.slots) {
    const candidates = ['mix', 'level', 'gain', 'drive', 'time', 'rate', 'depth', 'type'];
    const params = slot.params ?? {};
    for (const c of candidates) {
      if (c in params) {
        checks.push({ block: slot.block_type, name: c });
        break; // one check per slot
      }
    }
  }

  const results: { block: string; name: string; snapshotValue: unknown; getParamValue: unknown; matches: boolean }[] = [];
  const getParamT0 = Date.now();
  for (const c of checks) {
    const slot = snapshot.slots.find((s) => s.block_type === c.block)!;
    const snapshotValue = (slot.params ?? {})[c.name];
    const single = await callTool(client, 'get_param', { port: 'am4', block: c.block, name: c.name }) as { display_value: unknown };
    const getParamValue = single.display_value;
    // Snapshot values are numbers (float); get_param returns the same. Compare with epsilon for floats.
    const matches = typeof snapshotValue === 'number' && typeof getParamValue === 'number'
      ? Math.abs(snapshotValue - getParamValue) < 1e-3
      : snapshotValue === getParamValue;
    results.push({ block: c.block, name: c.name, snapshotValue, getParamValue, matches });
  }
  const getParamMs = Date.now() - getParamT0;

  await client.close();

  console.log(`Snapshot (1 call): ${snapshotMs} ms, ${snapshot.slots.length} placed slots`);
  console.log(`Per-param GET (${checks.length} calls, one per slot): ${getParamMs} ms`);
  console.log(`Speedup factor (extrapolated to full coverage): ${(getParamMs / snapshotMs * 50).toFixed(1)}× — assuming ~50 params per placed block`);
  console.log();
  console.log('Cross-check (one canonical param per placed slot):');
  let allMatch = true;
  for (const r of results) {
    const mark = r.matches ? '✓' : '✗';
    console.log(`  ${mark} ${r.block.padEnd(12)}.${r.name.padEnd(10)} snapshot=${JSON.stringify(r.snapshotValue)}  get_param=${JSON.stringify(r.getParamValue)}`);
    if (!r.matches) allMatch = false;
  }
  if (allMatch) console.log(`\n✓ all ${results.length} cross-checks matched — atomic read agrees with per-paramId GET`);
  else console.log(`\n✗ ${results.filter((r) => !r.matches).length} mismatch(es) — investigate`);
}

main().catch((err) => { console.error('FATAL:', err); process.exitCode = 1; });
