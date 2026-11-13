#!/usr/bin/env tsx
/**
 * Hardware sweep: exhaust the readable Axe-Fx II spec-diff disagreements while
 * connected. Reads the disputed paramIds (+ control samples) in the always-
 * placed blocks (amp, cab, controllers). A response confirms the paramId is a
 * LIVE current-firmware param (ruling the 2014 spec outdated there); a timeout
 * on a disputed paramId is a potential catalog ghost to investigate.
 *
 * Read-only. Drives the live MCP server.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER = path.join(ROOT, 'packages', 'server-all', 'dist', 'server', 'index.js');
const PORT = 'axe-fx-ii';

interface R { block: string; name: string; pid: number; disputed: boolean; spec?: string; }
const READS: R[] = [
  // amp controls (sanity — must respond)
  { block: 'amp', name: 'effect_type', pid: 0, disputed: false },
  { block: 'amp', name: 'input_drive', pid: 1, disputed: false },
  { block: 'amp', name: 'master_volume', pid: 5, disputed: false },
  { block: 'amp', name: 'presence', pid: 20, disputed: false },
  // amp disputed (ours vs 2014-spec name)
  { block: 'amp', name: 'xformer_grind', pid: 9, disputed: true, spec: 'TONESPACE' },
  { block: 'amp', name: 'low_res_freq', pid: 26, disputed: true, spec: 'SPKRFREQ' },
  { block: 'amp', name: 'low_res', pid: 27, disputed: true, spec: 'SPKRGAIN' },
  { block: 'amp', name: 'drivetype', pid: 30, disputed: true, spec: 'HARDNESS1' },
  { block: 'amp', name: 'harmonics', pid: 33, disputed: true, spec: 'STABILIZER' },
  { block: 'amp', name: 'pi_ratio', pid: 38, disputed: true, spec: 'SPKRGAIN2' },
  { block: 'amp', name: 'low_res_q', pid: 41, disputed: true, spec: 'SPKRQ' },
  { block: 'amp', name: 'hi_resonance', pid: 44, disputed: true, spec: 'SPKRHGAIN' },
  { block: 'amp', name: 'cut', pid: 45, disputed: true, spec: 'SPKRHQ' },
  { block: 'amp', name: 'preamp_tubes', pid: 69, disputed: true, spec: 'VOICING' },
  { block: 'amp', name: 'out_comp_clarity', pid: 70, disputed: true, spec: 'PALPFREQ' },
  { block: 'amp', name: 'character_q', pid: 71, disputed: true, spec: 'PAHPFREQ' },
  { block: 'amp', name: 'overdrive', pid: 74, disputed: true, spec: 'SPKRMGAIN' },
  { block: 'amp', name: 'out_comp_amount', pid: 75, disputed: true, spec: 'DYNAMICS' },
  { block: 'amp', name: 'out_comp_threshold', pid: 76, disputed: true, spec: 'DYNTIME' },
  { block: 'amp', name: 'preamp_cf_compress', pid: 80, disputed: true, spec: 'PREDYNAMICS' },
  { block: 'amp', name: 'preamp_cf_time', pid: 81, disputed: true, spec: 'PREDYNTIME' },
  { block: 'amp', name: 'version', pid: 82, disputed: true, spec: 'USEMATCHING' },
  { block: 'amp', name: 'ac_line_freq', pid: 87, disputed: true, spec: 'LINEFREQ' },
  { block: 'amp', name: 'pwr_amp_hardness', pid: 88, disputed: true, spec: 'THUNK' },
  { block: 'amp', name: 'preamp_cf_ratio', pid: 91, disputed: true, spec: 'SPARE1' },
  { block: 'amp', name: 'eq_type', pid: 92, disputed: true, spec: 'SPARE2' },
  { block: 'amp', name: 'cathode_resist', pid: 93, disputed: true, spec: 'NSPARE1' },
  { block: 'amp', name: 'cbtime', pid: 94, disputed: true, spec: 'NSPARE2' },
  // cab controls + disputed
  { block: 'cab', name: 'cab', pid: 0, disputed: false },
  { block: 'cab', name: 'mic', pid: 1, disputed: false },
  { block: 'cab', name: 'level', pid: 9, disputed: false },
  { block: 'cab', name: 'effect_type', pid: 12, disputed: true, spec: 'MODE' },
  { block: 'cab', name: 'saturation', pid: 15, disputed: true, spec: 'DRIVER' },
  // controllers disputed (always-present block)
  { block: 'controllers', name: 'tempo_setting', pid: 33, disputed: true, spec: 'TEMPOTOUSE' },
  { block: 'controllers', name: 'scene_2', pid: 79, disputed: true, spec: 'METLEVEL' },
  { block: 'controllers', name: 'scene_3', pid: 80, disputed: true, spec: 'METONOFF' },
];

function parse(res: unknown): { wire?: number; display?: unknown; err?: string } {
  const r = res as { content?: { text?: string }[] };
  const t = (r.content ?? []).map((c) => c.text ?? '').join('\n');
  if (/no response|Timeout|not placed|unknown/i.test(t)) return { err: t.replace(/\s+/g, ' ').slice(0, 90) };
  try {
    const j = JSON.parse(t);
    return { wire: j.wire_value, display: j.display_value };
  } catch {
    const w = t.match(/wire_value"?:\s*(\d+)/);
    return { wire: w ? +w[1] : undefined, display: t.replace(/\s+/g, ' ').slice(0, 60) };
  }
}

async function main() {
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env: { ...process.env } });
  const client = new Client({ name: 'diff-sweep', version: '0.0.1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);

  const ghosts: R[] = [];
  let live = 0;
  console.log('block.param                pid  disputed  result');
  console.log('-'.repeat(78));
  for (const r of READS) {
    let out: { wire?: number; display?: unknown; err?: string };
    try {
      const res = await client.callTool({ name: 'get_param', arguments: { port: PORT, block: r.block, name: r.name } });
      out = parse(res);
    } catch (e) {
      out = { err: (e as Error).message.replace(/\s+/g, ' ').slice(0, 90) };
    }
    const label = `${r.block}.${r.name}`.padEnd(26);
    const d = r.disputed ? `(vs ${r.spec})`.padEnd(18) : 'control'.padEnd(18);
    if (out.err) {
      console.log(`${label} ${String(r.pid).padStart(3)}  ${d} TIMEOUT/none  ${out.err}`);
      if (r.disputed) ghosts.push(r);
    } else {
      live++;
      console.log(`${label} ${String(r.pid).padStart(3)}  ${d} LIVE  wire=${out.wire} display=${JSON.stringify(out.display)}`);
    }
  }
  console.log('-'.repeat(78));
  console.log(`LIVE responses: ${live}/${READS.length}`);
  if (ghosts.length) {
    console.log(`POTENTIAL GHOSTS (disputed paramId timed out — investigate): ${ghosts.map((g) => `${g.block}.${g.name}#${g.pid}`).join(', ')}`);
  } else {
    console.log('No disputed paramId timed out: every read disputed param is a LIVE current-firmware param → 2014 spec is outdated there, our catalog stands.');
  }
  await client.close();
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
