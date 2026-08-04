/**
 * MULTI-PORT MIDI CHAIN MONITOR. READ-ONLY BY CONSTRUCTION.
 *
 * Opens N MIDI **input** ports at once on a single shared clock, so one play of
 * a sequence shows the same notes leaving each hop of a chain a millisecond
 * apart. Built to answer a question that had been argued rather than measured:
 * a sequencer feeds a synth's MIDI In, that synth is set to relay (Thru = On)
 * out of its MIDI Out, and a third device downstream is not responding. Which
 * link is dead?
 *
 * **Why it cannot write.** This file never constructs a `midi.Output`. Not
 * "does not call send" — the output class is never instantiated, so there is no
 * handle through which a byte could leave. Do not "tidy" that into a shared
 * `connect()` helper, which opens a bidirectional pair; the one-way-ness IS the
 * safety property and it should stay obvious from the imports alone.
 *
 * **Nothing is filtered.** `ignoreTypes(false, false, false)` admits SysEx,
 * timing clock and active sensing. Their PRESENCE OR ABSENCE is itself
 * diagnostic (no clock arriving at a hop is a finding, not noise), so they are
 * COUNTED rather than dropped. They are simply not echoed line-by-line, because
 * 24 PPQN would bury the notes.
 *
 * **`openPort` RESETS `ignoreTypes`** — a gotcha this project has already paid
 * for once. The filter call MUST come after the open, and does. Reordering
 * those two lines silently drops exactly the messages the tool exists to show.
 *
 * ## The positive control, and why the report insists on it
 *
 * A downstream tap that shows nothing is ambiguous: either the relay is dead,
 * or that port simply does not report relayed traffic. The report therefore
 * separates the notes a tap ECHOED (matched to an upstream note) from the ones
 * it ORIGINATED (no upstream match — e.g. keys played by hand on that synth).
 * Originated notes are the control: they prove the port reports that device's
 * output at all. "Relay broken" is only ever concluded when the control fired.
 *
 * Run:
 *   npx tsx scripts/probe-chain-monitor.ts <ports> [seconds] [--tail] [--focus=N]
 *
 *   <ports>    comma-separated, IN CHAIN ORDER (source first, then each hop).
 *              Each token is a case-insensitive regex matched against port
 *              names, or `#N` for a literal port index (use `#N` when two ports
 *              share a name, which happens when a replug leaves a stale
 *              enumeration behind).
 *   [seconds]  capture window, default 45. Rolling tallies print every 5s, so
 *              there is no countdown to perform against.
 *   --tail     echo every channel-voice message. Default prints the first few
 *              per port, then relies on the tallies.
 *   --focus=N  the channel the side-by-side timeline is built for. Default 3.
 *
 * Examples:
 *   npx tsx scripts/probe-chain-monitor.ts circuit 30
 *   npx tsx scripts/probe-chain-monitor.ts circuit,microfreak 40 --focus=3
 *   npx tsx scripts/probe-chain-monitor.ts '#1,#6,#2' 40 --tail
 */
import midi from '@julusian/midi';

// ─── args ────────────────────────────────────────────────────────────────────

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const rawPorts = (positional[0] ?? 'circuit').split(',').map((s) => s.trim()).filter((s) => s !== '');
const seconds = Number(positional[1] ?? '45');
const tail = process.argv.includes('--tail');
const focusArg = process.argv.find((a) => a.startsWith('--focus='));
const FOCUS_CH = Number(focusArg?.split('=')[1] ?? '3');

/** How long after an upstream note a downstream echo still counts as the same note. */
const RELAY_WINDOW_MS = 120;

// ─── decode tables ───────────────────────────────────────────────────────────

const VOICE: Record<number, string> = {
  0x80: 'note-off', 0x90: 'note-on', 0xa0: 'poly-AT',
  0xb0: 'cc', 0xc0: 'program-change', 0xd0: 'chan-AT', 0xe0: 'pitch-bend',
};
/** System messages. Separate from VOICE because they carry no channel nibble. */
const SYSTEM: Record<number, string> = {
  0xf0: 'sysex', 0xf1: 'mtc-quarter-frame', 0xf2: 'song-position', 0xf3: 'song-select',
  0xf6: 'tune-request', 0xf7: 'sysex-end',
  0xf8: 'clock', 0xf9: 'rt-undefined-f9', 0xfa: 'START', 0xfb: 'CONTINUE',
  0xfc: 'STOP', 0xfd: 'rt-undefined-fd', 0xfe: 'active-sensing', 0xff: 'system-reset',
};

const PITCH = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** MIDI 60 = C4, matching the Roland / Novation convention used elsewhere here. */
const noteName = (n: number): string => `${PITCH[n % 12]}${Math.floor(n / 12) - 1}`;

// ─── per-port state ──────────────────────────────────────────────────────────

interface ChannelTally {
  total: number;
  kinds: Map<string, number>;
  notes: Map<number, number>;
  ccs: Map<number, number>;
  pcs: Set<number>;
}
interface NoteEvent { t: number; ch: number; note: number; vel: number; matchedUpstream?: boolean }

interface Tap {
  label: string;
  portIndex: number;
  portName: string;
  input: midi.Input;
  channels: Map<number, ChannelTally>;
  system: Map<string, number>;
  noteEvents: NoteEvent[];
  firstAt?: number;
  lastAt?: number;
  printed: number;
  total: number;
}

const taps: Tap[] = [];

const enumerator = new midi.Input();
const allNames: string[] = [];
for (let i = 0; i < enumerator.getPortCount(); i++) allNames.push(enumerator.getPortName(i));

function resolvePort(token: string): number {
  if (token.startsWith('#')) {
    const idx = Number(token.slice(1));
    return Number.isInteger(idx) && idx >= 0 && idx < allNames.length ? idx : -1;
  }
  const re = new RegExp(token, 'i');
  const hits = allNames.map((n, i) => ({ n, i })).filter(({ n }) => re.test(n));
  if (hits.length === 0) return -1;
  if (hits.length > 1) {
    console.log(`  note: /${token}/i matches ${hits.length} ports (${hits.map((h) => `#${h.i} ${h.n}`).join(', ')}).`);
    console.log('        Taking the first. Pass #N to pick a specific one.');
  }
  return hits[0].i;
}

console.log('\n=== MIDI CHAIN MONITOR (read-only: no output port is ever opened) ===\n');
console.log('Available input ports:');
allNames.forEach((n, i) => console.log(`  #${i}  ${n}`));
console.log('');

const chosen: number[] = [];
for (const token of rawPorts) {
  const index = resolvePort(token);
  if (index === -1) {
    console.error(`No input port matching "${token}". Aborting, so a partial capture is never mistaken for a whole one.`);
    process.exit(1);
  }
  if (chosen.includes(index)) {
    console.error(`Port #${index} ("${allNames[index]}") selected twice (via "${token}"). Give each hop a distinct port.`);
    process.exit(1);
  }
  chosen.push(index);
}

// One clock for every tap, taken BEFORE any port opens so no tap gets a head
// start. That is what makes the cross-port deltas meaningful.
const t0 = Date.now();
const now = (): number => Date.now() - t0;

for (const index of chosen) {
  const input = new midi.Input();
  const portName = allNames[index];
  const label = portName.replace(/\s+/g, '-');
  const tap: Tap = {
    label, portIndex: index, portName, input,
    channels: new Map(), system: new Map(), noteEvents: [], printed: 0, total: 0,
  };

  input.on('message', (_dt: number, msg: number[]) => {
    const t = now();
    tap.total++;
    if (tap.firstAt === undefined) tap.firstAt = t;
    tap.lastAt = t;

    const status = msg[0];

    // System / realtime: COUNTED, never dropped. Absence of clock at a hop is
    // as much a finding as absence of notes.
    if (status >= 0xf0) {
      const name = SYSTEM[status] ?? `system-0x${status.toString(16)}`;
      tap.system.set(name, (tap.system.get(name) ?? 0) + 1);
      if (status === 0xfa || status === 0xfb || status === 0xfc) {
        console.log(`[${(t / 1000).toFixed(3).padStart(8)}s] ${label.padEnd(18)} ${name}`);
      }
      return;
    }

    const kind = VOICE[status & 0xf0];
    if (kind === undefined) return;
    const ch = (status & 0x0f) + 1;

    let e = tap.channels.get(ch);
    if (e === undefined) {
      e = { total: 0, kinds: new Map(), notes: new Map(), ccs: new Map(), pcs: new Set() };
      tap.channels.set(ch, e);
    }
    e.total++;
    e.kinds.set(kind, (e.kinds.get(kind) ?? 0) + 1);

    let detail: string;
    if (kind === 'note-on' && msg[2] > 0) {
      e.notes.set(msg[1], (e.notes.get(msg[1]) ?? 0) + 1);
      tap.noteEvents.push({ t, ch, note: msg[1], vel: msg[2] });
      detail = `${String(msg[1]).padStart(3)} (${noteName(msg[1]).padEnd(4)}) v${msg[2]}`;
    } else if (kind === 'note-on' || kind === 'note-off') {
      detail = `${String(msg[1]).padStart(3)} (${noteName(msg[1]).padEnd(4)}) off`;
    } else if (kind === 'cc') {
      e.ccs.set(msg[1], (e.ccs.get(msg[1]) ?? 0) + 1);
      detail = `cc${msg[1]} = ${msg[2]}`;
    } else if (kind === 'program-change') {
      e.pcs.add(msg[1]);
      detail = `program ${msg[1]}`;
    } else {
      detail = msg.slice(1).join(' ');
    }

    if (tail || tap.printed < 8) {
      tap.printed++;
      console.log(`[${(t / 1000).toFixed(3).padStart(8)}s] ${label.padEnd(18)} ch${String(ch).padStart(2)} ${kind.padEnd(14)} ${detail}`);
      if (!tail && tap.printed === 8) {
        console.log(`             ${label.padEnd(18)} ... further messages counted, not echoed (use --tail for all)`);
      }
    }
  });

  // A failed open must NOT abort the run. A machine can enumerate the same
  // device twice after a replug, and tapping both copies is a legitimate way to
  // find out which one is live — but only if the dead one degrades to a skipped
  // tap instead of killing a capture the operator is mid-performance for.
  try {
    input.openPort(index);
  } catch (err) {
    console.log(`  SKIPPED #${index} "${portName}": ${err instanceof Error ? err.message : String(err)}`);
    console.log('    (likely a stale duplicate enumeration or a port held exclusively elsewhere)');
    continue;
  }
  // MUST follow openPort: openPort RESETS ignoreTypes. Admit everything.
  input.ignoreTypes(false, false, false);

  taps.push(tap);
}

if (taps.length === 0) {
  console.error('No port could be opened. Nothing to capture.');
  process.exit(1);
}

// ─── armed banner ────────────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
console.log('║                  ARMED AND LISTENING — SAY GO NOW                    ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝');
for (const tp of taps) console.log(`   tap ${taps.indexOf(tp) + 1}: #${tp.portIndex}  ${tp.portName}`);
console.log(`\n   window   : ${seconds}s, stops on its own — no keypress needed to end it`);
console.log(`   focus ch : ${FOCUS_CH}`);
console.log('   sending  : NOTHING. No output port exists in this process.\n');
console.log('   PLAY NOW. And at some point during the window, play one or two keys');
console.log('   by hand on the MicroFreak — that is the positive control that proves');
console.log('   its USB port reports its output at all.\n');

// ─── rolling status ──────────────────────────────────────────────────────────

const rolling = setInterval(() => {
  const parts = taps.map((tp) => {
    const chans = [...tp.channels].sort((a, b) => a[0] - b[0]).map(([ch, e]) => `ch${ch}:${e.total}`).join(' ');
    const clk = tp.system.get('clock') ?? 0;
    return `  ${tp.label.padEnd(20)} ${chans === '' ? 'no channel msgs' : chans}${clk > 0 ? `  clock:${clk}` : '  NO CLOCK'}`;
  });
  console.log(`[running ${(now() / 1000).toFixed(0)}s / ${seconds}s]\n${parts.join('\n')}`);
}, 5000);
rolling.unref();

// ─── correlation ─────────────────────────────────────────────────────────────

interface Match { up: NoteEvent; down?: NoteEvent; delta?: number }

/**
 * Match note-ons on `up` to the same (channel, note) on `down` within the relay
 * window, greedily and without reusing a downstream event. Also marks each
 * downstream event as echoed or originated, which is what the positive control
 * reads.
 */
function correlate(up: Tap, down: Tap, ch: number): Match[] {
  const upEv = up.noteEvents.filter((e) => e.ch === ch);
  const downEv = down.noteEvents.filter((e) => e.ch === ch);
  const used = new Set<NoteEvent>();
  const out: Match[] = [];
  for (const a of upEv) {
    let best: NoteEvent | undefined;
    let bestDelta = Infinity;
    for (const b of downEv) {
      if (used.has(b) || b.note !== a.note) continue;
      const d = b.t - a.t;
      if (d < -5 || d > RELAY_WINDOW_MS) continue;
      if (Math.abs(d) < Math.abs(bestDelta)) { bestDelta = d; best = b; }
    }
    if (best) { used.add(best); best.matchedUpstream = true; out.push({ up: a, down: best, delta: bestDelta }); }
    else out.push({ up: a });
  }
  return out;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.floor(s.length / 2)];
};

// ─── final report ────────────────────────────────────────────────────────────

setTimeout(() => {
  clearInterval(rolling);
  for (const tp of taps) { try { tp.input.closePort(); } catch { /* already closed */ } }

  console.log('\n\n════════════════════════ CAPTURE REPORT ════════════════════════');
  console.log(`window ${seconds}s   taps ${taps.length}   focus channel ${FOCUS_CH}\n`);

  for (const tp of taps) {
    console.log(`──── ${tp.portName}  (port #${tp.portIndex}) ────`);
    console.log(`  ${tp.total} messages total` + (tp.firstAt !== undefined
      ? `, first ${(tp.firstAt / 1000).toFixed(2)}s, last ${(tp.lastAt! / 1000).toFixed(2)}s`
      : '  ← NOTHING ARRIVED ON THIS PORT'));

    if (tp.channels.size === 0) {
      console.log('  CHANNELS: none. No note / cc / pc traffic at all.');
    } else {
      console.log('  CHANNELS:');
      for (const [ch, e] of [...tp.channels].sort((a, b) => a[0] - b[0])) {
        const kinds = [...e.kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(', ');
        const star = ch === FOCUS_CH ? ' <<< FOCUS' : '';
        console.log(`    ch${String(ch).padStart(2)}: ${String(e.total).padStart(5)} msgs  [${kinds}]${star}`);
        if (e.notes.size > 0) {
          const ns = [...e.notes].sort((a, b) => a[0] - b[0]);
          console.log(`           range ${ns[0][0]} (${noteName(ns[0][0])}) .. ${ns[ns.length - 1][0]} (${noteName(ns[ns.length - 1][0])})`);
          console.log(`           notes: ${ns.map(([n, c]) => `${n}(${noteName(n)})×${c}`).join(' ')}`);
        }
        if (e.ccs.size > 0) console.log(`           ccs: ${[...e.ccs].sort((a, b) => a[0] - b[0]).map(([c, n]) => `${c}×${n}`).join(' ')}`);
        if (e.pcs.size > 0) console.log(`           program changes: ${[...e.pcs].sort((a, b) => a - b).join(', ')}`);
      }
    }

    console.log('  SYSTEM / REALTIME:');
    if (tp.system.size === 0) console.log('    none — no clock, no transport, no active sensing, no sysex.');
    else {
      for (const [k, n] of [...tp.system].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(20)} ${n}`);
      const clk = tp.system.get('clock') ?? 0;
      if (clk > 24 && tp.firstAt !== undefined && tp.lastAt! > tp.firstAt) {
        console.log(`    implied tempo: ${(((clk - 1) / ((tp.lastAt! - tp.firstAt) / 1000) / 24) * 60).toFixed(1)} BPM`);
      }
    }
    console.log('');
  }

  if (taps.length < 2) {
    console.log('Single tap: no chain comparison possible. Nothing was transmitted.\n');
    process.exit(0);
  }

  // ─── the deliverable: time-aligned side-by-side on the focus channel ───
  const source = taps[0];
  const downstream = taps.slice(1);
  const matchSets = downstream.map((d) => correlate(source, d, FOCUS_CH));

  console.log(`──── TIME-ALIGNED ch${FOCUS_CH} NOTE EVENTS (first 24) ────`);
  console.log(`  Each row is ONE note as it left ${source.label}, and whether the same note`);
  console.log('  reappeared on each downstream tap. "—" means it never arrived.\n');
  const hdr = `  ${'t (s)'.padEnd(9)}${'note'.padEnd(12)}${downstream.map((d) => d.label.slice(0, 21).padEnd(22)).join('')}`;
  console.log(hdr);
  console.log(`  ${'-'.repeat(hdr.length - 2)}`);
  const srcEv = source.noteEvents.filter((e) => e.ch === FOCUS_CH);
  if (srcEv.length === 0) {
    console.log(`  (no ch${FOCUS_CH} note-ons left ${source.label} at all)`);
  }
  for (let i = 0; i < Math.min(srcEv.length, 24); i++) {
    const a = srcEv[i];
    const cells = matchSets.map((ms) => {
      const m = ms.find((x) => x.up === a);
      return (m?.down ? `yes  +${String(m.delta).padStart(3)} ms` : '—  MISSING').padEnd(22);
    });
    console.log(`  ${(a.t / 1000).toFixed(3).padEnd(9)}${`${a.note} (${noteName(a.note)})`.padEnd(12)}${cells.join('')}`);
  }
  if (srcEv.length > 24) console.log(`  ... and ${srcEv.length - 24} more`);
  console.log('');

  // ─── verdict ───
  console.log('════════════════════════════ VERDICT ════════════════════════════');
  if (srcEv.length === 0) {
    console.log(`  ${source.label} transmitted NO channel-${FOCUS_CH} note-ons during the window.`);
    console.log('  The sequence did not play, the track is muted or empty, or MIDI Note Tx');
    console.log('  is off in Setup View. NOTHING DOWNSTREAM MATTERS until this is fixed.');
  } else {
    const notes = [...new Set(srcEv.map((e) => e.note))].sort((a, b) => a - b);
    console.log(`  ${source.label}: ${srcEv.length} ch${FOCUS_CH} note-ons, notes ${notes[0]} (${noteName(notes[0])})`
      + ` .. ${notes[notes.length - 1]} (${noteName(notes[notes.length - 1])}). SOURCE IS GOOD.`);
    downstream.forEach((d, i) => {
      const ms = matchSets[i];
      const matched = ms.filter((m) => m.down);
      const originated = d.noteEvents.filter((e) => e.ch === FOCUS_CH && !e.matchedUpstream);
      console.log('');
      console.log(`  ${d.label}:`);
      if (matched.length > 0) {
        console.log(`    ${matched.length}/${ms.length} notes reappeared, median +${median(matched.map((m) => m.delta!)).toFixed(0)} ms.`);
        console.log('    => THIS LINK PASSES TRAFFIC. The fault is further downstream.');
      } else if (originated.length > 0) {
        console.log(`    0/${ms.length} relayed notes arrived, BUT ${originated.length} note(s) originated here`);
        console.log('    (played by hand). The positive control FIRED: this port does report');
        console.log('    this device\'s output, and it relayed none of the sequence.');
        console.log('    => THIS LINK IS THE FAULT. Proved, not argued.');
      } else {
        console.log(`    0/${ms.length} relayed notes, and NOTHING originated here either.`);
        console.log('    AMBIGUOUS: either the relay is dead, or this USB port does not report');
        console.log('    this device\'s output at all. The positive control did NOT fire.');
        console.log('    => Re-run and play a key by hand on this device during the window.');
      }
    });
  }
  console.log('═════════════════════════════════════════════════════════════════');
  console.log('\nNothing was transmitted by this script. No device setting was changed.\n');
  process.exit(0);
}, seconds * 1000);
