---
name: vp4-eid206-structure-blob
class: struct-layout
status: matched
discovered: 2026-07-01 (mining pass over the two Kevin Iudicello fw 4.03 captures)
verified_on:
  - vp4-fw-4.03 capture #1 (2026-06-08 read-poll session, preset "Y1: Main Bank")
  - vp4-fw-4.03 capture #2 (2026-06-09 annotated edit session, preset "Y1: Virtual Pedalboard")
firmware_sensitive: true
golden: test/gen3/vp4/structureblob.test.ts
relates_to: [iii-byte-stream-septet-pack-8to7, vp4-fn01-swapped-septet-float32, gen3-fn1f-poll-block-bulk-read]
consumed_in:
  - src/gen3/vp4/structureBlob.ts (buildVp4GetStructureBlob / parseVp4StructureBlob)
  - packages/fractal-gen3/src/reader.ts (VP4 get_preset active-buffer structure read)
---

# VP4 eid206 pid0 tc=0x1f — the whole-preset STRUCTURE blob

The VP4's system block **eid 206** answers `fn=0x01` GET on **paramId 0,
typecode 0x1f** with one septet-packed blob carrying the active preset's whole
STRUCTURE: preset name, the four scene names, the current scene index, and the
serial 4-slot chain as effect IDs. This is the register VP4-Edit itself polls
to render the chain (392 responses across the two captures).

## Wire shape

Request (18 bytes, verbatim in both captures — 202 occurrences):

```
F0 00 01 74 14 01 4E 01 00 00 1F 00 00 00 00 00 cs F7
                  └eid 206─┘ └pid 0┘ tc      └len=0┘
```

Response (238 bytes): same header through `tc=0x1f`, then `00 00 00`, a
14-bit LSB-first length tag `40 01` (= **192** raw bytes; the same length-tag
convention as the VP4 write frame's `04 00`), then **220 packed bytes**,
checksum, F7.

## Payload decode

The 220 packed bytes unpack 8→7 with the chunked LSB-first-with-carry scheme
([[iii-byte-stream-septet-pack-8to7]] — `unpackValueChunked` in
`shared/packValue.ts`; carry restarts every 8 wire / 7 raw bytes) into a
192-byte raw record:

| raw offset | field |
|---|---|
| `[0]` | u8 status flag: `0x00` fresh-loaded, `0x60` after the first structural edit |
| `[4]` | 1-bit toggle that FLIPS on every structural command (delete / move / save / scene) |
| `[8]` | u8 **CURRENT SCENE**, 0-based |
| `[12..15]` | float32 LE **live telemetry** — varies per poll |
| `[16..47]` | preset name, ASCII, space-padded to 31 chars + NUL |
| `[48..175]` | scene 1..4 names, 4 × 32-byte records (31 ASCII + NUL) |
| `[176..191]` | **CHAIN TABLE**: 4 × u32 LE effectId (shared gen-3 effect-ID table), slots 1..4 in order; `0` = empty slot |

## Oracles (byte-exact, action-annotated)

- **Chain / move cascade (v2):** `[118,78,70,66]` (Drive/Chorus/Delay/Reverb)
  → the `eid206 pid10` write at 4.78 s (Drive delete) → `[0,78,70,66]` → the
  `pid15`/`pid16` pair at 10.73 s (Delay move) → `[70,0,78,66]` = exactly the
  annotated cascade [DLY, empty, CHO, RVB].
- **Chain (v1, independent preset):** `[70,118,90,94]` = precisely the
  preset's four annotated blocks (DLY/DRV/PHR/WAH).
- **Current scene (N=2):** the annotated v2 scene 1→3 switch (`pid13` write at
  41.15 s) flips raw[8] `0→2`; the v1 capture (also post scene-1→3) reads `2`.
- **Names:** "Virtual Pedalboard" / "Main Bank" and all eight scene names read
  as clean ASCII in both captures.
- **Status/toggle:** raw[0] `0x00→0x60` at the first structural edit; raw[4]
  flips at every structural command boundary (delete, move, save, scene,
  save) in the v2 timeline.

## Misapplication failure modes

- **DO NOT fingerprint or byte-compare raw blobs.** The telemetry word at
  raw[12..15] (and its packed image) varies on every poll — two reads of an
  UNCHANGED preset differ. Compare decoded fields, never bytes.
- **raw[4] is NOT a dirty flag.** It is a parity-like toggle that flips on
  every structural command (including SAVE), so its absolute value carries no
  "modified since save" meaning. raw[0]=0x60 is stickier but also not proven
  to clear on save — do not wire either into the buffer-dirty gate without a
  dedicated capture.
- **Chain slot value `0` means EMPTY, not effectId 0.** Preserve slot
  positions (gaps are real); do not compact the chain.
- **This is a VP4 register, not gen-3-family.** eid 206 is beyond the III
  addressable roster and the tc-typecode GET is the VP4's own frame shape;
  do not issue this read at other model bytes.
- **The unpack is the CHUNKED 8→7 scheme.** A continuous-carry (non-restarting)
  or MSB-first unpack garbles everything past the first 7 raw bytes — this
  exact mistake produced the v1 capture's since-retired "preset name is not
  in the capture / chain not recoverable" negatives.

## Where it does NOT apply (yet)

- Whether OTHER presets' structures can be read without loading them (a
  stored-location variant) is unknown — both captures only poll the active
  buffer.
- The blob is read-only evidence. The corresponding WRITE registers
  (`pid10` delete, `pid15`/`pid16` move pair, `pid13` scene) are identified
  by causality but their value math is undecoded — see the VP4 SYSEX-MAP
  "still gated" list.

## Verification path

`test/gen3/vp4/structureblob.test.ts` (in `test/run-all.ts`): the verbatim
request golden + two full captured response frames (one per preset/session)
asserting every decoded field, plus malformed-frame throws.
`scripts/verify-fractal-gen3-family.ts` drives the `fractal-gen3` reader
end-to-end against the captured v1 frame (mock conn).

## Refinement history

- 2026-07-01: decoded (mine1..mine5 pass over
  `samples/captured/decoded/vp4-403{,-v2}/frames.json`); codec + goldens +
  reader wiring shipped same-session. Overturned two v1-capture negatives
  (name-not-in-capture, chain-not-recoverable) — both were unpack-scheme
  misses, not absent data.
