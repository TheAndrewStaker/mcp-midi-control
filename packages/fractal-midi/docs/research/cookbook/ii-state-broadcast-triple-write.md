---
name: ii-state-broadcast-triple-write
class: envelope-shape
status: matched-singleton
devices: [II]
golden: scripts/cookbook-verify.ts#case-ii-state-broadcast-triple-write
verified_on:
  - axis: device-firmware
    point: "Axe-Fx II XL+ Q8.02"
    date: 2026-05-25
    evidence: "probe-axefx2-state-write.ts Test A: Amp 1 pos[2] round-trip byte-exact"
  - axis: device-family
    point: "FM9 (gen-3, model 0x12, FW 11.00), device→host broadcast direction"
    date: 2026-06-03
    evidence: "community FM9 capture: fn=0x74/0x75/0x76 burst as the fn=0x1F poll response; Reverb block 66, body index 0 = Mix = 65534. parseGen3StateBroadcastBody golden in test/axe-fx-iii/setparam.test.ts"
---

# State-Broadcast Triple Write (fn 0x74/0x75/0x76, Host → Device)

The device accepts a synthesized 0x74/0x75/0x76 triple as a WRITE operation.
Same envelope shape as the device-emitted state-broadcast (device → host) and
the fn=0x1F response. Bidirectional.

## Wire shape

```
HEADER  F0 00 01 74 [model] 74 [targetId:14b] [itemCount:14b] [opFlag] [cs] F7
CHUNK   F0 00 01 74 [model] 75 [chunkCount:14b] [N × packValue16] [cs] F7
FOOTER  F0 00 01 74 [model] 76 [cs] F7
```

- `targetId`: effectId from BLOCK_BY_ID (e.g. 106=Amp 1, 108=Drive 1)
- `itemCount`: total values across all chunks (must match block's full position count)
- `opFlag`: 0x01 (block edit) or 0x00 (preset-structure). Both accepted for writes.
- `packValue16`: 3-byte septet pack of a 16-bit value `[v&0x7F, (v>>7)&0x7F, (v>>14)&0x03]`
- Chunks hold max 64 items each; overflow spills to additional 0x75 frames.

## Constraints

1. **Full array required.** itemCount MUST equal the block's total position count
   (e.g. 236 for Amp, 78 for Drive). Partial writes (itemCount < total) are ignored.
2. **NOT channel-aware.** The triple writes to the block's monolithic state array
   regardless of which channel fn=0x11 last selected. Channel X and Y share
   most positions; writing one affects both channels' reads at shared positions.
3. **Encoding is per-position.** Some positions use wire16 (0..65534 for display
   0..10), others use display-integer scale (0..10 directly), others are enums
   or read-only. The fn=0x1F response reveals each position's native encoding.

## Applicability

The **device-emitted broadcast** direction (device → host) is now confirmed on a
**second device family**: the gen-3 FM9 (model `0x12`, FW 11.00) emits the same
`0x74/0x75/0x76` triple as its `fn=0x1F` poll response and on front-panel edits.
The triple ENVELOPE SHAPE thus generalizes across gen-2 (II) and gen-3 (III/FM3/FM9).

The **HOST-TO-DEVICE write acceptance** (this entry's headline claim) remains
confirmed on Axe-Fx II XL+ Q8.02 ONLY; gen-3 write-acceptance is untested (the
FM9 capture was a panel edit + reads, no synthesized write). Status stays
`matched-singleton` for the write claim until a gen-3 write round-trip lands.

## Fixtures

- `probe-axefx2-state-write.ts` Test A: Amp 1, 236 values, opFlag=0x01,
  pos[2] modified from 32767 to 49152. Readback confirmed byte-exact.
- `probe-axefx2-state-write-multiblock.ts`: 21-block sweep, 15 wire16 + 6
  display-int, all pass when values match native encoding.
- `probe-axefx2-state-write-display-scale.ts`: 6/6 "failing" blocks pass
  with display-scale values. Zero drift.
- `probe-axefx2-state-write-channel-xy.ts` PART 1: writing Y at pos[1,2]
  overwrote X's values (channel isolation breach). Monolithic.

## Consumer

- Builder: `packages/fractal-midi/src/gen2/axe-fx-ii/setParam.ts:buildStateBroadcastTriple`
- Reader: `packages/fractal-gen2/src/descriptor/reader.ts:readAllParams`

## Cross-references

- [[ii-fn1f-atomic-read]]: the READ primitive that returns this same shape
- [[septet-14bit]]: targetId and itemCount encoding

## Refinement history

- 2026-05-25: Initial registration. Status `matched-singleton` (Q8.02 XL+).
  Proved bidirectional + per-position encoding + NOT channel-aware.
- 2026-06-03: Cross-family confirmation of the device→host envelope. First gen-3
  hardware capture (FM9 model `0x12`, FW 11.00, community-contributed) shows the
  identical `0x74/0x75/0x76` triple as the `fn=0x1F` poll response; body is positional
  in device-true paramId order (Reverb idx 0 = Mix = 65534 = 100%). Parsed by
  `parseGen3StateBroadcastHead/Body` (`src/gen3/axe-fx-iii/setParam.ts`), golden in
  `test/axe-fx-iii/setparam.test.ts`, consumed by gen-3 dirty-state in the MCP-server
  layer. Write-acceptance NOT generalized (read direction only).
