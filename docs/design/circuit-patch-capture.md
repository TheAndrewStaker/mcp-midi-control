# Circuit Tracks: patch-select + patch-save capture guide (HW-CIRCUIT-004)

**Goal:** learn how Novation Components actually (a) **changes** a synth patch and
(b) **saves/uploads** a patch, so we can fix both open gaps in `save_preset`.

**Why this capture (2026-07-03 probe results):** our `save_preset` writes a
Replace-Patch (SysEx `F0 00 20 29 01 64 01 <slot> 00 <340> F7`), but we can neither
verify nor use it over MIDI, because **MIDI patch-select does not work on the unit**:
`scripts/probe-circuit-pc-select.ts` showed Program Change on ch1, and every
Bank-Select MSB/LSB + PC variant, never changes the loaded patch (the dump stays on
the current patch; PC only reverts a live edit). The read path itself is solid (the
dump reflects live CC edits instantly). So we have no MIDI way to reload a bank patch.
This capture is the ground truth for the real select + save mechanisms.

USBPcap + Wireshark mechanics: see `CONTRIBUTING.md` (the maintainer's standard editor-
write decode). Reuse the same MIDI-extraction you used for `get_pack_from_circuit_tracks.pcapng`.

## Before capturing

1. **Quit Claude Desktop** (or otherwise free the Circuit's MIDI port: it is exclusive;
   a held port makes Components fail to connect and the capture useless).
2. **Setup View check** (Shift + Save on the device): confirm **MIDI data control → MIDI
   Program Change data → Rx = On**. Note its state either way (our probe saw PC *received*,
   so it is likely On, but confirm, and note if a per-part toggle exists).
3. Open **Novation Components → Circuit Tracks → Synth Editor**, connected.
4. Start USBPcap on the Circuit's USB device.

## Captures to take (ONE action per capture, one hypothesis per file)

| File (→ `samples/captured/`, gitignored) | Action in Components |
|---|---|
| `components-patch-change.pcapng` | Select 3 DISTINCT named patches in the Synth Editor, ~1 s apart (e.g. "BassOSC", "Bassix", "Saw Pad"). Just change patch, no edits. |
| `components-patch-save.pcapng` | Edit ONE param (e.g. filter cutoff), then Save / "Send to Circuit" / upload to a specific slot. Note which slot. |
| `components-patch-read.pcapng` *(optional)* | If the editor pulls the current patch (a "get from Circuit" / refresh), capture it: tells us if it uses our `0x40` dump request. |

Keep ≥1 s between actions so each is a clean, isolable block in the capture.

## How to read it

MIDI rides USB as either 4-byte USB-MIDI event packets (1-byte cable/CIN header + up to 3
MIDI bytes) or bulk SysEx. Look in the host→device direction for:

- **Program Change:** `Cn pp` (n = channel: `C0` = ch1 Synth 1, `C1` = ch2 Synth 2, `CF` = ch16 Project).
- **Bank Select:** `Bn 00 <msb>` and/or `Bn 20 <lsb>` immediately before a PC.
- **Circuit SysEx:** `F0 00 20 29 01 64 <cmd> …`. Patch commands: `00` Replace-Current, `01`
  Replace-Patch (Flash), `40` Dump-Request. File-transfer group is `03` (the `.ncs`/sample protocol).

## What each outcome means (decision tree)

**Patch CHANGE (`components-patch-change.pcapng`):**
- Plain `C0 <n>` on ch1, nothing else → our `buildProgramChange(0, n)` is byte-identical, yet
  the unit ignored it → the difference is device state/mode (recheck Setup View Rx, or the
  synth must be track-selected). Flag as a firmware/mode caveat.
- Bank Select + PC → we're missing the bank prefix; implement the exact `msb/lsb` it uses.
- A **SysEx** select (some `F0 00 20 29 01 64 …` we don't send) → THIS is the real patch-load
  message; implement it. That unlocks `get_param`-after-select and the save reload/verify.

**Patch SAVE (`components-patch-save.pcapng`):**
- Matches `F0 00 20 29 01 64 01 <slot> 00 <340> F7` → our `buildReplaceFlashPatch` is correct;
  the reload path was the only gap (fixed by the select finding above).
- Replace-Current (`00`) then something else (a commit / file-transfer) → the Flash write needs
  that extra step; add it.
- A **file-transfer session** (group `03`, like projects/samples) → patch save uses the transfer
  protocol, not a one-shot SysEx; port that path (we already have the transfer layer for `.ncs`).

## After the capture

1. Diff the captured bytes against `buildProgramChange` / `buildReplaceFlashPatch` /
   `buildDumpRequest` (`packages/circuit-tracks/src/codec/`).
2. Implement the corrected select (and save, if different).
3. Re-run `npx tsx scripts/probe-circuit-patch-save.ts`; a PASS flips `supports_save → true`.

## RESULTS: captured + decoded 2026-07-03 ✅

Captures: `samples/captured/components-patch-{change,save}.pcapng`. Decoder:
`scripts/_research/decode-circuit-usbmidi.py` (parses the pcapng EPBs + USBPcap headers, de-frames
USB-MIDI 4-byte packets, reassembles SysEx ACROSS URB boundaries; the naive contiguous scan
misses everything because the CIN header byte breaks up the payload).

**A quick de-framer's first pass suggested "save = file-transfer 0x04"; the PROPER de-framer
(per-direction, across URBs) CORRECTED that.** The real picture, three distinct mechanisms:

**1. SAVE a patch to a Flash slot = Replace-Patch (`cmd 0x01`), and our frame was malformed.**
Components sends `F0 00 20 29 01 64 01 00 <slotHi> <slotLo> 00 <340 body> F7` (**352 bytes**), a
**5-byte prefix** with the slot at body-offset 3. Confirmed across FOUR messages (slots 0/1/2/3, all
`01 00 00 0X 00 …`). **Our `buildReplaceFlashPatch` emitted a 3-byte prefix `01 <slot> 00 …` (350
bytes)**, slot in the wrong position, body shifted 2 bytes, so the device silently dropped it.
That is the save bug. **FIXED 2026-07-03** (`codec/sysex.ts`) + goldens updated.

**2. LOAD a patch into the working buffer (editor "select") = Replace-Current (`cmd 0x00`).**
Components pushes the full 340-byte body: `F0 …64 00 00 00 <340 body> F7` (350 B). It does **NOT**
use Program Change, which confirms `probe-circuit-pc-select`'s finding (PC on a synth channel does
not select a patch; that was never how patches load). To load/preview a stored sound programmatically,
push Replace-Current, don't PC.

**3. READ a stored Flash slot = file-transfer READ (`fileType 0x04`).** THIS is where the
file-transfer protocol is used: projects=`0x03`, **patches=`0x04`**, samples=`0x05`. A read returns
an **1876-byte patch FILE** (msb-interleaved WRITE_DATA, CRC-finished, same transport as
projects/samples), a DIFFERENT, larger layout than the 340-byte SysEx body (file starts with the
16-char name, then an expanded param region). This is the missing verify/read-back path: `downloadOnce`
with `fileType 0x04` gives us save verification, patch `get_preset`, and the overwrite-gate occupancy read.

### RESOLVED: save + read both HARDWARE-CONFIRMED (2026-07-03)

A 7-agent capture review (diffing our failing probe capture `probe-circuit-patch-save-1.pcapng`
against Components byte-for-byte) plus follow-up probes closed both gaps:

- **SAVE: ✅ CONFIRMED (survives power-cycle).** The corrected frame was necessary but not
  sufficient. Two more fixes: (1) **clean `body[17]=0x00`**: that byte (frame offset 28) is a
  dirty-edit marker; a live-buffer dump carries `0x01` and the device refuses to commit a dirty body
  (every persisted Components save carries `0x00`). (2) **FIRE-AND-FORGET**: the Replace-Patch must
  be the last message on the wire; our in-band verify read's `CLOSE/OPEN` was aborting the flash
  commit. The device never acks a save even on success. Wired into `save_preset`; `supports_save=true`.
- **READ-BACK: ✅ CONFIRMED, but NOT via the file store.** The file-transfer read (`fileType 0x04`)
  reads the pack's sparse patch FILES, which do NOT contain a `save_preset`'d patch (a saved slot read
  back empty though it was audibly there). Fix: `get_preset("patch:N")` reads the actual synth BANK by
  **PC-loading the slot + dumping**: a Program Change on the synth channel loads an OCCUPIED bank slot
  into the working buffer (the old "PC does nothing" was only true for EMPTY slots). Returns name + all
  decoded params, restores the prior buffer. HW-confirmed: read `PROBE85` / freq=85 back from slots
  62/63 right after saving. The file-transfer read stays only in `checkOverwriteTarget` (non-destructive
  to the buffer the save is about to persist).

### Survey of all Circuit captures (via the de-framer)

`components-patch-{change,save}` → PATCH; `ct_upload_single*`, `send-*-samples` → sample transfers;
`get_pack_from_circuit_tracks` → **proj + PATCH + sample** (the full pack read, the patch-file
corpus). The ~120 `session-*`/`fm9-*` captures are Fractal (guitar) traffic, 0 Circuit messages.

## Reframe: SETTLED

The bank Replace-Patch DOES persist a synth patch on its own (power-cycle confirmed), so "save my
sound" is served directly by `save_preset` to a bank slot; no project re-save required. The
project-embed path (re-saving the `.ncs`, which we own) remains a valid alternative for "save the
whole song state," but is not needed for a single synth patch.
