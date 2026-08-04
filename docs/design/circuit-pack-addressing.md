# Circuit Tracks — microSD PACK addressing (decoded 2026-07-16, hardware-confirmed)

A Circuit Tracks with a microSD card holds up to **32 packs**, each a complete
64-project / 128-patch / 64-sample world. This decode is how to address a
specific pack over the file-transfer transport, and how to list the card's packs
by name.

**Status: HARDWARE-CONFIRMED** (2026-07-16, `scripts/probe-circuit-packs.ts`,
first attempt). Implemented in `packages/circuit-tracks/src/ncs/packDirectory.ts`
+ `transfer.ts`. Goldens in `scripts/verify-circuit-ncs.ts` (capture-exact).

---

## 1. The headline: the fileId's middle byte is the PACK

Every file-transfer subcommand addresses content as a 3-byte fileId:

```
fileId = [ fileType, pack, slot ]
           ^^^^^^^^  ^^^^  ^^^^
           03 project 0-based  0..63
           04 patch   pack idx
           05 sample
           02 = the PACK DIRECTORY itself (see §3)
```

`pack` is **0-based**: device "Pack 1" = wire `0`, "Pack 5" = wire `4`.

### The bug this corrected

`transfer.ts` previously read that byte as the high septet of a 14-bit slot:

```ts
// WRONG (pre-2026-07-16)
export function fileId(slot: number): number[] {
  return [FILE_TYPE_PROJECT, (slot >> 7) & 0x7f, slot & 0x7f];
}
```

`slot >> 7` is `0` for every legal slot (0..63), so it emitted a correct *pack-0*
byte and was **invisible** — while silently pinning every transfer this server
ever made to Pack 1, regardless of the front-panel selection.

Notably `sampleDirectory.ts` already had it right (`fileIdFor(fileType, pack,
slot)`, documented as "the shared fileId shape every file-transfer subcommand
uses"). The two modules disagreed about the same byte; the project path was the
stale one.

### Evidence (three independent legs)

1. **Capture, pack 2** — `samples/captured/send-pack-to-circuit-tracks-pack-2-06-27-2026.pcapng`:
   ```
   OUT  03 0b 03 01        dir-control, fileType 03 (project), pack 01
   OUT  03 0d 03 01 00     slot-info, project, pack 01, slot 00
   OUT  03 0d 03 01 01/02/03
   ```
2. **Capture, pack 3** — `…-single-sample-…-pack-3-06-27-2026.pcapng`:
   ```
   OUT  03 0b 05 02        dir-control, fileType 05 (sample), pack 02
   OUT  03 0d 05 02 00/01/02
   ```
   Same position, different fileType → the field is positional, not a type quirk.
3. **Refutation of the septet model** — under it, those frames decode as project
   slots 128..131 and sample slots 256..258. The device has **64** of each.
   Those slots do not exist, so the septet reading is impossible.

Capture filenames independently corroborate the 0-based mapping (pack 2 → `01`,
pack 3 → `02`).

---

## 2. What is NOT available

- **No command switches the active pack.** Front panel only (Shift + Projects).
- **No command reports which pack is ACTIVE.** Nothing in any capture exposes it.

Both are largely moot for authoring: with the pack byte you address a pack
*explicitly* rather than depending on what is selected. It matters only at
performance time, when the player must have the pack selected to play it.

---

## 3. Listing the card's packs (fileType 0x02)

The pack directory is listed with the *same* `DIR_CONTROL` (0x0b) → header +
`DIR_ENTRY` (0x0c) protocol as files. Direction confirmed via
`usb.endpoint_address.direction` (0 = host→device, 1 = device→host):

```
OUT  03 0b 02                          host: list packs
IN   03 0b 02 <count>                  device: header, count = number of packs
IN   03 0c 02 <idx> <ascii name…>      device: one entry per pack, UNSOLICITED
IN   03 0c 02 <idx> <ascii name…>      …
```

**The pack replies are one byte shorter than file replies** — a pack is not
inside a pack (no `pack` field) and its count is a single byte, not a septet
pair:

| | header | entry |
|---|---|---|
| **PACK** (0x02) | `0b 02 <count>` — **11 bytes** | `0c 02 <idx> <name>` — name at `msg[10]` |
| **FILE** (0x03/04/05) | `0b <type> <pack> <lo> <hi>` — **13 bytes** | `0c <type> <pack> <slot> <name>` — name at `msg[11]` |

Consequences worth knowing:

- Parsing a pack entry with the FILE layout **silently eats the name's first
  character as a slot byte** ("00_ST & Roland" → "0_ST & Roland"). Hence
  `packDirectory.ts` has its own parsers; both reject the other's shape.
- `sampleDirectory.ts`'s 2026-07-10 hardening note records an 11-byte
  `0b 02 05` frame as a "malformed straggler" from a desync bug. **It was not
  malformed** — it is this header, count 5, off the maintainer's own device,
  matching its 5 packs. The strict 13-byte FILE-header matcher rejected it
  correctly *as a file header*, which is why it read as noise.

### The listing call is already in every upload

`transfer.ts buildUploadFrames` has always sent `DIR_CONTROL([0x02])` as
handshake step 4 and dropped the replies:

```ts
frames.push({ label: 'dir_control_2', bytes: makeMessage(SUBCMD.DIR_CONTROL, [0x02]) });
```

`readPackDirectory` is that same frame with the replies parsed.

---

## 4. Hardware confirmation (2026-07-16)

`npx tsx scripts/probe-circuit-packs.ts` on the maintainer's device, first attempt:

```
Device reports 5 pack(s); 5 name(s) received.

  Pack 1  (wire index 0)   "00_73 pack from CT"
  Pack 2  (wire index 1)   "00_PACK"
  Pack 3  (wire index 2)   "01_PACK"
  Pack 4  (wire index 3)   "02_PACK"
  Pack 5  (wire index 4)   "03_PACK"
```

Matches the front panel's 5 packs and the 2026-07-10 `0b 02 05` count. Confirms
the header shape, entry layout, 0-based index, and unsolicited-entry flow.

**Corollary:** wire index 0 = `00_73 pack from CT` is the pack every transfer
this server has ever made addressed. The other four were unreachable.

---

## 5. Fast per-pack project listing (a free win)

`DIR_CONTROL([0x03, pack])` returns a count + one DIR_ENTRY per **occupied**
slot, in ONE round trip. `parseDirListHeader` / `parseDirEntry`
(`sampleDirectory.ts`) already decode it byte-exact (fileType 0x03, count 52
confirmed). Absent slots are free.

Confirmed 2026-07-16 (`scripts/probe-circuit-pack-projects.ts`):

- Pack 1 → 30 occupied slots, named, in one round trip.
- Pack 5 → 0 occupied, 64/64 free.

This replaces per-slot probing at ~6 s each (a 64-slot survey drops from ~6.4
minutes to one call), and it is the "occupancy pre-check" the `downloadOnce`
HARDENING TODO asked for. That TODO's "format is not yet reverse-engineered;
needs a capture" note is **stale** — the reply is decoded; wiring it in is
plumbing, not RE.

**WIRED 2026-07-17.** `readProjectDirectory(conn, pack)` (a fileType-parameterized
share of the sample-directory core, `sampleDirectory.ts` `readFileDirectory`)
backs the Circuit's new `reader.scanLocations`, so `scan_locations(from, to, pack)`
lists a pack's occupied projects in one round trip and filters to the range. On
the EXISTING verb, not a new tool. Goldens in `verify-circuit-ncs.ts`.

---

## 6. Implementation status

| Layer | State |
|---|---|
| `transfer.ts` `fileId(slot, pack=0)` | DONE — pack threaded, defaults preserve every legacy byte |
| `transfer.ts` `buildUploadFrames(..., pack=0)` | DONE — fid + `dir_listing` both scoped to the pack |
| `uploadProject` / `downloadProject` `TransferOptions.pack` | DONE |
| `packDirectory.ts` `readPackDirectory` | DONE, hardware-confirmed |
| `patchTransfer.ts` `patchFileId(slot, pack=0)` | DONE — had a live copy of the septet bug (see below) |
| `readPackCount` (was `readActivePackIndex`) | DONE — renamed; the byte is a COUNT (see below) |
| Goldens — PURE layer (`verify-circuit-ncs.ts`) | DONE — refutation guard + capture-exact parser checks |
| Goldens — I/O driver (`readPackDirectory`) | DONE (2026-07-16) — mocked round-trip + cross-talk + silent-device, in `verify-circuit-ncs.ts` |
| **Tool surface** (`pack` arg on apply_pattern / upload_project / get_preset / export_preset; a `list_packs` read) | DONE (2026-07-16) — see "How the tool surface carries `pack`" below |
| **Sample path** (`uploadSample` / `uploadKit` / `readSampleDirectory`) | **DONE (2026-07-17)** — `pack` threaded through `ctx.pack` into the sample read + write, exactly as projects. Tool args `pack` on `list_samples` / `upload_sample` / `upload_kit`; the dir read + every write frame carry it (goldens in `verify-circuit-ncs.ts` + `verify-circuit-ncs-transfer.ts`). Pack 0 hardware-confirmed; the nonzero-pack sample READ confirmed 2026-07-17 and the nonzero-pack sample WRITE confirmed 2026-07-27 (see §8) |

Packs are now reachable from a conversation for PROJECTS and PATCHES. Samples
are the remaining half.

### How the tool surface carries `pack` (2026-07-16)

`pack` is **1-based** at the tool boundary (`pack: 5` is the front panel's
"Pack 5"), converted once by `toWirePack` at `openCtx` and carried on
**`DispatchCtx.pack`** from there. It is deliberately NOT a per-call argument.

That is a safety property, not a style choice. Three legs run on a stored-slot
write — the backup read (`dumpStoredPresetBinary`), the gate's occupancy read
(`probeProjectSlot`), and the write (`uploadProjectTransport`). A per-call
`pack = 0` param can be threaded into one and forgotten in another, and that
divergence is a silent clobber: the gate clears an empty Pack 1 slot while the
write destroys a project on Pack 5. One shared ctx field makes divergence
impossible; the worst case degrades to "all three agree on the wrong pack",
which is visible and still gated.

Pinned by `scripts/verify-circuit-pack-gate.ts`, which decodes the pack byte out
of every frame the writer actually emits and fails if one operation speaks two
packs. It was verified to FAIL against a deliberately reintroduced divergence.

Also landed:
- `capabilities.has_packs` + `assertPackSupported` (enforced inside `openCtx`):
  a packless device REFUSES `pack > 1` instead of silently serving pack 1, per
  the `assertInstanceSupported` precedent.
- `list_packs` (reader hook `readPackDirectory` → `executeReadPackDirectory`),
  mirroring `list_samples`. Returns `{count, packs:[{pack, name, wire_index}]}`;
  `pack` is 1-based and is the same value the write tools' `pack` arg takes, so
  it passes straight through with no arithmetic.
- Receipts, dry-run previews, and backup filenames all name the pack. Nothing on
  the wire reports which pack the front panel has selected, so the pack must be
  chosen deliberately and every artifact has to say which one it meant.
- `get_preset("patch:N")` REFUSES an explicit pack: a patch read is served from
  the working buffer, which always follows the front panel's pack.

### Two live bugs this decode exposed (both fixed 2026-07-16)

1. **`patchTransfer.ts:71` carried the septet model verbatim** for fileType 0x04,
   reachable from `get_preset` on a patch location via `reader.ts` → not dead
   code. Patch reads were pinned to Pack 1 by the same invisible mechanism.
2. **`readActivePackIndex` never read an active pack index.** It returned
   `msg[9]` of the `0b 02` frame — which this decode identifies as the pack
   COUNT. Renamed `readPackCount`; the old name is a deprecated shim. Its
   2026-06-28 note ("invariant `01`... more likely a count/status... waiting on a
   clean 2+-pack capture") was right to doubt it and the capture was already on
   disk. **Near-miss worth recording:** on the maintainer's 5-pack device the
   function returns 5, and the maintainer was on Pack 5 — it would have "confirmed"
   the wrong model by coincidence.

### Known-incomplete, ranked (from a 2026-07-16 adversarial review)

1. ~~**Overwrite-gate safety.**~~ **CLOSED 2026-07-16.** Gate, backup, and write
   all read `ctx.pack`; divergence is structurally impossible and golden-pinned.
   See "How the tool surface carries `pack`" above.
2. ~~**Half-pack-aware codebase.**~~ **CLOSED 2026-07-17.** `pack` is threaded
   through `ctx.pack` into the sample read (`readSampleDirectory`) and write
   (`uploadSample` / `uploadSampleKit`) — the SAME chosen byte projects address.
   `list_samples` / `upload_sample` / `upload_kit` take a 1-based `pack` arg,
   converted at `openCtx` like every other pack-addressed tool. The dir read and
   every write frame now carry it (goldens: `verify-circuit-ncs.ts` pack-aware
   round trip, `verify-circuit-ncs-transfer.ts` driver→builder threading).

   This closes the cross-pack name trap: an agent that reads `list_samples
   pack:N`, loads samples with `upload_sample pack:N`, and writes the project
   with `pack:N` now has all three on one pack. Pack 0 is hardware-confirmed, and
   the nonzero-pack sample WRITE was confirmed on hardware 2026-07-27 (§8), which
   retires the community-beta label the receipts + `capacity_note` used to carry.
3. ~~**Stale sample-path docs.**~~ **CLOSED 2026-07-16.** `sampleTransfer.ts` and
   `sampleDirectory.ts` are reconciled against this doc: the pack byte is CHOSEN,
   not reported, and the `0b 02` byte is a count. The refuted "active pack index
   the device reports" model is called out by name so it cannot creep back.
4. ~~**`readPackDirectory` I/O has no offline test.**~~ **CLOSED 2026-07-16.**
   Mocked round-trip, cross-talk, and silent-device goldens in
   `verify-circuit-ncs.ts`.

   Worth recording, because it is the same shape as the near-miss above: the
   pack reader's cross-talk hazard runs the OPPOSITE way from the sample
   reader's. The `0b 02 05` frame that desynced `readSampleDirectory` is, for the
   pack reader, a perfectly valid header reading count 5. The first draft of the
   golden used a 5-pack fixture and "passed" by reading the count off that stale
   frame — 5 == 5. The fixture is now 3 packs, so a count that is right by
   coincidence cannot happen.
5. **`translate_preset` reads its source with a packless ctx**
   (`dispatcher/preset.ts`), so a Circuit source location is pinned to Pack 1.
   Low priority (no destructive write), but it is a leg.

---

## 7. Backwards compatibility

`pack` defaults to `0` everywhere, which is byte-identical to the pre-fix output
for every legal slot (`slot >> 7 === 0` for 0..63). No existing caller changes
behavior; the golden `fileId(slot) defaults to pack 0 …` pins that.

---

## 8. The nonzero-pack WRITE, confirmed on hardware 2026-07-27

Two SEPARATE claims, each with its own evidence. They landed on the same day on
the same device and are still not the same claim: samples and projects are
different file types on different code paths.

### 8a. SAMPLES: confirmed, and the slot byte is ADDRESSED

`scripts/circuit-clone-pack-samples.ts`, maintainer's 2-pack device, Pack 1 to
Pack 2:

- Pack 1's pool was read off the DEVICE, 64 of 64 slots, each download gated by
  the device's own **CRC32**, so the source bytes are self-validating. All parsed
  as 48 kHz mono 16-bit.
- 63 slots were written to Pack 2. The 64th was already byte-identical (md5), so
  writing it would have been a no-op on a device with no erase.
- **Index alignment was proven, not assumed.** Wire slot 0 was written alone,
  then wire slot 63 was written SECOND and out of order. It landed at 63 rather
  than at the next free index, which proves the slot byte is **addressed**, not
  append-ordered. That is the premise the whole index-preserving clone rests on,
  and it was the cheapest possible experiment for it.
- Eight slots spread across the pool were downloaded back off Pack 2 and were
  **md5-identical** to the Pack 1 originals; a full 64-slot name diff between the
  two pools came back identical. Final state: Pack 2 = 64 of 64.

Not re-checked across a power-cycle: the evidence is a device read-back, not a
reboot.

**A real bug the device's CRC caught.** The downloader left the trailing `F7` on
each frame, so `msbDeinterleave` decoded it as one EXTRA data byte per block and
shifted the whole stream. The RIFF size still matched (the reader truncates to
the declared length) and the WAV still parsed, so every structural check the host
could make said fine. Only the device's own CRC32 said no. That is the argument
for CRC-gating downloads rather than trusting a parse: a self-validating check
the host cannot fool is worth more than any number of checks it authors itself.

### 8b. PROJECTS: confirmed, separately, by read-back

Two authored projects were written to **Pack 2 slots 1 and 2** (each read-checked
empty first by the writer's own `gateProjectOverwrite`, `confirm_overwrite` never
passed), then **independently downloaded back**, CRC ok on both, with each track
asserted to hold the part it should rather than merely to hold something. A later
byte-surgical rename of both projects re-read them again and diffed with zero
collateral. So the pack byte addresses a project write the same way it addresses
a sample write.

What this does NOT establish: the projects have not yet been LOADED and PLAYED
from Pack 2, and there was no power-cycle. The write and its addressing are
confirmed; audible playback from a nonzero pack is not.

### 8c. The verification read races the flash commit (~6-8 s)

**The device flushes a pack's manifest roughly 6-8 SECONDS AFTER the transfer
session CLOSES.** On 2026-07-27 a pool read taken 1.2 s after the clone reported
**8 slots empty**, and a later read showed every one of them present. Nothing had
been lost; the verification was simply too fast.

Mitigation, and what any future verification loop should do: **poll**. Reconnect,
wait ~9 s, then retry at 5 s intervals, and treat an absent slot as a failure only
once the commit window has demonstrably passed. This matters more here than on
most gear: the Circuit has **no erase**, so a spurious "the write failed" leads to
a redo that is not harmless.

This does not revive the refuted commit-wait theory in
`docs/design/circuit-sample-upload.md`. That theory was about waiting IN-session
on a group-`0x08` frame as a commit signal, and it stays refuted (the frame is a
generic "ready" the device also sends pre-write). This is a different question:
with the session already closed, **when does a read-back become admissible as
evidence**. Answer: not for another ~6-8 s.

Wired into the product surface so a caller meets it before writing its own loop:
`readSampleDirectory`'s `capacity_note` (both pack branches), the `upload_sample`
/ `upload_kit` receipts, the `pack` tool-arg descriptions, and the descriptor's
`verification` string. Golden-pinned in `verify-circuit-ncs.ts`.
