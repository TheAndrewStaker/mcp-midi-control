# Contributing

Thanks for your interest. There are three contribution paths, ordered
from "no code" to "deep RE work":

1. **Test what's shipped and report back.** You own a supported device,
   install the server, run a small list of tool calls, and report
   whether the front panel matches the response. Five minutes per
   device, no developer setup. **This is the most valuable
   contribution right now**, especially for Axe-Fx III owners. See
   [`docs/community/axefx3-beta-testing.md`](docs/community/axefx3-beta-testing.md)
   for the III test menu. Same shape works for any device: pick a
   handful of tool calls, run them, paste the JSON.
2. **Add a device.** Write a `DeviceDescriptor` for a new piece of MIDI
   gear. The unified tool surface is device-agnostic; adding FM9, FM3,
   or a new vendor's synth is a TypeScript object, not new MCP tools.
   See [Adding a new device](#adding-a-new-device) below.
3. **Decode a protocol.** Capture wire traffic from a device, decode
   the envelope, and add a byte-exact golden. See
   [Capturing MIDI traffic](#capturing-midi-traffic) below.

## License

By submitting a contribution (pull request, patch, issue with a code
suggestion, or any other form), you agree that your contribution is
licensed under the project's license (**Apache License 2.0**) as
described in the [`LICENSE`](./LICENSE) file. You also certify that
you have the right to submit the contribution under that license
(e.g. it is your original work, or you have permission from the
copyright holder).

No separate contributor license agreement (CLA) or developer
certificate of origin (DCO) sign-off is required at this stage.

## Path 1: Test and report (no code)

The simplest contribution. You need:

- A supported device on USB.
- The release ZIP installed (5 minutes; see project README).
- Claude Desktop (or another MCP client) connected.

Run any tool call against your device, paste the JSON response into a
GitHub issue, and note whether the device's front panel did what the
response says. That's it.

The Axe-Fx III is the most-wanted target for this right now. The wire
shapes are decoded from public captures but no III owner has confirmed
end-to-end. See [`docs/community/axefx3-beta-testing.md`](docs/community/axefx3-beta-testing.md)
for a concrete 5–30 minute test menu.

## Path 2: Add a device

The unified tool surface is device-agnostic: adding a new device means
writing a **`DeviceDescriptor`**, a TypeScript object that describes
the device's capabilities, blocks, and wire adapters. No new MCP tools
are needed.

### Step 1: Create a new package

Copy the Axe-Fx III package as a template:

```
packages/axe-fx-iii/    ← copy this entire directory
packages/<your-device>/ ← rename and adjust
```

Key files to update:

| File | What to change |
|---|---|
| `package.json` | `name`, `description` |
| `src/descriptor.ts` | Block roster, capabilities, `port_match` regex, beta-warning banners for unverified ops |
| `src/midi.ts` | Port-discovery needles, connection helper |
| `src/device.ts` | No changes needed; it exports `DESCRIPTOR` cleanly |

`packages/axe-fx-iii/src/descriptor.ts` is the **canonical template**:
it demonstrates how to ship community-beta ops with a warning banner,
how to populate `DeviceCapabilities`, how to write a `coerceLocation`
adapter, and how to structure `agent_guidance`.

### Step 2: Register the descriptor

In `packages/server-all/src/server/index.ts`:

1. Import your descriptor:
   ```ts
   import { YOUR_DESCRIPTOR } from '@mcp-midi-control/your-device/device.js';
   ```
2. Call `registerMcpDevice` **before** any device whose `port_match`
   regex would also match your device's port name. Registration order
   decides which descriptor wins on ambiguous port names; more
   specific regex first. See `docs/DECISIONS.md` row 40 for the
   rationale.
   ```ts
   registerMcpDevice(YOUR_DESCRIPTOR);  // add before the catch-all
   ```

### Step 3: Wire the build and typecheck

In the root `package.json`, add your package to:

- `workspaces` array
- `typecheck` script (add `tsc --noEmit -p packages/<your-device>/tsconfig.json`)
- `build:<your-device>` script and wire it into the `build` chain

### Step 4: Add to smoke-server expected-tools list

If your descriptor registers any device-namespaced tools, add them to
the expected list in `scripts/smoke-server.ts`.

### Step 5: Run preflight

```
npm run preflight
```

This confirms the typecheck, all goldens, and the smoke test pass with
your new descriptor registered.

### Registration-order note

The `connection_label` on each descriptor must match the string that
`packages/core/src/server-shared/connections.ts:ensureConnection` uses
to look up the connector factory. If your device's label doesn't
substring-match the OS port name, you'll need a special-case branch in
`ensureConnection` analogous to the `AXEFX2_LABEL` entry. See
`docs/DECISIONS.md` row 41.

## Path 3: Decode a protocol

If you're adding a new MCP wire op (or fixing a misbehaving existing
op), you'll capture USB MIDI traffic and use those bytes to build a
byte-exact golden in `scripts/verify-msg.ts`.

### Before opening a PR

1. Run the full preflight locally:
   ```
   npm run preflight
   ```
   This runs `tsc --noEmit` + the golden verifiers (pack, message,
   transpile, enum-lookup, echo, cache-params) + the MCP smoke test.
2. If your change touches the wire protocol, add or update a
   byte-exact golden in `scripts/verify-msg.ts` against a real
   capture. See the "When adding a new pidHigh" note in
   [`CLAUDE.md`](./CLAUDE.md) for the rationale.
3. If your change adds a new MCP tool, add it to the expected-tools
   list in `scripts/smoke-server.ts`.

### Capturing MIDI traffic

Two approaches, depending on what you need to capture.

**Passive device-side capture** (host can read the device's outbound
SysEx). Use this for everything the device emits: responses to
queries, broadcasts, state announcements. This is the byte-exact wire
format every decoder gets tested against.

```
# List available MIDI input ports:
npm run capture-midi

# Capture device → host SysEx to a `.syx` file:
npm run capture-axefx2 -- samples/captured/my-axefx2-capture.syx
npm run capture-am4    -- samples/captured/my-am4-capture.syx

# Generic; any MIDI device by name substring:
npm run capture-midi -- hydra samples/captured/foo.syx
```

Press Ctrl+C to stop. Bytes are appended to disk as they arrive, so
partial captures survive crashes.

Single-action captures are gold. Start a fresh capture per specific
action (drag one block, turn one knob, switch one preset). Single-
action `.syx` files are far easier to decode than mixed sessions.

**USBPcap + Wireshark for the editor → device direction.** Windows
MIDI output ports are write-only from the OS side, so the passive-
capture script above can't see what an editor app (AxeEdit, AM4-Edit,
Hydrasynth Manager) sends to the device. To capture the
editor-write direction:

1. Install [USBPcap](https://desowin.org/usbpcap/) and Wireshark on
   Windows.
2. Identify the USB device for your MIDI gear (Device Manager → the
   device's "USB Composite Device" parent).
3. Start a USBPcap capture filtered on that USB device.
4. Open the editor app, perform the single action you want to decode.
5. Stop capture, save as `.pcapng`. The MIDI SysEx frames are visible
   in Wireshark's USB packet decode; export the relevant frames to a
   `.syx` file with Wireshark's "Export Packet Bytes" or use
   `scripts/_research/decode-pcapng.ts` for batch extraction.

This is the same method the maintainer uses. The `.pcapng` files
include both directions and a timeline; one capture per action makes
the decode much easier.

### What goes in `samples/`, what goes in `docs/captures/`

`samples/` is gitignored; that's local scratch for analysis. The
project doesn't ship multi-megabyte `.pcapng` files; capture your own
to decode something new. Tiny canonical `.syx` snippets (a few hundred
bytes) that demonstrate a specific wire shape can live under
`docs/captures/` with a companion `.md` decode note. Those are the
ones contributors can read alongside the goldens to understand the
envelope.

### Regenerating committed extractor output

Some committed files are the output of a script: the AM4 factory-data
JSON, the Fractal lineage tables, the Axe-Fx II catalog dumps, and so
on. Their generator scripts live under `scripts/extract-*.ts` and
their outputs are committed alongside the consumers that read them.

If you change an extractor whose output is committed, re-run the
extractor and commit the regenerated output in the same PR. The
`preflight` chain does NOT auto-regen; auto-regen would mask drift
between extractor logic and committed output. Treat regeneration as
an explicit step.

`npm run regen` runs every hardware-free generator in sequence.
Hardware-gated generators (e.g. `npm run extract-factory-data`, which
reads 104 presets from a real AM4) must be run manually with the
relevant device connected and at factory state.

## Questions / security issues

- General questions → open a GitHub issue.
- Security issues → see [`SECURITY.md`](./SECURITY.md).
