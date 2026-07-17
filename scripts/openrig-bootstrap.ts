/**
 * openrig:bootstrap — emit a starter OpenRig rig manifest (rig.json) seeded from
 * every registered device. Nodes only: the physical cables, opaque gear, clock
 * topology, and cross-device bindings the server CANNOT see are added by hand
 * afterward (OPENRIG-SCHEMA.md §6, "seed, don't dictate"). The output validates
 * clean. Pipe it to a private, gitignored file to start a real rig:
 *
 *   npm run build            # the script imports each package's dist
 *   npm run openrig:bootstrap > docs/_private/rig/rig.json
 *
 * then set MCP_RIG_MANIFEST to that path so describe_rig reads it.
 *
 * The registration list mirrors packages/server-all/src/server/index.ts (the
 * shipped roster). A new device added there must be added here too; both consume
 * the same descriptors.
 */
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { bootstrapRigFromRegistry } from '@mcp-midi-control/core/protocol-generic/dispatcher.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR, AX8_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { AXEFXGEN1_DESCRIPTOR } from '@mcp-midi-control/fractal-gen1/descriptor.js';
import { MODERN_FRACTAL_DESCRIPTORS } from '@mcp-midi-control/fractal-gen3/device.js';
import { HYDRASYNTH_DESCRIPTOR } from '@mcp-midi-control/hydrasynth/descriptor.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '@mcp-midi-control/circuit-tracks/descriptor.js';
import { SPD_SX_DESCRIPTOR } from '@mcp-midi-control/spd-sx/descriptor.js';
import { VE500_DESCRIPTOR } from '@mcp-midi-control/ve-500/descriptor.js';
import { RC_505_MK2_DESCRIPTOR, RC_600_DESCRIPTOR } from '@mcp-midi-control/boss-rc/descriptor.js';

for (const descriptor of MODERN_FRACTAL_DESCRIPTORS) registerDevice(descriptor);
registerDevice(AXEFXGEN1_DESCRIPTOR);
registerDevice(AX8_DESCRIPTOR);
registerDevice(AXEFX2_DESCRIPTOR);
registerDevice(AM4_DESCRIPTOR);
registerDevice(HYDRASYNTH_DESCRIPTOR);
registerDevice(CIRCUIT_TRACKS_DESCRIPTOR);
registerDevice(SPD_SX_DESCRIPTOR);
registerDevice(VE500_DESCRIPTOR);
registerDevice(RC_505_MK2_DESCRIPTOR);
registerDevice(RC_600_DESCRIPTOR);

const rig = bootstrapRigFromRegistry({ id: 'my-rig', name: 'My rig' });
process.stdout.write(`${JSON.stringify(rig, null, 2)}\n`);
