/**
 * Axe-Fx II fn 0x16 GET_PARAM_INFO targeted range check (READ-ONLY).
 *
 * Settles two cache-vs-convention divergences by asking the device for its
 * OWN min/max/default (cookbook ii-fn16-get-param-info: G1/G2/G3 = float32
 * min/max/default, 5-septet LE plain):
 *   - phaser.depth   (Phaser 1 effectId 122, paramId 5): cache says log10 [10..100]
 *   - compressor.level (Compressor 1 effectId 100, paramId 4): cache says -20..20
 * amp.level (Amp 1 effectId 106, paramId 21) is queried as a known-good anchor
 * (suffix rule -80..20). Read-only: only fn 0x16 query frames are sent.
 */
import midi from "@julusian/midi";

const MODEL = 0x07, MFR = [0x00, 0x01, 0x74], F0 = 0xf0, F7 = 0xf7;
const cks = (b: number[]) => b.reduce((a, x) => a ^ x, 0) & 0x7f;
const env = (fn: number, p: number[] = []) => { const h = [F0, ...MFR, MODEL, fn, ...p]; return [...h, cks(h), F7]; };
const e14 = (n: number): number[] => [n & 0x7f, (n >> 7) & 0x7f];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const find = (io: midi.Input | midi.Output, ns: string[]) => { for (let i = 0; i < io.getPortCount(); i++) if (ns.some((n) => io.getPortName(i).toLowerCase().includes(n))) return i; return -1; };
const s5 = (p: number[], o: number): number => (p[o] & 0x7f) + (p[o + 1] & 0x7f) * 128 + (p[o + 2] & 0x7f) * 16384 + (p[o + 3] & 0x7f) * 2097152 + (p[o + 4] & 0x7f) * 268435456;
const f32 = (u: number): number => { const b = Buffer.alloc(4); b.writeUInt32LE((u % 4294967296) >>> 0, 0); return b.readFloatLE(0); };
const r3 = (n: number): number => Number(n.toFixed(3));

const TARGETS = [
  { label: 'amp.level (anchor, expect ~-80..20)', eff: 106, pid: 21 },
  { label: 'phaser.depth (cache log10 [10..100] vs recipe 6)', eff: 122, pid: 5 },
  { label: 'compressor.level (cache -20..20 vs suffix -80..20)', eff: 100, pid: 4 },
];

async function main(): Promise<void> {
  const out = new midi.Output(), inp = new midi.Input();
  const oi = find(out, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  const ii = find(inp, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  if (oi < 0 || ii < 0) { console.error('Axe-Fx II port not found'); process.exit(1); }
  out.openPort(oi); inp.openPort(ii); inp.ignoreTypes(false, true, true);
  const got: number[][] = [];
  inp.on('message', (_d, m) => got.push(m));
  await sleep(150);

  console.log('fn 0x16 GET_PARAM_INFO range check (read-only)\n');
  for (const t of TARGETS) {
    const before = got.length;
    out.sendMessage(env(0x16, [...e14(t.eff), ...e14(t.pid)]));
    await sleep(400);
    const r = got.slice(before).find((f) => f[5] === 0x16 && f.length >= 33);
    if (!r) { console.log(`  ${t.label}: (no response)`); continue; }
    const p = r.slice(6, r.length - 2);
    const min = f32(s5(p, 5)), max = f32(s5(p, 10)), def = f32(s5(p, 15));
    console.log(`  ${t.label}\n     device min=${r3(min)}  max=${r3(max)}  default=${r3(def)}`);
  }
  inp.closePort(); out.closePort();
}
main().catch((e) => { console.error(e); process.exit(1); });
