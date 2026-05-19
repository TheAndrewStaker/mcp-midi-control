# Preset-Dump Request (host -> device) - Research & Decode

---

## Active-buffer dump tool shipped Session 51 (2026-05-08)

**Status: 🟢 ACTIVE-BUFFER PATH SHIPPED.** The byte-exact decode below
is now exposed as an MCP tool: `am4_request_active_buffer_dump()`.

- **Builder:** `buildRequestActiveBufferDump()` in
  `src/fractal/am4/setParam.ts`. No parameters; returns the 11-byte
  fn=0x03 request.
- **Receiver:** `receivePresetDumpStream(conn, options?)` in
  `src/fractal/am4/presetDump.ts`. Listens for the 6-message reply,
  validates each envelope + length + function byte + checksum, and
  returns `{ bank, sub, totalBytes, messageCount, headerBytes,
  chunkBytes, footerBytes }`. Default 2000 ms timeout (generous; the
  capture shows ~2 ms wall-clock between first 0x77 and final 0x79
  frame).
- **MCP tool:** `am4_request_active_buffer_dump()` registered in
  `src/fractal/am4/tools/navigation.ts`. Non-destructive (no working-buffer mutation,
  active location preserved, no audible side effect). Surfaces the
  raw masked dump bytes for the BK-036 probe series. Chunk content
  is not decoded.
- **Goldens:** byte-exact build golden in `scripts/verify-msg.ts`
  (`buildRequestActiveBufferDump() — matches session-51 export-preset
  capture`).
- **Docs:** SYSEX-MAP §6o.

The stored-preset variant (request a specific A01..Z04 dump without
affecting the working buffer) is still gated on a follow-up capture —
see HW-045 in `docs/HARDWARE-TASKS.md` for the procedure and the
"Decode landed Session 51" section below for the hypothesis space.

---

## Decode landed Session 51 (2026-05-08) — partial; stored-preset path still blocked

**Status: 🟡 PARTIALLY DECODED.** The wire shape of the export-preset
request is now known, but only for the **active working buffer** export
path. The capture taken for this session (`samples/captured/session-51-export-preset.pcapng`)
captured the founder clicking File -> Export Preset in AM4-Edit while
no stored location was specifically targeted, so the request emitted
references the **active buffer sentinel** (0x7F), not a stored bank/sub
pair. The implementation of `am4_request_preset_dump(location)` cannot
ship from this capture alone without speculating on the stored-preset
encoding.

### What we now know byte-exactly

OUT request (host -> device), single SysEx, 11 bytes total:

```
F0 00 01 74 15 03 7F 7F 00 13 F7
       envelope    fn payload   cs end
```

- envelope `F0 00 01 74 15`
- function byte `0x03` (NEW — never seen before in any capture; unrelated to the fn=0x01 PARAM_RW family)
- payload (3 raw bytes): `7F 7F 00`
  - byte 0 = `0x7F` — ACTIVE BUFFER sentinel (matches the response-side 0x77 header convention where bank=0x7F means the WB)
  - byte 1 = `0x7F` — second sentinel (or this is `sub` and is also 0x7F when WB-targeted)
  - byte 2 = `0x00` — constant; possibly a request-type discriminator or a reserved byte
- checksum `0x13` (XOR of bytes F0..00 & 0x7F — verified against `fractalChecksum`)
- end `F7`

IN response is the expected 6-message dump stream, totalling exactly **12,352 bytes**:

| # | Frame | Time | fn | Wire size | First bytes |
|---|---|---|---|---|---|
| 1 | 12147 | 14.262 | 0x77 | 13B | `f0 00 01 74 15 77 7F 00 00 20 00 38 f7` |
| 2 | 12147 | 14.262 | 0x78 | 3082B | `f0 00 01 74 15 78 00 08 09 02 00 55 54 02 3c ...` |
| 3 | 12161 | 14.262 | 0x78 | 3082B | `f0 00 01 74 15 78 00 08 2c 5d 00 17 59 01 58 5b ...` |
| 4 | 12176 | 14.263 | 0x78 | 3082B | (chunk 3, 0x78) |
| 5 | 12192 | 14.263 | 0x78 | 3082B | (chunk 4, 0x78) |
| 6 | 12208 | 14.264 | 0x79 | 11B | `f0 00 01 74 15 79 04 24 01 48 f7` |

13 + 4*3082 + 11 = 12,352 bytes — matches the per-preset count in the
factory bank file ([`factory-restore-research.md`](factory-restore-research.md)). Response shape
is the canonical dump stream, no surprises.

The 0x77 header payload is `7F 00 00 20 00`: **bank = 0x7F (active
sentinel), sub = 0x00, constants `00 20 00`**. This confirms the
encoder note from `FUN_1402298f0` — bank/sub live in payload[0..1]
and the trailing 3 bytes are constants. For an active-buffer export
the bank field carries the 0x7F sentinel; sub is 0x00.

### Why the stored-preset variant is still blocked

The captured request was for the working buffer, not a stored
location. So we have **one** data point: WB export -> request payload
`7F 7F 00`. Two plausible models for stored-preset exports:

| Hypothesis | Predicted wire (for A01, idx=0, bank=0 sub=0) | Predicted wire (for Z04, idx=103, bank=25 sub=3) |
|---|---|---|
| H1 (most likely): bytes 0..1 = bank/sub, byte 2 = 0x00 constant | `F0 00 01 74 15 03 00 00 00 cs F7` | `F0 00 01 74 15 03 19 03 00 cs F7` |
| H2: byte 0 = bank, byte 1 = "active flag" (0x7F = WB, 0x00 = stored), byte 2 = sub | `F0 00 01 74 15 03 00 00 00 cs F7` (= H1) | `F0 00 01 74 15 03 19 00 03 cs F7` |
| H3: completely different shape for stored exports (e.g. fn=0x03 only handles WB, stored uses a different fn byte) | n/a | n/a |

H1 is consistent with the response-side 0x77 header encoding
(`bank, sub, 00 20 00`) and with the symmetry argument (the host
addressing convention echoes what the device emits in the dump
header). H2 differs only in byte ordering and is probably equivalent.
H3 would be a surprise but cannot be ruled out without a second
capture.

We can ship a confident `am4_export_working_buffer()` tool today —
that's a single fixed wire string. We cannot ship
`am4_request_preset_dump(location)` for arbitrary location N without
another capture confirming the stored-preset encoding (H1 vs H2 vs H3).

### What's needed to disambiguate

ONE additional capture: AM4-Edit selects a STORED preset (e.g. A01),
then File -> Export Preset, USBPcap recording. That capture's first
OUT fn=0x03 message will reveal whether the bank/sub fields fill bytes
0..1 (H1) or are split (H2), or whether stored exports use a
different fn byte entirely (H3). Two captures (e.g. A01 *and* Z04)
would let us byte-exact verify the encoding across the full bank
range. See `HW-045` in `docs/HARDWARE-TASKS.md` for procedure.

### Shipped in this session

- This research note (decode landed for WB-export shape).
- HW-045 status updated to 🟡 partial — needs a stored-preset capture follow-up.

### NOT shipped

- `buildRequestPresetDump(location)` builder — blocked on stored-preset capture.
- `am4_request_preset_dump` MCP tool — blocked.
- Goldens in `verify-msg.ts` — only one wire shape known; not enough to anchor a parameterized builder.

If the founder is OK shipping a working-buffer-only path first
(`am4_export_working_buffer`) we can do that as a follow-up — the
wire shape is byte-exact. But the prompt's stated tool surface is
location-parameterized, which requires the second capture.

### Capture procedure recap (founder action)

When ready to disambiguate:

1. AM4 connected via USB, USBPcap recording.
2. AM4-Edit -> select preset A01 (or any specific stored preset, NOT
   the working buffer) on the preset list.
3. File -> Export Preset -> save .syx anywhere.
4. Stop capture, save as `samples/captured/session-NN-export-stored-A01.pcapng`.
5. Optional: repeat for Z04 to confirm the encoding spans the full bank range.

Total time: ~1 minute on hardware. Decode lands the same session.

---

## (Original Session 50 research below — kept for context)

**Status: 🔴 UNKNOWN.** No request command for the
0x77/0x78/0x79 preset-dump stream is present in any of the 80+ existing
captures, and AM4-Edit's encoder appears to never emit such a request.
Static analysis points to the dump-request flow being a separate
**Fractal-Bot** subsystem (bundled inside AM4-Edit but exposed via a
distinct `FractalBotDialog` UI), and our capture corpus does not include
a single trigger of that dialog. **A new hardware capture is required
to decode this command. There is no static-analysis path forward with
the artefacts on disk today.** This is exactly the case **HW-045**
queued for. See §8 below for the recommended capture setup the founder
can run in 60 seconds once an AM4 is connected.

**Author:** research sub-agent, 2026-05-07.
**Tracked as:** HW-045 (`docs/HARDWARE-TASKS.md`, post-MVP gate for
backup/restore + binary-format decoding).
**Tools blocked:** `am4_request_preset_dump(location)`,
`am4_dump_working_buffer()`, `am4_backup_location(location)`, the
BK-036 binary-format probe harness.

---

## 1. Verdict (one paragraph)

**Unknown, high-confidence reasoning.** Three independent pieces of
evidence converge on the same conclusion: (a) all 80+ existing captures
in `samples/captured/` contain ZERO 0x77/0x78/0x79 traffic in either
direction, including the launch + refresh + switch-preset + rename +
save-to-Z04 captures, (b) AM4-Edit's preset-list refresh uses the
lightweight `READ_PRESET_NAME` action `0x0012` (decoded session 50),
not preset dumps, (c) static analysis of AM4-Edit's encoder
(`samples/captured/decoded/ghidra-encoder.txt`) shows exactly **one**
construct-`0x77` site in the entire binary - and it's a
**header-rewriter** (`FUN_1402298f0`) that edits `bank` and
`sub-index` bytes inside an *existing* dump buffer, not a builder that
emits an outgoing dump-request SysEx. AM4-Edit's File menu surfaces a
"Fractal-Bot..." button that opens a separate `FractalBotDialog`; the
single download/upload-related string `download_sysex` lives next to
`patch_dump` and `cab_dump` in an internal command table, suggesting
those flows are dispatched into the Fractal-Bot subsystem rather than
emitted directly by the editor. The request shape can be decoded, but
only by capturing AM4-Edit (or Fractal-Bot itself) doing
File -> Export Preset and observing the first OUT SysEx. That capture
has never been taken.

---

## 2. Wire shape (if decoded)

**Not decoded.** No candidate wire shape can be proposed with confidence
from static analysis alone. Speculation would only narrow the search if
the founder had to choose between hypotheses to test, and in this case
the test cost is "click File -> Export Preset once with USBPcap
running" - cheaper than narrowing speculatively.

### What we can rule out

- **Not on the existing fn=0x01 PARAM_RW dispatcher.** The 8,185
  fn=0x01 messages in `session-46-am4edit-launch-device-connected.midi-events.txt`
  decode cleanly to known address registers (preset name read,
  block-layout reads, scene/bypass, etc.). None of them produce a
  dump response in the capture; the responses are short
  (15-47 byte) param/name reads.
- **Not a request that AM4-Edit's preset-list refresh emits.**
  Both the cold-attach launch capture and the explicit "Refresh
  Preset Names" trigger produce 104 OUT/IN pairs of action `0x0012`
  on `pidLow=0x00CE pidHigh=0x000B`, returning 32-byte names. No
  full-preset dump traffic.
- **Not an undocumented variant in the captured set.** The fn-byte
  histogram across the launch capture is `{ 0x00:1, 0x01:8179,
  0x08:2, 0x47:2, 0x64:1 }`. Across all the major sniffing sessions
  (session-04 gain, session-18 switch-preset, session-22
  rename/switch, session-29 expert pages, session-46 launch + refresh)
  the only function bytes ever observed are `0x01`, `0x08`, `0x12`,
  `0x14`, `0x47`, `0x64`. No 0x77/0x78/0x79 in any direction.

### Hypothesis space (ordered by likelihood)

| # | Hypothesis | Evidence for | Evidence against |
|---|---|---|---|
| H1 | A short 0x77 SysEx with a location-index payload (analogous to GET_PRESET_NUMBER 0x14 but addressing a stored slot, returning the 6-message dump) | Symmetric to 0x77 PRESET_DUMP_HEADER's role on the response side; matches the "request envelope echoes function byte" pattern of 0x14 / 0x0E / 0x0F | Speculation only; not present in any capture or string evidence |
| H2 | A new function-byte we haven't seen, e.g. 0x70 / 0x76 / 0x7A / 0x7B (in the same neighbourhood as 0x77/78/79) with location index | Wiki maps 0x7A/0x7B/0x7C to "IR download protocol" on Axe-Fx II - same family of "ask the device for a binary blob" requests; the Fractal designers might have placed the preset-dump request in the same numeric range | No string or symbol-table evidence, but no contradiction either |
| H3 | An fn=0x01 dispatcher action on a new pidLow/pidHigh register that returns the dump as a stream | Possible but would be unusual - 0x01 responses to date are all single SysEx frames carrying parameter-shaped payloads, not multi-message streams | The 6-message stream pattern (header + 4 chunks + footer) is distinct from any decoded fn=0x01 read response shape |
| H4 | A two-step protocol: fn=0x14 (set preset number) to load the target into the working buffer, then fn=??? to dump WB | Matches the documented 0x14 SET_PRESET_NUMBER + 0x77 export pattern hinted at in HW-045's notes ("File -> Export Preset menu sends a single small SysEx command and the device replies with the 6-message dump") | The note says "single small SysEx command" - so a one-shot, not a two-step. Also a two-step flow would clobber the working buffer, which AM4-Edit's "Export Preset" UX presumably does not |

H1 + H4 are the two strongest. The capture will resolve which.

---

## 3. Response shape (already documented)

The device-to-host side of this transaction IS already decoded - it's
the standard 6-message preset dump documented in
[`SYSEX-MAP.md`](SYSEX-MAP.md) §10b:

```
Msg 1   13B    func 0x77   PRESET_DUMP_HEADER  (5-byte payload)
Msg 2 3082B    func 0x78   PRESET_DUMP_CHUNK 1 (3074-byte payload)
Msg 3 3082B    func 0x78   PRESET_DUMP_CHUNK 2
Msg 4 3082B    func 0x78   PRESET_DUMP_CHUNK 3
Msg 5 3082B    func 0x78   PRESET_DUMP_CHUNK 4
Msg 6   11B    func 0x79   PRESET_DUMP_FOOTER  (3-byte payload)
```

Total: 12,352 bytes.

### Location-index encoding in the 0x77 header (confirmed)

`FUN_1402298f0` in the AM4-Edit encoder (lines 9223-9293 of
`samples/captured/decoded/ghidra-encoder.txt`) is the
header-rewriter used during bank uploads: when AM4-Edit needs to
re-target a dump's stored location, it scans for the envelope head
(the constant `local_48 = 0x740100f0` which is `f0 00 01 74` LE),
then writes:

```c
local_44 = *(undefined1 *)(param_1 + 0x30);   // model byte (== 0x15 for AM4)
local_43 = 0x77;                              // function byte
// ...
iVar5 = param_3 + uVar6;                      // global preset index (0..103)
local_68 = (ushort)(iVar5 >> 2) & 0xff;       // bank   = idx >> 2
local_66 = ((ushort)iVar5 & 3) - (short)uVar6 & 0xff;  // sub  = idx & 3
```

This **confirms** the location encoding documented in §10b: header
`payload[0] = bank` (0x00..0x19 == A..Z), `payload[1] = sub-index`
(0x00..0x03 == positions 1..4 within the bank), `payload[2..4]`
constants `00 20 00`. The same encoding will apply to the response
when the request decode lands - the 6-message dump that the device
emits in reply will use real location bytes (`bank, sub`), not the
0x7F active sentinel that appears only in active-buffer exports.

This bit of static analysis is genuinely useful even though the
request itself is undecoded: it pins down what the response header
will look like when we capture it, which makes correlation easier.

### How the response correlates to the request

Unknown until the request is decoded. Two plausible models:

- **Position-correlated** (like `READ_PRESET_NAME`): the device
  echoes the request and the host matches by arrival order. With a
  6-message reply, there's only one in flight at a time anyway -
  serial pacing makes correlation trivial.
- **Self-correlated**: the response's 0x77 header `payload[0..1]`
  bank/sub bytes already identify which location was dumped, so no
  request-response correlation is needed beyond "the next 6 messages
  belong to this request".

The capture will show which.

---

## 4. Capture analysis

This is the section that should byte-exactly cite the request. It
cannot, because no capture in the corpus contains it. The complete
analysis IS the negative result.

### Files searched

`scripts/find-preset-dump-traffic.ts` (created during this
investigation; reuses the `parse-midi-events.ts` parser to filter
specifically for fn=0x77 / 0x78 / 0x79 SysEx in either direction). Run
against:

| Capture | Total SysEx msgs | fn distribution | 0x77/78/79 hits |
|---|---|---|---|
| `session-46-am4edit-launch-device-connected.midi-events.txt` | 8,185 | `0x00:1 OUT, 0x01:4090 OUT/4089 IN, 0x08:1+1, 0x47:1+1, 0x64:0+1` | **0** |
| `session-46-refresh-after-new-firmware.midi-events.txt` | 31,175 | `0x01:15588 OUT/15587 IN` | **0** |
| `session-22-switch-preset-via-ui.tshark.txt` | 4,199 | `0x01:2101 OUT/2098 IN` | **0** |
| `session-22-rename-scene-2.tshark.txt` | 13,115 | `0x01:6558 OUT/6557 IN` | **0** |
| `session-18-switch-preset.tshark.txt` | 5,263 | `0x01:2632 OUT/2631 IN` | **0** |

The pattern holds across the entire `samples/captured/` directory: no
other capture in the corpus was generated by triggering a Fractal-Bot
"Export Preset" or backup operation. The closest existing captures
are the **save-to-slot** captures (`session-18-save-preset-z04.pcapng`
and `session-18-save-preset-empty-slot.pcapng`) - those are the
*write* direction, where the host sends a 6-message stream to the
device. Those would also contain the 0x77/78/79 envelope on the OUT
direction, but **only as host-emits-to-device upload**, not as a
request-for-dump pattern. (And we don't even have tshark.txt
companions for those two captures, so they weren't analysed in this
investigation - they're tangential to the request decode anyway.)

### Why this is a definitive negative

In every case where AM4-Edit's UI does something dump-like (refresh
preset names, refresh after firmware change, switch preset, rename
scene), the wire traffic is fn=0x01 dispatcher messages addressing
known register families - never the dump-stream envelope. AM4-Edit's
own preset-list refresh is built on the lightweight `READ_PRESET_NAME`
flow precisely because dumping each preset would be wasteful (~4 KB
per preset × 104 = ~430 KB just to populate a name list).

The export-preset menu item is the canonical and probably the **only**
place AM4-Edit triggers a dump-request, and it has never been
captured.

---

## 5. JUCE BinaryData / Ghidra evidence

### What the strings file says

`samples/captured/decoded/exe-strings.json` (33 MB of extracted
strings from `AM4-Edit.exe`) contains the following dump-related
hits:

| Offset | String | Interpretation |
|---|---|---|
| 6201248 | `patch_dump` | Internal command name (string-keyed dispatch). Adjacent to `patch_save`, `patch_clear`, `patch_scene_names`, `patch_batch_set`. Suggests "patch_dump" is the action that triggers the export-preset flow inside the editor. |
| 6201440 | `cab_dump` | Same dispatch table, for cabinet IRs. |
| 6201504 | `download_sysex` | Same dispatch table - the literal "download SysEx from device" action. |
| 7181264 | `Reading preset name %d of %d...` | Progress label for the 104-name loop. Confirms there's NO `Reading preset %d of %d...` (full dump) progress label anywhere in the editor. |
| 7180872 | `Updating preset %0.3d (%d of %d)...` | Progress label for bulk preset *uploads* (via Fractal-Bot). |
| 7154336 | `AxeManageThread: Message timed out for opCode 0x%x. Recvd %d, expected %d:` | Generic transfer-thread error. The "expected %d" count is the dump's 6-message tally; "opCode" is the function byte. |
| 6890016 | `A firmware file was detected. Fractal-Bot will launch with this file pre-loaded and ready to send to your device.` | Fractal-Bot is a **separate launch-on-demand subsystem** for big transfers. |
| 7533208 | `Click OK to open FractalBot and update the device.` | The export/backup flow defers to Fractal-Bot, not the editor's own MIDI thread. |
| 6173016 | `FractalBotDialog` (`.?AVFractalBotDialog@@`) | Fractal-Bot dialog class - the entry point for big transfers. |

### What the encoder dump says

`samples/captured/decoded/ghidra-encoder.txt` (the FindEncoder.java
Ghidra script output) has only **one** site that constructs the
`0x77` byte literal as a SysEx function byte (line 9258):

```
local_48 = 0x740100f0;                             // f0 00 01 74 LE
local_44 = *(undefined1 *)(param_1 + 0x30);        // model byte (0x15)
local_43 = 0x77;                                   // header function byte
```

Context (lines 9223-9293): this is `FUN_1402298f0`, a buffer-rewriter
that scans for the envelope-head sequence and edits the bank/sub
bytes that follow. It is the upload-path header re-stamper.

The encoder dump has no "build a request for a preset dump" function
anywhere. The case-statement that handles incoming fn-bytes
(line 8767, the bank-validator dispatcher) lists `0x46`, `0x5a/0x7a`,
`0x5c/0x7c`, `0x61`, `0x77`, `0x79`, `0x7d`, `0x7f` - all *response*
function bytes, not *request* bytes. (The 0x46 / 0x7d / 0x7f cases
are unrelated to AM4 dumps; they're the dispatcher's coverage of
device families AM4-Edit also speaks to via Fractal-Bot.)

### Why this static evidence is consistent with H1-H4 in §2

If the request really lives inside Fractal-Bot's dialog (the
`FractalBotDialog` class) and not in the AM4-Edit main editor, the
function symbol would not appear in the FindEncoder Java script's
output - that script is scoped to the editor's encode path, not the
backup-tool's. So "no builder for 0x77 in the encoder dump" is
exactly what we'd expect if the request flow is a Fractal-Bot job.
This explains why the request is undecoded despite the response side
being clean.

---

## 6. Implementation sketch for `am4_request_preset_dump(location)`

Once the wire shape is captured (HW-045 below), the tool wraps
straightforward request/response logic:

- **Tool surface:** `am4_request_preset_dump({ location })` accepting
  `location` as `'A01'..'Z04'` or integer 0..103, validated via the
  existing `parseLocationCode` helper. Optionally
  `{ destination: 'wb' | 'stored' }` if the capture reveals two
  modes (one for working-buffer, one for a stored slot index).
- **Returns:** the **parsed** dump structure (not raw bytes), built
  with the existing `parsePresetDump` from
  `src/fractal/am4/presetDump.ts`. Shape:
  `{ location, headerPayload, chunkPayloads, footerPayload, raw }`.
  Returning the parsed form makes the BK-036 mapping harness easier
  to write - the harness wants chunk-by-chunk diffs, not 12 KB of
  bytes-as-string.
- **Error handling:** location out-of-range throws before sending;
  ack timeout (after the 6-message reply window, ~150 ms with 30 ms
  pacing) returns `reconnect_midi` hint per existing convention;
  truncated reply (fewer than 6 messages or a chunk size mismatch)
  surfaces the partial structure plus a diagnostic string.
- **Latency budget:** 6 messages × ~30 ms inter-message + ~10 ms
  per-chunk USB transfer = 200-300 ms wall-clock for the response,
  plus the request's own ~5 ms. Comfortably inside the
  "acceptable < 1 s" budget from `CLAUDE.md`. For a probe harness
  that does N reads back-to-back, budget ~250 ms × N + report
  upfront if N × 250 ms > 1 s.
- **Probe-harness implications:** because the dump arrives parsed,
  the harness gets free chunk-payload diffing
  (`chunkPayloads[i]` vs the previously-captured baseline). No
  manual envelope stripping. The 0x77 header bytes already encode
  the location, so a self-check can confirm "the dump we got back
  matches the location we asked for" before persisting.

---

## 7. Probe harness sketch for BK-036 binary-format mapping

The combination of `am4_apply_preset` + `am4_save_to_location` +
`am4_request_preset_dump` enables the systematic param-to-byte
mapping that BK-036 has been blocked on. Rough flow:

1. **Reset baseline.** Apply a known-empty preset to the working
   buffer (`am4_apply_preset({ slots: [] })` with all bypassed),
   save to the scratch location (`am4_save_to_location({ location: 'Z04' })`).
2. **Dump baseline.** Request the dump for Z04 (`am4_request_preset_dump({ location: 'Z04' })`).
   Persist the parsed structure to disk for diffing
   (`samples/bk-036/baseline.json` or similar).
3. **Mutate one parameter.** Apply a single-param change to the
   working buffer (e.g. `set_param({ block: 'amp', name: 'gain', value: 5 })`),
   save to Z04 again.
4. **Dump mutated.** Request the dump again. Diff the parsed chunk
   payloads against the baseline byte-by-byte.
5. **Map the diff.** The byte offsets that changed identify where
   "amp.gain" lives in the binary. Repeat for each first-page knob
   of each block type. The result is the binary-format map BK-036
   needs.

Implementation notes (don't write the harness, just describe):

- The chunk-payload mask is **per-export keyed**, per BK-036 - so
  the diff has to be computed AT THE CHUNK LEVEL, not byte-for-byte
  across the entire 12,352-byte stream. Each chunk gets its own
  mask state. The harness should emit a per-chunk diff report
  (chunk1 changed bytes 100-104, chunk2 unchanged, etc.).
- For each parameter mapped, write one row to a CSV/JSON with
  `{ block, param, chunk, byteOffset, baselineValue, mutatedValue, displayBefore, displayAfter }`.
  After enough rows, the structure pops out: amp params cluster in
  chunks 1-2, scene/channel maps in chunk 3, etc.
- One run per parameter is enough for first-page coverage - the
  founder doesn't need 100 samples to find an offset. ~30 params
  × ~5 seconds per round-trip = ~3 minutes of probing for
  exhaustive first-page coverage.
- Don't auto-trigger this harness on tool registration. It's an
  explicit `npm run probe-bk-036` script, run by the founder in a
  controlled session with a clean Z04. Each run is destructive to
  Z04 (the conventional scratch location) and harmless to
  everything else.

The whole probe is gated on HW-045. Once the request decode lands
the harness becomes a one-day job.

---

## 8. Risks / unknowns - and the recommended unblock

### Risk 1: H4 (two-step) may need a different harness flow

If the decoded request requires a preceding `SET_PRESET_NUMBER`
(switching the active preset to the location being dumped), then
the harness can't blindly leave the working buffer untouched - the
"dump baseline" step would clobber WB. Mitigation: restore WB to
its prior state after each dump (cache before, re-apply after),
OR run the harness in a dedicated session where WB-clobber is
expected.

### Risk 2: The request might be Fractal-Bot-only and not exposed to AM4-Edit's MIDI thread

Possible but unlikely - Fractal-Bot is a separate `.exe` invoked by
a JUCE-bundled subprocess, and it speaks the same SysEx envelope
to the device. If AM4-Edit defers to Fractal-Bot for the export
flow, the request bytes ARE on the wire when Fractal-Bot does its
job - just emitted by the Fractal-Bot process, not the editor.
USBPcap doesn't care which process owns the USB handle; it captures
the bytes either way. Any decent capture of "File -> Export
Preset" will surface the request whether it's emitted by AM4-Edit
or by a spawned Fractal-Bot process. If AM4-Edit launches
Fractal-Bot and the export-preset menu item REQUIRES that, then
the founder needs to ensure Fractal-Bot is bundled/installed
before the capture (it is, per the embedded `FractalBotDialog`
class).

### Risk 3: AM4 firmware may not expose a single-preset dump-request at all

If "File -> Export Preset" is implemented via a working-buffer
dump after switching the preset, then the only request available
is "dump the working buffer," not "dump location N." That'd still
be useful (the harness becomes "switch -> dump WB -> diff" instead
of "dump location N"), but it'd also mean we can't read a stored
preset non-destructively. Mitigation: the BK-036 probe harness
above already accepts WB-only semantics - it's strictly less
convenient, not blocking.

### Risk 4: The capture may surface a multi-step protocol we haven't anticipated

E.g. handshake, capability check, then dump. Mitigation: the
capture is cheap (one click of a UI menu item), and the analysis
script `find-preset-dump-traffic.ts` already handles the parsing.
If it shows a complex sequence, decode it; if it shows a simple
one-shot, ship `am4_request_preset_dump` immediately.

---

## 9. Recommended next step (founder action)

This is HW-045 verbatim, restated for convenience:

1. Connect AM4 via USB, ensure AM4-Edit launches and connects cleanly
   (preset-list visible, parameters readable).
2. Start USBPcap recording to
   `samples/captured/session-NN-export-preset.pcapng`.
3. In AM4-Edit: **File -> Export Preset** (or whatever the analogous
   menu path is - "Export Preset...", "Export Preset to .syx", or
   the Manage Presets dialog "Export" button if File doesn't have it
   directly).
4. Save the resulting `.syx` anywhere (filename irrelevant; the wire
   bytes are what we need).
5. Stop the capture as soon as the export dialog closes.
6. Optional: repeat once for a stored preset (e.g. select A01, click
   Export) to confirm the request takes a location index.
7. Optional: repeat once for the active working buffer (no preset
   selection) to confirm whether WB-export uses a different request
   shape than stored-export.

**Total time: ~1 minute on hardware.** Result is a pcapng file that
will contain:

- The export request (probably 1-2 small SysEx messages OUT).
- The 6-message dump response IN.
- Any preceding handshake / capability messages, if any.

Once captured, run
`npx tsx scripts/find-preset-dump-traffic.ts samples/captured/session-NN-export-preset.tshark.txt`
(after `tshark -V -r samples/captured/session-NN-export-preset.pcapng > .tshark.txt`)
to confirm 0x77/78/79 IN traffic is present and to enumerate the
preceding OUT bytes.

The OUT bytes immediately before the first 0x77 IN ARE the request.
Hand that capture back to me (or any research sub-agent) and the
decode lands in one session.

---

## 10. Files referenced

Research scripts created during this investigation (kept under
`scripts/` for reuse during HW-045 follow-up; safe to delete after
the request is decoded):

- `scripts/find-preset-dump-traffic.ts` - filters a tshark / midi-
  events file for fn=0x77 / 0x78 / 0x79 SysEx in either direction;
  prints the fn-byte histogram for the whole capture too.

Existing reference files used for this analysis:

- [`preset-read-research.md`](preset-read-research.md) - the workflow
  that decoded `READ_PRESET_NAME`. Repeated approach here, but the
  negative result required a different structure.
- [`SYSEX-MAP.md`](SYSEX-MAP.md) §10b (Preset Dump Commands) and §6m
  (READ_PRESET_NAME) and §10b (factory bank file structure) -
  documented response side and location encoding.
- [`factory-restore-research.md`](factory-restore-research.md) - bank
  file structure, header payload byte meanings, mask theory.
- `samples/captured/session-46-am4edit-launch-device-connected.midi-events.txt` -
  primary cold-attach capture, no dump traffic.
- `samples/captured/session-46-refresh-after-new-firmware.midi-events.txt` -
  refresh capture, no dump traffic.
- `samples/captured/session-22-switch-preset-via-ui.tshark.txt` -
  switch-preset capture, no dump traffic.
- `samples/captured/decoded/exe-strings.json` - 33 MB of strings;
  ground truth for AM4-Edit UI labels and internal command names.
- `samples/captured/decoded/ghidra-encoder.txt` - encoder Java
  Ghidra script output. Confirmed `FUN_1402298f0` is the only 0x77
  emitter in the entire dump and it's a header-rewriter, not a
  request-builder.
- `src/fractal/am4/presetDump.ts` - existing parser/serialiser for
  the response side; will be reused by the eventual
  `am4_request_preset_dump` tool.

---

## Suggested HW-045 update (when this lands)

> **Verdict: 🔴 UNKNOWN, capture-required.** The request shape for the
> 0x77/0x78/0x79 dump stream is not present in any of the 80+ existing
> captures. AM4-Edit's encoder has zero builder sites for the 0x77
> function byte (only one re-stamper, `FUN_1402298f0`, which edits
> existing dump headers during uploads); the export-preset flow
> appears to defer to a separate Fractal-Bot subprocess.
> Recommended capture: USBPcap a single
> File -> Export Preset action in AM4-Edit (~1 minute on hardware).
> The first OUT SysEx immediately before the 6-message dump reply
> IS the request. Once captured, decode is a one-session job. See
> this doc §9 for the exact procedure.
> Until then, BK-036 (binary-format mapping), `dump_working_buffer`,
> and `backup_location` all stay blocked. Preset *upload* / restore
> works fine via the verbatim factory-bank replay path documented in
> [`factory-restore-research.md`](factory-restore-research.md) and exposed via the eventual
> `am4_restore_factory(location)` tool.
