# Axe-Fx III: Community Beta Testing

> **For Axe-Fx III owners.** The III tool surface is fully implemented and
> wire-verified against public captures. **What we need is hardware
> confirmation:** does our implementation behave correctly against a
> real III? You don't need to capture anything. Install the server,
> run the calls listed below, and paste the JSON responses into a
> GitHub issue.

---

## Why this matters

The III protocol layer was built from:

- Fractal's published **v1.4 MIDI for Third-Party Devices** PDF (the only
  public spec; covers bypass / channel / scene / preset name / tempo /
  looper / tuner).
- 10 public wire captures of the III's parameter-write opcode (`fn=0x01`)
  collected from forum posts and FC-12 footswitch traffic (Session 97
  pivot, 2026-05-18). The envelope is byte-verified against those
  captures.
- Mining the AxeEdit III editor's bundled XML (`__block_layout.xml`)
  for 2,017 per-block parameter names with display labels and control
  types (about 90% of the catalog).

What's NOT verified: that all of this **runs correctly on real III
firmware**. The maintainer doesn't own a III, so every tool response
ships with a beta warning. Your test session (five minutes of clicking
through a handful of tool calls and pasting the JSON) flips the III
from 🟡 community-beta to 🟢 hardware-confirmed.

---

## What you need

- An Axe-Fx III on current firmware, connected by USB.
- The MCP MIDI Control release ZIP installed (see the project README
  for the 5-minute install path).
- Claude Desktop (or another MCP client) connected to the server.

That's it. No capture tools, no driver tricks, no developer setup.

---

## The test menu

Pick any of the calls below. The more you run, the more we learn.
Each one is safe; none of them write to a stored preset slot.

Open a chat with Claude and ask it to run the call, or run it through
your MCP client of choice. Paste the JSON response into a GitHub
issue titled `axefx3 beta test: <op name>`.

### 1. Identify the device

```
describe_device(port: 'axe-fx-iii')
```

Expected: returns the III's block roster, capabilities, and an
`agent_guidance` blob. This confirms the device is detected and the
server can talk to it.

### 2. Read the active preset name

```
axefx3_get_preset_name()
```

Expected: returns `{ presetNumber, name }` where both match what you
see on the III's front panel. **If the name doesn't match, that's the
single highest-value bug report you can file.**

### 3. Read the active scene

```
axefx3_get_active_scene()
```

Expected: returns `{ scene: 0-7 }` matching the scene shown on the
front panel.

### 4. Read tempo

```
axefx3_get_tempo()
```

Expected: returns the BPM shown on the front panel.

### 5. Read effect bypass + channel state for one block

Pick any block that's in your active preset (Amp 1, Drive 1, Delay 1,
Reverb 1 are common). The III uses effect IDs from Appendix 1 of the
v1.4 PDF; we list them in `describe_device`.

```
axefx3_get_bypass(effect_id: <id>)
axefx3_get_channel(effect_id: <id>)
```

Expected: returns the bypass + channel state matching the front-panel
display.

### 6. STATUS_DUMP for the active preset

```
axefx3_status_dump()
```

Expected: returns a list of `{ effectId, bypassed, channel, channelCount }`
entries, one per block in the active preset. Cross-check against
what the front panel shows.

### 7. Parameter write (the big one)

This is the call that ships behind the strongest beta warning because
the parameter-write opcode (`fn=0x01`) is not in the v1.4 spec; it
was decoded from public captures only.

Pick a knob you don't mind changing. Suggestion: load a scratch preset
and bump `Amp 1 Drive` by one or two units.

```
set_param(port: 'axe-fx-iii', block: 'Amp 1', name: 'drive', value: 5.5)
get_param(port: 'axe-fx-iii', block: 'Amp 1', name: 'drive')
```

Expected:
- `set_param` returns a success response with the beta warning banner.
- The III's front panel shows the new drive value.
- `get_param` echoes back the value we just wrote.

**If `set_param` succeeds but the front panel doesn't move**, that's
the highest-value finding: it means our wire shape lands but binds to
the wrong block / param. Please file an issue with the full JSON
response from both calls.

### 8. (Optional) Scene switch

```
switch_scene(port: 'axe-fx-iii', scene: 2)
```

Expected: front panel shows scene 3 (zero-indexed in the API).

---

## How to file the report

GitHub issues, title format `axefx3 beta test: <what you ran>`. In
the body include:

- III firmware version (System → Firmware on the front panel).
- Server version (it's in the install folder's `package.json`).
- The exact tool calls you ran.
- The JSON responses pasted as a fenced code block.
- What the front panel actually did (matched / didn't match).

**That's the whole contribution.** No captures, no `.pcapng` files, no
Wireshark setup. Five minutes for one test, half an hour for the full
menu.

---

## What happens after your report

For each call you confirm:

- ✅ matches front panel → maintainer flips the corresponding row in
  the III support matrix from 🟡 community-beta to 🟢 hardware-verified.
- ❌ doesn't match → maintainer opens a follow-up issue with the
  exact wire bytes the server sent (the server logs them). Usually the
  fix is one constant in the III descriptor: fast iteration once the
  symptom is in hand.

---

## Reference

- **Fractal published spec:** ["Axe-Fx III MIDI for Third-Party Devices" v1.4](https://www.fractalaudio.com/downloads/misc/Axe-Fx%20III%20MIDI%20for%203rd%20Party%20Devices.pdf)
- **III protocol decode summary:** [`docs/SYSEX-MAP-AXE-FX-III.md`](../SYSEX-MAP-AXE-FX-III.md)
- **Per-call wire shape:** `fractal-midi/src/axe-fx-iii/setParam.ts`
  in the upstream codec package. Every function's evidence chain is in
  the doc comments.
