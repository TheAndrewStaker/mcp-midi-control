/**
 * Fractal editor emulator + logger (two loopMIDI ports) — CLI.
 *
 * Captures the EDITOR-WRITE direction (what FM-Edit / Axe-Edit sends *to*
 * the device) with no hardware and no USBPcap, by pretending to be the
 * device on a pair of loopMIDI virtual ports. The transport + codec-backed
 * SimDevice loop lives in `sim/emulator.ts` (`runEmulator`); this is the thin
 * argv wrapper. The controlled-capture runner (`sim/controlled-capture.ts`)
 * calls the same `runEmulator` with per-capture instructions + auto-decode.
 *
 * ## Background (why this exists despite the negative primitive entry)
 *
 * `_negative/virtual-midi-bridge-interposition.md` said Fractal editors
 * filter class-compliant virtual ports out of their picker. That was
 * verified on AxeEdit II + AM4-Edit on Windows. It does NOT hold for
 * FM9-Edit: a loopMIDI port named "AXEloopMIDI Port" appears in the picker,
 * connects, and the editor reports "Connected! FM9 FW: ..." with NO hardware.
 * The editor's connection check is satisfied by seeing its own outbound bytes
 * return on its MIDI-In. This script sits in the middle across two ports.
 *
 * ## Topology (create TWO loopMIDI ports first)
 *
 *   loopMIDI port 1: "AXEloopMIDI Port"     (editor OUT -> us; we read it)
 *   loopMIDI port 2: "AXEloopMIDI Port 2"   (us -> editor IN; we write it)
 *
 *   Editor (FM-Edit) Preferences / Setup:
 *     MIDI Out  ->  AXEloopMIDI Port
 *     MIDI In   ->  AXEloopMIDI Port 2
 *
 * Keep the "AXE" name prefix on both ports; that prefix is the current best
 * hypothesis for why FM-Edit accepts the virtual port at all.
 *
 * ## Usage
 *
 *   # List input + output ports and exit:
 *   npx tsx scripts/_research/fractal-editor-emulator.ts
 *
 *   # Run the emulator (one ACTION per capture, note it in the filename):
 *   npx tsx scripts/_research/fractal-editor-emulator.ts \
 *     --in "AXEloopMIDI Port" --out "AXEloopMIDI Port 2" \
 *     --model 12 --log samples/captured/fm9-edit-blockset-r2c3.syx
 *
 * Press Ctrl+C to stop and print the summary. `samples/` is gitignored.
 */
import { runEmulator, printPorts } from './sim/emulator.js';

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const inNeedle = getFlag('in');
const outNeedle = getFlag('out');
const logArg = getFlag('log');
const modelByte = parseInt(getFlag('model') ?? '12', 16);

if (!inNeedle || !outNeedle || !logArg) {
  console.error('Fractal editor emulator + logger — captures editor-write SysEx with no hardware.\n');
  console.error('Usage:');
  console.error('  npx tsx scripts/_research/fractal-editor-emulator.ts \\');
  console.error('    --in "<input port substr>" --out "<output port substr>" \\');
  console.error('    --model 12 --log samples/captured/<device>-<action>.syx [--no-echo]\n');
  printPorts();
  console.error('\nCreate two loopMIDI ports first (keep the "AXE" name prefix). See the');
  console.error('header of this file for the editor In/Out wiring.');
  process.exit(inNeedle && outNeedle && logArg ? 1 : 0);
}

runEmulator({
  modelByte,
  inNeedle,
  outNeedle,
  logPath: logArg,
  seedPath: getFlag('seed'),
  echo: !hasFlag('no-echo'),
  rateCap: getFlag('rate-cap') ? parseInt(getFlag('rate-cap')!, 10) : undefined,
});
