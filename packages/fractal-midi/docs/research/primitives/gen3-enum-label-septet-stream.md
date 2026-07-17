---
name: gen3-enum-label-septet-stream
class: bit-level
status: partial-N1
discovered: 2026-06-04 (FM9 enum-sweep + capture3 re-decode at offset 5, tester Harp)
verified_on:
  - fm9-fw-11.00
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-gen3-enum-label-septet-stream
relates_to: [iii-byte-stream-septet-pack-8to7, gen3-fn1f-poll-block-bulk-read, gen3-fn01-set-float32-ordinal]
consumed_in: []
---

# gen-3 enum value labels DO cross the wire (septet stream, byte-5 aligned)

Gen-3 Fractal editors fetch enum value NAMES (reverb/amp/drive type lists,
cab IR names, current-value labels, controller sources) from the device
over USB; they are NOT editor-resident. The names are carried **septet-
packed** in `fn=0x01` IN frames and recovered by the streaming MSB-first
8→7 unpack ([[iii-byte-stream-septet-pack-8to7]]), but only when the unpack
**starts at byte index 5** (the fn byte). See the negative
[[gen3-septet-label-wrong-offset]] for the one-byte misalignment that hid
these for multiple sessions.

## Formal definition

```
labels(frame):                                   # frame = full F0..F7
  stream = frame[5 .. len-2]                      # from fn byte to byte before checksum
  bytes  = septet_unpack_8to7(stream)             # acc=(acc<<7)|b; emit (acc>>(bits-8))&0xff when bits>=8
  # ASCII labels are fixed-width 32-char fields, space/NUL padded.
```

## Carriers (FM9 fw 11.00)

| fn:sub | what it carries |
|---|---|
| `0x01:0x2e` | a param's full value LIST (positional 32-char fields), dumped when its Type dropdown opens; in the panel-open capture this was the cab IR-picker list |
| `0x01:0x1a` | one param's CURRENT-value label (getParameterInfo septet tail), e.g. amp "FAS Bass"/"BASSGUY" |
| `0x01:0x09` | a typed-SET response: the SET value's name (see [[gen3-fn01-set-float32-ordinal]], the SET value is float32(ordinal)) |
| `0x01:0x2a` | cab/IR browser list (capture3: "AMPEG BASS", "SVT 4X10+subkick", …) |
| `0x01:0x1f` | controller / modifier source names ("PEDAL 1", "FC 1 PEDAL 1", …) |
| `0x01:0x01` | block instance / category names ("Reverb 1", "REV"), structural, not enum values |

## Evidence

FM9 enum-sweep frame #11 (`fn=0x01 sub=0x2e`, 755 B), septet-unpacked at
byte 5: "B4x10 FAS Bass -'25f", "Clean", "Warm", "Gain", "Driven", "Clean
w/DI, PostCabComp", … Capture3 re-decode at byte 5: `sub=0x09` carries
"Medium Spring"/"Music Hall"/"Blues OD"; `sub=0x2a` the full cab list. The
same scan at byte 6 yields only garbage. Reproduced by hand + the
`fm9-decode-verify` workflow. Full writeup is in the maintainer's private
session notes.

## Where this does NOT yet apply

- A block's **full type list** only dumps when its **Type dropdown is
  opened** (sub=0x2e for that param). Opening the block PANEL only yields
  current-value + cab IR list. So coverage so far = the cab IR list + ~3
  SET-echo pairs; the full reverb/amp/drive/delay tables need a
  dropdown-open capture (or an editor-resource re-mine of this 32-char
  format).
- Amp model names appear via `sub=0x1a` (current value) but the amp SET
  echo (`sub=0x09`) is numeric, not a name; see
  [[gen3-fn01-set-float32-ordinal]].
- N=1 axis (FM9 only).

## Refinement history

- 2026-06-04: discovered + `partial-N1`. Reverses the prior "labels are
  device-resident / never cross the wire" conclusion, which was a byte-6
  septet-alignment error (the wrong-unpack bug class).
