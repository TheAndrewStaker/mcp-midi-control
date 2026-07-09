# fractal-midi, Claude Code Context

Read by Claude Code when working inside `packages/fractal-midi/`.

---

## What this package is

Pure-TypeScript codec and parameter dictionaries for Fractal Audio devices.
Builds and parses SysEx wire bytes. No MIDI transport dependency, no MCP
server logic. Consumers bring their own MIDI library (`node-midi`, `webmidi`,
etc.) and use this package for the encoding layer.

Published independently to npm as `fractal-midi`. The MCP server packages
in this monorepo import from `fractal-midi/*`; the codec never imports from
the server.

## Supported devices

- **AM4** (model byte `0x15`): full catalog, codec, calibration, hardware-verified
- **Axe-Fx II** (model byte `0x07`, XL+): full catalog, codec, calibration, hardware-verified. The Axe-Fx II family spans several model bytes (`0x03` for the Mark I/II up to `0x07` for the XL+); this codec targets the XL+ hardware on hand.
- **Axe-Fx III** (model byte `0x10`): full catalog, codec, calibration, community-beta hardware verification
- **FM3 / FM9** (model bytes `0x11` / `0x12`): modern Fractal gen-3 family sharing the III's codec and block effect IDs. Device-true param catalogs mined from their own FM3-Edit / FM9-Edit binaries (paramIds are device-specific, never reused from the III — e.g. reverb mix/type are 0/10 on FM9 but 13/0 on FM3 and III). Calibration covers linear params; some non-linear formulas pending. All three grid devices now carry the discrete enum-flow correction (type/count selectors route as discrete ordinals, not continuous floats): FM9 from its own editor-cache enum rows + the 2026-06-18 hardware roundtrip, III from that roundtrip as oracle, and FM3 (2026-07-02) via the FAMILY-JOIN overlay `src/gen3/fm3/familyJoinDiscrete.generated.ts` — sibling FM9-cache/roundtrip evidence joined by (family, SYMBOL), never by paramId. FM3 overlay is family-pattern evidence, community-beta; an FM3 SET→GET roundtrip is the pending hardware confirm. Community beta: the FM3's core surface is hardware-CONFIRMED end-to-end through this codec's own frames (2026-06-12 field test over USB-serial: reads, continuous SET, bypass, scene, sub=0x27 preset switch), and discrete set-by-name SET is FM3-hardware-confirmed via a 2026-06-10 collaborator session (frames byte-identical to our builder, sent from the tester's rig); set_block placement + save_preset + the Windows serial-driver path still unconfirmed; the FM9 has community captures confirming the shared read + preset-dump + bank-select paths.
- **VP4** (model byte `0x14`): gen-3 codec but AM4-shape (serial 4-slot chain, 4 scenes, A-D channels, A01-Z04 locations, no amp/cab). Device-true catalog mined from VP4-Edit. Its fn=0x01 WRITE frame is its own shape (no sub-action, a `tc` sub-opcode, swapped-septet float — `src/gen3/vp4/setParam.ts`), decoded byte-exact from community captures (fw 4.03). Reads ship, including the **whole-preset STRUCTURE READ** (`src/gen3/vp4/structureBlob.ts`, decoded 2026-07-01 from the same captures: eid206 pid0 tc=0x1f blob → preset name, 4 scene names, current scene, and the 4-slot chain in one round-trip); `set_param` (continuous knobs only: raw wire value, calibration pending, enum/TYPE set refuses), `set_bypass`, and `save_preset` ship community-beta (untested on hardware); `set_block`/`switch_scene` WRITES stay gated (placement/scene value math undecoded — register identities pinned). Community beta.
- **Axe-Fx Standard/Ultra (gen-1)** (model byte `0x01`): its **own** nibble-split codec (8-bit fields → two low-nibble-first bytes; fn `0x02`; trailing query(0)/set(1) flag, no checksum), distinct from gen-2 septet and gen-3 sub-action. 922 params / 35 blocks decoded byte-exactly from the published Ultra SysEx param-set doc + its 0..255 conversion table. Parameter READ-back is wired too (`buildGetParam`/`parseParamValue` in `readParam.ts`: fn 0x02 query → MIDI_PARAM_VALUE with value + the device's own label), decoded from the fuller gen-1 wiki spec. The whole-patch dump's SPEC-PINNED SUBSET also ships (`patchDump.ts`: fn 0x03 request for edit buffer / stored presets 0..255 → fn 0x04 dump; name + 4×12 effect-grid layout + source flag; the dump's ~1790-byte param region is undetermined in the spec and surfaced as a byte count only; bank-C requests ≥ 256 refuse). Community beta, not hardware-verified. Save, preset/scene/channel ops remain out of scope.

## Stack

- TypeScript, ES modules (`"type": "module"`, `"module": "NodeNext"`)
- Zero runtime dependencies
- `tsx` as the TypeScript runner for scripts and tests
- Node >= 18

## Directory layout

```
packages/fractal-midi/
├── src/
│   ├── index.ts              # Root entry: exports VERSION only
│   ├── shared/               # Cross-device: checksum, packValue, lineage lookup
│   │   ├── lineage/          # JSON lineage tables (amp, cab, drive, etc.)
│   │   └── index.ts
│   ├── am4/                  # AM4 builders, parsers, params, blocks, calibration
│   │   └── index.ts
│   ├── gen1/                 # Axe-Fx Standard/Ultra (gen-1) nibble-split codec + generated catalog
│   │   └── index.ts
│   ├── gen2/
│   │   └── axe-fx-ii/        # Axe-Fx II builders, parsers, params, blocks
│   │       └── index.ts
│   └── gen3/                 # Modern Fractal family (shared gen-3 codec + types.ts)
│       ├── axe-fx-iii/       # Axe-Fx III builders, parsers, params, enum overlay
│       │   └── index.ts
│       ├── fm3/              # FM3 device-true param catalog
│       ├── fm9/              # FM9 device-true param catalog
│       └── vp4/              # VP4 device-true catalog + its own fn=0x01 write codec
├── test/                     # Golden-based test suites (mirrors src/: am4, gen1, gen2, gen3, shared)
│   └── run-all.ts            # Test runner entry point
├── scripts/
│   ├── copy-build-assets.ts  # Copies lineage JSON into dist/ after tsc
│   └── export-catalog.ts     # Generates catalog/*.json from the TS exports
├── catalog/                  # GENERATED language-agnostic JSON catalog (committed;
│                             #   never hand-edit — `npm run catalog:export` regenerates,
│                             #   `catalog:check` gates drift in preflight)
├── docs/                     # Protocol RE docs (SYSEX-MAP, capture guides, cookbook)
│   └── devices/              # Per-device protocol references
└── dist/                     # Build output (gitignored)
```

## Exports map

Consumers import from subpaths matching the device or shared layer:

```ts
import { packValue, fractalChecksum } from 'fractal-midi/shared';
import { buildSetParam, params, blocks }  from 'fractal-midi/am4';
import { buildSetParam, params }          from 'fractal-midi/gen2/axe-fx-ii';
import { buildSetParam, params }          from 'fractal-midi/gen3/axe-fx-iii';
import { buildSetParam, nibbleSplit, KNOWN_PARAMS } from 'fractal-midi/gen1';
```

The root export (`fractal-midi`) exposes only a `VERSION` constant.

Non-TypeScript consumers read the generated JSON catalog instead:
`fractal-midi/catalog/<device>.json` (shape contract in
[docs/CATALOG-SCHEMA.md](docs/CATALOG-SCHEMA.md)). When a param table, enum
roster, or range table changes, run `npm run catalog:export` in the same
change — preflight's `catalog:check` fails on drift.

## Build and test

| Command | What it does |
|---|---|
| `npm run build` | `tsc` + `copy-build-assets` (copies lineage JSON to `dist/`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `tsx test/run-all.ts` (golden-based byte-exact SysEx verification) |
| `npm run preflight` | typecheck + test + build, in order |

Run `npm run preflight` before committing changes to this package.

## Publishing

Bump the version in `package.json`, then publish from this directory
(`cd packages/fractal-midi && npm publish`). The npm package is independent
of the MCP server packages, which are private and not published.

## Key conventions

**Display-first API.** Public functions accept and return display units (knob
values like `7.5`, enum strings like `'Plexi 100W High'`, dB, ms, ratios).
Wire encoding (septet-packed 14-bit ints, packed floats, fixed-point scaling)
is internal and never leaks through the public surface.

**Param registration.** Every parameter lives in `params.ts` within its device
directory. Each entry carries `paramId`, `controlType`, value range, display
unit, and optional calibration. When adding a new param, add a matching golden
case in the device's test suite.

**Lineage JSON.** Lineage tables (amp/cab/drive model heritage data) live as
JSON in `src/shared/lineage/` and are copied to `dist/` at build time by
`scripts/copy-build-assets.ts`. The `lineageLookup` module reads them at
runtime via `fs.readFileSync`.

**Golden-based tests.** Tests assert byte-exact round-trip equality: build
SysEx from display values, parse back, confirm equality. No mocking. When
adding a new wire builder or parser, add a golden case.

**Protocol docs live here.** Per-device `SYSEX-MAP.md`, opcode tables, capture
guides, Ghidra scripts, and the encoding cookbook all live under `docs/` in
this package. Consult the relevant `SYSEX-MAP.md` before speculating about
wire shapes.
