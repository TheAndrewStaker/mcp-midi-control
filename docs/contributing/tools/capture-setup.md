# Capture setup (one-time)

How to record the USB or MIDI traffic between a vendor's editor app and your
hardware. Do this once, then follow the CAPTURE-tier asks on
[your device's page](../README.md).

This applies to any brand, not just Fractal. A Novation, Roland or Arturia
capture uses the same tools; only the manufacturer prefix in the bytes differs.

**Nothing here changes or risks your presets. You are only recording traffic.**
This project sends nothing to your device during a capture; the vendor editor
does all the talking.

> **Prefer not to install anything?** Two zero-setup options cover most of what
> is needed before any capture, and they are usually higher value anyway:
>
> - your editor's offline **definition cache file**
>   ([editor-cache-file.md](editor-cache-file.md)), which needs no tools and no
>   device time, and
> - the one-command read-only **harvest script**
>   ([harvest-script.md](harvest-script.md)), which writes one JSON file.
>
> Captures are only needed for the few wire shapes neither of those reaches,
> which in practice means: a write direction nobody has decoded, or a display
> value that only the editor knows.

---

## Windows: Wireshark + USBPcap (recommended)

USBPcap watches the USB cable directly, so it sees both directions even though
the editor holds the MIDI connection.

**Install (once)**
- Download Wireshark from wireshark.org and run the installer.
- On the components page, **check "Install USBPcap"** (off by default, easy to miss).
- Finish, then **reboot**. USBPcap is a driver, so it won't appear until you restart.

**Record**
- Plug the device straight into a **rear USB port** (not a hub). Open the editor app.
- Open Wireshark. On the start screen, hold **Ctrl** and click **every** interface
  named `USBPcap…` so all are selected, then **Start**. (Recording all controllers
  guarantees your device is captured; we sort out the rest.)
- Do the steps from your device's capture list, pausing about 3 seconds between
  each action.
- **Stop**, then **File, then Save As**, and save as a `.pcapng` file.

**Confirm it's working:** click around in the editor. You should see packet bursts
in time with your clicks, and they go quiet when you stop.

*Optional advanced check:* every manufacturer has its own SysEx prefix, and you
can search for it. Fractal messages start with `F0 00 01 74`; Arturia messages
start with `F0 00 20 6B`. In recent Wireshark, use **Edit, then Find Packet**,
set the search type to **Hex value**, and search the prefix (exact menu wording
shifts between versions). The "bursts in time with clicks" check above is enough
on its own.

**If interfaces don't appear or capture fails:** close Wireshark and reopen it with
**Run as administrator**.

---

## macOS: MIDI Monitor

- Install **MIDI Monitor** by Snoize (free, snoize.com) and open it.
- In the **Sources** list, tick your device. That window also has a separate
  **"Spy on output to destinations"** entry; tick your device there too. Sources
  captures the device's replies; the Spy entry captures what the editor sends.
  Exact wording may differ slightly by MIDI Monitor version.
- **Raise "Remember up to N events" in the main toolbar before you start.** The
  default of 1000 is the single biggest cause of an unusable capture: a vendor
  editor's read-poll can flood the buffer and flush your edits out of it before
  you save. Set it to the maximum. There is no record or stop button either;
  untick the source to freeze the log, then File, then Save As. A good capture is
  several megabytes, not kilobytes.
- Open the editor and do your device's capture steps.
- **Important check:** you must see messages in **both** directions, "To
  <device>" and "From <device>". The "From" replies are the valuable part. If you
  only ever see "To", MIDI Monitor cannot see replies on your setup; say so in
  your issue and a USB-level fallback can be suggested.
- Save the session document. For individual messages, "save as received" writes a
  `.syx`.

**One macOS exception: the Fractal FM3.** It is not a USB MIDI device on any
operating system, so it does not appear to CoreMIDI at all and MIDI Monitor
cannot see it. Its USB control channel is a serial port. See
[../devices/fm3.md](../devices/fm3.md).

---

## What makes a capture easy to read

- **Write down the starting state:** device and firmware, the loaded preset (number
  and name), and the editor version. The bytes only mean something with that context.
- **One action per burst, with pauses.** Idle about 3 seconds, do exactly one thing,
  idle about 3 seconds. Those gaps separate each action cleanly, which is the single
  biggest time-saver for us.
- **Trust the front panel,** not the editor, when noting a before/after value (the
  editor sometimes shows a cached value).
- **Name files after the action** (for example `fm9-receive-preset.pcapng`) and add
  a one-line note per file of what you did.

---

## Where to send

See [../SUBMITTING.md](../SUBMITTING.md). Short version: open a GitHub issue
with the Hardware evidence template and drag the file into the description box.
Larger captures zip up well.

Always send your written notes with the file. A capture with no notes usually
cannot be decoded, because the bytes have nothing to bind to.
