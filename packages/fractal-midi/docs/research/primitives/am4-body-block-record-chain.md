---
name: am4-body-block-record-chain
class: layout
status: matched
discovered: 2026-11-12 (re-mine of the AM4 factory bank after the gen-3 block-chain work, then a stored-vs-working-buffer cross-check on hardware)
verified_on:
  - am4 fw 1.01 (factory bank, 104 presets: the chain walks to exactly 2 bytes before decompSize in every one)
  - am4 fw 2.00 (hardware, 15 stored presets cross-checked against the working-buffer read; one-change dumps for bypass, channel and scene)
firmware_sensitive: true
golden: packages/fractal-midi/test/am4/presetcontainer.test.ts (synthetic body: walk, slot order, per-channel value, scene state, second instance, comparable body); capture sweep scripts/verify-am4-preset-container.ts (factory bank walk + factory[0] and factory[11] goldens + warm pairs)
relates_to: [am4-gen3-preset-container, am4-fn1f-atomic-read, am4-fn03-stored-dump-request, am4-pidlow-register-families, gen3-stored-block-chain-order]
consumed_in:
  - fractal-midi/src/am4/bodyChain.ts
  - mcp-midi-control/packages/am4/src/descriptor/reader.ts
  - mcp-midi-control/packages/am4/src/shared/bufferState.ts
---

# AM4 decoded preset body: a self-describing block-record chain

The decompressed body of an AM4 preset dump (see [[am4-gen3-preset-container]])
is four scene records followed by a chain of records that each name
themselves. Nothing has to be located by scanning or by a size table.

```
0x0000  u16   active scene, 0-based (in a stored dump: the scene it was saved on)
0x0004  4 x 0x50-byte scene records
          +0x00  32-byte ASCII scene name
          +0x20  channel word for slot 1..4, one per slot at a 4-byte stride
          +0x30  bypass word for slot 1..4 (nonzero = bypassed), 4-byte stride
0x0144  record chain, back to back, to 2 bytes before decompSize
```

Each chain record:

```
word 0      effect id  (== the block's pidLow; a second instance is id + 1)
words 1..4  zero
word 5      cols  (param words per row)
word 6      rows  (4 = channels A/B/C/D, 1 = one shared row)
then        cols * rows u16 words; a param sits at  row * cols + pidHigh
```

The record layout is the fn 0x1F chunk layout (`channel * stride + pidHigh`,
[[am4-fn1f-atomic-read]]), so the live param table and scaling decode it
unchanged.

The effect ids are the gen-3 effect ids (Input 0x25, Output 0x2A, Comp 0x2E,
Amp 0x3A, Cab 0x3E, Reverb 0x42, Delay 0x46, Drive 0x76 and its second
instance 0x77). Unlike the gen-3 grid devices, whose chain entries carry no id
([[gen3-stored-block-chain-order]]), the AM4 writes the id into every record.

## What is always present, and what follows placement

Present in all 104 factory presets, including the 16 empty ones: record 0x02
(99x1), records 0x03..0x12 (35x1 each), Input 0x25 (18x4), Output 0x2A (38x4),
Cab 0x3E (78x4) and PATCH 0xCE (118x1). Every other record exists exactly when
its block is placed in a slot, and the chain lists them in ascending id order,
which is NOT the signal-chain order.

Signal-chain order is in the PATCH record: words 0x0F..0x12 hold the effect id
in slots 1..4 (0 = empty). Those are the same registers the live slot read uses
(pidLow 0xCE, pidHigh 0x0F + slot - 1).

## Words that are not preset content

| Where | What | Evidence |
|---|---|---|
| PATCH word 0x0E | changes between back-to-back dumps of an untouched preset | three no-op redump pairs differ only here |
| PATCH word 0x0A | index of the location the buffer was loaded from | a copy saved from location 93 into 95 stores 93; the loaded buffer reads 95 |

Masking those two words gives a body that compares equal exactly when two
presets hold the same content (`am4ComparableBody`).

## Evidence

- Structure: the walk consumes the body exactly (2-byte tail) in 104/104
  factory presets (fw 1.01) and in every fw 2.00 hardware dump taken; the amp
  values it yields equal the earlier marker-scan amp decode on 87/87 presets.
- Values, on hardware: for 15 stored presets the stored decode was compared
  with the working-buffer read of the same preset after loading it. They place
  13 block types between them (amp, drive, delay, reverb, chorus, flanger,
  phaser, wah, filter, compressor, enhancer, gate, vol/pan); tremolo and rotary
  are covered only by the offline factory walk, and no preset on hand places a
  GEQ or PEQ. 18,687 of 18,737 values agreed. The 50 that did not are values
  the device itself changes when it loads a preset (shown by diffing the stored
  dump against the working-buffer dump: amp word 0x2D on fw 1.01-era presets,
  Cab Blend 1/2, gate attack, a wah bypass) or a rounding difference in the
  fn 0x1F read of the reverb low/high cut Q (`get_param` returned the stored
  word exactly). None is a misplaced offset.
- Scene words, one change per dump on the working buffer: bypassing the block
  in slot 4 on scene 1 moved only scene record 0 +0x3C; putting the slot-2 amp
  on channel C moved only scene record 0 +0x24; switching to scene 3 moved body
  word 0x0000 and PATCH word 0x0D. Across all four scenes of three presets the
  decoded channel and bypass matched the live state 200/200.
- Second instance: factory preset 11 places two drives; slot 2 reads 0x77 and
  record 0x77 has the drive table size (50x4).

## Limits

- `firmware_sensitive: true`: table sizes move with firmware. A fw 1.01
  Vol/Pan record is 20 columns and the same preset loaded on fw 2.00 dumps 21,
  the new column appended at the end of each row. The walk does not care, since
  every record states its own size, and params past a record's `cols` are
  skipped.
- Not decoded: records 0x02 and 0x03..0x12 (controllers / modifiers), the
  Input and Output records, scene MIDI in the PATCH record, and the scene
  record bytes past the two 4-slot tables.
- A value stored for a preset is not always the value the device holds after
  loading it (see the 50 above), so "stored equals loaded" is not an identity.
