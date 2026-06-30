/**
 * Gen-3 block & parameter help catalog (shared across Axe-Fx III / FM3 /
 * FM9 / VP4). HAND-WRITTEN, factual, paraphrased tooltip copy — original
 * wording describing what each block/param does and its audible effect.
 * It is NOT a copy of any vendor manual; device-specific notes live in the
 * per-device override files and are merged via `resolveHelp`.
 *
 * Keys: block = param-family symbol (`'DISTORT'` = Amp, `'FUZZ'` = Drive,
 * `'CABINET'` = Cab, …); param = the editor symbol `Param.name`.
 *
 * Common tail params (LEVEL/PAN/BYPASS/MIX/BYPASSMODE) recur on nearly
 * every block; their generic meaning is described once in
 * `GEN3_COMMON_PARAM_HELP` and applied as a fallback by `blockHelpFor`.
 */
import type { BlockHelpEntry, HelpCatalog, ParamHelp } from './helpTypes.js';

/**
 * Family-agnostic help for the mix/level/bypass tail that appears on most
 * blocks (param names share a stem, e.g. `REVERB_LEVEL`, `DELAY_MIX`). A
 * consumer can fall back to these by stripping the family prefix off a
 * `Param.name`. Block-specific overrides in `GEN3_HELP` win.
 */
export const GEN3_COMMON_PARAM_HELP: Readonly<Record<string, ParamHelp>> = {
  LEVEL: { blurb: 'Output level of the block.' },
  PAN: { blurb: 'Places the block output in the stereo field.' },
  BALANCE: { blurb: 'Pans wet and dry together across the stereo field.' },
  MIX: { blurb: 'Wet/dry blend. 0% = dry only, 100% = effect only.' },
  GLOBALMIX: { blurb: 'Adds a global offset to this block’s Mix across all presets.' },
  BYPASS: { blurb: 'Engages or bypasses the block.' },
  BYPASSMODE: {
    blurb: 'How the signal is routed when bypassed (e.g. muted, thru, or kept wet for trails).',
  },
  KILLDRY: { blurb: 'Removes the dry signal so only the wet effect is heard — useful in parallel/wet-only routings.' },
  INPUTSELECT: { blurb: 'Selects which input(s) feed the block (left, right, sum, or stereo).' },
  GAIN: { blurb: 'Input gain into the block.' },
  SCENEIGNORE: { blurb: 'When on, this block ignores scene changes.' },
};

/**
 * The shared gen-3 help catalog. Add families here; flag device-specific
 * differences in the per-device override files instead of duplicating.
 */
export const GEN3_HELP: HelpCatalog = {
  // ── AMP ───────────────────────────────────────────────────────────────
  // The amp tone-stack is addressed under the DISTORT family on gen-3.
  DISTORT: {
    block: {
      summary: 'Tube amp modeler. Component-level models of 280+ vintage and modern guitar/bass amps; the heart of your tone.',
      detail: 'Works hand-in-hand with the Cab block. The Tone page covers the everyday "authentic" controls; deeper pages expose preamp, power amp, EQ and dynamics tweaks.',
    },
    params: {
      DISTORT_TYPE: {
        blurb: 'Selects the amp model. Each type also recalls sensible default settings for the rest of the block.',
        tip: 'Browse alphabetically with VALUE/NAV — no ENTER needed.',
      },
      DISTORT_DRIVE: {
        blurb: 'Preamp gain. Sets how clean or distorted the amp is; with Master, defines the overall drive character.',
      },
      DISTORT_BASS: { blurb: 'Low-end tone control, modeling the amp’s passive tonestack.' },
      DISTORT_MID: { blurb: 'Midrange tone control of the modeled tonestack.' },
      DISTORT_TREBLE: { blurb: 'High-end tone control of the modeled tonestack.' },
      DISTORT_MASTER: {
        blurb: 'Power-amp drive. Higher settings add power-tube distortion, bloom and touch sensitivity.',
        tip: 'On clean-power amps, too-high Master is a common cause of mush — watch the Headroom meter.',
      },
      DISTORT_TRIM: {
        blurb: 'Adds or removes gain without changing tone — unlike Drive, it doesn’t interact with the surrounding circuit.',
      },
      DISTORT_XDRIVE: { blurb: 'Overdrive gain stage (only on amps that model one).' },
      DISTORT_PRESENCE: { blurb: 'Power-amp high-end via negative-feedback shaping; adds top-end edge.' },
      DISTORT_DEPTH: { blurb: 'Power-amp low-end boost via negative-feedback shaping; adds low thump.' },
      DISTORT_BRIGHT: { blurb: 'Bright switch — a treble lift that is strongest at low gain.' },
      DISTORT_BRIGHTCAP: { blurb: 'Sets the bright-cap value that controls how much top end the Bright switch adds.' },
      DISTORT_BOOST: { blurb: 'Built-in clean boost into the amp — adds gain without a separate Drive block.' },
      DISTORT_SATSWITCH: { blurb: 'Engages a preamp saturation mod for thicker, more aggressive distortion.' },
      DISTORT_CUT: { blurb: 'Trims low frequencies into the amp to tighten the tone and reduce flub.' },
      DISTORT_SUPPLYSAG: { blurb: 'Power-supply sag — how much the virtual rails dip under load, affecting compression and feel.' },
      DISTORT_MVCAP: { blurb: 'Bright-cap across the Master Volume; affects brightness as Master changes.' },
      DISTORT_HPFREQ: { blurb: 'Input low-cut frequency — a classic way to tighten an amp.' },
      DISTORT_LPFREQ: { blurb: 'High-cut placed between preamp and power amp; darkens distorted tone strongly.' },
    },
  },

  // ── CAB ───────────────────────────────────────────────────────────────
  CABINET: {
    block: {
      summary: 'Speaker cabinet sim using impulse responses (IRs), with mic, room, air and proximity modeling.',
      detail: 'Legacy mode picks from IR banks; DynaCab mode lets you choose a cab and mic and dial in position/distance visually.',
    },
    params: {
      CABINET_MODE: { blurb: 'Switches between Legacy IR-bank mode and the visual DynaCab cab/mic system.' },
      CABINET_DRIVE: { blurb: 'Virtual mic-preamp gain. Push it for warm to nasty preamp distortion.' },
      CABINET_BIAS: { blurb: 'Preamp saturation — the even/odd harmonic balance of the mic-preamp distortion.' },
      CABINET_LEVEL: { blurb: 'Master output level of the whole Cab block (on the Mix page).' },
      // Per-IR slot controls (1..4); slots 3-4 absent on FM3/FM9 (see overrides).
      CABINET_LEVEL1: {
        blurb: 'Relative level of IR 1 in the blend. With a single IR loaded it has no effect.',
        tip: 'Cab levels balance the mix; use the Mix-page Level for overall volume.',
      },
      CABINET_PAN1: { blurb: 'Stereo position of IR 1 in the cab mix.' },
      CABINET_PROXIMITY1: { blurb: 'Proximity effect for IR 1 — adds low end as the virtual mic moves closer.' },
      CABINET_DELAY1: { blurb: 'Mic distance for IR 1 (mm); the sub-ms delay creates inter-mic phase effects.' },
      CABINET_MUTE1: { blurb: 'Mutes IR 1. A muted IR uses no CPU — handy to save processing.' },
      CABINET_SMOOTH1: { blurb: 'Smooths out the peaks and notches of a mic’d IR for a more "in the room" feel.' },
    },
  },

  // ── DELAY ─────────────────────────────────────────────────────────────
  DELAY: {
    block: {
      summary: 'Echo effect — digital, analog, tape, ping-pong, reverse, ducking and more, with feedback EQ, modulation and diffusion.',
      detail: 'The Type page recalls a complete delay flavor in one move; the Config/EQ/Mod pages refine it.',
    },
    params: {
      DELAY_TYPE: { blurb: 'Picks a delay flavor (Digital, Analog, Tape, Ping-Pong, Reverse, Ducking, etc.), setting many params at once.' },
      DELAY_TIME: {
        blurb: 'Delay time in ms. Shown in parentheses when driven by Tempo sync.',
        tip: 'Set Tempo to NONE to regain manual control of Time.',
      },
      DELAY_TEMPO: { blurb: 'Syncs delay time to the tempo as a note value (e.g. 1/4). Set NONE to ignore tempo.' },
      DELAY_FEED: {
        blurb: 'Feedback (regeneration) — the number of repeats. Negative values invert phase in the loop.',
      },
      DELAY_MSTRFDBK: { blurb: 'Master feedback scaler (0–200%); above 100% it easily self-oscillates.' },
      DELAY_DRIVE: { blurb: 'Distortion in the delay path — simulates a tape/analog delay overdriving as repeats stack up.' },
      DELAY_LOCUT: { blurb: 'Low-cut filter in the feedback path; thins repeats and curbs low-end buildup.' },
      DELAY_HICUT: { blurb: 'High-cut filter in the feedback path; darkens successive repeats, tape-style.' },
      DELAY_DIFFUSE: { blurb: 'Smears the repeats for a softer, reverb-like delay.' },
      DELAY_HOLD: { blurb: 'HOLD freezes the current repeats (looper-like); STACK keeps the input open to layer over them.' },
      DELAY_SPREAD: { blurb: 'Master pan / stereo spread of the delay output.' },
    },
  },

  // ── REVERB ────────────────────────────────────────────────────────────
  REVERB: {
    block: {
      summary: 'Reverb — halls, rooms, chambers, plates, springs and more, with multi-band decay, EQ, ducking, modulation and pitch.',
      detail: 'Type recalls a mix-ready space instantly; the Basic/EQ/Advanced pages tailor decay, tone and character.',
    },
    params: {
      REVERB_TYPE: { blurb: 'Selects the space — Hall, Room, Chamber, Cathedral, Plate, Spring and more.' },
      REVERB_TIME: { blurb: 'Decay (t60) time — how long the tail takes to fade out.' },
      REVERB_PREDELAY: { blurb: 'Gap before the reverb starts; keeps a small space yet pushes the tail back from the dry signal.' },
      REVERB_SIZE: {
        blurb: 'Size of the modeled space. Larger spaces are darker and grainier; very small values turn metallic.',
      },
      REVERB_LFXOVER: { blurb: 'Crossover frequency splitting the low/high decay bands.' },
      REVERB_LFTIME: { blurb: 'Decay time of the low band — set independently for natural multi-band tails.' },
      REVERB_HFRATIO: { blurb: 'High-band decay relative to overall time; shorten it to model an absorptive room.' },
      REVERB_EARLYLEVEL: { blurb: 'Level of the early reflections (no effect on Spring types).' },
      REVERB_REVERBLEVEL: { blurb: 'Level of the reverb tail.' },
      REVERB_LOWCUT: { blurb: 'Low-cut on the wet signal only — keeps the reverb from muddying the mix.' },
      REVERB_HICUT: { blurb: 'High-cut on the wet signal only — darkens the reverb without dulling the dry tone.' },
      REVERB_DENSITY: { blurb: 'Echo density of the tail. Higher = smoother; lower lets individual repeats show.' },
      REVERB_DEPTH: { blurb: 'Modulation depth in the tail — thickens and lushes up the reverb, chorus-like.' },
      REVERB_RATE: { blurb: 'Modulation rate of the tail movement.' },
      REVERB_HOLD: { blurb: 'HOLD sustains the current tail indefinitely; STACK holds it but keeps the input open to layer.' },
      REVERB_DRIVE: { blurb: 'Overdrives the spring-reverb circuit (Spring types).' },
      REVERB_ATTEN: { blurb: 'Ducker depth — how much the reverb dips while you play. 0 disables ducking.' },
      REVERB_THRESH: { blurb: 'Input level above which the ducker attenuates the reverb.' },
    },
  },

  // ── DRIVE (overdrive / distortion / fuzz pedals) ───────────────────────
  // The Drive block is addressed under the FUZZ family on gen-3.
  FUZZ: {
    block: {
      summary: 'Overdrive / distortion / fuzz pedals — 55+ models from clean boost to extreme gain, with tone and EQ shaping.',
      detail: 'Boost types push an amp without much distortion of their own; OD/distortion/fuzz types add their own clipping character.',
    },
    params: {
      FUZZ_TYPE: { blurb: 'Selects the pedal model — boost, overdrive, distortion or fuzz, each with its own clipping voice.' },
      FUZZ_DRIVE: { blurb: 'Gain into the clipping stage — how hard the pedal distorts.' },
      FUZZ_DRIVE2: { blurb: 'Secondary drive control on models that have two gain stages.' },
      FUZZ_TONE: { blurb: 'The pedal’s tone control — tilts the balance from dark to bright.' },
      FUZZ_BASS: { blurb: 'Low-end EQ (±12 dB).' },
      FUZZ_MID: { blurb: 'Midrange EQ (±12 dB); Mid Frequency sets where it acts.' },
      FUZZ_MIDFREQ: { blurb: 'Center frequency of the Mid EQ.' },
      FUZZ_HIMID: { blurb: 'Upper-midrange EQ (±12 dB).' },
      FUZZ_TREBLE: { blurb: 'High-end EQ (±12 dB).' },
      FUZZ_LOCUT: { blurb: 'Input high-pass — raise it to tighten the low end and cut flub.' },
      FUZZ_HICUT: { blurb: 'Output low-pass — lower it for a darker, smoother sound.' },
      FUZZ_CLIPTYPE: { blurb: 'The modeled clipping circuit (diode, FET, LED, tube, op-amp, etc.) — shapes the distortion character.' },
      FUZZ_CLIPSHAPE: { blurb: 'On the Variable clip type, dials from a smooth, focused tone to a harder, brasher one.' },
      FUZZ_BIAS: { blurb: 'Clipping bias — shifts the even/odd harmonic balance; extremes give a gated, sputtery tone.' },
      FUZZ_SLEW: { blurb: 'Slew-rate limit — emulates the rolled-off highs of early op-amp pedals.' },
      FUZZ_BITREDUCE: { blurb: 'Lo-fi digital grit by reducing bit depth (bits subtracted from 24-bit).' },
      FUZZ_RESAMPLE: { blurb: 'Sample-rate reduction for gritty aliasing distortion.' },
      FUZZ_DRYGAIN: { blurb: 'Dry signal blended into the wet (added before tone controls); Tube-Screamer types default high.' },
    },
  },

  // ── COMPRESSOR ─────────────────────────────────────────────────────────
  COMP: {
    block: {
      summary: 'Compressor — evens out level and adds sustain. Pedal and studio (FF/FB/optical/tube) models with sidechain.',
      detail: 'Downward types tame loud peaks; "sustainer" types lift quiet parts. Sidechain filtering helps avoid pumping.',
    },
    params: {
      COMP_TYPE: { blurb: 'Selects the compressor model — pedal, studio FF/FB, optical, JFET, tube, etc.' },
      COMP_THRESH: { blurb: 'Level at which compression kicks in (above it for downward types, below it for sustainers).' },
      COMP_RATIO: { blurb: 'How hard it compresses above threshold. Higher = less dynamics; INFINITE acts as a limiter.' },
      COMP_SUSTAIN: { blurb: 'How much compression/sustain is applied on pedal-style types.' },
      COMP_DYNAMICS: { blurb: 'Below 0 compresses, above 0 expands — one knob for the Dynamics Processor type.' },
      COMP_ATTACK: { blurb: 'How fast gain reduction engages. Fast catches peaks; slow lets transients punch through.' },
      COMP_RELEASE: { blurb: 'How fast gain returns to normal. Fast for percussive material; slow for smooth leveling.' },
      COMP_AUTO: { blurb: 'Auto attack/release — adapts times to transients to reduce pumping.' },
      COMP_KNEE: { blurb: 'Soft knee eases compression in gradually (more transparent); hard knee is abrupt.' },
      COMP_DELAYTIME: { blurb: 'Look-ahead delay so the detector catches the fastest transients (adds latency).' },
      COMP_PEAKRMS: { blurb: 'Detector mode: PEAK (fast, punchy), RMS (smooth), or both.' },
      COMP_LIGHTTYPE: { blurb: 'Optical-type light element — changes the compressor’s response feel.' },
      COMP_SIDECHAIN: { blurb: 'Detector source — block input, a specific row, or a physical input (for ducking/de-essing).' },
      COMP_LOWCUT: { blurb: 'Low-cut on the detector signal only — stops thumpy lows from triggering pumping.' },
      COMP_HIGHCUT: { blurb: 'High-cut on the detector signal only.' },
      COMP_EMPHASIS: { blurb: 'High-shelf on the detector to curb low-frequency-driven pumping.' },
    },
  },

  // ── CHORUS ─────────────────────────────────────────────────────────────
  CHORUS: {
    block: {
      summary: 'Chorus — modulated delayed copies for a lush, dimensional shimmer; can reach vibrato and Leslie-like effects.',
      detail: 'Two voices for vintage chorus; up to eight for a thick ensemble. Includes tape, dimension and tri-chorus modes.',
    },
    params: {
      CHORUS_TYPE: { blurb: 'Selects a chorus flavor (digital, analog/BBD, tape, dimension, tri-chorus, etc.).' },
      CHORUS_VOICES: { blurb: 'Number of delay voices. More voices = fuller, more ensemble-like.' },
      CHORUS_RATE: { blurb: 'Modulation speed. Low rate + high depth = slow swirl; high rate = vibrato.' },
      CHORUS_TEMPO: { blurb: 'Syncs the rate to the tempo as a note value. NONE for manual.' },
      CHORUS_DEPTH: { blurb: 'Modulation depth — how much detune each voice has.' },
      CHORUS_DELAYTIME: { blurb: 'Base delay time (0.01–50 ms). Low = singular; high approaches slapback.' },
      CHORUS_DRIVE: { blurb: 'Simulated BBD-chip overdrive for vintage analog grit. 0 = clean.' },
      CHORUS_WIDTH: { blurb: 'Widens the sound by offsetting the right-channel delay time.' },
      CHORUS_SPREAD: { blurb: 'Stereo width, from mono (0%) to hard-panned and beyond (psychoacoustic to ±200%).' },
      CHORUS_LFOTYPE: { blurb: 'Modulation waveform shape (sine/triangle most common).' },
      CHORUS_LFOPHASE: { blurb: 'Left/right LFO phase offset — wider detune difference between channels.' },
      CHORUS_AUTO: { blurb: 'Auto-depth scales depth for a consistent effect at any rate. Off for more depth/wild sounds.' },
      CHORUS_LOWCUT: { blurb: 'High-pass on the wet signal — removes bass (good for bass-guitar chorus).' },
      CHORUS_HICUT: { blurb: 'Low-pass on the wet signal — a darker, "warmer" chorus.' },
    },
  },

  // ── FLANGER ────────────────────────────────────────────────────────────
  FLANGER: {
    block: {
      summary: 'Flanger — a swept comb filter from subtle whoosh to jet-plane sweep; feedback intensifies the resonant character.',
      detail: 'Built on a very short modulated delay. Negative feedback gives a hollow, vocal tone; Thru-Zero models tape flanging.',
    },
    params: {
      FLANGER_TYPE: { blurb: 'Selects a flanger flavor (analog, digital, thru-zero, vintage rack, etc.).' },
      FLANGER_RATE: { blurb: 'LFO sweep speed. Low rate + high depth = slow sweep; high rate = vibrato.' },
      FLANGER_TEMPO: { blurb: 'Syncs the sweep rate to the tempo. NONE for manual.' },
      FLANGER_DEPTH: { blurb: 'Sweep depth. At 0 the Manual knob controls the sweep; at max the LFO fully drives it.' },
      FLANGER_FEEDBACK: { blurb: 'Regeneration (±). Sharpens the resonant sweep; negative inverts phase for a hollow tone.' },
      FLANGER_MANUAL: { blurb: 'Manually sets the delay time so you can sweep by hand (set Depth to 0).' },
      FLANGER_DRIVE: { blurb: 'Simulated BBD-chip overdrive for vintage analog grit. 0 = clean.' },
      FLANGER_THRUZERO: { blurb: 'Thru-Zero mode — sweeps past the zero point for dramatic tape-style cancellation.' },
      FLANGER_HPFREQ: { blurb: 'High-pass on the wet signal — rolls off lows.' },
      FLANGER_LPFREQ: { blurb: 'Low-pass on the wet signal — rolls off highs.' },
      FLANGER_SPREAD: { blurb: 'Stereo width, from mono (0%) to hard-panned and beyond (to ±200%).' },
      FLANGER_LFOTYPE: { blurb: 'Modulation waveform shape.' },
      FLANGER_LFOPHASE: { blurb: 'Left/right LFO phase offset — 180° for max stereo, 0° for mono.' },
    },
  },

  // ── PHASER ─────────────────────────────────────────────────────────────
  PHASER: {
    block: {
      summary: 'Phaser — cascaded all-pass stages create swept notches for a watery, airy swoosh; no pitch modulation.',
      detail: '2–12 stages and ± feedback give subtle to extreme phasing; a Vibe mode models the Uni-Vibe.',
    },
    params: {
      PHASER_TYPE: { blurb: 'Selects a phaser flavor (script/block, vibe, barberpole, etc.).' },
      PHASER_RATE: { blurb: 'LFO sweep speed.' },
      PHASER_TEMPO: { blurb: 'Syncs the sweep rate to the tempo. NONE for manual.' },
      PHASER_DEPTH: { blurb: 'Sweep depth. 0 hands control to the Manual knob.' },
      PHASER_FEEDBACK: { blurb: 'Regeneration — how pronounced the peaks/notches are; the core of the phaser sound.' },
      PHASER_MANUAL: { blurb: 'Manually sweeps the phaser across its range (set Depth to 0).' },
      PHASER_ORDER: { blurb: 'Number of phase stages (in twos). More stages = more pronounced effect.' },
      PHASER_FBTAP: { blurb: 'Where in the stage chain feedback is taken from — changes the character.' },
      PHASER_TONE: { blurb: 'Simple tone control on the wet signal.' },
      PHASER_FMIN: { blurb: 'Lowest frequency of the sweep range.' },
      PHASER_FMAX: { blurb: 'Highest frequency of the sweep range.' },
      PHASER_LFOTYPE: { blurb: 'Modulation waveform shape.' },
      PHASER_LFOPHASE: { blurb: 'Left/right LFO phase offset for stereo phasing (180° = classic Bi-Phase).' },
    },
  },

  // ── PITCH ──────────────────────────────────────────────────────────────
  PITCH: {
    block: {
      summary: 'Pitch shifter — detune, chromatic/diatonic shift, whammy, octaver, harmonizer, arpeggiator and virtual capo.',
      detail: 'Up to four voices with per-voice shift, delay and feedback; intelligent types shift in key.',
    },
    params: {
      PITCH_TYPE: { blurb: 'Selects the pitch effect (detune, chromatic/diatonic shift, whammy, octave divider, arpeggiator, capo…).' },
      PITCH_SHIFT1: { blurb: 'Shift amount of voice 1 (semitones, or scale degrees on intelligent types).' },
      PITCH_SHIFT2: { blurb: 'Shift amount of voice 2.' },
      PITCH_DETUNE1: { blurb: 'Fine detune of voice 1 (cents) for thickening/chorus effects.' },
      PITCH_KEY: { blurb: 'Key for intelligent (diatonic) shifting.' },
      PITCH_SCALE: { blurb: 'Scale used for intelligent shifting.' },
      PITCH_DELAY1: { blurb: 'Delay before voice 1 is heard (for echo/harmony effects).' },
      PITCH_FEEDBACK1: { blurb: 'Feedback for voice 1 — repeats; with shift inside the loop, pitch climbs each repeat.' },
      PITCH_TRACKING: { blurb: 'Pitch-detection tracking — tune for your instrument/playing for cleaner shifting.' },
      PITCH_GLIDE: { blurb: 'Glide/portamento time when the shift amount changes (e.g. whammy).' },
    },
  },

  // ── WAH ────────────────────────────────────────────────────────────────
  WAH: {
    block: {
      summary: 'Wah — a swept resonant filter, classically pedal-controlled. Before drive for a vocal wah, after for a synthy sweep.',
    },
    params: {
      WAH_TYPE: { blurb: 'Selects a wah model based on classic and modern pedals.' },
      WAH_CONTROL: { blurb: 'Wah position. Usually assigned to a pedal; can also be parked or LFO-driven.' },
      WAH_FSTART: { blurb: 'Filter frequency at the heel-down (lowest) position.' },
      WAH_FSTOP: { blurb: 'Filter frequency at the toe-down (highest) position.' },
      WAH_Q: { blurb: 'Resonance of the filter — higher is more pronounced and peaky.' },
      WAH_TRACK: { blurb: 'Q tracking — reduces resonance as the pedal opens, like some vintage wahs.' },
      WAH_TAPER: { blurb: 'Pedal sweep feel, modeling different potentiometer tapers.' },
      WAH_DRIVE: { blurb: 'Overdrives the modeled wah circuit.' },
      WAH_BIAS: { blurb: 'Inductor DC bias — interacts with Drive to nail coveted wah tones.' },
      WAH_HPF: { blurb: 'Low-cut from the modeled coupling capacitor.' },
    },
  },

  // ── GATE / EXPANDER ────────────────────────────────────────────────────
  GATE: {
    block: {
      summary: 'Noise gate / expander — quiets the signal below a threshold to kill hiss and hum between notes.',
      detail: 'Expander modes attenuate gently by ratio; gate modes clamp by a fixed amount. Sidechain filtering enables ducking/de-essing.',
    },
    params: {
      GATE_TYPE: { blurb: 'Classic or Modern Gate/Expander. Modern Gate has a slower, swell-friendly attack.' },
      GATE_THRESH: { blurb: 'Level below which the gate/expander reduces volume — set just above your noise floor.' },
      GATE_RATIO: { blurb: 'Expander types: how much quieter signals below threshold become.' },
      GATE_RANGE: { blurb: 'Gate types: how much the signal is attenuated when the gate is closed (dB).' },
      GATE_ATTACK: { blurb: 'How fast the gate opens. Low lets your first note punch through; high gives a slow swell.' },
      GATE_RELEASE: { blurb: 'How fast the gate closes after the signal drops — slow for natural decay, fast to cut noise.' },
      GATE_HOLD: { blurb: 'How long the gate stays open after the signal crosses threshold.' },
      GATE_KEY: { blurb: 'Sidechain source — use a row/input to turn the gate into a ducker or de-esser.' },
      GATE_LOWCUT: { blurb: 'Low-cut on the detector signal only (doesn’t affect output tone).' },
      GATE_HICUT: { blurb: 'High-cut on the detector signal only.' },
      GATE_PEAKRMS: { blurb: 'Detector mode — PEAK (fast) or RMS (smooth).' },
    },
  },

  // ── GRAPHIC EQ ─────────────────────────────────────────────────────────
  GEQ: {
    block: {
      summary: 'Graphic EQ — fixed-frequency bands, each boost/cut up to ±12 dB. Simple, precise tone sculpting.',
    },
    params: {
      GEQ_TYPE: { blurb: 'Number of bands and behavior (10/8/7/5-band, plus passive console/Mark/JMP-1 types).' },
      GEQ_MASTERQ: { blurb: 'Bandwidth of all bands at once. <1 broadens and overlaps; >1 narrows each band.' },
      GEQ_GAIN1: { blurb: 'Boost/cut for the lowest band (±12 dB).' },
      GEQ_GAIN10: { blurb: 'Boost/cut for the highest band (±12 dB).' },
    },
  },

  // ── PARAMETRIC EQ ──────────────────────────────────────────────────────
  PEQ: {
    block: {
      summary: '5-band parametric EQ — sweepable frequency, Q and gain per band for precise, surgical tone shaping.',
    },
    params: {
      PEQ_TYPE1: { blurb: 'Band 1 filter type (shelving, peaking, blocking/cut).' },
      PEQ_FREQ1: { blurb: 'Center/cutoff frequency of band 1.' },
      PEQ_Q1: { blurb: 'Bandwidth of band 1 — low is broad and gentle, high is narrow and surgical.' },
      PEQ_GAIN1: { blurb: 'Boost/cut of band 1 (±12 dB), or slope when set to Blocking.' },
      PEQ_SOLO1: { blurb: 'Solos band 1 so you can hear its effect in isolation.' },
    },
  },

  // ── TREMOLO / PANNER ───────────────────────────────────────────────────
  TREMOLO: {
    block: {
      summary: 'Tremolo / panner — rhythmically pulses volume (tremolo) or sweeps it across the stereo field (panner).',
      detail: 'Bias and Harmonic trem model classic tube-amp circuits and may add their own gentle distortion.',
    },
    params: {
      TREMOLO_TYPE: { blurb: 'Tremolo, Panner, Bias Trem, Harmonic Trem or Optical Trem.' },
      TREMOLO_RATE: { blurb: 'Speed of the volume/pan pulsing.' },
      TREMOLO_TEMPO: { blurb: 'Syncs the rate to the tempo. NONE for manual.' },
      TREMOLO_DEPTH: { blurb: 'Effect intensity. On the panner, above 100% pans beyond the normal stereo image.' },
      TREMOLO_WIDTH: { blurb: 'Panner width — above 100% widens beyond the normal stereo image.' },
      TREMOLO_LFOTYPE: { blurb: 'Modulation waveform shape.' },
      TREMOLO_DUTY: { blurb: 'Waveform symmetry / duty cycle — changes the pulse contour.' },
      TREMOLO_PHASE: { blurb: 'Left/right LFO phase — 0° for true tremolo, 180° for full panning.' },
      TREMOLO_STARTPHASE: { blurb: 'Forces the cycle to start at a fixed point when engaged.' },
      TREMOLO_THRESH: { blurb: 'Restarts the cycle when you start playing, syncing the trem to your attack. OFF = free-running.' },
      TREMOLO_CENTER: { blurb: 'Panner only — shifts the apparent center of the stereo image.' },
    },
  },

  // ── ROTARY ─────────────────────────────────────────────────────────────
  ROTARY: {
    block: {
      summary: 'Rotary speaker — models a Leslie’s spinning horn and drum for that swirling, 3D organ/guitar sound.',
    },
    params: {
      ROTARY_RATE: { blurb: 'Spin speed of horn and drum. Set 0 to "park"; assign a modifier for slow/fast switching.' },
      ROTARY_TEMPO: { blurb: 'Syncs the spin rate to the tempo. NONE for manual.' },
      ROTARY_DRIVE: { blurb: 'Overdrives the virtual rotary amp for classic grit.' },
      ROTARY_HFDEPTH: { blurb: 'Horn (high) modulation depth. Reduce fully to simulate a drum-only cabinet.' },
      ROTARY_HFLEVEL: { blurb: 'Horn output level — balances horn against drum.' },
      ROTARY_LFDEPTH: { blurb: 'Drum (low) modulation depth — more = a stronger throb.' },
      ROTARY_HFLENGTH: { blurb: 'Virtual horn length — longer adds more Doppler shift and intensity.' },
      ROTARY_LOWRATE: { blurb: 'Drum speed relative to the horn.' },
      ROTARY_SPREAD: { blurb: 'Stereo width, from mono (0%) to wide and beyond (to ±200%).' },
      ROTARY_MICDIST: { blurb: 'Virtual mic distance from the cabinet.' },
    },
  },

  // ── RING MODULATOR ─────────────────────────────────────────────────────
  RINGMOD: {
    block: {
      summary: 'Ring modulator — amplitude modulation creates clangorous, inharmonic, metallic and sci-fi tones.',
      detail: 'The oscillator can track your pitch for musically predictable results across the neck.',
    },
    params: {
      RINGMOD_TYPE: { blurb: 'Classic or single-sideband ring modulation.' },
      RINGMOD_COARSE: { blurb: 'Modulator frequency — sets the inharmonic pitch of the effect.' },
      RINGMOD_FINE: { blurb: 'Fine adjustment of the modulator frequency.' },
      RINGMOD_PD_RANGE: { blurb: 'Frequency multiplier (0.25–4×) scaling the modulator frequency.' },
      RINGMOD_TRACK: { blurb: 'Pitch tracking — the modulator follows your played notes for a musical effect.' },
      RINGMOD_HICUT: { blurb: 'Low-pass to tame the harsh highs of the ring-mod output.' },
    },
  },

  // ── FILTER ─────────────────────────────────────────────────────────────
  FILTER: {
    block: {
      summary: 'Filter — a versatile stereo EQ/filter (lowpass, shelf, peaking, comb, allpass…) with an optional sweep LFO.',
    },
    params: {
      FILTER_TYPE: { blurb: 'Filter type — lowpass, highpass, bandpass, shelf, peaking, notch, comb, allpass, tilt, etc.' },
      FILTER_FREQ: { blurb: 'Center/cutoff frequency.' },
      FILTER_ORDER: { blurb: 'Slope — 2nd order = 12 dB/oct, 4th = 24 dB/oct (steeper, more "squelchy").' },
      FILTER_Q: { blurb: 'Resonance/bandwidth — higher is sharper.' },
      FILTER_GAIN: { blurb: 'Boost/cut at the center frequency (shelf/peaking types).' },
      FILTER_LOWCUT: { blurb: 'Extra first-order low-cut for tone shaping.' },
      FILTER_HICUT: { blurb: 'Extra first-order high-cut for tone shaping.' },
      FILTER_LFOENABLE: { blurb: 'Enables the sweep LFO for auto-filter effects.' },
      FILTER_LFOFREQ: { blurb: 'Sweep LFO rate.' },
      FILTER_MODFREQ: { blurb: 'The other end of the LFO sweep range (Frequency sets the first end).' },
    },
  },

  // ── FORMANT ────────────────────────────────────────────────────────────
  FORMANT: {
    block: {
      summary: 'Formant filter — vowel/talk-box effect using resonant peaks; can morph between three vowels.',
      detail: 'Often sounds best after distortion. Stereo in/out, processed per channel.',
    },
    params: {
      FORMANT_TYPE: { blurb: 'Sets how the start/mid/end vowels are blended.' },
    },
  },

  // ── MULTIBAND COMPRESSOR ───────────────────────────────────────────────
  MULTICOMP: {
    block: {
      summary: 'Multiband compressor — splits the signal into bands so each frequency range is compressed independently.',
    },
    params: {
      MULTICOMP_FREQ1: { blurb: 'Crossover frequency between band 1 and band 2.' },
      MULTICOMP_FREQ2: { blurb: 'Crossover frequency between band 2 and band 3.' },
      MULTICOMP_THRESH1: { blurb: 'Compression threshold for the low band.' },
      MULTICOMP_RATIO1: { blurb: 'Compression ratio for the low band.' },
      MULTICOMP_ATTACK1: { blurb: 'Attack time for the low band.' },
      MULTICOMP_RELEASE1: { blurb: 'Release time for the low band.' },
      MULTICOMP_LEVEL1: { blurb: 'Make-up level for the low band.' },
      MULTICOMP_MUTE1: { blurb: 'Mutes the low band — handy for soloing other bands.' },
    },
  },
};

/**
 * Resolve a block's help by family symbol, with the common mix/level/bypass
 * tail filled in for any param the block-specific catalog doesn't cover.
 * Returns `undefined` if the family has no entry at all.
 *
 * @param family param-family symbol, e.g. `'REVERB'`.
 * @param paramNames optional `Param.name[]` to expand the common tail for.
 */
export function blockHelpFor(
  catalog: HelpCatalog,
  family: string,
  paramNames?: readonly string[],
): BlockHelpEntry | undefined {
  const entry = catalog[family];
  if (!entry) return undefined;
  if (!paramNames || paramNames.length === 0) return entry;
  const params: Record<string, ParamHelp> = { ...entry.params };
  const prefix = `${family}_`;
  for (const name of paramNames) {
    if (params[name]) continue;
    const stem = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    const common = GEN3_COMMON_PARAM_HELP[stem];
    if (common) params[name] = common;
  }
  return { block: entry.block, params };
}
