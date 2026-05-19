/**
 * Hydrasynth Explorer — INIT_PATCH template (LEGACY — retained for
 * historical context and `verify-sysex-patch.ts` goldens).
 *
 * Hand-curated set of safe default parameter values originally used
 * by an NRPN-prelude approach (~100 writes prepended to recipe
 * batches to neutralize prior patch state). **That approach has
 * been RETIRED.** The canonical fresh-patch path is now
 * `hydra_apply_patch` (SysEx whole-patch dump from the factory INIT
 * buffer), which is atomic, ~10× faster on the wire, and inherently
 * overwrites destructive prior state.
 *
 * Why the NRPN-prelude was retired (commit 742b763 "remove broken
 * freshPatch path"): the device's working buffer carries forward
 * invisible routings (mod matrix, mutator wet, LFO assignments) that
 * aren't all in INIT_PATCH. Recipe-batch writes against an
 * incomplete neutralize prelude got unpredictable bleed-through —
 * the Van Halen "Jump" smoke test (2026-04-28) caught this when
 * leftover env-routing made the patch sound progressively worse with
 * each "fix." SysEx whole-patch replaces the entire 1762-byte buffer
 * atomically, eliminating the bleed.
 *
 * Scope — what's covered (~100 params):
 *   - Voice config: poly mode, no glide, no vibrato, BPM-sync off
 *   - Oscillators: osc1=Sine semi 0 cent 0 (osc2/3 zeroed)
 *   - Mixer: osc1 vol=100, everything else zeroed; pans centered
 *   - Mutators: all wet=0 (effectively bypassed)
 *   - Filters: LP Ladder 24, fully open, no resonance, no env
 *   - Envelopes: env1 (conventionally Filter) at organ-flat (instant
 *     attack, full sustain, no decay) so an open filter doesn't go
 *     dark; env2 (conventionally Amp) likewise organ-flat so notes
 *     sustain; env3..5 silent (assignable, off by default)
 *   - LFOs: all level=0 (silent — alias `lfo*.gain` matches the CC
 *     chart label)
 *   - Mod matrix: every modtarget=0 (disables all 32 slots)
 *   - FX: prefx + postfx Bypass; delay/reverb wet=0
 *
 * NOT in scope (intentionally):
 *   - Filter modulation page-2 params (LFO amounts, vel env, etc.) —
 *     less common bleed sources, omitted to keep init light. Add if
 *     a future test surfaces them as a problem.
 *   - Macro values — patch-defined; user typically wants the loaded
 *     patch's macro state.
 *   - Tempo, scale, microtuning — global settings, not patch state.
 *
 * Performance: ~100 NRPN writes × 3ms pacing = ~300ms wire time,
 * well within edisyn's documented safe pacing for the Hydrasynth
 * Explorer (which warns against sending the full ~1175-param dump
 * but is fine for partial sends at ≥2ms intervals).
 *
 * Update rule: keep sorted by section. When the device drops a value
 * we set here (rare — Hydrasynth processes 100ish writes reliably),
 * widen pacing not the template.
 */

export interface InitPatchEntry {
  readonly name: string;
  readonly value: number | string;
}

export const INIT_PATCH: readonly InitPatchEntry[] = [
  // -- Voice / global ----------------------------------------------------
  { name: 'voicepolyphony', value: 1 },              // poly (0=mono, 1=poly per cache)
  { name: 'voiceglide', value: 0 },                  // glide off
  { name: 'voiceglidetime', value: 0 },
  { name: 'voiceglidelegto', value: 0 },             // legato glide off
  { name: 'voicevibratoamount', value: 0 },
  { name: 'voicevibratoratesyncoff', value: 0 },
  { name: 'voicevibratobpm', value: 0 },             // BPM sync off

  // -- Oscillators -------------------------------------------------------
  { name: 'osc1type', value: 'Sine' },
  { name: 'osc2type', value: 'Sine' },
  { name: 'osc3type', value: 'Sine' },
  { name: 'osc1mode', value: 0 },                    // Single (0), not WaveScan
  { name: 'osc2mode', value: 0 },
  { name: 'osc3mode', value: 0 },
  { name: 'osc1semi', value: 0 },
  { name: 'osc2semi', value: 0 },
  { name: 'osc3semi', value: 0 },
  { name: 'osc1cent', value: 0 },
  { name: 'osc2cent', value: 0 },
  { name: 'osc3cent', value: 0 },

  // -- Mixer -------------------------------------------------------------
  { name: 'mixerosc1vol', value: 100 },              // osc1 audible by default
  { name: 'mixerosc2vol', value: 0 },
  { name: 'mixerosc3vol', value: 0 },
  { name: 'mixernoisevol', value: 0 },
  { name: 'mixerringmodvol', value: 0 },

  // -- Mutators ----------------------------------------------------------
  { name: 'mutator1wet', value: 0 },                 // all 4 mutators bypassed
  { name: 'mutator2wet', value: 0 },
  { name: 'mutator3wet', value: 0 },
  { name: 'mutator4wet', value: 0 },

  // -- Filter 1 ----------------------------------------------------------
  { name: 'filter1type', value: 'LP Ladder 24' },    // safe default; recipes override
  { name: 'filter1cutoff', value: 128 },             // fully open
  { name: 'filter1resonance', value: 0 },
  { name: 'filter1drive', value: 0 },
  { name: 'filter1keytrack', value: 0 },
  { name: 'filter1env1amount', value: 0 },           // no env routing into cutoff

  // -- Filter 2 ----------------------------------------------------------
  { name: 'filter2cutoff', value: 128 },
  { name: 'filter2resonance', value: 0 },

  // -- Envelope 1 (Amp) — organ-flat default ----------------------------
  // value=128 hits each param's wireMax via the auto-scale rule; for
  // env1sustain that's display=128.0 (max). Recipes typically override.
  { name: 'env1attacksyncoff', value: 0 },
  { name: 'env1decaysyncoff', value: 0 },
  { name: 'env1sustain', value: 128 },
  { name: 'env1releasesyncoff', value: 0 },

  // -- Envelopes 2-5 — silent ------------------------------------------
  { name: 'env2attacksyncoff', value: 0 },
  { name: 'env2decaysyncoff', value: 0 },
  { name: 'env2sustain', value: 0 },
  { name: 'env2releasesyncoff', value: 0 },
  { name: 'env3attacksyncoff', value: 0 },
  { name: 'env3decaysyncoff', value: 0 },
  { name: 'env3sustain', value: 0 },
  { name: 'env3releasesyncoff', value: 0 },
  { name: 'env4attacksyncoff', value: 0 },
  { name: 'env4decaysyncoff', value: 0 },
  { name: 'env4sustain', value: 0 },
  { name: 'env4releasesyncoff', value: 0 },
  { name: 'env5attacksyncoff', value: 0 },
  { name: 'env5decaysyncoff', value: 0 },
  { name: 'env5sustain', value: 0 },
  { name: 'env5releasesyncoff', value: 0 },

  // -- LFOs 1-5 — all silent (canonical name is lfo*level; CC chart calls it "Gain") --
  { name: 'lfo1level', value: 0 },
  { name: 'lfo2level', value: 0 },
  { name: 'lfo3level', value: 0 },
  { name: 'lfo4level', value: 0 },
  { name: 'lfo5level', value: 0 },

  // -- Mod matrix — every slot disabled ---------------------------------
  // Setting modtarget=0 disables the slot (target 0 = "None"). 32 slots.
  { name: 'modmatrix1modtarget', value: 0 },
  { name: 'modmatrix2modtarget', value: 0 },
  { name: 'modmatrix3modtarget', value: 0 },
  { name: 'modmatrix4modtarget', value: 0 },
  { name: 'modmatrix5modtarget', value: 0 },
  { name: 'modmatrix6modtarget', value: 0 },
  { name: 'modmatrix7modtarget', value: 0 },
  { name: 'modmatrix8modtarget', value: 0 },
  { name: 'modmatrix9modtarget', value: 0 },
  { name: 'modmatrix10modtarget', value: 0 },
  { name: 'modmatrix11modtarget', value: 0 },
  { name: 'modmatrix12modtarget', value: 0 },
  { name: 'modmatrix13modtarget', value: 0 },
  { name: 'modmatrix14modtarget', value: 0 },
  { name: 'modmatrix15modtarget', value: 0 },
  { name: 'modmatrix16modtarget', value: 0 },
  { name: 'modmatrix17modtarget', value: 0 },
  { name: 'modmatrix18modtarget', value: 0 },
  { name: 'modmatrix19modtarget', value: 0 },
  { name: 'modmatrix20modtarget', value: 0 },
  { name: 'modmatrix21modtarget', value: 0 },
  { name: 'modmatrix22modtarget', value: 0 },
  { name: 'modmatrix23modtarget', value: 0 },
  { name: 'modmatrix24modtarget', value: 0 },
  { name: 'modmatrix25modtarget', value: 0 },
  { name: 'modmatrix26modtarget', value: 0 },
  { name: 'modmatrix27modtarget', value: 0 },
  { name: 'modmatrix28modtarget', value: 0 },
  { name: 'modmatrix29modtarget', value: 0 },
  { name: 'modmatrix30modtarget', value: 0 },
  { name: 'modmatrix31modtarget', value: 0 },
  { name: 'modmatrix32modtarget', value: 0 },

  // -- FX slots (pre-FX, post-FX) ---------------------------------------
  { name: 'prefxtype', value: 'Bypass' },
  { name: 'postfxtype', value: 'Bypass' },
  { name: 'prefxwet', value: 0 },
  { name: 'postfxwet', value: 0 },

  // -- Delay & Reverb (between Pre-FX and Post-FX) ----------------------
  { name: 'delaywet', value: 0 },
  { name: 'reverbwet', value: 0 },
];
