# Axe-Fx II atomic read-modify-write apply: safety review

**Status:** decision-ready analysis. No implementation. For founder GO/NO-GO.
**Date:** 2026-07-02
**Author:** research/design-review pass (no MIDI sent, no src/test modified).

---

## TL;DR recommendation

**GO for a scoped v1**, gated by four safeguards; **NO-GO for the topology and
state-word edits** until those regions are decoded.

- **v1 (ship, community-beta / untested-on-hardware):** read a stored or
  edit-buffer preset dump → walk the self-describing TLV chain → patch
  **already-placed CONTINUOUS param words in place** (X and Y) → push → verify →
  optionally save. Same audible surface as today's per-param `apply_preset` on
  those blocks, but delivered as one coherent image load (silent, ~1-2 s) instead
  of ~142 streamed live writes.
- **Gated (stays on the incremental live-build path):** block insert / delete /
  replace (image reconstruction + re-sort), and bypass / scene / X-Y state edits
  (the per-block state words inside payloads are UNMAPPED; this is the sharp
  edge that could re-create the screech).

**The screech-class concern is resolved for the v1 scope by construction:** the
read-modify-write (RMW) path never transits the half-built, engaged-amp-at-default
state that caused the 2026-06-07 self-oscillation, and the continuous-param-only
scope guarantees v1 only ever moves an already-settled knob from one valid value
to another, which is exactly what `set_param` already does audibly and safely
today, one param at a time.

---

## 1. The capability under review

The 2026-07-02 decode ([`cookbook/ii-preset-image-tlv-chain.md`](../../packages/fractal-midi/docs/research/cookbook/ii-preset-image-tlv-chain.md),
shipped as [`packages/fractal-gen2/src/presetImageTlv.ts`](../../packages/fractal-gen2/src/presetImageTlv.ts))
established that the de-framed 4096-word II preset image is a **self-describing
TLV chain**. The dump in hand describes its own layout:

- `word 0` = format tag 2049; `words 2..33` = name; `words 36..129` = grid-order
  record table (NOT serialization order; never enumerate blocks from it).
- `word 130..` = TLV chain `[wire_id, payload_len, payload...]` to a `0`
  terminator. paramBase of a block TLV = `tlvWord + 2`; channel-Y param `p` at
  `paramBase + payload_len/2 + p`.
- Confirmed **388/388** (384 Q8.02 factory presets + 4 live hardware dumps);
  every BK-070 one-variable hardware anchor lands at the exact predicted word.

**What this dissolves:** the previous atomic-apply blocker. The parked research
artifact [`packages/fractal-gen2/src/research/atomicApply.ts`](../../packages/fractal-gen2/src/research/atomicApply.ts)
was gated (removed from the MCP surface, Session 116 cont 4) because its
`BLOCK_LAYOUT_MAP` paramBase coordinates were **calibrated against one Test Crunch
composition and shift per preset**, and the firmware layout encoder was undecoded.
The TLV decode removes that entirely: paramBase is **read from the dump itself**,
so there is **no layout-sort RE and no per-preset calibration probe**. That
blocker is gone.

**What now gates shipping** (per the STATE-AXEFX2 2026-07-02 entry): the
**screech-class safety review** (this document) plus the writeback invariants
(`byte2 & 0x7c` preservation, footer XOR-fold recompute, tone-match region
verbatim).

The pipeline: `dump → parse TLV → patch param words → recompute footer → push
66 frames → (verify) → (STORE if authorized)`. The wire primitives already exist
and are hardware-verified (`buildPatchDumpRequest`, `0x77/0x78/0x79` push,
`buildStorePreset`, footer XOR-fold, `byte2 & 0x7c`-preserving `writeUshortAt`,
all in `atomicApply.ts` and `presetImageTlv.ts`).

---

## 2. Why RMW is safer than the incident's incremental build

### 2.1 The incident (cross-reference)

**2026-06-07, hardware-reproduced** ([`docs/_private/0.2.1-fix-proposals.md`](../_private/0.2.1-fix-proposals.md)
P1; [`BK-070-DECODE-NOTES.md`](../_private/BK-070-DECODE-NOTES.md); regression
[`scripts/verify-screech-bypass-during-build.ts`](../../scripts/verify-screech-bypass-during-build.ts)):

> `apply_preset` emits ~142 live writes; the DSP processes audio through
> half-built states. A non-master amp (Plexi 50W, Brit Super) sits at default
> extreme gain for a few ms, engaged, before its EQ/level land, and
> self-oscillates into a screech that feeds a downstream reverb/delay.

Crucially, the **output mute could not fix it**: a self-sustaining oscillation
does not drain; it energizes while muted and is still ringing when the mute
releases. The shipped fix ([`applyExecutor.ts`](../../packages/fractal-gen2/src/tools/applyExecutor.ts)
~line 572): **bypass every block at placement** (dry pass-through = silent),
write params while bypassed (params store fine: bypass gates the signal path,
not storage), then re-engage to final state after all params land.

The root cause, precisely stated: **an ENGAGED block passing signal through a
not-yet-settled parameter state, with a downstream feedback effect.**

### 2.2 Why RMW does not have that failure

RMW's source is a **complete, coherent, already-settled preset**. v1 changes only
specific continuous param words and pushes the whole image. Two independent
reasons it is safer:

1. **No intermediate cross-block state ever reaches the running DSP.** The
   incremental builder's hazard was the *combination* of blocks in transient
   extremes (amp at default gain + engaged + reverb downstream) assembled a
   piece at a time. RMW assembles nothing; it starts from a preset the device
   already holds as one valid state and hands back a near-identical valid state.

2. **A continuous-param patch is a knob turn, not a build.** Changing
   `amp.gain` from 5 → 7 on an already-engaged, already-settled amp transitions
   the device from one valid gain to another valid gain. That is *exactly* the
   operation `set_param` performs audibly and safely today (hardware-verified
   fn 0x02, Session 60 / HW-075). RMW inherits that proof for every paramId it is
   allowed to touch (see §4, scope).

**The load is silent by construction.** A normal preset change on the II is
silent because the device loads the image as one coherent state. The project's
own analysis records this: *"a native atomic load is silent by construction, so
landing BK-070 would make the entire screech-mute approach redundant"*
([0.2.1-fix-proposals.md](../_private/0.2.1-fix-proposals.md) BACKLOG
CROSS-REFERENCE). The `0x77/0x78/0x79` envelope is the same envelope a stored
preset recall uses; it is wire-confirmed bidirectional, ~1-2 s, non-disruptive.

### 2.3 Where it is NOT automatically safer: the load-bearing assumption

**Does the device apply the pushed image atomically, or param-by-param on
receipt?** The safety argument rests on **buffered-then-atomic** application (all
66 frames buffered, applied as one image on the `0x79` footer). The evidence for
this is strong but indirect: normal preset recalls over this same envelope are
silent, and the push is documented as non-disruptive.

Even under the **worst case** (the device applies frames incrementally as they
arrive), RMW is still materially safer than the incident: every intermediate word
state is a valid intermediate of **one coherent preset**, never the cross-block
extremes the incremental builder created. You cannot get an amp at default gain
that a later frame will fix, because the amp's words were already correct in the
source image and v1 only nudges continuous knobs.

**This assumption is the single hardware-confirmation item** (§6): one listen
test: push an RMW-patched, engaged, high-gain preset and confirm silence.

---

## 3. Concrete failure modes and mitigations

| # | Failure mode | Severity | Mitigation | Residual |
|---|---|---|---|---|
| (a) | Writeback corrupts `byte2 & 0x7c` reserved bits → device NACK 0x13 | Device rejects (fail-safe) | `writeUshortAt` already preserves `(b2 & 0x7c) \| ((v>>14)&0x03)`. Coded invariant. Round-trip-identity precondition (§5) proves it holds for THIS preset before any patch. | none for v1 |
| (b) | Wrong footer XOR-fold → device rejects or misloads | Reject (safe) or misload (unsafe) | `computeFooterHash` recomputes XOR over all decoded native words; footer preserves `byte2 & 0x7c`. Round-trip-identity precondition catches a broken recompute (re-serialize the UNMODIFIED image → footer must equal the source footer byte-for-byte). Post-push read-back (§5) catches a misload. | none for v1 |
| (c) | **Patch a flag-looking word that is actually bypass / scene / X-Y state** (UNMAPPED) → could toggle a bypass and recreate the exact amp-into-delay feedback | **HIGH: the sharp edge** | Three layers: (1) `paramWordIndex` is bounds-checked to the block's own payload half and throws if `paramId >= perChannel`; cannot address a neighbouring TLV or run past the block. (2) v1 only patches paramIds that are **registered continuous knobs with a known calibration** on a block present in the parsed chain, the same paramIds `set_param` already drives audibly, which PROVES they are real knobs, not state words. (3) Refuse bypass (paramId 255), enum/type/effect_type, and any unmapped/state paramId. | Contained to v1's proven-knob set; state-word edits stay gated (§4) |
| (d) | Tone-match bulk region (word 2048+) not preserved | Corrupt tone-match preset | RMW copies the source image and overwrites only specific param words below the terminator; the region is untouched by construction. Round-trip-identity precondition also guards it. | none for v1 |
| (e) | Partial / interrupted push → corrupt STORED preset | Data loss | Per-frame NACK + frame-count monitoring (already in `pushPresetBinary`). Any NACK or miscount **aborts before STORE**. Push to working buffer by default (fully reversible: a preset switch discards it, like `set_param`). STORE only on `save_authorized` + clean push + verified read-back. | none for v1 |

---

## 4. Staged scope

### v1: SHIP (continuous params on placed blocks)

Patch `(block, paramId, channel)` tuples where **all** hold:

- the block wire_id is present in the parsed TLV chain of the dump in hand;
- the paramId is a **registered continuous knob with a known calibration**
  (the amp / cab / drive / delay / reverb / compressor knobs that `set_param`
  already drives, hardware-verified, `HARDWARE_SWEPT` calibration, 344/344
  round-trips);
- the channel is X, or Y on an even-payload block (`paramWordIndex` throws on Y
  for odd-payload single-channel blocks);
- `paramWordIndex` bounds-check passes (paramId within the block's per-channel
  half).

This is the **same audible surface** as today's per-param `apply_preset`/`set_param`
on those blocks, delivered atomically (silent, ~1-2 s, no re-engage transient)
instead of ~142 streamed writes. It is a **UX/reliability upgrade of an existing
capability**, not a new risk surface.

### Gated: STAYS OUT of v1

- **Block insert / delete / replace.** This is image *reconstruction*: the chain
  is alphabetical by squashed AxeEdit display name, so inserting a block shifts
  every later TLV's word position, moves the terminator, and requires
  re-serializing the whole chain. The TLV decode solved **reading** an existing
  image's layout; it did **not** solve **writing** a new topology (that is still
  the BK-084 sort problem). Keep on the incremental live-build path
  (`buildSetGridCell` + the dry-build screech mitigation, which exists precisely
  for this path).
- **Bypass / scene / X-Y channel-state edits.** The per-block state words inside
  payloads are **UNMAPPED at the word level** (only `scene-state-ushort` N=1
  coordinates exist). Patching them blind is failure mode (c). Keep on the
  incremental per-param path (fn 0x02 bypass paramId 255 + fn 0x29 scene, both
  hardware-verified).
- **Enum / type / effect_type sets in the image.** Route via the proven fn 0x02
  enum path, not the image.
- **Modifier records** (chain head, 15-word payload). Layout unknown; read-only,
  preserve verbatim.

---

## 5. The round-trip-identity precondition (the linchpin)

Before trusting the walker on **this** preset, at apply time:

```
deframe(dump) → parse TLV → re-serialize the UNMODIFIED image
             → assert byte-for-byte equal to the source dump (footer included)
```

If it does **not** round-trip identically, **REFUSE**: the walker is not
lossless for this preset (unusual composition, unknown TLV, drifted width,
tone-match quirk), so we must not patch it. This proves losslessness
**per-preset at apply time**, not merely against the 388-dump corpus, and it
single-handedly neutralizes failure modes (a), (b), (d), and essentially all
walker-correctness risk. Only after this passes do we apply the patch, recompute
the footer, and push.

**Post-push read-back verify.** After pushing to the working buffer, re-dump
(edit-buffer `7F 7F` sentinel, no reload side effect, hardware-confirmed
2026-06-10) and confirm: the patched words now hold the intended values **and**
every other word equals the source (only the intended words changed). Only then,
if `save_authorized`, STORE. This catches a mis-push, a device-side transform, or
any unexpected side effect before it becomes a saved corruption.

These two checks convert the entire class of "walker got it subtly wrong" from a
**silent-corruption** risk into a **clean refuse**.

---

## 6. Evidence and hardware axes (per the project shipping bar)

- **Evidence strength: STRONG.** 388/388 corpus (384 factory + 4 hardware dumps);
  BK-070 one-variable hardware anchors land at the exact predicted words; the
  device's own footer XOR-fold and `byte2 & 0x7c` mask self-validate the write
  (NACK 0x13 gates a bad frame); the round-trip-identity precondition is a
  per-preset self-check; and every v1-writable paramId inherits the audible
  hardware proof of the shipping fn 0x02 `set_param` path. → **Ships untested /
  community-beta. DONE pending a confirmation key-press, not "not done."**
- **Hardware confirmation (does NOT gate shipping):** one listen test: push an
  RMW-patched, engaged, high-gain preset and confirm silence (validates §2.3's
  buffered-then-atomic assumption); this flips the label "untested" → "confirmed."
  Optional second: read-back a STORE'd slot and confirm the patched values
  persisted.

Per CLAUDE.md's shipping bar, the honest label is **untested community-beta**,
and untested-but-evidence-backed capability still ships. This is not an
experimental guess behind a louder flag; it is strong-evidence work awaiting a
key-press.

---

## 7. Recommendation: GO for v1 with conditions

**GO** to build and ship the v1 RMW atomic apply (continuous params on placed
blocks) as untested community-beta, conditioned on all four safeguards:

1. **Round-trip-identity precondition**: refuse to patch any preset whose
   unmodified image does not re-serialize byte-for-byte to the source dump.
2. **Post-push read-back verify**: re-dump and confirm only the intended words
   changed, before any STORE.
3. **Continuous-param-only scope**: patch only registered, calibrated knobs on
   blocks present in the chain; refuse enum/type/bypass/state paramIds, Y on
   odd-payload blocks, and any out-of-range paramId.
4. **NACK-abort + STORE gating**: abort before STORE on any push NACK or frame
   miscount; working-buffer-only by default; STORE only on `save_authorized` +
   clean push + verified read-back (layered on the existing safe-edit dirty gate).

The screech-class concern that gated this lane is **resolved for the v1 scope by
construction** (§2): RMW never transits the engaged half-built state that caused
the incident, and v1 only moves settled knobs between valid values.

**NO-GO** for block-topology edits (image reconstruction / BK-084 sort still
open) and bypass/scene/X-Y state edits (per-block state words still UNMAPPED;
patching them blind is the one path that could re-create the screech). Those stay
on the incremental live-build path, which keeps its dry-build screech mitigation.

**Follow-up to unlock the gated scope:** decode the per-block scene/bypass/X-Y
state words (one 3-known-block probe binds the bit semantics) and the modifier
15-word layout; the BK-084 chain re-sort for topology writes remains a separate
multi-session effort.
