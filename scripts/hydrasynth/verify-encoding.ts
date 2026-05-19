/**
 * Hydrasynth Explorer — golden tests for the NRPN encoding logic.
 *
 * Mirrors the AM4 `verify-msg.ts` pattern: hand-written cases assert
 * exact wire bytes / resolved values for every interesting code path
 * in `src/asm/hydrasynth-explorer/encoding.ts` and the auto-
 * generated `nrpn.ts` registry. Locks in:
 *
 *   - Auto-scale from 0..127 to a 14-bit register's wireMax (the
 *     fix that made "decay=127" land near max instead of at ~1.5% of max).
 *   - Multi-slot dataMsb disambiguation (osc1/osc2/osc3 on the same
 *     NRPN address; mutator slots; ringmod sources).
 *   - CC-catalog alias resolution ("filter1.res" → filter1resonance,
 *     "mixer.osc1_vol" → mixerosc1vol, "env1.attack" → env1attacksyncoff).
 *   - Enum-name resolution (filter1type="Vowel" → 10) and sparse
 *     encoding (prefxtype="Lo-Fi" → 40 via ×8 scale).
 *
 * Run:  npx tsx scripts/hydrasynth/verify-encoding.ts
 *       (or via `npm test`).
 */
import { findHydraNrpn } from '@mcp-midi-control/hydrasynth/nrpn.js';
import {
  resolveNrpnValue,
  nrpnMessagesFor,
  findMatchingNrpns,
} from '@mcp-midi-control/hydrasynth/encoding.js';
import { INIT_PATCH } from '@mcp-midi-control/hydrasynth/initPatch.js';

interface Case {
  label: string;
  fn: () => boolean | string;
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, fn: () => boolean | string): Case {
  return { label, fn };
}

function eq<T>(actual: T, expected: T, ctx = ''): boolean | string {
  if (actual === expected) return true;
  return `${ctx ? ctx + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

function deepEq<T>(actual: T, expected: T, ctx = ''): boolean | string {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return true;
  return `${ctx ? ctx + ': ' : ''}expected ${e}, got ${a}`;
}

function getOrThrow(name: string) {
  const e = findHydraNrpn(name);
  if (!e) throw new Error(`registry missing "${name}"`);
  return e;
}

const cases: Case[] = [
  // ---------------- Lookup + alias resolution -----------------------------
  check('canonical name lookup: filter1cutoff', () => {
    const e = findHydraNrpn('filter1cutoff');
    if (!e) return 'not found';
    return e.msb === 0x40 && e.lsb === 0x28 ? true : `wrong address ${e.msb}/${e.lsb}`;
  }),
  check('alias lookup: filter1.cutoff → filter1cutoff', () => {
    const e = findHydraNrpn('filter1.cutoff');
    if (!e) return 'not found';
    return e.name === 'filter1cutoff' ? true : `aliased to ${e.name}`;
  }),
  check('alias lookup: filter1.res → filter1resonance', () => {
    const e = findHydraNrpn('filter1.res');
    return e?.name === 'filter1resonance' ? true : `got ${e?.name ?? 'undefined'}`;
  }),
  check('alias lookup: mixer.osc1_vol → mixerosc1vol', () => {
    const e = findHydraNrpn('mixer.osc1_vol');
    return e?.name === 'mixerosc1vol' ? true : `got ${e?.name ?? 'undefined'}`;
  }),
  check('alias lookup: env1.attack → env1attacksyncoff', () => {
    const e = findHydraNrpn('env1.attack');
    return e?.name === 'env1attacksyncoff' ? true : `got ${e?.name ?? 'undefined'}`;
  }),
  check('alias lookup: env1.sustain → env1sustain (canonical, no rename)', () => {
    const e = findHydraNrpn('env1.sustain');
    return e?.name === 'env1sustain' ? true : `got ${e?.name ?? 'undefined'}`;
  }),
  check('unknown name returns undefined', () => {
    return findHydraNrpn('totallymadeupparam') === undefined
      ? true : 'should have been undefined';
  }),

  // ---------------- 14-bit auto-scale -------------------------------------
  check('auto-scale: filter1cutoff value=64 → wire 4096 (display 64.0 exact)', () => {
    const r = resolveNrpnValue(getOrThrow('filter1cutoff'), 64);
    if (!r.scaled) return 'should have scaled';
    return r.wire === 4096 ? true : `wire=${r.wire}`;
  }),
  check('auto-scale: filter1cutoff value=128 → wire 8192 (max)', () => {
    const r = resolveNrpnValue(getOrThrow('filter1cutoff'), 128);
    return r.wire === 8192 && r.scaled
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('auto-scale: filter1cutoff value=127 → wire 8128 (display 127.0 exact)', () => {
    const r = resolveNrpnValue(getOrThrow('filter1cutoff'), 127);
    return r.wire === 8128 && r.scaled
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('auto-scale: filter1cutoff value=0 → wire 0 (min)', () => {
    const r = resolveNrpnValue(getOrThrow('filter1cutoff'), 0);
    return r.wire === 0 && r.scaled
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('auto-scale skipped: filter1cutoff value=8000 passes through (>128)', () => {
    const r = resolveNrpnValue(getOrThrow('filter1cutoff'), 8000);
    return r.wire === 8000 && !r.scaled
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('auto-scale: mixerosc1vol value=55 → wire 3520 (display 55.0 exact)', () => {
    const r = resolveNrpnValue(getOrThrow('mixerosc1vol'), 55);
    return r.wire === 3520 && r.scaled
      ? true : `got wire=${r.wire}`;
  }),
  check('auto-scale: filter1resonance value=15 → wire 960 (display 15.0 exact)', () => {
    const r = resolveNrpnValue(getOrThrow('filter1resonance'), 15);
    return r.wire === 960 && r.scaled
      ? true : `got wire=${r.wire}`;
  }),
  check('auto-scale: env1sustain value=128 → wire 8192 (max)', () => {
    const r = resolveNrpnValue(getOrThrow('env1sustain'), 128);
    return r.wire === 8192 && r.scaled
      ? true : `got ${JSON.stringify(r)}`;
  }),

  // ---------------- Bipolar auto-scale (BK-037) ---------------------------
  // Symmetric range [-64, +64] with wireMax 8192. value 0 must land at
  // wire 4096 (display 0), NOT wire 0 (display -64). Lock the
  // freshPatch silence regression.
  check('bipolar: filter1env1amount has displayMin=-64 displayMax=64', () => {
    const e = getOrThrow('filter1env1amount');
    return e.displayMin === -64 && e.displayMax === 64
      ? true : `got displayMin=${e.displayMin} displayMax=${e.displayMax}`;
  }),
  check('bipolar: filter1env1amount value=0 → wire 4096 (display 0, NOT -64)', () => {
    const r = resolveNrpnValue(getOrThrow('filter1env1amount'), 0);
    return r.wire === 4096 && r.bipolar && r.scaled
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('bipolar: filter1env1amount value=12 → wire 4864 (display +12)', () => {
    const r = resolveNrpnValue(getOrThrow('filter1env1amount'), 12);
    return r.wire === 4864 && r.bipolar
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('bipolar: filter1env1amount value=-52 → wire 768 (display -52, the original bug case)', () => {
    const r = resolveNrpnValue(getOrThrow('filter1env1amount'), -52);
    return r.wire === 768 && r.bipolar
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('bipolar: filter1env1amount value=64 → wire 8192 (max positive)', () => {
    const r = resolveNrpnValue(getOrThrow('filter1env1amount'), 64);
    return r.wire === 8192 && r.bipolar
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('bipolar: filter1env1amount value=-64 → wire 0 (max negative)', () => {
    const r = resolveNrpnValue(getOrThrow('filter1env1amount'), -64);
    return r.wire === 0 && r.bipolar
      ? true : `got ${JSON.stringify(r)}`;
  }),

  // Symmetric -200%..+200% with wireMax 8192. The second confirmed
  // INIT_PATCH bug — value 0 must center at wire 4096.
  check('bipolar: filter1keytrack has displayMin=-200 displayMax=200', () => {
    const e = getOrThrow('filter1keytrack');
    return e.displayMin === -200 && e.displayMax === 200
      ? true : `got displayMin=${e.displayMin} displayMax=${e.displayMax}`;
  }),
  check('bipolar: filter1keytrack value=0 → wire 4096 (display 0%, NOT -200%)', () => {
    const r = resolveNrpnValue(getOrThrow('filter1keytrack'), 0);
    return r.wire === 4096 && r.bipolar
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('bipolar: filter1keytrack value=100 → wire 6144 (display +100%)', () => {
    const r = resolveNrpnValue(getOrThrow('filter1keytrack'), 100);
    return r.wire === 6144 && r.bipolar
      ? true : `got ${JSON.stringify(r)}`;
  }),

  // Pan: -64..+64 like env amount.
  check('bipolar: mixerosc1pan value=0 → wire 4096 (centered)', () => {
    const r = resolveNrpnValue(getOrThrow('mixerosc1pan'), 0);
    return r.wire === 4096 && r.bipolar
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('bipolar: mixerosc1pan value=-30 → wire 2176 (display -30, panned left)', () => {
    const r = resolveNrpnValue(getOrThrow('mixerosc1pan'), -30);
    return r.wire === 2176 && r.bipolar
      ? true : `got ${JSON.stringify(r)}`;
  }),

  // Session 49 ambient-pad fix: out-of-range bipolar input now THROWS
  // instead of silently passing through. Previously the fall-through
  // path let `reverbtone: 72` (a -64..+64 param) wrap-encode to wire
  // 4608 / display 8.0 — visibly wrong values landing on the device.
  // The escape hatch for advanced callers passing raw wire was a
  // footgun in practice; if a caller really wants to send wire 9000,
  // they can pass it through `hydra_set_engine_param` which doesn't
  // route through resolveNrpnValue's range check.
  check('bipolar: out-of-range value 9000 throws (was a silent footgun)', () => {
    try {
      resolveNrpnValue(getOrThrow('filter1env1amount'), 9000);
      return 'should have thrown';
    } catch (e) {
      return e instanceof Error && /bipolar/.test(e.message)
        ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
    }
  }),

  // Unipolar regression — confirm the existing 14-bit auto-scale path
  // is unchanged (filter1cutoff, mixerosc1vol, etc. don't have
  // displayMin set, so they keep the old [0,128]→[0,wireMax] behavior).
  check('regression: filter1cutoff stays unipolar (no displayMin), value=0 → wire 0', () => {
    const e = getOrThrow('filter1cutoff');
    if (e.displayMin !== undefined) return `unexpected displayMin=${e.displayMin}`;
    const r = resolveNrpnValue(e, 0);
    return r.wire === 0 && r.scaled && !r.bipolar
      ? true : `got ${JSON.stringify(r)}`;
  }),

  // ---------------- Multi-slot disambiguation -----------------------------
  check('multi-slot: osc1semi has dataMsb=0', () => {
    const e = getOrThrow('osc1semi');
    return e.dataMsb === 0 ? true : `got ${e.dataMsb}`;
  }),
  check('multi-slot: osc2semi has dataMsb=1', () => {
    const e = getOrThrow('osc2semi');
    return e.dataMsb === 1 ? true : `got ${e.dataMsb}`;
  }),
  check('multi-slot: osc3semi has dataMsb=2', () => {
    const e = getOrThrow('osc3semi');
    return e.dataMsb === 2 ? true : `got ${e.dataMsb}`;
  }),
  check('multi-slot: mutator4mode has dataMsb=3', () => {
    const e = getOrThrow('mutator4mode');
    return e.dataMsb === 3 ? true : `got ${e.dataMsb}`;
  }),
  check('multi-slot: osc{1,2,3}semi all share NRPN 0x3F 0x11', () => {
    const a = getOrThrow('osc1semi');
    const b = getOrThrow('osc2semi');
    const c = getOrThrow('osc3semi');
    return a.msb === b.msb && a.msb === c.msb && a.lsb === b.lsb && a.lsb === c.lsb
      && a.msb === 0x3f && a.lsb === 0x11
      ? true : `addresses differ: ${a.msb}/${a.lsb}, ${b.msb}/${b.lsb}, ${c.msb}/${c.lsb}`;
  }),
  check('multi-slot: osc2semi value=12 produces correct CC sequence', () => {
    const msgs = nrpnMessagesFor(getOrThrow('osc2semi'), 1, 12);
    const expected = [
      [0xb0, 99, 0x3f],   // address MSB
      [0xb0, 98, 0x11],   // address LSB
      [0xb0, 6, 1],       // data MSB = slot index for osc2
      [0xb0, 38, 12],     // data LSB = +12 semitones
    ];
    return deepEq(msgs, expected, 'osc2semi=12 CC sequence');
  }),
  check('multi-slot: osc1semi value=12 produces correct CC sequence', () => {
    const msgs = nrpnMessagesFor(getOrThrow('osc1semi'), 1, 12);
    const expected = [
      [0xb0, 99, 0x3f],
      [0xb0, 98, 0x11],
      [0xb0, 6, 0],   // slot 0 for osc1
      [0xb0, 38, 12],
    ];
    return deepEq(msgs, expected, 'osc1semi=12 CC sequence');
  }),
  check('multi-slot: dataMsb suppresses 14-bit auto-scale', () => {
    // osc2semi is multi-slot and has no wireMax-driven auto-scale path.
    // value=64 should pass through, NOT scale to wireMax * 64/127.
    const r = resolveNrpnValue(getOrThrow('osc2semi'), 64);
    return r.wire === 64 && !r.scaled
      ? true : `got ${JSON.stringify(r)}`;
  }),

  // ---------------- Enum-name resolution ----------------------------------
  check('enum: filter1type="Vowel" → wire 10', () => {
    const r = resolveNrpnValue(getOrThrow('filter1type'), 'Vowel');
    return r.wire === 10 && !r.scaled
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('enum: filter1type="LP Ladder 12" → wire 0', () => {
    const r = resolveNrpnValue(getOrThrow('filter1type'), 'LP Ladder 12');
    return r.wire === 0
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('enum: relaxed-match resolves "lp-ladder-24" → wire 1', () => {
    const r = resolveNrpnValue(getOrThrow('filter1type'), 'lp-ladder-24');
    return r.wire === 1
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('enum: osc1type="Sine" → wire 0', () => {
    const r = resolveNrpnValue(getOrThrow('osc1type'), 'Sine');
    return r.wire === 0
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('enum: osc1type="Triangle" → wire 1', () => {
    const r = resolveNrpnValue(getOrThrow('osc1type'), 'Triangle');
    return r.wire === 1
      ? true : `got ${JSON.stringify(r)}`;
  }),

  // ---------------- Sparse-encoding (×8) for FX types ---------------------
  check('sparse-enum: prefxtype="Bypass" → wire 0', () => {
    const r = resolveNrpnValue(getOrThrow('prefxtype'), 'Bypass');
    return r.wire === 0
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('sparse-enum: prefxtype="Chorus" → wire 8 (1 × 8)', () => {
    const r = resolveNrpnValue(getOrThrow('prefxtype'), 'Chorus');
    return r.wire === 8
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('sparse-enum: prefxtype="Lo-Fi" → wire 40 (5 × 8)', () => {
    const r = resolveNrpnValue(getOrThrow('prefxtype'), 'Lo-Fi');
    return r.wire === 40
      ? true : `got ${JSON.stringify(r)}`;
  }),
  check('sparse-enum: postfxtype="Rotary" → wire 24 (3 × 8)', () => {
    const r = resolveNrpnValue(getOrThrow('postfxtype'), 'Rotary');
    return r.wire === 24
      ? true : `got ${JSON.stringify(r)}`;
  }),

  // ---------------- Plain 14-bit splitting (no auto-scale, no slot) -------
  check('14-bit split: filter1cutoff wire=4096 → data MSB 32 / LSB 0', () => {
    const msgs = nrpnMessagesFor(getOrThrow('filter1cutoff'), 1, 4096);
    // 4096 = 0x1000 → MSB = 0x20 = 32, LSB = 0x00 = 0
    return deepEq(msgs[2], [0xb0, 6, 32], 'data MSB') === true
        && deepEq(msgs[3], [0xb0, 38, 0], 'data LSB') === true
      ? true : `got data MSB=${msgs[2]?.[2]}, LSB=${msgs[3]?.[2]}`;
  }),
  check('14-bit split: filter1cutoff wire=8192 → data MSB 64 / LSB 0', () => {
    const msgs = nrpnMessagesFor(getOrThrow('filter1cutoff'), 1, 8192);
    return deepEq(msgs[2], [0xb0, 6, 64], 'data MSB') === true
        && deepEq(msgs[3], [0xb0, 38, 0], 'data LSB') === true
      ? true : `got data MSB=${msgs[2]?.[2]}, LSB=${msgs[3]?.[2]}`;
  }),

  // ---------------- Channel encoding --------------------------------------
  check('channel 1 → status byte 0xB0', () => {
    const msgs = nrpnMessagesFor(getOrThrow('filter1cutoff'), 1, 0);
    return msgs.every((m) => m[0] === 0xb0) ? true : 'wrong status';
  }),
  check('channel 16 → status byte 0xBF', () => {
    const msgs = nrpnMessagesFor(getOrThrow('filter1cutoff'), 16, 0);
    return msgs.every((m) => m[0] === 0xbf) ? true : 'wrong status';
  }),

  // ---------------- Search ranking + loose match -------------------------
  check('search: prefix at boundary outranks prefix mid-number', () => {
    // "modmatrix1" should rank modmatrix1depth (next char "d") above
    // modmatrix15modsource (next char "5"). Tests Fix B.
    const hits = findMatchingNrpns('modmatrix1', 5).map((h) => h.entry.name);
    const idx1 = hits.indexOf('modmatrix1depth');
    const idx15 = hits.findIndex((n) => n.startsWith('modmatrix15'));
    if (idx1 < 0) return 'modmatrix1depth not found';
    if (idx15 >= 0 && idx1 > idx15) return `modmatrix1depth at ${idx1}, modmatrix15* at ${idx15}`;
    return true;
  }),
  check('search: loose-segment match bridges mod1depth → modmatrix1depth', () => {
    // The cheat-sheet originally listed mod1depth (wrong); user/Claude
    // shouldn't have to know that. Tests Fix C.
    const hits = findMatchingNrpns('mod1depth', 5).map((h) => h.entry.name);
    return hits[0] === 'modmatrix1depth' ? true : `top hit was ${hits[0] ?? 'none'}`;
  }),
  check('search: loose match bridges ringmod1 → ringmodsource1', () => {
    const hits = findMatchingNrpns('ringmod1', 3).map((h) => h.entry.name);
    return hits[0] === 'ringmodsource1' ? true : `top hit was ${hits[0] ?? 'none'}`;
  }),
  check('search: alias direct hit still wins (filter1.cutoff)', () => {
    const hits = findMatchingNrpns('filter1.cutoff', 3);
    return hits[0]?.entry.name === 'filter1cutoff' && hits[0]?.score === 100
      ? true : `top hit ${hits[0]?.entry.name} score ${hits[0]?.score}`;
  }),
  check('search: empty query returns no hits (no full-dump risk)', () => {
    return findMatchingNrpns('', 30).length === 0 ? true : 'empty query returned hits';
  }),

  // ---------------- INIT_PATCH integrity ----------------------------------
  check('INIT_PATCH: every name resolves in the registry', () => {
    const missing = INIT_PATCH
      .map((e) => e.name)
      .filter((n) => !findHydraNrpn(n));
    return missing.length === 0
      ? true
      : `unresolved: ${missing.join(', ')}`;
  }),
  check('INIT_PATCH: every value resolves through resolveNrpnValue', () => {
    for (const e of INIT_PATCH) {
      const entry = findHydraNrpn(e.name);
      if (!entry) return `${e.name} not in registry`;
      try {
        resolveNrpnValue(entry, e.value);
      } catch (err) {
        return `${e.name}=${JSON.stringify(e.value)}: ${(err as Error).message}`;
      }
    }
    return true;
  }),
  check('INIT_PATCH: contains all 32 mod-matrix slot disables', () => {
    const targets = INIT_PATCH.filter((e) => /^modmatrix\d+modtarget$/.test(e.name));
    return targets.length === 32 && targets.every((e) => e.value === 0)
      ? true
      : `got ${targets.length} modtarget entries, all zero?=${targets.every((e) => e.value === 0)}`;
  }),
  check('INIT_PATCH: covers all 4 mutator wet zeros', () => {
    const muts = INIT_PATCH.filter((e) => /^mutator\dwet$/.test(e.name));
    return muts.length === 4 && muts.every((e) => e.value === 0)
      ? true : `got ${muts.length} mutator wet entries`;
  }),
  check('INIT_PATCH: all 5 LFO levels zeroed', () => {
    const lfos = INIT_PATCH.filter((e) => /^lfo\dlevel$/.test(e.name));
    return lfos.length === 5 && lfos.every((e) => e.value === 0)
      ? true : `got ${lfos.length} lfo level entries`;
  }),

  // ---------------- Error paths -------------------------------------------
  check('error: string input on non-enum param throws', () => {
    try {
      resolveNrpnValue(getOrThrow('filter1cutoff'), 'high');
      return 'should have thrown';
    } catch (err) {
      return err instanceof Error && err.message.includes('doesn\'t accept name strings')
        ? true : `wrong error: ${(err as Error).message}`;
    }
  }),
  check('error: unknown enum name throws with hint', () => {
    try {
      resolveNrpnValue(getOrThrow('filter1type'), 'NonExistentFilter');
      return 'should have thrown';
    } catch (err) {
      return err instanceof Error && err.message.includes('FILTER_1_TYPES')
        ? true : `wrong error: ${(err as Error).message}`;
    }
  }),
];

for (const c of cases) {
  let result: boolean | string;
  try {
    result = c.fn();
  } catch (err) {
    result = err instanceof Error ? `threw: ${err.message}` : String(err);
  }
  if (result === true) {
    passed++;
  } else {
    failed++;
    failures.push(`✗ ${c.label}\n    ${result}`);
  }
}

if (failed === 0) {
  console.log(`✓ ${passed}/${cases.length} hydrasynth encoding cases pass.`);
} else {
  console.error(`${passed}/${cases.length} pass; ${failed} fail:\n`);
  for (const f of failures) console.error(f);
  process.exit(1);
}
