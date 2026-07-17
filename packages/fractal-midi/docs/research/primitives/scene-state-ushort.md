---
name: scene-state-ushort
class: packed-field
status: matched
discovered: 
verified_on:
  - axe-fx-ii-q8.02 (384-preset factory file corpus survey, 3227 located scene words)
  - axe-fx-ii-xl-plus-q8.02-live (bk070 one-variable paired hardware captures; 32/32 informative pairs replay byte-exactly)
firmware_sensitive: false
golden: scripts/verify-ii-image-scene-words.ts
relates_to: [septet-21bit-byte2-mask-preservation, xor-fold-hash, ii-preset-image-tlv-chain, parambase-plus-paramid, alphabetical-name-cascade-block-ordering, ii-grid-routing-cell-matrix]
consumed_in:
  - packages/fractal-midi/src/gen2/axe-fx-ii/presetImage/sceneWords.ts (TLV-relative codec, encode + decode)
  - packages/fractal-gen2/src/sceneChannelMap.ts (BLOCK_LAYOUT_MAP scene state; legacy static coordinates)
  - packages/fractal-gen2/src/blockBinaryLayout.ts
  - packages/fractal-gen2/src/tools/applyExecutor.ts (apply_preset slots[].params.X/.Y nesting path)
# Note: the standalone axefx2_set_scene_channels tool was deprecated ;
# scene-state writes now go via apply_preset's channel-nested params path.
---

# Scene-state ushort (II)

One ushort per (block, scene) in the II preset binary encodes BOTH the
bypass mask AND the channel-Y mask for that block-scene combination.

## Formal definition

For a given block at scene-state offset `o` in the preset binary (offsets
mapped per block in `BLOCK_LAYOUT_MAP`), the 21-bit ushort decoded from
`o`:

```
sceneStateUshort = u16 at offset o   // decoded from 3-byte septet per [[septet-21bit-byte2-mask-preservation]]
bypass_mask     = sceneStateUshort & 0xFF        // bits 0..7
channelY_mask   = (sceneStateUshort >> 8) & 0xFF // bits 8..15
```

Bit-to-scene mapping (-DECODE-NOTES.md lines 690-700):

```
bit  (sceneIndex - 1)        of low byte  → bypass flag for scene `sceneIndex` (1..8)
bit  (sceneIndex - 1) + 8    of ushort    → channel-Y flag for scene `sceneIndex` (1..8)
```

Concretely: bit 0 = scene 1 bypass, bit 1 = scene 2 bypass, ..., bit 7
= scene 8 bypass; bit 8 = scene 1 channel-Y, bit 9 = scene 2 channel-Y,
..., bit 15 = scene 8 channel-Y. Set bit = flag active for that scene.
Channel-Y bits for scenes 5..8 (bits 12..15) have no direct hardware
pair; corpus instances decode consistently under the +8 pattern
(pattern-extrapolated, community-beta).

## TLV-relative location rule (2026-07-16, composition-independent)

The scene-state ushort for a placed block lives at image word

```
tlv.baseWord + k      (baseWord = tlvWord + 2)
```

where `k` is the block family's registered `<block>.bypass`
HOUSEKEEPING paramId in `fractal-midi/gen2/axe-fx-ii` KNOWN_PARAMS
(amp 28, cab 13, compressor 9, delay 22, drive 7, reverb 22, filter 8,
output 19, ...). The address is read from the dump's own TLV chain, so
it is layout-independent and firmware-drift-safe; the static
Test-Crunch-calibrated `(chunk, ushort)` coordinates in
`sceneChannelMap.ts` are the composition-fragile special case (all 6
BLOCK_LAYOUT_MAP anchors convert exactly). `k` indexes the FULL
payload: for the eight single-channel full-payload families (Filter,
Formant, Multiband Compressor, Resonator, Ring Modulator, Synth,
Feedback Return, Output) it sits past `payloadLen/2`, which is why the
per-channel-bounded param accessor must never be relaxed to reach it;
use a dedicated accessor bounded by `payloadLen`
(`sceneStateWordIndex` in the fractal-midi codec). Families with no
registered bypass pid (Quad Chorus, FX Loop, Feedback Send, Tone
Match, Mixer, Noisegate) have no located scene word: refuse by name.

## Byte-2 bypass MIRROR (2026-07-16, decoded this session)

The scene-state field is really a 21-BIT field: its byte-2 reserved
bits duplicate the bypass mask for scenes 1..5:

```
b2 & 0x7c == (ushort & 0x1f) << 2
```

Corpus-universal (4093/4093 located scene words across 503 on-disk
dumps, factory + live) and hardware-paired in BOTH directions: the
bk070 bypass pairs for scenes 1..5 flip the mirror bit in lockstep
with the bypass bit, scenes 6..8 flips do not (no septet room), and
channel-Y flips never touch it. Any scene-word write MUST maintain the
mirror or the written image differs from what the device itself would
serialize (and the footer, a 21-bit fold per the refined
[[xor-fold-hash]], exposes the difference). This decodes the
Session-115 NACK 0x13 lesson: the "meaningful byte-2 reserved bits" on
the Delay scene word were the bypass mirror.

## Where it's used

II preset binary scene encoding for 21 mapped blocks (Tier-1: Amp, Cab,
Comp, Delay, Drive, Reverb; Tier-2: Chorus, Flanger, Phaser, Wah, Pitch,
Filter, Vol/Pan, Tremolo/Panner, Formant, Enhancer, FX Loop, Rotary,
Graphic EQ, Parametric EQ, Multi Delay).

`axefx2_set_scene_channels` consumes this primitive; kills the 
channel-Y write-loss bug for the 6 Tier-1 blocks at the protocol level.

## Applicability

Use when reading or writing per-block per-scene bypass + channel-Y
state. Single ushort write modifies all 8 scenes atomically, far
preferable to 8 sequential SET_BLOCK_CHANNEL frames (which is what the
 channel-Y bug was caused by).

## Misapplication failure modes

- **DO NOT** assume the offset is constant across presets: address via
  the TLV-relative rule above (baseWord + bypass pid), never a static
  table. (The old pointer at [[block-record-stride-8]] as the locator
  is retired: that region is the grid cell matrix, see
  [[ii-grid-routing-cell-matrix]]; it never catalogued scene words.)
- **DO NOT** write bypass without preserving channel-Y (or vice versa).
  Read-modify-write the whole ushort.
- **DO NOT** write the ushort without maintaining the byte-2 bypass
  mirror `(word & 0x1f) << 2` (see above); a value-only write
  desynchronizes the mirror.
- **DO NOT** use SET_BLOCK_CHANNEL frames to modify scene state;
  that's exactly the  bug class (per-scene channel writes
  clobber non-active scene state).

## Where it does NOT apply

- AM4 (4 scenes ABCD, different encoding)
- Axe-Fx III: transfer candidate (likely same shape per `iii-preset-
  receiver.txt`; un-verified)

## Verification path

`scripts/verify-ii-image-scene-words.ts` (in `test:codec`):
1. Bit-semantics fixtures (decode 0x0803, RMW encode both directions).
2. Factory-corpus survey: 3227 located scene words decode across 384
   presets; single-channel blocks carry zero Y-mask bits (the one
   corpus anomaly, B052 "Cavernous" Output 0x0400, is allowlisted and
   asserted to stay unique).
3. THE PAIRED-CAPTURE REPLAY: every informative bk070 one-variable
   hardware pair (32) is replayed through the encoder
   (`applySceneStateToDump`) and must equal the real after-dump
   BYTE-FOR-BYTE, byte-2 mirror and 21-bit footer included.
Plus synthetic encode/refusal cases in
`packages/fractal-midi/test/gen2/axe-fx-ii/presetimage.test.ts`.

## Refinement history

- : bit-packing decoded for 6 Tier-1 blocks; sceneState
  offsets mapped for 21 blocks total.
- `axefx2_set_scene_channels` tool shipped same session.
- Primitive entry promoted from STATE.md  carryover to
  formal primitive.
- 2026-07-16: TLV-relative location rule (baseWord + registered bypass
  pid) replaces the static coordinates; single-channel full-payload
  refinement (8 families, k past len/2); byte-2 bypass MIRROR decoded
  (scenes 1..5 duplicated in bits 16..20); encode codec shipped in
  fractal-midi (`presetImage/sceneWords.ts`) with the 32-pair
  byte-exact replay golden. Status matched-singleton -> matched (two
  capture-context axes: factory file corpus + live-wire paired
  captures).
