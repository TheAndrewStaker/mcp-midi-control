# Circuit Tracks micro-step placement — SOLVED (both fronts hardware-confirmed)

> **Status (2026-07-03): DONE.** Front B (note-track delay) was confirmed and
> shipped 2026-07-02; **Front A (internal drum mask) was captured by the
> maintainer 2026-07-03 and the POSITIONAL hypothesis CONFIRMED** — every
> single-bit state matched (pos1..pos5 → `0x02/0x04/0x08/0x10/0x20`, buzz →
> `0x3F`; capture artifact `scripts/groove-analysis/_microstep-capture.json`).
> Wiring shipped same-day: the writer's drum route builds the mask from
> `Step.micro` (placed onsets, additive OR-merge per step) and fans rolls
> 2..6 to evenly-spaced ticks with the SAME spacing as the note-track delay
> fan (internal + external copies of a roll stay aligned); char-grid roll
> digits 2-5 are UNLOCKED (evenly-spaced sub-hits, not the front-loaded burst
> the old refusal guarded against); `micro_rounded_internal` is gone —
> placement is lossless on every route. Goldens: verify-patterns.ts,
> verify-circuit-ncs.ts (mask 0x29 for roll 3, additive 0x09 for hit+32nd).
>
> Historical context below (the hypothesis + capture plan, now confirmed).
>
> **Front B (note tracks, per-slot `delay` 0..5) — SHIPPED + B0 HW-CONFIRMED.**
> The B0 gate question ("does the Circuit MIDI-OUT transmit the note-track
> `delay` as real wire micro-timing, or only nudge the internal synth?") was
> answered on hardware 2026-07-02 by a fully automated probe
> (`scripts/b0-author-delay-test.ts` + `scripts/b0-drive-and-capture.ts`:
> PC ch16 project select + 0xFA/0xF8 clock drive + timestamped capture): a
> delay-3 note in the same step as a delay-0 note arrived **61.5 ms** after it
> at 120 BPM vs **62.6 ms** predicted (ratio 0.98, range 60–63 ms over 6
> loops). **Delay IS on the wire** — micro-placement reaches external gear
> (SPD-SX). The placement pipeline shipped the same session: the quantizer
> (`drumScore.ts`) PLACES off-grid onsets as `Step.micro` micro-tick lists
> instead of rounding, `compileToPlan` expands them into per-onset events
> (`RealizeNoteEvent.micro`, true-time `time_ms`), and the .ncs author
> (`writer.ts`) writes each onset's note-slot `delay` byte. Goldens in
> `verify-patterns.ts` + `verify-circuit-ncs.ts` (identity invariant included:
> on-grid patterns are unchanged).
>
> **Front A (internal DRUM tracks, the 6-bit `rhythm` mask) — capture still
> QUEUED.** Needs the maintainer at the device (the readline-gated
> author-on-device diff below). Until then internal drum tracks still round
> micro onsets to the step (reported via `micro_rounded_internal`), and roll
> stays `{1,6}`-only. Everything below is the standing plan for that capture.

## The gap

A Circuit drum step's `rhythm` byte (at `drumRowBase(track,pattern) + 96 + step`)
holds a **6-bit micro-hit mask** in its low bits — each step is subdivided into
six micro-ticks. We have decoded only its two **endpoints**:

| Mask | Meaning | Status |
|---|---|---|
| `0x01` | a plain on-beat hit (micro-tick 0) | confirmed |
| `0x3F` | all six micro-ticks fire = a full "buzz" roll | confirmed (HW 2026-06-20) |

The 60 values between are unconfirmed, so the writer authors only roll `{1,6}`
(`drumPattern.ts`: `micro_hits === 6 → 0x3f`, else `0x01`). A prior `roll 3 →
0x07` was a **guess** and was un-shipped.

This caps faithful import of fast parts. Worked example — Sleep Token
"Gethsemane" bridge hat (measures 128-139, track `t11`): of 216 hat hits, 69%
are plain 16ths (micro-tick 0), but **27 are 32nd notes (need micro-tick 3)** and
**12 are 16th-note triplets (need micro-ticks 2 & 4)**. Authoring those micro
positions takes the import from **~69% → ~87%** faithful. (The remaining ~12% are
64th-note bursts that fall at micro-tick 1.5/4.5 — off the 6-tick grid entirely;
a buzz roll is the only approximation.)

## Hypothesis (strong)

The rhythm low-6-bits are a **positional mask**: bit *k* (value `1<<k`) = a hit
on micro-tick *k*. The two known anchors are exactly the endpoints of such a
mask (`0x01` = bit 0 alone; `0x3F` = all six). If true:

- 32nd note → `0x08` (bit 3)
- 16th-triplet offsets → `0x04` & `0x10` (bits 2, 4)
- two hits in one step (e.g. a 32nd pair) → additive, `0x09`

The capture also resolves the alternative: if the device only produces
**contiguous low runs** (`0x01,0x03,0x07,0x0F,0x1F,0x3F`), the field is a roll
*length*, not free placement — in which case 32nd offsets need a finer step grid,
not micro-steps. Either outcome is decisive.

## Capture (queued — `scripts/circuit-microstep-capture.ts`)

Method: the **before/after on-device diff** that decoded length/chain/scenes —
read-only over MIDI (`downloadProject` only), one variable per capture,
readline-gated. You author one controlled micro-step state on a single drum
step, save to a scratch slot, press Enter; the script downloads and reports
which `rhythm` byte changed and its bit pattern, checking each against the
positional prediction.

```
npx tsx scripts/circuit-microstep-capture.ts [scratchSlot=63] [--extended]
```

Core plan: a single hit at each of the 6 micro positions (reads the bit-ordering
directly) + a buzz re-confirm. `--extended` adds a two-tick combo (additivity)
and the device roll/repeat control at 2/3/4 (does roll = contiguous low bits?,
and was the `0x07` guess right?).

Prereqs: Circuit powered on, **Novation Components closed** (port contention =
no-ack), a scratch slot you don't mind overwriting.

## After the capture (wiring, if positional confirmed)

1. `drumPattern.ts`: let `microHits` accept the full `1..63` mask (write it
   verbatim, `& 0x3f`); update the decode doc with the confirmed bit→tick map.
2. `writer.ts` drum route: build the mask from `Step.micro` (the quantizer
   already emits the placement list — Front B shipped it 2026-07-02; the drum
   route currently rounds and counts `micro_rounded_internal`). The mask for
   micro list `[0,3]` would be `0x09` (additive), etc.
3. `verify-circuit-ncs.ts`: golden for each captured mask (cite byte offset).
4. Re-run the Gethsemane import and re-measure fidelity (target ~87%).
5. Update `docs/design/songsterr-drum-import.md` (the micro-step row) + this file
   (move masks from "to confirm" → "confirmed", cite the capture).
