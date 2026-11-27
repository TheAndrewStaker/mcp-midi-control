/**
 * ii-roster-dump.ts: read one Axe-Fx II select's roster with fn 0x28
 * (SYSEX_GET_PARAM_STRINGS), collecting every reply frame for a window.
 * Read-only.   npx tsx scripts/_research/ii-roster-dump.ts <effectId> <paramId> [ms]
 */
import { connectAxeFxII } from '../../packages/fractal-gen2/src/midi.js';
const [eid, pid, ms] = process.argv.slice(2).map(Number);
const conn = connectAxeFxII();
const frames: number[][] = [];
const off = conn.onMessage((b) => { if (b[0] === 0xf0 && b[5] === 0x28) frames.push(b); });
const e14 = (v: number) => [v & 0x7f, (v >> 7) & 0x7f];
const body = [0xf0, 0x00, 0x01, 0x74, 0x07, 0x28, ...e14(eid), ...e14(pid)];
conn.send([...body, body.reduce((a, b) => a ^ b, 0) & 0x7f, 0xf7]);
await new Promise((r) => setTimeout(r, ms || 3000));
off(); conn.close();
console.log(`${frames.length} frames, lengths ${[...new Set(frames.map((f) => f.length))].join(',')}`);
for (const f of frames.slice(0, 3)) console.log(f.slice(0, 40).map((x) => x.toString(16).padStart(2, '0')).join(' '));
const strs = frames.map((f) => String.fromCharCode(...f.slice(6, -2).map((c) => (c === 0 ? 0x7c : c))));
console.log(JSON.stringify(strs.slice(0, 80)));
