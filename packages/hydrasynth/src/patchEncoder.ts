/**
 * Hydrasynth patch byte-map encoder/decoder.
 *
 * The Hydrasynth's whole-patch SysEx dump is a 2790-byte buffer split
 * across 22 chunks (21 × 128-byte chunks + a final 102-byte chunk),
 * sent as a sequence of `wrapSysex([0x16, 0x00, CHUNK, 0x16, …data…])`
 * messages. Every patch parameter sits at a fixed byte offset
 * documented in
 * `docs/devices/hydrasynth-explorer/references/SysexPatchFormat.txt`
 * (edisyn, Sean Luke).
 *
 * This module owns three concerns:
 *
 *   1. **Byte-level encoding** — read/write a parameter at its
 *      documented offset using one of four encodings: `u16le` (low/high
 *      byte pair, unsigned 0..65535), `s16le` (signed 16-bit
 *      little-endian, used by params that store negative values across
 *      both bytes), `u8` (single unsigned byte at the LSB position with
 *      the MSB position left as-is), and `s8` (single signed byte with
 *      sign-extension into the MSB position — `0xFF` for negative).
 *
 *   2. **Curated NRPN-name → offset map** — `PATCH_OFFSETS`. Hand-picked
 *      ~30 high-impact first-page params (oscillators, mixer, filter,
 *      amp, env1, FX dry/wet) so the encoder can take a sparse
 *      `Map<canonicalName, value>` and apply it on top of a base
 *      buffer. Future sessions extend this table; the format spec
 *      enumerates ~1000 params and we don't need them all on day one.
 *
 *   3. **Wire-chunking** — `splitIntoChunks(buf)` slices the 2790-byte
 *      buffer into the 22 chunks the device expects, framed with the
 *      `[0x16, 0x00, CHUNK, 0x16]` chunk-dump header. Each chunk is
 *      then `wrapSysex`'d at the call site to produce final F0…F7
 *      messages.
 *
 * Two invariants this module relies on the spec to hold:
 *
 *   - The patch buffer is exactly 2790 bytes (21 × 128 + 102). Asserted
 *     in `splitIntoChunks` / `concatChunks`.
 *   - The first 8 bytes are device metadata (Save-to-RAM marker, bank,
 *     patch number, version, etc.) — included in chunk 0 but not part
 *     of the audible patch. They're documented as fixed at known
 *     values: byte 1 = 0x00, byte 4 = version (0xC8 for 2.0.0). The
 *     encoder doesn't enforce these — callers preparing a fresh patch
 *     buffer set them up front.
 *
 * Goldens for this module live in `scripts/hydrasynth/verify-sysex-patch.ts`.
 */
import { HYDRASYNTH_NRPNS, type HydrasynthNrpn } from './nrpn.js';
import { INIT_PATCH_BUFFER } from './initPatchBuffer.js';

/** The full Hydrasynth patch buffer is 2790 bytes (21×128 + 102). */
export const PATCH_BUFFER_SIZE = 2790;

/** Standard chunk size for chunks 0..20 (21 chunks). */
export const PATCH_CHUNK_SIZE = 128;

/** Final chunk (chunk 21) is shorter — 102 bytes. */
export const PATCH_LAST_CHUNK_SIZE = 102;

/** Number of chunks per patch dump (21 full + 1 short = 22). */
export const PATCH_CHUNK_COUNT = 22;

/** Patch-buffer offsets for the eight-byte metadata header. */
export const PATCH_META = {
  /** byte 0: 0x06 = "Save to RAM" marker per spec. */
  saveMarker: 0,
  /** byte 1: always 0x00. */
  reserved1: 1,
  /** byte 2: bank number (A=0..H=7 on hardware; spec table allows 0..N). */
  bank: 2,
  /** byte 3: patch number within bank (0..127). */
  patchNumber: 3,
  /** byte 4: firmware version byte. 0xC8 = 2.0.0, 0xDC = 2.2.0. */
  version: 4,
  /** byte 6: also patch number per spec (purpose unclear). */
  patchNumberAlt: 6,
} as const;

/** Patch-buffer offsets for the four "magic bytes" (1766–1769). */
export const PATCH_MAGIC_BYTES = {
  /** Spec line 73: leaving these zero causes most subsequent writes to fail. */
  offsets: [1766, 1767, 1768, 1769],
  /** Default values per spec — ASCII "ETCD". */
  defaults: [69, 84, 67, 68],
} as const;

/**
 * Patch name occupies bytes 9..24 (16 chars max). Byte 8 is `Category`,
 * which the spec notes uses byte 9's "MSB position" — but for our
 * purposes we treat the name region as 16 contiguous bytes.
 */
export const PATCH_NAME = {
  startByte: 9,
  /** Hydrasynth front panel allows 16 chars max. */
  maxLength: 16,
} as const;

/**
 * Encoding kinds for parameters laid out in the patch buffer.
 *
 * - `u16le`: unsigned 16-bit little-endian. Byte N = LSB, byte N+1 = MSB.
 *   Used by all 14-bit wire-value params (filter cutoff, env timings,
 *   mixer volumes, bipolar centered values, etc.). **The patch buffer
 *   stores `wire / 8`** — the device's NRPN wire range is `[0, 8192]`
 *   (or `[0, 16383]` for full 14-bit), but the patch byte-map allocates
 *   `[0, 1024]` (or `[0, 2048]`) for the same parameter. Confirmed by
 *   inspecting INIT bytes (Session 39, BK-036.5) — every u16le param
 *   in the factory INIT lands at `wire/8` of its sensible default
 *   (filter1cutoff = 1024 patch = 8192 wire = 128.0 max display, etc.).
 *   `writePatchValue` / `readPatchValue` apply the `/8` scale internally
 *   so callers always pass NRPN wire values matching `set_param`.
 *
 * - `s16le`: signed 16-bit little-endian (two's complement). Used by
 *   the few params that store full negative ranges across both bytes
 *   AT DISPLAY SCALE (e.g. osc1cent stores cents directly: -50..+50
 *   round-trips as -50..+50, not as a 14-bit ring). No `/8` applied.
 *
 * - `u8`: single unsigned byte at offset N. Byte N+1 is left untouched
 *   on encode (typically 0). Used by enum / mode / boolean params at
 *   raw enum-index scale. No `/8` applied.
 *
 * - `s8`: single signed byte at offset N with sign-extension into byte
 *   N+1 (`0xFF` for negative, `0x00` for non-negative). Used by 1-byte
 *   2's complement values like `osc1semi` (-36..+36) where the spec
 *   says "if such a parameter represents a negative value, then it is
 *   sign-extended into the second byte". Stored at display scale.
 *   No `/8` applied.
 */
export type PatchOffsetEncoding = 'u16le' | 's16le' | 'u8' | 's8';

/**
 * Patch buffer divides every NRPN wire value by this constant for u16le
 * params. Wire `[0, 8192]` ⇒ patch `[0, 1024]`. Wire `[0, 16383]` ⇒
 * patch `[0, 2048]`. Bipolar centering happens for free — wire 4096
 * (display 0) ⇒ patch byte 512, the spec's documented bipolar center.
 */
export const PATCH_U16LE_WIRE_DIVISOR = 8;

/** A single curated mapping: canonical NRPN name → patch byte offset. */
export interface PatchOffsetSpec {
  /** Canonical NRPN name (must match `HYDRASYNTH_NRPNS[i].name`). */
  readonly name: string;
  /** Byte offset of the LSB position in the patch buffer (0..2789). */
  readonly byte: number;
  /** How the value is laid out in the buffer at that offset. */
  readonly enc: PatchOffsetEncoding;
  /** Spec-table label for cross-reference. Optional, debugging aid. */
  readonly label?: string;
}

/**
 * Curated subset of canonical NRPN names → patch byte offsets.
 *
 * **NOT exhaustive.** The spec enumerates ~1000 params; this table
 * covers ~30 first-page params critical to BK-036 milestone 2:
 *
 *   - The two BK-037 bipolar-bug regressions (filter1env1amount,
 *     filter1keytrack).
 *   - Osc1/2/3 first-page (mode, type, semi, cent, keytrack).
 *   - Mixer first-page (osc1/2/3 vol + pan).
 *   - Filter1/2 first-page (type, cutoff, resonance, env1 amount,
 *     LFO1 amount, vel-env, keytrack).
 *   - Amplifier (level, vel-env, LFO2 amount).
 *   - Env1 (attack, decay, sustain, release, delay, hold).
 *   - FX (pre/post type + dry/wet, delay/reverb dry/wet).
 *
 * Future sessions extend this; the encoder/decoder logic is generic
 * over the table so adding entries is a one-line change per param.
 *
 * **BPM-sync collapse note** (per spec line 61–68): the Hydrasynth
 * has separate sync-on / sync-off NRPN addresses for env timings,
 * delay time, LFO rates, and a few others. The patch buffer collapses
 * to a single slot, with semantics determined by the corresponding
 * `*bpmsync` byte. We map the **sync-off** variants (the more common
 * default state); callers writing sync-on values should set
 * `env1bpmsync`/`delaybpmsync` accordingly. Decoders see only the
 * collapsed value and don't know which semantic was active without
 * also reading the bpm-sync byte.
 */
export const PATCH_OFFSETS: readonly PatchOffsetSpec[] = [
  // -------- Voice / global (bytes 30–60) --------
  { name: 'voicepolyphony',     byte:  30, enc: 'u8',    label: 'Polyphony' },
  { name: 'voicedensity',       byte:  32, enc: 'u8',    label: 'Density' },
  { name: 'voicedetune',        byte:  34, enc: 'u8',    label: 'Detune' },
  { name: 'voiceanalogfeel',    byte:  36, enc: 'u8',    label: 'Analog Feel' },
  { name: 'voicestereomode',    byte:  40, enc: 'u8',    label: 'Stereo Mode' },
  { name: 'voicestereowidth',   byte:  42, enc: 'u8',    label: 'Stereo Width' },
  { name: 'voicepitchbend',     byte:  44, enc: 'u8',    label: 'Pitch Bend Range' },
  { name: 'voiceglide',         byte:  52, enc: 'u8',    label: 'Glide' },
  { name: 'voiceglidetime',     byte:  54, enc: 'u8',    label: 'Glide Time' },
  { name: 'voiceglidecurve',    byte:  56, enc: 'u8',    label: 'Glide Curve' },
  { name: 'voiceglidelegto',    byte:  58, enc: 'u8',    label: 'Legato' },

  // -------- Oscillator 1 (bytes 80–106) --------
  { name: 'osc1mode',           byte:  80, enc: 'u8',    label: 'Osc 1 Mode' },
  { name: 'osc1type',           byte:  82, enc: 'u8',    label: 'Osc 1 Wave' },
  { name: 'osc1semi',           byte:  84, enc: 's8',    label: 'Osc1 Semitones' },
  { name: 'osc1cent',           byte:  86, enc: 's16le', label: 'Osc1 Cents (-50..+50, 14-bit ring)' },
  { name: 'osc1keytrack',       byte:  88, enc: 's8',    label: 'Osc1 Keytrack' },
  { name: 'osc1wavscan',        byte:  90, enc: 'u16le', label: 'Osc 1 Wavescan' },

  // -------- Oscillator 2 (bytes 108–118) --------
  { name: 'osc2mode',           byte: 108, enc: 'u8',    label: 'Osc 2 Mode' },
  { name: 'osc2type',           byte: 110, enc: 'u8',    label: 'Osc 2 Wave' },
  { name: 'osc2semi',           byte: 112, enc: 's8',    label: 'Osc 2 Semitones' },
  { name: 'osc2cent',           byte: 114, enc: 's16le', label: 'Osc 2 Cents (-50..+50)' },
  { name: 'osc2keytrack',       byte: 116, enc: 's8',    label: 'Osc 2 Keytrack' },
  { name: 'osc2wavscan',        byte: 118, enc: 'u16le', label: 'Osc 2 Wavescan' },

  // -------- Oscillator 3 (bytes 136–142) --------
  { name: 'osc3type',           byte: 136, enc: 'u8',    label: 'Osc 3 Wave' },
  { name: 'osc3semi',           byte: 138, enc: 's8',    label: 'Osc 3 Semitones' },
  { name: 'osc3cent',           byte: 140, enc: 's16le', label: 'Osc 3 Cents (-50..+50)' },
  { name: 'osc3keytrack',       byte: 142, enc: 's8',    label: 'Osc 3 Keytrack' },

  // -------- Ring mod / noise (bytes 264–272) --------
  { name: 'ringmodsource1',     byte: 264, enc: 'u8',    label: 'Ring Mod Source 1' },
  { name: 'ringmodsource2',     byte: 266, enc: 'u8',    label: 'Ring Mod Source 2' },
  { name: 'ringmoddepth',       byte: 268, enc: 'u16le', label: 'Ring Mod Depth' },
  { name: 'noisetype',          byte: 272, enc: 'u8',    label: 'Noise Type' },

  // -------- Mixer (bytes 274–306) --------
  { name: 'mixerosc1vol',       byte: 274, enc: 'u16le', label: 'Mixer Osc 1 Volume' },
  { name: 'mixerosc2vol',       byte: 276, enc: 'u16le', label: 'Mixer Osc 2 Volume' },
  { name: 'mixerosc3vol',       byte: 278, enc: 'u16le', label: 'Mixer Osc 3 Volume' },
  { name: 'mixerringmodvol',    byte: 280, enc: 'u16le', label: 'Mixer Ringmod Volume' },
  { name: 'mixernoisevol',      byte: 282, enc: 'u16le', label: 'Mixer Noise Volume' },
  { name: 'mixerosc1pan',       byte: 286, enc: 'u16le', label: 'Mixer Osc 1 Pan (bipolar)' },
  { name: 'mixerosc2pan',       byte: 288, enc: 'u16le', label: 'Mixer Osc 2 Pan (bipolar)' },
  { name: 'mixerosc3pan',       byte: 290, enc: 'u16le', label: 'Mixer Osc 3 Pan (bipolar)' },
  { name: 'mixerosc1filterratio', byte: 292, enc: 'u16le', label: 'Mixer Osc 1 Filter Ratio' },
  { name: 'mixerosc2filterratio', byte: 294, enc: 'u16le', label: 'Mixer Osc 2 Filter Ratio' },
  { name: 'mixerosc3filterratio', byte: 296, enc: 'u16le', label: 'Mixer Osc 3 Filter Ratio' },
  { name: 'mixerringmodpan',    byte: 298, enc: 'u16le', label: 'Mixer Ringmod Pan' },
  { name: 'mixernoisepan',      byte: 300, enc: 'u16le', label: 'Mixer Noise Pan' },
  { name: 'mixerfilterrouting', byte: 302, enc: 'u8',    label: 'Filter Routing' },
  { name: 'mixerringmodfilterratio', byte: 304, enc: 'u16le', label: 'Mixer Ringmod Filter Ratio' },
  { name: 'mixernoisefilterratio',   byte: 306, enc: 'u16le', label: 'Mixer Noise Filter Ratio' },

  // -------- Mutators 1-4 (bytes 144-231 — see SysexPatchFormat.txt) --------
  // HW-060 follow-up (Session 47): mutator params added so the agent's
  // FM-Linear / WavStack / Osc-Sync / Harmonic recipes (DX7-style FM,
  // wave stacking, sync-sweep) land via apply_patch in one atomic
  // dump instead of a 2-step apply_patch + set_engine_params NRPN
  // batch. Each mutator: mode (u8), ratio + depth + window + feedback
  // + wet (u16le pairs). The 'wet' canonical name matches nrpn.ts;
  // spec calls it "Dry/Wet" but the wire field is 'wet'.
  { name: 'mutator1mode',       byte: 144, enc: 'u8',    label: 'Mutator 1 Mode' },
  { name: 'mutator1ratio',      byte: 148, enc: 'u16le', label: 'Mutator 1 Ratio' },
  { name: 'mutator1depth',      byte: 150, enc: 'u16le', label: 'Mutator 1 Depth' },
  { name: 'mutator1window',     byte: 152, enc: 'u16le', label: 'Mutator 1 Window' },
  { name: 'mutator1feedback',   byte: 154, enc: 'u16le', label: 'Mutator 1 Feedback' },
  { name: 'mutator1wet',        byte: 156, enc: 'u16le', label: 'Mutator 1 Dry/Wet' },
  { name: 'mutator2mode',       byte: 158, enc: 'u8',    label: 'Mutator 2 Mode' },
  { name: 'mutator2ratio',      byte: 162, enc: 'u16le', label: 'Mutator 2 Ratio' },
  { name: 'mutator2depth',      byte: 164, enc: 'u16le', label: 'Mutator 2 Depth' },
  { name: 'mutator2window',     byte: 166, enc: 'u16le', label: 'Mutator 2 Window' },
  { name: 'mutator2feedback',   byte: 168, enc: 'u16le', label: 'Mutator 2 Feedback' },
  { name: 'mutator2wet',        byte: 170, enc: 'u16le', label: 'Mutator 2 Dry/Wet' },
  { name: 'mutator3mode',       byte: 204, enc: 'u8',    label: 'Mutator 3 Mode' },
  { name: 'mutator3ratio',      byte: 208, enc: 'u16le', label: 'Mutator 3 Ratio' },
  { name: 'mutator3depth',      byte: 210, enc: 'u16le', label: 'Mutator 3 Depth' },
  { name: 'mutator3window',     byte: 212, enc: 'u16le', label: 'Mutator 3 Window' },
  { name: 'mutator3feedback',   byte: 214, enc: 'u16le', label: 'Mutator 3 Feedback' },
  { name: 'mutator3wet',        byte: 216, enc: 'u16le', label: 'Mutator 3 Dry/Wet' },
  { name: 'mutator4mode',       byte: 218, enc: 'u8',    label: 'Mutator 4 Mode' },
  { name: 'mutator4ratio',      byte: 222, enc: 'u16le', label: 'Mutator 4 Ratio' },
  { name: 'mutator4depth',      byte: 224, enc: 'u16le', label: 'Mutator 4 Depth' },
  { name: 'mutator4window',     byte: 226, enc: 'u16le', label: 'Mutator 4 Window' },
  { name: 'mutator4feedback',   byte: 228, enc: 'u16le', label: 'Mutator 4 Feedback' },
  { name: 'mutator4wet',        byte: 230, enc: 'u16le', label: 'Mutator 4 Dry/Wet' },

  // -------- Filter 1 (bytes 308–330) --------
  { name: 'filter1type',        byte: 308, enc: 'u8',    label: 'Filter 1 Type' },
  { name: 'filter1cutoff',      byte: 310, enc: 'u16le', label: 'Filter 1 Cutoff' },
  { name: 'filter1resonance',   byte: 312, enc: 'u16le', label: 'Filter 1 Resonance' },
  { name: 'filter1special',     byte: 314, enc: 'u16le', label: 'Filter 1 Formant Control' },
  { name: 'filter1env1amount',  byte: 316, enc: 'u16le', label: 'Filter 1 Env 1 Amount (bipolar)' },
  { name: 'filter1lfo1amount',  byte: 318, enc: 'u16le', label: 'Filter 1 LFO 1 Amount (bipolar)' },
  { name: 'filter1velenv',      byte: 320, enc: 'u16le', label: 'Filter 1 Vel Env' },
  { name: 'filter1keytrack',    byte: 322, enc: 'u16le', label: 'Filter 1 Keytrack (bipolar)' },
  { name: 'filter1drive',       byte: 326, enc: 'u16le', label: 'Filter 1 Drive' },
  { name: 'filter1positionofdrive', byte: 328, enc: 'u8', label: 'Filter 1 Drive Position' },
  { name: 'filter1vowelorder',  byte: 330, enc: 'u8',    label: 'Filter 1 Vowel Order' },

  // -------- Filter 2 (bytes 332–344, plus type at 472) --------
  { name: 'filter2morph',       byte: 332, enc: 'u16le', label: 'Filter 2 Morph' },
  { name: 'filter2cutoff',      byte: 334, enc: 'u16le', label: 'Filter 2 Cutoff' },
  { name: 'filter2resonance',   byte: 336, enc: 'u16le', label: 'Filter 2 Resonance' },
  { name: 'filter2env1amount',  byte: 338, enc: 'u16le', label: 'Filter 2 Env 1 Amount (bipolar)' },
  { name: 'filter2lfo1amount',  byte: 340, enc: 'u16le', label: 'Filter 2 LFO 1 Amount (bipolar)' },
  { name: 'filter2velenv',      byte: 342, enc: 'u16le', label: 'Filter 2 Vel Env' },
  { name: 'filter2keytrack',    byte: 344, enc: 'u16le', label: 'Filter 2 Keytrack (bipolar)' },
  { name: 'filter2type',        byte: 472, enc: 'u8',    label: 'Filter 2 Type' },

  // -------- Amplifier (bytes 346–351) --------
  { name: 'amplfo2amount',      byte: 346, enc: 'u16le', label: 'Amplifier LFO 2 Amount (bipolar)' },
  { name: 'ampvelenv',          byte: 348, enc: 'u16le', label: 'Amplifier Vel Env' },
  { name: 'amplevel',           byte: 350, enc: 'u16le', label: 'Amplifier Level' },

  // -------- Pre-FX (bytes 352–367) --------
  { name: 'prefxtype',          byte: 352, enc: 'u8',    label: 'Pre-FX Type' },
  // HW-058 follow-up (Session 47): prefxparam1..5 added so the agent's
  // chorus rate/depth recipe lands without erroring on PATCH_OFFSETS lookup.
  // Bytes 356-365 per SysexPatchFormat.txt; each is a u16le LB/HB pair.
  // Param meaning is FX-type-dependent (chorus rate / depth / etc.) — the
  // agent should consult the FX type's manual page for what each maps to.
  { name: 'prefxparam1',        byte: 356, enc: 'u16le', label: 'Pre-FX Param 1' },
  { name: 'prefxparam2',        byte: 358, enc: 'u16le', label: 'Pre-FX Param 2' },
  { name: 'prefxparam3',        byte: 360, enc: 'u16le', label: 'Pre-FX Param 3' },
  { name: 'prefxparam4',        byte: 362, enc: 'u16le', label: 'Pre-FX Param 4' },
  { name: 'prefxparam5',        byte: 364, enc: 'u16le', label: 'Pre-FX Param 5' },
  { name: 'prefxwet',           byte: 366, enc: 'u16le', label: 'Pre-FX Dry/Wet' },

  // -------- Delay (bytes 368–383) --------
  { name: 'delaytype',          byte: 368, enc: 'u8',    label: 'Delay Type' },
  { name: 'delaybpmsync',       byte: 370, enc: 'u8',    label: 'Delay BPM Sync' },
  // Spec collapses sync-on/sync-off into one wire slot at byte 372.
  // Both names map to the same byte; the device interprets the value
  // based on `delaybpmsync`. Pass `delaytimesyncoff` (free ms) when
  // bpmsync=0; pass `delaytimesyncon` (musical division string like
  // "1/4 D" via the FX_DELAYS_SYNC_ON enum) when bpmsync=1. Session 47
  // HW-060 retest: agent learned to favour bpmsync for rhythmic
  // delays after manual user fixup.
  { name: 'delaytimesyncoff',   byte: 372, enc: 'u16le', label: 'Delay Time (free ms — bpmsync=0)' },
  { name: 'delaytimesyncon',    byte: 372, enc: 'u16le', label: 'Delay Time (musical division — bpmsync=1)' },
  { name: 'delayfeedback',      byte: 374, enc: 'u16le', label: 'Delay Feedback' },
  { name: 'delayfeedtone',      byte: 376, enc: 'u16le', label: 'Delay Feed Tone (bipolar)' },
  { name: 'delaywettone',       byte: 378, enc: 'u16le', label: 'Delay Wet Tone (bipolar)' },
  { name: 'delaywet',           byte: 382, enc: 'u16le', label: 'Delay Dry/Wet' },

  // -------- Reverb (bytes 384–399) --------
  { name: 'reverbtype',         byte: 384, enc: 'u8',    label: 'Reverb Type' },
  { name: 'reverbtime',         byte: 388, enc: 'u16le', label: 'Reverb Time' },
  { name: 'reverbtone',         byte: 390, enc: 'u16le', label: 'Reverb Tone (bipolar)' },
  { name: 'reverbhidamp',       byte: 392, enc: 'u16le', label: 'Reverb High Damp' },
  { name: 'reverblodamp',       byte: 394, enc: 'u16le', label: 'Reverb Low Damp' },
  { name: 'reverbpredelay',     byte: 396, enc: 'u16le', label: 'Reverb Predelay' },
  { name: 'reverbwet',          byte: 398, enc: 'u16le', label: 'Reverb Dry/Wet' },

  // -------- Post-FX (bytes 400–415) --------
  { name: 'postfxtype',         byte: 400, enc: 'u8',    label: 'Post-FX Type' },
  // Same shape as Pre-FX — added Session 47 / HW-058 follow-up.
  { name: 'postfxparam1',       byte: 404, enc: 'u16le', label: 'Post-FX Param 1' },
  { name: 'postfxparam2',       byte: 406, enc: 'u16le', label: 'Post-FX Param 2' },
  { name: 'postfxparam3',       byte: 408, enc: 'u16le', label: 'Post-FX Param 3' },
  { name: 'postfxparam4',       byte: 410, enc: 'u16le', label: 'Post-FX Param 4' },
  { name: 'postfxparam5',       byte: 412, enc: 'u16le', label: 'Post-FX Param 5' },
  { name: 'postfxwet',          byte: 414, enc: 'u16le', label: 'Post-FX Dry/Wet' },

  // -------- Env 1 (bytes 478–504) --------
  { name: 'env1attacksyncoff',  byte: 478, enc: 'u16le', label: 'Env 1 Attack (collapsed slot)' },
  { name: 'env1decaysyncoff',   byte: 480, enc: 'u16le', label: 'Env 1 Decay (collapsed slot)' },
  { name: 'env1sustain',        byte: 482, enc: 'u16le', label: 'Env 1 Sustain' },
  { name: 'env1releasesyncoff', byte: 484, enc: 'u16le', label: 'Env 1 Release (collapsed slot)' },
  { name: 'env1bpmsync',        byte: 486, enc: 'u8',    label: 'Env 1 BPM Sync' },
  { name: 'env1delaysyncoff',   byte: 488, enc: 'u16le', label: 'Env 1 Delay (collapsed slot)' },
  { name: 'env1holdsyncoff',    byte: 490, enc: 'u16le', label: 'Env 1 Hold (collapsed slot)' },
  { name: 'env1atkcurve',       byte: 492, enc: 's8',    label: 'Env 1 Attack Curve' },
  { name: 'env1deccurve',       byte: 494, enc: 's8',    label: 'Env 1 Decay Curve' },
  { name: 'env1relcurve',       byte: 496, enc: 's8',    label: 'Env 1 Release Curve' },
  { name: 'env1legato',         byte: 498, enc: 'u8',    label: 'Env 1 Legato' },
  { name: 'env1reset',          byte: 500, enc: 'u8',    label: 'Env 1 Reset' },
  { name: 'env1freerun',        byte: 502, enc: 'u8',    label: 'Env 1 Free Run' },
  { name: 'env1loop',           byte: 504, enc: 'u8',    label: 'Env 1 Loop Curve' },

  // -------- Env 2 (bytes 506–532) --------
  // Session 48 ambient-pad bug fix: agent's slow-attack pad recipe used
  // env2 (default amp env) and apply_patch errored on missing offsets.
  // Layout mirrors env1 exactly with base 506 (28-byte stride). Sync-on
  // names are collapsed onto the same byte as their syncoff counterpart
  // — semantics are determined by env2bpmsync, same pattern as env1 and
  // delaytime above.
  { name: 'env2attacksyncoff',  byte: 506, enc: 'u16le', label: 'Env 2 Attack (collapsed slot)' },
  { name: 'env2attacksyncon',   byte: 506, enc: 'u16le', label: 'Env 2 Attack (collapsed slot, sync-on)' },
  { name: 'env2decaysyncoff',   byte: 508, enc: 'u16le', label: 'Env 2 Decay (collapsed slot)' },
  { name: 'env2decaysyncon',    byte: 508, enc: 'u16le', label: 'Env 2 Decay (collapsed slot, sync-on)' },
  { name: 'env2sustain',        byte: 510, enc: 'u16le', label: 'Env 2 Sustain' },
  { name: 'env2releasesyncoff', byte: 512, enc: 'u16le', label: 'Env 2 Release (collapsed slot)' },
  { name: 'env2releasesyncon',  byte: 512, enc: 'u16le', label: 'Env 2 Release (collapsed slot, sync-on)' },
  { name: 'env2bpmsync',        byte: 514, enc: 'u8',    label: 'Env 2 BPM Sync' },
  { name: 'env2delaysyncoff',   byte: 516, enc: 'u16le', label: 'Env 2 Delay (collapsed slot)' },
  { name: 'env2delaysyncon',    byte: 516, enc: 'u16le', label: 'Env 2 Delay (collapsed slot, sync-on)' },
  { name: 'env2holdsyncoff',    byte: 518, enc: 'u16le', label: 'Env 2 Hold (collapsed slot)' },
  { name: 'env2holdsyncon',     byte: 518, enc: 'u16le', label: 'Env 2 Hold (collapsed slot, sync-on)' },
  { name: 'env2atkcurve',       byte: 520, enc: 's8',    label: 'Env 2 Attack Curve' },
  { name: 'env2deccurve',       byte: 522, enc: 's8',    label: 'Env 2 Decay Curve' },
  { name: 'env2relcurve',       byte: 524, enc: 's8',    label: 'Env 2 Release Curve' },
  { name: 'env2legato',         byte: 526, enc: 'u8',    label: 'Env 2 Legato' },
  { name: 'env2reset',          byte: 528, enc: 'u8',    label: 'Env 2 Reset' },
  { name: 'env2freerun',        byte: 530, enc: 'u8',    label: 'Env 2 Free Run' },
  { name: 'env2loop',           byte: 532, enc: 'u8',    label: 'Env 2 Loop Curve' },

  // -------- Env 3 (bytes 534–560) --------
  // Session 49 ambient-pad followup: founder reported "must-have" full
  // env3-5 + lfo2-5 access. Spec lines 651+, 28-byte stride from env2.
  // Layout mirrors env1/env2 exactly. Sync-on names collapse onto the
  // same bytes as their syncoff counterparts; semantics determined by
  // env3bpmsync.
  { name: 'env3attacksyncoff',  byte: 534, enc: 'u16le', label: 'Env 3 Attack (collapsed slot)' },
  { name: 'env3attacksyncon',   byte: 534, enc: 'u16le', label: 'Env 3 Attack (collapsed slot, sync-on)' },
  { name: 'env3decaysyncoff',   byte: 536, enc: 'u16le', label: 'Env 3 Decay (collapsed slot)' },
  { name: 'env3decaysyncon',    byte: 536, enc: 'u16le', label: 'Env 3 Decay (collapsed slot, sync-on)' },
  { name: 'env3sustain',        byte: 538, enc: 'u16le', label: 'Env 3 Sustain' },
  { name: 'env3releasesyncoff', byte: 540, enc: 'u16le', label: 'Env 3 Release (collapsed slot)' },
  { name: 'env3releasesyncon',  byte: 540, enc: 'u16le', label: 'Env 3 Release (collapsed slot, sync-on)' },
  { name: 'env3bpmsync',        byte: 542, enc: 'u8',    label: 'Env 3 BPM Sync' },
  { name: 'env3delaysyncoff',   byte: 544, enc: 'u16le', label: 'Env 3 Delay (collapsed slot)' },
  { name: 'env3delaysyncon',    byte: 544, enc: 'u16le', label: 'Env 3 Delay (collapsed slot, sync-on)' },
  { name: 'env3holdsyncoff',    byte: 546, enc: 'u16le', label: 'Env 3 Hold (collapsed slot)' },
  { name: 'env3holdsyncon',     byte: 546, enc: 'u16le', label: 'Env 3 Hold (collapsed slot, sync-on)' },
  { name: 'env3atkcurve',       byte: 548, enc: 's8',    label: 'Env 3 Attack Curve' },
  { name: 'env3deccurve',       byte: 550, enc: 's8',    label: 'Env 3 Decay Curve' },
  { name: 'env3relcurve',       byte: 552, enc: 's8',    label: 'Env 3 Release Curve' },
  { name: 'env3legato',         byte: 554, enc: 'u8',    label: 'Env 3 Legato' },
  { name: 'env3reset',          byte: 556, enc: 'u8',    label: 'Env 3 Reset' },
  { name: 'env3freerun',        byte: 558, enc: 'u8',    label: 'Env 3 Free Run' },
  { name: 'env3loop',           byte: 560, enc: 'u8',    label: 'Env 3 Loop Curve' },

  // -------- Env 4 (bytes 562–588) --------
  { name: 'env4attacksyncoff',  byte: 562, enc: 'u16le', label: 'Env 4 Attack (collapsed slot)' },
  { name: 'env4attacksyncon',   byte: 562, enc: 'u16le', label: 'Env 4 Attack (collapsed slot, sync-on)' },
  { name: 'env4decaysyncoff',   byte: 564, enc: 'u16le', label: 'Env 4 Decay (collapsed slot)' },
  { name: 'env4decaysyncon',    byte: 564, enc: 'u16le', label: 'Env 4 Decay (collapsed slot, sync-on)' },
  { name: 'env4sustain',        byte: 566, enc: 'u16le', label: 'Env 4 Sustain' },
  { name: 'env4releasesyncoff', byte: 568, enc: 'u16le', label: 'Env 4 Release (collapsed slot)' },
  { name: 'env4releasesyncon',  byte: 568, enc: 'u16le', label: 'Env 4 Release (collapsed slot, sync-on)' },
  { name: 'env4bpmsync',        byte: 570, enc: 'u8',    label: 'Env 4 BPM Sync' },
  { name: 'env4delaysyncoff',   byte: 572, enc: 'u16le', label: 'Env 4 Delay (collapsed slot)' },
  { name: 'env4delaysyncon',    byte: 572, enc: 'u16le', label: 'Env 4 Delay (collapsed slot, sync-on)' },
  { name: 'env4holdsyncoff',    byte: 574, enc: 'u16le', label: 'Env 4 Hold (collapsed slot)' },
  { name: 'env4holdsyncon',     byte: 574, enc: 'u16le', label: 'Env 4 Hold (collapsed slot, sync-on)' },
  { name: 'env4atkcurve',       byte: 576, enc: 's8',    label: 'Env 4 Attack Curve' },
  { name: 'env4deccurve',       byte: 578, enc: 's8',    label: 'Env 4 Decay Curve' },
  { name: 'env4relcurve',       byte: 580, enc: 's8',    label: 'Env 4 Release Curve' },
  { name: 'env4legato',         byte: 582, enc: 'u8',    label: 'Env 4 Legato' },
  { name: 'env4reset',          byte: 584, enc: 'u8',    label: 'Env 4 Reset' },
  { name: 'env4freerun',        byte: 586, enc: 'u8',    label: 'Env 4 Free Run' },
  { name: 'env4loop',           byte: 588, enc: 'u8',    label: 'Env 4 Loop Curve' },

  // -------- Env 5 (bytes 590–616) --------
  { name: 'env5attacksyncoff',  byte: 590, enc: 'u16le', label: 'Env 5 Attack (collapsed slot)' },
  { name: 'env5attacksyncon',   byte: 590, enc: 'u16le', label: 'Env 5 Attack (collapsed slot, sync-on)' },
  { name: 'env5decaysyncoff',   byte: 592, enc: 'u16le', label: 'Env 5 Decay (collapsed slot)' },
  { name: 'env5decaysyncon',    byte: 592, enc: 'u16le', label: 'Env 5 Decay (collapsed slot, sync-on)' },
  { name: 'env5sustain',        byte: 594, enc: 'u16le', label: 'Env 5 Sustain' },
  { name: 'env5releasesyncoff', byte: 596, enc: 'u16le', label: 'Env 5 Release (collapsed slot)' },
  { name: 'env5releasesyncon',  byte: 596, enc: 'u16le', label: 'Env 5 Release (collapsed slot, sync-on)' },
  { name: 'env5bpmsync',        byte: 598, enc: 'u8',    label: 'Env 5 BPM Sync' },
  { name: 'env5delaysyncoff',   byte: 600, enc: 'u16le', label: 'Env 5 Delay (collapsed slot)' },
  { name: 'env5delaysyncon',    byte: 600, enc: 'u16le', label: 'Env 5 Delay (collapsed slot, sync-on)' },
  { name: 'env5holdsyncoff',    byte: 602, enc: 'u16le', label: 'Env 5 Hold (collapsed slot)' },
  { name: 'env5holdsyncon',     byte: 602, enc: 'u16le', label: 'Env 5 Hold (collapsed slot, sync-on)' },
  { name: 'env5atkcurve',       byte: 604, enc: 's8',    label: 'Env 5 Attack Curve' },
  { name: 'env5deccurve',       byte: 606, enc: 's8',    label: 'Env 5 Decay Curve' },
  { name: 'env5relcurve',       byte: 608, enc: 's8',    label: 'Env 5 Release Curve' },
  { name: 'env5legato',         byte: 610, enc: 'u8',    label: 'Env 5 Legato' },
  { name: 'env5reset',          byte: 612, enc: 'u8',    label: 'Env 5 Reset' },
  { name: 'env5freerun',        byte: 614, enc: 'u8',    label: 'Env 5 Free Run' },
  { name: 'env5loop',           byte: 616, enc: 'u8',    label: 'Env 5 Loop Curve' },

  // -------- LFO 1 (bytes 618–638) --------
  // Session 48 ambient-pad bug fix: agent reaches for lfo1 routinely
  // (washy modulation, vibrato, slow filter sweep). Spec lines 735-756.
  // ratesyncoff/syncon and delaysyncoff/syncon and fadeinsyncoff/syncon
  // collapse onto shared bytes (same pattern as env1 / delaytime).
  { name: 'lfo1wave',           byte: 618, enc: 'u8',    label: 'LFO 1 Wave' },
  { name: 'lfo1ratesyncoff',    byte: 620, enc: 'u16le', label: 'LFO 1 Rate (collapsed slot)' },
  { name: 'lfo1ratesyncon',     byte: 620, enc: 'u16le', label: 'LFO 1 Rate (collapsed slot, sync-on)' },
  { name: 'lfo1bpmsync',        byte: 622, enc: 'u8',    label: 'LFO 1 BPM Sync' },
  { name: 'lfo1trigsync',       byte: 624, enc: 'u8',    label: 'LFO 1 Trig Sync' },
  { name: 'lfo1delaysyncoff',   byte: 626, enc: 'u16le', label: 'LFO 1 Delay (collapsed slot)' },
  { name: 'lfo1delaysyncon',    byte: 626, enc: 'u16le', label: 'LFO 1 Delay (collapsed slot, sync-on)' },
  { name: 'lfo1fadeinsyncoff',  byte: 628, enc: 'u16le', label: 'LFO 1 Fade In (collapsed slot)' },
  { name: 'lfo1fadeinsyncon',   byte: 628, enc: 'u16le', label: 'LFO 1 Fade In (collapsed slot, sync-on)' },
  { name: 'lfo1phase',          byte: 630, enc: 'u16le', label: 'LFO 1 Phase' },
  { name: 'lfo1level',          byte: 632, enc: 'u16le', label: 'LFO 1 Level' },
  { name: 'lfo1steps',          byte: 634, enc: 'u8',    label: 'LFO 1 Steps' },
  { name: 'lfo1smooth',         byte: 636, enc: 'u8',    label: 'LFO 1 Smooth' },
  { name: 'lfo1oneshot',        byte: 638, enc: 'u8',    label: 'LFO 1 One Shot' },

  // -------- LFO 2 (bytes 656–676) --------
  // Session 49: founder hit "errors setting lfo 2, this is a must-have,
  // they should have access to all". 38-byte stride from lfo1.
  // Spec confirms: lfo2 wave at 656, lfo3 at 694, lfo4 at 732, lfo5 at 770.
  // Per-LFO step arrays (16 or 64 entries depending on wave) are
  // documented in spec at offsets 1770/1882/.../2338 — NOT added here
  // (large param count; founder didn't ask for them).
  { name: 'lfo2wave',           byte: 656, enc: 'u8',    label: 'LFO 2 Wave' },
  { name: 'lfo2ratesyncoff',    byte: 658, enc: 'u16le', label: 'LFO 2 Rate (collapsed slot)' },
  { name: 'lfo2ratesyncon',     byte: 658, enc: 'u16le', label: 'LFO 2 Rate (collapsed slot, sync-on)' },
  { name: 'lfo2bpmsync',        byte: 660, enc: 'u8',    label: 'LFO 2 BPM Sync' },
  { name: 'lfo2trigsync',       byte: 662, enc: 'u8',    label: 'LFO 2 Trig Sync' },
  { name: 'lfo2delaysyncoff',   byte: 664, enc: 'u16le', label: 'LFO 2 Delay (collapsed slot)' },
  { name: 'lfo2delaysyncon',    byte: 664, enc: 'u16le', label: 'LFO 2 Delay (collapsed slot, sync-on)' },
  { name: 'lfo2fadeinsyncoff',  byte: 666, enc: 'u16le', label: 'LFO 2 Fade In (collapsed slot)' },
  { name: 'lfo2fadeinsyncon',   byte: 666, enc: 'u16le', label: 'LFO 2 Fade In (collapsed slot, sync-on)' },
  { name: 'lfo2phase',          byte: 668, enc: 'u16le', label: 'LFO 2 Phase' },
  { name: 'lfo2level',          byte: 670, enc: 'u16le', label: 'LFO 2 Level' },
  { name: 'lfo2steps',          byte: 672, enc: 'u8',    label: 'LFO 2 Steps' },
  { name: 'lfo2smooth',         byte: 674, enc: 'u8',    label: 'LFO 2 Smooth' },
  { name: 'lfo2oneshot',        byte: 676, enc: 'u8',    label: 'LFO 2 One Shot' },

  // -------- LFO 3 (bytes 694–714) --------
  { name: 'lfo3wave',           byte: 694, enc: 'u8',    label: 'LFO 3 Wave' },
  { name: 'lfo3ratesyncoff',    byte: 696, enc: 'u16le', label: 'LFO 3 Rate (collapsed slot)' },
  { name: 'lfo3ratesyncon',     byte: 696, enc: 'u16le', label: 'LFO 3 Rate (collapsed slot, sync-on)' },
  { name: 'lfo3bpmsync',        byte: 698, enc: 'u8',    label: 'LFO 3 BPM Sync' },
  { name: 'lfo3trigsync',       byte: 700, enc: 'u8',    label: 'LFO 3 Trig Sync' },
  { name: 'lfo3delaysyncoff',   byte: 702, enc: 'u16le', label: 'LFO 3 Delay (collapsed slot)' },
  { name: 'lfo3delaysyncon',    byte: 702, enc: 'u16le', label: 'LFO 3 Delay (collapsed slot, sync-on)' },
  { name: 'lfo3fadeinsyncoff',  byte: 704, enc: 'u16le', label: 'LFO 3 Fade In (collapsed slot)' },
  { name: 'lfo3fadeinsyncon',   byte: 704, enc: 'u16le', label: 'LFO 3 Fade In (collapsed slot, sync-on)' },
  { name: 'lfo3phase',          byte: 706, enc: 'u16le', label: 'LFO 3 Phase' },
  { name: 'lfo3level',          byte: 708, enc: 'u16le', label: 'LFO 3 Level' },
  { name: 'lfo3steps',          byte: 710, enc: 'u8',    label: 'LFO 3 Steps' },
  { name: 'lfo3smooth',         byte: 712, enc: 'u8',    label: 'LFO 3 Smooth' },
  { name: 'lfo3oneshot',        byte: 714, enc: 'u8',    label: 'LFO 3 One Shot' },

  // -------- LFO 4 (bytes 732–752) --------
  { name: 'lfo4wave',           byte: 732, enc: 'u8',    label: 'LFO 4 Wave' },
  { name: 'lfo4ratesyncoff',    byte: 734, enc: 'u16le', label: 'LFO 4 Rate (collapsed slot)' },
  { name: 'lfo4ratesyncon',     byte: 734, enc: 'u16le', label: 'LFO 4 Rate (collapsed slot, sync-on)' },
  { name: 'lfo4bpmsync',        byte: 736, enc: 'u8',    label: 'LFO 4 BPM Sync' },
  { name: 'lfo4trigsync',       byte: 738, enc: 'u8',    label: 'LFO 4 Trig Sync' },
  { name: 'lfo4delaysyncoff',   byte: 740, enc: 'u16le', label: 'LFO 4 Delay (collapsed slot)' },
  { name: 'lfo4delaysyncon',    byte: 740, enc: 'u16le', label: 'LFO 4 Delay (collapsed slot, sync-on)' },
  { name: 'lfo4fadeinsyncoff',  byte: 742, enc: 'u16le', label: 'LFO 4 Fade In (collapsed slot)' },
  { name: 'lfo4fadeinsyncon',   byte: 742, enc: 'u16le', label: 'LFO 4 Fade In (collapsed slot, sync-on)' },
  { name: 'lfo4phase',          byte: 744, enc: 'u16le', label: 'LFO 4 Phase' },
  { name: 'lfo4level',          byte: 746, enc: 'u16le', label: 'LFO 4 Level' },
  { name: 'lfo4steps',          byte: 748, enc: 'u8',    label: 'LFO 4 Steps' },
  { name: 'lfo4smooth',         byte: 750, enc: 'u8',    label: 'LFO 4 Smooth' },
  { name: 'lfo4oneshot',        byte: 752, enc: 'u8',    label: 'LFO 4 One Shot' },

  // -------- LFO 5 (bytes 770–790) --------
  { name: 'lfo5wave',           byte: 770, enc: 'u8',    label: 'LFO 5 Wave' },
  { name: 'lfo5ratesyncoff',    byte: 772, enc: 'u16le', label: 'LFO 5 Rate (collapsed slot)' },
  { name: 'lfo5ratesyncon',     byte: 772, enc: 'u16le', label: 'LFO 5 Rate (collapsed slot, sync-on)' },
  { name: 'lfo5bpmsync',        byte: 774, enc: 'u8',    label: 'LFO 5 BPM Sync' },
  { name: 'lfo5trigsync',       byte: 776, enc: 'u8',    label: 'LFO 5 Trig Sync' },
  { name: 'lfo5delaysyncoff',   byte: 778, enc: 'u16le', label: 'LFO 5 Delay (collapsed slot)' },
  { name: 'lfo5delaysyncon',    byte: 778, enc: 'u16le', label: 'LFO 5 Delay (collapsed slot, sync-on)' },
  { name: 'lfo5fadeinsyncoff',  byte: 780, enc: 'u16le', label: 'LFO 5 Fade In (collapsed slot)' },
  { name: 'lfo5fadeinsyncon',   byte: 780, enc: 'u16le', label: 'LFO 5 Fade In (collapsed slot, sync-on)' },
  { name: 'lfo5phase',          byte: 782, enc: 'u16le', label: 'LFO 5 Phase' },
  { name: 'lfo5level',          byte: 784, enc: 'u16le', label: 'LFO 5 Level' },
  { name: 'lfo5steps',          byte: 786, enc: 'u8',    label: 'LFO 5 Steps' },
  { name: 'lfo5smooth',         byte: 788, enc: 'u8',    label: 'LFO 5 Smooth' },
  { name: 'lfo5oneshot',        byte: 790, enc: 'u8',    label: 'LFO 5 One Shot' },
];

/** Build an O(1) name → spec lookup; used by encode/decode helpers. */
const PATCH_OFFSETS_BY_NAME: Map<string, PatchOffsetSpec> = (() => {
  const m = new Map<string, PatchOffsetSpec>();
  for (const spec of PATCH_OFFSETS) {
    if (m.has(spec.name)) {
      throw new Error(`PATCH_OFFSETS duplicate name: "${spec.name}"`);
    }
    m.set(spec.name, spec);
  }
  return m;
})();

/** Lookup a curated patch-buffer offset by canonical NRPN name. */
export function findPatchOffset(name: string): PatchOffsetSpec | undefined {
  return PATCH_OFFSETS_BY_NAME.get(name);
}

// ---------------------------------------------------------------------------
// Low-level byte read/write at a single offset.
// ---------------------------------------------------------------------------

/**
 * Encode `value` into `buf` at `spec.byte` per `spec.enc`. Mutates
 * `buf` in place.
 *
 * **API contract: caller passes NRPN wire values** for `u16le` params
 * (matching `hydra_set_param` / `resolveNrpnValue` semantics — `0..8192`
 * for the typical 14-bit knob, `0..16383` for full 14-bit). Encoder
 * divides by `PATCH_U16LE_WIRE_DIVISOR` (8) before writing the bytes.
 * For `s16le` / `u8` / `s8`, value is at display/raw scale and is
 * written as-is.
 *
 * Throws if value is out of range or not an integer divisible by 8 for
 * `u16le` (the patch buffer can't represent finer granularity than the
 * spec note "[0,8192] seemingly only output in increments of 8").
 */
export function writePatchValue(buf: Uint8Array, spec: PatchOffsetSpec, value: number): void {
  if (spec.byte < 0 || spec.byte + 1 >= buf.length) {
    throw new Error(`patch offset ${spec.byte} out of bounds for buffer of ${buf.length} bytes`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`patch value for "${spec.name}" must be an integer; got ${value}`);
  }
  switch (spec.enc) {
    case 'u16le': {
      // Wire-in: caller passes NRPN wire 0..16383. Patch byte stores
      // wire/8. Round to nearest to absorb the spec's "increments of 8"
      // quantization rather than truncating off-by-one.
      if (value < 0 || value > 0xffff) {
        throw new Error(`u16le wire value for "${spec.name}" out of range 0..65535: ${value}`);
      }
      const patchByte = Math.round(value / PATCH_U16LE_WIRE_DIVISOR);
      if (patchByte > 0xffff) {
        throw new Error(`u16le wire value for "${spec.name}" exceeds patch byte range after /8: ${value}`);
      }
      buf[spec.byte]     = patchByte & 0xff;
      buf[spec.byte + 1] = (patchByte >>> 8) & 0xff;
      return;
    }
    case 's16le': {
      if (value < -0x8000 || value > 0x7fff) {
        throw new Error(`s16le value for "${spec.name}" out of range -32768..32767: ${value}`);
      }
      const enc = value < 0 ? value + 0x10000 : value;
      buf[spec.byte]     = enc & 0xff;
      buf[spec.byte + 1] = (enc >>> 8) & 0xff;
      return;
    }
    case 'u8': {
      if (value < 0 || value > 0xff) {
        throw new Error(`u8 value for "${spec.name}" out of range 0..255: ${value}`);
      }
      buf[spec.byte] = value & 0xff;
      // Per spec: leave the MSB position untouched. We zero it for
      // determinism on a fresh buffer; for in-place overrides on a
      // device-captured buffer the existing high byte is preserved by
      // not touching it. We pick zeroing — patch-buffer high bytes for
      // u8 fields are documented as 0 in the spec table (no `MSB?`
      // annotations on these entries).
      buf[spec.byte + 1] = 0;
      return;
    }
    case 's8': {
      if (value < -0x80 || value > 0x7f) {
        throw new Error(`s8 value for "${spec.name}" out of range -128..127: ${value}`);
      }
      buf[spec.byte]     = value & 0xff;
      // Sign-extend: 0xFF for negative, 0x00 for non-negative.
      buf[spec.byte + 1] = value < 0 ? 0xff : 0x00;
      return;
    }
  }
}

/**
 * Decode `value` from `buf` at `spec.byte` per `spec.enc`.
 *
 * Returns NRPN wire value for `u16le` (patch byte × 8) so the result
 * is comparable to what `hydra_set_param` / `resolveNrpnValue` use.
 * `s16le` / `u8` / `s8` return the raw display/index value.
 */
export function readPatchValue(buf: Uint8Array, spec: PatchOffsetSpec): number {
  if (spec.byte < 0 || spec.byte + 1 >= buf.length) {
    throw new Error(`patch offset ${spec.byte} out of bounds for buffer of ${buf.length} bytes`);
  }
  const lo = buf[spec.byte];
  const hi = buf[spec.byte + 1];
  switch (spec.enc) {
    case 'u16le':
      return (lo | (hi << 8)) * PATCH_U16LE_WIRE_DIVISOR;
    case 's16le': {
      const v = lo | (hi << 8);
      return v >= 0x8000 ? v - 0x10000 : v;
    }
    case 'u8':
      return lo;
    case 's8':
      return lo >= 0x80 ? lo - 0x100 : lo;
  }
}

// ---------------------------------------------------------------------------
// Patch-level encode / decode.
// ---------------------------------------------------------------------------

export interface EncodePatchOptions {
  /**
   * Base buffer to clone and apply overrides on top of. Must be exactly
   * `PATCH_BUFFER_SIZE` bytes. If omitted, starts from a zero-filled
   * buffer with the four magic bytes at 1766–1769 set to ETCD per spec
   * (an all-zeros buffer would silently fail to write on hardware).
   */
  readonly base?: Uint8Array;
  /**
   * Optional patch name to write into bytes 9-22 of the patch buffer.
   * 14-char ASCII max (truncated past 14 chars; shorter names
   * zero-padded). Session 47 / HW-058 follow-up: enables setting
   * the patch name as part of an apply_patch call. Cannot be set
   * standalone (no Hydrasynth SysEx for "rename current patch
   * without re-dumping"; the name lives in the patch buffer, which
   * we can write but not read).
   */
  readonly name?: string;
}

/**
 * Apply a sparse map of canonical NRPN-name → value overrides on top
 * of a base patch buffer. Returns a fresh `Uint8Array` of length
 * `PATCH_BUFFER_SIZE`; the input buffer is not mutated.
 *
 * Unknown parameter names throw — callers should pre-validate with
 * `findPatchOffset()` if they want to filter silently. This catches
 * typos and unmapped params loudly so they don't paint themselves
 * silent on hardware.
 *
 * **Patch-buffer wire-vs-index split** (Session 49 ambient-pad fix).
 * For enum-typed params with `enumValueScale` set in the canonical
 * NRPN registry (currently: prefxtype, postfxtype, delaytype,
 * reverbtype — all scale 8; reverbtime — scale 64), the patch buffer
 * stores the **raw enum index** (`wire / scale`), NOT the wire value
 * the NRPN path uses. The device's parser at byte 352 (and the
 * matching reverb/delay bytes) reads a literal index into FX_TYPES /
 * DELAY_TYPES / etc. — we confirmed this against
 * docs/devices/hydrasynth-explorer/references/ASMHydrasynth.java
 * lines 5963 / 6830 (`Math.max(0, Math.min(data[352], 9))`) and
 * empirically: passing `prefxtype: "Chorus"` had been writing wire 8
 * to the patch buffer, which the device decoded as Compressor
 * (FX_TYPES index 8). The NRPN send path remains unchanged — it
 * still emits `idx × scale` per the ENV1amt-style multiply-by-8
 * convention for FX/Delay/Reverb registers.
 */
export function encodePatch(
  overrides: Map<string, number> | ReadonlyMap<string, number>,
  options: EncodePatchOptions = {},
): Uint8Array {
  const base = options.base ?? defaultPatchBuffer();
  if (base.length !== PATCH_BUFFER_SIZE) {
    throw new Error(`base patch buffer must be ${PATCH_BUFFER_SIZE} bytes, got ${base.length}`);
  }
  const buf = new Uint8Array(base); // clone
  for (const [name, value] of overrides) {
    const spec = PATCH_OFFSETS_BY_NAME.get(name);
    if (!spec) {
      throw new Error(`encodePatch: no patch-buffer offset mapped for "${name}" (extend PATCH_OFFSETS in patchEncoder.ts)`);
    }
    const patchValue = patchBufferValueFor(name, value, spec);
    writePatchValue(buf, spec, patchValue);
  }
  if (options.name !== undefined) {
    writePatchName(buf, options.name);
  }
  return buf;
}

/**
 * Convert an NRPN wire value to the value the patch buffer should
 * store. For most params this is the identity — the wire value is
 * what the patch buffer wants (modulo `writePatchValue`'s u16le `/8`
 * convention which lives inside that helper).
 *
 * Three special cases:
 *
 * 1. **u8 enum-scaled params** (prefxtype / postfxtype / delaytype /
 *    reverbtype — all `enumValueScale: 8`): patch buffer stores raw
 *    enum index. u8 encoding has no internal /8 divisor (unlike u16le),
 *    so we have to undo the scale here. Without this, `prefxtype:
 *    "Chorus"` (wire 8) was getting written as byte 8 = Compressor.
 *
 * 2. **u16le enum-scaled params** (reverbtime — `enumValueScale: 64`):
 *    patch buffer stores `wire / 8` per the standard u16le rule. The
 *    device's display path floors `patch_byte / 8` to get the lookup
 *    index, so wire 6720 (idx 105) → patch byte 840 → idx 105 =
 *    "16.0s". No further scale-undo needed — pass wire through and
 *    let writePatchValue apply its /8.
 *
 * 3. **u16le enum WITHOUT enumValueScale** — Session 50 fix.
 *    `delaytimesyncon` (FX_DELAYS_SYNC_ON, wireMax: 20),
 *    `lfo*ratesyncon` (LFO_RATES_SYNC_ON, wireMax: 26),
 *    `*delaysyncon` (ENV_LFO_RATES_SYNC_ON, [0,28]),
 *    `*attacksyncon` / `*holdsyncon` / `*decaysyncon` /
 *    `*releasesyncon` / `*fadeinsyncon` (ENV_LFO_RATES_SYNC_ON,
 *    [0,27]). NRPN wire IS the enum index (small range). The device's
 *    patch-buffer decode (`data[pos] | (data[pos+1] << 8)` per
 *    ASMHydrasynth.java set2/get2) reads byte N as the raw index —
 *    NO /8 transform. But our writePatchValue u16le path always
 *    applies /8. Without this branch, `delaytimesyncon: "1/2 D"`
 *    (wire 18) wrote patch byte 2 (round(18/8)) → device decoded
 *    "1/32 T" (FX_DELAYS_SYNC_ON[2]). We pre-multiply by 8 here so
 *    writePatchValue's /8 cancels it out — wire 18 → 144 → byte 18.
 *    Detection: enumTable set, no enumValueScale, u16le slot.
 */
function patchBufferValueFor(name: string, wireValue: number, spec: PatchOffsetSpec): number {
  const entry = HYDRASYNTH_NRPNS.find((e) => e.name === name);
  if (entry === undefined) return wireValue;
  // Case 3: u16le enum-as-raw-index. Pre-multiply to cancel u16le /8.
  if (
    spec.enc === 'u16le' &&
    entry.enumTable !== undefined &&
    entry.enumValueScale === undefined
  ) {
    if (wireValue < 0) {
      throw new Error(`encodePatch: enum-indexed "${name}" wire ${wireValue} is negative`);
    }
    return wireValue * PATCH_U16LE_WIRE_DIVISOR;
  }
  if (entry.enumValueScale === undefined) return wireValue;
  // Case 1: u8 enum-scaled — undo scale to get raw idx.
  if (spec.enc !== 'u8') return wireValue;
  // Sanity: the wire value should be an integer multiple of the scale
  // (resolveNrpnValue produces idx × scale). If a caller bypasses the
  // resolver and hand-rolls the wire value, mod-out cleanly to the
  // nearest index — better than silently truncating.
  const idx = Math.round(wireValue / entry.enumValueScale);
  if (idx < 0) {
    throw new Error(`encodePatch: enum-scaled "${name}" wire ${wireValue} resolved to negative index ${idx}`);
  }
  return idx;
}

/**
 * Extract the curated subset of params from a patch buffer. Returns a
 * `Map<canonicalName, value>` containing every entry in `PATCH_OFFSETS`.
 *
 * Useful for: round-trip tests, reading a slot via `hydra_request_patch`,
 * comparing two patches.
 */
export function decodePatch(buf: Uint8Array): Map<string, number> {
  if (buf.length !== PATCH_BUFFER_SIZE) {
    throw new Error(`patch buffer must be ${PATCH_BUFFER_SIZE} bytes, got ${buf.length}`);
  }
  const out = new Map<string, number>();
  for (const spec of PATCH_OFFSETS) {
    const raw = readPatchValue(buf, spec);
    out.set(spec.name, wireValueFromPatchBuffer(spec.name, raw, spec));
  }
  return out;
}

/**
 * Inverse of `patchBufferValueFor`. `readPatchValue` returns the
 * "wire" interpretation by convention — for u16le slots, that's
 * `byte × 8` (assuming the standard 14-bit wire-to-patch divisor).
 * For enum-as-raw-index slots (Case 3 in patchBufferValueFor), the
 * patch byte IS the index and `byte × 8` is the wrong wire — undo
 * it here so a decode → encode round-trip is byte-stable.
 *
 * For `delaytimesyncon` with byte=18 (FX_DELAYS_SYNC_ON[18] = "1/2 D"):
 *   readPatchValue returns 18 × 8 = 144.
 *   This helper undoes the ×8 → returns 18 (the canonical NRPN wire).
 *   Re-encoding 18 goes through patchBufferValueFor's pre-multiply →
 *   144 → writePatchValue /8 → byte 18. Round trip stable.
 */
function wireValueFromPatchBuffer(name: string, raw: number, spec: PatchOffsetSpec): number {
  if (spec.enc !== 'u16le') return raw;
  const entry = HYDRASYNTH_NRPNS.find((e) => e.name === name);
  if (entry === undefined) return raw;
  if (entry.enumTable !== undefined && entry.enumValueScale === undefined) {
    return Math.round(raw / PATCH_U16LE_WIRE_DIVISOR);
  }
  return raw;
}

/**
 * Return a fresh clone of `INIT_PATCH_BUFFER` — the audible factory
 * INIT patch extracted from ASM Hydrasynth Manager's bundled
 * `Single INIT Bank.hydra` and baked into source via
 * `scripts/hydrasynth/bake-init-patch.ts`.
 *
 * Use as the base buffer for `encodePatch()` when the caller doesn't
 * supply their own — overrides land on top of an audible-by-construction
 * default instead of an all-zeros buffer (which would have bipolar
 * params at their negative extreme = filter slammed shut + silence).
 */
export function defaultPatchBuffer(): Uint8Array {
  return new Uint8Array(INIT_PATCH_BUFFER);
}

// ---------------------------------------------------------------------------
// Patch-name helpers.
// ---------------------------------------------------------------------------

/**
 * Write a patch name into the buffer at bytes 9..24. ASCII only; longer
 * names are truncated to 16 chars; shorter names are zero-padded.
 *
 * Note: byte 8 ("Category") is left untouched — the spec calls out that
 * byte 9 is "Patch Name Start" but that byte 8 uses the same MSB
 * position. Callers writing patch metadata should set Category first.
 */
export function writePatchName(buf: Uint8Array, name: string): void {
  if (buf.length !== PATCH_BUFFER_SIZE) {
    throw new Error(`patch buffer must be ${PATCH_BUFFER_SIZE} bytes, got ${buf.length}`);
  }
  for (let i = 0; i < PATCH_NAME.maxLength; i++) {
    const c = i < name.length ? name.charCodeAt(i) : 0;
    if (c > 0x7f) {
      throw new Error(`patch name char ${i} ("${name[i]}") is non-ASCII (0x${c.toString(16)})`);
    }
    buf[PATCH_NAME.startByte + i] = c;
  }
}

/** Read a patch name back out of a buffer; trailing zeros are trimmed. */
export function readPatchName(buf: Uint8Array): string {
  if (buf.length !== PATCH_BUFFER_SIZE) {
    throw new Error(`patch buffer must be ${PATCH_BUFFER_SIZE} bytes, got ${buf.length}`);
  }
  let s = '';
  for (let i = 0; i < PATCH_NAME.maxLength; i++) {
    const c = buf[PATCH_NAME.startByte + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Wire-chunking — slice a 2790-byte patch into 22 device chunks.
// ---------------------------------------------------------------------------

/**
 * A single chunk-dump info payload, ready to be `wrapSysex`'d:
 *   `[0x16, 0x00, CHUNK_INDEX, 0x16, …data…]`
 *
 * Chunks 0..20 carry 128 data bytes; chunk 21 carries 102.
 */
export interface PatchChunk {
  readonly index: number;
  readonly info: Uint8Array;
}

/**
 * Slice a `PATCH_BUFFER_SIZE`-byte patch buffer into the 22 chunks
 * the device expects. Each returned chunk's `info` already includes
 * the 4-byte chunk-dump header `[0x16, 0x00, CHUNK, 0x16]`; pass it
 * straight to `wrapSysex(chunk.info)` to produce the wire bytes.
 */
export function splitIntoChunks(buf: Uint8Array): PatchChunk[] {
  if (buf.length !== PATCH_BUFFER_SIZE) {
    throw new Error(`patch buffer must be ${PATCH_BUFFER_SIZE} bytes, got ${buf.length}`);
  }
  const chunks: PatchChunk[] = [];
  for (let i = 0; i < PATCH_CHUNK_COUNT; i++) {
    const isLast = i === PATCH_CHUNK_COUNT - 1;
    const size = isLast ? PATCH_LAST_CHUNK_SIZE : PATCH_CHUNK_SIZE;
    const start = i * PATCH_CHUNK_SIZE;
    const data = buf.subarray(start, start + size);
    const info = new Uint8Array(4 + size);
    info[0] = 0x16;
    info[1] = 0x00;
    info[2] = i;
    info[3] = 0x16;
    info.set(data, 4);
    chunks.push({ index: i, info });
  }
  return chunks;
}

/**
 * Concatenate 22 chunk-dump info payloads back into a single
 * `PATCH_BUFFER_SIZE`-byte patch buffer. Inverse of `splitIntoChunks`.
 *
 * Each `chunks[i].info` must start with `[0x16, 0x00, i, 0x16]` and
 * carry the appropriate data length (128 for chunks 0..20, 102 for
 * chunk 21).
 */
export function concatChunks(chunks: ReadonlyArray<PatchChunk>): Uint8Array {
  if (chunks.length !== PATCH_CHUNK_COUNT) {
    throw new Error(`expected ${PATCH_CHUNK_COUNT} chunks, got ${chunks.length}`);
  }
  const out = new Uint8Array(PATCH_BUFFER_SIZE);
  for (let i = 0; i < PATCH_CHUNK_COUNT; i++) {
    const c = chunks[i];
    if (c.index !== i) {
      throw new Error(`chunk ${i} has wrong index ${c.index}`);
    }
    const isLast = i === PATCH_CHUNK_COUNT - 1;
    const expectedSize = isLast ? PATCH_LAST_CHUNK_SIZE : PATCH_CHUNK_SIZE;
    if (c.info.length !== 4 + expectedSize) {
      throw new Error(`chunk ${i} info length ${c.info.length} != expected ${4 + expectedSize}`);
    }
    if (c.info[0] !== 0x16 || c.info[1] !== 0x00 || c.info[2] !== i || c.info[3] !== 0x16) {
      throw new Error(`chunk ${i} has bad header bytes`);
    }
    out.set(c.info.subarray(4), i * PATCH_CHUNK_SIZE);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cross-reference helpers (used by goldens; useful diagnostics surface).
// ---------------------------------------------------------------------------

/**
 * Names in `PATCH_OFFSETS` that are not present in the canonical
 * `HYDRASYNTH_NRPNS` registry. Returns an empty array if the table
 * is consistent. Run from a golden to catch typos at test time.
 */
export function unmappedPatchOffsets(): string[] {
  const known = new Set<string>();
  for (const e of HYDRASYNTH_NRPNS as readonly HydrasynthNrpn[]) {
    known.add(e.name);
  }
  const orphaned: string[] = [];
  for (const spec of PATCH_OFFSETS) {
    if (!known.has(spec.name)) orphaned.push(spec.name);
  }
  return orphaned;
}
