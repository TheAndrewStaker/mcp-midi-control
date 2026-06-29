/**
 * Modern Fractal family goldens (codec factory + device-true catalogs).
 *
 * Gates the parts the consumer-repo `verify-fractal-gen3-family.ts` does
 * NOT reach from inside the codec package:
 *   - the codec factory emits the right model byte + checksum for ALL four
 *     model bytes, including VP4 (0x14) which is otherwise ungated;
 *   - the FM3/FM9/VP4 catalogs load and carry DEVICE-TRUE paramIds (not the
 *     III's), with the known spot-checks the integration relies on.
 */
import { createModernFractalCodec, PARAMS_BY_FAMILY, resolveEnumValues, packValue16, AXE_FX_III_BLOCKS } from '../../../src/gen3/axe-fx-iii/index.js';
import {
  FM3_PARAMS,
  FM3_PARAMS_BY_FAMILY,
  FM3_EFFECT_IDS,
  FM3_EFFECT_ID_TABLE,
  FM3_FAMILY_BY_EFFECT_ID,
  fm3EffectId,
} from '../../../src/gen3/fm3/index.js';
import { FM9_PARAMS, FM9_PARAMS_BY_FAMILY, FM9_EFFECT_IDS } from '../../../src/gen3/fm9/index.js';
import { VP4_PARAMS, VP4_PARAMS_BY_FAMILY } from '../../../src/gen3/vp4/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function checksum(bytes: readonly number[]): number {
  let x = 0;
  for (let i = 0; i < bytes.length - 2; i++) x ^= bytes[i];
  return x & 0x7f;
}
function wellFormed(bytes: readonly number[], modelByte: number): boolean {
  return (
    bytes[0] === 0xf0 &&
    bytes[bytes.length - 1] === 0xf7 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x01 &&
    bytes[3] === 0x74 &&
    bytes[4] === modelByte &&
    bytes[bytes.length - 2] === checksum(bytes)
  );
}
function pid(
  pbf: Readonly<Record<string, readonly { name: string; paramId: number }[]>>,
  family: string,
  name: string,
): number | undefined {
  return (pbf[family] ?? []).find((p) => p.name === name)?.paramId;
}

const cases: Array<() => void> = [];

// 1. Codec factory model byte + checksum across ALL four model bytes.
for (const [name, mb] of [
  ['III', 0x10],
  ['FM3', 0x11],
  ['FM9', 0x12],
  ['VP4', 0x14],
] as const) {
  const codec = createModernFractalCodec(mb);
  const frames: Array<[string, number[]]> = [
    ['buildSetParameter', codec.buildSetParameter(66, 2, 100)],
    ['buildSetBypass', codec.buildSetBypass(66, true)],
    ['buildStorePreset', codec.buildStorePreset(5)],
    ['buildSetScene', codec.buildSetScene(0)],
  ];
  for (const [op, frame] of frames) {
    cases.push(() => assert(wellFormed(frame, mb), `${name} ${op}: model 0x${mb.toString(16)} + checksum`));
  }
}

// 1b. buildStorePreset byte-exact against the captured store frames
//     (fn=0x01 sub=0x26, presetNum septet @ bytes 12-13 LSB-first). Fixtures
//     from FM9-Edit (0x12) and AxeEdit III (0x10) driven over loopMIDI; see
//     cookbook gen3-fn01-store-preset. wellFormed above only checks
//     envelope + checksum, so this pins the exact payload of the production
//     builder to the captured truth on both confirmed model bytes.
function parseStoreHex(s: string): number[] {
  return s.trim().split(/\s+/).map((h) => parseInt(h, 16));
}
for (const [label, mb, presetNum, wantHex] of [
  ['III preset 5', 0x10, 5, 'f0 00 01 74 10 01 26 00 00 00 00 00 05 00 00 00 00 00 00 00 00 37 f7'],
  ['FM9 in place (0)', 0x12, 0, 'f0 00 01 74 12 01 26 00 00 00 00 00 00 00 00 00 00 00 00 00 00 30 f7'],
  ['FM9 preset 10', 0x12, 10, 'f0 00 01 74 12 01 26 00 00 00 00 00 0a 00 00 00 00 00 00 00 00 3a f7'],
  ['FM9 preset 5', 0x12, 5, 'f0 00 01 74 12 01 26 00 00 00 00 00 05 00 00 00 00 00 00 00 00 35 f7'],
] as const) {
  const want = parseStoreHex(wantHex);
  const got = createModernFractalCodec(mb).buildStorePreset(presetNum);
  cases.push(() =>
    assert(
      got.length === want.length && got.every((b, i) => b === want[i]),
      `buildStorePreset ${label}: built [${got.map((b) => b.toString(16)).join(' ')}] != captured ${wantHex}`,
    ),
  );
}

// 1c. buildSetGridCell byte-exact against the captured block-INSERT frames
//     (fn=0x01 sub=0x32, effectId septet @8-9, gridPos septet @12-13,
//     gridPos=(col-1)*rows+(row-1)). Fixtures from FM9-Edit (0x12),
//     AxeEdit III (0x10), and FM3-Edit (0x11, 4-row grid) over loopMIDI; see
//     cookbook gen3-fn01-grid-set-position-insert. Pins the production
//     builder's exact payload across all three confirmed model bytes.
for (const [label, mb, row, col, blockId, rows, wantHex] of [
  ['FM9 Amp r1c1', 0x12, 1, 1, 58, 6, 'f0 00 01 74 12 01 32 00 3a 00 00 00 00 00 00 00 00 00 00 00 00 1e f7'],
  ['FM9 Amp r1c2', 0x12, 1, 2, 58, 6, 'f0 00 01 74 12 01 32 00 3a 00 00 00 06 00 00 00 00 00 00 00 00 18 f7'],
  ['FM9 Cab r1c4', 0x12, 1, 4, 62, 6, 'f0 00 01 74 12 01 32 00 3e 00 00 00 12 00 00 00 00 00 00 00 00 08 f7'],
  ['III Amp r1c1', 0x10, 1, 1, 58, 6, 'f0 00 01 74 10 01 32 00 3a 00 00 00 00 00 00 00 00 00 00 00 00 1c f7'],
  ['FM3 Cab r4c12', 0x11, 4, 12, 62, 4, 'f0 00 01 74 11 01 32 00 3e 00 00 00 2f 00 00 00 00 00 00 00 00 36 f7'],
] as const) {
  const want = parseStoreHex(wantHex);
  const got = createModernFractalCodec(mb).buildSetGridCell({ row, col, blockId, rows });
  cases.push(() =>
    assert(
      got.length === want.length && got.every((b, i) => b === want[i]),
      `buildSetGridCell ${label}: built [${got.map((b) => b.toString(16)).join(' ')}] != captured ${wantHex}`,
    ),
  );
}

// 1d. buildRequestEditBufferDump byte-exact (fn=0x43, no args) + the dump-frame
//     predicates. Request confirmed on FM9 (0x12): `f0 00 01 74 12 43 54 f7`.
for (const [label, mb, wantHex] of [
  ['III', 0x10, 'f0 00 01 74 10 43 56 f7'],
  ['FM3', 0x11, 'f0 00 01 74 11 43 57 f7'],
  ['FM9', 0x12, 'f0 00 01 74 12 43 54 f7'],
] as const) {
  const codec = createModernFractalCodec(mb);
  const want = parseStoreHex(wantHex);
  const got = codec.buildRequestEditBufferDump();
  cases.push(() =>
    assert(
      got.length === want.length && got.every((b, i) => b === want[i]),
      `buildRequestEditBufferDump ${label}: built [${got.map((b) => b.toString(16)).join(' ')}] != ${wantHex}`,
    ),
  );
  // Predicates classify head (0x51) vs body (0x52) and reject the request/each other.
  const head = parseStoreHex(`f0 00 01 74 ${mb.toString(16)} 51 00 00 04 00 f7`);
  const body = parseStoreHex(`f0 00 01 74 ${mb.toString(16)} 52 00 08 00 00 00 f7`);
  cases.push(() => assert(codec.isEditBufferDumpHead(head), `${label} head predicate`));
  cases.push(() => assert(codec.isEditBufferDumpBody(body), `${label} body predicate`));
  cases.push(() => assert(!codec.isEditBufferDumpHead(body), `${label} head predicate rejects body`));
  cases.push(() => assert(!codec.isEditBufferDumpBody(got), `${label} body predicate rejects request`));
}

// 2. Device-true paramIds (delay.time diverges per device; III=2).
cases.push(() => assert(pid(PARAMS_BY_FAMILY, 'DELAY', 'DELAY_TIME') === 2, 'III DELAY_TIME=2'));
cases.push(() => assert(pid(FM3_PARAMS_BY_FAMILY, 'DELAY', 'DELAY_TIME') === 8, 'FM3 DELAY_TIME=8 (device-true, not III 2)'));
cases.push(() => assert(pid(FM9_PARAMS_BY_FAMILY, 'DELAY', 'DELAY_TIME') === 12, 'FM9 DELAY_TIME=12 (device-true, not III 2)'));

// 3. Effect-type selector recovered (was dropped by the XML-only base).
cases.push(() => assert(pid(FM3_PARAMS_BY_FAMILY, 'REVERB', 'REVERB_TYPE') !== undefined, 'FM3 REVERB_TYPE present'));

// 4. No phantom 'OLD' family; legacy flanger lives under FLANGER.
cases.push(() => assert(!('OLD' in FM3_PARAMS_BY_FAMILY), 'FM3 has no phantom OLD family'));
cases.push(() =>
  assert(
    (FM3_PARAMS_BY_FAMILY['FLANGER'] ?? []).some((p) => p.name.startsWith('OLD_FLANGER_')),
    'FM3 OLD_FLANGER_* mapped under FLANGER',
  ),
);

// 5. Catalog sizes are sane (a near-empty catalog = load failure).
cases.push(() => assert(FM3_PARAMS.length > 1500, `FM3 catalog size ${FM3_PARAMS.length}`));
cases.push(() => assert(FM9_PARAMS.length > 1500, `FM9 catalog size ${FM9_PARAMS.length}`));
cases.push(() => assert(VP4_PARAMS.length > 1000, `VP4 catalog size ${VP4_PARAMS.length}`));

// 6. Catalogs diverge from the III on shared symbols (proves NOT III-reuse).
function divergence(pbf: Readonly<Record<string, readonly { name: string; paramId: number }[]>>): number {
  let diff = 0;
  for (const fam of Object.keys(pbf)) {
    const iii = PARAMS_BY_FAMILY[fam];
    if (!iii) continue;
    const byName = new Map(iii.map((p) => [p.name, p.paramId]));
    for (const p of pbf[fam]) {
      if (byName.has(p.name) && byName.get(p.name) !== p.paramId) diff++;
    }
  }
  return diff;
}
cases.push(() => assert(divergence(FM3_PARAMS_BY_FAMILY) >= 50, 'FM3 diverges from III on >=50 paramIds'));
cases.push(() => assert(divergence(FM9_PARAMS_BY_FAMILY) >= 100, 'FM9 diverges from III on >=100 paramIds'));
cases.push(() => assert(divergence(VP4_PARAMS_BY_FAMILY) >= 500, 'VP4 diverges from III on >=500 paramIds'));

// 7. Gen-3 read-leg enum overlay (BK-093): effect-type ordinals join to
//    AM4's verified tables. REVERB_TYPE is byte-anchored (FM9 2026-06-03
//    capture: broadcast ordinal 16 == 'Spring, Medium', ordinal 1 ==
//    'Room, Medium'); the rest are reused by family.
cases.push(() => {
  const rev = resolveEnumValues('REVERB_TYPE');
  assert(rev !== undefined, 'REVERB_TYPE overlay present');
  assert(rev!.values[16] === 'Spring, Medium', `REVERB_TYPE ord 16 = ${rev!.values[16]} (byte-anchor)`);
  assert(rev!.values[1] === 'Room, Medium', `REVERB_TYPE ord 1 = ${rev!.values[1]} (byte-anchor)`);
});
cases.push(() => assert(resolveEnumValues('DELAY_TYPE') !== undefined, 'DELAY_TYPE overlay present'));
// DISTORT_TYPE deliberately has NO overlay: on gen-3 the DISTORT family is
// the AMP block, so DISTORT_TYPE is the amp MODEL selector, not a drive-pedal
// picker. The AM4 DRIVE table is not a valid ordinal oracle for gen-3 amp
// models, so it ships UNLABELED (numeric passthrough) to avoid fabricated names.
cases.push(() => assert(resolveEnumValues('DISTORT_TYPE') === undefined, 'DISTORT_TYPE has NO overlay (amp model selector ships unlabeled)'));
cases.push(() => assert(resolveEnumValues('PHASER_TYPE') !== undefined, 'PHASER_TYPE overlay present'));
// A non-enum numeric param must NOT pick up an enum table.
cases.push(() => assert(resolveEnumValues('REVERB_TIME') === undefined, 'REVERB_TIME has no enum overlay'));

// 8. Gen-3 fn=0x1F block bulk-read (S2): poll builder + positional assembler.
//    Mirrors the Axe-Fx II atomic-read; byte-confirmed on FM9 (2026-06-03).
function mkBroadcastFrame(model: number, fn: number, payload: number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  return [...body, checksum([...body, 0, 0]), 0xf7];
}
cases.push(() => {
  const codec = createModernFractalCodec(0x12); // FM9
  // Poll: 10-byte fn=0x1F frame carrying the effectId septet-LE.
  const poll = codec.buildBlockBulkReadPoll(66);
  assert(wellFormed(poll, 0x12), 'FM9 bulk-read poll well-formed');
  assert(poll[5] === 0x1f && poll[6] === 66 && poll[7] === 0, 'poll is fn=0x1F effectId 66');
});
cases.push(() => {
  const codec = createModernFractalCodec(0x12);
  // Two paged 0x75 sections (4 + 2 = 6 values) concatenate positionally so
  // record index i == paramId i across the page boundary. record[5] = 524.
  const head = mkBroadcastFrame(0x12, 0x74, [66, 0, 6, 0, 0x07]);
  const body0 = mkBroadcastFrame(0x12, 0x75, [0x00, 0x02,
    ...packValue16(10), ...packValue16(20), ...packValue16(30), ...packValue16(40)]);
  const body1 = mkBroadcastFrame(0x12, 0x75, [0x01, 0x02,
    ...packValue16(50), ...packValue16(524)]);
  const end = mkBroadcastFrame(0x12, 0x76, []);
  const got = codec.assembleGen3BlockBulkRead([head, body0, body1, end]);
  assert(got.blockId === 66, `bulk-read blockId ${got.blockId}`);
  assert(got.itemCount === 6, `bulk-read itemCount ${got.itemCount}`);
  assert(JSON.stringify(got.values) === JSON.stringify([10, 20, 30, 40, 50, 524]),
    `positional values ${JSON.stringify(got.values)}`);
});
cases.push(() => {
  const codec = createModernFractalCodec(0x12);
  // A burst with no head must throw (we never invent a blockId).
  let threw = false;
  try { codec.assembleGen3BlockBulkRead([mkBroadcastFrame(0x12, 0x75, [0, 2, ...packValue16(1)])]); }
  catch { threw = true; }
  assert(threw, 'assemble throws when the 0x74 head is missing');
});

// 9. Gen-3 fn=0x03 REQUEST_PRESET_DUMP: big-endian preset number + trailing 0x00.
//    Byte-confirmed on FM9 (2026-06-04 "receive preset from device" capture):
//    request `f0 00 01 74 12 03 [hi] [lo] 00 [cs] f7`, preset# big-endian septet.
cases.push(() => {
  const codec = createModernFractalCodec(0x12); // FM9
  // Captured request for preset 49: f0 00 01 74 12 03 00 31 00 25 f7.
  const req = codec.buildRequestPresetDump(49);
  assert(wellFormed(req, 0x12), 'FM9 preset-dump request well-formed');
  assert(req.length === 11, `request is 11 bytes (got ${req.length})`);
  assert(req[5] === 0x03, 'fn=0x03');
  // Big-endian: preset 49 = high 0, low 49; trailing 0x00.
  assert(req[6] === 0 && req[7] === 49 && req[8] === 0, 'preset 49 BE [0,49,0]');
  // Preset 444 = (3<<7)|60: high 3, low 60 (LE misread would be 7683).
  const req444 = codec.buildRequestPresetDump(444);
  assert(req444[6] === 3 && req444[7] === 60, 'preset 444 BE [3,60]');
  // Exact captured bytes for preset 49 (checksum 0x25).
  const want49 = [0xf0, 0x00, 0x01, 0x74, 0x12, 0x03, 0x00, 0x31, 0x00, 0x25, 0xf7];
  assert(JSON.stringify(req) === JSON.stringify(want49), `preset 49 bytes ${req.map((b) => b.toString(16)).join(' ')}`);
});
cases.push(() => {
  const codec = createModernFractalCodec(0x10); // III, same builder, different model byte
  let threw = false;
  try { codec.buildRequestPresetDump(-1); } catch { threw = true; }
  assert(threw, 'request rejects out-of-range preset number');
});

// 10. FM3/FM9 effectId ↔ family map. The (effectId, paramId) addressing layer:
//     every family that has a wire effectId must (a) be a real param family
//     in the catalog, (b) bind to the same firstId the shared gen-3 roster
//     (AXE_FX_III_BLOCKS) uses, and (c) carry the known DISTORT=Amp / FUZZ=Drive
//     anomaly + the virtual-block effectIds (FC=199, Controllers=2, ScnMIDI=190).
{
  // Spot-checks pinned to the FM3 editor instance-table cross-validation.
  const spot: Array<[string, number | null]> = [
    ['DISTORT', 58],   // Amp block (no ID_AMP in the gen-3 enum)
    ['FUZZ', 118],     // Drive / OD / Fuzz pedal block
    ['CABINET', 62], ['REVERB', 66], ['DELAY', 70], ['COMP', 46],
    ['INPUT', 37], ['OUTPUT', 42], ['VOLUME', 102], ['TREMOLO', 106],
    ['GATE', 146], ['MULTICOMP', 154], ['MULTITAP', 74], ['PLEX', 178],
    ['TENTAP', 158], ['FDBKSEND', 182], ['FDBKRET', 186], ['MULTIPLEXER', 191],
    ['IRPLAYER', 195],
    // virtual / system blocks
    ['CONTROLLERS', 2],   // ID_CONTROL
    ['MIDIBLOCK', 190],   // Scene MIDI
    ['FC', 199],          // Foot Controller
    ['IRCAPTURE', 36],
    // Param-addressable virtuals confirmed from the device:
    // GLOBAL=1 (Power-Amp-Modeling wrote eid 1/pid 4), Modifier=3.
    ['GLOBAL', 1], ['MOD', 3],
    // no wire effectId of their own
    ['PRESET', null],
  ];
  for (const [family, want] of spot) {
    cases.push(() =>
      assert(
        FM3_EFFECT_IDS[family] === want,
        `FM3_EFFECT_IDS.${family} = ${FM3_EFFECT_IDS[family]} (want ${want})`,
      ),
    );
    // FM9 mirrors FM3 (shared gen-3 roster + identical family set).
    cases.push(() =>
      assert(
        FM9_EFFECT_IDS[family] === want,
        `FM9_EFFECT_IDS.${family} = ${FM9_EFFECT_IDS[family]} (want ${want})`,
      ),
    );
  }
  // Every effectId-bearing family is a real catalog family.
  for (const e of FM3_EFFECT_ID_TABLE) {
    cases.push(() =>
      assert(
        Array.isArray(FM3_PARAMS_BY_FAMILY[e.family]) && FM3_PARAMS_BY_FAMILY[e.family].length > 0,
        `FM3_EFFECT_ID_TABLE family ${e.family} has no params in FM3_PARAMS_BY_FAMILY`,
      ),
    );
  }
  // Every block-addressing family's firstId is present in the shared gen-3
  // roster (firstId is the device-independent key across III/FM3/FM9).
  const iiiFirstIds = new Set(AXE_FX_III_BLOCKS.map((b) => b.firstId).filter((x) => x !== null));
  for (const e of FM3_EFFECT_ID_TABLE) {
    if (e.addressing === 'block' && e.firstId !== null) {
      cases.push(() =>
        assert(
          iiiFirstIds.has(e.firstId),
          `FM3 block ${e.family} firstId ${e.firstId} not present in AXE_FX_III_BLOCKS roster`,
        ),
      );
    }
  }
  // Resolver: instance math + range guard.
  cases.push(() => assert(fm3EffectId('DISTORT', 1) === 58, 'fm3EffectId DISTORT inst1 = 58'));
  cases.push(() => assert(fm3EffectId('DISTORT', 4) === 61, 'fm3EffectId DISTORT inst4 = 61'));
  cases.push(() => assert(fm3EffectId('DISTORT', 5) === null, 'fm3EffectId DISTORT inst5 out of range → null'));
  cases.push(() => assert(fm3EffectId('FC', 1) === 199, 'fm3EffectId FC = 199'));
  cases.push(() => assert(fm3EffectId('GLOBAL') === 1, 'fm3EffectId GLOBAL = 1 (device-confirmed)'));
  cases.push(() => assert(FM3_FAMILY_BY_EFFECT_ID[58] === 'DISTORT', 'reverse lookup 58 → DISTORT'));
  cases.push(() => assert(FM3_FAMILY_BY_EFFECT_ID[199] === 'FC', 'reverse lookup 199 → FC'));
}

export function runModernFamilyTests(): void {
  for (const c of cases) c();
}
export const MODERN_FAMILY_CASE_COUNT = cases.length;
