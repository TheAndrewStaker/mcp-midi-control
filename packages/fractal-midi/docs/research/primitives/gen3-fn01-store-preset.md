---
name: gen3-fn01-store-preset
class: envelope-shape
status: matched
discovered: 2026-06-04 (no-hardware loopMIDI editor-emulation capture)
verified_on:
  - fm9-edit-loopmidi-write-capture
  - axe-edit-iii-loopmidi-write-capture
golden: scripts/primitives-verify.ts#case-gen3-fn01-store-preset
relates_to: [septet-14bit, xor-7f-envelope-checksum, gen3-fn01-grid-set-position-insert]
consumed_in:
  - packages/fractal-midi/src/gen3/axe-fx-iii/setParam.ts (buildStorePreset)
  - packages/fractal-midi/test/gen3/modern-family/catalog.test.ts (byte-exact store golden, models 0x10 + 0x12)
---

# Gen-3 store / save-to-location (fn=0x01 sub=0x26)

The gen-3 editor saves the working buffer to a preset location with
`fn=0x01 sub=0x26`. Captured from FM9-Edit driven over loopMIDI with no
hardware (see the [loopMIDI editor-emulation capture guide](../../capture-guides/loopmidi-editor-emulation.md)).

This **corrects the codec's save path.** The shipped gen-3 `save_preset`
attempts `fn=0x1D` (a II-ported guess, flagged "store not in the published
spec," which is why save is currently refused / community-beta). The
editor's real store op is `fn=0x01 sub=0x26`.

## Formal definition

```
F0 00 01 74 <model> 01 26 00 00 00 00 00 <presetNum:2> 00 00 00 00 00 00 00 <cks> F7
```

Where:

- `<model>` is the gen-3 model byte (FM9 `0x12`, FM3 `0x11`, Axe-Fx III
  `0x10`); `01` is the fn byte; `26` is the store sub-action.
- `presetNum` is a 2-byte septet-encoded 14-bit field at positions 12-13
  per [[septet-14bit]], **LSB-first** (byte 12 = low septet). Saving in
  place stores to the active preset number.
- `cks` is the standard XOR-7F envelope checksum per
  [[xor-7f-envelope-checksum]].

The arg slot (positions 12-13) is the same one the block-insert op uses
for `gridPos` in [[gen3-fn01-grid-set-position-insert]]; the sub-action
byte (6) distinguishes the operation.

### Endianness note

Confirmed at three locations (in-place = 0, 10, 5), all below 128, so
byte 13 (the high septet) was zero in every fixture. The LSB-first reading
is locked by preset 10 landing in byte 12 as `0x0a` (an MSB-first reading
would put 10 in byte 13). **The high-septet (presets >= 128) is now captured**:
a live FM9-Edit save of preset 151 emitted `... 26 00 00 00 00 00 17 01 00 ...`,
i.e. byte 12 = `0x17` (151 & 0x7f = 23) and byte 13 = `0x01` (151 >> 7 = 1),
decode14(0x17,0x01) = 151, confirming the LSB-first septet extension across the
128 boundary (captured through the codec-backed simulator, see
[[gen3-editor-sync-read-surface]]). Note this
LSB-first layout differs from the preset-dump REQUEST (`fn=0x03`), whose
preset number is big-endian (see the fn=0x03 entry); do not assume one
endianness across gen-3 preset-number fields.

## Caveats

- This is the editor's OUTBOUND store op, captured byte-exact. Whether the
  device persists it (and any front-panel confirmation) was not observed
  (no hardware round-trip; loopMIDI self-loopback has no device). The wire
  shape is authoritative (the editor is the source of truth for what the
  device expects); persistence is the remaining hardware-verification step.
- Confirmed on FM9 (model 0x12) AND Axe-Fx III (model 0x10): III saving to
  preset 5 produced the byte-identical op (only byte 4 differs). FM3 shares
  the codec and is the remaining family member to capture.

## Verification path

`scripts/primitives-verify.ts#case-gen3-fn01-store-preset` builds the store
envelope for the three captured saves (preset 0, 10, 5) from `presetNum`
and asserts byte-for-byte equality with the captured frames.

## Refinement history

- 2026-06-04: discovered via no-hardware loopMIDI editor-emulation
  capture (three saves to distinct preset numbers). Decoded `sub=0x26` as
  the store op with the destination preset number at the 14-bit arg slot.
  Supersedes the `fn=0x1D` guess in the shipped save path.
- 2026-06-04: codec migrated. `buildStorePreset` now emits `fn=0x01
  sub=0x26` (was `fn=0x1D`); the gen-3 `save_preset` warning copy updated to
  name the confirmed op. A byte-exact golden ties the production builder to
  the captured frames for models 0x10 and 0x12 in
  `test/gen3/modern-family/catalog.test.ts`.
