# Axe-Fx III preset-file format — research log

**Source of truth for this doc:** Fractal Forum thread "Axe-Fx III and
deconstructing / parsing a .syx / sysex preset file"
([#159885](https://forum.fractalaudio.com/threads/axe-fx-iii-and-deconstructing-parsing-a-syx-sysex-preset-file.159885/)),
4 pages, March 2020 – July 2025. Local archive:
`docs/_private/fractal-forum-text.txt` (1304 lines).

The Axe-Fx III's preset save format is **not in the v1.4 PDF**. This
file captures what's been community-reverse-engineered, with citations
to forum posts so the chain of evidence is auditable.

---

## Top-line findings

1. **The preset .syx file is a multi-frame envelope.** Not a single
   STORE_PRESET function byte. III presets are 18 SysEx messages:
   - 1× `0x77` header (13 bytes)
   - 16× `0x78` body chunks (3082 bytes each)
   - 1× `0x79` footer (11 bytes)
   - FM3 / FM9 presets are 10 messages (8× 0x78 body chunks) — same
     header / footer.
   Source: community RE in Fractal Forum thread #159885 (May 2025
   posts), confirmed across 3 FX3 presets from different firmwares
   **and our own walk of the v28.06 factory ALL-BANKS file (384
   presets, 100% match)**.
   See `scripts/_research/analyze-factory-bank.ts`.

   **Header (0x77) carries destination location:**
   - Factory presets: `[0x00, slot_lo, 0x00, 0x00, 0x01]` — byte 1 is
     the preset slot index (verified across 384 factory presets,
     monotonically incrementing 0..383).
   - User-edit-buffer dumps: `[0x7F, 0x00, 0x00, 0x00, 0x01]` — byte 0
     `0x7F` = edit-buffer / "no fixed destination" marker.

   **Footer (0x79) carries a 3-byte checksum** that's unique per
   preset (384 distinct values across the factory bank).

   **Body[0] starts with constant magic** `00 08 3F 02 00 55 54 02`
   (offsets 0-7 of body payload). Then variable bytes including the
   preset-name region around offsets 14-47 with `0x01` interleavers
   that look like high-bit overflow markers.

2. **System-bank SysEx uses analogous envelope at 0x51/0x52/0x53.**
   The "settings backup" produced by Fractal-Bot has the same shape
   as a preset, but in a different function-byte range:
   - 1× `0x51` header
   - 64× `0x52` body chunks
   - 1× `0x53` footer
   Source: Fractal Forum thread #201663 ("Reverse engineer undocumented
   sysex?", 2024-02) — original-poster's analysis of a Fractal-Bot
   system-bank backup, with the structure tacitly confirmed in the
   same thread by an experienced third-party RE participant.

   Implication: Fractal's wire architecture uses paired
   header/body/footer function-byte triples in different ranges for
   different blob types. The pattern is reusable for IR uploads, cab
   uploads, etc. — function bytes probably 0x4N / 0x5N / 0x6N / 0x7N
   in a structured way.

2. **Preset content is Huffman-compressed.** The data inside the
   `0x78` frames is NOT a flat parameter table — community RE in
   thread #159885 (Jul 2025) indicates the body is Huffman-packed.
   This explains why a preset with a 120-parameter AMP block doesn't
   take 120 × 4-channel × 4-byte = ~2KB just for the amp — the unused
   defaults aren't stored at all, and what IS stored is compressed.

3. **The preset SysEx format is separate from the realtime SysEx.**
   Forum thread #159885 (Jul 2025) explicitly:
   > "Understanding the preset sysex won't help you to control any
   > parameter in real-time. You have to sniff AxeEdit for this"

   So even a complete decode of the .syx format would NOT give us
   the per-parameter SET_PARAMETER_VALUE sysex needed for tools like
   `set_param`. Those are different problems.

   **Cross-confirmed in thread #201663** (Reverse engineer undocumented
   sysex?, 2024-02), in a discussion about partial system-bank
   uploads — *"Yes, you have to sniff what Axe3Edit does when
   modifying a parameter (a setup parameter in your case)... Sending
   'a part of' a bank/preset/ir/anything doesn't exist"*.

   The constraint is absolute: either send the WHOLE blob (preset,
   system bank, IR), or use the realtime parameter-write SysEx — no
   middle ground. There is no "send these 3 bytes of preset N's amp
   gain" operation.

4. **There IS a SysEx for querying block parameter info**, but it's
   not publicly documented. Community RE in thread #159885 (post #57)
   notes:
   > "There's a sysex dedicated to this, which asks for a block each
   > parameters informations etc"

   This is the III's analog of Axe-Fx II's `0x01 GET_BLOCK_PARAMETERS_LIST`.
   Decoding it would unlock the param-ID space — but the community
   contributor with the working decode keeps it as a commercial moat,
   so we have to derive it independently via USB capture against
   AxeEdit III.

5. **Firmware updates don't change the protocol.** Per community RE
   in thread #159885:
   > "Firmwares don't change protocole, just known parameters and
   > sometimes parameters strings"

   So a one-time decode is stable; we don't need to re-decode for
   each firmware revision.

---

## Header frame (function 0x77)

Confirmed structure (13 bytes, established from community RE in
thread #159885 across 3 FX3 presets from different firmwares — header
was identical):

```
Offset  Hex   Notes
  0     F0    SysEx start
  1-3   00 01 74  Fractal manufacturer prefix
  4     10    Model byte (0x10 = III; 0x11 = FM3; 0x12 = FM9)
  5     77    Function byte — preset-header marker
  6-10  ??    Destination + revision payload (5 bytes; see below)
  11    XX    XOR checksum (per Fractal family convention)
  12    F7    SysEx end
```

**Payload (bytes 6-10) decoded from our own factory-bank analysis
(scripts/_research/analyze-factory-bank.ts, walking 384 presets):**

- **Factory presets:** `[0x00, slot_lo, 0x00, 0x00, 0x01]` — byte 7
  (offset 1 of payload) is the destination preset slot index.
  Confirmed by monotonically incrementing 0..383 across the v28.06
  ALL-BANKS file.
- **User-edit-buffer dumps:** `[0x7F, 0x00, 0x00, 0x00, 0x01]` —
  byte 6 (offset 0) `0x7F` is the "no fixed destination" / edit-
  buffer marker. (Earlier community RE characterized the full 5-byte
  payload as a "preset revision number" — the factory-bank analysis
  refines that: byte 6 is a flag, bytes 7-8 are the slot, bytes 9-10
  are a small constant.)

Example FX3 user-export header:
```
F0 00 01 74 10 77 7F 00 00 00 01 1C F7
```

This is the key write-side decode for `save_preset` on the III: if
you want to write a preset to slot N, byte 7 of the 0x77 header is
N (LSB; the destination encoding for slots ≥ 128 is TBD, but factory
slot indices fit in one byte so the pattern looks like LSB/MSB septet
encoding — same as elsewhere in the family).

---

## Body frames (function 0x78)

Per community RE in thread #159885 (cross-confirmed by our own
factory-bank walk):

- Each body frame is **3082 bytes** total
- Standard 5-byte SysEx prefix (`F0 00 01 74 10`) + `0x78` function
  byte + payload + checksum + `F7`
- 10 bytes of overhead per frame → **3072 data bytes per frame**
- The 3072-byte payload is split into 24× 128-byte chunks
- The first 128-byte chunk of body frame 0 contains "global preset
  info" — preset name, presumably tempo, etc.
- Subsequent chunks contain block data
- **Content is Huffman-compressed**

Body frame 0 starts with the preset name field at offset 9 of payload
(`0x78 00 08` header + name + zeros). The 32-char preset name is
encoded with **MIDI 7-bit packing** — each character can split across
2 bytes because MIDI strips the high bit of every byte to keep the
"control byte" reserved for `F0`/`F7`.

A "Spy Guitar" worked example surfaced in community RE, showing the
encoding pattern:
```
S = 0x53                  (53)
p = 0x70 ← bytes 60 01    (shift-assemble: 0x60 | (0x01<<7) = 0xE0 wrong)
y = 0x79                  (79)
```

The encoding wasn't fully cracked in the thread; further decoding is
ours to do, paired against the factory-bank ground truth.

---

## Footer frame (function 0x79)

Confirmed 11 bytes total via the same community RE that established
the header + body sizes. Our factory-bank analysis found the 3-byte
footer payload is unique per preset (384 distinct values across 384
factory presets), so it's almost certainly a checksum / size /
content-hash field.

---

## Other useful intel from community RE

- A third-party open-source RE project (LLM-assisted analysis,
  referenced from forum thread #159885 post #40, Jul 2025) ships a
  known-input/known-output paired data sample:
  - A real Splawn-amp preset binary (49,336 bytes)
  - A paired CSV with parameter ground truth
  - The same data in XML form

  Local archive: `docs/_private/axefx3-community-decode-sample/`.

  ### Assessment

  The project's prose analysis is **internally inconsistent** (its
  primary writeup describes two incompatible block-structure models
  in the same file, without reconciling them) and its **decode
  success rate against the paired CSV is low** (1 of 7 byte-pairs
  matched for the Input 1 block; 2 of 6 for a multi-band-compressor
  candidate). Treat the prose as hypothesis.

  **What we can use from the project:**
  1. **14-bit septet-pair encoding for parameter values** — also
     independently confirmed by Fractal v1.4 PDF for other functions.
  2. **One time-parameter decode**: Release = sysex_value / 50.0 (ms).
     Single data point but plausible given Fractal family conventions.
  3. **The paired data** is real ground truth we can analyze ourselves
     with much higher rigor.

  **What we don't use:**
  - Specific effect IDs claimed in the project's prose (multiple
    competing values in the same writeup; doesn't match the v1.4 PDF).
  - "Sparse storage" / "all-channels-or-none" as *confirmed* — the
    project claims these but the underlying decode table is mostly
    unmatched. Treat as hypothesis pending our own verification.
  - Specific byte offsets within blocks.

  ### Recommended use

  Treat the paired data triple as a data dump for our own analysis
  (`scripts/_research/analyze-splawnlane.ts` walks it programmatically),
  not as an authoritative source. The factory bank analysis on real
  v28.06 data is higher signal.

- **A closed-source community editor** for the Fractal product family
  has both a sniffer and a CSV/XML export of preset content. The
  developer keeps the protocol decode private as a commercial moat.
  We derive independently.

---

## Implications for this project

1. **`save_preset` for III is NOT a single-function envelope.** Any
   "ship STORE_PRESET" path requires:
   - Decoding the Huffman packing inside the `0x78` frames (HARD)
   - Or building a "write the entire .syx as the user provides it"
     tool (passthrough); user-friendliness suffers
   - Or sniffing AxeEdit III's save sequence and replicating it
2. **`set_param` for III still needs capture work.** Community RE
   consensus is that preset-file decode does NOT help with realtime
   param control — those are separate wire paths. **The III's
   per-block param-write opcode was decoded Session 97** to `fn=0x01`
   + sub-action `09 00` (typed-input), byte-verified against 10
   public captures. See [`SYSEX-MAP.md`](SYSEX-MAP.md) §0x01
   PARAMETER_SETGET and [`set-parameter-captures.md`](set-parameter-captures.md).
   The hypothesis-probe script (`scripts/_research/probe-axefx3-
   setparam-hypothesis.ts`) was retired in the same session since
   the captures resolved the H1..H5 tree without needing the live
   probe.
3. **Block-level operations (bypass / channel / scene) are unaffected**
   — those use the documented v1.4 spec functions 0x0A / 0x0B / 0x0C
   with Appendix 1 effect IDs, which work TODAY.
4. **The forum's reverse-engineering effort is ACTIVE** (most recent
   substantive posts mid-2025). Worth periodic check-in.

## Action items (research, not blocking shipping)

- [ ] If founder gets hardware access on an Axe-Fx III: capture an
  AxeEdit III parameter-edit USBPcap session. One 30-second capture
  of "knob turn" would unblock `set_param`.
- [ ] Decide whether `save_preset` for III is worth pursuing given
  the Huffman + multi-frame complexity. Probably no — recommend
  users save on the device's front panel until we have a capture.
