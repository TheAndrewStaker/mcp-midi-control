/**
 * Axe-Fx II fn 0x16 role-calibration sweep (READ-ONLY)
 * ====================================================
 * Sweeps fn 0x16 GET_PARAM_INFO across AMP paramIds 0..24 and decodes
 * the 25-byte payload as 5 groups of 5 plain-LE septets, interpreting
 * G0/G4 as int AND float, G1/G2/G3 as float AND int. Then fn 0x02 GET
 * for a few paramIds to read the live current value (calibrates G0).
 * Goal: pin which group is min/max/default/step/count. Read-only.
 */
import midi from "@julusian/midi";
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

const MODEL = 0x07, MFR = [0x00, 0x01, 0x74], F0 = 0xf0, F7 = 0xf7, AMP = 106;
const cks = (b: number[]) => b.reduce((a, x) => a ^ x, 0) & 0x7f;
const env = (fn: number, p: number[] = []) => { const h = [F0, ...MFR, MODEL, fn, ...p]; return [...h, cks(h), F7]; };
const e14 = (n: number): number[] => [n & 0x7f, (n >> 7) & 0x7f];
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const find = (io: midi.Input | midi.Output, ns: string[]) => { for (let i = 0; i < io.getPortCount(); i++) if (ns.some((n) => io.getPortName(i).toLowerCase().includes(n))) return i; return -1; };
function s5(p: number[], o: number): number { return (p[o] & 0x7f) + (p[o + 1] & 0x7f) * 128 + (p[o + 2] & 0x7f) * 16384 + (p[o + 3] & 0x7f) * 2097152 + (p[o + 4] & 0x7f) * 268435456; }
const f32 = (u: number) => { const b = Buffer.alloc(4); b.writeUInt32LE((u % 4294967296) >>> 0, 0); return b.readFloatLE(0); };
const i32 = (u: number) => { const b = Buffer.alloc(4); b.writeUInt32LE((u % 4294967296) >>> 0, 0); return b.readInt32LE(0); };
const r2 = (n: number) => (Math.abs(n) > 1e6 || (Math.abs(n) < 1e-4 && n !== 0)) ? n.toExponential(2) : Number(n.toFixed(3));

async function main() {
  const out = new midi.Output(), inp = new midi.Input();
  const oi = find(out, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  const ii = find(inp, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  if (oi < 0 || ii < 0) { console.error('Axe-Fx II port not found'); process.exit(1); }
  out.openPort(oi); inp.ignoreTypes(false, true, true);
  const got: number[][] = []; inp.on('message', (_d, b) => { if (b[0] === F0) got.push(b.slice()); }); inp.openPort(ii);
  await sleep(300); out.sendMessage(env(0x08)); await sleep(300); got.length = 0;

  const rows: string[] = ['| pid | G0 int / f32 | G1 min(f32) | G2 (f32/int) | G3 (f32/int) | G4 (f32/int) |', '|---|---|---|---|---|---|'];
  console.log('paramId | G0int | G1f | G2f | G2int | G3f | G3int | G4f | G4int');
  for (let pid = 0; pid <= 24; pid++) {
    const before = got.length; out.sendMessage(env(0x16, [...e14(AMP), ...e14(pid)])); await sleep(350);
    const r = got.slice(before).find((f) => f[5] === 0x16 && f.length >= 33);
    if (!r) { rows.push(`| ${pid} | (none) | | | | |`); continue; }
    const p = r.slice(6, r.length - 2);
    const g = [s5(p, 0), s5(p, 5), s5(p, 10), s5(p, 15), s5(p, 20)];
    console.log(`${pid}\t${i32(g[0])}\t${r2(f32(g[1]))}\t${r2(f32(g[2]))}\t${i32(g[2])}\t${r2(f32(g[3]))}\t${i32(g[3])}\t${r2(f32(g[4]))}\t${i32(g[4])}`);
    rows.push(`| ${pid} | ${i32(g[0])} / ${r2(f32(g[0]))} | ${r2(f32(g[1]))} | ${r2(f32(g[2]))} / ${i32(g[2])} | ${r2(f32(g[3]))} / ${i32(g[3])} | ${r2(f32(g[4]))} / ${i32(g[4])} |`);
  }

  // fn 0x02 GET current values (calibrate G0) for a few params
  console.log('\nfn 0x02 GET (current value):');
  const cur: string[] = ['', '## fn 0x02 GET current values', '', '| pid | response bytes |', '|---|---|'];
  for (const pid of [0, 2, 34]) {
    const before = got.length; out.sendMessage(env(0x02, [...e14(AMP), ...e14(pid)])); await sleep(400);
    const r = got.slice(before).find((f) => f[5] === 0x02);
    console.log(`  pid=${pid}: ${r ? hex(r) : '(no fn 0x02 response)'}`);
    cur.push(`| ${pid} | ${r ? '`' + hex(r) + '`' : '(none)'} |`);
  }

  mkdirSync('samples/captured', { recursive: true });
  writeFileSync(path.resolve('samples/captured/probe-axefx2-fn16-sweep.md'), ['# fn 0x16 sweep (AMP eid 106)', `> ${new Date().toISOString()}`, '', ...rows, ...cur].join('\n'));
  console.log('\nSaved samples/captured/probe-axefx2-fn16-sweep.md');
  inp.closePort(); out.closePort(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
