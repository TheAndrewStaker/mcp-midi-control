---
name: gen3-fn01-grid-routing
class: envelope-shape
status: matched
discovered: 2026-06-05 (FM9-Edit loopMIDI 26 cables; FM3-Edit loopMIDI 10 cables)
verified_on:
  - fm9-edit-loopmidi-write-capture-2026-06-05
  - fm3-edit-loopmidi-write-capture-2026-06-05
golden: scripts/cookbook-verify.ts#case-gen3-fn01-grid-routing
relates_to: [gen3-fn01-grid-set-position-insert, ii-fn06-set-cell-routing, xor-7f-envelope-checksum]
consumed_in:
  - packages/fractal-midi/src/gen3/axe-fx-iii/setParam.ts (buildSetGridRouting)
  - packages/fractal-midi/test/gen3/axe-fx-iii/routing.test.ts (35 byte-exact goldens)
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

## Two formula variants, branched by grid row count

### 6-row grids (III 0x10, FM9 0x12): 26 of 26 cables byte-exact

```
srcGp    = (srcCol − 1) × 6 + (srcRow − 1)
b21      = floor(srcGp / 2)
colTerm  = floor(3·(srcCol−1)/2) + 1
destSign = destRow ≥ 3 ? 1 : 0
b22      = ((srcGp & 1) << 6) | (colTerm + destSign)
b23      = ((|destRow−3| + (srcCol even ? 2 : 0)) mod 4) << 5
```

Coverage: source rows 2–6 all columns (18/18); row-1 odd srcCol (8/8).
Gap: row-1 even srcCol (byte22 breaks; encoding not yet captured for 6-row).

### 4-row grids (FM3 0x11): 10 of 10 cables byte-exact

```
srcGp = (srcCol − 1) × 4 + (srcRow − 1)
b21   = floor(srcGp / 2)
b22   = ((srcGp & 1) << 6) | srcCol           ← colTerm = srcCol; no destSign
b23   = (destRow − 1) << 5                    ← linear; no mod-4 wrap
```

Coverage: all rows 1–4, all srcCol including row-1 even-col (cable r1c2→r1c3
confirmed: b21=02 b22=02 b23=00). The even-col gate applies to 6-row grids only.

## Why the formulas differ

On a 6-row grid, the symmetric centering at row 3 in b23 and the `3/2`-scaled
colTerm in b22 pack cross-row distance efficiently. On a 4-row grid the
destination row fits directly into 2 bits `(destRow−1)`, making the linear
`(destRow−1)×32` encoding sufficient with no wrapping. The colTerm scaling
reduces to `srcCol` because `floor(3·(c−1)/2)+1 = c` for c = 1 and c = 2,
and the 4-row formula was confirmed only up to srcCol = 3 (same simplified form).

## Gotchas

- Formulas share b21 (`floor(srcGp/2)`) but use different ROWS in srcGp
  (4 vs 6), so b21 diverges for srcCol ≥ 2.
- destSign (6-row b22) has no equivalent in the 4-row formula; for destRow ≥ 3
  on FM3, destSign would be 1 in the 6-row formula but 0 in the actual captures.
- Row-1 even-col on 6-row: the byte22 bits are inconsistent across the 4
  available data points; the pattern is not closed. Do not extrapolate from
  FM3 row-1-even-col to FM9/III.

## Selected FM3 capture fixtures

| cable | srcGp | b21 | b22 | b23 | full frame |
|---|---|---|---|---|---|
| r2c1→r2c2 | 1 | 00 | 41 | 20 | `f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 41 20 42 f7` |
| r4c1→r4c2 | 3 | 01 | 41 | 60 | `f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 01 41 60 03 f7` |
| r2c1→r4c2 | 1 | 00 | 41 | 60 | `f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 41 60 02 f7` |
| r1c1→r1c2 | 0 | 00 | 01 | 00 | `f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 01 00 22 f7` |
| r2c2→r2c3 | 5 | 02 | 42 | 20 | `f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 02 42 20 43 f7` |
| r2c3→r2c4 | 9 | 04 | 43 | 20 | `f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 04 43 20 44 f7` |
| r1c2→r1c3 (row-1 even-col!) | 4 | 02 | 02 | 00 | `f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 02 02 00 23 f7` |

Full capture log: `samples/captured/fm3-routing-probe-*.json` (gitignored).
