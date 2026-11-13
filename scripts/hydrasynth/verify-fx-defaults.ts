/**
 * FX-type default-fill gate (Hydrasynth).
 *
 * Codifies — deterministically, not as tool-description prose — the rule
 * that selecting a pre/post FX TYPE without its `param1..5` must load
 * that type's defaults, never reinterpret the base buffer's bytes under
 * the new type. (Tool-description guidance to "always set FX params" was
 * present and ignored by the recipe-curation workflow on all 34 recipes;
 * EQ/Compressor without params silenced patches. The fix is in the codec
 * — `encodePatch` auto-fills `FX_TYPE_DEFAULTS` — and this gate enforces
 * it for every FX type, for any caller.)
 *
 * Deterministic, hardware-free:
 *   GATE A — for each FX type (1..9), pre AND post: encode a patch that
 *     sets ONLY that fxtype, decode it, and assert every param1..5 equals
 *     the type's default (quantized to the patch buffer's /8 grid). A
 *     regression that drops the auto-fill leaves INIT/Bypass bytes and
 *     fails here.
 *   GATE B — partial provision: caller-set params survive, only the
 *     UNSET ones get defaulted.
 *   GATE C — Bypass (type 0) fills nothing (params stay at base).
 */
import {
  FX_TYPE_DEFAULTS,
  encodePatch,
  decodePatch,
  defaultPatchBuffer,
  resolveApplyPatchValue,
} from '@mcp-midi-control/hydrasynth/patchEncoder.js';
import { findHydraNrpn } from '@mcp-midi-control/hydrasynth/nrpn.js';
import { HYDRASYNTH_ENUMS } from '@mcp-midi-control/hydrasynth/enums.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) { console.log(`  OK    ${label}`); }
  else { failed++; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

const FX_TYPES = HYDRASYNTH_ENUMS['FX_TYPES'] as Record<number, string>;
/** Patch buffer stores wire/8, so a wire default round-trips to this. */
const grid = (wire: number) => Math.round(wire / 8) * 8;

// FX-type selectors are `space: 'image-index'` fields since the 2026-08-23
// image-first fix: the encodePatch value is the raw enum INDEX, resolved by
// the image-pipeline resolver (not resolveNrpnValue, whose idx×8 output is
// the NRPN wire).
function typeWire(surface: 'pre' | 'post', idx: number): number {
  const entry = findHydraNrpn(`${surface}fxtype`)!;
  return resolveApplyPatchValue(entry, FX_TYPES[idx]!).wire;
}

console.log('[fx-defaults] GATE A — type-without-params loads the type defaults');
for (let idx = 1; idx <= 9; idx++) {
  for (const surface of ['pre', 'post'] as const) {
    const overrides = new Map<string, number>([[`${surface}fxtype`, typeWire(surface, idx)]]);
    const dec = decodePatch(encodePatch(overrides));
    const defs = FX_TYPE_DEFAULTS[idx]!;
    let bad = '';
    for (let n = 1; n <= 5; n++) {
      const got = dec.get(`${surface}fxparam${n}`)!;
      const want = grid(defs[n - 1]!);
      if (got !== want) { bad = `param${n}: got ${got}, want ${want}`; break; }
    }
    check(`${surface} ${FX_TYPES[idx]} (idx ${idx}) fills default param1..5`, bad === '', bad);
  }
}

console.log('\n[fx-defaults] GATE B — caller params survive; only unset ones default');
{
  // EQ (idx 7) with a custom param1; param2..5 should default.
  const eqWire = typeWire('pre', 7);
  const customP1 = grid(1234);
  const overrides = new Map<string, number>([
    ['prefxtype', eqWire],
    ['prefxparam1', customP1],
  ]);
  const dec = decodePatch(encodePatch(overrides));
  check('prefxparam1 keeps caller value (not defaulted)', dec.get('prefxparam1') === customP1,
    `got ${dec.get('prefxparam1')}, want ${customP1}`);
  check('prefxparam2 is defaulted', dec.get('prefxparam2') === grid(FX_TYPE_DEFAULTS[7]![1]!),
    `got ${dec.get('prefxparam2')}`);
}

console.log('\n[fx-defaults] GATE C — Bypass fills nothing (params stay at base)');
{
  const initDec = decodePatch(defaultPatchBuffer());
  const overrides = new Map<string, number>([['prefxtype', typeWire('pre', 0)]]);
  const dec = decodePatch(encodePatch(overrides));
  let same = true;
  for (let n = 1; n <= 5; n++) {
    if (dec.get(`prefxparam${n}`) !== initDec.get(`prefxparam${n}`)) { same = false; break; }
  }
  check('Bypass leaves prefxparam1..5 at INIT baseline', same);
}

console.log('');
if (failed > 0) {
  console.error(`x verify-fx-defaults: ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('OK verify-fx-defaults: every FX type auto-fills audible default params.');
