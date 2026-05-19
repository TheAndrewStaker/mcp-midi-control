# AM4 SysEx Map — Working Protocol Reference

> **Status:** Phase 1 working reference.
> **Sources:** `docs/wiki/MIDI_SysEx.md`, `MIDI.md`, `Presets.md`, `Scenes.md`,
> `Channels.md`, `Modifiers_and_controllers.md` (scraped 2026-04-14).
> **Update on every sniff session:** flip entries from 🟡 INFERRED / 🔴 UNKNOWN
> to 🟢 CONFIRMED as they are verified against real AM4 traffic.

---

## Legend

- 🟢 **CONFIRMED** — Documented for AM4 on the Fractal wiki, or verified by
  sniffing AM4-Edit traffic against a real device. Safe to use.
- 🟡 **INFERRED** — Not documented for AM4, but the Axe-Fx II / AX8 spec
  defines this function ID and the Fractal SysEx family is historically
  consistent. Treat as a reasonable first guess; verify before shipping.
- 🔴 **UNKNOWN** — No wiki coverage, no reliable template. Requires
  sniffing to determine.

---

## 1. Device Model IDs 🟢

From `MIDI_SysEx.md`. AM4 is 0x15, which is the byte that sits in position 4
of every AM4 SysEx message.

| Hex | Device | SysEx coverage |
|-----|--------|----------------|
| 0x00 | Axe-Fx Standard | Legacy |
| 0x01 | Axe-Fx Ultra | Legacy |
| 0x02 | MFC-101 | Foot controller |
| 0x03 | Axe-Fx II | Fully documented |
| 0x04 | MFC-101 mk3 | Foot controller |
| 0x05 | FX8 | Partial |
| 0x06 | Axe-Fx II XL | Fully documented |
| 0x07 | Axe-Fx II XL+ | Fully documented |
| 0x08 | AX8 | Fully documented (main template for AM4) |
| 0x0A | FX8 mk2 | Partial |
| 0x10 | Axe-Fx III | Separate 3rd-party MIDI PDF |
| 0x11 | FM3 | Separate 3rd-party MIDI PDF |
| 0x12 | FM9 | Separate 3rd-party MIDI PDF |
| 0x14 | VP4 | 5 mode-switch commands only |
| **0x15** | **AM4** | **5 mode-switch commands only** |

---

## 2. Envelope Format 🟡

Inferred to be identical to the Axe-Fx II family structure. The 5 documented
AM4 commands follow this shape exactly, so the envelope itself is safe to
treat as confirmed.

```
Byte 0     0xF0        SysEx start
Byte 1     0x00        Manufacturer ID byte 0  ┐
Byte 2     0x01        Manufacturer ID byte 1  │ Fractal Audio (0x00 01 74)
Byte 3     0x74        Manufacturer ID byte 2  ┘
Byte 4     0x15        Model ID — AM4
Byte 5     0xdd        Function ID
Byte 6..N-2           Payload (function-specific)
Byte N-1   0xdd        Checksum (7-bit, XOR of F0..last payload byte, & 0x7F)
Byte N     0xF7        SysEx end
```

### Worked example — "Switch AM4 to Scenes mode" (🟢 confirmed on wiki)

```
F0 00 01 74 15 12 49 4B F7
│  └──┬──┘  │  │  └─┬─┘ │
│     │     │  │    │   └ SysEx end
│     │     │  │    └───── 49 = mode-switch argument (Scenes); 4B = checksum
│     │     │  └────────── 12 = Function ID (mode switch)
│     │     └───────────── 15 = AM4 model ID
│     └─────────────────── Fractal manufacturer ID
└───────────────────────── SysEx start
```

Checksum verification:
```
0xF0 ^ 0x00 ^ 0x01 ^ 0x74 ^ 0x15 ^ 0x12 ^ 0x49 = 0xCB
0xCB & 0x7F = 0x4B ✓
```

---

## 3. Checksum Algorithm 🟢

XOR every byte from SysEx start (`0xF0`) through the last payload byte
(inclusive), then AND the result with `0x7F` to strip the high bit. The
resulting 7-bit value sits directly before `0xF7`.

### TypeScript implementation

```typescript
function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7F;
}

function buildMessage(fn: number, payload: number[] = []): number[] {
  const body = [0xF0, 0x00, 0x01, 0x74, 0x15, fn, ...payload];
  return [...body, fractalChecksum(body), 0xF7];
}
```

### Response checksums 🟢

**All AM4 responses carry a checksum** (confirmed session 2026-04-14 —
observed on 0x08, 0x14, and 0x64 responses). Simpler than Axe-Fx II's
"some do, some don't" split. No known exceptions yet; `0x0D TUNER_INFO`
and `0x10 MIDI_TEMPO_BEAT` are still untested on AM4.

---

## 4. Officially Documented AM4 Commands 🟢

These are the only AM4 commands currently on the wiki. All use Function
ID `0x12` (mode switch).

| Mode | Full SysEx | Function | Arg | Checksum |
|------|-----------|----------|-----|----------|
| Presets | `F0 00 01 74 15 12 48 4A F7` | 0x12 | 0x48 | 0x4A |
| Amp mode | `F0 00 01 74 15 12 58 5A F7` | 0x12 | 0x58 | 0x5A |
| Scenes | `F0 00 01 74 15 12 49 4B F7` | 0x12 | 0x49 | 0x4B |
| Effects | `F0 00 01 74 15 12 4A 48 F7` | 0x12 | 0x4A | 0x48 |
| Tuner / tap | `F0 00 01 74 15 12 18 1A F7` | 0x12 | 0x18 | 0x1A |

**Wire confirmation:** all 5 mode-switch commands above match
independent community captures posted to the Fractal Forum
("AM4 Tips and Tricks" and "Wish: Midi CC# to choose between 5 modes"
threads, multiple authors). The wire bytes our `am4_*` tools produce
are byte-for-byte identical to what community testers verified
controlled the AM4 mode select.

### Sibling VP4 (0x14) — same function, different args

| Mode | SysEx | Arg |
|------|-------|-----|
| Presets | `F0 00 01 74 14 12 48 4B F7` | 0x48 |
| Scenes | `F0 00 01 74 14 12 49 4A F7` | 0x49 |
| Effects | `F0 00 01 74 14 12 4A 49 F7` | 0x4A |
| Tuner / tap | `F0 00 01 74 14 12 18 1B F7` | 0x18 |

VP4 and AM4 are preset-compatible per `Presets.md`, so VP4 sniffing data
should translate directly to AM4 in most cases. A VP4 is a useful secondary
reference if one is available.

---

## 5. Axe-Fx II / AX8 Function ID Template 🟡

This is our guessing table for AM4. Each entry below is documented on the
wiki for Axe-Fx II/AX8 (model 0x03 / 0x08) and is a reasonable first-probe
candidate for AM4 (model 0x15). Replace the AM4 model byte (`0x15`) into
each message and try.

| ID | Symbolic name | Direction | Priority for AM4 Phase 1 |
|----|---------------|-----------|--------------------------|
| 0x01 | (Axe-Fx II GET_BLOCK_PARAMETERS_LIST) | — | 🟢 **on AM4 this is param R/W dispatcher — see §6a** |
| 0x02 | GET/SET_BLOCK_PARAMETER_VALUE | both | 🔴 **unused by AM4-Edit** — superseded by 0x01 |
| 0x07 | GET/SET_MODIFIER_VALUE | both | P2 |
| 0x08 | GET_FIRMWARE_VERSION | both | 🟢 confirmed — v2.00 build Mar 20 2026 |
| 0x09 | SET_PRESET_NAME | req | P1 — try as AM4 name query (read side may differ) |
| 0x0D | TUNER_INFO | resp only | P2 |
| 0x0E | PRESET_BLOCKS_DATA | both | P1 — shape of loaded preset; may also carry name |
| 0x0F | GET_PRESET_NAME | req | 🔴 **REJECTED on AM4** (ACK with result 0x05) |
| 0x10 | MIDI_TEMPO_BEAT | resp only | P2 |
| 0x11 | GET/SET_BLOCK_XY | both | P1 (likely channel-select on AM4) |
| 0x12 | (mode switch) | req | 🟢 confirmed |
| 0x13 | GET_CPU_USAGE | both | P2 |
| 0x14 | GET_PRESET_NUMBER | both | 🟢 confirmed — 14-bit decode |
| 0x17 | GET_MIDI_CHANNEL | both | P2 |
| 0x20 | GET_GRID_LAYOUT_AND_ROUTING | both | P1 — preset structure |
| 0x21 | FRONT_PANEL_CHANGE_DETECTED | resp only | P1 — needs 0x08 first |
| 0x23 | MIDI_LOOPER_STATUS | both | N/A (AM4 has no looper) |
| 0x29 | GET/SET_SCENE_NUMBER | both | P1 |
| 0x2A | GET_PRESET_EDITED_STATUS | both | P2 |
| 0x2E | SET_TYPED_BLOCK_PARAMETER_VALUE | req | P2 (float variant of 0x02) |
| 0x32 | BATCH_LIST_REQUEST_START | resp only | P1 |
| 0x33 | BATCH_LIST_REQUEST_COMPLETE | resp only | P1 |
| 0x3C | SET_PRESET_NUMBER | req | **P0 — switch presets** |
| 0x42 | DISCONNECT_FROM_CONTROLLER | req | P1 — needed for clean shutdown after 0x08 |
| 0x47 | DEVICE_INFO_OR_CAPABILITY 🟡 | both | **NEW (Session 46)**: observed during AM4-Edit launch handshake. AM4-Edit sends fn=0x47 with empty payload; AM4 returns 10 bytes: `4b 02 00 00 00 02 02 00 68 00`. Likely a device-info / capability / preset-count response — `0x68` = 104 matches the AM4 preset count. Decode pending; first 1-2 bytes (`4b 02`) probably a version stamp. |
| 0x64 | MULTIPURPOSE_RESPONSE | resp only | 🟢 confirmed — `[echoed_fn, result_code]` format |
| 0x7A / 0x7B / 0x7C | IR download protocol | req | P3 — IR loading |

### Phase 1 "live-tweak" MVP — the narrow path

The smallest shippable cut relies on just four function IDs:

1. **0x08 GET_FIRMWARE_VERSION** — handshake, proves two-way comms, unlocks
   `0x21` change-detected notifications.
2. **0x14 GET_PRESET_NUMBER** — read current state.
3. **0x0D QUERY_PATCH_NAME** — human-readable preset name (Axe-Fx III opcode,
   confirmed session 02).
4. **0x01 PARAMETER_R/W dispatcher** — tweak a parameter in real time
   (session 04 — see §6a for shape).

If those four work, we have a demo-able product without needing to reverse
the preset binary format. Everything harder (full preset read/write, scene
encoding, modifier graphs) comes after.

---

## 6a. 0x01 PARAMETER_R/W Dispatcher 🟢

**Confirmed session 04 (USB capture). Encoding fully cracked session 05
via Ghidra reverse-engineering of `FUN_140156d10` / `FUN_140156af0` in
AM4-Edit.exe — see `SESSIONS.md` for the trace.**

AM4 does NOT use the Axe-Fx II `0x02 GET/SET_BLOCK_PARAMETER_VALUE`. The
function byte `0x01` is a combined read/write dispatcher whose body holds
five 14-bit header fields followed by an 8-to-7-packed payload.

### General body layout (after envelope `F0 00 01 74 15 01`)

```
[hdr0_lo hdr0_hi] [hdr1_lo hdr1_hi] [hdr2_lo hdr2_hi] [hdr3_lo hdr3_hi] [hdr4_lo hdr4_hi]  ← 10 bytes (5 × 14-bit fields)
[packed_value_bytes...]                                                                   ← ceil((rawN*8 + 6)/7) wire bytes for rawN raw bytes
[cs] F7
```

Each header field is a 14-bit little-endian integer split into two 7-bit
septets: `value & 0x7F` then `(value >> 7) & 0x7F`.

| Field | Meaning | Notes |
|---|---|---|
| hdr0 | Parameter ID low (14 bits) | for Amp Gain on preset A01 = `0x003A` |
| hdr1 | Parameter ID high (14 bits) | for Amp Gain on preset A01 = `0x000B` |
| hdr2 | Action / type code | `0x0001` = WRITE (float). Read variants use other values — see read table below. |
| hdr3 | Reserved / channel | `0x0000` in all observed writes |
| hdr4 | Payload byte count | `0x0004` for a 32-bit float write; `0x0000` for reads |

### Write request (23 bytes for a float value)

```
F0 00 01 74 15 01 [pidL_lo pidL_hi] [pidH_lo pidH_hi] [01 00] [00 00] [04 00] [v0 v1 v2 v3 v4] [cs] F7
```

- 5 packed value bytes carry the 4-byte IEEE 754 little-endian float (see §6b).
- Captured Amp Gain = 1.0 (internal 0.1):
  `F0 00 01 74 15 01 3A 00 0B 00 01 00 00 00 04 00 66 73 19 43 68 [cs] F7`

### Read request (18 bytes on wire)

```
F0 00 01 74 15 01 [pidL_lo pidL_hi] [pidH_lo pidH_hi] [read_type:1] 00 00 00 00 [cs] F7
```

- `read_type` observed values (selects response shape):
  - `0D` → **64-byte response** (long-form param descriptor — 40-byte
    payload incl. live state; shape decoded HW-066, see "Read response —
    `read_type = 0x0D`" below). This is what AM4-Edit uses for state
    polling (bypass UI sync, etc.); the short read at `0x0E` returns a
    static value for the same address.
  - `0E` → **23-byte response** (short parameter read; shape decoded
    HW-044 — see "Read response — `read_type = 0x0E`" below). Use for
    knob-style continuous params and block-placement registers; does
    NOT track per-block bypass state at `pidHigh=0x0003` — that
    register requires the 0x0D long form.
  - `10` → 64-byte response shape (analogous to `0x0D`; not yet
    decoded against goldens).
  - `26` → response shape TBD (older trace mis-typed as 34-byte)
  - `1F` → seen on one address family; response shape TBD

### Read response — `read_type = 0x0E` 🟢

**Decoded HW-044 (Session 42, 2026-05-01).** Capture
`samples/captured/session-42-readprobe.pcapng`. Two reads sent
(`pidLow=0x00CE / pidHigh=0x000F` for slot-1 block; `pidLow=0x003A /
pidHigh=0x000B` for amp.gain) against a working buffer with slot 1 =
filter (FIL, bypassed) and amp.gain knob = 3.00. Both responses 23
bytes; both decoded byte-exact against the founder's display anchors.

```
F0 00 01 74 15 01 [pidL_lo pidL_hi] [pidH_lo pidH_hi] [0E 00] 00 00 [04 00] [packed 5b] [cs] F7
```

The response is byte-identical to the outgoing request through the
readType field, then `hdr3 = 0x0000`, `hdr4 = 0x0004` (signals "4 raw
bytes follow"), and 5 packed-septet bytes encoding those 4 bytes via
the same `packValue` round-trip as writes (§6b). Distinct from the
write-echo (64 bytes, `hdr4 = 0x0028`) and command-ack (18 bytes,
`hdr4 = 0x0000`) variants of the same `0x01` envelope.

**Decode rule (per param kind):**

- **Block-placement registers** (`pidLow=0x00CE`, `pidHigh=0x000F..0x0012`
  for slots 1..4): the unpacked 4 raw bytes are u32 LE = the block's
  pidLow. Look up via `BLOCK_NAMES_BY_VALUE` from `blockTypes.ts`.
  Filter (`pidLow=0x0072`) verified — packed payload `39 00 00 00 00`
  → raw `72 00 00 00` → u32 = 0x72.
- **Knob-style continuous params** (knob_0_10, knob_0_20, dB, hz, ms,
  percent, …): u32 LE is a Q16 fixed-point representation of the
  firmware's internal float — i.e. `internal = u32 / 65536`. Run
  through `decode(param, internal)` to convert to the display value.
  amp.gain = 3.00 verified — packed `66 13 00 00 00` → raw
  `CC 4C 00 00` → u32 = 19660 → internal 0.30 → display 3.00.

**Denominator empirically pinned at 65534 (= 0xFFFE) via HW-046
(Session 43, 2026-05-01).** Capture
`samples/captured/session-43-q16sanity.pcapng`, three additional
amp tone-stack reads at founder-noted display values. Combined with
HW-044's amp.gain=3.00 sample:

| display | observed u32 | predicted via /65534 round | /65535 trunc | /65536 trunc |
|---|---|---|---|---|
| 3.00 | 19660 | 19660 ✓ | 19660 | 19660 |
| 5.00 | 32767 | 32767 ✓ | 32767 | 32768 ✗ |
| 6.00 | 39320 | 39320 ✓ | 39321 ✗ | 39321 ✗ |

Bass=5.00 eliminates /65536; mid/treble=6.00 eliminate /65535. Only
/65534 with round-to-nearest fits all four samples byte-exact. Why
65534 specifically (= 2¹⁶ - 2): plausibly because AM4 stores values
in signed Q15 fixed-point internally (range -32767..+32767 with
-32768 reserved as a sentinel) and shifts the magnitude left by 1
on the wire to fill a 16-bit unsigned span. Empirical match is
ground truth — firmware RE past that is unnecessary.

Constant in code: `READ_VALUE_DENOMINATOR = 65534` in `setParam.ts`.

**Code:** `setParam.ts:isReadResponse` (predicate),
`setParam.ts:parseReadResponse` (parser, returns `{ pidLow, pidHigh,
rawValue, asUInt32LE(), asInternalFloat() }`). Goldens in `verify-msg`
for both captured responses (4 predicate cases + 2 byte-exact decode
cases).

### Read response — `read_type = 0x0D` 🟢 (long-form param descriptor)

**Decoded HW-066 (Session 48, 2026-05-06).** AM4-Edit's bidirectional
sync between front panel and editor UI is driven by polling each
block's bypass register at `(block_pidLow, pidHigh=0x0003)` with
**action `0x0D`**, not the `0x0E` short read we'd been using. The
`0x0E` short read at the same address returns a *static* value per
block (amp = 32767, drive/reverb/delay = 0) that doesn't track bypass
writes — that mismatch is what HW-064 turn 9 surfaced and HW-066
diagnosed.

```
F0 00 01 74 15 01 [pidL_lo pidL_hi] [pidH_lo pidH_hi] [0D 00] 00 00 [28 00] [40 raw bytes ...] [cs] F7
```

Total response length: **64 bytes** (vs. 23 for `0x0E`).
- `hdr3` = `0x0000`.
- `hdr4` = `0x0028` (40-byte raw payload follows; this is a full
  parameter descriptor, not just a 4-byte value).
- Payload occupies wire bytes 16..61. Within it, **wire byte 22 of the
  full response is the live bypass flag** for bypass-register reads:
  `0x01` → bypassed, `0x00` → active. Same polarity as the write side
  (`float32(1.0)` = bypass).

**Capture and probe references:**
- `samples/captured/session-46-front-panel-dly-rev-bypass.pcapng` —
  AM4-Edit polling traffic during front-panel bypass toggles. Decoded
  via `parse-capture.ts`; AM4-Edit polls each of `0x3A/0x76/0x42/0x46`
  + `pidHigh=0x0003` 290+ times per session.
- `scripts/probe-bypass-action-0d.ts` — directed test that writes
  bypass ON/OFF per block × scene and reads back at `0x0D`, printing
  all 64 wire bytes with byte-by-byte diffs. 8 (block × scene) cases
  all show byte 22 flipping `0x01 ↔ 0x00`; 12 other offsets change
  too but those are descriptor metadata (range/min/max) that swap in
  for the parameter at the new state — not the state itself.

**Code:** `setParam.ts:isReadResponseLong` (predicate),
`setParam.ts:parseLongReadBypassFlag` (extracts byte 22 with full
envelope + checksum validation), `setParam.ts:READ_TYPE_LONG = 0x0D`,
`LONG_READ_BYPASS_FLAG_BYTE = 22`. `am4_get_block_bypass` rewritten
in Session 48 to use this pipeline; `am4_get_active_scene` /
`am4_get_active_location` continue to use the short `0x0E` read
(those registers respond correctly to short reads).

**Limitation: this decode is currently bypass-specific.** Wire byte
22 carries the bypass flag for `pidHigh=0x0003` reads. The other 39
bytes of the 0x0D payload are a parameter descriptor (range, default,
display info) that we haven't decoded yet. If a future tool needs
descriptor metadata for any pid, that's a follow-up — for now we only
read the one byte we need.

### AM4-Edit behavior observed

- AM4-Edit polls active parameters at ~200 Hz with reads. The vast majority
  of OUT SysEx traffic is reads, not writes.
- Writes fire only on **Enter-commit** in the number input field. Physical
  knob moves on the AM4 itself emit NO USB traffic from AM4-Edit (the amp
  updates its own state; AM4-Edit sees it via polling).

### Known parameter IDs 🟡

| pidL | pidH | Parameter | Internal scale | Verified |
|---|---|---|---|---|
| `0x003A` | `0x000B` | Amp Gain | displayed × 0.1 (UI 0–10 → internal 0–1) | preset A01, session 04 |
| `0x003A` | `0x003E` | Parametric EQ band 1 gain | displayed × (1/12) for −12…+12 dB UI | session 05 |
| `0x003A` | `0x07D2` | Amp active channel (A/B/C/D) | enum int 0..3 packed as float32 | session 08 (toggle captures, all 4 confirmed) |
| `0x0001` | `0x0063` | GLOBAL_USBLEVEL1 (USB 1/2 Level, dB) | float32 LE, displayed verbatim (1.11 dB capture verified) | HW-112 (Session 96) |
| `0x0001` | `0x002E` | GLOBAL_TAP_TEMPO_MODE (enum int) | enum 0..N packed as float32 (1.0 = "Last Two") | HW-112 (Session 96) |

> The Amp channel-selector parameter (`pidH = 0x07D2`) is the first
> observation that `0x0f52` in the parse-capture body dump was **two 7-bit
> septets**, not a little-endian 16-bit value. Since every prior pidHigh
> was ≤ 0x7F the distinction was invisible. All future pidHighs ≥ 128
> must be decoded with `(hi << 7) | lo`, not `(hi << 8) | lo`. The other
> per-block selectors (Drive/Reverb/Delay) likely live at the same
> pidHigh `0x07D2` on their respective `pidLow` values, but that's not
> yet confirmed.

Per-parameter scale must be looked up — the firmware operates in
normalized units, AM4-Edit converts on display.

---

## 6b. Value Encoding — Sliding 8-to-7 Bit-Pack 🟢

**Cracked session 05.** The packed value field is a standard sliding-window
8-to-7 bit-pack of the raw payload bytes (typically 4 bytes for an IEEE 754
single-precision LE float). N raw bytes → N+1 wire septets; each wire byte
has bit 7 = 0 (SysEx-legal).

### Algorithm

```
pack(raw[0..N-1]) → wire[0..N]:
  carry = 0
  for i = 0..N-1:
    k = i + 1                     # shift width grows each iter, 1..N
    wire[i] = ((raw[i] >> k) & 0x7F) | carry
    carry   = ((~(0x7F << k) & raw[i]) << (7 - k)) & 0x7F
  wire[N] = carry
```

Reference TypeScript implementation: `src/protocol/packValue.ts`
(verified round-trip on all 10 captured samples — `npm run verify-pack`).

### Captured (displayed_value, internal_float, wire_5_bytes)

The internal float is what the firmware actually stores. The displayed
value seen in AM4-Edit is `internal × inverse_scale` (e.g. Amp Gain
displayed = internal × 10).

| Param | Displayed | Internal | Wire bytes (after the 10-byte header) |
|---|---|---|---|
| Amp Gain | 0.0 | 0.000 | `00 00 00 00 00` |
| Amp Gain | 0.25 | 0.025 | `66 73 19 43 60` |
| Amp Gain | 0.5 | 0.050 | `66 73 09 43 68` |
| Amp Gain | 1.0 | 0.100 | `66 73 19 43 68` |
| Amp Gain | 1.5 | 0.150 | `4D 26 23 13 70` |
| Amp Gain | 2.0 | 0.200 | `66 73 09 43 70` |
| Amp Gain | 2.5 | 0.250 | `00 00 10 03 70` |
| Amp Gain | 3.0 | 0.300 | `4D 26 33 13 70` |
| Amp Gain | 4.0 | 0.400 | `66 73 19 43 70` |
| EQ b1 | −1.0 dB | −0.0833 | `55 6A 55 2B 68` |

### Important correction to earlier notes

Earlier §6b listed **6** value bytes (positions 15..20) for a write. That
was wrong. The leading `00` belonged to the **high byte of the 5th 14-bit
header field** (the byte count `0x0004`, packed as `04 00`). The actual
value field is 5 bytes (positions 16..20). This is why our linear-pack
hypothesis appeared non-linear: we were including a header byte in the
"value" bits, and that header byte differs across parameters even when
the value is the same.

---

## 6bb. GLOBAL Family Register 🟢

**Cracked HW-112 (Session 96, 2026-05-17).** Capture
`samples/captured/session-95-am4-global-pidlow.pcapng`. Confirms that
the AM4's 99 system-level settings (USB levels, tap tempo, MIDI thru,
display brightness, modeling toggles, etc.) are addressable via the
**same `0x01` PARAM_RW envelope** as placeable blocks — only the
`pidLow` is different.

### Address

- **pidLow** `0x0001` — GLOBAL family register (fixed for all 99 system
  params). Ghidra dispatcher catalog labels this `case_0x1`; the
  in-firmware label prefix is `GLOBAL_*`.
- **pidHigh** = the paramId from the Ghidra catalog
  (`samples/captured/decoded/ghidra-am4-paramnames.json`, key
  `effect_types.case_0x1.params[*].paramId`). 99 paramIds total.

### Value

Float32 LE, same Q16 fixed-point convention as placeable blocks (§6a /
§6b). Continuous params use the `internal × inverse_scale` pattern;
enum dropdowns ride the same float wire as integer-valued enums (e.g.
`GLOBAL_TAP_TEMPO_MODE` = `1.0` selects "Last Two").

### Captured writes (HW-112)

Both decoded byte-exact from `session-95-am4-global-pidlow.pcapng`. The
host→device frames are unique writes; the surrounding ~3.4k frames are
AM4-Edit's idle polling at the same address.

| Frame | paramId | Ghidra name | Wire payload (5 packed bytes) | f32 decoded | Display |
|-------|---------|-------------|-------------------------------|-------------|---------|
| 6117  | 99 | `GLOBAL_USBLEVEL1` | `3D 45 11 63 78` | 1.110 | "USB 1/2 Level: 1.11 dB" |
| 11589 | 46 | `GLOBAL_TAP_TEMPO_MODE` | `00 00 10 03 78` | 1.000 | "Tap Tempo Mode: Last Two" |

The Ghidra catalog already carries all 99 paramId+name pairs. Generating
`params.ts` GLOBAL entries from this finding is mechanical (the next
follow-up after this decode).

---

## 6c. Block Slot Placement Register 🟢

**Cracked Session 19** from three Session-18 captures (`session-18-block-
clear-to-none.pcapng`, `session-18-block-type-gte-to-rev.pcapng`,
`session-18-block-add-none-to-amp.pcapng`). Block placement — which block
type occupies each of the AM4's four signal-chain slots — is a regular
0x01 PARAMETER_R/W **WRITE** to a dedicated parameter-family register.

### Address

- **pidLow** `0x00CE` — block-slot register (fixed).
- **pidHigh** `0x000F`–`0x0012` — slot index for positions 1, 2, 3, 4.
  - `0x0013` is **NOT** a valid slot — sending it produces a structurally
    different ack and was observed to have side effects on an unrelated
    slot (Session 19 hardware test). Clients MUST validate 1 ≤ position
    ≤ 4 and stop at pidHigh 0x0012.

### Value

Float32 containing the target block's own pidLow. `0.0` clears the slot
to "none" (empty). Known block-type values (same as pidLow elsewhere in
this map):

| Block | pidLow (float32 value) |
|-------|------------------------|
| (none / empty) | `0x0000` |
| Compressor | `0x002E` |
| GEQ | `0x0032` |
| PEQ | `0x0036` |
| Amp | `0x003A` |
| Reverb | `0x0042` |
| Delay | `0x0046` |
| Chorus | `0x004E` |
| Flanger | `0x0052` |
| Rotary | `0x0056` |
| Phaser | `0x005A` |
| Wah | `0x005E` |
| Volume/Pan | `0x0066` |
| Tremolo | `0x006A` |
| Filter | `0x0072` |
| Drive | `0x0076` |
| Enhancer | `0x007A` |
| Gate | `0x0092` |

### Captured goldens (byte-exact in `verify-msg`)

| Capture | Built by | Wire (with checksum) |
|---------|----------|----------------------|
| Slot 2 → none | `buildSetBlockType(2, 0)` | `F0 00 01 74 15 01 4E 01 10 00 01 00 00 00 04 00 00 00 00 00 00 4B F7` |
| Slot 3 → Reverb | `buildSetBlockType(3, 0x42)` | `F0 00 01 74 15 01 4E 01 11 00 01 00 00 00 04 00 00 00 10 44 10 0E F7` |
| Slot 4 → Amp | `buildSetBlockType(4, 0x3A)` | `F0 00 01 74 15 01 4E 01 12 00 01 00 00 00 04 00 00 00 0D 04 10 50 F7` |

The AM4-Edit filenames ("block-clear-to-none" etc.) didn't record which
slot the user targeted, so these were initially mis-labelled "slots 1/2/3".
Session 19 hardware mapping corrected that — pidHigh 0x10/0x11/0x12 are
device slots 2/3/4, leaving pidHigh 0x0F as slot 1 (no capture on disk,
but fits the linear pattern; verified live on hardware).

### Observation — related 0x0017 "action" traffic

Alongside the block-placement WRITE, AM4-Edit issues several bursts of a
different command shape: action byte `0x0017` (not WRITE `0x0001`) to
the placed block's own pidLow, with a zeroed 4-byte payload. The action
repeats 4–6× in a ~15 ms window after the placement WRITE. Hypothesis:
this is an initialization / defaults-reset broadcast for the newly-
placed block. Not required for placement itself — our builder emits only
the pidLow=0xCE WRITE and that matches the capture byte-for-byte. Revisit
if block placement without the 0x0017 burst misbehaves on hardware.

---

## 6d. Save-to-Slot Command 🟢

**Cracked Session 19** from `session-18-save-preset-z04.pcapng`. Persists
the AM4's current working buffer to one of the 104 preset slots. Uses
the same PARAM_RW function (0x01) as regular param writes, but with a
new action byte and pidLow/pidHigh of zero.

### Address

- **function** `0x01` (PARAM_RW).
- **pidLow** `0x0000`, **pidHigh** `0x0000` — save is a global action,
  not addressed to any block or parameter.
- **action** `0x001B` — dedicated save-to-slot action. Not observed in
  any other capture on disk.

### Payload

4-byte uint32 little-endian **slot index**, 0..103, packed with the same
8-to-7 septet encoder used for float payloads (§6b). Slot naming maps:
A01 → 0, A02 → 1, …, Z04 → 103. See `src/protocol/slots.ts` for the
parser/formatter.

### Captured golden (byte-exact in `verify-msg`)

| Capture | Built by | Wire (with checksum) |
|---------|----------|----------------------|
| Save to Z04 (slot 103) | `buildSaveToSlot(103)` | `F0 00 01 74 15 01 00 00 00 00 1B 00 00 00 04 00 33 40 00 00 00 7D F7` |

### Unresolved — save-ack shape

The save command produces a flurry of inbound SysEx in the 300 ms after
the send, but we haven't separated the save-specific ack from the
ambient polling/status traffic AM4-Edit is already running. The
`save_to_slot` MCP tool captures all inbound SysEx during the window
for future RE rather than asserting success on any particular shape.

### WRITE SAFETY

Saving overwrites the target slot. Only **Z04** (the designated scratch
slot) is safe to write during RE — every other slot holds factory
content or user work. The `save_to_slot` MCP tool hard-rejects any other
slot until factory-preset safety classification lands (P1-008).

---

## 6e. Rename (preset and scene) 🟢

**Cracked Session 19 (preset), Session 21 (scene)** from the capture
set `session-20-rename-preset.pcapng` + `session-20-rename-scene.pcapng`
(scene 1) + `session-22-rename-scene-{2,3,4}.pcapng`. Renaming a
preset or a scene uses a shared command shape with action byte `0x000C`
on the same block-slot register family (`pidLow=0x00CE`).

### Preset rename

- **function** `0x01` (PARAM_RW)
- **pidLow** `0x00CE`, **pidHigh** `0x000B`
- **action** `0x000C`
- **hdr4** `0x0024` = 36 raw payload bytes
- **Payload (36 raw):**
  - bytes 0..3: uint32 LE slot index (same encoding as save-to-slot)
  - bytes 4..35: 32-byte ASCII name, **space-padded** (0x20), not
    null-padded — the AM4 stores names fixed-width with trailing
    spaces. Non-printable / non-ASCII characters are rejected by
    the builder.

#### Captured golden (byte-exact in `verify-msg`)

| Capture | Built by | Wire (with checksum) |
|---------|----------|----------------------|
| Rename Z04 → "boston" | `buildSetPresetName(103, "boston")` | `F0 00 01 74 15 01 4E 01 0B 00 0C 00 00 00 24 00 33 40 00 00 03 09 5E 73 3A 1B 6D 62 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 00 09 F7` |

### Scene rename

Same envelope, same action (0x000C), same 36-byte payload shape as
preset rename, with two differences:
- **pidHigh** follows the linear pattern `0x0037 + sceneIndex`
  (scenes 1..4 → 0x0037 / 0x0038 / 0x0039 / 0x003A).
- Payload bytes 0..3 are **zeroed** — scene names are scoped to the
  working buffer, not a preset location.

#### Captured goldens (byte-exact in `verify-msg`)

| Capture | Built by | pidHigh |
|---------|----------|---------|
| Rename scene 2 → "clean"  | `buildSetSceneName(1, "clean")`  | `0x0038` |
| Rename scene 3 → "chorus" | `buildSetSceneName(2, "chorus")` | `0x0039` |
| Rename scene 4 → "lead"   | `buildSetSceneName(3, "lead")`   | `0x003A` |

Scene 1 rename (pidHigh `0x0037`) is covered by the Session 19g
capture and served as the anchor point for the linear map.

### Persistence — still open

Hardware test pending (HW-002 preset rename, HW-008 scene rename):
do these writes stick across a preset reload, or do they live in the
working buffer only until `save_to_location` runs? Scene rename is
explicitly working-buffer-scoped on the wire (zeroed slot field);
preset rename addresses a specific location but the AM4 may still
require an explicit save.

### Payload packing — chunked (7 raw → 8 wire)

The 36-byte payload exposed the chunked packing rule the sliding-window
algorithm (§6b) actually follows for long payloads: **every 7 raw
bytes restart the sliding window**, producing 8 packed bytes per full
chunk + (R+1) packed bytes for a trailing R-byte partial chunk. A 36-
byte payload packs as 5 full chunks (40 packed bytes) + 1 partial
chunk (2 packed bytes) = 42 total. Small payloads (≤ 7 raw) are
unaffected — the 4-byte float in SET_PARAM and the 4-byte slot in
SAVE_TO_SLOT still pack as N+1 bytes. `packValueChunked` /
`unpackValueChunked` in `src/protocol/packValue.ts` implement the
correct chunking.

### WRITE SAFETY

Same as save-to-slot — `set_preset_name` is hard-gated to Z04 until
P1-008 relaxes the restriction. `set_scene_name` is NOT gated
because it writes to the working buffer only; the scene names land
at a stored location only if the caller explicitly follows up with
`save_to_location`.

---

## 6f. Scene-switch + Preset-switch (active-preset navigation) 🟢

Two reads/writes that change what the AM4 currently plays without
modifying any stored preset. Both live on the same
`pidLow=0x00CE` register family as block placement and rename, but
differ in payload encoding.

### Scene switch (confirmed Session 21)

- **pidLow** `0x00CE`, **pidHigh** `0x000D`
- **action** `0x0001` (standard WRITE)
- **Payload** (4 raw): uint32 LE scene index `0..3` (0 ↔ UI scene 1,
  3 ↔ UI scene 4).

Decoded across `session-18-switch-scene.pcapng` (scene 2) +
`session-21-switch-scene-1-3-4.pcapng` (scenes 1/3/4). Byte-exact
goldens for all four scenes in `verify-msg`. `buildSwitchScene` +
`switch_scene` MCP tool.

### Preset switch (confirmed Session 21)

- **pidLow** `0x00CE`, **pidHigh** `0x000A`
- **action** `0x0001` (standard WRITE)
- **Payload** (4 raw): **IEEE 754 LE float32** of the preset location
  index (A01 → 0.0, Z04 → 103.0).

**Encoding note:** float32 is unusual here — scene-switch, save-to-
slot, and preset-rename all use u32 LE for their index fields. Preset
switch is the only command in the family using float32. Both
encodings coexist on the same register; readers must distinguish by
pidHigh (0x000A → float, 0x000D → u32).

Decoded from `session-22-switch-preset-via-ui.pcapng` (user clicked
A01 → A02 → A01 in AM4-Edit, yielding float 1.0 and float 0.0
writes). Byte-exact goldens for locations 0 and 1 in `verify-msg`.
`buildSwitchPreset` + `switch_preset` MCP tool.

### UX implication

`switch_preset` loads the target location into the working buffer,
**discarding any unsaved edits**. Callers should confirm intent
before issuing after a session of `apply_preset` / `set_param`
activity. The MCP tool description carries this warning; upstream
prompt behavior is the founder's call.

---

## 6g. Command ack shape (save / rename) 🟢

**Confirmed 2026-04-19** on hardware across both save and rename.
Addressing-only commands — `save_to_location`, `set_preset_name`,
`set_scene_name` — return an **18-byte** ack that echoes the
outgoing command's addressing fields with a zero payload:

```
F0 00 01 74 15 01
   <pidLow septets> <pidHigh septets> <action septets>
   00 00 00 00
   <cksum> F7
```

Concrete captures:

- Save ack (pidLow=0x0000, pidHigh=0x0000, action=0x001B):
  `F0 00 01 74 15 01 00 00 00 00 1B 00 00 00 00 00 0A F7`
- Preset-rename ack (pidLow=0x00CE, pidHigh=0x000B, action=0x000C):
  `F0 00 01 74 15 01 4E 01 0B 00 0C 00 00 00 00 00 59 F7`

Distinct from the 64-byte SET_PARAM write-echo (§6a, `hdr4=0x0028`
with a 40-byte param descriptor) and from the 23-byte USB-MIDI
receipt-echo of our own outgoing bytes. The `isCommandAck(sent,
resp)` predicate in `src/protocol/setParam.ts` exactly matches this
shape; 5/5 byte-exact goldens in `verify-msg` (2 positive, 3
negative including a full SET_PARAM 64-byte frame and an address-
mismatched ack).

No payload is returned — the ack is a "I received and parsed your
command" signal, not a state snapshot. If we want stored-preset
content back, we need a different request (the parked READ response
format in §13) or the payload bytes inside preset-switch / scene-
switch acks (§9 decode work, queued as BK-025 / BK-026).

---

## 6. Byte-Level Templates for Phase 1 Commands 🟡

All payloads below are **Axe-Fx II/AX8-derived guesses** for AM4. Expected
to work with just the model byte swapped, but verify every one on the
first sniff session.

### 0x08 GET_FIRMWARE_VERSION 🟢

```
Request:  F0 00 01 74 15 08 [CS] F7

Observed AM4 response (session 2026-04-14, firmware 2.00):
  F0 00 01 74 15 08 MAJ MIN R1 R2 R3 R4 R5 [build-date ASCII] 00 [nulls] [CS] F7

  Example: F0 00 01 74 15 08 02 00 03 04 05 00 00
           "Mar 20 2026 06:46:54" 00 00 00 00 00 00 00 00 00 00 00 00 67 F7

  MAJ = 0x02 (firmware major version 2)
  MIN = 0x00 (firmware minor version 0)
  R1..R5 = 03 04 05 00 00 (reserved, purpose unknown — stable across reads)
  Build date: null-terminated ASCII "Mon DD YYYY HH:MM:SS" format
  Null padding: appears to pad total response to a fixed length
```

**Note:** AM4 extends the Axe-Fx II format with a build-date string — the
prefix bytes through R5 are Axe-Fx II-compatible; everything after is AM4
(and probably newer Fractal products) specific.

After this request, the device is expected to begin broadcasting `0x21`
FRONT_PANEL_CHANGE_DETECTED whenever a front-panel value changes — behavior
not yet verified on AM4. Always send `0x42 DISCONNECT_FROM_CONTROLLER`
before closing the port.

### 0x14 GET_PRESET_NUMBER 🟢

```
Request:  F0 00 01 74 15 14 [CS] F7

Observed AM4 response (session 2026-04-14):
  F0 00 01 74 15 14 PP QQ [CS] F7

  Example: F0 00 01 74 15 14 00 00 04 F7
           decode14(0x00, 0x00) = 0 → slot A01
```

AM4 has 104 slots (A01–Z04), which fits in 7 bits — the high byte (QQ) is
expected to always be 0x00 in practice, but the decoding treats it as a
full 14-bit value for forward compatibility.

### 0x0F GET_PRESET_NAME 🔴 REJECTED on AM4

```
Request:  F0 00 01 74 15 0F [CS] F7

Observed AM4 response (session 2026-04-14):
  F0 00 01 74 15 64 0F 05 7E F7
  → MULTIPURPOSE_RESPONSE acknowledging 0x0F with result code 0x05

The command is parsed and checksum-validated, but AM4 returns a non-OK
result code. The actual preset-name query must use a different function
ID on AM4. Candidates to try on the next session:
  - 0x09 (Axe-Fx II SET_PRESET_NAME may be dual-purpose on AM4)
  - 0x0E PRESET_BLOCKS_DATA (may carry name in its payload)
  - Sniff AM4-Edit loading a preset and look for the name query
  - Scan function IDs 0x30–0x50 for unmapped responses
```

### 0x3C SET_PRESET_NUMBER

```
Request:  F0 00 01 74 15 3C PP QQ [CS] F7
          PP = preset # bits 0-6
          QQ = preset # bits 7-13 (expected to be 0 for AM4)

Expected response:
          F0 00 01 74 15 64 3C 00 [CS] F7   (0x64 MULTIPURPOSE_RESPONSE, OK)
```

### 0x64 MULTIPURPOSE_RESPONSE 🟢

The AM4's generic ACK / NACK for commands that don't have their own
structured response. Format:

```
F0 00 01 74 15 64 FN RC [CS] F7
  FN = function ID being acknowledged
  RC = result code
```

### Result codes (observed)

| RC | Meaning | Observed on |
|----|---------|-------------|
| 0x00 | OK / accepted | `0x12` mode switch |
| 0x05 | Command parsed, not honored (unsupported or invalid in current state) | `0x0F` GET_PRESET_NAME |

Treat any result code ≠ 0x00 as "we guessed wrong — investigate." The
parser should dispatch on `FN` to associate the ACK with the originating
request.

### 0x02 GET/SET_BLOCK_PARAMETER_VALUE

The heart of the live-tweak MVP. Request payload:

```
Request:  F0 00 01 74 15 02 B0 B1 P0 P1 V0 V1 V2 M [CS] F7
          B0 B1 = block ID (14-bit, bits 0-6 then 7-13)
          P0 P1 = parameter ID (14-bit, same encoding)
          V0 V1 V2 = parameter value (16-bit, bits 0-6 / 7-13 / 14-15)
          M = 0x00 query, 0x01 set

Expected response:
          F0 00 01 74 15 02 B0 B1 P0 P1 V0 V1 V2 L1 L2 ... Lk 00 [CS] F7
          Lk = parameter label as null-terminated ASCII, e.g. "GAIN"
```

**Special parameter ID 255 (0xFF 0x01) = bypass/engage:**

```
Engage block:  payload = B0 B1 FF 01 00 00 00 01
Bypass block:  payload = B0 B1 FF 01 01 00 00 01
```

Note: the above is the wiki-documented **Axe-Fx II** shape. The AM4's
per-block bypass is a different shape — regular SET_PARAM at a dedicated
pidHigh. See §6h below.

---

## 6h. Per-block Bypass Register 🟢

**Decoded Session 27** from `session-23-scene-{2,3,4}-{amp,drive,reverb}-bypass`
and `session-23-scene-2-amp-unbypass`. Toggles a block between active
and bypassed on the currently-active scene. The write itself carries no
scene index — the AM4 is stateful and scopes the bypass to whichever
scene is active right now (same rule that applies to channel switches
and SET_PARAM writes; see Session 23 / HW-009).

### Address

- **function** `0x01` (PARAM_RW).
- **pidLow** = the block's own pidLow (amp=`0x003A`, drive=`0x0076`,
  reverb=`0x0042`, delay=`0x0046`, etc. — see `BLOCK_TYPE_VALUES` in
  `src/protocol/blockTypes.ts`). Confirmed identical across amp, drive,
  and reverb captures — the `0x0003` pidHigh is shared by every block
  type that can be bypassed.
- **pidHigh** `0x0003` — per-block bypass flag.
- **action** `0x0001` (WRITE).

### Value

4-byte IEEE 754 float32 little-endian, septet-packed per §6b:
- **`1.0`** (raw `00 00 80 3F`, packed `00 00 10 03 78`) — block is
  **bypassed** (silent, but still in the slot with all params intact).
- **`0.0`** (raw `00 00 00 00`, packed `00 00 00 00 00`) — block is
  **active** (audible).

### Captured goldens (byte-exact in `verify-msg`)

| Capture | Built by | Wire |
|---------|----------|------|
| Amp bypass ON (scene 2) | `buildSetBlockBypass(0x003A, true)` | `F0 00 01 74 15 01 3A 00 03 00 01 00 00 00 04 00 00 00 10 03 78 46 F7` |
| Drive bypass ON (scene 3) | `buildSetBlockBypass(0x0076, true)` | `F0 00 01 74 15 01 76 00 03 00 01 00 00 00 04 00 00 00 10 03 78 0A F7` |
| Reverb bypass ON (scene 4) | `buildSetBlockBypass(0x0042, true)` | `F0 00 01 74 15 01 42 00 03 00 01 00 00 00 04 00 00 00 10 03 78 3E F7` |
| Amp bypass OFF (scene 2) | `buildSetBlockBypass(0x003A, false)` | `F0 00 01 74 15 01 3A 00 03 00 01 00 00 00 04 00 00 00 00 00 00 2D F7` |

### Scene-scoping is the caller's responsibility

The wire write is scene-agnostic. To bypass a block on scene N:

1. `buildSwitchScene(n)` — select the target scene.
2. `buildSetBlockBypass(blockPidLow, bypassed)` — write. The AM4 stores
   the new bypass flag against scene N internally.

This is the same pattern as scene-to-channel mapping (§Session 27 — no
dedicated scene-channel command; channel switch under an active scene
self-scopes) and channel-scoped param writes (HW-009). It's the
consequence of the AM4's stateful model: scenes are selectors, not
containers of their own param state.

### Observation — 0x0017 "action" traffic (same as §6c)

Every bypass capture is bracketed by the same `action=0x0017,
pidHigh=0x3E81, payload=0` bursts seen around block-placement writes:
two fires 15–20 ms apart BEFORE the real WRITE, two more fires AFTER.
AM4-Edit appears to be state-refreshing around every write. Not
required by the protocol — our builder emits only the real WRITE and
that matches byte-exact.

---

## 6i. Advanced-Controls Capture (HW-015 / Session 29) 🟢

**Captured 2026-04-21** (12 pcapngs under `samples/captured/session-29-*`).
Disambiguates knobs that cache signatures alone couldn't pin — Amp
Master/Depth/Presence/Out-Boost (toggle + level), delay/flanger/phaser
Feedback, and spring-reverb-specific reverb knobs.

### Key finding — Master/Presence correction

`pidHigh=0x000F` on the Amp block was registered as `amp.presence` in
Session 26 from cache signature alone. Two independent captures on
Marshall-family amps (`session-29-amp-master` + `session-29-amp-master-2`
on Brit 800 #34) proved the register is **Master**, not Presence. The
real Presence knob lives at `pidHigh=0x001E` (confirmed by
`session-29-amp-presence` on the same amp). Knob ordering on the Amp
Edit page for a master-volume amp is therefore:

| pidHigh | Knob |
|---------|------|
| `0x000B` | Gain |
| `0x000C` | Bass |
| `0x000D` | Mid (structural, HW-014 pending) |
| `0x000E` | Treble (structural, HW-014 pending) |
| `0x000F` | **Master** |
| `0x001A` | **Depth** |
| `0x001E` | **Presence** |

Cache signatures for 0x000D / 0x000E are identical to the confirmed
Master/Depth/Presence entries, so Mid and Treble are likely correct —
HW-014 spot-check remains the final verification step.

### New addresses captured this session

| Block | pidHigh | Param | Unit | Capture |
|-------|---------|-------|------|---------|
| amp (`0x003A`) | `0x0008` | `out_boost_level` | db 0..4 | `session-29-amp-output-level` |
| amp (`0x003A`) | `0x000F` | `master` | knob_0_10 | `session-29-amp-master` + `session-29-amp-master-2` |
| amp (`0x003A`) | `0x001A` | `depth` | knob_0_10 | `session-29-amp-depth` |
| amp (`0x003A`) | `0x001E` | `presence` | knob_0_10 | `session-29-amp-presence` |
| amp (`0x003A`) | `0x0096` | `out_boost` | enum OFF/ON | `session-29-amp-out-boost-toggle` |
| delay (`0x0046`) | `0x000E` | `feedback` | bipolar_percent ±100 | `session-29-delay-feedback` |
| flanger (`0x0052`) | `0x000E` | `feedback` | bipolar_percent ±99 | `session-29-flanger-feedback` |
| phaser (`0x005A`) | `0x0010` | `feedback` | bipolar_percent ±90 | `session-29-phaser-feedback` |
| reverb (`0x0042`) | `0x000F` | `size` | percent 0..100 | `session-29-reverb-size` + `-plate-size` |
| reverb (`0x0042`) | `0x001B` | `springs` | count 2..6 | `session-29-reverb-number-of-springs` |
| reverb (`0x0042`) | `0x001C` | `spring_tone` | knob_0_10 | `session-29-reverb-spring-tone` |

11 new goldens in `verify-msg` (one per pidHigh). Master also appears
twice in the capture set (two different amp types); any future
Marshall-amp rebuild can cross-reference either capture.

### AM4-Edit uses `action=0x0002` for these writes

**Quirk worth documenting.** All 12 captures show AM4-Edit emitting
SET_PARAM writes with `action=0x0002` at bytes 10–11, not the
`action=0x0001` our builder uses (and that every prior confirmed capture
used). Value-byte packing matches byte-for-byte between builder and
capture; only the action field (and the derived checksum) differ.
Both action values are accepted by the AM4 in practice — our builder's
0x0001 path has been verified on hardware across Sessions 04–28 — so
this is a version or mode difference on AM4-Edit's side, not a protocol
change. Goldens in `verify-msg` encode the builder's canonical
`action=0x0001` output; the captures are cited for value-byte
verification, not for the full 23-byte envelope match.

### Reverb Size is universal per reverb type

`reverb.size` at `pidHigh=0x000F` was confirmed on two captures — "Plate
Size" on a Plate reverb and "Size" on a Room/Hall reverb. Same wire
register, type-dependent UI label. Spring-specific knobs at `0x001B`
(springs) and `0x001C` (spring_tone) were captured only on a Spring
reverb; the registers are writable on any reverb type but AM4-Edit
exposes the UI only under Spring.

---

## 6j. Reverb First-Page Coverage + Predelay Fix (HW-018 / HW-025 / Session 30) 🟢

**Captured 2026-04-25** (7 pcapngs under `samples/captured/session-30-*`).
Two parallel investigations wrapped in one capture batch:

### BK-033 — `reverb.predelay` address fix

HW-014 had flagged `reverb.predelay` at `pidHigh=0x0010` as a dead
address (writes wire-acked but firmware ignored them). HW-025 capture
#1 (`session-30-reverb-predelay.pcapng`, Pre-Delay → 85 ms) revealed
AM4-Edit writes to **`pidLow=0x0042 / pidHigh=0x0013`** with
`float32(0.085)` — confirming both the correct address and the
existing `unit: 'ms'` ÷1000 scale. The cache record at id=16 (0x10)
that originally pointed at predelay is structurally plausible (range
0..0.25s, scale ×1000) but firmware-dead; the corrected entry now
lives hand-authored in `params.ts` and the cache name is removed
from `paramNames.ts` so the generator no longer emits the wrong
mapping. Byte-exact golden in `verify-msg`.

### BK-034 — `chorus.rate / flanger.mix / flanger.feedback / phaser.mix` proven not-a-bug

HW-014 reported these four params as encoding mismatches based on
AM4 hardware-display readbacks. HW-025 captures #2..#5 prove
**AM4-Edit's wire is byte-identical to our builder's** for the same
target values:

| Param | Capture | Wire address | Wire value (float32 LE) | Display value |
|---|---|---|---|---|
| `chorus.rate` | `session-30-chorus-rate` | `0x004e/0x000c` | `3.4` | 3.4 Hz |
| `flanger.mix` | `session-30-flanger-mix` | `0x0052/0x0001` | `0.54` | 54% |
| `flanger.feedback` | `session-30-flanger-feedback` | `0x0052/0x000e` | `-0.61` | -61% |
| `phaser.mix` | `session-30-phaser-mix` | `0x005a/0x0001` | `0.88` | 88% |

The HW-014 hardware-display divergence is therefore an AM4
hardware-screen rendering quirk (or HW-014 channel-state artifact),
**not** a wire-layer encoding bug. All four `params.ts` entries
keep their existing addresses and units; comments updated to
record the wire-equivalence. Verify these four params via
AM4-Edit, not the AM4 hardware display, until the screen-side
rendering is characterised. Four byte-exact goldens in
`verify-msg`.

### HW-018 — Reverb Basic-Page first-page completion

`session-30-reverb-basic-hall.pcapng` (Hall, Medium) and
`session-30-reverb-spring.pcapng` (Spring, Large) captured every
knob the founder wiggled on AM4-Edit's reverb Config page for both
types. Cross-referenced against the cache and the founder's
screenshot inventory; ten new universal/algorithmic-reverb /
Spring-engine registers landed:

| Block | pidHigh | Param | Unit | Range | Notes |
|-------|---------|-------|------|-------|-------|
| reverb | `0x000C` | `high_cut` | hz | 200..20000 | Universal. Hall final 7000 Hz (numeric input field, action=0x0001). |
| reverb | `0x0014` | `low_cut` | hz | 20..2000 | Universal. |
| reverb | `0x0017` | `input_gain` | percent | 0..100 | Universal. Spring final 0.8217 → 82.17% matches screenshot 82.2 %. |
| reverb | `0x0018` | `density` | count | 4..8 | Hall-only (algorithmic). Cache typecode 16 = small-int. |
| reverb | `0x0024` | `dwell` | knob_0_10 | 0.1..10 | Spring-only. Final 0.4741 → 4.741 matches screenshot 4.74. |
| reverb | `0x0027` | `stereo_spread` | bipolar_percent | -200..+200 | Hall-only. Cache exposes wider firmware range than the AM4-Edit UI's 0..100 % knob. |
| reverb | `0x0028` | `ducking` | db | 0..80 | Universal. Cache range matches AM4-Edit's "Ducking 46.9 dB" knob. |
| reverb | `0x002F` | `quality` | enum | ECONOMY / NORMAL / HIGH / ULTRA-HIGH | Hall-only (algorithmic CPU-quality selector). |
| reverb | `0x0030` | `stack_hold` | enum | OFF / STACK / HOLD | Hall-only. |
| reverb | `0x0034` | `drip` | percent | 0..100 | Spring-only. Final 0.9183 → 91.83% matches screenshot 91.8 %. |

**Same `action=0x0002` quirk** as HW-015 — AM4-Edit's continuous
slider drags use action=0x0002 at bytes 10–11; numeric-input-field
single-shot writes use action=0x0001. Our builder always emits
0x0001; goldens encode the builder's canonical form. Both action
values are firmware-accepted (verified across Sessions 04..29).

**Unidentified register at `pidHigh=0x0000`.** Both Hall and
Spring captures wrote 12 / 7 times respectively to
`pidLow=0x0042 / pidHigh=0x0000` with continuous-slider value
patterns (final ≈0.56 / 0.74). The cache has no metadata at id=0
for the reverb block. Most likely candidate is `reverb.level` (the
output-level dB knob shown on the right side of the screenshot
config page), but the wire encoding doesn't match a raw-dB
interpretation of the screenshot's -5.6 dB. Left unregistered;
future single-knob capture would resolve it.

**Tooling addition.** `scripts/extract-final-writes.ts` aggregates
multi-knob capture sweeps to "final value per pidHigh," which is
the right shape for HW-018-style multi-wiggle captures (HW-015
captured one knob per pcapng, where extract-writes.ts is enough).

---

## 6k. Cabinet Block — `pidLow=0x003e` (HW-041 / Session 38) 🟢

**Captured 2026-04-30** (`samples/captured/session-41-amp-cabinet-
expert.{pcapng,png}` + ALIGN modal screenshot).

**Finding.** The amp Expert page surfaces 4 UI tabs (Preamp / Power
Amp / Cabinet / Speaker) but spans **two block IDs** on the wire:

| Tab | pidLow | Verified |
|---|---|---|
| Preamp | `0x003a` (amp) | session-41 + prior session-40 |
| Power Amp | `0x003a` (amp) | session-41 |
| Cabinet | **`0x003e`** | session-41 (this section) |
| Speaker | `0x003a` (amp) | session-41 |

This is the first AM4 block we've observed split across two pidLows.
All other blocks audited so far (drive, delay, reverb, chorus,
flanger, phaser, wah, peq, geq, rotary, compressor, gate, tremolo,
filter, enhancer, volpan, ingate) live entirely at one pidLow.

### Discovery method

The first cabinet audit run (`pidLow=0x003a`, default for amp)
returned 0 distinct pidHighs. Frame-distribution analysis on the
46-char OUT writes in the cabinet capture showed:

| pidLow byte pair | Count | Block |
|---|---|---|
| `3e 00` (0x003e) | 3517 | **cabinet (new)** |
| `4e 01` (0x00ce) | 735 | (modulation/scene addressing) |
| `3a 00` (0x003a) | 1000 | amp (Level + Section bypass only) |
| 0x003e small writes | 30+ | various single-knob wiggles |

The bulk of cabinet knob writes target `pidLow=0x003e`. Only
`amp.level` (`pidHigh=0x0000`) and `amp.section` (`pidHigh=0x0023`)
hit `pidLow=0x003a` from the Cabinet tab — both are global
amp-block toggles surfaced as a sticky header above all four tabs.

### Registered cabinet params (16 of 54 captured pidHighs)

All in `src/protocol/params.ts` HW-041 block under the `amp.cab*` /
`amp.room_*` / `amp.air_*` / `amp.mic_*` / `amp.align_*` prefixes:

`amp.cab1_distance` / `amp.cab1_high_cut` / `amp.cab2_low_cut` /
`amp.cab2_high_cut` / `amp.cab_mic_preamp_drive` /
`amp.cab_mic_preamp_saturation` / `amp.cab_mic_preamp_treble` /
`amp.cab_master_high_cut` / `amp.cab_master_low_cut` /
`amp.cab_master_level` / `amp.room_size` / `amp.room_diffusion` /
`amp.air_frequency` / `amp.mic_spacing` / `amp.align_distance_1` /
`amp.align_distance_2`.

### Deferred decode work

- Cab 1 / Cab 2 Position knobs use a bipolar -10..10 wire format
  (no existing unit fits).
- Cab 1 / Cab 2 Low Cut store Hz as `wire/1000` (44.4 Hz → wire
  0.0444), unlike the Master Low Cut (raw Hz). Likely log-Hz or
  kHz storage convention.
- ~20 enum dropdowns (Cab Mode, Cab IR/Mic IDs, Slope dB/Oct,
  Bypass Modes, Room Shape, etc.) need enum tables built.
- LF/HF Damping ambiguity (three pidHighs share value 8.0) needs
  a single-knob wiggle to disambiguate.

Full audit report: `docs/audit-output/amp-cabinet.md`.

### Block prefix decision

Cabinet entries are keyed under the existing `amp.*` block in
`KNOWN_PARAMS` (not a new `cab.*` block) since AM4 surfaces all
four Expert tabs to the user as a single "Amp" block — the protocol
split is internal. Each `cab*` entry's `pidLow` field is set to
`0x003e`; the rest of the amp block continues to use `pidLow=0x003a`.

---

## 6l. Main Levels page — `pidLow=0x002A` (HW-067a closed Session 84, 2026-05-16) 🟢

**Decoded end-to-end** from `samples/captured/session-84-levels.pcapng`
against the founder's on-screen anchor values (preset.level=1.1 dB,
preset.balance=2.2, scene 1-4 levels 3.33/4.44/5.55/6.66 dB).
Decoded params now live in `packages/am4/src/params.ts` under the
`preset.*` block.

### Confirmed mapping (anchors match wire 1:1)

| Param | pidLow | pidHigh | Action | Wire float | Display | Unit / scale |
|---|---|---|---|---|---|---|
| `preset.level` | `0x002A` | `0x0000` | `0x0001` | 1.1100 | 1.1 dB | `db` (raw passthrough) |
| `preset.balance` | `0x002A` | `0x0002` | `0x0001` | 0.0222 | 2.2 | `bipolar_percent` (×100) |
| `preset.scene_1_level` | `0x002A` | `0x0018` | `0x0001` | 3.3300 | 3.3 dB | `db` |
| `preset.scene_2_level` | `0x002A` | `0x0019` | `0x0001` | 4.4400 | 4.4 dB | `db` |
| `preset.scene_3_level` | `0x002A` | `0x001A` | `0x0001` | 5.5500 | 5.5 dB | `db` |
| `preset.scene_4_level` | `0x002A` | `0x001B` | `0x0001` | 6.6600 | 6.7 dB | `db` |

### Resolutions of Session 50's open questions

1. **Value encoding scale (Q1, closed):** display = wire 1:1 for dB
   params, ×100 for `bipolar_percent` balance. The Session 46 capture
   showed 0..1-range floats because that was a *normalized-drag*
   action — see Q2.
2. **Action `0x0002` vs `0x0001` (Q2, closed):** AM4-Edit 2.00 +
   firmware 2.00 use the **standard `action=0x0001`** for this
   register family — same action our existing `buildSetParam` already
   sends. No `buildSetParam` extension needed. The Session 46
   `action=0x0002` writes were from an older AM4-Edit version
   doing live-drag continuous writes; the new version sends a single
   discrete commit on knob release.
3. **Scene 3 / 4 confirmation (Q3, closed):** wire-verified —
   pidHighs `0x001A` and `0x001B` accept writes and the values land
   1:1 with the displayed dB readout.
4. **Adjacent registers `0x001C..0x0025` (Q4, partial):** the
   Session 84 capture also wrote to `0x001C`/`0x001D`/`0x001E` with
   values 7.77/8.88/9.99 (likely Output / Master Level knobs) and
   to `0x001F..0x0025` with descending dB values -9 .. -3 (these
   are 7 of the 10 Preset EQ bands). Final naming pending a directed
   capture that pins each pidHigh → frequency-band correspondence.

### Code status

**Wired into `params.ts`:** `preset.level` / `preset.balance` /
`preset.scene_1_level..preset.scene_4_level`. Standard `buildSetParam`
(action=0x0001) works. `set_param(block='preset', name='level',
value=1.1)` writes 1.1 dB; `set_param(block='preset',
name='scene_2_level', value=-4.0)` writes -4 dB to scene 2's level.

**Goldens:** verify-msg covers `preset.level` / `preset.balance` /
`preset.scene_1_level` against captured wire bytes from
`session-84-levels.pcapng`. Pack/unpack roundtrip exercised via
the existing 10-sample verify-pack.

### Legacy decode (Session 50, superseded)

The text below documents what was known after the Session 46
capture, before the Session 84 follow-up. Kept for traceability.

---

## 6l-old. Main Levels page — Session 46 / Session 50 partial decode 🟡 (superseded)

**Captured Session 46 by founder (delivered Session 50, 2026-05-07):**
`samples/captured/session-46-main-levels.pcapn.pcapng` (filename note
— typo `.pcapn.pcapng` is intentional, file is the canonical capture
for HW-067). 517 OUT 23-byte writes in the segment of interest;
chronology cut off mid-way through scene 2 sweep so scene 3 / scene 4
sweeps were not captured.

**Finding.** AM4-Edit's Main Levels page (HOME → PAGE RIGHT 2× on the
device) writes to a **new register family**: `pidLow=0x002A` with
**action `0x0002`** (not the standard `0x0001` that every other AM4
write tool uses today via `ACTION_WRITE`).

### Confirmed addresses (from sweep chronology)

| Param | pidLow | pidHigh | action | Sweep window | Writes |
|---|---|---|---|---|---|
| `preset.level` | `0x002A` | `0x0000` | `0x0002` | t = 15.372 .. 30.4 | 119 |
| `preset.balance` | `0x002A` | `0x0002` | `0x0002` | t = 30.483 .. 37.632 | 49 |
| `scene_level_1` | `0x002A` | `0x0018` | `0x0002` | t = 41.244 .. 52.364 | 55 |
| `scene_level_2` | `0x002A` | `0x0019` | `0x0002` | t = 55.449 .. 58.564 | 17 |

### Inferred (untested — capture truncated before these sweeps)

| Param | pidLow | pidHigh | Basis |
|---|---|---|---|
| `scene_level_3` | `0x002A` | `0x001A` | Linear continuation of scenes 1 & 2 |
| `scene_level_4` | `0x002A` | `0x001B` | Linear continuation of scenes 1 & 2 |

Both were also touched by AM4-Edit's at-attach bulk-state push at
t ≈ 1 s (19 + 21 writes respectively, values clustered near 0.5),
which corroborates that those addresses are valid registers — but
no directed sweep is on disk for either one.

### Wire payload layout

Same envelope as every `0x01` PARAMETER_R/W message (§6a). Only the
header field values differ:

```
F0 00 01 74 15 01 [2A 00] [pidH_lo pidH_hi] [02 00] [00 00] [04 00] [packed 5b float] [cs] F7
```

Per-cluster float ranges across the four confirmed sweeps:

| Param | First (pre-sweep) | Min | Max |
|---|---|---|---|
| `preset.level` | 0.7968 | 0.7968 | 1.0000 |
| `preset.balance` | 0.4825 | 0.4825 | 1.0000 |
| `scene_level_1` | 0.5048 | 0.5048 | 1.0000 |
| `scene_level_2` | 0.4905 | 0.4905 | 1.0000 |

All four sweeps end at exactly 1.0000, suggesting the user finished
each sweep at the maximum knob position. Mins are mid-range (0.48-0.80)
rather than 0.0, which means either the sweeps did not reach the
true minimum, or the float representation is bipolar / log-scaled
rather than linear-from-zero.

### Open questions

1. **Value encoding scale.** The wire is a 4-byte IEEE 754 LE float
   in 0..1 range. The AM4 manual specifies preset.level in dB and
   scene_level as ±20 dB. Mapping float ↔ dB is unconfirmed without
   founder display anchors (HW-067 plan asked for "per-knob display
   values you wiggled" — those weren't captured in the delivery, so
   this needs a follow-up).
2. **Action `0x0002` vs `0x0001`.** Existing AM4 write code uses
   `ACTION_WRITE = 0x0001`. AM4-Edit's Main Levels writes are
   `0x0002`, and AM4-Edit's at-attach bulk-state push for amp.level
   / amp.out_boost_level also uses `0x0002` — yet our `set_param`
   pipeline reaches the same registers with `0x0001` and the device
   accepts the writes. Hypothesis: action `0x0002` is a "live-drag
   continuous write" variant; `0x0001` is a "discrete commit" that
   also lands. Hardware test required before tools commit to either.
3. **Scene 3 / 4 confirmation.** Linear-continuation hypothesis
   (`pidH=0x001A`, `0x001B`) is well-supported by the at-attach
   bulk-push but was not directly swept on disk.
4. **Adjacent registers `0x001C..0x0025`.** Bulk-state push touched
   12 more `pidLow=0x002A` pidHighs with values near 0.5 — likely
   per-scene balance and/or other per-scene/preset params. Out of
   scope for HW-067; flag for a future capture if needed.

### Code status

**Not yet wired into `params.ts` or `verify-msg`.** Reason: action
`0x0002` is novel and the value scale is unconfirmed. Adding entries
that send action `0x0001` may work but isn't validated; sending
`0x0002` requires generalising `buildSetParam` to take an action
override. Both deferred until a follow-up directed test confirms
which action(s) the device actually accepts on this register family
and pins the dB scale.

Decoder script: `scripts/decode-main-levels.ts` — extracts every OUT
23-byte write from a `*.tshark.txt` dump, groups by `(pidLow,
pidHigh, action)`, and prints the chronology with float / u32 / i32
interpretations. Reusable for other Main-Levels-style decodes.

---

## 6m. READ_PRESET_NAME — non-destructive stored-preset name read (HW-070 / Session 50) 🟢

**Decoded Session 50 (2026-05-07) byte-exact** from
`samples/captured/session-46-am4edit-launch-device-connected.midi-events.txt`
and the parallel "Refresh Preset Names" capture
`samples/captured/session-46-refresh-after-new-firmware.midi-events.txt`.
Both captures show the same 104-message OUT/IN loop AM4-Edit fires to
populate its preset list. See `docs/preset-read-research.md` for the
full investigation, hypothesis space, and end-to-end name corpus
round-trip.

This is the **read-direction sibling** of the rename WRITE (action
`0x000C`) that already lived on `pidLow=0x00CE pidHigh=0x000B`. The
register family was the natural place to look — and the action `0x0012`
turned out to be exactly correct, with an OUT request that addresses
the location by index and an IN response that returns the 32-byte
ASCII name verbatim.

### Wire shape (host -> device, 23 bytes)

- **function** `0x01` (PARAM_RW)
- **pidLow** `0x00CE`, **pidHigh** `0x000B` (shared with rename WRITE)
- **action** `0x0012` (NEW — read variant of rename register)
- **hdr4** `0x0004` = 4 raw payload bytes
- **payload** (4 raw): uint32 LE location index `0..103` (0 = A01, 103 = Z04)

```
F0 00 01 74 15 01
   4E 01    pidLow = 0x00CE
   0B 00    pidHigh = 0x000B
   12 00    action = 0x0012  -- READ_PRESET_NAME (new with HW-070)
   00 00    hdr3 = 0
   04 00    hdr4 = 4
   <5 packed bytes>     -- u32 LE location, sliding-window packed (§6b)
   <cs> F7
```

### Captured goldens (byte-exact in `verify-msg`)

| Capture | Built by | Wire (with checksum) |
|---------|----------|----------------------|
| Read A01 (loc 0) | `buildGetPresetName(0)` | `F0 00 01 74 15 01 4E 01 0B 00 12 00 00 00 04 00 00 00 00 00 00 43 F7` |
| Read A02 (loc 1) | `buildGetPresetName(1)` | `F0 00 01 74 15 01 4E 01 0B 00 12 00 00 00 04 00 00 40 00 00 00 03 F7` |
| Read Z04 (loc 103) | `buildGetPresetName(103)` | `F0 00 01 74 15 01 4E 01 0B 00 12 00 00 00 04 00 33 40 00 00 00 30 F7` |

### Wire shape (device -> host, 55 bytes)

- **function** `0x01` (echoes request)
- **pidLow / pidHigh / action** echo the request (`0x00CE / 0x000B / 0x0012`)
- **hdr4** `0x0020` = 32 raw payload bytes
- **payload** (32 raw): C-style ASCII name, NUL-terminated within the
  32-byte buffer. Bytes between the name and the NUL are 0x20-padded;
  bytes after the NUL are uninitialised (typically 0x20 with a final
  0x00). Empty locations return the literal 7-character sentinel
  `<EMPTY>` followed by NUL + uninitialised buffer.

```
F0 00 01 74 15 01
   4E 01    pidLow = 0x00CE
   0B 00    pidHigh = 0x000B
   12 00    action = 0x0012
   00 00    hdr3 = 0
   20 00    hdr4 = 32
   <37 packed bytes>    -- 32 ASCII chars, sliding-window chunked (§6e)
   <cs> F7
```

The IN payload does NOT include the location index — AM4-Edit
correlates request-with-response by arrival order, sending its 104
requests serially.

### Captured response goldens (byte-exact in `verify-msg`)

| Source frame | Location | Decoded | Wire (with checksum) |
|---|---|---|---|
| session-46-launch frame 47 | A01 (loc 0) | `"AM4 Gig Rig"` | `F0 00 01 74 15 01 4E 01 0B 00 12 00 00 00 20 00 20 53 26 42 02 1D 52 67 10 14 4D 16 39 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 00 00 40 F7` |
| session-46-launch frame 419 | X02 (loc 93) | `<EMPTY>` (isEmpty=true) | `F0 00 01 74 15 01 4E 01 0B 00 12 00 00 00 20 00 1E 11 29 55 02 51 32 3E 00 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 02 01 00 40 20 10 08 04 00 00 38 F7` |

### Code

- **Builder:** `buildGetPresetName(locationIndex)` in
  `src/fractal/am4/setParam.ts`.
- **Parser:** `parseGetPresetNameResponse(bytes, expectedLocation)` in
  the same file. Returns `{ location, name, isEmpty }`. Empty-detection
  is a string compare against `PRESET_NAME_EMPTY_SENTINEL` (`'<EMPTY>'`)
  after C-string truncation at the first NUL and trailing-space trim.
- **MCP tools:** `am4_get_preset_name({ location })` and
  `am4_scan_locations({ from, to })` in `src/fractal/am4/tools/read.ts`
  (sharing `readPresetName` from `src/server/shared/readOps.ts`).

### Performance

A full 104-location scan completes in ~350 ms wall-clock (~3.4 ms per
read including the USB MIDI round-trip). One bank (4 locations) is
~14 ms — effectively instant. The single-shot read for one location is
under 5 ms in practice.

### Non-destructive properties

- Working buffer state is preserved across the read.
- No preset switch is issued.
- No traffic touches `pidHigh=0x000A` (preset switch register) or any
  block-placement register.
- Two independent capture triggers (cold AM4-Edit launch + the explicit
  "Refresh Preset Names" UI button) emit identical wire patterns,
  confirming this is the canonical command for non-destructive name
  reads.

---

## 6n-patch. PATCH family — preset-scoped routing + scene-MIDI + 4CM (Session 84, 2026-05-16) 🟢

**pidLow = 0x00CE** — same register family that hosts block-placement
(pidHigh=0x0010+slot-1) and preset rename (pidHigh=0x000B). PATCH is
the umbrella for every preset-scoped param that isn't a block
parameter: routing toggles, scene-output config, 4CM mode, and the
4-message-per-scene MIDI sequencer.

**Decoded against Ghidra catalog case_0x3c** — the 85 `PATCH_*`
paramIds map directly to pidHighs via the §6p rule (`pidHigh = paramId`).
Capture: `samples/captured/session-84-routing-mix-midi.pcapng`.

### Confirmed wire writes from Session 84

| Time | pidLow | pidHigh | paramId | Catalog name | Wire value | Meaning |
|---|---|---|---|---|---|---|
| 11.29s | 0x00CE | 0x0014 | 20 | `PATCH_ROUTING_SLOT2` | 1.0 | FX2 → Parallel |
| 14.80s | 0x00CE | 0x0014 | 20 | `PATCH_ROUTING_SLOT2` | 0.0 | FX2 → Series |
| 17.99s | 0x00CE | 0x0015 | 21 | `PATCH_ROUTING_SLOT3` | 1.0 / 0.0 | FX3 routing |
| 24.22s | 0x00CE | 0x0016 | 22 | `PATCH_ROUTING_SLOT4` | 1.0 / 0.0 | FX4 routing |
| 56.83s | 0x00CE | 0x0040 | 64 | `PATCH_SCENE_1_MIDI_MSG_1` | 1.0 | Scene 1 MIDI msg type → PC |
| 1.00s | 0x00CE | 0x0050 | 80 | `PATCH_SCENE_1_MIDI_CH_1` | 2.0 / 3.0 | Scene 1 MIDI channel |
| 1.00s | 0x00CE | 0x0060 | 96 | `PATCH_SCENE_2_MIDI_CH_1` | 4.0 | Scene 2 MIDI channel |

### Routing encoding

Series/Parallel is a binary float: **Series = 0.0, Parallel = 1.0**.
Wire bytes match the standard 5-byte packed float envelope —
`buildSetParam('preset.routing_slot_2', 1)` produces the exact bytes
AM4-Edit sends for "Parallel."

### Anomaly: action=0x0017 at pidHigh=0x3E81

One write at t=30.41s addresses `pidHigh = 0x3e81` (16,001 decimal —
well past any 85-entry catalog) with `action = 0x0017`. Likely an
encoded multi-byte MIDI-message write that packs `(scene, message_idx,
field)` into the pidHigh and uses a different action than the standard
0x0001. Out of scope for first-pass PATCH support; needs a dedicated
capture sweeping scene N's MIDI message M field to decode the packing.

### Shipped MCP-addressable params

`packages/am4/src/params.ts` now exposes:
- `preset.routing_slot_2` (enum: Series / Parallel)
- `preset.routing_slot_3` (enum: Series / Parallel)
- `preset.routing_slot_4` (enum: Series / Parallel)

Standard `buildSetParam` (action=0x0001) handles the write. Verified
byte-exact against the capture via `verify-msg.ts` goldens.

### Pending (catalog known, wire-untested)

The remaining 34 PATCH catalog params are wire-addressable in
principle (same pidLow + §6p rule) but each needs a directed capture
to confirm the value encoding for enum-typed dropdowns:
- 4× `PATCH_SCENE_N_OUTPUT` (scene output mode)
- 1× `PATCH_4CM` (4-cable method toggle)
- Plus 29 remaining items — see Ghidra catalog `case_0x3c` (85 total).

**Scene-MIDI closed Session 85+86 (2026-05-16) — see §6n-scene-midi
below.** That sub-section covers the 48 `PATCH_SCENE_N_MIDI_*` params
(message type, channel, value byte across 4 scenes × 4 message slots)
that were listed here as pending in Session 84.

---

## 6n-scene-midi. Scene MIDI message bank (PATCH cols 0x40–0x6F) 🟢

Closed Session 85 + 86 (2026-05-16) via two captures:
- `samples/captured/session-85-scene-midi.pcapng` + `.png`
- `samples/captured/session-86-scene-midi-disambiguate.pcapng` + `.png`

Each preset has 4 scenes, each scene carries 4 outgoing MIDI message
slots, each slot has 3 fields (Type / Channel / Value byte). Total:
**48 wire-addressable params**, all on **standard SET_PARAM
action=0x0001 with `hdr4=0x0004`** and a packed-float value. **No
custom action needed**; identical envelope to every other AM4
SET_PARAM write in §6a.

### Wire layout

```
F0 00 01 74 15 01 [4E 01] [pidHigh_lo 00] [01 00] [00 00] [04 00]
                                                          ^^^^^
                                                          hdr4=0x0004
[5-byte packed float] [cs] F7
```

- `pidLow = 0x00CE` (PATCH family — same as routing, preset rename,
  block placement, etc.).
- `pidHigh = base_row + (scene - 1) * 4 + (msg - 1)`
  - `base_row 0x40` → Type field
  - `base_row 0x50` → Channel field
  - `base_row 0x60` → Value field

That gives 16 columns (4 scenes × 4 message slots) on each of the 3
rows. Scene is the outer loop, message slot is the inner — confirmed
Session 86 by the disambiguating captures `(s=1, m=2)` → col 1 and
`(s=3, m=1)` → col 8.

### Type enum

AM4-Edit's UI exposes only Program Change and Control Change as
message types. The wire encoding folds the CC# into the Type enum
itself:

| Wire value | Display | Notes |
|---|---|---|
| `0.0` | `None` | No message — Channel/Value greyed out in UI |
| `1.0` | `PC` | Program Change — Channel + Value carry MIDI data |
| `N ≥ 2.0` | `CC #(N-2)` | Control Change with CC# = N-2 |

Confirmed against `session-85-scene-midi.png`: AM4-Edit displays
`CC #016` when the wire carries `Type = 18.0` (16 + 2 = 18). Display
format uses three-digit zero-padded CC numbers with a space and hash
(`CC #016`, not `CC16`), to match AM4-Edit's exact rendering.

Defined as `SCENE_MIDI_TYPE_ENUM` in `packages/am4/src/params.ts`
(generated at module init: `{ 0: 'None', 1: 'PC' }` plus a 128-entry
loop for the CC range).

### Channel field

Wire value is `1..16` as a raw float (MIDI channel, 1-indexed display
matches AM4-Edit). When the founder picks the default channel (1)
without changing it, AM4-Edit emits NO wire write for that field —
captured in `session-85`'s `(s=4, m=1)` cluster where Type and Value
wrote but Channel did not.

### Value field

Wire value is `0..127` as a raw float — the MIDI program number (for
PC) or controller value (for CC).

### Shipped MCP-addressable params

48 entries in `packages/am4/src/params.ts`:
- `preset.scene_{1..4}_midi_{1..4}_type`     (16 params — enum, see above)
- `preset.scene_{1..4}_midi_{1..4}_channel`  (16 params — count 1..16)
- `preset.scene_{1..4}_midi_{1..4}_value`    (16 params — count 0..127)

Byte-exact goldens in `scripts/verify-msg.ts`:
- 9 from session-85 + session-86 covering 3 distinct columns × all
  3 field rows (`(s=1,m=1)`, `(s=1,m=2)`, `(s=3,m=1)`).
- 2 from session-85's CC capture — `(s=4,m=1)` Type=`CC #016` (wire 18)
  and Value=127, locking the PC/CC encoding rule.

Plus 5 `verify-enum-lookup` goldens covering the Type enum: `None`,
`PC`, `CC #000`, `CC #016` (the session-85 anchor), `CC #127`.

### One observed quirk for future captures

AM4-Edit resets the **message-slot cursor to 1** when you switch
scenes from the GUI. The Session 85 capture was intended as scene N →
msg N, but the founder's writes after each scene switch landed in
msg slot 1 every time (visible in `session-85-scene-midi.png`).
Doesn't change the wire spec — the formula fits all 5 datapoints
under the as-captured reading — but worth knowing for future
scene-MIDI captures: explicitly re-click the target message-slot row
after switching scenes, or you'll only ever exercise col 0/4/8/12.

### Out of scope (still pending in PATCH family)

Session 87 (2026-05-16) cross-reference audit corrected two phantom
items from this list:

- ~~4× `PATCH_SCENE_N_OUTPUT`~~ — these are the **Scene N Level**
  knobs, already shipping as `preset.scene_{1..4}_level`. The catalog
  symbol is Fractal's internal name; AM4-Edit labels them "Scene N
  Level." Caught by `scripts/_research/coverage-cross-ref-audit.ts`
  joining XML display names to catalog symbols.
- ~~1× `PATCH_4CM`~~ — confirmed **firmware ghost**. No AM4-Edit UI
  control. The 4CM concept exists only as a wiring pattern in the
  AM4 owner's manual (rear-panel Send/Return + VP4); there is no
  software toggle on AM4. Flagged GHOST in the cross-ref audit.

Still pending: ~29 Ghidra `case_0x3c` items in the catalog with no
XML control (likely firmware-internal calc state, not user-facing
knobs).

The Session 84 `pidHigh=0x3E81 action=0x0017` anomaly is **NOT** on
the scene-MIDI critical path. Session 87 capture
`session-87-scene-midi-test-buttons.pcapng` clicked all 16 per-row
test-send "▶" buttons and produced **zero** `action=0x0017` frames —
ruling out test-message buttons as the trigger. Anomaly trigger
remains unknown. What WAS discovered: per-row and per-scene "Send
All" buttons fire `action=0x0004 / pidHigh=0x0070` — see §6n-scene-
midi-test below.

---

## 6n-scene-midi-test. Scene MIDI test-send command (`pidLow=0x00CE`, `pidHigh=0x0070`) 🟢

Decoded Session 87 (2026-05-16) via two captures of AM4-Edit's
Scene MIDI page test-send buttons:
- `samples/captured/session-87-scene-midi-test-buttons.pcapng` —
  16 clicks of per-row "▶" test-send buttons (one per scene-msg cell).
- `samples/captured/session-87-scene-top-midi-test-buttons.pcapng` —
  4 clicks of per-scene "Send All" top buttons (one per scene column).

**This is NOT a working-buffer write.** It's a transient trigger
register telling the AM4 to emit the MIDI message that's already
authored at the targeted scene-msg row (via §6n-scene-midi). The
configured (type, channel, value) for that row is sent out the
AM4's MIDI OUT. No persistent state change.

### Wire shape (standard SET_PARAM envelope)

```
F0 00 01 74 15 01 [pidLow=0x00CE] [pidHigh=0x0070] [action=0x0001] [hdr3=0x0000] [hdr4=0x0004] [5 packed bytes] [cs] F7
```

- `pidLow = 0x00CE` — PATCH family, same as §6n-scene-midi.
- `pidHigh = 0x0070` — fixed; distinct from the scene-MIDI auth rows
  at 0x40/0x50/0x60.
- `action = 0x0001` — standard SET_PARAM write.
- `hdr4 = 0x0004` — 4-byte raw payload (float32), septet-packed to
  5 wire bytes (same convention as every other dB/float register in
  the AM4 protocol).
- Payload (after septet unpacking) is a single **float32 trigger value**
  encoding which row to fire.

### Trigger value encoding (unified for per-row and Send All)

```
trigger_float32_value = scene_index + (high_byte << 8)
  scene_index = 0..3  (scene 1..4)
  high_byte   = 0..3  (per-row: msg_index 0..3)
              = 0xFF (per-scene Send All sentinel — "fire all 4 msgs")
```

The "scene index in low byte, mode-selector in high byte" pattern
matches the AM4's other one-shot trigger registers in §6a.

**Per-row clicks** (16 frames from session-87-scene-midi-test-buttons):

| Click # | (scene, msg) 0-idx | trigger float32 | unpacked raw bytes |
|---|---|---|---|
| 1 | (0, 0) | `0.0` | `00 00 00 00` |
| 2 | (1, 0) | `256.0` | `00 00 80 43` |
| 3 | (2, 0) | `512.0` | `00 00 00 44` |
| 4 | (3, 0) | `768.0` | `00 00 40 44` |
| 5 | (0, 1) | `1.0` | `00 00 80 3F` |
| 6 | (1, 1) | `257.0` | `00 80 80 43` |
| 7 | (2, 1) | `513.0` | `00 40 00 44` |
| 8 | (3, 1) | `769.0` | `00 40 40 44` |
| 9 | (0, 2) | `2.0` | `00 00 00 40` |
| 10 | (1, 2) | `258.0` | `00 00 81 43` |
| 11 | (2, 2) | `514.0` | `00 80 00 44` |
| 12 | (3, 2) | `770.0` | `00 80 40 44` |
| 13 | (0, 3) | `3.0` | `00 00 40 40` |
| 14 | (1, 3) | `259.0` | `00 80 81 43` |
| 15 | (2, 3) | `515.0` | `00 C0 00 44` |
| 16 | (3, 3) | `771.0` | `00 C0 40 44` |

**Per-scene Send All clicks** (4 frames from
session-87-scene-top-midi-test-buttons):

| Click # | scene_index 0-idx | trigger float32 | interpretation |
|---|---|---|---|
| 1 | 0 | `65280.0` (=`0xFF00`) | scene 1, all msgs |
| 2 | 1 | `65281.0` (=`0xFF01`) | scene 2, all msgs |
| 3 | 2 | `65282.0` (=`0xFF02`) | scene 3, all msgs |
| 4 | 3 | `65283.0` (=`0xFF03`) | scene 4, all msgs |

Decoder reference: `scripts/_research/decode-hw110.ts` (chronological
per-write detail; pairs with `decode-main-levels.ts` shape).

### Companion `action=0x0008` zero-payload frames

The Send All capture also contained 12 follow-up frames at
`t=32.32..32.35 s` with `action=0x0008` and empty payload at the
scene-MIDI authoring pidHighs (`0x48-0x4B / 0x58-0x5B / 0x68-0x6B`,
i.e. scene 3's Type/Channel/Value cells). Hypothesis: a "refresh
display" or "post-test state restore" pulse AM4-Edit emits to flush
its UI back to the authored values. Not part of the trigger
protocol — surfaces only when AM4-Edit is in the loop.

### What's still open

- **action=0x0017 anomaly** at `pidHigh=0x3E81` remains undecoded.
  Session 87 ruled out per-row test-send buttons as the trigger
  (HW-110 ✅). Send All buttons also ruled out (use action=0x0001).
  Remaining hypotheses: "Quick Build" page action, AM4-Edit File →
  Send / Refresh, or a notification-side frame the device emits for
  some other UI affordance. Needs a fresh directed capture.
- **action=0x0008 semantics** — see "Companion frames" above. Low
  priority; AM4-Edit-internal pulse, not on the agent-write path.

### Potential MCP tool

Once the per-row payload is decoded, a `am4_send_scene_midi_test_now`
tool becomes possible: takes `(scene, msg_index | 'all')` and fires
the corresponding `action=0x0004 / pidHigh=0x0070` frame. Useful for
agent-driven "preview how scene 2 will affect my monitor amp"
workflows. Not in scope for v0.1; capture the requirement here so
it's available when the protocol lands fully.

---

## 6n. Save-intent composites (`am4_apply_preset_at`, `am4_apply_setlist`) 🟢

Session 50 (2026-05-07): two MCP tools that orchestrate existing wire
primitives into atomic save-intent flows. **No new wire commands are
introduced.** Both operations are purely a sequence of
already-decoded primitives, gated by a single up-front validation pass.

`am4_apply_preset_at({ location, preset })` runs:
1. `buildSwitchPreset(location)` (§6f preset-switch)
2. The full `am4_apply_preset` wire pass (block placements §6c, channel
   writes §6a, params §6a, scene channels / bypass §6h, scene names §6e,
   working-buffer rename §6e)
3. `buildSaveToLocation(location)` (§6d)

`am4_apply_setlist({ presets, on_error, dry_run })` is the batch wrapper:
validates every entry up front (location parsing, uniqueness, full
prepare-pass shape check), then runs the same switch+apply+save sequence
for each entry in order. Failure handling is `stop` (default) or
`continue`; `dry_run` validates without emitting any wire bytes.

The switch-first step keeps the AM4's display label aligned with the
working-buffer content for the duration of each build, so a user looking
at the device mid-batch sees the slot being saved into. Direct-to-slot
writes that bypass the working buffer entirely are queued for v0.1.x
once the preset binary format decode lands (see
`docs/preset-binary-format-research.md` and BK-036). Until then these
composites are working-buffer-mediated by construction.

Goldens in `verify-msg`: byte-exact concatenated wire sequences for a
1-block 1-scene `am4_apply_preset_at` and a 2-entry `am4_apply_setlist`
batch, plus a validation-failure case (duplicate location across the
batch) that proves no wire bytes leave the host on rejection.

---

## 6o. REQUEST_ACTIVE_BUFFER_DUMP (HW-045 / Session 51) 🟡

**Decoded Session 51 (2026-05-08) byte-exact** from
`samples/captured/session-51-export-preset.tshark.txt`. AM4-Edit's
File -> Export Preset menu, clicked with no stored preset selected,
emits this single 11-byte SysEx; the device replies with the canonical
6-message preset-dump stream documented in §10b. See
`docs/preset-dump-request-research.md` for the full investigation,
hypothesis space, and stored-preset variant gap.

This is a **new function byte** (`0x03`) — not part of the 0x01
PARAM_RW family, not part of the 0x77 / 0x78 / 0x79 dump-stream family.
Distinct payload pattern (`7F 7F 00`) too: the two `0x7F` bytes mirror
the active-buffer sentinel that appears in the response 0x77 header's
bank field, and the trailing `0x00` is constant across the captured
frame.

### Wire shape (host -> device, 11 bytes)

- **function** `0x03` (REQUEST_PRESET_DUMP — active-buffer variant)
- **payload** (3 raw bytes):
  - byte 0 = `0x7F` — active-buffer sentinel (matches the response
    header's bank=0x7F convention)
  - byte 1 = `0x7F` — second sentinel (also `bank` slot in the addressing
    pair; mirrored for the active-buffer case)
  - byte 2 = `0x00` — constant; possibly a request-type discriminator
    or a reserved byte
- **checksum** XOR of all preceding bytes & 0x7F (computed via
  `fractalChecksum`, NOT hardcoded — `0x13` in the captured frame)

```
F0 00 01 74 15 03
   7F          payload[0] = active-buffer sentinel
   7F          payload[1] = active-buffer sentinel (mirrored)
   00          payload[2] = constant
   <cs>        checksum (= 0x13 in capture)
   F7
```

### Captured golden (byte-exact in `verify-msg`)

| Capture | Built by | Wire (with checksum) |
|---------|----------|----------------------|
| Active-buffer export | `buildRequestActiveBufferDump()` | `F0 00 01 74 15 03 7F 7F 00 13 F7` |

### Wire shape (device -> host, 6 messages, 12,352 bytes)

The device responds with the canonical preset-dump stream documented
in §10b: 1x `0x77` header (13 B) + 4x `0x78` chunks (3,082 B each) +
1x `0x79` footer (11 B). The 0x77 header payload carries
`bank=0x7F sub=0x00 [00 20 00]` for an active-buffer dump (vs.
`bank, sub` carrying the actual location bytes for a stored-preset
dump). Total response size = 13 + 4*3082 + 11 = 12,352 bytes —
matches the per-preset count in the factory bank file.

### Captured response goldens (frame metadata in research doc)

| # | Time | fn | Wire size |
|---|------|----|----|
| 1 | 14.262 | 0x77 | 13 B |
| 2 | 14.262 | 0x78 | 3082 B |
| 3 | 14.262 | 0x78 | 3082 B |
| 4 | 14.263 | 0x78 | 3082 B |
| 5 | 14.263 | 0x78 | 3082 B |
| 6 | 14.264 | 0x79 | 11 B |

The 6 messages typically arrive within ~2 ms wall-clock between the
first 0x77 frame and the final 0x79 frame; the full request-to-response
window in the capture was about 250 ms including USB bus latency.

### Code

- **Builder:** `buildRequestActiveBufferDump()` in
  `src/fractal/am4/setParam.ts`. No parameters — active buffer is
  implicit. Returns the 11-byte request above.
- **Receiver:** `receivePresetDumpStream(conn, options?)` in
  `src/fractal/am4/presetDump.ts`. Listens for the 6-message reply,
  validates each envelope + length + function byte + checksum, asserts
  ordering (header before chunks before footer), and returns the
  structured result `{ bank, sub, totalBytes, messageCount,
  headerBytes, chunkBytes, footerBytes }`.
- **MCP tool:** `am4_request_active_buffer_dump()` in
  `src/fractal/am4/tools/navigation.ts`.

### Non-destructive properties

- Working buffer state is preserved across the dump.
- Active stored-location pointer is preserved.
- No audible side effects.
- Two-way symmetry with the response-side 0x77 header: `bank=0x7F`
  on both sides means "the working buffer".

### Stored-preset variant — still partially blocked

The captured frame is the **active-buffer** path only. A stored-preset
dump request (e.g. dumping A01 or Z04 without affecting the working
buffer) is a plausible second mode that would replace the `7F 7F`
sentinels with the location's `bank, sub` bytes (matching the response
header's encoding documented in §10b). This is consistent with H1 in
`docs/preset-dump-request-research.md` §2 but has not been captured
on hardware. HW-045 is parked at 🟡 partial pending one more capture
of File -> Export Preset against a specifically-clicked stored preset.

### Primary use case

The BK-036 probe series. `am4_apply_preset` sets the working buffer
to a known state; `am4_request_active_buffer_dump` captures the
masked stored-form bytes; the harness diffs against a baseline to
map byte-to-param relationships. The chunk content is NOT decoded;
the tool surfaces the raw bytes for the probe harness.

---

## 6p. Parameter ID structure — `pidLow` = block, `pidHigh` = paramId (Session 82) 🟢

**Decoded Session 82 (2026-05-16) via Ghidra mining of AM4-Edit.exe.**
Workflow + tooling: [`docs/ghidra-mining-workflow.md`](ghidra-mining-workflow.md).

The two 14-bit header fields `pidLow` and `pidHigh` in the §6a
parameter envelope aren't arbitrary handles — they encode a clean
`(block, param-within-block)` tuple. Confirmed at 99% match rate
(246 of 249 non-generic non-AMP entries) against our hand-decoded
`packages/am4/src/params.ts`.

### Mapping

| Field | Semantics |
|---|---|
| `pidLow` | Block-type identifier. Matches the `BLOCK_TYPE_VALUES` constants in `packages/am4/src/blockTypes.ts` (e.g. `amp = 0x003a`, `reverb = 0x0042`, `compressor = 0x002e`, `cabinet = 0x003e`, …). |
| `pidHigh` ∈ [10, 0x3FFF] | Per-block parameter index. **Equals the paramId** of the corresponding entry in AM4-Edit's per-effect param-table dispatcher (`FUN_1402e3da0`). The dispatcher's tables are arrays of `{ int paramId, int padding, const char* nameStr }` 16-byte structs; paramId is the same int that appears in `pidHigh`. |
| `pidHigh` ∈ [0, 9] | Generic shared params — paramId values < 10 are NOT in the per-effect dispatcher catalog (which starts at paramId 10), so these are cross-block conventions. Documented to date: |
| | • `0x0000` → block output level (14 blocks confirmed via captures) |
| | • `0x0001` → wet/dry mix (15 blocks confirmed) |
| | • `0x0002` → stereo balance (16 blocks confirmed; **but `amp.cab1_distance` uses this slot under the cab block — verify whether cab's slot 2 truly is balance or has a per-cab meaning**) |
| | • `0x0004` → bypass mode / Thru / Mute / Mute FX Out / Mute FX In / Mute Out (11 blocks confirmed) |
| | • `0x0007` → seen on `delay.kill_dry` only — verify whether other blocks have a kill-dry generic at slot 7 |
| | • `0x0008` → seen on `amp.out_boost_level` only — possibly generic, possibly amp-only |
| | (`0x0003`, `0x0005`, `0x0006`, `0x0009` undocumented; see §9 for channel-state register at `pidHigh=0x07D2`) |
| `pidHigh = 0x07D2` (2002) | Per-block channel-select register. Separate from the param dispatcher; used by §9 scene→channel writes. |

### Why this matters

- **Any Ghidra catalog entry directly yields its AM4 wire address.**
  Given a catalog `(family=REVERB, paramId=15, name=REVERB_SIZE)`,
  the wire bytes are `pidLow=0x0042, pidHigh=0x000F`. No further
  binary analysis is needed to derive wire addresses for the rest
  of the 1,732 catalog entries — and no further USB captures.

- **Existing hand-decoded params are validated.** The 99% match
  rate proves our capture-driven decode of pidLow/pidHigh values
  is correct. The 1% that don't match are all `*.channel` entries
  at `pidHigh=0x07D2` — a separate code path, not a typo.

- **Cross-device generalization.** Axe-Edit III's parallel
  dispatcher (`FUN_140397a40`) yields the same `(paramId, nameStr)`
  pairs for shared block families. The III's wire envelope for
  SET_PARAM uses a different shape (effectId + paramId; see
  [`docs/SYSEX-MAP-AXE-FX-III.md`](SYSEX-MAP-AXE-FX-III.md)) — but
  the `paramId` value itself is shared with AM4.

### Ghidra-extracted catalog

| | AM4 | Axe-Fx III |
|---|---|---|
| Dispatcher fn | `FUN_1402e3da0` | `FUN_140397a40` |
| Effect-family cases | 50 (1..0x3c) | 49 (1..0x3b) |
| Total paramId/name pairs | 1,732 | 2,216 |
| AM4-only families | PATCH (case 0x3c) | — |
| III-only families | — | FC, PRESET |

The AMP block has **no separate dispatcher case** — it shares the
DISTORT family (case 0xa, 143 catalog params) with the DRIVE block,
addressed via different pidLow values:

| Block | pidLow | Shared param family |
|---|---|---|
| amp | `0x003a` | DISTORT (case 0xa) |
| drive | `0x0076` | DISTORT (case 0xa) |

Confirmed via AM4-Edit's `__block_layout.xml`:

```xml
<EditorControls name="Amp"
  parameters="DISTORT_DRIVETYPE,DISTORT_EQTYPE,DISTORT_FBTYPE,
              DISTORT_BETA,DISTORT_BIASTYPE,
              DISTORT_MODE_1,DISTORT_MODE_2">
```

Cross-validated against our hand-decoded `amp.*` params: 93 of 93
non-generic, non-channel-register entries match the DISTORT catalog
by `pidHigh = paramId`. The remaining 6 are 5 generic params
(pidHigh 0-9) + 1 channel-select register (pidHigh 0x07D2).

This means every UI-referenced DISTORT_* paramId is addressable on
AM4 at BOTH `pidLow=0x003a` (amp) AND `pidLow=0x0076` (drive). The
generator (`scripts/_research/generate-am4-params-from-catalog.ts`)
emits proposed entries for both blocks.

### AM4 UI block name → Ghidra family

Full mapping from `__block_layout.xml` `<EditorControls name="X">`
to the dispatcher's effect-family:

| UI name | Family | Case | AM4 pidLow | Notes |
|---|---|---|---|---|
| Amp | DISTORT | 0xa | 0x003a | ← shared with Drive |
| Drive | DISTORT | 0xa | 0x0076 | ← shared with Amp |
| Cab | CABINET | 0xb | 0x003e | |
| Compressor | COMP | 0x7 | 0x002e | |
| GraphicEQ | GEQ | 0x8 | 0x0032 | |
| ParametricEQ | PEQ | 0x9 | 0x0036 | |
| Reverb | REVERB | 0xc | 0x0042 | |
| Delay | DELAY | 0xd | 0x0046 | |
| Chorus | CHORUS | 0x10 | 0x004e | |
| Flanger | FLANGER | 0x11 | 0x0052 | |
| Rotary | ROTARY | 0x12 | 0x0056 | |
| Phaser | PHASER | 0x13 | 0x005a | |
| Wah | WAH | 0x14 | 0x005e | |
| Tremolo | TREMOLO | 0x16 | 0x006a | |
| Filter | FILTER | 0x18 | 0x0072 | |
| Enhancer | ENHANCER | 0x1a | 0x007a | |
| GateExpander | GATE | 0x23 | 0x0092 | |
| VolPan | VOLUME | 0x28 | 0x0066 | |
| DynamicDistortion | DYNDIST | 0x3b | — | not in current `blockTypes.ts` |

The XML EditorControls list also contains entries for blocks AM4 the
device may not support as placeable effects (Pitch, MultiDelay,
PlexDelay, MegaTap, Vocoder, Synth, etc.). These are likely
AxeEdit-family blocks the AM4-Edit codebase carries from the shared
Fractal source — verify hardware support before exposing as MCP
tools.

### Non-placeable addressable blocks

`packages/am4/src/blockTypes.ts` only lists the 17 blocks placeable
in AM4's 4 slots. But the wire format addresses additional system-
wide "blocks" via dedicated pidLow values. Documented so far:

| pidLow | Block | Catalog family | UI page | Notes |
|---|---|---|---|---|
| `0x0025` | Input Noise Gate (`ingate.*`) | INPUT (case 0x29) | "Input" | Not in `BLOCK_TYPE_VALUES` (not slot-placeable). Verified: our `ingate.threshold` pidHigh=10 matches `INPUT_THRESH` paramId 10. |
| `0x003e` | Cabinet | CABINET (case 0xb) | "Cab" or part of "Amp Expert" | §6k. AM4's amp Expert page Cabinet tab writes here. |

The PATCH family (case 0x3c, 85 params — AM4-specific) covers
scene-level config that isn't tied to a single block:

- `PATCH_SCENE_OUTPUT1..4` — per-scene output 1-4 enable/mute
- `PATCH_ROUTING_SLOT2..4` — inter-slot routing (parallel/serial)
- `PATCH_4CM` — Four Cable Method mode
- `PATCH_SCENE_N_MIDI_MSG_M / _CH_M / _VAL_M / _EXEC_M` — per-scene
  MIDI sends (4 messages × 4 scenes — sends external MIDI when a
  scene activates)
- `PATCH_AMP_CHA_COLOR..CHD_COLOR` — per-amp-channel color tags (UI)
- `PATCH_SCENE_N_MIDI_MENU`, `PATCH_SCENE_MIDI_CLEAR` — MIDI menu / clear

PATCH's pidLow has not yet been captured on hardware (no USB capture
of AM4-Edit firing routing/4CM/scene-MIDI changes). Likely
candidates: pidLow=0 (system-wide) or a dedicated patch-config
pidLow. **Future capture (HW-NNN) needed to confirm.**

Similarly, the GLOBAL family (case 0x1, 99 params in AM4 catalog)
covers system-wide settings (tuner mode, USB levels, output config,
tap-tempo mode, etc.). Its pidLow address path is also TBD — likely
similar to PATCH (pidLow=0 or a dedicated GLOBAL pidLow).

### Tooling

Regenerate the AM4 catalog locally (~30 sec):

```bat
scripts\ghidra\run-am4-paramnames.cmd
```

Audit `params.ts` against the catalog (~5 sec):

```bash
npx tsx scripts/_research/compare-am4-params-coverage-v2.ts
```

Auto-generate proposed `params.ts` entries for catalog params we
haven't hand-decoded yet:

```bash
npx tsx scripts/_research/generate-am4-params-from-catalog.ts
# outputs samples/captured/decoded/am4-params-proposed.ts (gitignored)
```

---

## 7. Parameter Value Encoding 🟡

### 14-bit IDs (block ID, parameter ID)

```
byte0 = id & 0x7F
byte1 = (id >> 7) & 0x7F
```

```typescript
const encode14 = (n: number): [number, number] => [n & 0x7F, (n >> 7) & 0x7F];
const decode14 = (b0: number, b1: number): number =>
  (b0 & 0x7F) | ((b1 & 0x7F) << 7);
```

### 16-bit parameter values (0–65534)

```
byte0 = value & 0x7F
byte1 = (value >> 7) & 0x7F
byte2 = (value >> 14) & 0x7F
```

```typescript
const encode16 = (v: number): [number, number, number] => [
  v & 0x7F, (v >> 7) & 0x7F, (v >> 14) & 0x7F,
];
const decode16 = (b0: number, b1: number, b2: number): number =>
  (b0 & 0x7F) | ((b1 & 0x7F) << 7) | ((b2 & 0x7F) << 14);
```

### 32-bit float (0x2E SET_TYPED_BLOCK_PARAMETER_VALUE only)

5 bytes, split 7+7+7+7+4 — rarely needed on AM4 since the integer form
(`0x02`) is simpler and covers the same parameters.

---

## 8. Block IDs 🟡

**⚠️ The numbers below are Axe-Fx II/AX8 block IDs. AM4 block IDs are
undocumented.** Historical pattern suggests the Fractal family keeps block
IDs stable across products where the block exists — but this is a
guess-and-check situation. Every ID below needs verification.

From the `Effects_list` wiki page (🟢 confirmed), AM4 has exactly these
blocks, one of each:

| Block | On AM4? | Likely ID (from Axe-Fx II/AX8, verify) |
|-------|---------|-----------------------------------------|
| Amp | ✅ 1 | 106 |
| Cab | ✅ 1 | 108 |
| Chorus | ✅ 1 | 116 |
| Compressor | ✅ 1 | 100 |
| Delay | ✅ 1 | 112 |
| Drive | ✅ 2 | 133, 134 |
| Enhancer | ✅ 1 | 135 |
| Filter | ✅ 1 | 131 |
| Flanger | ✅ 1 | 118 |
| Gate/Expander | ✅ 1 | 150 |
| Graphic EQ | ✅ 1 | 102 |
| Parametric EQ | ✅ 1 | 104 |
| Phaser | ✅ 1 | 122 |
| Reverb | ✅ 1 | 110 |
| Rotary | ✅ 1 | 120 |
| Tremolo/Panner | ✅ 1 | 128 |
| Volume/Pan | ✅ 1 | 127 |
| Wah | ✅ 1 | 124 |
| Controllers | system (no bypass, no channels) | 141 |
| Input Noise Gate | system (per-preset) | 139 |
| Output mixer | system (per-preset) | 140 |
| Scene MIDI | system | (Axe-Fx III-era block — ID unknown) |

Blocks the wiki explicitly says **NOT on AM4**: Crossover, Dynamic
Distortion, FXL (send/return), Formant, IR Player, Looper, Megatap Delay,
Mixer, Multi Delay, Multitap Delay, Multiband Compressor, Multiplexer,
Pitch, Plex Delay, Resonator, Ring Modulator, Synth, Ten-Tap Delay, Tone
Match, Vocoder. Don't probe these IDs.

### Block counts = max instances per preset

The `(N)` column on the `Effects_list` table is **how many instances of
that block type you can use in a single preset's chain**, not how many
distinct block IDs exist in the protocol. AM4 has `Drive (2)`, meaning a
single preset can contain up to two Drive blocks in its effect slots —
which is why Axe-Fx II exposes distinct `Drive 1` (133) and `Drive 2`
(134) block IDs for per-instance parameter addressing. Every other block
type on AM4 is limited to one instance per preset.

---

## 9. Scene & Channel Structure 🟡

### Scenes — from `Scenes.md`

- **Scene count on AM4: 4** 🟢 (confirmed). Scene index is 0–3 in SysEx,
  displayed as 1–4 on the device.
- Per-scene state: block bypass/engage + per-block channel selection +
  output level + MIDI commands (Scene MIDI block) + Control Switch states
  (though AM4/VP4 lack Control Switches per `Modifiers_and_controllers.md`).
- Routing (the grid) is fixed across all scenes.
- Scene numbering is 0-indexed in SysEx (0–3), 1-indexed on display (1–4).
- Function `0x29` GET/SET_SCENE_NUMBER — value `0x7F` in the payload means
  "query"; any other value is a set.

### Channels — from `Channels.md`

- 4 channels per block (A, B, C, D). Each channel is effectively a mini
  preset — all parameters are stored independently per channel.
- Switching is gapless.
- Per-block channel selection is stored per-scene.
- Axe-Fx III/FM9/FM3 use MIDI CC values 0/1/2/3 for channel A/B/C/D — AM4
  behavior not documented; Function `0x11` GET/SET_BLOCK_XY is the likely
  SysEx equivalent.
- On AM4/VP4 the Controllers block has no channels (unlike Axe-Fx III/FM9).

---

## 10. Modifiers & Controllers 🟡

From `Modifiers_and_controllers.md`:

- **16 modifiers per AM4 preset** (vs 24 on Axe-Fx III/FM9/FM3).
- **4 external controllers** on AM4 (vs 16 on Axe-Fx III/FM9/FM3).
- **No Control Switches** on AM4/VP4 (big siblings have them).

### Internal controller sources

LFO, Sequencer, ADSR, Envelope Follower, Pitch Detector.

### Modifier parameter selectors (Function 0x07)

Axe-Fx II/AX8 exposes modifier fields via a selector byte in the payload:

| Selector | Parameter |
|----------|-----------|
| 0x0 | Source (which controller) |
| 0x1 | Min |
| 0x2 | Max |
| 0x3 | Start |
| 0x4 | Mid |
| 0x5 | End |
| 0x6 | Slope |
| 0x7 | Damping |
| 0x8 | (reserved) |
| 0x9 | (reserved) |
| 0xA | Auto engage |
| 0xB | PC reset |
| 0xC | Off value |
| 0xD | Scale |
| 0xE | Offset |

---

## 10b. Preset Dump Commands (0x77 / 0x78 / 0x79) 🟢

Confirmed from AM4-Edit's `.syx` export (session 03, 2026-04-14, A01 preset).
The librarian uses a header-chunks-footer protocol — literally the same bytes
for file-based `.syx` and over-the-wire upload per the Fractal Presets Update
Guide (`samples/factory/`).

### Anatomy of a single-preset dump (12,352 bytes total)

```
Msg 1  offset 0       13B    func 0x77  PRESET_DUMP_HEADER
Msg 2  offset 13      3082B  func 0x78  PRESET_DUMP_CHUNK (1 of 4)
Msg 3  offset 3095    3082B  func 0x78  PRESET_DUMP_CHUNK (2 of 4)
Msg 4  offset 6177    3082B  func 0x78  PRESET_DUMP_CHUNK (3 of 4)
Msg 5  offset 9259    3082B  func 0x78  PRESET_DUMP_CHUNK (4 of 4)
Msg 6  offset 12341   11B    func 0x79  PRESET_DUMP_FOOTER
```

### 0x77 PRESET_DUMP_HEADER

Observed: `F0 00 01 74 15 77 7F 00 00 20 00 38 F7` (export of currently-loaded
preset; 7F here is the "active slot" sentinel).

- Payload — 5 bytes — decoded 2026-04-29 against the factory bank:
  - `payload[0]` — bank index. 0x00..0x19 (A..Z). For an export of the
    active preset, AM4-Edit emits the sentinel `0x7F` instead of the real
    bank index.
  - `payload[1]` — sub-index within bank. 0x00..0x03 (preset 1..4).
  - `payload[2..4]` — constants `00 20 00`. Stable across all 104 factory
    dumps and all observed exports. Likely a fixed payload-size hint.
- `38 F7` — checksum + SysEx end.

Decode method: `samples/factory/AM4-Factory-Presets-1p01.syx` is exactly
104 × 12,352 bytes — a clean concatenation of all 104 factory preset
dumps. `scripts/verify-preset-dump.ts` parses it, then prints a
distinct-value count for each header-payload byte across the 104 dumps:
byte[0] takes 26 distinct values (banks A..Z), byte[1] takes 4 (preset
1..4 within each bank), bytes[2..4] are constant. No hardware capture
was needed — the bank file is the canonical encoding.

### 0x78 PRESET_DUMP_CHUNK

Format observed: `F0 00 01 74 15 78 [chunk_header:2?] [data:~3072] [cs] F7`

- Each chunk is 3082 bytes total. Envelope = 8 bytes. Payload ≈ 3074 bytes.
- Chunk 1 starts with a different data signature than chunks 4–5 — chunks 4–5
  are mostly zeros (preset padding for unused slots / channels).
- The diff between two exports (A01 with gain=3 vs A01 with gain=4) shows that
  within chunks 2–3 the bytes differ pervasively (>90% of the active region),
  while chunks 4–5 are almost entirely identical. This pattern is consistent
  with **scrambled or XOR-masked payload data**, not plaintext — see §11.

### 0x79 PRESET_DUMP_FOOTER

Observed: `F0 00 01 74 15 79 71 6F 00 77 F7`

- Payload `71 6F 00` — 3 bytes. Most likely a whole-preset checksum or data-
  integrity value. Changes when any data byte changes (the 4-byte diff in the
  0x3000 window during the gain-change test lands in the footer).
- `77 F7` — checksum + SysEx end.

### Upload semantics

Per `samples/factory/README AM4+VP4 Presets Update Guide.pdf`: the same byte
sequence that exports a preset can be sent back to the device via the librarian
(Fractal-Bot) to upload it. No transformation needed. This is how a preset
write-to-slot will work in our encoder — concatenate `[0x77 header] [0x78 × 4
chunks] [0x79 footer]`, stream the bytes over the AM4 MIDI Out, wait for the
device's MULTIPURPOSE_RESPONSE ACK.

**Target location for the dump** is encoded in `payload[0..1]` of the
0x77 header (decoded 2026-04-29 — see the §10b 0x77 entry above). For
backup-and-restore, a verbatim re-emit of a captured dump goes back to
the source location. Restoring to a *different* location requires
overwriting `payload[0..1]` with the target bank/sub-index and
recomputing the header checksum — see `serializePresetDump` in
`src/protocol/presetDump.ts` for the round-trip primitive.

**Factory-restore tools** `am4_restore_factory` and
`am4_restore_factory_range` orchestrate same-location replay of the
factory bank's stored-form bytes (`samples/factory/AM4-Factory-Presets-1p01.syx`,
104 × 12,352 = 1,284,608 bytes). No new wire commands: each restore
sends the 6-message 0x77/0x78/0x79 stream for the target slot at 30 ms
inter-message pacing, fire-and-forget. Same-location replay is mask-free
by construction (BK-036 chunk-payload masking is a fingerprinting
concern only, not a replay concern). Hardware-verified Session 51
(2026-05-08): G03 was overwritten with the factory Deluxe Tweed preset
cleanly with all 4 scenes intact.

## 11. Preset Binary Format 🔴

**Update 2026-04-29 (Session 37 cont):** Confirmed empirically that the
chunk payloads are **per-export masked** — `samples/factory/A01-original.syx`
(a session-03 active-loaded export of factory A01) has chunk-payload
SHA-256 DIFFERENT from the bank file's A01 entry, and matches NO bank
entry in a 104-slot sweep. Rules out "mislabeled file"; the mask is
keyed by something that differs between active and stored exports —
most likely the 0x77 header location bytes (active = 0x7F sentinel,
stored = real index 0x00..0x67). See `src/safety/locationStatus.ts`
header comment for the safety-gate implications and **BK-036** in
`04-BACKLOG.md` for the decode workstream.

From `Presets.md`:

- Export format: `.syx` (standard MIDI SysEx dump).
- AM4 presets are **mutually compatible with VP4** — shared format.
- AM4 presets are **incompatible with Axe-Fx III / FM3 / FM9** — different
  block IDs and parameter layouts.
- Hardware is always ready to receive a preset (no prep handshake).
- Loaded presets sit in a temporary buffer until explicitly stored.
- Compatible with generic MIDI librarians (MIDI-OX on Windows, SysEx
  Librarian on macOS) for dumping / loading.

Nothing about the binary layout itself is documented. This is the risky
phase of the project. Concrete plan once 0x02 works:

1. Export two factory presets via a generic librarian. Diff byte-by-byte
   with `scripts/diff-syx.ts`.
2. Change one parameter in AM4-Edit, export, diff the export. The changed
   bytes locate that parameter in the binary.
3. Repeat across representative parameters (amp gain, delay time, reverb
   mix, filter frequency, scene selection) until the structure is mapped.
4. Document findings in `docs/SYSEX-MAP.md` under a new "Preset binary
   layout" section, and in `docs/SESSIONS.md` for the per-session log.

---

## 12. Phase 1 Action Plan (derived from this map)

In priority order, each step either succeeds or reveals a concrete blocker:

1. **Run `scripts/probe.ts`** with the AM4 connected. Confirm enumeration,
   send the documented Scenes mode switch, observe display change.
2. **Send 0x08 GET_FIRMWARE_VERSION** as a first probe. Capture whatever
   response arrives. Even a silent response tells us something (command
   accepted but no reply vs. command rejected).
3. **Sniff AM4-Edit** doing a preset switch, a single parameter change,
   and a scene switch. Cross-reference captured bytes against Sections 5–6.
4. **Implement 0x02 SET_BLOCK_PARAMETER_VALUE** for ONE parameter (Amp
   gain). Audible change on the device = live-tweak MVP is unblocked.
5. **Fill in the confirmed block IDs and parameter IDs** for that one
   block as a template for the rest.
6. **Document each discovery** in `docs/SESSIONS.md` with raw hex and
   annotation, and flip the relevant 🟡 entries to 🟢 in this file.

---

## 13. What's Still 🔴 UNKNOWN

- Whether AM4 responses carry a checksum at all (Axe-Fx II family splits
  by function — AM4 may differ).
- Whether the device requires any initialization handshake before
  accepting non-mode-switch commands.
- The AM4-specific block ID values (Section 8 lists Axe-Fx II guesses).
- The parameter ID space for every block type — verified one block at a
  time via sniffing.
- Scene count (4 vs 8 — sources disagree).
- How modifiers are encoded in the preset binary.
- Whether any undocumented function IDs exist that AM4-Edit uses
  exclusively — forum threads about Axe-Fx III 0x51/0x52/0x53 suggest the
  possibility.
- The entire preset binary format.

Every unknown above maps to a specific sniff-session experiment. None are
structurally impossible — all are tedious.

---

## 14. Device Capability Limits (Fractal family)

Constraints below are **hardware/firmware limits**, not code gaps — no
amount of decode work will unlock them. They shape every tool that
reads or writes device state. New devices added to the project should
be audited against this table; new tools should respect the patterns
documented here.

| Constraint | AM4 | Axe-Fx II | Axe-Fx III | Pattern to use |
|---|---|---|---|---|
| Indirect preset read (read preset N without navigating to it) | ❌ no wire path | ❌ no wire path | ❌ no wire path | **Switch-then-read.** `switch_preset(N)` → working-buffer dump / `get_param`. Hardcoded into AM4 `describe_device` agent_guidance under `read_requires_navigation`. |
| Indirect scene read (read inactive scene state without switching to it) | ❌ no wire path | ❌ no wire path | ❌ no wire path | **Switch-then-read.** `switch_scene(N)` → `get_param`. To author per-scene state: `switch_scene N → write → optionally switch back`. Same discipline across all three devices. |
| Front-panel edit broadcast (device emits MIDI on knob turn / scene change / bypass) | ❌ none (HW-107 Session 74: zero bytes captured) | ✅ `0x74` state-broadcast triple | ❓ unverified | **AM4:** polled working-buffer fingerprint on the navigation seam (see SAFE-EDIT-WORKFLOW.md). **Axe-Fx II:** passive listener (`isStateBroadcastInbound` in `axe-fx-ii/midi.ts`). |
| Working-buffer dump request | ✅ HW-045 (Session 51) | ✅ same family | ❓ unverified | AM4 dump is 12,352 bytes streamed; ~150–200 ms round-trip. Acceptable to call once per navigation seam, not continuously. AM4-Edit's ~60 Hz polling cadence is explicitly rejected for this server. |
| Stored-preset binary read | ❌ scrambled per-export (Session 03) | ❌ same | ❌ same | **Puppet the device:** send a sequence of param/block writes against the working buffer, then `save_to_location`. AM4-Edit works this way; do not attempt to construct preset binaries in-memory. See DECISIONS.md 2026-04-14 row "Architecture: puppet the device, don't encode preset binaries." |
| Decoded scene-switch ack payload | ⏳ BK-025 partial (latency polish; doesn't unlock new capability) | ❓ unverified | ❓ unverified | Even fully decoded, the move-before-read pattern stays. The decoded payload would save one read after a switch the agent already had to do. |

### Cross-references

- **No-indirect-read enforcement (AM4):** `packages/am4/src/descriptor/agentGuidance.ts` — `read_requires_navigation` guidance block, exposed to the LLM via `describe_device({port:'am4'})`.
- **No-indirect-read (Axe-Fx III):** `docs/axefx3-design-notes.md:30-34` documents the move-before-write/read pattern.
- **AM4 dirty signal absence + polled-fingerprint workaround:** `packages/am4/src/bufferFingerprint.ts` + `packages/am4/src/tools/safeEdit.ts`; cross-device contract in `docs/SAFE-EDIT-WORKFLOW.md`.
- **HW-107 closure note:** AM4 emits zero unsolicited MIDI on front-panel edits (3 independent captures, Session 74).
- **Preset binary scrambling:** DECISIONS.md 2026-04-14 (architecture pivot).
