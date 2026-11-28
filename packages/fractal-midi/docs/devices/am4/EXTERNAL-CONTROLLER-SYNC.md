# AM4-Edit + external relative MIDI controller: hardware-confirmed live sync

> **Evidence:** independent user hardware session, 2026-11-27; Fractal AM4,
> AM4-Edit, Bome MIDI Translator Pro, and Livid Code 2 (8 relative encoders
> with independently controlled LED rings).
>
> **Scope:** integration observations and a reproducible `0x0D` live-read
> example. This did **not** test the `mcp-midi-control` server, and does
> **not** establish concurrent access to the USB MIDI port. Follow the
> project's [port-exclusivity guidance](../../../../docs/contributing/SAFETY.md)
> when using this server.
>
> **Metadata not captured:** AM4 firmware version; exact Windows version;
> loaded preset location, model, and name. Do not treat those as verified.

## Why an external controller may "snap back"

A relative encoder bridge typically keeps an absolute parameter value in a
local cache, then adds each encoder increment before writing a new value to
the AM4. When the device's physical knob changes that parameter, **updating
just the external LED ring is insufficient**. The local cache must also
be updated, or the next encoder movement writes its stale value and moves
both the AM4 hardware and AM4-Edit back to the old position.

The tested integration uses two **passive** observers to keep the same cache
and LED ring current:

- **AM4-Edit to AM4:** observe outgoing function `0x01`, action `0x02`
  parameter writes, without swallowing or altering the original message.
- **AM4 to AM4-Edit:** observe incoming function `0x01`, action `0x0D`
  long parameter-read responses while AM4-Edit is already polling, again
  preserving the original response for AM4-Edit.

The bridge then calculates each new external encoder write using the
**latest observed device/editor value**, not the previous Code 2 value.
The hardware readback observer does **not** generate any additional AM4
polling or force writes back to the AM4.

This is a pattern for an application-controlled MIDI bridge, **not** a claim
that the AM4 broadcasts knob changes unsolicited. Its operation here relied
on AM4-Edit's existing polling.

## Captured live `0x0D` continuous-parameter read

The main [AM4 SysEx map](./SYSEX-MAP.md) already documents function
`0x01` long reads with action `0x0D`, including the live bypass flag
for bypass-register reads. The following independent test adds an example
for **continuous Amp Bass** (`pidLow=0x003A`, `pidHigh=0x003E` for the
tested alternate tone-stack layout).

Request, from AM4-Edit:

```text
F0 00 01 74 15 01 3A 00 3E 00 0D 00 00 00 00 00 18 F7
```

The matching AM4 response begins:

```text
F0 00 01 74 15 01 3A 00 3E 00 0D 00 00 00 28 00 [packed payload ...] [checksum] F7
```

For these **specific captured Bass responses**, the first three wire
bytes of the packed payload, at full-message indices 16, 17, and 18
(zero-based), recover the low 16-bit normalized value:

```python
p, q, r = message[16:19]   # 7-bit SysEx bytes
low = (p << 1) | (q >> 6)
high = ((q & 0x3F) << 2) | (r >> 5)
value16 = low | (high << 8)
led_cc = max(0, min(127, round(value16 * 127 / 65534)))
```

Four examples captured on **AM4 MIDI In** while the physical Bass knob
was adjusted (the messages were forwarded unchanged to AM4-Edit):

| Wire bytes 16–18 | Decoded value16 | 0–127 LED position |
|---|---:|---:|
| `6E 49 0A` | 9437 | 18 |
| `63 12 6A` | 19398 | 38 |
| `5E 67 6A` | 40893 | 79 |
| `5E 77 6A` | 57277 | 111 |

These calculations were checked against the raw MIDI capture. **Do not**
generalize this three-wire-byte extraction to other parameter types or
assume the remaining descriptor bytes have no meaning. A production
implementation should validate the complete framing, payload length,
checksum, and expected parameter address/type; the full payload is not
decoded here.

## A Bome-specific failure and correction

An initial passive `0x0D` listener matched the arriving hardware Bass
replies but skipped its rules when an encoder direction/speed state
variable remained nonzero:

```text
if(hk!=0)noexecute
```

In the captured Bome variable dump, `hk=2` and `hc=264` (stale cached
Bass position) persisted despite changing hardware responses. The next
Code 2 turn then wrote the old position back to the device.

The subsequent revision removed that guard **only from the passive
hardware-feedback observers**, allowing the incoming read value to
refresh the cache and LED ring. The user then confirmed that the AM4
hardware, AM4-Edit, and Code 2 were responding correctly. This was a
**bridge-state bug**, not evidence of a defect in AM4 firmware.

To avoid regressions in this particular Bome setup, editor writes and
hardware `0x0D` replies were observed passively while the original
AM4-Edit/AM4 MIDI paths remained intact. Separately, targeted Action02
ACK/reply filters in the Code 2 control presets retained their original
Swallow settings; that is **Bome routing behavior**, not a general AM4
SysEx requirement.

## Hardware confirmation and remaining questions

- Eight live Amp controls were exercised: Gain, Bass, Mid, Treble,
  Presence, Depth, Master, and Level.
- After the cache correction, the owner confirmed hardware ↔ editor ↔
  Code 2 control/LED behavior without the previously observed snap-back.
- Preset switching and the two used tone-stack layouts remained
  satisfactory. No measured latency figure was recorded.
- The test does **not** prove this scheme works without AM4-Edit polling,
  with another editor, or with the MCP server sharing the device.
- In one amp model, a control labeled **P.A. Presence** was adjusted when
  writing the usual Presence parameter (`0x003A/0x001E`). The repository
  also knows `amp.presence_prepresence` (`0x003A/0x008A`), but **no
  targeted MIDI capture established the address of the other displayed
  Presence control**. This is a follow-up question, not a mapping claim.

**Supporting evidence:** the device owner retains the full raw
`AM4-Bass-Test.txt` Bome capture and the final hardware-tested
`AM4_Code2_v2.10_Hardware_Three_Way_Sync_Fix.bmtp` configuration,
which can be supplied for reproducibility. Neither file is part of
this documentation-only contribution.
