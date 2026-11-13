/**
 * Contract test for the device-agnostic export_preset / import_preset surface.
 *
 * Runs against the mock-transport server (no hardware). Locks the behavior the
 * device-agnostic future (Line 6 Helix, modern Fractal III/FM3/FM9) depends on:
 *
 *   1. Both tools are registered with the right annotations
 *      (export = read-of-device + local file write, not destructive;
 *       import = destructive, it replaces the working buffer / can overwrite).
 *   2. Capability gating: a device without a capability returns
 *      capability_not_supported, NOT a crash or a silent no-op. gen-3 now
 *      implements export (edit-buffer dump) but NOT import (restore / write-back
 *      is uncaptured), so export must fail cleanly with no_ack under the
 *      responder-less mock while import still returns capability_not_supported.
 *      This is the contract a device opts into per-direction by implementing
 *      dumpActivePresetBinary / restorePresetBinary.
 *   3. Unknown port → port_not_found.
 *   4. Cross-device safety: importing a file whose size doesn't match the
 *      target device (e.g. an AM4 12,352-byte backup into an Axe-Fx II, or
 *      vice versa) is rejected with a clear "wrong device" message BEFORE any
 *      byte reaches the wire. This is the guard that stops a multi-device user
 *      pushing the wrong .syx once Helix + III dumps share the surface.
 *
 * Run: npm run build && npx tsx scripts/mcp-test-preset-portability.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');

interface ToolDef { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }
function text(r: unknown): string {
  const c = (r as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return c.filter((x) => x.type === 'text' && x.text).map((x) => x.text).join('\n');
}
function isError(r: unknown): boolean { return (r as { isError?: boolean }).isError === true; }

const failures: string[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  console.log(`  ${pass ? '✓' : '✗'} ${name}`);
  if (!pass) { failures.push(name); if (detail) console.log(`      ${detail.slice(0, 200)}`); }
}

async function main(): Promise<void> {
  // A temp dir + fixture files of specific sizes (junk bytes — the size guard
  // fires before any parse, which is exactly the cross-device guard we test).
  const dir = mkdtempSync(path.join(tmpdir(), 'preset-portability-'));
  const f100 = path.join(dir, 'tiny.syx'); writeFileSync(f100, Buffer.alloc(100, 0x55));
  const fAm4Size = path.join(dir, 'am4size.syx'); writeFileSync(fAm4Size, Buffer.alloc(12352, 0x55));
  const fIiSize = path.join(dir, 'iisize.syx'); writeFileSync(fIiSize, Buffer.alloc(12951, 0x55));

  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER_ENTRY],
    env: { ...(process.env as Record<string, string>), MCP_MOCK_TRANSPORT: '1' },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'preset-portability', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);

  const tools = (await client.listTools()).tools as ToolDef[];
  const exp = tools.find((t) => t.name === 'export_preset');
  const imp = tools.find((t) => t.name === 'import_preset');

  console.log('Registration + annotations:');
  check('export_preset registered', !!exp);
  check('import_preset registered', !!imp);
  check('export_preset is not destructive', exp?.annotations?.destructiveHint === false, JSON.stringify(exp?.annotations));
  check('import_preset is destructive', imp?.annotations?.destructiveHint === true, JSON.stringify(imp?.annotations));

  console.log('\nCapability gating (gen-3: export wired, import not):');
  for (const port of ['axe-fx-iii', 'fm3', 'fm9']) {
    // export_preset is WIRED for gen-3 (edit-buffer dump, fn=0x43). The mock
    // connector now synthesizes the dump (0x51 head + 0x52 body run), so export
    // SUCCEEDS under the mock; against a non-answering device the read-until-quiet
    // collector would instead time out with no_ack. The contract under test is the
    // capability gate: it must NOT be capability_not_supported either way.
    const e = await client.callTool({ name: 'export_preset', arguments: { port } });
    const eTxt = text(e);
    check(
      `export_preset(${port}) is implemented (not capability_not_supported)`,
      !/not implemented|capability_not_supported/i.test(eTxt),
      eTxt,
    );
    // import_preset (restore / write-back) is NOT wired for gen-3 yet.
    const i = await client.callTool({ name: 'import_preset', arguments: { port, file_path: f100 } });
    check(`import_preset(${port}) → capability_not_supported`, isError(i) && /not implemented|capability_not_supported/i.test(text(i)), text(i));
  }

  console.log('\nUnknown port:');
  const u = await client.callTool({ name: 'import_preset', arguments: { port: 'nope', file_path: f100 } });
  check('import_preset(nope) → port_not_found', isError(u) && /no registered device|port_not_found/i.test(text(u)), text(u));

  console.log('\nCross-device safety (wrong .syx for the target device):');
  // AM4-sized backup into the Axe-Fx II → rejected (must be 12951).
  const wrong1 = await client.callTool({ name: 'import_preset', arguments: { port: 'axefx2', file_path: fAm4Size } });
  check('import_preset(axefx2, AM4-sized file) → rejected (12951 mismatch)', isError(wrong1) && /12951|must be/i.test(text(wrong1)), text(wrong1));
  // Axe-Fx II-sized backup into the AM4 → rejected (must be 12352).
  const wrong2 = await client.callTool({ name: 'import_preset', arguments: { port: 'am4', file_path: fIiSize } });
  check('import_preset(am4, II-sized file) → rejected (12352 mismatch)', isError(wrong2) && /12352|must be/i.test(text(wrong2)), text(wrong2));
  // Obviously-wrong tiny file → rejected on both.
  const tiny1 = await client.callTool({ name: 'import_preset', arguments: { port: 'axefx2', file_path: f100 } });
  check('import_preset(axefx2, 100-byte file) → rejected', isError(tiny1) && /must be|12951/i.test(text(tiny1)), text(tiny1));

  await client.close();

  console.log('');
  if (failures.length === 0) {
    console.log('✓ PASS — export_preset / import_preset device-agnostic contract holds.');
    process.exit(0);
  }
  console.log(`✗ FAIL — ${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
main().catch((e) => { console.error('Fatal:', e); process.exit(99); });
