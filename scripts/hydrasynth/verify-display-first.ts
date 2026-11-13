/**
 * Display-first parity gate (Hydrasynth).
 *
 * Enforces the project's "Tool API conventions: display-first" rule for
 * the params where it is easy to violate — the env/LFO TIME durations,
 * whose wire<->display mapping is a non-linear exponential bucket
 * schedule. The lazy implementation exposes a wire-shaped 0..128 index;
 * the correct one accepts the panel time (ms / "2.5s"). This test makes
 * that an enforced invariant, not a hope.
 *
 * Deterministic by construction — no hardware, no "didn't throw" checks.
 * Two gates:
 *
 *   GATE A (family coverage): every env/LFO duration param that has a
 *     display decoder MUST also be bidirectional (have `encode`). A new
 *     duration param added without an inverse fails here. Conversely,
 *     every param that HAS `encode` must be one of these time families
 *     (guards against accidentally making a linear param non-linear).
 *
 *   GATE B (exact on-grid round-trip identity): for every display value
 *     the device can actually show (each ms in the param's own lookup),
 *     `decode(resolveNrpnValue(param, displayMs))` must equal the
 *     canonical display for that grid point. A param that secretly takes
 *     an index (not display ms) cannot satisfy this — passing 90 would
 *     resolve to idx-90 (2.56 s) instead of 90 ms, so decode(resolve(90))
 *     != "90 ms" and the gate fails. Also asserts the index path is gone
 *     (bare number == ms == "<n>ms" string) and unit strings parse.
 *
 * KNOWN-NOT-YET-CONVERTED (display-first parity pending) — explicitly
 * allowlisted so a NEW leak still fails the gate while these tracked
 * ones don't. Each needs its own inverse before removal from the list.
 *
 * Cross-device note: the same two gates generalize to AM4 / Axe-Fx
 * (fractal-midi codec) — that extension is deferred (separate codec
 * package); this file is the Hydrasynth instance + the pattern to copy.
 */
import { HYDRASYNTH_NRPNS, findHydraNrpn } from '@mcp-midi-control/hydrasynth/nrpn.js';
import { resolveNrpnValue } from '@mcp-midi-control/hydrasynth/encoding.js';
import { NRPN_DISPLAY, decodeNrpnDisplay } from '@mcp-midi-control/hydrasynth/nrpnDisplay.js';
import { REVERB_TIMES } from '@mcp-midi-control/hydrasynth/enums.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) { console.log(`  OK    ${label}`); }
  else { failed++; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

/** Param-name pattern for env/LFO TIME durations (must be display-first ms). */
const DURATION_RE = /^(env[1-5](attack|decay|release|hold|delay)|lfo[1-5](delay|fadein))syncoff$/;
/** Free-running LFO rate (display-first Hz, device LFO_RATES_SYNC_OFF table). */
const LFO_RATE_RE = /^lfo[1-5]ratesyncoff$/;
/** Other non-time display-first families that legitimately carry an `encode`. */
const NON_DURATION_ENCODE_RE = /^reverbtime$/;

/**
 * Params that take an index / non-display value today and are NOT yet
 * display-first. Each is a tracked debt with a reason; removing one
 * means its inverse shipped. A param NOT on this list and NOT display-
 * first will fail GATE B.
 */
const PARITY_PENDING_ALLOWLIST: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /^voicevibratoratesyncoff$/, reason: 'vibrato rate is a Hz curve [0-127]; needs its own Hz inverse (separate from lfo*ratesyncoff, which is now display-first)' },
  { pattern: /syncon$/, reason: 'sync-ON variants take a musical-division enum string (already name-based, not ms)' },
  { pattern: /^lfo[1-5]fadeinsyncoff$/, reason: 'BK-HYDRA-DISPLAY-GAPS P2: raw 0..127 today, panel shows 0-5943 ms; needs the vendored edisyn fade-in table transcribed (Phase 2)' },
];

// ── GATE A: family coverage ─────────────────────────────────────────
console.log('[display-first] GATE A — env/LFO duration params are bidirectional');
for (const entry of HYDRASYNTH_NRPNS) {
  if (!DURATION_RE.test(entry.name)) continue;
  const f = NRPN_DISPLAY[entry.name];
  // Only params that have a forward decoder are in scope (we can only
  // round-trip what we can display). If it has a decoder, it MUST encode.
  if (f !== undefined && typeof f.decode === 'function') {
    check(`${entry.name}: has encode (bidirectional)`, typeof f.encode === 'function',
      'duration param has a display decoder but no inverse: add encode to its timeTable');
  }
}

// ── GATE A′: completeness — no duration/rate param falls through ────
// GATE A only inspects params that already HAVE a decoder, which is the
// hole that hid lfo2..5delaysyncoff for months (BK-HYDRA-DISPLAY-GAPS
// P1/P3): a param whose NAME says "this is a time" but that has no
// NRPN_DISPLAY formula silently takes raw wire while the tool contract
// promises ms. Every DURATION/LFO-RATE-shaped NRPN must either have a
// display formula or carry an explicit PARITY_PENDING_ALLOWLIST line.
console.log('\n[display-first] GATE A′ — every duration/LFO-rate NRPN has a formula or a tracked-debt line');
let aPrimeScope = 0;
for (const entry of HYDRASYNTH_NRPNS) {
  if (!DURATION_RE.test(entry.name) && !LFO_RATE_RE.test(entry.name)) continue;
  aPrimeScope++;
  const f = NRPN_DISPLAY[entry.name];
  const hasFormula = f !== undefined && typeof f.decode === 'function';
  const allowlisted = PARITY_PENDING_ALLOWLIST.some(({ pattern }) => pattern.test(entry.name));
  check(`${entry.name}: display formula or allowlist entry`, hasFormula || allowlisted,
    'a duration/LFO-rate-shaped NRPN has neither a display formula nor a PARITY_PENDING_ALLOWLIST line — add its decode+encode or file the debt explicitly');
}
// Scope floor: A′ must actually see the whole family. If the catalog is ever
// regenerated with renamed entries (the DESTRUCTIVE hydra:gen-nrpn hazard),
// the regexes silently match nothing and A′ passes vacuously — this pins the
// expected population: 25 env durations + 10 lfo delay/fadein + 5 lfo rates.
check('GATE A′ scope covers the full duration/rate family (40 params)', aPrimeScope === 40,
  `expected 40 params in scope, matched ${aPrimeScope} — a catalog regen or rename shrank the family; fix the catalog or update this floor deliberately`);
// Reverse: every encode-capable param must be a known display-first family
// (env/LFO duration ms tables, LFO free-run Hz, or reverb time).
for (const [name, f] of Object.entries(NRPN_DISPLAY)) {
  if (typeof f.encode !== 'function') continue;
  check(`${name}: encode only on display-first families`,
    DURATION_RE.test(name) || LFO_RATE_RE.test(name) || NON_DURATION_ENCODE_RE.test(name),
    'a param grew an encode() outside the known display-first families — confirm it is genuinely non-linear-display and update the family patterns');
}

// ── GATE B: exact on-grid round-trip identity ───────────────────────
console.log('\n[display-first] GATE B — display value round-trips exactly');
for (const [name, f] of Object.entries(NRPN_DISPLAY)) {
  if (typeof f.encode !== 'function' || !f.msLookup) continue;
  const entry = findHydraNrpn(name);
  if (!entry) { check(`${name}: entry exists`, false); continue; }
  const lookup = f.msLookup;
  let mismatches = 0;
  let firstBad = '';
  // Sample every grid point (deterministic, exhaustive over the table).
  for (let i = 0; i < lookup.length; i++) {
    const displayMs = lookup[i]!;
    const resolved = resolveNrpnValue(entry, displayMs);
    const got = decodeNrpnDisplay(name, resolved.wire);
    const want = decodeNrpnDisplay(name, i * 64);
    if (got !== want) {
      mismatches++;
      if (!firstBad) firstBad = `ms ${displayMs} → wire ${resolved.wire} → "${got}" (canonical "${want}")`;
    }
  }
  check(`${name}: all ${lookup.length} grid points round-trip`, mismatches === 0,
    `${mismatches} mismatch(es); first: ${firstBad}`);

  // Bare number == ms == "<n>ms" string (no index leak), and seconds parse.
  const a = resolveNrpnValue(entry, 250).wire;
  const b = resolveNrpnValue(entry, '250ms').wire;
  const c = resolveNrpnValue(entry, '0.25s').wire;
  check(`${name}: 250 == "250ms" == "0.25s" (display-first, no index leak)`, a === b && b === c,
    `250→${a}, "250ms"→${b}, "0.25s"→${c}`);
}

// ── GATE C: LFO free-run rate (Hz) is display-first ─────────────────
// `wire` for lfo*ratesyncoff IS the device table index (0..1024). The
// display layer must be self-consistent (every showable Hz round-trips
// to the same Hz) and a bare number must equal the "<n> Hz" string.
console.log('\n[display-first] GATE C — lfo*ratesyncoff is display-first Hz');
{
  const entry = findHydraNrpn('lfo1ratesyncoff');
  if (!entry) {
    check('lfo1ratesyncoff: entry exists', false);
  } else {
    let unstable = 0;
    let firstBad = '';
    const hz = (s: string | undefined) => Number(String(s).match(/([\d.]+)/)?.[1] ?? NaN);
    for (let idx = 0; idx <= 1024; idx++) {
      const d = decodeNrpnDisplay('lfo1ratesyncoff', idx);
      const wire = resolveNrpnValue(entry, d!).wire;
      const d2 = decodeNrpnDisplay('lfo1ratesyncoff', wire);
      if (hz(d) !== hz(d2)) { unstable++; if (!firstBad) firstBad = `idx ${idx} "${d}" → wire ${wire} → "${d2}"`; }
    }
    check('lfo1ratesyncoff: display round-trips stably over all 1025 indices', unstable === 0, `${unstable} unstable; first: ${firstBad}`);

    const a = resolveNrpnValue(entry, 4.44).wire;
    const b = resolveNrpnValue(entry, '4.44 Hz').wire;
    const c = resolveNrpnValue(entry, '4.44Hz').wire;
    check('lfo1ratesyncoff: 4.44 == "4.44 Hz" == "4.44Hz" (display-first, no index leak)', a === b && b === c, `4.44→${a}, "4.44 Hz"→${b}, "4.44Hz"→${c}`);

    // Founder hardware anchors (LFO_RATES_SYNC_OFF table indices).
    check('lfo1ratesyncoff: index 70 → "0.04 Hz"', decodeNrpnDisplay('lfo1ratesyncoff', 70) === '0.04 Hz', `got ${decodeNrpnDisplay('lfo1ratesyncoff', 70)}`);
    check('lfo1ratesyncoff: index 510 → "1.70 Hz"', decodeNrpnDisplay('lfo1ratesyncoff', 510) === '1.70 Hz', `got ${decodeNrpnDisplay('lfo1ratesyncoff', 510)}`);
    check('lfo1ratesyncoff: index 620 → "4.44 Hz"', decodeNrpnDisplay('lfo1ratesyncoff', 620) === '4.44 Hz', `got ${decodeNrpnDisplay('lfo1ratesyncoff', 620)}`);
  }
}

// ── GATE D: reverbtime (seconds/ms) is display-first ────────────────
// `wire` for reverbtime is index × 64. Every REVERB_TIMES entry must
// round-trip EXACTLY (each is a distinct displayable time), a bare
// number must equal the "<n>s" string, and "Freeze" must round-trip.
console.log('\n[display-first] GATE D — reverbtime is display-first seconds');
{
  const entry = findHydraNrpn('reverbtime');
  if (!entry) {
    check('reverbtime: entry exists', false);
  } else {
    let bad = 0;
    let firstBad = '';
    const maxIdx = Math.max(...Object.keys(REVERB_TIMES).map(Number));
    for (let i = 0; i <= maxIdx; i++) {
      const wire0 = i * 64;
      const d = decodeNrpnDisplay('reverbtime', wire0);
      const wire = resolveNrpnValue(entry, d!).wire;
      const d2 = decodeNrpnDisplay('reverbtime', wire);
      if (d !== d2 || wire !== wire0) { bad++; if (!firstBad) firstBad = `idx ${i} "${d}" → wire ${wire} (want ${wire0}) → "${d2}"`; }
    }
    check(`reverbtime: all ${maxIdx + 1} table entries round-trip exactly`, bad === 0, `${bad} bad; first: ${firstBad}`);

    const a = resolveNrpnValue(entry, 2.6).wire;
    const b = resolveNrpnValue(entry, '2.6s').wire;
    const c = resolveNrpnValue(entry, '2600ms').wire;
    check('reverbtime: 2.6 == "2.6s" == "2600ms" (display-first, no index leak)', a === b && b === c, `2.6→${a}, "2.6s"→${b}, "2600ms"→${c}`);
    check('reverbtime: "Freeze" round-trips', decodeNrpnDisplay('reverbtime', resolveNrpnValue(entry, 'Freeze').wire) === 'Freeze', `got ${decodeNrpnDisplay('reverbtime', resolveNrpnValue(entry, 'Freeze').wire)}`);
  }
}

// ── Parity-debt visibility: log the allowlist so coverage is auditable ─
console.log('\n[display-first] parity-pending (tracked debt, not failures):');
for (const { pattern, reason } of PARITY_PENDING_ALLOWLIST) {
  const hits = HYDRASYNTH_NRPNS.filter((e) => pattern.test(e.name)).length;
  console.log(`  ~ ${pattern.source} (${hits} params): ${reason}`);
}

console.log('');
if (failed > 0) {
  console.error(`x display-first: ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('OK verify-display-first: env/LFO duration params are display-first (ms) and round-trip exactly.');
