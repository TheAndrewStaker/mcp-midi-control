# Contributing

Thanks for your interest. There are two kinds of help, and you do not
need to write any code for the first one.

## Help confirm hardware (no code)

You own a supported device, and you confirm the protocol on real
hardware. **This is the most valuable contribution right now**,
especially for Axe-Fx III / FM9 / FM3 owners. Three ways, easiest first:
run a one-command read-only probe, paste back a few chat responses, or
record a short capture. None require a developer setup.

→ Everything you need is in **[`packages/fractal-midi/docs/capture-guides/`](packages/fractal-midi/docs/capture-guides/README.md)**:
per-device pages with the probe, a report-from-a-chat menu, and the exact
captures still needed.

## Contribute code

1. **Add a device.** Write a `DeviceDescriptor` for a new piece of MIDI
   gear. The unified tool surface is device-agnostic; adding a new
   vendor's modeler or synth is a TypeScript object, not new MCP tools.
   See [Adding a new device](#path-2-add-a-device) below.
2. **Decode a protocol.** Capture wire traffic from a device, decode
   the envelope, and add a byte-exact golden. See
   [Capturing MIDI traffic](#capturing-midi-traffic) below.

## Two-repo layout (read this first)

The codec lives in `fractal-midi`, currently a **workspace package** at
`packages/fractal-midi/` inside this monorepo (published independently
to npm). Wire builders / parsers, the param dictionaries, the
amp/drive/cab lineage JSON, block tables, and any other "what the
device speaks" data live there, not in the MCP server packages.

| Repo | What |
|---|---|
| `fractal-midi` (separate repo, published on npm) | Pure-TypeScript codec. Builders, parsers, param dictionaries, block tables, lineage JSON (`amp-lineage.json`, `cab-lineage.json`, etc.). NO MIDI transport, NO MCP server. |
| `mcp-midi-control` (this repo) | MCP server, descriptors, dispatcher, agent guidance, tool registrations. Imports from `fractal-midi/*`. Consumes the codec; does not define it. |

**If your contribution edits ANY of these, you are working in the codec repo, not here:**
- `amp-lineage.json` / `cab-lineage.json` / `drive-lineage.json` / similar
- A `KNOWN_PARAMS` table
- A SysEx builder or parser
- A block-type table

Workflow for a cross-repo change:
1. Switch to the `fractal-midi` repo checkout and edit the source.
2. Run `npm test` in the codec repo.
3. Bump the version in `package.json` per the codec repo's CHANGELOG cadence.
4. `npm pack` produces a `.tgz`.
5. Switch back to this repo and `npm install /path/to/the/.tgz`.
6. Test the integration here, commit both repos, then push.

For drafting (you are iterating quickly), `npm link` between the two
repos avoids the pack-install cycle. Reset to a published version
before opening the PR.

## Common contribution recipes

Pick the row that matches your PR; that names the file to edit. If
your edit lands in the codec repo (`fractal-midi`), see the two-repo
section above for the workflow.

| Goal | File to edit | Repo |
|---|---|---|
| Add an amp model to the AM4 lineage | `src/shared/lineage/amp-lineage.json` | `fractal-midi` |
| Add an amp model to the Axe-Fx II lineage | `src/shared/lineage/axefx2-amp-lineage.json` | `fractal-midi` |
| Add a cab attribution | `src/shared/lineage/cab-lineage.json` | `fractal-midi` |
| Add a drive / wah lineage entry | `src/shared/lineage/{drive,wah}-lineage.json` | `fractal-midi` |
| Add a recipe (tone preset, auto-wah, scene-leveling) | `packages/core/src/protocol-generic/recipes/` | this repo |
| Fix a tool description | `packages/<device>/src/tools/*.ts` | this repo |
| Add a new tool to the unified surface | `packages/core/src/protocol-generic/tools/*.ts` | this repo |
| Add a new param to a device's catalog | `src/<device>/params.ts` in `fractal-midi`, then `npm pack` + reinstall | `fractal-midi` |

## What to run before opening a PR

| Command | When to run | Requires |
|---|---|---|
| `npm run preflight` | Before every PR. Runs typecheck + 12 verifiers + cookbook gate + tool inventory lint. | Nothing. ~1 minute. |
| `npm run build` | If you touched TypeScript under `packages/*/src/`. Pre-installs the dist Claude Desktop spawns. | Nothing. ~30 s. |
| `npm run launch-verify` | If you touched anything wire-protocol related (wire builders, parsers, dispatcher, descriptor reader/writer). Runs the actual server against connected hardware. | A supported device on USB. |
| `npm run live-regression` | Same as launch-verify but covers more scenarios. | A supported device on USB. |
| `npm run agent-sweep` | **DO NOT** run casually. Spawns the `claude` CLI per case and **incurs billed Anthropic API calls**. Only run when changing agent-routing assumptions, and with maintainer permission. | `claude` CLI + API key. |
| `npm run release-gate` | Maintainer-only, pre-announce. Runs preflight + launch-verify + agent-sweep + live-regression in sequence. **Billed.** | Hardware + API key. |

## License and contributor grant

By submitting a contribution (pull request, patch, issue with a code
suggestion, or any other form), you agree to the following:

1. Your contribution is licensed under the project's primary license
   (**Apache License 2.0**) as described in the [`LICENSE`](./LICENSE)
   file. Users of the project receive all the freedoms Apache 2.0
   guarantees.
2. You also grant the project maintainer a perpetual, worldwide,
   non-exclusive, royalty-free, irrevocable license to use, modify,
   sublicense, and **relicense your contribution under any terms the
   maintainer chooses**, in addition to (and without affecting) the
   Apache 2.0 grant above. This keeps the option open for the project
   to ship under a different license alongside Apache 2.0 in the
   future (for example, a commercial license for proprietary
   integrations) without having to coordinate with every prior
   contributor.
3. You certify that you have the right to submit the contribution
   under these terms (e.g. it is your original work, or you have
   permission from the copyright holder).

No separate signature ceremony is required. Opening a pull request
or submitting a patch counts as agreement.

## Path 1: Test and report (no code)

The simplest contribution. You need:

- A supported device on USB.
- The release ZIP installed (5 minutes; see project README).
- Claude Desktop (or another MCP client) connected.

Run any tool call against your device, paste the JSON response into a
GitHub issue, and note whether the device's front panel did what the
response says. That's it.

The Axe-Fx III is a high-value target for this. A 2026-06 owner test
confirmed reads and continuous writes end-to-end, but discrete set-by-name,
`save_preset`, `set_block`, and the live grid read are still community beta
and want a second owner's confirmation. See [`packages/fractal-midi/docs/capture-guides/testing-axe-fx-iii.md`](packages/fractal-midi/docs/capture-guides/testing-axe-fx-iii.md)
for the probe, a report-from-a-chat menu, and the captures still needed.

## Recipes need your ears

Recipes are curated starting points (a warm pad, a screaming lead, an
auto-wah) that a player calls by name. The Hydrasynth library is mostly
auditioned on hardware, but the guitar recipes are early and the
iconic-tone coverage is still thin, so this is one of the most useful
places to help and it needs no protocol knowledge.

- **Tell us what landed.** If you tried a recipe, open an issue with the
  device, the tone you reached for, what sounded right, and what you
  tweaked by hand to fix it. That qualitative feedback is what turns a
  rough recipe into a good one. There is no telemetry and nothing is
  collected automatically; this is just you telling us what you heard.
- **Propose a recipe.** Send a named starting point with the parameter
  moves you make by hand to reach a tone. Recipes live in
  `packages/core/src/protocol-generic/recipes/`; see
  [`docs/RECIPE-AUTHORING-GUIDE.md`](docs/RECIPE-AUTHORING-GUIDE.md). We
  credit recipe authors in the recipe data.

## Path 2: Add a device

The unified tool surface is device-agnostic: adding a new device means
writing a **`DeviceDescriptor`**, a TypeScript object that describes
the device's capabilities, blocks, and wire adapters. No new MCP tools
are needed.

### Step 1: Create a new package (or a config on an existing codec)

A device that shares a wire codec with an existing family does NOT get
its own package: it gets a per-device **config**. The modern Fractal
gen-3 devices (Axe-Fx III / FM3 / FM9 / VP4) all live in
`packages/fractal-gen3/` as configs under `src/configs/`. Each config
binds the shared codec to a model byte, grid/scene shape, and param
catalog by calling `createModernFractalDescriptor()`:

```
packages/fractal-gen3/src/configs/axe-fx-iii.ts   ← the canonical config example
packages/fractal-gen3/src/configs/<your-device>.ts ← copy and adjust
```

A device on a brand-new codec (a different vendor or a fundamentally
different wire shape) gets its own package; copy the structure of an
existing device package and update:

| File | What to change |
|---|---|
| `package.json` | `name`, `description` |
| the descriptor entry point | Block roster, capabilities, `port_match` regex, beta-warning banners for unverified ops |
| the MIDI helper | Port-discovery needles, connection helper |
| the device export | Exposes `DESCRIPTOR` cleanly |

`packages/fractal-gen3/src/configs/axe-fx-iii.ts` is the **canonical
template** for a config-based device: it demonstrates how to ship
community-beta ops with a warning banner, how to populate
`DeviceCapabilities`, how to write a `coerceLocation` adapter, and how to
structure `agent_guidance`. Note there is no longer a single
`src/descriptor.ts` in that package; each device is its own config file.

### Step 2: Register the descriptor

In `packages/server-all/src/server/index.ts`:

1. Import your descriptor:
   ```ts
   import { YOUR_DESCRIPTOR } from '@mcp-midi-control/your-device/device.js';
   ```
2. Call `registerMcpDevice` **before** any device whose `port_match`
   regex would also match your device's port name. Registration order
   decides which descriptor wins on ambiguous port names; more specific
   regex first.
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
`ensureConnection` analogous to the `AXEFX2_LABEL` entry.

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

**USBPcap + Wireshark for the editor to device direction.** Windows
MIDI output ports are write-only from the OS side, so the passive-
capture script above can't see what an editor app (AxeEdit, AM4-Edit,
Hydrasynth Manager) sends to the device. The full step-by-step lives at
[`packages/fractal-midi/docs/capture-guides/usbpcap-wireshark.md`](packages/fractal-midi/docs/capture-guides/usbpcap-wireshark.md):
install pointers, USB device identification, single-action capture
discipline, SysEx extraction, and the citation expectations for any
decode that goes into `docs/SYSEX-MAP*.md`. This is the maintainer's
default workflow for any unknown editor-write op.

### What goes in `samples/`, what gets committed

`samples/` is gitignored; that's local scratch for analysis. The
project doesn't ship multi-megabyte `.pcapng` files; capture your own
to decode something new. What DOES get committed is the distilled
result: a decode written up in the relevant per-device protocol doc
under `packages/fractal-midi/docs/devices/<device>/` (the
`SYSEX-MAP.md` and its companions), with the canonical byte example
quoted inline and a matching golden added to the test suite. Those are
what contributors read alongside the goldens to understand the
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

### Sourcing and legal hygiene (read before contributing a decode)

This project decodes communication protocols for interoperability, which
is well-protected, but only when contributions are sourced cleanly. Two
rules keep the project on solid ground:

1. **Source facts from clean inputs.** Derive every decoded fact from one
   of: (a) a manufacturer's **publicly published** spec (e.g. Fractal's
   "MIDI for Third-Party Devices" doc or the gen-1 SysEx wiki page),
   (b) **wire traffic you captured from hardware you own**, or (c) a
   manufacturer editor binary **only where that editor's license does not
   prohibit reverse engineering**. Prefer (a) and (b); they are the
   lowest-risk sources. If you must inspect an editor binary, you are
   responsible for knowing whether its EULA bars it.

2. **Ship facts, never expression.** Contribute decoded *facts* (parameter
   IDs, byte offsets, value ranges, enum value lists, checksum rules)
   re-expressed in our own schema and our own words. Do **not** paste
   decompiler output, manufacturer source code, verbatim manual or help
   text, tooltip strings, or factory preset content into the repo. Facts
   are free; copied expression is not.

**Cite provenance.** Every decode written into a `SYSEX-MAP.md` or cookbook
entry must say how it was learned (capture file + byte offset, or the
published-spec section). This is both how the next contributor verifies it
and the project's evidence that the work is independent.

The project does not accept contributions derived from circumventing
encryption, code signing, or any access control, or from reverse
engineering an editor in violation of a license the contributor agreed to.
Background and citations: the maintainer keeps a legal-basis writeup
(private for now) summarizing why protocol decoding for interoperability is
protected and where the lines are.

## Questions / security issues

- General questions → open a GitHub issue.
- Security issues → see [`SECURITY.md`](./SECURITY.md).
