/**
 * Probe valid preset-index range on the user's Axe-Fx II XL+.
 * Tests fn 0x03 [preset_lo, preset_hi] requests at 0, 100, 200, 256,
 * 383, 384, 500, 666, 767. Reports which return a 0x77/0x78/0x79 dump
 * and which error.
 */

import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74];
const II_MODEL = 0x07;

function fractalChecksum(bytes: number[]): number {
  let acc = 0;
  for (const b of bytes) acc ^= b;
  return acc & 0x7f;
}

function septet14(value: number): [number, number] {
  return [value & 0x7f, (value >> 7) & 0x7f];
}

async function probe(conn: ReturnType<typeof connectAxeFxII>, location: number): Promise<void> {
  const [lo, hi] = septet14(location);
  const head = [SYSEX_START, ...FRACTAL_MFR, II_MODEL, 0x03, lo, hi];
  const request = [...head, fractalChecksum(head), SYSEX_END];

  const msgs: number[][] = [];
  const unsubscribe = conn.onMessage((b) => {
    if (b[0] === SYSEX_START) msgs.push([...b]);
  });
  conn.send(request);
  await new Promise((r) => setTimeout(r, 2500));
  unsubscribe();

  const headers = msgs.filter((m) => m[5] === 0x77).length;
  const chunks = msgs.filter((m) => m[5] === 0x78).length;
  const footers = msgs.filter((m) => m[5] === 0x79).length;
  const others = msgs.filter((m) => m[5] !== 0x77 && m[5] !== 0x78 && m[5] !== 0x79);

  if (headers === 1 && chunks === 64 && footers === 1) {
    const chunk0 = msgs.find((m) => m[5] === 0x78)!;
    let name = '';
    for (let i = 8; i < 8 + 32 * 3; i += 3) {
      const ch = chunk0[6 + i];
      if (ch === 0) break;
      name += String.fromCharCode(ch);
    }
    console.log(`  preset ${location.toString().padStart(4)} (${lo.toString(16).padStart(2, '0')} ${hi.toString(16).padStart(2, '0')}): SUCCESS — "${name.trim()}"`);
  } else if (msgs.length === 0) {
    console.log(`  preset ${location.toString().padStart(4)} (${lo.toString(16).padStart(2, '0')} ${hi.toString(16).padStart(2, '0')}): NO RESPONSE`);
  } else {
    const otherFns = others.map((m) => `0x${m[5].toString(16)}(${m.length}B)`).join(' ');
    console.log(`  preset ${location.toString().padStart(4)} (${lo.toString(16).padStart(2, '0')} ${hi.toString(16).padStart(2, '0')}): ${headers}/${chunks}/${footers} dump frames + others: ${otherFns}`);
  }
}

async function main(): Promise<void> {
  const conn = connectAxeFxII();
  console.log('Probing preset locations (fn 0x03 [lo, hi]):');
  for (const loc of [0, 1, 2, 100, 128, 200, 255, 256, 257, 383, 384, 500, 666, 700, 767, 768]) {
    await probe(conn, loc);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
