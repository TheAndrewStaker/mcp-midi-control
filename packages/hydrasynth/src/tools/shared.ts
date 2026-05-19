/**
 * Hydrasynth tools — shared helpers, MIDI lazy-init, constants, and the
 * long preamble / cheat-sheet strings prepended to most tool descriptions.
 *
 * Every per-family file under `src/asm/hydrasynth-explorer/tools/` imports
 * from here. The lazy-MIDI surface (`ensureMidi` / `resetMidiHandle`),
 * the note/bank/slot parsers, the bank-PC dance, the inbound-message
 * decoder, and the `runEngineParamBatch` NRPN-batch executor are the
 * core utilities the tool handlers reach for.
 */

import { connectHydrasynth, type HydrasynthConnection } from '../midi.js';
import { unwrapSysex } from '../sysexEnvelope.js';
import { findHydraNrpn, type HydrasynthNrpn } from '../nrpn.js';
import { findMatchingNrpns, nrpnMessagesFor, resolveNrpnValue } from '../encoding.js';

// -- MIDI lazy-init -------------------------------------------------------

let midi: HydrasynthConnection | undefined;
let midiError: Error | undefined;

export function ensureMidi(): HydrasynthConnection {
  if (midi) return midi;
  if (midiError) throw midiError;
  try {
    midi = connectHydrasynth();
    return midi;
  } catch (err) {
    midiError = err instanceof Error ? err : new Error(String(err));
    throw midiError;
  }
}

/**
 * Last successful `hydra_apply_patch` call's overrides + timestamp.
 * Used to flag near-duplicate retries — Session 48 ambient-pad bug:
 * Claude Desktop misread the missing chunk-acks as failure and looped
 * the same call four times. The retry detection is a soft signal in
 * the response text only; the wire write still happens (the user
 * might be deliberately re-testing).
 */
export let lastApplyPatch: { signature: string; targetSlot: string; at: number } | undefined;

export function recordApplyPatch(signature: string, targetSlot: string, at: number): void {
  lastApplyPatch = { signature, targetSlot, at };
}

export const APPLY_PATCH_DUP_WINDOW_MS = 30_000;

/**
 * Reset cached MIDI state so the next `ensureMidi()` re-attempts connect.
 * Used by `hydra_reconnect_midi` when the user plugs in the device after
 * the server has already cached "not connected" — without this, every
 * subsequent tool call keeps throwing the same stale error forever.
 *
 * Session 47 / HW-060 follow-up: founder reported the device-plugged-
 * in-mid-session case where list_midi_ports saw the device momentarily
 * but apply_patch kept failing because the cached midiError prevented
 * re-connect.
 */
export function resetMidiHandle(): { wasConnected: boolean; previousError: string | undefined } {
  const wasConnected = midi !== undefined;
  const previousError = midiError?.message;
  if (midi) {
    try {
      midi.close?.();
    } catch {
      // best-effort close — if it throws, the underlying handle is
      // dead anyway and we want to reset on the way out.
    }
  }
  midi = undefined;
  midiError = undefined;
  return { wasConnected, previousError };
}

// -- MIDI-byte helpers ----------------------------------------------------

export const DEFAULT_CHANNEL = 1;

export function ccBytes(channel: number, cc: number, value: number): number[] {
  const status = 0xB0 | ((channel - 1) & 0x0F);
  return [status, cc & 0x7F, value & 0x7F];
}

/**
 * Send a Hydrasynth NRPN write — 4 sequential CC messages.
 *
 * Each CC must be its own `sendMessage()` call. node-midi expects one
 * MIDI message per invocation; bundling 12 bytes into one call makes
 * the device only see the first CC (the NRPN address MSB).
 *
 * Encoding logic (multi-slot dataMsb, 14-bit value split) lives in
 * `encoding.ts` so it can be golden-tested without a MIDI handle.
 */
export function sendNrpn(conn: HydrasynthConnection, channel: number, entry: HydrasynthNrpn, value: number): void {
  for (const msg of nrpnMessagesFor(entry, channel, value)) {
    conn.send(msg);
  }
}

export function programChangeBytes(channel: number, program: number): number[] {
  const status = 0xC0 | ((channel - 1) & 0x0F);
  return [status, program & 0x7F];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// -- Slot parser ----------------------------------------------------------

/**
 * Parse a slot string like "A001" or "H128" into wire-format bank/patch
 * indices. Letter A..H → bank 0..7. Patch 1..128 → wire 0..127 (device
 * displays 1-indexed; SysEx wire format is 0-indexed). Returns the
 * parsed pair plus a normalized display string for response formatting.
 */
export function parseSlot(s: string): { bank: number; patch: number; display: string } {
  const m = s.trim().toUpperCase().match(/^([A-H])(\d{1,3})$/);
  if (!m) {
    throw new Error(`Slot "${s}" must be like "A001" or "H128" (letter A..H + patch 1..128).`);
  }
  const bank = m[1]!.charCodeAt(0) - 'A'.charCodeAt(0);
  const num = Number.parseInt(m[2]!, 10);
  if (num < 1 || num > 128) {
    throw new Error(`Slot "${s}" patch number must be 1..128, got ${num}.`);
  }
  return {
    bank,
    patch: num - 1,
    display: `${m[1]}${num.toString().padStart(3, '0')}`,
  };
}

// -- SysEx pacing constants ----------------------------------------------

/**
 * Pacing between SysEx chunks in milliseconds. The Hydrasynth ack-replies
 * after each chunk per `SysexEncoding.txt:351-352`. Diagnostic-mode
 * `hydra_apply_init` now records every inbound message so we can see
 * whether acks arrive — but the send loop still uses time-based pacing,
 * not ack-driven flow control. 5 ms is conservative: above MIDI 1.0's
 * bandwidth floor and slow enough that the device's per-chunk processing
 * should keep up. If the HW-040 capture shows acks but missing chunks,
 * this is the first knob to bump.
 */
export const SYSEX_CHUNK_PACING_MS = 5;

/**
 * After the bank/PC dance completes, drain inbound MIDI for this many ms
 * so straggling SysEx acks (especially the final Patch Saved + Footer
 * Response, which arrive after a slot-load delay) make it into the
 * capture before the tool returns. Cheap; only used by `hydra_apply_init`.
 */
export const SYSEX_TAIL_DRAIN_MS = 300;

/**
 * Pause required after sending a Write Request (`14 00`). Per
 * `SysexEncoding.txt:328-329`: "After performing this operation, you
 * will need to pause for at least 3500ms (yes, you heard that right:
 * *3.5 seconds*) before sending the Hydrasynth anything else,
 * including notes." The Hydrasynth is busy persisting to flash
 * during this window. Skipping the pause risks corrupting the patch
 * write or dropping subsequent MIDI.
 */
export const WRITE_REQUEST_FLASH_PAUSE_MS = 3500;

// -- Inbound-message decoder ---------------------------------------------

/**
 * Decode an inbound message into a short human-readable label. SysEx is
 * unwrapped via `unwrapSysex` so we can recognize Hydrasynth's documented
 * acks (`SysexEncoding.txt:342-378`):
 *   - `19 00`           → Header Response
 *   - `17 00 NN 16`     → Chunk Ack #NN
 *   - `07 00 BB PP`     → Patch Saved (bank=BB, patch=PP)
 *   - `1B 00`           → Footer Response
 * Anything else (or non-SysEx) is shown as raw hex with a status-byte
 * label so we can still see CC/PC echoes that the device emits during
 * the bank/PC dance.
 */
export function describeInboundMessage(bytes: number[]): string {
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  if (bytes[0] === 0xf0) {
    let info: Uint8Array;
    try {
      info = unwrapSysex(bytes);
    } catch (err) {
      return `SysEx (envelope error: ${err instanceof Error ? err.message : String(err)}) ${hex}`;
    }
    if (info.length === 2 && info[0] === 0x19 && info[1] === 0x00) return 'Header Response (19 00)';
    if (info.length === 2 && info[0] === 0x1b && info[1] === 0x00) return 'Footer Response (1B 00)';
    if (info.length === 4 && info[0] === 0x17 && info[1] === 0x00 && info[3] === 0x16) {
      return `Chunk Ack #${info[2]} (17 00 ${info[2]!.toString(16).padStart(2, '0').toUpperCase()} 16)`;
    }
    if (info.length === 4 && info[0] === 0x07 && info[1] === 0x00) {
      return `Patch Saved (bank=${info[2]}, patch=${info[3]})`;
    }
    const infoHex = Array.from(info)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
    return `SysEx (info: ${infoHex})`;
  }
  const status = bytes[0] ?? 0;
  if ((status & 0xf0) === 0xb0) return `CC ch=${(status & 0x0f) + 1} #${bytes[1]}=${bytes[2]} (${hex})`;
  if ((status & 0xf0) === 0xc0) return `PC ch=${(status & 0x0f) + 1} program=${bytes[1]} (${hex})`;
  if ((status & 0xf0) === 0x90) return `NoteOn ch=${(status & 0x0f) + 1} note=${bytes[1]} vel=${bytes[2]} (${hex})`;
  if ((status & 0xf0) === 0x80) return `NoteOff ch=${(status & 0x0f) + 1} note=${bytes[1]} (${hex})`;
  return `Other ${hex}`;
}

// -- Bank/PC dance constants ---------------------------------------------

/**
 * Scratch slot for `hydra_apply_init` SysEx dumps. Per
 * `SysexEncoding.txt:645`: "your best strategy is probably to use a
 * 'scratch patch', like H 127, and update it instead." H = bank 7,
 * patch 127 (0-indexed) = displayed "H128", the last slot of bank H.
 * Using a fixed scratch keeps the user's edited patches in lower banks
 * untouched and contains the NOTE 0 cross-write-affects-bank-mate
 * footgun to a corner of the patch space.
 */
export const SCRATCH_BANK = 7; // H
export const SCRATCH_PATCH = 127; // displayed 128

/**
 * Bounce target for the bank/PC dance (both pre-dump and post-dump).
 * Different bank from H (so the bank-change is effective regardless of
 * current bank) AND different patch from 128 (so the PC is effective
 * regardless of current patch). E064 is far from any plausible "user
 * just pressed INIT" starting location (A001), so the dance won't
 * NOOP if the founder presses INIT before testing — the failure mode
 * we hit on the first HW-040 test 1 run.
 */
export const BOUNCE_BANK = 4; // E
export const BOUNCE_PATCH = 63; // displayed 64

/**
 * Run the bank/PC dance: bounce off `BOUNCE_BANK`/`BOUNCE_PATCH`, pause
 * 150 ms (per `SysexEncoding.txt:657`), settle on `target`, pause 200 ms
 * (per spec line 658).
 *
 * Used by `hydra_apply_init` (settle on the scratch slot H128) and by
 * `hydra_apply_init_to` (settle on a caller-chosen slot for diagnostic
 * tests — typically the user's currently-active patch).
 *
 * Bank MSB is always 0 on the Explorer. Bank LSB selects 0..7 = A..H.
 */
export async function bankPcDance(
  conn: HydrasynthConnection,
  target: { bank: number; patch: number },
): Promise<void> {
  conn.send(ccBytes(DEFAULT_CHANNEL, 0, 0));               // Bank MSB = 0
  conn.send(ccBytes(DEFAULT_CHANNEL, 32, BOUNCE_BANK));    // Bank LSB → E
  conn.send(programChangeBytes(DEFAULT_CHANNEL, BOUNCE_PATCH));
  await sleep(150);
  conn.send(ccBytes(DEFAULT_CHANNEL, 0, 0));               // Bank MSB = 0
  conn.send(ccBytes(DEFAULT_CHANNEL, 32, target.bank));    // Bank LSB → target
  conn.send(programChangeBytes(DEFAULT_CHANNEL, target.patch));
  await sleep(200);
}

// -- Tool-description preamble + cheat sheets ----------------------------

/**
 * Single-line dev-mode preamble prepended to every Hydrasynth tool's
 * description. Tells the calling LLM (Claude Desktop, primarily) that
 * the surface is changing — memorized param names, ranges, or behaviors
 * from prior sessions may be stale. Live tool descriptions and error
 * messages are authoritative.
 *
 * Kept compact (one paragraph) so it doesn't bury the actual tool
 * documentation. Single-source so cross-tool wording stays consistent.
 */
export const HYDRA_DEV_MODE_PREAMBLE = [
  '⚠ This Hydrasynth tool surface is in active development. Treat THIS',
  '  description and runtime error messages as authoritative — do NOT',
  '  rely on memorized param names, value ranges, or behaviors from',
  '  prior sessions. If a write fails on a name, call',
  '  `hydra_param_catalog({ search: "<keyword>" })` to see what is',
  '  currently mapped. Tool API may change between sessions.',
  '',
].join('\n');

/**
 * Inline cheat sheet of common engine parameter names — shared by both
 * `hydra_set_engine_param` and `hydra_set_engine_params` descriptions.
 *
 * The catalog is large (1175 entries) but most patch-design work uses
 * the same ~50 parameters. Listing them in the tool description means
 * Claude doesn't need to call `hydra_param_catalog` to discover names —
 * which was burning multiple round-trips per patch build.
 *
 * Naming patterns to deduce the rest:
 *   - Slot families (osc1/2/3, env1/2/3/4/5, lfo1/2/3/4/5, filter1/2,
 *     mutator1/2/3/4, mod1..32) follow {family}{slot}{field} convention:
 *     osc1type, env3decaysyncoff, lfo2gain, etc.
 *   - Time-domain envelope+lfo params have *syncoff* (free-running ms)
 *     and *syncon* (BPM-synced) variants — use *syncoff* by default.
 *   - CC-style dot names ("env1.attack", "mixer.osc1_vol", "filter1.res")
 *     are accepted as aliases everywhere alongside the canonical NRPN
 *     names — pick whichever feels natural.
 */
export const ENGINE_PARAM_CHEAT_SHEET = `
Common parameter names (both styles work — pick whichever):

OSCILLATORS  — osc1/osc2/osc3 (slot-disambiguated):
  osc1type / osc2type / osc3type           wave selector — accepts names: "Sine", "Triangle", "Saw", "Square", "Pulse 1".."Pulse 6", "Horizon 1..8", and ~200 more (call hydra_list_enum_values("OSC_WAVES"))
  osc1semi / osc2semi / osc3semi           coarse pitch (-36..+36 semitones)
  osc1cent / osc2cent / osc3cent           fine tune (-50..+50 cents)
  osc1mode / osc2mode / osc3mode           "Single" or "WaveScan"
  osc1wavscan / osc2wavscan                wavescan position
  osc1keytrack / osc2keytrack / osc3keytrack

MIXER  (canonical or dot-style):
  mixerosc1vol / mixer.osc1_vol            OSC 1 volume
  mixerosc2vol / mixer.osc2_vol            OSC 2 volume
  mixerosc3vol / mixer.osc3_vol            OSC 3 volume
  mixerosc1pan / mixer.osc1_pan            OSC 1 pan (etc. for osc2/osc3)
  mixernoisevol / mixer.noise_vol          noise volume
  mixerringmodvol / mixer.ring_mod_vol     ring-mod volume

FILTER 1  (use names for type — "LP Ladder 12", "LP Ladder 24", "Vowel", "BP 3-Ler", etc., 16 options):
  filter1type
  filter1cutoff / filter1.cutoff
  filter1resonance / filter1.res
  filter1drive / filter1.drive
  filter1keytrack / filter1.keytrack
  filter1env1amount, filter1lfo1amount, filter1velenv

FILTER 2  (only "LP-BP-HP" or "LP-Notch-HP" types):
  filter2type
  filter2cutoff, filter2resonance, filter2env1amount, filter2lfo1amount, filter2velenv, filter2keytrack

ENVELOPES  — 5 envelopes total. Conventional routing (mod matrix can re-route any of these):
   • ENV1 → Filter (the canonical filter envelope; pair with filter1env1amount)
   • ENV2 → Amp    (the canonical amplifier envelope; the device's "amp env" front-panel page edits ENV2)
   • ENV3/4/5 → assignable (typically pitch / mod-matrix targets via mod*modsource = "ENV3"…)
  Default to syncoff variants for free-running times.
  env1.attack  / env1attacksyncoff
  env1.decay   / env1decaysyncoff
  env1.sustain / env1sustain
  env1.release / env1releasesyncoff
  env1holdsyncoff, env1delaysyncoff
  Same shape for env2..env5 (e.g. env2attacksyncoff for amp-env attack — the Eno-pad slow-attack knob).

LFOS — 5 LFOs. Conventional routing (mod matrix can re-route any LFO):
   • LFO1 → Filter (paired with filter1lfo1amount; classic filter wobble)
   • LFO2 → Amp    (paired with amplfo2amount; tremolo)
   • LFO3/4/5 → assignable (pitch vibrato, pan, FX param modulation via mod matrix)
  Per-LFO params:
  lfo1ratesyncoff, lfo1wave, lfo1level (alias: lfo1.gain — NOT "lfo1gain"), lfo1phase, lfo1delaysyncoff, lfo1fadeinsyncoff, lfo1smooth, lfo1steps, lfo1oneshot
  Same shape for lfo2..lfo5.

PRE-FX / POST-FX  (use names for type — "Bypass", "Chorus", "Flanger", "Rotary", "Phaser", "Lo-Fi", "Tremolo", "EQ", "Compressor", "Distortion"):
  prefxtype, postfxtype
  prefxparam1, prefxparam2, prefxwet
  postfxparam1, postfxparam2, postfxwet

DELAY / REVERB  (between Pre-FX and Post-FX):
  delaytype, delaytimesyncoff, delayfeedback, delaywet
  reverbtype (Hall/Room/Plate/Cloud), reverbtime (0..128 index — pass an integer or a string from REVERB_TIMES like "16.0s"), reverbtone (bipolar -64..+64), reverbpredelay (0..250 ms), reverbwet

VOICE / GLOBAL:
  voiceglide (BOOL — must be 1 to enable portamento; voiceglidetime alone does nothing if voiceglide=0)
  voiceglidetime, voiceglidecurve, voiceglidelegto
  voicelegato, voicemono, voicepolyphony
  vibratoamount, vibratorate, vibratobpmsync
  Note: a glide recipe needs BOTH voiceglide=1 AND voiceglidetime=N — pass them together, the time alone doesn't audibly do anything.

MUTATORS (4) — operate on oscillators (front-panel layout: Mutator 1/2 affect Osc 1; Mutator 3/4 affect Osc 2):
  mutator1mode (use names: "FM-Linear", "WavStack", "Osc Sync", "PW-Orig", "PW-Sqeez", "PW-ASM", "Harmonic", "PhazDiff")
  mutator1ratio, mutator1depth, mutator1wet (NOT mutator1drywet — common typo)
  Same shape for mutator2..mutator4.

MOD MATRIX  (32 slots — note edisyn names use "modmatrix" prefix):
  modmatrix1modsource    — source (LFO, ENV, velocity, aftertouch, …)
  modmatrix1modtarget    — destination (osc pitch, filter cutoff, …); set to 0 to disable a slot
  modmatrix1depth        — modulation amount
  ... modmatrix32modsource / modmatrix32modtarget / modmatrix32depth

MACROS:
  macro1value..macro8value (also patch-defined CCs 16-23)

VALUE NOTES:
  - **Unipolar params (most knobs).** Numbers 0..128 auto-scale onto each param's wireMax. value=64 → display 64.0, value=128 → max. Numbers 129..16383 pass through as raw 14-bit wire values.
  - **Bipolar params** (env amounts, pan, keytrack, mod-matrix depth, EQ gain, lfo/fx phase). Pass a SIGNED display value: \`value: 0\` is centered (no modulation), \`value: +N\` and \`-N\` offset symmetrically. Examples: filter1env1amount=0 (no env mod), filter1env1amount=12 (display +12, mild brightening), filter1keytrack=0 (off), mixerosc1pan=-30 (left). The tool response calls these out as \`[bipolar -X..+Y, display ±N]\` so you see the resolution. Common ranges: env amounts / pan / lfo amounts = -64..+64; keytrack = -200..+200; macros = -128..+128.
  - **Type-selector params** (osc*type, filter*type, prefxtype, postfxtype, mutator*mode): pass the display name string — auto-resolved.
`.trim();

/**
 * Seconds-to-index quick lookup for the exponential env-time and LFO-delay
 * inputs. The Hydrasynth maps these via a non-linear bucket schedule (see
 * nrpn.ts notes for env1attacksyncoff line 637 and env1decaysyncoff line
 * 639), so an agent picking idx 98 expecting "near 100% scale" actually
 * gets 4.60s. These tables let an agent translate a target time straight
 * into the floored index. Verified against
 * scripts/hydrasynth/verify-env-time-display.ts; values are exact.
 *
 * Inlined into the descriptions of any tool that writes env*attacksyncoff
 * / env*holdsyncoff / env*decaysyncoff / env*releasesyncoff /
 * lfo*delaysyncoff / lfo*fadeinsyncoff so the agent sees the table
 * regardless of which write path it reaches for.
 */
export const ENV_TIME_SECONDS_TO_INDEX = [
  '  SECONDS-TO-INDEX QUICK LOOKUP (exponential mapping. Idx 98 displays',
  '  4.60s, NOT "near 100% scale". Use these floored values; do not compute',
  '  on the fly. Verified against the bucket schedule in nrpn.ts.):',
  '',
  '  ATTACK / HOLD / lfo*delaysyncoff / lfo*fadeinsyncoff (idx 0..128, max 36s):',
  '    100ms = idx 42 (96ms)    200ms = idx 52 (192ms)',
  '    500ms = idx 65 (480ms)   750ms = idx 71 (704ms)',
  '    1s    = idx 75 (960ms)   2s    = idx 85 (1.92s)',
  '    3s    = idx 91 (2.81s)   5s    = idx 99 (4.86s)',
  '    10s   = idx 110          20s   = idx 120     36s = idx 128',
  '',
  '  DECAY / RELEASE (idx 0..127, max 60s):',
  '    100ms = idx 32 (96ms)    200ms = idx 42 (192ms)',
  '    500ms = idx 55 (480ms)   750ms = idx 61 (704ms)',
  '    1s    = idx 65 (960ms)   2s    = idx 75 (1.92s)',
  '    3s    = idx 81 (2.81s)   5s    = idx 89 (4.86s)',
  '    10s   = idx 100          16s   = idx 106',
  '    30s   = idx 113          60s   = idx 127 (58s, the table caps here)',
  '',
  '  Verifier: scripts/hydrasynth/verify-env-time-display.ts replays the',
  '  bucket schedule so any "sent N, device shows X" surprise can be',
  '  confirmed as documented mapping vs wire-path bug.',
].join('\n');

// -- NRPN batch executor (shared by hydra_set_engine_params) -------------

/**
 * Shared write-batch implementation backing `hydra_set_engine_params`.
 * Resolves each entry through `resolveNrpnValue`, sends each as a 4-CC
 * sequence with ~3 ms pacing, and formats a response with one line per
 * write.
 */
export async function runEngineParamBatch(
  params: Array<{ name: string; value: number | string }>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const conn = ensureMidi();
  const errors: string[] = [];
  const sent: { name: string; raw: number | string; resolved: number; resolvedDataMsb?: number; scaled: boolean; bipolar: boolean; wireMax?: number; displayMin?: number; displayMax?: number }[] = [];

  for (let i = 0; i < params.length; i++) {
    const { name, value } = params[i]!;
    const entry = findHydraNrpn(name);
    if (!entry) {
      const hits = findMatchingNrpns(name, 4);
      const closest = hits.length > 0
        ? ` (closest: ${hits.map((h) => h.entry.name).join(', ')})`
        : '';
      errors.push(`[${i}] "${name}" — unknown${closest}`);
      continue;
    }
    let resolved: number;
    let scaled = false;
    let bipolar = false;
    try {
      const r = resolveNrpnValue(entry, value);
      resolved = r.wire;
      scaled = r.scaled;
      bipolar = r.bipolar;
    } catch (err) {
      errors.push(`[${i}] "${name}" — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    sendNrpn(conn, DEFAULT_CHANNEL, entry, resolved);
    sent.push({ name, raw: value, resolved, resolvedDataMsb: entry.dataMsb, scaled, bipolar, wireMax: entry.wireMax, displayMin: entry.displayMin, displayMax: entry.displayMax });
    if (i < params.length - 1) await sleep(3);
  }

  const userLines = sent.map((s) => {
    const slotNote = s.resolvedDataMsb !== undefined ? ` [slot ${s.resolvedDataMsb}]` : '';
    let valueNote: string;
    if (typeof s.raw === 'string') {
      valueNote = `"${s.raw}" (${s.resolved})`;
    } else if (s.bipolar) {
      const sign = (s.raw as number) >= 0 ? '+' : '';
      valueNote = `${s.raw} → wire ${s.resolved} [bipolar ${s.displayMin}..+${s.displayMax}, display ${sign}${s.raw}]`;
    } else if (s.scaled) {
      valueNote = `${s.raw} → ${s.resolved} (scaled to wireMax ${s.wireMax})`;
    } else {
      valueNote = `${s.resolved}`;
    }
    return `  ${s.name} = ${valueNote}${slotNote}`;
  });
  const lines = userLines.length > 0 ? ['Sent params:', ...userLines] : [];
  const errorBlock = errors.length > 0
    ? `\n\nErrors (${errors.length}):\n${errors.map((e) => `  ${e}`).join('\n')}`
    : '';
  return {
    content: [{
      type: 'text',
      text: `Sent ${sent.length} NRPN write(s) with ~3 ms pacing:\n${lines.join('\n')}${errorBlock}\n\nReminder: requires Param TX/RX = NRPN on the device.`,
    }],
  };
}
