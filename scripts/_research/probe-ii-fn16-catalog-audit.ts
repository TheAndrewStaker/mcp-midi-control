/**
 * Axe-Fx II fn 0x16 GET_PARAM_INFO full catalog audit (READ-ONLY).
 *
 * Sweeps fn 0x16 across every KNOWN_PARAMS entry in the user-facing blocks,
 * decodes the device's own min/max/default (G1/G2/G3 float32, validated against
 * the amp.level -80..20 anchor), and compares to the shipped catalog displayMin/
 * displayMax. Surfaces: DIVERGE (catalog range disagrees with the device, like
 * compressor.level did) and GAP (device has a real range, catalog has none ->
 * authoritative input for the II range gap-fill). Read-only: only fn 0x16 sent.
 */
import midi from "@julusian/midi";
import { writeFileSync } from 'node:fs';
import { KNOWN_PARAMS } from '../../packages/fractal-midi/src/gen2/axe-fx-ii/params.js';
import { IDS_BY_GROUP } from '../../packages/fractal-midi/src/gen2/axe-fx-ii/blockTypes.js';

const MODEL = 0x07, MFR = [0x00, 0x01, 0x74], F0 = 0xf0, F7 = 0xf7;
const cks = (b: number[]) => b.reduce((a, x) => a ^ x, 0) & 0x7f;
const env = (fn: number, p: number[] = []) => { const h = [F0, ...MFR, MODEL, fn, ...p]; return [...h, cks(h), F7]; };
const e14 = (n: number): number[] => [n & 0x7f, (n >> 7) & 0x7f];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const find = (io: midi.Input | midi.Output, ns: string[]) => { for (let i = 0; i < io.getPortCount(); i++) if (ns.some((n) => io.getPortName(i).toLowerCase().includes(n))) return i; return -1; };
const s5 = (p: number[], o: number): number => (p[o] & 0x7f) + (p[o + 1] & 0x7f) * 128 + (p[o + 2] & 0x7f) * 16384 + (p[o + 3] & 0x7f) * 2097152 + (p[o + 4] & 0x7f) * 268435456;
const f32 = (u: number): number => { const b = Buffer.alloc(4); b.writeUInt32LE((u % 4294967296) >>> 0, 0); return b.readFloatLE(0); };
const r3 = (n: number): number => Number(n.toFixed(3));
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.02);

// User-facing blocks (the BK-060 musical surface), one effectId each.
const BLOCKS = ['amp', 'cab', 'reverb', 'delay', 'chorus', 'flanger', 'phaser', 'rotary', 'compressor', 'drive', 'wah', 'pantrem', 'enhancer', 'filter', 'gate', 'pitch', 'multidelay', 'graphiceq', 'parametriceq'];
const GROUP_BY_BLOCK: Record<string, string> = {
  amp: 'AMP', cab: 'CAB', reverb: 'REV', delay: 'DLY', chorus: 'CHO', flanger: 'FLG',
  phaser: 'PHA', rotary: 'ROT', compressor: 'CPR', drive: 'DRV', wah: 'WAH', pantrem: 'TRM',
  enhancer: 'ENH', filter: 'FLT', gate: 'GTE', pitch: 'PIT', multidelay: 'MTD',
  graphiceq: 'GEQ', parametriceq: 'PEQ',
};

async function main(): Promise<void> {
  const out = new midi.Output(), inp = new midi.Input();
  const oi = find(out, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  const ii = find(inp, ['axe-fx ii', 'axefxii', 'xl+', 'axe-fx']);
  if (oi < 0 || ii < 0) { console.error('Axe-Fx II port not found'); process.exit(1); }
  out.openPort(oi); inp.openPort(ii); inp.ignoreTypes(false, true, true);
  const got: number[][] = [];
  inp.on('message', (_d, m) => got.push(m));
  await sleep(150);

  const params = Object.values(KNOWN_PARAMS as Record<string, any>).filter(
    (p) => BLOCKS.includes(p.block) && p.controlType === 'knob' && typeof p.paramId === 'number',
  );
  console.log(`fn 0x16 catalog audit: ${params.length} knob params across ${BLOCKS.length} blocks (read-only, paced ~0.2s)\n`);

  const diverge: string[] = [], gap: string[] = [], agree: string[] = [], noresp: string[] = [];
  let count = 0;
  for (const p of params) {
    const eff = IDS_BY_GROUP[GROUP_BY_BLOCK[p.block]]?.[0];
    if (eff === undefined) continue;
    const before = got.length;
    out.sendMessage(env(0x16, [...e14(eff), ...e14(p.paramId)]));
    await sleep(220);
    if (++count % 50 === 0) process.stderr.write(`  ...${count}/${params.length}\n`);
    const r = got.slice(before).find((f) => f[5] === 0x16 && f.length >= 33);
    const key = `${p.block}.${p.name}`;
    if (!r) { noresp.push(key); continue; }
    const pl = r.slice(6, r.length - 2);
    const dMin = r3(f32(s5(pl, 5))), dMax = r3(f32(s5(pl, 10)));
    if (!Number.isFinite(dMin) || !Number.isFinite(dMax) || dMin >= dMax) { noresp.push(`${key} (bad: ${dMin}..${dMax})`); continue; }
    const cMin = p.displayMin, cMax = p.displayMax;
    if (cMin === undefined || cMax === undefined) {
      gap.push(`${key}: device ${dMin}..${dMax}`);
    } else if (near(cMin, dMin) && near(cMax, dMax)) {
      agree.push(key);
    } else {
      diverge.push(`${key}: catalog ${cMin}..${cMax}  vs  DEVICE ${dMin}..${dMax}`);
    }
  }
  inp.closePort(); out.closePort();

  const report = [
    `# II fn 0x16 catalog audit (2026-06-10)`,
    ``,
    `Swept ${count} knob params. agree=${agree.length} diverge=${diverge.length} gap=${gap.length} no-response=${noresp.length}`,
    ``,
    `## DIVERGE (catalog range disagrees with the device, FIX these)`,
    ...diverge.map((s) => `- ${s}`),
    ``,
    `## GAP (device has a range, catalog has none; authoritative gap-fill source)`,
    ...gap.map((s) => `- ${s}`),
    ``,
    `## no fn 0x16 response (params with explicit displayMin in catalog only):`,
    ...noresp.slice(0, 40).map((s) => `- ${s}`),
  ].join('\n');
  writeFileSync('samples/captured/probe-ii-fn16-catalog-audit.md', report);
  console.log(`\nagree=${agree.length}  DIVERGE=${diverge.length}  GAP=${gap.length}  no-resp=${noresp.length}`);
  console.log(`\n=== DIVERGE (wrong catalog ranges) ===`);
  for (const d of diverge) console.log('  ' + d);
  console.log(`\nfull report: samples/captured/probe-ii-fn16-catalog-audit.md`);
}
main().catch((e) => { console.error(e); process.exit(1); });
