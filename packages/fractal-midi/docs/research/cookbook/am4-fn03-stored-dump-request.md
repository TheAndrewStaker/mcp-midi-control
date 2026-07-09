---
name: am4-fn03-stored-dump-request
class: fn-byte-mapping
status: matched-singleton
discovered: 2026-06-10 (live probe settling the H1/H2/H3 hypothesis space from preset-dump-request-research.md)
verified_on:
  - am4
firmware_sensitive: false
golden: scripts/verify-msg.ts (buildRequestStoredPresetDump A01/A02/Z04 byte goldens)
relates_to: [ii-fn03-dump-addressing, am4-fn1f-atomic-read]
consumed_in:
  - fractal-midi/src/am4/setParam.ts
  - fractal-midi/docs/devices/am4/preset-dump-request-research.md
---

# AM4 fn=0x03 stored-location dump request: H1 `[bank, sub, 0x00]`

The AM4's fn=0x03 dump request addresses a STORED location with payload
`[bank, sub, 0x00]`: bank = locationIndex >> 2 (A=0..Z=25), sub =
locationIndex & 3 (display 01..04 → wire 0..3). The active-buffer form
is the `[7F 7F 00]` sentinel (decoded 2026-05-08 from the AM4-Edit
export capture; this entry settles the stored form).

```
F0 00 01 74 15 03 <bank> <sub> 00 <cs> F7
A01 = 00 00 00, A02 = 00 01 00, Z04 = 19 03 00
```

Hardware-confirmed live (no AM4-Edit capture needed): each of A01 /
A02 / Z04 answered with the canonical 6-frame / 12,352-byte
0x77/0x78/0x79 stream whose 0x77 header ECHOES the requested
`[bank, sub]` byte-exactly (unlike the II, whose dump headers carry a
fixed `7F 00` regardless of addressing). A01 and A02 bodies differ
(real per-slot content). Captures:
`samples/captured/hw132/am4-stored-{a01,a02-h1,z04}.syx` in the
consumer repo.

## No working-buffer side effect (opposite of the II)

Active-buffer dumps taken before and after the stored requests differ
ONLY in the dump's volatile bytes: the same offset cluster
(~27-29, 132, 139-157) drifts between two back-to-back active dumps
with nothing in between, and the post-request buffer does not match
the requested slot's content. The stored request is a pure read.
Contrast: the Axe-Fx II's slot-addressed fn 0x03 RELOADS the stored
preset over the working buffer (see [[ii-fn03-dump-addressing]]).

## Volatile-bytes caveat

The AM4 dump stream is NOT byte-stable call-to-call: identical buffer
content produces dumps that drift in the fixed offset cluster above.
Any byte-exact dump comparison must mask those offsets (or compare a
third dump to characterize the drift, as the side-effect probe did).
