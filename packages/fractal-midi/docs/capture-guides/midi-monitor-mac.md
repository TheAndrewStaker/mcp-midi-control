# MIDI Monitor capture guide (macOS)

MIDI Monitor by Snoize is the standard tool for capturing SysEx traffic on Mac. It captures at the CoreMIDI layer, which means it sees all MIDI messages in both directions -- including what AxeEdit or another editor sends to your device. No kernel extension or system extension approval required on macOS Ventura / Sonoma / Sequoia with MIDI Monitor 2.x.

Download: [snoize.com/midimonitor](https://www.snoize.com/midimonitor/)

## When to use this guide

Use this when you want to capture what a Fractal editor (AxeEdit III, FM9-Edit, VP4-Edit, AM4-Edit) sends to your device while it connects and syncs. This is the Mac equivalent of the [USBPcap + Wireshark](usbpcap-wireshark.md) guide used on Windows.

**FM3 exception:** MIDI Monitor cannot capture FM3-Edit traffic. The FM3 is not a USB MIDI device on any OS; FM3-Edit talks to it over a USB-CDC **serial** channel (`/dev/cu.usbmodem…`), which never touches CoreMIDI. To capture FM3-Edit traffic on a Mac, use a serial-level method instead (e.g. the lldb `write()` breakpoint technique). All the other devices here (III, FM9, VP4, AM4) are true CoreMIDI devices and capture normally.

## Enabling spy mode

MIDI Monitor has two capture modes:

- **Standard mode**: shows messages your device sends to the computer (device-to-host only)
- **Spy mode**: also shows messages other apps send to MIDI ports (host-to-device, including what the editor writes)

For capturing editor traffic, spy mode is required.

1. Open MIDI Monitor.
2. Open **Preferences** (Cmd+,).
3. Check **"Spy on output to destinations"** (the label may vary by version -- look for anything mentioning "spy" or "output").
4. If prompted to grant access or approve a background helper, allow it.
5. Close Preferences. The title bar will show "MIDI Monitor (Spy Active)" or similar when spy mode is running.

## Raise the message limit (do this before capturing)

MIDI Monitor keeps only its most recent N messages and discards older ones. Fractal editors **poll the active preset continuously at hundreds of messages per second**, so with a low cap that read-poll flood flushes your actual edit / knob-sweep frames out of the buffer before you save. You end up with a file full of small read polls and none of the writes you cared about. This is the single most common cause of an unusable capture.

1. In the **main window toolbar**, just above the message list, find the **"Remember up to N events"** field (next to the **Clear** button) and set it to a very large number. The default is **1000**, which the editor's poll flood blows through in seconds.
2. Capture as normal.
3. **Sanity-check the result:** a real session is **several megabytes**, not kilobytes. If your saved `.mmon` is tiny, the cap was too low: raise it and recapture. You can also confirm a **To-device SysEx that is clearly longer than the steady stream of small read-poll messages** appears near each action; that longer message is your write / sweep frame.

## Starting and stopping (there is no record button)

MIDI Monitor has no record / stop button: as soon as a source is checked it listens continuously and the message list keeps updating. That is expected, not a malfunction.

- **Start:** check your device in the **Sources** panel (with spy mode on, per above). It is now capturing.
- **Freeze / stop:** uncheck your device in the **Sources** panel, or quit the editor (FM9-Edit) so nothing is being sent. The list stops growing.
- **Save:** **File > Save As** to a `.mmon` file. You can save at any time without stopping first; freezing the buffer (uncheck the source) just guarantees nothing new pushes your sweep frames out before you save.

## Capturing an editor sync session

1. Connect your Axe-Fx III (or FM3 / FM9) via USB.
2. Open MIDI Monitor with spy mode active.
3. In the Sources panel, make sure your Axe-Fx is listed. Both directions ("in" and "out" ports, if shown separately) should be checked.
4. Open AxeEdit III and let it fully connect and sync to the device. Wait until the editor finishes loading -- preset list populated, grid rendered, no loading spinners.
5. Once you are done, freeze the buffer (uncheck the source in the **Sources** panel, or quit the editor) and use **File > Save As** to save a `.mmon` file (MIDI Monitor's native format), or **File > Export > SysEx** / copy-paste the message log.

If you're not sure the sync is complete, make a small change in the editor (like clicking a block type) and wait a moment. The editor should settle.

## What to share

Share the saved `.mmon` file or a plain-text copy of the message log. Both work for decode analysis. GitHub issues accept file attachments directly.

If spy mode doesn't show editor-to-device traffic (the messages appear empty when the editor is open), try restarting MIDI Monitor after enabling spy mode, or confirm spy mode is shown as active in the title bar.

## Pairing with the testing and captures guides

If you've already completed the read/change/save tests from your device's testing page (linked in the [guides index](README.md)), your device and server are confirmed working. The capture sessions are a separate step and do not require the MCP server to be running -- just your device and its editor. See the [captures guide](captures-gen3.md) for the full ask descriptions.
