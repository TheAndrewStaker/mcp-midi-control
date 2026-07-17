---
name: gen3-fn01-set-float32-ordinal
class: protocol-exchange
status: matched-singleton
discovered: 2026-06-04 (capture3 re-decode); corrected 2026-06-08 (FM3 write capture + re-verify)
verified_on:
  - fm9-fw-11.00
  - fm3-fw-12.00
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-gen3-fn01-set-float32-ordinal
relates_to: [gen3-enum-label-septet-stream, iii-fn01-set-parameter-envelope, iii-byte-stream-septet-pack-8to7]
consumed_in: []
---

# gen-3 fn=0x01 SET value = 5-septet LE float32 @ pos 12

A gen-3 parameter SET (`F0 00 01 74 [model] 01 [sub:2] [eff:14b LE] [pid:14b LE]
...`) carries its value as an **IEEE-754 float32, little-endian, packed as five
7-bit septets at payload bytes 12..16**, followed by four `0x00` bytes and the
XOR-7F checksum (23-byte frame). The two sub-actions are **value-kind
selectors, not param-kind selectors**:

- sub `09 00`: value = **float32 of the param's NATURAL DISPLAY value**. For a
  discrete param (type/model selector) the natural value IS the read ordinal:
  `float32(read-ordinal)`, exactly the index the read leg (fn=0x1f / broadcast)
  and the shipped enum rosters decode with, so **set-by-name resolves straight
  off the read roster; there is no separate write-id space.** For a continuous
  param the float carries the display value directly: float32(45.0) at FM3
  REVERB_LOWCUT (20..2000 Hz, log10 taper) landed as 45.0 Hz, read back wire
  11540 (single-point, community FM3 field test fw 12.00, 2026-06-12;
  `samples/captured/fm3-community-2026-06-12/`).
- sub `52 00` (mouse-drag): value = `float32(normalized 0..1)` =
  `wire16 / 65534`. Applied to a DISCRETE param the device **quantizes** the
  normalized value onto the enum grid (same field test: 0.74998 snapped to
  step 58 of the 79-entry reverb-type enum; the echo was the float32
  truncation of 58/78, one ULP below round-nearest).

```
SET  F0 00 01 74 [model] 01 [sub] 00 [eff:14b LE] [pid:14b LE] [s0 s1 s2 s3 s4] 00 00 00 00 [cs] F7
     value u32 = s0 | s1<<7 | s2<<14 | s3<<21 | s4<<28 ; reinterpret as float32
```

## RETRACTION: the "raw-id permutation" model was a misread

A prior version of this entry claimed the OUT SET carried a permuted "raw enum
id" (reverb 524/529, drive 523) at bytes 15-16 read as a packValue16, distinct
from the read ordinal. **That was wrong.** Bytes 15-16 are the high two septets
of the float32, and reading them alone as a 14-bit int is a lossy MISREAD:
ordinals 16/17/18/19 all collapse to "524". A community contributor's
`prove.py` (2026-06-08) reproduces every "raw-id" from `float32(ordinal)`:

| name | true ordinal | float32 | old pos-15 misread |
|---|---|---|---|
| Medium Spring (reverb) | 16 | 16.0 | 524 |
| Music Hall (reverb) | 45 | 45.0 | 529 |
| Blues OD (drive) | 15 | 15.0 | 523 |
| Shiver Clean (amp, FM3) | 31 | 31.0 | 527 |
| Recording Studio A (reverb, FM3) | 38 | 38.0 | 528 |

## Evidence

- FM9 fw 11.00 (capture3): reverb SET-echo OUT frame
  `...01 09 00 42 00 0a 00 00 00 00 0c 04 00 00 00 00 5f f7` → float32@pos12 =
  **16.0** (Medium Spring); the 60-byte IN echo carries the name septet-packed
  from byte 5 ([[gen3-enum-label-septet-stream]]) and the normalized ordinal
  16/78.
- FM3 fw 12.00 (community lldb write capture): amp model SELECT → float32
  **31.0** (Shiver Clean, file-id 31); reverb type SELECT → float32 **38.0**
  (Recording Studio A). Both checksums valid.
- FM3 fw 12.00 (community field test, 2026-06-12, server-issued over
  USB-serial; `samples/captured/fm3-community-2026-06-12/`): sub `09 00`
  float32(45.0) at REVERB_LOWCUT (eff 66, pid 10; continuous, 20..2000 Hz
  log10) read back wire 11540 = **45.0 Hz**: the float carries the param's
  NATURAL DISPLAY value on a continuous param (single-point but exact under
  the log10 mapping). Same session: sub `52 00` on the discrete reverb TYPE
  (pid 0) quantized 0.74998 → ordinal 58, bulk-read word = plain 58.
- The shipped rosters (TYPE_BINARY_IDS / GEN3_READ_ROSTERS) ARE the set-by-name
  map; amp ordinal 31 = "Shiver Clean", 179 = "Texas Star Clean" resolve directly.

## Where this does NOT apply

- 47 amp ordinals are unnamed in the factory-correlated roster (need the
  FM3-Edit `effectDefinitions` cache); a name not in the roster is rejected, not
  mis-set. The 47 are settable by numeric ordinal.
- ~~Device ACCEPTANCE of a server-issued SET is still hardware-untested.~~
  **Confirmed on FM3 hardware**: a server-issued non-power-of-2 discrete SET
  (sub `09 00`, ordinal 31 = Shiver Clean) moved the FM3 front panel
  (community session, 2026-06-10), and the 2026-06-12 field test landed
  server-issued `52 00` and `09 00` SETs end-to-end over USB-serial.

## Refinement history

- 2026-06-04: discovered as `partial-N1`, framed as a {raw-id → name} write leg.
- 2026-06-08: model corrected to `float32(read-ordinal) @ pos 12`; the raw-id /
  permutation framing retracted (pos-15 packValue16 misread). Renamed from
  `gen3-enum-setecho-rawid-name`. Promoted to `matched-singleton` (FM3 + FM9).
- 2026-06-12 (community FM3 field test, fw 12.00): sub semantics reframed as
  **value-kind, not param-kind**: sub `09 00` float32 carries the param's
  NATURAL DISPLAY value (45.0 → 45.0 Hz at REVERB_LOWCUT, wire 11540 under
  log10 20..2000; single-point), unifying the discrete `float32(ordinal)` case
  (an ordinal IS a discrete param's natural value); sub `52 00` on a discrete
  param quantizes onto the enum grid. The "server-issued SET hardware-untested"
  caveat retired (stale since the 2026-06-10 ordinal-31 confirmation;
  compounded, now fixed).
