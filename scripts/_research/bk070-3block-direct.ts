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
  function writeU(p: Uint8Array, idx: number, v: number): void { const off=2+idx*3; p[off]=v&0x7f; p[off+1]=(v>>7)&0x7f; p[off+2]=(v>>14)&0x7f; }
  function hash(chunks: readonly Uint8Array[]): number { let x=0; for (const c of chunks) for (const u of decodeChunk(c)) x^=u; return x&0xffff; }

  // Read baseline values
  const chunks = parsed.chunkPayloads.map((c: Uint8Array) => new Uint8Array(c));
  const ampOld = decodeChunk(chunks[2])[32];
  const driveOld = decodeChunk(chunks[10])[1];
  const delayOld = decodeChunk(chunks[8])[2];
  console.log(`Baseline: Amp=0x${ampOld.toString(16).padStart(4,'0')} Drive=0x${driveOld.toString(16).padStart(4,'0')} Delay=0x${delayOld.toString(16).padStart(4,'0')}`);
  console.log(`Baseline hash (computed): 0x${hash(chunks).toString(16).padStart(4,'0')}`);
  const footerHashFromBytes = ((parsed.footerPayload[0] & 0x7f) | ((parsed.footerPayload[1] & 0x7f) << 7) | ((parsed.footerPayload[2] & 0x7f) << 14)) & 0xffff;
  console.log(`Baseline hash (from footer): 0x${footerHashFromBytes.toString(16).padStart(4,'0')}`);

  // Modify 3 blocks
  const ampNew = (ampOld & 0xff) | 0xaa00;
  const driveNew = (driveOld & 0xff) | 0x5500;
  const delayNew = (delayOld & 0xff) | 0x7800;
  writeU(chunks[2], 32, ampNew);
  writeU(chunks[10], 1, driveNew);
  writeU(chunks[8], 2, delayNew);
  console.log(`Modified: Amp→0x${ampNew.toString(16).padStart(4,'0')} Drive→0x${driveNew.toString(16).padStart(4,'0')} Delay→0x${delayNew.toString(16).padStart(4,'0')}`);

  // Verify reads after write
  const ampCheck = decodeChunk(chunks[2])[32];
  const driveCheck = decodeChunk(chunks[10])[1];
  const delayCheck = decodeChunk(chunks[8])[2];
  console.log(`Re-read: Amp=0x${ampCheck.toString(16).padStart(4,'0')} Drive=0x${driveCheck.toString(16).padStart(4,'0')} Delay=0x${delayCheck.toString(16).padStart(4,'0')}`);

  const newHash = hash(chunks);
  console.log(`New hash: 0x${newHash.toString(16).padStart(4,'0')}`);

  const newFooter = new Uint8Array([
    newHash & 0x7f,
    (newHash >> 7) & 0x7f,
    (parsed.footerPayload[2] & 0x7c) | ((newHash >> 14) & 0x03),
  ]);
  console.log(`New footer bytes: [${Array.from(newFooter).map(b => '0x' + b.toString(16).padStart(2,'0')).join(', ')}]`);
  console.log(`Original footer bytes: [${Array.from(parsed.footerPayload).map((b: number) => '0x' + b.toString(16).padStart(2,'0')).join(', ')}]`);

  const modified = serializePresetDump({ raw: parsed.raw, headerPayload: parsed.headerPayload, chunkPayloads: chunks, footerPayload: newFooter });

  // Parse the SERIALIZED output back and verify hash
  const reparse = parsePresetDump(modified);
  const reparseHash = hash(reparse.chunkPayloads);
  const reparseFooterValue = ((reparse.footerPayload[0] & 0x7f) | ((reparse.footerPayload[1] & 0x7f) << 7) | ((reparse.footerPayload[2] & 0x7f) << 14)) & 0xffff;
  console.log(`Re-parsed serialized hash (computed): 0x${reparseHash.toString(16).padStart(4,'0')}`);
  console.log(`Re-parsed serialized hash (from footer): 0x${reparseFooterValue.toString(16).padStart(4,'0')}`);

  if (reparseHash !== reparseFooterValue) {
    console.log(`❌ Re-parse hash MISMATCH! Serializer didn't preserve hash correctly.`);
  } else if (reparseHash !== newHash) {
    console.log(`❌ Re-parse hash 0x${reparseHash.toString(16)} ≠ what we computed 0x${newHash.toString(16)}`);
  } else {
    console.log(`✓ Re-parsed serialized output verifies. Pushing...`);
  }

  // Push with per-frame ACK tracking
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
  for (let k = 0; k < messages.length; k++) {
    conn.send(messages[k]);
    await new Promise(r => setTimeout(r, 12));
  }
  await new Promise(r => setTimeout(r, 1000));
  unsub2();

  const acks = responses.filter(r => r[5] === 0x64);
  let nackCount = 0;
  for (const r of acks) {
    if (r[7] !== 0x00) {
      nackCount++;
      console.log(`NACK: fn=0x${r[6].toString(16)} result=0x${r[7].toString(16)}`);
    }
  }
  console.log(`Total acks: ${acks.length}, NACKs: ${nackCount}`);

  setTimeout(() => process.exit(0), 200);
}

main().catch(e => { console.error(e); process.exit(1); });
