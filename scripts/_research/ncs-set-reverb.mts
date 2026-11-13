/** Store the reverb ENGINE (FX-View pad) + per-lane sends into exported .ncs files.
 *  usage: ncs-set-reverb.mts <pad 1-8> <audio1Send 0-127> <file.ncs...> */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  getReverbSends, setReverbSend, FX_SEND_LANES, getProjectName,
  getReverbEngine, setReverbPreset,
} from '../../packages/circuit-tracks/src/ncs/format.js';

const [padArg, sendArg, ...files] = process.argv.slice(2);
const pad = Number(padArg), send = Number(sendArg);
if (!files.length || !Number.isInteger(pad) || !Number.isInteger(send)) {
  console.error('usage: ncs-set-reverb.mts <pad 1-8> <audio1Send 0-127> <file.ncs...>');
  process.exit(1);
}
for (const src of files) {
  const buf = new Uint8Array(readFileSync(src));
  const before = { ...getReverbEngine(buf), audio1: getReverbSends(buf).audio1 };
  setReverbPreset(buf, pad);
  for (const lane of FX_SEND_LANES) setReverbSend(buf, lane, lane === 'audio1' ? send : 0);

  const out = src.replace(/(-rev[-\d]*)?\.ncs$/, `-rev${pad}-${send}.ncs`);
  writeFileSync(out, buf);

  const back = new Uint8Array(readFileSync(out));
  const eng = getReverbEngine(back), sends = getReverbSends(back);
  const othersZero = Object.entries(sends).filter(([k]) => k !== 'audio1').every(([, v]) => v === 0);
  console.log(
    `${getProjectName(back).padEnd(16)} pad ${before.pad}->${eng.pad} ${String(eng.type_name).padEnd(10)} ` +
    `decay ${eng.decay} damp ${eng.damping}  audio1 ${String(before.audio1).padStart(3)}->${String(sends.audio1).padStart(3)} ` +
    `${othersZero ? 'others 0' : 'OTHERS NONZERO'}`,
  );
}
