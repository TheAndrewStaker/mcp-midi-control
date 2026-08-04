# Helping with the <Device display name>

<!-- contribution-meta
device_id: <descriptor id, exactly>
support_tier: <verified | community-beta | generic-only>
transport: <midi | serial | storage | hybrid>
preset_class: <layout | voice>
owned_by_maintainer: <yes | no>
-->

> Copy this file to `<descriptor-id>.md` and fill it in. The filename must equal
> the descriptor's `id` string exactly. The section headings below are checked
> in order by `scripts/verify-contribution-guides.ts`, so keep them as they are.
> Every fact you write must cite the file you read it from.

## Device

One or two sentences: what the box is, what a player uses it for, and which
variants this page covers. Name the vendor editor or manager app, because
contributors will need to quit it.

## Support status

What the server can do with this device today, per capability. Status words are
`confirmed` (a device confirmed it end to end), `hardware-unverified` (the wire
logic is evidence-backed and shipping, no device has confirmed it), `set-only`
(writes work, there is no read path) and `gated` (refused at the tool boundary
because the wire shape is undecoded). See [../TIERS.md](../TIERS.md).

| Capability | Status | Evidence |
|---|---|---|
| `get_param` / `get_params` | confirmed | What confirmed it, and where that is written down |
| `set_param` / `set_params` | hardware-unverified | The capture, spec section or round-trip it is derived from |
| `set_block` | gated | What is undecoded |

Support tier: `<tier>`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/<pkg>/src/<path>`, and preflight fails if the two
disagree.

## Confirmed on hardware

One line per thing a real device has confirmed end to end, each with what
confirmed it. Keep this list honest and specific: it is what tells a
contributor "do not spend your evening re-testing this".

- `<capability>`: confirmed on `<firmware>`, `<platform>`. One line on how.

**Please do not re-run these.** They are done.

## Blocked, and on what

For each blocked capability, name the exact missing evidence and the exact ask
that would close it. "Blocked" here means the wire shape is genuinely
undecoded, not that a decoded capability is awaiting a key-press. Anything
decoded and shipping goes in Support status as `hardware-unverified`, never
here.

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| `<tool>` | The specific unknown: a byte, an offset, a value mapping | Ask id on this page |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Port exclusivity.** Which vendor app holds the port, and what to quit. Name
  the tray or menu-bar quit step, not just closing the window.
- **Mode switches.** If the device has mutually exclusive USB modes, name them
  and which asks need which.
- **Firmware updates.** Never run a firmware updater while the server or a probe
  holds the port. Quit the MCP host fully first.
- **What we will never ask you to do.** No firmware modification, no opening the
  unit, no factory reset, no bypassing any protection.

## Asks, ranked

Highest value first, regardless of tier. Each ask names its tier, the time it
takes, and the capability it unlocks. Stop when you have done one.

### DONATE-1: <short title>
**Tier: DONATE | ~N minutes | no device time | unlocks: `<capability>`**

What the file is. Where it lives on Windows and on macOS, with literal paths.
How to tell a usable file from a placeholder. What is inside it, so you can
decide to send it.

### PROBE-1: <short title>
**Tier: PROBE | ~N minutes | read-only | unlocks: `<capability>`**

The exact command, in both forms: the double-clickable script name from the
release package, and the source-checkout form. What the script sends, in one
sentence. Where it writes its output. What to send back.

Read-only guarantee: state what makes it read-only. It never saves, never
switches a preset or scene, and never changes a parameter.

### SESSION-1: <short title>
**Tier: SESSION | ~N minutes | writes to the working buffer | unlocks: `<capability>`**

In your MCP host, with the device connected and the vendor editor quit:

> "the exact sentence to paste"

Report the tool response verbatim, and what the device's own display showed.
The front panel is the ground truth here, not the vendor editor, which caches
stale state.

### CAPTURE-1: <short title>
**Tier: CAPTURE | ~N minutes | sniffer required | unlocks: `<capability>`**

One-time tool setup: [../tools/capture-setup.md](../tools/capture-setup.md).

The numbered action list. One action per burst with a pause between, so the
diff is unambiguous. Exactly what to write down alongside: device, firmware,
editor version, loaded preset, and the front-panel reading before and after
each action.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md) for the general form. For this device,
always include:

- device model and firmware version,
- operating system,
- the loaded preset or kit or memory,
- whether the vendor editor was open at the same time,
- for a SESSION ask, what the front panel did, in your own words.

## When an ask closes

Maintainer checklist, kept on the page so it cannot be forgotten. When evidence
lands for an ask on this page, in the same session:

1. Move the capability's row in **Support status** to its new status word and
   cite the new evidence.
2. Add a line to **Confirmed on hardware** if a device confirmed it.
3. Delete the closed ask from **Asks, ranked**, or reduce it to a one-line
   closed note if a sibling device still needs it.
4. Update `capabilities.support_tier` and `capabilities.verification` on the
   descriptor if the tier moved. Preflight fails if the page and the descriptor
   disagree.
5. Update this device's row in [../README.md](../README.md).
