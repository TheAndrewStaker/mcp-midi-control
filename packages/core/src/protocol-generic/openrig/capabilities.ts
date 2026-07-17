/**
 * OpenRig compatibility bridge: build the injectable `CapabilityLookup` the
 * pure `checkRigCompatibility` (in the zero-dependency `openrig` package) reads
 * to legality-check a rig's cross-device bindings.
 *
 * The `openrig` package cannot import this server's descriptor types (it stays
 * extractable), so it takes a GENERIC `CapabilityLookup`; THIS file is the
 * reference implementation that projects each registered descriptor's
 * compat-relevant capability (voice_map, external_tracks, control_sources) into
 * the `DeviceCompatProfile` the check consumes. Keyed by `server_device_id`
 * (= the registered descriptor `id`), which is how a manifest node references a
 * supported device.
 *
 * Rebuilt per call from the live registry (cheap; the registry changes in tests
 * via clearRegistry/registerDevice), so it always reflects the current fleet.
 */
import type { CapabilityLookup, DeviceCompatProfile } from 'openrig';

import { listRegisteredDevices } from '../registry.js';

/** Project the registered fleet's capabilities into an OpenRig capability lookup. */
export function descriptorCapabilityLookup(): CapabilityLookup {
  const byId = new Map<string, DeviceCompatProfile>();
  for (const desc of listRegisteredDevices()) {
    const caps = desc.capabilities;
    const profile: DeviceCompatProfile = { label: desc.display_name };
    if (caps.voice_map !== undefined) {
      profile.voice_map = Object.fromEntries(
        Object.entries(caps.voice_map).map(([role, v]) => [role, { channel: v.channel, note: v.note }]),
      );
    }
    if (caps.external_tracks !== undefined) profile.external_tracks = caps.external_tracks;
    if (caps.control_sources?.assignable_cc !== undefined) profile.assignable_cc = caps.control_sources.assignable_cc;
    if (caps.control_sources?.targets !== undefined) profile.control_targets = caps.control_sources.targets;
    byId.set(desc.id, profile);
  }
  return { get: (sid: string): DeviceCompatProfile | undefined => byId.get(sid) };
}
