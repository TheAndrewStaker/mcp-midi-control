/**
 * Bootstrap a rig manifest from a set of device seeds (§6: "seed, don't
 * dictate"). The server produces the seeds by adapting its registered
 * descriptors (`listRegisteredDevices()` + each descriptor's transport / roles /
 * ports); this function turns them into `Node`s. To keep openrig extractable
 * and zero-dependency, `bootstrapRig` takes the GENERIC `DeviceSeed` shape, NOT
 * server descriptor types. The descriptor -> DeviceSeed adapter lives in the
 * reference implementation (server), not here.
 *
 * Bootstrap seeds NODES only. The physical cables (edges) and the cross-device
 * bindings are what the server CANNOT see, so the human adds them by voice
 * afterward (§6). A node-only rig is valid (no dangling endpoints).
 */
import type { Identity, Node, Port, Rig, Role } from './types.js';
import { OPENRIG_VERSION } from './types.js';

/**
 * The minimal, server-agnostic description of a supported device the bootstrap
 * needs. The reference implementation maps a registered descriptor to this.
 */
export interface DeviceSeed {
  /** The registered descriptor id. Becomes `node.id` + `node.server_device_id`. */
  server_device_id: string;
  /** Display name. */
  name: string;
  identity?: Identity;
  /** Roles the descriptor implies (sampler, sequencer, looper, ...). */
  roles?: Role[];
  /** Explicit ports, when the server can infer them. Overrides the defaults. */
  ports?: Port[];
  /** Transport hint, used to pick default ports when `ports` is absent. */
  transport?: 'midi' | 'serial' | 'storage' | 'hybrid';
  /** Add a default audio output port. */
  has_audio?: boolean;
}

export interface BootstrapOptions {
  /** Rig id (a slug). Default "my-rig". */
  id?: string;
  /** Rig display name. Default "My rig". */
  name?: string;
}

/** Default port set for a device with no explicit ports, keyed on transport. */
function defaultPorts(seed: DeviceSeed): Port[] {
  const ports: Port[] = [];
  switch (seed.transport) {
    case 'serial':
      // FM3-class: MIDI over USB-CDC serial, no DIN.
      ports.push({ id: 'usb', kind: 'usb_serial', label: 'USB (serial)' });
      break;
    case 'storage':
      // A device driven over mass storage has no live MIDI port to seed.
      break;
    case 'hybrid':
      ports.push({ id: 'usb', kind: 'usb_midi', label: 'USB MIDI' });
      break;
    case 'midi':
    default:
      ports.push({ id: 'midi_in', kind: 'midi_din_in', label: 'MIDI IN' });
      ports.push({ id: 'midi_out', kind: 'midi_din_out', label: 'MIDI OUT' });
      break;
  }
  if (seed.has_audio) ports.push({ id: 'audio_out', kind: 'audio_out', label: 'AUDIO OUT', audio: 'stereo' });
  return ports;
}

function seedToNode(seed: DeviceSeed): Node {
  return {
    id: seed.server_device_id,
    name: seed.name,
    server_device_id: seed.server_device_id,
    identity: seed.identity ?? { manufacturer: null, family: seed.server_device_id },
    roles: seed.roles ?? [],
    ports: seed.ports ?? defaultPorts(seed),
  };
}

/**
 * Build a starter rig manifest from device seeds. Produces the nodes; edges and
 * bindings are left empty for the human to author (the cables and cross-device
 * contracts the server cannot observe, §6). The result validates clean.
 */
export function bootstrapRig(seeds: readonly DeviceSeed[], opts: BootstrapOptions = {}): Rig {
  return {
    openrig_version: OPENRIG_VERSION,
    id: opts.id ?? 'my-rig',
    name: opts.name ?? 'My rig',
    nodes: seeds.map(seedToNode),
    edges: [],
  };
}
