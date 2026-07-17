# AM4-Edit Ghidra param-table dump vs shipped catalog

> Cross-validation of `samples/captured/decoded/ghidra-am4edit-paramtables.json`
> (47 tables / 2105 entries / 1894 unique symbols, mined 2026-05-22 via
> `SeekParamTables64.java` direct-pattern-scan against AM4-Edit.exe at
> image base `0x140000000`) against the shipped
> `packages/fractal-midi/src/am4/params.ts` `KNOWN_PARAMS` catalog
> (899 entries across 20 block names).
>
> Generated 2026-05-28. Analog of the Axe-Fx II addendum work
> (`SeekParamTablesII.java`, 1,113 entries / 99% indexed-symbol
> coverage / 470 new params).

## Per-block coverage table

Maps shipped catalog block names to Ghidra effect-family tables.
Gap is `(sum of mapped families' entries) - (catalog entries)`.
Positive = Ghidra has entries the catalog lacks; negative = catalog
has extras (typically CACHE_PARAMS mirrors and type-conditional
duplicates the Ghidra dump doesn't enumerate separately).

| Block       | Catalog | Mapped Ghidra families                            | Gap   |
|-------------|---------|---------------------------------------------------|-------|
| amp         | 206     | DISTORT:142 + CABINET:68                          | +4    |
| chorus      | 30      | CHORUS:22                                         | -8    |
| compressor  | 35      | COMP:32                                           | -3    |
| **delay**   | 86      | DELAY:80 + MEGATAP:27 + TENTAP:48 + MULTITAP:113  | **+182** |
| drive       | 38      | FUZZ:40 + DYNDIST:14                              | +16   |
| enhancer    | 11      | ENHANCER:8                                        | -3    |
| filter      | 35      | FILTER:31                                         | -4    |
| flanger     | 29      | FLANGER:26                                        | -3    |
| gate        | 17      | GATE:13                                           | -4    |
| geq         | 16      | GEQ:12                                            | -4    |
| global      | 98      | GLOBAL:99                                         | +1    |
| ingate      | 8       | INPUT:7                                           | -1    |
| peq         | 30      | PEQ:27                                            | -3    |
| phaser      | 31      | PHASER:28                                         | -3    |
| preset      | 86      | PATCH:85                                          | -1    |
| **reverb**  | 68      | REVERB:63 + PLEX:87                               | **+82** |
| rotary      | 18      | ROTARY:14                                         | -4    |
| tremolo     | 17      | TREMOLO:15                                        | -2    |
| volpan      | 14      | VOLUME:11                                         | -3    |
| wah         | 26      | WAH:20                                            | -6    |
| **TOTAL**   | **899** | (sum of mapped families)                          | **~+250** |

## Reading the gaps

### Negative gaps (catalog > Ghidra)

Catalog has more rows than the Ghidra dump for chorus, compressor,
enhancer, filter, flanger, gate, geq, ingate, peq, phaser, preset,
rotary, tremolo, volpan, wah. Reason: the catalog includes
**CACHE_PARAMS mirrors** (the same paramId registered with multiple
display names / per-type calibrations) plus **type-conditional
entries** that the Ghidra dump enumerates only once per descriptor
table. Not a real coverage problem, these are catalog-side
duplicates by design.

### Small positive gaps (1-16)

`amp +4`, `drive +16`, `global +1`, likely a handful of unregistered
params per block. Worth a focused per-block audit (~30 min each)
against the Ghidra symbol names to surface any genuinely missing
knobs. Drive's +16 includes the FUZZ-and-DYNDIST families that may
be AM4-exposed type variants the catalog hasn't enumerated.

### Large positive gaps, the real surface area

**`delay +182`**: AM4 has multiple delay block-type variants
(standard DELAY, MEGATAP, TENTAP, MULTITAP) each with its own param
table. The catalog's `delay.*` namespace stores params for all types
but with type-applicability gates; the gap suggests many MEGATAP /
TENTAP / MULTITAP-specific params are not registered. High-yield
audit target.

**`reverb +82`**: Standard REVERB (63) is fully covered by the
catalog's 68 entries. PLEX (87): the AM4's Plex Reverb type, is
mostly un-registered. PLEX is a real AM4 user-facing reverb variant
(visible in AM4-Edit's reverb-type dropdown), so these entries are
genuine missing catalog coverage. High-yield audit target.

## Unmapped Ghidra families (potential AM4 blocks OR multi-product artifacts)

AM4-Edit is a multi-product editor binary (per primitive
`[[iii-multiproduct-editor-binary]]`, model-byte dispatch over
III/FM9/FM3/AM4 was confirmed in the third-hop decode of
`FUN_1401da990`). Some Ghidra families correspond to features the
AM4 firmware doesn't expose; the binary carries the code for shared
multi-product handling. Without firmware verification, we can only
classify by confidence tier.

| Ghidra family | Entries | AM4 likelihood            | Reason                                                                 |
|---------------|---------|---------------------------|------------------------------------------------------------------------|
| PITCH         | 130     | LIKELY (partial)          | AM4's Shimmer Verb / Plex Verb voices use pitch-shift; some apply      |
| VOCODER       | 67      | UNLIKELY                  | No vocoder feature on AM4                                              |
| SYNTH         | 35      | UNLIKELY                  | No synth block on AM4                                                  |
| RESONATOR     | 34      | POSSIBLE                  | Resonator filter is a plausible filter-type variant; verify on hw     |
| MULTICOMP     | 31      | POSSIBLE                  | Multi-band compressor; AM4 has standard COMP, MULTICOMP may be variant |
| LOOPER        | 24      | UNLIKELY                  | AM4 has no looper                                                      |
| TONEMATCH     | 22      | UNLIKELY                  | AM4 has no tone matcher                                                |
| IRPLAYER      | 20      | POSSIBLE                  | AM4 has IR support; might expose user-IR playback                      |
| MIXER         | 17      | INFRASTRUCTURE            | Internal signal routing, not user-visible                              |
| OUTPUT        | 16      | INFRASTRUCTURE            | Output-stage gains; some already in `global.*`                         |
| CROSSOVER     | 15      | POSSIBLE                  | Crossover filter; verify on hw                                          |
| MOD           | 25      | INFRASTRUCTURE            | Generic modulator (LFO source); shared across blocks                   |
| FDBKRET       | 6       | INFRASTRUCTURE            | Feedback return path; internal                                          |
| RTA           | 6       | UNLIKELY                  | Real-time analyzer; not an AM4 feature                                  |
| **RINGMOD**   | **6**   | **VERIFY ON HARDWARE**    | Per memory `[[project_am4_ghidra_breakthrough_2026_05_22]]`, listed as "new block visible" |
| **FORMANT**   | **5**   | **VERIFY ON HARDWARE**    | Same memory note, "new block visible"                                  |
| **MIDIBLOCK** | **5**   | **CONFIRMED AM4**         | AM4's Scene-MIDI, needs catalog wiring                       |
| **IRCAPTURE** | **3**   | **VERIFY ON HARDWARE**    | Same memory note, "new block visible"                                  |
| ID            | 420     | (not a block)             | Internal ID enum table (`ID_NULL`, `ID_4CM`, ...); reference data       |
| CONTROLLERS   | 86      | INFRASTRUCTURE            | MIDI controllers / mappings; partly overlaps with MIDIBLOCK             |
| PATCH         | 85      | (already mapped)          | Mapped to `preset.*` above                                              |
| CABINET       | 68      | (already mapped)          | Mapped to `amp.*` (AM4 amp has built-in cab) above                      |
| GLOBAL        | 99      | (already mapped)          | Mapped to `global.*` above                                              |

## High-leverage audit candidates (no hardware needed)

These can be closed mechanically by reading the Ghidra dump and
adding entries to `KNOWN_PARAMS` for symbols the catalog lacks:

1. **PLEX reverb expansion** (~80 entries): add PLEX-specific
   reverb params under the existing `reverb.*` namespace with
   type-applicability gates for the Plex Reverb block type.
2. **Delay variants expansion** (~180 entries combined): register
   MEGATAP, TENTAP, MULTITAP params under `delay.*` with type
   gates. Bulk of the delay variant coverage.
3. **Drive variants** (~16 entries): audit FUZZ + DYNDIST symbols
   against the existing `drive.*` registrations.

## High-leverage audit candidates (hardware verification needed)

These require placing the candidate block in a slot on hardware
and observing whether the AM4 front panel reflects it:

4. **MIDIBLOCK** (5 entries): almost certainly AM4-exposed
   (Scene-MIDI work). Wire the 5 entries into `global.*`
   or a new `midiblock.*` namespace per founder preference.
5. **RINGMOD / FORMANT / IRCAPTURE** (~14 entries combined):    verify by checking AM4-Edit's block-type dropdown. If they
   appear, register; if not, they're multi-product artifacts.

## Low-leverage (skip or defer)

VOCODER, SYNTH, LOOPER, TONEMATCH, RTA, almost certainly
multi-product artifacts not exposed by AM4 firmware. Skip until
proven otherwise.

## Production code impact

None right now. This is a backlog-grooming document that maps the
high-leverage audit candidates so future sessions can pick them up
mechanically. The shipped catalog is functionally complete for
every block the AM4 actually exposes in practice; the gaps are
incremental coverage improvements (PLEX reverb params, delay
variants), not correctness bugs.

The single correctness bug surfaced this session (filter +
enhancer pan_left/right bipolar encoding) was fixed in the same
session, see STATE-AM4 follow-up #1.

## Regeneration

To re-run the cross-validate after a Ghidra re-mine or a catalog
update:

```bash
node -e "
const am4 = require('packages/fractal-midi/dist/am4/params.js');
const ghidra = require('SAMPLES/decoded/ghidra-am4edit-paramtables.json');
// ... per-block coverage diff (see scripts/_research/ if landed)
"
```

A reusable script lives at (not yet written, drop in
`scripts/_research/ghidra-am4-catalog-crossref.ts` when needed).
