/**
 * Capture the Axe-Fx II fn 0x18 GET_MODIFIER_INFO reply (PROBE-II-FN18-REPLY), v2.
 *
 * Precondition: a modifier is assigned on Amp 1 Input Drive (LFO 1A).
 *
 * v2 changes after v1 saw no reply:
 *   - Sends fn 0x37 SET_TARGET_BLOCK (AxeEdit SYSEX_EDIT_EFFECT) for Amp 1
 *     FIRST — the opcode table flags 0x37 as required before modifier requests.
 *   - Captures EVERY device->host SysEx frame (model 0x07), not just fn 0x18,
 *     since the reply may carry a different fn byte. Groups by (fn, length) and
 *     flags frames that are not the known 0x18 request shape as reply candidates.
 *
 * Read-only (GET requests only). Run:
 *   npx tsx scripts/_research/probe-axefx2-fn18-reply-capture.ts
 */
import midi from "@julusian/midi";

const II_NEEDLES = ['axe-fx ii', 'axe-fx-ii', 'axefx ii'];
const AMP1 = 106;

function findPort(io: midi.Input | midi.Output): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    const n = io.getPortName(i).toLowerCase();
    if (II_NEEDLES.some((needle) => n.includes(needle)) && !n.includes('mock')) return i;
  }
  return -1;
}
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
function csum(b: number[]): number { let a = 0; for (const x of b) a ^= x; return a & 0x7f; }
function frame(fn: number, payload: number[]): number[] {
  const head = [0xf0, 0x00, 0x01, 0x74, 0x07, fn, ...payload];
  return [...head, csum(head), 0xf7];
}
const enc14 = (n: number): number[] => [n & 0x7f, (n >> 7) & 0x7f];
const setTarget = frame(0x37, enc14(AMP1));                              // SET_TARGET_BLOCK Amp 1
const getModInfo = frame(0x18, [...enc14(AMP1), 0, 0, 0, 0, 0, 0]);       // GET_MODIFIER_INFO Amp 1
function isFn18Request(b: number[]): boolean {
  if (b.length !== 16 || b[5] !== 0x18) return false;
  for (let i = 8; i <= 13; i++) if (b[i] !== 0) return false;
  return true;
}

async function main(): Promise<void> {
  const input = new midi.Input();
  const inIdx = findPort(input);
  if (inIdx < 0) { console.error('Axe-Fx II input not found.'); process.exit(1); }
  input.ignoreTypes(false, true, true);

  const frames = new Map<string, { bytes: number[]; count: number; firstAfterMs: number }>();
  const t0 = Date.now();
  input.on('message', (_dt, msg) => {
    if (msg[0] !== 0xf0 || msg[4] !== 0x07) return; // II SysEx only
    const key = hex(msg);
    const rec = frames.get(key);
    if (rec) rec.count++;
    else frames.set(key, { bytes: [...msg], count: 1, firstAfterMs: Date.now() - t0 });
  });
  input.openPort(inIdx);

  const output = new midi.Output();
  const outIdx = findPort(output);
  if (outIdx < 0) { console.error('Axe-Fx II output not found.'); process.exit(1); }
  output.openPort(outIdx);
  console.log('Sending SET_TARGET_BLOCK(Amp1) + GET_MODIFIER_INFO(Amp1), 2 rounds ...');
  console.log(`  0x37: ${hex(setTarget)}`);
  console.log(`  0x18: ${hex(getModInfo)}`);
  for (let i = 0; i < 2; i++) {
    output.sendMessage(setTarget);
    await new Promise((r) => setTimeout(r, 120));
    output.sendMessage(getModInfo);
    await new Promise((r) => setTimeout(r, 600));
  }
  await new Promise((r) => setTimeout(r, 1500));
  input.closePort(); output.closePort();

  // Report. Sort by fn byte then length.
  const rows = [...frames.values()].sort((a, b) => (a.bytes[5] - b.bytes[5]) || (a.bytes.length - b.bytes.length));
  console.log(`\nDistinct II device->host frames captured: ${rows.length}`);
  const candidates: number[][] = [];
  for (const r of rows) {
    const fn = r.bytes[5];
    const tag = isFn18Request(r.bytes) ? 'fn18-REQUEST(echo/loopback)' :
      (fn === 0x18 ? 'fn18-REPLY?' : `fn 0x${fn.toString(16)}`);
    if (!isFn18Request(r.bytes) && (fn === 0x18 || (r.bytes.length > 20 && fn !== 0x12 && fn !== 0x15 && fn !== 0x10 && fn !== 0x64))) {
      candidates.push(r.bytes);
    }
    const show = r.bytes.length > 48 ? hex(r.bytes.slice(0, 48)) + ` ... (+${r.bytes.length - 48}B)` : hex(r.bytes);
    console.log(`  [${tag}] x${r.count} len=${r.bytes.length} @${r.firstAfterMs}ms: ${show}`);
  }
  if (candidates.length) {
    console.log('\n=== REPLY CANDIDATES (full bytes) ===');
    for (const c of candidates) console.log(hex(c));
  } else {
    console.log('\nNo reply candidate. If AxeEdit is still connected it may be commandeering the');
    console.log('target; try closing AxeEdit and re-running, or nudge its modifier dialog while this listens.');
  }
  process.exit(0);
}
main();
