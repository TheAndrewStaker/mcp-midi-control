/**
 * Hydrasynth Explorer — golden test for enum-typed param resolution.
 *
 * Locks the Session 49 ambient-pad bug fix for two related classes
 * of mismatch between the NRPN-wire encoding and the patch-buffer
 * byte layout:
 *
 *   1. **FX/Delay/Reverb type selectors with `enumValueScale: 8`.**
 *      The NRPN-send path emits `idx × 8` (Hydrasynth's sparse
 *      encoding — Bypass=0, Chorus=8, ..., Compressor=64). The patch
 *      buffer at bytes 352 / 368 / 384 / 400 stores the **raw enum
 *      index** (verified against ASMHydrasynth.java lines 5963 / 6830
 *      `Math.max(0, Math.min(data[352], 9))`). Empirically before this
 *      fix: `prefxtype: "Chorus"` wrote wire 8 to byte 352 and the
 *      device decoded it as Compressor (FX_TYPES[8]).
 *
 *   2. **REVERB_TIMES enum with `enumValueScale: 64`.** reverbtime is
 *      a 129-entry lookup table indexed by `wire / 64`. Numeric input
 *      is now treated as the index (0..128) rather than percent-of-
 *      max (Session 49: input 105 was percent-scaled to wire 6720
 *      → patch byte 13 → idx 1 = "130ms" instead of idx 105 = "16.0s").
 *
 * Two pinned-truth assertions per param: string input (the canonical
 * agent-friendly path) AND numeric input (defensive coverage for
 * agents that pass the index directly from a knowledge file).
 *
 * Run:  npx tsx scripts/hydrasynth/verify-enum-mapping.ts
 */
import { findHydraNrpn } from '@mcp-midi-control/hydrasynth/nrpn.js';
import { resolveNrpnValue } from '@mcp-midi-control/hydrasynth/encoding.js';
import {
  encodePatch,
  findPatchOffset,
  readPatchValue,
} from '@mcp-midi-control/hydrasynth/patchEncoder.js';

interface Case {
  label: string;
  fn: () => boolean | string;
}

const cases: Case[] = [];
function check(label: string, fn: () => boolean | string): void {
  cases.push({ label, fn });
}

function entryFor(name: string) {
  const e = findHydraNrpn(name);
  if (!e) throw new Error(`no NRPN entry for ${name}`);
  return e;
}

// --------------------------------------------------------------------
// FX_TYPES — prefxtype / postfxtype share enumValueScale=8.
// Index 0=Bypass, 1=Chorus, 2=Flanger, ..., 8=Compressor, 9=Distortion.
// NRPN wire = idx × 8. Patch buffer byte = idx (raw).
// --------------------------------------------------------------------

check('prefxtype: "Chorus" string → NRPN wire 8 (idx 1 × scale 8)', () => {
  const r = resolveNrpnValue(entryFor('prefxtype'), 'Chorus');
  return r.wire === 8 ? true : `got wire=${r.wire}`;
});

check('prefxtype: "Compressor" string → NRPN wire 64 (idx 8 × scale 8)', () => {
  const r = resolveNrpnValue(entryFor('prefxtype'), 'Compressor');
  return r.wire === 64 ? true : `got wire=${r.wire}`;
});

check('prefxtype: numeric 1 (index) → NRPN wire 8 = Chorus', () => {
  const r = resolveNrpnValue(entryFor('prefxtype'), 1);
  return r.wire === 8 ? true : `got wire=${r.wire}`;
});

check('prefxtype: numeric 8 (index) → NRPN wire 64 = Compressor', () => {
  const r = resolveNrpnValue(entryFor('prefxtype'), 8);
  return r.wire === 64 ? true : `got wire=${r.wire}`;
});

check('prefxtype: out-of-range index 10 throws', () => {
  try {
    resolveNrpnValue(entryFor('prefxtype'), 10);
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error && /index 0\.\.9/.test(e.message)
      ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
  }
});

check('prefxtype patch buffer: "Chorus" lands as raw index 1 at byte 352', () => {
  // The bug pre-fix: passing "Chorus" wrote wire 8 to byte 352, and
  // the device decoded byte=8 as Compressor. Lock the post-fix
  // behavior: byte 352 stores the index (1 for Chorus) regardless of
  // the wire scaling used on NRPN.
  const r = resolveNrpnValue(entryFor('prefxtype'), 'Chorus');
  const buf = encodePatch(new Map([['prefxtype', r.wire]]));
  return buf[352] === 1 && buf[353] === 0
    ? true : `bytes 352=${buf[352]}, 353=${buf[353]}`;
});

check('prefxtype patch buffer: "Compressor" lands as raw index 8 at byte 352', () => {
  const r = resolveNrpnValue(entryFor('prefxtype'), 'Compressor');
  const buf = encodePatch(new Map([['prefxtype', r.wire]]));
  return buf[352] === 8 && buf[353] === 0
    ? true : `bytes 352=${buf[352]}, 353=${buf[353]}`;
});

check('postfxtype patch buffer: "Lo-Fi" lands as raw index 5 at byte 400', () => {
  const r = resolveNrpnValue(entryFor('postfxtype'), 'Lo-Fi');
  const buf = encodePatch(new Map([['postfxtype', r.wire]]));
  return buf[400] === 5 ? true : `byte 400=${buf[400]}`;
});

check('decode round-trip: "Chorus" → encodePatch → readPatchValue is the index 1', () => {
  const r = resolveNrpnValue(entryFor('prefxtype'), 'Chorus');
  const buf = encodePatch(new Map([['prefxtype', r.wire]]));
  const back = readPatchValue(buf, findPatchOffset('prefxtype')!);
  return back === 1 ? true : `back=${back}`;
});

// --------------------------------------------------------------------
// DELAY_TYPES — delaytype share enumValueScale=8.
// Index 0=Basic Mono, 1=Basic Stereo, 2=Pan Delay, 3=LRC Delay, 4=Reverse.
// --------------------------------------------------------------------

check('delaytype: "Basic Stereo" string → NRPN wire 8 (idx 1 × 8)', () => {
  const r = resolveNrpnValue(entryFor('delaytype'), 'Basic Stereo');
  return r.wire === 8 ? true : `got wire=${r.wire}`;
});

check('delaytype patch buffer: "Basic Stereo" lands as index 1 at byte 368', () => {
  // The bug pre-fix: "Basic Stereo" → wire 8 → byte 368 = 8, device
  // decoded as out-of-range and showed BasicMo (Basic Mono — index 0).
  // Now: byte 368 = 1 → device shows Basic Stereo.
  const r = resolveNrpnValue(entryFor('delaytype'), 'Basic Stereo');
  const buf = encodePatch(new Map([['delaytype', r.wire]]));
  return buf[368] === 1 ? true : `byte 368=${buf[368]}`;
});

check('delaytype patch buffer: "Reverse" lands as index 4 at byte 368', () => {
  const r = resolveNrpnValue(entryFor('delaytype'), 'Reverse');
  const buf = encodePatch(new Map([['delaytype', r.wire]]));
  return buf[368] === 4 ? true : `byte 368=${buf[368]}`;
});

check('delaytype: numeric 2 (index) → NRPN wire 16 = Pan Delay', () => {
  const r = resolveNrpnValue(entryFor('delaytype'), 2);
  return r.wire === 16 ? true : `got wire=${r.wire}`;
});

// --------------------------------------------------------------------
// REVERB_TYPES — reverbtype share enumValueScale=8.
// Index 0=Hall, 1=Room, 2=Plate, 3=Cloud.
// --------------------------------------------------------------------

check('reverbtype: "Hall" string → NRPN wire 0 (idx 0 × 8)', () => {
  const r = resolveNrpnValue(entryFor('reverbtype'), 'Hall');
  return r.wire === 0 ? true : `got wire=${r.wire}`;
});

check('reverbtype patch buffer: "Cloud" lands as index 3 at byte 384', () => {
  const r = resolveNrpnValue(entryFor('reverbtype'), 'Cloud');
  const buf = encodePatch(new Map([['reverbtype', r.wire]]));
  return buf[384] === 3 ? true : `byte 384=${buf[384]}`;
});

// --------------------------------------------------------------------
// REVERB_TIMES — reverbtime gets enumValueScale=64. 129-entry table.
// idx 0 = "120ms", idx 1 = "130ms", idx 105 = "16.0s", idx 128 = "Freeze".
// Wire = idx × 64. Patch byte = wire / 8 / 8 = idx (after both /8 stages).
// --------------------------------------------------------------------

check('reverbtime: "16.0s" string → NRPN wire 6720 (idx 105 × 64)', () => {
  const r = resolveNrpnValue(entryFor('reverbtime'), '16.0s');
  return r.wire === 6720 ? true : `got wire=${r.wire}`;
});

check('reverbtime: numeric 105 (index) → NRPN wire 6720 = "16.0s"', () => {
  // The Session 49 ambient-pad bug — the agent passed 105 expecting
  // "16.0s"; the runtime percent-scaled it to wire 6720 (coincidentally
  // the right wire by accident — but a different mechanism than the
  // index path). Now both paths go through enumValueScale.
  const r = resolveNrpnValue(entryFor('reverbtime'), 105);
  return r.wire === 6720 ? true : `got wire=${r.wire}`;
});

check('reverbtime patch buffer: idx 105 lands as patch byte 840 at bytes 388/389', () => {
  // NRPN wire = idx × 64 = 6720.
  // u16le patch encoding does /8 internally → patch byte = 840.
  // 840 = 0x0348 → low 0x48, high 0x03. Device decodes patch_byte/8
  // = 105 → REVERB_TIMES[105] = "16.0s". The u16le encoding's
  // existing /8 already produces the right index, so encodePatch
  // does NOT also divide by enumValueScale for u16le slots.
  const r = resolveNrpnValue(entryFor('reverbtime'), '16.0s');
  const buf = encodePatch(new Map([['reverbtime', r.wire]]));
  return buf[388] === 0x48 && buf[389] === 0x03
    ? true : `bytes 388=${buf[388].toString(16)}, 389=${buf[389].toString(16)}`;
});

check('reverbtime: out-of-range index -1 throws', () => {
  try {
    resolveNrpnValue(entryFor('reverbtime'), -1);
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error ? true : `wrong error: ${e}`;
  }
});

check('reverbtime: out-of-range index 200 throws', () => {
  try {
    resolveNrpnValue(entryFor('reverbtime'), 200);
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error ? true : `wrong error: ${e}`;
  }
});

// --------------------------------------------------------------------
// reverbtone — bipolar -64..+64. Out-of-range numeric input must throw.
// Locks Session 49 bug fix: passing 72 to a -64..+64 param was silently
// percent-scaling to wire 4608 (display 8.0).
// --------------------------------------------------------------------

check('reverbtone: 0 → wire 4096 (centered)', () => {
  const r = resolveNrpnValue(entryFor('reverbtone'), 0);
  return r.wire === 4096 ? true : `got wire=${r.wire}`;
});

check('reverbtone: +64 → wire 8192 (max)', () => {
  const r = resolveNrpnValue(entryFor('reverbtone'), 64);
  return r.wire === 8192 ? true : `got wire=${r.wire}`;
});

check('reverbtone: -64 → wire 0 (min)', () => {
  const r = resolveNrpnValue(entryFor('reverbtone'), -64);
  return r.wire === 0 ? true : `got wire=${r.wire}`;
});

check('reverbtone: out-of-range +72 throws (was silently wrap-encoding)', () => {
  try {
    resolveNrpnValue(entryFor('reverbtone'), 72);
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error && /-64\.\.64/.test(e.message)
      ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
  }
});

check('reverbtone: out-of-range -100 throws', () => {
  try {
    resolveNrpnValue(entryFor('reverbtone'), -100);
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error && /-64\.\.64/.test(e.message)
      ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
  }
});

// Other bipolar params should reject too — sanity-check filter1env1amount.
check('filter1env1amount: out-of-range +100 (range -64..+64) throws', () => {
  try {
    resolveNrpnValue(entryFor('filter1env1amount'), 100);
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error && /bipolar/.test(e.message)
      ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
  }
});

// --------------------------------------------------------------------
// reverbpredelay — newly-bound to displayMin: 0, displayMax: 250 (ms).
// Input 18 (ms) → wire ~590 → patch byte 74 → device displays ~18 ms.
// Was previously percent-scaling 18 → wire 1152 → display 35.6 ms.
// --------------------------------------------------------------------

check('reverbpredelay: 18 (ms) maps closer to display 18 than the old percent-scaled 35.6', () => {
  const r = resolveNrpnValue(entryFor('reverbpredelay'), 18);
  // wire = round(18 × 8192 / 250) = 590
  // patch byte = round(590/8) = 74
  // device formula: 74 × 10 / 4.1042 = 180.3 → round 180 → 18.0 + 0.5 = 18.5 ms
  // Lock the wire value; we don't simulate the device formula here.
  if (r.wire !== 590) return `got wire=${r.wire} (expected 590)`;
  if (!r.scaled) return 'should be scaled';
  if (r.bipolar) return 'should not be bipolar';
  return true;
});

check('reverbpredelay: 0 ms → wire 0', () => {
  const r = resolveNrpnValue(entryFor('reverbpredelay'), 0);
  return r.wire === 0 ? true : `got wire=${r.wire}`;
});

check('reverbpredelay: 250 ms → wire 8192 (max)', () => {
  const r = resolveNrpnValue(entryFor('reverbpredelay'), 250);
  return r.wire === 8192 ? true : `got wire=${r.wire}`;
});

check('reverbpredelay: 300 (out of range, no displayMin<0) falls through to raw wire', () => {
  // displayMax 250 but displayMin 0 (not bipolar) → fall-through allowed
  // for unipolar params so advanced callers can still pass raw wire.
  const r = resolveNrpnValue(entryFor('reverbpredelay'), 300);
  return r.wire === 300 ? true : `got wire=${r.wire}`;
});

// --------------------------------------------------------------------
// FX_DELAYS_SYNC_ON — delaytimesyncon. NRPN wire IS the index (no
// enumValueScale, wireMax: 20). Patch buffer at byte 372 stores the
// raw index. The bug pre-Session 50: u16le writePatchValue divided
// wire by 8, so wire 18 ("1/2 D") became patch byte 2 ("1/32 T").
// --------------------------------------------------------------------

check('delaytimesyncon: "1/2 D" string → NRPN wire 18 (raw index, no scale)', () => {
  const r = resolveNrpnValue(entryFor('delaytimesyncon'), '1/2 D');
  return r.wire === 18 ? true : `got wire=${r.wire}`;
});

check('delaytimesyncon: numeric 18 (index) → NRPN wire 18', () => {
  const r = resolveNrpnValue(entryFor('delaytimesyncon'), 18);
  return r.wire === 18 ? true : `got wire=${r.wire}`;
});

check('delaytimesyncon patch buffer: "1/2 D" lands as raw index 18 at byte 372 (NOT 2)', () => {
  // Pre-Session 50: writePatchValue u16le did wire/8 = 2, device
  // decoded byte 2 as "1/32 T". Post-fix: patchBufferValueFor
  // pre-multiplies by 8 for u16le-enum-without-scale, so wire 18
  // → 144 → /8 → byte 18 = "1/2 D". Locks the founder's session 49
  // bug fix.
  const r = resolveNrpnValue(entryFor('delaytimesyncon'), '1/2 D');
  const buf = encodePatch(new Map([['delaytimesyncon', r.wire]]));
  return buf[372] === 18 && buf[373] === 0
    ? true : `bytes 372=${buf[372]}, 373=${buf[373]}`;
});

check('delaytimesyncon patch buffer: "1/4 D" lands as raw index 15 at byte 372', () => {
  const r = resolveNrpnValue(entryFor('delaytimesyncon'), '1/4 D');
  const buf = encodePatch(new Map([['delaytimesyncon', r.wire]]));
  return buf[372] === 15 ? true : `byte 372=${buf[372]}`;
});

check('delaytimesyncon round-trip: "1/2 D" → encode → decode reads back as 18', () => {
  const r = resolveNrpnValue(entryFor('delaytimesyncon'), '1/2 D');
  const buf = encodePatch(new Map([['delaytimesyncon', r.wire]]));
  const back = readPatchValue(buf, findPatchOffset('delaytimesyncon')!);
  // readPatchValue returns byte * 8 for u16le by convention; the wire-
  // recovery happens in decodePatch via wireValueFromPatchBuffer.
  return back === 18 * 8 ? true : `back=${back}`;
});

// --------------------------------------------------------------------
// LFO_RATES_SYNC_ON — lfo1ratesyncon. wireMax: 26, no enumValueScale.
// Same enum-as-raw-index pattern; verifies the fix generalizes
// beyond delaytimesyncon to env/lfo sync-on params.
// --------------------------------------------------------------------

check('lfo1ratesyncon: "1/4" string → NRPN wire 13 (LFO_RATES_SYNC_ON index)', () => {
  // LFO_RATES_SYNC_ON[13] = "1/4" — a slow ambient wash speed.
  const r = resolveNrpnValue(entryFor('lfo1ratesyncon'), '1/4');
  return r.wire === 13 ? true : `got wire=${r.wire}`;
});

check('lfo1ratesyncon patch buffer: "1/4" lands as raw index 13 at byte 620', () => {
  const r = resolveNrpnValue(entryFor('lfo1ratesyncon'), '1/4');
  const buf = encodePatch(new Map([['lfo1ratesyncon', r.wire]]));
  return buf[620] === 13 ? true : `byte 620=${buf[620]}`;
});

// --------------------------------------------------------------------
// Runner.
// --------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

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
  console.log(`✓ ${passed}/${cases.length} hydrasynth enum-mapping cases pass.`);
} else {
  console.error(`${passed}/${cases.length} pass; ${failed} fail:\n`);
  for (const f of failures) console.error(f);
  process.exit(1);
}
