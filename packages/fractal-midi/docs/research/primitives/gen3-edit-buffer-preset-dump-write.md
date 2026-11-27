---
name: gen3-edit-buffer-preset-dump-write
class: protocol-exchange
status: partial-N1
discovered: 2026-11-25 (prior-art review of two independent open-source implementations)
verified_on:
  - fm9-fw12-hardware-per-fractone (per-frame ack + load)
  - fm3-hardware-per-forgefx (un-acked paced load only; acks unknown)
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-gen3-edit-buffer-preset-dump-write
relates_to: [gen3-fn03-request-preset-dump, xor-7f-envelope-checksum, msb-first-14bit-preset-payload, ii-fn03-dump-addressing]
consumed_in:
  - packages/fractal-gen3/src/presetDumpEditBuffer.ts (retargetPresetDumpToEditBuffer, classifyDumpFrameResponse)
  - packages/fractal-gen3/src/presetDumpSend.ts (loadPresetDumpToEditBuffer)
  - packages/fractal-gen3/src/presetDumpLoad.ts (loadPresetDumpVerified)
---

# gen-3 edit-buffer preset dump WRITE (host to device 0x77/0x78/0x79)

Load a whole preset into the edit buffer of an Axe-Fx III (0x10), FM3 (0x11)
or FM9 (0x12) by sending the same 0x77/0x78/0x79 dump the unit sends for a
stored preset (see [[gen3-fn03-request-preset-dump]]), with the header
re-addressed to the edit buffer. Nothing is stored.

## Formal definition

```
host   F0 00 01 74 [model] 77 7F 7F [hdr2 hdr3 hdr4] [cs] F7       header (13 B)
         hdr2..4 kept as read: III 00 00 01, FM3/FM9 00 40 00
device F0 00 01 74 [model] 64 77 00 [cs] F7                        ack (FM9 only, see below)
host   F0 00 01 74 [model] 78 [00 08][3072 B septet body] [cs] F7  chunk x N (III 16, FM3/FM9 8)
device F0 00 01 74 [model] 64 78 00 [cs] F7                        ack, after each chunk (FM9)
host   F0 00 01 74 [model] 79 [3 B word XOR] [cs] F7               footer (11 B)
device F0 00 01 74 [model] 64 79 00 [cs] F7                        ack (FM9)
```

The per-frame ack is evidenced on the FM9 (fw 12, fractone) only. Whether
the FM3 or the Axe-Fx III acks each frame is UNKNOWN (ForgeFX sends FM3 loads
un-acked; fractal-remote lists it as not known). Our sender probes the header
on those models for ~400 ms: an ack switches to the acked mode, silence sends
the rest un-acked 150 ms apart, and the edit-buffer read-back compare decides.

- Retarget = header payload bytes 0-1 to `7F 7F` (preset 0x3FFF) and the
  header frame checksum recomputed. The chunks, the raw-patch CRC (raw bytes
  4-5, over the raw patch only) and the footer XOR do not cover the header,
  so they are byte-identical to the dump as read.
- Each frame waits for `64 [fn] 00`. A nonzero result code is a refusal;
  the transfer is retried whole (fractone: up to 3 attempts, 150 ms apart,
  then a 300 ms settle).
- Send NOTHING before the header: fractone saw the FM9 show preset #0 when a
  fn=0x01 sub=0x27 preset switch preceded the dump.
- On the FM3's USB-CDC serial port write each frame in 64-byte slices (ForgeFX:
  a flooded CDC write drops; it paces 64 B / 3 ms). We keep ForgeFX's average
  rate as 12 ms after every 4 slices, because a 3 ms timer lasts ~15.6 ms on
  Windows. fractone writes FM3 serial unpaced; unresolved. A USB-MIDI SysEx
  cannot be split.
- Read back with fn=0x03 `7F 7F 00`. The FM9 answers with header `7F 00 ...`
  (fractone's read-back fixture), so match on content. The unit recalculates
  some Amp words on load (see `presetDumpCompare.ts`), and fractone saw the
  FM9 drop a dump that arrived while it was still loading a just-selected
  preset: resend once after 1 s.

## Evidence

- fractone (GreyManSoftware, MIT), FM9 fw 12 hardware: `ForEditBufferImport`,
  `RestoreAcknowledgedAsync`, `IsSuccessfulAcknowledgement`, plus a hardware
  read-back fixture (`fm9-synthetic-ride-fm9-readback.syx`) that our compare
  accepts against the file sent with only recalculated Amp words differing.
- forgefx-midi (sKuhLight, Apache-2.0) `retargetPresetDumpToEditBuffer`, the
  same byte rewrite, live-validated on an FM3 by the ForgeFX audition flow
  (un-acked paced send).
- The fractone empty templates for all three models are edit-buffer addressed
  files; the golden rebuilds each template's header byte for byte from a
  stored-addressed header.

Two independent implementations agree byte for byte. Neither is our own
capture, and no gen-3 hardware here has run it: community-beta, untested by us.

## Conflict: result code 0x00

Our 0x64 code table labels code 0 `MIDI_ERROR_BAD_CHKSUM` (Axe-Edit III string
table + one III capture of a bad-checksum query answered `64 0E 00`). The
Axe-Fx II answers success with `64 [fn] 00`, and fractone accepts `64 [fn] 00`
as the dump-frame success on FM9 hardware. For the dump frames we follow the
hardware-verified implementation, and code 0 is labelled AMBIGUOUS in the
table. The generic gen-3 fn=0x01 writer keeps treating an echoed 0x64 as a
rejection: live fn=0x01 writes have never drawn `64 01 00` on success on
hardware. Dump frames never go through that path (they use
`classifyDumpFrameResponse`).

## Path to matched

One capture of our own (Axe-Edit III / FM9-Edit / FM3-Edit sending a preset
to the edit buffer, USBPcap) or a maintainer-run load on any gen-3 unit with
the read-back compare holding.

## Refinement history

- 2026-11-25: registered from fractone + forgefx-midi prior art; partial-N1.
