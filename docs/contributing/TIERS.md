# The five contribution tiers

Every device page uses the same five rungs, whether the box is a guitar
modeler, a synth, a sampler, a loop station or a drum pad. The tiers are
ordered by **contributor effort**, lowest first.

| Tier | What you do | Time | Device needed | Tooling | Safety posture |
|---|---|---|---|---|---|
| **REPORT** | Tell us the device exists, or answer one factual question (a USB port name, a menu label, a page in the manual) | ~2 min | No | None | Zero risk. Nothing is sent to the device |
| **DONATE** | Send a file your computer already holds: an editor definition cache, a preset backup, a project file, a kit folder | ~5 min | No, the file already exists | None | Zero risk to the device. Read the file first if you want to; every ask says what is inside it |
| **PROBE** | Run one read-only command | 5 to 15 min | Yes, connected | Node, or a double-clickable script from the release package | **Read-only.** No saves, no preset switch, no parameter change |
| **SESSION** | Drive the server from a normal conversation and tell us what the device actually did | 10 to 30 min | Yes, connected | Any MCP host | Writes reach the device, working buffer only. Nothing is saved unless you ask for a save in your own words |
| **CAPTURE** | Record the wire while the vendor editor talks to your device | 15 to 45 min | Yes, plus the vendor editor | USBPcap and Wireshark, or MIDI Monitor | Recording only. Nothing this project sends touches the device |

## Two rules about tiers

**Effort orders the tiers. Value orders the asks.** A device page lists its
asks ranked by what they unlock, and each ask carries its tier label. On one
device the top ask is a DONATE (send the editor cache and a whole parameter
dictionary lands offline). On another it is a CAPTURE (one editing session is
the only way to see an undecoded write). The tiers are not a queue to work
through in order. Do the top ask on your device's page, or the cheapest one you
can manage, and stop. Every rung is genuinely useful on its own.

**Ask ids are `TIER-n`**, unique within a device page: `PROBE-1`, `SESSION-2`,
`CAPTURE-1`. So "please do PROBE-1 on your MiniFreak" resolves to exactly one
thing, and you can put that id in your issue so the answer files itself against
the right question.

## What each tier can and cannot settle

- **REPORT** confirms a model and firmware combination is in the wild, and
  fixes routing bugs. The server matches your device by USB port name, so the
  exact string your operating system reports is a real answer to a real
  question.
- **DONATE** is the biggest jump per minute where it applies. A vendor editor
  that has synced with your device stores the device's own dictionary on your
  disk. That file answers dozens of questions at once, offline, with the device
  switched off.
- **PROBE** harvests device-resident data that cannot be obtained any other
  way: model rosters, parameter ranges, the exact enum spellings your firmware
  uses. It also confirms the read path end to end.

  > **A probe that can be validated against a known device carries far more
  > weight.** When the same script reproduces an already-confirmed answer on a
  > device we do own, its answer on a device nobody here has ever seen becomes
  > evidence rather than a hopeful guess. Where that self-check exists, the ask
  > says so and asks you to run it. It is also why a probe's **null** result is
  > worth reporting: on a validated method, "nothing answered" is a decoded
  > negative, not a failed run.
- **SESSION** is the only tier that can confirm a **write**, because confirming
  a write needs a human reading the front panel. This is what converts
  `hardware-unverified` into `confirmed`.
- **CAPTURE** is the only tier that can decode a write shape nobody has decoded
  yet, because it sees what the vendor editor sends. This is what un-gates a
  capability that currently refuses.

## Reading the status words

Two vocabularies, used consistently. Never mixed with release-cadence words.

| Where it appears | Values |
|---|---|
| Per-device support tier | `verified`, `community-beta`, `generic-only` |
| Per-capability status | `confirmed`, `hardware-unverified`, `set-only`, `gated` |

- `confirmed`: a real device confirmed this end to end.
- `hardware-unverified`: the wire logic is evidence-backed and shipping. It
  works as far as we can check without a device. No device has confirmed it.
- `set-only`: writes work, there is no read path, so the device cannot tell you
  what it is holding. Your ears and the front panel are the verification.
- `gated`: refused at the tool boundary on purpose, because the wire shape is
  undecoded and we do not ship guesses.

See [EVIDENCE.md](EVIDENCE.md) for why `hardware-unverified` is a shipping
state and not a missing feature.
