/**
 * Test whether save_preset actually commits the working buffer to flash.
 *
 * Sequence:
 *   1. Current state: wire 666 working buffer should have input_drive=9.5
 *      (from previous experiment), and save_preset claims it saved.
 *   2. Read input_drive NOW (working buffer).
 *   3. Switch to wire 0 (different preset, forces working buffer eject).
 *   4. Switch BACK to wire 666 (loads from flash).
 *   5. Read input_drive again.
 *
 *   - If step 5 shows 9.5 → save committed to flash. Then the issue is
 *     fn 0x03 returning a cached snapshot rather than fresh flash bytes.
 *   - If step 5 shows the pre-set value (~6.0) → save_preset is the no-op.
 */

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeSwitchPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { executeGetParam } from '@mcp-midi-control/core/protocol-generic/dispatcher/params.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';

registerDevice(AXEFX2_DESCRIPTOR);

async function readDrive(label: string): Promise<number | undefined> {
  const r = await executeGetParam({ port: 'axe-fx-ii', block: 'amp', name: 'input_drive' });
  const dv = (r as { display_value?: number }).display_value;
  console.log(`  ${label}: display_value = ${dv}`);
  return dv;
}

async function main(): Promise<void> {
  console.log('Step A: read input_drive on currently-loaded preset');
  const initial = await readDrive('initial (whatever is loaded)');
  console.log('');

  console.log('Step B: switch to wire 0 (preset display=1, "59 Bassguy")');
  const sw0 = await executeSwitchPreset({ port: 'axe-fx-ii', location: 1, on_active_preset_edited: 'discard' });
  console.log(`  ${(sw0 as { info?: string }).info ?? JSON.stringify(sw0).slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 300));
  await readDrive('after switch to display 1 (wire 0)');
  console.log('');

  console.log('Step C: switch back to wire 666 (display=666, "Test Crunch")');
  const sw666 = await executeSwitchPreset({ port: 'axe-fx-ii', location: 666, on_active_preset_edited: 'discard' });
  console.log(`  ${(sw666 as { info?: string }).info ?? JSON.stringify(sw666).slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 300));
  const afterReload = await readDrive('after reload of wire 666');
  console.log('');

  console.log('=== VERDICT ===');
  if (afterReload === undefined) {
    console.log('  could not read input_drive — abort');
  } else if (Math.abs(afterReload - 9.5) < 0.1) {
    console.log('  ✅ save_preset COMMITTED: post-reload value = 9.5 (matches what we set)');
    console.log('  → fn 0x03 dump must be returning a cached snapshot, not fresh flash');
  } else {
    console.log(`  ❌ save_preset DID NOT COMMIT: post-reload value = ${afterReload} (not 9.5)`);
    console.log(`     working buffer was eject + reload from flash, and flash has the OLD value`);
    console.log(`     this means executeSavePreset is the broken link`);
  }
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error(e); process.exit(1); });
