# Moved: contribution guidance now lives in the product repo

Per-device contribution asks, testing guides, capture-tool setup and the
submission funnel moved to **`docs/contributing/`** in the
[mcp-midi-control](https://github.com/TheAndrewStaker/mcp-midi-control) repo.

Start at
[docs/contributing/README.md](https://github.com/TheAndrewStaker/mcp-midi-control/blob/main/docs/contributing/README.md),
which indexes every registered device, Fractal and otherwise.

They moved because they say "install this server", "run this command" and "file
an issue here", and this package is the standalone codec published to npm. Its
consumers are developers building on the wire format, not owners running the MCP
server.

Two files remain in this directory, because they are codec-domain reverse
engineering methods that a consumer of this package would reuse:

- [`juce-binarydata-extraction.md`](juce-binarydata-extraction.md)
- [`loopmidi-editor-emulation.md`](loopmidi-editor-emulation.md)

Wire maps, opcode tables and the primitives corpus are unaffected and still live
under `packages/fractal-midi/docs/`.
