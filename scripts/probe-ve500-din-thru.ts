/**
 * VE-500 `system_midi` READ-ONLY inspection, aimed at ONE capability:
 *
 *   THRU (`system_midi.midi_usb_out_thru`) — the Parameter Guide's MIDI menu:
 *   "Specifies whether MIDI messages received at the MIDI IN connector are
 *   output from the USB port."
 *
 * That makes the VE-500 a MIDI MONITOR for its own DIN input. With THRU = ON,
 * opening the "VE-500" USB input port shows exactly what is arriving at the
 * 5-pin MIDI In — which is the far end of the Circuit -> MicroFreak -> VE-500
 * chain, observed with no cable moves at all.
 *
 * This script only READS (`buildGetParam`, RQ1). `buildSetParam` is deliberately
 * not imported, so it cannot alter the maintainer's live vocal chain. If THRU
 * reads 0, this prints the single write that would enable it and STOPS; making
 * that change is a decision for the maintainer, not for this script.
 *
 * Run: npx tsx scripts/probe-ve500-din-thru.ts
 */
import { connect } from '../packages/core/src/midi/transport.js';
import {
  findParam,
  buildGetParam,
  paramReplyMatcher,
  decodeParamReply,
} from '../packages/roland-midi/src/ve-500/index.js';

const VE_NEEDLES = ['ve-500', 've500'];

type Row = { name: string; why: string; render?: (v: number) => string };

const CHANNEL = (v: number): string => (v === 0 ? 'Ch.1' : `Ch.${v + 1}`);

const ROWS: Row[] = [
  {
    name: 'midi_usb_out_thru',
    why: 'THE ONE THAT MATTERS: ON routes everything arriving at the 5-pin MIDI In out to USB, '
      + 'turning this unit into a monitor for what it actually receives.',
    render: (v) => (v === 1 ? 'ON  — DIN In is mirrored to USB. The USB port can be listened to.' : 'OFF — DIN In is NOT mirrored to USB. Listening to the USB port shows nothing inbound.'),
  },
  { name: 'midi_rx_channel', why: 'global RX channel; only matters where a setting resolves to "RX"', render: CHANNEL },
  { name: 'midi_rx_omni_mode', why: 'ON = receive regardless of channel', render: (v) => (v ? 'ON (omni)' : 'OFF') },
  { name: 'midi_program_change_in', why: 'deliberately OFF in this rig so a stray PC cannot recall a patch mid-song', render: (v) => (v ? 'ON' : 'OFF') },
  { name: 'midi_sync_source', why: 'tempo clock source', render: (v) => ['INT', 'USB', 'MIDI', 'AUTO'][v] ?? String(v) },
];

async function veRead(
  conn: ReturnType<typeof connect>,
  block: string,
  name: string,
): Promise<{ wire?: number; err?: string }> {
  const def = findParam(block, name);
  if (!def) return { err: `UNRESOLVED param '${block}.${name}'` };
  const waiter = conn.receiveSysExMatching(paramReplyMatcher(def), 600).catch(() => undefined);
  conn.send(buildGetParam(def)); // RQ1 read only.
  const reply = await waiter;
  if (reply === undefined) return { err: 'no DT1 reply within 600ms' };
  const v = decodeParamReply(def, reply);
  if (typeof v !== 'number') return { err: 'malformed DT1 reply' };
  return { wire: v };
}

const ve = connect({ needles: VE_NEEDLES, notFoundLeadIn: 'VE-500 not found.' });

console.log('\n=== VE-500 system_midi (READ-ONLY) ===\n');
let thru: number | undefined;
for (const row of ROWS) {
  const r = await veRead(ve, 'system_midi', row.name);
  const shown = r.err ?? (row.render ? `${r.wire}  ${row.render(r.wire!)}` : String(r.wire));
  if (row.name === 'midi_usb_out_thru') thru = r.wire;
  console.log(`system_midi.${row.name.padEnd(26)} ${shown}`);
  console.log(`${''.padEnd(39)} ^ ${row.why}\n`);
}

console.log('────────────────────────────────────────────────────────────');
if (thru === 1) {
  console.log('THRU is already ON. The VE-500 USB input port is a live monitor of its DIN In.');
  console.log('Listen with:  npx tsx scripts/probe-chain-monitor.ts circuit,microfreak,"VE-500" 40');
} else if (thru === 0) {
  console.log('THRU is OFF, so listening on the VE-500 USB port will show NOTHING arriving from DIN.');
  console.log('Enabling it is ONE system write, reversible, and touches no audio setting:');
  console.log('    system_midi.midi_usb_out_thru : 0 -> 1');
  console.log('This script will NOT make that change. Ask the maintainer first — it is his live');
  console.log('vocal chain, and he should decide whether anything on this unit moves tonight.');
} else {
  console.log('THRU did not read back. Re-check the port (note the duplicate "VE-500" enumeration).');
}
console.log('────────────────────────────────────────────────────────────');
console.log('Nothing was written. Only RQ1 reads were sent.\n');

ve.close();
process.exit(0);
