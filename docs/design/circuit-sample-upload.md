# Circuit Tracks sample upload: research + feasibility

## 2026-07-27: the NONZERO-PACK sample WRITE is HARDWARE-CONFIRMED, and the read-back races the flash commit

Two findings, one session (`scripts/circuit-clone-pack-samples.ts`, maintainer's
2-pack device). Full evidence in
[`circuit-pack-addressing.md` §8](circuit-pack-addressing.md); the parts that
belong to THIS document are the timing and the download bug.

**1. The write is confirmed and the slot byte is ADDRESSED.** Pack 1's pool was
read off the device, 64 of 64 slots, every download gated by the device's own
CRC32; 63 were written to Pack 2 (the 64th was already byte-identical). Wire slot
0 was written alone, then wire slot 63 SECOND and out of order, and it landed at
63, not at the next free index. Eight slots read back off Pack 2 were
md5-identical to the originals and the 64-slot name diff was clean.

**2. THE MANIFEST FLUSH IS ~6-8 s AFTER SESSION CLOSE. Read this before writing
a verification loop.** A pool read 1.2 s after the clone reported **8 slots
empty**; a later read showed every one present. Nothing had been lost, the check
was too fast. Verify by POLLING: reconnect, wait ~9 s, then retry at 5 s
intervals, and call a slot absent only once the commit window has demonstrably
passed. The Circuit has **no erase**, so a spurious "the write failed" leads to a
redo that is not harmless, which is what makes this a hazard rather than a
nuisance.

**This does not revive the refuted commit-wait theory** documented further down
(2026-06-23 / 2026-06-28). That theory was that the group-`0x08` frame ~6-8 s
after CLOSE is a commit-complete signal you can WAIT ON IN-SESSION to make a
write land; it is still refuted, because the device sends that frame pre-write
too and the slot still read empty. What is confirmed here is narrower and lives
on the other side of the close: the flush window is real, and a VERIFICATION READ
taken inside it returns a false negative. The write does not need the wait. The
reader does.

**3. CRC-gate your downloads. A real bug proves the point.** The downloader left
the trailing `F7` on each frame, so `msbDeinterleave` read it as one EXTRA data
byte per block and shifted the whole stream. The RIFF size still matched (the
reader truncates to the declared length) and the WAV still parsed, so every check
the host could author itself passed. Only the device's own WRITE_FINISH CRC32
caught it. Strip the envelope with `core()` exactly as `uploadProject.ts` does,
and keep the CRC as the gate: a check the host cannot fool beats any number of
checks the host wrote.

## 2026-07-10: prelude reply-desync bug fixed; sample LISTING is now HARDWARE-CONFIRMED

A live bench run on the maintainer's device hit `occupied=0` on a pack that
genuinely holds 64 samples (`list_samples` / `readSampleDirectory`,
`packages/circuit-tracks/src/ncs/sampleDirectory.ts`). Root cause: the 4-step
prelude (`OPEN_SESSION` → `DIR_CONTROL([0x01])` → `QUERY_INFO([0x01,0x00])` →
`DIR_CONTROL([0x02])`) can leave a late/short `DIR_CONTROL` reply still arriving
when the listing phase opens — the observed straggler was
`f0 00 20 29 01 64 03 0b 02 05 f7` (sub=0x0b, but `msg[8]`=0x02, only 11 bytes,
not a directory-listing header for anything asked). The header matcher in use
at the time, `(m) => m[7] === SUB.DIR_CONTROL`, accepted ANY sub=0x0b reply
regardless of fileType/pack, so it consumed the straggler instead of the real
header; `parseDirListHeader` correctly rejected the malformed 11-byte frame
(returned `undefined`), so `count` fell back to 0 and the listing came back
empty even though the real fileType=0x05 header (`... 0b 05 00 40 00 ...`,
count 0x40=64) and all 64 `DIR_ENTRY` replies were still on their way.

**Fix:** the header matcher is now STRICT — it only accepts a reply that is
sub=DIR_CONTROL AND answers fileType=SAMPLE AND is the full fixed 13-byte
header shape, so a stray reply for a different fileType/pack, or a truncated
frame, can never be mistaken for this call's header. A best-effort drain (one
short, match-anything receive between the prelude and the listing request) was
added as defense-in-depth. Neither change touches the confirmed frame
sequence; both are receive-discipline only. Golden-locked in
`scripts/verify-circuit-ncs.ts` (a mocked round trip with the exact stale frame
queued ahead of the real header + 64 entries; reverting the matcher to the old
loose predicate reproduces `occupied=0` exactly, confirming the golden is
meaningful).

**The fix also confirms the fileType=0x05 (SAMPLE) listing call itself.** With
the desync fixed, the SAME bench run returned the pack-0 sample directory with
`occupied=64` and correct, Components-matching names ("00_PCM.wav",
"01_stoken_4_02_kick2.wav", ...). The fileType=0x05 LISTING call (previously
flagged below as "unconfirmed for samples specifically", shipped by shape
analogy only) is no longer an analogy — it is HARDWARE-CONFIRMED. The
`capacity_note` in `SampleDirectoryResult` and the module docstring in
`sampleDirectory.ts` are updated accordingly.

**Still open / proposed follow-ups (not implemented this session):**
- `readSampleDirectory` always reads pack 0 (the active/written SD pack, itself
  hardware-confirmed correct). The device supports additional SD packs at
  higher indices; reading a non-active pack is a proposed future story
  ("multi-pack SD addressing"), not a bug in the current pack=0 default.

## 2026-07-09: sample-directory READ re-decoded from a genuine Get-Pack capture: `read_sample_directory` / `list_samples` is LIVE again (community-beta)

The 2026-06-27-disabled `readSampleDirectory` (`packages/circuit-tracks/src/ncs/
sampleDirectory.ts`) is REPLACED with a re-decode from `samples/captured/
get_pack_from_circuit_tracks.pcapng` (USBPcap, Novation Components' own "Get
Pack from Circuit Tracks" action (a genuine, non-destructive READ); decoded
with `scripts/_research/decode-circuit-usbmidi.py`, no tshark needed). This
re-enables the already-registered `list_samples` MCP tool (it was throwing
the disabled-guard error on every call; the tool itself needed no changes).

**Confirmed non-destructive LISTING protocol** (byte offsets from `F0` at
index 0; `msg[7]` is always the subcommand):

- Prelude: `OPEN_SESSION(0x40)` → `DIR_CONTROL([0x01])` → `QUERY_INFO([0x01,0x00])`
  → `DIR_CONTROL([0x02])`, IDENTICAL to the first 4 steps of the existing,
  hardware-confirmed project-UPLOAD prelude (`transfer.ts` `buildUploadFrames`).
- Directory listing: `DIR_CONTROL([fileType, pack])` → device replies with ONE
  header (`sub=0x0b`: `msg[8]`=fileType, `msg[9]`=pack, `msg[10..11]`=septet-pair
  entry COUNT) then N × `DIR_ENTRY` (`sub=0x0c`: `msg[8]`=fileType, `msg[9]`=pack,
  `msg[10]`=slot, `msg[11..-2]`=ASCII name): ONE reply per OCCUPIED slot only,
  no 64-slot probing. CONFIRMED BYTE-EXACT for fileType=0x03 (project, 52
  entries) and 0x04 (patch bank, 16 entries) in this capture.
- Per-file READ REQUEST: same subcommand as `WRITE_INIT` (`sub=0x01`), but a
  short fixed tail (`blockAddress(0)` + 3-byte fileId + a single `0x02` byte)
  instead of `WRITE_INIT`'s size-nibble tail; the device replies as the SENDER
  (a real `WRITE_INIT` + `WRITE_DATA` blocks + `WRITE_FINISH`): i.e. read and
  write share one opcode, disambiguated by payload shape. CONFIRMED BYTE-EXACT
  for fileType 0x03 (project), 0x04 (patch bank), AND 0x05 (sample): all three
  appear directly in the capture's OUT stream, e.g.
  `f0 00 20 29 01 64 03 01 00 00 00 00 00 00 00 00 05 00 00 02 f7` (sample slot 0).

**fileType=0x05 (sample) caveat — SUPERSEDED 2026-07-10, see the dated section
at the top of this file.** The per-file READ REQUEST is directly confirmed for
samples. The DIRECTORY-LISTING call (`DIR_CONTROL([0x05, pack])`) is NOT
independently observed in THIS capture: Components fetched ~40 sample files
directly, with no visible `0x0b`/`fileType=5` listing exchange in between; it
evidently already knew the occupied slots from elsewhere in that session (not
captured). `readSampleDirectory` shipped this call by direct shape analogy
(the identical request/reply pair confirmed twice, for project and patch),
flagged community-beta / hardware-unverified for this specific `(fileType,
listing)` combination. A 2026-07-10 live bench run has SINCE confirmed the
call directly on real hardware (occupied=64, correct names) — the analogy is
no longer the only evidence; see the top of this file for the bug that was
masking it and the fix.

**What was actually wrong with the 2026-06-27 code.** Its prelude ended in the
SAME `DIR_CONTROL([FILE_TYPE_SAMPLE, 0x00])` call kept here; that part was
fine. The destructive step was AFTER it: a 64× `0x0d` (QUERY_CRC) + 64× `0x08`
(QUERY_NAME) probe loop, then `CLOSE_SESSION`. Per the confirmed UPLOAD decode
above, `0x0d`/`0x08` are the enumeration primitives Components sends WHILE
PREPARING A WRITE (immediately before real `WRITE_INIT`/`DATA`/`FINISH` for the
samples being uploaded), not a read-only query. Reusing them for a pure read,
then closing having sent zero real write frames, is what committed an empty
directory. The new code never sends `0x0d`/`0x08`, and never sends
`WRITE_INIT`/`DATA`/`FINISH`/`SET_FILENAME` at all (golden-locked in
`scripts/verify-circuit-ncs.ts`, a mocked round trip that asserts the sent
frame list contains none of those four subcommands).

**Negative finding: this capture is silent on empty-pack directory INIT.**
Task was also to check what this capture reveals about how Components
initializes an EMPTY pack's sample directory (the STILL OPEN item below). It
reveals nothing: the device in this capture has exactly ONE pack ("00_invasion-
test", per the `DIR_CONTROL([0x02])` pack listing), already populated (~40
samples, ~52 projects, 16 patch banks), never empty during this capture, and
there is no second pack or a from-empty sequence anywhere in the file (exactly
4 `OPEN`/`CLOSE_SESSION` pairs total: a disposable 2-step probe, then ONE
continuous session covering every file-type read through the final `CLOSE`).
The empty-pack-directory-INIT question stays open pending a capture that
actually starts from a genuinely empty pack (as noted below, `send-pack-to-
circuit-tracks-pack-2-...pcapng` is the closest existing lead for the WRITE
side of that question).

**Bonus, unwired groundwork**: `buildReadFileRequest`/`fileIdFor` (pure,
goldened, confirmed byte-exact for all 3 file types) are shipped as reusable
primitives for a future "download a sample's actual audio back" feature; they
are NOT called by `readSampleDirectory` (which only needs slot NAMES, not file
content) and are not wired into any live orchestration.

**Still true, unchanged by this session:** `upload_kit` replace-vs-merge audit
still open. Do NOT re-enable or modify any directory WRITE/commit path
(`sampleTransfer.ts`'s `0x0d`/`0x08` enumeration + `WRITE_INIT`/`DATA`/
`FINISH`/`SET_FILENAME` frames for uploads); this session touched READ only.

## 2026-07-03 (late): pack-index theory RE-TESTED and RE-FALSIFIED (2nd time); reverted again. Real lead = cold-handle single-upload drop.

A session re-wired `readActivePackIndex` into `uploadSample`/`uploadSampleKit` (reading the
`0b 02` byte and threading it as the pack byte) to re-test the pack-index theory on the
known-state device the doc said was needed. A 4-agent adversarial review workflow (read the
full doc + code paths + the observed results) FALSIFIED it AGAIN and the change was REVERTED
(`git checkout`, back to the Components-proven hardcoded pack 0). Verdict + evidence:

- **H1 (pack index is the differentiator): REFUTED.** Same controlled `_web`/`_our` bytes as
  the 2026-06-28 reversal, PLUS a new independent kill: a single upload to the EXACT slot the
  kit had just written successfully (occupied, on this very pack) STILL failed. An
  index/occupancy story cannot explain that.
- **The change was HARMFUL (or at best inert), never the fix.** It stuffs a count/status byte
  into a field Components proves must be 0. NO single upload ever succeeded with it live. The
  one `upload_kit` success was almost certainly its cold-handle probe TIMING OUT to the silent
  `0` fallback (= old correct behavior); the real reason the kit worked where it had failed
  earlier that evening was that a separate PORT-CONTENTION wedge had been cleared (two Claude
  Code sessions on the exclusive MIDI port; fixed via `/mcp` restart). Confounded variables,
  exactly the trap this doc keeps warning about.
- **The actual open lead (what the evidence points to): a COLD-HANDLE first-transaction drop on
  the SINGLE-upload path.** The dispatcher `ctx.reconnect()`s before every upload → each starts
  on a fresh cold handle, and a cold USB-MIDI handle routinely drops its first transaction. A
  multi-frame KIT primes the handle so its SET_FILENAME clears; a lone single-sample SET_FILENAME
  hits the drop and is read as the "UNINITIALIZED" rejection. Fix to try (NOT pack index): warm
  up / prime the reconnected handle before the lone write, or one-shot resend the first
  SET_FILENAME on a cold handle. `buildSampleUploadFrames` is literally `buildKitUploadFrames([one])`,
  so the single-vs-kit split is a transport/timing effect, not a frame-content one.
- **DO NOT re-test the pack-index theory a third time** without a genuinely NEW artifact: a fresh
  clean handshake capture on a 2+-pack device with a KNOWN active index. Two independent adversarial
  reviews (2026-06-28, 2026-07-03) have now falsified it against the repo's strongest controlled
  evidence. `readActivePackIndex` stays as an UNWIRED probe only.

## 2026-07-03: Components pack GET+SEND round-trip does NOT clear the empty-directory block

Hit the still-open "empty-non-default-pack first-write" gap again live: `upload_sample`
and `upload_kit` both rejected with `"the pack's sample directory is UNINITIALIZED
(empty pack)"` on a pack named "ST & Roland" that our OWN earlier writes may have left
in a bad state. Recovery attempted: founder used Components' **"Get Pack from Circuit
Tracks"** then **"Send to Circuit Tracks"** (a pure round-trip, no new sample added),
producing a pack named "7/3 pack from CT". Retried `upload_kit` against it:
**IDENTICAL rejection**, same message, same slot 0 failure. So a pack round-trip alone
does NOT flip the directory from empty to occupied; this is consistent with (not a new
contradiction of) the "STILL OPEN" note below: the gap is specifically the FIRST
sample entry into an empty directory, and Components merely re-sending the pack's
PROJECT data back doesn't perform whatever extra step seeds the sample directory.
**Unresolved next step (untested):** have the founder upload at least one sample via
Components' own **sample** upload UI (not a pack round-trip) to break the empty-first-
entry deadlock, per the existing note below that same-session uploads to an OCCUPIED
pack are proven to work; only the very first entry into a genuinely empty directory is
in question. Do not re-attempt more `upload_kit`/`upload_sample` calls against a
confirmed-empty pack without a new hypothesis; each failed attempt is a wedge risk
(see `feedback_circuit_multisession_port_contention` memory for the separate, ALSO-hit
port-contention wedge from two simultaneous Claude Code sessions this same evening;
different root cause, don't conflate the two).

## CORRECTION 2026-06-28 (post-review, READ FIRST; supersedes the pack-index claim below)

A multi-agent review FALSIFIED the "pack index from `0b 02`" root cause that the
sections below claim as SOLVED. The repo's own controlled pair disproves it:

| | `0b 02` reply | dir-listing `0b 05 00` | SET_FILENAME pack byte | result |
|---|---|---|---|---|
| `_web` (Components, works) | `01` | `…01` occupied | `07 05 **00**` | ACK |
| `_our` (ours, fails) | `01` | `…00` empty | `07 05 **00**` | reject |

Same device, **identical `0b 02` reply (`01`), identical pack byte (`00`)**, so the
pack byte is NOT the differentiator, and working Components writes `0` while `0b 02`
reads `01` (it does NOT copy that byte). The real differentiator in this pair is
**empty vs occupied directory**. The pack-2/pack-3 SD-card captures that suggested
the index rule are confounded (different device, manual pack switch, and pack-2 also
wrote projects first) and `0b 02` is invariant across empty/occupied here (more like
a count/status than an index).

**What actually stands (the proven wins):**
- SET_FILENAME now carries an ACK expectation → an upload that the device rejects
  fails LOUD (`ok:false`) instead of acked-but-silent. (Real ship-blocker fixed.)
- `read_sample_directory` disabled (it wiped the pool).

**Reverted:** deriving the pack byte from `0b 02` (uploadSample/Kit write pack byte
`0`, Components-proven; `readActivePackIndex` kept as a probe, not wired). The
empty-non-default-pack first-write is STILL OPEN; recover via Components. The
music-box hardware pass is consistent with the *occupied-directory* path, not the
pack-index theory. **Next:** a clean handshake capture on a 2+-pack device with a
KNOWN active index to settle what `0b 02`'s byte is. Everything below is retained as
the investigation trail but the SOLVED/pack-index conclusion is withdrawn.

## ROOT CAUSE FOUND: 2026-06-27 (read this first)

The "0/64 on a clean device" mystery was always the **pack sample-directory state**,
never our bytes. Decoded by diffing the pack-send capture
(`send-pack-to-circuit-tracks-...-06-27-2026.pcapng`) against `_our-single-timeline.txt`:

- The `0b 05 00` dir-listing reply carries a **non-empty flag**: `…01…` when the
  directory has ≥1 entry, `…00…` when it is completely empty/uninitialized.
- **`SET_FILENAME` (the slot-REGISTER step) is the load-bearing signal.** On an
  initialized directory it **ACKs (`04`)**; on an empty/uninitialized one it is
  **REJECTED** (device replies with the empty-slot record `05 00…`). The bulk
  data (WRITE_INIT/DATA/FINISH) ACKs in BOTH cases, so a write to an empty pack
  acks every frame but the slot is never registered and never plays. We never
  checked SET_FILENAME's reply → "acked-but-silent" false success.
- Every Components capture we hold starts from an **already-initialized** directory
  (≥1 slot occupied), so writes-to-empty-slots succeed. We have **never captured a
  truly-empty (`00`) pack**, so the directory-INIT frame (what flips `00`→`01`) is
  still undecoded.
- This also explains the 2026-06-27 incident: `read_sample_directory` opened+closed
  the write-session with zero writes → committed an EMPTY directory (`00`), and
  every re-upload afterward hit the reject path.

**FIXED:** `SET_FILENAME` now carries an ACK expectation (sampleTransfer.ts), so an
upload to an uninitialized directory **fails LOUD** with a clear message instead of
false success (golden: verify-circuit-ncs-transfer "SET_FILENAME rejection").
`read_sample_directory` is disabled (it caused the `00` wipe).

**STILL OPEN:** (a) the directory-INIT frame, see the 2026-06-27-night finding
below; (b) `upload_kit` may REPLACE the directory (writes only its own slots'
entries); audit merge-vs-replace before trusting it to preserve other occupied
slots. Recovery for a wiped pack = send a pack/samples via Components.

## 2026-06-27 night: EMPTY-pack write IS possible (pack-2 capture, partial decode)

`send-pack-to-circuit-tracks-pack-2-...pcapng` is the first capture that writes to a
genuinely EMPTY (`00`) directory: Components sent a pack to a fresh slot (pack 2)
on a new SD card. RESULT: the first sample's **SET_FILENAME ACKed on an empty
directory** (`07 05 01 00 … → 04 ACK`). So writing-to-empty is NOT impossible; our
pack-0 attempt (`_our-single-timeline`) that got rejected differs in TWO ways at
once, so neither is yet isolated:

1. **Pack-index byte** = the 3rd byte of the dir/file frames (`0b 03/05 <PACK>`,
   `07 05 <PACK> <slot>`, `0d 03/05 <PACK> <slot>`). Components used `01` (pack 2);
   OUR code HARDCODES `0x00` (sampleTransfer.ts FILE_TYPE_SAMPLE prelude + writes).
   The device addresses a specific pack slot by this byte.
2. **Projects written first.** The pack-2 send wrote the project directory
   (`0b 03 01` + WRITE_INIT…) BEFORE the sample directory, which may be what
   "opens"/creates the pack so its sample directory accepts the first SET_FILENAME.
   Our sample-only upload skips that. (Note: our earlier SAME-SESSION sample-only
   uploads to an OCCUPIED pack 0 worked, so sample-only is fine once the directory
   is non-empty; the gap is specifically the FIRST entry into an empty pack.)

Also differs (probably benign): the `0b 01` open reply was `…03` here vs `…01`
elsewhere, and Components did 1× enum vs our 64×.

## 2026-06-27 night: SOLVED + WIRED (pack-index)

The decisive capture (`send-single-sample-to-circuit-tracks-pack-3-...pcapng`) was
a SAMPLE-ONLY send to an EMPTY pack (slot 3), no projects written. It isolated the
variable: **the device reports its ACTIVE pack index in the `0b 02` DIR_CONTROL
reply, and every sample dir/file frame must carry it.** Three captures agree:

| capture | `0b 02` reply | wrote | SET_FILENAME |
|---|---|---|---|
| pack-3 (empty) | `0b 02 **02**` | `07 05 **02** …` | ACK ✓ |
| pack-2 (empty) | `0b 02 **01**` | `07 05 **01** …` | ACK ✓ |
| our code (fail) | `0b 02 **01**` | `07 05 **00** …` | REJECT ✗ |

Our `sampleFileId(slot)` built `[0x05, slot>>7, slot]` = `[0x05, **0**, slot]` for
slots 0..63, i.e. **we hardcoded pack 0 by accident** (the byte we labeled
"slot-high" is the PACK INDEX). Uploads only worked when the active pack was 0;
on any other (or after a pack switch) SET_FILENAME was rejected → "0/64". NOT an
init frame at all; we were addressing the wrong pack.

**WIRED (this is the real fix):** `sampleFileId(slot, packIndex)` →
`[0x05, packIndex, slot]`; `buildKitUploadFrames`/`buildSampleUploadFrames` thread
`packIndex` into the dir-listing / enum / info / write frames;
`readActivePackIndex(conn)` reads it from the `0b 02` reply (SAFE: pack-info
prelude only, never the 0x05 sample-dir session); `uploadSample`/`uploadSampleKit`
call it and target the active pack. Goldens in verify-circuit-ncs-transfer
(sampleFileId, frame bytes, readActivePackIndex). **HARDWARE-CONFIRMED 2026-06-28:**
`upload_sample` of a music box to slot 20 registered and PLAYED on the device's
active pack through our own code; `ok:true` is now gated on the SET_FILENAME ACK,
so success means the slot actually registered. The 0/64 bug is fixed end-to-end.
`read_sample_directory` stays disabled (separate destructive bug). `upload_kit`
replace-vs-merge audit still open.

---

**Historical (pre-2026-06-27): "STILL BROKEN, root cause OPEN".** History: a note here once
claimed "HARDWARE-CONFIRMED + DURABLE", retracted; the only durable uploads we
could point to were stock samples or the maintainer's own WEB uploads via
Components, never our code. Our code writing a custom WAV (single sample AND
64-kit) reads back **0/64** on a clean device.

**The post-CLOSE commit-wait theory was HARDWARE-REFUTED.** A timed both-direction
capture decode found the device sends a group-`0x08`/subcmd-`0x00` notification
~6-8 s after CLOSE, and a verification workflow (22/24) was confident this was the
flash-commit gate (plus a real ingest bug: the old `isOurs` filter required
header byte 5 == `0x03` and dropped the `0x08`-group frame). We built the fix
(opt-in `awaitCommitMs` + `isFamily`/`isCommitDone` ingest) and tested it on
hardware (instrumented, `scripts/_research/circuit-instrumented-upload.ts`):

- The wait **engages correctly**: upload took ~11 s (writes ~5 s + a real ~6 s
  wait) and **received** the post-CLOSE `0x08` frame (`ok=true`).
- **But the slot still read EMPTY.** And the device emits `grp 0x8 00` **4×**,
  including BEFORE any write, so it is a generic "ready/idle" status, **not** a
  commit gate. The cap1-only `grp 0x4 03 04 00` is occupied-pack-specific and
  never appears for an empty pack. Removing the pre-OPEN reset CLOSE didn't help
  either.

So the commit-wait is **necessary-but-not-sufficient at best, and on its own
useless**: backed out of the default path (the opt-in mechanism + the genuinely-
correct `isFamily` ingest stay, golden-tested, for the eventual fix). **Root cause
remains unknown:** our frames are byte-identical to the capture and ack, yet don't
persist. The directory READ path works (real names, 0/64), so the session
protocol is fine for reads.

**USBPcap DIFF: the missing `QUERY_INFO 09 01 01` (2026-06-24, the cleanest lead
yet).** Captured OUR upload (`ct_upload_single.pcapng`) and a Components
single-sample web upload (`ct_upload_single_from_web.pcapng`) under the same
conditions and diffed the host→device control frames
(`scripts/_research/diff-upload-captures.py`). The write phase (WRITE_INIT/DATA/
FINISH/SET_FILENAME/CLOSE) is structurally identical. The **entire** delta is the
prelude:

| capture | OPEN | CLOSE | `09 01 00` | `09 01 01` |
|---|---|---|---|---|
| Components single-sample (web, current) | 2 | 2 | 2 | **2** |
| Components multi-sample (06-21, 06-23) | 1 | 1 | 1 | 0 |
| OURS (failing) | 1 | 1 | 1 | **0** |

Two differences: (1) Components-current does a **probe session** first (OPEN→query→
dir→CLOSE), but with multi-SECOND gaps = the **UI browsing** the directory, almost
certainly not load-bearing; and (2) it sends **`QUERY_INFO 09 01 01`** inside the
write session (at protocol speed, ~1.5 ms after `09 01 00`), which **we never
send**. The `09 01 01` reply (`00 01 0f 03 0b 0f`) differs from `09 01 00`'s
(`00 00 00 00 05 0b`), a different info field, likely a "prepare/lock pack for
write" step. **Added `09 01 01` to the prelude** (`sampleTransfer.ts`).

CAVEAT (unresolved): the OLDER multi-sample captures, which presumably committed
(the maintainer has those samples), LACK `09 01 01` too, so either Components was
updated between then and now, or single- vs multi-sample differ, OR the new
single-sample web upload ALSO failed (needs confirming: is that sample on the
device?). The fresh same-scenario diff is the better evidence, so `09 01 01` is the
change to test first; the probe session is the fallback.

**EARLIER LEAD: CLOSE count, from the recurring STUCK symptom.** Our
uploads also leave the device **stuck in the upload/download display** (the
file-transfer session never completes). Capture diff: **Components sends OPEN×1 +
CLOSE×1** per upload (opens cold). **Our transport sends CLOSE up to 3×**: a
pre-OPEN reset CLOSE (`uploadProject.ts`), the plan's `close_session`
(`sampleTransfer.ts`), AND the `finally`'s CLOSE (~120 ms after the plan close,
firing into the device's multi-second flush). This single divergence plausibly
explains BOTH symptoms at once: extra closes around the flush strand the session →
device stuck in transfer display AND nothing commits. Implemented an opt-in
`singleClose` (TransferOptions) that makes the sample path send exactly one CLOSE,
Components-faithful (no pre-OPEN reset, `finally` suppressed on the success path);
`uploadSample`/`uploadSampleKit` pass it; project path unchanged (still 3×, which
works). Offline golden asserts OPEN×1/CLOSE×1. **UNTESTED on hardware**: this is a
hypothesis, the two prior ones were refuted. Recovery from the stuck state is a
device power-cycle.

**Decisive oracle: a fresh Components capture of a SINGLE sample to an EMPTY pack**
(our exact failing scenario; the existing captures were multi-sample to *occupied*
packs). Diff that wire sequence frame-by-frame against ours
(`decode-sample-capture-timeline.py`); the difference that makes Components commit
where we don't must be in there. Alternatively, USBPcap OUR upload and diff the
two raw streams directly. Do this BEFORE more on-device guessing (each failed
attempt wedges the device).

**Capture provenance + action (verified 2026-06-23):** the frame plan + golden
(`verify-circuit-ncs-transfer.ts`) are decoded byte-exact from
`send-to-circuit-tracks-sleep-token-samples.pcapng` (2026-06-21) →
`_cap1`/`_cap2`. That capture is the **"Send samples"** action, not "Send pack":
`_cap2_control.txt` contains ONLY `0x05` sample-file writes (no patch/project
file-types). So we decoded the RIGHT action; Send-samples-vs-Send-pack is not the
gap. In that working capture the device replied ~1:1 (`_cap2_in.hex` holds 1,884
`F0` device replies vs 1,880 host frames; the rest is `0xF8` clock noise), i.e.
Components got a reply to essentially every frame including the `0x0d` scan.

## Investigation 2026-06-23: acks but never commits (single sample too)

Symptom: a user upload reported success, but after a device restart the Circuit
showed no drum samples. Reading the device's own sample directory
(`scripts/circuit-read-sample-directory.ts`) confirmed **0/64 occupied**: the
writes never registered, not just "didn't survive a restart."

A clean, single-process **upload-then-readback** test (one connection, no MCP, so
no process handoff, `scripts/_research/circuit-diff-sample-upload.ts`) isolated it:

```
before : slot 1 = "(empty)"
upload : ok=true  blocks=12          # every frame device-ACKed
after  : slot 1 = "(empty)"          # still empty
```

So a SINGLE sample acks `ok` (the ACK gating is real: `runFramePlanOnce`
requires a subcmd-`0x04` ACK per frame within 4 s, `uploadProject.ts:165`) yet
nothing lands in the manifest. **It is not a volume / 64-in-one-session problem.**

**Ruled out** (don't re-chase):
- **Frame bytes**: our prelude, the 64× `0x0d` scan, WRITE_INIT/WRITE_FINISH/
  SET_FILENAME, and CLOSE all match the working Components capture
  `_cap2_control.txt` (a real 64-sample upload). The finish address `numBlocks+1`
  matches too: the capture's `0x0c` is just an 11-block WAV vs our 12-block one.
  Per-sample WRITE bytes are golden-verified byte-identical (`verify-circuit-ncs-transfer.ts`).
- **Fake acks**: the device really sends `0x04` ACKs; they are gated, not optimistic.

**ROOT CAUSE: the post-CLOSE FLASH COMMIT wait (timed-capture decode, 2026-06-23,
cross-validated in BOTH "Send samples" captures).** A timestamped both-direction
timeline (`scripts/_research/decode-sample-capture-timeline.py` →
`scripts/_research/_sample-timeline-2026-06-2{1,3}.txt`) shows that after the
final `CLOSE` (0x41) Components does NOT tear down; it WAITS for the device to
flush the pack manifest to flash:

```
cap1: 265.2607 OUT CLOSE 41 f7
      271.5868  IN (grp 0x8) 00 f7     # +6.3s  device flush status
      271.5880  IN ACK
      280.6068  IN (grp 0x4) 03 04 00  # +15.3s commit-complete
cap2: 277.2288 OUT CLOSE 41 f7
      284.6630  IN (grp 0x8) 00 f7     # +7.4s
```

`runFramePlanOnce` (`uploadProject.ts`) sends `CLOSE` and the `finally{}`
immediately closes the session and returns `ok`; it never waits for the
post-CLOSE flush. So every per-frame `0x04` ACK lands (upload reports ok) but the
device never finishes committing to flash → 0/64. This is the bug.

**Fix (to implement + test):** after sending `CLOSE_SESSION`, KEEP the connection
open and WAIT for the device's post-CLOSE commit signal (the `grp 0x8 00` status
and/or the `grp 0x4 03 04 00`) before declaring success or closing the port;
budget ~10-20 s (observed 6.3-15.3 s). Then re-run the single-sample upload +
directory read-back (`scripts/_research/circuit-diff-sample-upload.ts`); success =
the slot reads its name back, and it survives a restart.

(Superseded earlier guess: a `0x0d`-scan reply-wait. The timeline shows the
device DOES reply to every `0x0d` and Components paces ~40 ms, but our longer
fire-and-`clear()` doesn't break the scan; the real gap is the post-CLOSE flush.
A verification workflow is confirming this + decoding the `grp 0x8`/`grp 0x4`
messages.)

**Transport caveat (separate issue):** the `@julusian`/Windows handle WEDGES on a
CLI↔MCP port handoff (`Internal RtMidi error`, `reconnect` can't recover) and can
leave the device stuck in an upload/download state needing a power-cycle. Do all
sample I/O in ONE process per operation; don't alternate CLI scripts and MCP
tools against the port.

## (superseded) earlier PERSISTENCE note: the session PRELUDE

> Retained for history; its "confirmed" conclusion did not hold up (see above).
The write frames were byte-identical to Components, so the prelude was made
file-type `0x05` (SAMPLE dir, not the project `0x03`) followed by the 64× `0x0d`
scan, on the theory that the `0x05` listing + `0x0d` scan together commit the
manifest. That prelude is necessary but, on its own, evidently NOT sufficient:
firing the `0x0d` scan without consuming the replies still acks-but-stores-
nothing (the hypothesis above).

## CONFIRMED PROTOCOL (decoded byte-exact from a real Components capture)

Capture: `samples/captured/send-to-circuit-tracks-sleep-token-samples.pcapng`
(USBPcap; device = Novation 0x1235:0x0139, bus 5; MIDI on interrupt endpoint
0x01). Reassembled the USB-MIDI (`usbaudio.midi.event` via tshark) → SysEx, then
decoded with `scripts/decode-circuit-sample-capture.ts`.

- **Same file-transfer session as projects**: header `F0 00 20 29 01 64 03`,
  subcmds OPEN_SESSION `0x40` / DIR_CONTROL `0x0b` / QUERY_INFO `0x09` /
  WRITE_INIT `0x01` / WRITE_DATA `0x02` / WRITE_FINISH `0x03`, msb-interleave,
  CRC32. We already own all of this (`transfer.ts` / `uploadProject.ts`).
- **Sample FILE-TYPE byte = `0x05`** (projects are `0x03`). Seen in the
  WRITE_INIT `fileId = 05 00 <slot>` and the 64× `0x0d` directory entries
  `05 00 00`..`05 00 3F` (the 64 sample slots).
- **Payload = a STANDARD WAV file, sent VERBATIM.** WRITE_DATA deinterleaves to
  `RIFF <size> WAVE fmt …`: **48000 Hz, mono, 16-bit PCM** (fmt: audioFormat=1,
  channels=1, sampleRate=0xBB80, byteRate=96000, → bits=16). No custom encoding;
  the WAV header + data are sent as-is, msb-interleaved, CRC32-gated.
- **`SET_FILENAME 0x07`** = `fileId` + ASCII name (first file: `01_k1_kick.wav`).
- Two extra subcmds Components issues: **`0x0d`** ×64 (enumerate the 64 sample
  slots) and **`0x08`** ×62 (per-slot info/status). Replicate the observed order.

**Per-sample sequence:** OPEN_SESSION → dir handshake (DIR_CONTROL/QUERY_INFO) →
0x0d slot enumeration → 0x08 slot info → [WRITE_INIT(fileId 05,slot,size) →
WRITE_DATA(WAV bytes, msb-interleaved) → WRITE_FINISH(CRC32) → SET_FILENAME] →
CLOSE_SESSION.

**Device WAV requirement:** 48 kHz / mono / 16-bit PCM. Bounced WAVs that differ
must be resampled / channel-folded / re-quantized before upload.

---

## (original research, superseded by the confirmed decode above)

**Status:** research. Goal: automate uploading user WAV samples to the device
(replacing the manual Novation Components web-app workflow), ideally WITHOUT a
USB wire-capture campaign.

## Headline finding: we likely already own ~80% of it

Circuit Tracks sample upload almost certainly **reuses the same file-transfer
session protocol we already built + hardware-confirmed for `.ncs` projects**
(`packages/circuit-tracks/src/ncs/transfer.ts` + `uploadProject.ts`):
`F0 00 20 29 01 64 03 <subcmd> …` with `OPEN_SESSION (0x40)` → dir handshake →
`WRITE_INIT (0x01)` → `WRITE_DATA (0x02)` × N → `WRITE_FINISH (0x03)` + CRC32 →
`CLOSE_SESSION (0x41)`, 8-bit→7-bit `msbInterleave`, 8192-byte blocks. The only
project-specific piece is the **file id**: `fileId(slot) = [FILE_TYPE, hi, lo]`
where `FILE_TYPE_PROJECT = 0x03`. **A sample is the same envelope with a
different file-type byte + a different payload.**

## Evidence

- **Our project protocol** (proven, HW-confirmed): the session + framing + CRC32
  above. Reusable verbatim; only `fileId`'s file-type and the payload change.
- **userx14 Circuit Tracks firmware RE** (gist 664f5e74): confirms the header
  `00 20 29 01 64` (`0x64`=Circuit Tracks, `0x63`=Circuit Rhythm) and CRC-32 +
  7-bit MIDI packing. NOTE: that gist documents the FIRMWARE-UPDATE protocol
  (opcodes `0x71`..`0x7C`), which is a DIFFERENT command group from file
  transfer, useful for the header/CRC confirmation only.
- **mungewell/circuit_samples** (the original Circuit, header `00 20 29 00`,
  cmds `0x77/0x79/0x7a`, NO session): a **sample DATA-FORMAT reference**: raw
  **PCM, 8/16/24-bit, mono/stereo, big-endian, uncompressed**, 7-bit MSB-first
  packed, 256-byte chunks, CRC32 of the unpacked data, max ~90 MB. The original
  Circuit's wire differs from Tracks, but the **audio format is the strong
  starting hypothesis** for what Tracks stores.
- No Circuit-Tracks-specific sample-upload tool found (circuit-tracks-buddy =
  patch dumps; jorr-it/circuit-tr = a sample pack, not a tool).

## The remaining unknowns (Circuit-Tracks-specific)

1. The **sample file-type byte** (projects = `0x03`; samples = `0x01`/`0x02`/…?).
2. The exact **audio payload format** + any metadata header (rate/bits/channels;
   does Tracks resample to a fixed rate? store a header before PCM?).
3. The **sample-slot directory** mapping (64 sample slots; how `fileId` indexes
   a sample vs a project; how a slot's name/category is set).

## RE path WITHOUT capturing the wire (the ask)

1. **Read Novation Components' web-app JavaScript (recommended).** Components is
   a WebMIDI browser app; it builds the sample-upload SysEx **in the browser**,
   so its (minified but inspectable) JS encodes the file-type, the WAV→device
   conversion, the framing, and the slot directory. Reverse-engineering the JS
   is the "no USB capture" path the user wants, and it answers all three unknowns
   directly. (Fetch the Components bundle, locate the sample-upload module, trace
   the SysEx builder + the audio re-encode.)
2. **One targeted USBPcap capture** of a single Components sample upload, the
   fallback if the JS is too obfuscated. One capture answers everything.
3. **Infer + iterate.** Bind our existing `uploadProject` session to a guessed
   sample file-type + mungewell's PCM format and try it. The transfer is
   CRC-gated, so a malformed upload is *rejected* (safe). RISK: a wrong-but-
   CRC-valid payload could store a garbage sample in a slot, recoverable by
   re-uploading via Components, but treat sample slots as overwritable scratch
   while iterating, and confirm on a throwaway slot first.

## Implementation sketch

Parameterize the transfer we already have:
- `transfer.ts`: add `FILE_TYPE_SAMPLE` + a `fileId(slot, fileType)` variant.
- New `sampleCodec.ts`: WAV decode → the device's expected PCM (resample / set
  bit-depth / channel-fold per what Components does) → big-endian bytes.
- `uploadSample(conn, wavBytes, slot)`: reuse the session loop + `msbInterleave`
  + CRC32 + the in-transfer guard (the same reboot-safety we just hardened).
- An MCP tool `upload_sample({port, file, slot})`.

## Effort + verdict

**MODERATE and very feasible.** The hard, hardware-confirmed part (the transfer
session + framing + CRC + reboot-safe guard) is DONE and reused. The new work is
the sample file-type + WAV→PCM conversion + slot directory, all answerable from
**one Components-JS RE pass (no wire capture needed)**, with mungewell as the
data-format crib. Legal footing is the same personal-use/interop basis as the
rest of the project: the user uploads their own samples to their own device.
