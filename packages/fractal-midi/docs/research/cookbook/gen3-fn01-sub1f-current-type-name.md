---
name: gen3-fn01-sub1f-current-type-name
class: struct-layout
status: matched
discovered: FM3 field test 2026-06-12 (single name); FM9 Windows verify 2026-06-19 (3 blocks)
verified_on:
  - fm9-fw11.0
  - fm3-fw12.00
firmware_sensitive: false
golden: packages/fractal-midi/test/gen3/axe-fx-iii/typename.test.ts
consumed_in:
  - packages/fractal-midi/src/gen3/axe-fx-iii/setParam.ts (buildRequestCurrentTypeName / parseGetParameterResponse)
  - packages/fractal-gen3/src/reader.ts (getParam discrete-name path)
---

# gen-3 fn=0x01 sub=0x1F — read a block's CURRENT type/model NAME

The modern Fractal editor reads a block's currently-selected type/model NAME with
`fn=0x01 sub=0x1F`, targeting `(effectId, typeParamId)` with a zero value field.
The device replies with the long fn=0x01 GET frame whose display-string region
carries the model name. This is the authoritative source for a type selector's
value — the positional `fn=0x1F` BULK read mis-addresses type selectors (its value
is NOT the roster ordinal; FM9 capture 2026-06-19: a reverb whose device name was
"Small Room"/ordinal 0 read back as positional value 5 = "Large Hall").

`buildGetParameter`'s `sub=0x09` GET elicits the same display-string reply; the
`sub=0x1F` form is what the editor sends.

## Request (host → device), 23 bytes

```
F0 00 01 74 <model> 01 1F 00 <effLo effHi> <pidLo pidHi> 00*9 <cks> F7
```

- `effLo/effHi`, `pidLo/pidHi`: 14-bit LSB-first septet pairs (effectId, type paramId).
- The type paramId is DEVICE-SPECIFIC: FM9 amp/reverb=10, drive=0; III/FM3 differ
  (reverb type=0 on III/FM3). Resolve from the device-true catalog; never hardcode.

## Reply (device → host), variable length

```
F0 00 01 74 <model> 01 1F 00 <eff pair> <pid pair> 00*8 <LEN> 00 <packed name…> <cks> F7
```

- `LEN` at frame index 19 = name length + 1 (counts the NUL terminator).
- Name region from index 21: 8→7 packed ASCII (decode with the chunked
  sliding-window 8→7 unpacker / `parseGetParameterResponse`'s `displayString`),
  NUL-terminated, length `ceil(LEN*8/7)` packed bytes.

## Byte-exact fixtures (FM9 fw 11.0, 2026-06-19)

| block | eff / pid | LEN | decodes to |
|---|---|---|---|
| reverb | 66 / 10 | 0x0B | "Small Room" |
| amp | 58 / 10 | 0x12 | "59 Bassguy Bright" |
| drive | 118 / 0 | 0x0F | "Rat Distortion" |

FM3 fw 12.00 (2026-06-12) returned "Rat Distortion" from its drive sub=0x1F
(pid 0) — a second device/firmware axis point, byte-pattern identical bar the
model byte. All three FM9 names are real Fractal models (self-validating decode).

## Companion: sub=0x2E is OVERLOADED (do not confuse with this)

`fn=0x01 sub=0x2E` has two replies, both ~755 bytes (length cannot disambiguate):
- EMPTY-target (zero target region) = the live routing GRID (parseGen3GridLayout).
- BLOCK-target (effectId+paramId set) = a per-block preset-name/status frame
  (its variable region septet-decodes to the active preset name; the 3-byte field
  at idx34-36 is an opaque per-block state/hash word, not a name/ordinal). Route by
  the target region, not by length.

## Refinement history

- 2026-06-12 — FM3 field test: single-point decode ("Rat Distortion"), partial.
- 2026-06-19 — FM9 Windows verify: 3 blocks byte-exact + LEN-field semantics
  pinned; promoted to `matched` (FM9 + FM3 axis points). Wired into get_param.
