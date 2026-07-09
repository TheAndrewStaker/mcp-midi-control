/**
 * Gen-3 preset patch-body codec — now a re-export of the shared Fractal
 * preset-container codec in `fractal-midi/shared` (presetContainer.ts).
 *
 * The 3-to-16 septet pack/unpack, dynamic Huffman compress/decompress,
 * CRC-16/CCITT, raw_patch CRC, and footer XOR were hoisted to the codec
 * package on 2026-07-02 when the AM4 0x77/0x78/0x79 dump body was found
 * to be the SAME container verbatim (4 chunks / 8,192 B raw_patch vs the
 * III's 16 / FM3+FM9's 8). Codec logic belongs in `fractal-midi`; this
 * module keeps its import path and export surface so every gen-3 caller
 * (presetAuthor, parityMock, scripts/verify-gen3-*) is unchanged and the
 * gen-3 wire behavior stays byte-identical.
 *
 * See `packages/fractal-midi/src/shared/presetContainer.ts` for the full
 * layout doc, and `fractal-midi/am4` (`decodeAm4RawPatch`) for the AM4
 * consumer.
 */

export {
  RAW_PATCH_CRC_OFFSET,
  RAW_PATCH_DECOMP_SIZE_OFFSET,
  RAW_PATCH_COMP_SIZE_OFFSET,
  RAW_PATCH_BODY_OFFSET,
  CRC_INIT,
  decode3to16,
  encode16to3,
  huffmanUncompress,
  huffmanCompress,
  crc16ccitt,
  computeRawPatchCrc,
  computeRawPatchXor,
  decodeRawPatch,
  reencodeRawPatch,
} from 'fractal-midi/shared';
export type { DecodedRawPatch } from 'fractal-midi/shared';
