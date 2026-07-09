/**
 * Circuit Tracks agent guidance, surfaced via describe_device. Topic-keyed
 * so a reader can pull just what's relevant.
 */

export const CIRCUIT_AGENT_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  device_class:
    'Circuit Tracks is two devices in one: a TONE side (two synths + four drums you control like ' +
    'any synth via set_param/set_params) and an ORCHESTRATOR side (it sequences gear and is itself ' +
    'a pattern target). Use set_param for sounds; use apply_pattern for beats.',

  channel_model:
    'One USB endpoint multiplexed by MIDI channel: Synth 1 = ch1, Synth 2 = ch2, MIDI tracks = ' +
    'ch3/ch4 (external gear), Drums = ch10, Project/global = ch16. set_param targets SYNTH 1 by ' +
    'default; pass instance:2 to address the SAME synth param on SYNTH 2 (e.g. set_param block:"osc1" ' +
    'name:"semitones" value:7 instance:2). instance:2 applies only to synth blocks; drum/project ' +
    'params (fixed channels) reject it. Per-track MIDI channel reassignment (Setup View) is a follow-on.',

  param_surface:
    'Beyond the synth voice (osc1/osc2/mixer/filter/env1-3/lfo1-2/fx/eq), set_param also reaches: ' +
    'macros (block "macros", names macro_1..macro_8 = the 8 knob positions); the 12-slot mod matrix ' +
    '(blocks "mod1".."mod12", each with source1/source2/depth/destination, sources+destinations by ' +
    'name); drums (blocks "drum1".."drum4": patch/level/pitch/decay/distortion/eq/pan); and the project ' +
    'mixer (block "track_mixer": synth1_level/synth2_level/synth1_pan/synth2_pan) + reverb/delay/' +
    'master_filter. The reverb and delay blocks carry both the effect character (reverb type/decay/' +
    'damping, delay time/feedback/width/...) AND the per-track SEND levels (synth1_send/synth2_send/' +
    'drum1_send..drum4_send); raise a send to route that track into the effect (sends default to 0/dry, ' +
    'so the character params do nothing until a send is up). Sidechain ducking is two blocks ' +
    '"sidechain1"/"sidechain2" (one per synth engine; source/attack/hold/decay/depth on ch16, distinct ' +
    'addresses, so instance:2 does NOT reach sidechain2). Per-macro A-D routing is blocks "macro1".."macro8" ' +
    '(slots a-d, each {destination/start/end/depth}); the live knob POSITIONS stay in block "macros" (macro_1..macro_8). ' +
    'Macros, macro routing, and the mod matrix are per-synth, so instance:2 targets Synth 2 there too.',

  reads_are_limited:
    'get_param / get_params DO read SYNTH PATCH params now (osc/filter/env/lfo/mixer/fx/eq; instance 1 = ' +
    'Synth 1, 2 = Synth 2): they request a live Patch Dump and decode the body, so you can verify a synth ' +
    'write by reading it back. NOT readable this way: drum, project, macro, and mod-matrix state; those ' +
    'have no single-param readback, so get_param refuses them honestly (confirm by ear / front panel, never ' +
    'assume a value). For stored content, get_preset({port:"circuit", location: <slot 0..63>}) downloads a ' +
    'STORED project off a Flash slot and decodes its sequencer content (four note + four drum tracks, ' +
    'pattern 1); get_preset({location:"patch:N"}) reads a stored synth PATCH slot, returning the patch name ' +
    'AND decoded patch-dump params (osc/filter/env/lfo/mixer/fx/eq), and reflects freshly-saved patches. ' +
    'These read SAVED slots only; the live working buffer is not a slot, so the user must Save ' +
    'edits to a slot first. This is the read half of read-modify-write (read slot, edit, ncs_upload).',

  making_beats:
    'Two ways to land a beat, by intent: (1) apply_pattern mode:live_stream, Claude streams the ' +
    'beat live as a sound module (audition only; host-clocked, has timing jitter; nothing is stored). ' +
    '(2) apply_pattern mode:ncs_upload, author the pattern INTO a real .ncs project and push it to a ' +
    'stored project slot over SysEx. This is the way to PREP a project for a gig and the ONLY way to put a ' +
    'DRUM pattern onto the device programmatically. It needs ncs_template (a path to an exported .ncs to ' +
    'template-modify; the device cannot author one from scratch) and ncs_slot (the 0..63 project slot to ' +
    'write); it writes drums AND the note tracks (see melodic_sequencing). HARDWARE STATUS: the drum codec, ' +
    'the note-track (melodic) authoring leg, and the SysEx transfer are all hardware-confirmed (a bassline ' +
    'on Synth 1 + a kick on Drum 1 uploaded to a slot, loaded, and played back on the device). NOTE: ' +
    'record_capture exists but is NOT advertised here: ' +
    'DRUM tracks do NOT record external MIDI (manual p.38 + on-device test): external drum notes on ch10 ' +
    'TRIGGER the pad sound but are never captured. Use ncs_upload to land a drum beat on the device, ' +
    'live_stream to audition one.',

  melodic_sequencing:
    'apply_pattern authors MELODIES and CHORDS too, not just drums. Voices map to tracks by name: ' +
    'drum voices (kick/snare/hat/clap) → the ch10 pads; melodic voices → the note tracks, bass/chord → ' +
    'Synth 1, lead/arp → Synth 2, or target a track explicitly with the voice names synth1/synth2/midi1/' +
    'midi2 (MIDI 1/2 sequence EXTERNAL gear, e.g. midi1 → a Hydrasynth, midi2 → an SPD-SX). Pitch is ' +
    'written PER STEP with note tokens in the voice line: "c2 ~ g2 ~ eb2 ~ ~ ~" is a bassline, ' +
    '"c3+eb3+g3 ~ ~ ~" a chord (join chord notes with +, up to 6), "c3 eb3 g3 c4" an arpeggio. Names are ' +
    'scientific pitch (middle C = c4 = 60; # or s = sharp, b = flat). A plain x/X hit takes the voice\'s ' +
    'default note. The curated library (list_pattern_recipes) ships musical building blocks ' +
    '(minor_triad, octave_bass, minor_arp_up, lead_hook) authored in C; pass key:"G" (or transpose:7 ' +
    'in semitones) to play them in another key; the server transposes the pitches for you, and drum ' +
    'triggers are never shifted. Using the bass AND chord voices together combines them on Synth 1 (both ' +
    'default to ch1); target synth1/synth2 explicitly to keep parts on separate tracks. Melodic authoring ' +
    'lands on the device via mode:ncs_upload (hardware-confirmed); live_stream auditions it without storing. ' +
    'IMPORTANT: see the scales guidance; the device re-quantizes notes to the project scale, so absolute ' +
    'pitches only play literally under Chromatic (which ncs_upload sets by default).',

  scales:
    'The Circuit constrains every note a synth/MIDI track plays to the PROJECT SCALE (a Scale type + Root, ' +
    'saved in the project). It re-quantizes notes to that scale on playback, so an out-of-scale authored note ' +
    'is SHIFTED; e.g. in the device-default C Natural Minor, an authored C-E-G-B maj7 plays back as ' +
    'C-Eb-G-Bb. Because note tokens are ABSOLUTE pitches, apply_pattern mode:ncs_upload sets the project to ' +
    'CHROMATIC by default (all 12 notes in scale ⇒ pitches play exactly as authored); use this for exact ' +
    'transcriptions (a song melody, a specific chord). If instead you WANT the device\'s scale feature (the ' +
    'pattern stays in-key and the user can twist the on-device Scale knob to remap it to other keys/modes ' +
    'live), pass scale (e.g. scale:"C minor", "G mixolydian", "dorian"); author in-scale notes so nothing ' +
    'shifts. If you pass a non-Chromatic scale and some authored notes fall OUTSIDE it, the upload result ' +
    'warns how many pitch-classes the device will shift (it does not refuse; author in-key, or use ' +
    'Chromatic to keep exact pitches). 16 scales: Natural Minor, Major, Dorian, Phrygian, Mixolydian, ' +
    'Melodic/Harmonic Minor, Bebop Dorian, Blues, Minor Pentatonic, Hungarian Minor, Ukrainian Dorian, ' +
    'Marva, Todi, Whole Tone, Chromatic.',

  no_pattern_selection_over_midi:
    'You CANNOT select an individual pattern or scene within a project over MIDI, only whole PROJECTS ' +
    'switch (switch_preset / Program Change on ch16; 0..63 instant, 64..127 queued for a ' +
    'tempo-quantized section change). Do not try to address pattern steps directly; there is no wire path.',

  save_discipline:
    'set_param / set_params edit the live (RAM) sound, non-destructive, reverted by switching ' +
    'patches/projects. save_preset DOES persist a synth part\'s RAM sound to a Flash PATCH slot ' +
    '(instance 1 = Synth 1, 2 = Synth 2), hardware-confirmed 2026-07-03 to survive a power-cycle. ' +
    'It is destructive (it overwrites the slot) and needs confirm_overwrite. The device gives no save ' +
    'ack, so verify by ear / power-cycle, or read it back with get_preset("patch:N").',

  external_sequencing:
    'As an orchestrator, the Circuit can drive external gear from its MIDI tracks (ch3/ch4) and as ' +
    'clock master/follower. To sequence a Hydrasynth or SPD-SX from a neutral pattern, target THAT ' +
    "device's port with apply_pattern (each device owns its own voice_map); the Circuit need not be " +
    'in the loop. Transport uses the existing send_clock_* primitives.',

  sample_upload:
    'Load your own WAV drum samples onto the device with upload_sample(file, slot 1..64) or ' +
    'upload_kit(folder, kit?, start_slot?), replacing the Novation Components web app. The 64 sample ' +
    'slots are the SHARED DRUM POOL the four drum tracks pick from (synths use patches, not samples, so a ' +
    'sample is always a drum sound). Any-rate/-channel WAV is normalized to the device format (48 kHz mono ' +
    '16-bit) on upload. A slot is OVERWRITTEN, and sample slots can\'t be read to check occupancy yet, so both ' +
    'tools REFUSE by default and need confirm_overwrite:true; pass it only when the user authorized replacing ' +
    'the slot(s) (save/overwrite/replace language; loading a fresh kit is usually overwrite-intent). ' +
    'upload_kit natural-sorts a folder, maps files to consecutive slots, skips + reports any past ' +
    'the 64-slot ceiling, and writes the whole kit as ONE atomic sample-directory session (all-or-nothing). ' +
    'HARDWARE STATUS: durable, hardware-confirmed (2026-06-23): samples survive a device restart. The fix was ' +
    'the session prelude (sample-dir 0x05 listing + the 64x 0x0d scan that commits the pack manifest); confirm ' +
    'by ear since the device\'s final CRC verdict isn\'t read back. Needs a bidirectional connection (ACK-gated).',

  project_upload:
    'Load a prepared whole-project .ncs onto the device with upload_project(file, slot 0..63), sent verbatim ' +
    'over the same hardware-confirmed transport (device shows it as "Project slot+1"). Use this for a ready- ' +
    'made project such as a swappable groove set; to AUTHOR a pattern from scratch into a template instead, ' +
    'use apply_pattern mode:ncs_upload. OVERWRITE GATE: without confirm_overwrite the tool reads the target slot ' +
    'first: an EMPTY slot writes through, an OCCUPIED slot refuses and names the project it would replace; pass ' +
    'confirm_overwrite:true (only on user save/overwrite authorization) to overwrite an occupied slot. A project ' +
    'references samples by slot but does NOT contain the audio, so the drum tracks play whatever is assigned ' +
    'in Drum track > Preset; load the matching kit (upload_sample / upload_kit) and the user assigns ' +
    'Drum 1..4 to the sample positions on the device (per project). Needs a bidirectional connection.',

  drum_bleed_round_robin:
    'Each drum track is MONOPHONIC: a new hit retriggers (chokes) the previous hit on that SAME track, so a ' +
    'fast RINGING sound (open hat, ride, cymbal, snare roll) cuts itself off and sounds abruptly unnatural. ' +
    'One track cannot be made polyphonic. For acoustic-style bleed: (1) apply_pattern round_robin spreads a ' +
    'voice across 2+ drum tracks, e.g. round_robin:{"hat":["drum3","drum4"]} alternates consecutive hits so ' +
    'tails overlap (LOAD THE SAME sample on each target track). (2) trigger a pre-baked roll/cymbal SAMPLE ' +
    'once (upload_sample a real hat-roll WAV) instead of micro-step retriggers. (3) raise the drum Decay ' +
    'macro (drum Macro 4) to lengthen each ring. (4) add reverb/delay sends (an ambient tail rings past the ' +
    'choke). (5) keep a ringing sound on its own track, away from a busy pattern. The micro-step buzz ' +
    '(roll 6) has the same abruptness; a real roll sample is the musical fix.',

  multi_piece_drum_tracks:
    'A drum track plays one sample at a time, BUT each STEP can play a DIFFERENT sample via the device\'s ' +
    'SAMPLE FLIP feature, so multiple pieces (kick + snare + sticks) share ONE track and free the other three ' +
    'for more parts. Author with apply_pattern drum_flips (ncs_upload only): {"drum1":{"9":2,"13":15}} flips ' +
    'Drum 1 step 9 to sample slot 2 and step 13 to slot 15, while its other hits play the track default. The ' +
    'slot is the wire slot = the device\'s "Sample N" minus 1 (Sample 3 = slot 2). The step must already be a ' +
    'hit (a flip on a rest is reported and ignored). get_preset surfaces sample_flips per drum track for ' +
    'read-modify-write. CONSTRAINT: one sample per STEP, so two pieces that must sound on the SAME step still ' +
    'need two tracks; pieces that never collide on a step pack onto one track losslessly. Encoding: ' +
    'drum_choice = absolute sample slot 0..63, 0xFF = no flip (hardware-confirmed both directions 2026-06-22).',
});
