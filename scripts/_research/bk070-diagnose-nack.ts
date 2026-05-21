/**
 * Diagnose which frame NACKs when pushing a multi-block scene-channel
 * modification.
 */

import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeSwitchPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { parsePresetDump, serializePresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

async function main(): Promise<void> {
  await executeSwitchPreset({ port: 'axe-fx-ii', location: 666, on_active_preset_edited: 'discard' });
  await new Promise(r => setTimeout(r, 250));
  const conn = connectAxeFxII();

  const csum = (b: number[]): number => { let a = 0; for (const x of b) a ^= x; return a & 0x7f; };
  const build = (fn: number, payload: number[]): number[] => { const h = [0xf0, 0x00, 0x01, 0x74, 0x07, fn, ...payload]; return [...h, csum(h), 0xf7]; };

  let frames: number[][] = [];
  const unsub = conn.onMessage(b => { if (b[0] === 0xf0 && b[4] === 0x07 && [0x77,0x78,0x79].includes(b[5])) frames.push([...b]); });
  conn.send(build(0x03, [665 >> 7, 665 & 0x7f]));
  await new Promise(r => setTimeout(r, 3000));
  unsub();
  console.log(`dump frames: ${frames.length}`);

  const flat = new Uint8Array(frames.flat());
  const parsed = parsePresetDump(flat);

  function decodeChunk(p: Uint8Array): Uint16Array { const c = (p[0]&0x7f)|((p[1]&0x7f)<<7); const o = new Uint16Array(c); for (let i=0;i<c;i++) { const off=2+i*3; o[i]=((p[off]&0x7f)|((p[off+1]&0x7f)<<7)|((p[off+2]&0x7f)<<14))&0xffff; } return o; }
  function writeU(p: Uint8Array, idx: number, v: number): void { const off=2+idx*3; p[off]=v&0x7f; p[off+1]=(v>>7)&0x7f; p[off+2]=(p[off+2]&0x7c)|((v>>14)&0x03); }
  function hash(chunks: readonly Uint8Array[]): number { let x=0; for (const c of chunks) for (const u of decodeChunk(c)) x^=u; return x&0xffff; }

  // Modify Drive 1 only (chunk 10 ushort 1) — smallest possible diff.
  const chunks = parsed.chunkPayloads.map((c: Uint8Array) => new Uint8Array(c));
  const oldU = decodeChunk(chunks[10])[1];
  const newU = (oldU & 0x00ff) | 0x5500;  // scenes 1,3,5,7 on Y
  console.log(`Drive 1 chunk 10 ushort 1: 0x${oldU.toString(16).padStart(4,'0')} → 0x${newU.toString(16).padStart(4,'0')}`);
  writeU(chunks[10], 1, newU);

  const newHash = hash(chunks);
  const newFooter = new Uint8Array([
    newHash & 0x7f,
    (newHash >> 7) & 0x7f,
    (parsed.footerPayload[2] & 0x7c) | ((newHash >> 14) & 0x03),
  ]);
  console.log(`new hash: 0x${newHash.toString(16).padStart(4,'0')}`);

  const modified = serializePresetDump({ raw: parsed.raw, headerPayload: parsed.headerPayload, chunkPayloads: chunks, footerPayload: newFooter });

  // Push and capture per-frame ACK/NACK with delay BEFORE next push.
  const responses: number[][] = [];
  const unsub2 = conn.onMessage(b => { if (b[0] === 0xf0) responses.push([...b]); });

  const messages: number[][] = [];
  let i = 0;
  while (i < modified.length) {
    if (modified[i] !== 0xf0) { i++; continue; }
    let j = i + 1;
    while (j < modified.length && modified[j] !== 0xf7) j++;
    messages.push(Array.from(modified.slice(i, j + 1)));
    i = j + 1;
  }
  console.log(`Pushing ${messages.length} frames...`);
  for (let k = 0; k < messages.length; k++) {
    conn.send(messages[k]);
    await new Promise(r => setTimeout(r, 12));
  }
  await new Promise(r => setTimeout(r, 1000));
  unsub2();

  console.log(`Got ${responses.length} response messages`);
  // Display every response
  for (let k = 0; k < Math.min(responses.length, 70); k++) {
    const r = responses[k];
    const fn = r[5];
    const summary = r.slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join(' ');
    if (fn === 0x64) {
      // ACK frame: bytes are F0 00 01 74 07 64 [fn_being_acked] [result_code] ...
      const ackedFn = r[6];
      const result = r[7];
      const ackOk = result === 0x00;
      const mark = ackOk ? '✓' : '❌';
      console.log(`  ${mark} resp ${k}: fn=0x64 ack_for=0x${ackedFn.toString(16)} result=0x${result.toString(16)} | ${summary}`);
    } else {
      console.log(`  ? resp ${k}: fn=0x${fn?.toString(16) ?? '??'} | ${summary}`);
    }
  }
  setTimeout(() => process.exit(0), 200);
}

main().catch(e => { console.error(e); process.exit(1); });
