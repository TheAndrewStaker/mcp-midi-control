# Axe-Fx III — design notes for eventual support

This is a **pre-implementation design doc**. The Axe-Fx III isn't in the
codebase yet; this captures the patterns we've established for the
Axe-Fx II + AM4 family so the III implementation can mirror them when
the founder adds an Axe-Fx III to the project.

Authoritative source for the III's third-party MIDI surface is Fractal's
official PDF: **"Axe-Fx III MIDI for Third-Party Devices" v1.4**
(`https://www.fractalaudio.com/downloads/misc/Axe-Fx%20III%20MIDI%20for%203rd%20Party%20Devices.pdf`).
Document its envelope: `F0 00 01 74 [model=0x10] [function] … [cs] F7`.

## Function-byte map (from the official III spec)

| Fn | Name | Notes |
|---|---|---|
| `0x02` | SET_PARAMETER_VALUE | Same family shape as II, but at index level — III uses an "effect index" addressing model rather than II's 14-bit effect IDs. |
| `0x0A` | SET/GET BYPASS | `id id dd` — `dd=0` engaged, `dd=1` bypassed, `dd=7F` query. **Targets ACTIVE SCENE only.** No per-scene addressing in the documented surface. |
| `0x0B` | SET/GET CHANNEL | `id id dd` — `dd=0..3`, `dd=7F` query. **Active scene only.** |
| `0x0C` | SET/GET SCENE | `dd` = scene index. III has 8 scenes per preset. (II uses `0x29` for the same job.) |
| `0x0D` | SET/GET PRESET NUMBER | III's analog to II's `0x14`. |
| `0x0E` | QUERY SCENE NAME | `dd` = scene index (0-based), `7F` for current. Response: `nn dd*32` (scene name as 32 chars). **No SET variant documented** — same gap as II. |
| `0x0F` | QUERY PRESET NAME | III's analog to II's `0x0F`. |
| `0x13` | STATUS DUMP | III-only. Returns current-scene state for ALL effects in one shot: `id id dd` triples where `dd` bit 0 = bypass, bits 3-1 = channel, bits 6-4 = channel count. **This is III's closest analog to II's 0x74 state-broadcast triple** — but it's a one-shot snapshot, not an auto-emitted broadcast. |
| `0x21` | "Front panel change detected" auto-push | III emits this when the user touches the front panel. **Strong candidate for the device-sourced dirty signal.** |
| `0x64` | MULTIPURPOSE_RESPONSE | Same shape as II — function_id + response_code pair. The ack channel for writes. |

## Constraints inherited from the family

1. **All writes target the active scene only.** Per the III spec
   explicitly: `0x0A` (bypass) and `0x0B` (channel) operate on the
   currently-active scene. To author per-scene state, the agent must
   `switch_scene N` → write → optionally `switch_scene back`. Same
   discipline as II.

2. **Switch_preset / store_preset discard or commit the working
   buffer respectively.** Same model as II. Navigation refuses by
   default when the working buffer is dirty (the agent-side
   `on_active_preset_edited: 'warn' | 'discard' | 'save_active_first'`
   pattern).

3. **No per-scene authoring envelope exists in the documented surface.**
   The III spec confirms this explicitly (which is why II's analogous
   gap isn't a bug — it's a family-wide protocol constraint). Scene
   authoring on III is the same "switch-write-switch-back" workflow we
   designed for II.

## Dirty-state implementation (mirror Axe-Fx II)

Wire `src/fractal/axe-fx-iii/midi.ts` the same shape as
`src/fractal/axe-fx-ii/midi.ts`:

### Inbound classifier (device → host)

```ts
function isStateBroadcastInboundIII(bytes: readonly number[]): boolean {
  if (bytes.length < 6) return false;
  if (bytes[0] !== 0xf0) return false;
  if (bytes[1] !== 0x00 || bytes[2] !== 0x01 || bytes[3] !== 0x74) return false;
  if (bytes[4] !== AXE_FX_III_MODEL_ID) return false;
  // 0x21 is the "front panel change detected" auto-push per the III spec.
  // Strong candidate but UNVERIFIED on hardware — confirm with capture
  // (analogous to HW-107 for AM4) before trusting as the sole signal.
  return bytes[5] === 0x21;
}
```

**Verify before shipping:** capture a passive recording of user
front-panel edits on III (knob turn, bypass toggle, channel change)
with no host editor (Fractal-Bot / AxeManage III) running. Confirm:

1. Idle / no-edit → 0 `0x21` frames.
2. Knob turn → ≥1 `0x21` frame.
3. switch_preset → 0 `0x21` frames.
4. store_preset → 0 `0x21` frames.

If `0x21` doesn't fire on knob turn (only on hardware-button presses,
say), fall back to investigating `0x13` STATUS DUMP — III might
auto-emit a status dump on edit instead. Either way, the design above
applies; only the function-byte identity changes.

### Outbound classifier (host → device)

Clean transitions on `0x0D` (switch_preset analog) and III's STORE
function (TBD — III's preset-store envelope isn't in the public spec
we have; needs research at implementation time, possibly via the
same probe-and-observe pattern that landed II's 0x1D STORE_PRESET).

```ts
const CLEAN_FUNCTIONS_III = new Set<number>([
  0x0d, // SET_PRESET_NUMBER (analog to II's 0x3C SWITCH_PRESET)
  // 0x?? STORE_PRESET — pending decode at III implementation time
]);
```

## Capabilities object

When seeding the III descriptor (mirror of `AXEFX2_DESCRIPTOR`):

```ts
capabilities: {
  slot_model: 'grid',          // same 4×12 grid as II per the III editor UI
  scene_count: 8,              // III has 8 scenes per preset
  channel_names: ['A', 'B', 'C', 'D'],  // III restored 4 channels (II's X/Y outlier)
  supports_save: true,
  supports_factory_restore: false,  // III spec is silent on factory restore
  supports_lineage: true,       // amp/cab/drive corpus may extend to III models
  has_scenes: true,
  has_per_scene_authoring: false,  // confirmed by III spec — switch-write-switch-back only
}
```

## Lineage corpus

The Fractal-authored amp/cab/drive lineage lives in
`src/fractal/shared/lineage/`. Coverage across products:

- **AM4:** complete, file-only.
- **Axe-Fx II:** 203/259 amps matched after Session 66 BK-046/BK-047
  fixes. Drives/reverbs/delays inherit AM4's records via shared shape.
- **Axe-Fx III:** likely extends II's coverage with III-only amp
  models (a few dozen added post-II). At implementation time, audit
  the III's amp list against our `axe-fx-ii-amps.json` and add the
  III-only models.

## Implementation order (when III lands)

1. **Read the III spec PDF + capture user-only front-panel edits.** Same
   shape as HW-107 (AM4) — confirms which function byte is the dirty
   signal before any code lands.
2. **Implement `src/fractal/axe-fx-iii/{setParam,midi,blockTypes,params}.ts`**
   mirroring the Axe-Fx II shape. Pure builders + connection scaffold.
3. **Wire dirty-state classifier** in `midi.ts` using the confirmed
   inbound function byte from step 1.
4. **Write the descriptor** under `src/fractal/axe-fx-iii/descriptor/`
   (`schema.ts` + `writer.ts` + `reader.ts`), same per-role split as
   Axe-Fx II's descriptor (Session 67).
5. **Register before AM4 in `src/server/index.ts`** so port-name regex
   `/axe-?fx ?iii/i` fires first (matches "Fractal Axe-Fx III Port 1"
   before the more general `/Fractal/i` catches AM4).
6. **Verify-dispatcher goldens** — byte-equivalence between III legacy
   builders (if any) and the descriptor's pure builders, mirroring
   verify-dispatcher.ts § Axe-Fx II.

## Cross-references

- **Axe-Fx II implementation:** `src/fractal/axe-fx-ii/midi.ts` (dirty
  classification at send() / receive() level).
- **Shared dirty tracker:** `src/server/shared/bufferDirty.ts`.
- **Shared dirty guard utility:** `src/fractal/axe-fx-ii/tools/shared.ts`
  exports `guardActiveBufferOrSave()`. When III lands, extract this to
  `src/fractal/shared/dirtyGuard.ts` so both II and III can import it.
- **Capture methodology:** `scripts/capture-midi-passive.ts` (shared-
  read passive device-side capture); USBPcap + Wireshark for the
  editor → device direction (see `CONTRIBUTING.md`).
- **HW-107 (AM4 capture):** `docs/_private/HARDWARE-TASKS-AM4.md`.
  Pattern to mirror when capturing III's equivalent.

## Sources

- Fractal Audio Systems. "Axe-Fx III MIDI for Third-Party Devices" v1.4.
  `https://www.fractalaudio.com/downloads/misc/Axe-Fx%20III%20MIDI%20for%203rd%20Party%20Devices.pdf`
- bspaulding/axe-fx-midi (Rust): `github.com/bspaulding/axe-fx-midi` —
  cross-references II + III function-byte tables.
- tysonlt/AxeFxControl (Arduino, III-targeted):
  `github.com/tysonlt/AxeFxControl` — `MAX_SCENES = 8`,
  `requestSceneName`, `setEffectChannel`. No per-scene writes (confirms
  the family-wide constraint).
