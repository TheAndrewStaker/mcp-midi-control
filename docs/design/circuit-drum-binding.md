# Circuit Tracks drum-track → sample-slot binding (DECODED 2026-06-27)

The long-undecoded "which pool slot does each drum track play" pointer — the last
piece blocking turnkey groove projects (a project that loads with its drums
already pointing at the right kit slots, no on-device hand-assignment).

## The field

**Four consecutive bytes at `0x1a278`** in the `.ncs`, one per drum track, each a
**0-based sample slot** (byte = the device's "Sample N" minus 1):

| Offset | Track | Value = slot |
|---|---|---|
| `0x1a278` | Drum 1 | 0..63 |
| `0x1a279` | Drum 2 | 0..63 |
| `0x1a27a` | Drum 3 | 0..63 |
| `0x1a27b` | Drum 4 | 0..63 |

Project-global (one set per project, NOT per-pattern). Sits in the config region
between the last drum step-block (meta `0x19c4c`) and the first MIDI block
(meta `0x1a5fc`). Codec: `packages/circuit-tracks/src/ncs/drumBinding.ts`
(`setDrumSampleBinding` / `getDrumSampleBinding`); golden in
`scripts/verify-circuit-ncs.ts`.

## Evidence (hardware-confirmed, both directions)

Method: `export_preset(circuit, location=32)` dumps Project 33's byte-exact
`.ncs`; reassign a drum on the device + Save; export again; byte-diff.

1. **Decode (D1 reassign).** Drum bindings went `00 01 02 03` → `0b 07 07 08`.
   The device then *showed* "china" on Drum 1 — byte `0x1a278 = 0x0b` = sample 12
   = china. Independent confirmation from the front panel.
2. **Clean single-variable (D2 reassign).** Reload Project 33, change ONLY Drum 2
   (crash slot 7 → snare_roll slot 6), Save. Diff = **exactly 2 bytes**:
   `0x1a279: 07→06` and the mirror `0x26fc7: 07→06`. Patterns untouched.

The earlier "a reassign didn't show in the .ncs diff" note was wrong — it was
baselined against a stale export (a prior test's Save had already rewritten the
slot). With a correct baseline the pointer is unambiguous.

## The `0x26fc7` mirror — UNRESOLVED, and a conflict to fix

`0x26fc7` holds **Drum 2's sample slot** — confirmed across TWO projects:
- Project 33: `0x26fc7` = 0x01 / 0x07 / 0x06, each equal to Drum 2's binding byte.
- Project 43 (`_chain_before.ncs`): `0x26fc7` = `0x02`, and Drum 2's binding
  (`0x1a279`) is also `0x02`. The drum binding itself (`0x1a278`) is UNCHANGED by
  a chain edit.

So it is the "active / last-selected drum sample" UI byte, not a chain field.
**`ncs/chain.ts` mis-decodes this:** it treats `0x26fc7` as a pattern-chain
enable tail (`CHAIN_TAIL_OFFSET`, writes `0x0c`). In the lone chain capture
`0x26fc7` went `0x02 → 0x0c`, but `0x0c` was just the user's last-selected sample
during that capture (slot 12), NOT a chain constant — the real chain encoding is
the `0x2d4` start/end range + the `0x0f→0x1f` pattern-length bytes (both already
correct in `chain.ts`). The baked chains/scenes worked on hardware *despite* the
spurious tail write, because the tail isn't load-bearing.

**Action:** drop `setDrumChain`'s `0x26fc7` tail write (or, conservatively, gate
it) after a clean re-capture (build a chain on-device WITHOUT touching any drum
sample). `drumBinding.ts` does NOT write the mirror; for authored projects the
device reconciles it on load.

## Authoring

`setDrumSampleBinding(buf, [0,1,2,3])` writes the canonical stoken role layout
(kick/snare/closed_hat/ride on slots 1..4 — matches `pack_groove.py SAMPLE_SLOT`).
Used to repair Project 33 on 2026-06-27 (re-uploaded, read-back byte-identical).
Next: wire it into `apply_pattern mode:ncs_upload` so every authored groove sets
its binding from the voice→role→slot map (see `groove-instrument-mapping.md`).
