/**
 * Dispatcher core — step-1 port resolution and step-5 connection setup.
 *
 * Every unified MCP tool routes through one of the `execute*` wrappers in
 * the sibling family files (`params.ts`, `navigation.ts`, etc.); each of
 * those wrappers starts by calling `requireDevice(port)` here, runs its
 * family-specific validation, then calls `openCtx(descriptor)` to obtain
 * the MIDI handle right before delegating to the descriptor's writer or
 * reader.
 */

import { ensureConnection } from '../../server-shared/connections.js';
import { createNullMidiConnection } from '../../midi/transport.js';
import {
  DispatchError,
  type DeviceDescriptor,
  type DispatchCtx,
  type DispatchErrorDetails,
} from '../types.js';
import { listRegisteredDevices, resolveDevice } from '../registry.js';

/**
 * Resolves `port` to a registered descriptor or throws a
 * `port_not_found` DispatchError with the list of known devices.
 */
export function requireDevice(port: string): DeviceDescriptor {
  const desc = resolveDevice(port);
  if (desc) return desc;
  const known = listRegisteredDevices()
    .map((d) => d.display_name)
    .join(', ');
  const details: DispatchErrorDetails = {
    valid_options: listRegisteredDevices().map((d) => d.display_name),
    retry_action: 'Call list_midi_ports to see what is connected.',
  };
  throw new DispatchError(
    'port_not_found',
    '(no device matched)',
    known.length > 0
      ? `No registered device matches port '${port}'. Known devices: ${known}.`
      : `No registered device matches port '${port}'. No devices are registered yet.`,
    details,
  );
}

/**
 * Multi-instance gate. Devices that don't advertise
 * `capabilities.has_block_instances` (AM4, Hydrasynth) cannot address a
 * second instance of a block type; passing `instance > 1` to them would
 * be silently dropped and the write would land on instance 1. Refuse it
 * loudly instead. `instance` of undefined / 1 is always allowed, so the
 * single-instance contract is unchanged.
 *
 * `path` is an optional caller label (e.g. `ops[3] amp.gain`) folded into
 * the error so batch callers can point at the offending entry.
 */
export function assertInstanceSupported(
  descriptor: DeviceDescriptor,
  instance: number | undefined,
  path?: string,
): void {
  if (instance === undefined || instance === 1) return;
  if (descriptor.capabilities.has_block_instances) return;
  throw new DispatchError(
    'capability_not_supported',
    descriptor.display_name,
    `${path ? `${path}: ` : ''}${descriptor.display_name} has a single instance of each block type, ` +
      `so instance ${instance} is not addressable (only instance 1). Drop the \`instance\` arg ` +
      `(or pass instance: 1). Multi-instance addressing is available on grid Fractal devices ` +
      `(Axe-Fx II / III / FM3 / FM9) and Novation Circuit Tracks (Synth 1 / 2).`,
  );
}

/**
 * Open the endpoint for a descriptor and bundle it into the `DispatchCtx`
 * envelope the writer / reader sees. Step-5 of the dispatcher's 6-step
 * lifecycle.
 *
 * Branches on `descriptor.transport.kind` (default `'midi'`):
 *   - `'midi'` / `'serial'`: open (or reuse) the MIDI handle via
 *     `ensureConnection`. Serial is transparent here — its `MidiConnection`
 *     factory is registered under the device label like any other.
 *   - `'storage'`: resolve the mounted-volume root, or throw
 *     `device_not_mounted`. `conn` is a null object (no MIDI in this mode).
 *   - `'hybrid'`: drive mounted → the storage context; else try the MIDI
 *     surface (the two surfaces are mutually exclusive by hardware mode). If
 *     NEITHER resolves (no drive AND no MIDI port), throw a hybrid-aware error
 *     naming both surfaces — a bare MIDI port-not-found would mis-direct a
 *     storage operation toward looking for a MIDI port it never needs.
 */
export function openCtx(descriptor: DeviceDescriptor): DispatchCtx {
  const kind = descriptor.transport?.kind ?? 'midi';
  const label = descriptor.connection_label ?? descriptor.id;

  if (kind === 'storage' || kind === 'hybrid') {
    const root = descriptor.transport?.resolveRoot?.();
    if (root !== undefined) {
      // Storage surface: no MIDI wire. The null conn throws loudly if a method
      // miswires itself to the wire; storage methods use `ctx.storage.root`.
      return { conn: createNullMidiConnection(descriptor.display_name), storage: { root }, descriptor };
    }
    if (kind === 'storage') {
      throw new DispatchError(
        'device_not_mounted',
        descriptor.display_name,
        descriptor.transport?.notMountedHint
          ?? `${descriptor.display_name} is a storage-transport device but is not mounted as a drive. ` +
             'Connect it and put it in its mass-storage / disk mode, then retry.',
      );
    }
    // hybrid + not mounted → the MIDI surface might still be live (the device in
    // its MIDI mode). Try it; if it ALSO fails, neither surface is connected, so
    // surface both paths instead of a MIDI-only port-not-found.
    try {
      const conn = ensureConnection(label);
      return { conn, descriptor, reconnect: () => ensureConnection(label, true) };
    } catch (midiErr) {
      const storageHint = descriptor.transport?.notMountedHint
        ?? `${descriptor.display_name} is not mounted as a drive (its mass-storage mode).`;
      const midiDetail = midiErr instanceof Error ? midiErr.message.split('\n')[0] : String(midiErr);
      throw new DispatchError(
        'device_not_mounted',
        descriptor.display_name,
        `${descriptor.display_name} is not connected on either surface. ` +
          `For file/storage operations (kit + sample authoring): ${storageHint} ` +
          `For its MIDI surface (preset recall / pad triggers): connect it in its MIDI mode so a MIDI port ` +
          `appears (none matched right now: ${midiDetail}).`,
      );
    }
  }

  const conn = ensureConnection(label);
  // `reconnect` force-reopens the handle for this label (closing the stale one)
  // and returns the fresh handle, so a transfer that hits a dead handle can
  // recover itself instead of erroring out to the user.
  return { conn, descriptor, reconnect: () => ensureConnection(label, true) };
}
