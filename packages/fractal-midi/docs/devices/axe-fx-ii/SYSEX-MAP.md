# Axe-Fx II Family SysEx Map, Working Protocol Reference

> **Status:** Discovery artefact. Wiki + manual + bank-file evidence
> consolidated 2026-05-09. Some entries hardware-confirmed
> against an Axe-Fx II XL+ Q8.02 export; others sourced from the
> Fractal Audio Wiki and pending hardware verification.
>
> **Sister docs:**
> - [`docs/devices/am4/SYSEX-MAP.md`](../am4/SYSEX-MAP.md): AM4-resolved
>   protocol map (deepest current coverage; many AM4 findings transfer
>   to Axe-Fx II since both use the same envelope and checksum scheme).
> - [`axeedit-opcode-table.md`](axeedit-opcode-table.md): full 94-opcode
>   wire vocabulary recovered from `Axe-Edit.exe` via Ghidra mining
>   (2026-05-20). Canonical machine-readable form for the
>   wire-byte ↔ opcode-name map; this `SYSEX-MAP.md` is the narrative
>   complement focused on byte-shape decode + capture provenance.
> - [`component-catalog.md`](component-catalog.md): Axe-Edit
>   `<EditorControl>` catalog (UI structure, type-applicability gates)
>   generated from the JUCE BinaryData ZIP.
> - [`docs/MULTI-DEVICE-ROADMAP.md`](../../MULTI-DEVICE-ROADMAP.md): >   overall multi-device strategy.

---

## Recent additions

**2026-07-02:** the de-framed preset image's inner structure is
DECODED: a self-describing TLV chain from word 130 (modifier records →
effect blocks alphabetical by squashed display name → fixed system
tail), with `paramBase = tlvWord + 2` and channel-Y at
`+payload_len/2`. Confirmed 388/388 (384 factory presets + 4 live
hardware dumps); the BK-070 one-variable hardware diffs land at
exactly the predicted words. See § 6 "De-framed image layout" below;
decoder `packages/fractal-gen2/src/presetImageTlv.ts`; primitive
`ii-preset-image-tlv-chain`.

**2026-05-20:** Ghidra mining of `Axe-Edit.exe`
recovered the full 94-opcode wire vocabulary as a static
`OpcodeDescriptor` table in `.rdata`. Documented in
[`axeedit-opcode-table.md`](axeedit-opcode-table.md), which is the
canonical machine-readable form. **Nine of those wire bytes were not
previously catalogued in this map** and have been added to § 5 below
with status flags pending capture work:

| Wire | Opcode | Status | Section |
|------|--------|--------|---------|
| `0x0C` | `SYSEX_SET_GRID` | 🔴 no captures | § 5 |
| `0x0E` | `SYSEX_QUERY_STATES` | 🟡 structure measured (5-byte records, count==placed blocks), field semantics pending | § 5d |
| `0x16` | `SYSEX_GET_PARAM_INFO` | 🟢 33B response, 25-byte 5-group descriptor decoded (field roles partial) | § 5g |
| `0x18` | `SYSEX_GET_MODIFIER_INFO` | 🟢 confirmed request-only; modifiers read via fn 0x07 | § 5 |
| `0x1F` | `SYSEX_GET_ALL_PARAMS` | 🟢  primitive, hardware-verified | § 5e |
| `0x21` | `SYSEX_RESYNC` | 🟢 device-emitted, confirmed in passive capture | § 5 |
| `0x28` | `SYSEX_GET_PARAM_STRINGS` | 🟢 hardware-verified Q8.02, NULL-delimited ASCII enum dump | § 5h |
| `0x47` | `SYSEX_GET_SYSINFO` | 🟡 8-byte payload, semantics undecoded | § 5f |
| `0x63` | `SYSEX_FSGRID` | 🔴 no captures, FC-controller-only likely | § 5 |

The full opcode table covers 94 entries. These nine are the bytes
that the wiki + prior capture work hadn't already named. For any
opcode not narrated below, defer to
[`axeedit-opcode-table.md`](axeedit-opcode-table.md) for the wire-byte
and AxeEdit's internal name.

---

## Legend

- 🟢 **CONFIRMED**: Documented for the Axe-Fx II family on the
  Fractal Audio wiki (`wiki.fractalaudio.com/wiki/MIDI_SysEx`),
  cross-checked against [`docs/devices/am4/SYSEX-MAP.md`](../am4/SYSEX-MAP.md), or verified by inspecting
  real wire bytes in the cached factory bank export. Safe to use.
- 🟡 **WIKI-DOCUMENTED, NOT YET HARDWARE-VERIFIED**: Wiki spec exists
  but we haven't yet captured live Axe-Fx II ↔ Axe-Edit traffic to
  prove the device honours the spec at the current firmware. First
  hardware test would shift this to 🟢.
- 🔴 **UNKNOWN**: No wiki coverage, no AM4 analogue. Capture-based
  RE required.

---

## 1. Family overview

The Axe-Fx II family covers four wire-distinct variants of the same
product line. All share the SysEx envelope, the XOR & 0x7F checksum,
and the function-ID conventions documented in the wiki.

| Model byte | Device | Notes |
|------------|--------|-------|
| `0x03` | Axe-Fx II (Mark I / Mark II) | Original Axe-Fx II generations. |
| `0x06` | Axe-Fx II XL | Expanded memory + peripherals. |
| `0x07` | **Axe-Fx II XL+** | **Founder owns this; wire-confirmed .** |
| `0x08` | AX8 | Floor unit using the same engine. |

The Axe-Edit `__block_layout.xml` (catalog source) declares
`<Device model="3"/>`, `<model="6"/>`, `<model="7"/>` in its
header, Axe-Edit's internal numbering for the three Axe-Fx II
generations using the same model byte values.

Family wire shape (envelope + checksum) is identical to AM4. See
[`docs/devices/am4/SYSEX-MAP.md`](../am4/SYSEX-MAP.md) §2 (Envelope Format) and §3 (Checksum Algorithm).

## 1b. AX8 notes (BK-094, 2026-07-09)

The AX8 floor unit is a config on this SAME codec (`createAxeFxIIDescriptor`
in `packages/fractal-gen2/src/descriptor.ts`, config in
`packages/fractal-gen2/src/configs/ax8.ts`), not a new wire shape. **No AX8
hardware is on hand**; every fact below is evidence-backed per two-or-more
independent sources (per this project's evidence-bar rule) but untested
end-to-end. Full citations: `docs/_private/AX8-RESEARCH-2026-07-09.md`
(consumer repo).

- **Model byte `0x08`**, confirmed two ways: (1) the family table above +
  `setParam.ts`'s `MODEL_IDS.ax8` (both sourced from the cached Fractal Audio
  Wiki "MIDI_SysEx" page); (2) an independently-surfaced AX8 wire example,
  `F0 00 01 74 08 14 00 00 19 F7` (a fn=0x14 GET_PRESET_NUMBER response),
  **self-validating**: XOR-`&0x7F` of `F0 00 01 74 08 14 00 00` computes to
  `0x19`, matching the frame's own checksum byte exactly under this codec's
  `fractalChecksum`. Locked as a golden in
  `scripts/verify-ax8-model-byte.ts` (consumer repo).
- **Grid: 4 rows x 12 columns, SAME shape as the XL+, not reduced.** Source:
  AX8 Owner's Manual, "The Grid Concept": *"Virtual gear is selected from the
  inventory and placed as 'blocks' into the slots of a 12x4 'layout grid.'"*
  (`fractalaudio.com/downloads/manuals/AX8/AX8-Owners-Manual.pdf`).
- **Presets: 512 total, 64 banks x 8 presets/bank.** Source: AX8 Owner's
  Manual, "Saving Changes": *"The AX8 has 512 preset memory locations grouped
  in 64 numbered banks. Each bank contains 8 presets."* The wire location
  format is unchanged (1-indexed display slot, 14-bit wire ceiling
  1..16384), same as the XL+, this config doesn't hard-enforce the model's
  true physical count, only the wire's ceiling.
- **Scenes: 8 per preset, same X/Y-plus-bypass model as the XL+.** Source: AX8
  Owner's Manual, "Selecting Scenes": *"Every preset has eight scenes built in
  and ready to use,"* controlling per-block on/off and X/Y state.
- **Block roster: REDUCED vs the XL+**, single-instance-only on several
  groups (no Amp 2 / Cab 2 / Reverb 2 / Multi Delay 2 / Chorus 2 / Flanger 2 /
  Rotary 2 / Phaser 2 / Wah 2 / Tremolo-Panner 2 / Gate Expander 2 / Pitch 2 /
  Synth 2; Mixer, Vocoder, Megatap Delay, Crossover, Multiband Compressor,
  Quad Chorus, Resonator, and the 3rd/4th GEQ/PEQ/Filter/Volume-Pan instances
  are absent). Source: this file's own `blockTypes.ts`'s `availableOnAX8`
  field, itself mined from the same Fractal Audio Wiki Block-IDs table that
  supplies the block-ID table.
- **X/Y channels**: same model as the XL+, no codec rework needed (confirms
  the original BK-094 scoping note). AX8 Owner's Manual: *"Most blocks offer
  X/Y switching for twice as many sounds from the same number of blocks."*

**Gating.** `apply_preset` / `apply_setlist` refuse on the AX8 config
(`capability_not_supported`): the shared multi-step build pipeline
(`packages/fractal-gen2/src/tools/applyExecutor.ts`) calls the wire builders
WITHOUT a model-byte option (always emits the XL+'s `0x07`), so it would
silently build a preset a real AX8 never receives, a genuine model-byte
mismatch, not merely "untested." Every direct single-write op (`set_param`,
`set_params`, `set_block`, `set_bypass`, `switch_preset`, `switch_scene`,
`save_preset`, `rename`, plus every read) IS correctly addressed with
`{ modelId: 0x08 }` and ships community-beta. See
`docs/contributing/devices/ax8.md` (in the mcp-midi-control repo)
for the community verification ask.

## 2. Source documents and where each fact comes from

| Source | URL / path | Coverage |
|--------|------------|----------|
| Fractal Audio Wiki, `MIDI_SysEx` | `https://wiki.fractalaudio.com/wiki/index.php?title=MIDI_SysEx` | Authoritative protocol spec for Axe-Fx II / AX8 / AM4 / VP4 / III/FM family. **Cached at `founder-private notes`.** Includes the full per-block parameter ID tables (CPR / GEQ / PEQ / AMP / CAB / REV / DLY / etc.): these are the wire-IDs missing from the Axe-Edit XML catalog. The wiki disclaims the SysEx info is "printed here with the permission of Fractal Audio." |
| Fractal Audio Wiki, `Axe-Fx_SysEx_Documentation` (gen1) | `https://wiki.fractalaudio.com/gen1/index.php?title=Axe-Fx_SysEx_Documentation` | Original Axe-Fx Standard / Ultra protocol, direct ancestor. **Cached at `founder-private notes`.** Useful for understanding the function-ID space evolution. |
| Axe-Fx II Owner's Manual (Q7.0) | `docs/devices/axe-fx-ii/manuals/Axe-Fx-II-Owners-Manual.{pdf,txt}` | Hardware-anchored facts: SysEx ID `00 01 74` (cannot be changed), preset count (768 on XL/XL+, 384 on Mark I/II), 8 scenes, MIDI Implementation Chart at §17.3. |
| Factory bank export (Quantum 8.02) | `samples/factory/Axe-Fx-II_XL+_Bank-{A,B,C}_Q8p02.syx` | **Wire-canonical preset binary on the founder's hardware.** Three banks × 128 presets × 66 messages each = 8448 SysEx messages per bank. Used for 0x77/0x78/0x79 envelope validation . |
| Axe-Edit `__block_layout.xml` | `samples/captured/decoded/binarydata/axe-edit-extracted/__block_layout.xml` | UI-side: 39 block types, 2482 editor rows, 1035 unique parameter names, 160 type-applicability gates. Catalogued in [`component-catalog.md`](component-catalog.md). **Does not contain wire IDs**: for those, use the wiki tables. |

## 3. SysEx envelope 🟢

```
F0 00 01 74 [model] [function_id] [...payload...] [checksum] F7
```

Identical to AM4. Per the Owner's Manual:

> **SysEx ID: 00 01 74 (cannot be changed)**: `[I/O > MIDI > SysEx ID]`
> menu, which is read-only on Axe-Fx II.

Manufacturer ID octets `00 01 74` were assigned to Fractal in firmware
10.02. Earlier Standard/Ultra firmwares used `00 00 7D`, no longer
relevant; Axe-Fx II / AX8 / AM4 / VP4 / III all use `00 01 74`.

## 4. Checksum scheme 🟢

```typescript
const checksum = bytes
  .slice(0, -2)              // F0 .. last_payload_byte (exclude existing cs+F7)
  .reduce((acc, b) => acc ^ b, 0) & 0x7F;
```

XOR every byte from `F0` through the last data byte, mask to 7 bits.
Insert before the trailing `F7`.

**Verified ** against 8448/8448 messages in
`Axe-Fx-II_XL+_Bank-A_Q8p02.syx` and equivalents B and C. 100% match.

## 5. Function ID space, Axe-Fx II / AX8

The wiki documents the full set. Reproduced here with hardware-
verification status against the founder's XL+ where applicable:

| ID | Symbolic name | Direction | Status on XL+ |
|----|---------------|-----------|---------------|
| 0x01 | GET_BLOCK_PARAMETERS_LIST | both | 🟡 wiki |
| 0x02 | GET / SET_BLOCK_PARAMETER_VALUE | both | 🟢 hardware-verified Q8.02, GET is channel-aware (respects fn=0x11). SET is also channel-aware for writes (confirmed 2026-05-26: compressor X/Y independently addressable). SET uses 16-bit wire integer via 3x7-bit septets; required for enum/select params where fn=0x2e no-ops. Bypass (paramId=255) is block-global (same on X/Y). |
| **0x03** | **SYSEX_PATCH_DUMP** (request) | req | **🟢 hardware-verified Q8.02 (2026-06-10), TWO addressing forms.** (1) `[preset_hi, preset_lo]` MSB-first: dumps that slot's STORED flash contents as the 66-frame 0x77/0x78/0x79 chain, **and RELOADS the stored preset into the edit buffer as a side effect** (live probe: an fn 0x09 buffer rename was lost the moment the request was answered), destructive to unsaved edits. (2) **`0x7F 0x7F` sentinel (AM4-style): dumps the EDIT BUFFER**, confirmed three ways in the same probe session: two sentinel dumps across a live buffer rename differ (tracks the buffer), the rename SURVIVES the request (no reload side effect), and pushing the 66-frame response back to the device restored the dumped buffer state (round-trip verified by name re-read). All three dump responses carry 0x77 header payload `[0x7f, 0x00, 0x00, 0x20]` regardless of addressing. Captures: `samples/captured/hw132/`. Builders: `buildPatchDumpRequest` / `buildEditBufferDumpRequest` in `src/gen2/axe-fx-ii/setParam.ts` (goldens in the consumer repo's `verify-axe-fx-ii-encoding.ts`). |
| **0x06** | **SET_CELL_ROUTING** (undocumented) | req | **🟢 hardware-decoded on Q8.02 XL+ (2026-05-13)**: 3-byte payload `[src_cell, dst_cell, connect]` adds/removes a cable between adjacent-column cells. Byte-exact golden in `scripts/verify-axe-fx-ii-encoding.ts`. See § 5c. |
| **0x07** | **GET / SET_MODIFIER_VALUE** | both | **🟢 modifier READ decoded (Ares 2.00 capture).** The field-indexed modifier read channel: device reply = `F0 00 01 74 07 07 [effId:2][slot:2][field:2][value16:3][ASCII label] 00 [cs] F7`. field 0x00=source, 0x01/0x02=min/max, 0x03..0x06=start/mid/end/slope, 0x07=damping, 0x08=target effectId, 0x09=target paramId, 0x0a..0x0e=toggles+scale/offset. Source enum (partial): 0 NONE, 1 LFO 1A, 4 LFO 2B, 5 ADSR 1, 26 SCENE 1, 27 SCENE 2. THIS is how modifiers are read, not fn 0x18. See primitive [[ii-fn07-modifier-read]] + § 5i. |
| 0x08 | GET_FIRMWARE_VERSION | both | 🟡 wiki |
| 0x09 | SET_PRESET_NAME | req | 🟡 wiki |
| **0x0C** | **SYSEX_SET_GRID** (AxeEdit name) | req | **🔴 no captures.** Ghidra-only. Likely a grid-layout write counterpart to fn 0x20 GET_GRID.  probe gated behind `--include-writes`. See [`axeedit-opcode-table.md`](axeedit-opcode-table.md). |
| 0x0D | TUNER_INFO | resp | 🟡 wiki, no checksum on this message |
| **0x0E** | **SYSEX_QUERY_STATES / PRESET_BLOCKS_DATA** | both | **🟡 structure measured, field semantics pending**. AxeEdit's single-round-trip whole-preset block-state read (fires once per direct-sync gesture, alongside fn 0x20 GET_GRID). Response tiles into fixed 5-byte records, count == placed-block count, no trailing checksum. Per-field bit semantics + record ordering hardware-pending. See § 5d below + `samples/captured/session-58-direct-sync.syx`. |
| 0x0F | GET_PRESET_NAME | both | 🟡 wiki |
| 0x10 | MIDI_TEMPO_BEAT | resp | 🟡 wiki, no checksum |
| 0x11 | GET / SET_BLOCK_XY | both | 🟡 wiki |
| 0x12 | GET_CAB_NAME / GET_ALL_CAB_NAMES | both | 🟡 wiki |
| 0x13 | GET_CPU_USAGE | both | 🟡 wiki |
| 0x14 | GET_PRESET_NUMBER (read) / MIDI_SET_PRESET (legacy write) | both | 🟡 wiki, 14-bit preset number (XL+ range 0-767). **Captured response payload is MSB-first**, not LSB-first as the wiki suggests, see § 6b below. |
| **0x16** | **SYSEX_GET_PARAM_INFO** (AxeEdit name) | both | **🟢 hardware-responsive XL+ Q8.02.** Per-param descriptor: 33B response, 25-byte 5-group descriptor decoded (field roles partial). 5 groups of 5 plain-LE septets pack a 32-bit value each: G0 int current, G1/G2/G3 float32 min/max/default (G2-vs-G3 role control-type-ambiguous), G4 reserved. See § 5g. |
| 0x17 | GET_MIDI_CHANNEL | both | 🟡 wiki |
| **0x18** | **SYSEX_GET_MODIFIER_INFO** (AxeEdit name) | req | **🟡 request decoded, response hardware-gated.** Per-block modifier descriptor read. In `session-58-direct-sync.syx` AxeEdit fires 24 of these, one per modifier-capable block, sweeping a contiguous effectId range 100..123 (Compressor 1 through Phaser 2) in catalog order. Request payload is 8 bytes: a 14-bit septet effectId selector `[effectId_lo][effectId_hi]` plus 6 zero pad bytes. **Hardware-confirmed request-only (Ares 2.00, 2026-05-29):** with a target set via fn 0x37 (device 0x64-acks `[37 00]`) and a modifier assigned on Amp 1 Input Drive, fn 0x18 still emits NO reply. The modifier data is read over **fn 0x07** instead (field-indexed; see that row + § 5i). fn 0x37 SET_TARGET_BLOCK wire shape also confirmed here: payload = effectId septet pair. See [`axeedit-opcode-table.md`](axeedit-opcode-table.md). |
| **0x1C** | **BANK_DUMP_REQUEST** | req | **🟢 wire-confirmed** (community capture, multiple authors): 2-byte payload `[bank_id, cs]` where bank_id = 0 (Bank A), 1 (B), 2 (C), 3 (System). Device responds with the corresponding bank as a 0x77/0x78/0x79 envelope sequence. Captured wire: `F0 00 01 74 03 1C 00 1A F7` (Bank A), `…1C 01 1B F7` (B), `…1C 02 18 F7` (C), `…1C 03 19 F7` (System). |
| **0x1D** | **STORE_PRESET (save-to-location)** | req | **🟢 wire-confirmed XL+ Q8.02 ( capture +  round-trip, 2026-05-11)**: 2-byte payload `[preset_high, preset_low]` MSB-first; device responds with 0x64 echoing 0x1D + result_code |
| **0x1F** | **SYSEX_GET_ALL_PARAMS** (AxeEdit name) | both | **🟢 hardware-verified  ( primitive).** Bulk per-block parameter dump. Lands in `fractal-midi/src/gen2/axe-fx-ii/` as the per-block read path. See § 5e below + `samples/captured/probe-axefx2-bulk-read.syx`. |
| **0x20** | **GET_GRID_LAYOUT_AND_ROUTING** | both | **🟢 wire-confirmed XL+ Q8.02 ( captures, 2026-05-12)**: 200-byte frame, 192-byte payload, column-major (12 cols × 4 rows × 4 bytes/cell). Each cell `[blockId_lo, blockId_hi, routing_mask, byte3]`. See § 5c. |
| **0x21** | **SYSEX_RESYNC / FRONT_PANEL_CHANGE_DETECTED** | resp | **🟢 confirmed via passive capture.** Device-emitted state-changed broadcast. Sending this from host triggers the device to push current state as `0x74/0x75/0x76` state-broadcast triples per placed block (which we already decode). Likely usable as an atomic-read primitive without further capture work. AxeEdit name `SYSEX_RESYNC`; wiki name `FRONT_PANEL_CHANGE_DETECTED`. |
| 0x23 | MIDI_LOOPER_STATUS_ENABLE / MIDI_LOOPER_STATUS | both | 🟡 wiki |
| **0x28** | **SYSEX_GET_PARAM_STRINGS** (AxeEdit name) | both | **🟢 hardware-verified XL+ Q8.02 ( probe, 2026-05-20).** Runtime enum-value label query. Device returns NULL-delimited 7-bit ASCII strings filling the SysEx payload. Early captures stopped at ~2048 bytes; root-caused 2026-06-09 to our receive path dropping node-midi's WinMM continuation fragments (not a device or node-midi truncation), fixed by fragment reassembly. 154 amp-type labels captured for paramId=0 pre-fix, matched the catalog at 150/154 entries, surfaced **4 wiki transcription errors** the catalog had been carrying. See § 5h. |
| 0x29 | GET / SET_SCENE_NUMBER | both | 🟡 wiki, scene 0..7 (8 scenes) |
| 0x2A | GET_PRESET_EDITED_STATUS | both | 🟡 wiki |
| 0x2E | SET_TYPED_BLOCK_PARAMETER_VALUE | req | 🟡 wiki, 32-bit float variant for typed-input edits |
| 0x32 | BATCH_LIST_REQUEST_START | resp | 🟡 wiki |
| 0x33 | BATCH_LIST_REQUEST_COMPLETE | resp | 🟡 wiki |
| 0x37 | SET_TARGET_BLOCK | req | 🟡 wiki, must precede modifier and monitor-graph requests |
| 0x3C | SET_PRESET_NUMBER | req | 🟡 wiki |
| 0x42 | DISCONNECT_FROM_CONTROLLER | req | 🟡 wiki, clean-shutdown after 0x08 |
| **0x47** | **SYSEX_GET_SYSINFO** (AxeEdit name) | both | **🟡 capture exists, payload semantics undecoded**. 8-byte payload `0a 02 3d 01 00 08 04 00` observed in `samples/captured/session-58-direct-sync.syx`, in the device-side response cluster (direction inferred from stream position). Richer device-info than fn 0x08 GET_FIRMWARE_VERSION. See § 5f below + [`axeedit-opcode-table.md`](axeedit-opcode-table.md). |
| **0x63** | **SYSEX_FSGRID** (AxeEdit name) | both | **🔴 no captures.** Ghidra-only. Footswitch grid layout. Likely FC-controller-only opcode (MFC-101 / FC-12 family) and not exercised on a bare XL+ install. See [`axeedit-opcode-table.md`](axeedit-opcode-table.md). |
| 0x64 | MULTIPURPOSE_RESPONSE | resp | 🟡 wiki, `[echoed_fn, result_code]` |
| 0x7A | MIDI_START_IR_DOWNLOAD | req | 🟡 wiki, IR download begin |
| 0x7B | MIDI_G2_IR_DATA | req | 🟡 wiki, IR sample chunks (64 messages × 32 chunks) |
| 0x7C | MIDI_CLOSE_IR_DOWNLOAD | req | 🟡 wiki, IR download end + cumulative checksum |
| **0x77** | **PRESET_DUMP_HEADER** | both | **🟢 wire-confirmed XL+ Q8.02**: 4-byte payload `[bank, preset, 0x00, 0x20]` |
| **0x78** | **PRESET_DUMP_CHUNK** | both | **🟢 wire-confirmed XL+ Q8.02**: 194-byte payload, 64 chunks per preset |
| **0x79** | **PRESET_DUMP_FOOTER** | both | **🟢 wire-confirmed XL+ Q8.02**: 3-byte payload (likely whole-preset checksum) |

(0x77 / 0x78 / 0x79 are not documented in the wiki's main function-ID
table, they live under "MIDI SysEx: Importing/Exporting Presets" which
the wiki section is mostly empty. AM4's [`docs/devices/am4/SYSEX-MAP.md`](../am4/SYSEX-MAP.md) §10b
decoded the same three bytes for AM4. Today's bank-file inspection
confirms identical envelope shape on Axe-Fx II XL+ Q8.02.)

## 5b. STORE_PRESET (function 0x1D): save-to-location 🟢

**Wire envelope (request, host → device):**

```
F0 00 01 74 [model] 1D [preset_high] [preset_low] [cs] F7
  preset_high = (preset_number >> 7) & 0x7F
  preset_low  = preset_number & 0x7F
  cs          = XOR of bytes [F0 .. preset_low] masked to 7 bits
```

**Wire envelope (response, device → host):** standard MULTIPURPOSE_RESPONSE.

```
F0 00 01 74 [model] 64 1D [result_code] [cs] F7
  result_code = 0x00 (OK) | 0x05 (parsed but not honored) | ...
```

**Byte ordering is MSB-first** for the preset number, `[preset_high,
preset_low]`, which differs from the wiki's documented LSB-first
ordering for related functions (0x14 GET_PRESET_NUMBER, 0x3C
SET_PRESET_NUMBER). The wiki has no 0x1D entry; the MSB-first ordering
comes from a public Rust RE crate and is empirically confirmed against
Q8.02 XL+ (see § 6b for the disambiguating evidence).

**Effect on device state:** commits the active working buffer to
user preset slot `preset_number`. The working buffer is not cleared;
the saved slot now matches the working buffer byte-for-byte. Slot
0-indexed on the wire; front-panel display is 1-indexed (slot
display N corresponds to wire `preset_number = N - 1`).

**Decoding evidence (2026-05-11):**

Passive capture of AxeEdit's File → Save Preset operation to slot 700
on Q8.02 XL+ produced three `0x64` MULTIPURPOSE_RESPONSE messages from
the device:

```
F0 00 01 74 07 64 1D 00 7B F7    ← echoed_fn=0x1D, result=0x00 (STORE OK)
F0 00 01 74 07 64 3C 00 5A F7    ← echoed_fn=0x3C, result=0x00 (post-save preset switch)
F0 00 01 74 07 64 09 00 6F F7    ← echoed_fn=0x09, result=0x00 (SET_PRESET_NAME)
```

Capture file: `samples/captured/session-61-save-attempt.syx`.
Decoder: `scripts/decode-session-61-save.ts`.

**Cross-reference:** a public Rust RE crate (MIT, archived) ships
`store_in_preset` with byte-exact test case for Mark II preset 217:
`[F0 00 01 74 03 1D 01 59 43 F7]`. Math checks out: 217 = (1<<7)+0x59,
XOR across body = 0xC3, so cs = 0x43. Same encoder shape, just our
model byte (0x07 XL+) vs the crate's 0x03 Mark II.

**End-to-end round-trip (2026-05-11):** our `buildStorePreset`
encoder fired against Q8.02 XL+ produced byte-identical wire output;
device returned `0x64 1D 00` (OK) and the founder confirmed the
working buffer landed at slot 700 via front-panel inspection. First
attempt success, no encoder bugs in the path.

## 5c. Routing grid wire format (function 0x20 + fn 0x06) 🟢

**fn 0x20 GET_GRID_LAYOUT_AND_ROUTING response, wire-confirmed XL+ Q8.02.**

```
F0 00 01 74 07 20 [192-byte payload] [cs] F7
```

Payload is **column-major**: 12 columns × 16 bytes/column. Each
16-byte column packs 4 rows × 4 bytes/cell:

```
column N (16 bytes) = row0[4 bytes] | row1[4 bytes] | row2[4 bytes] | row3[4 bytes]
cell  (4 bytes)     = [blockId_lo, blockId_hi, routing_mask, byte3_unknown]
```

- `blockId` = 14-bit septet pair (`blockId_lo | (blockId_hi << 7)`).
  Empty cells have blockId = 0; SHUNT cells have blockId = 201.
- `routing_mask` at byte offset +2 is a **4-bit input mask**: each bit
  N (0..3) set means "feed this cell from row N+1 of the previous
  column." So `0x02` (bit 1) = "feed from row 2 of prev col."
  Multi-bit masks encode parallel-path merges (e.g. `0x06` = feed from
  both row 2 AND row 3 of prev col). The mask lives on the
  **destination** cell, not the source. Cabling Amp(R2C2)→Cab(R2C3)
  sets *Cab's* mask to 0x02, leaving Amp's mask untouched.
- `byte3` semantics unknown, likely channel state or per-cell flags.

**State-broadcast `op_flag = 0x03` = "routing changed".** When a
cable is added or removed, the device emits a 0x74/0x75/0x76 triple
targeting the **source** block of the affected cable, with
`op_flag` = 0x03 (distinct from 0x00 = preset structure, 0x01 = block
edit decoded ). Listeners can use this to detect routing
changes without polling the full grid.

**Decoding evidence (2026-05-12):**

Two passive captures (`samples/captured/session-68-click-connect.syx`
and `session-69-click-connect-ctrl.syx`) of AxeEdit's "Click to
connect" gesture on slot 666 "Glassy Clean":

- First capture: clicked + between Comp (R2C1) and Amp (R2C2). Diff
  of pre/post grid frames showed Amp's mask flipped 0x00 → 0x02
  (cell at col 1 row 1, byte offset 6 within the 16-byte column
  stride = byte 2 of row 1's 4-byte cell).
- Control capture: clicked + between Amp (R2C2) and Cab (R2C3). Final
  grid shows Comp(0x02) → Amp(0x02) → Cab(0x02) → Reverb(0x00),
  matching the visible cable chain.

Decoder: `scripts/diff-axefx2-grid-state.ts`.

**fn 0x06 SET_CELL_ROUTING, hardware-decoded 2026-05-13.**

Wire envelope:

```
F0 00 01 74 [model] 06
  [src_cell_idx]    ← col-major linear index: (col-1)*4 + (row-1)
  [dst_cell_idx]    ← col-major linear index; MUST be src_col + 1
  [connect]         ← 0x01 = add cable, 0x00 = remove cable
  [cs] F7
```

The device updates `dst_cell.routing_mask` by setting (connect=1) or
clearing (connect=0) the bit at index `src_row_0indexed`. Since the
mask is the destination's INPUT mask (see § 5c above), this is the
inverse of what one might naively guess from the function name, *"set cell routing"* sets the **destination cell's** mask, not the
source's.

**Captured oracle** (`samples/captured/session-69-click-connect-ctrl.syx`,
AxeEdit click-to-connect on Amp(R2C2) → Cab(R2C3)):

```
F0 00 01 74 07 06 05 09 01 09 F7
  src_cell = 5  = (2-1)*4 + (2-1) = R2C2 (Amp's cell)
  dst_cell = 9  = (3-1)*4 + (2-1) = R2C3 (Cab's cell)
  connect  = 1  = add cable
  cs       = 09 (XOR of F0..01 inclusive, & 0x7F)
```

**Replayed by `scripts/verify-axefx2-routing-write.ts`** against
Q8.02 XL+: device acked `F0 00 01 74 07 64 06 00 [cs] F7` (result
code 0x00 = OK) and the grid-state read confirmed Cab's routing
mask flipped 0x00 → 0x02 ("Cab now feeds from row 2 of col 2 = Amp").

**Critical bug rooted out:** prior probe scripts (`probe-axefx2-
routing.ts`, `probe-axefx2-routing-sweep.ts`) used a local checksum
that started XOR at index 1 (excluding the leading F0). Fractal's
canonical checksum INCLUDES F0 (`src/fractal/shared/checksum.ts`).
Switching probes to the canonical `fractalChecksum` flipped most
of an earlier 0x01 acks to 0x00 OK, the "payload shapes failed"
finding was a cs-validation failure misdiagnosed as shape rejection.

**Result codes observed on Q8.02 XL+:**
- `0x00`, OK, routing updated
- `0x01`, request rejected (e.g. non-adjacent columns, malformed)
- `0x0C`, payload length too short

**Implementation:** `buildSetCellRouting({srcRow, srcCol, dstRow,
dstCol, connect})` in `src/fractal/axe-fx-ii/setParam.ts`. The
applyExecutor uses it to wire EVERY adjacent pair in row 2, both
between content blocks (cols 1→2, 2→3, ..., N-1→N) AND through the
shunt-chain extension (cols N→N+1 through 11→12). Closes the
silent-preset bug that was the Axe-Fx II MVP ship gate.

**Content blocks do NOT auto-route on fn 0x05 placement.** 
slot-601 hardware test (2026-05-13) proved this empirically: Comp /
Amp / Cab / Reverb placed via fn 0x05 SET_GRID_CELL came up with
routing_mask=0 across all four cells. The earlier "device auto-cables
Comp→Amp→Cab→Reverb on row 2" assumption was wrong, what actually
happened in earlier modifier tests was that the SOURCE slot (e.g.
slot 666 "Glassy Clean") already had the cables saved from a prior
authoring session, and our apply was inheriting that wiring. Once
applied to a truly-empty target slot (601), the content blocks land
unwired. Fix: emit explicit fn 0x06 cables for every adjacent pair
from col 2..12, regardless of whether the source cell is a content
block or a shunt. Byte 3 of fn 0x05 confirmed unrelated to routing
(probed values 0x00, 0x01, 0x02, 0x04, 0x08, 0x0F, all accepted by
device, none mutate the routing_mask).

**Each shunt position needs a UNIQUE block instance ID.** 
in-to-out-route capture (`samples/captured/session-71-in-to-out-
route.pcapng`, 2026-05-13) shows AxeEdit placing 6 shunts at cols 7-12
using `blockId` 200, 201, 202, 203, 204, 205, one unique instance
per cell. Reusing the same blockId across positions triggers the
device's documented "move on duplicate" behavior (`setParam.ts:797`):
the second placement clears the first cell as a side effect, leaving
only the LAST placement persisted. Per-cell mask=0 broke the chain
even after cabling, silent preset. Fix: use `SHUNT 1`..`SHUNT N`
(`blockId 200 + (n-1)`) for each shunt position, never repeating an
instance ID within a single preset.

**fn 0x05 envelope is 3 payload bytes in AxeEdit's wire format**, not
4, `F0 00 01 74 [model] 05 [block_lo] [block_hi] [cell_idx] [cs] F7`
(11 bytes total). Our `buildSetGridCell` appends a 0x00 "reserved"
byte (12 bytes total). Device accepts both, 4-byte format was
hardware-verified in /63 probes, but AxeEdit's canonical
form omits the trailing byte. No known semantic difference under
Q8.02, but minimizing protocol drift is preferable; pending future
session to retire byte 3.

## 5d. fn 0x0E SYSEX_QUERY_STATES, whole-preset block-state read 🟡

**AxeEdit name:** `SYSEX_QUERY_STATES`. **Wiki name:** `PRESET_BLOCKS_DATA`.
**Source:** Ghidra mining of `Axe-Edit.exe`. Capture
provenance: `samples/captured/probe-axefx2-new-opcodes-findings.md`,
`samples/captured/session-58-direct-sync.syx`.

This is AxeEdit's single-round-trip whole-preset state read: a "Read
from Axe-Fx" / direct-sync gesture fires fn 0x20 GET_GRID and fn 0x0E
together, and the pair reconstructs the whole working buffer. It is
distinct from fn 0x1F GET_ALL_PARAMS, which is a per-block, multi-KB
parameter dump.

**Wire envelope (request, host → device):**

```
F0 00 01 74 [model] 0E [payload] [cs] F7
```

The request is **payload-insensitive**: an empty request and a
block-selector request return the same frame shape.

**Response shape (structure measured):**

- A single frame, measured 54-62 bytes depending on the preset (62
  bytes / 11 records for an 11-block preset; ~54 bytes for a 10-block
  preset).
- The response carries **NO trailing checksum**. Sanity check: XOR over
  `F0`..second-last byte = `0x1a` for the 62-byte sample, which does
  not equal the byte present in that slot, so the byte is data, not a
  checksum.
- Payload (header is `F0 00 01 74 07 0E`, 6 bytes; drop the final F7)
  tiles into fixed **5-byte records**. The record count equals the
  number of placed blocks on the active grid, cross-checked against the
  fn 0x20 GET_GRID read in the same capture.
- Each record: `byte0` = a small tag (observed `{0x02, 0x03}`); `bytes
  1..4` = a 28-bit packed per-block state word (bypass + channel X/Y +
  likely scene bits).

**HARDWARE-PENDING (do NOT assert as decoded):**

- The per-field bit semantics (which bits are bypass vs channel-Y vs
  scene). The `scene-state-ushort` low/high-byte crib does NOT cleanly
  fit bytes 3..4.
- The record-to-block mapping / ordering basis. Grid-position order and
  effectId-ascending order are both consistent with the single captured
  preset, so neither can be asserted.

**Codec:** `buildQueryStates` / `isQueryStatesResponse` /
`parseQueryStatesResponse` in `src/gen2/axe-fx-ii/setParam.ts` return opaque
5-byte records (tag + four state septets + a packed 28-bit word) and
make no ordering or effectId commitment. Primitive entry:
[[ii-fn0e-query-states]].

**Status:** 🟡 structure measured, field semantics pending.

## 5e. fn 0x1F SYSEX_GET_ALL_PARAMS, bulk per-block param dump 🟢

**AxeEdit name:** `SYSEX_GET_ALL_PARAMS`. **Source:** Ghidra mining
. Hardware-verified  against XL+ Q8.02.

Returns every parameter on a single addressed block in one round-trip,
as an alternative to issuing N × fn 0x02 GET_BLOCK_PARAMETER_VALUE
reads. Lands in `fractal-midi/src/gen2/axe-fx-ii/` as a first-class bulk-read
path. Capture: `samples/captured/probe-axefx2-bulk-read.syx`.

**NOT channel-aware** (corrected 2026-05-25). fn=0x1F returns monolithic
block state regardless of fn=0x11 channel selection. For per-channel
reads, use fn=0x02 GET_BLOCK_PARAMETER_VALUE, which IS channel-aware.
Hardware-verified: writing distinct values to X and Y via fn=0x2e, then
reading fn=0x1F on both channels returns identical values; fn=0x02 GET
returns the correct per-channel values.

This is the bulk-read primitive for the monolithic block state. Useful for
backup, bulk audits, and per-position encoding calibration. For
per-channel preset snapshots, the reader falls back to per-param
fn=0x02 GET on the non-active channel.

See [`axeedit-opcode-table.md`](axeedit-opcode-table.md) for the
opcode entry; full byte-shape decode pending the next protocol-doc
sweep.

## 5e-write. State-broadcast triple as HOST-TO-DEVICE write (0x74/0x75/0x76) 🟢

**Status:** 🟢 hardware-verified 2026-05-25, XL+ Q8.02.

The same 0x74/0x75/0x76 envelope that the device emits as a broadcast and
returns in response to fn 0x1F is accepted BY the device as a write.
Bidirectional: host can read (fn 0x1F) and write (triple) using the same
encoding.

**Confirmed properties:**

- Works for all 21 tested block types (Amp, Drive, Delay, Reverb, Cab,
  Compressor, Chorus, Flanger, Phaser, Wah, Volume/Pan, Filter, Pitch,
  Graphic EQ, Parametric EQ, Multi Delay, Tremolo/Pan, Rotary, FX Loop,
  Enhancer, Formant).
- Full value array required (itemCount must equal the block's total position
  count). Partial writes (itemCount < total) are silently ignored.
- Both opFlag=0x01 and opFlag=0x00 accepted for writes.
- Performance: ~3 ms send for 236 values (6 SysEx frames). Full
  read-modify-write-verify cycle: ~331 ms.

**Critical constraints:**

- **NOT channel-aware.** The triple writes to the block's monolithic state
  array. fn=0x11 BLOCK_CHANNEL does not affect which channel the triple
  targets. For channel-correct writes, use fn=0x2e SET_PARAM_DIRECT +
  fn=0x11 per-param.
- **Encoding is per-position, not per-block.** Within a single block, some
  positions store wire16 values (0..65534), others store display-integer
  values, others are enum indices. The fn=0x1F response reveals each
  position's native encoding.

Probe scripts: `scripts/_research/probe-axefx2-state-write*.ts` (6 scripts).
Full findings recorded in the project's hardware-test log.
Primitive entry: `ii-state-broadcast-triple-write.md`.

## 5f. fn 0x47 SYSEX_GET_SYSINFO, extended device-info 🟡

**AxeEdit name:** `SYSEX_GET_SYSINFO`. **Source:** Ghidra mining
. Capture: `samples/captured/session-58-direct-sync.syx`.

Richer device-info exchange than fn 0x08 GET_FIRMWARE_VERSION (which
returns only the firmware version string). The fn 0x08 handshake gives
us model + firmware; fn 0x47 carries additional system metadata
(memory layout, hardware revision, license / feature flags, with exact
semantics undecoded).

**Observed frame (session-58-direct-sync.syx):**

```
f0 00 01 74 07 47 0a 02 3d 01 00 08 04 00 7d f7
                  └────── 8-byte payload ──────┘ ^cksum
```

Payload `0a 02 3d 01 00 08 04 00`, checksum `0x7d` (XOR-7F, verified).
The frame sits in the device-side cluster right after the fn 0x08
firmware response, so it reads as a device RESPONSE, not a host request.
Direction is inferred from stream position only: the .syx carries no USB
direction metadata, and the editor request side is not in this capture,
so the prior "request payload" label was direction-unconfirmed.

Payload byte index 1 = `0x02` is a constant shared with the AM4 fn 0x47
frame (likely a struct / protocol-version stamp). The remaining fields
are undecoded; the 384-preset count does not appear as an adjacent
septet pair, so II exposes no positional preset-count field here.

**Cross-device note (does NOT transfer):** AM4 fn 0x47 (model byte
`0x15`) is a 10-byte payload and exposes its 104-preset count at payload
offset +8 (value `0x68`); II (model byte `0x07`) is 8 bytes with no
positional preset-count field. The layout does not transfer across the
two model bytes; only the byte1 = `0x02` constant is shared.

**Direction confirmed (Q8.02).** Sending the no-payload request
`F0 00 01 74 07 47 45 F7` with the editor closed returns the 8-byte
payload `0a 02 3d 01 00 08 04 00` (cksum `7d`). So the 8-byte payload is
the device RESPONSE to a host request, not a request payload. The
earlier "request payload" labeling is corrected.

**Cheapest next probe:** repeat the request with single-byte selector
variants to see which of the 8 payload fields move (field semantics
beyond byte1 = `0x02` are still undecoded).

**Status:** wire byte confirmed via Ghidra; frame direction confirmed on
hardware (device response to a no-payload request); payload field
semantics undecoded.

## 5g. fn 0x16 SYSEX_GET_PARAM_INFO, per-parameter descriptor 🟢

**AxeEdit name:** `SYSEX_GET_PARAM_INFO`. **Source:** 
probe (2026-05-20), XL+ Q8.02. Raw capture and per-probe verdicts:
`samples/captured/probe-axefx2-new-opcodes-findings.md`.

Per-parameter metadata read. Companion to fn 0x02
`SET/GET_BLOCK_PARAMETER_VALUE` (which returns the current wire
value), this opcode returns a descriptor (range, default, units,
possibly display labels).

**Request shape:**

```
F0 00 01 74 07 16 [blockId_lo] [blockId_hi] [paramId_lo] [paramId_hi] [cksum] F7
```

Optional 4-byte zero-pad after the paramId pair matches the
`SYSEX_GET_MODIFIER_INFO` convention; both padded and unpadded forms
were tested and returned identical responses.

**Response shape:** 33-byte SysEx frame, 25-byte payload after the
`F0 00 01 74 07 16` 6-byte header, then `[checksum] F7`.

**Two samples captured (both AMP 1 = effectId 106):**

```
paramId=0  → 10 00 00 00 00 00 00 00 00 00 00 00 12 1c 04 00 00 00 7c 03 00 00 00 00 00
paramId=10 → 41 10 00 00 00 2c 0b 1f 39 03 0a 2e 0f 61 03 00 48 50 4b 04 00 00 00 00 00
```

**Decoded layout (byte-exact, round-trip + checksum verified, N=2):**

The 25-byte payload is **5 fixed groups of 5 wire bytes**. Each group
is one 32-bit native value packed as plain little-endian septets:

```
v = b0 | (b1<<7) | (b2<<14) | (b3<<21) | (b4<<28)   (low 32 bits used)
b_i = (v >> 7*i) & 0x7F
```

This is the 5-septet extension of the septet-14bit primitive (shift
table 0, 7, 14, 21, 28). It is **NOT** the AM4 sliding-window
`packFloat32LE`: 265.0 encodes plain-LE as `00 00 12 1c 04`
(`0x43848000`), whereas the AM4 packer would emit `00 20 10 44 18`.

**Group roles (offsets into the 25-byte payload):**

| Group | Offset | Type | Role |
|---|---|---|---|
| G0 | 0..4 | int32 | **default** value (NOT current; the live value is from fn 0x02) |
| G1 | 5..9 | float32 | min |
| G2 | 10..14 | float32 | for enums: value count; for continuous params: one range/scale extent |
| G3 | 15..19 | float32 | the other range/scale extent (frequently a `1.0` sentinel) |
| G4 | 20..24 | float32 | step / resolution (0 for enums) |

Roles pinned by a Q8.02 sweep of AMP paramIds 0..24 plus a fn 0x02
current-value cross-check (the earlier "G0 current, G2/G3 max-or-default,
G4 reserved" reading was corrected). See primitive
`ii-fn16-get-param-info` for the full sweep.

**Decoded values:**

- Enum paramId=0 (amp.effect_type): G0=16 (default index), G1 min=0.0,
  G2 count=265.0, G3=1.0, G4 step=0.
- Knob paramId=10 (amp.bright_cap): G0=2113 (default), G1=1e-5, G2=0.01,
  G3=1e6, G4 step=0.
- 0..10 display knobs (paramIds 1, 2, 3, 4, 5, 16, 19, 20): G0=50
  (default 5.0), G1=0.0, G2=`1.0` sentinel, G3=10.0 (display max),
  G4=0.001 step. fn 0x02 returns the differing live values (bass `4.55`).

Round-trip is byte-exact on both captured payloads; both frame
checksums verified (paramId=0 cksum `0x71`, paramId=10 cksum `0x59`;
standard XOR-7F over `F0`..last payload byte).

**RESOLVED on hardware (Q8.02 sweep, paramIds 0..24):**

- **G0 = default, not current.** All eight 0..10 knobs read G0=50 (5.0
  default) while fn 0x02 returns their differing live values.
- **G4 = step / resolution** (0.001 for 0..10 knobs), not reserved.
- **Enums put the value count in G2**, G3=1.0 (amp.effect_type 265,
  tone_stack paramId 34 = 109, paramId 14 = 3, 15 = 2, 18 = 12).

**STILL OPEN:**

- **G2/G3 internal-vs-display split for continuous params.** Which group
  holds the display max versus an internal extent is param-class
  dependent (one is often a `1.0` sentinel: 0..10 knob max is G3, a dB
  param max is G2). Labeling each needs a per-param display-range
  cross-ref.
- ~~**Enum count 265 vs catalog 259.**~~ RESOLVED (2026-06-09): the
  Axe-Edit `effectDefinitions_07.cache` (real-device sync) carries the
  complete amp table: 266 names, ordinals 0..265. It agrees with the
  shipped catalog at all 259 prior ordinals (0 mismatches) and supplies
  the 7 the wire dump lost to the receive cap: 259 FRIEDMAN BE C45,
  260 FRIEDMAN 2018, 261 PLEXI 2204, 262 FRIEDMAN HBEC45, 263 PORTA-BASS,
  264 SV BASS 2, 265 SKULL CRUSHER (now in `AMP_EFFECT_TYPE_VALUES`).
  The G2 "265" reading was the max ordinal. Cache grammar: see the
  primitive entry `editor-cache-section-record-grammar`.
  HARDWARE-CONFIRMED 2026-06-09: the post-reassembly-fix fn 0x28 re-run
  captured all 266 labels in one untruncated frame, 266/266 display-equal
  vs the catalog, 0 mismatches
  (samples/captured/probe-axefx2-enum-dump-findings.md).

Note that the float fields are firmware-internal DSP units for
non-display-mapped params; for display calibration the wire 0..65534
endpoints are still obtained separately.

**Status:** 🟢 for the layout (byte-exact verified) with the noted open
semantic labels. Primitive entry: [[ii-fn16-get-param-info]].

**Probe runner:** `scripts/_research/probe-axefx2-new-opcodes.ts`
(in `mcp-midi-control`). Decoder helper:
`scripts/_research/decode-fn16-param-info.ts` (prints per-offset
candidate decodings + pairwise diff).

## 5h. fn 0x28 SYSEX_GET_PARAM_STRINGS, enum-value label dump 🟢

**AxeEdit name:** `SYSEX_GET_PARAM_STRINGS`. **Source:** 
probe (2026-05-20), XL+ Q8.02. Raw capture:
`samples/captured/probe-axefx2-new-opcodes-findings.md`.

Runtime enum-value display strings for a `select`-type parameter.
Returns the full enum table as NULL-delimited 7-bit ASCII. Replaces
the need for hard-coded enum tables, the device itself emits the
display labels at whatever firmware revision is loaded.

**Request shape:**

```
F0 00 01 74 07 28 [blockId_lo] [blockId_hi] [paramId_lo] [paramId_hi] [cksum] F7
```

Optional 4-byte zero-pad after the paramId pair is accepted (mirrors
the `SYSEX_GET_MODIFIER_INFO` convention).

**Response shape:**

```
F0 00 01 74 07 28 [STR_0\0 STR_1\0 STR_2\0 ... STR_N\0] [cksum] F7
```

- 7-bit ASCII (no septet packing, letters / digits / space / dash
  / `+` all fit in `0x00..0x7F`).
- Each string is NULL-terminated (`0x00`).
- The device sends the full table in ONE SysEx message. The
  2026-05-20 capture stopped at 2048 bytes / ~154 amp-type strings
  because node-midi's WinMM backend fragments any SysEx longer than
  RT_SYSEX_BUFFER_SIZE (2048 bytes, `midi/binding.gyp`) into multiple
  `message` events, and our receive paths at the time dropped the
  continuation fragments (they don't start with F0). Root-caused +
  fixed 2026-06-09: the Axe-Fx II transport
  (`packages/fractal-gen2/src/midi.ts`) and the enum-dump probe now
  reassemble fragments via the shared `createSysExAssembler`
  (`packages/core/src/midi/transport.ts`), so the full ~3.5 KB
  266-entry amp table arrives intact. Re-run DONE on hardware
  2026-06-09: 266/266 labels in one untruncated frame, 0 mismatches
  vs the catalog. The 7 names past the old cap were independently
  recovered from the Axe-Edit `effectDefinitions_07.cache` first and
  confirmed by the re-run (see § 5g resolution note above).

**Validation against the wiki-sourced catalog (`AMP_EFFECT_TYPE_VALUES`):**

Compared 154 hardware-captured strings (paramId=0 = `AMP.TYPE`) to
the catalog's first 154 entries:

- ✅ 150 byte-exact matches
- ❌ 4 wiki transcription errors carried by the catalog:

| Wire idx | Hardware (Q8.02) | Catalog (wiki-sourced) | Note |
|---|---|---|---|
| 22 | `USA IIC+ BRIGHT` | `USA IIC+ BRight` | Wiki casing inconsistent |
| 44 | `CORNFED M50` | `CORNCOB M50` | Wiki MIDI_SysEx page has typo; Wiki Amp_models_list page correctly has CORNFED. Amp models a Cornford MK50 II ("Cornfed" → Cornford). |
| 45 | `CAROL-ANN OD-2` | `CA OD-2` | Wiki MIDI_SysEx page abbreviated to "CA"; full name on Amp_models_list page is CAROL-ANN. |
| 65 | `SV BASS 1` | `SV BASS` | Wiki dropped the trailing "1". |

These mismatches mean the agent could legitimately propose "CAROL-ANN
OD-2" (the device's true label, surfaced by `lookup_lineage` or other
public sources), have the wire write reject because the catalog only
recognises "CA OD-2", and bail or guess. Catalog should be patched to
match hardware ground truth.

**Action items:**

1. ~~Patch `AMP_EFFECT_TYPE_VALUES` (idx 22 / 44 / 45 / 65) to match
   hardware.~~ DONE earlier; validated 2026-06-09 by the post-fix
   re-run (266/266 device-emitted labels match the catalog).
2. Run a per-paramId fn 0x28 sweep on `AMP 1` to dump remaining
   enum-bearing knobs (input drive tonestack types, output trim
   modes, etc).
3. Run fn 0x28 across other placed blocks (`CAB`, `DRV`, `REV`,
   `DLY`, `CHO`, `PHA`, `FLG`) with their respective enum paramIds
   to extract every enum table the device exposes. **One probe
   sweep = full Rosetta-stone refresh of II enum vocabulary.**
4. ~~Re-write the probe to chain multiple SysEx frames so the full
   AMP_EFFECT_TYPE_VALUES set is captured in one run.~~ DONE
   2026-06-09: no chaining needed, the device already sends one big
   frame; the probe and the II transport now reassemble node-midi's
   2048-byte WinMM fragments (`createSysExAssembler`). Re-run
   `scripts/_research/probe-axefx2-enum-dump.ts` to confirm the full
   266-string table lands in one capture.

**Probe runner:** `scripts/_research/probe-axefx2-new-opcodes.ts`
(in `mcp-midi-control`). Decoders:
`scripts/_research/decode-fn28-enum-strings.ts` (extracts strings),
`scripts/_research/diff-fn28-vs-catalog.ts` (cross-references against
`fractal-midi/src/gen2/axe-fx-ii/params.ts`).

## 5i. fn 0x07 modifier read (field-indexed) 🟢

Hardware-decoded on Ares 2.00 (XL+, 2026-05-29). A modifier was assigned to
Amp 1 (effectId 106) Input Drive (paramId 1); AxeEdit's read of it was captured
passively (`samples/captured/probe-axefx2-modifier-path.jsonl`).

The modifier is read field-by-field over **fn 0x07**. Each device reply:

```
F0 00 01 74 07 07 [effId_lo effId_hi] [slot_lo slot_hi] [field_lo field_hi]
   [v0 v1 v2] [ASCII label ...] 00 [cs] F7
```

- effId/slot/field: 14-bit septet pairs (slot = modifier slot, observed 1).
- value: 16-bit, 3-septet `packValue16` (same as fn 0x02 param values).
- label: NUL-terminated 7-bit ASCII, the device-rendered display string.

| field | meaning | example |
|---|---|---|
| 0x00 | source (value = source index, label = name) | 1 "LFO 1A" |
| 0x01 / 0x02 | Min / Max (target-param units) | "0.00" / "10.00" |
| 0x03 / 0x04 / 0x05 / 0x06 | Start / Mid / End / Slope (%) | "0.0 %" .. |
| 0x07 | Damping (ms) | "10 ms" |
| 0x08 | target effectId (no label) | 106 = Amp 1 |
| 0x09 | target paramId (no label) | 1 = input_drive |
| 0x0a / 0x0b | bool toggles | "OFF" |
| 0x0c / 0x0d / 0x0e | percent / Scale / Offset | "1.000" / "0.0 %" |

Fields 0x00, 0x01/0x02, 0x08/0x09 are matched (0x08=106 and 0x09=1 decode to
the known Amp-1 Input-Drive target). 0x03..0x07 strongly identified by unit +
dialog order. 0x0a..0x0e back-half names proposed (the source-toggle reset the
envelope to defaults, so distinct values per field weren't captured).

Modifier-source enum (partial, from field 0x00 across toggles): 0 NONE,
1 LFO 1A, 4 LFO 2B, 5 ADSR 1, 26 SCENE 1, 27 SCENE 2. Full enumeration = a
field-0x00 sweep or fn 0x28 on MOD_CTRLID. Primitive: [[ii-fn07-modifier-read]].

## 6b. 0x14 GET_PRESET_NUMBER byte-ordering correction 🟢

**Wiki says:** the 0x14 response payload is `[bits 6-0, bits 13-7]`, LSB-first. **Q8.02 XL+ actually emits MSB-first**: `[bits 13-7,
bits 6-0]`, at least for the response side.

**Evidence:** session-61 passive capture, captured immediately after
AxeEdit saved the working buffer to slot 700:

```
F0 00 01 74 07 14 05 3B 28 F7    ← payload bytes: 05 3B
```

- **LSB-first decode** (per wiki): `0x05 + (0x3B << 7) = 5 + 7552 = 7557`
, impossible (XL+ user preset range is 0..767).
- **MSB-first decode**: `(0x05 << 7) + 0x3B = 640 + 59 = 699`, matches
  the founder's reported save target (front-panel display "slot 700"
  is wire preset 699 per the 0-vs-1-indexing finding ).

The wiki appears to be wrong about ordering for at least the response
side. The request side (0x3C SET_PRESET_NUMBER) hasn't been
disambiguated against hardware for `preset_number ≥ 128`; our
`buildSwitchPreset` currently emits LSB-first per wiki, only verified
on preset 0 where the orderings are indistinguishable. Open
item: verify 0x3C on a non-zero preset to either confirm
the wiki or correct it.

## 6. Preset binary format on the wire 🟢

Verified  by inspecting `samples/factory/Axe-Fx-II_XL+_Bank-A_Q8p02.syx`
via `scripts/inspect-axe-bank-syx.ts`:

### Bank file structure

A factory bank export is a flat concatenation of N presets, each preset
laid out as **1 header + 64 data chunks + 1 footer** = **66 messages**.
A bank file holds 128 presets (8448 messages, ~1.6 MB). The XL+ ships
3 factory banks (A / B / C), totaling 384 presets in the factory bundle
(of the device's 768-slot user capacity).

```
preset_dump = [
  F0 00 01 74 07 77 [bank] [preset] 00 20 [cs] F7    ← 12 bytes
  F0 00 01 74 07 78 [194-byte payload] [cs] F7        ← 204 bytes × 64 chunks
  F0 00 01 74 07 79 [3-byte payload] [cs] F7          ← 10 bytes
]
```

### Header payload semantics

| Bytes | Bank A first | Bank B first | Bank C first |
|-------|--------------|--------------|--------------|
| `payload[0]` | `0x00` | `0x01` | `0x02` |
| `payload[1]` | `0x00` | `0x00` | `0x00` |
| `payload[2]` | `0x00` | `0x00` | `0x00` |
| `payload[3]` | `0x20` | `0x20` | `0x20` |

`payload[0]` is the bank index. `payload[1]` is the preset index
within bank (`0x00..0x7F` for the 128 presets of each bank).
`payload[2..3]` = `00 20` are constants, purpose unverified, likely
a payload-size or magic-number field. The same constants appear on
AM4's `0x77` payload (`[bank A..Z, sub_index 0..3, 00, 20, 00]`)
suggesting a shared family layout where the constant bytes pad to a
fixed-width header.

### Preset name encoding

Visible at chunk #0, byte offset 8 of payload, in 3-byte triplets:
each character is one ASCII byte followed by two zero bytes. Examples
extracted from the factory bank:

- A001 = `"59 Bassguy"`
- B001 = `"Galaxy Formation"`
- C001 = `"Squashed"`

The two zero bytes following each character likely reserve space for
larger character sets (UTF-something) but are unused for ASCII. AM4
encodes preset names without this padding, the family format is not
identical at every level.

(2026-07-02 refinement: the "3-byte triplets" are the general word
encoding of the whole body: each triplet is one 16-bit native ushort,
`lo7 | mid7<<7 | (b2 & 0x03)<<14`, byte 2's high 5 bits reserved. The
name is simply words 2..33 of the de-framed image, one ASCII char per
word. See § 6b.)

### 6b. De-framed image layout: the TLV chain 🟢

**Decoded 2026-07-02.** De-framing the 64 × `0x78` chunk payloads
(each `[count=64 as 2 septets] + 64 × 3-byte words`) yields a fixed
4096-word image. Its structure, confirmed on **388/388 dumps** (384
factory presets, Q8.02 XL+ banks A/B/C, + 4 live hardware dumps:
`samples/captured/bk070-loop-amp-bass-2-baseline.syx`,
`samples/captured/hw132/{sentinel-eb-alpha,sentinel-eb-bravo,stored-slot-7}.syx`):

| Words | Content |
|---|---|
| 0 | format tag **2049** (388/388) |
| 2..33 | preset name, 1 ASCII char per word, 0-terminated |
| 36..129 | record table: stride 8, max 12 entries, `[block_id, flag, 0×6]`. **GRID / signal-chain order metadata**: ids ≥ 200 are unplaced/shunt placeholders never serialized. NOT a placed-block enumerator, NOT layout order (Test Crunch table order Comp,Drive,Amp,Cab,Delay,Reverb vs serialized Amp@132..Reverb@678) |
| 130.. | **TLV chain**: repeated `[wire_id, payload_len, payload...]`; `wire_id == 0` terminates |
| 2048.. | tone-match bulk region, ONLY when block 170 is in the chain (4/388); sits after the chain terminator; preserve verbatim |

TLV chain contents, in order (388/388):

1. **Modifier records**: `wire_id` = modifier slot 1..20, always
   `payload_len` 15, always before the first block TLV. 15-word
   payload layout undecoded, read-only.
2. **Effect blocks**, ALPHABETICAL by the AxeEdit canonical DISPLAY
   name, spaces/punctuation ignored ("Tremolo/Panner" sorts under T;
   "Multiband Compressor" precedes "Multi Delay"). Multi-instance
   blocks adjacent.
3. **System tail**: ordered subsequence of `[170 Tone Match,
   139 Noisegate, 140 Output, 142 Feedback Send, 143 Feedback Return,
   141 Controllers]`; 139/140/141 always present; Feedback Send/Return
   sit BETWEEN Output and Controllers.

**Param addressing** (a block TLV at word `i`):

```
paramBase        = i + 2
channel-X param p → word[paramBase + p]
channel-Y param p → word[paramBase + payload_len/2 + p]   (X/Y blocks; payload_len even)
```

BK-070 hardware anchors (Test Crunch, Amp TLV `[106, 236]` @ word 130
→ paramBase 132): the one-variable hardware diffs land at exactly
word 252 = 132+118+2 (amp.bass ch-Y, `bk070-loop-amp-bass-2-*`) and
word 255 = 132+118+5 (amp.master_volume ch-Y,
`bk070-loop-amp-master-vol-3-*`). `word[paramBase]` of the Amp TLV is
the amp-type ordinal ('59 Bassguy = 0 at word 149 on factory A000,
where one modifier record precedes the Amp TLV). Every BK-070
measured width = `payload_len + 2`; every measured X→Y offset =
`payload_len / 2` (Amp 118, Cab 39, Comp 20, Delay 70, Drive 21,
Reverb 45).

**Payload lengths are per-dump self-described and drift across
firmware**: the Q8.02 factory bank files carry Amp `payload_len` 234;
live Q8.02 hardware dumps carry 236. Never trust a static width
table; walk the chain of the dump in hand.

Decoder: `packages/fractal-gen2/src/presetImageTlv.ts`
(`deframePresetImage` / `parsePresetImage` / `getParamWord`). Golden +
corpus sweep: `scripts/verify-ii-preset-image-tlv.ts` (root
`test:codec`). Primitives: `ii-preset-image-tlv-chain` (+ corrections in
`block-record-stride-8`, `parambase-plus-paramid`). OPEN: modifier
15-word layout; per-block scene/bypass/X-Y state words inside
payloads; ids ≥ 200 semantics.

## 7. Block IDs (from wiki) 🟡

The wiki lists 70+ block IDs in the range 100..170 (effects) and
200..235 (shunts). Excerpt of the most-iconic blocks:

| ID | Block | Wiki group | XML name |
|----|-------|-----------|----------|
| 100, 101 | Compressor 1, 2 | CPR | Compressor |
| 102, 103, 160, 161 | Graphic EQ 1..4 | GEQ | GraphicEQ |
| 104, 105, 162, 163 | Parametric EQ 1..4 | PEQ | ParametricEQ |
| **106, 107** | **Amp 1, 2** | **AMP** | **Amp** |
| **108, 109** | **Cab 1, 2** | **CAB** | **Cab** |
| 110, 111 | Reverb 1, 2 | REV | Reverb |
| 112, 113 | Delay 1, 2 | DLY | Delay |
| 114, 115 | Multi Delay 1, 2 | MTD | MultiDelay |
| 116, 117 | Chorus 1, 2 | CHO | Chorus |
| 122, 123 | Phaser 1, 2 | PHA | Phaser |
| 124, 125 | Wah 1, 2 | WAH | Wah |
| 130, 153 | Pitch 1, 2 | PIT | Pitch |
| 133, 134 | Drive 1, 2 | DRV | Drive |
| 141 | Controllers | CONTROLLERS | Controllers |
| 144, 145 | Synth 1, 2 | SYN | Synth |
| 169 | Looper | LPR | Looper |
| 170 | Tone Match | TMA | _(no XML, Tone Match is recipe-driven, no editor surface)_ |

Multiple instances per block (e.g. Amp 1 / Amp 2) reflect that an
Axe-Fx II preset can have two of each block in its 4×12 grid. AM4
has only one amp slot; XL+ has two.

Full table at `founder-private notes`,
section "Axe-Fx II MIDI SysEx: Block IDs".

## 8. Per-block parameter tables (wiki) 🟡

The wiki documents per-block parameter tables with `(block, paramId,
name, type, options/range, modifier-assignable, fw-added)` columns
for every block group (CPR / GEQ / PEQ / AMP / CAB / REV / DLY / MTD /
CHO / FLG / ROT / PHA / WAH / FRM / VOL / TRM / PIT / FIL / DRV / ENH /
FXL / INPUT / OUTPUT / CONTROLLERS / SYN / GTE / RNG / LPR / SND / RTN /
MIX / MBC / XVR / MGT). These are the wire-IDs needed to implement
`buildSetParam` / `buildReadParam`, the closest analogue to AM4's
hand + generated `KNOWN_PARAMS`.

Highlights from the AMP table (Quantum 8.02):

- 259 amp models in the EFFECT TYPE enum (param 0): from `0: 59 BASSGUY`
  through `258: 5F1 TWEED EC`.
- 108 entries in the TONE STACK enum (param 34): `ACTIVE`, `DEFAULT`,
  `BROWNFACE`, `BLACKFACE`, ...
- ~75 first-page + advanced knobs, covers everything the Axe-Edit
  XML's Amp `<EditorControl>` rows reference.

Cross-validation between the XML catalog and wiki tables is the
checkable path for `paramName ↔ paramId` mapping: where both sources
list a parameter on the same block, the XML's `parameterName` symbol
+ the wiki's `(block, paramId)` identify the same wire entry.

**Status:** generator landed.
`scripts/extract-axe-fx-ii-params.ts` joins the wiki HTML and the XML
catalog and emits `src/fractal/axe-fx-ii/params.ts` (929 params,
72% XML join rate). Regenerate via `npm run extract-axe-fx-ii-params`.
Every entry stays 🟡 wiki-documented; hardware verification
would promote to 🟢.

## 9. Parameter value encoding 🟢

Per wiki section "MIDI SysEx: obtaining parameter values":

- **0-65534 range (Axe-Fx II), unlike Standard/Ultra's 0-254.**
- Encoded as 3 septets `[XX YY ZZ]`:
  - `XX` = bits 0-6 of the value
  - `YY` = bits 7-13
  - `ZZ` = bits 14-15 (top 2 bits, padded into a 7-bit byte)

Encoder/decoder code samples in the wiki C++ snippets. AM4's
`src/fractal/shared/packValue.ts` is the reference implementation
for the same family of bit-packing.

## 9b. Per-block calibration: Compressor (STUDIO COMP) 🟢

**Hardware-verified 2026-05-27, XL+ Ares 2.00.** fn=0x02 GET responses
with ASCII display strings in the response tail (bytes after offset 18).

The II compressor block uses different display ranges than the AM4
compressor. AM4 calibration entries MUST NOT be copied to II verbatim.

| Param | AM4 range | II range | Scaling | II evidence |
|---|---|---|---|---|
| threshold | -60..+20 dB | -80..0 dB | linear | Wire 47512 = "-22.0 dB", wire 32767 = "-40.0 dB" |
| ratio | 1..20 | 1..20 | log10 | Wire 30326 = "4.000" |
| attack | 0.1..100 ms | 1..100 ms | log10 | Wire 32767 = "10.00 ms" |
| release | 2..2000 ms | 10..1000 ms | log10 | Wire 32767 = "100.0 ms" |

Log10 formula: `display = min * (max / min) ^ (wire / 65534)`.
Linear formula: `display = min + (max - min) * (wire / 65534)`.

Primitive entry: [[ii-compressor-calibration-divergence]].

## 10. What this leaves blocked

Hardware-free work this consolidates unlocks:

- ✅ **Axe-Fx II `blockTypes.ts`**: : generated from wiki Block IDs
  table. 71 entries with `id`, `name`, `groupCode`, `canBypass`,
  `availableOnAX8`. See `src/fractal/axe-fx-ii/blockTypes.ts`.
- ✅ **Axe-Fx II `params.ts`**: : generated from wiki
  per-block parameter tables joined with the XML catalog's
  `parameterName` symbols (case-insensitive label match).
  929 parameters across 34 wiki groups, 669 (72%) joined to XML
  symbols. Includes inlined enum tables (e.g. `AMP_EFFECT_TYPE_VALUES`
  with 259 amp models), type-applicability gates from XML, and
  per-param wiki provenance (`wikiName`, `fwAdded`, `modifierAssignable`).
  See `src/fractal/axe-fx-ii/params.ts`. Regenerator:
  `npm run extract-axe-fx-ii-params`.
- ✅ **`setParam.ts` encoder**: : hand-written GET/SET_BLOCK_
  PARAMETER_VALUE envelope (function 0x02) with the wiki's 3-septet
  16-bit value packing, default modelByte 0x07 (XL+) and override for
  Mark I/II / XL / AX8. Byte-exact goldens in
  `scripts/verify-axe-fx-ii-encoding.ts` (in `npm test`).
- **Bank file parser**: replay or modify factory presets via the same
  `0x77 / 0x78 / 0x79` codepath AM4 uses (`src/fractal/am4/safety/backup.ts`
  + `src/fractal/am4/factoryBank.ts` are the analogues).

Hardware-blocked:

- **Live Axe-Edit ↔ device USBPcap capture** to confirm wiki-documented
  function IDs land on Quantum 8.02 firmware and decode any that the
  wiki marks "?".
- **Per-parameter unit/range/scaling rules**: the wiki gives min/max
  and step for some entries but not the display-unit conversion for
  log-curve params (frequency, time, etc.). AM4's
  `typeApplicability.ts` + `cacheParams.ts` learnt these per-knob via
  hardware spotchecks; same path applies.
- **Save/load semantics**: does sending a captured bank dump back over
  the wire actually persist on Axe-Fx II XL+? AM4 confirmed yes via
  ; XL+ is unverified.

See the project's local hardware-tasks queue for the work order.
