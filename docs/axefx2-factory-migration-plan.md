# Axe-Fx II → shared writer/reader factory: migration plan

> **Status: SHELVED (low priority).** This is a code-health / DRY refactor, not
> a capability. The Axe-Fx II is already hardware-verified and is not missing
> any capability relative to the modern Fractal family. It only pays off if
> cross-device capabilities are being added that must land on both II and
> gen-3. While the focus is first-class **fractal-gen3** (formerly fractal-modern) support, leave the
> II as-is. Revisit only if (a) the II writer starts blocking a gen-3 capability
> that needs to land in both, or (b) the two paths drift enough to cause bugs.
> The plan below is kept ready so that revisit is cheap.

## Goal

The modern Fractal family (Axe-Fx III / FM3 / FM9) shares one `makeWriter` /
`makeReader` factory (`packages/fractal-gen3/src/{writer,reader}.ts`): each
device is a config that binds a codec + catalog + grid shape. The Axe-Fx II
still **hand-rolls** its writer/reader (`packages/fractal-gen2/src/descriptor/`,
~1400 + ~700 LOC). The cost of that duplication is concrete: cross-device
capabilities have to be implemented twice (multi-instance addressing needed the
same edit in both the factory and the II writer), and the two paths drift.

This plan migrates the Axe-Fx II onto the shared factory so device-agnostic
orchestration (the `applyPreset` slot loop, `applySetlist`, multi-instance
threading, the dirty guard, the apply budget, the NACK-watch send) lives in
**one** place, and the II contributes only its device-specific pieces.

**This is hardware-verified code.** The II writer/reader is 🟢 on Q8.02. Every
phase below must keep `npm run preflight` green AND be validated by a
`scripts/live-regression.ts` pass on real hardware before the next phase
starts. Do not land the whole migration in one commit.

## Why it isn't a drop-in (the seam)

The factory's `ModernFractalCodec` (`fractal-midi/src/gen3/axe-fx-iii/setParam.ts`)
is uniform and paramId-based: `buildSetParameter(effectId, paramId, wire)`,
`buildSetChannel(effectId, 0..3)`, `buildSetScene`, `buildSetGridCell`,
`buildStorePreset`, `isMultipurposeResponse`, etc. The II diverges on six axes
the generalized interface must absorb:

| # | Axis | gen-3 factory | Axe-Fx II | Seam needed |
|---|---|---|---|---|
| 1 | Param SET builder | one `buildSetParameter` | int-vs-float split: `buildSetBlockParameterValueInteger` (fn 0x02) for `FN02_ONLY_GROUPS` (CPR), `buildSetBlockParameterValue` (fn 0x2e) otherwise | codec method takes a group/kind hint, or the adapter encapsulates the split behind one `buildSetParam` |
| 2 | Channels | A/B/C/D (`0..3`) | X/Y (`'X'`/`'Y'`) | a `channelModel` on the config: names + count + a normalize fn; factory already validates against it |
| 3 | Applicability | none | `checkApplicability` pre-flight (typeApplicability, 786 entries) before a write | optional `preflightParam?(block, name, ctx)` hook the factory calls |
| 4 | display↔wire boundary | catalog schema `encode`/`decode` | II builders take display values directly (calibration inside the codec) | route II calibration through schema `encode` so the factory always hands the codec a wire int (unifies on the gen-3 model) |
| 5 | Block addressing | `resolveBlockOrThrow → effectId` | `block.id` from `KNOWN_PARAMS` | a `ModernCatalog`-shaped adapter over `KNOWN_PARAMS` |
| 6 | set_block | grid `{row,col,blockId}` | grid `{row,col,blockId}` + explicit cell routing (`buildSetCellRouting`) | mostly shared; routing is an extra factory step gated by a `needsExplicitRouting` flag |

## Phased plan (each phase ships + is hardware-validated independently)

**Phase 0: generalize the codec interface (additive, no behavior change).**
Lift `ModernFractalCodec` to a broader `BlockWriteCodec` interface (in `core`
or a shared codec-contract module) that both the gen-3 codec and a new II
adapter satisfy. gen-3 already satisfies it structurally; II's adapter is
written but unused. Factory still only serves gen-3. Gate: typecheck + all
existing tests unchanged.

**Phase 1: II codec + catalog adapters (unused in production).**
Write `axe-fx-ii` adapters: a `BlockWriteCodec` that encapsulates the int/float
split (#1) and X/Y channels (#2), and a `ModernCatalog`-shaped view over
`KNOWN_PARAMS` (#5) whose schema `encode` runs the existing II calibration (#4).
Add a golden test asserting the adapter's `buildSetParam` is byte-identical to
the current hand-rolled II builder across a representative param set (CPR int
param, calibrated amp knob, enum). Nothing in production uses it yet.

**Phase 2: factory seams for applicability + channel model + routing.**
Extend `makeWriter` opts with the optional `preflightParam` hook (#3),
`channelModel` (#2), and `needsExplicitRouting` (#6). gen-3 passes none/defaults
(behavior unchanged; re-run the gen-3 family + dispatcher suites). Wire II's
`checkApplicability` into the hook.

**Phase 3: switch the II descriptor to the factory, behind a parity gate.**
Build the II writer/reader via the factory with the Phase-1 adapters + Phase-2
seams. Keep the old hand-rolled writer in the tree. Add a parity harness that
runs both old and new over the full `verify-dispatcher` + `verify-translator` +
II agent-regression corpus and asserts byte-identical wire output. Flip the
descriptor only when parity is 100%.

**Phase 4: hardware validation + delete the old writer.**
Run `scripts/live-regression.ts` on Q8.02 (self-restoring mutations) +
the agent-sweep. On a clean pass, delete the hand-rolled II writer/reader and
its now-dead helpers. Update STATE + the living-docs table.

## First PR scope (safe, non-breaking)

Phase 0 + Phase 1: the generalized interface + the II adapters with the
byte-parity golden, **with nothing in production switched over**. This is fully
additive, compiles, and proves the adapter reproduces the hand-rolled II wire
output before any descriptor is repointed.

## Risk notes

- The II `applyPreset` also lays content blocks + shunts + **explicit cell
  routing** every adjacent pair (decoded for the silent-preset fix); the gen-3
  factory does not. Axis #6 must be a real factory step, not an afterthought.
- The II's `FN02_ONLY_GROUPS` int/float split is hardware-confirmed; the
  adapter must preserve it exactly (a regression here lands calibrated params at
  the wrong value, the class of bug the fn=0x2e migration once caused).
- `checkApplicability` gating must run at the same point in the write lifecycle
  it does today, or type-gated params silently no-op.
- Do not migrate the reader and writer in the same PR; reader parity (the
  fn 0x1F atomic read + per-channel synth) is a separate verification surface.
