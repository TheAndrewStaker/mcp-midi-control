# Axe-Fx III: protocol + research

Fractal Axe-Fx III (model byte `0x10`). Community-beta; the project
maintainer doesn't own a III, so wire shapes are decoded from the
Fractal v1.4 PDF plus public captures and Ghidra mining of AxeEdit III.
Code lives in [`packages/axe-fx-iii/`](../../../packages/axe-fx-iii/).

## Files in this directory

- [`SYSEX-MAP.md`](./SYSEX-MAP.md): Axe-Fx III wire-protocol reference.
  Covers the v1.4 PDF (10 documented functions) + 21 fn bytes confirmed
  via Ghidra caller trace + the 49-effect dispatcher catalog. **`§0x01
  PARAMETER_SETGET`** is the Session 97 pivot decode (byte-verified
  against 10 public captures).
- [`design-notes.md`](./design-notes.md): design notes captured while
  scaffolding the III package. Some predate later decode work; cite
  carefully.
- [`dirty-state-research.md`](./dirty-state-research.md): evidence
  chain for the III's `04 01` STATE_BROADCAST dirty signal.
- [`fn01-decode.md`](./fn01-decode.md): function `0x01` three-mode
  envelope decode (Session 81-82 RE work).
- [`preset-format-research.md`](./preset-format-research.md):
  community RE of the III preset-save format (forum thread #159885
  archive).
- [`set-parameter-captures.md`](./set-parameter-captures.md): the 10
  public captures that locked the `fn=0x01` SET_PARAMETER envelope.

## See also

- [`../../AXEFX3-BETA-TESTING.md`](../../AXEFX3-BETA-TESTING.md):
  workflow for III owners testing the beta surface.
- [`../../research/fractal-protocol-decode-status.md`](../../research/fractal-protocol-decode-status.md):
  current decode coverage across all Fractal devices.
