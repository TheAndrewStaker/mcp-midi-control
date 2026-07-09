/**
 * AM4 channel-blocking confirmation (READ-ONLY).
 *
 * Hypothesis (from the gen-3 transfer): the AM4 fn=0x1F per-block dump is
 * CHANNEL-BLOCKED — it packs four contiguous copies of the block's param slots,
 * one per channel A-D, so `itemCount = (maxPidHigh+1) × 4` and value index
 * `i = channel × stride + pidHigh`. TREMOLO already matched the arithmetic
 * (itemCount 100 = 25×4) but its four quarters were identical in the prior
 * capture, so distinctness is unproven.
 *
 * This probe is READ-ONLY: it polls each block's fn=0x1F dump and, for any whose
 * itemCount is divisible by 4, splits the values into 4 equal quarters and reports
 * whether the quarters DIFFER. A block with differing quarters is a distinct-channel
 * proof — no writes needed (the loaded preset already varies that block per channel).
 * If every placed block's quarters are identical, the run is inconclusive and the
 * controlled-write probe (set a param on A vs B) is the next step.
 *
 * Prereq: AM4 connected, AM4-Edit CLOSED, and no other app holding the port
 * (incl. a running MCP server). Run: npx tsx scripts/_research/probe-am4-channel-blocked.ts
 */
import midi from "@julusian/midi";

const AM4_MODEL = 0x15;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FN_GET_ALL_PARAMS = 0x1f;
const POLL_WAIT_MS = 250;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}
function enc14(n: number): [number, number] {
  return [n & 0x7f, (n >> 7) & 0x7f];
}
function dec14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}
function unpack16(b0: number, b1: number, b2: number): number {
  return (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
}
function buildPoll(effectId: number): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, AM4_MODEL, FN_GET_ALL_PARAMS, ...enc14(effectId)];
  return [...head, fractalChecksum(head), SYSEX_END];
}

function findPort(inst: midi.Input | midi.Output, label: string): number {
  const count = inst.getPortCount();
  for (let i = 0; i < count; i++) if (/AM4|Fractal.*AM4/i.test(inst.getPortName(i))) return i;
  const names = Array.from({ length: count }, (_, i) => inst.getPortName(i));
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

/** Assemble a 0x74/0x75.../0x76 burst → {effectId, itemCount, values}. */
function assemble(frames: number[][]): { effectId: number; itemCount: number; values: number[] } | undefined {
  const ours = frames.filter((b) => b.length >= 7 && b[0] === SYSEX_START
    && b[1] === FRACTAL_MFR[0] && b[2] === FRACTAL_MFR[1] && b[3] === FRACTAL_MFR[2] && b[4] === AM4_MODEL);
  const head = ours.find((b) => b[5] === 0x74);
  if (head === undefined) return undefined;
  const values: number[] = [];
  for (const b of ours) {
    if (b[5] !== 0x75) continue;
    for (let i = 8; i + 3 <= b.length - 2; i += 3) values.push(unpack16(b[i], b[i + 1], b[i + 2]));
  }
  return { effectId: dec14(head[6], head[7]), itemCount: dec14(head[8], head[9]), values };
}

async function main(): Promise<void> {
  const input = new midi.Input();
  const output = new midi.Output();
  const inPort = findPort(input, 'input');
  const outPort = findPort(output, 'output');
  console.log(`AM4 in: ${input.getPortName(inPort)} | out: ${output.getPortName(outPort)}`);
  input.ignoreTypes(false, true, true);
  input.openPort(inPort);
  output.openPort(outPort);

  // Sweep a focused effectId range that covers AM4 block chunk ids. The channel-
  // bearing blocks (amp/drive/reverb/delay) + tremolo are what we care about, but
  // we sweep broadly and report every block that answers a triple.
  const candidates: number[] = [];
  for (let e = 1; e <= 130; e++) candidates.push(e);

  console.log('\neffId  itemCount  /4=stride  div4?  quartersDiffer?  (channel-blocked proof if differ)');
  const hits: Array<{ effectId: number; itemCount: number; differ: boolean }> = [];
  for (const e of candidates) {
    const c = collect(input, POLL_WAIT_MS);
    output.sendMessage(buildPoll(e));
    const burst = assemble(await c);
    if (burst === undefined || burst.values.length === 0) continue;
    const { itemCount, values } = burst;
    const div4 = itemCount % 4 === 0 && values.length >= itemCount;
    let differ = false;
    let detail = '';
    if (div4) {
      const stride = itemCount / 4;
      const q = [0, 1, 2, 3].map((ch) => values.slice(ch * stride, ch * stride + stride).join(','));
      differ = !q.every((x) => x === q[0]);
      if (differ) {
        // find first differing index for a concrete witness
        const qa = values.slice(0, stride);
        for (let p = 0; p < stride; p++) {
          const col = [0, 1, 2, 3].map((ch) => values[ch * stride + p]);
          if (!col.every((v) => v === col[0])) { detail = ` pidHigh ${p}: A/B/C/D = ${col.join('/')}`; break; }
        }
        void qa;
      }
    }
    hits.push({ effectId: e, itemCount, differ });
    console.log(
      String(e).padEnd(6), String(itemCount).padEnd(10), String(div4 ? itemCount / 4 : '?').padEnd(10),
      (div4 ? 'yes' : 'NO').padEnd(6), (div4 ? (differ ? 'DIFFER ✓' : 'identical') : '—').padEnd(16), detail,
    );
    await new Promise((r) => setTimeout(r, 30));
  }

  input.closePort();
  output.closePort();

  const anyDiffer = hits.some((h) => h.differ);
  const allDiv4 = hits.length > 0 && hits.every((h) => h.itemCount % 4 === 0);
  console.log(`\n── Verdict ──`);
  console.log(`Blocks answered: ${hits.length}; all itemCounts divisible by 4: ${allDiv4}`);
  if (anyDiffer) {
    console.log('✅ CHANNEL-BLOCKED CONFIRMED: at least one block has DISTINCT per-channel quarters (read-only proof).');
  } else if (hits.length > 0) {
    console.log('🟡 Inconclusive: every block answered but all quarters identical (channels at same settings).');
    console.log('   Next: load a preset that varies a channel-bearing block per channel, or run the controlled-write probe.');
  } else {
    console.log('❌ No blocks answered — check the AM4 is connected and no other app holds the port.');
  }
}

main().catch((err) => { console.error('Probe failed:', err); process.exitCode = 1; });
