/**
 * Display-first parity gate — Fractal devices (AM4, Axe-Fx II, gen-3
 * III/FM3/FM9/VP4, gen-1 Standard/Ultra).
 *
 * Cross-device generalization of `scripts/hydrasynth/verify-display-first.ts`
 * (the pattern to copy, per CLAUDE.md "Tool API conventions → display-first").
 * Enforces, per device, over the non-linear / non-trivial display params:
 *
 *   GATE A (family coverage): every param whose decode produces a DISPLAY
 *     value must have a display-accepting inverse (encode), and every
 *     non-linear param must actually engage its non-linear branch (a
 *     `log10` tag whose range hits the decode guard's silent linear
 *     fallback is tracked debt, not a pass). A decoder without an inverse
 *     — the set/get asymmetry that makes set_param silently wrong — fails.
 *
 *   GATE B (exact on-grid round-trip identity): for every display value
 *     the device can actually show — enumerated from the param's real
 *     wire grid, exactly like the Hydrasynth gate walks the device's own
 *     lookup tables — decode(wire) → encode(display) → decode(wire') must
 *     reproduce the display value EXACTLY (same rounding convention the
 *     production decode boundary already applies; no "close enough"
 *     floats). A param whose encode secretly takes a wire index cannot
 *     pass: decode(encode(display)) lands on the wrong grid point.
 *
 * Where each device's display machinery lives (the codec truth this gate
 * exercises):
 *   - AM4:      fractal-midi/am4 params.ts — `decode` (normalized Q
 *               read-register → display; linear | log10 taper) +
 *               `internalFromDisplay` (its exact inverse) +
 *               `roundDisplayValue` (per-unit panel precision).
 *   - Axe-Fx II: fractal-midi/shared displayScale.ts (`displayToWire` /
 *               `wireToDisplay`, HW-079 hardware-verified) resolved through
 *               fractal-gen2 calibration.ts (`resolveAxeFxIIParamKind`:
 *               catalog → overlay → suffix-rule ladder, incl. the
 *               hardware-swept amp tier).
 *   - gen-3:    fractal-gen3 catalog.ts schema closures (same shared
 *               resolver; FM9 additionally overridden by its device-true
 *               ranges.generated.ts cache rows).
 *   - gen-1:    fractal-gen1 descriptor/schema.ts (linear display↔wire
 *               over the 8-bit 0..254 wire; `scaling:'pending'` params
 *               refuse display units by design).
 *
 * PARITY-PENDING ALLOWLIST: anything that cannot round-trip today is
 * listed per device WITH A REASON and a max-hit ceiling. The gate's job
 * is to freeze the debt and fail NEW leaks: a param that is neither
 * display-first nor matched by a tracked entry fails, and a tracked
 * bucket that GROWS past its ceiling fails (bump the ceiling only with a
 * conscious reason).
 *
 * Deterministic by construction — no hardware, no "didn't throw" checks.
 * Wired into `test:codec` (root package.json), mirroring
 * `hydra:verify-display-first` in `test:hydra`.
 */

import {
  KNOWN_PARAMS as AM4_PARAMS,
  decode as am4Decode,
  encode as am4Encode,
  internalFromDisplay as am4InternalFromDisplay,
  roundDisplayValue as am4Round,
  type Param as Am4Param,
} from 'fractal-midi/am4';
import { KNOWN_PARAMS as II_PARAMS, type AxeFxIIParam } from 'fractal-midi/gen2/axe-fx-ii';
import { resolveAxeFxIIParamKind } from '@mcp-midi-control/fractal-gen2/calibration.js';
import {
  AXEFX3_DESCRIPTOR,
  FM3_DESCRIPTOR,
  FM9_DESCRIPTOR,
  VP4_DESCRIPTOR,
} from '@mcp-midi-control/fractal-gen3/device.js';
import { AXEFXGEN1_DESCRIPTOR } from '@mcp-midi-control/fractal-gen1/descriptor.js';
import { KNOWN_PARAMS as GEN1_PARAMS, type AxeFxGen1Param } from 'fractal-midi/gen1';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK    ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
}

/** Cap noisy per-param failure listings. */
function summarizeFailures(bad: string[], cap = 8): string {
  const head = bad.slice(0, cap).join('; ');
  return bad.length > cap ? `${head}; …+${bad.length - cap} more` : head;
}

// ── Parity-pending allowlist (tracked debt; every skip is a line here) ─
//
// `max_hits` freezes the bucket: growth past the ceiling fails the gate
// (a NEW leak entered the bucket), shrinkage prints a tighten-me note.
interface AllowlistEntry {
  readonly device: string;
  readonly pattern: RegExp;
  readonly reason: string;
  readonly max_hits: number;
  hits?: number;
}

const PARITY_PENDING_ALLOWLIST: AllowlistEntry[] = [
  {
    device: 'am4',
    pattern:
      /^(drive\.slew_rate_slew|reverb\.release_time|flanger\.(drive|bass_focus)|phaser\.(attack|release)|wah\.(q_resonance|drive)|compressor\.time|filter\.(resonance|attack_time|release_time)|gate\.(attack|hold|release))$/,
    reason:
      "cache typecode tagged scaling:'log10' but displayMin=0, so decode's degenerate-range guard silently treats them LINEAR. Taper-vs-range contradiction (same family as the HW-131 contradicted Hz tapers) — needs a hardware knob reading to pick taper or range. Round-trip still holds in the linear fallback branch (GATE B covers them).",
    max_hits: 15,
  },
  {
    device: 'axe-fx-ii',
    pattern: /.*/,
    reason:
      'uncalibrated II params (no wiki/AM4-shared/editor/hardware-swept calibration): raw 16-bit wire by design — the BK-060 long tail. encodeDisplay/decodeWire are absent TOGETHER (no one-sided leak, enforced by GATE A); the tool layer surfaces them as opaque-wire knobs with a clear message.',
    max_hits: 377,
  },
  {
    device: 'axe-fx-iii',
    pattern: /.*/,
    reason:
      "continuous params without a calibrated display range (AM4-symbol-join overlay miss): raw 0..65534 wire passthrough by design; they cross to display-first automatically as ranges land. Encode and decode are BOTH wire-identity (no one-sided leak, enforced by the identity probe).",
    max_hits: 844,
  },
  {
    device: 'fm3',
    pattern: /.*/,
    reason:
      "device-true FM3 catalog is unit:'unverified'; params without an AM4-overlay range are raw-wire passthrough by design (no device-synced range cache yet — the FM3 has no ranges.generated.ts). Both closures are wire-identity. Ceiling tightened 875→839 (2026-07-02): the FM3 family-join discrete overlay (FM3_FAMILY_JOIN_DISCRETE) moved former passthrough selectors to the discrete class.",
    max_hits: 839,
  },
  {
    device: 'fm9',
    pattern: /.*/,
    reason:
      "FM9 params with neither an AM4-overlay range nor a float-kind row in the device-true editor-cache range table (ranges.generated.ts): raw-wire passthrough by design. Both closures are wire-identity.",
    max_hits: 141,
  },
  {
    device: 'vp4',
    pattern: /.*/,
    reason:
      'VP4 continuous params are raw 0..65534 wire BY DESIGN pending calibration (community-beta write surface: set_param takes the raw wire value; see write_allowlist). Both closures are wire-identity.',
    max_hits: 1172,
  },
  {
    device: 'axe-fx-gen1',
    pattern: /.*/,
    reason:
      "scaling:'pending' (171 params: the published gen-1 doc marks the display curve non-linear/unknown) plus 3 params with no documented curve/range at all (amp.flags, multi_delay.reftempo, pitch.flags — bitfield/tempo-ref registers). Raw wire 0..254 by design (no fabricated curve — the AM4 decode-bug class); encode refuses display units with a clear front-panel-verify message.",
    max_hits: 174,
  },
];

/** Match a debt param against the allowlist; false = untracked NEW leak. */
function trackDebt(device: string, key: string): boolean {
  for (const entry of PARITY_PENDING_ALLOWLIST) {
    if (entry.device === device && entry.pattern.test(key)) {
      entry.hits = (entry.hits ?? 0) + 1;
      return true;
    }
  }
  return false;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Evenly spaced integer wire samples across [0, wmax], endpoints included. */
function wireGrid(wmax: number, n = 33): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const w = Math.round((i / (n - 1)) * wmax);
    if (out[out.length - 1] !== w) out.push(w);
  }
  return out;
}

const round2 = (v: number): number => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};

// ════════════════════════════════════════════════════════════════════
// AM4 (fractal-midi/am4) — normalized Q read-register space
// ════════════════════════════════════════════════════════════════════
console.log('[display-first] AM4 — GATE A: structural family coverage');
{
  const params = Object.entries(AM4_PARAMS) as Array<[string, Am4Param]>;
  let continuous = 0;
  let enums = 0;
  let log10Engaged = 0;
  const badUnit: string[] = [];
  const badRange: string[] = [];
  const badEnum: string[] = [];
  const untrackedLog10: string[] = [];
  let trackedLog10 = 0;
  for (const [key, p] of params) {
    if (p.unit === 'enum') {
      enums++;
      if (p.enumValues === undefined || Object.keys(p.enumValues).length === 0) badEnum.push(key);
      continue;
    }
    continuous++;
    // Unit must be registered in the encode scale + precision tables
    // (TS enforces at compile time; this is the runtime belt).
    if (!Number.isFinite(am4Encode(p, p.displayMin))) badUnit.push(key);
    if (!(p.displayMin < p.displayMax)) badRange.push(key);
    if (p.scaling === 'log10') {
      if (p.displayMin > 0 && p.displayMax > 0) {
        log10Engaged++;
      } else if (trackDebt('am4', key)) {
        trackedLog10++;
      } else {
        untrackedLog10.push(key);
      }
    }
  }
  check(`am4: every continuous unit is registered (${continuous} params)`, badUnit.length === 0, summarizeFailures(badUnit));
  check('am4: every continuous range is displayMin < displayMax', badRange.length === 0, summarizeFailures(badRange));
  check(`am4: every enum param carries enumValues (${enums} enums)`, badEnum.length === 0, summarizeFailures(badEnum));
  check(
    `am4: every log10 param engages its taper (${log10Engaged} engaged, ${trackedLog10} tracked-degenerate)`,
    untrackedLog10.length === 0,
    `NEW degenerate log10 (silent linear fallback), not on the allowlist: ${summarizeFailures(untrackedLog10)}`,
  );
}

console.log('\n[display-first] AM4 — GATE B: exact on-grid round-trip identity');
{
  const params = Object.entries(AM4_PARAMS) as Array<[string, Am4Param]>;
  const gridBad: string[] = [];
  const inverseBad: string[] = [];
  let gridPoints = 0;
  for (const [key, p] of params) {
    if (p.unit === 'enum') continue;
    // Analytic inverse identity at interior points, full precision:
    // internalFromDisplay must be decode's exact inverse (branch-for-branch,
    // including the degenerate-log10 linear fallback).
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const d = am4Decode(p, t);
      const back = am4InternalFromDisplay(p, d);
      if (!(Math.abs(back - t) <= 1e-9)) {
        inverseBad.push(`${key} (t=${t} → d=${d} → back=${back})`);
        break;
      }
    }
    // Panel-grid stability over the u32 read-register quantization: every
    // display value the register can produce must re-encode onto a wire
    // point that decodes to the SAME display value (exact equality at the
    // param's own panel precision — the production decode boundary).
    for (const u of wireGrid(65534)) {
      gridPoints++;
      const d = am4Round(p, am4Decode(p, u / 65534));
      if (typeof d !== 'number') {
        gridBad.push(`${key} (wire ${u} decoded to non-number "${d}")`);
        break;
      }
      const u2 = clamp(Math.round(am4InternalFromDisplay(p, d) * 65534), 0, 65534);
      const d2 = am4Round(p, am4Decode(p, u2 / 65534));
      if (d2 !== d) {
        gridBad.push(`${key} (wire ${u} → "${d}" → wire ${u2} → "${d2}")`);
        break;
      }
    }
  }
  check('am4: internalFromDisplay is decode\'s exact inverse (all continuous params)', inverseBad.length === 0, summarizeFailures(inverseBad));
  check(`am4: all sampled grid points round-trip exactly (${gridPoints} points)`, gridBad.length === 0, summarizeFailures(gridBad));

  // Hardware anchors — the pinned READ captures (display ↔ u32, denominator
  // 65534, byte-exact goldens in verify-msg) now also pin the inverse.
  const gain = AM4_PARAMS['amp.gain'] as Am4Param;
  for (const [display, u32] of [[3, 19660], [5, 32767], [6, 39320]] as const) {
    const got = Math.round(am4InternalFromDisplay(gain, display) * 65534);
    check(`am4: amp.gain display ${display}.00 → u32 ${u32} (pinned capture)`, got === u32, `got ${got}`);
  }
  // buildSetParamNorm hardware note: normalized 0.7 landed at display 7.0 —
  // for knob-space params the write-float and normalized spaces coincide.
  check(
    'am4: amp.gain encode(7.0) === internalFromDisplay(7.0) === 0.7 (knob spaces coincide)',
    am4Encode(gain, 7.0) === 0.7 && am4InternalFromDisplay(gain, 7.0) === 0.7,
    `encode=${am4Encode(gain, 7.0)}, inverse=${am4InternalFromDisplay(gain, 7.0)}`,
  );
}

// ════════════════════════════════════════════════════════════════════
// Axe-Fx II (fractal-gen2 resolver over the shared 16-bit display scale)
// ════════════════════════════════════════════════════════════════════
console.log('\n[display-first] Axe-Fx II — GATE A + GATE B via resolveAxeFxIIParamKind');
{
  let calibrated = 0;
  let discrete = 0;
  let debt = 0;
  const unresolved: string[] = [];
  const oneSided: string[] = [];
  const untracked: string[] = [];
  const gridBad: string[] = [];
  for (const key of Object.keys(II_PARAMS)) {
    const p = II_PARAMS[key as keyof typeof II_PARAMS] as AxeFxIIParam;
    const kind = resolveAxeFxIIParamKind(p.block, p.name);
    if (kind === undefined) {
      unresolved.push(key);
      continue;
    }
    if (kind.unit === 'enum' || kind.unit === 'bool') {
      discrete++;
      continue;
    }
    const hasEncode = typeof kind.encodeDisplay === 'function';
    const hasDecode = typeof kind.decodeWire === 'function';
    // GATE A: closures come in pairs — a decoder without an inverse (or an
    // encoder without a decoder) is the silent set/get asymmetry class.
    if (hasEncode !== hasDecode) {
      oneSided.push(`${key} (encode=${hasEncode}, decode=${hasDecode})`);
      continue;
    }
    if (!hasEncode) {
      debt++;
      if (!trackDebt('axe-fx-ii', key)) untracked.push(key);
      continue;
    }
    calibrated++;
    // GATE B: exact display stability over the wire grid.
    for (const u of wireGrid(65534)) {
      const d = kind.decodeWire!(u);
      if (typeof d !== 'number') {
        gridBad.push(`${key} (wire ${u} decoded to non-number "${d}")`);
        break;
      }
      let d2: number | string;
      let u2: number;
      try {
        u2 = kind.encodeDisplay!(d);
        d2 = kind.decodeWire!(u2);
      } catch (err) {
        gridBad.push(`${key} (wire ${u} → "${d}" → encode threw: ${err instanceof Error ? err.message : err})`);
        break;
      }
      if (d2 !== d) {
        gridBad.push(`${key} (wire ${u} → "${d}" → wire ${u2} → "${d2}")`);
        break;
      }
    }
  }
  check('axe-fx-ii: every catalog param resolves a param kind', unresolved.length === 0, summarizeFailures(unresolved));
  check('axe-fx-ii: encode/decode closures come in pairs (no one-sided leak)', oneSided.length === 0, summarizeFailures(oneSided));
  check(
    `axe-fx-ii: uncalibrated raw-wire params are all tracked debt (${debt} tracked)`,
    untracked.length === 0,
    `NEW uncalibrated leak, not on the allowlist: ${summarizeFailures(untracked)}`,
  );
  check(
    `axe-fx-ii: all calibrated params round-trip exactly on-grid (${calibrated} params, ${discrete} enum/bool out of numeric scope)`,
    gridBad.length === 0,
    summarizeFailures(gridBad),
  );

  // Hardware anchors.
  const vol = resolveAxeFxIIParamKind('drive', 'volume');
  check(
    'axe-fx-ii: drive.volume 5 → wire ~32767 (Session 98 root-cause anchor)',
    vol?.encodeDisplay !== undefined && Math.abs(vol.encodeDisplay(5) - 32767) <= 1,
    `got ${vol?.encodeDisplay?.(5)}`,
  );
  const lowCut = resolveAxeFxIIParamKind('cab', 'low_cut');
  check(
    'axe-fx-ii: cab.low_cut 20/200/2000 Hz → wire 0/~32767/65534 (HW-079 log10 anchor)',
    lowCut?.encodeDisplay !== undefined &&
      lowCut.encodeDisplay(20) === 0 &&
      Math.abs(lowCut.encodeDisplay(200) - 32767) <= 1 &&
      lowCut.encodeDisplay(2000) === 65534,
    `got ${lowCut?.encodeDisplay?.(20)}/${lowCut?.encodeDisplay?.(200)}/${lowCut?.encodeDisplay?.(2000)}`,
  );
}

// ════════════════════════════════════════════════════════════════════
// gen-3 (III / FM3 / FM9 / VP4) — descriptor schema closures
// ════════════════════════════════════════════════════════════════════
for (const [device, descriptor] of [
  ['axe-fx-iii', AXEFX3_DESCRIPTOR],
  ['fm3', FM3_DESCRIPTOR],
  ['fm9', FM9_DESCRIPTOR],
  ['vp4', VP4_DESCRIPTOR],
] as const) {
  console.log(`\n[display-first] gen-3 ${device} — GATE A + GATE B via catalog schema`);
  let calibrated = 0;
  let discrete = 0;
  let passthrough = 0;
  const untracked: string[] = [];
  const endpointBad: string[] = [];
  const gridBad: string[] = [];
  const passthroughBad: string[] = [];
  for (const [slug, block] of Object.entries(descriptor.blocks)) {
    for (const [name, s] of Object.entries(block.params)) {
      const key = `${slug}.${name}`;
      if (s.wire_kind === 'discrete' || s.unit === 'enum' || s.unit === 'bool' || s.enum_values !== undefined) {
        discrete++;
        continue;
      }
      // Behavior probe: wire-identity decode = raw-wire passthrough.
      const identity = [1, 21845, 65533].every((u) => s.decode(u) === u);
      if (identity) {
        passthrough++;
        // GATE A for passthrough: encode must be raw-wire too (a display-
        // shaped encode over an identity decode is the one-sided leak).
        try {
          if (s.encode(21845) !== 21845) passthroughBad.push(`${key} (encode(21845) → ${s.encode(21845)})`);
        } catch (err) {
          passthroughBad.push(`${key} (encode(21845) threw: ${err instanceof Error ? err.message : err})`);
        }
        if (!trackDebt(device, key)) untracked.push(key);
        continue;
      }
      calibrated++;
      // GATE A: calibrated closures must decode the wire endpoints onto the
      // schema's advertised display bounds (panel-rounded).
      const dMin = s.decode(0);
      const dMax = s.decode(65534);
      if (
        s.display_min === undefined ||
        s.display_max === undefined ||
        dMin !== round2(s.display_min) ||
        dMax !== round2(s.display_max)
      ) {
        endpointBad.push(`${key} (decode(0)=${dMin} vs min=${s.display_min}; decode(65534)=${dMax} vs max=${s.display_max})`);
      }
      // GATE B: exact display stability over the wire grid.
      for (const u of wireGrid(65534)) {
        const d = s.decode(u);
        if (typeof d !== 'number') {
          gridBad.push(`${key} (wire ${u} decoded to non-number "${d}")`);
          break;
        }
        let u2: number;
        let d2: number | string;
        try {
          u2 = s.encode(d);
          d2 = s.decode(u2);
        } catch (err) {
          gridBad.push(`${key} (wire ${u} → "${d}" → encode threw: ${err instanceof Error ? err.message : err})`);
          break;
        }
        if (d2 !== d) {
          gridBad.push(`${key} (wire ${u} → "${d}" → wire ${u2} → "${d2}")`);
          break;
        }
      }
    }
  }
  check(`${device}: passthrough params take raw wire on BOTH sides (${passthrough} params)`, passthroughBad.length === 0, summarizeFailures(passthroughBad));
  check(
    `${device}: raw-wire passthrough params are all tracked debt`,
    untracked.length === 0,
    `NEW uncalibrated leak, not on the allowlist: ${summarizeFailures(untracked)}`,
  );
  check(`${device}: calibrated endpoints decode onto advertised bounds (${calibrated} calibrated)`, endpointBad.length === 0, summarizeFailures(endpointBad));
  check(
    `${device}: all calibrated params round-trip exactly on-grid (${discrete} discrete/enum out of numeric scope)`,
    gridBad.length === 0,
    summarizeFailures(gridBad),
  );
}

// ════════════════════════════════════════════════════════════════════
// gen-1 (Axe-Fx Standard/Ultra) — 8-bit wire, linear or pending
// ════════════════════════════════════════════════════════════════════
console.log('\n[display-first] gen-1 — GATE A + GATE B via descriptor schema (exhaustive wire grid)');
{
  let linear = 0;
  let discrete = 0;
  let pending = 0;
  const missing: string[] = [];
  const untracked: string[] = [];
  const gridBad: string[] = [];
  const pendingBad: string[] = [];
  for (const key of Object.keys(GEN1_PARAMS)) {
    const p = GEN1_PARAMS[key as keyof typeof GEN1_PARAMS] as AxeFxGen1Param;
    const s = AXEFXGEN1_DESCRIPTOR.blocks[p.block]?.params[p.name];
    if (s === undefined) {
      missing.push(key);
      continue;
    }
    if (p.controlType === 'enum' || p.controlType === 'switch') {
      discrete++;
      continue;
    }
    const wmax = p.range.max ?? 254;
    if (p.scaling !== 'linear' || p.display === undefined) {
      pending++;
      // GATE A for pending: the schema must REFUSE display units (raw-wire
      // integers only) — a fabricated curve here is the AM4 decode-bug class.
      try {
        if (s.encode(Math.min(1, wmax)) !== Math.min(1, wmax)) pendingBad.push(`${key} (wire int did not pass through)`);
      } catch (err) {
        pendingBad.push(`${key} (encode(wire int) threw: ${err instanceof Error ? err.message : err})`);
      }
      if (!trackDebt('axe-fx-gen1', key)) untracked.push(key);
      continue;
    }
    linear++;
    // GATE B: exhaustive over the full 8-bit wire grid (≤255 points).
    for (let u = 0; u <= wmax; u++) {
      const d = s.decode(u);
      if (typeof d !== 'number') {
        gridBad.push(`${key} (wire ${u} decoded to non-number "${d}")`);
        break;
      }
      let u2: number;
      let d2: number | string;
      try {
        u2 = s.encode(d);
        d2 = s.decode(u2);
      } catch (err) {
        gridBad.push(`${key} (wire ${u} → "${d}" → encode threw: ${err instanceof Error ? err.message : err})`);
        break;
      }
      if (d2 !== d) {
        gridBad.push(`${key} (wire ${u} → "${d}" → wire ${u2} → "${d2}")`);
        break;
      }
    }
  }
  check('axe-fx-gen1: every catalog param has a descriptor schema', missing.length === 0, summarizeFailures(missing));
  check(`axe-fx-gen1: pending-curve params refuse display units, take raw wire (${pending} params)`, pendingBad.length === 0, summarizeFailures(pendingBad));
  check(
    'axe-fx-gen1: pending-curve params are all tracked debt',
    untracked.length === 0,
    `NEW pending leak, not on the allowlist: ${summarizeFailures(untracked)}`,
  );
  check(
    `axe-fx-gen1: all linear params round-trip exactly over the FULL wire grid (${linear} params, ${discrete} enum/switch out of numeric scope)`,
    gridBad.length === 0,
    summarizeFailures(gridBad),
  );

  // Doc-derived anchor: compressor.threshold is -80..0 dB linear over 0..254.
  const thr = AXEFXGEN1_DESCRIPTOR.blocks['compressor']?.params['threshold'];
  check(
    'axe-fx-gen1: compressor.threshold -40 dB ↔ wire 127 (published-spec anchor)',
    thr !== undefined && thr.encode(-40) === 127 && thr.decode(127) === -40,
    `encode(-40)=${thr?.encode(-40)}, decode(127)=${thr?.decode(127)}`,
  );
}

// ── Parity-debt visibility + ceiling enforcement ─────────────────────
console.log('\n[display-first] parity-pending (tracked debt, not failures):');
for (const entry of PARITY_PENDING_ALLOWLIST) {
  const hits = entry.hits ?? 0;
  console.log(`  ~ ${entry.device} ${entry.pattern.source} (${hits}/${entry.max_hits} params): ${entry.reason}`);
  if (hits > entry.max_hits) {
    failed++;
    console.error(
      `  FAIL  ${entry.device}: tracked-debt bucket GREW (${hits} > ceiling ${entry.max_hits}) — a new raw-wire/degenerate param entered. ` +
        'Either make it display-first or consciously bump max_hits with a reason.',
    );
  } else if (hits < entry.max_hits) {
    console.log(`        note: bucket shrank below its ceiling (${hits} < ${entry.max_hits}) — tighten max_hits to freeze the gain.`);
  }
}

console.log('');
if (failed > 0) {
  console.error(`x display-first (fractal): ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('OK verify-display-first-fractal: Fractal display params are display-first and round-trip exactly on-grid.');
