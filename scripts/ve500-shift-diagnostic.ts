/**
 * VE-500 `pitch_correct.shift` DIAGNOSTIC — turns PITCH CORRECT into a
 * two-state indicator that says, by ear alone, whether MIDI notes are reaching
 * the block.
 *
 * ## Why this works
 *
 * Roland's own wording: SHIFT is the interval used **"when no MIDI message is
 * being received."** SHIFT and an incoming MIDI note are therefore MUTUALLY
 * EXCLUSIVE, which makes the block a live indicator with two audibly different
 * states:
 *
 *   - Sing with NOTHING playing  -> the voice is shifted by SHIFT.
 *     Hearing this proves the audio path, the block being in circuit, and
 *     PITCH CORRECT actually processing.
 *   - Play the sequence          -> if MIDI notes arrive, SHIFT stops applying
 *     and the voice snaps to the melody instead.
 *
 * The CHANGE between the two states is the measurement. No capture, no cabling,
 * no coordination beyond singing twice.
 *
 * ## Why +12 (one octave up) and not a fifth or a tritone
 *
 * The two states must be distinguishable by REGISTER, not merely by interval
 * quality, because the melody itself occupies a register. MIDI 1 is authored at
 * notes 51..65 (D#3..F4). A shifted voice must not land inside that band, or
 * "shifted" and "snapped to the melody" sound alike and the test reads false.
 *
 *   +6 (tritone): a normal male vocal near C4 shifts to ~F#4 = 66, sitting
 *       exactly at the top edge of the melody band. Maximally dissonant, but
 *       the register collides — the worst choice here despite the obvious tone.
 *   +7 (fifth):   C4 -> G4 = 67, still adjacent to the band.
 *   +12 (octave): C4 -> C5 = 72, cleanly ABOVE the whole 51..65 band. The two
 *       states cannot be confused, and through TYPE=ELECTRIC at SPEED=10 an
 *       octave up is the unmistakable hard-autotune sound the maintainer
 *       described hearing in the artist's live performance.
 *
 * So: dissonance is not the goal, SEPARATION is. The octave wins.
 *
 * ## Safety
 *
 * Writes ONE parameter into the temporary (edit-buffer) patch and does NOT
 * store it. `buildSavePreset` is deliberately not imported, so this script
 * cannot persist the change: recalling any patch reverts it. Every write is
 * verified by read-back in display units, because a write that silently did
 * nothing would otherwise look identical to a success.
 *
 * Run:
 *   npx tsx scripts/ve500-shift-diagnostic.ts          # set the diagnostic (+12)
 *   npx tsx scripts/ve500-shift-diagnostic.ts revert   # put it back to 0
 *   npx tsx scripts/ve500-shift-diagnostic.ts read     # read only, change nothing
 */
import { connect } from '../packages/core/src/midi/transport.js';
import {
  findParam,
  buildGetParam,
  buildSetParam,
  paramReplyMatcher,
  decodeParamReply,
} from '../packages/roland-midi/src/ve-500/index.js';

const MODE = (process.argv[2] ?? 'set').toLowerCase();
if (!['set', 'revert', 'read'].includes(MODE)) {
  console.error(`Unknown mode "${MODE}". Use: set | revert | read`);
  process.exit(1);
}

/** Wire 12 = "0" semitones (neutral). Wire 24 = "+12" = one octave up. */
const WIRE_NEUTRAL = 12;
const WIRE_OCTAVE_UP = 24;

const def = findParam('pitch_correct', 'shift');
if (!def) {
  console.error('Could not resolve pitch_correct.shift in the VE-500 catalog.');
  process.exit(1);
}

const display = (wire: number): string => def.enum_values?.[wire] ?? String(wire);

const conn = connect({ needles: ['ve-500', 've500'], notFoundLeadIn: 'VE-500 not found.' });

async function read(): Promise<number | undefined> {
  const waiter = conn.receiveSysExMatching(paramReplyMatcher(def!), 800).catch(() => undefined);
  conn.send(buildGetParam(def!));
  const reply = await waiter;
  if (reply === undefined) return undefined;
  const v = decodeParamReply(def!, reply);
  return typeof v === 'number' ? v : undefined;
}

console.log('\n=== VE-500 pitch_correct.shift ===\n');

const before = await read();
if (before === undefined) {
  console.error('No reply to the read. Aborting rather than writing blind.');
  conn.close();
  process.exit(1);
}
console.log(`  current: wire ${before}  =  ${display(before)} semitones`);

if (MODE === 'read') {
  console.log('\nRead-only mode. Nothing was written.\n');
  conn.close();
  process.exit(0);
}

const target = MODE === 'revert' ? WIRE_NEUTRAL : WIRE_OCTAVE_UP;
if (before === target) {
  console.log(`  already at ${display(target)}. No write needed.`);
  conn.close();
  process.exit(0);
}

console.log(`  writing: wire ${target}  =  ${display(target)} semitones  (edit buffer only, NOT stored)`);
conn.send(buildSetParam(def, target));

// Read-back verification. A write that did nothing looks exactly like a
// success without this, which is why it is not optional.
await new Promise((r) => setTimeout(r, 250));
const after = await read();

if (after === undefined) {
  console.log('\n  VERIFY FAILED: no reply to the read-back. Treat the value as UNKNOWN.');
  conn.close();
  process.exit(1);
}
console.log(`  read-back: wire ${after}  =  ${display(after)} semitones`);

if (after !== target) {
  console.log(`\n  VERIFY FAILED: expected ${display(target)}, device holds ${display(after)}.`);
  conn.close();
  process.exit(1);
}
console.log('  VERIFIED.\n');

if (MODE === 'revert') {
  console.log('────────────────────────────────────────────────────────────────');
  console.log('  SHIFT is back to 0 semitones. The vocal path is neutral again.');
  console.log('────────────────────────────────────────────────────────────────\n');
} else {
  console.log('════════════════════ WHAT TO LISTEN FOR ════════════════════');
  console.log('');
  console.log('  STATE A — sing with NOTHING playing.');
  console.log('    Expect: your voice an OCTAVE UP, hard-tuned. Unmistakable.');
  console.log('    If you hear it  -> PITCH CORRECT is in circuit and processing.');
  console.log('    If you DO NOT   -> the block is not in the audio path at all.');
  console.log('                       Stop here; MIDI is not the problem.');
  console.log('');
  console.log('  STATE B — now play the After Dark chorus and sing over it.');
  console.log('    Expect: the octave-up STOPS and your voice snaps to the melody');
  console.log('            (notes 51..65, D#3..F4 — around your own register).');
  console.log('    If it CHANGES   -> MIDI notes ARE reaching the block. The chain');
  console.log('                       is intact and the fault is in how it sounds,');
  console.log('                       not in whether MIDI arrives.');
  console.log('    If it stays an octave up, unchanged for the whole chorus');
  console.log('                    -> NO MIDI is reaching the block. That is the');
  console.log('                       answer, and the captures then locate WHERE.');
  console.log('');
  console.log('  Sustained notes matter: the VE-500 does NOT latch a target. It has');
  console.log('  no "notes extension" equivalent, and its MIDI chart recognises All');
  console.log('  Notes Off, so the target only holds while a note is HELD. Short');
  console.log('  staccato notes give brief snaps back to the melody between');
  console.log('  octave-up gaps — that flicker is still a PASS, and is itself');
  console.log('  evidence the notes are too short.');
  console.log('');
  console.log('  ⚠ REVERT WHEN DONE:  npx tsx scripts/ve500-shift-diagnostic.ts revert');
  console.log('    Leaving SHIFT at +12 detunes your voice an octave up on every');
  console.log('    song where no MIDI note is playing, which is most of them.');
  console.log('    Nothing was stored, so recalling any patch also reverts it.');
  console.log('════════════════════════════════════════════════════════════\n');
}

conn.close();
process.exit(0);
