---
name: gen3-fn01-grid-routing
class: envelope-shape
status: matched
discovered: 2026-06-05 (FM9-Edit loopMIDI 26 cables; FM3-Edit loopMIDI 10 cables); law unified 2026-10-24 (42 distinct FM9-Edit frames + FM9 fw 12 hardware)
verified_on:
  - fm9-edit-loopmidi-write-capture-2026-06-05
  - fm3-edit-loopmidi-write-capture-2026-06-05
golden: scripts/primitives-verify.ts#case-gen3-fn01-grid-routing
relates_to: [gen3-fn01-grid-set-position-insert, ii-fn06-set-cell-routing, xor-7f-envelope-checksum]
consumed_in:
  - packages/fractal-midi/src/gen3/axe-fx-iii/setParam.ts (buildSetGridRouting)
  - packages/fractal-midi/test/gen3/axe-fx-iii/routing.test.ts (42 captured FM9 frames + FM3 goldens)
  - packages/fractal-gen3/src/writer.ts (routing gate removed for FM3)
---

# Gen-3 grid routing / SET_GRID_ROUTING (fn=0x01 sub=0x35)

Draws or removes a cable between two adjacent-column cells in the gen-3 routing
grid. The destination column is always `srcCol + 1` (the device rejects
non-adjacent cables). Captured via Rig A (single-port loopMIDI self-loopback)
using FM9-Edit (model 0x12) and FM3-Edit (model 0x11); no hardware required.

## Wire frame (26 bytes, all model bytes)

```
F0 00 01 74 <model> 01 35 00 00 00 00 00 <OP> 00 00 00 00 00 00 02 00 <b21> <b22> <b23> <cs> F7
```

- `OP` byte 12: `0x01` = connect, `0x02` = disconnect.
- `b21` byte 21, `b22` byte 22, `b23` byte 23: encode source cell + destination row
  (see formulas below).
- Checksum (byte 24): XOR of bytes 0..23 then `& 0x7F`.
- Constant `0x02` at byte 19 is the edge-record marker (observed in all 36 captures).

## One law, written as source and destination gridPos

```
from = (srcCol − 1) × rows + (srcRow − 1)      ← source cell gridPos
to   = srcCol × rows + (destRow − 1)           ← destination cell gridPos (col srcCol+1)
b21  = from >> 1
b22  = ((from & 1) << 6) | (to >> 2)
b23  = (to & 3) << 5
```

`gridPos` is the same cell index `set_block` uses (sub=0x32 bytes 12-13). The
three bytes are a 14-bit `from` and 9-bit `to` packed MSB-first.

**6-row (III 0x10, FM9 0x12).** Reproduces every one of the 42 distinct
sub=0x35 frames FM9-Edit sent in our loopMIDI captures
(`fm9-cc-routing-live/-sweep/-routing2/-routing3`, `fm9-sim-m1`), connect and
disconnect, including row-1 even-column sources. Decoding each frame with this
law puts its destination exactly one column right of its source (42/42), a
check a wrong law fails. Hardware: an FM9 fw 12 owner (issue #23) found
r2c4→r2c5 and the cross-row r3c3→r2c4 land with these bytes and do nothing
with the earlier law's bytes.

**4-row (FM3 0x11).** With rows = 4, `to >> 2` = srcCol and `to & 3` =
destRow − 1, so this is exactly the FM3-Edit-decoded form
(`b22 = ((srcGp&1)<<6) | srcCol`, `b23 = (destRow−1)<<5`; 10/10 captures,
FM3 hardware-confirmed 2026-06-27).

## Superseded: the 6-row colTerm/destSign law (2026-06-05 to 2026-10-24)

```
b22 = ((srcGp & 1) << 6) | (floor(3·(srcCol−1)/2) + 1 + (destRow ≥ 3 ? 1 : 0))
b23 = ((|destRow−3| + (srcCol even ? 2 : 0)) mod 4) << 5
```

It was fitted to the first 26-cable corpus and agrees with the gridPos law on
part of the grid, but differs on 162 of the 432 possible 6-row edges (e.g.
r2c1→r2c2: `00 41 20` vs the captured `00 41 60`), could not produce 6 of the
later captured frames, and forced a refusal of row-1 even-column sources.
Kept here so the old goldens are explainable; do not reuse it.

## Gotchas

- `to` uses srcCol (not srcCol − 1): the destination is the next column.
- b21 alone does not identify the source: the low bit of `from` rides in b22.

## Selected FM3 capture fixtures

| cable | srcGp | b21 | b22 | b23 | full frame |
|---|---|---|---|---|---|
| r2c1→r2c2 | 1 | 00 | 41 | 20 | `f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 41 20 42 f7` |
| r4c1→r4c2 | 3 | 01 | 41 | 60 | `f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 01 41 60 03 f7` |
| r2c1→r4c2 | 1 | 00 | 41 | 60 | `f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 41 60 02 f7` |
| r1c1→r1c2 | 0 | 00 | 01 | 00 | `f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 01 00 22 f7` |
| r2c2→r2c3 | 5 | 02 | 42 | 20 | `f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 02 42 20 43 f7` |
| r2c3→r2c4 | 9 | 04 | 43 | 20 | `f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 04 43 20 44 f7` |
| r1c2→r1c3 (row-1 even col) | 4 | 02 | 02 | 00 | `f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 02 02 00 23 f7` |

Full capture log: `samples/captured/fm3-routing-probe-*.json` (gitignored).
