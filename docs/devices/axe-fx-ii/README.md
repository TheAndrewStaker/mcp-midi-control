# Axe-Fx II — protocol + research

Fractal Axe-Fx II XL+ (model byte `0x07`). Hardware-verified on Quantum
8.02. Code lives in [`packages/axe-fx-ii/`](../../../packages/axe-fx-ii/).

## Files in this directory

- [`SYSEX-MAP.md`](./SYSEX-MAP.md) — Axe-Fx II wire-protocol reference.
  Family overview (model bytes 0x03 / 0x06 / 0x07 / 0x08), envelope,
  documented + undocumented function bytes, captured decodes.
- [`community-re-methodology.md`](./community-re-methodology.md) —
  survey of public-OSS Axe-Fx II RE projects (bspaulding, tysonlt,
  laxu) with license, staleness, and coverage notes. Background for
  the "build informed by, not depend on" decision (DECISIONS.md).
- [`component-catalog.md`](./component-catalog.md) — auto-generated
  catalog of Axe-Edit's `<EditorControl>` entries (block types,
  parameters, variant + page structure, applicability gates).
  Re-generate via `scripts/extract-axe-fx-ii-catalog.ts`.
- [`state-broadcast-decode-research.md`](./state-broadcast-decode-research.md)
  — decode of the `0x74` / `0x75` / `0x76` state-broadcast triple
  (read-side; HW-086 proved it's not bidirectional).

## See also

- [`../am4/SYSEX-MAP.md`](../am4/SYSEX-MAP.md) — many AM4 findings
  transfer to Axe-Fx II since both share the envelope + checksum.
- [`../../fractal-protocol-decode-status.md`](../../fractal-protocol-decode-status.md)
  — current decode coverage across all Fractal devices.
