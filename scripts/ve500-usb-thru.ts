/**
 * VE-500 `system_midi.midi_usb_out_thru` — turn the unit into a MIDI MONITOR of
 * its own 5-pin input.
 *
 * Roland's Parameter Guide, MIDI menu, THRU:
 *   "Specifies whether MIDI messages received at the MIDI IN connector are
 *    output from the USB port."
 *
 * With this ON, opening the "VE-500" USB input port shows EXACTLY what is
 * arriving at the DIN MIDI In — the far end of the
 * Circuit -> MicroFreak -> VE-500 chain — with no cable moves at all. It is the
 * only way to observe that hop directly.
 *
 * ## Scope of the change, stated plainly
 *
 * This is a SYSTEM parameter, not a patch parameter. It therefore PERSISTS
 * across patch recalls and power cycles: unlike the SHIFT diagnostic, recalling
 * a patch does NOT undo it. It must be reverted explicitly.
 *
 * It touches NO audio setting. It does not alter the vocal signal path, the
 * pitch-correct block, or what front-of-house hears. It only adds a copy of
 * inbound DIN traffic to the USB port. The one real consequence is that any
 * host listening on the VE-500's USB port will now also see that traffic.
 *
 * ## Revert
 *
 *   npx tsx scripts/ve500-usb-thru.ts off
 *
 * That writes it straight back to 0 (the factory default, and the value read
 * from this unit before any change). Nothing else is touched, so the revert is
 * complete and exact.
 *
 * Every write is verified by read-back, because a write that silently did
 * nothing is indistinguishable from a success otherwise.
 *
 * Run:
 *   npx tsx scripts/ve500-usb-thru.ts on     # enable the monitor
 *   npx tsx scripts/ve500-usb-thru.ts off    # REVERT to the default
 *   npx tsx scripts/ve500-usb-thru.ts read   # read only, change nothing
 */
import { connect } from '../packages/core/src/midi/transport.js';
import {
  findParam,
  buildGetParam,
  buildSetParam,
  paramReplyMatcher,
  decodeParamReply,
} from '../packages/roland-midi/src/ve-500/index.js';

const MODE = (process.argv[2] ?? 'read').toLowerCase();
if (!['on', 'off', 'read'].includes(MODE)) {
  console.error(`Unknown mode "${MODE}". Use: on | off | read`);
  process.exit(1);
}

const def = findParam('system_midi', 'midi_usb_out_thru');
if (!def) {
  console.error('Could not resolve system_midi.midi_usb_out_thru in the VE-500 catalog.');
  process.exit(1);
}

const label = (v: number): string => (v === 1
  ? 'ON  — DIN MIDI In is mirrored to the USB port (monitor active)'
  : 'OFF — DIN MIDI In is not mirrored (factory default)');

const conn = connect({ needles: ['ve-500', 've500'], notFoundLeadIn: 'VE-500 not found.' });

async function read(): Promise<number | undefined> {
  const waiter = conn.receiveSysExMatching(paramReplyMatcher(def!), 800).catch(() => undefined);
  conn.send(buildGetParam(def!));
  const reply = await waiter;
  if (reply === undefined) return undefined;
  const v = decodeParamReply(def!, reply);
  return typeof v === 'number' ? v : undefined;
}

console.log('\n=== VE-500 system_midi.midi_usb_out_thru ===\n');

const before = await read();
if (before === undefined) {
  console.error('No reply to the read. Aborting rather than writing blind.');
  conn.close();
  process.exit(1);
}
console.log(`  current: ${before}  ${label(before)}`);

if (MODE === 'read') {
  console.log('\nRead-only mode. Nothing was written.\n');
  conn.close();
  process.exit(0);
}

const target = MODE === 'on' ? 1 : 0;
if (before === target) {
  console.log('  already at the requested value. No write needed.\n');
  conn.close();
  process.exit(0);
}

console.log(`  writing: ${target}  ${label(target)}`);
conn.send(buildSetParam(def, target));

await new Promise((r) => setTimeout(r, 250));
const after = await read();

if (after === undefined) {
  console.log('\n  VERIFY FAILED: no reply to the read-back. Treat the value as UNKNOWN.\n');
  conn.close();
  process.exit(1);
}
console.log(`  read-back: ${after}  ${label(after)}`);
if (after !== target) {
  console.log(`\n  VERIFY FAILED: expected ${target}, device holds ${after}.\n`);
  conn.close();
  process.exit(1);
}
console.log('  VERIFIED.\n');

if (target === 1) {
  console.log('────────────────────────────────────────────────────────────────');
  console.log('  The VE-500 USB input port is now a live monitor of its DIN In.');
  console.log('  Watch the true far end of the chain with:');
  console.log('');
  console.log('    npx tsx scripts/probe-chain-monitor.ts circuit,microfreak,"#2" 60 --focus=3');
  console.log('');
  console.log('  (use #2 rather than a name: this machine enumerates TWO ports');
  console.log('   called "VE-500" after a replug, and the name would match the');
  console.log('   stale one. Confirm the index from the port list it prints.)');
  console.log('');
  console.log('  ⚠ THIS IS A SYSTEM SETTING AND PERSISTS across patch recalls and');
  console.log('    power cycles. Recalling a patch will NOT undo it. Revert with:');
  console.log('      npx tsx scripts/ve500-usb-thru.ts off');
  console.log('────────────────────────────────────────────────────────────────\n');
} else {
  console.log('────────────────────────────────────────────────────────────────');
  console.log('  Reverted to the factory default. The VE-500 no longer mirrors');
  console.log('  its DIN input to USB. No audio setting was ever touched.');
  console.log('────────────────────────────────────────────────────────────────\n');
}

conn.close();
process.exit(0);
