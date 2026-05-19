# AM4 vs Axe-Fx II — device-broadcast behavior

**Captured 2026-05-11 via `scripts/capture-midi-passive.ts`.**

The two Fractal devices we've decoded have **different protocol
postures** at the device → host broadcast level. This matters for:

- Contributor capture workflow (BK-048 evidence shape per device)
- Protocol RE methodology — Axe-Fx II reveals state via passive
  capture; AM4 requires active querying to extract state
- Tool design — `axefx2_*` tools can rely on broadcasts for state
  sync; `am4_*` tools must poll

## Axe-Fx II XL+ (Quantum 8.02) — broadcasts continuously

Captured 2026-05-10/11. Passive listening on `AXE-FX II MIDI In`
with no editor connected. Device broadcasts the following without
any host query:

| Function | Count per ~60s capture | Likely role |
|---|---|---|
| `0x10` | ~50 | TEMPO / MIDI clock pulse |
| `0x12` | ~1217 | High-frequency status pulse (PPQN-class) |
| `0x15` | ~768 | Periodic chunked state data (42 bytes each) |
| `0x18` | ~24 | Periodic something |

Plus event broadcasts when the user does something:

| Function | Trigger |
|---|---|
| `0x14` | Preset switch (preset-number announcement) |
| `0x29` | Scene switch |
| `0x74/0x75/0x76` triple | Block / param / grid edits via AxeEdit |

**Implication:** the Axe-Fx II is a "state-streaming" device. We
get continuous broadcasts whether anyone's listening or not. A
passive capture of any user activity reveals the device's current
state for free.

## AM4 (Q1.00) — silent until queried

Captured 2026-05-11. Passive listening on `AM4 MIDI In` with
AM4-Edit closed, founder changing presets via the front panel
knob. **Zero messages received.** Confirmed with two captures:

- `session-59-am4-idle.syx` — 66.7s of pure idle, **0 messages**
- `session-59-am4-preset-switch.syx` — front-panel preset
  switches over 16.6s, **0 messages**

**Implication:** AM4 has no equivalent of the Axe-Fx II's broadcast
firehose. It only emits MIDI in direct response to host queries.
This is consistent with the session-04 AM4 capture showing
AM4-Edit polling the device ~3,499 times per single-value session
— AM4-Edit polls aggressively *because* the device doesn't
volunteer state.

## Consequences for the project

### Passive-capture script utility (per device)

`scripts/capture-midi-passive.ts` is highly useful for Axe-Fx II
(captures state changes for free, no editor needed). It is **not
useful for AM4 in isolation** — you'd capture zero bytes unless an
editor or host tool is actively querying the device.

For AM4 captures contributors want to use this script, they must
ALSO have AM4-Edit (or our MCP server) running and triggering
queries. The shared-port-read approach works for both Axe-Fx II
and AM4, but on AM4 the "shared" party providing query traffic
must exist.

### BK-048 contribution evidence per device

- **Axe-Fx II PRs**: capture is straightforward — passive capture
  alone produces usable evidence files.
- **AM4 PRs**: capture must include the query-issuing party.
  Either:
  - (a) AM4-Edit captures the query+response pair (shared-port-read
    captures the response half).
  - (b) Our MCP server captures both sides (we send the query, we
    log our own outbound + the device's inbound).

Option (b) is the cleanest for BK-048 — our own goldens hold the
outbound bytes; the response capture provides the third-party-
verifiable inbound bytes. This means **AM4 contributor evidence is
naturally cleaner than Axe-Fx II evidence**: our own encoder
produces the request, the device's response is captured passively,
the goldens verify both halves.

### Tool-design implications

- **Axe-Fx II**: an `axefx2_subscribe_to_state` tool could be
  valuable — open the input port, listen for the device's
  continuous broadcasts, surface state changes to the agent without
  the agent having to poll. Future BK item worth considering.
- **AM4**: same tool would be useless — nothing to subscribe to.
  Polling remains the only way to detect AM4 state changes (e.g.
  the user changed a preset on the device front panel — AM4 won't
  tell us; we have to ask).

### Architectural reflection

This difference probably reflects the products' market positions:

- **Axe-Fx II**: high-end studio/touring unit. State-sync with
  controllers (foot controllers, MFC-101) + editors is critical.
  Continuous broadcasts enable lock-step state.
- **AM4**: compact home/practice unit. MIDI is more of a "configure
  via editor" use case than a "live state sync" use case. The
  protocol cost of broadcasts isn't justified by the market need.

Worth keeping in mind when speculating about what Axe-Fx III /
FM3 / FM9 might do — those are higher-end again than the II, so
likely have at least as much broadcast as the II, possibly more.

## Cross-reference

- `docs/_private/AXEFX2-DECODE-0x74-0x75-0x76.md` — first decode of
  the Axe-Fx II broadcast envelope.
- `docs/_private/SESSIONS.md` Session 04 — original AM4 capture
  showing the polling pattern.
- `scripts/capture-midi-passive.ts` — the script used to surface
  this difference.
- `docs/devices/axe-fx-ii/community-re-methodology.md` — public-facing
  community-RE survey; should note this behavioural difference if
  any contributor doc updates land.
