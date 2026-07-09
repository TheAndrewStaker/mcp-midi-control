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

import { clearRegistry, registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeDescribeRig } from '@mcp-midi-control/core/protocol-generic/dispatcher.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { SPD_SX_DESCRIPTOR } from '@mcp-midi-control/spd-sx/descriptor.js';

let failures = 0;
const fail = (msg: string) => { console.error(`  FAIL ${msg}`); failures++; };
const ok = (msg: string) => console.log(`  OK   ${msg}`);
const assert = (cond: boolean, msg: string) => { cond ? ok(msg) : fail(msg); };

console.log('describe_rig roster:');
clearRegistry();
registerDevice(AM4_DESCRIPTOR);
registerDevice(SPD_SX_DESCRIPTOR);

const rig = executeDescribeRig();

assert(rig.total_registered === 2, `total_registered = 2 (got ${rig.total_registered})`);
assert(rig.devices.length === 2, 'devices array has both entries');
assert(typeof rig.connected_count === 'number' && rig.connected_count <= 2, 'connected_count is a bounded number');
assert(/serial|FM3/i.test(rig.note), 'note flags the serial-detection caveat');

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

clearRegistry();
console.log(failures === 0 ? '\ndescribe_rig golden passed.' : `\n${failures} describe_rig assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
