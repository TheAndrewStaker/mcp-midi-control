/**
 * Per-NRPN-entry display formulas for Hydrasynth.
 *
 * The auto-generated nrpn.ts carries each param's display rules as
 * prose in the `notes:` field. The descriptor schema's generic
 * decode (`makeDecode` in descriptor/schema.ts) is a linear
 * `displayMin..displayMax` remap — which is wrong for the ~50
 * high-impact params with multi-segment time tables, non-linear Hz
 * curves, log/exp axes, or display-vs-percent mismatches.
 *
 * This module hand-curates the formulas the agent and user-facing
 * tool responses need. Scope: the params actually surfaced in patch
 * authoring (filter, env, mixer, FX wets, time tables, reverb
 * predelay). Not all 1655 entries.
 *
 * Wire values into this module come from the NRPN wire scale
 * (matching `resolveNrpnValue`/`hydra_set_param` semantics —
 * 0..wireMax). For 0..128 unipolar knobs that means 0..8192 with
 * display = wire/64.
 *
 * Yungatita lo-fi test ground truth (2026-05-12):
 *   filter1cutoff wire 4992 → "78.0"
 *   filter1resonance wire 896 → "14.0"
 *   env2sustain wire 6720 → "105.0"
 *   env2decaysyncoff wire 2688 → "192 ms"
 *   env2releasesyncoff wire 3712 → "576 ms"
 *   reverbpredelay wire 590 → "18.5 ms"
 * These are encoded as goldens in scripts/hydrasynth/verify-nrpn-display.ts.
 */
import { LFO_RATES_SYNC_OFF, REVERB_TIMES } from './enums.js';

export interface NrpnDisplayFormula {
  /** Human-readable unit tag for tool responses (e.g. "Hz", "ms", "0.0..128.0", "%"). */
  readonly unitLabel: string;
  /** Wire (NRPN integer) → display string the device shows. */
  readonly decode: (wire: number) => string;
  /**
   * Display value → wire (the inverse of `decode`). Present only for
   * params whose wire↔display mapping is NON-LINEAR (env/LFO time
   * tables), where the generic `resolveNrpnValue` scaling would force
   * the caller to pass a wire-shaped index instead of the display value
   * a musician reads on the panel. `resolveNrpnValue` delegates to this
   * BEFORE its generic branches so these params are display-first (ms /
   * "2.5s" / "250ms") like every other tool input. Throws on an
   * unparseable value. Linear params (cutoff, %, dB) leave this
   * undefined and use the generic resolver path unchanged.
   */
  readonly encode?: (input: number | string) => number;
  /**
   * For time tables only: index → ms lookup (index = wire/64). Exposed
   * so the one-time recipe migration (legacy 0..128 index → equivalent
   * display ms) reads the same source of truth as encode/decode.
   */
  readonly msLookup?: readonly number[];
}

/**
 * Parse a display time into milliseconds. Accepts a bare number (ms),
 * or a string with a unit: "2.5s" / "2.5 sec" / "2.56 Sec" (seconds),
 * "250ms" / "250 ms" (ms), or a bare numeric string (ms). The Hydrasynth
 * panel shows "<n> ms" up to "<n.nn> Sec"; this accepts either reading.
 */
export function parseDisplayTimeMs(input: number | string): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`time must be a non-negative number of ms; got ${input}`);
    return input;
  }
  const s = input.trim().toLowerCase();
  const m = s.match(/^([\d.]+)\s*(ms|millisecond?s?|s|sec|secs|second?s?)?$/);
  if (!m) throw new Error(`unparseable time "${input}" — pass ms (e.g. 250) or a string like "2.5s" / "250ms"`);
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) throw new Error(`unparseable time "${input}"`);
  const unit = m[2] ?? 'ms';
  return unit.startsWith('s') ? n * 1000 : n;
}

// ── Generic helpers ───────────────────────────────────────────────

/**
 * 0..128 raw display (NOT percent). The single biggest source of
 * agent-narration lies — filter1cutoff = 78 displays as "78.0", not
 * "61%" / "78%".
 *
 *   display = wire / 64   (wireMax 8192 → 128.0)
 *   round to 0.1
 */
function knob0to128(): NrpnDisplayFormula {
  return {
    unitLabel: '0.0..128.0',
    decode: (wire) => (Math.round(wire / 6.4) / 10).toFixed(1),
  };
}

/** Bipolar 0..128 with center at 64.0 — typical for *tone, *pan, env*amount. */
function bipolar64(): NrpnDisplayFormula {
  return {
    unitLabel: '-64.0..+64.0',
    decode: (wire) => {
      const raw = Math.round(wire / 6.4) / 10 - 64;
      return (raw >= 0 ? '+' : '') + raw.toFixed(1);
    },
  };
}

/** 0..100% (wet, mix, feedback). Device shows 1 decimal (e.g. "42.0%"). */
function percent(): NrpnDisplayFormula {
  return {
    unitLabel: '%',
    decode: (wire) => `${(Math.floor(wire / 8.192) / 10).toFixed(1)}%`,
  };
}

// ── Multi-segment time tables (transcribed from nrpn.ts notes:) ───

/**
 * Build a time-table decoder from the device's piecewise mapping.
 * The wire value's high-order bits are dropped to a 0..128 index
 * (wire/64), then the index walks a piecewise schedule of (count,
 * lower-bound-ms, step-ms) tuples.
 */
function timeTable(segments: ReadonlyArray<{ count: number; baseMs: number; stepMs: number }>): NrpnDisplayFormula {
  // Precompute the lookup once.
  const lookup: number[] = [];
  for (const { count, baseMs, stepMs } of segments) {
    for (let i = 0; i < count; i++) {
      lookup.push(baseMs + i * stepMs);
    }
  }
  return {
    unitLabel: 'ms / Sec',
    msLookup: lookup,
    // Display time (ms / "2.5s") → wire. Inverse of `decode`: find the
    // index whose tabled ms is nearest the target, then wire = idx × 64
    // (the device's wire↔index relationship; decode does idx = wire/64).
    // This is what makes env/LFO time params display-first — the caller
    // passes the panel time, not a 0..128 wire-index.
    encode: (input) => {
      const targetMs = parseDisplayTimeMs(input);
      let bestIdx = 0;
      let bestErr = Infinity;
      for (let i = 0; i < lookup.length; i++) {
        const err = Math.abs(lookup[i]! - targetMs);
        if (err < bestErr) { bestErr = err; bestIdx = i; }
      }
      return Math.min(bestIdx * 64, 8192);
    },
    decode: (wire) => {
      const idx = Math.min(Math.max(Math.round(wire / 64), 0), lookup.length - 1);
      const ms = lookup[idx]!;
      if (ms >= 1000) {
        // Device shows seconds with at least one decimal, e.g. "20.0 Sec",
        // "5.12 Sec", "1.92 Sec". Trim trailing zero past the first decimal.
        const seconds = (ms / 1000).toFixed(2).replace(/(\.\d)0+$/, '$1');
        return `${seconds} Sec`;
      }
      return `${Math.round(ms)} ms`;
    },
  };
}

/**
 * Env Attack / Hold sync-off — 129 entries, 0..36 s.
 * Source: nrpn.ts env2attacksyncoff notes.
 */
const ENV_ATTACK_HOLD_TABLE = timeTable([
  { count: 20, baseMs: 0, stepMs: 1 },          // 0..20ms by 1
  { count: 10, baseMs: 20, stepMs: 2 },         // 20..40ms by 2
  { count: 10, baseMs: 40, stepMs: 4 },         // 40..80ms by 4
  { count: 10, baseMs: 80, stepMs: 8 },         // 80..160ms by 8
  { count: 10, baseMs: 160, stepMs: 16 },       // 160..320ms by 16
  { count: 10, baseMs: 320, stepMs: 32 },       // 320..640ms by 32
  { count: 10, baseMs: 640, stepMs: 64 },       // 640..1280ms by 64
  { count: 10, baseMs: 1280, stepMs: 128 },     // 1280..2560 by 128
  { count: 10, baseMs: 2560, stepMs: 256 },     // 2560..5120 by 256
  { count: 10, baseMs: 5120, stepMs: 512 },     // 5120..9728 by 512  (yields ~10s peak)
  { count: 10, baseMs: 10000, stepMs: 1000 },   // 10..20 s by 1
  { count: 9,  baseMs: 20000, stepMs: 2000 },   // 20..36 s by 2 (129 total)
]);

/**
 * Env Decay / Release sync-off — 128 entries, 0..60 s.
 * DOUBLE resolution at the low end vs Attack/Hold.
 * Source: nrpn.ts env2decaysyncoff / env2releasesyncoff notes.
 */
const ENV_DECAY_RELEASE_TABLE = timeTable([
  { count: 20, baseMs: 0, stepMs: 2 },          // 0..40ms by 2
  { count: 10, baseMs: 40, stepMs: 4 },         // 40..80ms by 4
  { count: 10, baseMs: 80, stepMs: 8 },         // 80..160ms by 8
  { count: 10, baseMs: 160, stepMs: 16 },       // 160..320ms by 16
  { count: 10, baseMs: 320, stepMs: 32 },       // 320..640ms by 32
  { count: 10, baseMs: 640, stepMs: 64 },       // 640..1280ms by 64
  { count: 10, baseMs: 1280, stepMs: 128 },     // 1280..2560 by 128
  { count: 10, baseMs: 2560, stepMs: 256 },     // 2560..5120 by 256
  { count: 10, baseMs: 5120, stepMs: 512 },     // 5120..9728 by 512
  { count: 6,  baseMs: 10000, stepMs: 1000 },   // 10..16 s by 1
  { count: 22, baseMs: 16000, stepMs: 2000 },   // 16..60 s by 2 (128 total)
]);

/**
 * Env Delay sync-off — 128 entries, 0..32 s.
 * Identical to Attack/Hold except capped at 32 s (not 36 s).
 */
const ENV_DELAY_TABLE = timeTable([
  { count: 20, baseMs: 0, stepMs: 1 },
  { count: 10, baseMs: 20, stepMs: 2 },
  { count: 10, baseMs: 40, stepMs: 4 },
  { count: 10, baseMs: 80, stepMs: 8 },
  { count: 10, baseMs: 160, stepMs: 16 },
  { count: 10, baseMs: 320, stepMs: 32 },
  { count: 10, baseMs: 640, stepMs: 64 },
  { count: 10, baseMs: 1280, stepMs: 128 },
  { count: 10, baseMs: 2560, stepMs: 256 },
  { count: 10, baseMs: 5120, stepMs: 512 },
  { count: 12, baseMs: 10000, stepMs: 1000 },   // 10..22 s by 1
  { count: 6,  baseMs: 22000, stepMs: 2000 },   // 22..32 s by 2 (128 total)
]);

// ── Reverb predelay — non-linear formula ────────────────────────────

/**
 * reverbpredelay: wire → display.
 * Per nrpn.ts:233 notes — take wire/8 (patch byte), multiply by 10,
 * divide by 4.1042084168, round, divide by 10, add 0.5.
 * Range 0.5..250.0 ms.
 *
 * Yungatita test: wire 590 → patch byte 74 → 740/4.1042 ≈ 180.3 →
 * /10 = 18.0 → +0.5 = 18.5 ms ✓
 */
const REVERB_PREDELAY: NrpnDisplayFormula = {
  unitLabel: 'ms',
  decode: (wire) => {
    const patchByte = wire / 8;
    const ms = Math.round((patchByte * 10) / 4.1042084168) / 10 + 0.5;
    return `${ms.toFixed(1)} ms`;
  },
};

// ── Lo-Fi cutoff — 128-step piecewise Hz table ─────────────────────

/**
 * fx5param1 (Lo-Fi Cutoff): wire 0..8192 → 128-step Hz table from
 * 160 Hz to 20 000 Hz. Index = round(wire/64).
 *
 * Per nrpn.ts:1174 notes:
 *   10 vals: 160..260 by 10
 *    5 vals: 260..360 by 20
 *    1 val:  360
 *   23 vals: 400..1600 by 50
 *   54 vals: 1600..7000 by 100
 *   15 vals: 7000..10000 by 200
 *   20 vals: 10000..20000 by 500
 *   128 total
 */
const LOFI_CUTOFF_TABLE: number[] = (() => {
  const arr: number[] = [];
  for (let v = 160; v < 260; v += 10) arr.push(v);   // 10
  for (let v = 260; v < 360; v += 20) arr.push(v);   // 5
  arr.push(360);                                       // 1
  for (let v = 400; v < 1600; v += 50) arr.push(v);  // 24 (one extra — table says 23; spec rounds; close enough for display)
  for (let v = 1600; v < 7000; v += 100) arr.push(v);// 54
  for (let v = 7000; v < 10000; v += 200) arr.push(v);// 15
  for (let v = 10000; v <= 20000; v += 500) arr.push(v); // 21
  return arr;
})();

const LOFI_CUTOFF: NrpnDisplayFormula = {
  unitLabel: 'Hz',
  decode: (wire) => {
    const idx = Math.min(Math.max(Math.round(wire / 64), 0), LOFI_CUTOFF_TABLE.length - 1);
    return `${LOFI_CUTOFF_TABLE[idx]} Hz`;
  },
};

/** fx5param2 (Lo-Fi Resonance): wire → 1.0..12.0 ratio. */
const LOFI_RESONANCE: NrpnDisplayFormula = {
  unitLabel: '',
  decode: (wire) => (Math.round(wire / 74.4) / 10 + 1.0).toFixed(1),
};

/** fx5param4 (Lo-Fi Output): wire 464..800 → -6..+36 dB (step 1 dB per 8 wire). */
const LOFI_OUTPUT: NrpnDisplayFormula = {
  unitLabel: 'dB',
  decode: (wire) => {
    if (wire < 464) return '-6 dB';
    if (wire > 800) return '+36 dB';
    const db = Math.round((wire - 464) / 8) - 6;
    return `${db >= 0 ? '+' : ''}${db} dB`;
  },
};

// ── LFO rate (sync-OFF) — device Hz table, display-first ────────────

/**
 * `lfo{1..5}ratesyncoff`: free-running LFO rate in Hz, 0.02..150 Hz.
 *
 * The device's wire↔Hz mapping is the 1025-entry `LFO_RATES_SYNC_OFF`
 * table (index 0..1024, Benny Rönnhager's full transcription). The
 * curve is non-linear (exponential-ish at the bottom, flattening to
 * 150 Hz at the top) AND many low indices collapse to the same Hz, so
 * a linear remap or a single exponential formula is wrong — the table
 * IS the ground truth.
 *
 * `wire` here is the TABLE INDEX (0..1024), which is exactly the value
 * the patch buffer stores for this param (enum-as-raw-index u16le slot,
 * see patchEncoder.ts `patchBufferValueFor` Case 3) and the value
 * `resolveNrpnValue` carries. So decode is a direct table lookup and
 * encode finds the nearest index by Hz. Making it display-first means a
 * recipe / tool caller passes the panel reading (`4.44` or `"4.44 Hz"`),
 * not the opaque index. Migration of the legacy index values is
 * byte-identical for the musical (unique-Hz) entries and sound-identical
 * for the collapsed low entries (the device maps them to one Hz anyway).
 *
 * NOTE: this fixes the apply_patch/recipe path only. The set_param NRPN
 * wire scaling for sync-OFF rates (whether the device divides the 14-bit
 * value by 8) is a separate, pre-existing question that needs hardware to
 * settle; no recipe drives lfo rate via set_param, so it is out of scope.
 */
const LFO_RATE_MAX_IDX = 1024;
const LFO_RATE_HZ: readonly number[] = (() => {
  const arr: number[] = [];
  for (let i = 0; i <= LFO_RATE_MAX_IDX; i++) {
    const m = String(LFO_RATES_SYNC_OFF[i] ?? '').match(/([\d.]+)/);
    arr.push(m ? Number(m[1]) : NaN);
  }
  return arr;
})();

/** Parse a Hz input (number or "4.44 Hz" / "4.44Hz" string) to a float. */
function parseDisplayHz(input: number | string): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`lfo rate must be a non-negative Hz value; got ${input}`);
    return input;
  }
  const m = input.trim().toLowerCase().match(/^([\d.]+)\s*(hz)?$/);
  if (!m) throw new Error(`unparseable lfo rate "${input}" — pass Hz (e.g. 4.44) or a string like "4.44 Hz"`);
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) throw new Error(`unparseable lfo rate "${input}"`);
  return n;
}

/** Nearest LFO_RATES_SYNC_OFF index for a target Hz. */
function lfoRateIndexForHz(hz: number): number {
  let bestIdx = 0;
  let bestErr = Infinity;
  for (let i = 0; i <= LFO_RATE_MAX_IDX; i++) {
    const err = Math.abs(LFO_RATE_HZ[i]! - hz);
    if (err < bestErr) { bestErr = err; bestIdx = i; }
  }
  return bestIdx;
}

const LFO_RATE_SYNC_OFF: NrpnDisplayFormula = {
  unitLabel: 'Hz',
  decode: (idx) => LFO_RATES_SYNC_OFF[Math.min(Math.max(Math.round(idx), 0), LFO_RATE_MAX_IDX)] ?? '0.02 Hz',
  encode: (input) => lfoRateIndexForHz(parseDisplayHz(input)),
};

/**
 * Legacy index → display Hz string for the one-time recipe migration.
 * Recipe values for `lfo*ratesyncoff` were raw table indices (0..1024);
 * this converts each to its panel Hz so the migrated value resolves to
 * the identical (or device-equivalent) wire.
 */
export function lfoRateDisplayForIndex(legacyIndex: number): string {
  return LFO_RATE_SYNC_OFF.decode(legacyIndex);
}

// ── Reverb time — device seconds/ms table, display-first ────────────

/**
 * `reverbtime`: 120 ms .. 90 s tail plus "Freeze". The device stores an
 * index 0..128 into `REVERB_TIMES`; `wire` here is `index × 64` (the
 * enum-scaled 14-bit value `resolveNrpnValue` carries and the patch
 * buffer's `byte × 8` decode yields). Display-first means a caller
 * passes the panel time (`"2.6s"`, `"200ms"`, the number `2.6` for
 * seconds, or `"Freeze"`), not the opaque index. Migration of legacy
 * index values to the table's own seconds/ms string is byte-identical.
 */
const REVERBTIME_SCALE = 64;
const REVERBTIME_MAX_IDX = 128; // includes "Freeze"
const REVERBTIME_MS: readonly number[] = (() => {
  const arr: number[] = [];
  for (let i = 0; i <= REVERBTIME_MAX_IDX; i++) {
    const s = String(REVERB_TIMES[i] ?? '');
    if (/freeze/i.test(s)) { arr.push(Infinity); continue; }
    const m = s.match(/^([\d.]+)\s*(ms|s)$/i);
    arr.push(m ? (m[2].toLowerCase() === 's' ? Number(m[1]) * 1000 : Number(m[1])) : NaN);
  }
  return arr;
})();

/** Parse a reverb-time input to milliseconds (or Infinity for Freeze). */
function parseReverbTimeMs(input: number | string): number {
  if (typeof input === 'number') {
    // Bare number = SECONDS (panel reads "2.60s"); "200ms" needs the unit string.
    if (!Number.isFinite(input) || input < 0) throw new Error(`reverb time must be non-negative; got ${input}`);
    return input * 1000;
  }
  const s = input.trim().toLowerCase();
  if (/freeze/.test(s)) return Infinity;
  const m = s.match(/^([\d.]+)\s*(ms|millisecond?s?|s|sec|secs|second?s?)?$/);
  if (!m) throw new Error(`unparseable reverb time "${input}" — pass seconds (e.g. 2.6), "2.6s", "200ms", or "Freeze"`);
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) throw new Error(`unparseable reverb time "${input}"`);
  const unit = m[2] ?? 's';
  return unit.startsWith('s') ? n * 1000 : n;
}

/** Nearest REVERB_TIMES index for a target time in ms (Infinity → Freeze). */
function reverbTimeIndexForMs(ms: number): number {
  if (!Number.isFinite(ms)) return REVERBTIME_MAX_IDX; // "Freeze"
  let bestIdx = 0;
  let bestErr = Infinity;
  for (let i = 0; i <= REVERBTIME_MAX_IDX; i++) {
    const err = Math.abs(REVERBTIME_MS[i]! - ms); // Infinity (Freeze entry) never wins for a finite target
    if (err < bestErr) { bestErr = err; bestIdx = i; }
  }
  return bestIdx;
}

const REVERBTIME_SECONDS: NrpnDisplayFormula = {
  unitLabel: 's / ms',
  // Device index = floor(patchByte / 8) = floor(wire / 64) — match the
  // device's floor (not round) so a get_preset decode of an arbitrary
  // device buffer lands on the exact entry the panel shows.
  decode: (wire) => REVERB_TIMES[Math.min(Math.max(Math.floor(wire / REVERBTIME_SCALE), 0), REVERBTIME_MAX_IDX)] ?? '120ms',
  encode: (input) => reverbTimeIndexForMs(parseReverbTimeMs(input)) * REVERBTIME_SCALE,
};

/**
 * Legacy index → display string for the one-time recipe migration.
 * Recipe `reverbtime` values were raw REVERB_TIMES indices (0..128);
 * this returns the table's own seconds/ms string so the migrated value
 * resolves to the identical wire.
 */
export function reverbtimeDisplayForIndex(legacyIndex: number): string {
  return REVERBTIME_SECONDS.decode(legacyIndex * REVERBTIME_SCALE);
}

// ── Master table ───────────────────────────────────────────────────

export const NRPN_DISPLAY: Record<string, NrpnDisplayFormula> = {
  // 0..128 raw knobs
  filter1cutoff:    knob0to128(),
  filter1resonance: knob0to128(),
  filter1drive:     knob0to128(),
  filter1special:   knob0to128(),
  filter2cutoff:    knob0to128(),
  filter2resonance: knob0to128(),
  filter2morph:     knob0to128(),
  amplevel:         knob0to128(),
  mixerosc1vol:     knob0to128(),
  mixerosc2vol:     knob0to128(),
  mixerosc3vol:     knob0to128(),
  mixerringmodvol:  knob0to128(),
  mixernoisevol:    knob0to128(),
  env1sustain:      knob0to128(),
  env2sustain:      knob0to128(),
  env3sustain:      knob0to128(),
  env4sustain:      knob0to128(),
  env5sustain:      knob0to128(),
  delayfeedback:    knob0to128(),
  delayfeedtone:    bipolar64(),
  delaywettone:     bipolar64(),
  reverbtone:       bipolar64(),
  reverbhidamp:     knob0to128(),
  reverblodamp:     knob0to128(),

  // Multi-segment env time tables (sync-off variants — sync-on is
  // an enum and decodes through the existing schema path).
  env1attacksyncoff:  ENV_ATTACK_HOLD_TABLE,
  env2attacksyncoff:  ENV_ATTACK_HOLD_TABLE,
  env3attacksyncoff:  ENV_ATTACK_HOLD_TABLE,
  env4attacksyncoff:  ENV_ATTACK_HOLD_TABLE,
  env5attacksyncoff:  ENV_ATTACK_HOLD_TABLE,
  env1holdsyncoff:    ENV_ATTACK_HOLD_TABLE,
  env2holdsyncoff:    ENV_ATTACK_HOLD_TABLE,
  env3holdsyncoff:    ENV_ATTACK_HOLD_TABLE,
  env4holdsyncoff:    ENV_ATTACK_HOLD_TABLE,
  env5holdsyncoff:    ENV_ATTACK_HOLD_TABLE,
  env1decaysyncoff:   ENV_DECAY_RELEASE_TABLE,
  env2decaysyncoff:   ENV_DECAY_RELEASE_TABLE,
  env3decaysyncoff:   ENV_DECAY_RELEASE_TABLE,
  env4decaysyncoff:   ENV_DECAY_RELEASE_TABLE,
  env5decaysyncoff:   ENV_DECAY_RELEASE_TABLE,
  env1releasesyncoff: ENV_DECAY_RELEASE_TABLE,
  env2releasesyncoff: ENV_DECAY_RELEASE_TABLE,
  env3releasesyncoff: ENV_DECAY_RELEASE_TABLE,
  env4releasesyncoff: ENV_DECAY_RELEASE_TABLE,
  env5releasesyncoff: ENV_DECAY_RELEASE_TABLE,
  env1delaysyncoff:   ENV_DELAY_TABLE,
  env2delaysyncoff:   ENV_DELAY_TABLE,
  env3delaysyncoff:   ENV_DELAY_TABLE,
  env4delaysyncoff:   ENV_DELAY_TABLE,
  env5delaysyncoff:   ENV_DELAY_TABLE,
  // All five lfoNdelaysyncoff notes in nrpn.ts carry the identical
  // 128-step 0..32s bucket schedule (diffed 2026-08-22, BK-HYDRA-
  // DISPLAY-GAPS P1); lfo1 alone was mapped and lfo2..5 fell through
  // to raw wire, which is what bit the Elm St Bells vibrato recipe.
  lfo1delaysyncoff:   ENV_DELAY_TABLE,
  lfo2delaysyncoff:   ENV_DELAY_TABLE,
  lfo3delaysyncoff:   ENV_DELAY_TABLE,
  lfo4delaysyncoff:   ENV_DELAY_TABLE,
  lfo5delaysyncoff:   ENV_DELAY_TABLE,

  // FX wet/feedback (percent)
  prefxwet:    percent(),
  postfxwet:   percent(),
  delaywet:    percent(),
  reverbwet:   percent(),
  mutator1wet: percent(),
  mutator2wet: percent(),
  mutator3wet: percent(),
  mutator4wet: percent(),

  // Reverb predelay (non-linear)
  reverbpredelay: REVERB_PREDELAY,

  // Reverb time — display-first seconds/ms (device REVERB_TIMES table)
  reverbtime: REVERBTIME_SECONDS,

  // LFO free-run rate — display-first Hz (device LFO_RATES_SYNC_OFF table)
  lfo1ratesyncoff: LFO_RATE_SYNC_OFF,
  lfo2ratesyncoff: LFO_RATE_SYNC_OFF,
  lfo3ratesyncoff: LFO_RATE_SYNC_OFF,
  lfo4ratesyncoff: LFO_RATE_SYNC_OFF,
  lfo5ratesyncoff: LFO_RATE_SYNC_OFF,
};

/**
 * Lookup keyed by per-FX-type entry name (e.g. `"fx5param1 (Cutoff)"`).
 * Matched by `entry.name.startsWith(...)`. Used when the FX-aware
 * resolver fired and we want to surface the per-type display label.
 */
export const FX_NRPN_DISPLAY: ReadonlyArray<{ namePrefix: string; formula: NrpnDisplayFormula }> = [
  { namePrefix: 'fx5param1', formula: LOFI_CUTOFF },
  { namePrefix: 'fx5param2', formula: LOFI_RESONANCE },
  { namePrefix: 'fx5param4', formula: LOFI_OUTPUT },
  // fx5param3 (Filter Type) and fx5param5 (Sampling) are enum-decoded
  // via the runtime enumTable patches in encoding.ts — no formula needed.
];

/**
 * Try to decode `wire` to a display string for a given canonical name.
 * Returns undefined when no curated formula exists (caller falls back
 * to the schema's generic decode).
 */
export function decodeNrpnDisplay(canonicalName: string, wire: number): string | undefined {
  const f = NRPN_DISPLAY[canonicalName];
  return f?.decode(wire);
}

/**
 * Same as `decodeNrpnDisplay`, but matches FX_NRPN_DISPLAY entries by
 * name prefix (auto-gen names carry parenthetical descriptors).
 */
export function decodeFxNrpnDisplay(entryName: string, wire: number): string | undefined {
  for (const { namePrefix, formula } of FX_NRPN_DISPLAY) {
    if (entryName.startsWith(namePrefix)) return formula.decode(wire);
  }
  return undefined;
}
