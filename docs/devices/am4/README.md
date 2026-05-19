# AM4 — protocol + research

Fractal AM4 is the project's headline device — the deepest protocol
RE, the most hardware-verified, and the reference shape every other
device follows. Code lives in [`packages/am4/`](../../../packages/am4/).

## Files in this directory

- [`SYSEX-MAP.md`](./SYSEX-MAP.md) — authoritative AM4 wire-protocol
  reference. Envelope, checksum, function bytes, param addressing,
  per-block decodes, all with capture citations.
- [`0x01-stream-research.md`](./0x01-stream-research.md) — research on
  the undocumented `0x01` editor-stream function used by AM4-Edit.
- [`preset-binary-format-research.md`](./preset-binary-format-research.md)
  — research on the preset binary format (Huffman-compressed chunks).
- [`preset-dump-request-research.md`](./preset-dump-request-research.md)
  — host -> device dump-request envelope decode.
- [`preset-read-research.md`](./preset-read-research.md) —
  non-destructive stored-preset name reads (action `0x0012`).
- [`factory-restore-research.md`](./factory-restore-research.md) —
  factory bank file structure and replay-to-restore mechanism.

## See also

- [`../../BLOCK-PARAMS.md`](../../BLOCK-PARAMS.md) — AM4 block reference
  (catalog + Ghidra evidence). Cross-referenced from other devices.
- [`../../fractal-protocol-decode-status.md`](../../fractal-protocol-decode-status.md)
  — current decode coverage across all Fractal devices.
