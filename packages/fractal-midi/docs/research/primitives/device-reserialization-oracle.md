---
name: device-reserialization-oracle
class: verification-method
status: partial-N1
discovered: 2026-07-27 (Circuit Tracks tie/gate orthogonality test; the mixer byte that moved on its own)
verified_on:
  - circuit-tracks-2026-07-27 (pack 5 project 42 gate lane, on-device Save, 2-byte diff)
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-device-reserialization-oracle
relates_to: [gen3-sub2e-live-meters, am4-fn03-stored-dump-request, ii-fn03-dump-addressing]
consumed_in:
  - scripts/circuit-tie-orthogonality-arm.ts
  - scripts/circuit-tie-orthogonality-read.ts
  - scripts/verify-circuit-ncs.ts
  - docs/contributing/devices/circuit-tracks.md
---

# Device re-serialization oracle: telling "the device accepted it" apart from "the file kept it"

**Method primitive, not a wire shape.** It answers a question every stored-file
and stored-preset decode eventually hits: we wrote a value into a device's own
file format, sent it, read it back, and it is still there. What did that prove?

## The trap

Write bytes, upload, download, read the same bytes back, and you have proven
exactly one thing: **a file round-trips a value you chose**. That is circular.
The question worth asking is almost always a different one: does the DEVICE
accept the value, understand it, or normalize it? A storage medium that faithfully
returns your own bytes answers none of that.

The trap is that the circular test is indistinguishable, at the byte level, from
a successful one. Both end with your value on the screen. Nothing in the result
says whether the device parsed the field into its model and wrote it back out, or
whether the image you uploaded sat untouched in flash and came back verbatim.

## The method

1. **Write the value under test** into the stored file, upload it.
2. **Make the device re-author the file from its own internal state.** On most
   devices this is: load the item, touch something, save. The load populates the
   device's model from the file; the save serializes that model back out. A save
   is the only cheap operation that forces a full compose-from-state.
3. **Pick an ORACLE field before the test**: an unrelated field that can only be
   composed from live hardware state, never from the loaded file. Arrange for it
   to differ from what the uploaded file says (see "Poisoning the oracle field").
4. **Diff the read-back against the pre-save image**, not against your
   expectation. You want the complete change set, not a spot check.
5. **Adjudicate** on two independent signals: did the field under test change,
   and did the oracle field move?

## What makes a good oracle field

Four criteria. The first three are hard requirements; the fourth is what makes
the experiment practical.

- **Composed from live hardware state.** The value must be readable off the
  physical instrument at save time and cannot be derived from the uploaded image.
  A physical control position (fader, knob, encoder, pedal) is close to ideal: it
  lives outside the file by construction.
- **Independent of the field under test.** Different subsystem, different region
  of the file, no shared encoder. If one mechanism could plausibly explain both
  fields moving, the oracle explains nothing. A field under test can never be its
  own oracle.
- **Stable across reads when no save happened.** This one is easy to miss and it
  is fatal when violated. A byte that drifts between two back-to-back reads with
  nothing in between (the AM4 dump's volatile offset cluster, see
  [[am4-fn03-stored-dump-request]]; the VP4 structure blob's telemetry float, see
  [[vp4-eid206-structure-blob]]) moves whether or not the device re-serialized, so
  its movement carries no information. Live telemetry is the classic false oracle:
  it looks live because it IS live, but it is live in the read path, not the save
  path.
- **Cheap for the operator to move.** The whole step must fit in one sentence of
  instruction: "nudge a fader, then save." Anything that needs menu diving gets
  done wrong or not at all, and the report comes back ambiguous.

### Finding one on a device you do not know

Do not go looking during the experiment. Qualify a candidate in a **separate,
earlier round trip**, or you are using the thing under test to validate itself.

1. **Start from the physical panel.** Enumerate the controls whose positions the
   device could plausibly persist: mixer levels, pans, master volume, tempo,
   transpose, swing. These are the fields most likely to be sampled from hardware
   at save time rather than carried through from the file.
2. **Run a null round trip first.** Download, upload the same image unchanged,
   download again. Every byte that moves here is volatile-on-read and is
   disqualified as an oracle (criterion three).
3. **Run a qualification round trip.** Author a distinctive value into the
   candidate field, upload, move the corresponding physical control to a
   different position, save on the device, download, diff. If the candidate now
   holds the control's position rather than the value you wrote, it is composed
   from live state and it is a valid oracle. Record which field, which control.
4. **Prefer a field you already had to decode for other reasons.** The best
   oracle is one whose semantics are already pinned, because you can state what
   its new value MEANS, not merely that it changed.
5. **Failing all of that**, any byte that changed which you did not write is weak
   evidence of re-serialization ("the save was not a pure echo"), but it is not
   the oracle: you cannot say where the new value came from, so a firmware
   housekeeping counter and a live-state field look the same.

### Poisoning the oracle field

Write the oracle field to a value the live control cannot be sitting at (zero, on
a control the operator will be asked to move off zero), then ask the operator to
move it. The oracle's movement is then unambiguous and large, and it cannot be
confused with an incidental rewrite of the same value. Without this step, an
oracle that happens to agree with the file stays silent and you learn nothing.

## The adjudication table

Read the two signals independently. Note the **asymmetry**: they are not
symmetric halves of one test.

| Field under test | Oracle | Verdict |
|---|---|---|
| **Changed** from what you wrote | not needed | **Conclusive without any oracle.** Only the device could have rewritten it. Whatever it now holds is the device's own normalization, quantization, clamp, or rejection. Decode that value. |
| Survived unchanged | moved | **Re-serialization proven; the survival is the device's answer.** The device composed the image from its own state and its state holds your value. |
| Survived unchanged | did not move, but other bytes you did not write changed | **Likely, not proven.** The save was not a pure echo, but nothing ties the changed bytes to live state. Treat as suggestive and fall back if the claim is load-bearing. |
| Survived unchanged | nothing at all changed | **Inconclusive.** Indistinguishable from an echo of the uploaded image. Do not report this as a confirmation. |

A CHANGED value under test needs no oracle at all. The oracle exists solely to
rescue the case where the value SURVIVES, which is also the case that most looks
like success and most often is not.

## The limit, stated plainly

What the oracle **proves** is that the region containing the oracle field was
composed from device state.

That the region containing your field under test was **likewise** rebuilt, rather
than copied through from a cached image of the loaded file, is a **strong
inference from the same save path, not a separate measurement.** A device that
rebuilt its mixer block from live faders while blitting its pattern block through
from a cache is conceivable. Nothing in this method excludes it. Say "the device
re-serialized the project and kept the value", not "the device parsed and
re-emitted this exact field."

The strength of the inference scales with how much of the image demonstrably came
from state, so a diff that shows several independent regions moving is worth more
than one byte in one region.

**The airtight version** is to have the DEVICE author the value through its own
UI: dial the setting in on the front panel, save, download, and read what it
wrote. That removes the upload from the causal chain entirely, so there is no
echo hypothesis left to exclude. It costs more operator effort (finding the
control, hitting the exact value, and often a value the UI cannot express at all),
which is why it is the fallback rather than the default. **Reach for it when the
oracle result lands in either of the bottom two rows above**, or when the claim is
one the product will be built on.

## Worked example: Circuit Tracks tie plus gate, 2026-07-27

The question was a field-independence one. The per-step gate byte in the `.ncs`
project format decodes as `tie << 7 | gate_sixths`. All 1,048 ties observed
across a 274-file / 44,898-slot corpus sat at magnitude 96 (16 steps), so the
corpus could not distinguish "two independent fields" from "a tie forces maximum
length" (or from "`0xE0` is a single drone sentinel").

- **Field under test**: byte `0x1a281` in pack 5 project 42, the MIDI 1 /
  pattern 1 / step 1 / slot 1 gate lane. Written to **176** (`0x80 | 48`, a tie at
  8 steps), a combination the corpus had never shown. Uploaded by
  `scripts/circuit-tie-orthogonality-arm.ts` as a verified single-byte edit.
- **Oracle**: byte `0x2701c`, synth 1 mixer level. Qualified the day before by an
  unrelated experiment: the differential that decoded the drum levels showed
  `MIXER_SYNTH1_LEVEL` / `MIXER_SYNTH2_LEVEL` moving `0 -> 2` and `0 -> 39` on a
  hand-Save, values never sent over the wire, i.e. the live fader positions
  sampled at save time (`packages/circuit-tracks/src/ncs/format.ts`). Poisoned:
  the uploaded image held 0.
- **Operator step**: load project 42 on the device, nudge the Synth 1 fader off
  zero, save. One sentence.
- **Read-back diff** against the pre-save backup, 2 bytes in 160,780:

```
0x1a281   224 -> 176    midi1 / pattern 1 / step 1 / slot 1 GATE LANE  (field under test)
0x2701c     0 ->  57    mixer synth1 level                            (oracle)
```

- **Adjudication**: row two. The mixer byte cannot have come from the uploaded
  image, so the device rebuilt the project from its own state, so the surviving
  176 is the device's answer and not our own bytes handed back. Tie and magnitude
  are independent fields; the rival hypothesis predicted 224 and is falsified.
- **Structural independence check**: the note-pattern region for this track and
  pattern is `[0x1a27c, 0x1a5fc)`; the oracle at `0x2701c` sits about 52 KB
  outside it, in the mixer block. No single mechanism spans both.

Without the oracle, reading 176 back would have been indistinguishable from an
echo, and the correct report would have been "inconclusive."

## Applicability, and the path to `matched`

`partial-N1`: one device axis so far (Novation Circuit Tracks, storage-transport
file round trip). The method itself is device-agnostic and transport-agnostic; it
applies wherever a host can write a device's stored representation and ask the
device to write it back. Nothing in it is Fractal-specific, which is why it is
filed as a method rather than under a device.

Standing transfer candidates, any one of which promotes this to `matched`:

- **Fractal `save_preset` confirmation** (AM4 / II / gen-3). The open hardware
  question on several devices is whether a host-issued store actually persisted.
  Candidate oracles: a front-panel-set field the host never wrote, or the II's
  scene / channel state set from the panel before the store. Beware the AM4 dump's
  volatile offset cluster ([[am4-fn03-stored-dump-request]]), which fails
  criterion three, and beware the II's slot-addressed `fn=0x03`, which RELOADS the
  working buffer and therefore mutates the very state you are trying to read
  ([[ii-fn03-dump-addressing]]).
- **SPD-SX kit authoring** over the storage transport. The device re-writes its
  kit XML on a panel-side save; a pad parameter set from the panel is a candidate
  oracle for confirming an authored kit was ingested rather than merely stored.
- **Hydrasynth patch writes**, where there is no MIDI dirty signal and therefore
  no other way to distinguish "the device took it" from "the file holds it."

A second axis needs the same shape, not merely a second successful write: an
oracle field qualified in advance, poisoned before the test, and a diff of the
full image.

## Misapplication notes

- **Using a field you authored as the oracle.** If the value could have come from
  your upload, its presence proves nothing. The oracle must be unwritable by you
  in that round trip.
- **Using live telemetry as the oracle.** CPU meters, output meters, poll counters
  ([[gen3-sub2e-live-meters]], [[vp4-eid206-structure-blob]]) move on every read
  regardless of any save. They are live in the read path, not the save path.
- **Using a read path with side effects.** If the read reloads or rewrites the
  buffer, the state you sampled is not the state the save produced
  ([[ii-fn03-dump-addressing]]).
- **Spot-checking instead of diffing.** Reading only the two bytes you care about
  hides the third byte that would have told you the save did something else
  entirely. Diff the whole image and locate every change.
- **Reporting the inference as the measurement.** See "The limit, stated plainly."
  The honest sentence names what moved and what that licenses.

## Verification path

The golden (`case-device-reserialization-oracle` in
`scripts/primitives-verify.ts`) is structural plus behavioral, because a method
has no bytes of its own to assert:

1. **The decision rule is executable and pinned.** The adjudication table above is
   implemented as a function and asserted over all four rows plus the
   inadmissible-oracle case, including the asymmetry (a changed field under test
   is conclusive with no oracle at all).
2. **The oracle-admissibility predicate is pinned.** The three hard criteria are
   asserted to accept the Circuit mixer byte and to reject (a) the field under
   test as its own oracle, (b) a field the uploaded image authored, and (c) a
   read-volatile telemetry byte.
3. **The worked case's arithmetic is pinned.** `176 = 0x80 | 48` splits to
   `{tie, 48 sixths}`; the rival "tie forces maximum" hypothesis predicts 224 and
   is falsified by the observation; the oracle offset lies outside the note-pattern
   region under test.
4. **The cited artifacts are reachable and still carry the method.** Both probe
   scripts must exist, and the read script must still import the mixer constant
   and implement its `--before` diff. A refactor that quietly drops the oracle leg
   leaves the shipped implementation unable to discharge this entry's claim, and
   the gate says so.

What the golden deliberately does NOT do is assert a byte encoding, because this
primitive has none. The gate-lane packing itself (a top-bit flag over a 7-bit
magnitude) is generic and is separately pinned by byte goldens in both directions
in `scripts/verify-circuit-ncs.ts`.

## Refinement history

- 2026-07-27: registered `partial-N1`. Discovered while closing the Circuit
  Tracks tie/gate orthogonality question. Filed as a cross-device METHOD rather
  than as a Circuit wire-format entry: the transferable content is the experiment
  design, the gate packing it settled is thin as a primitive and already gated
  elsewhere, and the corpus already carries device-neutral method entries.
