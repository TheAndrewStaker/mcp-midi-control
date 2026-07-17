# loopMIDI Editor-Emulation Capture (no hardware)

> Captures the gen-3 editor **write** direction (block insert, grid
> routing, parameter set) by driving FM9-Edit against a loopMIDI virtual
> port, with no Fractal hardware attached. This is how the gen-3
> `grid_set_position` block-insert op was first decoded.

## Why this works (and what it overturns)

The standing finding was that Fractal editors filter class-compliant
virtual MIDI ports out of their picker (see
[`_negative/virtual-midi-bridge-interposition.md`](../research/primitives/_negative/virtual-midi-bridge-interposition.md)).
That holds for AxeEdit II / AM4-Edit, but **FM9-Edit accepts a loopMIDI
port** when the port name carries the `AXE` prefix (e.g. `AXEloopMIDI
Port`). The port appears in Preferences and the editor connects.

The negative finding ruled out *interposition* (a virtual port bridging
the editor to a real device). This is different: full **device
emulation**, the editor connects to a fake with no hardware in the loop.

## Two rigs

### A. Single-port self-loopback + passive read (reliable; capture-only)

Point FM9-Edit's MIDI **In and Out at the same** loopMIDI port. The
editor's queries loop straight back to its own input, which is enough for
its loose `query_sys_info` check to report "Connected" (it even mis-parses
its own echoed query into a bogus firmware string). The grid never renders
real device state, but the editor still emits its write SysEx when you drag
blocks or draw cables, and it does **not** time out, so you can perform
many operations in one session.

Read the editor's outbound writes passively (loopMIDI fans a port out to
all readers):

```
npx tsx scripts/capture-midi-passive.ts "AXEloopMIDI Port" samples/captured/<action>.syx
```

Then drag blocks / draw cables. Each placement is a one-time message
(`fn=0x01 sub=0x30`/`0x32`), trivially separable from the high-frequency
poll loop by global frequency. This rig produced the block-insert decode
([[gen3-fn01-grid-set-position-insert]]).

Limit: with no rendered grid you cannot target a knob or a delete (the
block is invisible), so this rig captures structural inserts and routing,
not edits to existing blocks.

### B. Two-port full mock + codec-backed simulator (`scripts/_research/fractal-editor-emulator.ts`)

Two loopMIDI ports (editor Out -> port A -> us; us -> port B -> editor In),
with the emulator answering the editor's queries. The handshake works (see
spec below). The emulator now drives a **codec-backed device simulator**
(`scripts/_research/sim/SimDevice.ts`) that answers the editor's
`fn=0x01` / `fn=0x1F` reads from a consistent state model so the grid renders.

Naive record-and-replay did NOT work: the capture lumps every device frame
between two editor queries onto the first query, and keying on the full query
hex serves mispaired/position-lumped frames. The simulator fixes this by (a)
keying the verbatim store on the query ADDRESS (bytes 5..11), not the full
hex, and serving exactly the paired frame(s) per query (deterministic
one-query-to-one-frame), and (b) projecting the decoded frames (placed-flag,
stream, bulk-read) and any mutated block from state. The render-gate frames the
codec has not fully decoded (`sub=0x2e` layout map, `sub=0x01` descriptor) are
served verbatim by address (checksum recomputed).

Run it, seeded from a direction-tagged connect+sync capture:

```
npx tsx scripts/_research/fractal-editor-emulator.ts \
  --in "AXEloopMIDI Port" --out "AXEloopMIDI Port 2" \
  --model 12 --seed samples/captured/decoded/fm9-capture3-enum-sweep-2026-06-03.frames.json \
  --log samples/captured/fm9-sim-m1.syx
```

Use `--model 10` for III-Edit, `--model 11` for FM3-Edit (each needs its own
connect+sync capture to seed the verbatim render-gate frames; FM9 is the only
captured corpus so far). The shape builders are golden-tested offline by
`scripts/verify-fractal-gen3-sim.ts` (no editor needed). The primitive entry
[`gen3-editor-sync-read-surface`](../research/primitives/gen3-editor-sync-read-surface.md)
documents the read surface the simulator answers.

## FM3-Edit (Rig A): routing formula decode, 2026-06-05

FM3-Edit Rig A (single-port self-loopback on `AXEloopMIDI Port`) was used
to capture the 4-row routing formula (fn=0x01 sub=0x35). 10 cables collected
via `scripts/_research/probe-fm3-routing.ts`. Key findings:

- The FM3 4-row formula is structurally different from the FM9/III 6-row
  formula: `colTerm = srcCol` (no 3/2 scaling), `destSign = 0` always,
  `b23 = (destRow−1)×32` (linear, no mod-4 wrap).
- Row-1 even-col sources work on FM3 (r1c2→r1c3 confirmed byte-exact).
  The even-col refusal is 6-row-specific.
- `b21` follows `floor(srcGp/2)` with `srcGp = (srcCol−1)×4 + (srcRow−1)`.

Full decode: primitive entry
[`gen3-fn01-grid-routing`](../research/primitives/gen3-fn01-grid-routing.md),
implementation: `packages/fractal-midi/src/gen3/axe-fx-iii/setParam.ts`
(`buildSetGridRouting`, rows=4 branch).

## The gen-3 connect handshake (`query_sys_info`)

The editor's cold-connect sequence and the device replies it requires:

```
device emits (unsolicited, ~100ms before WHO_AM_I):
  F0 00 01 74 12 64 00 00 73 F7                 fn=0x64 announce
editor: F0 00 01 74 7F 00 ...                   fn=0x00 broadcast identify (model 0x7F)
  reply: F0 00 01 74 12 00 <modelByte> <cks> F7 (model carried in the PAYLOAD, not just envelope)
editor: F0 00 01 74 12 08 1F F7                 fn=0x08 WHO_AM_I
  reply: F0 00 01 74 12 08 0b 00 00 01 04 00 00 <ASCII build date> 00... <cks> F7
editor: F0 00 01 74 12 47 50 F7                 fn=0x47 INIT
  reply: F0 00 01 74 12 47 4b 02 00 10 00 08 10 00 11 F7
```

Gotchas that cost iterations:

- The editor parses the **session model byte from the fn=0x00 reply
  payload**, not the envelope. An empty-payload reply is rejected and the
  handshake never settles.
- The fn=0x64 announce is **device-initiated**; the emulator must send it
  proactively, not as a reply.
- No firmware-version gate and no per-session correlation token exist in
  the handshake path, replaying an old firmware's WHO_AM_I verbatim is
  safe.

## loopMIDI settings

- loopMIDI's **Feedback-Detection** (default 5000 commands / 5s) will
  auto-mute a port if the emulator floods it. Keep emulator output under
  ~1000 frames/sec (the emulator self-throttles), or raise/disable the
  detector. A muted port shows red `[muted]`; delete and recreate it to
  clear.
- Keep the `AXE` name prefix on both ports (the prefix is what gets past
  the editor's filter).

## See also

- `scripts/_research/fractal-editor-emulator.ts`, the two-port emulator +
  logger (handshake responders, proactive announce, codec-backed simulator).
- `scripts/capture-midi-passive.ts`, the passive reader used by rig A.
- [`usbpcap-wireshark.md`](usbpcap-wireshark.md), the with-hardware path.
