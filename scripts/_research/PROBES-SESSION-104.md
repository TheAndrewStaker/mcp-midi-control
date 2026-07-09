# Ghidra opcode-table follow-up probe pack

> Probes written 2026-05-20 following the AM4-Edit and Axe-Fx II
> Ghidra opcode-table dumps. Each probe is heavily documented
> inline; this README orients you to the pack as a whole.

## What this pack tests

The AM4-Edit Ghidra mining recovered the full 47-entry
`MESSAGE_*` action-code table for the AM4's 0x01 PARAM_RW dispatcher.
6 of the 47 actions are already wired in fractal-midi/am4; the
remaining 41 are unverified candidates. This probe pack tests the
unverified ones live on hardware.

Earlier Axe-Fx II Ghidra work also surfaced several wire bytes that
were documented in `axeedit-opcode-table.md` but never probed live.
This pack also exercises those.

## What's in each script

| Script | What it does | Safety |
|---|---|---|
| `probe-am4-action-reads.ts` | Hits 15 unused AM4 GET-style action codes (0x0F GET_PARAM_INFO, 0x10 GET_KNOBVALUE, 0x11 GET_STR, 0x19 GET_VAL, 0x1A GET_VAL_AND_STR, 0x1D GET_PATCH_NAME_BY_NUM, 0x1E GET_ALL_SCENE_NAMES, 0x1F GET_PATCH, 0x20 GET_GRID_INFO, 0x25 GET_EFFECT_AVAIL, 0x26 GET_MODIFIER, 0x2B GET_METER, 0x2C GET_SPI_ADC, 0x30 GET_EFFECT_INUSE, 0x31 GET_SCENE_NAME_BY_NUM) with multiple addressing variants. ~25 requests total. | 🟢 Read-only |
| `probe-am4-action-writes.ts` | Tests SET-style action codes (0x02 SET_NORM, 0x03 INCR, 0x04 INCR_COARSE, 0x05 DECR, 0x06 DECR_COARSE, 0x07 TOGGLE, 0x08 DEFAULT, 0x09 DEFAULT_PARAM, 0x0A SET_PARAM, 0x18 EXECUTE, 0x1C RECALL_PATCH, 0x2D COPY_CHANNEL, 0x2E COPY_SCENE, 0x32 SWAP_SCENES, 0x22 PLACE_EFFECT, 0x23 RESET_EFFECT). Gated to Z04 scratch; baseline+verify reads per probe. | 🔴 Mutates working buffer, gated behind `--writes` flag |
| `probe-am4-meter.ts` | Polls action 0x2B (MESSAGE_GET_METER) at 20 Hz for 5 seconds while you play through the AM4. Tracks per-byte variance to detect live signal. | 🟢 Read-only |
| `probe-axefx2-new-opcodes.ts` | Hits unprobed Axe-Fx II wire bytes from the Ghidra opcode mining (fn 0x16 GET_PARAM_INFO, fn 0x28 GET_PARAM_STRINGS, fn 0x48 FSGRID, fn 0x47 payload variations, fn 0x0E with various payloads). | 🟢 Read-only (write fn 0x0C SET_GRID gated behind `--include-writes`) |

## Run order

Recommended sequence, least invasive first:

### 1. Close the editors

Both probes pollute their inbound stream if AM4-Edit / AxeEdit III
is running concurrently. Close them.

### 2. AM4 read probe (safe)

```bash
npx tsx scripts/_research/probe-am4-action-reads.ts
```

Wall time: ~60 s. Walks ~25 read variants. Output:
- `samples/captured/probe-am4-action-reads.syx` (raw bytes)
- `samples/captured/probe-am4-action-reads-findings.md` (analysis)

**What to look for**: a per-action verdict table at the end.
🟢 responsive opcodes are the new wire paths we can implement.
🔴 silent opcodes either aren't supported on AM4 firmware v2.00 or
need different addressing.

### 3. AM4 meter probe (safe, requires guitar)

Plug in your guitar, then:

```bash
npx tsx scripts/_research/probe-am4-meter.ts
```

Wall time: ~10 s (5 s probe + setup). PLAY through the AM4 during
the 5 s window. Output:
- `samples/captured/probe-am4-meter-findings.md`

**What to look for**: at the end, the per-byte variance analysis.
If the bytes vary > 0 with audio activity, the meter is live.

### 4. Axe-Fx II new-opcode probe (safe)

```bash
npx tsx scripts/_research/probe-axefx2-new-opcodes.ts
```

Wall time: ~25 s. Walks ~10 fn-byte variants. Output:
- `samples/captured/probe-axefx2-new-opcodes.syx`
- `samples/captured/probe-axefx2-new-opcodes-findings.md`

**What to look for**:
- fn 0x16 GET_PARAM_INFO responding would unlock device-side param
  introspection (saves us hardcoding ranges).
- fn 0x28 GET_PARAM_STRINGS responding would let us read enum
  display strings from the device (e.g., AMP.TYPE names) instead
  of bundling them at build time.

### 5. AM4 write probe (destructive, gated)

DO THIS LAST. Make sure Z04 contains scratch / nothing precious.

Dry run first (no writes, prints planned actions):
```bash
npx tsx scripts/_research/probe-am4-action-writes.ts
```

Live writes (tier 1+2):
```bash
npx tsx scripts/_research/probe-am4-action-writes.ts --writes
```

Tier 3 (grid + scene manipulation, most destructive):
```bash
npx tsx scripts/_research/probe-am4-action-writes.ts --writes --writes-tier3
```

Wall time: ~30-45 s with all writes enabled. Output:
- `samples/captured/probe-am4-action-writes.syx`
- `samples/captured/probe-am4-action-writes-findings.md`

After this probe, the AM4 working buffer will be in an unknown
state; load Z04 from the front panel or AM4-Edit to start fresh.

## After running

For each 🟢 responsive opcode in the findings, the next step is to:

1. Open the findings markdown.
2. Read the raw bytes of the response.
3. Decode the wire shape (hdr4 = payload length, packed payload, etc.).
4. Update `fractal-midi/docs/devices/am4/am4edit-action-table.md`
   (or `fractal-midi/docs/devices/axe-fx-ii/SYSEX-MAP.md`) with the
   confirmed wire shape + a capture reference.
5. If the opcode unlocks a useful MCP capability, file an MCP task
   to wire a builder/parser in fractal-midi and expose via the
   unified tool surface.

## Expected per-opcode unlock summary

Before running, here's what we hope to learn from each:

### AM4 reads

- **0x0F GET_PARAM_INFO**: per-param descriptor. If responsive, we
  can stop hardcoding ranges/units in `params.ts` and read them from
  the device at boot.
- **0x10 GET_KNOBVALUE**: front-panel knob position. If distinct
  from wire value, we get "user is touching the knob" detection.
- **0x11 GET_STR**: short formatted display string. Saves us
  formatting display values ourselves.
- **0x19 GET_VAL / 0x1A GET_VAL_AND_STR**: alternate value-read
  shapes. May be more efficient than 0x0E short read.
- **0x1D GET_PATCH_NAME_BY_NUM**: alternate to existing action 0x12
  (MESSAGE_GET_STRING). Decode the difference.
- **0x1E GET_ALL_SCENE_NAMES**: bulk scene-name read. Reduces scene
  discovery from 4 round-trips to 1 (~75% wire reduction).
- **0x1F GET_PATCH**: full preset binary read. If it returns the
  0x77/0x78/0x79 stream WITH a location target, we can read stored
  presets without switching (closes a long-standing decode gap).
- **0x20 GET_GRID_INFO**: grid layout via dispatcher. Compare to
  fn 0x20 top-level; may carry extra info.
- **0x25 GET_EFFECT_AVAIL**: which effect types are available.
  Useful for "what could I place here" UX.
- **0x26 GET_MODIFIER**: modifier graph read. AM4 has limited
  modifier support but this is the wire path.
- **0x2B GET_METER**: DSP audio level. If live, enables real-time
  level monitoring (UX nice-to-have).
- **0x2C GET_SPI_ADC**: hardware diagnostic. Mostly informational.
- **0x30 GET_EFFECT_INUSE**: slot occupancy summary.
- **0x31 GET_SCENE_NAME_BY_NUM**: single scene name.

### AM4 writes

- **0x02 SET_NORM**: normalized 0..1 write. Cleaner than current
  display→internal conversion for clients that already have
  normalized values.
- **0x03/0x04/0x05/0x06 INCR/DECR family**: nudge value up/down.
  Unlocks "turn the gain up a little" UX without computing the
  target value client-side.
- **0x07 TOGGLE**: clean bypass-flip. Replace current write-0/1
  pattern.
- **0x09 DEFAULT_PARAM**: reset to factory. Useful for "start over
  on this param" UX.
- **0x18 EXECUTE**: generic command trigger.
- **0x1C RECALL_PATCH**: alternate preset load. May be cleaner /
  more atomic than current float-write to pidHigh=0x000A.
- **0x22 PLACE_EFFECT**: place block into slot programmatically.
  Currently we don't expose this; would unlock signal-chain UX.
- **0x23 RESET_EFFECT**: reset all block params to default.
- **0x2D COPY_CHANNEL**: copy block channel state (A→B etc.).
- **0x2E COPY_SCENE**: copy scene state.
- **0x32 SWAP_SCENES**: atomic scene swap.

### Axe-Fx II

- **fn 0x16 GET_PARAM_INFO**: same potential as AM4 0x0F.
- **fn 0x28 GET_PARAM_STRINGS**: device-side enum strings. Would
  let us drop the static `AMP_TYPES` / `DRIVE_TYPES` tables from
  fractal-midi/gen2/axe-fx-ii and ask the device.
- **fn 0x48 FSGRID**: informational.
- **fn 0x47 SYSINFO payload decode**: understand each of the 8
  payload bytes' role.
- **fn 0x0E QUERY_STATES payloads**: scope the inventory.

## After all findings are reviewed

Each 🟢 responsive opcode becomes a follow-up task in fractal-midi
to:
1. Implement the codec builder + parser.
2. Add a verify-msg golden from the captured bytes.
3. (Optional) wire into the MCP tool surface.

Each 🟡 ack-only opcode is filed as a "what does this do" research
item; likely needs a different addressing variant or payload.

Each 🔴 silent opcode is filed as "not supported on this firmware /
not the right wire shape" and de-prioritized.

## Files this produces

```
samples/captured/
├── probe-am4-action-reads.syx                    # raw bytes
├── probe-am4-action-reads-findings.md            # per-action verdict + decode prompts
├── probe-am4-action-writes.syx
├── probe-am4-action-writes-findings.md
├── probe-am4-meter-findings.md
├── probe-axefx2-new-opcodes.syx
└── probe-axefx2-new-opcodes-findings.md
```

All `samples/captured/` files are gitignored; they're local
research scratch.
