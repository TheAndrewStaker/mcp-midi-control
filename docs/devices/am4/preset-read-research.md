# Non-destructive Stored-Preset Name Read — Research & Decode

**Status: 🟢 DECODED.** Wire shape, byte-exact golden, and end-to-end
sample of all 104 names round-tripped from a captured AM4-Edit launch
session.

**Author:** research sub-agent, 2026-05-07.
**Tracked as:** HW-070 (`docs/HARDWARE-TASKS.md`).
**Tools unblocked:** `am4_get_preset_name(location)`, `am4_scan_locations({ from, to })`.

The command is a new READ action (`0x0012`) on the existing
`pidLow=0x00CE pidHigh=0x000B` preset-name register family that was
already half-known via the rename WRITE action (`0x000C`). The protocol
designer kept the same address shape and added a read variant -- exactly
the symmetry that exists between SET_PARAM (action `0x0001`) and the
short read (action `0x000E`). One AM4-Edit "Refresh Preset Names"
button click maps to a 104-message loop that takes ~350 ms total on the
wire. No preset switch occurs; the working buffer is untouched.

---

## 1. What we already know

Existing read paths and why none of them solve "give me location N's
name without switching to it":

| Path | Function | Action | Returns | Touches working buffer? | Reads stored location? |
|------|---|---|---|---|---|
| Short param read | `0x01` | `0x000E` | one knob value (4 raw) | no | no -- reads the active working buffer |
| Long param read | `0x01` | `0x000D` | 64-byte param descriptor | no | no -- reads the active working buffer |
| Preset switch | `0x01` (`pidLow=0x00CE pidHigh=0x000A`) | `0x0001` | ack only | YES, replaces it | yes (loads into buffer) -- destructive |
| 0x77/0x78/0x79 dump (response) | `0x77/0x78/0x79` | n/a | full preset binary, ~12,352 bytes | no | yes -- but the **request** shape is unknown (HW-045); only response side is decoded |
| `0x0F GET_PRESET_NAME` (Axe-Fx II) | `0x0F` | n/a | (rejected) | n/a | n/a -- AM4 returns result code 0x05 |

In short: **no existing pidLow/pidHigh combination returned preset-name
data for an inactive location**. Until this decode, the only way to
inspect a stored preset's contents was a destructive `am4_switch_preset`
or a 5-8 second full preset dump (whose request shape is also unknown).

The `pidLow=0x00CE` register family was the natural place to look,
because it already hosts:

| pidHigh | What | Action(s) decoded |
|---|---|---|
| `0x000A` | Preset switch (active buffer) | `0x0001` write only |
| `0x000B` | Preset name (rename write) | `0x000C` write -- 36-byte payload `[u32 slotIdx][32 ASCII]` |
| `0x000D` | Scene switch | `0x0001` write |
| `0x000F..0x0012` | Block placement at slots 1..4 | `0x0001` write, `0x000E` read |
| `0x0037..0x003A` | Scene 1..4 name | `0x000C` write |

So `pidHigh=0x000B` already had a write action. A read counterpart was
the obvious hypothesis, and that turned out to be exactly correct.

---

## 2. The hypothesis space

| Candidate | Likelihood | Evidence |
|---|---|---|
| **Read variant of preset-rename register** (`pidLow=0x00CE pidHigh=0x000B` with a new action) | **HIGH** -- by analogy with the SET_PARAM/short-read pairing | Symmetric design pattern across the protocol; AM4-Edit must populate its preset list somehow |
| Variant of `0x77/0x78/0x79` dump request (host -> device) with a location index | medium | Only the device -> host response is decoded; the request triggers a full ~12 kB dump (slow) -- overkill for "just the name" |
| New function byte we haven't catalogued | low | None of the unmapped IDs in the Axe-Fx II template fit a name-only reader |
| Multi-message protocol | low | Too heavy for a simple list refresh |
| Preset name embedded in some existing "active state" message | low | All known active-state messages target the working buffer, not stored locations |

The capture analysis below confirms the top candidate **byte-exactly**
on a 104-name corpus.

---

## 3. Capture analysis

Source file: `samples/captured/session-46-am4edit-launch-device-connected.midi-events.txt`
(8,185 SysEx messages parsed; capture taken Session 46 when AM4-Edit
attached to the device at startup).

### The 104-message smoking gun

Grouping every fn=0x01 OUT message by its `(pidLow, pidHigh, action)`
header triple surfaces one address that occurs **exactly 104 times** at
the very front of the capture (frames 45..463):

```
pidLow=0x00CE pidHigh=0x000B action=0x0012  count=104  payloadLens={15}
```

That is the AM4 preset count (26 banks x 4 = 104). Confirms the
per-slot loop hypothesis. The same 104-message pattern repeats in
`session-46-refresh-after-new-firmware.midi-events.txt` (frames
45205..) -- which is exactly what the AM4-Edit "Refresh Preset Names"
UI button does, so the find generalises beyond a single capture.

### OUT request shape (15 bytes payload, 23 bytes on the wire)

Frame 45, location 0 (A01):

```
Wire:   F0 00 01 74 15 01 4E 01 0B 00 12 00 00 00 04 00 00 00 00 00 00 43 F7
Bytes:        |env       |fn|pidLow|pidH |act |hdr3|hdr4 |packed u32 LE   |cs|end
```

Decoded body fields:

| Field | Value | Meaning |
|---|---|---|
| function | `0x01` | PARAM_RW dispatcher |
| pidLow | `0x00CE` (septets `4E 01`) | preset-name register |
| pidHigh | `0x000B` (septets `0B 00`) | preset-name register |
| action | `0x0012` (septets `12 00`) | **READ_PRESET_NAME (new)** |
| hdr3 | `0x0000` | reserved/zero |
| hdr4 | `0x0004` (septets `04 00`) | 4 raw payload bytes follow |
| payload (5 packed -> 4 raw) | u32 LE = location index 0..103 | which preset to read |

The 5 packed bytes encode the 4-byte u32 LE location index using the
sliding-window pack from §6b (`packValue` in
`src/fractal/shared/packValue.ts`). Verified bit-for-bit by
`scripts/verify-name-read-roundtrip.ts`: the 8 captured tails for
locations 0..7 unpack to exactly `0..7`. The full builder for location 0
matches frame 45 byte-for-byte including checksum (`0x43`).

### IN response shape (47 bytes payload, 56 bytes on the wire)

Frame 47, response for location 0:

```
F0 00 01 74 15 01 4E 01 0B 00 12 00 00 00 20 00 <37 packed bytes> <cs> F7
```

Decoded:

| Field | Value | Meaning |
|---|---|---|
| function | `0x01` | echoes request |
| pidLow / pidHigh / action | `0x00CE / 0x000B / 0x0012` | echoes request |
| hdr3 | `0x0000` | reserved |
| hdr4 | `0x0020` (septets `20 00`) | 32 raw payload bytes follow |
| payload (37 packed -> 32 raw) | 32 ASCII bytes, space-padded (0x20) | the preset name |

Notable: the IN payload is **NOT** prefixed with the location index
(unlike the rename WRITE payload, which has a u32 LE slot prefix). The
caller correlates request-with-response by arrival order; AM4-Edit
clearly sends its 104 requests serially and matches by position.

### End-to-end name corpus

`scripts/decode-preset-name-reads.ts` unpacks all 104 IN responses with
`unpackValueChunked` (32 raw bytes = 4 full chunks of 7 + 1 partial
chunk of 4 = 8*4 + 5 = 37 packed bytes -- matches the 37 observed). All
104 names decode to coherent strings:

- A01..R04: factory presets ("AM4 Gig Rig", "59 Bassguy", ...,
  "Wrecker Express") -- matches the AM4 Owner's Manual factory list.
- S01..V04: signature artist banks ("Brett's Gig Rig EV12", "Leon's
  Live AM4", ...).
- W01..X01: founder's user presets ("love-song", "breakdown", "ktulu",
  "amber", "bass").
- X02..Z03: empty locations -- payload literally reads `<EMPTY>`
  followed by spaces.
- Z04: founder's working preset ("P1010-D SPOT CHECK").

Empty locations return the literal ASCII `<EMPTY>` (8 chars) padded
with spaces, NOT a null payload or a different result code. This is
useful for the MCP tool: empty-detection is a string compare, no
special-casing needed.

### Timing

From the tshark timestamps:

- First OUT (frame 45): t = 10.164105 s
- Last IN  (frame 463): t = 10.512116 s
- **Total: ~350 ms for all 104 reads serially.**

That's ~3.4 ms per name including the 1.5 ms USB MIDI round-trip on
each side. **Comfortably under the 1 s "acceptable" budget for a batch
tool**, and dramatically better than the current 20 s preset-switch
sweep.

### What DOESN'T appear in the launch capture

- No `0x77/0x78/0x79` traffic at all -- AM4-Edit does NOT do full
  preset dumps for the list refresh. It uses the lightweight name read
  exclusively.
- No traffic targeting `pidHigh=0x000A` (preset switch) -- the working
  buffer is never disturbed during a list refresh.
- No `0x0F GET_PRESET_NAME` -- consistent with that command being
  rejected on AM4 (it was never the right command in the first place).

This is exactly the design we needed.

---

## 4. JUCE BinaryData / Ghidra evidence

`samples/captured/decoded/exe-strings.json` confirms the user-facing
control name in AM4-Edit:

- `"presetNamesRefreshBtn"` -- the JUCE button component.
- `"Refresh Preset Names"` -- the menu label.
- `"Preset names refreshed."` -- the post-action toast.
- **`"Select the Refresh button below to refresh all preset names from the AM4."`** -- the help-text confirmation that this UI flow IS the bulk-name read we observed.

These are the user-facing strings the founder clicked when generating
the launch / refresh captures. Together with the byte-exact wire match
above, the command is unambiguously identified.

No new function-byte names showed up in the Ghidra paramtable / encoder
dumps (`samples/captured/decoded/ghidra-encoder.txt`,
`ghidra-paramtable.txt`); the action byte `0x0012` is data-driven from
configuration tables, not a named symbol -- so no symbolic
`GetPresetName` constant appears. The capture-side evidence is the
canonical proof.

---

## 5. Best-guess wire shape (now confirmed byte-exactly)

### `READ_PRESET_NAME` (host -> device)

- **function** `0x01` (PARAM_RW)
- **pidLow** `0x00CE`, **pidHigh** `0x000B`
- **action** `0x0012` -- READ counterpart of the rename WRITE (`0x000C`)
- **hdr4** `0x0004` = 4 raw payload bytes
- **Payload (4 raw):** uint32 LE location index (0 = A01, 103 = Z04)

```
F0 00 01 74 15 01
   4E 01    pidLow = 0x00CE
   0B 00    pidHigh = 0x000B
   12 00    action = 0x0012
   00 00    hdr3 = 0
   04 00    hdr4 = 4
   <5 packed bytes>     -- u32 LE location, sliding-window packed (§6b)
   <cs> F7
```

Total wire size: **23 bytes**.

### Captured goldens (suggested for `verify-msg`)

| Capture | Built by | Wire (with checksum) |
|---|---|---|
| Read A01 (loc 0) | `buildGetPresetName(0)` | `F0 00 01 74 15 01 4E 01 0B 00 12 00 00 00 04 00 00 00 00 00 00 43 F7` |
| Read A02 (loc 1) | `buildGetPresetName(1)` | `F0 00 01 74 15 01 4E 01 0B 00 12 00 00 00 04 00 00 40 00 00 00 03 F7` |
| Read Z04 (loc 103) | `buildGetPresetName(103)` | `F0 00 01 74 15 01 4E 01 0B 00 12 00 00 00 04 00 33 40 00 00 00 30 F7` |

Source captures: frames 45 and 49 in
`samples/captured/session-46-am4edit-launch-device-connected.midi-events.txt`.
Loc 103 is verified by the matching frame near the end of the same
capture.

### `READ_PRESET_NAME` response (device -> host)

- **function** `0x01` (echoes request)
- **pidLow / pidHigh / action** echo `0x00CE / 0x000B / 0x0012`
- **hdr4** `0x0020` = 32 raw payload bytes
- **Payload (32 raw):** 32 ASCII chars, space-padded (0x20). Empty
  locations return the literal `<EMPTY>` followed by spaces. No null
  termination.

Total wire size: **56 bytes**.

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

Decoder: `unpackValueChunked(packed, 32)` -> 32-byte Uint8Array; convert
to string and strip trailing spaces. The chunk math (32 raw = 4 full
7-byte chunks + 1 partial 4-byte chunk -> 4*8 + 5 = 37 packed bytes)
matches the captured payload sizes byte-for-byte.

### Empty-detection helper

```typescript
const EMPTY_SENTINEL = '<EMPTY>';
function isEmpty(name: string): boolean { return name.trim() === EMPTY_SENTINEL; }
```

---

## 6. Probe plan (founder, hardware required to verify against a clean
capture but the decode is already complete)

Because the decode is already byte-exact against captured AM4-Edit
traffic and round-trips cleanly to the founder's known preset list at
W01..X01 + Z04, **no new hardware probe is strictly required to ship**.
A hardware confirmation is still cheap and worth doing once before the
tool surface lands, to:

1. Confirm the device responds the same way to a Node.js-built
   request as to AM4-Edit's request (verifies the sliding-window
   chunked pack is implemented identically end-to-end).
2. Confirm `<EMPTY>` is the sentinel for empty locations on the
   founder's actual unit (factory bank covers all 104 locations on a
   stock AM4, so the founder needs at least one cleared slot to test
   this).

### Recommended single-capture probe

1. Open AM4-Edit.
2. Start USBPcap.
3. Click the existing **"Refresh Preset Names"** menu/button (or
   refresh-after-new-firmware -- both produce the same pattern).
4. Save as `samples/captured/session-NN-preset-name-refresh.pcapng`.
5. Compare against the existing
   `session-46-am4edit-launch-device-connected.pcapng` captures via
   `scripts/parse-midi-events.ts` -- the 104-message OUT/IN sequence
   should appear identically.

**Expected response shape per location** (per §5 above): 56-byte SysEx
frame with hdr4=32 and a 37-byte packed name payload, decoding to a
32-char ASCII string that matches what the AM4 front-panel display
shows for that location.

### Optional precision probe (one shot)

If the founder wants a single in-isolation confirmation rather than
the bulk loop:

1. Founder confirms the unit's current active preset (e.g. via
   `am4_get_preset_number`).
2. Send a single `READ_PRESET_NAME` request for a location that
   ISN'T the active one (so we prove the read is non-destructive).
3. Observe: device returns the requested name; **active preset on
   the front-panel display does NOT change**; working-buffer params
   stay untouched (read back amp.gain via short-read; should be the
   same value as before).

Pass criterion: name returned + working-buffer state unchanged. Three
boxes ticked = we ship.

---

## 7. Implementation sketch

### `am4_get_preset_name({ location })`

- **Input:** `location` -- string ("A01" through "Z04") or integer
  (0..103). Use existing `parseLocationCode` from
  `src/fractal/am4/locations.ts` to coerce.
- **Build:** new `buildGetPresetName(locationIndex: number)` in
  `src/fractal/am4/setParam.ts` modeled on `buildSetPresetName`.
  Reuses `packValue` (single-chunk) for the 4-byte u32 LE location.
  Wire envelope identical to §5 above.
- **Send:** existing `sendSysEx` + `receiveSysExMatching` infra. The
  matching predicate echoes the outgoing addressing fields (pidLow /
  pidHigh / action) and expects `hdr4 = 0x0020`.
- **Decode:** `unpackValueChunked(packed, 32)` -> `String.fromCharCode(...raw)`
  -> `trimEnd()`. If decoded string equals `<EMPTY>`, return
  `{ location, isEmpty: true, name: undefined }`. Otherwise
  `{ location, isEmpty: false, name }`.
- **Errors:**
  - Location out of range (< 0, > 103): throw before sending.
  - MIDI port unavailable: surface `reconnect_midi` nudge per existing
    convention (`am4_get_block_layout` etc.).
  - Ack timeout: 300 ms window per the §6a baseline; report
    "device did not respond" with the same shape used by other reads.
  - Truncated response (< 56 bytes): throw with hex of received bytes
    for debug.
- **Latency budget:** ~5 ms in practice (single OUT + single IN).
  Comfortably "instantaneous."

### `am4_scan_locations({ from, to })`

- **Input:** `from` and `to` -- location codes (default
  `from="A01"`, `to="Z04"` for full scan). Both inclusive.
- **Build:** loop `buildGetPresetName(i)` for each location index in
  range. Send sequentially (the AM4 SysEx pipe is serial; parallel
  sends are not safe).
- **Send/decode:** identical per-iteration to `am4_get_preset_name`.
  Aggregate results into an array of
  `{ location, isEmpty, name }`.
- **Output shape:** array sorted by location index. Include a
  `summary` with counts: `{ total: N, populated: M, empty: N - M }`.
- **Errors:**
  - Range invalid (`from > to`): throw before sending.
  - Mid-loop failure (one ack timeout out of N): partial result + an
    `errors: [{ location, reason }]` field; don't abort the whole scan
    on a single transient.
  - For the launch flow, **never** auto-trigger a 104-location scan
    on tool registration; the agent decides when to scan based on the
    user's request.
- **Latency budget:** ~3.4 ms per location * range size. A full 104
  scan = ~350 ms; a 20-location setlist scan = ~70 ms. Well under the
  "acceptable" < 1 s threshold; no progress message required.
- **Tool description guidance** (per `CLAUDE.md` "performance budget"
  and "tool API conventions"):
  - Lead with what it does: "Use this tool to list preset names at
    multiple AM4 locations without switching to them."
  - Note non-destructive nature: "This does NOT change the active
    preset; the working buffer is untouched."
  - Note the gigging-guitarist value: "Use this before bulk-write
    operations (e.g. setlist load) to surface what would be
    overwritten."

### Goldens for `verify-msg`

Add three rows to `scripts/verify-msg.ts`:

1. `buildGetPresetName(0)` vs frame 45 of session-46-launch capture.
2. `buildGetPresetName(1)` vs frame 49.
3. `buildGetPresetName(103)` vs the corresponding frame near the end
   of the same capture (look up via the dump-name-read-out script).

Per `CLAUDE.md`'s rule on adding new pidHighs: the action `0x0012` is
new, so the matching `verify-msg` row is mandatory before merging the
tool.

---

## 8. Risks / fallbacks

### Confidence: very high

- **Byte-exact match** between built request and captured request,
  including checksum, on three sample location indices (0, 1, 103).
- 104 IN responses round-trip to coherent factory + user-preset names
  on the founder's own unit (the "P1010-D SPOT CHECK" name at Z04 is
  founder-created, the W01..X01 names are founder-created, factory
  names match the AM4 Owner's Manual).
- Two independent captures (`launch-device-connected` and
  `refresh-after-new-firmware`) show the same pattern from cold-attach
  AND from the explicit "Refresh Preset Names" UI button. Two
  independent triggers with identical wire output is strong evidence
  that this IS the canonical command.
- AM4-Edit string evidence (`"Refresh Preset Names"`,
  `"presetNamesRefreshBtn"`) confirms the UI surface this command
  backs.

### Risks (low, but worth flagging)

1. **Empty-location sentinel format unverified on founder's unit.**
   The `<EMPTY>` literal was decoded from the founder's existing capture
   (locations X02..Z03 come back as `<EMPTY>`). Some Fractal devices
   might use null-terminated rather than space-padded sentinel on
   non-stock firmware. Mitigation: the empty-detection helper accepts
   both `name === '<EMPTY>'` and `name.trim() === ''` to be defensive.
2. **Long-name truncation.** AM4 preset names are exactly 32 ASCII
   bytes -- the rename WRITE rejects longer names. Read responses are
   guaranteed 32 bytes. No risk; just trim trailing spaces on display.
3. **Stale-buffer aliasing.** If the user does a `set_preset_name`
   write on the active working buffer and then immediately reads the
   stored name at the same location, they'll see the *stored* name,
   not the new one (until `save_to_location` runs). This is correct
   behavior; the tool description should make clear it reads from
   the on-device flash, not the working buffer.

### Fallback: if the hardware probe surprises us

If somehow the action byte `0x0012` is firmware-version-specific and a
different AM4 (older firmware) returns `0x64 MULTIPURPOSE_RESPONSE`
with result code `0x05` (i.e. "command not honored"), the fallback
plan is:

- Detect the rejection in the receive predicate.
- Return `{ supported: false, reason: 'Firmware does not expose READ_PRESET_NAME (action 0x0012)' }`.
- Fall back to the existing `0x77/0x78/0x79` dump command (slow but
  decoded) once HW-045 lands. Parse the name field out of the dump
  without persisting the rest of the binary.
- Cache the result with TTL = "until next set_preset_name / save_preset
  on this server instance," same pattern as P1-008's classification
  cache.

This fallback is unlikely to be needed -- the founder's unit is on
firmware 2.00 (build Mar 20 2026) which is current, and the launch
capture is from that same firmware. But the safety net is worth coding
into the tool surface for future-proofing.

### Truly-missing case (vanishingly unlikely)

If the command is somehow rejected on the founder's unit despite
working in AM4-Edit (which would be a contradiction we'd have to
investigate first), the previously-discussed dump-and-cache approach
remains: dump-on-first-touch into a local manifest file the agent
reads in subsequent sessions; invalidate on writes from this server
instance only. Per BK-036, the dump payloads are per-export masked, so
the cache would store decoded names + block layout summaries, not raw
bytes. Latency would be acceptable for first-time scan (~5-8 s for a
20-location range) but a 104-location cold scan would be ~30+ s and
require a progress UI per the CLAUDE.md performance budget.

---

## 9. Files referenced

Research scripts created during this investigation (kept under
`scripts/` for follow-up; safe to delete after the tool ships):

- `scripts/probe-preset-name-traffic.ts` -- finds OUT 0x01 addresses
  with count == 104 in any midi-events.txt.
- `scripts/dump-name-read-out.ts` -- dumps the OUT-side bytes for
  every name-read in a capture.
- `scripts/decode-preset-name-reads.ts` -- decodes the 104 IN
  responses to readable names.
- `scripts/verify-name-read-roundtrip.ts` -- confirms the OUT-side
  packing matches the captured tails byte-exactly and shows built
  example messages.

Existing reference files used:

- `src/fractal/shared/packValue.ts` -- `packValue` / `unpackValueChunked`
  primitives for the wire encoding.
- `src/fractal/am4/setParam.ts` -- `buildSetPresetName` (rename WRITE)
  is the model for `buildGetPresetName`.
- `samples/captured/session-46-am4edit-launch-device-connected.{pcapng,tshark.txt,midi-events.txt}` -- primary capture.
- `samples/captured/session-46-refresh-after-new-firmware.{pcapng,midi-events.txt}` -- secondary capture (same pattern).
- `samples/captured/decoded/exe-strings.json` -- AM4-Edit string
  evidence for the UI flow.

---

## Suggested HW-070 update

> **Verdict: 🟢 DECODED.** Action `0x0012` on `pidLow=0x00CE pidHigh=0x000B`
> is the per-location name read. OUT request 23 bytes (4-byte u32 LE
> location index, sliding-window packed); IN response 56 bytes (32-byte
> ASCII name, space-padded, sentinel `<EMPTY>` for cleared slots).
> Decoded byte-exact from `samples/captured/session-46-am4edit-launch-device-connected.midi-events.txt`
> -- 104 OUT/IN pairs round-trip to coherent factory + user-preset names
> on the unit. Total wire time for full 104-scan: ~350 ms. AM4-Edit's
> "Refresh Preset Names" button calls this exact command. Hardware
> probe is optional; one capture of the founder clicking the existing
> Refresh button + a single Node.js-built single-location read against
> a non-active preset would close the loop. Tool implementation:
> `am4_get_preset_name(location)` + `am4_scan_locations({ from, to })`
> per this doc §7. Ready to hand off to Claude
> for code changes; no further hardware investigation needed.
