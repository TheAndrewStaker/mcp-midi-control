/**
 * Quick probe: is compressor.effect_type block-global or per-channel?
 *
 * Writes PEDAL COMP 1 via fn=0x02 on channel X context, then reads
 * both X and Y. If both show PEDAL COMP 1, it's block-global and
 * fn=0x02 is safe for all channel contexts.
 *
 * Run: npx tsx scripts/_research/probe-comp-effect-type-global.ts
 */
import midi from "@julusian/midi";

const MODEL = 0x07;
const MFR = [0x00, 0x01, 0x74] as const;
const COMP = 100;
const CET = 12;

function cksum(b: number[]) { return b.reduce((a, c) => a ^ c, 0) & 0x7f; }
function env(fn: number, payload: number[] = []) {
  const h = [0xf0, ...MFR, MODEL, fn, ...payload];
  return [...h, cksum(h), 0xf7];
}
function e14(n: number): [number, number] { return [n & 0x7f, (n >> 7) & 0x7f]; }
function d16(a: number, b: number, c: number) { return (a & 0x7f) | ((b & 0x7f) << 7) | ((c & 0x03) << 14); }
function pv16(v: number): [number, number, number] { return [v & 0x7f, (v >> 7) & 0x7f, (v >> 14) & 0x03]; }
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

const msgs: number[][] = [];

async function getParam(output: midi.Output, eid: number, pid: number) {
  const before = msgs.length;
  output.sendMessage(env(0x02, [...e14(eid), ...e14(pid), 0, 0, 0, 0x00]));
  const dl = Date.now() + 3000;
  while (Date.now() < dl) {
    await sleep(30);
    for (let i = before; i < msgs.length; i++) {
      const b = msgs[i];
      if (b.length >= 17 && b[5] === 0x02) {
        const e = (b[6] & 0x7f) | ((b[7] & 0x7f) << 7);
        const p = (b[8] & 0x7f) | ((b[9] & 0x7f) << 7);
        if (e === eid && p === pid) {
          const w = d16(b[10], b[11], b[12]);
          const lb: number[] = [];
          for (let j = 18; j < b.length - 2 && b[j] !== 0; j++) lb.push(b[j]);
          return { wire: w, label: String.fromCharCode(...lb) };
        }
      }
    }
  }
  return null;
}

function switchCh(output: midi.Output, eid: number, ch: 0 | 1) {
  output.sendMessage(env(0x11, [...e14(eid), ch]));
}
function setFn02(output: midi.Output, eid: number, pid: number, val: number) {
  output.sendMessage(env(0x02, [...e14(eid), ...e14(pid), ...pv16(val), 0x01]));
}

async function main() {
  const input = new midi.Input();
  const output = new midi.Output();
  let outIdx = -1, inIdx = -1;
  for (let i = 0; i < output.getPortCount(); i++) if (output.getPortName(i).includes('AXE-FX II')) outIdx = i;
  for (let i = 0; i < input.getPortCount(); i++) if (input.getPortName(i).includes('AXE-FX II')) inIdx = i;
  if (outIdx < 0 || inIdx < 0) { console.error('Axe-Fx II not found'); process.exit(1); }

  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);
  input.on('message', (_, b) => { if (b[0] === 0xf0) msgs.push(b.slice()); });
  input.openPort(inIdx);
  await sleep(500);

  try {
    console.log('=== Compressor effect_type: block-global or per-channel? ===\n');

    switchCh(output, COMP, 0); await sleep(200);
    const origX = await getParam(output, COMP, CET);
    switchCh(output, COMP, 1); await sleep(200);
    const origY = await getParam(output, COMP, CET);
    console.log('Original X:', origX?.wire, origX?.label);
    console.log('Original Y:', origY?.wire, origY?.label);

    // Write PEDAL COMP 1 (wire=1) via fn=0x02 on channel X
    switchCh(output, COMP, 0); await sleep(200);
    setFn02(output, COMP, CET, 1);
    await sleep(500);

    // Read both channels
    switchCh(output, COMP, 0); await sleep(200);
    const afterX = await getParam(output, COMP, CET);
    switchCh(output, COMP, 1); await sleep(200);
    const afterY = await getParam(output, COMP, CET);
    console.log('\nAfter fn=0x02 write of PEDAL COMP 1:');
    console.log('X:', afterX?.wire, afterX?.label);
    console.log('Y:', afterY?.wire, afterY?.label);

    if (afterX?.wire === afterY?.wire && afterX?.wire === 1) {
      console.log('\nFINDING: BLOCK-GLOBAL. fn=0x02 wrote to both channels. No X/Y issue.');
    } else if (afterX?.wire === 1 && afterY?.wire !== 1) {
      console.log('\nFINDING: PER-CHANNEL. fn=0x02 only wrote to X. Y retained original value.');
      console.log('Testing fn=0x02 write on Y channel...');
      switchCh(output, COMP, 1); await sleep(200);
      setFn02(output, COMP, CET, 2); // PEDAL COMP 2
      await sleep(500);
      switchCh(output, COMP, 1); await sleep(200);
      const afterY2 = await getParam(output, COMP, CET);
      switchCh(output, COMP, 0); await sleep(200);
      const afterX2 = await getParam(output, COMP, CET);
      console.log(`After fn=0x02 write of PEDAL COMP 2 on Y:`);
      console.log(`X: ${afterX2?.wire} ${afterX2?.label}`);
      console.log(`Y: ${afterY2?.wire} ${afterY2?.label}`);
      if (afterY2?.wire === 2 && afterX2?.wire === 1) {
        console.log('\nCONFIRMED: fn=0x02 IS channel-aware for writes. Both X and Y independently addressable.');
      } else {
        console.log(`\nUNEXPECTED: X=${afterX2?.wire} Y=${afterY2?.wire}`);
      }
    } else {
      console.log(`\nFINDING: UNEXPECTED. X=${afterX?.wire} Y=${afterY?.wire}`);
    }

    // Restore
    switchCh(output, COMP, 0); await sleep(100);
    setFn02(output, COMP, CET, origX?.wire ?? 0);
    await sleep(200);
    switchCh(output, COMP, 1); await sleep(100);
    setFn02(output, COMP, CET, origY?.wire ?? 0);
    await sleep(200);
  } finally {
    input.closePort();
    output.closePort();
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
