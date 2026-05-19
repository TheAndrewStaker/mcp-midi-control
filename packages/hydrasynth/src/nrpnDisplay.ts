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

export interface NrpnDisplayFormula {
  /** Human-readable unit tag for tool responses (e.g. "Hz", "ms", "0.0..128.0", "%"). */
  readonly unitLabel: string;
  /** Wire (NRPN integer) → display string the device shows. */
  readonly decode: (wire: number) => string;
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
  lfo1delaysyncoff:   ENV_DELAY_TABLE,

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
