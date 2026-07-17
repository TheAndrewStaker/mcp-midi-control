/**
 * OpenRig Phase C: the server-side descriptor -> DeviceSeed adapter.
 *
 * The OpenRig package (`openrig`) stays zero-dependency and server-agnostic, so
 * its `bootstrapRig` takes a GENERIC `DeviceSeed[]`, not this server's descriptor
 * types (see packages/openrig/src/bootstrap.ts). THIS file is the reference
 * implementation's bridge: it maps a registered `DeviceDescriptor` to a
 * `DeviceSeed`, deriving the OpenRig-facing metadata (identity, roles, ports)
 * the descriptor does not itself carry.
 *
 * Per the spec's "seed, don't dictate" rule (OPENRIG-SCHEMA.md §6): this seeds
 * NODES from what the server can see (registered devices + each descriptor's
 * transport / voice_map / external_tracks). The physical cables, opaque gear,
 * clock topology, and cross-device bindings the server CANNOT see are added by
 * the human afterward in the rig manifest. So the bootstrap is a best-effort
 * starting point, not the finished rig.
 *
 * Roles / identity are NOT descriptor fields (a descriptor models wire protocol,
 * not rig role), so a small per-device table supplies them for the shipped
 * fleet, with a generic capability-derived fallback for any future device the
 * table does not name. This is OpenRig metadata (manufacturer + rig role), never
 * a restatement of device capability.
 */
import type { DeviceSeed } from 'openrig';
import type { BootstrapOptions, Rig, Role } from 'openrig';
import { bootstrapRig } from 'openrig';
import type { DeviceDescriptor, TransportKind } from '../types.js';
import { listRegisteredDevices } from '../registry.js';
import type { Port } from 'openrig';

/** Natural manufacturer per registered descriptor id (the Identity type-key). */
const MANUFACTURER_BY_ID: Readonly<Record<string, string>> = {
  am4: 'Fractal',
  'axe-fx-ii': 'Fractal',
  ax8: 'Fractal',
  'axe-fx-gen1': 'Fractal',
  'axe-fx-iii': 'Fractal',
  fm3: 'Fractal',
  fm9: 'Fractal',
  vp4: 'Fractal',
  hydrasynth: 'ASM',
  'circuit-tracks': 'Novation',
  'spd-sx': 'Roland',
  've-500': 'Boss',
  'rc-505mk2': 'Boss',
  'rc-600': 'Boss',
};

/**
 * OpenRig rig-roles per registered descriptor id (the fixed core enum). These
 * are the rig-level roles a working musician would assign; they are not derivable
 * from wire-protocol capabilities alone (a looper / clock-master / mixer role
 * lives in how the box is used, not in its param set). A device the table does
 * not name falls back to `deriveRolesGeneric`.
 */
const ROLES_BY_ID: Readonly<Record<string, readonly Role[]>> = {
  am4: ['sound_source', 'effect'],
  'axe-fx-ii': ['sound_source', 'effect'],
  ax8: ['sound_source', 'effect'],
  'axe-fx-gen1': ['sound_source', 'effect'],
  'axe-fx-iii': ['sound_source', 'effect'],
  fm3: ['sound_source', 'effect'],
  fm9: ['sound_source', 'effect'],
  vp4: ['effect'],
  hydrasynth: ['sound_source'],
  'circuit-tracks': ['sound_source', 'sequencer'],
  'spd-sx': ['sampler', 'sound_source'],
  've-500': ['effect', 'sound_source'],
  'rc-505mk2': ['looper', 'clock_master', 'midi_router', 'mixer'],
  'rc-600': ['looper', 'clock_master', 'mixer'],
};

/**
 * Descriptors whose device is USB-CDC serial, not USB MIDI. The FM3's serial
 * transport is NOT declared on the descriptor (the gen3 factory sets no
 * transport; the serial path is keyed on `connection_label:'fm3'` inside the
 * connection factory), so the adapter special-cases it by id.
 */
const SERIAL_IDS: ReadonlySet<string> = new Set(['fm3']);

/** Every shipped device has an audio output; a future pure-controller lists here. */
const NO_AUDIO_IDS: ReadonlySet<string> = new Set<string>();

function transportOf(desc: DeviceDescriptor): TransportKind {
  if (SERIAL_IDS.has(desc.id)) return 'serial';
  return desc.transport?.kind ?? 'midi';
}

/** Strip a known manufacturer prefix from the display name to get the model. */
function familyOf(desc: DeviceDescriptor, manufacturer: string | null): string {
  if (manufacturer !== null && desc.display_name.startsWith(`${manufacturer} `)) {
    return desc.display_name.slice(manufacturer.length + 1);
  }
  return desc.display_name;
}

/**
 * Capability-derived roles for a device the per-id table does not name. Weaker
 * than the curated table (it cannot know looper / clock-master / mixer, which
 * are usage roles), but keeps a future device from seeding with zero roles.
 */
function deriveRolesGeneric(desc: DeviceDescriptor): Role[] {
  const roles = new Set<Role>();
  const caps = desc.capabilities;
  if (caps.external_tracks && Object.keys(caps.external_tracks).length > 0) roles.add('sequencer');
  if (caps.voice_map && Object.keys(caps.voice_map).length > 0) roles.add('sampler');
  switch (desc.preset_class) {
    case 'voice':
      roles.add('sound_source');
      break;
    case 'effect':
      roles.add('effect');
      break;
    case 'layout':
    default:
      roles.add('sound_source');
      roles.add('effect');
      break;
  }
  return [...roles];
}

/**
 * Best-effort ports for a device with no hand-authored ports. MIDI/hybrid get
 * 5-pin DIN in+out; a serial device gets a single usb_serial port; a sequencer's
 * outward note tracks (`external_tracks`) become named out-ports so a rig's
 * host-track -> device wiring is reconstructable from an edge's from-port
 * (deriveRigLinks). Audio out is added unless the device has none.
 */
function buildPorts(desc: DeviceDescriptor, transport: TransportKind, hasAudio: boolean): Port[] {
  const ports: Port[] = [];
  if (transport === 'serial') {
    ports.push({ id: 'usb', kind: 'usb_serial', label: 'USB (serial)' });
  } else if (transport === 'storage') {
    // Storage-only: no live MIDI port to seed (kit recall is over the drive).
  } else {
    // midi + hybrid: the hybrid devices here (SPD-SX, RC-505/600) also carry
    // real 5-pin DIN MIDI alongside their storage surface.
    ports.push({ id: 'midi_in', kind: 'midi_din_in', label: 'MIDI IN' });
    ports.push({ id: 'midi_out', kind: 'midi_din_out', label: 'MIDI OUT' });
  }
  const ext = desc.capabilities.external_tracks;
  if (ext) {
    for (const track of Object.keys(ext)) {
      ports.push({ id: track, kind: 'midi_din_out', label: `${track.toUpperCase()} (sequencer track)`, group: track });
    }
  }
  if (hasAudio) ports.push({ id: 'audio_out', kind: 'audio_out', label: 'AUDIO OUT', audio: 'stereo' });
  return ports;
}

/**
 * Map one registered descriptor to an OpenRig `DeviceSeed`. Pure: reads only the
 * descriptor + the per-id metadata tables, no I/O.
 */
export function descriptorToSeed(desc: DeviceDescriptor): DeviceSeed {
  const manufacturer = MANUFACTURER_BY_ID[desc.id] ?? null;
  const transport = transportOf(desc);
  const hasAudio = !NO_AUDIO_IDS.has(desc.id);
  const roles = ROLES_BY_ID[desc.id] ?? deriveRolesGeneric(desc);
  return {
    server_device_id: desc.id,
    name: desc.display_name,
    identity: { manufacturer, family: familyOf(desc, manufacturer) },
    roles: [...roles],
    ports: buildPorts(desc, transport, hasAudio),
    transport,
    has_audio: hasAudio,
  };
}

/**
 * Bootstrap a starter rig manifest from every registered device (§6). Produces
 * the nodes; the human authors the cables + bindings the server cannot see. The
 * result validates clean. This backs `npm run openrig:bootstrap` and the
 * `describe_rig` "no manifest configured" hint.
 */
export function bootstrapRigFromRegistry(opts: BootstrapOptions = {}): Rig {
  const seeds = listRegisteredDevices().map(descriptorToSeed);
  return bootstrapRig(seeds, opts);
}
