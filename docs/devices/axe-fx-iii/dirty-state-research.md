# Axe-Fx III dirty-state signal — research findings

**Question.** Does the Axe-Fx III broadcast unsolicited MIDI on user edits
(front-panel knob turns, AxeEdit III parameter writes), or does it stay
silent like the AM4 — requiring a poll-based fingerprint to detect dirty
state?

## Conclusion

🟡 **The III broadcasts on USB, but only via `fn=0x01` sub-action `04 01`
(STATE_BROADCAST), not via a dedicated `0x21 FRONT_PANEL_CHANGE` opcode.**
The classifier pattern from the Axe-Fx II will work — wire up a
`fn=0x01 + subAction=0x0184` predicate on inbound USB traffic and call
`markDirty('axe-fx-iii')` from it. Confidence is **MEDIUM**: the
broadcast frames are byte-decoded and the parser already exists
(`parseSetGetParameterResponse` in `packages/axe-fx-iii/src/setParam.ts`),
but the captures come from passive AxeEdit-III sniffs — they prove the
device emits on USB **while AxeEdit is connected**, not that it emits
when the host is the MCP server alone. A 30-second hardware test would
flip this to 🟢. Do NOT port the AM4 fingerprint pattern as a first
choice — the III has a real broadcast.

## Evidence summary

Strongest first.

- **5 byte-decoded `04 01` STATE_BROADCAST captures already exist on the
  III, all on USB.** Source: passive sniffs of AxeEdit III ↔ III
  traffic. Effect IDs span 1, 2, 58, 59, 190 — full Appendix 1 range,
  consistent with a state-stream the device emits during edits. Field
  layout: `[id_lo id_hi 00 00 value_lo value_hi flag 00*6 cs]`. See
  [`fn01-decode.md`](fn01-decode.md) §"Sub-action `04 01` —
  STATE_BROADCAST (device→host)" (lines 105-134) and
  `packages/axe-fx-iii/src/setParam.ts` `parseSetGetParameterResponse`
  (lines 300-331, branch at line 314).
- **v1.4 PDF (`docs/manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.txt` lines 149-176)
  explicitly enumerates only TWO documented pushes: tempo down-beat
  (0x10) and tuner (0x11).** Both are gated by the "Send Realtime
  Sysex" global parameter AND — critically — Fractal says: "this data
  ONLY streams over the MIDI Out jack. It does not stream over the
  MIDI-Over-USB output." So the **documented push frames don't reach
  us at all** over USB; whatever the III emits on USB during normal
  AxeEdit operation is undocumented territory.
- **`0x21 FRONT_PANEL_CHANGE` is a phantom.** Earlier design notes
  ([`design-notes.md`](design-notes.md) line 25) cite `0x21` as the III's
  dirty signal. [`SYSEX-MAP.md`](SYSEX-MAP.md) lines 67-69 retracts
  this: "Source for that claim is unidentified; treat as unverified."
  Session 82 Ghidra mining of `Axe-Edit III.exe` enumerated every
  fn byte AxeEdit III emits (SYSEX-MAP-AXE-FX-III.md lines 720-752);
  **0x21 is not in the list.** SYSEX-MAP also notes (lines 614-619)
  forum reports of "TONS of messages" with fn=0x21 during front-panel
  knob movement — but those reports almost certainly describe **MIDI
  Out jack** broadcasts (tempo down-beat heartbeat, 0x10 — which
  *is* on the MIDI Out per v1.4), not USB traffic.
- **AxeEdit III is observably state-syncing in real time** without
  polling-storm traffic. That only works if the device emits
  something. Combined with the 5 captured `04 01` frames, this points
  to fn=0x01 STATE_BROADCAST being the III's real state-feedback
  channel — the spec just doesn't document it because it's not part
  of the third-party MIDI surface.
- **OSS priors are silent on this.** bspaulding/axe-fx-midi
  (`docs/devices/axe-fx-ii/community-re-methodology.md` lines 42+) and
  tysonlt/AxeFxControl (line 74+) are request-response only — they
  navigate and read, they don't listen for state pushes. No prior
  art either way.
- **AM4 + II evidence sets the methodology bar.** AM4 closure HW-107
  (`docs/_private/HARDWARE-TASKS-AM4.md` line 61-64, archived) was a
  passive capture: idle 66.7 s = 0 messages, preset-switch 16.6 s = 0
  messages. II broadcast confirmation
  (`docs/devices/axe-fx-ii/state-broadcast-decode-research.md`) was the same
  passive shape: 0x12/0x15/0x10 firehose continuously, plus
  0x74/0x75/0x76 triple ONLY on edit actions. **A passive III capture
  matching either shape would settle this in one session.**

## Implementation under each hypothesis

### If broadcast (recommended starting assumption — port the II pattern)

Mirror the II classifier from
`packages/axe-fx-ii/src/midi.ts` (the inbound-handler block at lines
243-268). Specifically:

- Add `isStateBroadcastInboundIII` to `packages/axe-fx-iii/src/midi.ts`:
  predicate is `bytes[5]===0x01 && bytes[6]===0x04 && bytes[7]===0x01`
  (fn=0x01 + sub-action `04 01`). The parser exists already at
  `packages/axe-fx-iii/src/setParam.ts:300-331` — caller doesn't need
  it for the dirty signal, just the predicate.
- In the III connection's inbound-data handler, call
  `markDirty('axe-fx-iii')` whenever the predicate matches.
- Belt-and-suspenders: also call `markDirty` from the outbound side
  on `buildSetParameter` / `buildSetBypass` / `buildSetChannel` —
  mirrors `isEditOutbound` in II midi.ts line 268.
- Clean transitions: `markClean('axe-fx-iii')` after successful
  preset switch (PC bytes) and after successful save (when
  `buildStorePreset` lands).
- Wire `guardActiveBufferOrSave` for III in a new
  `packages/axe-fx-iii/src/tools/shared.ts` modelled exactly on
  `packages/axe-fx-ii/src/tools/shared.ts` lines 140-256. Reuse
  `core/server-shared/safeEdit.ts` for the schema + types.

New files needed in `packages/axe-fx-iii/src/`:
- `tools/shared.ts` (mirror II's structure: lazy conn, dirty label,
  `guardActiveBufferOrSave`).
- Modify `midi.ts` to add the inbound classifier (no new file).

### If silent (fallback — port the AM4 pattern)

If the 30-second hardware test (below) shows zero `04 01` frames
during user front-panel edits, fall back to fingerprinting. Port
from:

- `packages/am4/src/bufferFingerprint.ts` (whole file — SHA-256 of
  buffer-dump payload, Map keyed by location index).
- `packages/am4/src/tools/safeEdit.ts` (whole file — the navigation-
  seam guard that does dump → hash → compare).

The III's analog to AM4's `am4_request_active_buffer_dump` would be
a 0x13 `STATUS_DUMP` (cheap, ~ms-scale, already wired:
`buildStatusDump` at `setParam.ts:693`) PLUS a per-block parameter
read loop. STATUS_DUMP alone catches bypass/channel/scene changes
but misses per-knob parameter edits — fingerprinting parameter
values needs an `fn=0x01` GET sweep, which is itself hypothesis-only
(see `setParam.ts:240-259`, GET shape is unverified). This path is
viable but more expensive than the II classifier and has more
unknowns.

## What's still uncertain — addendum for `docs/AXEFX3-BETA-TESTING.md`

A III owner can settle this conclusively in **about 60 seconds** of
testing. Propose adding a Section 9 to the beta-testing doc:

```
### 9. Dirty-state signal (the broadcast test)

Help us settle whether the III tells us when its working buffer is
edited. Two short captures, paste the JSON from each.

a. **Idle test (~15 s).** Close AxeEdit III. With Claude Desktop +
   MCP server connected, run:
       describe_device(port: 'axe-fx-iii')
   then leave the III untouched for 15 seconds. Run:
       axefx3_debug_inbound_count(window_ms: 15000)
   Report the JSON. Expected if III is silent: 0 inbound frames.
   Expected if III broadcasts unprompted: >0.

b. **Edit-while-passive test (~30 s).** Same setup. Touch the III's
   front panel: turn the AMP 1 DRIVE knob 2-3 increments. Wait 5 s.
   Bypass-toggle DRIVE 1. Wait 5 s. Run:
       axefx3_debug_inbound_count(window_ms: 30000)
   Report the JSON, including the frame-byte previews if the tool
   surfaces them.

What we're looking for: any inbound frame with byte 5 = 0x01 and
bytes 6-7 = 04 01. If present, the III broadcasts on USB and we
ship the classifier-pattern dirty signal (no polling). If absent,
the III is AM4-shaped and we ship the polled-fingerprint pattern.
```

`axefx3_debug_inbound_count` is a new diagnostic tool — a 15-line
addition to the III surface that opens the input port and counts
inbound frames in a window, returning hex previews of the first 3.
That's the minimum hardware-loop closure for this question.

## Cross-references

- `packages/axe-fx-iii/src/setParam.ts:107-110`
  (STATE_BROADCAST comment).
- `packages/axe-fx-iii/src/setParam.ts:300-331`
  (`parseSetGetParameterResponse` already disambiguates by sub-action).
- [`fn01-decode.md`](fn01-decode.md) §"Sub-action `04 01` —
  STATE_BROADCAST" (lines 105-134).
- [`SYSEX-MAP.md`](SYSEX-MAP.md) lines 67-69 (0x21 retraction) and
  lines 614-619 (forum 0x21 claim — likely MIDI-Out, not USB).
- `docs/research/fractal-broadcast-vs-poll-research.md` (the AM4/II methodology
  reference — replicate this script shape on the III).
- `docs/manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.txt:149-176` ("PUSH DATA" spec).
- `packages/axe-fx-ii/src/midi.ts:108-268` (classifier to mirror).
- `packages/am4/src/bufferFingerprint.ts` + `packages/am4/src/tools/safeEdit.ts`
  (fallback pattern to port if the hardware test refutes the broadcast).
