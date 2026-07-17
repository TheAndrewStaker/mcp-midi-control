/**
 * Hand-maintained name table for cache-derived parameters.
 *
 * Pipeline (P1-010): `scripts/gen-params-from-cache.ts` walks every
 * CONFIRMED cache block, looks up each record's `id` in this table,
 * and emits a `KNOWN_PARAMS`-shape entry if a name is present.
 * Records without a name here are NOT emitted — they stay dormant
 * until a human assigns them a UI label (Session B of P1-010).
 *
 * Why a manual table instead of just emitting `param_{id}` placeholders:
 * MCP tool callers (Claude) need real human names to reason about
 * parameters. `amp.gain=6` is useful; `amp.param_11=6` is not. The
 * cache only stores ids + ranges, not labels.
 *
 * Sources for labels (in priority order):
 *   1. Wire captures that pin a name to a `(pidLow, pidHigh)` pair
 *      (highest confidence — see SYSEX-MAP §6a for the decode rule).
 *   2. `docs/manuals/Fractal-Audio-Blocks-Guide.txt` param descriptions.
 *   3. AM4-Edit UI labels observed via AM4-Edit screenshots.
 *
 * Entry shape (two forms):
 *   `'name'` — plain string. Generator infers unit from cache `c`
 *     (display-scale) via the default mapping (c=10 → knob_0_10,
 *     c=100 → percent, c=1000 → ms, c=1 → db, enum → enum).
 *   `{ name: 'label', unit: 'hz' }` — object form with an explicit
 *     unit override. Required when cache signature is ambiguous
 *     (e.g. c=1 could be dB / Hz / seconds / raw-count — the cache
 *     doesn't distinguish). Optional `displayMin` / `displayMax`
 *     overrides round the cache's internal min/max to a cleaner UI
 *     range where needed (e.g. reverb.predelay cache max=0.25s →
 *     displayMax=250 ms instead of the floating-point 250.0000…).
 *
 * Seed (2026-04-19): every name already registered in
 * `KNOWN_PARAMS`. 2026-04-20 added tone-stack + Mix
 * Page + Drive tone/level/mix + reverb predelay + LFO rates +
 * reverb time via the object-form overrides.
 *
 * OUT-OF-BAND PARAMS (not in the cache; hand-registered in
 * `KNOWN_PARAMS` directly, not through this pipeline):
 *   - `amp.level` / other-block `level` — pidHigh=0x0000, no cache
 *     record at id=0.
 *   - `{amp,drive,reverb,delay}.channel` — pidHigh=0x07D2, no cache
 *     record ( decoded this directly from wire captures).
 *
 * These remain in `params.ts` regardless of what this file says.
 */
import type { Unit } from './params.js';

export type ParamNameEntry =
  | string
  | { readonly name: string; readonly unit?: Unit; readonly displayMin?: number; readonly displayMax?: number };

// Universal per-block output Balance at cache id=2 — signature
// (a=-1, b=1, c=100) across every confirmed block. Blocks Guide §347
// documents Balance as a standard block-level parameter that pans
// the block's output between left and right. Requires the
// `bipolar_percent` unit (display -100..+100, internal -1..+1,
// scale 100) which generator default for c=100 would misclassify
// as plain `percent` (0..100).
const BALANCE: ParamNameEntry = {
  name: 'balance',
  unit: 'bipolar_percent',
  displayMin: -100,
  displayMax: 100,
};

export const PARAM_NAMES: Readonly<Record<string, Readonly<Record<number, ParamNameEntry>>>> = {
  amp: {
    2: BALANCE,
    // Out Boost Level — dB knob on the Extras tab,
    // cache (a=0, b=4, c=1, step=0.05). Wire-verified at pidHigh=0x08.
    8: { name: 'out_boost_level', unit: 'db', displayMin: 0, displayMax: 4 },
    10: 'type',
    11: 'gain',
    12: 'bass',
    // ids 13/14 (mid/treble) still structural — cache signature identical
    // to gain/bass (knob_0_10, 0..1 range, step 0.001). Named per the
    // AM4 Owner's Manual line 1563 tone-stack order "Gain, Bass, Mid,
    // Treble, Presence, Level". Spot-check still pending.
    13: 'mid',
    14: 'treble',
    // id 15 (pidHigh=0x0f) was mis-inferred as
    // 'presence' from the cache signature alone. Two
    // wire captures (amp-master on an unknown Marshall-family amp +
    // amp-master-2 on "Brit 800 #34") prove this register is Master.
    // Real Presence was subsequently captured at id 30 (pidHigh=0x1e).
    15: 'master',
    // Depth at pidHigh=0x1a, knob_0_10. Wire-
    // verified with a full 0→10 sweep capture.
    26: 'depth',
    // Presence at pidHigh=0x1e, knob_0_10. Wire-
    // verified on the same amp as amp-master. Corrects the
    // structural guess at id 15.
    30: 'presence',
    // 2026-04-29: Amp Expert-Edit page from
    // session-40-amp-expert.pcapng + paired AM4-Edit screenshot
    // (FAS Modern III). Wiggle order + screenshot column order
    // disambiguates the OFF/ON switches in the IDEAL column.
    20: { name: 'bright_cap', unit: 'pf', displayMin: 10, displayMax: 10000 },
    54: { name: 'input_trim', unit: 'count', displayMin: 0.1, displayMax: 10 },
    // amp's 8-band GEQ stores ±1 wire, scale ×12 → display ±12 dB.
    // Cache ids 62..69 share the (a=-1, b=1, c=12) signature. Uses the
    // `amp_geq_band` unit (scale 12) — distinct from drive's GEQ which
    // stores ±12 wire directly (cache c=1) and uses plain `db`.
    62: { name: 'geq_band_1', unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
    63: { name: 'geq_band_2', unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
    64: { name: 'geq_band_3', unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
    65: { name: 'geq_band_4', unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
    66: { name: 'geq_band_5', unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
    67: { name: 'geq_band_6', unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
    68: { name: 'geq_band_7', unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
    69: { name: 'geq_band_8', unit: 'amp_geq_band', displayMin: -12, displayMax: 12 },
    // ids 77/82/83 renamed 2026-07-15 to the UI-label-audit names (audit
    // rows DISTORT 77/82/83) already used by the hand-authored entries;
    // the old compressor_* names double-registered the registers (BK-106).
    // Old names alias in PARAM_ALIASES. NB the hand entry for 77 carries
    // displayMin 0.1 (corrected cache walk) — kept here so the cache
    // cross-check agrees.
    77: { name: 'clarity', unit: 'knob_0_10', displayMin: 0.1, displayMax: 10 },
    82: { name: 'amount', unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
    83: { name: 'threshold', unit: 'db', displayMin: -60, displayMax: 0 },
    84: { name: 'master_vol_trim', unit: 'count', displayMin: 0.1, displayMax: 10 },
    104: { name: 'high_treble', unit: 'db', displayMin: -12, displayMax: 12 },
    // 2026-05-16: DISTORT  closeout from
    // samples/captured/decoded/am4-params-proposed.ts (Ghidra-mined
    // catalog, Sessions 82–83) + cross-ref audit (35  amp
    // params at pidLow=0x003a). Same workflow as REVERB + DELAY
    // commit 5de0870: route through paramNames.ts overrides to
    // correct the cache pipeline's c=1 → 'db' fallback for Hz / count
    // entries, plus full overrides where c is non-default (c=0.4166
    // for spkr-reso knobs, c=2 for spkrdrive, c=31.62 for definition).
    // Names re-state the GENERATED_PARAM_NAMES entry verbatim where
    // present (firmware-truth from AM4-Edit.exe's variant resolver);
    // only unit / displayMin / displayMax overrides are emitted to
    // correct the cache pipeline defaults. Enum-typed ids (typecode
    // 16) need custom value tables and stay hand-authored in
    // params.ts later — see TODOs at the end of the amp: block.
    //
    // id=34 DISTORT_SPKRLFGAIN ("Low Reso") — cache type=48 a=0
    // b=24 c=0.4166666… → display ×c → 0..10 knob. Generator can't
    // infer c=0.4166; full override required. No GENERATED entry
    // (resolver doesn't reach this id), so emit the name here too.
    34: { name: 'low_reso', unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
    // id=38 DISTORT_MVCAP ("Master Vol Cap") — cache type=72 (log10)
    // a=1e-6 b=1e-3 c=1e6 → 1..1000 pF (Master-Volume bypass
    // capacitor in pF; sibling to amp.bright_cap at id=20 which uses
    // the same pf unit). GENERATED has `master_vol_cap`.
    38: { name: 'master_vol_cap', unit: 'pf', displayMin: 1, displayMax: 1000 },
    // id=51 DISTORT_SPKRHFGAIN ("Hi Reso") — same shape as id=34
    // (cache type=48, c=0.4166666…). GENERATED has `hi_reso`.
    51: { name: 'hi_reso', unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
    // id=57 DISTORT_SPKRDRIVE ("Drive") — speaker-stage drive knob.
    // Cache type=48 a=0 b=5 c=2 → display 0..10 knob. Generator can't
    // infer c=2; full override required. GENERATED has `drive`, which
    // collides with the existing drive block's `drive` (different
    // block — no collision at lookup). Renamed to `spkr_drive` to
    // avoid amp.drive vs drive.drive ambiguity in tool descriptions.
    57: { name: 'spkr_drive', unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
    // id=79 DISTORT_INEQFREQ ("Frequency") — input-EQ peaking
    // frequency. Cache type=66 a=100 b=10000 c=1 → Hz; default 'db'
    // wrong. GENERATED has `frequency`. The label "Frequency" alone
    // is ambiguous across amp's two EQ stages — renamed to
    // `input_eq_frequency` to mirror the existing `input_eq_low_cut`
    // / `input_eq_q` / `input_eq_gain` naming at adjacent paramIds.
    79: { name: 'input_eq_frequency', unit: 'hz', displayMin: 100, displayMax: 10000 },
    // id=81 DISTORT_DRIVE2 ("Normal Gain") — second drive register
    // for amps with a Normal channel (Marshall JTM/JCM-style).
    // Cache type=48 c=10 → knob_0_10 inference works; unit not
    // overridden. GENERATED has `overdrive` from the variant
    // resolver — keep the resolver name. (Cache pipeline will
    // auto-emit this entry on next gen-params since GENERATED
    // supplies the name.) Registered here for documentation and
    // to give the entry an explicit displayMin/Max audit trail.
    81: { name: 'overdrive', unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
    // id=86 DISTORT_DEFINITION ("Definition") — Power-amp definition
    // knob. Cache type=48 a=-0.31623 b=0.31623 c=31.62299 → bipolar
    // ×c → -10..+10. The 31.62 scale is ≈ 10/√10 — power-amp
    // definition appears stored on a log-axis but displayed as a
    // bipolar knob. Generator can't infer c=31.62; full override.
    // Use `count` (not bipolar_percent) since the front-panel reads
    // -10.0..+10.0, not ±100%.
    86: { name: 'definition', unit: 'count', displayMin: -10, displayMax: 10 },
    // id=87 DISTORT_CFTHRESH ("Compression") — Cathode-Follower
    // compression amount. Cache type=53 c=100 → percent inference
    // works; unit not overridden. GENERATED has `compression`.
    87: { name: 'compression', unit: 'percent', displayMin: 0, displayMax: 100 },
    // id=90 DISTORT_HICUT ("High Cut") — Preamp high-cut Hz.
    // Cache type=66 a=200 b=20000 c=1 → Hz; default 'db' wrong.
    // GENERATED has `high_cut`.
    90: { name: 'high_cut', unit: 'hz', displayMin: 200, displayMax: 20000 },
    // id=100 DISTORT_CBRATIO ("Cathode Resistance") — Cathode-bias
    // resistance amount. Cache type=53 c=100 → percent inference
    // works; unit not overridden. GENERATED has `cathode_resistance`.
    100: { name: 'cathode_resistance', unit: 'percent', displayMin: 0, displayMax: 100 },
    // id=125 DISTORT_VCCMON ("B+") — Power-supply B+ voltage MONITOR
    // (read-only meter, not a knob). Cache type=0 a=0 b=1 c=1 → raw
    // 0..1 float. Display as `count` (0..1) instead of the dB default.
    // GENERATED has `vccmon` (resolver had no XML label). Renamed
    // to `b_plus_monitor` to surface the function (it's the B+
    // headroom indicator behind the "B+" front-panel display).
    125: { name: 'b_plus_monitor', unit: 'count', displayMin: 0, displayMax: 1 },
    // id=126 DISTORT_GAINMON ("Gain") — Drive-stage gain MONITOR
    // (read-only meter). Cache type=0 c=1 → count. GENERATED has
    // `gain_gainmon` (dedupe artifact since `gain` is owned by id=11).
    // Renamed to `gain_monitor` for clarity.
    126: { name: 'gain_monitor', unit: 'count', displayMin: 0, displayMax: 1 },
    // id=137 DISTORT_VPLATEMON ("HEADROOM") — Power-amp plate-
    // voltage headroom monitor. Cache type=0 c=1 → count.
    // GENERATED has `headroom`.
    137: { name: 'headroom_monitor', unit: 'count', displayMin: 0, displayMax: 1 },
    // id=138 DISTORT_PREPRESENCE ("Treble") — Preamp-stage presence
    // shaper (the label is "Treble" on some amps, but the wire/
    // catalog calls it PREPRESENCE — pre-power-amp presence).
    // Cache type=48 c=10 → knob_0_10 inference works. GENERATED has
    // `presence_prepresence` (dedupe vs amp.presence at id=30).
    138: { name: 'presence_prepresence', unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
    // id=140 DISTORT_PAHICUT ("Tone") — Power-amp high-cut shaper
    // (label is "Tone" on AM4-Edit, catalog calls it PAHICUT).
    // Cache type=48 c=10 → knob_0_10 inference works. GENERATED has
    // `high_cut_pahicut`. Renamed to `pa_high_cut` for the same
    // reason `high_cut` (id=90) is preamp-side: clearer family
    // separation in describe_device output.
    140: { name: 'pa_high_cut', unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
    // id=145 DISTORT_GLOBALMASTER ("Overdrive Volume") — Global
    // post-amp master that scales after the cab sim. Cache type=48
    // c=10 → knob_0_10 inference works. GENERATED has
    // `overdrive_volume`.
    145: { name: 'overdrive_volume', unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
    // TODOs — enum-typed ids (cache typecode=16). Each needs a custom
    // enum value table hand-authored in params.ts; auto-emission via
    // paramNames.ts would force the wrong enumImport (AMP_TYPES_VALUES
    // is the Type enum at id=10, not these per-feature enums). The
    // GENERATED_PARAM_NAMES table also skips these because the
    // resolver only emits to non-enum cache slots. Symbol + range +
    // value labels listed below for the future capture-driven pass:
    //   id=47  DISTORT_BOOST       enum 0..1   "In Boost Sw" [OFF, ON]
    //   id=61  DISTORT_SATSWITCH   enum 0..2   "Saturation Sw" [OFF, ON, ON (IDEAL)]
    //   id=76  DISTORT_PRETUBETYPE enum 0..8   "Preamp Tube Type" [12AX7A SYL, ECC83, 7025, 12AX7A JJ, ECC803S, EF86, 12AX7A RCA, 12AX7A, 12AX7B]
    //   id=93  DISTORT_SUPPLYTYPE  enum 0..1   "Power Type" [AC, DC]
    //   id=103 DISTORT_PRESAG      enum 0..1   "Preamp Sag" [OFF, ON]
    //   id=109 DISTORT_INEQTYPE    enum 0..3   "Type" [LOWSHELF, PEAKING, HIGHSHELF, TILT EQ]
    //   id=111 DISTORT_PRESSHIFT   enum 0..1   "Pres. Shift" [OFF, ON]
    //   id=117 DISTORT_EQPOSITION  enum 0..2   "Location" [OUTPUT, PRE P.A., INPUT]
    //   id=130 DISTORT_BOOSTTYPE   enum 0..14  "In Boost Type" [NEUTRAL, T808, T808 MOD, SUPER OD, FULL OD, AC BOOST, SHIMMER, FAS BOOST, GRINDER, TREBLE BOOST, MID BOOST, CC BOOST, SHRED BOOST, RCB BOOST, JP IIC+ SHRED]
    //   id=133 DISTORT_EQONOFF     enum 0..1   "Off / On" [OFF, ON]
    //   id=135 DISTORT_SPKRMODEL   enum 0..92  "Spkr Imp. Curve" — 93-cab impedance-curve table (factory speaker IRs). Big table; consider a dedicated SPKR_IMP_CURVE_VALUES export in cacheEnums.ts.
    //   id=141 DISTORT_PAONOFF     enum 0..1   "Power Amp Modeling" [OFF, ON]
    //   id=142 DISTORT_SPKRBREAKUP enum 0..2   "Breakup" [SOFT, MEDIUM, HARD]
    //   id=144 DISTORT_PLATEDIODE  enum 0..1   "Plate Suppr. Diodes" [OFF, ON]
    //   id=146 DISTORT_AUTO_SPKR_Z enum 0..1   "DynaMatch" [OFF, ON]
    //   id=147 DISTORT_NFBCOMP     enum 0..1   "NFB Compensation" [OFF, ON]
    //   id=148 DISTORT_MODE_1      enum 0..3   "Mid/Gain Boost" [mode 1, mode 2, mode 3, mode 4]
    //   id=149 DISTORT_MODE_2      enum 0..3   "Tubes" — cache lists kind=float typecode=16 a=0 b=3; treat as 4-state enum (values pending capture).
    //
    // TODO — action / button-class (no cache record):
    //   id=65520 DISTORT_ZEROEQ    button       "Zero All" — XML exposes
    //     this as a UI control but cache has no record (button class,
    //     not a stored param). Wire-write should send the action to the
    //     GEQ block to reset all bands to 0 dB. Likely needs a synthetic
    //     entry in params.ts with a fixed action payload rather than a
    //     value range. Defer pending capture-confirmed wire shape.
  },
  drive: {
    2: BALANCE,
    10: 'type',
    11: 'drive',
    // AM4 Owner's Manual line 1330: "Page Right and dial in Drive, Tone,
    // and Level." Cache records at 0x0C and 0x0D have the identical
    // knob_0_10 signature to drive.drive (0x0B); typical pedal-UI order
    // matches. `mix` at 0x0E follows the universal Mix Page pattern
    // (percent). All three await Session D hardware spot-check.
    12: 'tone',
    13: 'level',
    14: 'mix',
    // 2026-04-25: EQ-page knobs decoded from
    // session-30-drive-basic-blackglass-7k. Cache ids 16/17 are the
    // Hz cuts (raw passthrough — c=1 default would mis-classify as dB),
    // ids 20/21/23 are the knob_0_10 Bass/Mid/Treble flanking id 22
    // (mid frequency in Hz). T808 OD doesn't expose these — the
    // session-30-drive-basic-t808-od capture only had drive/tone/level.
    16: { name: 'low_cut', unit: 'hz', displayMin: 20, displayMax: 2000 },
    20: 'bass',
    21: 'mid',
    22: { name: 'mid_freq', unit: 'hz', displayMin: 200, displayMax: 2000 },
    23: 'treble',
    //  +  (2026-04-29): Blackglass 7K Drive
    // Expert-Edit page exposes a second-Hz cut + a 10-band post-Drive
    // Graphic EQ + DIGITAL LO-FI + ADVANCED knobs. Decoded from
    // session-31-drive-expert.pcapng + paired AM4-Edit screenshot.
    // Closes  (0x002d = high_mid knob, knob_0_10 — wiggled
    // adjacent to drive.mid_freq + drive.treble in the timeline).
    //
    // - id 17 (0x0011): high_cut sibling to id 16. Cache c=1 a=200
    //   b=20000 — needs the 'hz' override (default would be dB).
    // - id 24 (0x0018): Bit Reduce count, cache a=0 b=24 c=1 raw.
    //   Uses the 'count' unit (default for c=1 would be dB).
    // - id 45 (0x002d): drive.high_mid for Blackglass 7K (cache c=10
    //   knob_0_10). Type-specific UI label varies; the register name
    //   reflects the most common Blackglass usage.
    17: { name: 'high_cut', unit: 'hz', displayMin: 200, displayMax: 20000 },
    24: { name: 'bit_reduce', unit: 'count', displayMin: 0, displayMax: 24 },
    // 10-band post-Drive Graphic EQ — cache ids 29..38 all share the
    // bipolar dB ±12 signature (a=-12 b=12 c=1 step=0.025). Frequencies
    // per the screenshot: 100, 160, 250, 400, 640, 1000, 1600, 2500,
    // 4000, 6400 Hz. Wire-display match is byte-exact on all 10 bands
    // (capture vs screenshot agree exactly).
    29: { name: 'geq_band_1', unit: 'db', displayMin: -12, displayMax: 12 },
    30: { name: 'geq_band_2', unit: 'db', displayMin: -12, displayMax: 12 },
    31: { name: 'geq_band_3', unit: 'db', displayMin: -12, displayMax: 12 },
    32: { name: 'geq_band_4', unit: 'db', displayMin: -12, displayMax: 12 },
    33: { name: 'geq_band_5', unit: 'db', displayMin: -12, displayMax: 12 },
    34: { name: 'geq_band_6', unit: 'db', displayMin: -12, displayMax: 12 },
    35: { name: 'geq_band_7', unit: 'db', displayMin: -12, displayMax: 12 },
    36: { name: 'geq_band_8', unit: 'db', displayMin: -12, displayMax: 12 },
    37: { name: 'geq_band_9', unit: 'db', displayMin: -12, displayMax: 12 },
    38: { name: 'geq_band_10', unit: 'db', displayMin: -12, displayMax: 12 },
    45: 'high_mid',
  },
  reverb: {
    1: 'mix',
    2: BALANCE,
    10: 'type',
    // Blocks Guide §Reverb Basic Page: "Time — Sets the decay time."
    // Cache 0x0B is 0.1..100 seconds, c=1 (raw passthrough). Needs the
    // 'seconds' unit override — generator default for c=1 is 'db'.
    // displayMin rounded to 0.1 (cache stores 0.10000000149…).
    11: { name: 'time', unit: 'seconds', displayMin: 0.1 },
    // Size at pidHigh=0x0f, percent. Wire-verified
    // on two captures — "Plate Size" (on Plate reverb type) and "Size"
    // (on Room reverb type) both wrote to this register, confirming
    // it's a universal reverb-size knob whose UI label depends on the
    // active reverb type.
    15: 'size',
    // the cache record at id=16 (0x10)
    // signature LOOKED like predelay (0..0.25s × 1000 = 0..250 ms) but
    // wire-testing proved it's a dead address — writes ack but the
    // firmware ignores them. The real predelay register is id=19 (0x13);
    // AM4-Edit captures wrote there for "Pre-Delay → 85 ms / 111.4 ms".
    // Skipping id=16 here so the generator doesn't emit the wrong cache
    // mapping; the corrected entry lives hand-authored in params.ts.
    // The cache record at 0x13 has no name slot here either — it's
    // not exposed via the auto-gen path; instead reverb.predelay is
    // a pure KNOWN_PARAMS hand-authored entry going forward.
    // Spring-reverb-specific. Number of Springs
    // (integer count 2..6) at pidHigh=0x1b; cache c=1 structurally
    // ambiguous — needs 'count' override. Spring Tone (knob_0_10) at
    // pidHigh=0x1c; cache signature matches knob_0_10 default. Both
    // only visible in AM4-Edit when a Spring reverb type is active,
    // but the registers remain writable on any type — writes simply
    // no-op on non-spring reverbs.
    27: { name: 'springs', unit: 'count', displayMin: 2, displayMax: 6 },
    28: 'spring_tone',
    // follow-up 2026-04-21: Shimmer Verb / Plex Verb
    // "Shift 1" and "Shift 2" pitch-shifter voices. Blocks Guide
    // §Shimmer Verb Parameters: "Shift 1–8 — Sets the amount of
    // detune within a range of ±24 semitones. This is where
    // 'Shimmer' is born." AM4's reverb has two such voices (ids
    // 56/57); the AxeFx/FM8-voice variant ships more. Cache signature
    // (a=-24, b=24, c=1, step=1) matches the BG documentation
    // exactly — needs the 'semitones' unit override since c=1 is
    // structurally ambiguous. Structural registration; -style
    // spot-check still required.
    // ids 56/57 renamed 2026-07-15 to the UI-label-audit names already used
    // by the hand-authored entries (BK-106 double-registration scan); old
    // shift_1/shift_2 names alias in PARAM_ALIASES.
    56: { name: 'voice_1_shift', unit: 'semitones', displayMin: -24, displayMax: 24 },
    57: { name: 'voice_2_shift', unit: 'semitones', displayMin: -24, displayMax: 24 },
    // 2026-05-16: REVERB params from
    // samples/captured/decoded/am4-params-proposed.ts (Ghidra-mined
    // catalog, –83). Routed through paramNames.ts overrides
    // (not direct cacheParams hand-edit) per the  unit-fallback
    // trap — the cache pipeline's c=1 default emits `unit: 'db'`, wrong
    // for Hz / Q / count / semitones / seconds. Names defer to the
    // resolver-derived GENERATED_PARAM_NAMES entries (firmware-truth from
    // AM4-Edit.exe's variant resolver) where they exist; only unit /
    // displayMin / displayMax overrides are emitted to correct the
    // cache pipeline defaults. Eight ids (51, 53, 54, 59, 61, 64, 68,
    // 70) have no GENERATED entry — those that are enums need a custom
    // value list and stay hand-authored in params.ts (see TODOs below).
    //
    // id=13 REVERB_HFRATIO ("High Decay") — cache type=64 log10
    // a=0.01 b=1 → decay-ratio knob, NOT dB. Display 0.01..1 as a
    // count (effectively a percent ×100, but cache emits as raw float).
    13: { name: 'high_decay', unit: 'count', displayMin: 0.01, displayMax: 1 },
    // id=22 REVERB_RATE — cache type=66 log10 a=0.01 b=1 → modulation
    // rate. Range 0..1 is a normalized rate knob (UI shows 0.0..1.00 Hz
    // approximately). Use 'hz' with the raw range.
    22: { name: 'rate', unit: 'hz', displayMin: 0.01, displayMax: 1 },
    // ids 30/31 REVERB_FREQ1/FREQ2 — cache type=66 log10 c=1, a/b are
    // the actual Hz range. Default 'db' is wrong.
    30: { name: 'frequency_1', unit: 'hz', displayMin: 20, displayMax: 2000 },
    31: { name: 'frequency_2', unit: 'hz', displayMin: 100, displayMax: 10000 },
    // ids 32/33 REVERB_Q1/Q2 — cache type=64 log10 a=0.1 b=10 → Q
    // factor 0.1..10. Default 'db' is wrong; use 'count'.
    32: { name: 'q_1', unit: 'count', displayMin: 0.1, displayMax: 10 },
    33: { name: 'q_2', unit: 'count', displayMin: 0.1, displayMax: 10 },
    // id=37 REVERB_LFTIME ("Low Decay") — cache type=64 log10 a=0.02
    // b=2 sec → seconds, not dB.
    37: { name: 'low_decay', unit: 'seconds', displayMin: 0.02, displayMax: 2 },
    // id=38 REVERB_LFXOVER ("Xover Frequency") — cache type=66 a=100
    // b=10000 → Hz.
    38: { name: 'xover_frequency', unit: 'hz', displayMin: 100, displayMax: 10000 },
    // id=45 REVERB_EARLYDECAY ("Early Decay") — cache c=50 a=0 b=2 →
    // display 0..100% (a*c..b*c). Generator can't infer c=50; full
    // override required.
    45: { name: 'early_decay', unit: 'percent', displayMin: 0, displayMax: 100 },
    // id=49 REVERB_BASETYPE — cache kind=float type=16 range 0..8 →
    // integer count selector (which base reverb algorithm). Should
    // ideally be an enum with named base types, but cache lacks the
    // value table — registered as count for now.
    49: { name: 'basetype', unit: 'count', displayMin: 0, displayMax: 8 },
    // id=50 REVERB_LFOPHASE — cache type=54 c=57.29578 (rad→deg) →
    // 0..180 degrees per radians-encoded LFO phase convention.
    50: { name: 'lfo_phase', unit: 'degrees', displayMin: 0, displayMax: 180 },
    // id=55 REVERB_PITCHMIX — c=100 already correct percent; no
    // override needed. Skipping.
    // id=60 REVERB_PITCHTIME ("Splice Time") — cache type=52 c=1000
    // a=0.01 b=2 sec → 10..2000 ms. Generator emits 'ms' but
    // displayMin defaults to 0; override the lower bound.
    60: { name: 'splice_time', unit: 'ms', displayMin: 10, displayMax: 2000 },
    // id=63 REVERB_PITCHBAL ("Voice Balance") — c=100 a=-1 b=1 →
    // bipolar_percent; generator default for c=100 is plain percent.
    63: { name: 'voice_balance', unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
    // id=67 REVERB_PITCHLPF ("Pitch High Cut") — cache type=66 a=200
    // b=20000 → Hz; default 'db' wrong.
    67: { name: 'pitch_high_cut', unit: 'hz', displayMin: 200, displayMax: 20000 },
    // ids 71/72 REVERB_LOWQ/HIGHQ ("Low Cut Q" / "High Cut Q") —
    // cache type=64 log10 a=0.1 b=10 → Q factor count; default 'db'
    // wrong.
    71: { name: 'low_cut_q', unit: 'count', displayMin: 0.1, displayMax: 10 },
    72: { name: 'high_cut_q', unit: 'count', displayMin: 0.1, displayMax: 10 },
    // TODO (no GENERATED entry, enum without value table — hand-author
    // in params.ts with proper enum map):
    //   id=51 REVERB_INPUTSELECT  enum 0..2  (likely L+R / L / R)
    //   id=53 REVERB_LOWSLOPE     enum 0..1  (slope toggle)
    //   id=54 REVERB_HIGHSLOPE    enum 0..1  (slope toggle)
    //   id=59 REVERB_PITCHDIR     enum 0..3  (pitch shift direction)
    //   id=61 REVERB_PITCHPOS     enum 0..2  (pitch position)
    //   id=64 REVERB_PREDLYTEMPO  enum 0..78 (TEMPO_DIVISIONS_VALUES)
    //   id=68 REVERB_SPRINGTYPE   enum 0..1  (spring type toggle)
    //   id=70 REVERB_PREDLYTAP    enum 0..1  (predelay tap mode)
  },
  delay: {
    // Mix follows the universal percent-at-0x01 pattern (Blocks Guide
    // §Common Mix/Level Parameters, p. 7). "delay block uses a
    // different Mix Law compared to other blocks" — same param, just
    // different internal curve; still the wet/dry knob.
    1: 'mix',
    2: BALANCE,
    10: 'type',
    12: 'time',
    // Feedback at pidHigh=0x0e. Cache (a=-1, b=1,
    // c=100) is bipolar — negative feedback inverts the phase of the
    // repeats, a standard Fractal delay feature.
    14: { name: 'feedback', unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
    // 2026-04-25: Ducking attenuation amount,
    // session-30-delay-basic-digital-mono capture. Cache id=46 a=0
    // b=80 c=1 → raw dB 0..80. Same signature as reverb.ducking.
    // delay.level (out-of-band, pidHigh=0x0000) and
    // delay.stack_hold (per-block non-Type enum, pidHigh=0x001f) are
    // hand-authored in params.ts directly.
    46: 'ducking',
    // 2026-04-29: Delay Expert-Edit page on
    // Ambient Stereo from session-40-delay-expert.pcapng. ~32 new
    // params across BASIC + DIFFUSOR + EQ + MIX + DUCKER + COMPANDER
    // + STACK/HOLD + LO FI sections. Cache shapes pin units; screenshot
    // labels confirm names. Bypass_mode / kill_dry / phase_reverse /
    // slopes / compander enums are hand-authored in params.ts.
    13: { name: 'lr_time_ratio', unit: 'percent', displayMin: 1, displayMax: 100 },
    16: { name: 'feedback_r', unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
    18: { name: 'stereo_spread', unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
    20: { name: 'low_cut', unit: 'hz', displayMin: 20, displayMax: 2000 },
    21: { name: 'high_cut', unit: 'hz', displayMin: 200, displayMax: 20000 },
    27: { name: 'input_gain', unit: 'percent', displayMin: 0, displayMax: 100 },
    32: { name: 'master_feedback', unit: 'percent', displayMin: 0, displayMax: 200 },
    47: { name: 'ducker_threshold', unit: 'db', displayMin: -80, displayMax: 20 },
    48: { name: 'ducker_release', unit: 'ms', displayMin: 1, displayMax: 1000 },
    // id 49 respelled 2026-07-15 to match the hand-authored diffuser entry
    // (BK-106 double-registration scan); diffusor aliases in PARAM_ALIASES.
    49: { name: 'diffuser', unit: 'percent', displayMin: 0, displayMax: 100 },
    50: { name: 'diffusion_time', unit: 'percent', displayMin: 1, displayMax: 100 },
    63: { name: 'eq_q_high_low', unit: 'count', displayMin: 0.1, displayMax: 10 },
    64: { name: 'bit_reduction', unit: 'count', displayMin: 0, displayMax: 24 },
    65: { name: 'eq_freq_1', unit: 'hz', displayMin: 20, displayMax: 2000 },
    66: { name: 'eq_freq_2', unit: 'hz', displayMin: 100, displayMax: 10000 },
    67: { name: 'eq_q_1', unit: 'count', displayMin: 0.1, displayMax: 10 },
    68: { name: 'eq_q_2', unit: 'count', displayMin: 0.1, displayMax: 10 },
    69: { name: 'eq_gain_1', unit: 'db', displayMin: -12, displayMax: 12 },
    70: { name: 'eq_gain_2', unit: 'db', displayMin: -12, displayMax: 12 },
    // 2026-05-04: cache id=72 (DELAY_SPEED, "Motor Speed") has
    // a=0.5, b=2, c=1 — a tape-motor speed multiplier, not dB. Without
    // this hand override the cache pipeline emits unit='db' from the
    // c=1 default. Range 0.5..2.0 = half-speed to double-speed; only
    // applies when delay.type is Ping-Pong (per type-applicability).
    72: { name: 'motor_speed', unit: 'count', displayMin: 0.5, displayMax: 2 },
    76: { name: 'compander_time', unit: 'ms', displayMin: 1, displayMax: 100 },
    77: { name: 'compander_threshold', unit: 'db', displayMin: -100, displayMax: -20 },
    78: { name: 'master_time', unit: 'percent', displayMin: 25, displayMax: 400 },
    79: { name: 'lfo_rate', unit: 'hz', displayMin: 0.1, displayMax: 10 },
    80: { name: 'lfo_depth', unit: 'percent', displayMin: 0, displayMax: 100 },
    87: { name: 'stack_feedback', unit: 'percent', displayMin: 0, displayMax: 100 },
    88: { name: 'hold_feedback', unit: 'percent', displayMin: 0, displayMax: 100 },
    // 2026-05-16: DELAY params from
    // samples/captured/decoded/am4-params-proposed.ts (Ghidra-mined
    // catalog, –83). Same workflow as the REVERB block above:
    // route through paramNames.ts overrides to correct the cache
    // pipeline's c=1 → 'db' fallback for Hz / Q / count / degrees
    // entries. Names use the resolver-derived GENERATED_PARAM_NAMES
    // entries (firmware-truth) where they exist; ids with no GENERATED
    // entry are enums that need custom value tables and stay
    // hand-authored in params.ts (see TODOs below).
    //
    // id=17 DELAY_DELAYPAN ("Echo Pan") — c=100 a=-1 b=1 → bipolar
    // pan, not a 0..100 percent. Generator default for c=100 is plain
    // 'percent'; override to bipolar_percent.
    17: { name: 'echo_pan', unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
    // ids 22/23 DELAY_RATE1/RATE2 ("Mod Rate" / "Rate") — cache type=66
    // log10 a=0.1..10 / 0.2..20 → Hz. Default 'db' wrong.
    22: { name: 'mod_rate', unit: 'hz', displayMin: 0.1, displayMax: 10 },
    23: { name: 'rate', unit: 'hz', displayMin: 0.2, displayMax: 20 },
    // ids 34/35 DELAY_FEEDLR/FEEDRL ("Rotation" / second routing) —
    // c=100 a=-1 b=1 → bipolar_percent. Generator default is plain
    // 'percent' which loses the sign.
    34: { name: 'rotation', unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
    35: { name: 'lfo_phase', unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
    // ids 38/39 DELAY_PANL/PANR ("Pan L" / "Pan R") — type=48 c=100
    // a=-1 b=1 → bipolar pan.
    38: { name: 'pan_l', unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
    39: { name: 'pan_r', unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
    // ids 40/41 DELAY_LFO1PHASE/LFO2PHASE — type=54 c=57.29578 (rad→
    // deg) → 0..180 degrees per radians-encoded LFO phase convention.
    // Generator's c=57.29... is unrecognized; falls through to skip.
    // Full override required.
    40: { name: 'modulation_phase', unit: 'degrees', displayMin: 0, displayMax: 180 },
    41: { name: 'lfo_phase_2', unit: 'degrees', displayMin: 0, displayMax: 180 },
    // id=42 DELAY_SPLICETIME ("Crossfade Time") — type=52 c=1000
    // a=0.001 b=0.255 → ms 1..255. Generator emits ms but displayMin
    // floors to 0; override the lower bound to match cache.
    42: { name: 'crossfade_time', unit: 'ms', displayMin: 1, displayMax: 255 },
    // id=56 DELAY_RATE3 ("Sweep Rate") — type=66 → Hz; default 'db' wrong.
    56: { name: 'sweep_rate', unit: 'hz', displayMin: 0.1, displayMax: 10 },
    // id=58 DELAY_LFO3PHASE ("Sweep Phase") — type=54 → degrees.
    58: { name: 'sweep_phase', unit: 'degrees', displayMin: 0, displayMax: 180 },
    // ids 60/61 DELAY_FSTART/FSTOP ("Sweep Start/Stop Freq") — type=66
    // → Hz; default 'db' wrong.
    60: { name: 'sweep_start_freq', unit: 'hz', displayMin: 100, displayMax: 1000 },
    61: { name: 'sweep_stop_freq', unit: 'hz', displayMin: 500, displayMax: 5000 },
    // id=62 DELAY_Q ("Sweep Resonance") — type=80 log10 c=10 a=0.2
    // b=20 → Q-factor 0.2..20. Cache c=10 makes generator emit
    // 'knob_0_10' with bounds 0..10 — wrong upper bound and misleading
    // unit name. Use 'count' with the real range.
    62: { name: 'sweep_resonance', unit: 'count', displayMin: 0.2, displayMax: 20 },
    // id=82 DELAY_RATE4 ("Pan Rate") — type=66 → Hz.
    82: { name: 'pan_rate', unit: 'hz', displayMin: 0.1, displayMax: 10 },
    // id=85 DELAY_LFO4PHASE — type=54 → degrees. GENERATED named it
    // `lfo_phase_lfo4phase` (deduplication artifact); use the cleaner
    // `lfo_phase_4` since LFO1 phase already owns plain `lfo_phase`.
    85: { name: 'lfo_phase_4', unit: 'degrees', displayMin: 0, displayMax: 180 },
    // TODO (no GENERATED entry, enum without value table — hand-author
    // in params.ts with proper enum map):
    //   id=11 DELAY_TYPE         enum 0..7  (delay mode variant)
    //   id=28 DELAY_LFO1TYPE     enum 0..9  (LFO waveform: sine/tri/...)
    //   id=29 DELAY_LFO2TYPE     enum 0..9  (LFO waveform)
    //   id=33 DELAY_TEMPOR       enum 0..78 (TEMPO_DIVISIONS_VALUES)
    //   id=43 DELAY_RUN          enum 0..1  (run/stop toggle)
    //   id=44 DELAY_MODE         enum 0..1  (mode toggle)
    //   id=52 DELAY_LFO1TARGET   enum 0..2  (LFO 1 target)
    //   id=53 DELAY_LFO2TARGET   enum 0..2  (LFO 2 target)
    //   id=54 DELAY_LFO1TEMPO    enum 0..78 (TEMPO_DIVISIONS_VALUES)
    //   id=55 DELAY_LFO2TEMPO    enum 0..78 (TEMPO_DIVISIONS_VALUES)
    //   id=57 DELAY_LFO3TYPE     enum 0..9  (LFO waveform)
    //   id=59 DELAY_LFO3TEMPO    enum 0..78 (TEMPO_DIVISIONS_VALUES)
    //   id=71 DELAY_MAXDEPTH     enum 0..1  (max depth toggle)
    //   id=81 DELAY_LFO4TYPE     enum 0..9  (LFO waveform)
    //   id=83 DELAY_LFO4TEMPO    enum 0..78 (TEMPO_DIVISIONS_VALUES)
    //   id=86 DELAY_LFO4TARGET   enum 0..3  (LFO 4 target)
    //   id=89 DELAY_SVFTYPE      enum 1..3  (SVF filter type)
  },
  // Universal `mix` at pidHigh 0x01 across every effect block that
  // exposes a Mix Page per the Blocks Guide (p. 7). Skipped for
  // Amp/Drive (different semantics), Wah/GEQ/Gate/VolPan (no wet/dry —
  // AM4 manual p.34 line 1423: "Effects with no mix, such as Wah,
  // GEQ, etc., will show 'NA'"). Cache signature matches percent
  // (0..1 × 100) structurally identical to the confirmed reverb.mix.
  // Modulation-block LFO controls. Blocks Guide §Chorus/Flanger/Phaser
  // document "Rate (Hz/BPM): Controls the speed of the modulation" —
  // all three blocks expose a rate knob with the same cache-c=1 raw-Hz
  // signature. Depth is a percent knob at a distinct pidHigh per block.
  chorus: {
    1: 'mix',
    2: BALANCE,
    10: 'type',
    12: { name: 'rate', unit: 'hz', displayMin: 0.1 },
    14: 'depth',
    // 2026-04-29: Chorus Expert-Edit page on
    // Analog Stereo from session-40-chorus-expert.pcapng. Cache shapes
    // pin units; screenshot labels confirm names.
    11: { name: 'number_of_voices', unit: 'count', displayMin: 1, displayMax: 4 },
    15: { name: 'high_cut', unit: 'hz', displayMin: 200, displayMax: 20000 },
    21: { name: 'lfo_phase_pct', unit: 'percent', displayMin: 0, displayMax: 100 },
    // ids 22/23/25/26 renamed 2026-07-15 to the UI-label-audit names the
    // hand-authored KNOWN_PARAMS entries already carry (audit rows CHORUS
    // 22/23/25/26) — the old generator names (lfo_rate/width/lfo_freq/
    // lfo_depth_2) double-registered the same registers under misleading
    // names (BK-106 scan). Deliberately NOT aliased: each old name reads
    // as a different control than the register it addressed.
    22: { name: 'rate_right', unit: 'hz', displayMin: 0.1, displayMax: 10 },
    23: { name: 'lfo_2_depth', unit: 'percent', displayMin: 0, displayMax: 100 },
    24: { name: 'drive', unit: 'knob_0_10', displayMin: 0.5, displayMax: 500 },
    25: { name: 'low_cut', unit: 'hz', displayMin: 20, displayMax: 2000 },
    26: { name: 'stereo_spread', unit: 'bipolar_percent', displayMin: -200, displayMax: 200 },
  },
  // geq Expert-Edit additions are merged into the existing geq:
  // entry above (lines ~299) — duplicate removed in cleanup.
  // The 10 GEQ bands + master_q now live there.
  flanger: {
    1: 'mix',
    2: BALANCE,
    10: 'type',
    11: { name: 'rate', unit: 'hz', displayMin: 0.05 },
    13: 'depth',
    // Feedback at pidHigh=0x0e. Cache (a=-0.995,
    // b=0.995, c=100) — bipolar_percent with the internal range
    // clamped slightly short of ±1.0 per Fractal's flanger
    // implementation.
    14: { name: 'feedback', unit: 'bipolar_percent', displayMin: -99, displayMax: 99 },
    // 2026-05-17: FLANGER unit overrides to correct
    // the cache pipeline's c=1 → 'db' default for entries the catalog
    // says are Hz / count / ms / knob. Names defer to GENERATED_PARAM_NAMES
    // for ids the resolver covered (19/23/25/30/35) — only unit fixes
    // emitted here. Source: paramNamesGenerated.ts + cache-section3.json
    // ranges.
    19: { name: 'smooth_steps', unit: 'count', displayMin: 0.5, displayMax: 50 },
    23: { name: 'high_cut', unit: 'hz', displayMin: 200, displayMax: 20000 },
    25: { name: 'low_cut', unit: 'hz', displayMin: 20, displayMax: 2000 },
    35: { name: 'vpo_exponent', unit: 'count', displayMin: 0.01, displayMax: 100 },
  },
  phaser: {
    1: 'mix',
    2: BALANCE,
    10: 'type',
    12: { name: 'rate', unit: 'hz', displayMin: 0.1 },
    // Feedback at pidHigh=0x10. Cache (a=-0.9,
    // b=0.9, c=111.1) — bipolar, internal ±0.9 with an unusual
    // display-scale of 111.1 meaning internal -0.9 displays as
    // -99.99%. We use the standard bipolar_percent unit (scale 100)
    // with displayMin/Max clamped to ±90 so input stays within the
    // internal range; the displayed percentage in AM4-Edit may read
    // slightly higher than the value Claude used (e.g. "50" sets
    // internal 0.5, AM4-Edit displays ~55.5%) but the wire behavior
    // is correct. Natural-language UX impact is negligible.
    16: { name: 'feedback', unit: 'bipolar_percent', displayMin: -90, displayMax: 90 },
    //  cont (2026-05-17): PHASER unit overrides. Same
    // cache-c=1 → 'db' default correction as flanger above. Names
    // defer to GENERATED_PARAM_NAMES.
    17: { name: 'min_frequency', unit: 'hz', displayMin: 5, displayMax: 500 },
    18: { name: 'max_frequency', unit: 'hz', displayMin: 200, displayMax: 20000 },
    20: { name: 'bias', unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
    22: { name: 'feedback_point', unit: 'count', displayMin: 0, displayMax: 11 },
    25: { name: 'q', unit: 'count', displayMin: 0.1, displayMax: 10 },
    29: { name: 'shape_vcrk', unit: 'count', displayMin: 0.1, displayMax: 10 },
    30: { name: 'shape', unit: 'count', displayMin: 0.01, displayMax: 0.99 },
    // id=31 high_cut: cache stores in kHz (0.5..50). 'count' until
    // confirmed via capture — Hz unit would mislabel the display value.
    31: { name: 'high_cut', unit: 'count', displayMin: 0.5, displayMax: 50 },
    35: { name: 'low_cut', unit: 'hz', displayMin: 20, displayMax: 200 },
    36: { name: 'high_cut_lpf', unit: 'hz', displayMin: 2000, displayMax: 20000 },
  },
  wah: {
    1: 'mix',
    2: BALANCE,
    10: 'type',
    // 2026-04-29: Wah Expert-Edit page on FAS Wah
    // from session-40-wah-expert.pcapng. Cache shapes pin units;
    // screenshot labels confirm names. ** audit ( cont,
    // 2026-04-29):** the original auto-generated names for ids 13..20
    // were misaligned vs the AM4-Edit screenshot. Each label below was
    // re-derived from the value-matched audit table run via
    // `scripts/audit-block-vs-screenshot.ts` against
    // `docs/audit-input/wah.json`. Old → new mapping:
    //   13 (was `q`,                  range 2..20) → `q_resonance`, range 0..10
    //   14 (was `q_resonance`)        → `q_tracking`
    //   15 (was `q_tracking`)         → `wah_control`
    //   16 (was `drive`)              → `fat`
    //   17 (was `fat`)                → `drive`
    //   18 (was unregistered)         → `control_taper` (enum, hand-authored in params.ts)
    //   19 (was `low_cut_frequency`)  → `inductor_bias`
    //   20 (was `inductor_bias`)      → `low_cut_frequency`
    // ids 11/12 renamed 2026-07-15 to the UI-label-audit names already used
    // by the hand-authored entries (BK-106 double-registration scan); old
    // min_frequency/max_frequency names alias in PARAM_ALIASES.
    11: { name: 'minimum_frequency', unit: 'hz', displayMin: 100, displayMax: 1000 },
    12: { name: 'maximum_frequency', unit: 'hz', displayMin: 500, displayMax: 5000 },
    13: { name: 'q_resonance', unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
    14: { name: 'q_tracking', unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
    15: { name: 'wah_control', unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
    16: { name: 'fat', unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
    17: { name: 'drive', unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
    19: { name: 'inductor_bias', unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
    20: { name: 'low_cut_frequency', unit: 'hz', displayMin: 20, displayMax: 2000 },
    22: { name: 'graphic_eq_band_1', unit: 'db', displayMin: -12, displayMax: 12 },
    23: { name: 'graphic_eq_band_2', unit: 'db', displayMin: -12, displayMax: 12 },
    24: { name: 'graphic_eq_band_3', unit: 'db', displayMin: -12, displayMax: 12 },
    25: { name: 'graphic_eq_band_4', unit: 'db', displayMin: -12, displayMax: 12 },
    26: { name: 'graphic_eq_band_5', unit: 'db', displayMin: -12, displayMax: 12 },
    27: { name: 'graphic_eq_band_6', unit: 'db', displayMin: -12, displayMax: 12 },
    28: { name: 'graphic_eq_band_7', unit: 'db', displayMin: -12, displayMax: 12 },
    29: { name: 'graphic_eq_band_8', unit: 'db', displayMin: -12, displayMax: 12 },
  },
  // 2026-04-29: NEW BLOCKS — PEQ (parametric EQ,
  // pidLow=0x0036, S2 cacheBlock=4) and Rotary (pidLow=0x0056, S3
  // cacheBlock=4). Neither has a Type enum at id=10. Captures from
  // session-40-{peq,rot}-expert.pcapng.
  peq: {
    1: 'mix',
    2: BALANCE,
    // 5 channels of parametric EQ, each with Type / Frequency / Q /
    // Gain / Solo. Cache lays them out in groups: ids 10-14 are the
    // 5 frequencies (Hz, varying ranges), 15-19 are the 5 Q values
    // (count 0.1..10), 20-24 are the 5 gains (dB ±20).
    10: { name: 'channel_1_frequency', unit: 'hz', displayMin: 20, displayMax: 2000 },
    11: { name: 'channel_2_frequency', unit: 'hz', displayMin: 100, displayMax: 10000 },
    12: { name: 'channel_3_frequency', unit: 'hz', displayMin: 100, displayMax: 10000 },
    13: { name: 'channel_4_frequency', unit: 'hz', displayMin: 100, displayMax: 10000 },
    14: { name: 'channel_5_frequency', unit: 'hz', displayMin: 200, displayMax: 20000 },
    15: { name: 'channel_1_q', unit: 'count', displayMin: 0.1, displayMax: 10 },
    16: { name: 'channel_2_q', unit: 'count', displayMin: 0.1, displayMax: 10 },
    17: { name: 'channel_3_q', unit: 'count', displayMin: 0.1, displayMax: 10 },
    18: { name: 'channel_4_q', unit: 'count', displayMin: 0.1, displayMax: 10 },
    19: { name: 'channel_5_q', unit: 'count', displayMin: 0.1, displayMax: 10 },
    20: { name: 'channel_1_gain', unit: 'db', displayMin: -20, displayMax: 20 },
    21: { name: 'channel_2_gain', unit: 'db', displayMin: -20, displayMax: 20 },
    22: { name: 'channel_3_gain', unit: 'db', displayMin: -20, displayMax: 20 },
    23: { name: 'channel_4_gain', unit: 'db', displayMin: -20, displayMax: 20 },
    24: { name: 'channel_5_gain', unit: 'db', displayMin: -20, displayMax: 20 },
  },
  rotary: {
    1: 'mix',
    2: BALANCE,
    // FAS Rotary cabinet sim. Cache layout (cacheBlock=4 in S3).
    // ** audit ( cont, 2026-04-29):** initial cache-driven
    // names had two pidHigh swaps vs the AM4-Edit screenshot. Re-derived
    // via `scripts/audit-block-vs-screenshot.ts` against
    // `docs/audit-input/rotary.json`:
    //   id 10 (was `drive`)        → `rate` (Leslie speed knob; cache
    //                                  range 0..10 ×1 → display 0..10 Hz)
    //   id 21 (was `mic_spacing`)  → `drive` (cache range 0.5..500 ×10)
    //   id 16 (was unregistered)   → `mic_spacing` (cache π-encoded:
    //                                  range 0..π × 31.831 → display 0..100)
    // Plus 5 new entries founder confirmed from screenshot:
    //   id 0 → `level` (db); id 4 → `bypass_mode` (enum, hand-authored
    //   in params.ts); id 14 → `tempo` (TEMPO_DIVISIONS, hand-authored);
    //   id 20 → `stereo_spread` (bipolar -200..200%); id 23 →
    //   `input_select` (enum [L+R, LEFT, RIGHT], hand-authored).
    10: { name: 'rate', unit: 'hz', displayMin: 0, displayMax: 10 },
    11: { name: 'low_depth', unit: 'percent', displayMin: 0, displayMax: 100 },
    12: { name: 'high_depth', unit: 'percent', displayMin: 0, displayMax: 100 },
    13: { name: 'high_level', unit: 'db', displayMin: -6, displayMax: 6 },
    15: { name: 'rotor_length', unit: 'percent', displayMin: 0.1, displayMax: 100 },
    16: { name: 'mic_spacing', unit: 'rotary_mic_spacing', displayMin: 0, displayMax: 100 },
    17: { name: 'low_rate_multiplier', unit: 'count', displayMin: 0.1, displayMax: 10 },
    18: { name: 'low_time_constant', unit: 'count', displayMin: 0.1, displayMax: 10 },
    19: { name: 'high_time_constant', unit: 'count', displayMin: 0.1, displayMax: 10 },
    20: { name: 'stereo_spread', unit: 'bipolar_percent', displayMin: -200, displayMax: 200 },
    21: { name: 'drive', unit: 'knob_0_10', displayMin: 0.5, displayMax: 500 },
    22: { name: 'mic_distance', unit: 'count', displayMin: 0.01, displayMax: 1 },
  },
  compressor: {
    1: 'mix',
    2: BALANCE,
    // 2026-04-25: Compressor first-page knobs from
    // session-30-comp-basic-jfet-studio. Cache ids 10..15 are the
    // canonical comp-config registers per Blocks Guide §Compressor:
    // Threshold (dB), Ratio (1..20:1, new `ratio` unit), Attack (ms),
    // Release (ms), Knee Type enum (id 14, not yet wiggled), Auto
    // Makeup OFF/ON (id 15, hand-authored in params.ts because per-
    // block non-Type enums skip the generator). compressor.level
    // (pidHigh=0x0000) is out-of-band hand-authored.
    10: { name: 'threshold', unit: 'db', displayMin: -60, displayMax: 20 },
    // ids 12/13 renamed 2026-07-15 to the UI-label-audit names already used
    // by the hand-authored entries (BK-106 double-registration scan); old
    // attack/release names alias in PARAM_ALIASES.
    12: { name: 'attack_time', unit: 'ms', displayMin: 0.1, displayMax: 100 },
    13: { name: 'release_time', unit: 'ms', displayMin: 2, displayMax: 2000 },
    19: 'type',
    // Ratio uses the new `ratio` unit (display = internal, scale 1) so
    // Claude reads "ratio 4" as 4:1 not 4 dB. Cache c=1 default would
    // mis-classify as dB; full override required.
    11: { name: 'ratio', unit: 'ratio', displayMin: 1, displayMax: 20 },
    //  +  (2026-04-29): JFET Studio Compressor
    // Expert-Edit page exposes a Sidechain section + a Drive-engine
    // emphasis knob. Decoded from session-31-comp-jfet-expert.pcapng
    // + paired AM4-Edit screenshot. Cache shapes pin units; screenshot
    // labels confirm the names. Wire-vs-screenshot value mismatches on
    // Ratio (wire 2.22 / shot 3.000) and Look-Ahead (wire 4.33 ms / shot
    // 2.000 ms) — founder noted screenshot was for label confirmation,
    // not exact final-value sync; cache shapes + label position keep
    // registration unambiguous. Closes  (0x0017 = emphasis at
    // cache c=20 fine knob 0..20; 0x0029 = drive at cache c=10
    // knob_0_10).
    17: { name: 'sidechain_low_cut', unit: 'hz', displayMin: 20, displayMax: 2000 },
    21: { name: 'look_ahead_time', unit: 'ms', displayMin: 0, displayMax: 2 },
    23: { name: 'emphasis', unit: 'knob_0_20', displayMin: 0, displayMax: 20 },
    26: { name: 'sidechain_high_cut', unit: 'hz', displayMin: 200, displayMax: 20000 },
    27: { name: 'sidechain_gain', unit: 'db', displayMin: -12, displayMax: 12 },
    28: { name: 'sidechain_frequency', unit: 'hz', displayMin: 100, displayMax: 10000 },
    // Q is a fractional 0.1..10 quality factor — `count` here is
    // structural (display = wire passthrough), not integer-only.
    29: { name: 'sidechain_q', unit: 'count', displayMin: 0.1, displayMax: 10 },
    39: { name: 'sidechain_emphasis_freq', unit: 'hz', displayMin: 100, displayMax: 10000 },
    41: 'drive',
    //  cont (2026-05-17): COMP ratio_compansion at id=36 is a
    // ratio (1..10:1), not dB. Cache-c=1 default to 'db' was wrong.
    36: { name: 'ratio_compansion', unit: 'ratio', displayMin: 1, displayMax: 10 },
  },
  geq: {
    1: 'mix',
    2: BALANCE,
    20: 'type',
    // 2026-04-29: GEQ Expert-Edit page on
    // 10 Band Variable Q from session-40-geq-expert.pcapng. 10 bands
    // (cache ids 10-19), all bipolar dB ±12, plus Master Q (id 21).
    // ** audit ( cont, 2026-04-29):** added Level
    // (hand-authored in params.ts because pidHigh=0x0000 has no cache
    // record at id=0 across blocks) and Bypass Mode (hand-authored enum).
    10: { name: 'band_1', unit: 'db', displayMin: -12, displayMax: 12 },
    11: { name: 'band_2', unit: 'db', displayMin: -12, displayMax: 12 },
    12: { name: 'band_3', unit: 'db', displayMin: -12, displayMax: 12 },
    13: { name: 'band_4', unit: 'db', displayMin: -12, displayMax: 12 },
    14: { name: 'band_5', unit: 'db', displayMin: -12, displayMax: 12 },
    15: { name: 'band_6', unit: 'db', displayMin: -12, displayMax: 12 },
    16: { name: 'band_7', unit: 'db', displayMin: -12, displayMax: 12 },
    17: { name: 'band_8', unit: 'db', displayMin: -12, displayMax: 12 },
    18: { name: 'band_9', unit: 'db', displayMin: -12, displayMax: 12 },
    19: { name: 'band_10', unit: 'db', displayMin: -12, displayMax: 12 },
    21: { name: 'master_q', unit: 'count', displayMin: 0.1, displayMax: 10 },
  },
  filter: {
    1: 'mix',
    2: BALANCE,
    10: 'type',
    // Blocks Guide §Filter: Frequency is the filter cutoff (20..20000 Hz
    // at cache-c=1 raw). Universal control for every filter type.
    // Renamed 2026-07-15 to the UI-label-audit name already used by the
    // hand-authored entry (BK-106 double-registration scan); the old freq
    // name aliases in PARAM_ALIASES.
    11: { name: 'frequency', unit: 'hz' },
    // 2026-04-25: Low/High cut on the
    // filter Config page — `session-32-filter-extended.pcapng`. Cache
    // c=1 raw Hz; needs the 'hz' override since the generator default
    // for c=1 is 'db'. Wire-verified at 100 Hz / 1800 Hz.
    18: { name: 'low_cut', unit: 'hz', displayMin: 20, displayMax: 2000 },
    19: { name: 'high_cut', unit: 'hz', displayMin: 200, displayMax: 20000 },
    // 2026-04-26: All-Pass filter Config-page
    // residuals — `session-33-filter-extended.pcapng`. Wire-verified
    // at +13% / 4 poles on an All-Pass filter. Feedback's cache
    // signature (a=-1, b=1, c=100) requires the bipolar_percent
    // override since the generator default for c=100 is plain
    // percent. Order is a raw integer (cache c=1 a=1 b=12) — needs
    // 'count' override since c=1 default is 'db'.
    21: { name: 'feedback', unit: 'bipolar_percent', displayMin: -100, displayMax: 100 },
    28: { name: 'order', unit: 'count', displayMin: 1, displayMax: 12 },
    // 2026-05-04: cache id=33 (FILTER_SENS, "Sensitivity") has
    // a=0.1, b=40, c=10, typecode=80 (log10). The generator's c=10
    // default forces displayMin=0, displayMax=10 (knob_0_10). With
    // displayMin=0, the runtime decode falls back to LINEAR even when
    // typecode 80 wants log10 — yielding the inverted-taper bug 
    // observed (write 7 → display 3.25). Override with a positive
    // displayMin so log10 fires correctly. Only applies when
    // filter.type is Envelope Filter / Auto-Wah / Touch-Wah (per
    // type-applicability).
    33: { name: 'sensitivity', unit: 'count', displayMin: 0.1, displayMax: 40 },
    //  cont (2026-05-17): FILTER unit overrides. Same
    // cache-c=1 → 'db' correction. id=33 sensitivity already overridden
    // above per .
    12: { name: 'q', unit: 'count', displayMin: 0.1, displayMax: 10 },
    24: { name: 'rate', unit: 'hz', displayMin: 0.1, displayMax: 10 },
    26: { name: 'mod_frequency', unit: 'hz', displayMin: 20, displayMax: 20000 },
    31: { name: 'start_frequency', unit: 'hz', displayMin: 100, displayMax: 10000 },
    32: { name: 'stop_frequency', unit: 'hz', displayMin: 100, displayMax: 10000 },
  },
  tremolo: {
    1: 'mix',
    2: BALANCE,
    10: 'type',
    // Blocks Guide §Tremolo: Rate sets the modulation speed (0.2..20 Hz
    // at cache-c=1 raw). Depth is a percent knob.
    12: { name: 'rate', unit: 'hz', displayMin: 0.2 },
    13: 'depth',
    //  cont (2026-05-17): TREMOLO unit override — crossover
    // freq is Hz not dB (cache-c=1 default).
    21: { name: 'crossover_freq', unit: 'hz', displayMin: 200, displayMax: 2000 },
  },
  enhancer: {
    1: 'mix',
    2: BALANCE,
    // 2026-04-29: Config-page knobs from
    // session-33-enhancer-extended.pcapng + paired screenshot. Wire-
    // verified at width=33% / depth=11% / low_cut=22.2 Hz /
    // high_cut=6500 Hz on a Modern enhancer. Width + Depth follow the
    // generator's c=100 → percent default; Low/High Cut need the 'hz'
    // override since cache c=1 default is dB. enhancer.level is out-of-
    // band hand-authored in params.ts (pidHigh=0x0000, no cache record).
    10: 'width',
    11: 'depth',
    12: { name: 'low_cut', unit: 'hz', displayMin: 20, displayMax: 2000 },
    13: { name: 'high_cut', unit: 'hz', displayMin: 200, displayMax: 20000 },
    // AM4-Edit labels this "Mode" but we keep `type` for cross-block consistency.
    14: 'type',
  },
  gate: {
    2: BALANCE,
    // 2026-04-26: slot-Gate Config-page knobs on
    // Modern Gate type — `session-34-slotgate-extended.pcapng`.
    // Threshold/Attack/Hold/Release/Attenuation are dB and ms knobs
    // with cache c=1 (raw dB, signed) and c=1000 (ms) signatures
    // respectively. Sidechain enum (cache id=15) is hand-authored
    // in params.ts since the generator only handles one enum import
    // per block (used for `type` at id=19).
    10: { name: 'threshold', unit: 'db', displayMin: -100, displayMax: 0 },
    11: { name: 'attack', unit: 'ms', displayMin: 0, displayMax: 1000 },
    12: { name: 'hold', unit: 'ms', displayMin: 0, displayMax: 1000 },
    13: { name: 'release', unit: 'ms', displayMin: 0, displayMax: 1000 },
    19: 'type',
    20: { name: 'attenuation', unit: 'db', displayMin: -80, displayMax: 0 },
  },
  volpan: {
    2: BALANCE,
    // The Volume-vs-Auto-Swell selector. Registered as `volpan.mode` in
    // KNOWN_PARAMS for historical reasons — keep the name stable.
    15: 'mode',
    // 2026-04-25: Auto-Swell envelope params
    // on the Volume/Pan Config page — `session-32-volpan-extended.pcapng`.
    // Threshold (id=16, dB) wire-verified at -20 dB; Attack (id=17, ms)
    // wire-verified at 300 ms. Cache c=1 for threshold (raw dB, needs
    // 'db' override since generator default is also 'db' but we set the
    // range explicitly). Cache c=1000 for attack means generator picks
    // 'ms' automatically — no override needed except the display range.
    16: { name: 'threshold', unit: 'db', displayMin: -100, displayMax: 0 },
    17: { name: 'attack', unit: 'ms', displayMin: 1, displayMax: 5000 },
  },
} as const;
