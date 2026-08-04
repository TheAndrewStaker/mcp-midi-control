# `fractal-midi` documentation

Protocol RE, wire-shape decode notes, opcode tables, and Ghidra-mining
infrastructure for the Fractal Audio device family. These docs ship
with the codec because the wire vocabulary IS the codec's domain.
Consumers of `fractal-midi` need them to understand what bytes their
builders/parsers produce.

## Per-device wire maps

| Device | Folder |
|--------|--------|
| AM4 | [`devices/am4/`](devices/am4/) |
| Axe-Fx II XL+ | [`devices/axe-fx-ii/`](devices/axe-fx-ii/) |
| Axe-Fx III | [`devices/axe-fx-iii/`](devices/axe-fx-iii/) |
| Hydrasynth Explorer / KB / DR | [`devices/hydrasynth/`](devices/hydrasynth/) |

Each per-device folder typically contains:

- `README.md`: orientation: what's in this device's wire envelope, decode status, links to related research.
- `SYSEX-MAP.md`: authoritative wire-protocol reference. Envelope, checksum, function bytes, param addressing.
- `manuals/`: vendor PDFs (gitignored) plus extracted `.txt` for grep-ability.
- Research docs (preset-format, state-broadcast, fn-byte decodes, etc.): narrative writeups of how each protocol surface was figured out.

## Cross-device research

[`research/`](research/) holds methodology and status across devices:

- [`ghidra-mining-workflow.md`](research/ghidra-mining-workflow.md): how we extract protocol info from editor binaries.
- [`fractal-broadcast-vs-poll-research.md`](research/fractal-broadcast-vs-poll-research.md): which devices push state vs require polling.
- [`fractal-protocol-decode-status.md`](research/fractal-protocol-decode-status.md): per-device decode status table.

## Editor reverse-engineering methods

[`capture-guides/`](capture-guides/): codec-domain techniques for pulling wire
facts out of a Fractal editor when existing captures don't answer a question:

- [`juce-binarydata-extraction.md`](capture-guides/juce-binarydata-extraction.md): 5-minute label discovery from JUCE editor binaries.
- [`loopmidi-editor-emulation.md`](capture-guides/loopmidi-editor-emulation.md): driving an editor's own write path to observe its frames.

**Contributor-facing capture guidance moved to the product repo**, under
`docs/contributing/` in
[mcp-midi-control](https://github.com/TheAndrewStaker/mcp-midi-control): the
one-time sniffer setup, the Windows USBPcap workflow, the macOS MIDI Monitor
workflow, and one page per registered device naming what it needs. It lives
there because it says "install this server" and "file an issue here", which is
product-repo territory, not codec territory. See
[`capture-guides/README.md`](capture-guides/README.md).

## Cross-device manuals

[`manuals/`](manuals/): vendor docs that cover MULTIPLE devices:

- `Fractal-Audio-Blocks-Guide.{pdf,txt}`: the canonical block / param reference.
- `Fractal-Audio-Systems-MIMIC-(tm)-Technology.{pdf,txt}`: amp-modeling background.

## Ghidra scripts

[`../scripts/ghidra/`](../scripts/ghidra/) holds the GhidraScripts that
extract param tables, opcode names, dispatch handlers, etc. from each
device's editor binary. Each script has a companion `.cmd` launcher.
Output lands in `samples/captured/decoded/` (gitignored, local-only
research scratch).

## Reading order for a new contributor

1. Pick a device in `devices/<device>/`, read its `README.md`, then
   `SYSEX-MAP.md`.
2. Skim `research/fractal-protocol-decode-status.md` to learn what's
   wire-confirmed (🟢) vs still wiki-only (🟡).
3. If you want to mine new info, read
   `research/ghidra-mining-workflow.md` + try one of the existing
   `scripts/ghidra/*.cmd` launchers against your local Ghidra
   project.

## Audience

These docs target:

1. **`fractal-midi` consumers** writing custom Fractal tooling who
   need to understand the wire shapes the codec hides.
2. **Contributors** extending the codec to new devices or new
   opcodes.
3. **Reverse-engineering hobbyists** documenting Fractal's protocol
   for community benefit.

Not the target audience: end-user musicians (they consume tools built
on this library, not the library itself).
