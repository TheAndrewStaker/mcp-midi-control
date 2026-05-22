# Getting started: what to say to Claude on day one

You installed it. Now what?

This guide is for guitarists, not developers. It's 6 conversations
that prove the tool works and build up your fluency.

> **First-time concerns?** Read `SAFETY-FOR-MUSICIANS.md` in this same
> folder before you start. It covers what the AI can and can't do to
> your saved presets. TL;DR: it can't save anything without you
> saying "save."

## Conversation 1: make sure it sees the device

Open a new Claude Desktop chat. Confirm `mcp-midi-control` is enabled in
the connector panel (look for the `+` near the chat input). Then ask:

> Using mcp-midi-control, list the MIDI ports you can see and tell me
> if my AM4 is detected.

What you should see: Claude calls `list_midi_ports`, reports something
like *"AM4 detected (in: AM4, out: AM4)"*. If it says the AM4 isn't
visible, replug the USB cable and ask again.

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

That's save-language. Claude calls `apply_preset` with
`target_location: "Z4"` and `save_authorized: true`, the server's gate
clears, and the tone persists to Z4 (the conventional scratch slot).

## Conversation 4: confirm the safety gate

Try to trip the gate:

> Build me a Marshall Plexi crunch at slot M3.

If the AI is well-behaved, it audits the tone WITHOUT saving (M3 is
your slot, not a scratch slot, and "build a tone at" isn't save
language). The server will refuse if the AI tries to save without
authorization, and the refusal message shows up in your chat.

Compare:

> Save a Plexi crunch tone to M3 and call it "Stones Rhythm."

Now save-language is explicit, gate clears, persists.

## Conversation 5: multi-preset (setlist)

A setlist is explicit multi-save intent. No per-preset
authorization needed, but the AI should pre-flight scan target slots
to surface overwrites.

> Build me a setlist for tonight's show:
>   - G1: clean Vox AC30
>   - G2: Plexi crunch
>   - G3: Mesa Mark IV lead
>   - G4: ambient cleans with delay + plate reverb
> Pre-flight scan G1-G4 first so I know what I'm overwriting.

Watch the AI call `scan_locations` first, surface "G1: Big Plexi,
G2: empty, G3: ..." for your review, then proceed once you confirm.
About 30 seconds wall time for 4 presets.

## Conversation 6: port a tone across devices

If you have more than one supported device plugged in (say an AM4 and
an Axe-Fx II XL+), the AI can port a tone from one to the other in a
single call. Same Fractal family ports with high fidelity; Fractal to
Hydrasynth surfaces what does and doesn't translate.

> Take whatever's in my AM4's working buffer and port it to the Axe-Fx II
> at slot 614. Don't save yet, just let me audition.

Claude calls `translate_preset` with `source_port: "am4"`, `target_port:
"axe-fx-ii"`, maps block roles (drive to drive, amp to amp, etc.),
translates params, and applies to the II's working buffer. The
response tells you what mapped cleanly, what was approximated, and
what was skipped. Once you like it:

> Save it to slot 614 and call it "AM4 Vox port."

## Conversation 7: when something goes wrong

If you accidentally overwrote a factory preset:

> Restore A1 to factory.

The `restore_defaults` tool puts that slot back to Fractal's factory
bytes. Single tool call, under a second.

If you accidentally renamed a working-buffer preset and the new name
is on screen but you haven't saved:

> Reload slot M3 to drop my edits.

Switching presets re-reads the saved bytes from flash. Original
state restored.

## Iterating on a tone

Once you have something in the working buffer, the AI can tweak
individual params without rebuilding from scratch:

> Drop the gain to 3 and bump the reverb mix to 50%.

That's `set_param` calls, one per change. Reversible by switching
presets.

> The reverb is washing out the attack. Make it 25% instead.

> Add a touch of compression too.

Until you say "save," every change lives only in the working buffer.

## The vocabulary that gets it right

| You say | AI interprets as |
|---|---|
| "build", "design", "make", "try", "audition" | Working buffer only |
| "save", "store", "keep", "put on N", "persist" | Save to slot |
| "setlist" / multiple slots named at once | Save to all (multi-preset) |
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
  semantics right ("the reverb is too loud" → `reverb.mix`, not
  `reverb.level`).
- Browse the tool list (`The tool surface` section in the README),
  though most of the time you won't need to know individual tool
  names. The AI picks them.
