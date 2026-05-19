# External References: MCP MIDI Control

Primary sources available locally or online, what they cover, and when to consult each.
Update this file whenever a new reference is added to the project.

---

## Per-device authoritative decode status (read first)

Before opening a new reverse-engineering investigation or proposing a
protocol change, consult these; they reflect what is currently
byte-verified vs. what is still open. Always more current than the
manuals.

- **`docs/fractal-protocol-decode-status.md`**: cross-device status
  index (AM4 / Axe-Fx II / Axe-Fx III). Last full sweep Session 82–83
  (Ghidra mining). Tells you which paramId families are named and
  which are still open per device.
- **`docs/SYSEX-MAP.md`**: AM4 wire map, byte-exact, with capture
  references for every confirmed claim.
- **`docs/SYSEX-MAP-AXE-FX-II.md`**: Axe-Fx II wire map.
- **`docs/SYSEX-MAP-AXE-FX-III.md`**: Axe-Fx III wire map (covers
  Fractal's v1.4 PDF + community RE).
- **`docs/ghidra-mining-workflow.md`**: proven canonical RE method
  for paramId catalog extraction (99% wire-accuracy verified). Read
  before opening a new Ghidra project on any Fractal editor binary.

---

## Official Fractal Audio documents (local)

All files below live in `docs/manuals/` unless noted. Plain-text `.txt` extractions
sit next to each PDF for grep-ability.

### `docs/manuals/AM4-Owners-Manual.pdf` (8.4 MB, extracted to `.txt`, 2956 lines)
Primary AM4 user manual from Fractal Audio. The authoritative source for:
- Hardware controls, footswitch functions, rear-panel I/O.
- Preset navigation model (A1–Z4, scenes, channels).
- Per-block parameter names as shown on the AM4 display; treat as **ground truth**
  for block-TYPE names and parameter labels when writing presets.
- Global setup menu (I/O, MIDI channel, noise gate, etc.).

### `docs/manuals/Fractal-Audio-Blocks-Guide.pdf` (3.7 MB, extracted to `.txt`, 4745 lines)
Deep per-block parameter reference covering the entire current Fractal product line
(Axe-Fx III / FM9 / FM3 / AM4 / VP4). Use when the AM4 owner's manual is too terse.
Contains:
- Full parameter lists for every effect block TYPE (e.g., every Delay type, every
  Reverb type) with parameter ranges and units.
- Channel/modifier/controller architecture.
- Is the correct source for "what does parameter X do" once you know the TYPE.

### `docs/manuals/Axe-Fx III MIDI for 3rd Party Devices.pdf` (220 KB, extracted to `AxeFx3-MIDI-3rdParty.txt`)
The only public SysEx protocol document from Fractal. AM4 is in the same family,
so this defines the "baseline" command set (bypass 0x0A, channel 0x0B, scene 0x0C,
patch/scene name query 0x0D/0x0E, status dump 0x13, tempo 0x14). **AM4 has been
empirically confirmed to follow this spec** (session 02, 2026-04-14) with AM4-specific
extensions above block ID 200 and an internal editor-streaming function `0x01`
not documented here. See `docs/SYSEX-MAP.md` for the AM4-resolved mapping.

### `samples/factory/README AM4+VP4 Presets Update Guide.pdf` (extracted alongside)
Short guide on using **Fractal-Bot** (the librarian built into AM4-Edit) to push
`.syx` files to the device. Confirms that `.syx` files are literal SysEx byte
streams (the same bytes sent over USB MIDI during upload) and that AM4/VP4
banks are handled differently from Axe-Fx III family banks.

### `samples/factory/AM4-Factory-Presets-1p01.syx` (1.28 MB)
Full AM4 factory preset bank as distributed by Fractal. Contains all 104 slots
worth of presets in a single `.syx` dump. Can be parsed the same way as
individual exports (header `0x77` / chunks `0x78` / footer `0x79`), multiplied
by the number of presets.

---

## Other-manufacturer manuals (local)

Docs for devices on the multi-device expansion roadmap (BK-014..BK-020).
All files live in `docs/manuals/other-gear/`. **PDFs are gitignored** for
copyright and size reasons; only the plain-text extractions are committed.
If you need the source PDF, obtain it from the manufacturer's downloads
page. Extract with `pdftotext -layout <file>.pdf <file>.txt` (ships with
Git for Windows).

### Fractal Audio: Axe-Fx II XL+ (BK-014)
Manuals added 2026-05-09 (Session 53), live at `docs/manuals/`:
- `Axe-Fx-II-Owners-Manual.{pdf,txt}`: primary user manual. Section
  17.3 has the MIDI Implementation Chart; Section 16.19 documents the
  read-only `SysEx ID = 00 01 74` constraint and per-device-byte
  defaults. Q7.0 firmware-era doc.
- `Axe-Fx-II-Scenes-Mini-Manual-1.02.{pdf,txt}`: confirms 8-scene
  capability count.
- `Axe-Fx-II-Tone-Match-Manual.{pdf,txt}`: Tone Match block (block
  ID 170 per the wiki).
- `Axe-Fx-II-ir-capture.{pdf,txt}`: IR capture / cab capture
  procedure. Adjacent to `MIDI_START_IR_DOWNLOAD` (function 0x7A) and
  related MIDI flow.
- `Axe-Fx_II_XL_MIDI_THRU_Guide.{pdf,txt}`: XL/XL+ MIDI THRU jack
  routing rules.
- `Fractal-Audio-Systems-MIMIC-(tm)-Technology.{pdf,txt}`:
  cab-modeling whitepaper.
- **No dedicated Axe-Fx II SysEx implementation chart published.**
  Fractal didn't release one for the II line (only the III+ family
  got `Axe-Fx III MIDI for 3rd Party Devices.pdf`). For Axe-Fx II
  protocol, the canonical source is the wiki MIDI_SysEx page below.

### Fractal factory bank exports (BK-014, founder hardware)
Live at `samples/factory/` (gitignored). Founder's Axe-Fx II XL+ at
firmware Quantum 8.02:
- `Axe-Fx-II_XL+_Bank-{A,B,C}_Q8p02.syx`: 1.6 MB each, 128 presets
  per bank. Used Session 53 to wire-confirm model byte `0x07`,
  envelope `00 01 74`, XOR-and-0x7F checksum, and the 1+64+1
  message-per-preset shape (vs AM4's 1+4+1). See
  `docs/SYSEX-MAP-AXE-FX-II.md` §6.
- `Axe-Fx-II-XL+_All-Banks_Q8p02.syx`: all three banks concatenated
  (4.8 MB).

### Roland SPD-SX (BK-019)
- `SPD-SX_OM.txt`: Owner's Manual. Primary reference. **Key sections for
  BK-019:** USB save/load (pp. 65–66), USB MODE switch (p. 63),
  documented MIDI surface (pp. 67–68).
- `SPD-SX_Wave_Manager_e02.txt`: "Using SPD-SX Wave Manager" guide.
  Doesn't contain the USB protocol, but documents every operation Wave
  Manager performs on kit/wave data; serves as the **feature spec** for
  the flash-drive-based MCP approach chosen in BK-019.
- `SPD-SX_EffectGuide.txt`: Master + Kit effect parameter reference.
  Needed when BK-019 extends from kit-structure editing to per-effect
  parameter editing.
- `SPD-SX_PA.txt`: Sound List (Factory Data v1.01). 210 factory wave
  names. Useful when the agent references waves by name while assigning
  them to kits.
- **No MIDI Implementation Chart exists.** Roland publishes only four
  SPD-SX docs (OM, Wave Manager, Effect Guide, Sound List); no separate
  MIDI Impl PDF, unlike JD-Xi / VE-500. Documented MIDI surface is thin
  (Program Change, Control Change, Note on/off only). This is why
  BK-019's feature scope goes through the USB flash drive path.

### Roland JD-Xi (BK-020)
- `JD-Xi_MIDI_Implementation.txt`: full MIDI Implementation Chart.
  Primary reference for BK-020; complete address table + parameter
  ranges + tone-category enums.

### Boss VE-500 (BK-018)
- `VE-500_MIDI_ImpleChart.txt`: MIDI Implementation Chart. Confirms the
  SysEx address map is **closed** ("Specifications of System Exclusive
  message is not opened for users"), so deep editing requires
  capture-based RE of Boss Tone Studio; the CC + Program Change surface
  is what's available out of the box. See BK-018 for scope implications.

### Boss RC-505 MKII (BK-017)
*No manuals local yet.* Add the RC-505 MKII MIDI Implementation PDF
from boss.info when BK-017 activates.

---

## Community sources (online, not local)

### Fractal Audio Wiki: `https://wiki.fractalaudio.com/wiki/index.php`
Scraped copy lives in `docs/wiki/` (gitignored; regenerate via
`npm run scrape-wiki -- P0` for block params, `P1` for protocol pages).
- `MIDI_SysEx` page: main source. Documents the COMPLETE Axe-Fx II /
  AX8 SysEx surface (function IDs 0x01..0x7C, per-block parameter ID
  tables for every block group, modifier semantics, IR-load protocol,
  preset numbering for XL/XL+ ranges 0..767). For AM4 the same page
  documents only the 5 mode-switch commands (function 0x12). Cached
  copy of the full HTML at
  `docs/_private/wiki-cache/axe-fx-ii-midi-sysex.html` (gitignored).
- Block pages (`Amp_block.md`, `Delay_block.md`, etc.): community parameter
  notes, often matching the Blocks Guide PDF.

### Fractal Audio Gen1 Wiki: `https://wiki.fractalaudio.com/gen1/index.php`
**Separate MediaWiki instance** for original Axe-Fx Standard / Ultra
(model bytes 0x00 / 0x01), direct ancestors to the Axe-Fx II family.
Useful for understanding the function-ID space evolution and the
8-bit-vs-16-bit parameter-value migration. Not covered by the existing
`scrape-wiki.ts` which targets `wiki.fractalaudio.com/wiki/` only.
- `Axe-Fx_SysEx_Documentation` page: Standard / Ultra protocol spec.
  Cached at `docs/_private/wiki-cache/axe-fx-gen1-sysex-documentation.html`
  (gitignored). The wiki disclaims SysEx info is "printed here with
  the permission of Fractal Audio", an authoritative source.

### Fractal Audio Forum: `https://forum.fractalaudio.com`
Active community. Useful search terms:
- "AM4 sysex": user experiments and findings.
- "preset format": reverse-engineering discussions (mostly Axe-Fx III, some apply).
- "3rd party MIDI": expected usage and gotchas.

### Axe-Fx II community libraries
A detailed scan of the open-source community RE projects (bspaulding,
tysonlt, laxu) with license / staleness / coverage notes lives in
**`docs/axe-fx-ii-community-re-methodology.md`**. That doc is the
canonical inventory; don't duplicate the per-library breakdown here.

### Axe-Fx III preset-format reverse-engineering
Community projects that have partially reverse-engineered the Axe-Fx III preset
binary are potential cross-references for AM4 (same family, similar format):
- Not formally indexed here; search `github.com` for `axefx3` / `fractal preset parser`.
- Fractal Forum thread #159885 archived at `docs/_private/fractal-forum-text.txt`.

---

## Our own generated references

### `docs/BLOCK-PARAMS.md`
Committed working reference for AM4 block types and their available effect TYPEs.
Distilled from the wiki scrape + AM4 owner's manual. First stop when building a
preset IR.

### `docs/SYSEX-MAP.md`
Working SysEx protocol reference, AM4-resolved. Updated after every sniff/probe
session. First stop when encoding a message to send.

### `docs/_private/SESSIONS.md` (gitignored)
Chronological log of every reverse-engineering session with raw captures and
decoded findings. Use to understand how a claim in SYSEX-MAP became confirmed.
Local-only; operational scratch under `docs/_private/`.

### `packages/core/src/fractal-shared/lineage/*-lineage.json`
Model lineage dictionaries generated from the wiki scrape + Blocks Guide PDF
by `scripts/extract-lineage.ts` and `scripts/extract-axe-fx-ii-lineage.ts`.
One file per block (amp/drive/reverb/delay/cab/chorus/flanger/phaser/wah/
compressor) for AM4, plus `axefx2-*-lineage.json` for Axe-Fx II. Each record
carries the device-canonical name (e.g. `am4Name`), `inspiredBy` (with
`source` tag), `description`, `fractalQuotes`, and block-specific metadata
(family/powerTubes/matchingDynaCab for amps; categories/clipTypes for
drives; creator prefix for cabs). Re-run via `npm run extract-lineage` /
`npm run extract-axe-fx-ii-lineage` (or `npm run regen` for the full set)
whenever the wiki scrape is refreshed. The build also copies these files
into `packages/core/dist/fractal-shared/lineage/` via
`scripts/copy-build-assets.ts`.

Provenance policy: only Fractal-authored content is captured (Blocks Guide
entries, wiki parentheticals, forum quotes attributed `[Fractal Audio]`).
Brand-authored quotes (Xotic, JHS, Macari's) and community-inferred
qualitative tags (genre, era, mood adjectives) are deliberately omitted to
avoid hallucination risk; any record without a Fractal source has its
field populated via `flags: ['VERIFY: ...']` and no `inspiredBy`.

### `docs/DECISIONS.md`
Architectural and scope decisions with rationale. Read before proposing changes
to: MIDI library choice, module system, distribution model, MVP scope, or
write-safety protocol.

---

## How to use this file

- Before searching the web, check whether a local manual covers the question:
  `grep -l <term> docs/manuals/*.txt` is fast and precise.
- When adding a new PDF or external reference to the project, add a section to
  this file so future Claude Code sessions discover it without rescanning.
- Prefer the AM4 owner's manual over the Blocks Guide when they disagree on
  AM4-specific behavior; the Blocks Guide covers the whole product line and
  may describe features not present on AM4.
