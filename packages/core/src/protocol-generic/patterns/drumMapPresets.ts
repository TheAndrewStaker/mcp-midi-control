/**
 * Named drum-map presets: per-source percussion key maps for known non-GM
 * sources, usable wherever a `drum_map` is accepted (apply_pattern midi_file,
 * importMidiDrums). A preset only carries CONFIRMED keys — candidates stay in
 * comments until verified (the unmapped-numbers warning names anything a
 * preset misses, so gaps are visible, never silent).
 */

/**
 * Mixwave "Sleep Token - II" GROOVE PACK (the 160 `.mid` grooves under the
 * library's MIDI Files folder; kit sequenced on MIDI ch16). NOTE: this is the
 * key map of the GROOVE FILES, which is NOT the key map of the Kontakt
 * instrument itself. The instrument's own map is GM-aligned and
 * screenshot-confirmed straight from its MIDI MAPPING panel (2026-07-04),
 * superseding the 2026-07-03 audio-render census on one point: keys 41/43
 * are Floor Tom hits (soft/hard), not "ruffs" as the census had guessed.
 * Confirmed: kick 35/36 (hit left/right), snare 38 hit-center/39 flam/40 rim
 * shot/37 side stick/25 buzz-roll, rack toms 45/47/48/50 (+rim 21/23), floor
 * tom 41/43 (+rim 19), hi-hat 7-zone tip+edge tight/closed/open plus
 * 42 edge-closed/44 pedal-closed/46 edge-open, ride bow 51/bell 53/crash 59,
 * crashes 49/54/57, splash 55 (each cymbal also has its own choke + manual-
 * choke note). The groove keys 1/2/3/14 render SILENCE on the instrument.
 *
 * Evidence: ear-confirmed via A/B preview in the 2026-06-21 groove-set session
 * (scripts/groove-analysis/groove_to_pattern.py) and independently reproduced
 * by metric-position analysis across all 160 files (2026-07-03: key 1 =
 * downbeat+syncopation kick profile, 3 = half-time beat-3 backbeat, 14 = 16th
 * streams, 2 = soft busy-hat runs, 41 = quarter-note ride pulse).
 *
 * UNCONFIRMED remainder (named in warnings when hit; extend via drum_map):
 * 11/7/9/13/32/23/19/21/33/29/27/22/20/18/0/4/16/17/25/28/30 sparse; GM-range
 * keys 35/38/44/47/50-57 in these FILES have unverified meaning (do not
 * assume GM). The earlier "(tom/fill pieces?)" / "(crash?)" guesses for
 * 11/7/9/13/32 are REFUTED (2026-07-04): the catalog now tags every file
 * fill/groove, and each of these notes' hit-share by file-kind lands right
 * at the pack's base fill-rate (31/160 ≈ 19%, not concentrated in fills) —
 * they're ordinary secondary articulations used throughout normal grooves,
 * not fill/transition-specific pieces.
 *
 * KEY 2 RE-MAPPED hat -> snare (2026-11-07). The 2026-06-21 A/B preview heard
 * whole grooves, not key 2 in isolation, and the "soft busy-hat runs" reading
 * does not survive the files: key 2's loud hits (vel >= 110) peak on steps 8
 * and 12 of the bar, exactly where snare key 3 accents (key 3: 312 / 107 hits
 * there), while hat key 14's accents spread evenly; key 2 and key 3 sound
 * together once in 793 key-3 hits; and S04 Groove 09 has NO key 3 at all,
 * with key 14 playing the hat figure and key 2 carrying the ghost 16ths plus
 * the beat-4 backbeat every bar. Read as a hat, that groove imported as
 * "hat, kick" with no snare (dogfooded through apply_pattern dry_run).
 * Candidates from the same 2026-11-07 survey, NOT in the preset (structural
 * inference only, unheard): 0 = second kick (alternates 16ths with key 1,
 * never coincides), 23 = hat foot, 32 = crash (38/115 on beat 1 with the
 * kick), 53 = ridden crash, 54 = china, 7/9/11 = high/mid/floor tom.
 */
export const MIXWAVE_ST2_GROOVES: Readonly<Record<number, string>> = {
  1: 'kick',
  2: 'snare',  // soft/ghost snare lane (re-mapped 2026-11-07 from 'hat'; see the evidence note above)
  3: 'snare',
  14: 'hat',   // closed hat
  41: 'ride',
};

/** Preset registry: name → map. Names are kebab-case, vendor-pack scoped. */
export const DRUM_MAP_PRESETS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  'mixwave-st2-grooves': MIXWAVE_ST2_GROOVES,
};

/** Resolve a preset by name; throws with the available names on a miss. */
export function resolveDrumMapPreset(name: string): Readonly<Record<number, string>> {
  const preset = DRUM_MAP_PRESETS[name];
  if (!preset) {
    throw new Error(`Unknown drum_map preset "${name}". Available: ${Object.keys(DRUM_MAP_PRESETS).join(', ')}.`);
  }
  return preset;
}
