/**
 * AM4 preset-container goldens (pure-CPU, no captures).
 *
 * The capture-backed sweep lives in `scripts/verify-am4-preset-container.ts`
 * (repo root; gated on samples/ presence): CRC + footer XOR + Huffman
 * termination over the 104-preset fw 1.01 factory bank and the fw 2.00
 * warm-pair captures. This suite covers the arithmetic and the synthetic
 * round-trip so a codec regression fails everywhere, not just on the
 * founder's machine.
 */
import {
  crc16ccitt,
  computeRawPatchCrc,
  computeRawPatchXor,
  huffmanCompress,
  huffmanUncompress,
  encode16to3,
  decode3to16,
  RAW_PATCH_DECOMP_SIZE_OFFSET,
  RAW_PATCH_COMP_SIZE_OFFSET,
  RAW_PATCH_BODY_OFFSET,
  RAW_PATCH_CRC_OFFSET,
} from '../../src/shared/presetContainer.js';
import {
  decodeAm4RawPatch,
  parseAm4PresetDump,
  AM4_RAW_PATCH_SIZE,
  AM4_CONTAINER_CHUNK_COUNT,
  AM4_CHUNK_DISCRIMINATOR,
  AM4_RAW_PATCH_NAME_OFFSET,
  AM4_RAW_PATCH_MAGIC,
  AM4_FW_WORD_2P00,
  AM4_BODY_SCENE_NAME_OFFSET,
  AM4_BODY_SCENE_RECORD_STRIDE,
  AM4_BODY_AMP_GAIN_CHA_OFFSET,
} from '../../src/am4/presetContainer.js';
import { AM4_MODEL_ID } from '../../src/am4/setParam.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function writeU16le(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
}

function writeName32(buf: Uint8Array, off: number, name: string): void {
  const padded = (name + ' '.repeat(32)).slice(0, 31) + '\0';
  for (let i = 0; i < 32; i++) buf[off + i] = padded.charCodeAt(i) & 0xff;
}

// ── CRC / XOR arithmetic vectors ─────────────────────────────────────

function caseCrcVectors(): void {
  // Standard CRC-16/CCITT-FALSE check value.
  const check = crc16ccitt(new TextEncoder().encode('123456789'), 0xffff);
  assert(check === 0x29b1, `crc16ccitt("123456789", 0xFFFF): expected 0x29B1, got 0x${check.toString(16)}`);
  // Device seed: empty input returns the seed itself.
  assert(crc16ccitt(new Uint8Array(0)) === 0xaa55, 'crc16ccitt(empty, 0xAA55) must equal the seed');
  // computeRawPatchCrc zeroes [0x04:0x06] before folding: an image differing
  // only in the stored-CRC field yields the same computed CRC.
  const imgA = new Uint8Array(64);
  const imgB = imgA.slice();
  writeU16le(imgB, RAW_PATCH_CRC_OFFSET, 0x1234);
  assert(
    computeRawPatchCrc(imgA) === computeRawPatchCrc(imgB),
    'computeRawPatchCrc must ignore the stored CRC field',
  );
}

function caseXorVectors(): void {
  const img = new Uint8Array(6);
  writeU16le(img, 0, 0x1234);
  writeU16le(img, 2, 0x5678);
  writeU16le(img, 4, 0x0000);
  assert(
    computeRawPatchXor(img) === 0x444c,
    `XOR of {0x1234, 0x5678, 0} expected 0x444C, got 0x${computeRawPatchXor(img).toString(16)}`,
  );
  assert(computeRawPatchXor(new Uint8Array(0)) === 0, 'XOR of empty image is 0');
}

// ── Huffman + septet round-trips ─────────────────────────────────────

function caseHuffmanRoundTrip(): void {
  const body = new Uint8Array(512);
  for (let i = 0; i < body.length; i++) body[i] = (i * 7 + (i >> 3)) & 0xff;
  const rt = huffmanUncompress(huffmanCompress(body), body.length);
  assert(bytesEqual(rt, body), 'huffmanUncompress(huffmanCompress(x)) !== x');
  // Single-symbol body (synthesized sibling leaf path).
  const single = new Uint8Array(16).fill(0x42);
  const rtSingle = huffmanUncompress(huffmanCompress(single), single.length);
  assert(bytesEqual(rtSingle, single), 'single-symbol Huffman round-trip failed');
}

function caseSeptetRoundTrip(): void {
  const img = new Uint8Array(32);
  for (let i = 0; i < img.length; i++) img[i] = (i * 37) & 0xff;
  const rt = decode3to16(encode16to3(img));
  assert(bytesEqual(rt, img), 'decode3to16(encode16to3(x)) !== x');
  const wire = encode16to3(img);
  assert(wire.every((b) => b < 0x80), 'encode16to3 output not 7-bit-clean');
}

// ── Synthetic full-container round-trip ──────────────────────────────

interface Synthetic {
  frames: Uint8Array;
  rawPatch: Uint8Array;
  body: Uint8Array;
}

function frameAm4(func: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 8);
  out[0] = 0xf0;
  out[1] = 0x00;
  out[2] = 0x01;
  out[3] = 0x74;
  out[4] = AM4_MODEL_ID;
  out[5] = func;
  out.set(payload, 6);
  let acc = 0;
  for (let i = 0; i < out.length - 2; i++) acc ^= out[i];
  out[out.length - 2] = acc & 0x7f;
  out[out.length - 1] = 0xf7;
  return out;
}

/** Build a synthetic-but-shape-true AM4 dump: known body → raw_patch →
 *  16-to-3 pack → 4 framed chunks + header + XOR footer. */
function buildSyntheticDump(): Synthetic {
  // Body: scene names at the pinned offsets + a pinned param value.
  const body = new Uint8Array(0x1500);
  const sceneNames = ['Clean Double', 'Pushed AC', 'Jumped Plexi', 'IIC+ Hot Lead'];
  for (let n = 0; n < 4; n++) {
    writeName32(body, AM4_BODY_SCENE_NAME_OFFSET + n * AM4_BODY_SCENE_RECORD_STRIDE, sceneNames[n]);
  }
  // amp.gain chA = display 5.1 → round(5.1/10*65534) = 0x828E (warm-pair oracle value).
  writeU16le(body, AM4_BODY_AMP_GAIN_CHA_OFFSET, 0x828e);

  const rawPatch = new Uint8Array(AM4_RAW_PATCH_SIZE);
  writeU16le(rawPatch, 0x00, AM4_FW_WORD_2P00);
  writeU16le(rawPatch, 0x02, AM4_RAW_PATCH_MAGIC);
  writeName32(rawPatch, AM4_RAW_PATCH_NAME_OFFSET, 'Synthetic Rig');
  const comp = huffmanCompress(body);
  assert(
    RAW_PATCH_BODY_OFFSET + comp.length <= rawPatch.length,
    'synthetic body compressed larger than the raw_patch — shrink the fixture',
  );
  writeU16le(rawPatch, RAW_PATCH_DECOMP_SIZE_OFFSET, body.length);
  writeU16le(rawPatch, RAW_PATCH_COMP_SIZE_OFFSET, comp.length);
  rawPatch.set(comp, RAW_PATCH_BODY_OFFSET);
  writeU16le(rawPatch, RAW_PATCH_CRC_OFFSET, computeRawPatchCrc(rawPatch));

  const packed = encode16to3(rawPatch); // 8192 B → 12,288 B
  const frames: Uint8Array[] = [];
  frames.push(frameAm4(0x77, new Uint8Array([0x7f, 0x7f, 0x00, 0x00, 0x00])));
  const perChunk = packed.length / AM4_CONTAINER_CHUNK_COUNT; // 3072
  for (let i = 0; i < AM4_CONTAINER_CHUNK_COUNT; i++) {
    const payload = new Uint8Array(2 + perChunk);
    payload[0] = AM4_CHUNK_DISCRIMINATOR[0];
    payload[1] = AM4_CHUNK_DISCRIMINATOR[1];
    payload.set(packed.subarray(i * perChunk, (i + 1) * perChunk), 2);
    frames.push(frameAm4(0x78, payload));
  }
  const xor = computeRawPatchXor(rawPatch);
  frames.push(
    frameAm4(0x79, new Uint8Array([xor & 0x7f, (xor >> 7) & 0x7f, (xor >> 14) & 0x03])),
  );
  const total = frames.reduce((a, f) => a + f.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of frames) { out.set(f, off); off += f.length; }
  return { frames: out, rawPatch, body };
}

function caseSyntheticContainerRoundTrip(): void {
  const syn = buildSyntheticDump();
  assert(syn.frames.length === 12_352, `synthetic dump must be 12,352 B, got ${syn.frames.length}`);

  const parsed = parseAm4PresetDump(syn.frames);
  assert(parsed.chunkPayloads.length === AM4_CONTAINER_CHUNK_COUNT, 'chunk count != 4');
  assert(parsed.byteLength === 12_352, 'parse byteLength != 12,352');

  const d = decodeAm4RawPatch(syn.frames);
  assert(bytesEqual(d.rawPatch, syn.rawPatch), 'decoded raw_patch differs from the source image');
  assert(bytesEqual(d.decompressedBody, syn.body), 'decoded body differs from the source body');
  assert(d.crcValid, 'CRC must validate on the synthetic image');
  assert(d.footerXorValid, 'footer XOR must validate on the synthetic image');
  assert(d.magicValid, 'word[1] must be 0xAA55');
  assert(d.huffmanComplete, 'Huffman stream must terminate at decompSize');
  assert(d.name === 'Synthetic Rig', `name: expected "Synthetic Rig", got "${d.name}"`);
  assert(d.fwWord === AM4_FW_WORD_2P00, 'fwWord mismatch');
  assert(d.decompSize === syn.body.length && d.compSize > 0, 'size header mismatch');
  assert(
    d.sceneNames.join('|') === 'Clean Double|Pushed AC|Jumped Plexi|IIC+ Hot Lead',
    `scene names: got ${JSON.stringify(d.sceneNames)}`,
  );
  const gain = (d.decompressedBody[AM4_BODY_AMP_GAIN_CHA_OFFSET] |
    (d.decompressedBody[AM4_BODY_AMP_GAIN_CHA_OFFSET + 1] << 8)) & 0xffff;
  assert(gain === 0x828e, `amp.gain chA: expected 0x828E, got 0x${gain.toString(16)}`);
}

function caseCorruptionDetection(): void {
  const syn = buildSyntheticDump();
  // Flip one packed body byte inside chunk 1 (frame 2), re-fix its frame
  // checksum, and confirm the container CRC catches it.
  const bytes = syn.frames.slice();
  const chunk1Start = 13; // after the header frame
  const target = chunk1Start + 6 + 2 + 100; // payload byte inside the packed body
  bytes[target] = (bytes[target] ^ 0x01) & 0x7f;
  const csIndex = chunk1Start + 3082 - 2;
  let acc = 0;
  for (let i = chunk1Start; i < csIndex; i++) acc ^= bytes[i];
  bytes[csIndex] = acc & 0x7f;
  const d = decodeAm4RawPatch(bytes);
  assert(!d.crcValid, 'a corrupted packed byte must invalidate the raw_patch CRC');

  // Truncated / non-dump input must throw at the framing layer.
  let threw = false;
  try {
    parseAm4PresetDump(syn.frames.subarray(0, 100));
  } catch {
    threw = true;
  }
  assert(threw, 'truncated dump must throw');
}

const cases: Array<{ label: string; run: () => void }> = [
  { label: 'crc vectors', run: caseCrcVectors },
  { label: 'xor vectors', run: caseXorVectors },
  { label: 'huffman round-trip', run: caseHuffmanRoundTrip },
  { label: 'septet 16<->3 round-trip', run: caseSeptetRoundTrip },
  { label: 'synthetic container round-trip', run: caseSyntheticContainerRoundTrip },
  { label: 'corruption detection', run: caseCorruptionDetection },
];

export const AM4_PRESET_CONTAINER_CASE_COUNT = cases.length;

export function runAm4PresetContainerTests(): void {
  for (const c of cases) {
    try {
      c.run();
    } catch (err) {
      throw new Error(`am4/presetContainer case "${c.label}": ${(err as Error).message}`);
    }
  }
}
