/**
 * b0-drive-and-capture — fully automated B0 GATE run (see
 * scripts/b0-author-delay-test.ts and the Gethsemane HANDOFF).
 *
 * The Circuit switches to external sync on MIDI Start (0xFA) and will not
 * advance without a 0xF8 clock stream (confirmed empirically: bare Start from
 * send_clock_start produced zero note-ons). So this script drives EVERYTHING
 * itself in one process:
 *
 *   1. open Circuit input (capture) + output (transport)
 *   2. Stop -> Program Change ch16 (project direct-access) -> wait for load
 *   3. Start + drift-corrected 24 PPQN clock stream at BPM
 *   4. record driver-timestamped note-ons of the probe pitch classes
 *   5. after N loops of the decisive probe (or timeout): Stop, analyze, verdict
 *
 * Probe map (pitch class, octave-agnostic):
 *   C=step0 d0, D=step8 d0, E=step16 d0, F=step24 slot d0, G=step24 slot d3.
 * Decisive measurement: t(G)-t(F) within a step. Honored delay -> 3 micro-ticks
 * = half a 16th step; quantized MIDI-out -> ~0 ms.
 *
 *   npx tsx scripts/b0-drive-and-capture.ts [projectSlot=0] [bpm=120] [loops=6] [timeoutSec=75]
 */
import midi from '@julusian/midi';

const SLOT = Number(process.argv[2] ?? 0);
const BPM = Number(process.argv[3] ?? 120);
const WANT_LOOPS = Number(process.argv[4] ?? 6);
const TIMEOUT_S = Number(process.argv[5] ?? 75);

const PROBE_BY_PC: Record<number, string> = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G' };
interface Onset { t: number; probe: string; note: number; ch: number; vel: number }

function findPort<T extends midi.Input | midi.Output>(p: T, label: string): number {
  for (let i = 0; i < p.getPortCount(); i++) {
    if (p.getPortName(i).toLowerCase().includes('circuit')) return i;
  }
  throw new Error(`no Circuit Tracks MIDI ${label} port`);
}

const input = new midi.Input();
const output = new midi.Output();
const inIdx = findPort(input, 'input');
const outIdx = findPort(output, 'output');

const onsets: Onset[] = [];
let clock = 0;
let gCount = 0;
let done = false;

input.ignoreTypes(true, true, true);
input.on('message', (dt, bytes) => {
  clock += dt;
  if (done || bytes.length < 3) return;
  const status = bytes[0];
  if ((status & 0xf0) !== 0x90 || bytes[2] === 0) return;
  const probe = PROBE_BY_PC[bytes[1] % 12];
  if (!probe) return;
  onsets.push({ t: clock, probe, note: bytes[1], ch: (status & 0x0f) + 1, vel: bytes[2] });
  process.stderr.write(`\r${onsets.length} probe note-ons  last=${probe} n${bytes[1]} ch${(status & 0x0f) + 1} t=${clock.toFixed(4)}s   `);
  if (probe === 'G' && ++gCount >= WANT_LOOPS) finish('collected requested loops');
});

input.openPort(inIdx);
output.openPort(outIdx);
console.error(`✓ input [${inIdx}] + output [${outIdx}] "Circuit Tracks" open. Project slot ${SLOT}, ${BPM} BPM, ${WANT_LOOPS} loops.`);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Drift-corrected 24 PPQN clock stream anchored to the wall clock.
const tickMs = 60000 / (BPM * 24);
let ticking = false;
let tickN = 0;
let tickT0 = 0;
function startClockStream(): void {
  ticking = true;
  tickT0 = performance.now();
  const pump = (): void => {
    if (!ticking) return;
    const now = performance.now();
    while (tickT0 + tickN * tickMs <= now) {
      output.sendMessage([0xf8]);
      tickN++;
    }
    const next = tickT0 + tickN * tickMs - performance.now();
    setTimeout(pump, Math.max(0, next - 1));
  };
  output.sendMessage([0xfa]); // Start
  pump();
}

function finish(reason: string): void {
  if (done) return;
  done = true;
  ticking = false;
  try { output.sendMessage([0xfc]); } catch { /* port dead */ }
  clearTimeout(killer);
  setTimeout(() => {
    try { input.closePort(); } catch { /* closed */ }
    try { output.closePort(); } catch { /* closed */ }
    analyze(reason);
  }, 200);
}

function stats(xs: number[]): { n: number; mean: number; min: number; max: number } {
  const n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : NaN;
  return { n, mean, min: Math.min(...xs), max: Math.max(...xs) };
}
const ms = (s: number) => (s * 1000).toFixed(1);

function analyze(reason: string): void {
  console.error(`\n\nStopped (${reason}). ${onsets.length} probe note-ons captured.`);
  if (onsets.length === 0) {
    console.error('❌ NOTHING captured — project load / transport / MIDI-2 USB routing failed.');
    process.exit(2);
  }
  const baseline: number[] = [];
  const fToG: number[] = [];
  const eToF: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    const a = onsets[i - 1], b = onsets[i];
    const key = a.probe + b.probe;
    const dt = b.t - a.t;
    if (key === 'CD' || key === 'DE') baseline.push(dt);
    else if (key === 'FG') fToG.push(dt);
    else if (key === 'EF') eToF.push(dt);
  }
  const base = stats(baseline);
  const step = base.mean / 8;
  const predicted = step / 2;
  const pair = stats(fToG);

  console.log('\n── B0 DECODE SUMMARY ──────────────────────────────────────');
  console.log(`baseline 8-step IOIs (C→D, D→E): n=${base.n} mean=${ms(base.mean)}ms [${ms(base.min)}..${ms(base.max)}]`);
  console.log(`  → step (16th) = ${ms(step)}ms, micro-tick = ${ms(step / 6)}ms`);
  console.log(`E→F 8-step check: n=${eToF.length} mean=${ms(stats(eToF).mean)}ms (expect ≈ baseline)`);
  console.log(`DECISIVE F→G same-step pair (delay 0 vs 3): n=${pair.n} mean=${ms(pair.mean)}ms [${ms(pair.min)}..${ms(pair.max)}]`);
  console.log(`  predicted if wire honors delay: ${ms(predicted)}ms; if quantized: ~0-2ms`);

  if (!pair.n || !base.n || !isFinite(step)) {
    console.log('VERDICT: INSUFFICIENT DATA — need at least one loop with both F and G onsets.');
    process.exit(2);
  }
  const ratio = pair.mean / predicted;
  console.log(`  ratio measured/predicted = ${ratio.toFixed(2)}`);
  if (ratio >= 0.6) console.log('VERDICT: ✅ DELAY IS ON THE WIRE — MIDI-out transmits micro-timing. Front B is GO.');
  else if (ratio <= 0.2) console.log('VERDICT: ❌ QUANTIZED — MIDI-out ignores note delay. Front B is a dead end for external gear.');
  else console.log('VERDICT: ⚠ AMBIGUOUS — shift present but far from 3 micro-ticks. Inspect raw onsets.');
  console.log('\nraw onsets (t seconds, probe, wire note, ch, vel):');
  for (const o of onsets) console.log(`  ${o.t.toFixed(4)}  ${o.probe}  ${o.note}  ch${o.ch}  v${o.vel}`);
  process.exit(0);
}

const killer = setTimeout(() => finish('timeout'), TIMEOUT_S * 1000);

(async () => {
  output.sendMessage([0xfc]);                 // clean transport state
  await sleep(300);
  output.sendMessage([0xcf, SLOT & 0x7f]);    // PC ch16 -> project direct-access
  console.error(`  sent PC ch16 program ${SLOT}; waiting 2.5s for the project load...`);
  await sleep(2500);
  console.error(`  starting transport + ${BPM} BPM clock stream (tick every ${tickMs.toFixed(2)}ms)...`);
  startClockStream();
})();
