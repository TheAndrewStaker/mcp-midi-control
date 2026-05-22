# Fractal Preset Schema — shipped contract

**Status: shipped.** v0.1 contract (BK-051, Session 63, 2026-05-11) +
v0.4 routing extensions (BK-054, Session 76, 2026-05-14). The runtime
types live in `packages/core/src/protocol-generic/types.ts:PresetSpec`
and the device-level translations in each device's descriptor under
`packages/<device>/src/descriptor/`. Hardware-verified end-to-end on
AM4 + Axe-Fx II XL+ (live launch-verify 24/24); BK-054 cross-row
cabling audited via golden + audition test against live Axe-Fx II.

This document is the canonical reference for "a Fractal preset" — one
shape that covers every Fractal guitar processor:

- **AM4** (linear, 4 slots, A/B/C/D channels, 4 scenes) — shipped
- **Axe-Fx II / II XL / II XL+** (4×12 grid, X/Y channels, 8 scenes) — shipped
- **Axe-Fx III** (4×14 grid, A/B/C/D channels, 8 scenes) — schema-ready; descriptor pending (BK-015 community beta)
- **FM9** (4×14 grid, A/B/C/D channels, 8 scenes) — schema-ready; descriptor pending
- **FM3** (4×4 grid, A/B/C/D channels, 8 scenes) — schema-ready; descriptor pending

Hydrasynth and other non-Fractal devices are **out of scope** — their
domain model differs enough (NRPN modulation matrix, patch-based
architecture, no scenes) that forcing them into a Fractal shape would
hurt more than it helps. They stay on the generic `PresetSpec` already
shipped, with their own descriptor-level translation.

## Why this matters

The founder's framing: "the integration API IS the schema."

Today, the unified `apply_preset` accepts a single `PresetSpec` shape
that's the lowest common denominator across AM4 + grid devices. It
works for v0.1 linear-row-2 chains. But the eventual goal — parallel
chains, FX loops, stereo splits, the full grid editing experience
AxeEdit ships — requires expressing topology richer than "slots in
order."

This schema is the design choice that unlocks Level 4 routing
(parallel paths, multi-row merges) while keeping AM4 callers
unchanged.

---

## Domain model — six axes

Every Fractal preset varies along these six axes:

| Axis | What it is | AM4 | Axe-Fx II | Axe-Fx III / FM9 / FM3 |
|---|---|---|---|---|
| **Block placement** | Where each block sits in the signal path | 4 fixed slots | 48 cells (4×12) | 56–64 cells (4×14 to 4×16) |
| **Block instances** | Multiple of the same type per preset? | No (1 per type) | Yes (Amp 1, Amp 2, …) | Yes |
| **Channels** | Per-block parameter variations | 4 letters (A/B/C/D) | 2 letters (X/Y) | 4 letters (A/B/C/D) |
| **Routing** | Signal flow between blocks | Implicit linear | Explicit per-cell input mask | Explicit per-cell input mask |
| **Scenes** | Performance snapshots picking channels + bypass | 4 scenes | 8 scenes | 8 scenes |
| **Metadata** | Preset name, scene names | 32-char ASCII | 32-char ASCII | 32-char ASCII |

The schema needs to accommodate every axis without inflating the
linear case beyond what it actually needs.

---

## The proposed shape

```typescript
/**
 * A Fractal preset — the data Claude builds in `apply_preset(spec)`.
 *
 * One shape across all Fractal devices. Per-device descriptors
 * translate it into device-native wire ops; fields irrelevant to a
 * given device are silently ignored (AM4 ignores grid coords; linear
 * devices ignore the routing array; etc.).
 */
interface FractalPreset {
  /**
   * Optional ASCII-printable preset name (≤32 chars). Padded with
   * spaces on the wire. Omitting it leaves whatever the slot's
   * current name is (typically the previous preset's name on the
   * working buffer).
   */
  name?: string;

  /**
   * Every block placed in this preset. Empty list = clear all slots
   * (working buffer becomes silent). Order doesn't matter for
   * placement — each block carries its own `slot`. Order DOES matter
   * for routing inference in `chain` mode (see below).
   */
  blocks: FractalBlock[];

  /**
   * Optional explicit routing edges. Grid devices use this to author
   * parallel chains, FX loops, multi-row merges. Linear devices
   * (AM4) silently ignore it — the order of `blocks[].slot` IS the
   * routing.
   *
   * When `routing` is omitted on a grid device, the descriptor
   * computes the implicit linear-chain routing across blocks in the
   * same row (current Level 1 behavior). When you supply `routing`,
   * the descriptor uses it verbatim and skips inference.
   */
  routing?: RoutingEdge[];

  /**
   * Per-scene state. Up to N scenes (4 on AM4, 8 on Axe-Fx II/III).
   * Scenes reference blocks by their `id` field. A scene that doesn't
   * touch a block inherits the block's defaults.
   */
  scenes?: Scene[];

  /**
   * Which scene the device sits on after the build. 1-indexed. Use
   * this so the user immediately hears the scene they care about
   * (e.g. scene 1 for the song's opening section).
   */
  landing_scene?: number;
}

interface FractalBlock {
  /**
   * Stable identifier for this block within the preset. Used by
   * `routing` and `scenes` to reference this specific block. If
   * omitted, the descriptor generates one from `block_type +
   * instance` (e.g. `amp_1`, `drive_2`). Provide explicitly when
   * you have two instances of the same type and want predictable
   * names — `id: 'rhythm_amp'` / `id: 'lead_amp'`.
   */
  id?: string;

  /**
   * The block type/group. Lowercase slug per the device's
   * `block_aliases` table (e.g. `amp`, `compressor`, `reverb`,
   * `drive`, `cab`, `delay`). Call `describe_device({port})` to see
   * the device's supported types.
   */
  block_type: string;

  /**
   * Instance number (1-indexed). Defaults to 1. Only meaningful on
   * grid devices that support multiple instances per type (Axe-Fx
   * II/III have "Amp 1" + "Amp 2", AM4 has just "the amp"). AM4
   * silently ignores `instance` ≠ 1 with an error if you try
   * `instance: 2` on a single-instance type.
   */
  instance?: number;

  /**
   * Where this block lives in the signal path.
   *   - On linear devices: `number` (1..4 for AM4) = slot position.
   *   - On grid devices: `{ row, col }` (1-indexed). 1-D `number`
   *     accepted as shorthand for `{ row: 2, col: N }` (current
   *     Level 1 row-2 convenience).
   */
  slot: number | { row: number; col: number };

  /**
   * Initial bypass state for this block. Scenes can override
   * per-scene. Default false (engaged).
   */
  bypassed?: boolean;

  /**
   * Block parameters in display units. Two named fields, never
   * both on the same slot:
   *
   *   - `params: { gain: 5, bass: 6 }` — FLAT map for non-channel
   *     blocks (filter, chorus, comp, ...) or for the active channel
   *     of a channel block.
   *   - `params_by_channel: { A: { gain: 5 }, B: { gain: 8 } }` —
   *     PER-CHANNEL map for multi-channel authoring on channel
   *     blocks. Channel letters are device-specific: AM4 = A/B/C/D,
   *     Axe-Fx II = X/Y, Axe-Fx III/FM = A/B/C/D.
   *
   * Setting both `params` and `params_by_channel` on the same slot
   * is rejected at preflight (T-5, 2026-05-21). Earlier nested-in-
   * params (`{A: {...}}`) shorthand was accepted via a zod union;
   * pass that shape via `params_by_channel` now.
   *
   * Values are display units (knob 0..10, dB, ms, %); enum dropdowns
   * accept the canonical name as a string ("Plexi 100W High") or
   * the wire index as a number.
   */
  params?: ParamMap;
  params_by_channel?: Record<ChannelLetter, ParamMap>;
}

interface RoutingEdge {
  /** Source block's `id` (or auto-generated `<block_type>_<instance>`). */
  from: string;
  /** Destination block's `id`. */
  to: string;
  /**
   * Add the cable (default) or remove it. Removing edges is for
   * surgical routing tweaks; whole-preset builds typically don't
   * need `connect: false`.
   */
  connect?: boolean;
}

interface Scene {
  /** Scene number (1-indexed). 1..4 on AM4, 1..8 on Axe-Fx II/III/FM. */
  index: number;
  /** Optional scene name (≤32 chars). Some devices don't expose scene-name writes; descriptor ignores when unsupported. */
  name?: string;
  /**
   * Per-block channel selection for this scene. Keys are block ids.
   * Block ids absent from the map inherit the block's default channel.
   */
  channels?: Record<string, ChannelLetter>;
  /**
   * Per-block bypass state for this scene. Keys are block ids.
   * Block ids absent from the map inherit the block's default bypass.
   */
  bypassed?: Record<string, boolean>;
}

type ParamMap = Record<string, number | string>;
type ChannelLetter = string; // 'A'..'D' on AM4/III, 'X'|'Y' on Axe-Fx II
```

---

## How it translates per device

### AM4 (linear)

A 4-block clean preset:

```jsonc
{
  "name": "Clean Vox",
  "blocks": [
    { "block_type": "compressor", "slot": 1 },
    { "block_type": "amp",        "slot": 2,
      "params": { "type": "Class-A 30W TB", "gain": 4, "master": 6, "treble": 7 } },
    { "block_type": "cab",        "slot": 3 },
    { "block_type": "reverb",     "slot": 4,
      "params": { "type": "Spring, Medium", "mix": 25 } }
  ],
  "scenes": [
    { "index": 1, "channels": { "amp": "A" }, "bypassed": { "compressor": false } },
    { "index": 2, "channels": { "amp": "B" }, "bypassed": { "compressor": true } }
  ],
  "landing_scene": 1
}
```

AM4 descriptor:
- Reads each block's `slot: 1..4` as the linear position
- Ignores `instance` (errors if anything but 1)
- Ignores `routing` if present (linear is implicit)
- Walks `scenes[]` and writes per-scene channel + bypass via the
  switch-write-switch-back pattern
- `params: { gain: 5 }` → flat map; writes to the currently-active
  channel on channel blocks (or the sole register on non-channel
  blocks). `params_by_channel: { A: {gain:5}, B: {gain:8} }` is the
  multi-channel form (T-5, 2026-05-21): the writer walks each channel

### Axe-Fx II (grid, row-2 linear chain — Level 1)

Same preset, expressed for Axe-Fx II:

```jsonc
{
  "name": "Clean Vox",
  "blocks": [
    { "block_type": "compressor", "slot": 1 },
    { "block_type": "amp",        "slot": 2,
      "params": { "X": { "input_drive": 4, "master_volume": 6, "treble": 7 } } },
    { "block_type": "cab",        "slot": 3 },
    { "block_type": "reverb",     "slot": 4,
      "params": { "X": { "type": "Spring, Medium", "mix": 25 } } }
  ],
  "scenes": [
    { "index": 1, "channels": { "amp": "X" } },
    { "index": 2, "channels": { "amp": "Y" } }
  ],
  "landing_scene": 1
}
```

Axe-Fx II descriptor:
- Reads `slot: number` as shorthand for `{ row: 2, col: number }`
- Auto-extends with shunts on cols N+1..12, auto-cables row 2
- No `routing` array → linear row-2 chain inferred
- Channel letters X/Y validated; A/B rejected

### Axe-Fx II — parallel chain (Level 4)

A wet/dry split: comp → splits to dry path AND wet path with delay+reverb, then merges:

```jsonc
{
  "name": "Wet/Dry Lead",
  "blocks": [
    { "id": "comp",   "block_type": "compressor", "slot": { "row": 2, "col": 1 } },
    { "id": "amp",    "block_type": "amp",        "slot": { "row": 2, "col": 2 },
      "params": { "X": { "input_drive": 7, "master_volume": 5 } } },
    { "id": "cab",    "block_type": "cab",        "slot": { "row": 2, "col": 3 } },
    { "id": "delay",  "block_type": "delay",      "slot": { "row": 1, "col": 4 },
      "params": { "X": { "mix": 100, "time": 350 } } },
    { "id": "reverb", "block_type": "reverb",     "slot": { "row": 3, "col": 4 },
      "params": { "X": { "mix": 100 } } },
    { "id": "mixer",  "block_type": "mixer",      "slot": { "row": 2, "col": 5 } }
  ],
  "routing": [
    { "from": "comp",  "to": "amp" },
    { "from": "amp",   "to": "cab" },
    { "from": "cab",   "to": "delay" },
    { "from": "cab",   "to": "reverb" },
    { "from": "cab",   "to": "mixer" },
    { "from": "delay", "to": "mixer" },
    { "from": "reverb","to": "mixer" }
  ]
}
```

The descriptor:
- Places each block at its explicit `{ row, col }`
- For each `routing` edge, derives the dst cell's input mask by
  OR-ing bits for each src row that feeds it
- Sends one `fn 0x06 SET_CELL_ROUTING` per edge
- The `mixer` block ends up with `routing_mask = 0x05` (bits 0 + 2,
  receives from rows 1 and 3 of prev col) → merges the three sources

### Axe-Fx III (when added)

Same schema as Axe-Fx II, just with:
- 4 channels A/B/C/D instead of X/Y
- 4×14 grid instead of 4×12
- Different block-type catalog (more block groups, different effectId space)

All of this is descriptor concerns — the schema doesn't change.

---

## What this replaces / extends

**Current shape (`src/protocol/generic/types.ts:PresetSpec`):**

```typescript
interface PresetSpec {
  slots: Array<{ slot: SlotRef; block_type: string; params?: ...; bypassed?: boolean; }>;
  scenes?: Array<{ scene: number; channels?: ...; bypassed?: ...; name?: string; }>;
  landingScene?: number;
  name?: string;
}
```

**The gaps:**

1. **No `instance` field** — can't address `Amp 2` distinctly from `Amp 1`.
2. **No `routing` array** — grid devices can only do row-2 linear chains.
3. **No block `id`** — scenes reference blocks by `block_type` string,
   which collides on multi-instance presets.
4. **No `routing` semantics for cross-row cables** — parallel chains,
   FX loops, stereo splits all blocked.

**Migration plan:**

- Add `instance?: number`, `id?: string` to slot/block entries.
- Add `routing?: RoutingEdge[]` at top level.
- Use block `id` (or auto-derived from `block_type + instance`) in
  scene maps. Back-compat: existing scenes that use `block_type` slug
  keys (e.g. `bypassed: { drive: true }`) continue working when there's
  only one instance — the descriptor falls back to slug lookup.
- Rename `slots` → `blocks` (conceptually clearer — `slot` is the
  POSITION, not the thing). Keep `slots` as a back-compat alias for
  one release cycle. Same for `scenes[].scene` → `scenes[].index`.

The changes are additive at the type level. Existing AM4 + Axe-Fx II
linear callers (slot 608, 609, all prior tests) continue working
unchanged.

---

## Why the founder's instinct is right

> "this is what the integration API actually is."

A few reasons this design IS the API:

1. **It's the contract the LLM sees.** Tool descriptions paste this
   shape into the agent's context window. The shape's clarity
   directly determines whether the agent picks the right blocks /
   slots / channels / scenes when building a preset from natural
   language.

2. **It's the contract that propagates to every device.** Adding
   FM9 or Axe-Fx III is a descriptor that accepts FractalPreset and
   translates to device-native ops. The schema doesn't change per
   device — only the descriptor's wire layer does.

3. **It's the contract files / setlists / version-controlled tone
   libraries use.** A YAML / JSON file of FractalPreset shapes IS
   the user's tone library. They can commit it to git, share it,
   export it to AxeEdit-compatible format, anything.

4. **It's the contract that survives the wire-protocol decoding.**
   Wire protocols change between firmware revisions (Q8.02 → Quantum
   10.0 — different SysEx envelopes). The schema is firmware-
   independent; per-device descriptors absorb the wire churn.

A well-designed FractalPreset shape is the senior-engineering moat:
new devices = new descriptors, not new tools. New routing topologies
= same shape, descriptor handles. New firmware = wire-layer fix,
schema unchanged.

---

## Open questions

1. **Do we expose a higher-level `chain: BlockRef[]` shorthand for
   the common linear case?** Pro: ergonomic for AM4 + Level 1 Axe-Fx
   II users. Con: two ways to do the same thing. Recommended: NO —
   the descriptor's automatic linear-chain inference (when `routing`
   omitted) is enough.

2. **How does flat `params` interact with multi-channel devices?**
   AM4's "active channel" is whatever the user last selected on the
   device. If a caller passes flat `params: { gain: 5 }` without
   specifying channel, the descriptor writes to whatever's active,
   which may not be what the caller intended. When the caller needs
   a specific channel, pass `params_by_channel: { A: { gain: 5 } }`
   instead. T-5 split (2026-05-21) made the two fields distinct so
   the shape is unambiguous at the schema layer.

3. **Should `routing` be allowed on linear devices?** If a caller
   accidentally passes `routing` to AM4, do we error or silently
   ignore? Recommended: error with a clear message ("routing edges
   are not applicable on linear devices; AM4 routes implicitly by
   slot order"). Silent ignore hides bugs.

4. **Scene-name writes on Axe-Fx II.** Currently undecoded. The
   schema accepts `scenes[].name`; the descriptor throws
   `capability_not_supported` when called against a device that
   can't write scene names. Recommended: schema accepts it
   universally; descriptor surfaces the error.

5. **Multi-block-type aliases.** AM4's "GEQ" vs "Graphic EQ" — same
   thing, different names. Resolved at the descriptor's
   `block_aliases` map. Schema is canonical; descriptor handles
   spelling.

---

## What this enables in v0.4

With FractalPreset shipped:

- **Parallel chains** (wet/dry, doubled drives merging at a mixer)
- **FX loops** (send on row 1, return on row 3)
- **Stereo splits** (L on row 1, R on row 3, merge at OUTPUT)
- **Multi-amp presets** (Amp 1 on row 2 col 4, Amp 2 on row 4 col 4,
  blended at a mixer)
- **Setlist files as version-controlled YAML** (one shape across all
  Fractal gear; portable between AM4 and Axe-Fx II for compatible
  blocks)
- **Authoring tools that round-trip** (export AxeEdit preset →
  FractalPreset → reimport)

---

## Shipped — implementation milestones

All milestones below shipped through Session 76 (2026-05-14):

1. ✅ `PresetSpec` extended with `instance`, `id`, `routing` fields
   (back-compat preserved). Lives in
   `packages/core/src/protocol-generic/types.ts:265-363`.
2. ✅ Descriptor translators wired for AM4 + Axe-Fx II XL+. AM4 rejects
   `routing[]` + `instance≠1` (linear device contract); Axe-Fx II
   accepts both and walks the routing edges.
3. ✅ `routing` walk in `applyExecutor`
   (`packages/axe-fx-ii/src/tools/applyExecutor.ts:414-490`). Validates
   adjacent-column constraint + block-id references before any wire
   write fires.
4. ✅ Shunt synthesis (BK-054 follow-on, Session 76) —
   `block_type: "shunt"` (or numeric id 200..235) resolves to a
   synthetic block with a unique id per occurrence. Required for
   audible wet/dry presets that reach the OUTPUT terminator at col 12.
5. ✅ Unit golden — `scripts/verify-axe-fx-ii-routing.ts` (5 cases:
   wet/dry parallel, legacy linear, adjacent-column rejection,
   unknown block id rejection, shunt synthesis). Wired into
   `npm test`.
6. ✅ Hardware audition — `launch-verify` exercises a wet/dry split
   end-to-end through `StdioClientTransport` → dispatcher → descriptor
   → wire → device acks. Same wire path Claude Desktop uses.

**Hardware sign-off remaining (founder, manual):** save the wet/dry +
shunts spec from the README to a slot on a live Axe-Fx II and audibly
confirm parallel routing produces a wider stereo image than series
routing of the same blocks.

## Per-device capability adaptation

Each device's `DeviceDescriptor` declares which schema fields it
accepts. The dispatcher consults the descriptor's capability flags
to refuse unsupported combinations BEFORE any wire write fires, with
structured error codes (`routing_not_supported`,
`capability_not_supported`, `instance_not_supported`).

| Field | AM4 | Axe-Fx II XL+ | Axe-Fx III (planned) | FM3 / FM9 (planned) |
|---|---|---|---|---|
| `slots[].slot` accepts | `1..4` integer | `1..12` int OR `{row, col}` | `{row, col}` 4×14 | 4×4 / 4×14 grid |
| Channels | `A`/`B`/`C`/`D` | `X`/`Y` only | `A`/`B`/`C`/`D` | `A`/`B`/`C`/`D` |
| `scenes[]` count | 1..4 | 1..8 | 1..8 | 1..8 |
| `routing[]` | **rejected** | accepted | will accept | will accept |
| `instance` | only `1` | `1..N` | `1..N` | `1..N` |
| `block_type: "shunt"` | n/a | accepted (post BK-054) | will accept | will accept |
| `landingScene` | scene 1..4 | scene 1..8 | scene 1..8 | scene 1..8 |

When a new Fractal device gets a descriptor, its capability flags get
filled in here and the schema "just works" — zero new MCP tools, zero
schema changes.

---

## Appendix — `fill_to_output` proposal (post-v0.4)

**Status:** sketch (Session 74). Pre-implementation; expect iteration
before code.

### Problem

The Axe-Fx II OUTPUT terminator pulls from col 12 of the routing grid.
Signal that doesn't reach a cabled cell on row 2 col 12 is silent. The
legacy row-2 auto-chain mode handles this implicitly — it places
shunts at every empty row-2 col after the last content block and
cables them to col 12.

v0.4 explicit-routing mode SKIPS all of that on the principle "the
caller supplied the routing, trust it verbatim." That's correct for
fully-specified topologies, but it makes the common wet/dry case
verbose. A two-row wet/dry split with the merge at col 5 needs:

```jsonc
{
  "slots": [
    { "id": "comp",     "slot": { "row": 2, "col": 1 }, "block_type": "compressor" },
    { "id": "delay",    "slot": { "row": 1, "col": 2 }, "block_type": "delay" },
    { "id": "reverb",   "slot": { "row": 1, "col": 3 }, "block_type": "reverb" },
    { "id": "mixer",    "slot": { "row": 2, "col": 4 }, "block_type": "mixer" },
    // 7 more "shunt" entries needed at row 2 cols 5..11 to reach col 12.
    // Each shunt is also a "block_type" placement (shunt is its own block type),
    // and each adjacent pair needs a routing edge below.
    { "id": "shunt_5",  "slot": { "row": 2, "col": 5 },  "block_type": "shunt" },
    { "id": "shunt_6",  "slot": { "row": 2, "col": 6 },  "block_type": "shunt" },
    { "id": "shunt_7",  "slot": { "row": 2, "col": 7 },  "block_type": "shunt" },
    { "id": "shunt_8",  "slot": { "row": 2, "col": 8 },  "block_type": "shunt" },
    { "id": "shunt_9",  "slot": { "row": 2, "col": 9 },  "block_type": "shunt" },
    { "id": "shunt_10", "slot": { "row": 2, "col": 10 }, "block_type": "shunt" },
    { "id": "shunt_11", "slot": { "row": 2, "col": 11 }, "block_type": "shunt" },
    { "id": "shunt_12", "slot": { "row": 2, "col": 12 }, "block_type": "shunt" }
  ],
  "routing": [
    { "from": "comp",     "to": "delay" },
    { "from": "delay",    "to": "reverb" },
    { "from": "reverb",   "to": "mixer" },
    { "from": "comp",     "to": "mixer" },     // dry path: comp R2C1 → ... wait, mixer is R2C4, comp R2C1; cols not adjacent
    // ↑ this is the real catch: dry-path R2C1 → R2C4 needs intermediate
    // shunts too (comp → R2C2 shunt → R2C3 shunt → mixer). The wet/dry
    // example doesn't fit cleanly without ALSO filling dry-path shunts.
    { "from": "shunt_5",  "to": "shunt_6" },
    { "from": "shunt_6",  "to": "shunt_7" },
    { "from": "shunt_7",  "to": "shunt_8" },
    { "from": "shunt_8",  "to": "shunt_9" },
    { "from": "shunt_9",  "to": "shunt_10" },
    { "from": "shunt_10", "to": "shunt_11" },
    { "from": "shunt_11", "to": "shunt_12" },
    { "from": "mixer",    "to": "shunt_5" }
  ]
}
```

The 8 shunt entries + 8 routing edges (the entire bottom half of the
spec) carry no creative intent — they're the cost of "getting signal
to OUTPUT." An LLM authoring this is more likely to forget a shunt
than to get the topology wrong, and the resulting silent preset
looks identical to a real audio failure.

### Proposed API

Add an optional boolean to `PresetSpec`:

```ts
interface PresetSpec {
  // ... existing fields ...
  routing?: readonly RoutingEdge[];

  /**
   * v0.4+: grid devices only. When true AND routing[] is supplied,
   * the executor auto-extends row 2 from the rightmost-occupied row-2
   * cell to col 12 by placing shunt blocks in every empty intermediate
   * cell and cabling them in sequence. Linear devices (AM4) reject
   * this field with a capability error — they route implicitly.
   *
   * No-op when routing[] is omitted (legacy auto-chain mode already
   * extends to OUTPUT) or when the rightmost row-2 cell is already col 12.
   *
   * Default: false (opt-in, preserves explicit-mode "trust the caller
   * verbatim" semantics for fully-specified topologies).
   */
  fill_to_output?: boolean;
}
```

With `fill_to_output: true`, the wet/dry spec above collapses to:

```jsonc
{
  "slots": [
    { "id": "comp",   "slot": { "row": 2, "col": 1 }, "block_type": "compressor" },
    { "id": "delay",  "slot": { "row": 1, "col": 2 }, "block_type": "delay" },
    { "id": "reverb", "slot": { "row": 1, "col": 3 }, "block_type": "reverb" },
    { "id": "mixer",  "slot": { "row": 2, "col": 4 }, "block_type": "mixer" }
  ],
  "routing": [
    { "from": "comp",   "to": "delay" },
    { "from": "delay",  "to": "reverb" },
    { "from": "reverb", "to": "mixer" },
    { "from": "comp",   "to": "mixer" }    // ← still flagged: not adjacent (R2C1 → R2C4)
  ],
  "fill_to_output": true
}
```

The dry path R2C1 → R2C4 is still adjacency-invalid (cols 1 and 4
aren't adjacent), so the user still needs to either:
  a) Put a shunt at R2C2 and R2C3, cable comp→R2C2→R2C3→mixer
  b) Or accept that one of "wet path runs cols 2-3" or "dry path runs
     cols 2-3" needs intermediate shunts — they share row 2

This is a real topological constraint, not a verbosity problem.
`fill_to_output` only solves the post-merge tail (`mixer → OUTPUT`),
which is genuinely mechanical.

### Behavior — what the executor does

After the explicit-routing edge loop (current behavior), if
`fill_to_output: true`:

1. Find the rightmost row-2 column occupied by any block in `resolved`.
   Call it `lastRow2Col`. If no row-2 blocks at all, raise an error
   ("`fill_to_output` requires at least one row-2 block to extend
   from — your topology has no row-2 anchor"). Don't silently no-op.

2. If `lastRow2Col >= 12`, skip (the chain already terminates at the
   OUTPUT column).

3. For each col in `lastRow2Col + 1` .. `12`:
   a. Allocate a unique shunt block id (extend the SHUNT_BASE_ID=200
      counter past any explicit shunts already in `resolved`).
   b. Emit `set_grid_cell({ row: 2, col, blockId })` (SHUNT placement).
   c. Emit `set_cell_routing({ srcRow: 2, srcCol: col-1, dstRow: 2,
      dstCol: col, connect: true })` (cable previous cell to this one).

   The cable at `col = lastRow2Col + 1` connects the user's last block
   to the first auto-shunt; everything from there to col 12 is the
   auto-fill chain.

4. Append all the auto-fill ops to the same `ops[]` array the
   explicit-routing loop populates, so they hit the wire in the same
   single-pass place-then-cable order the existing flow uses.

### Safety / failure modes

- **Unmixed parallel paths**. If the user has row-1 blocks at cols
  past `lastRow2Col` (a wet path that didn't merge), those signals
  don't reach OUTPUT. `fill_to_output` shouldn't try to fix this —
  it only extends row 2. Optional follow-up: emit a warning in the
  apply_preset response: `"fill_to_output extended row 2 to col 12,
  but row 1 has blocks past your row-2 endpoint that aren't cabled
  to a mixer — those signals won't reach OUTPUT."`

- **Block-id collisions**. Auto-fill shunts must use ids that don't
  conflict with explicit blocks. Scan `resolved` for existing shunt
  ids in the 200..235 range, allocate next-available.

- **Cross-device contract**. AM4 must reject `fill_to_output: true`
  in the same capability-not-supported branch that already rejects
  `routing[]`. Hydrasynth's apply_preset path doesn't reach this
  code, but the dispatcher should validate at the boundary so the
  error is consistent across grid vs non-grid devices.

- **Interaction with `routing[]` omitted**. `fill_to_output` is
  meaningless without explicit routing — the legacy auto-chain mode
  already extends to OUTPUT. Decision: silently ignore (no error)
  when routing[] is omitted, on the grounds that the user's intent is
  satisfied either way. Document this in the field's description.

### Implementation effort

~1-2 hours including:
  - PresetSpec type extension (1 line)
  - Zod schema entry on `presetShape` with description (5 lines)
  - AM4 writer specToApplyInput rejection (5 lines, mirrors routing[] rejection)
  - Axe-Fx II applyExecutor auto-fill loop after the explicit-routing
    edge loop (~30 lines)
  - 1 golden in verify-transpile covering: explicit routing topology
    that stops at col 5 with `fill_to_output: true` → 7 auto-shunts +
    8 auto-cables appended to the op stream
  - Optional: warning when unmixed paths detected

Hardware verification once it lands:
  - `scripts/mcp-hwtest-wet-dry.ts` (was task #16). With
    `fill_to_output: true`, the wet/dry spec is ~10 lines instead of ~30.
  - `scripts/mcp-hwtest-dual-amp.ts` (was task #16). Dual amp at R2C4
    + R4C4 merging at a mixer at R2C5 — `fill_to_output` extends R2
    cols 6..12.

### Open questions for review

1. **Field name.** `fill_to_output` is explicit but verbose. Alternatives:
   `auto_extend_to_output`, `terminate_at_output`, `auto_shunt_tail`. The
   verbose name is preferable because it appears in user-facing tool
   responses ("Auto-extended row 2 with 7 shunts via fill_to_output.").

2. **Default true vs false?** Currently proposing default false.
   Argument for default true: most users want their preset to make
   sound, the few cases where they explicitly want row 2 truncated
   are rare. Argument for default false: explicit-routing mode is
   already opt-in (you only get there by passing `routing[]`); adding
   implicit shunt-fill on top muddies the contract. Lean: false.

3. **Should the auto-fill emit a `warnings[]` entry in the
   apply_preset response listing which cells were auto-filled?** Yes
   — same pattern as `apply_preset.warning` for type-gated skip+warn.
   Lets the agent narrate the action honestly ("Filled row 2 cols
   6-12 with shunts to reach OUTPUT").

