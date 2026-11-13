/** Duration + tail of every WAV in a folder: what can a mono lane actually ring for? */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const d = process.argv[2];
const names = process.argv.slice(3);
for (const f of readdirSync(d).filter((x) => x.toLowerCase().endsWith('.wav')).sort()) {
  if (names.length && !names.some((n) => f.includes(n))) continue;
  const b = readFileSync(join(d, f));
  // minimal RIFF walk
  let off = 12, rate = 44100, bits = 16, ch = 1, dataOff = 0, dataLen = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
    if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz & 1);
  }
  const frames = dataLen / (ch * (bits / 8));
  const dur = frames / rate;
  // tail: last frame above -60 dBFS
  const thr = 32768 * Math.pow(10, -60 / 20);
  let last = 0;
  for (let i = 0; i < frames; i++) {
    const v = Math.abs(b.readInt16LE(dataOff + i * ch * 2));
    if (v > thr) last = i;
  }
  console.log(`${f.padEnd(34)} ${dur.toFixed(2)}s  audible→${(last / rate).toFixed(2)}s  ${rate}Hz ${bits}b ${ch}ch`);
}
