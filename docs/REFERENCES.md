# External References: MCP MIDI Control

Primary sources available locally or online, what they cover, and when to consult each.
Update this file whenever a new reference is added to the project.

---

## Per-device authoritative decode status (read first)

Before opening a new reverse-engineering investigation or proposing a
protocol change, consult these; they reflect what is currently
byte-verified vs. what is still open. Always more current than the
manuals.

- **`docs/research/fractal-protocol-decode-status.md`**: cross-device status
  index (AM4 / Axe-Fx II / Axe-Fx III). Tells you which paramId
  families are named and which are still open per device.
- **`packages/fractal-midi/docs/devices/am4/SYSEX-MAP.md`**: AM4 wire
  map, byte-exact, with capture references for every confirmed claim.
- **`packages/fractal-midi/docs/devices/axe-fx-ii/SYSEX-MAP.md`**:
  Axe-Fx II wire map.
- **`packages/fractal-midi/docs/devices/axe-fx-iii/SYSEX-MAP.md`**:
  Axe-Fx III wire map (covers Fractal's v1.4 PDF + community RE).
- **`packages/fractal-midi/docs/devices/hydrasynth/SYSEX-MAP.md`**:
  Hydrasynth wire map.
- **`docs/research/ghidra-mining-workflow.md`**: proven canonical RE method
  for paramId catalog extraction (99% wire-accuracy verified). Read
  before opening a new Ghidra project on any Fractal editor binary.

---

## Official Fractal Audio documents (local)

Cross-device Fractal documents live in `docs/manuals/`. Per-device
manuals (AM4, Axe-Fx II, Axe-Fx III, Hydrasynth) live under
`packages/fractal-midi/docs/devices/<device>/manuals/` (in the codec
package). Plain-text `.txt` extractions sit next to each PDF for
grep-ability.

### `packages/fractal-midi/docs/devices/am4/manuals/AM4-Owners-Manual.pdf` (8.4 MB, extracted to `.txt`, 2956 lines)
Primary AM4 user manual from Fractal Audio. The authoritative source for:
- Hardware controls, footswitch functions, rear-panel I/O.
- Preset navigation model (A1 to Z4, scenes, channels).
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

### `packages/fractal-midi/docs/devices/axe-fx-iii/manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.pdf` (220 KB, extracted to `Axe-Fx-III-MIDI-for-3rd-Party-Devices.txt`)
The only public SysEx protocol document from Fractal. AM4 is in the same family,
so this defines the "baseline" command set (bypass 0x0A, channel 0x0B, scene 0x0C,
patch/scene name query 0x0D/0x0E, status dump 0x13, tempo 0x14). **AM4 has been
empirically confirmed to follow this spec** (2026-04-14) with AM4-specific
extensions above block ID 200 and an internal editor-streaming function `0x01`
not documented here. See `packages/fractal-midi/docs/devices/am4/SYSEX-MAP.md` for the AM4-resolved mapping.

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

Docs for devices on the multi-device expansion roadmap (Axe-Fx II,
Axe-Fx III, FM3, FM9, VP4).
Per-device manuals live under
`packages/fractal-midi/docs/devices/<device>/manuals/` (in the codec
package); cross-device docs (Blocks Guide, MIMIC whitepaper) live in
`docs/manuals/`. **PDFs are gitignored** for copyright and size
reasons; only the plain-text extractions are committed.
If you need the source PDF, obtain it from the manufacturer's downloads
page. Extract with `pdftotext -layout <file>.pdf <file>.txt` (ships with
Git for Windows).

### Fractal Audio: Axe-Fx II XL+
Manuals added 2026-05-09, live at
`packages/fractal-midi/docs/devices/axe-fx-ii/manuals/` (in the codec
package; the cross-device MIMIC whitepaper still lives at
`docs/manuals/`):
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
  got `Axe-Fx-III-MIDI-for-3rd-Party-Devices.pdf`). For Axe-Fx II
  protocol, the canonical source is the wiki MIDI_SysEx page below.

### Fractal factory bank exports (founder hardware)
Live at `samples/factory/` (gitignored). Captured from an Axe-Fx II XL+
at firmware Quantum 8.02:
- `Axe-Fx-II_XL+_Bank-{A,B,C}_Q8p02.syx`: 1.6 MB each, 128 presets
  per bank. Wire-confirm model byte `0x07`, envelope
  `00 01 74`, XOR-and-0x7F checksum, and the 1+64+1 message-per-preset
  shape (vs AM4's 1+4+1). See
  `packages/fractal-midi/docs/devices/axe-fx-ii/SYSEX-MAP.md` §6.
- `Axe-Fx-II-XL+_All-Banks_Q8p02.syx`: all three banks concatenated
  (4.8 MB).

### Roland / Boss devices

**Boss VE-500 Vocal Performer: supported (hardware-verified).** The first Roland
address-based SysEx codec in the tree. Wire layer lives in the `roland-midi`
package (`packages/roland-midi/`): shared DT1/RQ1 + Roland checksum + 7-bit
address + value packing in `src/shared/`, and the VE-500 catalog + builders in
`src/ve-500/`. The descriptor is `@mcp-midi-control/ve-500`. Protocol reference:
[`packages/roland-midi/docs/devices/ve-500/SYSEX-MAP.md`](../packages/roland-midi/docs/devices/ve-500/SYSEX-MAP.md).
The address map was decoded from the BOSS VE-500 Editor's own JavaScript (its
published SysEx spec is "not opened for users"); the catalog is generated by
`scripts/generate-ve500-catalog.ts`. The editor extract + Parameter Guide / Owner's
Manual `.txt` are maintainer-private (gitignored) under
`docs/_private/devices/ve-500/`.

**Boss RC-505mk2 Loop Station: supported (community beta, hybrid transport).**
Shipped as the `@mcp-midi-control/boss-rc` package: a hybrid descriptor with a
live USB-MIDI surface (memory recall via Program Change on the RX CTL channel,
looper/track control via CC through the memory's ASSIGN table) plus a USB
mass-storage surface that reads and authors the device's `.RC0` memory files.
The whole path is hardware-confirmed end-to-end (a CC-driven scene ping-pong
authored into a memory started and stopped looper tracks on the unit). The
`.RC0` codec and the RC-505mk2 field dictionary live in `packages/boss-rc/src/`
(`codec/rc0.ts` + `codec/mk2.ts`); the maintainer's Parameter Guide extract and
decode notes are gitignored local scratch.
Key decoded facts: the RC-505mk2 has **NO address SysEx** (nothing like Roland
DT1/RQ1; there is no read/verify path over MIDI), so live control is
generic-MIDI-tier, NOT a `roland-midi` codec addition. All live control is CC /
PC / MIDI clock / note, routed through the on-device **ASSIGN** system (16
SOURCE->TARGET slots per memory; a SOURCE can be `MIDI CC#01-31` / `#64-95`, and
the CC->target mapping is **user-configured per memory, not a factory chart**).
Memory switch is PC on the RX CTL channel; tempo slaves to MIDI clock; the RX
VOICE channel takes rhythm / HARMONIST / VOCODER notes. Its stored config (the
ASSIGN + CTL menus, INPUT/TRACK FX type+params, per-track record behavior,
MIDI/routing/output system settings) has **no MIDI write path** and is reachable
only via the **USB STORAGE (`STORAGE: CONNECT`) file transport** (memory files on
the mounted drive), the same pattern as the SPD-SX.

**Storage-file format is de-risked prior art (researched 2026-07-04): the memories
are plain-text XML, NOT a binary blob.** A backup is the whole `ROLAND/` folder:
`ROLAND/DATA/*.RC0` (memories + system settings, XML) + `ROLAND/WAVE/*.wav` (loop
audio). The `.RC0` grammar is `<database name="RC-..." revision><mem id=N><NAME>
(chars as C01..C12 int codes) <TRACK1..n> <MASTER> <RHYTHM> input/track FX
<ASSIGN1..N> <sys></database>`, all params as integer text nodes, with a possible
trailing checksum after `</database>` that editors strip and the device tolerates.
The RC-505mk2 shares this format with the RC-600 (one closed editor, rc600editor.com,
edits both). Two MIT-licensed sibling parsers are safe to DERIVE from (not vendor):
- **paulelong/RCEditor** (C#, MIT, RC-600 = the mk2's direct generational twin, most
  complete read+write): https://github.com/paulelong/RCEditor
- **dfleury2/boss-rc500-editor** (C++, MIT, RC-500, clean XML round-trip + schema
  templates under `resources/templates/`): https://github.com/dfleury2/boss-rc500-editor
- westlicht/rc505-editor (GPLv3, RC-505 **mk1**) is REFERENCE-ONLY (GPL, do not
  vendor, same rule as the bouncer): https://github.com/westlicht/rc505-editor

So the container grammar transfers for free; what stays mk2-specific (track count = 5
vs RC-600's 6, ASSIGN slot count, effect roster + source/target enum ordinals) is
pinned by ONE real mk2 `MEMORY.RC0`, obtained as a plain file copy in USB STORAGE
mode (`MENU > USB > STORAGE: CONNECT`), NOT a MIDI/hardware capture. No official
BOSS editor exposes settings (Tone Studio for RC = WAV loops only; RC Rhythm
Converter = audio->rhythm only) and there is no fixed MIDI Implementation chart /
SysEx. The mk2-specific field dictionary and enum ordinals that pin the format
live in `packages/boss-rc/src/codec/mk2.ts`.

**Other Tier 2 Roland / Boss devices (parked):** SPD-SX (shipped,
storage transport), JD-Xi. The `roland-midi/shared` primitives are the reuse seed
for the rest of the family. See
[`docs/MULTI-DEVICE-ROADMAP.md`](MULTI-DEVICE-ROADMAP.md) Tier 2 for per-device scope.

**Boss GT-1000 / GT-1000CORE, GX-100, SY-1000: researched, not yet built (2026-07-09).**
Unlike the VE-500, Roland publishes full SysEx address maps for all three (DT1/RQ1,
same family as the VE-500's decoded codec): GT-1000 model ID `00 00 00 4F`, GX-100,
and SY-1000 (by far the largest address space of the three, matching its deeper
per-part synth-guitar engine). Raw manuals (gitignored, local only, same pattern as
the SPD-SX / RC-505mk2 / Circuit Tracks manuals below) staged at
`docs/manuals/other-gear/`: `GT-1000-MIDI-Implementation.{pdf,txt}` (`gt1000.txt`),
`GX-100_MIDI_Implementation.{pdf,txt}` (`gx100.txt`), `SY-1000_MIDI_Implementation.{pdf,txt}`
(`sy1000.txt`). Full findings, the proposed one-codec/four-config shape, and the
adjacent Katana Gen 3 (community BTS-JS-extract oracle, much larger install base)
and deprioritization notes (Quad Cortex, Elektron) live in
`docs/_private/BOSS-GT-CODEC-RESEARCH-2026-07-09.md`. Backlog entry: see `BACKLOG.md`
Theme 3.

---

## Community sources (online, not local)

### Fractal Audio Wiki: `https://wiki.fractalaudio.com/wiki/index.php`
Scraped copy lives in `docs/wiki/` (gitignored; regenerate via
`npm run scrape-wiki -- P0` for block params, `P1` for protocol pages).
- `MIDI_SysEx` page: main source. Documents the COMPLETE Axe-Fx II /
  AX8 SysEx surface (function IDs 0x01..0x7C, per-block parameter ID
  tables for every block group, modifier semantics, IR-load protocol,
  preset numbering for XL/XL+ ranges 0..767). For AM4 the same page
  documents only the 5 mode-switch commands (function 0x12).
- Block pages (`Amp_block.md`, `Delay_block.md`, etc.): community parameter
  notes, often matching the Blocks Guide PDF.

### Fractal Audio Gen1 Wiki: `https://wiki.fractalaudio.com/gen1/index.php`
**Separate MediaWiki instance** for original Axe-Fx Standard / Ultra
(model bytes 0x00 / 0x01), direct ancestors to the Axe-Fx II family.
- `Axe-Fx_SysEx_Documentation` page: the Standard / Ultra protocol spec,
  "printed here with the permission of Fractal Audio" (authoritative).
  **HARVESTED 2026-06-06** to `docs/manuals/AxeFx-gen1-SysEx-Spec-wiki.wikitext.txt`.
  This is the FULLER doc that documents the bidirectional protocol the narrow
  "Ultra System Exclusive Messages" param-set PDF omits: function 0x02 carries a
  query(0)/set(1) flag (→ MIDI_PARAM_VALUE with value + label), plus MIDI_GET_PATCH
  0x03 → MIDI_PATCH_DUMP 0x04, get-firmware 0x08, get-preset-name 0x0f. The page
  had been catalogued here for sessions but never pulled, so gen-1 was built
  set-only from the PDF until the read path was decoded from this page.
- `AxeFxSysExTable` is a redirect to `Axe-Fx_SysEx_Documentation` (no separate table).

**Complete enumeration (don't re-discover pages one at a time):** run
`npx tsx scripts/_research/scrape-fractal-wiki.ts`; it walks the MediaWiki
`list=allpages` API across BOTH wiki instances, filters the gift-card spam (620
of the gen1 wiki's 1040 pages are spam), and flags protocol-relevant titles.
Full title lists land in `samples/wiki-inventory/`. As of 2026-06-06 the gen1
wiki's 420 real pages contain exactly ONE wire-protocol spec (the page above);
every other MIDI/SysEx-named page is user-facing (CC charts, dump tutorials,
modifier-usage, setup guides), confirmed to carry no wire bytes.

### Fractal Audio Forum: `https://forum.fractalaudio.com`
Active community. Useful search terms:
- "AM4 sysex": user experiments and findings.
- "preset format": reverse-engineering discussions (mostly Axe-Fx III, some apply).
- "3rd party MIDI": expected usage and gotchas.

### USB enumeration per device (settled 2026-06-11, cited research)
Which Fractal devices are USB-MIDI class-compliant vs serial: the answer to
every "does it work on Mac / why is the FM3 invisible to MIDI apps" question:
- **Fractal support KB, "Mac OS Audio MIDI Setup Utility"**
  (`https://support.fractalaudio.com/en-US/mac-os-audio-midi-setup-utility-286553`):
  states the III and FM9 appear in MIDI Studio and the FM3 does not ("this is
  normal"). The single most authoritative per-device Mac statement.
- **Fractal wiki `USB` and `MIDI` pages**: FM3 "is NOT a USB MIDI Device …
  uses 'COM over USB' channels"; III/FM9 have the dedicated USB processor and
  true MIDI-over-USB; VP4 "appears as MIDI ports in a DAW" (staff quote).
- **FM3 downloads page**: Windows needs TWO drivers, audio + the "FM3 USB
  Serial Driver" (virtual COM port; that's the editor/Fractal-Bot channel).
- **Linux ground truth**: FM3 enumerates as `/dev/ttyACM0` (CDC-ACM); the
  Axe-Fx III is `2466:8010` in mainline `sound/usb/quirks.c` (pure
  audio+MIDI class, no serial).
Net: every Fractal device here is CoreMIDI-reachable on macOS except the FM3,
which is serial on every OS, hence the FM3 serial transport in
`packages/core/src/midi/serialTransport.ts`.

### Axe-Fx II community libraries
A detailed scan of the open-source community RE projects, with license,
staleness, and coverage notes, lives in
**`packages/fractal-midi/docs/devices/axe-fx-ii/community-re-methodology.md`**
(in the codec package). That doc is the canonical inventory; don't
duplicate the per-library breakdown here.

### Axe-Fx III preset-format reverse-engineering
Community projects that have partially reverse-engineered the Axe-Fx III preset
binary are potential cross-references for AM4 (same family, similar format):
- Not formally indexed here; search `github.com` for `axefx3` / `fractal preset parser`.
- Fractal Forum thread #159885 on `forum.fractalaudio.com`.

### Competitive landscape: other public Fractal decoders (2026-06-27 survey)
A fan-out research pass mapped every public project that touches the Fractal
protocol, to confirm whether any rivals this project's codec (`fractal-midi`)
on **preset-binary decode depth** (the routing grid, the Huffman-compressed
gen-3 patch body, the CRC, the deepest, hardest layer). The verdict: **none
do.** The only cross-generation preset-binary decoder, FracTool, is closed
donationware forbidden for commercial use, so it is not a buildable
"source of truth" anyone can migrate to. Every *open* public project is
strictly narrower than our codec: either command-only (sends SysEx
commands, never parses the stored preset) or a name catalog. Recorded here
so future sessions don't re-survey:

- **`github.com/sKuhLight/ForgeFX`**: C#/.NET 10, ASP.NET Core HTTP API +
  OpenAPI + Docker. FM3-focused (FM9/III planned). Its `Fm3PresetCodec` is,
  by its own README, an *independent C# reimplementation* of the gen-3 dump
  framing / Huffman patch body / grid layout it credits to **this project**
  and to `fractal-syx-codec`. A downstream consumer/repackager of our decode
  work for a server audience, **not** an independent decode. The new C#
  entrant that prompted this survey.
- **`github.com/tysonlt/AxeFxControl`**: C++/Arduino, **GPL-3.0**, ~34★, last
  commit Oct 2023. Complete implementation of Fractal's *published* gen-3
  3rd-party MIDI **command** spec (preset/scene change, bypass, status dump,
  tuner, looper, tempo) for the III (tested) and FM3 (flag). **Does NOT touch
  the preset binary, Huffman body, CRC, or routing grid.** This is the same
  repo characterized (anonymized as the "Arduino read/navigate library
  (GPL-3.0)") in the codec package's
  [`community-re-methodology.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/axe-fx-ii/community-re-methodology.md);
  GPL-3.0 means it is read-only-reference for our Apache-2.0 tree, no code lift.
- **`github.com/rinkashimikito/ampdex`**: React 19 / TypeScript / Vite,
  **MIT**, ~0★, last push 2026-05. Searchable UI over the 331 gen-3 amp-model
  names (III/FM9/FM3), wrapping Clayton Welch's *Amplifier Library Guide*. Amp
  **names only**, decodes no SysEx, no preset binary, no grid. A tone-discovery
  catalog, not a protocol decoder.
- **FracTool** and **FracPad III** (forum member AlGrenadine; `archive.axefx.fr`
  / mobile app stores, **not** on GitHub): closed-binary, **donationware,
  commercial use forbidden**. FracTool parses gen-2 *and* gen-3 preset `.syx`
  offline (blocks, controllers, modifiers, per-scene/X-Y), exports CSV/XML/PDF,
  and cross-converts II/XL/XL+/AX8/FX8/FM3 → III/FM9 (v3.85, actively maintained
  as of Nov 2024); FracPad III is a full Axe-Edit alternative that decodes *and*
  authors. These two are the deepest non-our decoders in existence, but both are
  closed and legally unusable as a base. Tracked (anonymized) in the methodology doc.
- **Forum RE fragments** (not repos): gen-2/gen-3 `.syx` framing
  (`0x77`/`0x78`/`0x79` header/chunk/footer), septet/7-bit name packing, and an
  undocumented gen-3 system-backup SysEx (`0x51`/`0x52`/`0x53`, single-source,
  medium confidence) live in forum threads #60098, #159885, #201663: raw
  evidence, not maintainable codebases.

**Broader open-source roster (all shallower than `fractal-midi`; surveyed
2026-06-27, none parse the full stored patch):**
- **`github.com/vangrieg/Midi-SysEx-MCPServer`**: *another MCP server* doing
  III/FM RE, but LLM-assisted notes only: block layout partly mapped, most
  params still `❓`. Not a working decoder. **The closest thing to a same-niche
  competitor; worth periodic re-checking** in case it matures.
- **`github.com/ctrowat/fractal-preset-sysex`** (+ `-parser`): docs + TS that
  document `0x77`/`0x78`/`0x79` framing and split a `.syx` into chunks; author's
  own note says "much decoding to do here." Framing only, **not** a decoder.
- **`github.com/bspaulding/axe-fx-midi`**: Rust (MIT, ~1.8k dl), decodes the
  **live** grid/flags from a device query response (fn `0x20`), not stored files.
  This is the anonymized "Rust read/navigate crate" in the methodology doc.
- **`github.com/laxu/AxeFx2VirtualPedalboard`**: TS (MIT), CC→SET_PARAM live
  translator (II/AX8). The anonymized "TypeScript SET_PARAM project" in the
  methodology doc; first open `0x02` SET_PARAM prior art on the II.
- **`github.com/JamesDunne/axefx-sysex-decoder`**: Go (MIT, dead 2018), unpacks
  septet encoding of **IR/firmware** transport packets, not preset structure.
- **`github.com/codeflows/rusty-axe`**: Rust (dead 2016), reads `.syx`
  **header only** (model/name/target).
- **`github.com/rudib/axess`** (Rust, dead 2020), **`github.com/sean-e/mTroll`**,
  and assorted FCB1010 / Arduino foot-controller projects: live-MIDI command
  mappers / CC senders, no preset decode.

**Phantoms (searched, do not exist as public projects, don't re-hunt):**
"Fractal Manager"/FractalManager, axe-fx-mfc, "Albert Gee" tools, any
`pyaxefx`/`axefx`/`axefx-control` on PyPI, any `axefx`/`fractalbot` on npm
(the only Axe-Fx npm package is our own `fractal-midi`), FractalUI,
AxeFXSysExEditor, gumbo-fx.

Net: `fractal-midi` remains the deepest **open-source** gen-3 protocol decoder
and the only public open cross-generation *stored-preset* decoder; no public
project rivals it or is a credible migration target. The one open deep gen-3
decoder, `drewmerc302/fractal-syx-codec` (Apache-2.0), is this project's own
collaborator's, not independent prior art. Our Apache-2.0 license is what makes
us the legally-safe base others build on (ForgeFX did). Sourcing caveat: the
gen-3 patch-body decode is corroborated by Drew's codec (which Huffman-
decompresses it), **not** by the public forum corpus, which describes the
III/FM body as plaintext-sparse, so don't cite the community as a Huffman source.

---

## Our own generated references

### `docs/BLOCK-PARAMS.md`
Committed working reference for AM4 block types and their available effect TYPEs.
Distilled from the wiki scrape + AM4 owner's manual. First stop when building a
preset IR.

### `packages/fractal-midi/docs/devices/<device>/SYSEX-MAP.md`
Working SysEx protocol reference, one file per device (in the codec
package). Updated after every sniff/probe session. First stop when
encoding a message to send.

### `packages/fractal-midi/docs/research/primitives/editor-cache-section-record-grammar.md`
The fully decoded grammar of the Fractal editors' `effectDefinitions_*.cache`
files. One device-synced cache file yields the device's complete parameter
dictionary (ranges, defaults, steps, enum/model rosters) offline; this is the
first evidence source to reach for before any wire capture. Decoder:
`scripts/_research/parse-effectdefinitions-cache.ts`.

### `packages/fractal-midi/docs/capture-guides/harvest-script.md`
Community guide for `scripts/harvest-device-metadata.ts`, the one-command
read-only device self-describe sweep (one JSON output file). The second
community ask after the editor cache file, ahead of any targeted wire capture.

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

---

## How to use this file

- Before searching the web, check whether a local manual covers the question:
  `grep -l <term> docs/manuals/*.txt packages/fractal-midi/docs/devices/*/manuals/*.txt`
  is fast and precise.
- When adding a new PDF or external reference to the project, add a section to
  this file so future Claude Code sessions discover it without rescanning.
- Prefer the AM4 owner's manual over the Blocks Guide when they disagree on
  AM4-specific behavior; the Blocks Guide covers the whole product line and
  may describe features not present on AM4.
