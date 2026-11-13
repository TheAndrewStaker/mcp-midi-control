/**
 * Golden gate: mod-matrix + macro routes ride the Hydrasynth PATCH IMAGE
 * (BK-HYDRA-DISPLAY-GAPS P7, 2026-08-22).
 *
 * Locks the image encoding established by the 1024-image flash-corpus census:
 *   - source/target fields store LINEAR indices into the edisyn-ordered
 *     MOD_SOURCE_NAMES / MOD_DEST_NAMES arrays (u16le_raw, no /8);
 *   - destination categories are DERIVED into the parallel region;
 *   - depths/buttons ride the standard u16le wire/8 convention (512 = 0.0);
 *   - a newly-assigned macro target defaults its button value to display-0
 *     (image 512), never the INIT buffer's 0 (= -128, the slam-on-press bug).
 *
 * Pipeline-faithful: values resolve through findHydraNrpn +
 * resolveApplyPatchValue exactly as apply_patch's tool layer does (the
 * 2026-08-23 image-first fix: route labels resolve to LINEAR indices, route
 * numerics refuse, FX-type numerics are the raw enum index).
 *
 * Also locks the decode→re-encode IDENTITY over the two field classes the
 * 2026-08-23 review reproduced corruption on (CC-range routes, u8
 * enum-scaled FX types), plus a corpus-wide re-encode identity sweep.
 *
 * Corpus tail: when the (gitignored) backup corpus is present locally, spot
 * checks 32 images for category/target consistency AND byte-identical
 * re-encode; skipped cleanly in CI.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePatch, decodePatch, findPatchOffset, resolveApplyPatchValue } from '../../packages/hydrasynth/src/patchEncoder.js';
import { findHydraNrpn } from '../../packages/hydrasynth/src/nrpn.js';
import {
  MOD_DEST_CATEGORIES,
  modSourceLabelForImageIndex,
  modDestLabelForImageIndex,
} from '../../packages/hydrasynth/src/modRouting.js';
import { framesToPatchBuffer } from '../../packages/hydrasynth/src/patchWrite.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  OK    ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

function wireFor(name: string, value: number | string): number {
  const entry = findHydraNrpn(name);
  if (!entry) throw new Error(`no NRPN entry for ${name}`);
  return resolveApplyPatchValue(entry, value).wire;
}

const u16 = (b: Uint8Array, off: number) => b[off]! | (b[off + 1]! << 8);

// --- The Elm St Bells route set, resolved exactly like the tool layer ------
const overrides = new Map<string, number>([
  ['modmatrix1modsource', wireFor('modmatrix1modsource', 'Env 3')],
  ['modmatrix1modtarget', wireFor('modmatrix1modtarget', 'Mut 1 Depth')],
  ['modmatrix1depth', wireFor('modmatrix1depth', 45)],
  ['modmatrix2modsource', wireFor('modmatrix2modsource', 'Note-On Vel')],
  ['modmatrix2modtarget', wireFor('modmatrix2modtarget', 'Mut 1 Depth')],
  ['modmatrix2depth', wireFor('modmatrix2depth', 25)],
  ['modmatrix3modsource', wireFor('modmatrix3modsource', 'LFO 1')],
  ['modmatrix3modtarget', wireFor('modmatrix3modtarget', 'All Osc Pitch')],
  ['modmatrix3depth', wireFor('modmatrix3depth', 5)],
  ['macro1target1', wireFor('macro1target1', 'Noise Vol')],
  ['macro1depth1', wireFor('macro1depth1', 60)],
  ['macro4target1', wireFor('macro4target1', 'Filt 1 Cutoff')],
  ['macro4depth1', wireFor('macro4depth1', -70)],
]);
const buf = encodePatch(overrides);

console.log('encode: image bytes');
check('matrix 1 source = linear 3 (Env 3)', u16(buf, 902) === 3, `got ${u16(buf, 902)}`);
check('matrix 1 target = linear 21 (Mut 1 Depth)', u16(buf, 966) === 21, `got ${u16(buf, 966)}`);
check('matrix 1 category derived = 6 (Mutant 1)', u16(buf, 1030) === 6, `got ${u16(buf, 1030)}`);
check('matrix 2 source = linear 19 (Note-On Vel)', u16(buf, 904) === 19, `got ${u16(buf, 904)}`);
check('matrix 3 target = linear 19 (All Osc Pitch)', u16(buf, 970) === 19, `got ${u16(buf, 970)}`);
check('matrix 3 category derived = 5 (All Osc)', u16(buf, 1034) === 5, `got ${u16(buf, 1034)}`);
const d1 = u16(buf, 838);
check('matrix 1 depth(+45) image ~ 692 (=(45+128)*4)', Math.abs(d1 - 692) <= 1, `got ${d1}`);
check('macro 1 target 1 = linear 77 (Noise Vol)', u16(buf, 1222) === 77, `got ${u16(buf, 1222)}`);
check('macro 1 category derived = 11 (Mixer)', u16(buf, 1478) === 11, `got ${u16(buf, 1478)}`);
check('macro 1 button defaulted to 512 (display 0)', u16(buf, 1350) === 512, `got ${u16(buf, 1350)}`);
const m4d = u16(buf, 1094 + 16 * 3);
check('macro 4 depth(-70) image ~ 232 (=(-70+128)*4)', Math.abs(m4d - 232) <= 1, `got ${m4d}`);
check('macro 4 category derived = 12 (Filter 1)', u16(buf, 1478 + 16 * 3) === 12, `got ${u16(buf, 1478 + 16 * 3)}`);
check('untouched matrix row 4 stays zero', u16(buf, 908) === 0 && u16(buf, 972) === 0 && u16(buf, 1036) === 0);

console.log('decode: roundtrip');
const decoded = decodePatch(buf);
check('decode matrix 1 source raw = 3', decoded.get('modmatrix1modsource') === 3);
check('decode label roundtrip source', modSourceLabelForImageIndex(decoded.get('modmatrix1modsource')!) === 'Env 3');
check('decode label roundtrip target', modDestLabelForImageIndex(decoded.get('modmatrix1modtarget')!) === 'Mut 1 Depth');
check('decode matrix 1 depth wire = image*8', decoded.get('modmatrix1depth') === d1 * 8);
check('category table agrees with derived byte', MOD_DEST_CATEGORIES[21] === 6);

console.log('explicit overrides + Off');
const buf2 = encodePatch(new Map<string, number>([
  ['modmatrix1modtarget', wireFor('modmatrix1modtarget', 'Off')],
  ['modmatrix1targetcategory', 0],
  ['macro2target3', wireFor('macro2target3', 'Reverb Dry/Wet')],
]));
check('target Off -> linear 0, category 0', u16(buf2, 966) === 0 && u16(buf2, 1030) === 0);
check('macro 2 target 3 = linear 115 (Reverb Dry/Wet)', u16(buf2, 1222 + 16 + 4) === 115, `got ${u16(buf2, 1222 + 16 + 4)}`);
check('macro 2 target 3 category = 17 (Reverb)', u16(buf2, 1478 + 16 + 4) === 17, `got ${u16(buf2, 1478 + 16 + 4)}`);

console.log('offsets registered');
check('modmatrix32targetcategory registered at 1092', findPatchOffset('modmatrix32targetcategory')?.byte === 1092);
check('macro8buttonvalue8 registered at 1476', findPatchOffset('macro8buttonvalue8')?.byte === 1476);
check('macro8targetcategory8 registered at 1604', findPatchOffset('macro8targetcategory8')?.byte === 1604);

// --- CC-range routes + FX types: the 2026-08-23 corruption classes ---------
// Source image 131 = "CC 96" and target image 287 = "CC 85" sit in the
// wire/image collision zones (28 source + 43 dest overlaps); target image
// 256 = "CC 54" collides with wire "Off". Before the image-first fix these
// re-encoded as "Env 3" / "Mut 1 Depth" / route-deleted respectively.
console.log('CC-range routes: label encode + decode→re-encode identity');
const ccOverrides = new Map<string, number>([
  ['modmatrix1modsource', wireFor('modmatrix1modsource', 'CC 96')],
  ['modmatrix1modtarget', wireFor('modmatrix1modtarget', 'CC 85')],
  ['modmatrix1depth', wireFor('modmatrix1depth', 30)],
  ['modmatrix2modsource', wireFor('modmatrix2modsource', 'Mod Wheel')],
  ['modmatrix2modtarget', wireFor('modmatrix2modtarget', 'CC 54')],
  ['prefxtype', wireFor('prefxtype', 'Chorus')],
  ['delaytype', wireFor('delaytype', 3)], // numeric = enum index contract
]);
const ccBuf = encodePatch(ccOverrides);
check('label "CC 96" encodes as source linear 131', u16(ccBuf, 902) === 131, `got ${u16(ccBuf, 902)}`);
check('label "CC 85" encodes as target linear 287', u16(ccBuf, 966) === 287, `got ${u16(ccBuf, 966)}`);
check('label "CC 54" encodes as target linear 256 (not wire-Off 0)', u16(ccBuf, 968) === 256, `got ${u16(ccBuf, 968)}`);
check('"Chorus" encodes as prefxtype byte 1', ccBuf[352] === 1, `got ${ccBuf[352]}`);
check('delaytype numeric 3 encodes as byte 3 (index, not wire/8)', ccBuf[368] === 3, `got ${ccBuf[368]}`);
const ccRe = encodePatch(decodePatch(ccBuf));
check('encodePatch(decodePatch(x)) byte-identical over CC routes + FX types',
  ccRe.length === ccBuf.length && ccRe.every((b, i) => b === ccBuf[i]),
  `first diff at byte ${ccRe.findIndex((b, i) => b !== ccBuf[i])}`);

console.log('numeric route input refuses (wire/image ambiguity)');
for (const [nm, v] of [['modmatrix1modsource', 129], ['modmatrix1modtarget', 287], ['macro1target1', 21]] as const) {
  let threw = false;
  let msg = '';
  try { wireFor(nm, v); } catch (err) { threw = true; msg = err instanceof Error ? err.message : String(err); }
  check(`${nm}: ${v} refuses with label guidance`, threw && /LABEL only/.test(msg), threw ? msg.slice(0, 80) : 'did not throw');
}

// --- Corpus tail (local only; the corpus is gitignored) --------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(HERE, '../../samples/hydrasynth/device-backup-2026-08-10-16-19-27');
if (existsSync(CORPUS)) {
  const files = readdirSync(CORPUS).filter((f) => f.endsWith('.syx')).sort().slice(0, 32);
  let rows = 0, catOk = 0, catBad = 0, reBad = 0;
  for (const f of files) {
    const img = framesToPatchBuffer(new Uint8Array(readFileSync(path.join(CORPUS, f))));
    for (let i = 0; i < 32; i++) {
      const dest = u16(img, 966 + 2 * i);
      if (dest === 0) continue;
      rows++;
      if (u16(img, 1030 + 2 * i) === MOD_DEST_CATEGORIES[dest]) catOk++; else catBad++;
    }
    // Re-encode identity over the fields THIS fix owns (routes, categories,
    // macro slots, FX types + their params so fillFxTypeDefaults doesn't
    // overwrite real bytes): with base=img every other byte carries over, so
    // full-buffer equality proves these fields round-trip on a REAL device
    // image. NOT the full 674-field set: a whole-map sweep exposed that
    // `mutatorNratio` stores raw u16 values beyond the wire÷8 convention
    // (filed as evidence under BK-HYDRA-DISPLAY-GAPS P4 — that field class
    // has its own undeclared space and needs its own derivation).
    const OWNED_RE = /^(modmatrix\d+(depth|modsource|modtarget|targetcategory)|macro\d+(depth|target|buttonvalue|targetcategory)\d+|(pre|post)fxtype|delaytype|reverbtype|(pre|post)fxparam[1-5])$/;
    const owned = new Map([...decodePatch(img)].filter(([k]) => OWNED_RE.test(k)));
    const re = encodePatch(owned, { base: img });
    if (!(re.length === img.length && re.every((b, j) => b === img[j]))) reBad++;
  }
  check(`corpus spot check: category parity on ${rows} active rows across ${files.length} images`, catBad === 0, `${catBad} mismatches`);
  check(`corpus re-encode identity: ${files.length} device images byte-stable`, reBad === 0, `${reBad} images differ after decode→encode`);
} else {
  console.log('  SKIP  corpus spot check (backup corpus not present — CI)');
}

console.log(failures === 0 ? 'verify-mod-matrix-image: all cases pass.' : `verify-mod-matrix-image: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
