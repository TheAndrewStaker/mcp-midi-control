# Getting started: what to say to Claude on day one

You installed it. Now what?

This is an open-source MCP server for controlling MIDI gear by talking
to Claude. It has strict, opinionated rules that apply the same way to
every device:

- **Display-first.** You speak in front-panel units (a 0 to 10 knob, dB,
  ms, a ratio like 4:1, an amp name). The server never asks you to think
  in wire bytes.
- **No silent saves.** Nothing persists to memory unless you say so.
- **No silent edit loss.** It warns before discarding edits you made.
- **No silent overwrites.** It scans a target before writing over it.
- **Every write is acknowledged.** A change you ask for either confirms
  or reports why it could not.
- **Tempo-first.** Time-based settings can be set in musical terms.
- **Read before write.** It reads current state before changing it.

The point is consistency. The same instruction and the same guarantees
behave the same way whether the device is a guitar amp modeler or a
synthesizer. The examples below use a guitar modeler because it is
concrete, but a synth owner can follow the exact same flow: every place
this guide says "build a tone and audition it, do not save," a synth
owner says "build a patch and audition it, do not save," and the
audition-vs-save rules are identical. There is a synth-specific walk in
Conversation 7.

Any USB MIDI device works today through generic-MIDI primitives (CC,
NRPN, SysEx, program change, notes, clock). A growing set of devices have
deeper, first-class support (whole-preset or whole-patch authoring, tone
lineage, cross-device translation): the Fractal AM4 and Axe-Fx II XL+,
and the ASM Hydrasynth Explorer are hardware-verified, with several more in
community beta: the modern Fractal family (Axe-Fx III / FM3 / FM9 / VP4) and
the original Axe-Fx Standard/Ultra, the Novation Circuit Tracks (groove and
melody sequencing), the Roland SPD-SX (kit and sample authoring), and the Boss
VE-500 vocal processor.

This guide is written for musicians, not developers. It is a set of
conversations that prove the tool works and build up your fluency.

> **First-time concerns?** Read `SAFETY-FOR-MUSICIANS.md` in this same
> folder before you start. It covers what the AI can and can't do to
> your saved presets and patches. The short version: it can't save
> anything without you saying "save."

## Conversation 1: make sure it sees the device

Open a new Claude Desktop chat. Confirm `mcp-midi-control` is enabled in
the connector panel (look for the `+` near the chat input). Then ask:

> Using mcp-midi-control, list the MIDI ports you can see and tell me
> if my AM4 is detected.

What you should see: Claude calls `list_midi_ports`, reports something
like *"AM4 detected (in: AM4, out: AM4)"*. If it says the AM4 isn't
visible, replug the USB cable and ask again. (Synth owners: substitute
your device name, for example "tell me if my Hydrasynth is detected.")

## Conversation 2: read, don't write

Before letting Claude touch anything, prove it can READ:

> What preset is the AM4 currently on?

Claude calls `describe_device` or `get_param` and tells you the current
location. Cross-check with the AM4's display.

> What's the current scene number?

Same: a read-only round-trip. Confirms the wire path works in both
directions.

## Conversation 3: first audition (working buffer)

Now ask for a tone. **Don't say "save."** Use audition-language:

> Build me a clean Vox AC30 tone with light spring reverb and audition
> it. Don't save.

Claude builds the tone in the working buffer, meaning your AM4 plays
the new sound, but switching presets discards it. **The current
preset on flash is unchanged.** Confirm by switching to another
preset and back; the tone reverts.

If you like what you hear:

> Save this to Z4 and call it "Vox Light."

That's save-language. Claude calls `apply_preset` targeting Z4, the
server's save gate clears because you used save language, and the tone
persists to Z4 (the conventional scratch location).

## Conversation 4: confirm the safety gate

Try to trip the gate:

> Build me a Marshall Plexi crunch at location M3.

If the AI is well-behaved, it auditions the tone WITHOUT saving (M3 is
your location, not a scratch location, and "build a tone at" isn't save
language). The server will refuse if the AI tries to save without
authorization, and the refusal message shows up in your chat.

Compare:

> Save a Plexi crunch tone to M3 and call it "Stones Rhythm."

Now save-language is explicit, gate clears, persists.

## Conversation 5: multi-preset (setlist)

A setlist is explicit multi-save intent. No per-preset
authorization needed, but the AI should pre-flight scan target locations
to surface overwrites.

> Build me a setlist for tonight's show:
>   - G1: clean Vox AC30
>   - G2: Plexi crunch
>   - G3: Mesa Mark IV lead
>   - G4: ambient cleans with delay + plate reverb
> Pre-flight scan G1 to G4 first so I know what I'm overwriting.

Watch the AI call `scan_locations` first, surface "G1: Big Plexi,
G2: empty, G3: ..." for your review, then proceed once you confirm.
About 30 seconds wall time for 4 presets.

## Conversation 6: port a tone across devices

If you have more than one supported device plugged in (say an AM4 and
an Axe-Fx II XL+), the AI can port a tone from one to the other in a
single call. Same Fractal family ports with high fidelity; porting a
guitar tone to the Hydrasynth surfaces what does and doesn't translate.

> Take whatever's in my AM4's working buffer and port it to the Axe-Fx II
> at location 614. Don't save yet, just let me audition.

Claude reads the AM4's preset via `get_preset`, adapts block roles
(drive to drive, amp to amp, etc.) and translates params in
conversation, then applies to the II's working buffer via
`apply_preset` with `port: "axe-fx-ii"`. The response tells you
what mapped cleanly, what was approximated, and what was skipped.
Once you like it:

> Save it to location 614 and call it "AM4 Vox port."

## Conversation 7: the same flow on a synth

Everything above maps onto a synthesizer. Audition-vs-save is
identical; the only difference is the words for the sound (a "patch"
instead of a "tone" or "preset") and the device's memory addresses.

On the Hydrasynth, ask for a patch the same way you asked for a tone:

> Build me a warm analog pad and audition it. Don't save.

Claude calls `apply_patch`, which assembles the full voice (oscillators,
filters, envelopes, mixer, effects, and so on) in one call and plays it.
Nothing is written to memory. If you like it:

> Save it to location A005 and call it "Warm Pad."

That's save-language, so the patch persists to that location. The same
no-silent-save and read-before-write rules apply, and the AI will tell
you when a saved patch would overwrite something.

You can also start from a curated recipe instead of describing
everything from scratch. Just as `apply_preset` accepts a `recipe_id` on
the guitar side, `apply_patch` accepts one on the synth side:

> Build me a patch from the "growl_wobble" recipe, then make the filter
> a little brighter. Audition only.

Claude materializes the recipe, applies your brightness tweak on top,
and auditions it. To discover available recipe ids, ask Claude to
describe the device. And you can route by name in plain language, for
example "wire LFO 1 to filter cutoff" or "set Macro 1 to open the
filter," without touching the front panel.

## When something goes wrong

If you accidentally overwrote a factory preset, reload the factory
image from the device itself: the AM4 has a front-panel factory-restore
sequence (hold the relevant buttons during power-on), and AM4-Edit has
a "Restore Factory Default" menu. The MCP server doesn't bundle vendor
factory binaries. Synths have their own factory-restore procedure in
their manual; the principle is the same.

If you accidentally renamed a working-buffer preset and the new name
is on screen but you haven't saved:

> Reload location M3 to drop my edits.

Switching presets re-reads the saved bytes from flash. Original
state restored. (On the Hydrasynth there is no working-memory read over
MIDI, so if you turned knobs on the device itself after a build, save
those by pressing the device's own SAVE button rather than asking the
AI to "save my current sound.")

## Iterating on a tone

Once you have something in the working buffer, the AI can tweak
individual params without rebuilding from scratch:

> Drop the gain to 3 and bump the reverb mix to 50%.

That's `set_param` calls, one per change. Reversible by switching
presets.

> The reverb is washing out the attack. Make it 25% instead.

> Add a touch of compression too.

Until you say "save," every change lives only in the working buffer.
The same holds on a synth: nudge a filter or an envelope, audition,
and nothing persists until you say so.

## The vocabulary that gets it right

| You say | AI interprets as |
|---|---|
| "build", "design", "make", "try", "audition" | Working buffer only |
| "save", "store", "keep", "put on N", "persist" | Save to location |
| "setlist" / multiple locations named at once | Save to all (multi-preset) |
| "tweak", "change", "adjust", "nudge" | Single-param edit in working buffer |
| "what's on M3?" / "show me" | Read-only |
| "restore X to factory" | Factory restore (destructive but recoverable) |

## What if it does the wrong thing?

You stop it. Every Claude Desktop tool call is visible in the tool
panel before it executes, so you can refuse any call you don't like.
The server's refusal gates are a safety NET; your "no" in chat is
the primary mechanism.

If the AI insists on a wrong path:

> Stop. Don't save anything. Just audition at Z4 until I say
> otherwise.

Then keep iterating from there.

## When the tool doesn't show up in Claude Desktop

If after `setup.cmd` and a full Claude Desktop relaunch you still
don't see mcp-midi-control in the connector panel, check Claude
Desktop's MCP log. On Windows (Microsoft Store install) it lives at:

```
%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\logs\mcp-server-mcp-midi-control.log
```

(Paste that path into File Explorer's address bar and press Enter.)

The log usually says exactly what went wrong: native MIDI module
failed to load, path not found, port already in use, etc. Send the
last 50 lines to the GitHub issues tab if it's not self-explanatory.

## What's next

- Read `SAFETY-FOR-MUSICIANS.md` for the full safety model.
- Read `VOLUME-CONTROL.md` if you're not getting the loudness
  semantics right ("the reverb is too loud" maps to `reverb.mix`, not
  `reverb.level`).
- Browse the tool list (`The tool surface` section in the README),
  though most of the time you won't need to know individual tool
  names. The AI picks them.
- Want a device the server doesn't cover in depth yet? Adding a device
  is a descriptor, not new tools. Line 6 Helix and other popular amp
  modelers, instruments, and synthesizers are on the near-term roadmap,
  and contributions are welcome through the GitHub repo.
