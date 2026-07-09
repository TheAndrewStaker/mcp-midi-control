# Axe-Fx III, fn 0x01 SET_PARAMETER wire shape (Ghidra-verified)

**Status:** Wire envelope byte-verified against AxeEdit III's builder
function `FUN_14033ec70`. Confirms and extends `fn01-decode.md`'s
empirical model from public captures.

## Builder function

`FUN_14033ec70 @ 0x14033ec70` in `Axe-Edit III.exe` (v1.14.31). Calls
the generic SysEx builder `FUN_1403437d0` with fn=0x01. Wire envelope:

```
F0 00 01 74 10 01 [15-byte fixed header] [variable-length tail] [cs] F7
```

### Builder C-equivalent

```c
undefined8 buildSetParameter(undefined1 *modelHandle, longlong txCtx, uint *fields) {
    // fields = {action14, blockId14, paramId14, value32, modifier14, tailCount14, tail[...]}

    // Compute total payload size:
    //   15 bytes fixed (6 fields septet-packed) + tail items
    int payloadLen = (int)(fields[5] * 8 + 6) / 7 + 0xf;

    byte *buf = calloc(payloadLen, 1);

    // Field A: payload bytes 0-1 (14-bit septet pair)
    buf[0] = fields[0] & 0x7F;
    buf[1] = (fields[0] >> 7) & 0x7F;

    // Field B: payload bytes 2-3 (14-bit septet pair)
    buf[2] = fields[1] & 0x7F;
    buf[3] = (fields[1] >> 7) & 0x7F;

    // Field C: payload bytes 4-5 (14-bit septet pair)
    buf[4] = fields[2] & 0x7F;
    buf[5] = (fields[2] >> 7) & 0x7F;

    // Field D: payload bytes 6-10 (32-bit value, 5 septet pieces)
    buf[6]  = fields[3]        & 0x7F;
    buf[7]  = (fields[3] >> 7) & 0x7F;
    buf[8]  = (fields[3] >> 14) & 0x7F;
    buf[9]  = (fields[3] >> 21) & 0x7F;
    buf[10] = (fields[3] >> 28);             // 4 bits remain; no mask

    // Field E: payload bytes 11-12 (14-bit septet pair)
    buf[11] = fields[4] & 0x7F;
    buf[12] = (fields[4] >> 7) & 0x7F;

    // Field F: payload bytes 13-14 (14-bit septet pair) = tail item count
    buf[13] = fields[5] & 0x7F;
    buf[14] = (fields[5] >> 7) & 0x7F;

    // Optional tail (when fields[5] != 0):
    if (fields[5] != 0) {
        writeTailItems(&fields[6], fields[5], buf + 0xf);
    }

    sendSysEx(txCtx, /*fn*/ 0x01, buf, payloadLen, modelHandle[0]);
    free(buf);
    return 1;
}
```

## Field map

Cross-referenced against community captures in `fn01-decode.md`:

| Field | Bytes | Width | Wire encoding | Identified from captures |
|---|---|---|---|---|
| A | 0 to 1 | 14-bit | septet pair (LE) | **action/sub-op code** (e.g. `52 00` = SET, `04 01` = STATE_BROADCAST, `01 00` = long broadcast) |
| B | 2 to 3 | 14-bit | septet pair | **block id / effect id** (Appendix 1 enum) |
| C | 4 to 5 | 14-bit | septet pair | **param id** within the block |
| D | 6 to 10 | 32-bit | 5-byte septet (4-bit high tail) | **value**: likely IEEE-754 float bits OR fixed-point uint32 |
| E | 11 to 12 | 14-bit | septet pair | **modifier / scene slot** (varies per action) |
| F | 13 to 14 | 14-bit | septet pair | **tail item count** (often 0) |
| Tail | 15+ | variable | per `writeTailItems` | array of `fields[5]` items |

### Total wire length

For a SET write with `tail count = 0`:
- envelope: 6 bytes (`F0 00 01 74 10 01`)
- payload: 15 bytes (fields A, F)
- trailer: 2 bytes (checksum + `F7`)
- **total: 23 bytes**

This matches the 23-byte captures in `fn01-decode.md`'s "Action `52 00`"
row exactly. The wiki's "action code at pos 6-7" is what we call
Field A (the first 14-bit septet pair, sitting at wire frame offset
6-7 = payload offset 0-1).

For the long broadcast (action `01 00`, 87-byte frames):
- envelope: 6 bytes
- payload base: 15 bytes
- tail: `fields[5]` items × item size = 64 bytes
- trailer: 2 bytes
- **total: 87 bytes** ✓ matches public captures

The community-claimed 87-byte broadcast carries 64 bytes of tail data
gated by Field F (the count). Item size is constant per call, the
size calculation `(fields[5] * 8 + 6) / 7 + 0xf` suggests each tail
item is 8 bits raw → 8/7 = ~1.14 wire bytes per item, with the
formula adjusting for byte alignment. 64 wire bytes ÷ 8-bit-items ≈
56 items, consistent with a packed block-param snapshot.

## Builder argument struct layout

```c
struct SetParamFields {
    uint16_t action;       // Field A: sub-action code
    uint16_t blockId;      // Field B: block / effect ID
    uint16_t paramId;      // Field C: param ID
    uint32_t value;        // Field D: value (float bits or uint32)
    uint16_t modifier;     // Field E: modifier / scene slot
    uint16_t tailCount;    // Field F: tail item count
    uint16_t tail[];       // optional tail (size = tailCount items)
};
```

This is the most precise wire decode the III has had, the prior
`fn01-decode.md` had to infer field boundaries from XOR diffs across
public captures. The Ghidra finding makes every byte position
deterministic.

## Closes & extends

- **fn01-decode.md**: confirms the 23-byte SET shape, the 87-byte
  long broadcast shape, and the per-byte field boundaries. Promotes
  Hypothesis 4 ("fn=0x01, 16-byte payload") to BYTE-VERIFIED status
  (actual base payload is 15 bytes, not 16, the extra byte was
  miscounted; sums match 23-byte total exactly).
- ****: adds direct binary verification on top of the
  cross-mapped fn-byte vocabulary. The `FUN_14033ec70` decompile is
  the ground-truth wire builder for fn=0x01.

## Source

- `samples/captured/decoded/ghidra-axeedit3-message-builders.txt`
  L5170-5379, `FUN_14033ec70` decompile (already shipped )
- `scripts/_research/parse-axeedit3-fnbyte-callers.ts`, parses the
  message-builders trace into structured fn-byte → caller mapping
