/**
 * MicroFreak OUTPUT-CHANNEL listener. Fully passive: opens the input port and
 * reports what the device transmits. Sends nothing.
 *
 * Verifies `Utility > MIDI > Output Chan` empirically instead of trusting the
 * menu reading, by decoding the channel nibble of every channel-voice message
 * the device emits when keys are played.
 *
 * Run: npx tsx scripts/probe-microfreak-listen.ts [seconds]
 */
import midi from '@julusian/midi';

const seconds = Number(process.argv[2] ?? '45');

const input = new midi.Input();
let port = -1;
for (let i = 0; i < input.getPortCount(); i++) {
  if (/microfreak|arturia/i.test(input.getPortName(i))) { port = i; break; }
}
if (port === -1) {
  console.error('MicroFreak input port not found.');
  process.exit(1);
}
console.log(`Listening on "${input.getPortName(port)}" for ${seconds}s. Play some keys.\n`);

const STATUS: Record<number, string> = {
  0x80: 'note-off', 0x90: 'note-on', 0xa0: 'poly-aftertouch',
  0xb0: 'cc', 0xc0: 'program-change', 0xd0: 'channel-aftertouch', 0xe0: 'pitch-bend',
};
const channelHits = new Map<number, number>();
const kinds = new Map<string, number>();

input.on('message', (_d: number, msg: number[]) => {
  const status = msg[0] & 0xf0;
  if (status < 0x80 || status > 0xe0) return;            // ignore realtime/sysex
  const ch = (msg[0] & 0x0f) + 1;
  channelHits.set(ch, (channelHits.get(ch) ?? 0) + 1);
  const kind = STATUS[status] ?? `0x${status.toString(16)}`;
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
});

input.openPort(port);
// openPort RESETS ignoreTypes, so it must be set AFTER opening, not before.
// Keep sysex(false) so a stray dump is visible, drop timing/active-sensing noise.
input.ignoreTypes(false, true, true);

setTimeout(() => {
  input.closePort();
  console.log('--- channels seen ---');
  if (channelHits.size === 0) {
    console.log('  NOTHING RECEIVED. Either no keys were played, or Output dest excludes USB.');
  } else {
    for (const [ch, n] of [...channelHits].sort((a, b) => b[1] - a[1])) {
      console.log(`  channel ${String(ch).padStart(2)}: ${n} messages`);
    }
    console.log('--- message kinds ---');
    for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  }
  process.exit(0);
}, seconds * 1000);
