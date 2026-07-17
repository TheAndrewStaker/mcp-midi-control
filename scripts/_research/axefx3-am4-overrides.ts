/**
 * Axe-Fx III ⇆ AM4 calibration overrides.
 *
 * This module powers the III catalog generator's ability to port
 * hardware-verified display calibrations (`unit`, `displayMin`,
 * `displayMax`, `scaling`) from AM4 → III for cross-family parameters
 * that share semantics across the two devices.
 *
 * Why this is sound. The AM4 (model byte 0x15) and the Axe-Fx III
 * (model byte 0x10) are different binaries with different paramId
 * orderings inside each effect family, but both use the same Fractal
 * naming convention for parameters. Where AM4 has `reverb.time`
 * `unit: 'seconds'` `displayMin: 0.1` `displayMax: 100` at
 * `pidHigh=0x000b`, the III has `REVERB.REVERB_TIME` at `paramId=1`.
 * The wire address differs, the wire value scale (16-bit, packed
 * across three septets) differs, BUT the user-facing display
 * convention is governed by Fractal's design language and the same
 * audio-engineering reality (reverb time IS a 0.1..100 s knob on
 * both devices because that's the musically useful range).
 *
 * Sanity caveats:
 *
 * 1. **Join is by SYMBOL NAME, not paramId.** AM4-Edit's binary and
 *    AxeEdit III's binary number paramIds differently inside each
 *    family. `DISTORT_DRIVE` is paramId=1 on the III but paramId=11
 *    on the AM4. Joining by `(family, paramId)` would map AM4's
 *    `amp.gain` (knob_0_10) onto whatever the III happens to have at
 *    paramId 11 — which is `DISTORT_WSLPF`, a wave-shaper LPF that
 *    is most definitely not a 0..10 knob. So we join by the symbolic
 *    name suffix only.
 *
 * 2. **Enum value tables do NOT port.** AM4's `reverb.type` enum has
 *    79 values; III's REVERB_TYPE has more (the III ships dozens of
 *    extra reverb algorithms added post-AM4). We deliberately drop
 *    `enumValues` in the port and emit unit='enum' WITHOUT a value
 *    table — that signals "this paramId is an enum, but the menu
 *    is III-firmware-defined and needs III-side capture to enumerate."
 *
 * 3. **One AM4 family can map to multiple AM4 blocks.** AM4's DISTORT
 *    family is addressable as both `amp` and `drive` blocks (per the
 *    AM4 generator's FAMILY_TO_BLOCKS table). For calibration porting
 *    we only need ONE AM4 entry to copy unit + range from — both
 *    blocks share the catalog, so we walk the candidate blocks in
 *    order and take the first hit. Ties don't matter; the metadata
 *    is identical across blocks of the same family.
 *
 * 4. **Output is documentary, not executable.** The III's `0x02
 *    SET_PARAMETER` tool surface still accepts raw 16-bit wire values
 *    from the caller — these ported display ranges are surfaced for
 *    the agent to reason about ("this is a 0..10 knob"), not to drive
 *    display↔wire conversion. Display↔wire still requires III
 *    hardware verification, because the III's wire scaling for any
 *    given knob isn't published. When III hardware verification lands,
 *    the calibrated entries flip from "inferred from AM4" → "verified
 *    on III".
 *
 * 5. **Idempotent.** This module is pure: same AM4 source ⇒ same
 *    override table ⇒ same generator output. Re-running the
 *    generator without source changes produces a byte-stable file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const AM4_CACHE_PARAMS_PATH = join(
  REPO_ROOT,
  'packages',
  'fractal-midi',
  'src',
  'am4',
  'cacheParams.ts',
);
// AM4's hand-authored `params.ts` carries the entries that don't live
// in the cache (channel/level/bypass/tempo/pan + several enum overrides
// the cache-generator can't emit cleanly). Those entries share the same
// schema shape and same hardware-verified calibration as cacheParams.ts
// — including them roughly doubles the III's calibration coverage,
// because most of the III's per-family `LEVEL`/`PAN`/`TEMPO`/`BYPASS`
// suffixes have AM4 analogs only in params.ts, not cacheParams.ts.
//
// Both sources are parsed by the same regex (their entry shape is
// identical by design — see `gen-params-from-cache.ts`). When the
// same `block.name` appears in both, cacheParams.ts wins (it's the
// generator-truth, while params.ts may carry hand-tweaked display
// overrides we'd rather not propagate to the III).
const AM4_PARAMS_PATH = join(
  REPO_ROOT,
  'packages',
  'fractal-midi',
  'src',
  'am4',
  'params.ts',
);

// ── Family ↔ AM4 block mapping ─────────────────────────────────────
//
// Mirrors the table in `generate-am4-params-from-catalog.ts` — kept
// in this file too because we walk the III's family symbols (taken
// from its own Ghidra mining) rather than AM4-Edit's. Families that
// AM4 doesn't have (CABINET, PEQ instances ≠ AM4's, FUZZ, NAM,
// etc.) simply produce no overrides — they stay 'unverified'.

export const FAMILY_TO_AM4_BLOCKS: Readonly<Record<string, readonly string[]>> = {
  REVERB: ['reverb'],
  DELAY: ['delay'],
  CHORUS: ['chorus'],
  FLANGER: ['flanger'],
  PHASER: ['phaser'],
  ROTARY: ['rotary'],
  TREMOLO: ['tremolo'],
  WAH: ['wah'],
  FILTER: ['filter'],
  // DISTORT covers both AM4 amp AND drive blocks — Ghidra shows both
  // pidLows (0x003a, 0x0076) dispatch into the same param table.
  // Order matters slightly for ties (we take the first hit), but the
  // metadata is identical across the two blocks.
  DISTORT: ['amp', 'drive'],
  COMP: ['compressor'],
  GEQ: ['geq'],
  PEQ: ['peq'],
  GATE: ['gate'],
  ENHANCER: ['enhancer'],
  VOLUME: ['volpan'],
};

// ── Hand-curated cross-family overrides ────────────────────────────
//
// Maps III SCREAMING_SNAKE symbol → AM4 `block.name` key, bypassing
// the FAMILY_TO_AM4_BLOCKS restriction. Each entry is for a case where
// the III family borrows a coherent subset from an AM4 block that
// FAMILY_TO_AM4_BLOCKS deliberately doesn't join (because the broader
// family overlap would produce false positives).
//
// Why not widen FAMILY_TO_AM4_BLOCKS instead?
//   CABINET → ['amp'] would auto-join 126 III CABINET paramIds to
//   AM4's 167 amp entries by name, surfacing the 4 right DynaCab
//   matches AND 15-30 false positives (e.g. III's CABINET_LEVEL is a
//   0..100 numeric mix; AM4's amp.level is -80..20 dB — same name,
//   wrong calibration). A per-symbol whitelist is auditable at commit
//   time without a per-generation review treadmill.
//
// Adding an entry:
//   1. Confirm the III paramId and AM4 entry name refer to the same
//      musical concept on both products (read both XMLs / manual).
//   2. Add the row with a one-line rationale comment.
//   3. Re-run the III catalog generator and inspect the diff —
//      exactly one row should flip from unverified → calibrated.
//
// Inventory + rationale: `docs/_private/axefx3-unverified-audit-2026-05-18.md`.
export const EXPLICIT_III_TO_AM4: Readonly<Record<string, string>> = {
  // DynaCab IR-type and mic selectors. AM4 hosts the canonical
  // DynaCab catalog under its `amp` block (per AM4 manual p. 25);
  // III's CABINET family reuses the same enumeration. Range 0..31,
  // count semantics.
  CABINET_DYNACAB_TYPE1: 'amp.dynacab_1_cab',
  CABINET_DYNACAB_TYPE2: 'amp.dynacab_2_cab',
  CABINET_DYNACAB_MIC1: 'amp.dynacab_1_mic',
  CABINET_DYNACAB_MIC2: 'amp.dynacab_2_mic',
  // Drive clip-type selector. DISTORT_CLIPTYPE1 already auto-joins
  // via FAMILY_TO_AM4_BLOCKS[DISTORT] → drive.clip_type; the `2`
  // instance suffix breaks the auto-join name, so we land it
  // explicitly. Same 14-value enum on both products.
  DISTORT_CLIPTYPE2: 'drive.clip_type',
};

// ── III suffix ↔ AM4 name aliases ──────────────────────────────────
//
// Mirrors `generate-am4-params-from-catalog.ts`'s NAMING_ALIAS table.
// Maps an SCREAMING_SNAKE suffix (post family-prefix strip) to AM4's
// snake_case convention. Suffixes not in the map fall through to plain
// `toLowerCase()`.

const III_SUFFIX_ALIAS: Readonly<Record<string, string>> = {
  // Frequency knobs — III uses HICUT/LOWCUT, AM4 uses high_cut/low_cut.
  HICUT: 'high_cut',
  LOWCUT: 'low_cut',
  // DELAY uses LOCUT (no 'W') alongside LOWCUT on some III firmware
  // revisions; both resolve to AM4's `low_cut`.
  LOCUT: 'low_cut',
  // Compressor — III's `THRESH` ↔ AM4's `threshold`. Common abbreviation
  // mismatch; the AM4 generator's NAMING_ALIAS doesn't carry it because
  // AM4-Edit's own catalog symbols use `THRESH` too, but the AM4
  // params.ts hand-overrides expanded it to `threshold` for readability.
  THRESH: 'threshold',
  // Sidechain frequency knobs on the compressor.
  SCFREQ: 'sidechain_frequency',
  SCGAIN: 'sidechain_gain',
  SCQ: 'sidechain_q',
  SCHIGHCUT: 'sidechain_high_cut',
  SCLOWCUT: 'sidechain_low_cut',
  // Reverb late/early/HF/LF knob aliases. Several of these target AM4
  // entries that don't currently exist (e.g. `hf_ratio`, `lf_time`,
  // `early_send`); they're documented here for future AM4-side
  // expansion. The override loader silently no-ops on missing targets.
  HFRATIO: 'hf_ratio',
  LFTIME: 'lf_time',
  LFXOVER: 'lf_xover',
  // AM4 ships `pre_delay`; the cache catalog name is `pre_delay`. The
  // previous alias target `predelay` was a misread — AM4 has no entry
  // by that exact spelling.
  PREDELAY: 'pre_delay',
  NUMSPRINGS: 'springs',
  INPDIFF: 'input_diffusion',
  INDIFFTIME: 'input_diff_time',
  EARLYLEVEL: 'early_level',
  EARLYDIFF: 'early_diffusion',
  EARLYDIFFTIME: 'early_diff_time',
  EARLYDECAY: 'early_decay',
  EARLYSEND: 'early_send',
  LATELEVEL: 'late_level',
  LATEINPUTMIX: 'late_input_mix',
  HIGHDECAY: 'high_decay',
  LOWDECAY: 'low_decay',
  XOVERFREQ: 'xover_frequency',
  RELEASETIME: 'release_time',
  ECHOMIX: 'echo_mix',
  PICKUPSPACING: 'pickup_spacing',
  SPRINGTONE: 'spring_tone',
  DIFFUSIONTIME: 'diffusion_time',
  PITCHFEEDBACK: 'pitch_feedback',
  PITCHMODULATION: 'pitch_modulation',
  PITCHHIGHCUT: 'pitch_high_cut',
  VOICEBALANCE: 'voice_balance',
  SPLICETIME: 'splice_time',
  LOWCUTQ: 'low_cut_q',
  HIGHCUTQ: 'high_cut_q',
  LFOPHASE: 'lfo_phase',
  // III firmware exposes a `REVERB_LFOPHASE` (mod LFO phase) alongside
  // AM4's `lfo_phase_pct` (chorus stage). Different blocks, same
  // alias safely targets the AM4 reverb entry.
  REVERBLEVEL: 'reverb_level',
  // AM4's cacheParams ships `reverb.reverbdelay` (no underscore). The
  // previous alias `reverb_delay` was a misread.
  REVERBDELAY: 'reverbdelay',
  INPUTSELECT: 'input_select',
  // Session 95: AM4 REVERB renamed `low_slope` → `low_cut_slope` and
  // `high_slope` → `high_cut_slope` to match the AM4-Edit XML labels.
  // FAMILY_TO_AM4_BLOCKS only maps REVERB → ['reverb'], so this alias
  // affects only the III's REVERB family lookup (where AM4 reverb hosts
  // the canonical calibration); CABINET is not joined here.
  LOWSLOPE: 'low_cut_slope',
  HIGHSLOPE: 'high_cut_slope',
  // AM4's cache symbols are `basetype` / `tonetype` (one word). The
  // previous aliases `base_type` / `tone_type` didn't match anything.
  BASETYPE: 'basetype',
  TONETYPE: 'tonetype',
  SHIFT1: 'voice_1_shift',
  SHIFT2: 'voice_2_shift',
  SPRINGTYPE: 'spring_type',
  PREDLYTAP: 'predly_tap',
  PREDLYTEMPO: 'predly_tempo',
  PREDLYFDBK: 'predly_fdbk',
  PREDLYMIX: 'predly_mix',
  PITCHLPF: 'pitch_lpf',
  PITCHMIX: 'pitch_mix',
  PITCHFDBK: 'pitch_fdbk',
  // Session 95: AM4 REVERB renamed `pitch_dir` → `pitch_direction` and
  // `pitch_pos` → `pitch_position` to spell out the AM4-Edit XML labels.
  PITCHDIR: 'pitch_direction',
  PITCHTIME: 'pitch_time',
  PITCHPOS: 'pitch_position',
  PITCHMOD: 'pitch_mod',
  PITCHBAL: 'pitch_bal',
  FEEDR: 'feed_r',
  FEEDL: 'feed_l',
  FEEDLR: 'feed_lr',
  FEEDRL: 'feed_rl',
  MSTRFDBK: 'master_feedback',
  MSTRTIME: 'master_time',
  TEMPOR: 'tempo_r',
  TEMPOL: 'tempo_l',
  PANL: 'pan_l',
  PANR: 'pan_r',
  LOWQ: 'low_q',
  HIGHQ: 'high_q',
  // ── Indexed parameter aliases ────────────────────────────────────
  // AM4 numbers indexed params with an underscore (`gain_1`, `q_2`,
  // `frequency_1`); III concatenates (`GAIN1`, `Q2`, `FREQ1`). The
  // explicit alias rows below keep the join straightforward — without
  // them, plain lowercase produces `gain1`/`q2`/`freq1` which don't
  // match any AM4 entry.
  GAIN1: 'gain_1',
  GAIN2: 'gain_2',
  // GAIN3..5 / FREQ3..5 / Q3..5 have AM4 analogs only inside the PEQ
  // block under the `channel_N_*` naming convention. Aliasing the
  // generic suffix to `gain_3` here would silently misroute the GEQ
  // family (which uses `band_N` instead). Skipped — the III's PEQ
  // entries stay `unverified` until we add family-aware aliasing.
  FREQ1: 'frequency_1',
  FREQ2: 'frequency_2',
  Q1: 'q_1',
  Q2: 'q_2',
  // ── Compound-word suffix aliases ─────────────────────────────────
  // III concatenates these as SCREAMING_RUN-ON, AM4 uses snake_case.
  // Every entry here was verified against the actual AM4 source —
  // dead aliases are kept above (HF*/LF*/EARLY_SEND/PREDLY_*/etc.) as
  // documented future-readiness rather than mixed in here.
  LFOTYPE: 'lfo_type',
  DELAYTIME: 'delay_time',
  KILLDRY: 'kill_dry',
  GAINMONITOR: 'gain_monitor',
  PHASEREV: 'phase_reverse',
  MODPHASE: 'mod_phase',
  AUTODEPTH: 'auto_depth',
  // Chorus stereo-image suffixes. III uses single-letter L/C/R on
  // DEPTH; AM4 spells them out.
  DEPTHL: 'left_depth',
  DEPTHC: 'center_depth',
  DEPTHR: 'right_depth',
  VOICES: 'number_of_voices',
  STEREOSPREAD: 'stereo_spread',
  // Flanger time-range knobs. AM4 names them `min_time`/`max_time`.
  TMIN: 'min_time',
  TMAX: 'max_time',
  // Flanger dry-delay knob (AM4 spells with underscore).
  DRYDELAY: 'dry_delay',
  // Delay compander/feedback compound names.
  BITREDUCE: 'bit_reduction',
  HOLDFDBK: 'hold_feedback',
  STACKFDBK: 'stack_feedback',
  LEVELL: 'level_l',
  LEVELR: 'level_r',
  // ── Cross-block generic-param aliases ────────────────────────────
  // The III concatenates these into one screaming-snake suffix; AM4
  // exposes them per-block under snake_case names. Each alias listed
  // here is verified present in AM4 for at least one block — the
  // findAm4Override walk over FAMILY_TO_AM4_BLOCKS will pick up the
  // hit for whichever block the III family resolves to. Suffixes
  // AM4 doesn't expose at all (BYPASS, GLOBALMIX, SCENEIGNORE) are
  // deliberately omitted — would resolve to nothing and stay
  // 'unverified' regardless of alias.
  BYPASSMODE: 'bypass_mode',
  // ── DISTORT-family AM4 amp-section aliases ───────────────────────
  // The III's DISTORT family covers both AMP and DRIVE blocks. Most
  // of the AMP tone-shaping knobs the III concatenates are present on
  // AM4 under snake_case names, just with `_` separators the III
  // omits. Each alias verified by name-grep in AM4 packages/am4/src/
  // params.ts. Where the III's name doesn't map cleanly (e.g.
  // WSLPF = wave-shaper LPF; XFHPF/XFLPF = transformer HPF/LPF), no
  // alias is added because the AM4 entry doesn't exist.
  BRIGHTCAP: 'bright_cap',
  SUPPLYSAG: 'supply_sag',
  PRESFREQ: 'presence_freq',
  PREAMPBIAS: 'preamp_bias',
  GRIDBIAS: 'grid_bias',
  DEPTHFREQ: 'depth_freq',
  SPKRDRIVE: 'spkr_drive',
  SPKRCOMP: 'spkr_compression',
  SPKRIMPED: 'speaker_impedance',
};

/**
 * Convert a full Ghidra III symbol like `REVERB_TIME` or
 * `DISTORT_PRESENCE` into the AM4 convention name (`time`,
 * `presence`). Strips the first underscore-delimited segment as the
 * family prefix, then applies the alias table (with a lowercase
 * fallback for unaliased suffixes).
 */
export function iiiSymbolToAm4Name(iiiSymbol: string): string {
  const u = iiiSymbol.indexOf('_');
  if (u < 0) return iiiSymbol.toLowerCase();
  const tail = iiiSymbol.substring(u + 1);
  if (III_SUFFIX_ALIAS[tail]) return III_SUFFIX_ALIAS[tail];
  return tail.toLowerCase();
}

// ── AM4 cacheParams parser ─────────────────────────────────────────

export interface Am4Override {
  block: string;
  name: string;
  unit: string;
  /**
   * Display range. Always populated for `'am4'` and `'universal'`
   * sources; absent for `'xml'`-only matches because XML mining
   * recovers parameterName + displayLabel + controlType but not the
   * knob's numeric bounds.
   */
  displayMin?: number;
  displayMax?: number;
  scaling?: 'linear' | 'log10';
  /**
   * True if AM4's entry was an enum (`unit: 'enum'` + `enumValues: …`).
   * The III generator emits `unit: 'enum'` for these but deliberately
   * drops the enumValues table — III's enum vocabularies differ from
   * AM4's (post-AM4 firmware adds reverb types, amp models, etc.),
   * and shipping AM4's values for an III enum would be misleading.
   */
  enum: boolean;
  /**
   * Provenance of the calibration. `'am4'` means we joined directly
   * to an AM4 entry by symbol name (the Session 88 approach — uses
   * AM4's hardware-verified unit/range). `'universal'` means we filled
   * the calibration from a Fractal-wide naming convention (every
   * `*_BYPASS` is enum, every `*_PAN` is bipolar_percent -100..100,
   * etc.) without a direct AM4 entry — used for the III families AM4
   * doesn't carry (PITCH, GLOBAL, CONTROLLERS, …) and for cross-block
   * generic params AM4 doesn't ship at pidHigh ≥ 10. `'xml'` means
   * the unit was inferred from the AxeEdit III JUCE-BinaryData
   * controlType (dropdown→enum, knob→numeric, etc.) — see
   * [[reference_axeedit3_xml_labels]] for the mining artifact. XML-
   * source overrides are weakest (no range), but still useful: the
   * enum-vs-numeric distinction alone steers the LLM agent away from
   * passing a number to a dropdown-shaped knob.
   *
   * The generator emits different trailing comments per source so the
   * file's audit trail stays separable.
   */
  source: 'am4' | 'universal' | 'xml';
  /**
   * Display label from the AxeEdit III XML mining (the human-readable
   * knob name shown in the editor — e.g. `'Drive'` for `DISTORT_DRIVE`).
   * Populated for any entry whose name appears in
   * `axeedit3-xml-labels.json`, regardless of which calibration source
   * (AM4 / universal / XML) supplied the unit + range. Useful as a
   * prompt-context hint to the LLM agent independent of calibration.
   */
  displayLabel?: string;
}

/**
 * Parse one AM4 source file (cacheParams.ts or params.ts) for entries
 * shaped `'block.name': { block, name, pidLow, pidHigh, unit,
 * displayMin, displayMax, [scaling], [enumValues] }`. Both files
 * share the schema by design — `gen-params-from-cache.ts` owns
 * cacheParams.ts, and the hand-authored params.ts entries the
 * cache-generator can't produce (channel/level/bypass/tempo/pan +
 * several enum overrides) match the same shape.
 *
 * Parses by regex against the literal entry text — no TS compiler /
 * AST walk. The cacheParams generator owns the format; params.ts
 * follows the same shape by convention. If either file changes, the
 * generator below emits fewer / zero overrides and the regression is
 * loud (the III file's `inferred from AM4` count drops).
 *
 * The regex tolerates extra trailing fields (`displayLabel`,
 * `displayUnit`, `enumValues`) between `displayMax` and the closing
 * brace, which is needed for params.ts entries that the cache file
 * doesn't carry.
 */
function loadOverridesFromFile(path: string): Map<string, Am4Override> {
  const src = readFileSync(path, 'utf8');

  const result = new Map<string, Am4Override>();

  // Entry shape:
  //   'amp.gain': {
  //     block: 'amp', name: 'gain',
  //     pidLow: 0x003a, pidHigh: 0x000b,
  //     unit: 'knob_0_10', displayMin: 0, displayMax: 10,
  //     [optional `scaling: 'log10',`]
  //     [optional `enumValues: AMP_TYPES_VALUES,`]
  //     [optional `displayLabel: 'Gain',`]
  //   },
  //
  // We capture block/name/unit/displayMin/displayMax/scaling/has-enum.
  // The `[\s\S]*?` between sections allows params.ts entries that
  // interleave optional fields (e.g. `displayLabel: 'Tempo',`) between
  // the name and pidLow lines.
  const entryRe = new RegExp(
    [
      // header line - 'amp.gain': {
      String.raw`'(?<key>[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)':\s*\{`,
      // block + name line. Non-greedy gap allows leading-line comments
      // and other fields between the header and the block declaration
      // (some params.ts entries put `displayLabel` first).
      String.raw`[\s\S]*?block:\s*'(?<block>[a-z][a-z0-9_]*)',\s*name:\s*'(?<name>[a-z][a-z0-9_]*)',`,
      // pidLow + pidHigh line. Non-greedy gap tolerates an interleaved
      // `displayLabel: 'Foo',` etc.
      String.raw`[\s\S]*?pidLow:\s*0x[0-9a-fA-F]+,\s*pidHigh:\s*0x[0-9a-fA-F]+,`,
      // unit + displayMin + displayMax line. unit names mix lowercase
      // letters + digits + underscores (e.g. `knob_0_10`). displayMin/
      // Max can be negative or fractional, so capture as a signed
      // numeric. The trailing comma after `displayMax: N` is optional —
      // single-line entries (e.g. all AM4 `geq_band_*` rows) close the
      // brace on the same line with `displayMax: 12 }` and no comma,
      // while multi-line entries (`scaling:` continuation) keep the
      // comma. Both shapes must match.
      String.raw`[\s\S]*?unit:\s*'(?<unit>[a-z][a-z0-9_]*)',\s*displayMin:\s*(?<displayMin>-?\d+(?:\.\d+)?),\s*displayMax:\s*(?<displayMax>-?\d+(?:\.\d+)?),?`,
      // Optional remainder before the closing brace. Captures
      // `scaling: 'log10'` if present, and a marker for `enumValues:`.
      String.raw`(?<tail>[\s\S]*?)\}`,
    ].join(''),
    'g',
  );

  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(src)) !== null) {
    const g = m.groups as Record<string, string>;
    const tail = g.tail ?? '';
    const scalingMatch = /scaling:\s*'(log10|linear)'/.exec(tail);
    const hasEnumValues = /enumValues:\s*[A-Za-z_][A-Za-z0-9_]*/.test(tail);

    const override: Am4Override = {
      block: g.block,
      name: g.name,
      unit: g.unit,
      displayMin: Number(g.displayMin),
      displayMax: Number(g.displayMax),
      enum: g.unit === 'enum' || hasEnumValues,
      source: 'am4',
    };
    if (scalingMatch) {
      override.scaling = scalingMatch[1] as 'linear' | 'log10';
    }
    result.set(`${g.block}.${g.name}`, override);
  }

  return result;
}

/**
 * Merge AM4 overrides from `cacheParams.ts` (the generator-truth) and
 * `params.ts` (hand-authored entries the generator can't emit —
 * channel/level/bypass/tempo/pan + various enum overrides).
 *
 * Conflict policy: `cacheParams.ts` wins. The cacheParams generator
 * derives display ranges from the binary metadata cache; that's the
 * harder-to-fudge source. `params.ts` may carry hand-tweaked display
 * overrides (e.g. `displayUnit: ''` cosmetic suppression on
 * `negative_feedback`) that we wouldn't want to propagate to the III.
 *
 * Why merge at all (vs. just using cacheParams.ts): a large fraction of
 * the III's per-family `LEVEL`/`PAN`/`TEMPO`/`BYPASS`/`MODE`/`WIDTH`
 * suffixes correspond to AM4 pidHigh 0..9 generic-params that don't
 * live in the cache file (see the cacheParams.ts header comment). Those
 * AM4 entries are hand-authored in `params.ts`. Pulling from both
 * sources roughly triples the III's calibration coverage (Session 88
 * — went from 116 → ~200 inferred entries via this loader change).
 */
export function loadAm4ParamOverrides(): Map<string, Am4Override> {
  const cache = loadOverridesFromFile(AM4_CACHE_PARAMS_PATH);
  const hand = loadOverridesFromFile(AM4_PARAMS_PATH);

  const merged = new Map<string, Am4Override>(cache);
  for (const [k, v] of hand) {
    if (!merged.has(k)) merged.set(k, v);
  }
  return merged;
}

// ── AxeEdit III JUCE-BinaryData XML labels ─────────────────────────
//
// Parallel-agent Session 93 cont (2026-05-17) mined the III's JUCE
// BinaryData XML files (`__block_layout.xml`, `__amp_layout.xml`,
// per-firmware amp-layout variants) into a flat JSON catalog at
// `samples/captured/decoded/axeedit3-xml-labels.json` — 2,017 unique
// parameterName entries with displayLabel + controlType. ~90% of the
// 2,216-paramId III Ghidra catalog has an XML match by name. See
// `scripts/_research/mine-axeedit3-xml-labels.ts` for the miner and
// [[reference_axeedit3_xml_labels]] for context.
//
// Two consumption paths in this module:
//
//   1. `displayLabel` overlay (lossless). When an XML entry exists for
//      the III symbol, its `displayLabel` is attached to whatever
//      calibration source ultimately wins (AM4 / universal / XML).
//      Independent of unit + range — the label is just the editor's
//      knob caption, useful as LLM prompt context.
//
//   2. controlType → unit inference (3rd-tier fallback). When AM4
//      and universal-convention both miss, the XML controlType is
//      mapped to a coarse unit (dropdown* / btn* / toggle* → `'enum'`,
//      knob* / slider* / readout numeric → `'numeric'`, etc.). The
//      enum-vs-numeric distinction alone is high-value for the agent:
//      a `unit: 'enum'` tells it to suggest a categorical value, not
//      a number.

interface XmlLabelEntry {
  parameterName: string;
  displayLabel: string;
  controlType: string;
}

export interface XmlLabel {
  displayLabel: string;
  controlType: string;
}

const XML_LABELS_PATH = join(
  REPO_ROOT,
  'samples',
  'captured',
  'decoded',
  'axeedit3-xml-labels.json',
);

/**
 * Load the AxeEdit III XML-mined parameterName → label/controlType
 * catalog. Returns an empty map if the file is absent (the JSON lives
 * under `samples/` which is gitignored — fresh worktrees may not have
 * it, in which case the generator falls back to AM4 + universal
 * sources only). Caller can detect "XML disabled" via `map.size === 0`.
 */
export function loadXmlLabels(): Map<string, XmlLabel> {
  if (!existsSync(XML_LABELS_PATH)) return new Map();
  const raw = JSON.parse(readFileSync(XML_LABELS_PATH, 'utf8')) as XmlLabelEntry[];
  const m = new Map<string, XmlLabel>();
  for (const e of raw) {
    // Duplicate parameterName entries can occur when the miner aggregates
    // across multiple XML source files (one parameter may appear in
    // both __block_layout.xml and a per-firmware __amp_layout_v*.xml).
    // First-write-wins keeps the result deterministic.
    if (m.has(e.parameterName)) continue;
    m.set(e.parameterName, { displayLabel: e.displayLabel, controlType: e.controlType });
  }
  return m;
}

/**
 * Map an AxeEdit III XML controlType (the JUCE widget kind used to
 * render the param in the editor) to a coarse Fractal unit. The map
 * is intentionally limited to widget types whose unit semantics are
 * unambiguous — pure label / cab-bank picker / dynacab-control widgets
 * are omitted so they stay `unit: 'unverified'` rather than getting a
 * misleading inference.
 *
 * `enum` vs `numeric` is the only dimension XML can decide reliably
 * (range / scaling can't be recovered from controlType alone). The
 * resulting overrides emit without `displayMin`/`displayMax`.
 */
const XML_CONTROL_TYPE_TO_UNIT: Readonly<Record<string, { unit: string; enum: boolean }>> = {
  // ── Continuous numeric knobs / sliders ───────────────────────────
  // No range info — emit unit only. We use `'numeric'` (a new unit in
  // the III Unit union) to distinguish "we know this is a number" from
  // `'unverified'` (we know nothing).
  knob:                      { unit: 'numeric', enum: false },
  knobCompact:               { unit: 'numeric', enum: false },
  knobMini:                  { unit: 'numeric', enum: false },
  knobSmall:                 { unit: 'numeric', enum: false },
  knobMiniReadout:           { unit: 'numeric', enum: false },
  knobMiniReadout2:          { unit: 'numeric', enum: false },
  slider:                    { unit: 'numeric', enum: false },
  sliderMiniA:               { unit: 'numeric', enum: false },
  sliderMiniB:               { unit: 'numeric', enum: false },
  readoutValueFloat:         { unit: 'numeric', enum: false },
  readoutValueInt:           { unit: 'numeric', enum: false },
  readoutCabNumber:          { unit: 'numeric', enum: false },
  readoutCtrl8:              { unit: 'numeric', enum: false },
  // Meters are dB-scale display readouts on the III. They're read-only
  // in normal usage but appear in the catalog because some are
  // host-addressable for automation. Coarse `'db'` unit; specific
  // range not in XML.
  meterGainVert:             { unit: 'db',      enum: false },
  meterGainVertNoReadout:    { unit: 'db',      enum: false },
  meterGainVertShort:        { unit: 'db',      enum: false },
  meterGainHeadroom:         { unit: 'db',      enum: false },
  meterVuVert:               { unit: 'db',      enum: false },
  // ── Categorical (dropdown / toggle / button) ─────────────────────
  // Every dropdown* / btn* / toggle* maps to a small finite menu. We
  // emit `unit: 'enum'` so the agent treats it as categorical — no
  // enumValues table because XML doesn't expose the value vocabulary
  // (those live in the editor's binary code, not in the layout XML).
  dropdown1:                 { unit: 'enum',    enum: true  },
  dropdown1Tight:            { unit: 'enum',    enum: true  },
  dropdown1Tight1Line:       { unit: 'enum',    enum: true  },
  dropdown1TightXtra:        { unit: 'enum',    enum: true  },
  dropdown1LFO:              { unit: 'enum',    enum: true  },
  'dropdown1LFO-Off':        { unit: 'enum',    enum: true  },
  dropdown1mhz:              { unit: 'enum',    enum: true  },
  dropdown1p5:               { unit: 'enum',    enum: true  },
  dropdown1p5Tight:          { unit: 'enum',    enum: true  },
  dropdown1p5Tight1Line:     { unit: 'enum',    enum: true  },
  dropdown1p5ThinTight1Line: { unit: 'enum',    enum: true  },
  dropdown1p5Mini:           { unit: 'enum',    enum: true  },
  dropdownNoLabel:           { unit: 'enum',    enum: true  },
  dropdownMini:              { unit: 'enum',    enum: true  },
  dropdownMiniReadout:       { unit: 'enum',    enum: true  },
  dropdownThin1Line:         { unit: 'enum',    enum: true  },
  dropdownThin2Line:         { unit: 'enum',    enum: true  },
  dropdownCabBank:           { unit: 'enum',    enum: true  },
  dropdownCompact:           { unit: 'enum',    enum: true  },
  dropdownCompact3:          { unit: 'enum',    enum: true  },
  dropdownLeftLabel:         { unit: 'enum',    enum: true  },
  btnBypass:                 { unit: 'enum',    enum: true  },
  btnIgnoreScene:            { unit: 'enum',    enum: true  },
  btnKillDry:                { unit: 'enum',    enum: true  },
  btnRectangle:              { unit: 'enum',    enum: true  },
  btnRectangleLong:          { unit: 'enum',    enum: true  },
  btnSquare:                 { unit: 'enum',    enum: true  },
  btnSquareReverse:          { unit: 'enum',    enum: true  },
  toggle:                    { unit: 'enum',    enum: true  },
  toggleHorz:                { unit: 'enum',    enum: true  },
  toggleCompact:             { unit: 'enum',    enum: true  },
  'toggle-looper-once':      { unit: 'enum',    enum: true  },
  'toggle-looper-play':      { unit: 'enum',    enum: true  },
  'toggle-looper-overdub':   { unit: 'enum',    enum: true  },
  'toggle-looper-reverse':   { unit: 'enum',    enum: true  },
  'toggle-looper-undo':      { unit: 'enum',    enum: true  },
  // ── Intentionally omitted ────────────────────────────────────────
  // `label*` widgets are read-only captions/headings — not knobs.
  // `readoutNameShortRO` / `readoutNameLong` are string-valued name
  // displays. `dynaCabControl` / `readoutMidiBlock` are custom
  // composite widgets. We don't infer a unit for any of these — they
  // still pick up a `displayLabel` via the lossless overlay, but the
  // unit stays `'unverified'`.
};

function inferOverrideFromXml(
  iiiSymbolName: string,
  xmlLabels: Map<string, XmlLabel>,
): Am4Override | undefined {
  const xml = xmlLabels.get(iiiSymbolName);
  if (!xml) return undefined;
  const inference = XML_CONTROL_TYPE_TO_UNIT[xml.controlType];
  if (!inference) return undefined;
  return {
    block: '_xml',
    name: iiiSymbolName.toLowerCase(),
    unit: inference.unit,
    enum: inference.enum,
    source: 'xml',
    displayLabel: xml.displayLabel,
  };
}

// ── Universal Fractal-convention suffix fallbacks ──────────────────
//
// Some III symbol suffixes mean the same thing on every Fractal block,
// regardless of family. AM4 doesn't ship per-block entries for these
// (most live at pidHigh 0..9 generic-params that the catalog scope
// excludes), so the family-keyed AM4 join misses every time even
// though the calibration is well-known. Filling them in from
// convention is safe: the III's UI for these knobs follows the same
// design language as the AM4's, and ranges are bounded by
// audio-engineering reality (a pan knob is -100..100 percent because
// any other shape would be a UI design break).
//
// Each fallback fires AFTER the AM4-name lookup misses, so legitimate
// AM4 hits (e.g. `amp.pan` exists in AM4 — DISTORT_PAN still resolves
// through the AM4 path with its own verified range) take precedence.
//
// Entries here are conservative: only suffixes whose convention is
// stable across every Fractal block. `*_LEVEL` is deliberately NOT
// in this table — block output level is typically `db -80..20`, but
// `GLOBAL_USBLEVEL` / `GLOBAL_AESLEVEL` etc. use different ranges,
// and family-blind LEVEL fallback would mis-calibrate those.

const UNIVERSAL_SUFFIX_FALLBACKS: Readonly<Record<string, Omit<Am4Override, 'block' | 'name'>>> = {
  // Per-block bypass switch — universally an enum. AM4 has block
  // bypass at pidHigh 0..9 generic-params but doesn't expose it in
  // `params.ts` under a `<block>.bypass` key, so every III `*_BYPASS`
  // misses the AM4 join despite being conventionally OFF/ON.
  BYPASS:      { unit: 'enum',            displayMin: 0,    displayMax: 1,   enum: true,  source: 'universal' },
  // Bypass-mode selector (Thru / Mute FX Out / Mute Out / etc.). AM4
  // ships 11 of these and the `BYPASSMODE: 'bypass_mode'` alias
  // resolves them; this fallback covers the III families AM4 doesn't
  // share (PITCH, GLOBAL, MULTITAP, CONTROLLERS, …).
  BYPASSMODE:  { unit: 'enum',            displayMin: 0,    displayMax: 0,   enum: true,  source: 'universal' },
  // Stereo pan knob. AM4 only carries `amp.pan` (verified
  // bipolar_percent -100..100); this fallback covers every other
  // block's PAN, and indexed PAN1..PANn variants via the regex below.
  PAN:         { unit: 'bipolar_percent', displayMin: -100, displayMax: 100, enum: false, source: 'universal' },
  // Block-level Global Mix — what fraction of the block's wet output
  // mixes into the preset's global mix bus. III adds this per block;
  // AM4 doesn't expose the knob at all (its mix model is preset-level
  // only). Universally percent 0..100.
  GLOBALMIX:   { unit: 'percent',         displayMin: 0,    displayMax: 100, enum: false, source: 'universal' },
  // Per-parameter scene-ignore flag. III's scene model lets the user
  // exempt a specific knob from scene recall; AM4's scene model is
  // implicit (records bypass + channel only, no per-param flags).
  // Always an enum (OFF/ON).
  SCENEIGNORE: { unit: 'enum',            displayMin: 0,    displayMax: 1,   enum: true,  source: 'universal' },
  // Wet/dry mix knob — universally percent 0..100 on Fractal blocks.
  // AM4 ships per-block `*.mix` for the AM4-mapped families, which
  // resolve through the AM4 path; this fallback covers III families
  // AM4 doesn't share (PITCH, MULTITAP, TONEMATCH, …).
  MIX:         { unit: 'percent',         displayMin: 0,    displayMax: 100, enum: false, source: 'universal' },
};

function findUniversalFallback(iiiSymbolName: string): Am4Override | undefined {
  const u = iiiSymbolName.indexOf('_');
  if (u < 0) return undefined;
  const suffix = iiiSymbolName.substring(u + 1);
  const exact = UNIVERSAL_SUFFIX_FALLBACKS[suffix];
  if (exact) {
    return { block: '_universal', name: suffix.toLowerCase(), ...exact };
  }
  // Indexed PAN variants (PAN1..PANn — multi-voice / multi-band pan
  // on Pitch, Multi-tap, Vocoder, etc.). Same -100..100 bipolar_percent
  // shape as the unindexed PAN knob.
  if (/^PAN\d+$/.test(suffix)) {
    return { block: '_universal', name: suffix.toLowerCase(), ...UNIVERSAL_SUFFIX_FALLBACKS.PAN };
  }
  return undefined;
}

/**
 * Look up a calibration override for a given III catalog entry.
 *
 * Three-tier resolution (best to weakest):
 *   1. **AM4-name join.** If the III family maps to AM4 blocks via
 *      `FAMILY_TO_AM4_BLOCKS`, look up `(am4Block, am4Name)` in the
 *      loaded overrides. First hit wins. This is the hardware-verified
 *      path — calibration is copied directly from AM4's catalog
 *      including range + scaling.
 *   2. **Universal Fractal-convention fallback.** If the AM4 join
 *      misses (family unmapped, or AM4 doesn't carry the specific
 *      suffix), check `UNIVERSAL_SUFFIX_FALLBACKS` for a suffix-keyed
 *      match (BYPASS, PAN, GLOBALMIX, SCENEIGNORE, MIX, PANn).
 *   3. **AxeEdit III XML controlType inference.** If both above miss
 *      and `xmlLabels` is supplied, look up the III symbol's XML
 *      controlType and map it to a coarse unit (enum vs numeric vs dB).
 *      No range info — `displayMin`/`displayMax` stay undefined.
 *
 * Separately, the XML displayLabel is ALWAYS overlaid onto whichever
 * source wins (or stands alone when no calibration source matched),
 * because the editor's knob caption is independent of unit. Callers
 * shouldn't double-apply the label — this function returns the final
 * override with `displayLabel` already populated if XML has a hit.
 *
 * Returns undefined only when all three calibration tiers miss AND
 * the XML doesn't even know the symbol — those entries stay
 * `unit: 'unverified'` in the emitted catalog.
 */
export function findAm4Override(
  family: string,
  iiiSymbolName: string,
  overrides: Map<string, Am4Override>,
  xmlLabels?: Map<string, XmlLabel>,
): Am4Override | undefined {
  let result: Am4Override | undefined;
  // Hand-curated explicit cross-family override takes precedence over
  // the family-based join — see EXPLICIT_III_TO_AM4 comment block for
  // the rationale.
  const explicitKey = EXPLICIT_III_TO_AM4[iiiSymbolName];
  if (explicitKey) {
    result = overrides.get(explicitKey);
  }
  if (!result) {
    const am4Blocks = FAMILY_TO_AM4_BLOCKS[family];
    if (am4Blocks && am4Blocks.length > 0) {
      const am4Name = iiiSymbolToAm4Name(iiiSymbolName);
      for (const block of am4Blocks) {
        const hit = overrides.get(`${block}.${am4Name}`);
        if (hit) {
          result = hit;
          break;
        }
      }
    }
  }
  if (!result) result = findUniversalFallback(iiiSymbolName);
  if (!result && xmlLabels) result = inferOverrideFromXml(iiiSymbolName, xmlLabels);

  // Lossless displayLabel overlay. Independent of unit/range, so safe
  // to apply whether the calibration came from AM4, universal, XML,
  // or — when only the XML label is known but the controlType isn't in
  // our inference map — when there's no calibration source at all
  // (returns a label-only synthetic override).
  if (xmlLabels) {
    const xmlInfo = xmlLabels.get(iiiSymbolName);
    if (xmlInfo) {
      if (result) {
        // Clone before mutating; the AM4 map is shared across catalog
        // entries (e.g. CHORUS_LEVEL and FLANGER_LEVEL might both hit
        // the same generic `*.level` entry), so mutating in place
        // would leak displayLabel across families.
        if (!result.displayLabel) {
          result = { ...result, displayLabel: xmlInfo.displayLabel };
        }
      } else if (XML_CONTROL_TYPE_TO_UNIT[xmlInfo.controlType] === undefined) {
        // No calibration at all, but XML knows the label — emit a
        // label-only synthetic. unit stays 'unverified'; we surface
        // the label so the agent has prompt context. Source tag
        // `'xml'` keeps audit trail honest.
        result = {
          block: '_xml-label-only',
          name: iiiSymbolName.toLowerCase(),
          unit: 'unverified',
          enum: false,
          source: 'xml',
          displayLabel: xmlInfo.displayLabel,
        };
      }
    }
  }
  return result;
}
