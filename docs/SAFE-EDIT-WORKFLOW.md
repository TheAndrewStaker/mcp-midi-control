# Safe-Edit Workflow

The cross-device contract this project guarantees for every supported
MIDI device: AM4, Axe-Fx II, Hydrasynth, and any device added later.

**The rule, one sentence:** no tool silently overwrites a preset, no
tool silently loses your in-progress edits, and "save" is something
you ask for, except when you ask for multiple presets at once,
because a setlist without persistence isn't a setlist.

## Why this exists

Audio gear protocols don't natively protect users from this kind of
data loss. The Axe-Fx II's working buffer is just RAM; switching
presets discards whatever you were editing. The AM4 is the same.
AxeEdit's UI mitigates with a warning dialog before you navigate
away from an edited preset; bare MIDI has no such gate.

When an LLM is the one steering the device, the loss surface gets
larger: the agent may not realize the user has been editing, or
may interpret an ambiguous request like "build a tone at slot 700"
as "save to slot 700" when the user just meant "audition there."
We've hit both failure modes during development.

This document codifies the gates. Implementing them consistently
across every device means users can speak to any of our supported
devices the same way and trust the same safety guarantees.

## The contract

### Single preset / patch request

| User state | User language | Tool behavior |
|---|---|---|
| Clean buffer | "build a tone at slot X" / "design a clean preset" | Navigate to X, apply to working buffer, **don't save**. Response tells the user: *"Auditioning at slot X, say 'save it' if you want to persist."* |
| Clean buffer | "save a tone to slot X" / "build and save" / "put it on X" / "keep it at X" | Navigate to X, apply, save. |
| Dirty buffer | ANY request that navigates to a different preset | **Refuse with a structured warning naming the edited preset.** Agent asks the user: save first / discard / cancel? Re-call with the user's choice. |

### Multiple preset / patch request (setlist)

| User state | User language | Tool behavior |
|---|---|---|
| Clean buffer | "build setlist for 700/701/702" / "build 3 tones for A/B/C" | **Multi-preset implies save intent.** Pre-flight scan + warn about overwrites. Then navigate-apply-save each. |
| Dirty buffer | same | Warn about dirty first (same handling as single). User chooses, then the batch runs. |

### What counts as "save language"

Explicit, common verbs the agent should recognize:

- `save` / `save it` / `save this`
- `store` / `store it`
- `keep` / `keep it`
- `put it on slot N` / `put on N`
- `persist`
- `commit it` / `write it to N`
- `make it permanent`

What does NOT count as save authorization:

- `at slot X` (names a target, not an authorization; `"build a tone at 700"` is audition)
- `design a tone for X` (X is a song or style, not a slot)
- `try out a tone` / `play around with` / `experiment with`
- bare slot numbers without an action verb

### What counts as "multi-preset request"

- Two or more named target slots
- A range (`"slots 700-705"`)
- A named setlist (`"Def Leppard setlist for tonight's show"`)
- An enumerated list (`"a clean, a crunch, and a lead"` with slots implied or stated)

A single request that mentions multiple scenes within one preset is
NOT multi-preset: scenes are intra-preset, save discipline is the
same as single-preset (one save authorization needed).

## Device-by-device current state

Devices vary in how much of the contract is enforced at the API
boundary today. The table below tracks both gaps and the
implementation strategy:

| Capability | AM4 | Axe-Fx II | Hydrasynth | Circuit Tracks |
|---|---|---|---|---|
| Device-sourced dirty signal | ❌ not exposed (verified by capture: zero MIDI bytes on front-panel edits). Dirty gate uses the deterministic in-memory `markDirty`/`markClean` tracker (`core/server-shared/bufferDirty.ts`), set at AM4 write call sites + cleared on save/switch; see `tools/safeEdit.ts`. Does NOT track front-panel / parallel-editor edits (deliberate tradeoff; the old fingerprint poll did, but non-deterministically, which false-refused users). | ✅ via `0x74` state-broadcast | ❌ not exposed in MIDI | n/a: no working-buffer "save" model. Edits are either live (fire-and-forget CC/NRPN, instantly audible, nothing to lose) or whole-slot file transfers (see the slot-transfer gate below). There is no dirty preset buffer to guard. |
| `on_active_preset_edited` guard | ✅ unified surface (`apply_preset`, `switch_preset`) | ✅ shipped | n/a (no dirty detection) | n/a (no working buffer) |
| `save_authorized` guard on apply-at-slot | ✅ unified `apply_preset(target_location, save_authorized)` | ✅ shipped | ✅ `apply_patch(save: true)` | replaced by the **slot-transfer overwrite gate** (`confirm_overwrite`) on the destructive transfer tools, see below |
| Multi-preset overwrite scan | ✅ `scan_locations` | ✅ `scan_locations` | n/a (different patch model) | ⚠️ partial: `upload_project` / `apply_pattern ncs_upload` READ the target project slot (empty→write, occupied→refuse + name); sample slots can't be read yet (`upload_sample` / `upload_kit` refuse by default). `delete_project` scans every named slot and its refusal IS the report (see below). |
| `save_preset` single-target overwrite gate | ✅ reads the target's stored name and refuses a non-active occupied location until `confirm_overwrite: true` | ✅ **since 2026-08-03, on a different basis**: this device can read which preset is ACTIVE but has no decoded read for what is stored at an ARBITRARY location, so occupancy is genuinely unknown. It refuses any NON-ACTIVE target until `confirm_overwrite: true`, and the refusal SAYS no occupancy check was possible rather than implying one happened. Saving back to the location being edited is unaffected. Before this the store landed `acked: true` with the caution on the RECEIPT, which is a warning after a flash write, not a gate | n/a (patch model, `apply_patch(save)`) | see the slot-transfer gate below |
| Erase (make a stored slot empty) | n/a: no erase exists on the device, a location always holds something | n/a | n/a | ✅ `delete_project`, gated harder than any overwrite: see "erasing, which is not overwriting" below |
| Tool-description guidance for agent | ✅ `describe_device` agent_guidance | ✅ `describe_device` agent_guidance | ✅ `describe_device` agent_guidance, all 13 topics inline (they were withheld until 2026-08-02, when patch-archetype `source_notes` moved to `describe_device({port, recipe})` and freed ~24 KB). Any topic a device cannot fit is still named in `agent_guidance_withheld` and read via `describe_device(port, guidance: [...topics])` | ✅ the `confirm_overwrite` contract is in every transfer tool's description |

AM4 / Axe-Fx II / Hydrasynth are fully shipped on the unified surface
(`apply_preset`, `save_preset`, `switch_preset`). Device-namespaced tools have
been removed from the registered surface. The unified surface is the sole live
contract.

### Circuit Tracks: slot-transfer overwrite gate

The Circuit Tracks has no working-buffer "save" model, so the preset
dirty/save gates above don't apply. What it DOES have is **destructive
slot transfers**: `upload_sample` / `upload_kit` (a sample slot, 1..64),
`upload_project` (a project, 1..64 as the device numbers it), and
`apply_pattern mode:ncs_upload`
(authors a pattern into a template, then writes a project slot). Each one
permanently overwrites whatever is in the target slot. The project's
"read before write / confirm before overwriting non-empty" contract applies
here just as it does to a preset location.

The gate is **occupancy-driven, not a blanket refuse-by-default**, so it
adds friction only where there's something to lose:

- **`upload_project` / `apply_pattern ncs_upload`** (project slots are
  readable): without `confirm_overwrite`, the tool READS the target slot
  first. **Empty → it writes straight through** (no friction). **Occupied →
  it refuses** (`overwrite_confirmation_required`) and names the stored
  project, for the agent to surface and the user to confirm; re-call with
  `confirm_overwrite: true`. The read costs one extra slot download and runs
  only on the non-authorized path.
- **`upload_sample` / `upload_kit`** (sample slots are NOT readable yet, the
  sample-directory decode is RE-gated): occupancy "can't be confirmed", so the
  tool refuses by default and asks for `confirm_overwrite: true`. When the
  dir-listing decode lands, these graduate to the same empty-slot-no-friction
  behavior as projects.
- **`confirm_overwrite: true`** (set by the agent when the user used
  save/overwrite/replace language) writes immediately and skips the occupancy
  read on every path.

**A second, finer-grained destruction the slot gate cannot see (added 2026-07-27):
`preserve_template_gates`.** `apply_pattern mode:ncs_upload` template-modifies a
stored project, so a re-author with `confirm_overwrite` already granted can still
destroy work WITHIN a slot the user meant to keep. Before authored note lengths
existed, the writer emitted only a one-step gate, so every re-author flattened
every hand-dialled note length and dropped every tie flag in the project. The
template's gate and tie are now carried through per `(step, note)`, and the flag
**defaults to preserving**: the destructive direction is the one you have to ask
for. An inherited tie the new arrangement no longer reaches is dropped and
reported rather than left as a device no-op, and a pattern-stated length beats
template inheritance. Pass `preserve_template_gates: false` to deliberately
flatten.

The mechanism is `SlotWriteOptions.confirmOverwrite` threaded from each
transfer tool's `confirm_overwrite` arg; the refusal is a
`DispatchError('overwrite_confirmation_required', …)` formatted into the
canonical refusal text. Implementation: `gateProjectOverwrite` /
`gateSampleOverwrite` + `probeProjectSlot` in
`packages/circuit-tracks/src/descriptor/writer.ts` and
`.../ncs/uploadProject.ts`.

### Circuit Tracks: erasing, which is not overwriting

`delete_project` is the only tool in this server that makes stored content stop
existing. Every other destructive path REPLACES: the slot still holds something
afterwards and the receipt names what. A delete leaves nothing, on a device with
no undo, no trash, and no front-panel erase. Its gates are therefore stricter
than the overwrite gate, and three of them are deliberately NOT symmetric with
it. Implementation:
`packages/core/src/protocol-generic/dispatcher/deleteProject.ts` (gates) and
`packages/circuit-tracks/src/ncs/fileDelete.ts` (wire).

| Gate | Behaviour | Why it differs from the overwrite gate |
|---|---|---|
| **Read before delete** | Unconditional, both oracles, per slot, and again in-session one instruction before each destructive frame. Refuses on empty, on unreadable, and on the two oracles DISAGREEING. | The overwrite gate SKIPS its read when `confirm_overwrite` is passed, because on a write the read only buys information: the write lands either way. Here the read is the only thing separating "erase this project" from "erase the wrong project", and the only evidence that the file backed up is the file destroyed. |
| **Backup** | Mandatory, CRC-verified, with NO flag to skip it. Anything other than a saved, structurally valid file aborts the whole call before a single delete frame. | `upload_project`'s `backup_first` is a flag, and was found on 2026-07-29 to be a silent no-op unless `confirm_overwrite` was also passed. A flag whose effect depends on another flag is the failure mode. There is also no non-destructive path here for it to be optional on: the tool refuses empty slots, so every call that reaches the backup destroys something. The backup IS the undo, and an undo you can switch off is not an undo. |
| **Authorization** (`confirm_delete`) | Refuse-by-default. The refusal CARRIES the pre-flight report, naming every project that would be lost. | This is the multi-preset overwrite gate above ("pre-flight scan the target range and surface what would be overwritten"), not a second gate beside it. It is also why the tool needs no `dry_run`: the unauthorized call already is one. |
| **Per-call ceiling** | 8 slots. Over it the call is REFUSED, never trimmed to fit. | A truncating delete leaves the caller believing a range is clear when it is not, which is the same class of lie as a silent no-op. The number is an order of magnitude below the 64 slots a loop of these frames cleared on 2026-06-27; clearing a pack takes eight separate calls, each re-reading the card and re-stating what it will destroy. |
| **Verify after** | Both oracles, in a fresh session, past the manifest-flush window: the device's own per-file query AND a directory read, plus a byte-for-byte comparison against a known-free control slot. | The directory is the table a delete edits, so verifying with it alone is circular; reading it too early reports stale contents. The control comparison exists because a 2026-07-29 verification whose matcher accepted only the occupied reply shape scored a real successful erase as "still there", and the obvious next move after reading that is to send the delete again. |

**Named slots, never a range.** `slots` is a list the caller writes out; there is
no `from`/`to` at any layer. The 2026-06-27 incident that emptied a pack's
64-slot sample pool was a loop over a range, and Novation Components does not
loop either: it enumerates the pack, then sends one frame per slot its own
directory lists as occupied. A caller who wants a range enumerates it with
`scan_locations` first, which means they have seen what is in it before they name
it.

Sample and patch slots use the same opcode and stay gated: a project can be read
back byte-exact and backed up before it is erased, and a sample slot cannot.

## Implementation pattern

Three pieces, applied consistently:

### 1. Buffer-dirty tracking

Three strategies depending on what the device exposes over MIDI:

**Device-sourced broadcast (Axe-Fx II).** The device emits a state-
broadcast that fires on edits (`0x74` triple). We listen passively
and flip an in-memory `dirty[device]` flag. Device-sourced and
authoritative.

**Deterministic in-memory flag (AM4).** Hardware probing confirmed AM4
emits zero unsolicited MIDI on front-panel edits; no push signal exists.
The AM4 also has no transport-layer send classifier, so it fires
`markDirty` (`core/server-shared/bufferDirty.ts`) at each acked
edit-class write call site in `writer.ts` / `applyExecutor.ts` /
`presetRestore.ts`, and `markClean` on save / switch, the same
call-site model Axe-Fx II uses. `tools/safeEdit.ts` consults
`isDirty(label)`. A prior version polled + hashed the working-buffer
dump, but the AM4 dump is non-deterministic (~20% byte drift on a
zero-mutation re-dump, 2026-05-28), so the hash both fails-open and
false-refuses: a real user was refused a navigation immediately after
a clean save (2026-06-03). Tradeoff vs. the old poll: this detects OUR
edits reliably but not out-of-band front-panel / parallel-editor edits.

**No detection (Hydrasynth).** Device doesn't expose a dirty signal
and the patch-buffer dump cost is prohibitive. We don't fake it.
`save_authorized` guard still works; `on_active_preset_edited` is
omitted as `n/a`; agents know to ask the user before navigating.

### 2. `on_active_preset_edited` guard

Parameter on every tool that navigates away from the active preset:

```ts
on_active_preset_edited: z.enum(['warn', 'discard', 'save_active_first']).optional()
```

Default `'warn'`. When the buffer is dirty:

- `'warn'` (default): refuse, return a structured warning naming
  the active preset's slot + name. The agent surfaces this to the
  user, gets a save/discard/cancel decision, retries with the
  appropriate mode.
- `'discard'`: proceed without saving (silent edit loss, but
  user-authorized).
- `'save_active_first'`: read active preset's slot, save the
  working buffer to it, then navigate.

When the buffer is clean, the guard is a no-op and the tool runs
normally.

**`export_preset` needs no dirty gate on any device.** Every device
that implements it dumps the TRUE edit buffer (AM4 + Axe-Fx II via the
fn 0x03 `7F 7F` sentinel, gen-3 via fn 0x43), so exporting unsaved work
is safe and correct. The hazard lives one layer down: the II's
SLOT-ADDRESSED fn 0x03 dump reloads the stored preset over the working
buffer (hardware-confirmed 2026-06-10), which is why no tool path uses
it on the II. Full per-device table: TOOL-AUTHORING-GUIDE.md
"Source-of-data contract".

### 3. `save_authorized` guard on apply-at-slot

Parameter on every tool that applies AND persists in one call
(e.g. `apply_preset` with `target_location` + `save_authorized`,
`apply_patch` with target slot):

```ts
save_authorized: z.boolean().optional()
```

Default `false`. When `false`:

- Tool refuses with a structured message explaining: the user must
  have used save language, and pointing the agent at the
  working-buffer-only alternative (`apply_preset` without
  `target_location`) for audition.

When `true`:

- Tool proceeds with the full apply-and-save flow (after passing
  the `on_active_preset_edited` guard if applicable).

Multi-preset batch operations (if reintroduced) would not have this
guard, as multi-preset intent is the authorization. They would still
pre-flight scan and warn about overwrites.

## Agent-facing tool-description rules

Every tool that navigates or persists carries the contract in its
description so the LLM knows what to surface to the user. Pattern
from the unified `apply_preset`:

> SAVE AUTHORIZATION REQUIRED, DESTRUCTIVE: when `save_authorized:
> true` is passed alongside a `target_location`, this tool calls
> STORE_PRESET at the end, which overwrites the target slot. The
> tool refuses by default; you MUST pass `save_authorized: true`
> AND that should only happen when the user used save-intent
> language (save/store/keep/put-on/persist). For "build a tone" /
> "design a preset" without save language, omit `save_authorized`
> (working-buffer-only) instead, let the user audition, then ASK
> before calling with `save_authorized: true`.

Mirror that paragraph in every per-device equivalent. Keep the
wording close so an agent that's only ever seen one device's tools
recognizes the pattern in another.

## Test scenarios: what every device must pass

These are the user-facing behaviors that prove the contract is
implemented. Use them as a regression check whenever the safe-edit
code changes.

**Manual verification:** The scenarios below can be exercised by hand
in a Claude Desktop chat with `mcp-midi-control` connected. Ask Claude
to perform the scenario, then observe whether the tool panel shows the
expected refusal or success. See `docs/SAFETY-FOR-MUSICIANS.md` §"How
to verify the gates are actually working" for a two-prompt walkthrough.

An automated regression suite (`scripts/mcp-test-safe-edit-scenarios.ts`)
exercises the gates. Extending it to cover more of the unified
`apply_preset` / `switch_preset` surface is tracked in the backlog.

| Scenario | Expected | Suite assertion |
|---|---|---|
| 1. User on clean preset says "build a tone at slot X" | Agent calls `apply_preset` (working buffer), tool succeeds without `save_authorized`. | S1: working-buffer apply succeeds. |
| 2. User on clean preset says "save a tone as Glassy at slot X" | Agent calls `apply_preset` with `target_location` + `save_authorized=true`, tool persists. | S2: clean + apply-at-slot with auth succeeds. |
| 3. User on dirty preset Y says "build a tone at slot X" | Tool refuses (save-auth gate fires first; if auth granted, dirty gate fires next). | S3a (refusal, no auth) + S3b (refusal, auth but dirty). |
| 4. User on clean preset says "build setlist for 700/701/702" | Tool pre-flight scans (warns about overwrites), navigates-applies-saves each. | Covered by founder-driven setlist tests, outside the regression suite. |
| 5. User on dirty preset says "build setlist for 700/701/702" | Refuses dirty first; agent must save/discard before retrying. | S5: dirty + setlist refuses. |
| 6. User on clean preset says "switch to slot 47" (no apply) | Tool navigates, no save concern. | S6: clean + switch_preset succeeds with default mode. |
| 7. User on dirty preset says "switch to slot 47" (no apply) | Tool refuses, asks save/discard. | S7: dirty + switch_preset refuses. |

## Failure modes documented

- **Front-panel edits on Hydrasynth.** No dirty detection at all:
  the device doesn't broadcast and the patch-buffer dump cost is
  prohibitive. `save_authorized` still catches save-intent
  ambiguity; `on_active_preset_edited` is omitted. Honest scope:
  agents ask the user before navigating.

- **Front-panel edits between navigations on the same AM4 preset.**
  The fingerprint refresh after a clean transition captures whatever
  was on screen at that moment. If the user then turns a knob and
  asks to navigate to a DIFFERENT preset, the gate catches the edit
  (current hash ≠ cached). If the user turns a knob and asks to
  navigate to the SAME preset (re-loading it), the gate compares
  against the same cached baseline, so the edit is detected. The
  remaining gap: edits between two refresh points the user never
  explicitly navigates between (e.g. silent state at the moment of
  the cache refresh isn't checked against a prior baseline). In
  practice this is closed by every clean transition the agent does.

- **Device save we can't see.** If we made edits (flag = dirty) and the
  user then presses SAVE on the device's own front panel, the buffer now
  matches flash but our in-memory flag is still dirty (we never saw the
  front-panel save). The next navigation warns; user says "I saved it"
  → choose `'discard'`. Fail-safe (extra confirmation) rather than
  fail-dangerous (silent edit loss).

- **Server restart.** The dirty flag is in-memory and resets to clean on
  restart. The first post-restart navigation treats the buffer as clean
  and proceeds; our own edits after restart re-arm the flag.

## References

- `packages/core/src/server-shared/bufferDirty.ts`: shared deterministic dirty-flag tracker (`markDirty`/`markClean`/`isDirty`). Axe-Fx II (fractal-gen2), fractal-gen3, AND AM4 all use it.
- `packages/fractal-gen2/src/tools/shared.ts:guardActiveBufferOrSave`:
  reference implementation of the warn/discard/save-first guard
- `packages/fractal-gen2/src/midi.ts`: device-sourced dirty
  classification (state-broadcast listener)
- `packages/am4/src/tools/safeEdit.ts:guardActiveAM4BufferOrSave`:
  AM4 guard; consults `isDirty`, fires `markDirty`/`markClean` at the
  writer / applyExecutor / presetRestore call sites.
- AM4 doesn't broadcast on front-panel edits, full stop (verified by
  capture). The earlier polled-fingerprint workaround was removed
  (2026-06-03): the AM4 dump is non-deterministic (~20% drift on a
  zero-mutation re-dump), so the hash false-refused users. AM4 now
  tracks ITS OWN edits via markDirty (not front-panel / parallel-editor
  edits, accepted tradeoff for determinism).
