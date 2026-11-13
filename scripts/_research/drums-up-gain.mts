/**
 * drums-up-gain.mts - OFFLINE. Write a gain-adjusted copy of a WAV, so a sample that is right in
 * character but wrong in level can be levelled once, permanently, instead of being rejected.
 *
 * Levels are matched on MOMENTARY-MAX (loudest 100 ms window), not integrated loudness: a one-shot is
 * too short for an integrated measure, which once told this project to boost a ride 12 dB the wrong way.
 *
 * Usage: npx tsx scripts/_research/drums-up-gain.mts <in.wav> <out.wav> <dB>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const [inp, outp, dbStr] = process.argv.slice(2);
if (!inp || !outp || dbStr === undefined) throw new Error('usage: drums-up-gain.mts <in.wav> <out.wav> <dB>');
const gain = 10 ** (Number(dbStr) / 20);
const b = readFileSync(inp);
let off = 12, dataOff = -1, dataSz = 0, ch = 0, rate = 0, bits = 0;
while (off + 8 <= b.length) {
  const id = b.toString('ascii', off, off + 4); const sz = b.readUInt32LE(off + 4);
  if (id === 'fmt ') { ch = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
  if (id === 'data') { dataOff = off + 8; dataSz = sz; break; }
  off += 8 + sz + (sz & 1);
}
if (dataOff < 0 || bits !== 16) throw new Error(`${inp}: need 16-bit PCM (got ${bits}-bit)`);
const out = Buffer.from(b);
let clipped = 0;
for (let i = 0; i < Math.floor(dataSz / 2); i++) {
  const v = Math.round(b.readInt16LE(dataOff + i * 2) * gain);
  const c = Math.max(-32768, Math.min(32767, v));
  if (c !== v) clipped++;
  out.writeInt16LE(c, dataOff + i * 2);
}
mkdirSync(dirname(outp), { recursive: true });
writeFileSync(outp, out);
console.log(`${inp} ${Number(dbStr) >= 0 ? '+' : ''}${dbStr} dB -> ${outp}  (${ch}ch ${rate}Hz, ${clipped} sample(s) clipped)`);
