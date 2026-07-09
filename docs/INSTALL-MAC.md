# Install on macOS

A short, one-time setup. It takes ~5–10 minutes, most of it waiting on
downloads. You do **not** need to be a developer, install a compiler, pay any
fee, or edit any files by hand.

> **A one-click install is coming.** A Claude Desktop Extension (`.mcpb`) that
> installs from inside Claude Desktop with no Terminal at all is in progress
> (see [accessibility plan](design/accessibility-blind-support.md)). Until it
> ships, the Terminal steps below are the way in, and they are short.

## Why this install is friction-free (no compiler, no security prompts)

The MIDI engine ships as a **prebuilt binary** that `npm` downloads for your
Mac's chip (Apple Silicon or Intel). Two things follow:

- **No build tools.** Earlier versions compiled the engine on your Mac (which
  needed Apple's Command Line Tools). That is no longer required: the binary is
  already built for your platform.
- **No Gatekeeper "unidentified developer" wall.** A binary fetched by `npm`
  (not downloaded in a web browser) is not quarantined by macOS, so it loads
  with no security prompt and no Apple Developer fee.

## Steps

1. **Install Node.js.** Go to <https://nodejs.org>, download the macOS
   **Installer (.pkg)** for the LTS version, double-click it, and click through.
   (This installer is Apple-approved, so it opens with no warnings.)

2. **Open Terminal.** Press `Cmd+Space`, type `Terminal`, press Return.

3. **Download the software with `git` (not your web browser).** Using `git`
   avoids the macOS security block that a browser download would trigger. Paste
   and press Return:

   ```
   git clone https://github.com/TheAndrewStaker/mcp-midi-control.git ~/mcp-midi-control
   ```

   (If Terminal offers to install developer tools the first time you use `git`,
   click Install, let it finish, then run the line again.)

4. **Run setup.** Paste these lines, pressing Return after each:

   ```
   cd ~/mcp-midi-control
   npm run setup-mac
   ```

   `setup-mac` downloads the prebuilt MIDI engine and registers the server with
   Claude Desktop for you, so you never touch a config file. (If you prefer, you
   can instead double-click **`setup-mac.command`** in the `~/mcp-midi-control`
   folder in Finder; it does the same thing.)

5. **Restart Claude Desktop.** Fully quit it with `Cmd+Q` (closing the window is
   not enough), then reopen it.

6. **Plug in your gear by USB** and ask Claude to connect. Fractal and ASM
   units work on macOS with no driver: macOS recognizes them automatically.

> **Rare fallback: if setup says the MIDI engine could not load.** This only
> happens if no prebuilt binary matched your Mac. Install Apple's free Command
> Line Tools, then rebuild the engine:
>
> ```
> xcode-select --install
> cd ~/mcp-midi-control && npm rebuild @julusian/midi
> ```
>
> The Command Line Tools are free and do not need any paid Apple account.

## Which devices work over USB on a Mac

Almost all of them, and with no driver. The Axe-Fx III, FM9, VP4, and AM4 are
class-compliant USB MIDI devices on macOS (they appear in Audio MIDI Setup),
as is the ASM Hydrasynth: plug in and go.

**The FM3 is the one special case.** Fractal's own documentation is explicit
that the FM3 is *not* a USB MIDI device on any OS; over USB its control
channel is a serial device (`/dev/cu.usbmodem…` on a Mac). This server
handles that automatically: when no FM3 MIDI port is found it looks for the
FM3's serial port and talks raw MIDI over it (community-beta, please report
how it goes). Two things to know:

- The FM3 serial port is **exclusive**: FM3-Edit or Fractal-Bot must be fully
  quit while Claude is talking to the FM3 (and vice versa).
- If the FM3's port isn't auto-detected (the "ask Claude to list MIDI ports"
  check will say so), tell the server the exact port. Find the name with
  `ls /dev/cu.usbmodem*`, then add it to the server's entry in
  `~/Library/Application Support/Claude/claude_desktop_config.json`:

  ```json
  "mcp-midi-control": {
    "command": "node",
    "args": ["…/dist/server/index.js"],
    "env": { "MCP_FM3_SERIAL_PATH": "/dev/cu.usbmodemXXXXX" }
  }
  ```

  (This is the one case where editing the config by hand is needed. Note that
  re-running `npm run setup-mac` rewrites the entry, so re-add the env line
  after an update.)

## Updating later

```
cd ~/mcp-midi-control
git pull
npm run setup-mac
```

Then fully quit and reopen Claude Desktop.

## If something goes wrong

- An error on the `git clone` or `npm` lines that mentions **"permission"** or
  **"unidentified developer"**: don't click through random security prompts.
  Note exactly which line failed and report it.
- **"command not found: node"** after step 1: quit and reopen Terminal so it
  picks up the new Node install, then retry.
- The MIDI tools don't appear in Claude after step 6: make sure you fully quit
  Claude Desktop with `Cmd+Q`, not just closing the window.

## Notes for the maintainer

**Update:** the native dependency has been swapped from `midi` to
`@julusian/midi` (API-compatible drop-in, ships N-API prebuilts). Two
consequences, both pending on-Mac confirmation (validate on the Intel iMac for
darwin-x64 and a community Apple-Silicon owner for darwin-arm64):

1. **The Xcode Command Line Tools step (step 3) is now usually unnecessary.**
   `npm install` fetches a prebuilt binary instead of compiling, so common Macs
   (arm64 / x64) need no toolchain. An npm-fetched prebuild is *not* quarantined
   (npm/git/curl don't set `com.apple.quarantine`), so it stays Gatekeeper-clean
   at runtime, the same property local compilation gave us. Keep `xcode-select`
   documented only as a fallback for platforms without a matching prebuild. Do
   not drop it from the user steps until a Mac confirms the prebuild fetch.
2. **The `.mcpb` Desktop Extension is now unblocked**: it was gated on exactly
   this swap. That double-click, no-Terminal, no-Gatekeeper install is the front
   door we want for non-technical and screen-reader users; see
   `docs/design/accessibility-blind-support.md`. This source-build path stays as
   the fallback.
