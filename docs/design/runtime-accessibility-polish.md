# Runtime accessibility polish (0.6.0)

**Status:** proposed for 0.6.0, alongside the `@julusian/midi` swap. No native
work, helps every user, low risk. Part of the blind-accessibility headline
(see [accessibility-blind-support.md](accessibility-blind-support.md)).

**Premise:** the conversational interface is already the accessibility win: text
in, text out, no spatial navigation. We do **not** build a separate "accessible
mode." This is about making sure what the tools *say back* presents cleanly when
read aloud by a screen reader (VoiceOver / NVDA), which also makes every reply
clearer for sighted users.

## Core principle: accessibility is a property of the unified surface, not new tools

There are **zero new tools** in this plan, and there must never be a bespoke
"accessible" tool variant. Accessibility falls out of the layering the project
already has:

- **Tools are the data layer; the model is the presentation layer.** Every unified
  tool returns **structured, display-unit data** (e.g. `live_grid` is
  `{row, col, block}` cells), never a pre-rendered visual. Structured data is
  presentation-agnostic: the model renders the *same payload* to whatever the
  listener needs: spoken prose for a screen reader, a tight summary for a sighted
  user.
- Therefore accessibility is not a feature added to a tool; it is a consequence of
  tools **never pre-rendering layout**. Make that an invariant and every tool
  "just works" aloud, including any future device, because adding gear is a
  descriptor, not new tools.

This is the screen-reader sibling of the existing **display-first** invariant
(tools return `0..10` knobs, not wire bytes). "Don't leak wire format" and "don't
pre-render visuals" are the same kind of cross-cutting rule on the one surface.

Everything below reduces to **two unified levers**:

1. **One invariant**: tools return structured display-unit data; never ASCII
   grids or aligned tables (Item 5 guards it; the audit confirms current
   compliance).
2. **One shared directive**: a single "describe for ears" block in the server
   instructions / shared agent guidance, applied to *all* tools and *all* devices
   at once, never per-tool.

**What the audit found (good news):** there are **no ASCII-art grids or aligned
tables in runtime tool output** today. `live_grid` and preset layout are returned
as **structured data** (`Gen3GridCellView[]`), which the model narrates; it is not
a pre-rendered diagram. The only box-ish characters in the codebase are `↔` arrows
inside *agent guidance* (model input, not user output, and a single arrow reads
fine). So this is presentation/phrasing polish, not a rip-out.

---

## Items

### 1. A "describe for ears" instruction (highest leverage): ✅ SHIPPED

**Status:** done. Added as a `DESCRIBE FOR EARS` block in `SERVER_INSTRUCTIONS`
(`packages/server-all/src/server/index.ts`), the cross-cutting shared guidance
sent once at the MCP `initialize` handshake, applied to all tools and all devices
at once, never per-tool (there is no separate "shared agent guidance" module; the
per-device `agentGuidance.ts` files stay device-specific). Build + typecheck +
smoke-server green.

Add a short accessibility directive to the server's MCP instructions
(`packages/server-all/src/server/index.ts`) and the shared agent guidance, so the
model presents results aloud-friendly by default:

- **Spatial layouts as a linear path, never a table.** Describe a signal chain or
  routing grid as prose: *"Signal flows: drive into amp into cab into reverb; the
  reverb is bypassed in scene 1."* Never render a row/column grid as monospace
  text.
- **Confirm each change in one short sentence with the device-confirmed value.**
  *"Amp gain set to 5.0, confirmed on the device."* Not a JSON blob, not a table
  of fields.
- **Read safety prompts as plain, unambiguous sentences.** *"This would overwrite
  preset A03, named 'Lead Tone'. Say 'overwrite' to proceed."*
- **State uncertainty in words.** When a write is sent but unconfirmed, say so in
  a sentence (*"Sent, but the device did not echo it back, so please confirm on
  the front panel"*), rather than surfacing `acked:false` raw.

This is one block of guidance text. It costs nothing at runtime and shapes every
reply. It should read as general good practice (it helps everyone), not as a mode
that toggles on.

### 2. `live_grid` narration cue: ✅ SHIPPED

**Status:** done. Added a clause to the `liveGrid` branch of the gen-3 get_preset
warning (`packages/fractal-gen3/src/reader.ts`) telling the model to narrate
`live_grid` as a linear signal path (Input → block → block → Output), not a
row/column grid or coordinates. Structured data unchanged.

The gen-3 `get_preset` warning (`packages/fractal-gen3/src/reader.ts`) already
explains the `live_grid` structure to the model. Add one clause telling it to
**narrate the grid as a linear signal path (Input → … → Output), not a grid
table**, so a screen-reader user hears the chain, not coordinates. Keep the
structured data exactly as-is; this only guides presentation.

### 3. Spoken-clean confirmations and warnings: ✅ SHIPPED

**Status:** done. Reworded the AM4 write not-acked warnings
(`packages/am4/src/descriptor/writer.ts`, 6 sites) to lead with the human outcome
("Sent, but the device did not confirm it. It may not have landed; check the AM4
display.") instead of jargon ("No ack within timeout" / "No write-echo within
timeout"). The gen-2 writer warnings already read as clean sentences ("verify by
audible/visible response on the device") and were left as-is. No live test asserts
on these strings (checked launch-verification / live-regression / agent-regression).

Write results already carry `display_value` + a `warning`. Audit the phrasing so
each reads as a clean sentence when the model relays it:

- Success: lead with the human outcome (*"reverb mix is now 25%"*), keep the wire
  detail out of the spoken line.
- The `unconfirmed` / `0x64 rejection` paths: confirm they paraphrase to a plain
  "it may not have landed, check the panel" rather than a code.
- This is mostly a wording pass over existing `warning` strings; no contract
  change.

### 4. Safety prompts read aloud (the moments that matter most): ✅ REVIEWED

**Status:** done (no text change needed). Reviewed the save-authorization refusal
(`buildSaveAuthorizationRefusal`, `core/src/server-shared/safeEdit.ts`) and the
AM4 dirty-buffer navigation gate (`am4/src/tools/safeEdit.ts`): each already names
the target location in device-local terms and states the exact phrase / argument
to proceed (`save_authorized: true`, `on_active_preset_edited="save_active_first"
| "discard"`). These are agent-facing guidance the model paraphrases, and item 1's
`DESCRIBE FOR EARS` directive now explicitly governs rendering them as plain
sentences naming target + proceed phrase. No gate-logic or message change made
(the strings are golden-tested; rewording for marginal gain risked breakage).

The read-before-write / overwrite gates are exactly where a blind user most needs
an unambiguous spoken sentence. Review the gate warnings (and
`docs/SAFETY-FOR-MUSICIANS.md`) so each overwrite/dirty-buffer prompt names the
target and the exact phrase to proceed, in one sentence. No gate-logic change,
only the message text.

### 5. Regression guardrail (optional, cheap): ✅ SHIPPED

**Status:** done. `scripts/verify-no-visual-tables.ts` scans every TS file under
`packages/*/src/` for Unicode box-drawing (U+2500–257F) and block-element
(U+2580–259F) glyphs in agent-visible strings (comments exempt), and is wired into
`npm run preflight` after `verify-no-internal-refs`. It deliberately does NOT flag
multi-space alignment (legit in model-facing agent_guidance) or arrow glyphs
(↔ → read fine aloud). **On first run it caught 3 real pre-existing offenders the
manual audit missed**: `── name ──` box-drawing dividers in the `lookup_lineage`
output of the AM4 and gen-2 readers, which were fixed (bare name headers; entries
were already blank-line separated). The guard now passes clean (172 files scanned).

Add a small check (a `verify-*` script in the preflight chain) asserting that no
tool *description* and no static output template embeds box-drawing characters
(`│ ─ ┌ ╔ …`) or multi-space column alignment, so a future contributor does not
reintroduce a screen-reader-hostile table. Lightweight, prevents drift.

### 6. Accessibility note in the docs: ✅ SHIPPED

**Status:** done. Added a "Using it with a screen reader" H2 section to `README.md`
(after "What you can ask Claude to do today"): the conversational surface is the
win, no separate mode, structured-data/narrated-for-the-ear behavior, the install
path, and an explicit invitation to file an issue for any reply that reads badly
aloud or any install step that fights a screen reader.

A short "Using this with a screen reader" section in `README.md` / getting-started:
the conversational surface is the point, here is the install path
([INSTALL-MAC.md](../INSTALL-MAC.md)), and an invitation to report any reply that
reads badly aloud. Signals the project takes it seriously and gives testers a
channel.

## Suggested order

1. Item 1 (the global "describe for ears" guidance): biggest effect, smallest change.
2. Items 2–4 (narration cue + phrasing/warning audit): same change set.
3. Item 6 (docs note).
4. Item 5 (guardrail): last, to lock it in.

## Validation

- No automated test can prove "reads well aloud"; the real check is the blind
  beta tester (the Reddit user). Item 5 catches the one objective regression
  (visual tables). Preflight stays green (text-only changes).
- Pair this with the install win: once he can install (the `@julusian/midi` swap /
  the `.mcpb`), this polish is what makes the *session* feel good.

## Non-goals

- No separate accessible UI or mode flag.
- No change to tool contracts, return shapes, or wire behavior.
- Not trying to make the model verbose: short spoken sentences, not essays.
