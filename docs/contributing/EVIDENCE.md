# Evidence, not hardware

A capability here can be **built and shipping** and still be **unconfirmed on
hardware**. Those are two different axes and this project never collapses them
into one word.

If the wire logic is derived from evidence we can actually check, it ships, and
it says `hardware-unverified` on the tin. Checkable means one of:

- byte-exact against a real capture we hold,
- self-validating, where the device's own checksum or CRC would reject a wrong
  answer,
- a byte-identical round-trip against a reference we trust,
- read byte for byte out of a published specification.

**`untested` is not `unbuilt`.** A capability sitting at `hardware-unverified`
is done pending a confirmation, not missing.

That is why your five-minute test matters even when the code already exists.
You are not filling a hole. You are converting `hardware-unverified` into
`confirmed`. On a device family that shares a codec, confirming one unit raises
confidence across all of them: the Fractal gen-3 family is one codec bound to
four model bytes, so an owner test on one member is evidence about the others.

## The counterpart, which is what makes the promise credible

Anything **guessed**, with no way to catch a wrong answer, does not ship. If it
ships at all it ships behind a distinctly louder label, never under the same
banner as evidence-backed work.

You will never be asked to test a guess while being told it is a
near-certainty. When a page says a capability is `gated`, that means we could
have shipped a plausible-looking frame and chose not to, because a wrong frame
sent to your device is worse than a refusal.

The MiniFreak is the clearest example in the repo. Its SysEx surface is absent
rather than approximate, because the Arturia envelope is keyed by a per-product
device-code byte and the MiniFreak's is unknown. A guessed byte would address
some other Arturia product on the same bus. So the whole surface is
structurally disabled until one owner recovers the real byte. See
[devices/minifreak.md](devices/minifreak.md).

## Where status actually lives

One source of truth, three renderings.

- **Source of truth:** `capabilities.support_tier` and
  `capabilities.verification` on the device descriptor in its package source.
- **Contributor rendering:** the Support status table on each device page under
  `devices/`. It is bound to the descriptor by the page's `contribution-meta`
  block, and preflight fails if the two disagree.
- **Agent rendering:** `describe_device` and `describe_rig`, fed from the same
  descriptor field.

A device page that lags its descriptor is a build failure, not a stale doc. See
`scripts/verify-contribution-guides.ts`.

## What a failure report is worth

More than a success report, usually.

If a tool reports success and the front panel does not move, that is the single
most valuable thing anyone outside this repo can send. It means an
evidence-backed frame is wrong in a way no offline check could catch, and it is
the only signal that finds that class of bug.

The front panel is the ground truth. The vendor editor is not: editors cache UI
state and can show a value the device is not holding. When the panel and the
editor disagree, the panel wins.
