/**
 * Fractal preset-CONTAINER codec: 3-to-16 septet pack/unpack, the dynamic
 * Huffman compressor/decompressor, and the CRC-16/CCITT the device validates.
 * This is the layer inside the 0x77/0x78/0x79 preset-dump envelope that turns
 * the packed chunk bodies into the flat `raw_patch` image — the step that makes
 * whole-preset READ (and, with the encoder, authoring) possible.
 *
 * SHARED across codec generations, not gen-3-specific. Confirmed users:
 *
 *   - gen-3 (Axe-Fx III 0x10 / FM3 0x11 / FM9 0x12 / VP4 0x14): 16-chunk
 *     (III, 16,384 B raw_patch) and 8-chunk (FM3/FM9) dumps. Validated over
 *     all 384 III factory presets + FM9 exports (`scripts/verify-gen3-*.ts`).
 *   - AM4 (0x15): the SAME container verbatim at 4 chunks (8,192 B
 *     raw_patch). Validated over all 104 fw 1.01 factory presets + 14 fw 2.00
 *     hardware exports (CRC, footer XOR, Huffman termination, plaintext name
 *     all hold — 2026-07-02 decode, see primitive `am4-gen3-preset-container`
 *     and `src/am4/presetContainer.ts`).
 *
 * Originally lived in `@mcp-midi-control/fractal-gen3/presetHuffman.ts`;
 * hoisted here 2026-07-02 when the AM4 dump was found to be the same
 * container (codec logic belongs in the codec package). The gen-3 module
 * re-exports everything from here, so gen-3 wire behavior is unchanged.
 *
 * Clean-room reimplementation from the published format spec (the FORMAT.md of
 * Andrew Mercurio's Apache-2.0 `fractal-syx-codec`); not a line-port of the
 * reference Python. See the repo Credits.
 *
 * raw_patch layout (chunkCount × 1024 words × 2 bytes; little-endian):
 *   0x00 u16  firmware/format version word (AM4: 0x0107 fw 1.01 / 0x0109 fw 2.00)
 *   0x02 u16  0xAA55 magic
 *   0x04 u16  CRC-16/CCITT (poly 0x1021, MSB-first, init 0xAA55) over the whole
 *             raw_patch with bytes [0x04:0x06] treated as zero
 *   0x08      32-byte ASCII preset name
 *   0x48 u16  decompressed body size
 *   0x4A u16  compressed body size
 *   0x4C ...  Huffman bitstream (dynamic code tree serialized as a prefix),
 *             zero-filled to the end of the raw_patch
 */

export const RAW_PATCH_CRC_OFFSET = 0x04;
export const RAW_PATCH_DECOMP_SIZE_OFFSET = 0x48;
export const RAW_PATCH_COMP_SIZE_OFFSET = 0x4a;
export const RAW_PATCH_BODY_OFFSET = 0x4c;
export const CRC_INIT = 0xaa55;

/** Unpack a 3-bytes-per-uint16 septet stream into the little-endian raw byte
 *  image: each 3 wire bytes -> one 16-bit word (b0 | b1<<7 | b2<<14) -> 2 LE
 *  bytes. Inverse of the device's 16-to-3 packing. */
export function decode3to16(payload: Uint8Array): Uint8Array {
  const words = Math.floor(payload.length / 3);
  const out = new Uint8Array(words * 2);
  for (let i = 0; i < words; i++) {
    const o = i * 3;
    const v = (payload[o] | (payload[o + 1] << 7) | (payload[o + 2] << 14)) & 0xffff;
    out[i * 2] = v & 0xff;
    out[i * 2 + 1] = (v >> 8) & 0xff;
  }
  return out;
}

interface HuffNode {
  value: number; // >= 0 for a leaf symbol; -1 for an internal node
  left?: HuffNode;
  right?: HuffNode;
}

class BitReader {
  private pos = 0;
  private bit = 0;
  constructor(private readonly data: Uint8Array) {}
  readBit(): number {
    const b = this.data[this.pos] ?? 0;
    const out = (b >> (7 - this.bit)) & 1;
    this.bit += 1;
    if (this.bit === 8) { this.bit = 0; this.pos += 1; }
    return out;
  }
  readByteValue(): number {
    let v = 0;
    for (let i = 0; i < 8; i++) v = (v << 1) | this.readBit();
    return v;
  }
  get exhausted(): boolean { return this.pos >= this.data.length; }
}

/** Tree serialization: bit 1 = leaf followed by an 8-bit symbol; bit 0 = an
 *  internal node followed by its left subtree then its right subtree. */
function buildTree(r: BitReader): HuffNode {
  if (r.readBit() === 1) return { value: r.readByteValue() };
  const left = buildTree(r);
  const right = buildTree(r);
  return { value: -1, left, right };
}

/** Decompress the dynamic-Huffman body into exactly `outputSize` bytes (the
 *  decomp size from the header). Bits are read MSB-first; at each step a 1 walks
 *  right, a 0 walks left, to a leaf symbol. */
export function huffmanUncompress(data: Uint8Array, outputSize: number): Uint8Array {
  const r = new BitReader(data);
  const root = buildTree(r);
  const out = new Uint8Array(outputSize);
  let i = 0;
  for (; i < outputSize; i++) {
    if (r.exhausted) break;
    let node = root;
    while (node.value < 0) node = (r.readBit() ? node.right : node.left) as HuffNode;
    out[i] = node.value & 0xff;
  }
  return r.exhausted ? out.subarray(0, i) : out;
}

/** CRC-16/CCITT (poly 0x1021, MSB-first) with the device's `init` seed. */
export function crc16ccitt(data: Uint8Array, init = CRC_INIT): number {
  let crc = init & 0xffff;
  for (const byte of data) {
    crc ^= (byte << 8) & 0xffff;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** Compute the CRC the device validates: over the whole raw_patch with the
 *  stored CRC field [0x04:0x06] treated as zero. */
export function computeRawPatchCrc(rawPatch: Uint8Array): number {
  const tmp = rawPatch.slice();
  tmp[RAW_PATCH_CRC_OFFSET] = 0;
  tmp[RAW_PATCH_CRC_OFFSET + 1] = 0;
  return crc16ccitt(tmp, CRC_INIT);
}

function u16le(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8)) & 0xffff;
}

/**
 * The 16-bit value the device stores in the `fn=0x79` preset-dump footer: the
 * XOR of every little-endian uint16 word of the raw_patch (FORMAT.md §1). The
 * footer carries it 3-to-16 septet-packed as a 3-byte payload. Confirmed
 * byte-exact against the III factory banks (BANK_A[0] = 0x7f91), an FM9
 * export (0xfff5) — see scripts/verify-gen3-authoring.ts — and all 104 AM4
 * factory presets + 14 AM4 hardware exports
 * (scripts/verify-am4-preset-container.ts). An authoring edit changes the
 * patch words, so this must be recomputed when re-framing a dump.
 */
export function computeRawPatchXor(rawPatch: Uint8Array): number {
  let xor = 0;
  for (let i = 0; i + 1 < rawPatch.length; i += 2) {
    xor ^= rawPatch[i] | (rawPatch[i + 1] << 8);
  }
  return xor & 0xffff;
}

export interface DecodedRawPatch {
  rawPatch: Uint8Array;
  storedCrc: number;
  computedCrc: number;
  crcValid: boolean;
  decompSize: number;
  compSize: number;
  /** The decompressed patch body (decompSize bytes). */
  body: Uint8Array;
}

/** Concatenate a parsed dump's chunk payloads, unpack to the raw_patch, verify
 *  the CRC, and Huffman-decompress the body. The caller passes the
 *  `chunkPayloads` from its device's dump parser (each payload = 2-byte chunk
 *  discriminator + 3072 packed bytes). */
export function decodeRawPatch(chunkPayloads: readonly Uint8Array[]): DecodedRawPatch {
  let total = 0;
  for (const c of chunkPayloads) total += c.length - 2; // strip the 2-byte chunk discriminator
  const packed = new Uint8Array(total);
  let off = 0;
  for (const c of chunkPayloads) { packed.set(c.subarray(2), off); off += c.length - 2; }
  const rawPatch = decode3to16(packed);

  const storedCrc = u16le(rawPatch, RAW_PATCH_CRC_OFFSET);
  const computedCrc = computeRawPatchCrc(rawPatch);
  const decompSize = u16le(rawPatch, RAW_PATCH_DECOMP_SIZE_OFFSET);
  const compSize = u16le(rawPatch, RAW_PATCH_COMP_SIZE_OFFSET);
  const compData = rawPatch.subarray(RAW_PATCH_BODY_OFFSET, RAW_PATCH_BODY_OFFSET + compSize);
  const body = huffmanUncompress(compData, decompSize);

  return { rawPatch, storedCrc, computedCrc, crcValid: storedCrc === computedCrc, decompSize, compSize, body };
}

// ── Encode side (authoring / write-back) ───────────────────────────

/** Pack a little-endian raw byte image back to the 3-bytes-per-uint16 wire
 *  stream. Inverse of decode3to16. */
export function encode16to3(rawPatch: Uint8Array): Uint8Array {
  const words = Math.floor(rawPatch.length / 2);
  const out = new Uint8Array(words * 3);
  for (let i = 0; i < words; i++) {
    const v = (rawPatch[i * 2] | (rawPatch[i * 2 + 1] << 8)) & 0xffff;
    out[i * 3] = v & 0x7f;
    out[i * 3 + 1] = (v >> 7) & 0x7f;
    out[i * 3 + 2] = (v >> 14) & 0x7f;
  }
  return out;
}

class BitWriter {
  private readonly bytes: number[] = [];
  private cur = 0;
  private nbits = 0;
  writeBit(bit: number): void {
    this.cur = ((this.cur << 1) | (bit & 1)) & 0xff;
    if (++this.nbits === 8) { this.bytes.push(this.cur); this.cur = 0; this.nbits = 0; }
  }
  writeByteValue(v: number): void { for (let i = 7; i >= 0; i--) this.writeBit((v >> i) & 1); }
  flush(): Uint8Array {
    if (this.nbits > 0) this.bytes.push((this.cur << (8 - this.nbits)) & 0xff);
    return Uint8Array.from(this.bytes);
  }
}

function serializeTree(node: HuffNode, w: BitWriter): void {
  if (node.value >= 0) { w.writeBit(1); w.writeByteValue(node.value); }
  else { w.writeBit(0); serializeTree(node.left as HuffNode, w); serializeTree(node.right as HuffNode, w); }
}

function buildCodebook(node: HuffNode, prefix: number[], table: Map<number, number[]>): void {
  if (node.value >= 0) { table.set(node.value, prefix.length ? [...prefix] : [0]); return; }
  buildCodebook(node.left as HuffNode, [...prefix, 0], table);
  buildCodebook(node.right as HuffNode, [...prefix, 1], table);
}

/**
 * Compress with the same dynamic-Huffman shape the device reads back: build a
 * frequency tree, serialize it as the bitstream prefix, then emit each byte's
 * code. The exact tree need not match the device's original (the device
 * validates the recomputed CRC over the whole patch, not the compressed bytes),
 * only that our own `huffmanUncompress` recovers the input — which the
 * round-trip golden enforces. The single-symbol case synthesizes a sibling leaf
 * so the tree always has an internal root.
 */
export function huffmanCompress(data: Uint8Array): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
  const freq = new Map<number, number>();
  for (const b of data) freq.set(b, (freq.get(b) ?? 0) + 1);
  let order = 0;
  const pool: Array<{ node: HuffNode; count: number; order: number }> =
    [...freq.entries()].map(([sym, count]) => ({ node: { value: sym }, count, order: order++ }));
  let root: HuffNode;
  if (pool.length === 1) {
    const only = pool[0].node;
    root = { value: -1, left: only, right: { value: (only.value + 1) & 0xff } };
  } else {
    while (pool.length > 1) {
      pool.sort((a, b) => a.count - b.count || a.order - b.order);
      const n1 = pool.shift() as { node: HuffNode; count: number; order: number };
      const n2 = pool.shift() as { node: HuffNode; count: number; order: number };
      pool.push({ node: { value: -1, left: n1.node, right: n2.node }, count: n1.count + n2.count, order: order++ });
    }
    root = pool[0].node;
  }
  const w = new BitWriter();
  serializeTree(root, w);
  const codebook = new Map<number, number[]>();
  buildCodebook(root, [], codebook);
  for (const b of data) for (const bit of codebook.get(b) as number[]) w.writeBit(bit);
  return w.flush();
}

/**
 * Rebuild a raw_patch with a new (possibly edited) decompressed body: recompress
 * it, write the new decomp/comp sizes, place the bitstream at 0x4C, zero the
 * remainder, then recompute and store the CRC. Header bytes [0x00:0x48] (incl.
 * the preset name) are preserved. The result re-decodes to the same body with a
 * valid CRC; the device accepts it because the CRC is recomputed over the new
 * patch. (Write-back to the device is itself still hardware-unverified; this is
 * the file-level authoring primitive.)
 */
export function reencodeRawPatch(rawPatch: Uint8Array, newBody: Uint8Array): Uint8Array {
  const out = rawPatch.slice();
  const comp = huffmanCompress(newBody);
  out[RAW_PATCH_DECOMP_SIZE_OFFSET] = newBody.length & 0xff;
  out[RAW_PATCH_DECOMP_SIZE_OFFSET + 1] = (newBody.length >> 8) & 0xff;
  out[RAW_PATCH_COMP_SIZE_OFFSET] = comp.length & 0xff;
  out[RAW_PATCH_COMP_SIZE_OFFSET + 1] = (comp.length >> 8) & 0xff;
  out.fill(0, RAW_PATCH_BODY_OFFSET);
  out.set(comp, RAW_PATCH_BODY_OFFSET);
  out[RAW_PATCH_CRC_OFFSET] = 0;
  out[RAW_PATCH_CRC_OFFSET + 1] = 0;
  const crc = crc16ccitt(out, CRC_INIT);
  out[RAW_PATCH_CRC_OFFSET] = crc & 0xff;
  out[RAW_PATCH_CRC_OFFSET + 1] = (crc >> 8) & 0xff;
  return out;
}
