# Captures inventory — what we already have

> **Read this BEFORE asking the founder for more captures.** Hardware
> capture is expensive (founder time, founder-only); existing captures
> are zero cost. The Session 103 retrospective: an agent proposed a
> 70-minute, 21-capture plan for BK-070 without first checking
> `samples/captured/`. The inventory below already contained 5+
> captures directly relevant to that decode (`session-23-*` scene
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
to git — they're often >100 MB each and contain firmware sequences.
Decode results that distill captures into structured data (param
tables, opcode maps, byte-shape docs) DO get committed under
`docs/devices/<device>/` once verified.

## Capture index by device

### Axe-Fx II XL+ (Q8.02 firmware, model byte `0x07`)

**AxeEdit "Read from Axe-Fx" sync flow** (session 58 — primary BK-070
material):

| File | Direction | Content |
|---|---|---|
| `session-58-direct-sync.syx` | both | Full AxeEdit-initiated sync. fn 0x08 → fn 0x47 (SYSEX_GET_SYSINFO) → fn 0x20 grid → fn 0x0E SYSEX_QUERY_STATES (THE atomic state read) → fn 0x18 × 24 per-block modifier polls → fn 0x15 × 768 preset names → fn 0x12 × 1217 cab names. The 0x0E request payload is 11 chunks × 5 bytes per `docs/devices/axe-fx-ii/axeedit-opcode-table.md`. |
| `session-58-knob-turn.syx` | both | One AMP 1 knob nudged. Contains the 0x74/0x75/0x76 state-broadcast triple with 236 16-bit values (full AMP 1 state). Decoder ships at `scripts/_research/decode-axefx2-chunk.ts`. |
| `session-58-grid-move.syx` | both | One block moved on the grid. State-broadcast triple for the moved block (140 values, target=Delay 1). |
| `session-58-block-add.syx` | both | One block added. State-broadcast triple for the new block (9 values, Volume/Pan 1). |
| `session-58-preset-change.syx` | both | Preset switch — NO state-broadcast triples emitted. Confirms reads don't trigger broadcasts. |

**Scene + channel + bypass diffs** (session 23 — multi-scene state changes):

| File | Setup |
|---|---|
| `session-23-scene-2-amp-bypass.pcapng` | scene 2 amp toggled bypassed |
| `session-23-scene-2-amp-channel-b.pcapng` | scene 2 amp channel A→B |
| `session-23-scene-2-amp-unbypass.pcapng` | scene 2 amp toggled engaged |
| `session-23-scene-3-amp-channel-c.pcapng` | scene 3 amp channel A→C |
| `session-23-scene-3-drive-bypass.pcapng` | scene 3 drive toggled |
| `session-23-scene-4-amp-channel-d.pcapng` | scene 4 amp channel A→D |
| `session-23-scene-4-reverb-bypass.pcapng` | scene 4 reverb toggled |

These are AM4-shape captures (A/B/C/D channels). For II, the
session-58 state-broadcast captures cover X/Y channel + bypass via
the 0x74 triple — different envelope, same per-block-edit signal.

**Preset export / dump traffic:**

| File | Content |
|---|---|
| `session-51-export-preset.pcapng` | AxeEdit File → Export of a preset. Contains the actual 0x77/0x78/0x79 preset-dump exchange. Use to decode the request payload + extract a sample preset binary. |
| `samples/factory/Axe-Fx-II_XL+_Bank-{A,B,C}_Q8p02.syx` | 384 factory presets × 66 messages each = 25,344 SysEx frames. Used Session 53 to confirm 0x77/0x78/0x79 envelope shape. Natural variation across presets gives diff-style decode without controlled captures. |

**Param-value calibration** (sessions 04-46):

| Sessions | Block coverage |
|---|---|
| 04-06 | gain, bass, drive level, delay time, reverb mix, drive type |
| 08-09 | amp gain channel A vs B, channel toggle a/b/c/d sequences |
| 18 | block types per family (chorus, compressor, drive, delay, enhancer, filter, flanger, gate, geq, peq, phaser, reverb, rotary, tremolo, volpan, wah) plus block channel A↔B, preset/scene rename, switch_preset, switch_scene |
| 23 | scene-specific channel + bypass (above) |
| 29 | amp.master, amp.depth, amp.presence, amp.output_level, amp.out_boost_toggle, delay.feedback, flanger.feedback, phaser.feedback, reverb size variants |
| 30 | basic param sweeps across chorus / comp / delay / drive / flanger / phaser / reverb / tremolo |
| 31, 32, 33, 34 | expert pages: comp jfet, drive expert, enhancer/filter/flanger/gate extended, inputgate, slotgate |
| 40, 41 | amp expert (cabinet, poweramp, preamp, speaker), chorus/delay/geq/peq/rotary/wah expert |
| 42 | read-probe baseline |
| 43-46 | channel probe, compressor expert, q16 sanity, gate expert, volpan expert variants, drive expert (blackglass, pifuzz), front-panel bypass behavior, am4edit baseline |

**Grid + routing** (session 64-71):

| Sessions | Content |
|---|---|
| 64, 65 | autoroute + routing probe behavior |
| 68 | scene broadcast, click-connect, fn 0x06 routing probes, routing pre-state |
| 69, 70, 71 | click-to-connect, routing in→out, slot 666 routing probes (Session 70 found fn 0x06 = SET_CELL_ROUTING) |

**Levels + scene MIDI** (sessions 84-87):

| File | Content |
|---|---|
| `session-84-levels.pcapng` | global level adjustments |
| `session-84-routing-mix-midi.pcapng` | routing + mix MIDI |
| `session-85-scene-midi.pcapng` | scene MIDI capture |
| `session-86-scene-midi-disambiguate.pcapng` | scene disambiguation captures |
| `session-87-scene-midi-test-buttons.pcapng` | test-button scene captures |

### Axe-Fx III (model byte `0x10`)

| File | Content |
|---|---|
| `samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06/Axe-Fx_III_BANK_{A,B,C}-*.syx` | 3 factory banks × 128 presets each = 384 III presets in 18-message envelope. Used Session 56 for envelope-shape confirmation. Body is Huffman-compressed per Fractal Forum #159885. |
| `samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06/Axe-Fx_III_ALL-BANKS-*.syx` | Same 384 presets in one file. |

The III community RE work (Fractal Forum thread #159885 archived at
`docs/_private/fractal-forum-text.txt`, 1304 lines) is the primary
external decode source. See `docs/devices/axe-fx-iii/preset-format-research.md`.

### AM4 (model byte `0x15`)

| File | Content |
|---|---|
| `samples/factory/AM4-Factory-Presets-1p01.syx` | 104 factory presets × 4 messages each. Used as ground truth for AM4 preset-binary decode (`docs/devices/am4/preset-binary-format-research.md`). |
| `samples/captured/A01-original.syx` + `A01-clean-{a,b}.syx` + `A01-gain-plus-1.syx` | Same preset slot (A01) at different states — controlled-diff captures showing what 1-byte changes look like in the preset binary. These are the closest analogue we have to the captures I almost asked for; for AM4 they unblocked the preset-binary decode in Session 18. |
| `session-59-am4-*.syx` | AM4-Edit sync flow: idle, preset switch, scene switch, block bypass, block type swap, param change. The AM4 analogue of session-58. |
| `session-46-am4edit-*.syx` | AM4-Edit launch + reverb + firmware refresh captures. |
| `session-95-am4-global-pidlow.pcapng` | HW-112 capture — AM4 GLOBAL family pidLow discovery (closed Session 96). |

## Ghidra mining (no captures needed)

We have an existing Ghidra project at `C:\Users\Steph\ghidra-axe-edit`
with `Axe-Edit.exe` already auto-analyzed. The .exe contains
significant decode material:

- **94-opcode SYSEX_* table** with internal enum values → wire byte
  via the +1 offset (`docs/devices/axe-fx-ii/axeedit-opcode-table.md`,
  decoded Session 103).
- **Param symbol pool** (1,125 strings via Session 83's
  `MineAxeEditIIParamResolver.java`).
- **Direct paramId↔name table** (1,113 entries via Session 94's
  `SeekParamTablesII.java`).
- **Block-layout XML** (extracted from BinaryData via the JUCE-zip
  pattern, lives under `samples/captured/decoded/binarydata/`).

The scripts/ghidra/ directory has 30+ Ghidra GhidraScript .java files
covering AM4-Edit, AxeEdit II, AxeEdit III; each has a companion CMD
launcher. Session 103 added 7 new scripts targeting the SysEx core.

**ROI:** Session 103 mined the full opcode table in ~30 minutes of
wall time across 6 iterative scripts. That's ~80 wire opcodes nailed
to display names without any hardware activity. By contrast the
proposed 21-capture decode would have taken 70 minutes of founder
time AND likely failed (preset binary is Huffman-compressed).

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

1. **No existing capture matches** — grep the table above + the actual
   directory.
2. **No Ghidra script can produce the same data** — string tables,
   opcode maps, param descriptors all come from the .exe.
3. **The wire envelope IS known to vary in a way that can't be
   deduced from existing material** — e.g. a brand-new firmware
   feature, or a wire byte that's never been observed.

When #1-3 all hold, propose ONE focused capture that maximally
disambiguates. The Session 103 retrospective rule: the smallest
useful new capture should answer at least 5× more questions than the
sum of existing-capture re-inspection would.

If a capture turns out to be needed, file it as a `HW-NNN` entry in
the appropriate `docs/_private/HARDWARE-TASKS-<DEVICE>.md` with:

- Exact step-by-step founder workflow.
- The single question the capture answers.
- The expected file output path.
- Why no existing capture answers the question.
