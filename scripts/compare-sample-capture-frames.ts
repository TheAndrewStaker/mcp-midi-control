/**
 * Compare our generated sample-upload frames against the real Novation Components
 * capture, byte-by-byte on the WAV-INDEPENDENT parts (session prefix: handshake +
 * enumeration, and the WRITE_INIT / SET_FILENAME framing). Finds what makes a
 * Components write PERSIST that ours doesn't — grounded, not guessed.
 *
 *   npx tsx scripts/compare-sample-capture-frames.ts
 */
import { readFileSync } from 'node:fs';
import { buildKitUploadFrames } from '@mcp-midi-control/circuit-tracks/samples/sampleTransfer.js';

const CAP = 'samples/circuit-tracks/_cap_out.hex';
const NAME: Record<number, string> = {
  0x01: 'WRITE_INIT', 0x02: 'WRITE_DATA', 0x03: 'WRITE_FIN', 0x07: 'SET_NAME',
  0x08: 'q08', 0x09: 'QUERY_INFO', 0x0b: 'DIR_CTRL', 0x0d: 'enum0d', 0x40: 'OPEN', 0x41: 'CLOSE',
};
const hx = (a: readonly number[]) => a.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const nm = (s: number) => NAME[s] ?? ('0x' + s.toString(16));

// Reassemble capture OUT SysEx.
const bytes: number[] = [];
for (const line of readFileSync(CAP, 'utf8').split('\n')) {
  const h = line.trim();
  for (let i = 0; i + 1 < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
}
const capMsgs: number[][] = []; let cur: number[] | undefined;
for (const b of bytes) { if (b === 0xf0) cur = [0xf0]; else if (cur) { cur.push(b); if (b === 0xf7) { capMsgs.push(cur); cur = undefined; } } }

const sub = (m: number[]) => m[7];

// My frames (the full Components-style attempt: enumerate + 0x05 context).
const dummy = new Uint8Array(9000); dummy.set([0x52, 0x49, 0x46, 0x46]);
const mine = buildKitUploadFrames([{ wav: dummy, slot: 0, filename: '00_01_k1_kick.wav' }], { enumerate: true, dirType: 0x05 }).map((f) => f.bytes);

// Prefix = everything up to the first WRITE_INIT (WAV-independent).
const prefix = (msgs: number[][]) => { const out: number[][] = []; for (const m of msgs) { if (sub(m) === 0x01) break; out.push(m); } return out; };
const capPre = prefix(capMsgs), minePre = prefix(mine);

const tally = (msgs: number[][]) => { const t: Record<number, number> = {}; for (const m of msgs) t[sub(m)] = (t[sub(m)] || 0) + 1; return Object.entries(t).map(([s, c]) => `${nm(+s)}:${c}`).join('  '); };
console.log('CAPTURE prefix:', capPre.length, 'frames —', tally(capPre));
console.log('MINE    prefix:', minePre.length, 'frames —', tally(minePre));

// Show the capture's NON-enum prefix frames (OPEN/DIR/QUERY) in full, and mine.
console.log('\n--- capture prefix control frames (excluding the 0x0d/0x08 enum runs) ---');
for (const m of capPre) if (sub(m) !== 0x0d && sub(m) !== 0x08) console.log(`  ${nm(sub(m)).padEnd(11)} ${hx(m)}`);
console.log('--- mine prefix control frames (excluding 0x0d enum) ---');
for (const m of minePre) if (sub(m) !== 0x0d) console.log(`  ${nm(sub(m)).padEnd(11)} ${hx(m)}`);

// Does the capture send 0x08 (name reads) that we skip?
const cap08 = capPre.filter((m) => sub(m) === 0x08).length;
const mine08 = minePre.filter((m) => sub(m) === 0x08).length;
console.log(`\n0x08 name-read frames — capture: ${cap08}, mine: ${mine08}` + (cap08 !== mine08 ? '   <<< DIFFERENCE' : ''));
