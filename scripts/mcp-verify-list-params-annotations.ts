/**
 * One-shot verification for the v0.3 functional-parity gap #7 fix:
 * confirm that `list_params({ port: 'am4', block: 'amp', name: 'master' })`
 * returns `host_label`, `parameter_name`, and `applies_only_when` (when
 * the param is type-gated) — the annotations that the removed
 * am4_list_params used to surface.
 *
 * Hardware-free.
 *
 * STALE, AND KEPT ONLY BECAUSE DELETING SOMEONE ELSE'S GATE IS THEIR CALL.
 * It is wired into no npm script and its server path had already rotted
 * (`dist/server/index.js` predates the workspace split). Everything it checks
 * now has preflight-gated coverage in `scripts/verify-dispatcher.ts` under
 * "scope projection". Two fixes were applied 2026-08-02 so that running it by
 * hand does not produce a misleading red: the server path, and Probe 3, which
 * read `parameter_name` off the BLOCK-scoped response. That field is now
 * served only at param scope (`block` + `name`). It is 26-27 KB per gen-3
 * catalog and inlining it per row is part of what put this tool past the
 * host's delivery cliff. Delete this file when convenient.
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');
function extractText(r: unknown): string {
  if (!r || typeof r !== 'object') return '';
  const c = r as { content?: Array<{ type?: string; text?: string }> };
  return (c.content ?? []).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text!).join('\n');
}

async function main(): Promise<void> {
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
  if (t.stderr) t.stderr.on('data', () => {});
  const c = new Client({ name: 'v', version: '1' }, { capabilities: {} });
  await c.connect(t);
  let pass = true;
  try {
    // Probe 1: amp.master (always applies, has AM4-Edit label "Master")
    const r1 = await c.callTool({
      name: 'list_params',
      arguments: { port: 'am4', block: ['amp'], name: ['master'] },
    });
    const t1 = extractText(r1);
    const parsed1 = JSON.parse(t1);
    const masterEntry = parsed1.params?.[0];
    const hasMasterLabel = masterEntry?.host_label === 'Master';
    console.log(hasMasterLabel
      ? '✓ amp.master surfaces host_label="Master" (AM4-Edit canonical wording)'
      : `✗ amp.master.host_label missing or wrong (got ${JSON.stringify(masterEntry?.host_label)})`);
    if (!hasMasterLabel) pass = false;

    // Probe 2: a type-gated param — amp.bias_x (only applies on certain amp types)
    const r2 = await c.callTool({
      name: 'list_params',
      arguments: { port: 'am4', block: ['amp'] },
    });
    const t2 = extractText(r2);
    const parsed2 = JSON.parse(t2);
    const typeGatedParams = (parsed2.params ?? []).filter((p: { applies_only_when?: string }) => p.applies_only_when);
    console.log(typeGatedParams.length > 0
      ? `✓ ${typeGatedParams.length} amp params carry applies_only_when (type-gating annotation)`
      : '✗ NO params carry applies_only_when — applicability decode not flowing');
    if (typeGatedParams.length === 0) pass = false;
    if (typeGatedParams.length > 0) {
      const sample = typeGatedParams[0];
      console.log(`  sample: amp.${sample.name} — "${sample.applies_only_when.slice(0, 80)}..."`);
    }

    // Probe 3: a param with a known firmware symbolic id (parameter_name).
    // Read it from the PARAM-scoped response (parsed1), not the block-scoped
    // one: `parameter_name` is a post-choice cross-reference field and is
    // withheld from block scope for size.
    const distortMaster = (parsed1.params ?? []).find((p: { name: string }) => p.name === 'master');
    const hasParamName = distortMaster?.parameter_name === 'DISTORT_MASTER';
    console.log(hasParamName
      ? '✓ amp.master surfaces parameter_name="DISTORT_MASTER" (firmware symbolic id)'
      : `✗ amp.master.parameter_name missing (got ${JSON.stringify(distortMaster?.parameter_name)})`);
    if (!hasParamName) pass = false;
  } finally {
    await c.close();
  }
  console.log(pass ? '\n🎯 PASS — gap #7 fix verified' : '\n❌ FAIL');
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(99); });
