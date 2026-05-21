import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeApplyPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/preset.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';

registerDevice(AXEFX2_DESCRIPTOR);

async function main(): Promise<void> {
  const r = await executeApplyPreset({
    port: 'axe-fx-ii',
    spec: {
      name: 'Test Crunch',
      slots: [
        { slot: { row: 2, col: 1 }, block_type: 'compressor' },
        { slot: { row: 2, col: 2 }, block_type: 'drive' },
        { slot: { row: 2, col: 3 }, block_type: 'amp' },
        { slot: { row: 2, col: 4 }, block_type: 'cab' },
        { slot: { row: 2, col: 5 }, block_type: 'delay' },
        { slot: { row: 2, col: 6 }, block_type: 'reverb' },
      ],
    },
    target_location: 666,
    save_authorized: true,
    on_active_preset_edited: 'discard',
  } as Parameters<typeof executeApplyPreset>[0]);
  console.log('Test Crunch restored:', JSON.stringify(r).slice(0, 200));
  setTimeout(()=>process.exit(0), 200);
}
main().catch(e => { console.error(e); process.exit(1); });
