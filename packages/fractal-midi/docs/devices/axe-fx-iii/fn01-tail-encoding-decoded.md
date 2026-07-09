# Axe-Fx III, fn=0x01 SET_PARAMETER tail encoding (Ghidra-decoded)

The III SET_PARAMETER (fn=0x01) builder `FUN_14033ec70` writes a
15-byte fixed header followed by an optional variable-length tail.
The tail writer `FUN_14033f2d0` uses an **8-bit → 7-bit packing**
algorithm, NOT the septet-pack we see elsewhere.

## The packing function

```c
int FUN_14033f2d0(byte *src, int srcLen, byte *dst) {
  byte carry = 0;
  int dstIdx = 0;
  int bitCounter = 1;

  for (int srcIdx = 0; srcIdx < srcLen; ) {
    byte *dstByte = &dst[dstIdx];
    dstIdx++;

    if (bitCounter == 8) {
      // every 8th byte: emit the accumulated carry from prior 7 inputs
      *dstByte = carry;
      bitCounter = 1;
      carry = 0;
    } else {
      // 7 of 8 dst bytes: high 7 bits of src byte + low bit from carry
      byte srcByte = src[srcIdx];
      *dstByte = (srcByte >> bitCounter) & 0x7F | carry;
      carry = (~(0x7F << bitCounter) & srcByte) << (7 - bitCounter);
      bitCounter++;
      srcIdx++;
    }
  }
  // trailing carry byte
  dst[dstIdx] = carry;
  return dstIdx + 1;
}
```

This is the classic **N bytes → ⌈(N×8 + 6) / 7⌉ wire bytes** packing
that lets full 8-bit source bytes squeeze through MIDI's 7-bit-safe
wire format.

## Tail length formula

From `FUN_14033ec70` allocator:

```c
int payloadLen = (int)(srcLen * 8 + 6) / 7 + 0xf;
//                                          ^^^^ 15-byte fixed header
//               ^^^^^^^^^^^^^^^^^^^^^^^^^^ packed tail size
```

Total wire frame = `payloadLen + 8` (envelope + cs + F7).

### Known fn=0x01 wire frame sizes

| Wire total | Payload | Tail wire | Tail src bytes | Action code (Field A) |
|---|---|---|---|---|
| 10 bytes | 2 | 0 | 0 | (header-only sub-actions) |
| 23 bytes | 15 | 0 | 0 | `52 00` SET_PARAMETER |
| 23 bytes | 15 | 0 | 0 | `04 01` STATE_BROADCAST (short) |
| 87 bytes | 79 | 64 | **56** | `01 00` long broadcast |

### How "tail src bytes" maps to operation semantics

- **SET (0x52)**: 0 tail bytes, the value sits in Field D (32-bit
  at bytes 6-10). Single-knob writes don't need a tail.
- **STATE_BROADCAST short (0x04)**: 0 tail bytes, single param
  state announcement.
- **Long broadcast (0x01)**: 56 tail src bytes, packed snapshot of
  a block's full per-channel state. Plausible content per block:
  - 14 params × 4 bytes (float32 each) = 56 bytes ✓
  - OR 28 params × 2 bytes (uint16 each) = 56 bytes ✓
  - OR 56 individual byte fields (block flags + bypass + channel +
    routing + headroom values) = 56 bytes ✓

The 8-bit packing means tail data is **opaque payload** from the
wire perspective. The semantic structure (whether it's float arrays
or u16 arrays or mixed bytes) is set by the receiver code on the
device side, which we don't have visibility into from AxeEdit's
binary.

## Decoder (host-side)

To unpack a received fn=0x01 tail (e.g. from STATE_BROADCAST):

```c
int unpack_8to7(byte *wire, int wireLen, byte *dst) {
  byte carry = 0;
  int dstIdx = 0;
  int bitCounter = 1;

  for (int wireIdx = 0; wireIdx < wireLen - 1; ) {
    if (bitCounter == 8) {
      // pull the 8-th wire byte (saved carry) and shift it into
      // the previous 7 results. Actually, the packed format has
      // already integrated this; the reader just reverses the bits
      bitCounter = 1;
      carry = wire[wireIdx];
      wireIdx++;
    } else {
      // shift the 7-bit value back into an 8-bit byte
      byte hi = (wire[wireIdx] & ~0x7F) >> (7 - bitCounter);
      // ... etc.
      // Working impl: invert the FUN_14033f2d0 packing rule
      dstIdx++;
      bitCounter++;
      wireIdx++;
    }
  }
  return dstIdx;
}
```

A full TypeScript decoder ships with the codec, see followup task.

## Implications

For  + III observability tools:

- **`get_block_state` on III** can subscribe to fn=0x01 STATE_BROADCAST
  frames (action code `04 01`). Decode the 23-byte short broadcast →
  single-param updates. Decode the 87-byte long broadcast → bulk
  block state via unpack_8to7 on the 64-byte tail.
- **`set_param` on III** is straightforward: action `52 00` + 14-bit
  block-id + 14-bit param-id + 32-bit value, no tail. We already
  ship this via an earlier fn=0x01 codec; this Ghidra decode just
  byte-verifies the existing implementation.
- **STATE_BROADCAST consumer**: a future MCP tool that maintains a
  device-state cache by listening to fn=0x01 `04 01` broadcasts.
  Eliminates the need to poll `get_block_layout` repeatedly.

## Source

- `samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt`
  L1274-1318, FUN_14033f2d0 (the packing function)
- `samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt`
  L1322-1535, FUN_14033ec70 caller (the SET_PARAMETER builder)
