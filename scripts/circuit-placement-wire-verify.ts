/**
 * circuit-placement-wire-verify — end-to-end proof that an authored project's
 * micro-step placement arrives on the Circuit's MIDI-OUT wire (the Gethsemane
 * accuracy test; generalizes the B0 gate probe).
 *
 * Decodes the EXPECTED onsets straight from the .ncs bytes (midi2 pattern 0:
 * every note slot → micro-tick step*6+delay, wire note = authored-12), then
 * drives the device exactly like scripts/b0-drive-and-capture.ts (PC ch16
 * project select, Start + drift-corrected 24 PPQN clock) while timestamping
 * the received note-ons. Alignment is brute-force: the first captured onset is
 * tried against every same-note expected onset; the hypothesis minimizing the
 * total match error wins. Fully automated, no human observation step.
 *
 *   npx tsx scripts/circuit-placement-wire-verify.ts <file.ncs> [slot=1] [bpm=120] [loops=3] [timeoutSec=60]
 */
import { readFileSync } from 'node:fs';
import midi from '@julusian/midi';
import { decodeNotePattern } from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';

const FILE = process.argv[2] ?? 'samples/circuit-tracks/grooves/gm/gethsemane_electronic_accurate.ncs';
const SLOT = Number(process.argv[3] ?? 1);
const BPM = Number(process.argv[4] ?? 120);
const WANT_LOOPS = Number(process.argv[5] ?? 3);
const TIMEOUT_S = Number(process.argv[6] ?? 60);

const STEPS = 32;
const TICKS_PER_LOOP = STEPS * 6;
const OCTAVE = 12; // Circuit transmits MIDI-track notes an octave below the stored value

// ── expected onsets from the file bytes ──────────────────────────────
const buf = new Uint8Array(readFileSync(FILE));
const pattern = decodeNotePattern(buf, 'midi2', 0);
interface Expected { tick: number; note: number }
const expected: Expected[] = [];
for (let s = 0; s < STEPS; s++) {
  for (const n of pattern[s].notes) expected.push({ tick: s * 6 + n.delay, note: n.note - OCTAVE });
}
expected.sort((a, b) => a.tick - b.tick);
if (expected.length === 0) { console.error('no onsets in midi2 pattern 0 — wrong file?'); process.exit(1); }
console.error(`✓ ${FILE}: ${expected.length} expected onsets/loop (notes ${[...new Set(expected.map((e) => e.note))].join(',')})`);

// ── capture + drive ──────────────────────────────────────────────────
function findPort<T extends midi.Input | midi.Output>(p: T, label: string): number {
  for (let i = 0; i < p.getPortCount(); i++) if (p.getPortName(i).toLowerCase().includes('circuit')) return i;
  throw new Error(`no Circuit Tracks MIDI ${label} port`);
}
const input = new midi.Input();
const output = new midi.Output();
const inIdx = findPort(input, 'input');
const outIdx = findPort(output, 'output');

interface Onset { t: number; note: number }
const onsets: Onset[] = [];
let clock = 0;
let done = false;
const wanted = new Set(expected.map((e) => e.note));
const stopAt = expected.length * WANT_LOOPS;

input.ignoreTypes(true, true, true);
input.on('message', (dt, bytes) => {
  clock += dt;
  if (done || bytes.length < 3) return;
  if ((bytes[0] & 0xf0) !== 0x90 || bytes[2] === 0) return;
  if (!wanted.has(bytes[1])) return;
  onsets.push({ t: clock, note: bytes[1] });
  process.stderr.write(`\r${onsets.length}/${stopAt} note-ons   `);
  if (onsets.length >= stopAt) finish('collected requested loops');
});
input.openPort(inIdx);
output.openPort(outIdx);

const tickMsClock = 60000 / (BPM * 24);      // MIDI clock tick
const microMs = (60000 / BPM) / 4 / 6;       // one micro-tick (16th/6)
let ticking = false;
let tickN = 0;
let tickT0 = 0;
function pump(): void {
  if (!ticking) return;
  const now = performance.now();
  while (tickT0 + tickN * tickMsClock <= now) { output.sendMessage([0xf8]); tickN++; }
  setTimeout(pump, Math.max(0, tickT0 + tickN * tickMsClock - performance.now() - 1));
}

const killer = setTimeout(() => finish('timeout'), TIMEOUT_S * 1000);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function finish(reason: string): void {
  if (done) return;
  done = true;
  ticking = false;
  try { output.sendMessage([0xfc]); } catch { /* dead */ }
  clearTimeout(killer);
  setTimeout(() => {
    try { input.closePort(); } catch { /* closed */ }
    try { output.closePort(); } catch { /* closed */ }
    analyze(reason);
  }, 200);
}

function analyze(reason: string): void {
  console.error(`\nStopped (${reason}). ${onsets.length} note-ons captured.`);
  if (onsets.length < expected.length) {
    console.error('❌ fewer onsets than one loop — playback / routing failed.');
    process.exit(2);
  }
  // Brute-force anchor: align captured[0] to each same-note expected onset; the
  // hypothesis with the lowest mean |error| wins.
  const first = onsets[0];
  let best: { anchorTick: number; meanAbs: number; errs: Map<number, number[]> } | undefined;
  for (const cand of expected.filter((e) => e.note === first.note)) {
    const errs = new Map<number, number[]>();
    let sumAbs = 0;
    let matched = 0;
    for (const o of onsets) {
      const absTick = cand.tick + ((o.t - first.t) * 1000) / microMs;
      const foldTick = ((absTick % TICKS_PER_LOOP) + TICKS_PER_LOOP) % TICKS_PER_LOOP;
      // nearest same-note expected onset (wrap-aware)
      let bestErr = Infinity;
      let bestTick = -1;
      for (const e of expected) {
        if (e.note !== o.note) continue;
        let d = foldTick - e.tick;
        if (d > TICKS_PER_LOOP / 2) d -= TICKS_PER_LOOP;
        if (d < -TICKS_PER_LOOP / 2) d += TICKS_PER_LOOP;
        if (Math.abs(d) < Math.abs(bestErr)) { bestErr = d; bestTick = e.tick; }
      }
      if (bestTick >= 0) {
        const arr = errs.get(bestTick) ?? [];
        arr.push(bestErr);
        errs.set(bestTick, arr);
        sumAbs += Math.abs(bestErr);
        matched++;
      }
    }
    const meanAbs = sumAbs / Math.max(1, matched);
    if (!best || meanAbs < best.meanAbs) best = { anchorTick: cand.tick, meanAbs, errs };
  }
  if (!best) { console.error('no alignment found'); process.exit(2); }

  console.log('\n── PLACEMENT WIRE VERIFY ──────────────────────────────────');
  console.log(`expected onsets/loop: ${expected.length}; captured: ${onsets.length}; anchor tick ${best.anchorTick}`);
  console.log(`mean |error| = ${(best.meanAbs * microMs).toFixed(1)}ms = ${best.meanAbs.toFixed(2)} micro-ticks (tick = ${microMs.toFixed(1)}ms)`);
  const missed = expected.filter((e) => !best!.errs.has(e.tick));
  const offGrid = expected.filter((e) => e.tick % 6 !== 0);
  const offGridHit = offGrid.filter((e) => {
    const errs = best!.errs.get(e.tick);
    return errs !== undefined && Math.abs(errs.reduce((a, b) => a + b, 0) / errs.length) <= 0.5;
  });
  console.log(`micro-PLACED onsets (tick%6≠0): ${offGrid.length}/loop; matched on the wire within ±½ tick: ${offGridHit.length}`);
  if (missed.length > 0) console.log(`expected onsets never matched: ${missed.map((e) => `${e.note}@${e.tick}`).join(', ')}`);
  const ok = best.meanAbs <= 0.5 && offGridHit.length === offGrid.length;
  console.log(ok
    ? 'VERDICT: ✅ every placed micro-tick arrives on the wire at its authored position.'
    : 'VERDICT: ⚠ placement partially confirmed — inspect the per-tick errors below.');
  console.log('\nper-expected-tick mean error (micro-ticks), placed onsets first:');
  const rows = [...best.errs.entries()].sort((a, b) => (b[0] % 6 === 0 ? 0 : 1) - (a[0] % 6 === 0 ? 0 : 1) || a[0] - b[0]);
  for (const [tick, errs] of rows) {
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    const e = expected.find((x) => x.tick === tick);
    console.log(`  tick ${String(tick).padStart(3)} (step ${Math.floor(tick / 6)}+${tick % 6}, note ${e?.note}): n=${errs.length} mean ${mean >= 0 ? '+' : ''}${mean.toFixed(2)}`);
  }
  process.exit(ok ? 0 : 1);
}

(async () => {
  output.sendMessage([0xfc]);
  await sleep(300);
  output.sendMessage([0xcf, SLOT & 0x7f]);
  console.error(`  sent PC ch16 program ${SLOT}; waiting 2.5s for the project load…`);
  await sleep(2500);
  console.error(`  Start + ${BPM} BPM clock; expecting ~${(TICKS_PER_LOOP * microMs / 1000).toFixed(1)}s/loop…`);
  ticking = true;
  tickT0 = performance.now();
  output.sendMessage([0xfa]);
  pump();
})();
