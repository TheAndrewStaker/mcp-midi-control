# Recipe Authoring Guide

How to add a tone-building recipe (a hand-curated starting point the
agent can apply via `apply_preset({recipe_id})` for guitar devices or
`apply_patch({recipe_id})` for synths) so the agent stops guessing knob
values and pastes from a documented player rig or a known synth voice.

This guide is for community contributors. It pairs with
[`docs/TOOL-AUTHORING-GUIDE.md`](TOOL-AUTHORING-GUIDE.md): that one
covers the MCP tool surface itself; this one covers the curated data
layered on top.

`recipe_id` works on BOTH apply tools. On linear guitar devices (AM4,
Axe-Fx II, Axe-Fx III) it rides `apply_preset`. On the Hydrasynth it
rides `apply_patch`. Both expand the recipe into ordinary tool calls,
so every safe-edit gate still fires.

---

## What a recipe is

A recipe encodes ONE iconic tone, with:

- Per-device slot list (block placement + knob values + enum picks).
- A short prose description that names the player / era / song so
  the agent knows when to suggest it.
- A `signature_params` dict naming the 2-4 most distinctive picks
  (e.g. `amp.type='Brit Silver'`, `delay.feedback=25`). The agent
  uses these to disambiguate between sibling recipes from the slim
  `describe_device.recipes[]` surface.
- A `source_notes` line citing where the values came from (Premier
  Guitar rig rundown, Sound on Sound feature, forum thread with
  player confirmation). This is authored on every recipe, but where
  it SURFACES depends on the family: inline for the Fractal
  families, on the detail path for Hydrasynth patch archetypes (see
  below). Either way it is reachable via
  `describe_device({port, recipe:"<id>"})`.

The agent discovers recipes via `describe_device(port).recipes[]` and
applies them via `apply_preset({port, recipe_id, overrides?})` (guitar)
or `apply_patch({port, recipe_id, overrides?})` (Hydrasynth). The
dispatcher materializes recipe + overrides into a normal spec before
preflight, so every existing safety gate (type-knob applicability,
phantom-param, channel-Y inactive on guitar; range and routing checks
on synth) still fires.

---

## Families

There are two groups, split by device family because the expansion
differs.

### Guitar families (linear devices: AM4, Axe-Fx II, Axe-Fx III)

| Family | Shape | Surface |
|---|---|---|
| `block_stack` | Multi-slot signal chain | Slim summary; apply via `recipe_id` |
| `auto_wah` / `pitch` / `wah` / `filter` / `scene_leveling` | Single-block | Full params inline in `describe_device.recipes[]` |

Single-block recipes apply via `set_block` / `set_params` / direct
`apply_preset` slot. They ship inline because the params dict is
small and the agent uses it directly. The guitar side ships utility
recipes for the common "make me a X" requests where parameter
relationships matter: pitch, wah, filter, auto-wah, diatonic pitch.

Block-stack recipes ship slim (id, family, description, slot_count,
signature_params) because their full slot trees are 6 to 9 KB per
device. The agent picks by id; the dispatcher materializes.

**What a block-stack summary deliberately does NOT carry**, as of
2026-08-02, after measuring the Axe-Fx II's 14 entries per field:

| Field | Cost on the II | Why it left |
|---|---|---|
| `target_blocks` | 2,499 | The block roster is already in `description`, in English, on 14 of 14 recipes. The slot refs it also carried are only read when writing `apply_preset.overrides`, i.e. after a recipe is chosen. |
| `source_notes` | 1,982 | Provenance answers a question about a recipe already picked. Same reasoning as the Hydrasynth archetypes below. |
| `params` | 182 | It was `{}` on every entry — a block stack has no top-level params — and read as "this recipe sets nothing". |

All three are served in full by
`describe_device({port, recipe:"<id>"})`, where `slots` is a strict
superset of the old `target_blocks`. Keep authoring `source_notes`
thoroughly; it costs nothing until somebody asks. Do NOT add a new
field to the summary without asking whether it is read while CHOOSING
or after, and running `npx tsx scripts/verify-describe-device-budget.ts`.

### Synth family (Hydrasynth): patch archetypes

This family is **shipped and live** through `apply_patch`. A
`patch_archetype` is a named, display-first starting point for a synth
voice: oscillator setup, filter, envelopes, and optional mod-matrix
and macro routing. Block-stack semantics don't translate to synth
patches, so an archetype carries a base param list in display units
plus optional routing-by-name instead of a slot tree.

Around 33 archetypes have been auditioned on the Hydrasynth Explorer
hardware. The ones that reproduce reliably are curated into the
shipped set. Examples: a Prophet-5 warm analog pad, a Juno-106 chorus
pad, an OB-Xa brass/jump lead.

**What an archetype surfaces where.** `describe_device.recipes[]`
carries the MATCH-time fields only: id, family, description, category,
cultural_reference, tags, signature_params, requires_nrpn. The full
`params` map materializes server-side from `recipe_id` (the summary
stopped emitting an empty `params: {}` alongside it on 2026-08-02), and
`source_notes` moved to the detail path
(`describe_device({port:"hydrasynth", recipe:"<id>"})`, which also
returns `full_params` / `mod_routes` / `macro_routes`). Reason: at
687 chars per recipe across 36 recipes, the citations were 50% of
this device's whole `describe_device` response, and every byte of
that response is charged against a hard host delivery ceiling on
every Hydrasynth question. Keep writing thorough `source_notes` —
they cost nothing until someone asks — but do NOT add new prose
fields to the summary without running
`npx tsx scripts/verify-describe-device-budget.ts` first. A 37th
archetype costs about 700 chars of a ~100-char margin.

---

## Curation criteria

Every recipe must satisfy:

1. **Recognizable.** A working guitarist should recognize the tone
   from the name without explanation. "Edge dotted-eighth lead", "80s
   metal brown sound", "Texas blues crunch", not "warm clean tone."
   For synth archetypes the same rule applies by classic-synth name:
   "Prophet-5 pad", "Juno-106 pad", "OB-Xa Jump".

2. **Sourced.** The knob values come from a public, documented source
   you can cite. Cite it in `source_notes`. No "I dialed this in by
   ear and it sounded right" recipes; those go in the user's
   personal preset library, not the shared corpus. Synth archetypes
   additionally must round-trip on hardware before they are curated
   (see the patch-archetype authoring section).

3. **Enum-verified.** Every `amp.type` / `drive.type` / `reverb.type`
   string in the recipe MUST exist in the target device's catalog
   verbatim. Verify at authoring time:
   ```
   grep -r "'BRIT SILVER'" packages/fractal-gen2/  # for II
   grep -r "Brit Silver" packages/am4/          # for AM4
   ```
   If the enum doesn't exist, the recipe ships broken; the recipe-
   table preflight (`scripts/verify-recipe-tables.ts`) will catch it
   at CI time.

4. **Slot-fits the device.** Block-stack recipes that need 5+ slots
   are II-only (AM4 has a 4-slot linear chain). Document the AM4
   absence in the recipe's header comment.

5. **No improvised middle-ground.** If the tone is fundamentally a
   different rig on a different device (e.g. djent on AM4 needs a
   noise gate + sub-cut that won't fit four slots), omit that device
   from `applicable_devices`. Don't ship a "best approximation" that
   no one will recognize.

---

## Authoring a new block_stack recipe

Walk through what changes where.

### 1. Add the recipe entry

Edit `packages/core/src/protocol-generic/recipes/blockStack.ts`. Add
a new entry to `BLOCK_STACK_RECIPES`:

```ts
my_recipe_id: {
  name: 'my_recipe_id',
  description:
    'Player / era / song reference: chain shape + headline knobs.',
  applicable_devices: ['am4', 'axe-fx-ii'] as const,
  signature_params_per_device: {
    am4: { 'amp.type': '<verified enum>', 'drive.type': '<verified enum>' },
    'axe-fx-ii': { 'amp.effect_type': '<VERIFIED ENUM>', 'drive.effect_type': '<VERIFIED ENUM>' },
  },
  source_notes:
    'Cite the public source (Premier Guitar, Sound on Sound, etc).',
  slots_per_device: {
    am4: [
      { slot: 1, block_type: 'drive', params: p({ type: '<enum>', ... }) },
      { slot: 2, block_type: 'amp',   params: p({ type: '<enum>', ... }) },
      // ...
    ],
    'axe-fx-ii': [
      { slot: { row: 2, col: 1 }, block_type: 'drive', params: p({ effect_type: '<ENUM>', ... }) },
      { slot: { row: 2, col: 2 }, block_type: 'amp',   params: p({ effect_type: '<ENUM>', ... }) },
      // ...
    ],
  },
},
```

`signature_params_per_device` is REQUIRED and CI-validated:
- Every key must be a `<block_type>.<param_name>` dot-path.
- The value must match the corresponding param in `slots_per_device`
  for the same port (drift fails the build).
- Pick 2-4 keys per device, the ones that DISTINGUISH this recipe
  from siblings. The amp type is almost always one. A
  characteristic effect (delay type, drive type, modulation rate) is
  another.

### 2. CI gates

`scripts/verify-recipe-tables.ts` runs in `npm test`. It verifies for
every recipe:

- `applicable_devices` non-empty.
- For each applicable port: `slots_per_device[port]` is non-empty
  AND `signature_params_per_device[port]` is non-empty.
- Every `signature_params` key resolves to a real slot+param.
- Every `signature_params` value matches the slot's authored value.
- Materializer round-trip: `materializeBlockStackRecipe(name, port,
  undefined)` returns the expected slots.
- Materializer overrides merge: applying an override produces a spec
  with the override applied AND the recipe's other knobs preserved.
- Verbatim equivalence: materialize(name, port, undefined).slots
  deep-equals `slots_per_device[port]`.
- Non-applicable port throws `RecipeMaterializeError`.

If any gate fires, fix the recipe rather than adjusting the gate.

### 3. Agent-regression case (optional, future)

When a recipe is iconic enough that we want to PROVE the agent picks
it up from a natural prompt, add an agent-regression case under
`scripts/agent-regression/cases-<device>.ts`. Existing examples:
`axefx2-recipe-block-stack-pickup`, `am4-recipe-block-stack-pickup`
(disabled by default until validated).

Pattern:
```ts
{
  id: '<device>-recipe-<recipe_id>-pickup',
  device: '<device>',
  tier: 'hardware',
  description: 'Agent picks the <recipe_id> recipe by id...',
  prompt: 'A natural-language prompt the agent should map to the recipe',
  expectations: {
    must_call: ['describe_device', 'apply_preset'],
    tool_call_validators: [{
      tool: 'apply_preset',
      call_index: 0,
      check: (args) => {
        if (args.recipe_id !== '<recipe_id>') {
          return `Expected recipe_id='<recipe_id>'; got ${JSON.stringify(args.recipe_id)}.`;
        }
        return true;
      },
    }],
  },
}
```

---

## Authoring a single-block recipe

Single-block families ship full params inline. Each family has its
own file (`autoWah.ts`, `pitch.ts`, `filter.ts`, `wah.ts`,
`sceneLeveling.ts`). Follow the existing entries' shape:

```ts
my_single_block_recipe: {
  name: 'my_single_block_recipe',
  description: 'What this tone evokes',
  applicable_devices: ['am4', 'axe-fx-ii'],
  params_per_device: {
    am4: { rate: 0.8, depth: 60, /* ... */ },
    'axe-fx-ii': { rate: 0.8, depth: 60, /* ... */ },
  },
  target_block_per_device: {
    am4: 'filter',
    'axe-fx-ii': 'wah',  // II uses WAH block for auto-wah
  },
  // optional:
  modifier_needed_on: { am4: true, 'axe-fx-ii': true },
},
```

The cross-device divergence is built into the schema (auto-wah lives
on FILTER on AM4 but WAH on II). Use `target_block_per_device` to
expose the per-device routing.

---

## Authoring a Hydrasynth patch archetype

Synth archetypes are display-first param lists plus optional routing
by name. They live in
`packages/core/src/protocol-generic/recipes/patchArchetype.curated.ts`
(the curated, hardware-auditioned set) with the shape and support
types in `patchArchetype.ts` and `patchRecipeTypes.ts`.

1. **Pick a `recipe_id`.** Lowercase snake_case, unique. Example:
   `juno106_pad`.
2. **Declare base params** in display units. Use musician-facing
   names (`filter_cutoff`, `amp_env_attack`) and display values
   (wave names like `'saw'`, ms, cutoff readings). Never expose a
   wire index or an internal bucket number; the codec owns the
   inverse for non-linear params (env / LFO time tables).
3. **Add routing by name** if the voice needs it. A `mod_routes`
   entry names `source` / `dest` / `depth`; a `macro_routes` entry
   names `macro` / `dest` / `depth`. The codec resolves a name like
   `lfo1` or `filter_cutoff` to the right mod-matrix or macro slot,
   so you never touch a routing index. This is the same name-based
   routing the `set_mod_route` and `set_macro_route` tools use.

   The shape, in display terms (read an existing curated entry for the
   exact field names and types before adding one):

   ```
   recipe_id:    'prophet5_pad'
   description:  'Prophet-5 style warm analog pad'
   base params:  osc1 wave = saw, filter cutoff = 62,
                 amp env release = 1800 ms
   mod routes:   lfo1 -> filter cutoff, depth 22
   macro routes: macro 1 -> filter cutoff, depth 40
   ```

4. **Audition on hardware.** Add an archetype to
   `patchArchetype.curated.ts` only after it round-trips on the
   Hydrasynth Explorer. The curated file is the hardware-verified
   set, not a wish list. An archetype that has not been heard on
   real hardware does not belong in the curated set.
5. **Register it** so the dispatcher and `apply_patch` pick it up,
   and so `describe_device(port).recipes[]` lists it.
6. **Test it.** The curated archetypes carry a test
   (`patchArchetype.curated.test.ts`) that validates their shape.
   Extend it for the new entry.

A patch archetype applies via `apply_patch({port, recipe_id})`. It
edits the active patch and never persists; the user still has to ask
to save, exactly like a manual edit.

---

## Authoring a brand-new family

If a new shape doesn't fit `block_stack`, any existing single-block
family, or the patch-archetype family (for example an FX-loop recipe
or a drum-pad kit), add a new family:

1. Define the recipe spec interface in a new file under `recipes/`.
   Mirror the existing single-block-family interfaces
   (`AutoWahRecipeSpec`, `PitchRecipeSpec`, etc) or the
   patch-archetype types.
2. Add the family table + resolver function (`MY_FAMILY_RECIPES`,
   `resolveMyFamilyRecipe`).
3. Add the family to `RecipeSummaryEntry.family` union in
   `summary.ts`.
4. Extend `summarizeRecipesForPort` to emit the family's entries.
5. Decide: inline params (small) or slim summary (large)? Inline is
   fine if the params dict is < 200 bytes; switch to slim with a
   materializer (like block_stack's `materializeBlockStackRecipe`)
   above that.
6. Extend `scripts/verify-recipe-tables.ts` with the family's
   integrity checks (the existing block_stack section is a template).

Discuss the design before doing the work: a new family changes the
contract surface, and pinging the maintainer first saves rewrites.

---

## What NOT to do

- **Don't ship a recipe you can't cite.** "I made this up and it
  sounds great" is fine for personal presets, not for the shared
  corpus.
- **Don't approximate cross-device.** If the tone doesn't translate
  (djent on AM4), omit the device. A bad approximation is worse than
  no entry.
- **Don't skip `signature_params`.** CI enforces it, but more
  importantly the agent uses it to pick between siblings. Without it
  the slim summary becomes ambiguous.
- **Don't extend `signature_params` to non-distinctive knobs.** It's
  a disambiguator, not a full enumeration. 2-4 picks per device. If
  every knob is "signature" then none of them are.
- **Don't bake firmware-version-specific values.** Enums shift
  between firmware versions; if a value is only stable on Q8.02,
  pick a different recipe or omit that device until the enum
  stabilizes.

---

## Examples worth reading

In `packages/core/src/protocol-generic/recipes/blockStack.ts`:

- `edge_dotted_eighth_lead`: the canonical block_stack example.
  Multi-block chain, dual-device, dense documentation header, cited
  sources, distinctive signature_params (Brit Silver + Digital
  Stereo delay + 25% feedback).
- `djent_gated_5150`: single-device (II-only) because the chain
  needs 5 slots. Header documents WHY AM4 is absent rather than
  shipping a bad approximation.
- `texas_blues_crunch`: minimal 3-block chain. Shows that recipes
  don't need to be long; iconic is what matters.

In `packages/core/src/protocol-generic/recipes/autoWah.ts`:

- `auto_wah_funk`: cross-device divergence handled cleanly via
  `target_block_per_device`. AM4 uses FILTER, II uses WAH; both
  carry envelope-follower types.

In `packages/core/src/protocol-generic/recipes/patchArchetype.curated.ts`:

- The curated Hydrasynth archetypes: each names base params in
  display units and routes mod/macro destinations by name. Read one
  before authoring a new synth voice; the Prophet-5 and Juno-106 pads
  show the param + routing shape.
