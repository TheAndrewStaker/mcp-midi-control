# Manuals — local-only reference set

This directory holds copies of Fractal Audio's official documentation and
a handful of third-party manuals (Hydrasynth). The project consults these
during reverse-engineering work, design decisions about block / scene /
parameter semantics, and when authoring user-facing tool descriptions.

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

The `.txt` extractions ARE committed (both top-level Fractal docs and
the `other-gear/` set). They're derivative reference material used for
interoperability research; treating them as fair-use development assets
makes the repo grep-able for both contributors and Claude Code agents
without forcing every clone to re-run `pdftotext`. If a publisher
objects to a specific extract, the policy is to drop that file (the
`.gitignore` entry for the PDF stays; only the `.txt` would be
removed).

Download each PDF from the publisher's site (links below) and drop it in
the named location so you can re-generate the `.txt` if needed. Several
scripts and docs expect these exact filenames.

## Fractal Audio manuals

Drop these in `docs/manuals/`. The PDF is gitignored; the `.txt`
extraction is committed. Generate the `.txt` once with `pdftotext`
after you download the PDF, then `git add` the `.txt` if it's new to
the repo.

| File | Source | What this project uses it for |
|------|--------|-------------------------------|
| `AM4-Owners-Manual.pdf` | [fractalaudio.com/am4-downloads](https://www.fractalaudio.com/am4-downloads/) | AM4 block roster, scene/channel semantics, factory layout |
| `Axe-Fx-II-Owners-Manual.pdf` | [fractalaudio.com/axe-fx-ii-downloads](https://www.fractalaudio.com/axe-fx-ii-downloads/) | Axe-Fx II block roster, grid behavior, preset model |
| `Axe-Fx-II-Scenes-Mini-Manual-1.02.pdf` | same source | Scene model on Axe-Fx II (per-scene state: channel + bypass) |
| `Axe-Fx-II-Tone-Match-Manual.pdf` | same source | Tone Match block semantics |
| `Axe-Fx-II-ir-capture.pdf` | same source | IR capture workflow |
| `Axe-Fx_II_XL_MIDI_THRU_Guide.pdf` | same source | MIDI Thru on the XL+ specifically |
| `Axe-Fx III MIDI for 3rd Party Devices.pdf` | [fractalaudio.com/downloads/misc](https://www.fractalaudio.com/downloads/misc/Axe-Fx%20III%20MIDI%20for%203rd%20Party%20Devices.pdf) | Axe-Fx III MIDI wire surface. The public protocol spec |
| `Axe-Fx-III-Owners-Manual.pdf` | [fractalaudio.com/axe-fx-iii-downloads](https://www.fractalaudio.com/axe-fx-iii-downloads/) | III block roster, scene model, footswitch logic. Complements the third-party MIDI spec (which covers wire only) |
| `Fractal-Audio-Blocks-Guide.pdf` | [fractalaudio.com/downloads](https://www.fractalaudio.com/downloads/) (search "Blocks Guide") | Per-block parameter prose. Cross-device (AM4 / FM3 / FM9 / Axe-Fx III). Most-cited reference in the codebase |
| `Fractal-Audio-Systems-MIMIC-(tm)-Technology.pdf` | Fractal blog / downloads | Background on the speaker simulation technology |

## Other-manufacturer manuals (`other-gear/`)

Short `.txt` extractions of relevant third-party device manuals. PDFs are
gitignored; `.txt` files are committed.

| File | What this project uses it for |
|------|-------------------------------|
| `Hydrasynth_Explorer_Owners_Manual_2.2.0.txt` | Hydrasynth NRPN catalog, system CC layout, voice architecture |
| `Hydrasynth_KB_DR_Owners_Manual_2.2.0.pdf` (PDF only) | Keyboard / Desktop / Deluxe manual. Same engine; used to confirm portability of the Hydrasynth tool surface across the line |
| `Hydrasynth_Single_Factory_Patch_Listing_2.0.xlsx` | Factory patch names for the discovery flow |

## Generating the `.txt` extractions

Most consumers in this repo (scripts, agents, doc cross-references)
expect the `.txt` form, not the PDF. Generate after each PDF download:

```bash
cd docs/manuals
pdftotext -layout "AM4-Owners-Manual.pdf" "AM4-Owners-Manual.txt"
pdftotext -layout "Fractal-Audio-Blocks-Guide.pdf" "Fractal-Audio-Blocks-Guide.txt"
pdftotext -layout "Axe-Fx III MIDI for 3rd Party Devices.pdf" "AxeFx3-MIDI-3rdParty.txt"
pdftotext -layout "Axe-Fx-II-Owners-Manual.pdf" "Axe-Fx-II-Owners-Manual.txt"
# repeat for each PDF you downloaded
```

On Windows, `pdftotext` ships with Poppler / MSYS2. Any equivalent
extractor that preserves layout works.

## How agents in this repo use these files

Claude Code agents working on this codebase grep the `.txt` files
directly. Common patterns:

- "What does `amp.bias_x` do on a triode amp?" -> `grep -B 2 -A 8 'bias_x' Fractal-Audio-Blocks-Guide.txt`
- "What are the AM4's scene-vs-channel semantics?" -> read `AM4-Owners-Manual.txt` sections on Scenes and Channels.
- "Does the III have per-scene block bypass like the II?" -> grep the III spec, fall back to forum captures if absent.

When an agent can't answer a knob-semantics question from the `.txt`
files, that's a real gap worth flagging to the maintainer. Don't burn
context WebFetching for things the local manuals already cover.

The Claude Project that hosts the conversational agent (the one that
talks to the running MCP server) has the Blocks Guide loaded as project
knowledge. End users of the server don't need any of these files
installed.

## See also

- [`docs/REFERENCES.md`](../REFERENCES.md) lists which sections of each
  manual the codebase actively cites.
- [`docs/SYSEX-MAP.md`](../SYSEX-MAP.md), [`docs/SYSEX-MAP-AXE-FX-II.md`](../SYSEX-MAP-AXE-FX-II.md),
  and [`docs/SYSEX-MAP-AXE-FX-III.md`](../SYSEX-MAP-AXE-FX-III.md) are
  the authoritative wire-protocol references; the manuals fill in the
  semantic context behind the wire.
