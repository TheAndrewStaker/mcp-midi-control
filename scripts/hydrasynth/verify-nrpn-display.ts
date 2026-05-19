/**
 * Golden test for Hydrasynth NRPN display formulas.
 *
 * Each row is a `(canonical-name, wire-value, expected-device-display)`
 * tuple. The first batch is grounded in the actual front-panel
 * readings the founder reported during the yungatita lo-fi test on
 * 2026-05-12 — wire values are derived from `resolveNrpnValue` for
 * the display inputs the agent passed.
 *
 * Spec-derived rows fill in the param families the test didn't cover
 * (delaywet, reverbwet, mutator*wet, etc.).
 */
import { resolveNrpnValue, resolveFxAwareValue } from '@mcp-midi-control/hydrasynth/encoding.js';
import { findHydraNrpn } from '@mcp-midi-control/hydrasynth/nrpn.js';
import { decodeFxNrpnDisplay, decodeNrpnDisplay } from '@mcp-midi-control/hydrasynth/nrpnDisplay.js';
import { HYDRASYNTH_ENUMS } from '@mcp-midi-control/hydrasynth/enums.js';

interface DisplayCase {
  readonly desc: string;
  readonly name: string;
  readonly userInput: number | string;
  /** prefxtype context (display name) for FX-aware sub-params. */
  readonly prefxType?: string;
  readonly expectDisplay: string;
}

const CASES: DisplayCase[] = [
  // ── Yungatita lo-fi test ground truth (founder front-panel readings) ──
  {
    desc: 'filter1cutoff = 78 user input → device shows "78.0" (NOT percent)',
    name: 'filter1cutoff',
    userInput: 78,
    expectDisplay: '78.0',
  },
  {
    desc: 'filter1resonance = 14 user input → device shows "14.0"',
    name: 'filter1resonance',
    userInput: 14,
    expectDisplay: '14.0',
  },
  {
    desc: 'env2sustain = 105 user input → device shows "105.0"',
    name: 'env2sustain',
    userInput: 105,
    expectDisplay: '105.0',
  },

  // ── FX wets (percent) ──
  {
    desc: 'reverbwet = 42 user input (already a percent) → "42.0%"',
    name: 'reverbwet',
    userInput: 42,
    expectDisplay: '42.0%',
  },
  {
    desc: 'delaywet = 18 → "18.0%"',
    name: 'delaywet',
    userInput: 18,
    expectDisplay: '18.0%',
  },
  {
    desc: 'prefxwet = 100 → "100.0%"',
    name: 'prefxwet',
    userInput: 100,
    expectDisplay: '100.0%',
  },

  // ── 0..128 raw knobs ──
  {
    desc: 'amplevel = 100 → "100.0"',
    name: 'amplevel',
    userInput: 100,
    expectDisplay: '100.0',
  },
  {
    desc: 'mixerosc1vol = 110 → "110.0"',
    name: 'mixerosc1vol',
    userInput: 110,
    expectDisplay: '110.0',
  },

  // ── Lo-Fi FX sub-params (per-type-aware path) ──
  // The agent's "value=88" for prefxparam1 went to 170 Hz before the
  // fix because the generic entry was used. With the fix, the fx5param1
  // entry is used: wire = 88 × 8192 / 128 = 5632 → Hz table index 88
  // → ~6500 Hz (not 170). The exact Hz depends on the table; we just
  // verify the decoder runs and returns a Hz string.
  {
    desc: 'Lo-Fi prefxparam1 = 88 + prefxtype=Lo-Fi → device shows Hz value (not raw 88)',
    name: 'prefxparam1',
    userInput: 88,
    prefxType: 'Lo-Fi',
    // Wire 88 × 8192/128 = 5632; cutoff table index 88 lands in the
    // 1600..7000 Hz band at the 64th entry of that band → ~6400 Hz.
    expectDisplay: '6400 Hz',
  },
  {
    desc: 'Lo-Fi prefxparam5 = "22050" + prefxtype=Lo-Fi → device shows 22050',
    name: 'prefxparam5',
    userInput: '22050',
    prefxType: 'Lo-Fi',
    expectDisplay: '22050',
  },

  // ── HW-109 (2026-05-17): env time wire→display, 27 points captured live
  //    from front panel of Hydrasynth Explorer. These pin the ATTACK/HOLD
  //    table (0..36 s) and the DECAY/RELEASE table (0..60 s) to byte-exact
  //    device output. Decay and release share the same table — covering
  //    both protects against a future refactor that diverges them.
  { desc: 'HW-109 env2attacksyncoff N=0   → "0 ms"',     name: 'env2attacksyncoff',  userInput: 0,   expectDisplay: '0 ms'      },
  { desc: 'HW-109 env2attacksyncoff N=5   → "5 ms"',     name: 'env2attacksyncoff',  userInput: 5,   expectDisplay: '5 ms'      },
  { desc: 'HW-109 env2attacksyncoff N=10  → "10 ms"',    name: 'env2attacksyncoff',  userInput: 10,  expectDisplay: '10 ms'     },
  { desc: 'HW-109 env2attacksyncoff N=25  → "30 ms"',    name: 'env2attacksyncoff',  userInput: 25,  expectDisplay: '30 ms'     },
  { desc: 'HW-109 env2attacksyncoff N=50  → "160 ms"',   name: 'env2attacksyncoff',  userInput: 50,  expectDisplay: '160 ms'    },
  { desc: 'HW-109 env2attacksyncoff N=75  → "960 ms"',   name: 'env2attacksyncoff',  userInput: 75,  expectDisplay: '960 ms'    },
  { desc: 'HW-109 env2attacksyncoff N=100 → "5.12 Sec"', name: 'env2attacksyncoff',  userInput: 100, expectDisplay: '5.12 Sec'  },
  { desc: 'HW-109 env2attacksyncoff N=120 → "20.0 Sec"', name: 'env2attacksyncoff',  userInput: 120, expectDisplay: '20.0 Sec'  },
  { desc: 'HW-109 env2attacksyncoff N=127 → "34.0 Sec"', name: 'env2attacksyncoff',  userInput: 127, expectDisplay: '34.0 Sec'  },

  { desc: 'HW-109 env2decaysyncoff N=0    → "0 ms"',     name: 'env2decaysyncoff',   userInput: 0,   expectDisplay: '0 ms'      },
  { desc: 'HW-109 env2decaysyncoff N=5    → "10 ms"',    name: 'env2decaysyncoff',   userInput: 5,   expectDisplay: '10 ms'     },
  { desc: 'HW-109 env2decaysyncoff N=10   → "20 ms"',    name: 'env2decaysyncoff',   userInput: 10,  expectDisplay: '20 ms'     },
  { desc: 'HW-109 env2decaysyncoff N=25   → "60 ms"',    name: 'env2decaysyncoff',   userInput: 25,  expectDisplay: '60 ms'     },
  { desc: 'HW-109 env2decaysyncoff N=50   → "320 ms"',   name: 'env2decaysyncoff',   userInput: 50,  expectDisplay: '320 ms'    },
  { desc: 'HW-109 env2decaysyncoff N=75   → "1.92 Sec"', name: 'env2decaysyncoff',   userInput: 75,  expectDisplay: '1.92 Sec'  },
  { desc: 'HW-109 env2decaysyncoff N=100  → "10.0 Sec"', name: 'env2decaysyncoff',   userInput: 100, expectDisplay: '10.0 Sec'  },
  { desc: 'HW-109 env2decaysyncoff N=120  → "44.0 Sec"', name: 'env2decaysyncoff',   userInput: 120, expectDisplay: '44.0 Sec'  },
  { desc: 'HW-109 env2decaysyncoff N=127  → "58.0 Sec"', name: 'env2decaysyncoff',   userInput: 127, expectDisplay: '58.0 Sec'  },

  { desc: 'HW-109 env2releasesyncoff N=0    → "0 ms"',     name: 'env2releasesyncoff', userInput: 0,   expectDisplay: '0 ms'      },
  { desc: 'HW-109 env2releasesyncoff N=5    → "10 ms"',    name: 'env2releasesyncoff', userInput: 5,   expectDisplay: '10 ms'     },
  { desc: 'HW-109 env2releasesyncoff N=10   → "20 ms"',    name: 'env2releasesyncoff', userInput: 10,  expectDisplay: '20 ms'     },
  { desc: 'HW-109 env2releasesyncoff N=25   → "60 ms"',    name: 'env2releasesyncoff', userInput: 25,  expectDisplay: '60 ms'     },
  { desc: 'HW-109 env2releasesyncoff N=50   → "320 ms"',   name: 'env2releasesyncoff', userInput: 50,  expectDisplay: '320 ms'    },
  { desc: 'HW-109 env2releasesyncoff N=75   → "1.92 Sec"', name: 'env2releasesyncoff', userInput: 75,  expectDisplay: '1.92 Sec'  },
  { desc: 'HW-109 env2releasesyncoff N=100  → "10.0 Sec"', name: 'env2releasesyncoff', userInput: 100, expectDisplay: '10.0 Sec'  },
  { desc: 'HW-109 env2releasesyncoff N=120  → "44.0 Sec"', name: 'env2releasesyncoff', userInput: 120, expectDisplay: '44.0 Sec'  },
  { desc: 'HW-109 env2releasesyncoff N=127  → "58.0 Sec"', name: 'env2releasesyncoff', userInput: 127, expectDisplay: '58.0 Sec'  },
];

function actualDisplay(c: DisplayCase): string {
  if (c.prefxType !== undefined) {
    // FX-aware route.
    const enumIdx = resolveNrpnValue(findHydraNrpn('prefxtype')!, c.prefxType);
    const fxTypeIdx = Math.round(enumIdx.wire / 8); // FX_TYPES is enumValueScale: 8
    const resolved = resolveFxAwareValue(c.name, c.userInput, { prefxTypeIdx: fxTypeIdx });
    // Try FX-specific decoder first, then enum table fallback.
    const fx = decodeFxNrpnDisplay(resolved.entry.name, resolved.wire);
    if (fx !== undefined) return fx;
    if (resolved.entry.enumTable) {
      const table = HYDRASYNTH_ENUMS[resolved.entry.enumTable];
      const idx = resolved.entry.enumValueScale
        ? Math.round(resolved.wire / resolved.entry.enumValueScale)
        : resolved.wire;
      return String(table?.[idx] ?? `wire ${resolved.wire}`);
    }
    return `wire ${resolved.wire}`;
  }
  // Generic curated formula path.
  const entry = findHydraNrpn(c.name)!;
  const resolved = resolveNrpnValue(entry, c.userInput);
  const display = decodeNrpnDisplay(c.name, resolved.wire);
  return display ?? `wire ${resolved.wire}`;
}

let failures = 0;
for (const c of CASES) {
  const got = actualDisplay(c);
  const ok = got === c.expectDisplay;
  if (!ok) {
    failures++;
    console.error(`✗ ${c.desc}`);
    console.error(`    expected: ${c.expectDisplay}`);
    console.error(`    got:      ${got}`);
  } else {
    console.log(`✓ ${c.desc}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${CASES.length} display-formula cases failed.`);
  process.exit(1);
}
console.log(`\n✓ ${CASES.length}/${CASES.length} hydrasynth NRPN display cases pass.`);
