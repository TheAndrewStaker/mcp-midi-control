/**
 * Generic passive MIDI MONITOR. Opens a port for INPUT only and reports what a
 * device transmits. Sends nothing, changes nothing, and needs no cable moves, so
 * a rig can be observed in its final configuration rather than a test rig.
 *
 * Answers, without anyone having to read a screen:
 *   - which MIDI channels actually carry traffic (verifies track->channel setup)
 *   - which message types (note / cc / pc / clock / transport)
 *   - whether MIDI clock is really flowing, and the implied tempo
 *   - which notes, so a drum map or a note range can be checked
 *
 * Run: npx tsx scripts/probe-midi-monitor.ts <portPattern> [seconds]
 *   e.g. npx tsx scripts/probe-midi-monitor.ts circuit 45
 */
import midi from '@julusian/midi';

const pattern = process.argv[2] ?? 'circuit';
const seconds = Number(process.argv[3] ?? '45');

const input = new midi.Input();
let port = -1;
for (let i = 0; i < input.getPortCount(); i++) {
  if (new RegExp(pattern, 'i').test(input.getPortName(i))) { port = i; break; }
}
if (port === -1) {
  console.error(`No input port matching /${pattern}/i. Available:`);
  for (let i = 0; i < input.getPortCount(); i++) console.error(`  [${i}] ${input.getPortName(i)}`);
  process.exit(1);
}
console.log(`Monitoring "${input.getPortName(port)}" for ${seconds}s. Nothing is being sent.\n`);

const VOICE: Record<number, string> = {
  0x80: 'note-off', 0x90: 'note-on', 0xa0: 'poly-AT',
  0xb0: 'cc', 0xc0: 'program-change', 0xd0: 'chan-AT', 0xe0: 'pitch-bend',
};
const REALTIME: Record<number, string> = {
  0xf8: 'clock', 0xfa: 'START', 0xfb: 'CONTINUE', 0xfc: 'STOP', 0xfe: 'active-sensing',
};

const perChannel = new Map<number, { total: number; kinds: Map<string, number>; notes: Set<number>; ccs: Set<number> }>();
const realtime = new Map<string, number>();
let clockCount = 0;
let firstClockAt = 0;
let lastClockAt = 0;

input.on('message', (_d: number, msg: number[]) => {
  const status = msg[0];
  if (status >= 0xf8) {
    const name = REALTIME[status] ?? `rt-0x${status.toString(16)}`;
    realtime.set(name, (realtime.get(name) ?? 0) + 1);
    if (status === 0xf8) {
      clockCount++;
      const now = Date.now();
      if (firstClockAt === 0) firstClockAt = now;
      lastClockAt = now;
    }
    return;
  }
  const kind = VOICE[status & 0xf0];
  if (kind === undefined) return;
  const ch = (status & 0x0f) + 1;
  let e = perChannel.get(ch);
  if (e === undefined) { e = { total: 0, kinds: new Map(), notes: new Set(), ccs: new Set() }; perChannel.set(ch, e); }
  e.total++;
  e.kinds.set(kind, (e.kinds.get(kind) ?? 0) + 1);
  if (kind === 'note-on' && msg[2] > 0) e.notes.add(msg[1]);
  if (kind === 'cc') e.ccs.add(msg[1]);
});

input.openPort(port);
// openPort RESETS ignoreTypes, so it MUST be set after opening. Enable clock +
// sysex so transport and tempo are observable; that is the point of this tool.
input.ignoreTypes(false, false, false);

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n: number): string => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

/**
 * Emit a rolling summary while running, NOT only at the end.
 *
 * The end-only version forced a timing handshake: the operator had to perform
 * during a countdown they could not see, which is precisely what the project's
 * hardware-probe rule forbids ("the maintainer cannot reliably watch a device
 * and note what appeared during an automatic countdown"). With a rolling
 * summary the run can simply be left open and read whenever the operator is
 * actually ready, so there is no window to miss.
 */
setInterval(() => {
  const chans = [...perChannel].sort((a, b) => a[0] - b[0])
    .map(([ch, e]) => `ch${ch}:${e.total}`).join(' ');
  const rt = [...realtime].map(([k, n]) => `${k}:${n}`).join(' ');
  console.log(`[running] ${chans === '' ? 'no notes yet' : chans}  |  ${rt === '' ? 'no realtime' : rt}`);
}, 5000).unref();

setTimeout(() => {
  input.closePort();
  console.log('--- CHANNELS ---');
  if (perChannel.size === 0) {
    console.log('  no channel-voice messages seen.');
  } else {
    for (const [ch, e] of [...perChannel].sort((a, b) => a[0] - b[0])) {
      const kinds = [...e.kinds].map(([k, n]) => `${k}x${n}`).join(', ');
      console.log(`  ch${String(ch).padStart(2)}: ${String(e.total).padStart(5)} msgs  [${kinds}]`);
      if (e.notes.size > 0) {
        const ns = [...e.notes].sort((a, b) => a - b);
        console.log(`         notes: ${ns.map((n) => `${n}(${noteName(n)})`).join(' ')}`);
      }
      if (e.ccs.size > 0) console.log(`         ccs: ${[...e.ccs].sort((a, b) => a - b).join(' ')}`);
    }
  }
  console.log('\n--- REALTIME ---');
  if (realtime.size === 0) console.log('  none (no clock, no transport).');
  for (const [k, n] of realtime) console.log(`  ${k}: ${n}`);
  if (clockCount > 24 && lastClockAt > firstClockAt) {
    // MIDI clock is 24 pulses per quarter note.
    const bpm = ((clockCount - 1) / ((lastClockAt - firstClockAt) / 1000) / 24) * 60;
    console.log(`  implied tempo: ${bpm.toFixed(1)} BPM`);
  }
  process.exit(0);
}, seconds * 1000);
