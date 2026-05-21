import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeSwitchPreset, executeSavePreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { executeSetParam } from '@mcp-midi-control/core/protocol-generic/dispatcher/params.js';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { parsePresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

async function main(): Promise<void> {
  await executeSwitchPreset({ port: 'axe-fx-ii', location: 666, on_active_preset_edited: 'discard' });
  await new Promise(r => setTimeout(r, 250));
  const conn = connectAxeFxII();

  const csum = (b: number[]): number => { let a = 0; for (const x of b) a ^= x; return a & 0x7f; };
  const build = (fn: number, p: number[]): number[] => { const h = [0xf0, 0x00, 0x01, 0x74, 0x07, fn, ...p]; return [...h, csum(h), 0xf7]; };
  function decodeChunk(p: Uint8Array): Uint16Array { const c = (p[0]&0x7f)|((p[1]&0x7f)<<7); const o = new Uint16Array(c); for (let i=0;i<c;i++) { const off=2+i*3; o[i]=((p[off]&0x7f)|((p[off+1]&0x7f)<<7)|((p[off+2]&0x7f)<<14))&0xffff; } return o; }

  async function dump(): Promise<Uint8Array> {
    const frames: number[][] = [];
    const unsub = conn.onMessage(b => { if (b[0]===0xf0 && b[4]===0x07 && [0x77,0x78,0x79].includes(b[5])) frames.push([...b]); });
    conn.send(build(0x03, [665 >> 7, 665 & 0x7f]));
    await new Promise(r => setTimeout(r, 3000));
    unsub();
    return new Uint8Array(frames.flat());
  }

  // Try a sequence of cab params one at a time via dispatcher
  const tests: Array<{ name: string; value: number | string }> = [
    { name: 'level_l', value: -25 },
    { name: 'level_r', value: -15 },
    { name: 'level', value: -10 },
    { name: 'pan_l', value: 50 },
    { name: 'pan_r', value: -50 },
  ];

  for (const t of tests) {
    const b0 = await dump();
    console.log(`\nSet cab.${t.name} = ${t.value}`);
    try {
      const r = await executeSetParam({ port: 'axe-fx-ii', block: 'cab', name: t.name, value: t.value });
      console.log('  dispatcher response:', JSON.stringify(r).slice(0, 120));
    } catch (e) {
      console.log('  ERROR:', e instanceof Error ? e.message : e);
      continue;
    }
    await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
    await new Promise(r => setTimeout(r, 300));
    const b1 = await dump();

    const p0 = parsePresetDump(b0); const p1 = parsePresetDump(b1);
    let diffs = 0;
    for (let c = 0; c < 64; c++) {
      const a = decodeChunk(p0.chunkPayloads[c]); const b = decodeChunk(p1.chunkPayloads[c]);
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          console.log(`  chunk ${c} ushort ${i}: 0x${a[i].toString(16)} → 0x${b[i].toString(16)}`);
          diffs++;
        }
      }
    }
    if (diffs === 0) console.log('  no diff');
  }

  setTimeout(()=>process.exit(0), 200);
}

main().catch(e => { console.error(e); process.exit(1); });
