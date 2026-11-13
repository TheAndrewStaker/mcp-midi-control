/** The 11-byte per-drum record (base 0x26fbc, stride 11) for each of the four lanes. */
import { readFileSync } from 'node:fs';
// +7..+10 are RESERVED/PAD: zero in 4,700 of 4,700 track-slots across the corpus, so nothing has
// ever been observed in them. They were briefly labelled rev_send/dly_send - retracted 2026-09-20.
// The REAL drum reverb sends are hardware-confirmed elsewhere, at 0x26ffa..0x26ffd (format.ts).
const F = ['patch_select', 'level', 'pitch', 'decay', 'distortion', 'eq', 'pan', 'pad7', 'pad8', 'pad9', 'pad10'];
for (const f of process.argv.slice(2)) {
  const b = new Uint8Array(readFileSync(f));
  console.log(f.split(/[\/]/).pop());
  for (let t = 0; t < 4; t++) {
    const o = 0x26fbc + t * 11;
    console.log(`  D${t + 1}: ` + F.map((n, i) => `${n}=${b[o + i]}`).join(' '));
  }
}
