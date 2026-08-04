---
name: deferred-commit-readback-window
class: verification-method
status: partial-N1
discovered: 2026-07-27 (Circuit Tracks pack-2 sample clone; 8 slots read back "empty" that were fine)
verified_on:
  - circuit-tracks-2026-07-27 (pack sample manifest, ~6-8 s post-CLOSE flush; 1.2 s read reported 8 of 63 slots absent, later read showed all present)
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-deferred-commit-readback-window
relates_to: [device-reserialization-oracle]
consumed_in:
  - scripts/circuit-clone-pack-samples.ts
  - packages/circuit-tracks/src/ncs/sampleDirectory.ts
  - packages/circuit-tracks/src/descriptor/writer.ts
  - docs/design/circuit-sample-upload.md
  - docs/design/circuit-pack-addressing.md
  - docs/contributing/devices/circuit-tracks.md
---

# Deferred-commit read-back window: an early "it is not there" is not evidence

**Method primitive, not a wire shape.** It answers the question that comes
immediately after [[device-reserialization-oracle]]: that entry says how to make a
read-back MEAN something. This one says **when a read-back is admissible at all.**

## The trap

A write finishes, every frame is acked, the session closes. You read the device's
own directory back and the slot is empty. The obvious conclusion is that the write
failed, and on many devices it would be right.

But a device that commits stored state ASYNCHRONOUSLY has a window in which its
own listing is behind its own flash. Inside that window, "absent" is not a
measurement of anything: it is the question arriving before the answer. The trap
is that the failure is perfectly silent and perfectly reproducible, so a fast
verification loop returns a confident, repeatable, wrong verdict.

The cost is asymmetric, and that is what makes this a hazard rather than a
nuisance. A false "the write landed" is caught by the next real use. A false "the
write failed" triggers a REDO, and on a device with **no erase** a redo is not
harmless: it consumes a slot, overwrites a neighbour, or burns a session on a
device that was already correct.

## The method

1. **Establish the commit window before trusting any read-back.** Time it once,
   from session CLOSE, not from the last data frame: the flush is triggered by the
   close, so the burst length does not shift it.
2. **Never verify off one immediate read.** Poll: reconnect if the transport
   restarts (a device that re-enumerates on commit invalidates the handle), wait
   past the observed maximum, then retry on a short interval.
3. **Adjudicate on the CLOCK, not on the read.** An observation taken inside the
   window is INADMISSIBLE, whatever it says. Absence is a failure only once the
   window has demonstrably passed.
4. **Let a present result short-circuit.** Presence inside the window is still
   valid evidence: the asymmetry runs one way. Only ABSENCE needs the wait.

The rule in one line: **presence is conclusive whenever you see it; absence is
conclusive only after the commit window.**

## The worked case: Circuit Tracks, 2026-07-27

Cloning Pack 1's 64-slot sample pool onto Pack 2
(`scripts/circuit-clone-pack-samples.ts`):

| Observation | t after CLOSE | Reported | Truth |
|---|---|---|---|
| First verification read | ~1.2 s | 8 of 63 slots absent | all present |
| Re-read after the poll | > 9 s | all present | all present |

The device flushes a pack's sample manifest **roughly 6 to 8 seconds after the
session closes**. Nothing had been lost at 1.2 s; the verification was simply
faster than the device. The loop now reconnects, waits ~9 s, then retries at 5 s
intervals, and treats an absent slot as a failure only once the window has passed.

**This is NOT the refuted in-session commit-wait theory** (see
`docs/design/circuit-sample-upload.md`, 2026-06-23 and 2026-06-28). That theory
said the device's group-`0x08` frame ~6-8 s after CLOSE is a commit-complete
signal you can WAIT ON IN-SESSION to make a write LAND, and it stays refuted: the
device sends that frame pre-write too, and waiting on it did not make the slot
commit. The window is real; the frame is not its signal, and the WRITE does not
need the wait. Only the READER does. Keeping those two apart matters, because the
same "~6-8 s" number appears in a refuted claim and in a confirmed one.

## Applicability, and the path to `matched`

`partial-N1`: one device axis so far (Novation Circuit Tracks, SysEx
file-transfer over USB MIDI). Nothing in the method is Circuit-specific or even
MIDI-specific. It applies wherever a host writes device-resident state through a
session and then asks the device to describe that state back, which covers every
storage-transport and file-transfer device this project touches.

Standing transfer candidates, any one of which promotes this to `matched`:

- **SPD-SX storage transport.** Writes land on a mounted drive; the device
  rebuilds its own kit/wave index on a mode change or restart. If a wave written
  through `spdsx_import_waves` is invisible to the device's own listing for a
  bounded period, that is a second axis point and the same rule applies.
- **Fractal `save_preset` on any generation.** A store is acked long before the
  unit has finished writing flash. If a `get_preset` on the just-saved location
  can return the OLD image inside a bounded window, this generalizes off the
  storage archetype entirely.
- **Any device that re-enumerates on commit.** The transport restart is itself a
  tell that the commit is deferred, and it is observable without timing anything.

The negative result is worth as much: a device whose listing is synchronous with
its write, measured rather than assumed, bounds where this hazard lives.

## What this entry does NOT claim

- **It does not put a number on any other device.** ~6-8 s is a Circuit
  measurement, not a constant. The transferable content is the adjudication rule
  and the obligation to measure the window before trusting a read-back.
- **It does not say a write needs a wait.** The write is complete at close. This
  is purely about the admissibility of the verification.
- **It does not replace a power-cycle check.** Passing the window proves the
  device's own listing agrees; a reboot is still the stronger persistence test.

## What the golden pins

`case-deferred-commit-readback-window` in `scripts/primitives-verify.ts`. Like the
other method entries it has no bytes of its own, so the case pins the decision
rule and the artifacts that carry it:

1. **The adjudication rule is executable.** An absence observed inside the window
   is inadmissible; the same absence after it is a failure; presence is conclusive
   at any time, which is the asymmetry.
2. **The cited verification loop still waits past the window.** The clone script
   must contain a post-write wait at least as long as the observed maximum. A
   refactor that trims it back below the flush window reintroduces exactly the
   false negative this entry exists to prevent, and the gate says so.
3. **The runtime surface still warns.** The sample-directory `capacity_note` must
   still carry the timing, because that string is what an agent reads at the
   moment it is about to draw the wrong conclusion.

## Refinement history

- 2026-07-27: registered `partial-N1`. Discovered during the first on-device
  exercise of the nonzero-pack sample write, where the write itself succeeded
  completely and only its verification was wrong. Filed as a cross-device METHOD
  alongside [[device-reserialization-oracle]], which it composes with: that entry
  makes a read-back meaningful, this one makes it timely.
