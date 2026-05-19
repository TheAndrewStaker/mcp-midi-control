#!/usr/bin/env node
/**
 * Post-install MIDI device check for MCP MIDI Control.
 *
 * Invoked by `installer/verify-midi.cmd` after the user runs setup.cmd.
 * Asks node-midi directly which ports the OS is exposing, classifies
 * each by supported-device family (AM4 / Axe-Fx II / Axe-Fx III /
 * Hydrasynth), and prints a human-readable report.
 *
 * Bypasses Claude Desktop entirely — useful when the AM4 tools don't
 * appear in Claude and the user can't tell whether the problem is on
 * the OS / driver / cable side or on the Claude Desktop side.
 *
 * Exit codes:
 *   0 = at least one supported device fully present (input + output)
 *   1 = no supported device, OR only partial (one direction missing)
 */

import { listMidiPorts } from '@mcp-midi-control/core/midi/transport.js';

interface DeviceFamily {
  label: string;
  needles: string[];
  driverNote?: string;
}

const FAMILIES: DeviceFamily[] = [
  {
    label: 'Fractal AM4',
    needles: ['am4'],
    driverNote: 'AM4 driver: https://www.fractalaudio.com/am4-downloads/',
  },
  {
    label: 'Fractal Axe-Fx II',
    needles: ['axe-fx ii', 'axefx ii', 'axe-fx2', 'axefx2'],
    driverNote:
      'Axe-Fx II driver: https://www.fractalaudio.com/axe-fx-ii-downloads/',
  },
  {
    label: 'Fractal Axe-Fx III',
    needles: ['axe-fx iii', 'axefx iii', 'axe-fx3', 'axefx3'],
    driverNote:
      'Axe-Fx III is class-compliant USB MIDI; no driver needed.',
  },
  {
    label: 'ASM Hydrasynth',
    needles: ['hydrasynth', 'asm hydra'],
    driverNote:
      'Hydrasynth is class-compliant USB MIDI; no driver needed.',
  },
];

function classify(name: string): DeviceFamily | undefined {
  const lower = name.toLowerCase();
  return FAMILIES.find((f) => f.needles.some((n) => lower.includes(n)));
}

const allNeedles = FAMILIES.flatMap((f) => f.needles);
const { inputs, outputs } = listMidiPorts(allNeedles);

console.log('');
console.log('MCP MIDI Control — MIDI device check');
console.log('');

const detected: DeviceFamily[] = [];
const partial: DeviceFamily[] = [];
const reportLines: string[] = [];

for (const family of FAMILIES) {
  const inMatch = inputs.find((p) => classify(p.name)?.label === family.label);
  const outMatch = outputs.find((p) => classify(p.name)?.label === family.label);
  if (!inMatch && !outMatch) continue;

  if (inMatch && outMatch) {
    reportLines.push(`  [OK]      ${family.label}`);
    detected.push(family);
  } else {
    reportLines.push(`  [PARTIAL] ${family.label}`);
    partial.push(family);
  }
  reportLines.push(`            input:  ${inMatch ? `"${inMatch.name}"` : '(not visible)'}`);
  reportLines.push(`            output: ${outMatch ? `"${outMatch.name}"` : '(not visible)'}`);
}

if (reportLines.length === 0) {
  console.log('Supported devices detected: (none)');
} else {
  console.log('Supported devices detected:');
  console.log(reportLines.join('\n'));
}
console.log('');

console.log('All MIDI ports the OS is exposing:');
console.log('  Inputs:');
if (inputs.length === 0) {
  console.log('    (none)');
} else {
  for (const p of inputs) {
    const fam = classify(p.name);
    console.log(`    [${p.index}] ${p.name}${fam ? `  -> ${fam.label}` : ''}`);
  }
}
console.log('  Outputs:');
if (outputs.length === 0) {
  console.log('    (none)');
} else {
  for (const p of outputs) {
    const fam = classify(p.name);
    console.log(`    [${p.index}] ${p.name}${fam ? `  -> ${fam.label}` : ''}`);
  }
}
console.log('');

if (detected.length > 0) {
  const names = detected.map((d) => d.label).join(', ');
  console.log(`Result: ${names} fully connected.`);
  console.log('');
  console.log('Next: open Claude Desktop and try:');
  console.log('  "Using mcp-midi-control, list the MIDI ports you can see."');
  console.log('');
  process.exit(0);
}

if (partial.length > 0) {
  console.log('Result: device(s) partially detected (input OR output missing).');
  console.log('');
  console.log('Only one direction is usually a loose USB cable, a driver that');
  console.log('registered just one direction, or the OS still enumerating.');
  console.log('Try unplug + replug the USB cable, then re-run this check.');
  console.log('');
  for (const f of partial) if (f.driverNote) console.log(`  ${f.driverNote}`);
  console.log('');
  process.exit(1);
}

console.log('Result: no supported devices detected.');
console.log('');
console.log('Check the following:');
console.log('  - Device is powered on.');
console.log('  - USB cable is fully seated at both ends.');
console.log('  - Driver is installed:');
for (const f of FAMILIES) if (f.driverNote) console.log(`      ${f.driverNote}`);
console.log('  - Try unplug + replug the USB cable, then re-run this check.');
console.log('');
process.exit(1);
