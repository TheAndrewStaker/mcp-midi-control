# Helping with the ASM Hydrasynth

<!-- contribution-meta
device_id: hydrasynth
support_tier: verified
transport: midi
preset_class: voice
owned_by_maintainer: yes
-->

## Device

ASM's wave-morphing digital synthesizer. This descriptor targets the
**Explorer**, the maintainer's own unit: eight banks of 128 patches, a 32-slot
modulation matrix, and eight macros with eight destinations each
(`packages/hydrasynth/src/descriptor.ts`). ASM's editor app is **Hydrasynth
Manager**.

This is a synth, so the tool surface is shaped differently from the guitar
processors here: patches are voices rather than block layouts, there is no
scene model, and whole-patch authoring goes through `apply_patch` rather than a
block-placement pipeline. Modulation matrix and macro-page routing are
authorable by name.

## Support status

| Capability | Status | Evidence |
|---|---|---|
| `set_param` / `set_params` | confirmed | Hardware-verified on the maintainer's Explorer. Decodes live in the codec package at `packages/fractal-midi/docs/devices/hydrasynth/SYSEX-MAP.md` |
| `get_param` / `get_params` | confirmed | Same |
| `apply_patch`, `init_patch` | confirmed | Same |
| `set_mod_route` (32 matrix slots) | confirmed | Source and target wire values resolve through name-backed tables (`packages/hydrasynth/src/descriptor.ts`) |
| `set_macro`, `set_macro_route` (8 macros, 8 destinations each) | confirmed | Same |
| `switch_preset` | confirmed | Same |
| Display-first non-linear parameters, envelope and LFO times | confirmed | The exponential bucket schedules carry both directions of their formula, and a preflight gate round-trips every display-first parameter over its full on-grid sample set |
| `save_preset` | not supported | The descriptor declares `supports_save: false`. Patches are authored into the working buffer; storing is done on the device |
| Dirty-buffer detection | not available | The Hydrasynth emits no MIDI dirty signal, so the safe-edit workflow's buffer-dirty gate has no input on this device |

Support tier: `verified`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/hydrasynth/src/descriptor.ts`, and preflight fails if
the two disagree.

## Confirmed on hardware

- The whole parameter surface, read and write, on an Explorer.
- Modulation matrix and macro-page routing by name.
- Whole-patch authoring.
- The non-linear display-first tables, which is the part most likely to be
  subtly wrong and is gated in preflight because of it.

**Please do not re-run these.**

## Blocked, and on what

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Anything specific to the **Deluxe** or the **Keyboard** | This project owns only an Explorer. The larger models add voices, controls and possibly parameters that the Explorer descriptor does not describe | REPORT-1, then SESSION-1 |
| A dirty-buffer gate | The device emits no MIDI signal when its working buffer is edited. Other devices here are gated by a fingerprint poll or a device push; neither exists here | Nothing a contributor can send. It is a device limitation |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Port exclusivity.** Hydrasynth Manager holds the USB port. Quit it fully
  before driving the server. On Windows check the system tray.
- **There is no dirty-buffer warning on this device.** On the guitar processors
  the server can refuse to navigate away from an edited buffer. Here it cannot
  see that state, so **store or abandon your own edits before you start**.
  Switching patches discards the working buffer without asking.
- **Save happens on the device, not through the server.** If you build something
  you want to keep, store it from the front panel.
- **Firmware updates.** Never run ASM's firmware updater while the server holds
  the port.
- **What we will never ask you to do.** No firmware modification, no opening the
  unit, no factory reset.

## Asks, ranked

### REPORT-1: Tell us if you have a Deluxe or a Keyboard
**Tier: REPORT | ~2 minutes | nothing is sent to the device | unlocks: coverage beyond the Explorer**

The descriptor is written against an Explorer. The larger Hydrasynths are the
obvious coverage gap and nobody has confirmed the descriptor routes to them
correctly, or whether their parameter surface differs.

In your MCP host:

> "List the available MIDI ports."

then

> "What can you see about my Hydrasynth?"

Paste both, and say which model you have. The port matcher is deliberately broad
enough to catch a short "hydra", so it will very likely match; what is unknown
is whether everything downstream is right for your model.

### SESSION-1: Read and write a few parameters on a Deluxe or Keyboard
**Tier: SESSION | ~10 minutes | writes to the working buffer | unlocks: cross-model confirmation**

Only worth doing if you have a model other than the Explorer.

Store or abandon any edits first, since there is no dirty gate here. Then:

> "Read the filter 1 cutoff on my Hydrasynth."

> "Set the filter 1 cutoff to 55."

> "Set envelope 1 attack to 250 ms, then read it back."

The third one matters most. Envelope and LFO times are the non-linear
display-first tables, where the panel reading and the underlying value are not
the same number. If a time lands somewhere other than what you asked for, that
is a real finding on your model.

Report each response next to what the device's own screen showed.

### SESSION-2: Audition a recipe and tell us what you heard
**Tier: SESSION | ~15 minutes | writes to the working buffer | unlocks: better recipe data**

Recipes are named starting points a player can call by name. The Hydrasynth
library is mostly auditioned on hardware already, but taste is not a decode, and
more ears make it better.

Ask for a tone by name, or describe one, and let the server build it. Then tell
us: what you reached for, what sounded right, and what you tweaked by hand to
fix it.

There is no telemetry and nothing is collected automatically. This is just you
telling us what you heard. Proposals for new recipes are welcome too; see
[`docs/RECIPE-AUTHORING-GUIDE.md`](../../RECIPE-AUTHORING-GUIDE.md).

### PROBE-1: Run the display-first round-trip gate
**Tier: PROBE | ~1 minute | no device needed at all | unlocks: nothing on its own, but it is how you check a suspicion**

If you think a non-linear parameter is landing wrong, this is the check that
either backs you up or clears the code. It round-trips every display-first
parameter over its full on-grid sample set and fails if any input or output
leaks an internal index or wire value. It needs no hardware.

From a source checkout:

```
npm run hydra:verify-display-first
```

If it passes and your device still lands somewhere odd, that is a genuinely
interesting report, because it means the table itself disagrees with your unit.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md). For this device, always include:

- exact model, Explorer, Deluxe or Keyboard,
- firmware version,
- operating system,
- the loaded patch,
- whether Hydrasynth Manager was open at the same time,
- for a recipe report, what you heard and what you changed by hand.

## When an ask closes

1. Move the capability's row in **Support status** to its new status word and
   cite the new evidence.
2. Add a line to **Confirmed on hardware** if a device confirmed it.
3. Delete the closed ask from **Asks, ranked**.
4. Update `capabilities.support_tier` and `capabilities.verification` on the
   descriptor if the tier moved. Preflight fails if the page and the descriptor
   disagree.
5. Update this device's row in [../README.md](../README.md).

The Hydrasynth has its own codec and shares it with no other device here, so
evidence from this page does not transfer.
