---
name: scene-state-ushort
class: packed-field
status: matched-singleton
discovered: 
verified_on:
  - axe-fx-ii-q8.02
firmware_sensitive: false
golden: STUB (structural-only; de-facto coverage: packages/fractal-gen2/src/sceneChannelMap.ts consumer; no byte-exact fixture)
relates_to: [septet-21bit-byte2-mask-preservation, alphabetical-name-cascade-block-ordering, block-record-stride-8]
consumed_in:
  - packages/fractal-gen2/src/sceneChannelMap.ts (BLOCK_LAYOUT_MAP scene state)
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

- **DO NOT** assume the offset is constant across presets. Scene-state
  offsets ARE stable per block-name in the binary layout, but they're
  not at the same offset as paramBase. See [[block-record-stride-8]]
  for the block-record table at chunk 0 ushort 36+ that catalogues
  where each block's scene-state lives.
- **DO NOT** write bypass without preserving channel-Y (or vice versa).
  Read-modify-write the whole ushort.
- **DO NOT** use SET_BLOCK_CHANNEL frames to modify scene state;
  that's exactly the  bug class (per-scene channel writes
  clobber non-active scene state).

## Where it does NOT apply

- AM4 (4 scenes ABCD, different encoding)
- Axe-Fx III: transfer candidate (likely same shape per `iii-preset-
  receiver.txt`; un-verified)

## Verification path

No inline fixture ships (golden is STUB). A functional case, if added,
would run:
1. Decode known capture: ushort `0x0301` → bypass scenes {1,2}, channel-Y
   scene {1}.
2. Encode round-trip: encode bypass_mask=0x07 + channelY_mask=0x80,
   assert correct ushort.
3. Write-without-clobber: set channelY in scene 2 without changing
   bypass; verify untouched scenes preserved.

## Refinement history

- : bit-packing decoded for 6 Tier-1 blocks; sceneState
  offsets mapped for 21 blocks total.
- `axefx2_set_scene_channels` tool shipped same session.
- Cookbook entry promoted from STATE.md  carryover to
  formal primitive.
