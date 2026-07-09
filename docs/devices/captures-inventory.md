# Captures inventory: what we already have

> **Read this BEFORE asking the founder for more captures.** Hardware
> capture is expensive (founder time, founder-only); existing captures
> are zero cost. A real cautionary case: an agent once proposed a
> 70-minute, 21-capture plan for an atomic-read decode without first
> checking `samples/captured/`. The inventory below already contained
> 5+ captures directly relevant to that decode (`session-23-*` scene
> diffs, `session-58-*` AxeEdit sync flow, `session-51-export-preset`
> preset-dump request), plus 384 factory presets for natural diffs.
> The 21-capture plan was scrapped.
>
> **Mental model:** captures + Ghidra binary mining are the two
> hardware-free decode lanes. Exhaust both before queuing new founder
> work.

## Top-level directories

| Path | Tracked by git? | Content |
|---|---|---|
| `samples/captured/` | gitignored | All raw captures (`.pcapng`, `.syx`). 169 files, ~50+ session IDs. |
| `samples/captured/decoded/` | gitignored | Ghidra dumps, capture-derived JSON, intermediate analysis. |
| `samples/factory/` | gitignored | Official factory preset banks per device. |

Everything under `samples/` is local-only. Captures are NEVER committed
to git: they're often >100 MB each and contain firmware sequences.
Decode results that distill captures into structured data (param
tables, opcode maps, byte-shape docs) DO get committed under
`docs/devices/<device>/` once verified.

## Capture index by device

### Axe-Fx II XL+ (Q8.02 firmware, model byte `0x07`)

**AxeEdit "Read from Axe-Fx" sync flow** (primary atomic-read
material, file prefix `session-58-`):

| File | Direction | Content |
|---|---|---|
| `session-58-direct-sync.syx` | both | Full AxeEdit-initiated sync. fn 0x08 â†’ fn 0x47 (SYSEX_GET_SYSINFO) â†’ fn 0x20 grid â†’ fn 0x0E SYSEX_QUERY_STATES (whole-preset block-state read: device emits one frame tiling into fixed 5-byte records, one per placed non-shunt block, field semantics hardware-pending; the atomic per-block read primitive is fn 0x1F SYSEX_GET_ALL_PARAMS, not fn 0x0E) â†’ fn 0x18 × 24 per-block modifier polls â†’ fn 0x15 × 768 preset names â†’ fn 0x12 × 1217 cab names. The 0x0E request payload is 11 chunks × 5 bytes per [`fractal-midi/docs/devices/axe-fx-ii/axeedit-opcode-table.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/axe-fx-ii/axeedit-opcode-table.md). |
| `session-58-knob-turn.syx` | both | One AMP 1 knob nudged. Contains the 0x74/0x75/0x76 state-broadcast triple with 236 16-bit values (full AMP 1 state). Decoder ships at `scripts/_research/decode-axefx2-chunk.ts`. |
| `session-58-grid-move.syx` | both | One block moved on the grid. State-broadcast triple for the moved block (140 values, target=Delay 1). |
| `session-58-block-add.syx` | both | One block added. State-broadcast triple for the new block (9 values, Volume/Pan 1). |
| `session-58-preset-change.syx` | both | Preset switch: NO state-broadcast triples emitted. Confirms reads don't trigger broadcasts. |

**Scene + channel + bypass diffs** (multi-scene state changes,
file prefix `session-23-`):

| File | Setup |
|---|---|
| `session-23-scene-2-amp-bypass.pcapng` | scene 2 amp toggled bypassed |
| `session-23-scene-2-amp-channel-b.pcapng` | scene 2 amp channel Aâ†’B |
| `session-23-scene-2-amp-unbypass.pcapng` | scene 2 amp toggled engaged |
| `session-23-scene-3-amp-channel-c.pcapng` | scene 3 amp channel Aâ†’C |
| `session-23-scene-3-drive-bypass.pcapng` | scene 3 drive toggled |
| `session-23-scene-4-amp-channel-d.pcapng` | scene 4 amp channel Aâ†’D |
| `session-23-scene-4-reverb-bypass.pcapng` | scene 4 reverb toggled |

These are AM4-shape captures (A/B/C/D channels). For II, the
session-58 state-broadcast captures cover X/Y channel + bypass via
the 0x74 triple: different envelope, same per-block-edit signal.

**Preset export / dump traffic:**

| File | Content |
|---|---|
| `session-51-export-preset.pcapng` | AxeEdit File â†’ Export of a preset. Contains the actual 0x77/0x78/0x79 preset-dump exchange. Use to decode the request payload + extract a sample preset binary. |
| `samples/factory/Axe-Fx-II_XL+_Bank-{A,B,C}_Q8p02.syx` | 384 factory presets × 66 messages each = 25,344 SysEx frames. Used to confirm 0x77/0x78/0x79 envelope shape. Natural variation across presets gives diff-style decode without controlled captures. |

**Param-value calibration** (sessions 04-46):

| Sessions | Block coverage |
|---|---|
| 04-06 | gain, bass, drive level, delay time, reverb mix, drive type |
| 08-09 | amp gain channel A vs B, channel toggle a/b/c/d sequences |
| 18 | block types per family (chorus, compressor, drive, delay, enhancer, filter, flanger, gate, geq, peq, phaser, reverb, rotary, tremolo, volpan, wah) plus block channel Aâ†”B, preset/scene rename, switch_preset, switch_scene |
| 23 | scene-specific channel + bypass (above) |
| 29 | amp.master, amp.depth, amp.presence, amp.output_level, amp.out_boost_toggle, delay.feedback, flanger.feedback, phaser.feedback, reverb size variants |
| 30 | basic param sweeps across chorus / comp / delay / drive / flanger / phaser / reverb / tremolo |
| 31, 32, 33, 34 | expert pages: comp jfet, drive expert, enhancer/filter/flanger/gate extended, inputgate, slotgate |
| 40, 41 | amp expert (cabinet, poweramp, preamp, speaker), chorus/delay/geq/peq/rotary/wah expert |
| 42 | read-probe baseline |
| 43-46 | channel probe, compressor expert, q16 sanity, gate expert, volpan expert variants, drive expert (blackglass, pifuzz), front-panel bypass behavior, am4edit baseline |

**Grid + routing** (capture batch, file prefixes `session-64-` to
`session-71-`):

| Sessions | Content |
|---|---|
| 64, 65 | autoroute + routing probe behavior |
| 68 | scene broadcast, click-connect, fn 0x06 routing probes, routing pre-state |
| 69, 70, 71 | click-to-connect, routing inâ†’out, slot 666 routing probes (fn 0x06 = SET_CELL_ROUTING decoded from these) |

**Levels + scene MIDI** (sessions 84-87):

| File | Content |
|---|---|
| `session-84-levels.pcapng` | global level adjustments |
| `session-84-routing-mix-midi.pcapng` | routing + mix MIDI |
| `session-85-scene-midi.pcapng` | scene MIDI capture |
| `session-86-scene-midi-disambiguate.pcapng` | scene disambiguation captures |
| `session-87-scene-midi-test-buttons.pcapng` | test-button scene captures |

### Modern Fractal family (gen-3): Axe-Fx III `0x10` / FM3 `0x11` / FM9 `0x12`

One shared codec; a capture from any member helps the others. The III is the
byte-identity anchor; the first real gen-3 hardware captures are FM9 (community,
2026-06-03).

**Axe-Fx III:**

| File | Content |
|---|---|
| `samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06/Axe-Fx_III_BANK_{A,B,C}-*.syx` | 3 factory banks × 128 presets each = 384 III presets in 18-message envelope. Envelope-shape confirmation. Body is Huffman-compressed per Fractal Forum #159885. |
| `samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06/Axe-Fx_III_ALL-BANKS-*.syx` | Same 384 presets in one file. |

No III *hardware* captures exist yet: everything III-side is byte-anchored from the
v1.4 spec, the factory banks, Axe-Edit III binary mining, and public II-sourced
SET captures. The III community RE work (Fractal Forum thread #159885, archived in
the maintainer's private notes (gitignored), 1304 lines) is the primary external
decode source. See [`fractal-midi/docs/devices/axe-fx-iii/preset-format-research.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/axe-fx-iii/preset-format-research.md).

**FM9 (FW 11.00, community captures 2026-06-03):**

| File | Content |
|---|---|
| `samples/captured/fm9-reverb-mix-readback-community-2026-06-03.pcapng` | Panel-driven readback. Decoded the gen-3 READ path: `fn=0x1F` poll → `0x74/0x75/0x76` positional whole-block broadcast (record index i == device-true paramId i). Shipped as gen-3 `get_param`. |
| `samples/captured/fm9-reverb-type-medroom-to-medspring-2026-06-03.pcapng` | Single reverb-type change. Byte-anchored the WRITE leg: typed `fn=0x01 sub=0x09` SET carries the **raw enum id** (524 = "Medium Spring"), distinct from the read ordinal (16); enum count 79 via the 60B echo. |
| `samples/captured/fm9-capture3-enum-sweep-2026-06-03.pcapng` (37,947 frames) | Attempted enum-label sweep + 6 typed SETs (reverb/amp/drive). Confirmed the write envelope on hardware, but **proved the dropdown-open does NOT make the editor fetch labels over the wire** (zero enum strings in the whole capture). Retires the "open each block" sweep plan. |
| `samples/captured/fm9-152-super-duos2-exported-2026-06-03.syx` (24,680 B) | Exported preset. Decoded the gen-3 whole-preset binary: `0x77` head + 8× `0x78` body + `0x79` tail, plaintext 16-bit words (0xaa55 magic, ASCII name from word4), NOT compressed. Written from editor memory, so it proves FORMAT only. |
| `samples/captured/fm9-fw/` | FM9 DSP firmware image. Re-decoded with the correct MSB-first septet unpack: entropy 6.5, sectioned/compressed, no plain strings. Enum labels live here but behind an unidentified decompressor (S4 fallback lane). |
| `samples/captured/fm9-amp-balance-0-to-neg100-*-2026-06-04.pcapng` (66 MB, 27,772 FM9 frames) | Controlled single-edit: amp block Balance dragged 0 → −100 in the editor (Preset 433, Scene S03). Byte-anchored the **continuous-param SET** (`fn=0x01 sub=0x52`, eff 58 = ID_DISTORT1, paramId 2 = `DISTORT_PAN`, 5-septet LE float32 normalized, 0.5 = center) + the 60-byte value-echo. Adversarially validated (5 refuters + synth, all confirmed). **Headline:** decoded the `0x75` broadcast as **channel-blocked**: `index = channel × stride + paramId`, `stride = itemCount/4` (DISTORT 588 = 147×4). Balance changed only index 149 = 1×147+2 (channel B); A/C/D copies constant. The old `values[paramId]` read was silently channel-A-only; gen-3 `get_param` now projects the correct channel (channel-aware read shipped). See the maintainer's private session notes + SYSEX-MAP. |

No FM3 captures exist (model `0x11`, implemented but unconfirmed on hardware).

### Still needed (gen-3): what to ask III / FM9 / FM3 owners for

Priority order (re-swept 2026-06-04 against current state). Full contributor-facing
instructions in [`packages/fractal-midi/docs/capture-guides/`](../../packages/fractal-midi/docs/capture-guides/); the detailed tester protocol lives in the maintainer's private session notes.

1. **III / FM3 hardware confirmation (probe + chat report). TOP: genuinely open.** Any
   III or FM3 owner running the probe + a `get_param`/`set_param` round-trip on real
   hardware. Both have ZERO hardware captures; the shared gen-3 codec (and the server
   poll→burst read) is only inferred to apply to them. Highest value because it is the
   one thing nothing else can substitute for, and it's the easiest contributor action.
2. **Set-by-name: three number spaces, and the AMP is the exception that still NEEDS a
   capture.** Per a multi-agent converged enum-mine analysis: **ordinal**
   (read index, from the `0x75` broadcast / XML value-lists), **name** (AM4 `cacheEnums.ts`
   arrays indexed by ordinal, joined in `enumOverlay.ts`), and **raw-id** (write value).
   - For **most blocks** (reverb/delay/chorus/flanger/phaser/wah/comp/geq/filter/tremolo/
     enhancer/gate) the read `{ordinal→name}` join is **already offline** (AM4 effectType
     overlays are valid), so reads label correctly; only the write `{ordinal→raw-id}` is
     missing (it is NOT in the XML, a non-constant permutation, so it needs wire captures;
     partial table `GEN3_ENUM_ORDINAL_TO_RAW_ID` holds reverb {16:524, 45:529}).
   - For the **AMP (`DISTORT_TYPE`) and drive (`FUZZ_TYPE`)** the AM4 name table is INVALID
     (`enumOverlay.ts:262`: FM9 amp ordinals 65/179/264 exceed AM4's list, names disagree),
     so the model selector ships UNLABELED; names are NOT offline. Only 3 FM9 amp ordinals
     have names (264=SV Bass 1, 65=SV Bass 2, 179=Texas Star Clean). **The amp model roster
     therefore needs a real capture**: the "getBlockString amp-roster sweep" the code waits
     on. This is the single highest-value gen-3 capture: it binds device-true amp names AND
     captures the write raw-ids, closing set-amp-by-name.
   - **Method (corrected, the NAME does NOT cross the wire).** SELECT each model one at a
     time in the editor (NOT just open the dropdown; opening is INERT). Each SELECT puts the
     **raw-id (SET)** on the wire and triggers a `0x75` broadcast (ordinal), but the editor
     holds names locally and never sends them: `getBlockString` never fires; capture3
     (37,947 frames) had **zero** label strings. The name comes from the human, but via a
     **SCREENSHOT, not transcription**: screenshot the full model list (in order), then select
     each option top-to-bottom in that same order. Wire gives raw-ids in selection order;
     screenshot gives names in list order; same order ⇒ positional join `name[i] ↔ raw-id[i]`
     (the per-select `0x75` ordinal is an independent cross-check). We read the screenshots, so
     the tester types nothing. Read↔write is a non-constant permutation, so partial captures
     only pin the models actually selected (no transform), but partial is useful per-model. Amp
     roster ~280 (the selecting is the work; screenshots cover names cheaply). **Drive/FUZZ is
     the quick win:** if FM9 ordinals match AM4 `DRIVE_TYPES` (names offline) it needs no
     screenshot, just the raw-ids. The full tester protocol lives in the maintainer's
     private session notes.
3. **Receive-preset-from-device: FM9 DONE; III/FM3 still open.** FM9 closed 2026-06-04
   (harp `fm9-receive-preset-from-device-*`, live `0x77/0x78/0x79` dump captured). For
   III/FM3 it's still open: a Fractal-Bot "Receive" of one preset, to confirm the shared
   dump on those devices. Medium value (the format is decoded from the FM9 stream).
4. **Amp param-value calibration (display ranges).** Not a capture, derived in software
   by AM4 symbol-name join. Listed here only so it isn't confused with a hardware ask.
5. **Second exported preset** (different preset) to diff the `0x77` head version field.
   Low priority; only ask if already in hand. We already have one FM9 export.
6. **Amp knob sweep → confirm the channel-blocked read model. OPTIONAL CONFIRMATION.**
   The `0x75` broadcast layout is now SOLVED from data in hand: it is channel-blocked,
   `index = channel × stride + paramId`, `stride = itemCount/4` (validated N=2: DISTORT
   588 = 147×4, REVERB 292 = 73×4; balance changed only index 149 = 1×147+2). The
   channel-aware `get_param` read is shipped, so this capture is **no longer required**:
   it would only raise confidence from N=2 params to N=8 (each knob's channel copies land
   at `channel × stride + paramId`). Downgraded to optional belt-and-suspenders (six
   isolated single-knob amp drags: Drive `DISTORT_DRIVE` 11, Bass 12, Mid 13, Treble 14,
   Master 15, Presence 30). See SYSEX-MAP + the maintainer's private session notes.

> Already answered, do NOT re-ask: gen-3 READ path, the typed-SET write envelope
> (now also the **continuous mouse-drag SET** via the 2026-06-04 balance capture), and
> the exported-preset file format are all decoded (above). The old "single knob turn"
> and "open the dropdowns" asks are retired (the latter re-proven inert by the
> 2026-06-04 enum-label-sweep capture: 7,352 frames, zero SET writes, zero names).

### AM4 (model byte `0x15`)

| File | Content |
|---|---|
| `samples/factory/AM4-Factory-Presets-1p01.syx` | 104 factory presets × 4 messages each. Used as ground truth for AM4 preset-binary decode ([`fractal-midi/docs/devices/am4/preset-binary-format-research.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/am4/preset-binary-format-research.md)). |
| `samples/captured/A01-original.syx` + `A01-clean-{a,b}.syx` + `A01-gain-plus-1.syx` | Same preset slot (A01) at different states: controlled-diff captures showing what 1-byte changes look like in the preset binary. These are the closest analogue we have to the captures I almost asked for; for AM4 they unblocked the preset-binary decode. |
| `session-59-am4-*.syx` | AM4-Edit sync flow: idle, preset switch, scene switch, block bypass, block type swap, param change. The AM4 analogue of session-58. |
| `session-46-am4edit-*.syx` | AM4-Edit launch + reverb + firmware refresh captures. |
| `session-95-am4-global-pidlow.pcapng` | AM4 GLOBAL family pidLow discovery capture. |

## Ghidra mining (no captures needed)

We have an existing Ghidra project alongside the editors with
`Axe-Edit.exe` already auto-analyzed. The .exe contains significant
decode material:

- **94-opcode SYSEX_* table** with internal enum values → wire byte
  via the +1 offset ([`fractal-midi/docs/devices/axe-fx-ii/axeedit-opcode-table.md`](https://github.com/TheAndrewStaker/fractal-midi/blob/main/docs/devices/axe-fx-ii/axeedit-opcode-table.md)).
- **Param symbol pool** (1,125 strings via the string-walk script
  `MineAxeEditIIParamResolver.java`).
- **Direct paramIdâ†”name table** (1,113 entries via
  `SeekParamTablesII.java`).
- **Block-layout XML** (extracted from BinaryData via the JUCE-zip
  pattern, lives under `samples/captured/decoded/binarydata/`).

The scripts/ghidra/ directory has 30+ Ghidra GhidraScript .java files
covering AM4-Edit, AxeEdit II, AxeEdit III; each has a companion CMD
launcher. The SysEx-core opcode-table mining added 7 new scripts to
that pack.

**ROI:** the full opcode table was mined in ~30 minutes of wall time
across 6 iterative scripts. That's ~80 wire opcodes nailed to display
names without any hardware activity. By contrast the proposed
21-capture decode would have taken 70 minutes of founder time AND
likely failed (preset binary is Huffman-compressed).

## How to find captures relevant to a specific decode

```bash
# Free-text grep in the inventory
grep -i "scene" docs/devices/captures-inventory.md
grep -i "channel.*y" docs/devices/captures-inventory.md

# Inspect a specific capture's frame distribution
npx tsx -e "
  const fs=require('fs');
  const buf=fs.readFileSync('samples/captured/SESSION-FILE');
  const counts={};
  let i=0;
  while (i<buf.length) {
    if (buf[i]!==0xF0) {i++; continue;}
    const start=i; let j=i+1;
    while (j<buf.length && buf[j]!==0xF7) j++;
    if (j>=buf.length) break;
    if (j-start+1>=7 && buf[start+1]===0x00 && buf[start+2]===0x01 && buf[start+3]===0x74) {
      const model = buf[start+4], fn = buf[start+5];
      const key = 'model=0x' + model.toString(16) + ' fn=0x' + fn.toString(16);
      counts[key] = (counts[key]||0)+1;
    }
    i = j+1;
  }
  console.log(counts);
"

# Decode a state-broadcast triple
npx tsx scripts/_research/decode-axefx2-chunk.ts samples/captured/SESSION-FILE
```

## When to ask for new captures

Before queuing founder time, confirm ALL of:

1. **No existing capture matches**: grep the table above + the actual
   directory.
2. **No Ghidra script can produce the same data**: string tables,
   opcode maps, param descriptors all come from the .exe.
3. **The wire envelope IS known to vary in a way that can't be
   deduced from existing material**: e.g. a brand-new firmware
   feature, or a wire byte that's never been observed.

When #1-3 all hold, propose ONE focused capture that maximally
disambiguates. The rule of thumb: the smallest useful new capture
should answer at least 5× more questions than the sum of
existing-capture re-inspection would.

If a capture turns out to be needed, file it as an entry in your local
hardware-task notes (the maintainer keeps these per device, gitignored) with:

- Exact step-by-step founder workflow.
- The single question the capture answers.
- The expected file output path.
- Why no existing capture answers the question.
