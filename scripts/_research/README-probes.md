# Axe-Fx II probe suite

Three probes, each ~10-60s of hardware time. Read-only: no state
mutation, no writes. Run with the device powered on and connected via
USB; close AxeEdit first so it doesn't fight for the MIDI port.

## Recommended order

### 1. `probe-axefx2-bulk-read.ts`: envelope test (~30s)

```
npx tsx scripts/_research/probe-axefx2-bulk-read.ts
```

Fires 7 envelopes in sequence:

- `fn 0x21 SYSEX_RESYNC` (5s listen, slowest response)
- `fn 0x1F SYSEX_GET_ALL_PARAMS` × 3 shapes (empty / [AMP 1] / [AMP 1 + padding])
- `fn 0x0E SYSEX_QUERY_STATES` (empty)
- `fn 0x18 SYSEX_GET_MODIFIER_INFO` (AMP 1 with 8-byte payload)
- `fn 0x47 SYSEX_GET_SYSINFO` (empty and AxeEdit-captured payloads)

Prints what each one received. Saves raw bytes to
`samples/captured/probe-axefx2-bulk-read.syx`.

**What it answers:** which envelopes return data, and what envelope
the response uses (state-broadcast triples vs structured response).

### 2. `probe-axefx2-fn1f-sweep.ts`: bulk-read per placed block (~20s)

```
npx tsx scripts/_research/probe-axefx2-fn1f-sweep.ts
```

Reads the grid via fn 0x20, then sends `fn 0x1F` for every placed
block. Saves per-block raw bytes to
`samples/captured/fn1f-sweep/block-XX.syx`.

**What it answers:** if fn 0x1F is the bulk-per-block primitive,
this sweep returns enough data to decode the response layout.

### 3. `probe-axefx2-passive-listen.ts`: capture front-panel activity (configurable)

```
# Default 30 seconds
npx tsx scripts/_research/probe-axefx2-passive-listen.ts

# Custom duration (e.g. 60 seconds)
npx tsx scripts/_research/probe-axefx2-passive-listen.ts 60
```

Opens the device input port, captures every inbound Fractal SysEx
frame, prints per-fn-byte histogram + the first 30 non-tempo frames
with timestamps.

**What it answers:** what the device emits on its own. Interact with
the front panel (turn knobs, switch scenes, toggle bypass, change
presets) during the capture window. State-broadcast triples
(`0x74/0x75/0x76`) should fire on every edit.

**Note:** AxeEdit filters out virtual MIDI ports, so we can't snoop
AxeEdit's traffic from this script. Use USBPcap + Wireshark for that
(see `fractal-midi/docs/capture-guides/usbpcap-wireshark.md`).

## Quick-result triage

After running all three, the atomic-read primitive resolves to one
of:

| Outcome | What it means | Next step |
|---|---|---|
| fn 0x21 RESYNC returns 0x74/0x75/0x76 triples per placed block | Done: use existing decoder | Wire `getWorkingBufferState()` into the II reader using the existing state-broadcast decoder. |
| fn 0x1F returns structured per-block response (e.g. 0x74 triples or a new envelope) | Done with one decode hop | Decode the response envelope, wire per-block bulk reads. |
| fn 0x0E returns a richer payload with an empty query | Re-decode it (an earlier capture had a 54-byte response that may be block inventory + state combined) | Look at the new bytes; might supersede fn 0x1F. |
| None of the above respond | Each is fire-and-forget; the device doesn't expose a bulk-read primitive in any of these envelopes | Atomic-read path is back to scene-walk OR preset-binary decode (the harder option). |

## After running

Drop the file paths of the saved `.syx` files in chat. I'll decode
the response shapes offline and build the codec + dispatcher wiring
in `fractal-midi` + this repo.
