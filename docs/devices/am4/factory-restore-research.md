# Factory-restore feasibility - research notes

Status: research-only. Static analysis complete. Hardware send still pending
(blocked on HW-068 finishing; founder runs `--send` once the port is free).

Companion artefacts:
- `scripts/probe-factory-restore.ts` - parses the bank, prints per-slot
  summary, dry-runs a "WOULD SEND" sequence for the chosen slot, and
  optionally transmits with `--send --slot=<code>`.
- Existing helpers: `src/fractal/am4/presetDump.ts` (parse/serialize),
  `src/fractal/am4/locations.ts` (A01..Z04 codec), `src/fractal/am4/midi.ts`
  (`connectAM4`).
- Existing golden: `scripts/verify-preset-dump.ts` already proves the
  parse/serialize round-trip is byte-identical on every one of the 104
  factory dumps. That's the foundation this whole thing rests on.

## 1. What the factory bank file is

`samples/factory/AM4-Factory-Presets-1p01.syx` is Fractal's own factory
preset bank, downloaded from <https://www.fractalaudio.com/am4-downloads/>
and meant to be uploaded to the device via Fractal-Bot per
`samples/factory/README-AM4-VP4-Presets-Update-Guide.txt`. Same byte stream,
same purpose: replay = restore.

- Total size: 1,284,608 bytes = exactly 104 x 12,352.
- Format: 104 back-to-back AM4 preset dumps in the documented 0x77 / 0x78 /
  0x79 envelope ([`SYSEX-MAP.md`](SYSEX-MAP.md) §10b). No file-level header, no
  separator, no trailer.
- Each per-preset dump is 6 SysEx messages: 1 header (0x77, 13 B), 4 chunks
  (0x78, 3082 B each), 1 footer (0x79, 11 B).
- Every message has the AM4 envelope `F0 00 01 74 15` and a valid Fractal
  XOR-and-0x7F checksum. `parsePresetBank` in
  `src/fractal/am4/presetDump.ts` validates all of this in one call.

The bank file IS the canonical stored form. There is no transformation
between "factory bank as distributed by Fractal" and "what the device
holds at each location" - Fractal-Bot streams the file's bytes verbatim
to the device.

## 2. Per-slot structure

Confirmed by running the probe in dry-run mode:

| field | value | notes |
|---|---|---|
| presets | 104 | matches A01..Z04 |
| messages per preset | 6 | 1 header + 4 chunks + 1 footer |
| total bytes per preset | 12,352 | constant across all 104 |
| header payload[0] | 0x00..0x19 | bank index A..Z, monotonic across the file |
| header payload[1] | 0x00..0x03 | sub-index 0..3 within the bank |
| header payload[2..4] | constant `00 20 00` | identical across all 104 dumps |
| chunk payload size | 3074 B (envelope strips 8 B) | constant |
| chunks 1..2 | content-bearing (block layout, params, name) | mostly non-zero |
| chunks 3..4 | mostly zeros | per [`SYSEX-MAP.md`](SYSEX-MAP.md) §10b - padding for unused slots/channels |
| footer payload | 3 B | distinct across all 104 (content-derived hash) |

Slot ordering in the file is monotonic A01, A02, A03, A04, B01, ..., Z04.
No special-template slots, no oddly-sized presets, no `0x7F` active
sentinel (which would only appear in an active-buffer export, not in the
stored bank).

Slot index is encoded explicitly in header payload bytes [0..1], not
implicit by file ordering. That's the lever that makes "restore A01 to a
DIFFERENT location" technically possible (rewrite payload[0..1], recompute
the 0x77 checksum, send) - but for `restore_factory(N)` we only need
verbatim replay, so we never touch those bytes.

## 3. The masking question (BK-036 vs replay)

BK-036 finding (paraphrased): the 0x78 chunk payloads are per-export
scrambled. An active-buffer export of factory A01 (`A01-original.syx`,
header sentinel `0x7F`) has chunk-payload SHA-256 different from the bank
file's A01 entry (header bank=`0x00`, sub=`0x00`). The scramble appears to
be keyed by the 0x77 header location bytes.

This matters for fingerprinting (you cannot SHA-compare two exports of
the same content and expect them to match). It does NOT affect replay:

1. The factory bank file already contains the "stored form" mask for each
   slot, baked in at the slot's actual location bytes (`bank=0x00, sub=0x00`
   for A01, etc.). Sending those bytes back to that same location is just
   asking the device to restore exactly what Fractal originally shipped.
2. The verify-preset-dump golden has already proved parse -> serialize is
   byte-identical for all 104 entries, which means we can hand the device
   the exact bytes Fractal-Bot would hand it.
3. Fractal's own update guide (`samples/factory/README-AM4-VP4-Presets-Update-Guide.txt`)
   documents this exact replay model: download the .syx, send it via
   Fractal-Bot, done.

So: BK-036 is a fingerprinting/decode problem, not a replay problem.
`restore_factory(N)` only needs replay. The chunk-mask decode work
remains valuable for `list_locations` and "what changed since last save"
UX, but it is not on the critical path for factory restore.

The one nuance worth flagging: cross-location restore (replay A01's
bytes to slot M03, say) WOULD likely require unmasking + re-masking
the chunks against the new location, since the mask appears keyed by
the header location bytes. That is out of scope for `restore_factory`,
which is location-pinned by design.

## 4. What the probe will tell us when run

After the founder runs `npx tsx scripts/probe-factory-restore.ts --send --slot=Z04`
on hardware:

Pass signals:

- The 6 SysEx messages transmit without throwing.
- The AM4 front-panel display, when navigated to Z04, shows the **factory
  preset name** for that location ("CleanCrunch", whatever Z04's factory
  name is - check the AM4 manual / preset list to know what to expect).
- A subsequent `am4_switch_preset` call (or front-panel selection) to Z04
  audibly loads the factory tone: the right block layout, the right
  channel-A defaults, the factory mix.
- Optional read-back: `am4_get_preset_name` after the restore should
  return the factory name string.

Fail signals (each with diagnostic guidance):

- The device emits a `0x64 MULTIPURPOSE_RESPONSE` with `rc=0x05` (NACK).
  Likely cause: pacing too fast - bump `INTER_MESSAGE_DELAY_MS` from 30
  to 100 and retry. Less likely: per-export scramble keyed by something
  beyond header bytes (would refute BK-036's working theory).
- Front-panel display shows the slot empty / corrupt name characters.
  Likely cause: header byte change applied without checksum recompute
  (we don't do this, but worth knowing the failure mode looks like).
- No response at all. Likely cause: stale MIDI handle - same recipe as
  HW-066 / HW-068, follow the `reconnect_midi` lead.

## 5. Risks and unknowns (honest list)

1. **Pacing.** The Fractal Presets Update Guide leaves Fractal-Bot in
   charge of message pacing; we have no documented minimum delay. 30 ms
   between messages is conservative against the 30-60 ms ack window the
   AM4 typically uses, but the actual minimum could be lower or higher.
   First `--send` test will tell us.
2. **No ack capture in the probe yet.** The current script is fire-and-
   forget - it sends bytes and trusts the device. A v2 should listen for
   `0x64` ACKs after each message (or at least after the footer) and
   flip "success" output to "ACKed" / "NACKed". Adding it now is easy
   (`conn.receiveSysExMatching`) but I deliberately left the probe
   minimal so the founder's first test is "does the device accept the
   bytes at all" without parser noise on top.
3. **Active-buffer side-effect.** Uploading a preset to slot N might or
   might not change what's currently in the working buffer. AM4-Edit's
   behaviour suggests "no" (the working buffer is independent of stored
   slots), but the probe doesn't measure this. If the user has unsaved
   edits in the buffer, a factory-restore of the SAME location they're
   editing could be confusing. The MCP tool will need to surface this -
   probably "this only affects the stored preset; your working buffer is
   untouched, switch to the location to load it".
4. **Firmware-version compatibility.** Fractal's own update guide warns
   "newer presets on older firmware appear blank." The factory bank
   filename pins it: `AM4-Factory-Presets-1p01.syx`. If a user's AM4 is
   on firmware older than 1.01, restore could land a blank preset. The
   MCP tool should read firmware version (0x08) at startup and refuse
   restore if older than the bank's version.
5. **Mid-stream interruption.** If the user pulls the cable mid-restore
   (or the OS kills the MCP server), some chunks could land and others
   not. The device's behaviour with a half-written preset is unknown -
   it might keep the old preset intact (good) or end up with a corrupt
   slot (bad). Mitigation: send all 6 messages in one synchronous burst,
   document recovery path ("re-run the restore"), and consider an
   auto-backup-before-restore step in the eventual MCP tool.

## 6. Implementation sketch for `restore_factory(location)`

Once the probe passes on hardware, the MCP tool wraps almost identical
logic. Five-bullet sketch:

- **Tool surface:** `am4_restore_factory({ location: 'A01'..'Z04' })`.
  Validates the code via `parseLocationCode` (already throws on bad
  input). Refuses any other input shape; refuses missing `location`.
- **Bank loading:** read `samples/factory/AM4-Factory-Presets-1p01.syx`
  once at server startup, parse with `parsePresetBank`, cache the
  resulting array. The file is a static asset bundled with the
  installer; missing-file is a startup-time error, not a tool-time
  error. (Already gitignored - the installer copies it in from the
  download.)
- **Pre-write safety:** read the current preset name at the target
  location, surface it to the user ("about to overwrite *<current name>*
  at A01 with factory <factory name>"), and require explicit
  confirmation. The existing safety pattern in `src/fractal/am4/safety/`
  already covers this for the save flow; reuse it.
- **Send path:** identical to the probe's `--send` branch - 6 messages,
  conservative pacing, optionally `receiveSysExMatching` for `0x64` ACKs.
  On NACK, surface "restore failed at chunk N - device may be in a
  partial-write state, retry the restore" rather than swallowing.
- **Error handling:**
  - bad location code -> `parseLocationCode` already throws with a
    user-facing message;
  - MIDI port not available -> reuse the `reconnect_midi` hint surfaced
    by other write tools;
  - firmware version mismatch -> refuse restore, point user at firmware
    update;
  - the bank file is missing -> startup-time error, surfaced via
    `list_midi_ports` / health endpoint, not a tool-call surprise.

Performance: 6 messages x 30 ms = ~180 ms wire time, plus device
processing. Well inside the 1 s "acceptable" bucket from CLAUDE.md's
performance budget.

## 7. Stock-or-custom detection sketch

Less valuable than restore but cheap on top of it: an
`am4_is_factory_preset(location)` warning agents can use before bulk
destructive ops ("you have custom presets here, are you sure?").

### What BK-036 actually constrains

Re-reading §3: only 0x77 header location bytes are identified as the
*likely* mask key, from a one-pair sample (active A01 vs stored A01).
That's a hypothesis, not proven determinism. Until BK-036 decodes the
mask we should treat byte-level chunk SHA as possibly-deterministic-
given-location, possibly-not — so a naive
`sha(deviceReadback) == sha(bankSlotN)` is fragile even at the same
location.

### Three candidate approaches

- **(a) Demask + content hash.** Strongest signal; needs BK-036 done.
  Out of current scope.
- **(b) Cleartext-field comparison.** Compare only fields known to be
  readable plaintext via separate SysEx reads: preset name, block
  layout (`pidLow=0x00CE pidHigh=0x000F..0x0012`), per-block channel +
  bypass. All match bank slot N → factory; any differ → custom, with
  *which* fields named.
- **(c) Device-side dirty flag.** Searched `exe-strings.json` for
  `dirty | modified | userPreset | isFactory | unsaved`. Hits
  (`PROMPT_PRESET_MODIFIED`, "The preset has been modified.") are
  AM4-Edit's own client-side session edit-tracking, not a
  device-readable bit. The `(Factory)` label suffix implies AM4-Edit
  fingerprints client-side too. No evidence of an AM4-exposed dirty
  bit; (c) not feasible without further RE.

### Recommended: approach (b)

Cheap, doesn't depend on cracking the mask, precise enough for the
warning use case. "False positives" (rename a factory preset →
reported as custom) are correct UX — any user-visible change SHOULD
count as customised.

### Implementation sketch for `am4_is_factory_preset(location)`

- **Input / output:** `{ location: 'A01'..'Z04' }` →
  `{ isFactory: boolean, mismatchedFields: string[],
  factoryName: string, currentName: string }`. The field list lets the
  agent narrate severity ("name only" vs "layout differs").
- **Bank source:** reuse the cached `parsePresetBank` result from
  §6's startup load. No new file I/O.
- **Comparison fields:** preset name (string equality); slot
  layout (sequence of 4 block-type ints from `pidHigh=0x000F..0x0012`
  reads); per-slot channel + bypass state. Each field is a separate
  device read; total ≈ 6-8 wire round-trips (~300-400 ms).
- **Returns:** `isFactory=true` iff `mismatchedFields.length === 0`.
  `mismatchedFields` uses stable names (`name`, `slot1.blockType`,
  `slot2.channel`, etc.) so callers can pattern-match.
- **Tool-description caveat:** "Compares user-visible fields, not raw
  chunk bytes. Sufficient for bulk-overwrite warnings; not a
  cryptographic factory-integrity check." Byte-level certainty waits
  on BK-036.
