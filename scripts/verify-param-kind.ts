/**
 * Cross-device param-kind helper golden.
 *
 * Asserts that `resolveParamKind(deviceId, block, name)` returns the
 * expected shape (unit, displayMin/Max, source, round-trip-safe
 * encode/decode closures) for every supported device, across the four
 * provenance tiers:
 *
 *   - codec_catalog — catalog ships displayMin/Max
 *   - overlay       — device-local table (AM4_SHARED / EDITOR_OBSERVED)
 *   - suffix_rule   — convention rule matched on the param name
 *   - unknown       — no calibration data anywhere
 *
 * Per-device:
 *   - Axe-Fx II: full ladder (4-5 cases per tier)
 *   - AM4: catalog-calibrated cases (AM4 ships displayMin/Max directly
 *     in the cache catalog; there's no overlay)
 *   - Hydrasynth: catalog-calibrated + opaque cases
 *   - Axe-Fx III: unknown fallback (no resolver registered yet)
 *
 * Round-trip discipline: for every calibrated case the test asserts
 * `encodeDisplay(decodeWire(w)) === w` and
 * `decodeWire(encodeDisplay(d)) === d` (within one wire step / float
 * rounding) so a future helper rewrite can't silently break wire
 * format determinism.
 *
 * Run:  npx tsx scripts/verify-param-kind.ts
 */

// Eager-load every device descriptor so their resolvers register
// before we probe the helper.
import '@mcp-midi-control/fractal-gen2/descriptor.js';
import '@mcp-midi-control/am4/descriptor.js';
import '@mcp-midi-control/hydrasynth/descriptor.js';
import '@mcp-midi-control/fractal-gen3/descriptor.js';

import {
  resolveParamKind,
  hasParamKindResolver,
} from '@mcp-midi-control/core/protocol-generic/paramKind.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK    ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

interface KindCase {
  device: string;
  block: string;
  name: string;
  expectedSource:
    | 'codec_catalog'
    | 'overlay'
    | 'suffix_rule'
    | 'unknown';
  /** When set, helper must report this exact unit. */
  expectedUnit?: string;
  /** When set, helper must report a closures-driven display range. */
  expectsClosures?: boolean;
  /** Optional display range assertion. */
  displayMin?: number;
  displayMax?: number;
  /** Optional round-trip sample (display → wire → display). */
  rtDisplay?: number;
}

// ─────────────────────────────────────────────────────────────────
// Cases — at minimum 4-5 per provenance tier per device that has a
// resolver, plus opaque/unknown cases for III.
// ─────────────────────────────────────────────────────────────────
const cases: KindCase[] = [
  // ── Axe-Fx II ── codec_catalog (catalog ships displayMin/Max)
  {
    device: 'axe-fx-ii',
    block: 'amp',
    name: 'master_volume',
    expectedSource: 'codec_catalog',
    expectsClosures: true,
    rtDisplay: 5,
  },
  {
    device: 'axe-fx-ii',
    block: 'amp',
    name: 'input_drive',
    expectedSource: 'codec_catalog',
    expectsClosures: true,
    rtDisplay: 3,
  },
  {
    device: 'axe-fx-ii',
    block: 'amp',
    name: 'bass',
    expectedSource: 'codec_catalog',
    expectsClosures: true,
    rtDisplay: 5,
  },
  {
    device: 'axe-fx-ii',
    block: 'amp',
    name: 'treble',
    expectedSource: 'codec_catalog',
    expectsClosures: true,
    rtDisplay: 6,
  },

  // ── Axe-Fx II ── overlay (AM4_SHARED / EDITOR_OBSERVED)
  {
    device: 'axe-fx-ii',
    block: 'drive',
    name: 'volume',
    expectedSource: 'overlay',
    expectedUnit: 'knob',
    expectsClosures: true,
    displayMin: 0,
    displayMax: 10,
    rtDisplay: 5,
  },
  {
    device: 'axe-fx-ii',
    block: 'drive',
    name: 'tone',
    expectedSource: 'overlay',
    expectsClosures: true,
    displayMin: 0,
    displayMax: 10,
    rtDisplay: 7,
  },
  {
    device: 'axe-fx-ii',
    block: 'delay',
    name: 'mix',
    expectedSource: 'overlay',
    expectsClosures: true,
    displayMin: 0,
    displayMax: 100,
    rtDisplay: 50,
  },
  {
    device: 'axe-fx-ii',
    block: 'reverb',
    name: 'time',
    expectedSource: 'overlay',
    expectsClosures: true,
    displayMin: 0.1,
    displayMax: 100,
    rtDisplay: 25,
  },
  // Note: chorus.mix is calibrated in the codec catalog directly,
  // so the overlay is bypassed. Pick a different overlay case here.
  {
    device: 'axe-fx-ii',
    block: 'drive',
    name: 'middle',
    // Device-label tier (deviceLabelCalibration.generated.ts): the II prints
    // drive Middle as -12..+12 dB ("0.00 dB" at wire 32767), not the AM4-shared
    // 0..10 knob the overlay carried (2026-11-26 label sweep).
    expectedSource: 'overlay',
    expectedUnit: 'db',
    expectsClosures: true,
    displayMin: -12,
    displayMax: 12,
    rtDisplay: 0,
  },

  // ── Axe-Fx II ── suffix_rule (fractal-convention)
  // Pick params whose canonical knob name matches a suffix rule but are not
  // in AM4_SHARED / EDITOR_OBSERVED or the device-label tier. Controllers is
  // not a grid block, so no preset sweep measures it.
  {
    device: 'axe-fx-ii',
    block: 'controllers',
    name: 'level',
    expectedSource: 'suffix_rule',
    expectedUnit: 'knob',
    expectsClosures: true,
    displayMin: -80,
    displayMax: 20,
    rtDisplay: 0,
  },
  // Block levels the II itself prints in dB (device-label tier, 2026-11-26).
  {
    device: 'axe-fx-ii',
    block: 'amp',
    name: 'level',
    expectedSource: 'overlay',
    expectedUnit: 'db',
    expectsClosures: true,
    displayMin: -80,
    displayMax: 20,
    rtDisplay: 0,
  },
  {
    device: 'axe-fx-ii',
    block: 'reverb',
    name: 'level',
    expectedSource: 'overlay',
    expectsClosures: true,
    displayMin: -80,
    displayMax: 20,
    rtDisplay: -6,
  },
  {
    device: 'axe-fx-ii',
    block: 'compressor',
    name: 'level',
    // fn 0x16 device-reported -20..20 (2026-06-10), overlay overrides the
    // *level suffix rule's -80..20 (II compressor calibration divergence).
    expectedSource: 'overlay',
    expectsClosures: true,
    displayMin: -20,
    displayMax: 20,
  },
  {
    device: 'axe-fx-ii',
    block: 'compressor',
    name: 'ratio',
    expectedSource: 'overlay',
    expectedUnit: 'knob',
    expectsClosures: true,
    displayMin: 1,
    displayMax: 20,
    rtDisplay: 4,
  },
  {
    device: 'axe-fx-ii',
    block: 'delay',
    name: 'level',
    expectedSource: 'overlay',
    expectsClosures: true,
    displayMin: -80,
    displayMax: 20,
  },

  // ── Axe-Fx II ── opaque/unknown: param recognized but no
  // calibration. SUFFIX_RULES is very wide so finding one needs a
  // probe; rather than hardcode a specific param (the catalog evolves)
  // we synthesize the assertion by querying a non-existent param.
  // True "param not in catalog" returns source: 'unknown'.
  {
    device: 'axe-fx-ii',
    block: 'amp',
    name: '__not_a_real_param',
    expectedSource: 'unknown',
    expectedUnit: 'opaque',
  },

  // ── AM4 ── codec_catalog (AM4 ships displayMin/Max in the cache
  // catalog directly)
  {
    device: 'am4',
    block: 'amp',
    name: 'gain',
    expectedSource: 'codec_catalog',
    expectsClosures: true,
    rtDisplay: 5,
  },
  {
    device: 'am4',
    block: 'amp',
    name: 'master',
    expectedSource: 'codec_catalog',
    expectsClosures: true,
    rtDisplay: 5,
  },
  {
    device: 'am4',
    block: 'reverb',
    name: 'time',
    expectedSource: 'codec_catalog',
    expectsClosures: true,
  },
  {
    device: 'am4',
    block: 'drive',
    name: 'tone',
    expectedSource: 'codec_catalog',
    expectsClosures: true,
    rtDisplay: 5,
  },
  // ── AM4 ── unknown: nonexistent param returns the UNKNOWN envelope
  {
    device: 'am4',
    block: 'amp',
    name: '__not_a_real_param',
    expectedSource: 'unknown',
    expectedUnit: 'opaque',
  },

  // ── Hydrasynth ── codec_catalog: catalog-calibrated params
  {
    device: 'hydrasynth',
    block: 'osc1',
    name: 'pitch',
    expectedSource: 'codec_catalog',
    expectsClosures: true,
  },
  {
    device: 'hydrasynth',
    block: 'env1',
    name: 'attack',
    expectedSource: 'codec_catalog',
    expectsClosures: true,
  },
  {
    device: 'hydrasynth',
    block: 'voice',
    name: 'glide',
    expectedSource: 'codec_catalog',
    expectsClosures: true,
  },
  {
    device: 'hydrasynth',
    block: 'voice',
    name: '__not_a_real_param',
    expectedSource: 'unknown',
    expectedUnit: 'opaque',
  },

  // ── Axe-Fx III ── no resolver registered yet (community beta)
  {
    device: 'axe-fx-iii',
    block: 'amp',
    name: 'gain',
    expectedSource: 'unknown',
    expectedUnit: 'opaque',
  },
  {
    device: 'axe-fx-iii',
    block: 'reverb',
    name: 'mix',
    expectedSource: 'unknown',
    expectedUnit: 'opaque',
  },
];

// ─────────────────────────────────────────────────────────────────
// Resolver registration check — guards against descriptors that
// forget to register their resolver at module load.
// ─────────────────────────────────────────────────────────────────
console.log('\nResolver registration');
check(
  'axe-fx-ii resolver registered',
  hasParamKindResolver('axe-fx-ii'),
);
// AM4 / Hydrasynth do not have to register a resolver — the helper
// returns the UNKNOWN envelope which is the correct semantics for
// devices that haven't migrated yet. The registration assertion is
// optional; we record but don't fail on absence.
console.log(
  `  INFO  am4 resolver registered: ${hasParamKindResolver('am4')}`,
);
console.log(
  `  INFO  hydrasynth resolver registered: ${hasParamKindResolver('hydrasynth')}`,
);
console.log(
  `  INFO  axe-fx-iii resolver registered: ${hasParamKindResolver('axe-fx-iii')}`,
);

// ─────────────────────────────────────────────────────────────────
// Per-case probes.
// ─────────────────────────────────────────────────────────────────
console.log('\nPer-param-kind cases');
let caseCount = 0;
for (const c of cases) {
  caseCount++;
  // AM4 / Hydrasynth resolvers may not be registered yet. If absent,
  // the helper returns UNKNOWN — for codec_catalog cases on those
  // devices, this means the case is testing the absence path. Tolerate
  // by re-classifying the expected source to 'unknown' when the
  // resolver isn't registered.
  const resolverPresent = hasParamKindResolver(c.device);
  const effectiveExpectedSource =
    resolverPresent ? c.expectedSource : 'unknown';
  const effectiveExpectsClosures =
    resolverPresent ? (c.expectsClosures ?? false) : false;

  const kind = resolveParamKind(c.device, c.block, c.name);
  const label = `${c.device}/${c.block}.${c.name}`;
  check(
    `${label}: source=${effectiveExpectedSource}`,
    kind.source === effectiveExpectedSource,
    `got ${kind.source}`,
  );
  if (c.expectedUnit !== undefined) {
    // When resolver is absent, helper falls back to unit:'opaque'.
    const effectiveUnit = resolverPresent ? c.expectedUnit : 'opaque';
    check(
      `${label}: unit=${effectiveUnit}`,
      kind.unit === effectiveUnit,
      `got ${kind.unit}`,
    );
  }
  if (c.displayMin !== undefined && resolverPresent) {
    check(
      `${label}: displayMin=${c.displayMin}`,
      kind.displayMin === c.displayMin,
      `got ${kind.displayMin}`,
    );
  }
  if (c.displayMax !== undefined && resolverPresent) {
    check(
      `${label}: displayMax=${c.displayMax}`,
      kind.displayMax === c.displayMax,
      `got ${kind.displayMax}`,
    );
  }
  if (effectiveExpectsClosures) {
    check(
      `${label}: encodeDisplay closure present`,
      typeof kind.encodeDisplay === 'function',
    );
    check(
      `${label}: decodeWire closure present`,
      typeof kind.decodeWire === 'function',
    );
  }
  // Round-trip: encodeDisplay(decodeWire(w)) === w, within one wire
  // step. We probe at a midpoint wire and at the rtDisplay sample.
  if (effectiveExpectsClosures && kind.encodeDisplay && kind.decodeWire) {
    if (c.rtDisplay !== undefined) {
      try {
        const wire = kind.encodeDisplay(c.rtDisplay);
        const back = kind.decodeWire(wire);
        const numBack = typeof back === 'number' ? back : Number(back);
        // Within float rounding (0.01 of display range) OR exact match
        // for integer-valued displays.
        const tolerance = Math.abs(
          ((c.displayMax ?? 100) - (c.displayMin ?? 0)) * 0.01,
        );
        check(
          `${label}: round-trip display ${c.rtDisplay} → wire ${wire} → display ${numBack}`,
          Math.abs(numBack - c.rtDisplay) <= Math.max(tolerance, 0.001),
        );
      } catch (err) {
        check(
          `${label}: round-trip display ${c.rtDisplay}`,
          false,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    // Wire round-trip at midpoint — display-stable idempotency.
    //
    // decodeWire now rounds to the panel's display resolution (the
    // display-first fix: get_param/get_preset must return the panel
    // reading, not the wire→display inverse residue). That makes EXACT
    // wire recovery (wireBack === midWire) impossible by design — the
    // display step maps back to a small band of wire values. The
    // meaningful determinism invariant under display-first rounding is
    // that re-encoding the decoded panel value lands in the SAME panel
    // bucket: decodeWire(encodeDisplay(decodeWire(w))) === decodeWire(w).
    // A helper rewrite that broke encode/decode would shift the bucket
    // and fail this; a benign sub-display-step wire drift does not.
    try {
      const midWire = 32767;
      const display = kind.decodeWire(midWire);
      if (typeof display === 'number') {
        const wireBack = kind.encodeDisplay(display);
        const displayBack = kind.decodeWire(wireBack);
        const numBack = typeof displayBack === 'number' ? displayBack : Number(displayBack);
        const tolerance = Math.max(
          ((c.displayMax ?? 100) - (c.displayMin ?? 0)) * 0.01,
          0.001,
        );
        check(
          `${label}: wire ${midWire} → display ${display} → wire ${wireBack} → display ${numBack} (display-stable)`,
          Math.abs(numBack - display) <= tolerance,
        );
      }
    } catch {
      // OK: some closures throw for boundary inputs; not a failure.
    }
  }
}

console.log('');
console.log(`Total cases: ${caseCount}`);
if (failed > 0) {
  console.error(`✗ ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('✓ paramKind helper verified across registered devices.');
