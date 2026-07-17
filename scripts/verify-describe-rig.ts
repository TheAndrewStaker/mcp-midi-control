/**
 * Golden: `describe_rig` rolls up the registered device set with correct
 * transport / preset_class / pattern-target fields, without opening any handle.
 *
 * Registers a representative MIDI device (AM4) and the hybrid storage device
 * (SPD-SX) into a clean registry, then asserts the roster shape. `connected` is
 * hardware-dependent (best-effort port scan), so it is checked for TYPE only,
 * never an exact value.
 *
 * Run via:  npx tsx scripts/verify-describe-rig.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { clearRegistry, registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import {
  executeDescribeRig,
  clearRigManifestCache,
  clearRigInventoryCache,
  RIG_MANIFEST_ENV,
  RIG_INVENTORY_ENV,
} from '@mcp-midi-control/core/protocol-generic/dispatcher.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { SPD_SX_DESCRIPTOR } from '@mcp-midi-control/spd-sx/descriptor.js';
import { RC_505_MK2_DESCRIPTOR } from '@mcp-midi-control/boss-rc/descriptor.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '@mcp-midi-control/circuit-tracks/descriptor.js';
import type { Rig } from 'openrig';

let failures = 0;
const fail = (msg: string) => { console.error(`  FAIL ${msg}`); failures++; };
const ok = (msg: string) => console.log(`  OK   ${msg}`);
const assert = (cond: boolean, msg: string) => { cond ? ok(msg) : fail(msg); };

// Hermetic: the manifest surface is env-var-driven, so clear it for the base
// roster golden (a stray MCP_RIG_MANIFEST in the environment must not leak in).
const priorManifest = process.env[RIG_MANIFEST_ENV];
delete process.env[RIG_MANIFEST_ENV];
clearRigManifestCache();
const priorInventory = process.env[RIG_INVENTORY_ENV];
delete process.env[RIG_INVENTORY_ENV];
clearRigInventoryCache();

console.log('describe_rig roster:');
clearRegistry();
registerDevice(AM4_DESCRIPTOR);
registerDevice(SPD_SX_DESCRIPTOR);

const rig = executeDescribeRig();

assert(rig.total_registered === 2, `total_registered = 2 (got ${rig.total_registered})`);
assert(rig.devices.length === 2, 'devices array has both entries');
assert(typeof rig.connected_count === 'number' && rig.connected_count <= 2, 'connected_count is a bounded number');
assert(/serial|FM3/i.test(rig.note), 'note flags the serial-detection caveat');
assert(rig.manifest === undefined, 'no manifest configured -> manifest field omitted');

const am4 = rig.devices.find((d) => d.id === 'am4');
assert(am4 !== undefined, 'AM4 present in the roster');
if (am4) {
  assert(am4.transport === 'midi', `AM4 transport = midi (got ${am4.transport})`);
  assert(am4.preset_class === 'layout', `AM4 preset_class = layout (got ${am4.preset_class})`);
  assert(typeof am4.connected === 'boolean', 'AM4 connected is a boolean (best-effort, hardware-dependent)');
  assert(am4.name === AM4_DESCRIPTOR.display_name, 'AM4 name echoes the descriptor display_name');
}

const spd = rig.devices.find((d) => d.id === 'spd-sx');
assert(spd !== undefined, 'SPD-SX present in the roster');
if (spd) {
  assert(spd.transport === 'hybrid', `SPD-SX transport = hybrid (got ${spd.transport})`);
  assert(spd.preset_class === 'voice', `SPD-SX preset_class = voice (got ${spd.preset_class})`);
  assert(spd.pattern_target === true, 'SPD-SX is a pattern target (has pattern_realizers)');
  assert(spd.summary !== undefined && spd.summary.length > 0, 'SPD-SX carries a one-line capability summary');
}

// --- manifest surface: a configured rig.json is read, validated, drift-reported ---
console.log('\ndescribe_rig manifest:');
{
  // Fixture references am4 + spd-sx (both registered here), rc-505mk2 (NOT
  // registered in this golden -> unresolved), and an opaque passive cab.
  const fixture: Rig = {
    openrig_version: '0.1',
    id: 'test-manifest',
    name: 'Test manifest rig',
    nodes: [
      { id: 'am4', name: 'AM4', server_device_id: 'am4', identity: { manufacturer: 'Fractal', family: 'AM4' }, roles: ['sound_source', 'effect'], ports: [{ id: 'out_lr', kind: 'audio_out' }, { id: 'midi_out', kind: 'midi_din_out' }] },
      { id: 'spdsx', name: 'SPD-SX', server_device_id: 'spd-sx', identity: { manufacturer: 'Roland', family: 'SPD-SX' }, roles: ['sampler'], ports: [{ id: 'midi_in', kind: 'midi_din_in' }] },
      { id: 'rc505', name: 'RC-505', server_device_id: 'rc-505mk2', identity: { manufacturer: 'Boss', family: 'RC-505mk2' }, roles: ['looper'], ports: [{ id: 'midi_in', kind: 'midi_din_in' }] },
      { id: 'cab', name: 'Passive cab', server_device_id: null, identity: { manufacturer: null, family: 'passive-cab' }, roles: ['monitor'], ports: [{ id: 'in', kind: 'audio_in' }], capabilities: null },
    ],
    edges: [
      { id: 'am4-audio', from: { node: 'am4', port: 'out_lr' }, to: { node: 'cab', port: 'in' }, directed: true, signal: { kind: 'audio', channels: ['L', 'R'] } },
    ],
  };
  const tmp = path.join(os.tmpdir(), `openrig-describe-rig-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(fixture), 'utf8');
  try {
    process.env[RIG_MANIFEST_ENV] = tmp;
    clearRigManifestCache();
    const withManifest = executeDescribeRig();
    const m = withManifest.manifest;
    assert(m !== undefined && m.configured === true, 'manifest present -> manifest.configured = true');
    assert(m?.error === undefined, `manifest loads without error (got ${m?.error})`);
    assert(m?.name === 'Test manifest rig' && m?.node_count === 4 && m?.edge_count === 1, 'manifest summary echoes id/name/counts');
    assert(m?.validation?.ok === true, `manifest validates clean (errors: ${JSON.stringify(m?.validation?.errors)})`);
    assert(m?.drift?.opaque_node_count === 1, `drift counts the one opaque node (got ${m?.drift?.opaque_node_count})`);
    assert(m?.drift?.unresolved_server_device_ids.includes('rc-505mk2') === true, 'drift flags rc-505mk2 as unresolved (not registered in this golden)');
    const accounted = [...(m?.drift?.declared_present ?? []), ...(m?.drift?.declared_absent ?? [])].sort();
    assert(JSON.stringify(accounted) === JSON.stringify(['am4', 'spd-sx']), `registered manifest devices are accounted present-or-absent (got ${JSON.stringify(accounted)})`);
    assert(/manifest/i.test(withManifest.note), 'note mentions the loaded manifest');
  } finally {
    fs.rmSync(tmp, { force: true });
    // restore the environment for any downstream test in the same process
    if (priorManifest === undefined) delete process.env[RIG_MANIFEST_ENV];
    else process.env[RIG_MANIFEST_ENV] = priorManifest;
    clearRigManifestCache();
  }
}

// --- malformed manifest (valid JSON, not a rig) -> graceful error, roster intact ---
console.log('\ndescribe_rig malformed manifest:');
{
  const tmp = path.join(os.tmpdir(), `openrig-describe-rig-bad-${process.pid}.json`);
  fs.writeFileSync(tmp, '{}', 'utf8'); // valid JSON, missing nodes/edges
  try {
    process.env[RIG_MANIFEST_ENV] = tmp;
    clearRigManifestCache();
    const bad = executeDescribeRig();
    assert(bad.manifest?.configured === true && bad.manifest?.error !== undefined, 'malformed manifest -> manifest.error set (not a crash)');
    assert(bad.manifest?.validation === undefined, 'malformed manifest -> no validation attempted');
    assert(bad.total_registered === 2 && bad.devices.length === 2, 'malformed manifest -> device roster still intact (not lost to a throw)');
  } finally {
    fs.rmSync(tmp, { force: true });
    if (priorManifest === undefined) delete process.env[RIG_MANIFEST_ENV];
    else process.env[RIG_MANIFEST_ENV] = priorManifest;
    clearRigManifestCache();
  }
}

// --- drift dedups a server_device_id shared by two physical units of one model ---
console.log('\ndescribe_rig drift dedup:');
{
  const dupFixture: Rig = {
    openrig_version: '0.1',
    id: 'dup',
    name: 'Dup rig',
    nodes: [
      { id: 'am4-1', name: 'AM4 #1', server_device_id: 'am4', identity: { manufacturer: 'Fractal', family: 'AM4' }, roles: ['sound_source'], ports: [{ id: 'midi_out', kind: 'midi_din_out' }] },
      { id: 'am4-2', name: 'AM4 #2', server_device_id: 'am4', identity: { manufacturer: 'Fractal', family: 'AM4' }, roles: ['sound_source'], ports: [{ id: 'midi_out', kind: 'midi_din_out' }] },
    ],
    edges: [],
  };
  const tmp = path.join(os.tmpdir(), `openrig-describe-rig-dup-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(dupFixture), 'utf8');
  try {
    process.env[RIG_MANIFEST_ENV] = tmp;
    clearRigManifestCache();
    const dup = executeDescribeRig();
    const d = dup.manifest?.drift;
    const am4Count = [...(d?.declared_present ?? []), ...(d?.declared_absent ?? [])].filter((x) => x === 'am4').length;
    assert(am4Count === 1, `two nodes sharing server_device_id am4 -> counted once in drift (got ${am4Count})`);
  } finally {
    fs.rmSync(tmp, { force: true });
    if (priorManifest === undefined) delete process.env[RIG_MANIFEST_ENV];
    else process.env[RIG_MANIFEST_ENV] = priorManifest;
    clearRigManifestCache();
  }
}

// --- compatibility: cross-device bindings are agreement- + capability-checked ---
console.log('\ndescribe_rig compatibility:');
{
  // Register the full binding-relevant fleet so capability-legality has data:
  // RC-505mk2 (assignable_cc), Circuit (external_tracks), SPD-SX (voice_map).
  clearRegistry();
  registerDevice(AM4_DESCRIPTOR);
  registerDevice(SPD_SX_DESCRIPTOR);
  registerDevice(RC_505_MK2_DESCRIPTOR);
  registerDevice(CIRCUIT_TRACKS_DESCRIPTOR);

  const bindings = [
    {
      id: 'looper_track3_trigger',
      from: { node: 'am4', emits: { node: 'am4', type: 'cc', channel: 5, cc: 80 } },
      to: { node: 'rc505', expects: { node: 'rc505', type: 'cc', channel: 5, cc: 80, target: 'TRK3 REC/PLY' } },
    },
    {
      id: 'drum_note_map',
      from: { node: 'circuit', emits: { node: 'circuit', type: 'note', channel: 4, note_map: 'GM' } },
      to: { node: 'spdsx', expects: { node: 'spdsx', type: 'note', channel: 4, note_map: 'GM' } },
    },
  ];
  const nodes = [
    { id: 'am4', name: 'AM4', server_device_id: 'am4', identity: { manufacturer: 'Fractal', family: 'AM4' }, roles: ['sound_source'], ports: [{ id: 'midi_out', kind: 'midi_din_out' }] },
    { id: 'rc505', name: 'RC-505', server_device_id: 'rc-505mk2', identity: { manufacturer: 'Boss', family: 'RC-505mk2' }, roles: ['looper'], ports: [{ id: 'midi_in', kind: 'midi_din_in' }] },
    { id: 'circuit', name: 'Circuit', server_device_id: 'circuit-tracks', identity: { manufacturer: 'Novation', family: 'Circuit Tracks' }, roles: ['sequencer'], ports: [{ id: 'midi2', kind: 'midi_din_out' }] },
    { id: 'spdsx', name: 'SPD-SX', server_device_id: 'spd-sx', identity: { manufacturer: 'Roland', family: 'SPD-SX' }, roles: ['sampler'], ports: [{ id: 'midi_in', kind: 'midi_din_in' }] },
  ];

  const runWith = (bs: unknown[]): ReturnType<typeof executeDescribeRig>['manifest'] => {
    const fixture = { openrig_version: '0.1', id: 'compat-rig', name: 'Compat rig', nodes, edges: [], bindings: bs } as unknown as Rig;
    const tmp = path.join(os.tmpdir(), `openrig-compat-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(fixture), 'utf8');
    try {
      process.env[RIG_MANIFEST_ENV] = tmp;
      clearRigManifestCache();
      return executeDescribeRig().manifest;
    } finally {
      fs.rmSync(tmp, { force: true });
      if (priorManifest === undefined) delete process.env[RIG_MANIFEST_ENV];
      else process.env[RIG_MANIFEST_ENV] = priorManifest;
      clearRigManifestCache();
    }
  };

  // healthy: both bindings line up + are capability-legal
  const healthy = runWith(bindings);
  assert(healthy?.compatibility !== undefined, 'compatibility present on the manifest summary');
  assert(healthy?.compatibility?.ok === true, `healthy bindings -> compatibility.ok = true (issues: ${JSON.stringify(healthy?.compatibility?.issues)})`);
  assert(healthy?.compatibility?.checked_capabilities === true, 'capability legality ran (descriptors registered)');
  const looper = healthy?.compatibility?.bindings.find((b) => b.id === 'looper_track3_trigger');
  assert(looper?.status === 'consistent' && looper?.capability === 'passed', 'looper trigger: consistent + capability passed (CC#80 legal on the RC-505)');
  const drums = healthy?.compatibility?.bindings.find((b) => b.id === 'drum_note_map');
  assert(drums?.status === 'consistent' && drums?.capability === 'passed', 'drum note map: consistent + capability passed (GM pads on the SPD-SX)');

  // broken: an illegal assign-source CC is rejected end-to-end through describe_rig
  const brokenBindings = JSON.parse(JSON.stringify(bindings));
  brokenBindings[0].from.emits.cc = 40;
  brokenBindings[0].to.expects.cc = 40; // agreed, but CC#40 is not an RC-505 assignable source
  const broken = runWith(brokenBindings);
  assert(broken?.compatibility?.ok === false, 'illegal assign-source CC -> compatibility.ok = false');
  assert(broken?.compatibility?.issues.some((i) => i.code === 'assign-source-illegal') === true, 'the illegal CC surfaces as assign-source-illegal');
  assert(healthy?.audio !== undefined, 'audio-output report present on the manifest summary');
}

// --- audio: an instrument whose audio is not patched to the output is flagged ---
console.log('\ndescribe_rig audio-output:');
{
  clearRegistry();
  registerDevice(AM4_DESCRIPTOR);
  const fixture = {
    openrig_version: '0.1', id: 'audio-rig', name: 'Audio rig',
    nodes: [
      { id: 'synth', name: 'Synth', server_device_id: null, identity: { manufacturer: null, family: 'synth' }, roles: ['sound_source'], ports: [{ id: 'out', kind: 'audio_out' }], capabilities: null },
      { id: 'pa', name: 'PA', server_device_id: null, identity: { manufacturer: null, family: 'pa' }, roles: ['monitor'], ports: [{ id: 'in', kind: 'audio_in' }], capabilities: null },
    ],
    edges: [], // the synth's audio out is NOT patched to the PA
  } as unknown as Rig;
  const tmp = path.join(os.tmpdir(), `openrig-audio-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(fixture), 'utf8');
  try {
    process.env[RIG_MANIFEST_ENV] = tmp;
    clearRigManifestCache();
    const m = executeDescribeRig().manifest;
    assert(m?.audio?.ok === false, 'unpatched instrument -> audio.ok = false');
    assert(m?.audio?.instruments.find((i) => i.id === 'synth')?.status === 'no_output', 'the unpatched synth reads no_output');
    assert(m?.audio?.issues.some((i) => i.code === 'instrument-no-audio-output') === true, 'a no-audio-output warning is surfaced');
  } finally {
    fs.rmSync(tmp, { force: true });
    if (priorManifest === undefined) delete process.env[RIG_MANIFEST_ENV];
    else process.env[RIG_MANIFEST_ENV] = priorManifest;
    clearRigManifestCache();
  }
}

// --- inventory: owned gear + in-rig-vs-spare cross-reference (§11) ---
console.log('\ndescribe_rig inventory:');
{
  clearRegistry();
  registerDevice(AM4_DESCRIPTOR);
  const rigFx = { openrig_version: '0.1', id: 'inv-rig', name: 'Inv rig',
    nodes: [{ id: 'am4', name: 'AM4', server_device_id: 'am4', identity: { manufacturer: 'Fractal', family: 'AM4' }, roles: ['sound_source'], ports: [{ id: 'midi_out', kind: 'midi_din_out' }] }],
    edges: [] } as unknown as Rig;
  const invFx = { openrig_version: '0.1', id: 'my-inv', name: 'My gear', devices: [
    { id: 'am4', name: 'Fractal AM4', identity: { manufacturer: 'Fractal', family: 'AM4' }, server_device_id: 'am4' },
    { id: 'fm3', name: 'Fractal FM3', identity: { manufacturer: 'Fractal', family: 'FM3' }, server_device_id: 'fm3' },
  ] };
  const rigTmp = path.join(os.tmpdir(), `openrig-inv-rig-${process.pid}.json`);
  const invTmp = path.join(os.tmpdir(), `openrig-inv-${process.pid}.json`);
  fs.writeFileSync(rigTmp, JSON.stringify(rigFx), 'utf8');
  fs.writeFileSync(invTmp, JSON.stringify(invFx), 'utf8');
  try {
    process.env[RIG_MANIFEST_ENV] = rigTmp;
    process.env[RIG_INVENTORY_ENV] = invTmp;
    clearRigManifestCache(); clearRigInventoryCache();
    const iv = executeDescribeRig().inventory;
    assert(iv?.configured === true && iv?.error === undefined, 'inventory present + loads clean');
    assert(iv?.device_count === 2 && iv?.validation?.ok === true, 'inventory device count + validates clean');
    assert(iv?.report?.in_rig === 1 && iv?.report?.spare === 1, `in_rig=1 (am4), spare=1 (fm3) (got ${iv?.report?.in_rig}/${iv?.report?.spare})`);
    assert(iv?.report?.devices.find((d) => d.id === 'am4')?.status === 'in_rig', 'am4 is in_rig');
    assert(iv?.report?.devices.find((d) => d.id === 'fm3')?.status === 'spare', 'fm3 is spare (owned, not wired)');
  } finally {
    fs.rmSync(rigTmp, { force: true }); fs.rmSync(invTmp, { force: true });
    if (priorManifest === undefined) delete process.env[RIG_MANIFEST_ENV]; else process.env[RIG_MANIFEST_ENV] = priorManifest;
    if (priorInventory === undefined) delete process.env[RIG_INVENTORY_ENV]; else process.env[RIG_INVENTORY_ENV] = priorInventory;
    clearRigManifestCache(); clearRigInventoryCache();
  }
}

clearRegistry();
console.log(failures === 0 ? '\ndescribe_rig golden passed.' : `\n${failures} describe_rig assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
