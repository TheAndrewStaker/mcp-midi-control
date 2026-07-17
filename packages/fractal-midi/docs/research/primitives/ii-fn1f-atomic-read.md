---
name: ii-fn1f-atomic-read
class: fn-byte-mapping
status: matched-singleton
discovered:  (2026-05-20;  hardware-verified)
verified_on:
  - axe-fx-ii-q8.02
firmware_sensitive: false
golden: scripts/verify-axe-fx-ii-getpreset-channel-walk.ts (offline fn=0x1F channel-blocked dump decode)
relates_to: [ii-axeedit-opcode-table, septet-14bit, ii-state-broadcast-triple-write, am4-fn1f-atomic-read, ii-fn0e-query-states]
consumed_in:
  - fractal-midi/docs/devices/axe-fx-ii/SYSEX-MAP.md
---

# Axe-Fx II fn=0x1F SYSEX_GET_ALL_PARAMS (atomic read)

Axe-Fx II exposes a single-frame atomic-read primitive at fn=0x1F:
one request from the host triggers the device to emit the full
per-block parameter set for the active preset's working buffer. This
is OUR `getPreset` / bulk per-block read primitive (hardware-verified,
matched-singleton).

Note: fn=0x1F is NOT what AxeEdit uses for its own "Read from Axe-Fx"
sync. The session-58 captures contain zero fn 0x1F frames; AxeEdit's
sync uses fn 0x0E QUERY_STATES (whole-preset block state) + fn 0x20
GET_GRID (grid layout). See [[ii-fn0e-query-states]]. fn=0x1F is the
read primitive we chose for `getPreset` because it returns the full
per-block parameter set in one round-trip.

Earlier the project's `get_preset` path issued a scene-walk
(8 round-trips, ~8 seconds total) to reconstruct per-scene state.
Mining the AxeEdit binary's opcode table surfaced fn=0x1F
SYSEX_GET_ALL_PARAMS as a one-request, one-reply full-state read:
~1-2 seconds total. (fn=0x1F is the read primitive we adopted; it is
not the opcode AxeEdit itself issues during sync, which is fn 0x0E +
fn 0x20.)

This entry is high-value because the CLAUDE.md prose explicitly warns
against re-attempting flat-byte-offset diffs of the 0x77/0x78/0x79
preset binary as a workaround for the atomic-read gap. fn=0x1F closes
the gap at the protocol level: the device already exposes the
primitive.

## Formal definition

Request envelope (12 bytes):

```
F0 00 01 74 07 1F 00 00 00 00 <cksum> F7
```

Where:

- `00 01 74` is the Fractal manufacturer ID.
- `07` is the Axe-Fx II XL+ model byte (per [[xor-7f-envelope-checksum]]).
- `1F` is the fn byte (SYSEX_GET_ALL_PARAMS per
  [[ii-axeedit-opcode-table]]; NOT QUERY_STATES, which is fn 0x0E).
- The 4 zero bytes are reserved (the request carries no payload; the
  zeros are a workflow envelope filler).
- `cksum` is the standard XOR-7F envelope checksum.

Reply envelope (one or more SysEx frames):

The device emits the reply as a 0x74/0x75/0x76 state-broadcast triple
(the same envelope the device emits as an unsolicited broadcast on a
front-panel edit, and that the host can send back as a write). Each
value in the 0x75 chunk is a 16-bit native value packed via
`packValue16`: `byte0 = v & 0x7F`, `byte1 = (v >> 7) & 0x7F`,
`byte2 = (v >> 14) & 0x03`. This is NOT the preset-binary 21-bit
packing: byte2 carries only the top 2 value bits and has no reserved
high bits (`0x7c`) to preserve. See [[ii-state-broadcast-triple-write]].

## Where it's used

The reply decodes as a positional ushort array (chunk position equals
param position), the same shape the state-broadcast decoder handles
([[ii-state-broadcast-triple-write]]). For channel-bearing blocks the
body is CHANNEL-BLOCKED x2: quarter 0 = X, quarter 1 = Y, at
`channel * stride + paramId` with `stride = itemCount / 2` (e.g. block
0x6a itemCount 236 = 118 params x 2). This is the same channel-blocked
shape as the AM4 (x4 A-D, [[am4-fn1f-atomic-read]]) and gen-3 read; II
differs only in channel count (x2 X/Y). The reply length varies with the
preset's block composition; representative captures are 2-4 KB.

The atomic-read should be the foundation of any future `get_preset`
rewrite that needs per-scene state. The current scene-walk implementation
is the legacy path; fn=0x1F is the structural improvement.

## Misapplication failure modes

- **DO NOT** attempt to read stored-preset state via fn=0x1F. The
  device responds with working-buffer state only; the working buffer
  reflects what the device is currently playing. To read a stored
  preset, switch to it first (which loads its bytes into the working
  buffer), then issue fn=0x1F.
- **DO NOT** confuse the fn=0x1F triple reply with the preset-binary
  (0x77/0x78/0x79) layout. The fn=0x1F reply is the block's monolithic
  positional ushort array (chunk position equals param position, packed
  via `packValue16`); it is NOT block-record-keyed and NOT
  byte2-mask-preserving. The `block-record-stride-8` and
  `parambase-plus-paramid` primitives apply to the preset binary, not to
  this reply.
- **DO NOT** route this through the scene-walk legacy path. The
  scene-walk is 4-8x slower and produces the same data; it exists only
  because fn=0x1F was undocumented when the original path was written.

## Where it does NOT apply

- AM4 has its own fn=0x1F atomic-read at [[am4-fn1f-atomic-read]] but
  the contract differs: AM4 requires a 2-byte effectId payload and
  returns one block per request, whereas II's request omits the
  effectId and returns the whole preset in one frame. Treat them as
  related-but-distinct sibling opcodes that share a fn byte.
- Axe-Fx III has its own atomic-read family (fn 0x19 "File Snapshot /
  Get Preset Data" + fn 0x14 GET_PRESET_NUMBER reply); these are
  not byte-compatible with fn=0x1F.
- Hydrasynth uses dump-by-NRPN-range, not a single atomic-read opcode.

## Verification path

`scripts/verify-axe-fx-ii-getpreset-channel-walk.ts` exercises the
fn=0x1F read path fully offline (channel-blocked dump decode against a
purpose-built fake connection). The fn byte constant
`FN_GET_ALL_PARAMS = 0x1F` ships in
`fractal-midi/src/gen2/axe-fx-ii/setParam.ts`.

Live wire verification ships in the project via the  workstream's
research scripts ( era); see the
`founder-private notes` references for the per-block
reply layout decode.

## Refinement history

- 2026-05-20: fn=0x1F SYSEX_GET_ALL_PARAMS mined from the AxeEdit
  opcode table via [[ii-axeedit-opcode-table]]; adopted as OUR
  `getPreset` read primitive. Closes the false dichotomy
  that "atomic apply_preset requires flat-byte-offset diff of
  0x77/0x78/0x79 preset binary"; the protocol already exposes a clean
  read primitive.
- 2026-05-28: corrected the "this is what AxeEdit uses for its sync"
  claim. The session-58 captures contain zero fn 0x1F frames; AxeEdit's
  own sync is fn 0x0E QUERY_STATES + fn 0x20 GET_GRID
  ([[ii-fn0e-query-states]]). fn=0x1F remains real and hardware-verified
  as OUR chosen read primitive; the opcode-name line was also corrected
  (1F = SYSEX_GET_ALL_PARAMS, not QUERY_STATES).
- 2026-05-28: corrected the reply-encoding cross-reference. The reply is
  the 0x74/0x75/0x76 state-broadcast triple decoded via `packValue16`
  (byte2 carries only the top 2 value bits), NOT the preset-binary
  21-bit byte2-mask-preservation scheme and NOT block-record-keyed. The
  stale links to `septet-21bit-byte2-mask-preservation`,
  `block-record-stride-8`, and `parambase-plus-paramid` were preset-binary
  primitives misattributed to this live read path; see
  [[ii-state-broadcast-triple-write]].
- 2026-05-22 (Rosetta-stone primitives audit): promoted to
  primitive. The CLAUDE.md anti-pattern warning ("flat-byte-offset
  diff of II preset binary") becomes mechanically backed by this
  entry's existence: the alternative is named and documented.
- 2026-05-22 (HW-AM4-FN1F probe): the "Where it does NOT apply" line
  claiming AM4 has no fn=0x1F equivalent was falsified by a 7-shape
  AM4 probe. AM4 ships a sibling primitive with a different request
  contract (effectId payload, per-block granularity); see
  [[am4-fn1f-atomic-read]] for the AM4-specific shape.
- 2026-06-04 (channel-blocked x2): the per-block reply body is
  channel-blocked, not a single-channel array: quarter 0 = X, quarter 1
  = Y, `stride = itemCount / 2` (block 0x6a 236 = 118 x 2). `getPreset`
  now decodes BOTH channels from the one dump; the earlier per-param
  fn 0x02 Y-walk (and its set-Y / restore-X channel mutation) is removed.
  The earlier "monolithic / always-X" reading was the quarter-0 symptom
  of a channel-blocked body indexed by paramId. (Arithmetic-confirmed
  236 = 118 x 2 + structural transfer from the AM4 live x4 read; a paired
  II X != Y hardware confirmation is still pending.)
