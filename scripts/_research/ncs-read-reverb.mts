/** Print the stored reverb state of one or more .ncs files: engine (FX-View pad, type, decay,
 *  damping), the authoritative send block, and the write-only mirror. */
import { readFileSync } from 'node:fs';
import { getReverbEngine, getReverbSends, getProjectName, REVERB_SEND_MIRROR } from '../../packages/circuit-tracks/src/ncs/format.js';
for (const f of process.argv.slice(2)) {
  const b = new Uint8Array(readFileSync(f));
  const e = getReverbEngine(b);
  console.log(`${getProjectName(b).padEnd(16)} ${f.split(/[\/]/).pop()}`);
  console.log(`  engine: pad ${e.pad} (${e.type_name ?? `type ${e.type}`})  decay ${e.decay}  damping ${e.damping}`);
  console.log(`  sends : ${JSON.stringify(getReverbSends(b))}`);
  console.log(`  mirror: ${Array.from(b.slice(REVERB_SEND_MIRROR, REVERB_SEND_MIRROR + 8)).join(',')}`);
}
