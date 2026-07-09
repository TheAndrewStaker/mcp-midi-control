/**
 * b0-capture-delay-onsets — timestamped note-on capture + automatic verdict for
 * the B0 GATE (companion to scripts/b0-author-delay-test.ts; see
 * samples/circuit-tracks/grooves/gm/gethsemane_electronic_HANDOFF.md).
 *
 * Opens the Circuit Tracks MIDI INPUT as a parallel listener (shared read, same
 * approach as capture-midi-passive.ts) and records the driver-timestamped
 * note-on stream while the B0 test project plays. Fully automated — no human
 * observation step — so it self-terminates and prints a verdict.
 *
 * Probe identification is by PITCH CLASS (immune to the octave-low transmit and
 * to loop phase):
 *   C -> step 0 (delay 0)      D -> step 8 (delay 0)     E -> step 16 (delay 0)
 *   F -> step 24 slot delay 0  G -> step 24 slot delay 3
 *
 * Measurements per loop:
 *   - baseline step length: IOI(C->D)/8 and IOI(D->E)/8  (self-calibrating)
 *   - THE DECISIVE PAIR: dt = t(G) - t(F). Same step, delays 0 vs 3.
 *       predicted if wire honors delay: 3 micro-ticks = step/2
 *       predicted if MIDI-out quantizes: ~0 ms (same-tick serial spacing ~1 ms)
 *
 * Verdict: mean(dt)/predicted >= 0.6 -> DELAY ON THE WIRE (Front B GO);
 *          <= 0.2 -> QUANTIZED (Front B dead end for external gear); else AMBIGUOUS.
 *
 *   npx tsx scripts/b0-capture-delay-onsets.ts [loops=6] [timeoutSec=90]
 */
import midi from '@julusian/midi';

const WANT_LOOPS = Number(process.argv[2] ?? 6);
const TIMEOUT_S = Number(process.argv[3] ?? 90);

const PROBE_BY_PC: Record<number, string> = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G' };

interface Onset { t: number; probe: string; note: number; ch: number; vel: number }

function findCircuitInput(): { input: midi.Input; index: number; name: string } {
  const input = new midi.Input();
  for (let i = 0; i < input.getPortCount(); i++) {
    const name = input.getPortName(i);
    if (name.toLowerCase().includes('circuit')) return { input, index: i, name };
  }
  throw new Error('no MIDI input port matching "circuit" — is the Circuit Tracks connected?');
}

const { input, index, name } = findCircuitInput();
const onsets: Onset[] = [];
let clock = 0; // accumulated driver delta-time (seconds)
let gCount = 0;

input.ignoreTypes(true, true, true); // channel messages only; clock/sensing/sysex dropped

input.on('message', (dt, bytes) => {
  clock += dt;
  if (bytes.length < 3) return;
  const status = bytes[0];
  if ((status & 0xf0) !== 0x90 || bytes[2] === 0) return;
  const probe = PROBE_BY_PC[bytes[1] % 12];
  if (!probe) return;
  onsets.push({ t: clock, probe, note: bytes[1], ch: (status & 0x0f) + 1, vel: bytes[2] });
  process.stderr.write(`\r${onsets.length} probe note-ons  last=${probe} note ${bytes[1]} ch${(status & 0x0f) + 1} t=${clock.toFixed(4)}s   `);
  if (probe === 'G' && ++gCount >= WANT_LOOPS) finish('collected requested loops');
});

input.openPort(index);
console.error(`✓ Listening on [${index}] "${name}" for ${WANT_LOOPS} loops (timeout ${TIMEOUT_S}s)...`);
console.error('  Select the B0 test project and start playback (PC ch16 + clock start).');

const killer = setTimeout(() => finish('timeout'), TIMEOUT_S * 1000);

function stats(xs: number[]): { n: number; mean: number; min: number; max: number } {
  const n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : NaN;
  return { n, mean, min: Math.min(...xs), max: Math.max(...xs) };
}
const ms = (s: number) => (s * 1000).toFixed(1);

function finish(reason: string): void {
  clearTimeout(killer);
  try { input.closePort(); } catch { /* already closed */ }
  console.error(`\n\nStopped (${reason}). ${onsets.length} probe note-ons captured.`);
  if (onsets.length === 0) {
    console.error('❌ NOTHING captured — playback never started, MIDI-2 not routed to USB, or wrong project selected.');
    process.exit(2);
  }

  // Successive-pair IOIs, by probe transition.
  const baseline: number[] = [];   // C->D and D->E, 8 steps each
  const fToG: number[] = [];       // the decisive same-step pair
  const eToF: number[] = [];       // 8 steps, F is delay-0
  for (let i = 1; i < onsets.length; i++) {
    const a = onsets[i - 1], b = onsets[i];
    const key = a.probe + b.probe;
    const dt = b.t - a.t;
    if (key === 'CD' || key === 'DE') baseline.push(dt);
    else if (key === 'FG') fToG.push(dt);
    else if (key === 'EF') eToF.push(dt);
  }

  const base = stats(baseline);
  const step = base.mean / 8;               // one 16th step, seconds
  const predicted = step / 2;               // 3 micro-ticks (of 6)
  const pair = stats(fToG);

  console.log('\n── B0 DECODE SUMMARY ──────────────────────────────────────');
  console.log(`baseline 8-step IOIs (C→D, D→E): n=${base.n} mean=${ms(base.mean)}ms [${ms(base.min)}..${ms(base.max)}]`);
  console.log(`  → step (16th) = ${ms(step)}ms, micro-tick = ${ms(step / 6)}ms`);
  console.log(`E→F 8-step check: n=${eToF.length} mean=${ms(stats(eToF).mean)}ms (expect ≈ baseline)`);
  console.log(`DECISIVE F→G same-step pair (delay 0 vs 3): n=${pair.n} mean=${ms(pair.mean)}ms [${ms(pair.min)}..${ms(pair.max)}]`);
  console.log(`  predicted if wire honors delay: ${ms(predicted)}ms; if quantized: ~0-2ms`);

  if (!pair.n || !base.n || !isFinite(step)) {
    console.log('VERDICT: INSUFFICIENT DATA — need at least one full loop with both F and G onsets.');
    process.exit(2);
  }
  const ratio = pair.mean / predicted;
  console.log(`  ratio measured/predicted = ${ratio.toFixed(2)}`);
  if (ratio >= 0.6) {
    console.log('VERDICT: ✅ DELAY IS ON THE WIRE — MIDI-out transmits micro-timing. Front B is GO.');
  } else if (ratio <= 0.2) {
    console.log('VERDICT: ❌ QUANTIZED — MIDI-out ignores note delay. Front B is a dead end for external gear.');
  } else {
    console.log('VERDICT: ⚠ AMBIGUOUS — shift present but far from 3 micro-ticks. Re-run / inspect raw onsets below.');
  }
  console.log('\nraw onsets (t seconds, probe, wire note, ch, vel):');
  for (const o of onsets) console.log(`  ${o.t.toFixed(4)}  ${o.probe}  ${o.note}  ch${o.ch}  v${o.vel}`);
  process.exit(0);
}
