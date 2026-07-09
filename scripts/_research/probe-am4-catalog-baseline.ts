/**
 * AM4 catalog BASELINE sweep (READ-ONLY) — snapshot before firmware V2.01.
 *
 * V2.01 ("now up to date with Axe-Fx III firmware 32.05") changes the amp + chorus
 * models and param counts (new models; "exposed gain controls for the unused channel";
 * new chorus tone controls + expert params). Those shift the per-block fn=0x1F chunk
 * strides (stride = itemCount/4, channel-blocked). Capturing the strides + full
 * channel-A param slice now lets us DIFF after the update: confirms the chunk is
 * model/firmware-dependent and hands us the post-32.05 catalog (≈ III/FM9).
 *
 * Output: samples/captured/decoded/am4-catalog-baseline-pre-v2.01.json
 * Re-run the SAME script after updating; diff the two JSONs.
 *
 * Prereq: AM4 connected, AM4-Edit closed, port free.
 * Run: npx tsx scripts/_research/probe-am4-catalog-baseline.ts [label]
 */
import midi from "@julusian/midi";
import { writeFileSync, mkdirSync } from 'node:fs';

const AM4_MODEL = 0x15;
const POLL_WAIT_MS = 220;
const LABEL = process.argv[2] ?? 'pre-v2.01';

const cks = (b: number[]): number => b.reduce((a, x) => a ^ x, 0) & 0x7f;
const enc14 = (n: number): number[] => [n & 0x7f, (n >> 7) & 0x7f];
const dec14 = (lo: number, hi: number): number => (lo & 0x7f) | ((hi & 0x7f) << 7);
const unpack = (a: number, b: number, c: number): number => (a & 0x7f) | ((b & 0x7f) << 7) | ((c & 0x03) << 14);

function findPort(inst: midi.Input | midi.Output, label: string): number {
  for (let i = 0; i < inst.getPortCount(); i++) if (/AM4|Fractal.*AM4/i.test(inst.getPortName(i))) return i;
  const names = Array.from({ length: inst.getPortCount() }, (_, i) => inst.getPortName(i));
  throw new Error(`No AM4 ${label} port. Available: ${names.join(' | ') || '(none)'}`);
}
function collect(input: midi.Input, ms: number): Promise<number[][]> {
  return new Promise((resolve) => {
    const frames: number[][] = [];
    const h = (_d: number, m: number[]): void => { frames.push([...m]); };
    input.on('message', h);
    setTimeout(() => { input.removeListener('message', h); resolve(frames); }, ms);
  });
}

async function main(): Promise<void> {
  const input = new midi.Input();
  const output = new midi.Output();
  const inPort = findPort(input, 'input');
  const outPort = findPort(output, 'output');
  console.log(`AM4 in: ${input.getPortName(inPort)} | out: ${output.getPortName(outPort)} | label: ${LABEL}`);
  input.ignoreTypes(false, true, true);
  input.openPort(inPort);
  output.openPort(outPort);

  const blocks: Array<{ effectId: number; itemCount: number; valueCount: number; stride: number | null; channelBlocked: boolean; quartersDiffer: boolean | null; channelA: number[] }> = [];
  for (let e = 1; e <= 140; e++) {
    const c = collect(input, POLL_WAIT_MS);
    const head = [0xf0, 0x00, 0x01, 0x74, AM4_MODEL, 0x1f, ...enc14(e)];
    output.sendMessage([...head, cks(head), 0xf7]);
    const frames = await c;
    const ours = frames.filter((b) => b[0] === 0xf0 && b[4] === AM4_MODEL);
    const hd = ours.find((b) => b[5] === 0x74);
    if (hd === undefined) continue;
    const values: number[] = [];
    for (const b of ours) { if (b[5] !== 0x75) continue; for (let i = 8; i + 3 <= b.length - 2; i += 3) values.push(unpack(b[i], b[i + 1], b[i + 2])); }
    if (values.length === 0) continue;
    const itemCount = dec14(hd[8], hd[9]);
    const cb = itemCount % 4 === 0 && values.length >= itemCount;
    const stride = cb ? itemCount / 4 : null;
    let quartersDiffer: boolean | null = null;
    let channelA: number[] = [];
    if (stride !== null) {
      const q = [0, 1, 2, 3].map((ch) => values.slice(ch * stride, ch * stride + stride).join(','));
      quartersDiffer = !q.every((x) => x === q[0]);
      channelA = values.slice(0, stride); // channel-A slice (quarter 0) = the catalog signal
    }
    blocks.push({ effectId: e, itemCount, valueCount: values.length, stride, channelBlocked: cb, quartersDiffer, channelA });
    await new Promise((r) => setTimeout(r, 25));
  }
  input.closePort();
  output.closePort();

  const out = { device: 'AM4', model: 0x15, label: LABEL, capturedAt: new Date().toISOString(), blockCount: blocks.length, blocks };
  mkdirSync('samples/captured/decoded', { recursive: true });
  const path = `samples/captured/decoded/am4-catalog-baseline-${LABEL}.json`;
  writeFileSync(path, JSON.stringify(out, null, 0));

  console.log(`\nBlocks answered: ${blocks.length}  →  ${path}`);
  console.log('effId  itemCount  stride  channelBlocked  quartersDiffer');
  for (const b of blocks) {
    console.log(String(b.effectId).padEnd(6), String(b.itemCount).padEnd(10), String(b.stride ?? '-').padEnd(7), String(b.channelBlocked).padEnd(15), String(b.quartersDiffer ?? '-'));
  }
  console.log('\nRe-run after updating to V2.01 with a new label:');
  console.log('  npx tsx scripts/_research/probe-am4-catalog-baseline.ts post-v2.01');
  console.log('then diff the two JSONs (stride changes = catalog/firmware-dependent chunk confirmed; post = III-32.05 catalog).');
}
main().catch((e) => { console.error('failed:', e); process.exitCode = 1; });
