# Manuals, local-only reference set

This directory holds **cross-device** vendor documentation (Fractal
Audio Blocks Guide, MIMIC technology whitepaper). Per-device manuals
live with the device under
[`docs/devices/<device>/manuals/`](../devices/).

## Who this directory is for

**Human contributors** setting up a local development environment. Copies
of the manuals stay on your machine after you clone; the project doesn't
redistribute the PDFs.

**Claude Code agents working in this repo** also rely on the `.txt`
extractions. When a contributor's agent is decoding a knob or naming a
parameter, the local extractions are grep-able and authoritative. Per
[`CLAUDE.md`](../../CLAUDE.md): check the local manuals before searching
the web. Most common questions are answered by one of these files.

The running MCP server does NOT read these manuals at runtime. End users
of the server never need to install them.

## License and redistribution

PDFs from Fractal Audio are copyrighted by Fractal Audio Systems. PDFs
from ASM (Hydrasynth) are copyrighted by Ashun Sound Machines. **None of
the PDFs are committed to the repo.**

The `.txt` extractions ARE committed. They're derivative reference
material used for interoperability research; treating them as fair-use
development assets makes the repo grep-able for both contributors and
Claude Code agents without forcing every clone to re-run `pdftotext`. If
a publisher objects to a specific extract, the policy is to drop that
file (the `.gitignore` entry for the PDF stays; only the `.txt` would be
removed).

Download each PDF from the publisher's site (links below) and drop it
in the correct location (this directory for cross-device manuals,
`docs/devices/<device>/manuals/` for per-device ones) so you can
re-generate the `.txt` if needed. Several scripts and docs expect these
exact filenames.

## Cross-device Fractal documentation (lives here)

Drop these in `docs/manuals/`. The PDF is gitignored; the `.txt`
extraction is committed. Generate the `.txt` once with `pdftotext`
after you download the PDF, then `git add` the `.txt` if it's new to
the repo.

| File | Source | What this project uses it for |
|------|--------|-------------------------------|
| `Fractal-Audio-Blocks-Guide.pdf` | [fractalaudio.com/downloads](https://www.fractalaudio.com/downloads/) (search "Blocks Guide") | Per-block parameter prose. Cross-device (AM4 / FM3 / FM9 / Axe-Fx III). Most-cited reference in the codebase. Feeds `npm run extract-param-descriptions`. |
| `Fractal-Audio-Systems-MIMIC-(tm)-Technology.pdf` | Fractal blog / downloads | Background on the speaker simulation technology. |

## Per-device manuals (live with the device)

Per-device manuals are co-located with the device's other docs at
[`docs/devices/<device>/manuals/`](../devices/). Each device folder has
its own README listing its expected manuals + download URLs.

| Device | Manuals folder |
|--------|----------------|
| Fractal AM4 | [`docs/devices/am4/manuals/`](../devices/am4/manuals/) |
| Fractal Axe-Fx II XL+ | [`docs/devices/axe-fx-ii/manuals/`](../devices/axe-fx-ii/manuals/) |
| Fractal Axe-Fx III | [`docs/devices/axe-fx-iii/manuals/`](../devices/axe-fx-iii/manuals/) |
| ASM Hydrasynth | [`docs/devices/hydrasynth/manuals/`](../devices/hydrasynth/manuals/) |

## Generating the `.txt` extractions

Most consumers in this repo (scripts, agents, doc cross-references)
expect the `.txt` form, not the PDF. Generate after each PDF download.
For cross-device manuals:

```bash
cd docs/manuals
pdftotext -layout "Fractal-Audio-Blocks-Guide.pdf" "Fractal-Audio-Blocks-Guide.txt"
pdftotext -layout "Fractal-Audio-Systems-MIMIC-(tm)-Technology.pdf" "Fractal-Audio-Systems-MIMIC-(tm)-Technology.txt"
```

For per-device manuals, run `pdftotext -layout` in the relevant
`docs/devices/<device>/manuals/` directory. Filenames inside each
per-device folder are documented in that folder's README.

On Windows, `pdftotext` ships with Poppler / MSYS2. Any equivalent
extractor that preserves layout works.

## How agents in this repo use these files

Claude Code agents working on this codebase grep the `.txt` files
directly. Common patterns:

- "What does `amp.bias_x` do on a triode amp?": `grep -B 2 -A 8 'bias_x' docs/manuals/Fractal-Audio-Blocks-Guide.txt`
- "What are the AM4's scene-vs-channel semantics?": read `docs/devices/am4/manuals/AM4-Owners-Manual.txt` sections on Scenes and Channels.
- "Does the III have per-scene block bypass like the II?": grep `docs/devices/axe-fx-iii/manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.txt`, fall back to forum captures if absent.

When an agent can't answer a knob-semantics question from the `.txt`
files, that's a real gap worth flagging to the maintainer. Don't burn
context WebFetching for things the local manuals already cover.

The Claude Project that hosts the conversational agent (the one that
talks to the running MCP server) has the Blocks Guide loaded as project
knowledge. End users of the server don't need any of these files
installed.

The running MCP server bundles a derived
`packages/core/src/protocol-generic/param-descriptions.json`: a
maintainer-time scrape of the Blocks Guide (plus the Owner's Manuals
where the regex catches more entries) keyed by (device, block, param).
The unified `list_params` and `get_param` tools surface the prose to
the agent on demand via the `include_descriptions` / `include_description`
flags. Regenerate with `npm run extract-param-descriptions`; the script
is idempotent so the regenerated file diffs cleanly.

## See also

- [`docs/REFERENCES.md`](../REFERENCES.md) lists which sections of each
  manual the codebase actively cites.
- [`docs/devices/am4/SYSEX-MAP.md`](../devices/am4/SYSEX-MAP.md),
  [`docs/devices/axe-fx-ii/SYSEX-MAP.md`](../devices/axe-fx-ii/SYSEX-MAP.md),
  [`docs/devices/axe-fx-iii/SYSEX-MAP.md`](../devices/axe-fx-iii/SYSEX-MAP.md),
  [`docs/devices/hydrasynth/SYSEX-MAP.md`](../devices/hydrasynth/SYSEX-MAP.md)
  are the authoritative wire-protocol references; the manuals fill in
  the semantic context behind the wire.
