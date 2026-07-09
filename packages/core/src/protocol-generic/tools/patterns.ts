/**
 * Pattern-orchestrator tools (device-neutral, dispatch by `port`).
 *
 *   - apply_pattern       , realize a drum/melodic pattern on a target via
 *                            its declared realizer (live_stream today; the
 *                            mode is gated by the device, not the schema).
 *   - list_pattern_recipes, read the named pattern library; with a port,
 *                            also report what that target supports.
 *   - import_songsterr    , fetch a Songsterr drum tab (read-only, no device)
 *                            → tracks / sections / tempo, and per-section voice
 *                            grids to feed apply_pattern.
 *
 * One verb + one lister, shared across every pattern target (Circuit Tracks,
 * SPD-SX, and any voice device with a voice_map), adding a sequencer is a
 * descriptor (pattern_realizers + voice_map), not a new tool.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { executeApplyPattern, executeListPatternRecipes } from '../dispatcher/patterns.js';
import { executeImportSongsterr } from '../dispatcher/songsterr.js';
import { PORT_DESC, asError, asText } from './shared.js';

export function registerPatternTools(server: McpServer): void {
  server.registerTool('apply_pattern', {
    // destructiveHint reflects the WORST-CASE mode: ncs_upload persists + overwrites
    // a flash slot (gated by confirm_overwrite + backup_first, same act as upload_project).
    // live_stream / record_capture are reversible.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: [
      'Realize a drum / step pattern on a sequencer target (Circuit Tracks drums, Roland SPD-SX, or any voice device with a voice_map).',
      'Pattern source (pick one): `recipe` (named library id, see list_pattern_recipes), `voices` (map voice to step string, e.g. {kick:"x...x...", snare:"....x..."}), or `notation` (comma-stack mini-notation "bd*4, hh*8, ~ sd ~ sd", needs `steps`).',
      'Step strings: char grid "x...x..." (X = accent), mini-notation "bd ~ ~ ~" (rest ~, repeat *n, subgroup [], stack ,), or Euclidean "E(k,n)" / "E(k,n,rot)" (e.g. E(5,16) spreads 5 hits over 16).',
      'Micro-step rolls: char-grid digits 1-6 = that many evenly-spaced sub-hits in the step (6 = the trap hi-hat "buzz"; hardware-confirmed positional mask, so 2-5 are real spaced subdivisions). Route the hi-hat to the drum4 voice to land it on Drum 4 (the "hat" voice is Drum 3).',
      'Imported off-grid onsets (32nds, triplets, swing) auto-place on micro-ticks with true timing on every route: note-track/external delay and the internal drum micro-mask are both hardware-confirmed.',
      'Melodic voices carry pitch with note tokens in the step string: "c2 ~ g2 ~" (bassline), "c3+eb3+g3 ~ ~ ~" (chord, join with +), "c3 eb3 g3 c4" (arp). Scientific pitch, middle C = c4 = 60, # / s = sharp, b = flat. Library recipes minor_triad/major_triad/octave_bass/minor_arp_up/lead_hook are in C: set `key` ("G", "Eb", "F#") or `transpose` (semitones) to play in another key (drum triggers are never transposed).',
      'mode live_stream (default) streams live (audition, nothing stored); record_capture streams while the device records into a pattern; ncs_upload (Circuit Tracks) writes the pattern as a stored project (needs ncs_slot 0..63 + ncs_template, an exported .ncs) that persists and replays on the device.',
      'EXTERNAL gear (ncs_upload): external_targets sequences another device via host MIDI tracks. Working SPD-SX call: [{device:"spd-sx", track:"midi2", note_offset:12}] puts the drum voices on Circuit MIDI 2 via the SPD-SX note map. note_offset:12 because the Circuit transmits MIDI-track notes an octave LOW (omit it, they miss the pads); set the SPD-SX to receive on that channel. Voices route external-only by default; also_internal:true ALSO keeps the Circuit drums. For hat rolls, author the hat voice "poly" with a buzz step (6).',
      'WHOLE SONG (ncs_upload): the `arrangement` input authors a multi-section song into one auto-advancing project. Author the sections yourself from what you know of the song, or paste grids from import_songsterr whole_song (returns the exact shape); no external source is required. See the arrangement schema for capacity.',
      'Voices resolve to pads/tracks via the target voice_map. A drum voice the target lacks FOLDS to its nearest musical substitute (china to crash, conga to tom) and is reported; a voice with no substitute errors. Re-running a pattern after the kit gains a piece resolves it more faithfully. Confirm by ear (no readback).',
      'Mapping a big groove onto a small kit is lossy: the receipt reports PIECE COMPRESSION as facts (re-voiced pieces with hit counts, merged pieces). Before a persisting write of a groove richer than the target, pre-flight with dry_run:true, relay real compression to the user, and offer alternatives (see dry_run). A clean mapping reports nothing.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      recipe: z.string().optional().describe('Named library recipe id (e.g. "four_on_the_floor"). Mutually exclusive with voices / notation.'),
      voices: z.record(z.string(), z.string()).optional().describe('Inline per-voice map: voice name → char-grid or mini-notation line.'),
      notation: z.string().optional().describe('Inline comma-stack mini-notation. Requires `steps`.'),
      tab: z.string().optional().describe('ASCII drum tablature (community text format). One line per drum voice with a label then step chars: "HH|x-x-x-x-|", "SD|----o---|", "BD|o---o---|". Labels map to voices (BD/B/K=kick, SD/S=snare, HH/H=hat, OH=openhat, CC/C=crash, RD/R=ride, T/FT=tom, RS=perc). Chars: x/o=hit, X/O=accent, -/./space=rest, g=ghost, b=buzz roll (the only verified Circuit micro-roll). Bars split on "|"; blank-line-separated systems concatenate in order (so a multi-bar song section works). Step count = the column count; the Circuit caps at 32. Mutually exclusive with recipe/voices/notation.'),
      midi_file: z.string().optional().describe('Path to a Standard MIDI File (.mid) on disk. Imports its drum track (MIDI channel 10, General-MIDI percussion → kick/snare/hat/openhat/crash/ride/tom/perc, full GM 35-81) and quantizes to a 16th-note grid; add `midi_tracks` to ALSO import melodic channels (bass/chords/lead) as pitched voices. The free, reliable "play any song" source (download a free .mid). Use midi_from_bar / midi_bars to pick a section (defaults to bars 1-2 = 32 steps; 4/4 assumed). Velocity >=100 → accent, <=40 → ghost. Mutually exclusive with the other pattern sources.'),
      midi_from_bar: z.number().int().min(1).optional().describe('midi_file only: 1-based bar to start importing from (assumes 4/4). Default 1.'),
      midi_bars: z.number().int().min(1).max(8).optional().describe('midi_file only: number of bars to import (assumes 4/4). Default 2 (= 32 sixteenth-note steps, the Circuit pattern max).'),
      midi_channel: z.number().int().min(1).max(16).optional().describe('midi_file only: 1-based MIDI channel holding the drums. Default 10 (the GM convention). Drum-library groove packs often sequence on another channel (the Mixwave Sleep Token II pack uses 16); the no-notes warning lists the channels present.'),
      drum_map: z.union([z.string(), z.record(z.string(), z.union([z.string(), z.number()]))]).optional().describe('midi_file only: percussion remap for non-GM key maps. Note number (string key) to a voice name ("clap") or GM number (39), OR a named preset string: "mixwave-st2-grooves" (the Mixwave Sleep Token II groove pack, ch16). Warnings name any unmapped numbers with hit counts, which is exactly what this map needs to cover.'),
      midi_tracks: z.record(z.string(), z.number().int().min(1).max(16)).optional().describe('midi_file only: ALSO import MELODIC channels as pitched voices, a map of voice name to 1-based MIDI channel, e.g. {"bass": 3, "chord": 2}. Voices route via the target voice_map (bass=Synth1, lead=Synth2 on the Circuit). Chords group per step (max 6 notes). Not sure which channel? Run once without it: the receipt lists every channel with note counts, pitch range, and a chords flag (lowest range = usually the bass).'),
      steps: z.number().int().min(1).max(64).optional().describe('Grid resolution per bar (8/16/32). Required for notation; optional for char-grid voices (inferred from length).'),
      bpm: z.number().min(20).max(300).optional().describe('Tempo in BPM. Default 120.'),
      mode: z.enum(['live_stream', 'record_capture', 'ncs_upload']).optional().describe('Realizer mode. Default = the target\'s first advertised realizer.'),
      repeat: z.number().int().min(1).max(64).optional().describe('Loop count. Clamped to a ~30s total realize budget.'),
      armed: z.boolean().optional().describe('record_capture only: pass true after Record is armed on the device to stream the take.'),
      ncs_template: z.string().optional().describe('ncs_upload only: path to an exported .ncs project to template-modify (the device cannot author one from scratch).'),
      ncs_slot: z.number().int().min(0).max(63).optional().describe('ncs_upload only: target project slot 0..63 to write on the device. OVERWRITE GATE: this OVERWRITES that slot, so the tool reads it first. An EMPTY slot writes through; an OCCUPIED slot REFUSES and names the project it would replace. Pass confirm_overwrite:true (only on user save/overwrite authorization) to overwrite an occupied slot.'),
      key: z.string().optional().describe('Target key root (C, G, Eb, F#…) for melodic content. Transposes the C-based pitches up to that root. Ignored if `transpose` is set; drum triggers are unaffected.'),
      transpose: z.number().int().min(-48).max(48).optional().describe('Semitone shift for authored pitches (e.g. +7, -5). Takes precedence over `key`. Drum/un-pitched hits are not transposed.'),
      scale: z.string().optional().describe('ncs_upload only: the musical scale the Circuit constrains the pattern to (e.g. "C minor", "G mixolydian", "dorian", "chromatic"). The device re-quantizes notes to its scale on playback. DEFAULT = Chromatic, so authored absolute pitches play LITERALLY (use this for exact transcriptions). Set a scale to keep the pattern in-key and let the on-device Scale knob remap it musically.'),
      round_robin: z.record(z.string(), z.array(z.string())).optional().describe('Spread a voice\'s consecutive hits across 2+ drum tracks so a fast RINGING sound (hats / ride / cymbal) overlaps and bleeds instead of choking itself. Each Circuit drum track is monophonic: a new hit cuts the previous one on that SAME track, which sounds abruptly cut off. Map a source voice to the target drum tracks to rotate across, e.g. {"hat":["drum3","drum4"]} deals hit 1->drum3, hit 2->drum4, hit 3->drum3, … Load the SAME sample on each target track so it sounds like one instrument ringing. Works in live_stream (audition) and ncs_upload. The source voice is consumed; its hits now live on the targets.'),
      drum_flips: z.record(z.string(), z.record(z.string(), z.number().int().min(0).max(63))).optional().describe('ncs_upload only: per-step SAMPLE FLIPS (the Circuit\'s feature for playing a different sample on individual steps of a drum track). Map a drum track ("drum1".."drum4") to { 1-based step number → absolute sample slot 0..63 }, e.g. {"drum1":{"9":2,"13":15}} makes Drum 1 step 9 play sample slot 2 and step 13 play slot 15, while its other hits play the track\'s default sample. This is how MULTIPLE drum pieces (kick + snare + sticks) share ONE track: the default sample on most steps, flips on the rest. The step must already be a hit (authored by a voice); flipping a rest does nothing. Slot is the wire slot = the device\'s "Sample N" minus 1 (Sample 3 = slot 2).'),
      confirm_overwrite: z.boolean().optional().describe('ncs_upload only: overwrite gate. Omitted/false reads the target slot first and refuses only if it is occupied. Pass true to overwrite an occupied slot (skips the read), only when the user authorized it.'),
      backup_first: z.boolean().optional().describe('ncs_upload only: backup-before-overwrite. Default true: when confirm_overwrite overwrites an occupied slot, save its current project to a .ncs backup (~/mcp-midi-backups) first so the change is reversible. Pass false to skip the pre-write backup read.'),
      dry_run: z.boolean().optional().describe('Pre-flight: resolve + compile + (ncs_upload) author + fit-check, sending NOTHING to the device (no reads, no gate, no backup, no transfer). Returns status "dry_run" with the full receipt: the piece-compression report (re-voiced pieces with hit counts, e.g. "ride (64 hits) to hat"; merged pieces whose distinct voices are lost), arrangement layout, and warnings. When the report shows merges or high-hit-count re-voicings, TELL THE USER what will be compressed and offer alternatives (route drums to a bigger target via external_targets, keep pieces distinct on one track via drum_flips, or accept), then re-call without dry_run.'),
      external_targets: z.array(z.object({
        device: z.string().describe('External device port (id or name), e.g. "spd-sx".'),
        track: z.string().optional().describe('Host outward MIDI track ("midi1"/"midi2"). Defaults from the rig links (MCP_RIG_LINKS / describe_rig).'),
        voices: z.array(z.string()).optional().describe('Voices to route externally. Defaults to every pattern voice the external device can place.'),
        also_internal: z.boolean().optional().describe('false (default) = the voices play ONLY on the external device (e.g. "beat on MIDI 2" goes to the SPD-SX alone). true = also play them on the Circuit\'s own drums AND the external device ("on the drum tracks and MIDI 2"), the same beat on both at once.'),
        note_offset: z.number().int().min(-48).max(48).optional().describe('Semitones added to the externally-routed notes (clamped 0..127). The Circuit Tracks transmits MIDI-track notes ONE OCTAVE BELOW the authored value (confirmed by USB capture), so pass note_offset:12 so the notes land on the external device\'s pad notes. Default 0 (no shift).'),
        voice_notes: z.record(z.string(), z.number().int().min(0).max(127)).optional().describe('Per-voice PAD PINNING: route a voice to an explicit note on the external device, bypassing its voice_map and the fold layer. The idle-pad recovery: when the compression report shows a fold (busy_hat onto the hat pad) AND the kit has an unused pad, load the right sample there and pin the voice, e.g. {"busy_hat": 39, "ride_bell": 49} keeps both pieces distinct on an SPD-SX whose clap/crash pads are idle for this song. note_offset still applies; the pinned voice needs no voice_map entry.'),
      })).optional().describe('ncs_upload only: route some/all voices to an EXTERNAL device sequenced via the host\'s MIDI 1/2 tracks (Circuit Tracks to e.g. a Roland SPD-SX). Those voices author onto the host MIDI track using the external device\'s note map; the external device must receive on that track\'s channel. Default plays the voices ONLY on the external device; also_internal:true also plays them on the Circuit\'s internal drums. Verify the host\'s actual transmit channel + octave with `npm run capture-midi` (the Circuit can send MIDI-track notes an octave low: use note_offset).'),
      arrangement: z.object({
        sections: z.array(z.object({
          name: z.string().describe('Section name ("Intro", "Verse", "Chorus"), shown in the receipt and on-device layout.'),
          recipe: z.string().optional().describe('Named library recipe id for this section.'),
          voices: z.record(z.string(), z.string()).optional().describe('Per-voice char-grid / mini-notation map for this section (the agent-authored form).'),
          notation: z.string().optional().describe('Comma-stack mini-notation for this section. Requires `steps`.'),
          tab: z.string().optional().describe('ASCII drum tab for this section.'),
          steps: z.number().int().min(1).max(64).optional().describe('Grid resolution for this section\'s inline forms.'),
          repeat: z.number().int().min(1).max(16).optional().describe('Consecutive plays of this section (default 1). "Verse ×2" = repeat:2.'),
        })).min(1).describe('The song\'s sections. Without `order`: played in listed order, each `repeat` times. Each uses exactly one of recipe / voices / notation / tab.'),
        order: z.array(z.string()).optional().describe('Play order as section NAMES, revisits allowed: ["Verse","Chorus","Verse","Chorus"]. Overrides listed order + per-section repeat.'),
      }).optional().describe('ncs_upload only: author a MULTI-SECTION song (mutually exclusive with the single-pattern sources). Sections land in pattern slots and auto-advance via the pattern chain (≤8 plays incl. repeats; hardware-confirmed) or a scene-chain (≤4 scene steps of consecutive sections; community-beta) and the song loops. Author the sections yourself, or paste grids from import_songsterr (whole_song mode returns this exact shape).'),
    },
  }, async ({ port, recipe, voices, notation, tab, midi_file, midi_from_bar, midi_bars, midi_tracks, steps, bpm, mode, repeat, armed, ncs_template, ncs_slot, key, transpose, scale, round_robin, drum_flips, confirm_overwrite, backup_first, dry_run, external_targets, arrangement }) => {
    try {
      const result = await executeApplyPattern({
        port, recipe, voices, notation, tab, midi_file, midi_from_bar, midi_bars, midi_tracks, steps,
        bpm: bpm ?? 120,
        mode, repeat, armed, ncs_template, ncs_slot, key, transpose, scale, round_robin, drum_flips, confirm_overwrite, backup_first, dry_run, external_targets, arrangement,
      });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('list_pattern_recipes', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      'List the named drum-pattern library (four_on_the_floor, boom_bap, half_time, two_step, amen, trap_hats, …) for use with apply_pattern.',
      'Pass `port` to also see what that target supports: its realizer modes and the abstract voices its voice_map can place.',
    ].join(' '),
    inputSchema: {
      port: z.string().optional().describe(PORT_DESC),
    },
  }, async ({ port }) => {
    try {
      return asText(executeListPatternRecipes({ port }));
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('import_songsterr', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: [
      'Fetch a song\'s DRUM tab from Songsterr and return it ready for apply_pattern. Read-only: it reads public Songsterr data only, nothing is sent to a device.',
      'Two steps: (1) call with `url` (a songsterr.com tab URL) or `query` ("Sleep Token Gethsemane") to list the drum TRACKS, SECTIONS (Intro/Verse/Bridge), and the TEMPO map; (2) call again with a window (`section` "Bridge", or `from_measure`/`to_measure` as displayed measure numbers) to get the per-voice step grids (`voices`) and the LOCAL tempo. Pass those `voices` and `bpm` to apply_pattern.',
      'WHOLE SONG: whole_song:true decomposes the FULL drum track into a deduped section bank + play order, returned as `arrangement` {sections, order}, the exact shape apply_pattern\'s `arrangement` input takes. See whole_song / fuzz.',
      'A song may have several drum tracks (acoustic kit vs programmed/electronic layer); when ambiguous the result lists them, pick with `track_name` ("Programmed", "electronic") or `track`. Drum data is GM percussion: kick/snare/hat/openhat/crash/ride/tom/perc. Non-GM numbers are skipped and NAMED in warnings; re-import with `drum_map` to place them.',
      '`steps`: 4 = 16ths (default), 8 = 32nds (one 4/4 bar fits the 32-step pattern). Off-grid ornaments are placed on micro-ticks by the realize path and flagged.',
    ].join(' '),
    inputSchema: {
      url: z.string().optional().describe('Songsterr tab URL (…-s1467797t11) or bare id (1467797 / 1467797t11). The t-selector picks the drum track. Provide this OR `query`.'),
      query: z.string().optional().describe('Song name to search ("Sleep Token Gethsemane") when you don\'t have the URL. Resolves to the best Songsterr match; alternatives are returned.'),
      track: z.number().int().min(0).optional().describe('Drum-track override: pass the `partId` shown in the result\'s drum_tracks[] list (a meta-track index, NOT its position in the list). Prefer `track_name` for clarity.'),
      track_name: z.string().optional().describe('Pick the drum track by name/instrument substring ("Programmed", "II", "electronic").'),
      section: z.string().optional().describe('Window by section name ("Bridge", "Chorus"). Case-insensitive; if a name repeats, the first is used.'),
      from_measure: z.number().int().min(1).optional().describe('Window start at this DISPLAYED measure number (1-based, matching the tab UI). Prefer this or `section` over from_beat.'),
      to_measure: z.number().int().min(1).optional().describe('Window end at this displayed measure number (inclusive).'),
      from_beat: z.number().min(0).optional().describe('Advanced: window start as a raw quarter-beat offset. Use only for sub-measure windows; `from_measure` overrides it if both are given.'),
      beats: z.number().min(1).optional().describe('Advanced: window length in quarter-beats.'),
      steps: z.number().int().optional().describe('Grid resolution as steps-PER-BEAT: 4 = 16ths (default), 8 = 32nds. (Note: this is per-beat, unlike apply_pattern\'s `steps` which is per-bar; it is not carried into apply_pattern, which infers length from the returned grids.)'),
      whole_song: z.boolean().optional().describe('Decompose the FULL drum track into a deduped section bank + play order, returned as `arrangement` (paste into apply_pattern\'s `arrangement` input). `fuzz` merges near-identical grooves to fit the 8 pattern slots; raise it if the song does not fit, or arrange a sub-span with measures. Mutually exclusive with the window args.'),
      fuzz: z.number().min(0).max(1).optional().describe('whole_song only: fuzzy-merge threshold (default 0.10). Higher folds near-identical grooves (turnaround fills) into one section, shrinking the bank toward the Circuit\'s 8 slots; 0 = exact dedup.'),
      drum_map: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('Per-tab percussion remap: source number to a neutral voice name ("clap") or a GM number (39). Use when warnings name non-GM numbers that were skipped, e.g. {"0": "clap"} for a tab that writes its clap layer on number 0. Judge what the number plays from where it lands (a number stacked with the snare on backbeats is usually the clap layer) and confirm by ear.'),
    },
  }, async (args) => {
    try {
      return asText(await executeImportSongsterr(args));
    } catch (err) {
      return asError(err);
    }
  });
}
