# Safety: what every guitarist needs to know

You spent hours dialing in those presets. This tool is between you and the AI.
Before you install, here's exactly what the AI can and can't do to your gear.

## Plain-English summary

- **The AI cannot overwrite a preset without you saying "save."** Building a
  tone is reversible (it's in the device's working buffer; switching presets
  throws it away). Saving is permanent. The two are separate steps the AI
  has to explicitly ask for.
- **The AI cannot accidentally throw away edits you're in the middle of
  making.** If you've been tweaking knobs (in any source: chat, AM4-Edit, or
  the device's own buttons), and the AI tries to change presets, the server
  refuses and asks you whether to save or discard first.
- **There's a designated scratch slot.** `Z04` on the AM4 is the
  convention; the AI will use it for try-it-out tones unless you say
  otherwise.
- **Factory restore is one tool call away.** If you do clobber something,
  Fractal's factory presets are loadable straight from the AM4's flash.
- **You can read everything the AI does.** Every tool call shows up in
  Claude Desktop's tool panel, with its arguments. You can refuse any
  call you don't like.

## The three safety gates

Every supported device enforces the same three rules at the server level,
applied to whatever that device can persist: the working buffer and stored
presets on the guitar amps and the Hydrasynth, a stored kit and its wave pool
on the Roland SPD-SX, a project slot on the Novation Circuit Tracks. They're not
"the AI is supposed to follow"; they're "the server refuses to do this
regardless of what the AI asks." Documented in `docs/SAFE-EDIT-WORKFLOW.md` if you want the
implementation details.

### Gate 1: save-authorization

Tools that persist to a slot (e.g. `apply_preset` with a target
location, `save_preset`, `apply_patch` with `save: true`) refuse
by default. The AI has to *explicitly* pass `save_authorized: true`,
which it should only do when you used save-intent language:

| You said | AI interprets as |
|---|---|
| "save this to G1" / "store as M03" / "put it on Z04" | Save-authorized ✓ |
| "keep it" / "persist this preset" | Save-authorized ✓ |
| "build a tone at slot 700" / "design a Plexi preset" | NOT authorized (audition only) |
| "try out a Vox AC30 sound at H01" | NOT authorized (audition only) |

If the AI misreads "design a tone at G1" as save intent, the server
refuses with a message naming the working-buffer-only alternative,
visible in your Claude chat. You see the refusal text yourself.

### Gate 2: dirty-buffer warning

If the AI has been editing a preset (set_param, apply_preset, anything
that mutates the working buffer through the MCP server) and then tries
to navigate to a different preset, the server refuses with a structured
warning:

> REFUSING TO NAVIGATE: location M03 ("Mesa Lead") has unsaved
> working-buffer edits.
>
> Navigating away would DISCARD those edits silently. Ask the user how
> to proceed:
>   • "save first" → call this tool again with
>     on_active_preset_edited="save_active_first"
>   • "discard" → call this tool again with
>     on_active_preset_edited="discard"

You see this message in chat. The AI is supposed to ASK you which one;
you tell it, and only then does it retry. This catches "the AI was
building my new lead tone but loaded a different preset and lost it",
the most expensive failure mode for a working musician.

**Scope honesty (knobs you turn yourself).** This gate catches edits
the AI makes through the MCP server. Edits you make directly on the
device's front panel (turning knobs, toggling bypass, switching
scenes from the hardware) are NOT detected on AM4 or Hydrasynth.
The Axe-Fx II broadcasts its dirty state, so it catches both kinds.
AM4 and Hydrasynth do not. We verified by capture: the AM4 emits
zero MIDI bytes when you turn a knob, and there's
no broadcast for us to listen for. Practical advice: **if you've
been editing on the device's front panel, save on the device before
asking the AI to load a different preset.** Or just tell the AI
"discard my front-panel edits, then load A1" and the AI will pass
`on_active_preset_edited: "discard"` and proceed. The gate is
fail-safe in the agent-driven path; not magic in the human-driven
path.

### Gate 3: multi-preset overwrite warning

If you ask for a setlist ("build 5 presets in slots G01-G05"), the
intent IS save (you said "build 5 presets", that's a save). But the
server still pre-flight-scans the target range and surfaces what would
be overwritten, so the AI can tell you what you'd lose before it runs.

## What happens if it goes wrong

**Scenario: AI saved something you didn't want.**

Fractal's factory presets are reloadable from the device itself.
On the AM4, hold the relevant buttons during power-on to restore a
single slot or the full bank from the built-in factory image, or use
AM4-Edit's "Restore Factory Default" menu. The MCP server doesn't
bundle Fractal's factory binaries (copyright + firmware-version
concerns); a future release may let you point it at a locally
downloaded factory bank file.

**Scenario: AI accidentally renamed your preset.**

Rename is working-buffer-only by default. If the AI changed the name but
didn't call save, the original name is intact on flash. Load the slot
again to refresh from flash.

**Scenario: AI overwrote a slot you actually cared about.**

Z04 is the convention for "scratch / try-it-out." If you keep your
personal presets in A-Y (banks A through Y, 4 presets each = 100 slots
of personal space) and leave Z04 for scratch, the AI defaults align
with this convention. You can tell the AI "use M03 as your scratch
slot" and it'll switch.

If you want extra insurance, AM4-Edit can export a `.syx` backup of
every slot. Save one of those somewhere on disk before you start
serious AI sessions; that's your full-flash recovery file.

## What the AI cannot do

- **Cannot read your saved presets without permission.** Scanning
  (`scan_locations`) is for "what's in bank G?", not background spying,
  and it is slow enough that you would notice. On the AM4 it is purely a
  read: the device never moves. **On the Axe-Fx II it is not**, because
  that device has no way to read a name without loading the preset, so a
  scan steps through each slot in turn and lands you back where you
  started. Anything you had edited and not saved is gone. The AI is
  refused if you have unsaved edits, and has to be told explicitly to
  discard them or save them first.
- **Cannot send arbitrary SysEx without you explicitly asking for it.**
  The `send_sysex` primitive exists for developers; it's not a path the
  AI takes during normal "build me a tone" conversations.
- **Cannot persist anything you can't see in chat.** Every change is a
  tool call you can read.

## What to say to the AI

The plain-English vocabulary that gets it right:

- **"Try out X":** working buffer only, reversible
- **"Audition X at Z04":** write to scratch slot for listening, doesn't save
- **"Save this as 'My Lead' at M03":** write + name + persist
- **"Build a setlist for tonight's show: clean at G01, crunch at G02..."**
  multi-preset save (the explicit slot list = explicit save intent)
- **"What's on H02?":** non-destructive read

When in doubt, the AI should default to audition mode (working buffer
only). If it doesn't, the server's refusal gates will surface to you in
chat, and you can correct course before anything persists.

## How to verify the gates are actually working

If you want to confirm the safety gates work on your installation,
open a new Claude Desktop chat with the `mcp-midi-control` connector
active and ask:

> Build me a preset at Z04 without saving it. Then immediately
> try to switch to A01. I want to see what happens with unsaved edits.

Claude will build the tone in the working buffer, then try to navigate
away. The dirty-buffer gate (Gate 2) should fire and produce a refusal
message naming the unsaved buffer before Claude switches presets. If the
gate fires, the safety story is working on your hardware.

For Gate 1 (save-authorization), try:

> Design a Mesa Rectifier preset and put it on M03.

"Put it on" is not save language; Claude should audition at M03 without
persisting. Compare with:

> Save a Mesa Rectifier preset to M03.

That uses "save", so save-authorization clears and Claude will write to M03.
Watch the tool panel: `apply_preset` with `save_authorized: false` is
an audition; with `save_authorized: true` is a persist.

## TL;DR for the impatient

1. The server refuses to save unless you used save-language.
2. The server refuses to switch presets if you have unsaved edits.
3. Factory restore is one tool call away if anything goes sideways.
4. Z04 (AM4) is the scratch slot. Use any letter you want for personal
   presets; AI follows your convention.
5. Every tool call is visible in Claude Desktop's tool panel. Refuse
   any you don't like.

That's the floor. The ceiling is whatever you ask the AI to do.
