# Submitting what you found

Open a [GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues)
using the **Hardware evidence** template. Attach files by dragging them into the
description box. Captures zip up well.

If you were following a specific ask from a device page, put its id in the ask
field: `PROBE-1`, `SESSION-2`, `CAPTURE-1`. That files your answer against the
right question.

No GitHub account? A reply on whichever forum or subreddit thread brought you
here is read too.

## Always include

Whatever the tier, these five lines make the difference between usable and
unusable:

1. **Device model and firmware version.**
2. **Operating system.**
3. **What was loaded** at the time: the preset, kit, memory or patch.
4. **Whether the vendor editor or manager app was open at the same time.** This
   matters more than it sounds. See [SAFETY.md](SAFETY.md) section 2.
5. **What the device itself did**, in your own words. The front panel is the
   ground truth, not the vendor editor and not the tool response.

Your device's page names anything extra that device needs.

## By tier

**REPORT.** Paste the answer. If it is a port list, paste the whole list rather
than the line you think is relevant; the surrounding entries are often what
identifies the routing bug.

**DONATE.** Attach the file. Say where it came from on disk, and for an editor
cache, say whether the editor had connected to your device before you grabbed
it. An editor install that never synced writes a placeholder with no model
names, and that file cannot be used.

**PROBE.** Attach the output file the script wrote, and its `.log` companion if
one exists. Add one line for anything odd you noticed: an error line, a surface
reported as silent, the run stopping early.

**SESSION.** Paste the tool response verbatim, and next to it say what the front
panel showed. Both halves are needed. A tool response alone cannot tell us
whether the device agreed.

> If the tool reported success and the panel did not move, say so plainly. That
> is the most valuable single report anyone can send, and it is the one thing no
> offline check can catch.

**CAPTURE.** Attach the `.pcapng` or the MIDI Monitor session file, plus your
written notes: the ordered list of actions you performed, and the front-panel
reading before and after each one. A capture with no notes usually cannot be
decoded, because the bytes have nothing to bind to. See
[tools/capture-setup.md](tools/capture-setup.md) for what makes a capture easy
to read.

## What happens next

Evidence that confirms a capability moves that capability's row on the device
page from `hardware-unverified` to `confirmed`, adds a line to that page's
"Confirmed on hardware" list, and updates the descriptor's own status field in
the same change. Evidence that decodes something new lands as a byte-exact
golden in the test suite plus a write-up in the relevant protocol map.

Either way the ask you answered gets removed from the page, so nobody spends
their evening re-running it.

## Credit

Contributions are credited in the change that lands them, in whatever form you
prefer, including not at all. Say which you want in the issue. This repo does
not publish contributor names by default.

## Licensing

Submitting a contribution means agreeing to the terms in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md) under "License and contributor
grant". For a file donation or a test report there is nothing to sign; opening
the issue counts.
