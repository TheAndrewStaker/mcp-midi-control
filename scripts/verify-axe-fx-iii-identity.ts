/**
 * Axe-Fx III byte-identity gate.
 *
 * The III catalog is the byte-identity ANCHOR of the modern Fractal
 * family: folding it into the `createModernFractalCodec` /
 * `createModernCatalog` factory must NOT change a single block, param key,
 * firmware symbol, unit, or paramId the III exposes. The pre-factory
 * `packages/fractal-gen3` descriptor was deleted in the migration, so there
 * is no module to diff against. This gate freezes the III's surface as a
 * committed snapshot (counts + sha256 of a canonical dump) and fails if
 * the factory-built `AXEFX3_DESCRIPTOR` or the III catalog drifts.
 *
 * Three independent snapshots:
 *   1. CATALOG   — every (family, name, paramId) in PARAMS_BY_FAMILY. Pins
 *                  the wire-addressing identity (a changed/dropped paramId
 *                  fails here).
 *   2. SURFACE   — every (blockSlug, paramKey, parameter_name, unit) in
 *                  AXEFX3_DESCRIPTOR.blocks. Pins the describe_device
 *                  surface the agent sees (a renamed block / dropped param
 *                  / changed unit fails here).
 *   3. BLOCKS    — every (name, groupCode, firstId, instances) in
 *                  AXE_FX_III_BLOCKS. Pins the block roster + effect IDs.
 *
 * To re-bless after an INTENTIONAL III change: run with `--update`, paste
 * the printed constants below, and explain the change in the commit.
 *
 * Run:  npx tsx scripts/verify-axe-fx-iii-identity.ts [--update]
 */
import { createHash } from 'node:crypto';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import { PARAMS_BY_FAMILY, AXE_FX_III_BLOCKS } from 'fractal-midi/gen3/axe-fx-iii';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// ── 1. CATALOG: (family, name, paramId) ────────────────────────────
const catalogRows: string[] = [];
for (const family of Object.keys(PARAMS_BY_FAMILY).sort()) {
  for (const p of PARAMS_BY_FAMILY[family]) {
    catalogRows.push(`${family}|${p.name}|${p.paramId}`);
  }
}
catalogRows.sort();
const catalog = { count: catalogRows.length, hash: sha256(catalogRows.join('\n')) };

// ── 2. SURFACE: (slug, key, parameter_name, unit) ──────────────────
const surfaceRows: string[] = [];
let surfaceParamCount = 0;
for (const slug of Object.keys(AXEFX3_DESCRIPTOR.blocks).sort()) {
  const b = AXEFX3_DESCRIPTOR.blocks[slug];
  for (const key of Object.keys(b.params).sort()) {
    const p = b.params[key];
    surfaceRows.push(`${slug}|${key}|${p.parameter_name ?? ''}|${p.unit ?? ''}`);
    surfaceParamCount++;
  }
}
surfaceRows.sort();
const surface = {
  blockCount: Object.keys(AXEFX3_DESCRIPTOR.blocks).length,
  paramCount: surfaceParamCount,
  hash: sha256(surfaceRows.join('\n')),
};

// ── 3. BLOCKS: (name, groupCode, firstId, instances) ───────────────
const blockRows = AXE_FX_III_BLOCKS.map(
  (b) => `${b.name}|${b.groupCode}|${b.firstId}|${b.instances}`,
).sort();
const blocks = { count: blockRows.length, hash: sha256(blockRows.join('\n')) };

// ── Expected snapshot (committed). `--update` prints fresh values. ──
const EXPECTED = {
  // Re-blessed for the gen-3 AMP unlock: ID_DISTORT1=58 relabeled Drive→Amp
  // (slug drive→amp), ID_FUZZ1=118 relabeled Fuzz→Drive (slug fuzz→drive),
  // and the phantom firstId:null Amp row removed (block count 51→50).
  // CATALOG (family,name,paramId) is unchanged (no param mining); only the
  // describe_device SURFACE slugs/names and the BLOCKS roster changed.
  //
  // Re-blessed AGAIN for the roundtrip-derived discrete-ordinal overlay
  // (III_ROUNDTRIP_DISCRETE): ~92 III type/model/mode/count params the
  // editor-cache enum path missed are now classified `unit: 'enum'` (and routed
  // DISCRETE) because the device's own full roundtrip sweep proved it quantizes
  // a continuous SET to a small ordinal. CATALOG (family,name,paramId) and
  // BLOCKS are UNCHANGED — only the SURFACE `unit` field flips for those params.
  // WIRE byte-identity is intact: no wire builder was touched, a discrete SET
  // still emits sub=0x09 float32(ordinal). Only paramCount stays 1711 (no params
  // added/removed); the hash changes solely from the unit reclassification.
  //
  // Re-blessed AGAIN for the signed-raw-semitone fix (issue #6, 2026-07-21):
  // PITCH_SHIFT1-4/PITCH_STEP1-16/PLEX_SHIFT1-8/SYNTH_SHIFT1-3 (31 params) were
  // `unit: 'numeric'` with no display range (raw-wire passthrough); backfilled
  // to `unit: 'semitones', displayMin: -24, displayMax: 24` from the same
  // hardware-anchored range REVERB_SHIFT1/2 already carried, so their catalog
  // decode routes through the new signed-int16 read path (catalog.ts
  // SIGNED_RAW_SEMITONE_PARAMS) instead of the wrong-sign standard linear
  // decode. CATALOG (family,name,paramId) and BLOCKS are UNCHANGED (no params
  // added/removed) — only the SURFACE `unit` field changes for those 31 params.
  // WIRE byte-identity is intact: SET still emits the standard normalized
  // continuous form (sub=0x52, float32(normalized)); only READ decode changed.
  catalog: { count: 2216, hash: '109f858e07b904de65b8782edb41383d746844b0dce309ffd6628fabd2d30223' },
  surface: { blockCount: 50, paramCount: 1711, hash: '8576a2c86284c4306ed2c8de09f9f0959cfdeec6880c2aca09685e20ea33b954' },
  blocks: { count: 50, hash: '07db286053f0f4bd242e14c45697f5bbc612f642c5c7f6c7fdd9dd0e9dd7dd51' },
};

if (process.argv.includes('--update')) {
  console.log('Paste these into EXPECTED:');
  console.log(JSON.stringify({ catalog, surface, blocks }, null, 2));
  process.exit(0);
}

let failures = 0;
function cmp(label: string, got: Record<string, unknown>, want: Record<string, unknown>): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    console.log(`  ✓ ${label}  (${JSON.stringify(got)})`);
  } else {
    failures++;
    console.log(`  ✗ ${label}`);
    console.log(`      got : ${JSON.stringify(got)}`);
    console.log(`      want: ${JSON.stringify(want)}`);
  }
}

console.log('Axe-Fx III byte-identity (catalog + describe_device surface frozen):');
cmp('CATALOG (family,name,paramId)', catalog, EXPECTED.catalog);
cmp('SURFACE (slug,key,parameter_name,unit)', surface, EXPECTED.surface);
cmp('BLOCKS (name,groupCode,firstId,instances)', blocks, EXPECTED.blocks);

if (failures > 0) {
  console.error(
    `\nFAIL — the Axe-Fx III surface drifted. The III is the byte-identity anchor and must stay ` +
      `exactly as-is. If this change is INTENTIONAL, re-run with --update and bless the new snapshot ` +
      `in the commit; otherwise revert the change that touched the III catalog/blocks or the factory.`,
  );
  process.exit(1);
}
console.log('\nAxe-Fx III identity intact.');
