/**
 * Download one project slot to a file (read-only). For the scene/chain decode
 * (save+download+diff) and general backup.
 *
 *   npx tsx scripts/circuit-download-slot.ts <slot 0..63> <out.ncs>
 */
import { writeFileSync } from 'node:fs';
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { downloadProject } from '@mcp-midi-control/circuit-tracks/ncs/uploadProject.js';

const slot = Number(process.argv[2]);
const out = process.argv[3] ?? `slot_${slot}.ncs`;

async function main(): Promise<void> {
  const c = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found (powered on? Components closed?).' });
  try {
    const d = await downloadProject(c, slot);
    if (d.bytes) {
      writeFileSync(out, d.bytes);
      console.log(`slot ${slot} (Project ${slot + 1}) -> ${out}  (${d.bytes.length} bytes, crcOk=${d.crcOk})`);
    } else {
      console.log(`slot ${slot}: empty / no readable project (${d.error ?? 'no bytes'})`);
    }
  } finally {
    c.close();
  }
}
main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
