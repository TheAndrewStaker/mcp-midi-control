/**
 * Verify the modern Fractal family factory (Axe-Fx III / FM3 / FM9).
 *
 * No hardware. Guards the two things the family factory must get right:
 *   1. Each device emits ITS OWN model byte on every wire builder
 *      (III 0x10, FM3 0x11, FM9 0x12) — the core promise of the
 *      model-byte-parameterized codec. A regression here would send FM3
 *      frames with the III's model byte (silently ignored by the FM3).
 *   2. Each descriptor advertises the right shape + support_tier, and its
 *      example_spec fits its grid (FM3 is 4×4, not 4×14).
 *
 * Run:  npx tsx scripts/verify-fractal-gen3-family.ts
 */

import {
  AXEFX3_DESCRIPTOR,
  FM3_DESCRIPTOR,
  FM9_DESCRIPTOR,
  VP4_DESCRIPTOR,
  MODERN_FRACTAL_DESCRIPTORS,
} from '@mcp-midi-control/fractal-gen3/device.js';
import {
  encode16to3,
  huffmanCompress,
  computeRawPatchCrc,
} from '@mcp-midi-control/fractal-gen3/presetHuffman.js';
import {
  createModernFractalCodec,
  resolveEffectId,
  packValue16,
  PARAMS_BY_FAMILY,
  resolveGen3EnumOrdinal,
  encode5SeptetFloat32,
  decode5SeptetFloat32,
  type Param,
} from 'fractal-midi/gen3/axe-fx-iii';
import { mockConnect } from '@mcp-midi-control/core/midi/transport.js';
import { makeGen3BroadcastMockResponder } from '@mcp-midi-control/fractal-gen3/parityMock.js';
import { FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import { FM9_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm9';
import {
  VP4_PARAMS_BY_FAMILY,
  buildVp4GetStructureBlob,
  parseVp4StructureBlob,
} from 'fractal-midi/gen3/vp4';
import type { DeviceDescriptor } from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { encodeValue } from '@mcp-midi-control/core/protocol-generic/dispatcher/resolvers.js';
import { assertInstanceSupported } from '@mcp-midi-control/core/protocol-generic/dispatcher/core.js';
import {
  clearRegistry,
  registerDevice,
  resolveDevice,
} from '@mcp-midi-control/core/protocol-generic/registry.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { markDirty, markClean } from '@mcp-midi-control/core/server-shared/bufferDirty.js';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

function fractalChecksum(bytes: readonly number[]): number {
  // XOR of F0 through the last payload byte (everything except checksum + F7).
  let x = 0;
  for (let i = 0; i < bytes.length - 2; i++) x ^= bytes[i];
  return x & 0x7f;
}

function frameIsWellFormed(bytes: readonly number[], modelByte: number): { ok: boolean; why?: string } {
  if (bytes[0] !== 0xf0) return { ok: false, why: 'no F0 start' };
  if (bytes[bytes.length - 1] !== 0xf7) return { ok: false, why: 'no F7 end' };
  if (!(bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x74)) return { ok: false, why: 'bad Fractal prefix' };
  if (bytes[4] !== modelByte) return { ok: false, why: `model byte ${bytes[4].toString(16)} ≠ ${modelByte.toString(16)}` };
  const expectedCs = fractalChecksum(bytes);
  if (bytes[bytes.length - 2] !== expectedCs) return { ok: false, why: 'checksum mismatch' };
  return { ok: true };
}

// ── 1. Codec model-byte goldens (direct) ───────────────────────────
console.log('Codec emits the correct model byte per device:');
for (const { name, modelByte } of [
  { name: 'Axe-Fx III', modelByte: 0x10 },
  { name: 'FM3', modelByte: 0x11 },
  { name: 'FM9', modelByte: 0x12 },
  { name: 'VP4', modelByte: 0x14 },
]) {
  const codec = createModernFractalCodec(modelByte);
  for (const [op, frame] of [
    ['buildSetScene(0)', codec.buildSetScene(0)],
    ['buildSetParameter(66,0,100)', codec.buildSetParameter(66, 0, 100)],
    ['buildSetBypass(66,true)', codec.buildSetBypass(66, true)],
    ['buildStorePreset(5)', codec.buildStorePreset(5)],
  ] as const) {
    const r = frameIsWellFormed(frame, modelByte);
    check(`${name} ${op} → model 0x${modelByte.toString(16)} + valid checksum`, r.ok, r.why);
  }
}

// ── 2. Descriptor wire routing (full chain: catalog resolve → codec) ─
console.log('\nDescriptor writer.buildSetParam routes through the right model byte:');
for (const { desc, modelByte } of [
  { desc: AXEFX3_DESCRIPTOR, modelByte: 0x10 },
  { desc: FM3_DESCRIPTOR, modelByte: 0x11 },
  { desc: FM9_DESCRIPTOR, modelByte: 0x12 },
]) {
  const frame = desc.writer.buildSetParam!('reverb', 'type', 100);
  const r = frameIsWellFormed(frame, modelByte);
  check(`${desc.id} set_param(reverb.type) → model 0x${modelByte.toString(16)}`, r.ok, r.why);
}

// ── 2a2. Reverb-type set-by-name (write leg, capture-backed) ────────
//
// The gen-3 reverb TYPE set value = the read-roster ORDINAL (a discrete SET
// sends float32(ordinal) @ pos 12, 2026-06-08). EVERY type sets by name with no
// capture — encode resolves a name to the same ordinal decode labels with. No
// raw-id space; the old 524/529 were float32(ordinal) misread at pos 15. Read
// (decode ordinal→label) is unchanged. Shared across III/FM3/FM9 (one codec).
console.log('\nReverb-type set-by-name (read-roster ordinal = the float32 set value):');
for (const desc of [AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR]) {
  const schema = desc.blocks['reverb']?.params['type'];
  check(
    `${desc.id} reverb.type wire_kind = discrete`,
    schema?.wire_kind === 'discrete',
    `wire_kind: ${schema?.wire_kind}`,
  );
  check(
    `${desc.id} set reverb.type "Spring, Medium" → ordinal 16`,
    encodeValue(desc, 'reverb', 'type', 'Spring, Medium') === 16,
  );
  check(
    `${desc.id} set reverb.type "Hall, Music" → ordinal 45`,
    encodeValue(desc, 'reverb', 'type', 'Hall, Music') === 45,
  );
  check(
    `${desc.id} set reverb.type "spring, medium" (case/space tolerant) → 16`,
    encodeValue(desc, 'reverb', 'type', 'spring, medium') === 16,
  );
  // AM4 arrays use "Category, Modifier" order; accept the natural reversed phrasing too.
  check(
    `${desc.id} set reverb.type "Medium Spring" (reversed order) → 16`,
    encodeValue(desc, 'reverb', 'type', 'Medium Spring') === 16,
  );
  check(
    `${desc.id} set reverb.type "Music Hall" (reversed order) → 45`,
    encodeValue(desc, 'reverb', 'type', 'Music Hall') === 45,
  );
  // Previously "capture-blocked": now sets by name like every other type.
  check(
    `${desc.id} set reverb.type "Room, Small" → ordinal 0 (was capture-blocked, now resolves)`,
    encodeValue(desc, 'reverb', 'type', 'Room, Small') === 0,
  );
  check(
    `${desc.id} set reverb.type 16 (numeric ordinal passthrough) → 16`,
    encodeValue(desc, 'reverb', 'type', 16) === 16,
  );
  // FM9 has a device-true reverb roster (cache-mined): adjective-first labels.
  // III/FM3 still borrow AM4 REVERB_TYPES noun-first names until their own caches.
  const expRev16 = desc.id === 'fm9' ? 'Medium Spring' : 'Spring, Medium';
  check(
    `${desc.id} reverb.type decode(16) → "${expRev16}" (read leg intact)`,
    schema?.decode(16) === expRev16,
  );
}

// ── 2a-bis. FM9 device-true amp model names (per-device enum override) ──
//
// The amp roster (DISTORT_TYPE) is device-specific, so the family-shared
// overlay leaves it numeric. FM9 binds a PARTIAL device-true table captured
// from hardware (read-leg ordinals: 264=SV Bass 1, 65=SV Bass 2, 179=Texas
// Star Clean). Decode labels those ordinals, passes unknown ones through as
// numbers, and never leaks onto III/FM3 (whose amp rosters differ). The ordinal
// IS the discrete-SET value, so these set by name too (float32(ordinal)).
console.log('\nFM9 amp model names (per-device enum override, partial):');
{
  const ampSchema = FM9_DESCRIPTOR.blocks['amp']?.params['type'];
  check('FM9 amp.type schema exists', ampSchema !== undefined, `blocks.amp.params.type missing`);
  check('FM9 amp.type decode(264) → "SV Bass 1"', ampSchema?.decode(264) === 'SV Bass 1', `got ${ampSchema?.decode(264)}`);
  check('FM9 amp.type decode(65) → "SV Bass 2"', ampSchema?.decode(65) === 'SV Bass 2', `got ${ampSchema?.decode(65)}`);
  check('FM9 amp.type decode(179) → "Texas Star Clean"', ampSchema?.decode(179) === 'Texas Star Clean', `got ${ampSchema?.decode(179)}`);
  check('FM9 amp.type decode(9999) → 9999 (unknown ordinal passes through, partial table)', ampSchema?.decode(9999) === 9999, `got ${ampSchema?.decode(9999)}`);
  // P1: the shared gen-3 read roster names amps on ALL of III/FM3/FM9. The
  // amp model ordinal space is family-wide (one effect codec): every shared
  // ordinal agrees across III/FM3/FM9, and the factory-correlated base is now
  // unioned with the device-true FM9 cache roster (== Fractal wiki), so the
  // formerly-unnamed ordinals (e.g. 65="SV Bass 2") name on III/FM3 too. These
  // additions are evidence-strong (device cache + wiki agree) but untested on
  // III/FM3 hardware — community-beta, like the rest of the gen-3 amp roster.
  const iiiAmp = AXEFX3_DESCRIPTOR.blocks['amp']?.params['type'];
  check('III amp.type decode(264) → "SV Bass 1" (shared gen-3 read roster)', iiiAmp?.decode(264) === 'SV Bass 1', `got ${iiiAmp?.decode(264)}`);
  check('III amp.type decode(65) → "SV Bass 2" (complete shared gen-3 amp roster)', iiiAmp?.decode(65) === 'SV Bass 2', `got ${iiiAmp?.decode(65)}`);
  // Set-by-name now works for amps too: the read ordinal IS the set value.
  check('FM9 amp.type 264 numeric passthrough → 264', encodeValue(FM9_DESCRIPTOR, 'amp', 'type', 264) === 264);
  check('FM9 set amp.type "SV Bass 1" by name → ordinal 264 (set-by-name unblocked)',
    encodeValue(FM9_DESCRIPTOR, 'amp', 'type', 'SV Bass 1') === 264);
}

// ── 2b. Device-true paramIds (NOT reused from the III) ──────────────
//
// paramIds are firmware-specific ordinals. Reusing the III's would mis-
// address FM3 6.9% / FM9 18.6% of shared params (silent wrong-knob
// writes). These checks lock that the FM catalogs are device-true: the
// SAME (block, param) resolves to a DIFFERENT paramId than the III where
// the device's own editor binary says it should, and the wire frame
// carries the device-true id.
console.log('\nDevice-true paramIds (FM catalogs are NOT the III\'s):');
{
  const delayEffectId = resolveEffectId('delay', 1);
  // Expected delay.time paramId per device's own binary scan (III=2).
  for (const { desc, modelByte, pid } of [
    { desc: AXEFX3_DESCRIPTOR, modelByte: 0x10, pid: 2 },
    { desc: FM3_DESCRIPTOR, modelByte: 0x11, pid: 8 },
    { desc: FM9_DESCRIPTOR, modelByte: 0x12, pid: 12 },
  ]) {
    const codec = createModernFractalCodec(modelByte);
    const got = desc.writer.buildSetParam!('delay', 'time', 100);
    // delay.time is a CONTINUOUS knob → sub 52 00 + float32(wire/65534).
    const want = codec.buildSetParameterContinuous(delayEffectId, pid, 100 / 65534);
    check(
      `${desc.id} set_param(delay.time) encodes device-true paramId ${pid}`,
      JSON.stringify(got) === JSON.stringify(want),
      `got ${JSON.stringify(got)}`,
    );
  }
  // The FM frames must DIFFER from the III's paramId encoding (proves no
  // accidental III-catalog reuse). Compare param-address bytes only by
  // re-encoding the III's pid=2 under each FM model byte.
  for (const { desc, modelByte } of [
    { desc: FM3_DESCRIPTOR, modelByte: 0x11 },
    { desc: FM9_DESCRIPTOR, modelByte: 0x12 },
  ]) {
    const codec = createModernFractalCodec(modelByte);
    const got = desc.writer.buildSetParam!('delay', 'time', 100);
    const iiiReuse = codec.buildSetParameterContinuous(delayEffectId, 2, 100 / 65534); // III pid under FM model byte
    check(
      `${desc.id} set_param(delay.time) is NOT the III-reused paramId (2)`,
      JSON.stringify(got) !== JSON.stringify(iiiReuse),
    );
  }

  // Catalog-wide regression guard: many shared symbols must diverge from
  // the III. A swap back to the III catalog would drop this to ~0.
  function strip(family: string, name: string): string {
    const p = `${family}_`;
    return name.startsWith(p) ? name.slice(p.length) : name;
  }
  function divergence(
    devPBF: Readonly<Record<string, readonly Param[]>>,
  ): { shared: number; diff: number } {
    let shared = 0;
    let diff = 0;
    for (const fam of Object.keys(devPBF)) {
      const iii = PARAMS_BY_FAMILY[fam];
      if (!iii) continue;
      const iiiById = new Map(iii.map((p) => [strip(fam, p.name), p.paramId]));
      for (const p of devPBF[fam]) {
        const key = strip(fam, p.name);
        if (iiiById.has(key)) {
          shared++;
          if (iiiById.get(key) !== p.paramId) diff++;
        }
      }
    }
    return { shared, diff };
  }
  const fm3div = divergence(FM3_PARAMS_BY_FAMILY);
  const fm9div = divergence(FM9_PARAMS_BY_FAMILY);
  check(
    `FM3 catalog diverges from III on >=50 shared paramIds (got ${fm3div.diff}/${fm3div.shared})`,
    fm3div.diff >= 50,
  );
  check(
    `FM9 catalog diverges from III on >=100 shared paramIds (got ${fm9div.diff}/${fm9div.shared})`,
    fm9div.diff >= 100,
  );
}

// ── 3. Descriptor shape + support_tier ──────────────────────────────
console.log('\nDescriptor capabilities:');
const expected = [
  { desc: AXEFX3_DESCRIPTOR, id: 'axe-fx-iii', rows: 6, cols: 14 },
  { desc: FM3_DESCRIPTOR, id: 'fm3', rows: 4, cols: 12 },
  { desc: FM9_DESCRIPTOR, id: 'fm9', rows: 6, cols: 14 },
];
for (const { desc, id, rows, cols } of expected) {
  const c = desc.capabilities;
  check(`${id} id matches`, desc.id === id);
  check(`${id} support_tier = community-beta`, c.support_tier === 'community-beta', String(c.support_tier));
  check(`${id} grid ${rows}×${cols}`, c.grid?.rows === rows && c.grid?.cols === cols, JSON.stringify(c.grid));
  check(`${id} scene_count 8`, c.scene_count === 8, String(c.scene_count));
  check(`${id} channels A/B/C/D`, JSON.stringify(c.channel_names) === JSON.stringify(['A', 'B', 'C', 'D']));
  // Meaningful floor (the family has ~50 blocks; a near-empty roster means
  // the catalog failed to load). The III's exact count is pinned separately
  // by verify-axe-fx-iii-identity.
  check(`${id} block roster is substantial (>=40)`, Object.keys(desc.blocks).length >= 40, String(Object.keys(desc.blocks).length));
  check(`${id} carries a verification note`, typeof c.verification === 'string' && c.verification.length > 0);
}

// ── 4. example_spec fits the device grid ────────────────────────────
console.log('\nexample_spec slots fit the grid:');
function exampleFitsGrid(desc: DeviceDescriptor): { ok: boolean; why?: string } {
  const grid = desc.capabilities.grid;
  if (!grid || !desc.example_spec) return { ok: false, why: 'missing grid or example_spec' };
  for (const slot of desc.example_spec.slots) {
    if (typeof slot.slot !== 'object') return { ok: false, why: 'non-grid slot ref' };
    if (slot.slot.row < 1 || slot.slot.row > grid.rows) return { ok: false, why: `row ${slot.slot.row} out of 1..${grid.rows}` };
    if (slot.slot.col < 1 || slot.slot.col > grid.cols) return { ok: false, why: `col ${slot.slot.col} out of 1..${grid.cols}` };
  }
  return { ok: true };
}
for (const { desc, id } of expected) {
  const r = exampleFitsGrid(desc);
  check(`${id} example_spec within grid`, r.ok, r.why);
}

// ── 5. Central descriptor list ──────────────────────────────────────
console.log('\nMODERN_FRACTAL_DESCRIPTORS central list:');
check('lists exactly 4 devices', MODERN_FRACTAL_DESCRIPTORS.length === 4, String(MODERN_FRACTAL_DESCRIPTORS.length));
check(
  'ids = axe-fx-iii, fm3, fm9, vp4 (III first for registration order)',
  JSON.stringify(MODERN_FRACTAL_DESCRIPTORS.map((d) => d.id)) === JSON.stringify(['axe-fx-iii', 'fm3', 'fm9', 'vp4']),
  JSON.stringify(MODERN_FRACTAL_DESCRIPTORS.map((d) => d.id)),
);

// ── 6. Port routing (the AM4 catch-all collision landmine) ─────────
//
// AM4's port_match is /Fractal/i — a catch-all that ALSO matches a port
// enumerating as "Fractal Audio FM9". The modern family MUST register
// before AM4 so the narrower /fm ?9/ etc. win the registration-order
// tiebreak. A routing regression here sends FM9 commands out with AM4's
// model byte (0x15) — a silent no-op on the FM9. This locks the contract.
console.log('\nPort resolution (registered in server-all order: modern family before AM4):');
clearRegistry();
for (const d of MODERN_FRACTAL_DESCRIPTORS) registerDevice(d);
registerDevice(AXEFX2_DESCRIPTOR);
registerDevice(AM4_DESCRIPTOR);

for (const [port, expectedId] of [
  // Exact id (the path the agent normally uses).
  ['fm3', 'fm3'],
  ['fm9', 'fm9'],
  ['axe-fx-iii', 'axe-fx-iii'],
  // Raw OS port names — pattern scan, registration-order tiebreak.
  ['FM9', 'fm9'],
  ['FM3', 'fm3'],
  ['VP4', 'vp4'],
  ['Fractal Audio FM9', 'fm9'],     // must NOT fall through to AM4's /Fractal/i
  ['Fractal Audio FM3', 'fm3'],
  ['Fractal Audio VP4', 'vp4'],     // must NOT fall through to AM4's /Fractal/i
  ['Axe-Fx III', 'axe-fx-iii'],
  ['Fractal AM4', 'am4'],           // AM4 still resolves (no FM/III/VP pattern matches)
] as const) {
  const got = resolveDevice(port)?.id;
  check(`resolveDevice("${port}") → ${expectedId}`, got === expectedId, `got ${got}`);
}

// ── 7. Writer-level behavior (grid bounds, scene bounds, save gate) ─
//
// These drive the actual DeviceWriter against a fake connection. The
// fake's receiveSysExMatching rejects immediately (simulating "no device
// rejection within the window" → write accepted) so the accept paths
// don't hang; setBlock/guard paths that throw or return early never reach it.
function fakeCtx() {
  const sent: number[][] = [];
  const ctx = {
    conn: {
      send: (b: number[]) => { sent.push(b); },
      receiveSysExMatching: () => Promise.reject(new Error('mock-timeout')),
      onMessage: () => () => {},
      close: () => {},
    },
    // descriptor is unused by the paths under test.
  } as unknown as Parameters<NonNullable<DeviceDescriptor['writer']['setBlock']>>[0];
  return { ctx, sent };
}

async function writerChecks(): Promise<void> {
  console.log('\nWriter-level behavior:');

  // FM3 4x12 (wire-confirmed 4 rows; 12 cols per FM3-Edit + official specs).
  // col 14 is outside (>12) and must throw without hitting the wire; col 12 is
  // now IN-grid (it was wrongly rejected when cols was 4).
  {
    const { ctx, sent } = fakeCtx();
    let threw = false;
    try {
      await FM3_DESCRIPTOR.writer.setBlock!(ctx, { row: 1, col: 14 }, { block_type: 'reverb' });
    } catch { threw = true; }
    check('FM3 set_block {row:1,col:14} throws (outside 4x12 grid)', threw);
    check('FM3 out-of-grid set_block emits NO wire frame', sent.length === 0, `sent ${sent.length}`);

    const { ctx: ctx2 } = fakeCtx();
    let ok12 = false;
    // set_block has no positive ack; an in-grid placement that isn't rejected
    // returns unconfirmed (sent, verify on device), not acked. "Accepted" = sent
    // without a 0x64 rejection / throw.
    try { const r12 = await FM3_DESCRIPTOR.writer.setBlock!(ctx2, { row: 4, col: 12 }, { block_type: 'reverb' }); ok12 = r12.acked === true || r12.unconfirmed === true; } catch { ok12 = false; }
    check('FM3 set_block {row:4,col:12} accepted (12-col grid)', ok12);

    // FM3 (4-row) places via a sub=0x30 cell-select THEN the sub=0x32 insert —
    // the FM3 ignores the insert's cell without the prior cursor move (ForgeFX
    // live-confirmed on hardware 2026-06-27). The sub-action is payload byte 0
    // (frame index 6); both frames carry the FM3 model byte 0x11.
    const { ctx: ctx3, sent: sent3 } = fakeCtx();
    await FM3_DESCRIPTOR.writer.setBlock!(ctx3, { row: 2, col: 3 }, { block_type: 'reverb' });
    check('FM3 set_block emits sub=0x30 select THEN sub=0x32 insert (two frames)',
      sent3.length === 2 && sent3[0][6] === 0x30 && sent3[1][6] === 0x32,
      JSON.stringify(sent3.map((f) => `0x${f[6]?.toString(16)}`)));
    check('FM3 select+insert both carry model byte 0x11', sent3.every((f) => f[4] === 0x11));
  }

  // Axe-Fx III (6-row): single-frame insert, no pre-select (the confirmed path).
  {
    const { ctx, sent } = fakeCtx();
    try { await AXEFX3_DESCRIPTOR.writer.setBlock!(ctx, { row: 1, col: 1 }, { block_type: 'reverb' }); } catch { /* ignore */ }
    check('III set_block emits ONE frame (sub=0x32 insert only, no 0x30 pre-select)',
      sent.length === 1 && sent[0][6] === 0x32, JSON.stringify(sent.map((f) => `0x${f[6]?.toString(16)}`)));
  }

  // FM9 6x14: the same col 14 is IN-grid and must be accepted + emit model 0x12.
  {
    const { ctx, sent } = fakeCtx();
    let ok = false;
    try {
      const r = await FM9_DESCRIPTOR.writer.setBlock!(ctx, { row: 1, col: 14 }, { block_type: 'reverb' });
      ok = r.acked === true || r.unconfirmed === true; // sent, not rejected (no positive ack)
    } catch { ok = false; }
    check('FM9 set_block {row:1,col:14} accepted (within 6x14 grid)', ok);
    check('FM9 in-grid set_block emitted a model-0x12 frame', sent.length === 1 && sent[0][4] === 0x12, JSON.stringify(sent[0]?.slice(0, 6)));
  }

  // apply_preset(target_location) honors save_authorization: the store envelope
  // (fn=0x01 sub=0x26) is DESTRUCTIVE flash, so it fires ONLY when options.save.
  // A target WITHOUT save is a reversible audition and must emit NO store frame.
  {
    const isStore = (f: number[]): boolean => f[5] === 0x01 && f[6] === 0x26;
    const emptySpec = { slots: [] } as Parameters<NonNullable<DeviceDescriptor['writer']['applyPreset']>>[1];

    const { ctx, sent } = fakeCtx();
    await FM9_DESCRIPTOR.writer.applyPreset!(ctx, emptySpec, 5, { save: false });
    check('FM9 apply_preset(target, save_authorized:false) = audition: NO store envelope',
      sent.filter(isStore).length === 0, `store frames: ${sent.filter(isStore).length}`);

    const { ctx: ctx2, sent: sent2 } = fakeCtx();
    await FM9_DESCRIPTOR.writer.applyPreset!(ctx2, emptySpec, 5, { save: true });
    check('FM9 apply_preset(target, save_authorized:true) emits exactly one store envelope (fn=0x01 sub=0x26)',
      sent2.filter(isStore).length === 1, `store frames: ${sent2.filter(isStore).length}`);
  }

  // The gen-3 grid is 6 rows (wire-confirmed on FM9 + III over loopMIDI, and
  // visually 6x14 in both editors), NOT the 4 the config originally carried.
  // Row 6 is now IN-grid, and the cell-index stride must be 6 (the wire
  // geometry from the block-insert decode) so col>1 addresses the right cell.
  {
    const { ctx } = fakeCtx();
    let ok6 = false;
    try { const r6 = await FM9_DESCRIPTOR.writer.setBlock!(ctx, { row: 6, col: 1 }, { block_type: 'reverb' }); ok6 = r6.acked === true || r6.unconfirmed === true; } catch { ok6 = false; }
    check('FM9 set_block {row:6,col:1} accepted (6-row grid)', ok6);

    // {row:1,col:2} -> gridPos = (2-1)*6 + (1-1) = 6 (stride-6, not the old 4).
    // The block-insert op (fn=0x01 sub=0x32) carries gridPos septet-LSB at
    // envelope byte 12 (effectId is at bytes 8-9), so read byte 12.
    const { ctx: ctx2, sent: sent2 } = fakeCtx();
    let gridPos = -1;
    try { await FM9_DESCRIPTOR.writer.setBlock!(ctx2, { row: 1, col: 2 }, { block_type: 'reverb' }); gridPos = sent2[0]?.[12] ?? -1; } catch { /* threw */ }
    check('FM9 set_block {row:1,col:2} emits gridPos=6 (6-row stride)', gridPos === 6, `gridPos=${gridPos}`);
  }

  // switchScene bounds: 8 ok (→ wire scene 7), 9 rejected, 0 rejected.
  {
    const codec = createModernFractalCodec(0x11);
    const { ctx, sent } = fakeCtx();
    const r = await FM3_DESCRIPTOR.writer.switchScene!(ctx, 8);
    check('FM3 switchScene(8) acked', r.acked === true);
    check('FM3 switchScene(8) emits buildSetScene(7) with model 0x11',
      sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify(codec.buildSetScene(7)),
      JSON.stringify(sent[0]));
    for (const bad of [0, 9, 99]) {
      let threw = false;
      try { await FM3_DESCRIPTOR.writer.switchScene!(fakeCtx().ctx, bad); } catch { threw = true; }
      check(`FM3 switchScene(${bad}) throws (out of 1..8)`, threw);
    }
  }

  // Safe-edit gate: supports_save=false → save_active_first must NOT emit
  // a STORE (0x1D) at the device; it refuses and tells the user to discard.
  {
    const { ctx, sent } = fakeCtx();
    markDirty('fm9'); // simulate an edit having marked the buffer dirty
    const r = await FM9_DESCRIPTOR.writer.guardActiveBufferOrSave!(ctx, 'save_active_first');
    markClean('fm9'); // reset shared dirty state for any later checks
    check('FM9 guard save_active_first refuses (proceed=false) when save unsupported', r.proceed === false);
    check('FM9 guard emits NO STORE/wire frame in save_active_first', sent.length === 0, `sent ${sent.length}`);
  }

  // Guard is a no-op (proceed=true) when the buffer is clean.
  {
    const { ctx, sent } = fakeCtx();
    markClean('fm3');
    const r = await FM3_DESCRIPTOR.writer.guardActiveBufferOrSave!(ctx, 'warn');
    check('FM3 guard proceeds when buffer is clean', r.proceed === true);
    check('FM3 clean guard emits no frame', sent.length === 0);
  }

  // switch_preset wire shape per device. The FM3 ships the SysEx-native
  // fn=0x01 sub=0x27 switch — PC is hardware-FALSIFIED on the FM3 for presets
  // >127 (fw 12.00 ignores CC32; field test 2026-06-12) — while the III/FM9
  // keep MIDI Program Change + Bank Select, split into one send per message
  // (the WinMM long-message drop workaround). Preset 475: bank 3, PC 91.
  {
    const codec11 = createModernFractalCodec(0x11);
    const { ctx, sent } = fakeCtx();
    const r = await FM3_DESCRIPTOR.writer.switchPreset!(ctx, 475);
    check('FM3 switch_preset(475) acked', r.acked === true);
    check('FM3 switch_preset emits exactly ONE frame', sent.length === 1, `sent ${sent.length}`);
    const f = sent[0] ?? [];
    check('FM3 switch_preset frame = SysEx model 0x11, fn=0x01, sub=0x27',
      f[0] === 0xf0 && f[4] === 0x11 && f[5] === 0x01 && f[6] === 0x27,
      JSON.stringify(f.slice(0, 8)));
    // Preset number rides as a 14-bit LE septet pair at payload pos 12
    // (475 → 5b 03; the codec golden pins the same bytes).
    check('FM3 switch_preset carries preset 475 as septet pair 5b 03 at pos 12',
      f[12] === 0x5b && f[13] === 0x03, JSON.stringify([f[12], f[13]]));
    check('FM3 switch_preset frame is byte-identical to buildSwitchPresetSysEx(475)',
      JSON.stringify(f) === JSON.stringify(codec11.buildSwitchPresetSysEx(475)), JSON.stringify(f));
  }
  // FM9: PC + Bank Select short-MIDI messages with the 'msb' encoding — the
  // FM9 reads the bank from CC0 and ignores CC32. No 0xF0-prefixed frame.
  {
    const { ctx, sent } = fakeCtx();
    await FM9_DESCRIPTOR.writer.switchPreset!(ctx, 475);
    check('FM9 switch_preset emits NO SysEx frame (PC+Bank path)',
      sent.length > 0 && sent.every((m) => m[0] !== 0xf0), JSON.stringify(sent));
    check('FM9 switch_preset(475) = CC0=3 (bank in CC0, msb mode), CC32=0, PC=91',
      JSON.stringify(sent) === JSON.stringify([[0xb0, 0x00, 3], [0xb0, 0x20, 0], [0xc0, 91]]),
      JSON.stringify(sent));
  }
  // III: same PC+Bank path with the spec-standard (CC0<<7)|CC32 encoding.
  {
    const { ctx, sent } = fakeCtx();
    await AXEFX3_DESCRIPTOR.writer.switchPreset!(ctx, 475);
    check('III switch_preset emits NO SysEx frame (PC+Bank path)',
      sent.length > 0 && sent.every((m) => m[0] !== 0xf0), JSON.stringify(sent));
    check('III switch_preset(475) = CC0=0, CC32=3 (standard), PC=91',
      JSON.stringify(sent) === JSON.stringify([[0xb0, 0x00, 0], [0xb0, 0x20, 3], [0xc0, 91]]),
      JSON.stringify(sent));
  }
}

await writerChecks();

// ── 7b. VP4 (model 0x14): serial AM4-shape + gated writes ───────────
//
// VP4 reuses the gen-3 effects codec but is AM4-SHAPE: a serial 4-slot chain,
// 4 scenes, A-D channels, A01..Z04 locations, no amp/cab. Only the fn=0x12
// mode switch is wire-confirmed, so every device-state WRITE refuses with
// capability_not_supported and emits no frame; reads work (proven in the
// reader section). This locks the serial shape, the roster exclusion, and the
// write gate together.
async function vp4Checks(): Promise<void> {
  console.log('\nVP4 (model 0x14) serial AM4-shape + gated writes:');
  const c = VP4_DESCRIPTOR.capabilities;
  check('vp4 id matches', VP4_DESCRIPTOR.id === 'vp4');
  check('vp4 slot_model = linear', c.slot_model === 'linear', String(c.slot_model));
  check('vp4 slot_count = 4', c.slot_count === 4, String(c.slot_count));
  check('vp4 has NO grid (serial, not grid)', c.grid === undefined, JSON.stringify(c.grid));
  check('vp4 scene_count = 4 (AM4-shape, not gen-3 8)', c.scene_count === 4, String(c.scene_count));
  check('vp4 channels A/B/C/D', JSON.stringify(c.channel_names) === JSON.stringify(['A', 'B', 'C', 'D']));
  check('vp4 single-instance (has_block_instances falsy)', !c.has_block_instances, String(c.has_block_instances));
  check('vp4 support_tier = community-beta', c.support_tier === 'community-beta', String(c.support_tier));
  check(
    'vp4 location format accepts A01 / Z4 (A-Z04)',
    c.preset_location_format?.test('A01') === true && c.preset_location_format?.test('Z4') === true,
    String(c.preset_location_format),
  );
  check('vp4 carries a verification note', typeof c.verification === 'string' && c.verification.length > 0);

  // No amp/cab on the physical VP4 (mined catalog carries DISTORT/CABINET from
  // the shared editor binary, but exclude_blocks drops them); effects remain.
  check('vp4 drops the amp block (exclude_blocks)', VP4_DESCRIPTOR.blocks['amp'] === undefined);
  check('vp4 drops the cab block (exclude_blocks)', VP4_DESCRIPTOR.blocks['cab'] === undefined);
  check('vp4 keeps the reverb block', VP4_DESCRIPTOR.blocks['reverb'] !== undefined);
  check('vp4 keeps the delay block', VP4_DESCRIPTOR.blocks['delay'] !== undefined);
  check('vp4 block roster is substantial (>=40)', Object.keys(VP4_DESCRIPTOR.blocks).length >= 40, String(Object.keys(VP4_DESCRIPTOR.blocks).length));

  // VP4 write codec: the pure BUILDER for a CONTINUOUS param emits a well-formed
  // model-0x14 frame (VP4-true: no sub-action, tc sub-opcode, swapped float).
  // DISCRETE param SET is intentionally unsupported on VP4 (zero captured
  // evidence) → the builder throws rather than mis-encode.
  {
    const frame = VP4_DESCRIPTOR.writer.buildSetParam!('reverb', 'time', 100);
    const r = frameIsWellFormed(frame, 0x14);
    check('vp4 buildSetParam(reverb.time continuous) → model 0x14 + valid checksum', r.ok, r.why);
  }
  {
    let threw = false;
    try { VP4_DESCRIPTOR.writer.buildSetParam!('reverb', 'type', 100); } catch { threw = true; }
    check('vp4 buildSetParam(reverb.type discrete) throws (unsupported, not mis-encoded)', threw);
  }

  // ALLOWED (decoded byte-exact, community-beta): emit a wire frame, do not refuse.
  // Continuous set_param/set_params + set_bypass + save_preset.
  async function allowed(label: string, run: () => Promise<unknown>, sent: number[][]): Promise<void> {
    let code: string | undefined;
    try { await run(); } catch (e) { code = e instanceof DispatchError ? e.code : `(non-dispatch: ${String(e)})`; }
    check(`vp4 ${label} is NOT gated`, code !== 'capability_not_supported', `code: ${code}`);
    check(`vp4 ${label} emits a wire frame`, sent.length >= 1, `sent ${sent.length}`);
  }
  { const { ctx, sent } = fakeCtx(); await allowed('set_param (continuous)', () => VP4_DESCRIPTOR.writer.setParam!(ctx, 'reverb', 'time', 32767), sent); }
  { const { ctx, sent } = fakeCtx(); await allowed('set_params (continuous)', () => VP4_DESCRIPTOR.writer.setParams!(ctx, [{ block: 'reverb', name: 'time', value: 32767 }]), sent); }
  { const { ctx, sent } = fakeCtx(); await allowed('set_bypass', () => VP4_DESCRIPTOR.writer.setBypass!(ctx, 'reverb', true), sent); }
  { const { ctx, sent } = fakeCtx(); await allowed('save_preset', () => VP4_DESCRIPTOR.writer.savePreset!(ctx, 0), sent); }

  // Every OTHER device-state write refuses with capability_not_supported and
  // emits NO wire frame (gated until decoded/confirmed).
  async function refuses(label: string, run: () => Promise<unknown>, sent: number[][]): Promise<void> {
    let code: string | undefined;
    try { await run(); } catch (e) { code = e instanceof DispatchError ? e.code : `(non-dispatch: ${String(e)})`; }
    check(`vp4 ${label} refuses (capability_not_supported)`, code === 'capability_not_supported', `code: ${code}`);
    check(`vp4 ${label} emits NO wire frame`, sent.length === 0, `sent ${sent.length}`);
  }
  // DISCRETE/enum set_param refuses (no captured evidence; must not mis-encode).
  { const { ctx, sent } = fakeCtx(); await refuses('set_param(reverb.type discrete)', () => VP4_DESCRIPTOR.writer.setParam!(ctx, 'reverb', 'type', 5), sent); }
  { const { ctx, sent } = fakeCtx(); await refuses('set_block', () => VP4_DESCRIPTOR.writer.setBlock!(ctx, 1, { block_type: 'reverb' }), sent); }
  { const { ctx, sent } = fakeCtx(); await refuses('apply_preset', () => VP4_DESCRIPTOR.writer.applyPreset!(ctx, { name: 'X', slots: [] }), sent); }
  { const { ctx, sent } = fakeCtx(); await refuses('switch_preset', () => VP4_DESCRIPTOR.writer.switchPreset!(ctx, 'A01'), sent); }
  { const { ctx, sent } = fakeCtx(); await refuses('switch_scene', () => VP4_DESCRIPTOR.writer.switchScene!(ctx, 2), sent); }
  { const { ctx, sent } = fakeCtx(); await refuses('rename', () => VP4_DESCRIPTOR.writer.rename!(ctx, 'preset', 'X'), sent); }

  // STRUCTURE READ (eid206 pid0 tc=0x1f): one blob read gives preset name,
  // scene names, current scene, and the serial 4-slot chain. Byte-decoded
  // from two fw 4.03 community captures; community-beta. Mock the device
  // with a REAL captured response frame (preset "Y1: Main Bank", post
  // scene-1→3, chain DLY/DRV/PHR/WAH) and drive get_preset end-to-end.
  {
    const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');
    check(
      'vp4 structure-blob GET frame byte-exact vs capture',
      hex(buildVp4GetStructureBlob()) === 'f000017414014e0100001f000000000040f7',
      hex(buildVp4GetStructureBlob()),
    );
    const V1_STRUCTURE_FRAME = (
      'f000017414014e0100001f0000004001300000000004000000004000000218480710' +
      '49560b255c2021182d66590040201008040201004020100804020100402010080402' +
      '01000052305d64020100402010080402010040201008040201004020100804020100' +
      '4020100800053b05502022192d460b64402010080402010040201008040201004020' +
      '1008040201004000281a0c171b15642022192d460b64402010080402010040201008' +
      '0402010040201008040002114a6c305e240201004020100804020100402010080402' +
      '0100402010080402010040200011400000016c0000000b200000005e0000000037f7'
    ).match(/../g)!.map((h) => Number.parseInt(h, 16));
    const parsed = parseVp4StructureBlob(V1_STRUCTURE_FRAME);
    check('vp4 parseVp4StructureBlob decodes the captured frame',
      parsed.presetName === 'Main Bank' && parsed.currentSceneDisplay === 3,
      JSON.stringify({ name: parsed.presetName, scene: parsed.currentSceneDisplay }));

    // Reader end-to-end: a mock conn answers ONLY the structure GET with the
    // captured frame (the fn=0x1F block polls stay unanswered, as on a device
    // whose fn=0x1F support is unconfirmed — the structure fields must still
    // come through).
    let handler: ((b: number[]) => void) | undefined;
    const ctx = {
      conn: {
        send: (b: number[]) => {
          // the structure GET: fn=0x01, eid 206 (4E 01), tc=0x1f at index 10
          if (b[5] === 0x01 && b[6] === 0x4e && b[7] === 0x01 && b[10] === 0x1f && handler) {
            const h = handler;
            setTimeout(() => h(V1_STRUCTURE_FRAME), 0);
          }
        },
        receiveSysExMatching: () => Promise.reject(new Error('mock-timeout')),
        onMessage: (h: (b: number[]) => void) => { handler = h; return () => { handler = undefined; }; },
        close: () => {},
      },
    } as unknown as Parameters<NonNullable<DeviceDescriptor['reader']['getPreset']>>[0];
    const snap = await VP4_DESCRIPTOR.reader!.getPreset!(ctx);
    check('vp4 get_preset name from the structure blob', snap.name === 'Main Bank', JSON.stringify(snap.name));
    check('vp4 get_preset active_scene = 3 (1-based display)', snap.active_scene === 3, String(snap.active_scene));
    check(
      'vp4 get_preset scene names from the structure blob',
      JSON.stringify(snap.scenes?.map((s) => s.name)) === JSON.stringify(['Raw', 'Wah Delay', 'Phaser Delay', 'Delay']),
      JSON.stringify(snap.scenes?.map((s) => s.name)),
    );
    check(
      'vp4 get_preset routing_omitted=false (the chain IS the routing)',
      snap._meta?.routing_omitted === false,
      String(snap._meta?.routing_omitted),
    );
    check(
      'vp4 get_preset warning names the structure read + the fn=0x1F audit item',
      (snap.read_warnings ?? []).some((w) => w.includes('eid206 pid0 tc=0x1f') && w.includes('fn=0x1F')),
      JSON.stringify(snap.read_warnings),
    );
  }
}
await vp4Checks();

// ── 8. Gen-3 enum READ leg + set-by-name gate (BK-093) ─────────────
//
// The effect-type selector enums label the device's broadcast/GET ordinal
// (read leg, byte-anchored for REVERB on the 2026-06-03 FM9 capture) but
// refuse set-by-name (the typed-SET raw enum id is a different, uncaptured
// encoding). This locks BOTH halves: labels present + decode; names blocked,
// numbers pass.
console.log('\nGen-3 enum read leg + set-by-name gate (BK-093):');
for (const { desc } of [
  { desc: AXEFX3_DESCRIPTOR },
  { desc: FM3_DESCRIPTOR },
  { desc: FM9_DESCRIPTOR },
]) {
  const typeSchema = desc.blocks['reverb']?.params['type'];
  // FM9 = device-true cache roster (adjective-first); III/FM3 = AM4-borrowed.
  const expRev16 = desc.id === 'fm9' ? 'Medium Spring' : 'Spring, Medium';
  check(`${desc.id} reverb.type carries enum_values`, typeSchema?.enum_values !== undefined);
  check(
    `${desc.id} reverb.type ordinal 16 → '${expRev16}' (byte-anchor)`,
    typeSchema?.enum_values?.[16] === expRev16,
    JSON.stringify(typeSchema?.enum_values?.[16]),
  );
  check(`${desc.id} reverb.type wire_kind = discrete`, typeSchema?.wire_kind === 'discrete');
  check(
    `${desc.id} reverb.type decode(16) labels`,
    typeSchema?.decode(16) === expRev16,
    JSON.stringify(typeSchema?.decode(16)),
  );
  check(
    `${desc.id} reverb.type decode(unknown ordinal) falls back to wire`,
    typeSchema?.decode(60000) === 60000,
  );

  // Every valid reverb type name now sets by name (the read ordinal IS the set
  // value): "Room, Small" resolves to ordinal 0 (was capture-blocked).
  check(
    `${desc.id} set_param(reverb.type, "Room, Small") → ordinal 0 (set-by-name unblocked)`,
    encodeValue(desc, 'reverb', 'type', 'Room, Small') === 0,
  );
  // Numeric wire value still passes through (raw, caller's responsibility).
  check(`${desc.id} set_param(reverb.type, 16) numeric passthrough`, encodeValue(desc, 'reverb', 'type', 16) === 16);
  check(`${desc.id} set_param(reverb.type, "16") numeric-string passthrough`, encodeValue(desc, 'reverb', 'type', '16') === 16);
}

// ── 8b. Gen-3 AMP block is unlocked (ID_DISTORT1=58, DISTORT family) ─
//
// The amp is the DISTORT family at effect IDs 58..61. set_block('amp') +
// set_param amp.gain/bass/mid/treble/... must work on all three devices.
// The amp MODEL selector (amp.type): the AM4 DRIVE/AMP_TYPES ordinal table is
// not a valid oracle for gen-3 amp ordinals, so a DRIVE_TYPES leak onto
// amp.type would fabricate wrong names. III/FM3 ship it UNLABELED (numeric
// passthrough). FM9 carries a device-true PARTIAL override (captured amp
// names), which must be the real roster, never the drive table.
console.log('\nGen-3 AMP block unlocked (ID_DISTORT1=58):');
for (const { desc } of [
  { desc: AXEFX3_DESCRIPTOR },
  { desc: FM3_DESCRIPTOR },
  { desc: FM9_DESCRIPTOR },
]) {
  check(`${desc.id} resolveEffectId('amp', 1) === 58`, resolveEffectId('amp', 1) === 58, String(resolveEffectId('amp', 1)));
  const ampBlock = desc.blocks['amp'];
  check(`${desc.id} exposes an 'amp' block`, ampBlock !== undefined);
  check(`${desc.id} amp block has >0 params`, Object.keys(ampBlock?.params ?? {}).length > 0, String(Object.keys(ampBlock?.params ?? {}).length));
  const ampType = ampBlock?.params['type'];
  const vals = ampType?.enum_values;
  // No AM4 DRIVE_TYPES leak on ANY device (the drive table's hallmark names).
  const looksLikeDriveTable = vals !== undefined
    && Object.values(vals).some((n) => /^(T808|Tube Drive|FAS Boost|Fat Rat|Esoteric)/i.test(String(n)));
  check(`${desc.id} amp.type carries no AM4 DRIVE_TYPES leak`, !looksLikeDriveTable, JSON.stringify(vals));
  // P1: every gen-3 grid device carries the shared read roster for amps
  // (SV Bass 1 @ ordinal 264). Set-by-name now works (the ordinal IS the set
  // value), so amp.type is a discrete selector like reverb/drive.
  check(`${desc.id} amp.type carries the shared gen-3 amp roster (SV Bass 1 @264)`,
    vals !== undefined && vals[264] === 'SV Bass 1', JSON.stringify(vals?.[264]));
  check(`${desc.id} amp.type wire_kind = discrete (set-by-name unblocked)`,
    ampType?.wire_kind === 'discrete', String(ampType?.wire_kind));
}

// ── 8c. Gen-3 multi-instance addressing (C8) ────────────────────────
//
// gen-3 presets routinely use a 2nd amp / 2nd reverb. The `instance` arg
// must route a write to the right block: Amp 1 = effect id 58, Amp 2 = 59
// (resolveEffectId('amp', n) = firstId + (n-1)). This drives the real
// writer and asserts the emitted SET_PARAMETER frame carries the
// instance's effect id, encoded with each device's DEVICE-TRUE drive
// paramId (III=1; FM3/FM9 differ).
async function multiInstanceChecks(): Promise<void> {
  console.log('\nGen-3 multi-instance addressing (C8):');
  for (const { desc, modelByte, pbf } of [
    { desc: AXEFX3_DESCRIPTOR, modelByte: 0x10, pbf: PARAMS_BY_FAMILY },
    { desc: FM3_DESCRIPTOR, modelByte: 0x11, pbf: FM3_PARAMS_BY_FAMILY },
    { desc: FM9_DESCRIPTOR, modelByte: 0x12, pbf: FM9_PARAMS_BY_FAMILY },
  ]) {
    const codec = createModernFractalCodec(modelByte);
    const drivePid = (pbf['DISTORT'] ?? []).find((p) => p.name === 'DISTORT_DRIVE')?.paramId;
    check(`${desc.id} DISTORT_DRIVE paramId present`, drivePid !== undefined, String(drivePid));
    if (drivePid === undefined) continue;

    // instance 1 → Amp 1 (effect id 58)
    {
      const { ctx, sent } = fakeCtx();
      await desc.writer.setParam!(ctx, 'amp', 'drive', 100, undefined, 1);
      // amp.drive is a CONTINUOUS knob → sub 52 00 + float32(wire/65534).
      const want = codec.buildSetParameterContinuous(58, drivePid, 100 / 65534);
      check(`${desc.id} set_param(amp.drive, instance:1) → Amp 1 (effect id 58)`,
        sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify(want),
        JSON.stringify(sent[0]?.slice(0, 8)));
    }
    // instance 2 → Amp 2 (effect id 59), and it MUST differ from instance 1.
    {
      const { ctx, sent } = fakeCtx();
      await desc.writer.setParam!(ctx, 'amp', 'drive', 100, undefined, 2);
      const want2 = codec.buildSetParameterContinuous(59, drivePid, 100 / 65534);
      const want1 = codec.buildSetParameterContinuous(58, drivePid, 100 / 65534);
      check(`${desc.id} set_param(amp.drive, instance:2) → Amp 2 (effect id 59)`,
        sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify(want2),
        JSON.stringify(sent[0]?.slice(0, 8)));
      check(`${desc.id} amp instance 2 frame differs from instance 1`,
        JSON.stringify(sent[0]) !== JSON.stringify(want1));
    }
    // out-of-range instance (Amp has 4) throws and emits nothing.
    {
      const { ctx, sent } = fakeCtx();
      let threw = false;
      try { await desc.writer.setParam!(ctx, 'amp', 'drive', 100, undefined, 5); } catch { threw = true; }
      check(`${desc.id} set_param(amp.drive, instance:5) throws (amp has 4 instances)`, threw);
      check(`${desc.id} out-of-range instance emits NO frame`, sent.length === 0, `sent ${sent.length}`);
    }
  }
}
await multiInstanceChecks();

// ── 8d. Multi-instance capability gate (no AM4/Hydra regression) ────
//
// The dispatcher gate refuses instance > 1 on devices that don't advertise
// has_block_instances, so AM4/Hydra never silently write the wrong instance.
// instance 1 / undefined is always allowed. Grid Fractal devices pass.
console.log('\nMulti-instance capability gate:');
check('axe-fx-iii advertises has_block_instances', AXEFX3_DESCRIPTOR.capabilities.has_block_instances === true);
check('axe-fx-ii advertises has_block_instances', AXEFX2_DESCRIPTOR.capabilities.has_block_instances === true);
check('AM4 does NOT advertise has_block_instances', !AM4_DESCRIPTOR.capabilities.has_block_instances);
for (const inst of [undefined, 1]) {
  let threw = false;
  try { assertInstanceSupported(AM4_DESCRIPTOR, inst); } catch { threw = true; }
  check(`AM4 gate allows instance ${inst}`, !threw);
}
{
  let gateErr: unknown;
  try { assertInstanceSupported(AM4_DESCRIPTOR, 2); } catch (e) { gateErr = e; }
  check('AM4 gate refuses instance 2 (capability_not_supported)',
    gateErr instanceof DispatchError && gateErr.code === 'capability_not_supported',
    gateErr instanceof DispatchError ? gateErr.code : String(gateErr));
}
for (const desc of [AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR, AXEFX2_DESCRIPTOR]) {
  let threw = false;
  try { assertInstanceSupported(desc, 2); } catch { threw = true; }
  check(`${desc.id} gate allows instance 2`, !threw);
}

// ── 9. Gen-3 fn=0x1F bulk-read reader (S2), mock connection ─────────
//
// Drives the real DeviceReader against a mock MIDI connection that answers
// the fn=0x1F poll with a synthesized 0x74/0x75/0x76 burst. Confirms the
// poll→burst→positional-decode→enum-label path end-to-end (minus USB).
async function readerChecks(): Promise<void> {
  console.log('\nGen-3 fn=0x1F bulk-read reader (mock connection):');

  const reverbEffectId = resolveEffectId('reverb', 1);

  function broadcastFrame(model: number, fn: number, payload: number[]): number[] {
    const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
    return [...body, fractalChecksum([...body, 0, 0]), 0xf7];
  }
  // The 0x75 body is CHANNEL-BLOCKED: four contiguous copies of every paramId
  // (index = channel × stride + paramId, stride = itemCount/4). Place ordinal 16
  // at each device's OWN REVERB_TYPE paramId (III=0, FM3/FM9 differ), in EVERY
  // channel's copy, so a no-channel read returns it (channel-invariant). A
  // correct read must honor the device's paramId and the channel stride, not a
  // shared offset.
  function burstFor(model: number, typeParamId: number): number[][] {
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    const stride = typeParamId + 6; // clears the type slot
    const itemCount = stride * 4; // 4 channels A–D
    const dumpValues = Array.from({ length: itemCount }, (_, idx) =>
      idx % stride === typeParamId ? 16 : (idx * 7) & 0x7fff);
    const head = broadcastFrame(model, 0x74, [...enc14(reverbEffectId), ...enc14(itemCount), 0x07]);
    const body = broadcastFrame(model, 0x75, [0x00, 0x02, ...dumpValues.flatMap((v) => packValue16(v))]);
    const end = broadcastFrame(model, 0x76, []);
    return [head, body, end];
  }

  for (const { desc, modelByte, pbf } of [
    { desc: AXEFX3_DESCRIPTOR, modelByte: 0x10, pbf: PARAMS_BY_FAMILY },
    { desc: FM3_DESCRIPTOR, modelByte: 0x11, pbf: FM3_PARAMS_BY_FAMILY },
    { desc: FM9_DESCRIPTOR, modelByte: 0x12, pbf: FM9_PARAMS_BY_FAMILY },
    // VP4 reads are NOT gated — only writes are. The fn=0x1F block poll is
    // effect-id addressed (grid-agnostic), so the serial VP4 reads exactly
    // like its grid siblings off the same channel-blocked burst.
    { desc: VP4_DESCRIPTOR, modelByte: 0x14, pbf: VP4_PARAMS_BY_FAMILY },
  ]) {
    const typeParamId = (pbf['REVERB'] ?? []).find((p) => p.name === 'REVERB_TYPE')!.paramId;
    const conn = mockConnect({
      responder: (out) => (out[5] === 0x1f ? burstFor(modelByte, typeParamId) : []),
      ackLatencyMs: 1,
    });
    const ctx = { conn, descriptor: desc } as unknown as Parameters<NonNullable<DeviceDescriptor['reader']>['getParam']>[0];
    let res: Awaited<ReturnType<NonNullable<DeviceDescriptor['reader']>['getParam']>> | undefined;
    let err: unknown;
    try {
      res = await desc.reader!.getParam(ctx, 'reverb', 'type');
    } catch (e) {
      err = e;
    }
    check(`${desc.id} get_param(reverb.type) reads the fn=0x1F dump`, res !== undefined, String(err));
    check(`${desc.id} get_param(reverb.type) wire_value = 16 (device-true paramId ${typeParamId})`, res?.wire_value === 16, JSON.stringify(res?.wire_value));
    check(`${desc.id} get_param(reverb.type) display_value labels via S1 overlay`, res?.display_value === (desc.id === 'fm9' ? 'Medium Spring' : 'Spring, Medium'), JSON.stringify(res?.display_value));
  }

  // Channel-DIVERGENT read: the four channel copies of REVERB_TYPE differ. This
  // is exactly the branch the channel-aware fix added (index = channel × stride +
  // paramId) and the one that first fires against a real FM9 dump tomorrow. A
  // no-channel read must REFUSE and list every channel; an explicit channel arg
  // must project that channel's copy (not silently return channel A).
  {
    const typeParamId = (FM9_PARAMS_BY_FAMILY['REVERB'] ?? []).find((p) => p.name === 'REVERB_TYPE')!.paramId;
    const perChannel = [16, 45, 1, 16]; // A=16, B=45, C=1, D=16 — B/C diverge from A
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    function burstDivergent(model: number): number[][] {
      const stride = typeParamId + 6;
      const itemCount = stride * 4;
      const dumpValues = Array.from({ length: itemCount }, (_, idx) => {
        const ch = Math.floor(idx / stride);
        const pid = idx % stride;
        return pid === typeParamId ? perChannel[ch] : (idx * 7) & 0x7fff;
      });
      const head = broadcastFrame(model, 0x74, [...enc14(reverbEffectId), ...enc14(itemCount), 0x07]);
      const body = broadcastFrame(model, 0x75, [0x00, 0x02, ...dumpValues.flatMap((v) => packValue16(v))]);
      const end = broadcastFrame(model, 0x76, []);
      return [head, body, end];
    }
    // (a) no channel + divergent copies → refuse with bad_channel and list channels.
    {
      const conn = mockConnect({ responder: (out) => (out[5] === 0x1f ? burstDivergent(0x12) : []), ackLatencyMs: 1 });
      const ctx = { conn, descriptor: FM9_DESCRIPTOR } as unknown as Parameters<NonNullable<DeviceDescriptor['reader']>['getParam']>[0];
      let divErr: unknown;
      try { await FM9_DESCRIPTOR.reader!.getParam(ctx, 'reverb', 'type'); } catch (e) { divErr = e; }
      check(
        'FM9 get_param(reverb.type) with divergent channels REFUSES (bad_channel)',
        divErr instanceof DispatchError && divErr.code === 'bad_channel',
        divErr instanceof DispatchError ? divErr.code : String(divErr),
      );
    }
    // (b) explicit channel B → projects channel B's copy (ordinal 45), not A's 16.
    {
      const conn = mockConnect({ responder: (out) => (out[5] === 0x1f ? burstDivergent(0x12) : []), ackLatencyMs: 1 });
      const ctx = { conn, descriptor: FM9_DESCRIPTOR } as unknown as Parameters<NonNullable<DeviceDescriptor['reader']>['getParam']>[0];
      let res: Awaited<ReturnType<NonNullable<DeviceDescriptor['reader']>['getParam']>> | undefined;
      let bErr: unknown;
      try { res = await FM9_DESCRIPTOR.reader!.getParam(ctx, 'reverb', 'type', 'B'); } catch (e) { bErr = e; }
      check(
        'FM9 get_param(reverb.type, channel=B) projects channel B copy (wire 45, not channel A 16)',
        res?.wire_value === 45,
        JSON.stringify(res?.wire_value ?? String(bErr)),
      );
    }
  }

  // Unrelated-block broadcast (wrong blockId head) must NOT satisfy the read:
  // the responder returns a WELL-FORMED burst for a DIFFERENT block id, and the
  // reader's blockId gate must ignore it and time out with a no_ack error. (A
  // crash in the fixture would falsely satisfy a bare `threw` check, so we
  // assert the specific no_ack DispatchError the gate produces.)
  {
    const conn = mockConnect({
      responder: (out) => {
        if (out[5] !== 0x1f) return [];
        const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
        const head = broadcastFrame(0x12, 0x74, [...enc14(reverbEffectId + 1), ...enc14(6), 0x07]);
        return [head, broadcastFrame(0x12, 0x75, [0x00, 0x02, ...packValue16(16)]), broadcastFrame(0x12, 0x76, [])];
      },
      ackLatencyMs: 1,
    });
    const ctx = { conn, descriptor: FM9_DESCRIPTOR } as unknown as Parameters<NonNullable<DeviceDescriptor['reader']>['getParam']>[0];
    let gateErr: unknown;
    try { await FM9_DESCRIPTOR.reader!.getParam(ctx, 'reverb', 'type'); } catch (e) { gateErr = e; }
    check(
      'FM9 get_param ignores a broadcast for a different block (no_ack, gate exercised)',
      gateErr instanceof DispatchError && gateErr.code === 'no_ack',
      gateErr instanceof DispatchError ? gateErr.code : String(gateErr),
    );
  }

  // get_preset poll loop: the placed block (reverb) bursts; every OTHER block
  // NACKs fast (fn=0x64), so the loop finishes quickly and reports reverb.
  {
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    const conn = mockConnect({
      responder: (out) => {
        if (out[5] !== 0x1f) return [];
        const polledEffectId = (out[6] & 0x7f) | ((out[7] & 0x7f) << 7);
        if (polledEffectId !== reverbEffectId) {
          return [broadcastFrame(0x12, 0x64, [0x04])]; // multipurpose NACK: not placed
        }
        // FM9 reverb: REVERB_TYPE is paramId 10; ordinal 16 = Medium Spring (device-true).
        const vals = Array.from({ length: 11 }, (_, i) => (i === 10 ? 16 : i));
        return [
          broadcastFrame(0x12, 0x74, [...enc14(reverbEffectId), ...enc14(11), 0x07]),
          broadcastFrame(0x12, 0x75, [0x00, 0x02, ...vals.flatMap((v) => packValue16(v))]),
          broadcastFrame(0x12, 0x76, []),
        ];
      },
      ackLatencyMs: 1,
    });
    type GetPresetFn = NonNullable<DeviceDescriptor['reader']['getPreset']>;
    const ctx = { conn, descriptor: FM9_DESCRIPTOR } as unknown as Parameters<GetPresetFn>[0];
    let snap: Awaited<ReturnType<GetPresetFn>> | undefined;
    let snapErr: unknown;
    try { snap = await FM9_DESCRIPTOR.reader!.getPreset!(ctx); } catch (e) { snapErr = e; }
    check('FM9 get_preset returns a snapshot', snap !== undefined, String(snapErr));
    const reverbSlot = snap?.slots.find((s) => s.block_type === 'reverb');
    check('FM9 get_preset finds the placed reverb block', reverbSlot !== undefined);
    check('FM9 get_preset decodes reverb.type to its label', (reverbSlot?.params as Record<string, unknown> | undefined)?.type === 'Medium Spring',
      JSON.stringify((reverbSlot?.params as Record<string, unknown> | undefined)?.type));
    check('FM9 get_preset reports only placed blocks (NACKed blocks excluded)', (snap?.slots.length ?? 0) >= 1 && (snap?.slots.length ?? 99) < 5,
      String(snap?.slots.length));
    check('FM9 get_preset carries a beta read_warning', (snap?.read_warnings?.length ?? 0) > 0);
  }

  // export_preset (dumpActivePresetBinary): fn=0x43 → 0x51 head + 0x52 body run,
  // NO tail. The reader's read-until-quiet collector concatenates verbatim.
  {
    type DumpFn = NonNullable<DeviceDescriptor['reader']['dumpActivePresetBinary']>;
    const head = broadcastFrame(0x12, 0x51, [0x00, 0x00, 0x04]);
    const conn = mockConnect({
      responder: (out) => out[5] === 0x43
        ? [head, broadcastFrame(0x12, 0x52, [0x00, 0x08, 0x00]),
           broadcastFrame(0x12, 0x52, [0x00, 0x08, 0x01]),
           broadcastFrame(0x12, 0x52, [0x00, 0x08, 0x02])]
        : [],
      ackLatencyMs: 1,
    });
    const ctx = { conn, descriptor: FM9_DESCRIPTOR } as unknown as Parameters<DumpFn>[0];
    let dump: Awaited<ReturnType<DumpFn>> | undefined;
    let dumpErr: unknown;
    try { dump = await FM9_DESCRIPTOR.reader!.dumpActivePresetBinary!(ctx); } catch (e) { dumpErr = e; }
    check('FM9 export_preset returns a dump', dump !== undefined, String(dumpErr));
    check('FM9 export dump frame_count = 4 (head + 3 bodies)', dump?.frame_count === 4, String(dump?.frame_count));
    check('FM9 export dump byte_length == concatenated bytes', dump !== undefined && dump.byte_length === dump.bytes.length && dump.byte_length === head.length + 3 * broadcastFrame(0x12, 0x52, [0x00, 0x08, 0x00]).length,
      String(dump?.byte_length));
    check('FM9 export dump starts with the 0x51 head', !!dump && dump.bytes[0] === 0xf0 && dump.bytes[5] === 0x51, dump ? dump.bytes.slice(0, 6).join(',') : 'none');
    check('FM9 export dump format = fractal-gen3-edit-buffer-dump', dump?.format === 'fractal-gen3-edit-buffer-dump', dump?.format);
  }

  // export_preset rejects cleanly when the device answers a head with no body
  // (malformed/empty dump), rather than returning a 1-frame .syx.
  {
    type DumpFn = NonNullable<DeviceDescriptor['reader']['dumpActivePresetBinary']>;
    const conn = mockConnect({
      responder: (out) => out[5] === 0x43 ? [broadcastFrame(0x12, 0x51, [0x00, 0x00, 0x04])] : [],
      ackLatencyMs: 1,
    });
    const ctx = { conn, descriptor: FM9_DESCRIPTOR } as unknown as Parameters<DumpFn>[0];
    let threw = false;
    try { await FM9_DESCRIPTOR.reader!.dumpActivePresetBinary!(ctx); } catch { threw = true; }
    check('FM9 export_preset rejects a head-only (no body) dump', threw);
  }

  // export_preset(location=N): the STORED-preset dump (fn=0x03 request →
  // 0x77/0x78/0x79 reply), behind export_preset's `location` arg. Exercises
  // collectStoredPresetDump, the read-until-tail collector that had no mock/e2e
  // coverage (the active-buffer dump above uses a different fn=0x43/0x51 path).
  {
    type DumpFn = NonNullable<DeviceDescriptor['reader']['dumpStoredPresetBinary']>;
    const head = broadcastFrame(0x12, 0x77, [0x00, 0x01, 0x00, 0x40, 0x00]);
    const body1 = broadcastFrame(0x12, 0x78, [0x00, 0x08, 0x01]);
    const body2 = broadcastFrame(0x12, 0x78, [0x00, 0x08, 0x02]);
    const tail = broadcastFrame(0x12, 0x79, [0x00, 0x00, 0x00]);
    const conn = mockConnect({
      responder: (out) => (out[5] === 0x03 ? [head, body1, body2, tail] : []),
      ackLatencyMs: 1,
    });
    const ctx = { conn, descriptor: FM9_DESCRIPTOR } as unknown as Parameters<DumpFn>[1];
    let dump: Awaited<ReturnType<DumpFn>> | undefined;
    let dumpErr: unknown;
    try { dump = await FM9_DESCRIPTOR.reader!.dumpStoredPresetBinary!(0, ctx); } catch (e) { dumpErr = e; }
    check('FM9 export_preset(location) returns a stored dump', dump !== undefined, String(dumpErr));
    check('FM9 stored dump frame_count = 4 (head + 2 bodies + tail)', dump?.frame_count === 4, String(dump?.frame_count));
    check('FM9 stored dump byte_length == concatenated frames',
      dump !== undefined && dump.byte_length === head.length + body1.length + body2.length + tail.length, String(dump?.byte_length));
    check('FM9 stored dump format = fractal-gen3-stored-preset-dump', dump?.format === 'fractal-gen3-stored-preset-dump', dump?.format);
    check('FM9 stored dump starts with the 0x77 head', !!dump && dump.bytes[5] === 0x77, dump ? String(dump.bytes[5]) : 'none');
  }
  // Stored dump that answers a head but no 0x78 body (a stray non-dump frame
  // ends the burst) rejects cleanly rather than returning a head-only .syx.
  {
    type DumpFn = NonNullable<DeviceDescriptor['reader']['dumpStoredPresetBinary']>;
    const conn = mockConnect({
      responder: (out) => (out[5] === 0x03
        ? [broadcastFrame(0x12, 0x77, [0x00, 0x01, 0x00, 0x40, 0x00]), broadcastFrame(0x12, 0x76, [])]
        : []),
      ackLatencyMs: 1,
    });
    const ctx = { conn, descriptor: FM9_DESCRIPTOR } as unknown as Parameters<DumpFn>[1];
    let threw = false;
    try { await FM9_DESCRIPTOR.reader!.dumpStoredPresetBinary!(0, ctx); } catch { threw = true; }
    check('FM9 export_preset(location) rejects a head with no body', threw);
  }

  // get_preset(location=N): the STORED-preset WHOLE-DECODE path. Synthesize a
  // CRC-valid single-chunk stored dump carrying a known preset name + scene
  // names, replay it on the fn=0x03 request, and assert the reader runs the full
  // collect -> flatten -> decodeGen3PresetDump -> snapshotFromDecoded pipeline and
  // surfaces `whole_preset`. (The decode itself is exhaustively cross-validated in
  // verify-gen3-preset-body.ts; this covers the reader wiring + snapshot mapping.)
  function buildSyntheticStoredDump(model: number, presetName: string, sceneNames: string[]): number[][] {
    // Decompressed body: scene names live at body[4 + i*32] (32 bytes each).
    const body = new Uint8Array(0x300);
    for (let i = 0; i < 8 && i < sceneNames.length; i++) {
      const s = sceneNames[i];
      for (let j = 0; j < s.length && j < 31; j++) body[4 + i * 32 + j] = s.charCodeAt(j);
    }
    const comp = huffmanCompress(body);
    // raw_patch: 1 chunk = 1024 words = 2048 bytes. Header: CRC@0x04, name@0x08,
    // decompSize@0x48, compSize@0x4A, Huffman body@0x4C.
    const rawPatch = new Uint8Array(2048);
    for (let j = 0; j < presetName.length && j < 31; j++) rawPatch[0x08 + j] = presetName.charCodeAt(j);
    rawPatch[0x48] = body.length & 0xff; rawPatch[0x49] = (body.length >> 8) & 0xff;
    rawPatch[0x4a] = comp.length & 0xff; rawPatch[0x4b] = (comp.length >> 8) & 0xff;
    rawPatch.set(comp, 0x4c);
    const crc = computeRawPatchCrc(rawPatch);
    rawPatch[0x04] = crc & 0xff; rawPatch[0x05] = (crc >> 8) & 0xff;
    const packed = encode16to3(rawPatch); // 1024 words -> 3072 packed bytes
    // chunk payload = 2-byte discriminator + 3072 packed = 3074 (CHUNK_PAYLOAD_LEN).
    const chunkPayload = [0x00, 0x00, ...Array.from(packed)];
    return [
      broadcastFrame(model, 0x77, [0x00, 0x01, 0x00, 0x40, 0x00]),
      broadcastFrame(model, 0x78, chunkPayload),
      broadcastFrame(model, 0x79, [0x00, 0x00, 0x00]),
    ];
  }
  {
    type GetPresetFn = NonNullable<DeviceDescriptor['reader']['getPreset']>;
    const sceneNames = ['Clean', 'Crunch', 'Lead', 'Solo', 'Ambient', 'Dry', 'Bass', 'Verb'];
    const frames = buildSyntheticStoredDump(0x12, 'Mock Tone', sceneNames);
    const conn = mockConnect({ responder: (out) => (out[5] === 0x03 ? frames : []), ackLatencyMs: 1 });
    const ctx = { conn, descriptor: FM9_DESCRIPTOR } as unknown as Parameters<GetPresetFn>[0];
    let snap: Awaited<ReturnType<GetPresetFn>> | undefined;
    let err: unknown;
    try { snap = await FM9_DESCRIPTOR.reader!.getPreset!(ctx, { location: 5 }); } catch (e) { err = e; }
    check('FM9 get_preset(location) returns a snapshot', snap !== undefined, String(err));
    check('FM9 get_preset(location) name == decoded preset name', snap?.name === 'Mock Tone', String(snap?.name));
    check('FM9 get_preset(location) populates whole_preset', snap?.whole_preset !== undefined);
    check('FM9 get_preset(location) whole_preset.source = stored-dump', snap?.whole_preset?.source === 'stored-dump', String(snap?.whole_preset?.source));
    check('FM9 get_preset(location) reports crc_valid', snap?.whole_preset?.crc_valid === true);
    check('FM9 get_preset(location) decodes scene names', snap?.whole_preset?.scene_names?.[1] === 'Crunch', JSON.stringify(snap?.whole_preset?.scene_names?.slice(0, 2)));
    check('FM9 get_preset(location) scenes summary carries 8 scenes', snap?.scenes?.length === 8, String(snap?.scenes?.length));
    check('FM9 get_preset(location) model = FM9', snap?.whole_preset?.model === 'FM9', String(snap?.whole_preset?.model));
  }
  {
    type GetPresetFn = NonNullable<DeviceDescriptor['reader']['getPreset']>;
    const conn = mockConnect({ responder: () => [], ackLatencyMs: 1 });
    const ctx = { conn, descriptor: FM9_DESCRIPTOR } as unknown as Parameters<GetPresetFn>[0];
    let threw = false;
    try { await FM9_DESCRIPTOR.reader!.getPreset!(ctx, { location: -1 }); } catch { threw = true; }
    check('FM9 get_preset(location=-1) rejects a negative location', threw);
  }
}

await readerChecks();

// ── 9b. Live grid read (fn=0x01 sub=0x2E) + amp applicability ───────
//
// Drives the real DeviceReader.getPreset (active buffer) against the parity
// mock, which now answers the sub=0x2E grid query with a coherent grid (Input
// + the placed effect IDs). Confirms get_preset returns a positioned live_grid
// AND that the grid gates the fn=0x1F poll to placed blocks. Then exercises the
// adopted amp type-knob applicability (findCompatibleTypes) on the FM9 descriptor.
async function liveGridChecks(): Promise<void> {
  console.log('\nGen-3 live grid read + amp applicability (mock connection):');

  // (a) grid available → live_grid positioned, routing_omitted false.
  {
    const conn = mockConnect({
      responder: makeGen3BroadcastMockResponder({ modelByte: 0x12, placedEffectIds: [58, 66, 70] }),
      ackLatencyMs: 1,
    });
    const ctx = { conn, descriptor: FM9_DESCRIPTOR } as unknown as Parameters<NonNullable<DeviceDescriptor['reader']>['getParam']>[0];
    const snap = await FM9_DESCRIPTOR.reader!.getPreset!(ctx);
    const grid = snap.live_grid ?? [];
    check('FM9 get_preset(active) returns a non-empty live_grid', grid.length > 0, `len=${grid.length}`);
    check('FM9 live_grid cells carry integer row/col positions', grid.every((c) => Number.isInteger(c.row) && Number.isInteger(c.col)), JSON.stringify(grid[0]));
    check('FM9 live_grid contains the placed Amp', grid.some((c) => typeof c.name === 'string' && c.name.startsWith('Amp')), grid.map((c) => c.name).join(','));
    check('FM9 live_grid carries Input at col 0', grid.some((c) => c.col === 0 && /Input/i.test(c.name ?? '')), grid.map((c) => `${c.name}@${c.col}`).join(','));
    check('FM9 get_preset routing_omitted=false when grid read', snap._meta.routing_omitted === false, JSON.stringify(snap._meta.routing_omitted));
    check('FM9 get_preset slots populated from placed blocks', snap.slots.length > 0, `slots=${snap.slots.length}`);
  }

  // (b) no grid reply → graceful fallback (no live_grid, routing_omitted true,
  //     slots still populated via the full poll).
  {
    const conn = mockConnect({
      // Answer only the fn=0x1F poll; ignore the sub=0x2E grid query.
      responder: (out) =>
        makeGen3BroadcastMockResponder({ modelByte: 0x12, placedEffectIds: [58, 66, 70] })(
          out[5] === 0x01 && out[6] === 0x2e ? [] : out,
        ),
      ackLatencyMs: 1,
    });
    const ctx = { conn, descriptor: FM9_DESCRIPTOR } as unknown as Parameters<NonNullable<DeviceDescriptor['reader']>['getParam']>[0];
    const snap = await FM9_DESCRIPTOR.reader!.getPreset!(ctx);
    check('FM9 get_preset falls back gracefully when no grid reply (no live_grid)', snap.live_grid === undefined, JSON.stringify(snap.live_grid));
    check('FM9 get_preset fallback sets routing_omitted=true', snap._meta.routing_omitted === true, JSON.stringify(snap._meta.routing_omitted));
    check('FM9 get_preset fallback still polls placed blocks', snap.slots.length > 0, `slots=${snap.slots.length}`);
  }

  // (c) amp type-knob applicability (adopted from ai-tone-assistant).
  {
    const fct = FM9_DESCRIPTOR.findCompatibleTypes;
    check('FM9 descriptor implements findCompatibleTypes', typeof fct === 'function');
    if (typeof fct === 'function') {
      const depth = fct({ block: 'amp', params: ['depth'] });
      check('FM9 find_compatible_types amp+depth: applicability_known', depth.applicability_known === true);
      check('FM9 find_compatible_types amp+depth: a strict subset', depth.compatible_types.length > 0 && depth.compatible_types.length < depth.total_types, `${depth.compatible_types.length}/${depth.total_types}`);
      const drive = fct({ block: 'amp', params: ['drive'] });
      check('FM9 find_compatible_types amp+drive: universal (all amps)', drive.compatible_types.length === drive.total_types && drive.total_types === 331, `${drive.compatible_types.length}/${drive.total_types}`);
      const reverb = fct({ block: 'reverb', params: ['time'] });
      check('FM9 find_compatible_types non-amp: applicability_known false', reverb.applicability_known === false);
    }
  }
}

await liveGridChecks();

// ── 10. A6: SET value-echo → display_value, with sent-value fallback ─
//
// On accept, set_param confirms in DISPLAY units, not raw wire. When the
// device returns the synchronous fn=0x01 value-echo (normalized float), the
// writer prefers the DEVICE-quantized value; when no echo arrives (the
// common community-beta case), it falls back to decoding the value it sent.
// Both paths route through the calibration catalog.
async function setEchoChecks(): Promise<void> {
  console.log('\nA6: SET value-echo → display_value:');
  const reverbEffectId = resolveEffectId('reverb', 1);

  // float32 → LSB-first 5-septet (inverse of decode5SeptetFloat32).
  function packF32Septets(norm: number): number[] {
    const buf = new ArrayBuffer(4);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f[0] = norm;
    const v = u[0];
    return [v & 0x7f, (v >> 7) & 0x7f, (v >> 14) & 0x7f, (v >> 21) & 0x7f, (v >> 28) & 0x7f];
  }
  function valueEchoFrame(model: number, effectId: number, paramId: number, norm: number): number[] {
    const enc14 = (n: number) => [n & 0x7f, (n >> 7) & 0x7f];
    // F0 00 01 74 <model> 01 09 00 [eff] [pid] [f32 septets] <descriptor pad> cs F7
    const body = [
      0xf0, 0x00, 0x01, 0x74, model, 0x01, 0x09, 0x00,
      ...enc14(effectId), ...enc14(paramId), ...packF32Septets(norm),
      ...Array(40).fill(0),
    ];
    return [...body, fractalChecksum([...body, 0, 0]), 0xf7];
  }

  for (const { desc, modelByte, pbf } of [
    { desc: AXEFX3_DESCRIPTOR, modelByte: 0x10, pbf: PARAMS_BY_FAMILY },
    { desc: FM3_DESCRIPTOR, modelByte: 0x11, pbf: FM3_PARAMS_BY_FAMILY },
    { desc: FM9_DESCRIPTOR, modelByte: 0x12, pbf: FM9_PARAMS_BY_FAMILY },
  ]) {
    const mixPid = (pbf['REVERB'] ?? []).find((p) => p.name === 'REVERB_MIX')?.paramId;
    const schema = desc.blocks['reverb']?.params['mix'];
    check(`${desc.id} reverb.mix paramId + schema present`, mixPid !== undefined && schema !== undefined, String(mixPid));
    if (mixPid === undefined || schema === undefined) continue;

    // Echo path: device echoes normalized 0.5 → wire16 32767 → display via cal.
    {
      const conn = mockConnect({
        responder: (out) => (out[5] === 0x01 ? [valueEchoFrame(modelByte, reverbEffectId, mixPid, 0.5)] : []),
        ackLatencyMs: 1,
      });
      const ctx = { conn, descriptor: desc } as unknown as Parameters<NonNullable<DeviceDescriptor['writer']['setParam']>>[0];
      const r = await desc.writer.setParam!(ctx, 'reverb', 'mix', 100, undefined, 1);
      const expectWire = Math.round(0.5 * 65534);
      check(`${desc.id} set_param(reverb.mix) echo → wire_value ${expectWire} (device-quantized)`,
        r.wire_value === expectWire, JSON.stringify(r.wire_value));
      check(`${desc.id} set_param(reverb.mix) echo → display_value = decode(${expectWire})`,
        r.display_value === schema.decode(expectWire), JSON.stringify(r.display_value));
      check(`${desc.id} echo display_value differs from raw sent wire (100)`, r.display_value !== 100);
    }

    // Fallback path: no echo → confirm with decode(sent wire), in display units.
    {
      const conn = mockConnect({ responder: () => [], ackLatencyMs: 1 });
      const ctx = { conn, descriptor: desc } as unknown as Parameters<NonNullable<DeviceDescriptor['writer']['setParam']>>[0];
      const r = await desc.writer.setParam!(ctx, 'reverb', 'mix', 100, undefined, 1);
      check(`${desc.id} set_param(reverb.mix) no-echo → display_value = decode(100) (display units, not raw)`,
        r.display_value === schema.decode(100) && r.display_value !== 100, JSON.stringify(r.display_value));
      // Honest 2-state: a silent timeout (sent, not rejected, no device echo) is
      // NOT a confirmed write. Reporting it acked would be a wire-ack-not-audible
      // false success. It must report acked:false with an "unverified" warning
      // that is NOT a 0x64 rejection.
      check(`${desc.id} no-echo accept → acked:false (sent, unconfirmed; not a false success)`, r.acked === false);
      check(`${desc.id} no-echo accept → warning flags it unverified, not a 0x64 rejection`,
        /unverified|did not confirm/i.test(r.warning ?? '') && !/MULTIPURPOSE_RESPONSE/i.test(r.warning ?? ''),
        JSON.stringify(r.warning));
    }
  }
}
await setEchoChecks();

// ── 11. C10: enum set-by-name resolver (BK-093 write leg) ───────────
//
// name → ordinal (offline, decoded) → raw-id (capture-backed table). The
// shipped table now carries the FM9-captured REVERB_TYPE + FUZZ_TYPE write-leg
// points (REVERB ord 16→524, 45→529; FUZZ ord 15→523 Blues OD), so those names
// resolve `resolved`; a valid
// name WITHOUT a captured raw-id stays `capture_pending` (gated, no untested
// byte). More entries land as the getBlockString sweep extends the table.
console.log('\nC10: enum set-by-name resolver (name → read-roster ordinal):');
{
  // name → ordinal is fully decoded offline (case/whitespace tolerant). The
  // ordinal IS the float32 set value — no raw-id hop.
  const ord = resolveGen3EnumOrdinal('REVERB_TYPE', 'spring,  medium');
  check('resolveGen3EnumOrdinal(REVERB_TYPE, "spring,  medium") → ordinal 16 (tolerant)',
    'ordinal' in ord && ord.ordinal === 16, JSON.stringify(ord));

  // Reversed word order resolves too ("Music Hall" → the canonical "Hall, Music").
  const music = resolveGen3EnumOrdinal('REVERB_TYPE', 'Music Hall');
  check('resolveGen3EnumOrdinal(REVERB_TYPE, "Music Hall") → ordinal 45',
    'ordinal' in music && music.ordinal === 45, JSON.stringify(music));

  // FUZZ_TYPE: Blues OD resolves to ordinal 15 (the set value).
  const bluesOd = resolveGen3EnumOrdinal('FUZZ_TYPE', 'Blues OD');
  check('resolveGen3EnumOrdinal(FUZZ_TYPE, "Blues OD") → ordinal 15',
    'ordinal' in bluesOd && bluesOd.ordinal === 15, JSON.stringify(bluesOd));

  // Every valid name now resolves (no capture gate): "Room, Small" → ordinal 0.
  const roomSmall = resolveGen3EnumOrdinal('REVERB_TYPE', 'Room, Small');
  check('resolveGen3EnumOrdinal(REVERB_TYPE, "Room, Small") → ordinal 0 (no longer gated)',
    'ordinal' in roomSmall && roomSmall.ordinal === 0, JSON.stringify(roomSmall));

  // Unknown name → undefined ordinal with suggestions (no false ordinal).
  const unknown = resolveGen3EnumOrdinal('REVERB_TYPE', 'Not A Real Reverb');
  check('resolveGen3EnumOrdinal(REVERB_TYPE, bogus) → undefined ordinal + suggestions',
    'ordinal' in unknown && unknown.ordinal === undefined && unknown.suggestions.length > 0,
    JSON.stringify('ordinal' in unknown ? unknown.ordinal : unknown));

  // Non-enum param → noEnum.
  const noEnum = resolveGen3EnumOrdinal('REVERB_MIX', '50');
  check('resolveGen3EnumOrdinal(REVERB_MIX, ...) → noEnum (continuous param)',
    'noEnum' in noEnum, JSON.stringify(noEnum));
}

console.log('\nC11: 0x64 multipurpose-response reject predicate hardening:');
{
  const fm3 = createModernFractalCodec(0x11);
  // A genuine rejection: F0 00 01 74 11 64 [echoed_fn] [result_code] [cs] F7.
  const reject = [0xf0, 0x00, 0x01, 0x74, 0x11, 0x64, 0x01, 0x06, 0x00, 0xf7];
  check('reject [fn=01,code=06] is a multipurpose response', fm3.isMultipurposeResponse(reject) === true);
  const parsed = fm3.parseMultipurposeResponse(reject);
  check('reject parses → echoedFn 1, resultCode 6', parsed.echoedFn === 1 && parsed.resultCode === 6);
  check('reject matches when expectedFn echoes the sent fn (0x01)', fm3.isMultipurposeResponse(reject, 0x01) === true);
  check('reject REJECTED when expectedFn is a different op (0x0A) — echoed-fn guard',
    fm3.isMultipurposeResponse(reject, 0x0a) === false);
  // A longer 0x64 frame (e.g. an unsolicited tuner/tempo status stream) must NOT
  // be read as a reject, or its first two bytes become a garbage [fn,code].
  const stream = [0xf0, 0x00, 0x01, 0x74, 0x11, 0x64, 1, 2, 3, 4, 5, 6, 7, 8, 0x00, 0xf7];
  check('long 0x64 frame (payload>4) is NOT a reject — length guard',
    fm3.isMultipurposeResponse(stream) === false);
}

console.log('\nC12: 5-septet float32 codec vs independent captured vectors (ForgeFX / fm3-protocol):');
{
  // ForgeFX's FractalSysex.cs pins these against the sKuhLight/fm3-protocol
  // Python ref (FM3 fw 12.0) — a DIFFERENT provenance from ours (BoodieTraps /
  // our FM9 capture), so byte agreement is genuine cross-validation of the
  // gen-3 SET value field (float32 at payload pos 12, LSB-first 5×7).
  const hex5 = (a: readonly number[]) => a.map((b) => b.toString(16).padStart(2, '0')).join('');
  check('encode5SeptetFloat32(3740.5) → 0010272b04', hex5(encode5SeptetFloat32(3740.5)) === '0010272b04', hex5(encode5SeptetFloat32(3740.5)));
  check('encode5SeptetFloat32(55.2) → 4d19731204', hex5(encode5SeptetFloat32(55.2)) === '4d19731204', hex5(encode5SeptetFloat32(55.2)));
  check('decode5SeptetFloat32(00 10 27 2b 04) → 3740.5', decode5SeptetFloat32(0x00, 0x10, 0x27, 0x2b, 0x04) === 3740.5, String(decode5SeptetFloat32(0x00, 0x10, 0x27, 0x2b, 0x04)));
}

console.log('\nC13: signed-raw-semitone decode (PITCH/PLEX/SYNTH/REVERB shift, issue #6):');
{
  // Byte-exact against a real SET->GET hardware roundtrip (FM9 fw 11.0 + III
  // fw 25.04, 2026-06-18): sentWire 0/16384/32767/49151/65534 (the standard
  // normalized-continuous sweep across displayMin=-24..displayMax=24) read
  // back as raw wire 65512/65525/0/12/24. int16(65512) = -24, matching the
  // SENT value exactly — the device's register is a native signed int16, not
  // a renormalized 0..65534 field, so the standard linear decode gets the
  // SIGN wrong at every non-zero wire value. See catalog.ts
  // SIGNED_RAW_SEMITONE_PARAMS / makeSignedRawSemitoneDecode.
  const roundtripPairs: ReadonlyArray<readonly [wire: number, display: number]> = [
    [65512, -24], [65525, -11], [0, 0], [12, 12], [24, 24],
  ];
  for (const { desc, block, key } of [
    { desc: FM9_DESCRIPTOR, block: 'pitch', key: 'shift1' },
    { desc: FM9_DESCRIPTOR, block: 'plex_delay', key: 'shift1' },
    { desc: FM9_DESCRIPTOR, block: 'synth', key: 'shift1' },
    { desc: FM9_DESCRIPTOR, block: 'reverb', key: 'shift1' },
    { desc: AXEFX3_DESCRIPTOR, block: 'pitch', key: 'shift1' },
    { desc: AXEFX3_DESCRIPTOR, block: 'plex_delay', key: 'shift1' },
    { desc: AXEFX3_DESCRIPTOR, block: 'synth', key: 'shift1' },
    { desc: AXEFX3_DESCRIPTOR, block: 'reverb', key: 'shift1' },
  ]) {
    const schema = desc.blocks[block]?.params[key];
    const id = `${desc.id} ${block}.${key}`;
    if (!schema) { check(`${id} exists`, false, 'block/param not found'); continue; }
    for (const [wire, display] of roundtripPairs) {
      check(`${id} decode(${wire}) = ${display} (captured hardware wire)`, schema.decode(wire) === display, `got ${schema.decode(wire)}`);
    }
    // SET direction is UNCHANGED: the standard normalized-continuous encode
    // (the roundtrip's sentWire values were themselves the standard sweep).
    check(`${id} encode(-24) = 0`, schema.encode(-24) === 0, `got ${schema.encode(-24)}`);
    check(`${id} encode(24) = 65534`, schema.encode(24) === 65534, `got ${schema.encode(24)}`);
  }
  // FM3 shares the same firmware symbols (family-wide overlay list); no FM3
  // hardware roundtrip exists yet, but the wiring must still be live.
  const fm3Schema = FM3_DESCRIPTOR.blocks['pitch']?.params['shift1'];
  check('fm3 pitch.shift1 decode(65512) = -24 (family-wide, community-beta)', fm3Schema?.decode(65512) === -24, `got ${fm3Schema?.decode(65512)}`);
}

// ── Every advertised slug resolves through the WRITE path ──────────
//
// The defect this gate exists for: `writer.ts` resolved a placement by
// handing the descriptor SLUG to `resolveEffectId`, which matches display
// names ("Graphic EQ") and 3-letter group codes ("GEQ"), never slugs. Blocks
// whose slug happens to equal their display name worked; the other 15 per
// device did not, among them `graphic_eq`, `gate_expander`, `volume_pan`,
// `multitap_delay` and `parametric_eq`. Every one is advertised by
// describe_device and list_params, so an agent doing exactly what it was told
// got "Unknown Axe-Fx III block" naming a block the device really has, and on
// an FM9 it got the III's name in the bargain.
//
// The read paths were always correct (`resolveBlockOrThrow`), which is why
// this survived: reads and writes disagreed about what a block was called.
// So the assertion is a CROSS-CHECK, not a list: every slug the descriptor
// advertises must resolve the same way on the write path as on the read path,
// or refuse with a structured reason. A hardcoded roster would go stale; this
// cannot, because it is derived from what the device advertises.
{
  console.log('\nEvery advertised block slug resolves through the WRITE path:');
  for (const d of MODERN_FRACTAL_DESCRIPTORS) {
    const slugs = Object.keys(d.blocks);
    const broken: string[] = [];
    const refusedWithReason: string[] = [];
    for (const slug of slugs) {
      try {
        const conn = mockConnect({ responder: () => [], ackLatencyMs: 0 });
        await d.writer.setBypass!({ conn, descriptor: d } as never, slug, true);
      } catch (err) {
        const code = err instanceof DispatchError ? err.code : '(plain Error)';
        // `unknown_block` on a slug the descriptor itself advertises is the
        // bug. `capability_not_supported` is the honest answer for a block
        // with no addressable effect id (NAM, Global Block, Shunt, the
        // FC-only ones), and a plain Error is a defect in its own right
        // because it loses the code the dispatcher routes on.
        if (code === 'unknown_block' || code === '(plain Error)') broken.push(`${slug} [${code}]`);
        else if (code === 'capability_not_supported') refusedWithReason.push(slug);
      }
    }
    check(
      `${d.id}: all ${slugs.length} advertised slugs resolve or refuse with a reason (${refusedWithReason.length} not addressable)`,
      broken.length === 0,
      broken.length > 0 ? `unresolvable: ${broken.join(', ')}` : undefined,
    );
    // Self-coverage: if the roster ever came back empty this leg would pass
    // having checked nothing, which is precisely how the original defect hid.
    check(`${d.id}: the slug roster is non-empty (this leg measured something)`, slugs.length >= 20, `got ${slugs.length}`);
  }

  // A shunt is NOT a cleared cell: the grid word carries block type 0x08 plus
  // a sequential index (gridLayout.ts). set_block used to advertise "shunt" as
  // a synonym for "none" in its own error text and then refuse it. It must now
  // refuse with a reason that says why, and must never quietly send blockId 0.
  let shuntCode = '(no throw)';
  let shuntMsg = '';
  try {
    const conn = mockConnect({ responder: () => [], ackLatencyMs: 0 });
    await AXEFX3_DESCRIPTOR.writer.setBlock!(
      { conn, descriptor: AXEFX3_DESCRIPTOR } as never,
      { row: 1, col: 2 } as never,
      { block_type: 'shunt' } as never,
    );
  } catch (err) {
    shuntCode = err instanceof DispatchError ? err.code : '(plain Error)';
    shuntMsg = err instanceof Error ? err.message : '';
  }
  check('set_block refuses "shunt" rather than clearing the cell', shuntCode === 'capability_not_supported', `got ${shuntCode}`);
  check('the shunt refusal explains it is not an empty cell', /not an empty cell/i.test(shuntMsg), shuntMsg.slice(0, 90));
}

console.log('');
if (failures > 0) {
  console.error(`FAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log('All modern Fractal family checks passed.');
