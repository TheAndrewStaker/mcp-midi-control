// AUTO-GENERATED FILE — do not edit by hand.
// Source:  docs/devices/hydrasynth-explorer/cc-chart-raw.txt
// Regen:   npm run hydra:gen-params
//
// The chart in the source comes from pp. 94-96 of the official
// ASM Hydrasynth Explorer Owner's Manual v2.2.0. Both sort
// orders ("by Module" and "by CC Number") are cross-validated
// at generation time before this file is emitted.

export type HydrasynthCategory = 'system' | 'engine';

export interface HydrasynthParam {
  /** MIDI CC number (0..127). Primary key. */
  readonly cc: number;
  /** Module the parameter belongs to (e.g. "Filter 1", "ARP"). */
  readonly module: string;
  /** Parameter name as shown on the device UI. */
  readonly parameter: string;
  /** Canonical lookup id, e.g. "filter1.cutoff". Stable across sessions. */
  readonly id: string;
  /**
   * `system` = always-on (CC 0/1/7/11/32/64/123 — exempt from the
   *            device's Param TX/RX setting per manual p. 82).
   * `engine` = synthesis-engine parameter (only responsive when
   *            Param TX/RX = CC on MIDI page 10).
   */
  readonly category: HydrasynthCategory;
}

export const HYDRASYNTH_PARAMS: readonly HydrasynthParam[] = [
  { cc:   0, module: "System"     , parameter: "Bank Select MSB"           , id: "system.bank_select_msb"    , category: 'system' },
  { cc:   1, module: "System"     , parameter: "Modulation Wheel"          , id: "system.modulation_wheel"   , category: 'system' },
  { cc:   3, module: "Mixer"      , parameter: "Noise Vol"                 , id: "mixer.noise_vol"           , category: 'engine' },
  { cc:   5, module: "Voice"      , parameter: "Glide Time"                , id: "voice.glide_time"          , category: 'engine' },
  { cc:   7, module: "System"     , parameter: "Master Volume"             , id: "system.master_volume"      , category: 'system' },
  { cc:   8, module: "Mixer"      , parameter: "Noise Pan"                 , id: "mixer.noise_pan"           , category: 'engine' },
  { cc:   9, module: "Mixer"      , parameter: "Ring Mod Vol"              , id: "mixer.ring_mod_vol"        , category: 'engine' },
  { cc:  10, module: "Mixer"      , parameter: "Ring Mod Pan"              , id: "mixer.ring_mod_pan"        , category: 'engine' },
  { cc:  11, module: "System"     , parameter: "Expression Pedal"          , id: "system.expression_pedal"   , category: 'system' },
  { cc:  12, module: "Pre-FX"     , parameter: "PRE-FX Param1"             , id: "prefx.param1"              , category: 'engine' },
  { cc:  13, module: "Pre-FX"     , parameter: "PRE-FX Param2"             , id: "prefx.param2"              , category: 'engine' },
  { cc:  14, module: "Delay"      , parameter: "Delay Feedback"            , id: "delay.feedback"            , category: 'engine' },
  { cc:  15, module: "Delay"      , parameter: "Delay Time"                , id: "delay.time"                , category: 'engine' },
  { cc:  16, module: "Macros"     , parameter: "Macro 1"                   , id: "macros.macro_1"            , category: 'engine' },
  { cc:  17, module: "Macros"     , parameter: "Macro 2"                   , id: "macros.macro_2"            , category: 'engine' },
  { cc:  18, module: "Macros"     , parameter: "Macro 3"                   , id: "macros.macro_3"            , category: 'engine' },
  { cc:  19, module: "Macros"     , parameter: "Macro 4"                   , id: "macros.macro_4"            , category: 'engine' },
  { cc:  20, module: "Macros"     , parameter: "Macro 5"                   , id: "macros.macro_5"            , category: 'engine' },
  { cc:  21, module: "Macros"     , parameter: "Macro 6"                   , id: "macros.macro_6"            , category: 'engine' },
  { cc:  22, module: "Macros"     , parameter: "Macro 7"                   , id: "macros.macro_7"            , category: 'engine' },
  { cc:  23, module: "Macros"     , parameter: "Macro 8"                   , id: "macros.macro_8"            , category: 'engine' },
  { cc:  24, module: "OSC 1"      , parameter: "OSC1 WaveScan"             , id: "osc1.wavescan"             , category: 'engine' },
  { cc:  25, module: "ENV 4"      , parameter: "ENV4 Attack"               , id: "env4.attack"               , category: 'engine' },
  { cc:  26, module: "OSC 2"      , parameter: "OSC2 WaveScan"             , id: "osc2.wavescan"             , category: 'engine' },
  { cc:  27, module: "ENV 4"      , parameter: "ENV4 Decay"                , id: "env4.decay"                , category: 'engine' },
  { cc:  28, module: "LFO 2"      , parameter: "LFO2 Gain"                 , id: "lfo2.gain"                 , category: 'engine' },
  { cc:  29, module: "Mutator 1"  , parameter: "Mutator1 Ratio"            , id: "mutator1.ratio"            , category: 'engine' },
  { cc:  30, module: "Mutator 1"  , parameter: "Mutator1 Depth"            , id: "mutator1.depth"            , category: 'engine' },
  { cc:  31, module: "Mutator 1"  , parameter: "Mutator1 Dry/Wet"          , id: "mutator1.dry_wet"          , category: 'engine' },
  { cc:  32, module: "System"     , parameter: "Bank Select LSB"           , id: "system.bank_select_lsb"    , category: 'system' },
  { cc:  33, module: "Mutator 2"  , parameter: "Mutator2 Ratio"            , id: "mutator2.ratio"            , category: 'engine' },
  { cc:  34, module: "Mutator 2"  , parameter: "Mutator2 Depth"            , id: "mutator2.depth"            , category: 'engine' },
  { cc:  35, module: "Mutator 2"  , parameter: "Mutator2 Dry/Wet"          , id: "mutator2.dry_wet"          , category: 'engine' },
  { cc:  36, module: "Mutator 3"  , parameter: "Mutator3 Ratio"            , id: "mutator3.ratio"            , category: 'engine' },
  { cc:  37, module: "Mutator 3"  , parameter: "Mutator3 Depth"            , id: "mutator3.depth"            , category: 'engine' },
  { cc:  39, module: "Mutator 3"  , parameter: "Mutator3 Dry/Wet"          , id: "mutator3.dry_wet"          , category: 'engine' },
  { cc:  40, module: "Mutator 4"  , parameter: "Mutator4 Ratio"            , id: "mutator4.ratio"            , category: 'engine' },
  { cc:  41, module: "Mutator 4"  , parameter: "Mutator4 Depth"            , id: "mutator4.depth"            , category: 'engine' },
  { cc:  42, module: "Mutator 4"  , parameter: "Mutator4 Dry/Wet"          , id: "mutator4.dry_wet"          , category: 'engine' },
  { cc:  43, module: "Mixer"      , parameter: "RM12 Depth"                , id: "mixer.rm12_depth"          , category: 'engine' },
  { cc:  44, module: "Mixer"      , parameter: "OSC1 Vol"                  , id: "mixer.osc1_vol"            , category: 'engine' },
  { cc:  45, module: "Mixer"      , parameter: "OSC1 Pan"                  , id: "mixer.osc1_pan"            , category: 'engine' },
  { cc:  46, module: "Mixer"      , parameter: "OSC2 Vol"                  , id: "mixer.osc2_vol"            , category: 'engine' },
  { cc:  47, module: "Mixer"      , parameter: "OSC2 Pan"                  , id: "mixer.osc2_pan"            , category: 'engine' },
  { cc:  48, module: "Mixer"      , parameter: "OSC3 Vol"                  , id: "mixer.osc3_vol"            , category: 'engine' },
  { cc:  49, module: "Mixer"      , parameter: "OSC3 Pan"                  , id: "mixer.osc3_pan"            , category: 'engine' },
  { cc:  50, module: "Filter 1"   , parameter: "Filter 1 Drive"            , id: "filter1.drive"             , category: 'engine' },
  { cc:  51, module: "Filter 1"   , parameter: "Filter 1 Keytrack"         , id: "filter1.keytrack"          , category: 'engine' },
  { cc:  52, module: "Filter 1"   , parameter: "Filter 1 LFO1amt"          , id: "filter1.lfo1amt"           , category: 'engine' },
  { cc:  53, module: "Filter 1"   , parameter: "Filter 1 Vel Env"          , id: "filter1.vel_env"           , category: 'engine' },
  { cc:  54, module: "Filter 1"   , parameter: "Filter 1 ENV1amt"          , id: "filter1.env1amt"           , category: 'engine' },
  { cc:  55, module: "Filter 2"   , parameter: "Filter 2 Cutoff"           , id: "filter2.cutoff"            , category: 'engine' },
  { cc:  56, module: "Filter 2"   , parameter: "Filter 2 Res"              , id: "filter2.res"               , category: 'engine' },
  { cc:  57, module: "Filter 2"   , parameter: "Filter 2 Type"             , id: "filter2.type"              , category: 'engine' },
  { cc:  58, module: "Filter 2"   , parameter: "Filter 2 Keytrack"         , id: "filter2.keytrack"          , category: 'engine' },
  { cc:  59, module: "Filter 2"   , parameter: "Filter 2 LFO1amt"          , id: "filter2.lfo1amt"           , category: 'engine' },
  { cc:  60, module: "Filter 2"   , parameter: "Filter 2 Vel Env"          , id: "filter2.vel_env"           , category: 'engine' },
  { cc:  61, module: "Filter 2"   , parameter: "Filter 2 ENV1amt"          , id: "filter2.env1amt"           , category: 'engine' },
  { cc:  62, module: "Amp"        , parameter: "Amp LFO2amt"               , id: "amp.lfo2amt"               , category: 'engine' },
  { cc:  63, module: "Delay"      , parameter: "Delay Wet Tone"            , id: "delay.wet_tone"            , category: 'engine' },
  { cc:  64, module: "System"     , parameter: "Sustain Pedal"             , id: "system.sustain_pedal"      , category: 'system' },
  { cc:  65, module: "Reverb"     , parameter: "Reverb Time"               , id: "reverb.time"               , category: 'engine' },
  { cc:  66, module: "Voice"      , parameter: "Glide"                     , id: "voice.glide"               , category: 'engine' },
  { cc:  67, module: "Reverb"     , parameter: "Reverb Tone"               , id: "reverb.tone"               , category: 'engine' },
  { cc:  68, module: "Post-FX"    , parameter: "POST-FX Param1"            , id: "postfx.param1"             , category: 'engine' },
  { cc:  69, module: "Post-FX"    , parameter: "POST-FX Param2"            , id: "postfx.param2"             , category: 'engine' },
  { cc:  70, module: "LFO 1"      , parameter: "LFO1 Gain"                 , id: "lfo1.gain"                 , category: 'engine' },
  { cc:  71, module: "Filter 1"   , parameter: "Filter 1 Res"              , id: "filter1.res"               , category: 'engine' },
  { cc:  72, module: "LFO 1"      , parameter: "LFO1 Rate"                 , id: "lfo1.rate"                 , category: 'engine' },
  { cc:  73, module: "LFO 2"      , parameter: "LFO2 Rate"                 , id: "lfo2.rate"                 , category: 'engine' },
  { cc:  74, module: "Filter 1"   , parameter: "Filter 1 Cutoff"           , id: "filter1.cutoff"            , category: 'engine' },
  { cc:  75, module: "LFO 3"      , parameter: "LFO3 Gain"                 , id: "lfo3.gain"                 , category: 'engine' },
  { cc:  76, module: "LFO 3"      , parameter: "LFO3 Rate"                 , id: "lfo3.rate"                 , category: 'engine' },
  { cc:  77, module: "LFO 4"      , parameter: "LFO4 Gain"                 , id: "lfo4.gain"                 , category: 'engine' },
  { cc:  78, module: "LFO 4"      , parameter: "LFO4 Rate"                 , id: "lfo4.rate"                 , category: 'engine' },
  { cc:  79, module: "LFO 5"      , parameter: "LFO5 Gain"                 , id: "lfo5.gain"                 , category: 'engine' },
  { cc:  80, module: "LFO 5"      , parameter: "LFO5 Rate"                 , id: "lfo5.rate"                 , category: 'engine' },
  { cc:  81, module: "ENV 1"      , parameter: "ENV1 Attack"               , id: "env1.attack"               , category: 'engine' },
  { cc:  82, module: "ENV 1"      , parameter: "ENV1 Decay"                , id: "env1.decay"                , category: 'engine' },
  { cc:  83, module: "ENV 1"      , parameter: "ENV1 Sustain"              , id: "env1.sustain"              , category: 'engine' },
  { cc:  84, module: "ENV 1"      , parameter: "ENV1 Release"              , id: "env1.release"              , category: 'engine' },
  { cc:  85, module: "ENV 2"      , parameter: "ENV2 Attack"               , id: "env2.attack"               , category: 'engine' },
  { cc:  86, module: "ENV 2"      , parameter: "ENV2 Decay"                , id: "env2.decay"                , category: 'engine' },
  { cc:  87, module: "ENV 2"      , parameter: "ENV2 Sustain"              , id: "env2.sustain"              , category: 'engine' },
  { cc:  88, module: "ENV 2"      , parameter: "ENV2 Release"              , id: "env2.release"              , category: 'engine' },
  { cc:  89, module: "ENV 3"      , parameter: "ENV3 Attack"               , id: "env3.attack"               , category: 'engine' },
  { cc:  90, module: "ENV 3"      , parameter: "ENV3 Decay"                , id: "env3.decay"                , category: 'engine' },
  { cc:  91, module: "Reverb"     , parameter: "Reverb Dry/Wet"            , id: "reverb.dry_wet"            , category: 'engine' },
  { cc:  92, module: "Delay"      , parameter: "Delay Dry/Wet"             , id: "delay.dry_wet"             , category: 'engine' },
  { cc:  93, module: "Pre-FX"     , parameter: "PRE-FX Mix"                , id: "prefx.mix"                 , category: 'engine' },
  { cc:  94, module: "Post-FX"    , parameter: "POST-FX Mix"               , id: "postfx.mix"                , category: 'engine' },
  { cc:  95, module: "Voice"      , parameter: "Detune"                    , id: "voice.detune"              , category: 'engine' },
  { cc:  96, module: "ENV 3"      , parameter: "ENV3 Sustain"              , id: "env3.sustain"              , category: 'engine' },
  { cc:  97, module: "ENV 3"      , parameter: "ENV3 Release"              , id: "env3.release"              , category: 'engine' },
  { cc: 102, module: "ENV 5"      , parameter: "ENV5 Attack"               , id: "env5.attack"               , category: 'engine' },
  { cc: 103, module: "ENV 5"      , parameter: "ENV5 Decay"                , id: "env5.decay"                , category: 'engine' },
  { cc: 104, module: "ENV 5"      , parameter: "ENV5 Sustain"              , id: "env5.sustain"              , category: 'engine' },
  { cc: 105, module: "ENV 5"      , parameter: "ENV5 Release"              , id: "env5.release"              , category: 'engine' },
  { cc: 106, module: "ARP"        , parameter: "ARP Division"              , id: "arp.division"              , category: 'engine' },
  { cc: 107, module: "ARP"        , parameter: "ARP Gate"                  , id: "arp.gate"                  , category: 'engine' },
  { cc: 108, module: "ARP"        , parameter: "ARP Mode"                  , id: "arp.mode"                  , category: 'engine' },
  { cc: 109, module: "ARP"        , parameter: "ARP Ratchet"               , id: "arp.ratchet"               , category: 'engine' },
  { cc: 110, module: "ARP"        , parameter: "ARP Chance"                , id: "arp.chance"                , category: 'engine' },
  { cc: 111, module: "OSC 1"      , parameter: "OSC1 Cent"                 , id: "osc1.cent"                 , category: 'engine' },
  { cc: 112, module: "OSC 2"      , parameter: "OSC2 Cent"                 , id: "osc2.cent"                 , category: 'engine' },
  { cc: 113, module: "OSC 3"      , parameter: "OSC3 Cent"                 , id: "osc3.cent"                 , category: 'engine' },
  { cc: 114, module: "Mixer"      , parameter: "OSC3 FRate"                , id: "mixer.osc3_frate"          , category: 'engine' },
  { cc: 115, module: "Mixer"      , parameter: "Noise FRate"               , id: "mixer.noise_frate"         , category: 'engine' },
  { cc: 116, module: "Mixer"      , parameter: "RM12 FRate"                , id: "mixer.rm12_frate"          , category: 'engine' },
  { cc: 117, module: "Voice"      , parameter: "StWidth"                   , id: "voice.stwidth"             , category: 'engine' },
  { cc: 118, module: "Mixer"      , parameter: "OSC1 FRate"                , id: "mixer.osc1_frate"          , category: 'engine' },
  { cc: 119, module: "Mixer"      , parameter: "OSC2 FRate"                , id: "mixer.osc2_frate"          , category: 'engine' },
  { cc: 120, module: "ARP"        , parameter: "ARP Octave"                , id: "arp.octave"                , category: 'engine' },
  { cc: 122, module: "ARP"        , parameter: "ARP Length"                , id: "arp.length"                , category: 'engine' },
  { cc: 123, module: "System"     , parameter: "All Notes Off"             , id: "system.all_notes_off"      , category: 'system' },
  { cc: 124, module: "ENV 4"      , parameter: "ENV4 Release"              , id: "env4.release"              , category: 'engine' },
  { cc: 125, module: "ENV 4"      , parameter: "ENV4 Sustain"              , id: "env4.sustain"              , category: 'engine' },
] as const;

/** Lookup by CC number. */
export const HYDRASYNTH_PARAMS_BY_CC: ReadonlyMap<number, HydrasynthParam> =
  new Map(HYDRASYNTH_PARAMS.map((p) => [p.cc, p]));

/** Lookup by canonical id (e.g. "filter1.cutoff"). */
export const HYDRASYNTH_PARAMS_BY_ID: ReadonlyMap<string, HydrasynthParam> =
  new Map(HYDRASYNTH_PARAMS.map((p) => [p.id, p]));

/** All distinct module names, in stable order (matches the manual). */
export const HYDRASYNTH_MODULES: readonly string[] = [
  "System",
  "Mixer",
  "Voice",
  "Pre-FX",
  "Delay",
  "Macros",
  "OSC 1",
  "ENV 4",
  "OSC 2",
  "LFO 2",
  "Mutator 1",
  "Mutator 2",
  "Mutator 3",
  "Mutator 4",
  "Filter 1",
  "Filter 2",
  "Amp",
  "Reverb",
  "Post-FX",
  "LFO 1",
  "LFO 3",
  "LFO 4",
  "LFO 5",
  "ENV 1",
  "ENV 2",
  "ENV 3",
  "ENV 5",
  "ARP",
  "OSC 3",
] as const;
