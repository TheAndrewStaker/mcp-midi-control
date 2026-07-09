# Design note: gen-3 integer-step params read back as a literal value, not a knob position

**Status:** proposed, not implemented. Written for discussion — it documents a real
behavior we found in chihotta's FM9 roundtrip and the design choice it forces.

**TL;DR:** For a class of FM9 params (pitch/synth/plex *shift*, *step*, *bitreduce* —
~33 of them), SET already works but READ shows the wrong number, because the device
returns these as a literal integer value while we decode them as a 0–65534 knob
position. Fixing the read is easy in principle but breaks an assumption our code
relies on (that a param's encode and decode are mirror images), so it needs a
deliberate "this param reads differently than it writes" mechanism.

---

## Background: how a normal gen-3 knob works

Think of every parameter as having two forms:

- **Display value** — what a human reads: `gain 5.0`, `mix 25%`, `pitch +12 semitones`.
- **Wire value** — the number that travels over USB.

For an ordinary continuous knob (say amp gain, 0–10), the wire is a **position** on a
0–65534 slider. Halfway up the slider (wire ≈ 32767) means gain 5.0. We convert both
ways with one linear formula:

- **encode** (set): display 5.0 → position 32767
- **decode** (read): position 32767 → display 5.0

`encode` and `decode` are mirror images. Read it back, you get what you set. This is
the model our whole catalog is built on, and it's correct for ~800 FM9 knobs (the
roundtrip confirmed they read back as position).

## What's different about "shift" / "step" / "bitreduce" params

chihotta's roundtrip set each param to five points across its range and read it back.
For `PITCH_SHIFT` (range −24..+24 semitones) the device answered:

| we sent (position) | device read back | meaning |
|---|---|---|
| 0       (slider min) | 65512 | −24 semitones (65512 = −24 as a signed 16-bit number) |
| 16384   (25%)        | 65525 | −11 |
| 32767   (50%)        | 0     | 0 |
| 49151   (75%)        | 12    | +12 |
| 65534   (slider max) | 24    | +24 |

Two things to notice:

1. **SET still works.** We sent a *position* (slider 0..max) and the device landed on
   the right musical value (slider 75% → +12 semitones). Our continuous SET already
   sends a position, so **setting these params is correct today** — same code path as
   the hardware-confirmed amp-gain write.
2. **READ is different.** The device did **not** answer with a position. It answered
   with the **literal signed value** (+12, or −24 encoded as 65512). Our decode assumes
   the read is a position, so it would translate 65512 into roughly **+24** — the
   opposite end of the range. So `get_param` / `get_preset` *lie* about these params.

We confirmed this is not a one-off: it's uniform across all ~32 shift/step params, and
it generalizes to chihotta's separate "integer-quantized" category too (e.g.
`DELAY_BITREDUCE`, `MEGATAP_NUMTAPS`). The clean rule, validated against his data:

> **Integer-step params** (the editor cache marks `step ≥ 1`) read back as their
> **literal integer value** (interpret as signed if the range goes negative).
> **Fractional-step knobs** read back as a **position** (our current decode is right).

Evidence strength: **strong.** The rule is cache-driven (the `step` field already lives
in `FM9_RANGES`), the transform is exact and linear, and it's confirmed against real
hardware readbacks. 33 of ~40 integer-step params fit it cleanly; the ~4 that don't are
most likely the amp-DSP "read-lag" artifacts chihotta separately flagged.

## Why it isn't a trivial fix

Our schema assumes `encode` and `decode` are inverses. For these params they can't be:

- **encode (SET)** must stay **position-based** (the device wants a slider position; this
  already works).
- **decode (READ)** must become **value-based** (the device returns the literal value).

So `decode(encode(x)) ≠ x` for these params — by design, because the device itself is
asymmetric. That's fine for the hardware, but it trips two things in our codebase:

1. The **display-first round-trip gate** (`verify-fractal-gen3-display-units`) asserts
   encode/decode are inverses. These params would need to be recognized as asymmetric
   and checked differently (set-direction and read-direction verified separately).
2. The **schema shape** has one `decode`. We'd add a notion of a separate
   "read decode" (literal-value) distinct from the "position decode," applied by the
   reader only.

None of this is huge, but it's a real model change (the schema contract + the reader +
the gate), so it deserves its own focused change and review rather than being slipped in.

## Scope / blast radius

- **FM9 only**, for the same reason the enum-routing fix was FM9-only: we need the
  device editor cache's `step`/range data to know which params are integer-step, and
  only the FM9 has a synced cache today. III/FM3/VP4 come along once their synced caches
  land (the same blocker as the enum unlock).
- **~33 FM9 params** corrected on read. Real but not the most-used params (pitch/synth/
  plex shift, bit-reduction). Severity: **read-honesty** — control already works; the
  bug is that we report the wrong value back.

## Open questions to decide together

1. **Worth doing now, or queue it?** It's read-only correctness for ~33 niche FM9
   params, at the cost of introducing the asymmetric-wire model. Is that trade worth it
   before the synced-cache work that would let it cover all devices?
2. **How to model the asymmetry cleanly?** Options:
   - (a) Add an optional `readDecode` to the param schema; the reader prefers it, the
     writer ignores it. Smallest concept, slightly leaky.
   - (b) A `wire_kind: 'integer_value'` that the reader and the display-gate both branch
     on. More explicit, more plumbing.
   - (c) Handle it entirely inside the reader from the cache `step`, with no schema
     change (the catalog stays position-based; the reader re-interprets integer-step
     params). Keeps the schema clean; the logic lives in one place.
3. **The ~4 exceptions** (integer-step params that read back as position). Confirm they
   are read-lag artifacts (re-read with a longer settle), or carve them out explicitly.
4. **Verification.** Build a golden straight from chihotta's sent→got pairs so the
   decode is locked to real hardware readings, not a derived formula.

## What this is NOT

Not a control bug. You can set these params correctly today. This is about
`get_param`/`get_preset` reporting the truth for them. Keep that framing when we weigh
priority against the accessibility work, which is likely higher-leverage.
