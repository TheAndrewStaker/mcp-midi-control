# Testing: Axe-Fx Standard / Ultra

> Gen-1 supports **writing** parameters (922 of them), **reading** them back (function 0x02 query returns the live value plus the device's own label), and now **reading a preset's name + block layout** (`get_preset`, the spec-pinned subset of the patch dump -- per-param values are not included, that region of the dump is still undecoded). All of it is decoded from the spec but UNCONFIRMED on real Standard/Ultra hardware. The asks below take about 7 minutes combined and confirm what we can't verify from the spec alone.

> **Want preset BUILDING (`apply_preset` + save) on your Standard/Ultra?** One capture of a gen-1 AxeEdit editing session is the single unlock -- see [captures-axe-fx-gen1.md, section C2](captures-axe-fx-gen1.md).

See [README.md](README.md) for setup. Have old AxeEdit captures? See [captures-axe-fx-gen1.md](captures-axe-fx-gen1.md).

---

## T1 -- Port name (highest value, 2 min)
**~2 min | no tools**

In Claude Desktop:

> "List the available MIDI ports."

Paste the full output. The server matches your USB port by name to route to the correct codec (it looks for an Axe-Fx Standard or Ultra port). Older hardware may enumerate as "Axe-Fx MIDI" or similar, which would route to the wrong codec (gen-2). Your exact port name is the only thing needed to confirm or fix this before you try anything else.

---

## T2 -- Write confirmation
**~3 min | no tools**

Ask Claude to change any parameter you can see on the front panel:

> "Set the amp gain to 7 on my Axe-Fx."

Confirm the front panel moved and paste the response. The nibble-split codec is decoded byte-exactly from the published gen-1 SysEx spec, but has never been confirmed on real hardware.

---

## T3 -- Read confirmation *(new)*
**~2 min | no tools**

Pick a parameter you can see on the front panel, then ask Claude to read it:

> "What's the amp gain on my Axe-Fx right now?"

Paste the response and compare its value/label to the front panel. If it reports a value that matches, gen-1 read-back works on your hardware -- a big deal, because it's never been confirmed. If it times out (`no_ack`) or reports a wrong value, that's the most valuable thing to report: paste the full response and note your firmware version.

---

## T4 -- Preset name + block layout *(new)*
**~2 min | no tools**

With any preset loaded, ask Claude what's in it:

> "What preset is loaded on my Axe-Fx, and what blocks does it have?"

Compare the reported preset NAME and the list of blocks (amp, cab, delay, ...) to the front panel / LAYOUT screen. This exercises the gen-1 patch dump (`get_preset`) -- the spec pins the name and effect-grid regions but it has never been confirmed on hardware. Note: the response will say per-parameter values are not included; that's expected (that region of the dump is undecoded -- see the capture ask in [captures-axe-fx-gen1.md](captures-axe-fx-gen1.md), C1). If the name or block list is wrong, or the call times out, paste the full response + your firmware version -- that's the most valuable report.

---

## Submitting results

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) or reply to the Reddit thread. Include your exact USB port name (from T1), whether the panel moved (T2), whether the read matched (T3), and whether the preset name/blocks matched (T4). Firmware version and model (Standard vs Ultra) are also helpful.
