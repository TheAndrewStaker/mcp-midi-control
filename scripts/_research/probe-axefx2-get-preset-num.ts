/**
 * Probe: ask the Axe-Fx II what preset is currently loaded via fn 0x14
 * GET_PRESET_NUMBER. Confirms whether the dump path is reading from
 * the same "current preset" that the device's front-panel UI shows.
 */

import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74];
const II_MODEL = 0x07;
const FUNC_GET_PRESET_NUM = 0x14;

function fractalChecksum(bytes: number[]): number {
  let acc = 0;
  for (const b of bytes) acc ^= b;
  return acc & 0x7f;
}

async function main(): Promise<void> {
  const head = [SYSEX_START, ...FRACTAL_MFR, II_MODEL, FUNC_GET_PRESET_NUM];
  const request = [...head, fractalChecksum(head), SYSEX_END];

  const conn = connectAxeFxII();
  const responses: number[][] = [];
  const unsubscribe = conn.onMessage((bytes) => {
    if (bytes[0] === SYSEX_START) responses.push([...bytes]);
  });
  conn.send(request);
  await new Promise((r) => setTimeout(r, 1000));
  unsubscribe();

  console.log('fn 0x14 GET_PRESET_NUMBER:');
  console.log('  request:', request.map((b) => b.toString(16).padStart(2, '0')).join(' '));
  console.log(`  got ${responses.length} responses:`);
  for (const r of responses) {
    console.log('  ', r.map((b) => b.toString(16).padStart(2, '0')).join(' '));
    if (r[5] === 0x14) {
      // Decode: payload likely [preset_lo, preset_hi] (septet 14-bit)
      const lo = r[6];
      const hi = r[7];
      const presetNum = lo | (hi << 7);
      console.log(`     decoded preset number: ${presetNum} (lo=${lo} hi=${hi})`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
