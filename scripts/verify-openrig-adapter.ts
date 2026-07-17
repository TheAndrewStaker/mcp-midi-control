/**
 * Golden: the OpenRig Phase C server bridge — the descriptor -> DeviceSeed
 * adapter, the registry bootstrap, and the manifest-derived rig links.
 *
 * Registers a representative slice of the real fleet into a clean registry and
 * asserts the seed metadata (roles / identity / transport / ports), that the
 * full-registry bootstrap validates clean (openrig validateRig), and that
 * deriveRigLinks / resolveRigLinks reconstruct the host-track -> device wiring
 * from a manifest (superseding MCP_RIG_LINKS).
 *
 * Run via:  npx tsx scripts/verify-openrig-adapter.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { clearRegistry, registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import {
  descriptorToSeed,
  bootstrapRigFromRegistry,
  deriveRigLinks,
  resolveRigLinks,
  clearRigLinksCache,
  clearRigManifestCache,
  RIG_MANIFEST_ENV,
} from '@mcp-midi-control/core/protocol-generic/dispatcher.js';
import { validateRig, type Rig } from 'openrig';

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { SPD_SX_DESCRIPTOR } from '@mcp-midi-control/spd-sx/descriptor.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '@mcp-midi-control/circuit-tracks/descriptor.js';
import { RC_505_MK2_DESCRIPTOR } from '@mcp-midi-control/boss-rc/descriptor.js';
import { MODERN_FRACTAL_DESCRIPTORS } from '@mcp-midi-control/fractal-gen3/device.js';

let failures = 0;
const fail = (msg: string) => { console.error(`  FAIL ${msg}`); failures++; };
const ok = (msg: string) => console.log(`  OK   ${msg}`);
const assert = (cond: boolean, msg: string) => { cond ? ok(msg) : fail(msg); };
const eq = <T>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

const FM3 = MODERN_FRACTAL_DESCRIPTORS.find((d) => d.id === 'fm3');

console.log('openrig adapter (descriptor -> seed):');
clearRegistry();
registerDevice(AM4_DESCRIPTOR);
registerDevice(SPD_SX_DESCRIPTOR);
registerDevice(CIRCUIT_TRACKS_DESCRIPTOR);
registerDevice(RC_505_MK2_DESCRIPTOR);
if (FM3) registerDevice(FM3);

// --- AM4: amp modeler = sound_source + effect, midi transport, Fractal/AM4 ---
{
  const s = descriptorToSeed(AM4_DESCRIPTOR);
  assert(s.server_device_id === 'am4', 'AM4 seed id = am4');
  assert(eq(s.roles, ['sound_source', 'effect']), `AM4 roles = [sound_source, effect] (got ${JSON.stringify(s.roles)})`);
  assert(s.identity?.manufacturer === 'Fractal' && s.identity?.family === 'AM4', 'AM4 identity = Fractal / AM4 (manufacturer stripped from display name)');
  assert(s.transport === 'midi', `AM4 transport = midi (got ${s.transport})`);
  const kinds = (s.ports ?? []).map((p) => p.kind);
  assert(kinds.includes('midi_din_in') && kinds.includes('midi_din_out') && kinds.includes('audio_out'), 'AM4 ports = DIN in/out + audio out');
}

// --- SPD-SX: sampler, hybrid transport, Roland/SPD-SX ---
{
  const s = descriptorToSeed(SPD_SX_DESCRIPTOR);
  assert(eq(s.roles, ['sampler', 'sound_source']), `SPD-SX roles = [sampler, sound_source] (got ${JSON.stringify(s.roles)})`);
  assert(s.transport === 'hybrid', `SPD-SX transport = hybrid (got ${s.transport})`);
  assert(s.identity?.manufacturer === 'Roland' && s.identity?.family === 'SPD-SX', 'SPD-SX identity = Roland / SPD-SX');
}

// --- Circuit Tracks: sequencer + external-track named out-ports ---
{
  const s = descriptorToSeed(CIRCUIT_TRACKS_DESCRIPTOR);
  assert(s.roles?.includes('sequencer') === true, 'Circuit Tracks has the sequencer role');
  const portIds = (s.ports ?? []).map((p) => p.id);
  const ext = CIRCUIT_TRACKS_DESCRIPTOR.capabilities.external_tracks ?? {};
  assert(Object.keys(ext).every((t) => portIds.includes(t)), `Circuit external tracks seeded as named out-ports (${Object.keys(ext).join(',')} in ${portIds.join(',')})`);
}

// --- RC-505: the curated usage roles the descriptor can't derive ---
{
  const s = descriptorToSeed(RC_505_MK2_DESCRIPTOR);
  assert(eq(s.roles, ['looper', 'clock_master', 'midi_router', 'mixer']), `RC-505 roles = looper/clock_master/midi_router/mixer (got ${JSON.stringify(s.roles)})`);
  assert(s.identity?.manufacturer === 'Boss', 'RC-505 manufacturer = Boss');
}

// --- FM3: serial transport special-case (descriptor declares no transport) ---
if (FM3) {
  const s = descriptorToSeed(FM3);
  assert(s.transport === 'serial', `FM3 transport special-cased to serial (got ${s.transport})`);
  assert((s.ports ?? []).some((p) => p.kind === 'usb_serial'), 'FM3 seeded with a usb_serial port');
} else {
  fail('FM3 descriptor not found in MODERN_FRACTAL_DESCRIPTORS');
}

// --- bootstrap from the full registry validates clean ---
{
  const rig = bootstrapRigFromRegistry({ id: 'test-rig', name: 'Test rig' });
  const v = validateRig(rig);
  assert(rig.nodes.length === 5, `bootstrap: one node per registered device (got ${rig.nodes.length})`);
  assert(rig.edges.length === 0, 'bootstrap: no edges (human authors cables)');
  assert(v.errors.length === 0, `bootstrap: validates with no errors (got ${JSON.stringify(v.errors)})`);
}

// --- deriveRigLinks: a sequencer note edge reconstructs the track -> device link ---
console.log('openrig rig links (manifest supersedes MCP_RIG_LINKS):');
const SEQ_RIG: Rig = {
  openrig_version: '0.1',
  id: 'seq-rig',
  name: 'Seq rig',
  nodes: [
    { id: 'circuit', name: 'Circuit Tracks', server_device_id: 'circuit-tracks', identity: { manufacturer: 'Novation', family: 'Circuit Tracks' }, roles: ['sequencer'], ports: [{ id: 'midi2', kind: 'midi_din_out' }] },
    { id: 'spdsx', name: 'SPD-SX', server_device_id: 'spd-sx', identity: { manufacturer: 'Roland', family: 'SPD-SX' }, roles: ['sampler'], ports: [{ id: 'midi_in', kind: 'midi_din_in' }] },
  ],
  edges: [
    { id: 'circuit-to-spdsx', from: { node: 'circuit', port: 'midi2' }, to: { node: 'spdsx', port: 'midi_in' }, directed: true, signal: { kind: 'midi', signals: [{ type: 'note', channel: 4, note_map: 'GM' }] } },
  ],
};
{
  const links = deriveRigLinks(SEQ_RIG);
  assert(links['midi2'] === 'spd-sx', `deriveRigLinks: midi2 -> spd-sx (got ${JSON.stringify(links)})`);
}

// --- resolveRigLinks: manifest present -> derived; absent -> env fallback ---
{
  const tmp = path.join(os.tmpdir(), `openrig-adapter-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(SEQ_RIG), 'utf8');
  const priorManifest = process.env[RIG_MANIFEST_ENV];
  const priorLinks = process.env.MCP_RIG_LINKS;
  try {
    process.env[RIG_MANIFEST_ENV] = tmp;
    delete process.env.MCP_RIG_LINKS;
    clearRigManifestCache();
    clearRigLinksCache();
    const resolved = resolveRigLinks();
    assert(resolved['midi2'] === 'spd-sx', 'resolveRigLinks: manifest-derived when MCP_RIG_MANIFEST is set');

    delete process.env[RIG_MANIFEST_ENV];
    process.env.MCP_RIG_LINKS = JSON.stringify({ midi1: 'hydrasynth' });
    clearRigManifestCache();
    clearRigLinksCache();
    const envLinks = resolveRigLinks();
    assert(envLinks['midi1'] === 'hydrasynth' && envLinks['midi2'] === undefined, 'resolveRigLinks: falls back to MCP_RIG_LINKS with no manifest');
  } finally {
    fs.rmSync(tmp, { force: true });
    if (priorManifest === undefined) delete process.env[RIG_MANIFEST_ENV]; else process.env[RIG_MANIFEST_ENV] = priorManifest;
    if (priorLinks === undefined) delete process.env.MCP_RIG_LINKS; else process.env.MCP_RIG_LINKS = priorLinks;
    clearRigManifestCache();
    clearRigLinksCache();
  }
}

clearRegistry();
console.log(failures === 0 ? '\nopenrig adapter golden passed.' : `\n${failures} openrig adapter assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
