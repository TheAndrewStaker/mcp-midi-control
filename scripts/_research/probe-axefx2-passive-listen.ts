/**
 * Passive listener that captures EVERY inbound MIDI frame from the
 * Axe-Fx II for a configurable duration, then summarizes what arrived.
 *
 * Note on virtual-port filtering: AxeEdit (the desktop editor) filters
 * out class-compliant virtual MIDI ports by driver class via
 * `midiInGetDevCaps` / `midiOutGetDevCaps`, which means we CAN'T
 * sit between AxeEdit and the device to snoop AxeEdit's traffic. But
 * we CAN open the device's real input port directly, and the device's
 * outbound traffic — including state broadcasts and any responses to
 * MIDI sent FROM the device's front panel — is visible there.
 *
 * Use cases:
 *
 *   1. Founder turns a knob on the device → captures the resulting
 *      0x74/0x75/0x76 state-broadcast triple. Confirms the broadcast
 *      structure under live edits.
 *
 *   2. Founder changes scene via the device front panel → captures
 *      any inbound that signals the scene change (fn 0x29? a flood
 *      of triples?). Tells us how the device announces scene moves.
 *
 *   3. Founder switches presets via the device front panel → captures
 *      the inbound traffic during a preset load. Confirms whether
 *      the device emits anything beyond the basic switch.
 *
 *   4. Founder bypasses a block via the front-panel switches →
 *      captures the bypass-change broadcast. Decodes the wire shape
 *      of front-panel bypass events.
 *
 * READ-ONLY. No outgoing MIDI. Pure listener.
 *
 * Run:
 *
 *   npx tsx scripts/_research/probe-axefx2-passive-listen.ts [seconds]
 *
 * Default duration: 30 seconds.
 */

import midi from 'midi';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

function findPort(io: midi.Input | midi.Output, needles: string[]): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    const name = io.getPortName(i);
    for (const n of needles) {
      if (name.toLowerCase().includes(n.toLowerCase())) {
        console.log(`  matched port [${i}] ${name}`);
        return i;
      }
    }
  }
  return -1;
}

function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

async function main(): Promise<void> {
  const durationSec = parseInt(process.argv[2] ?? '30', 10);
  console.log(`Axe-Fx II passive listener — capturing for ${durationSec} seconds`);

  const input = new midi.Input();
  const needles = ['Axe-Fx II', 'AxeFxII', 'AXE-FX II', 'XL+'];
  const inIdx = findPort(input, needles);
  if (inIdx < 0) { console.error('ERROR: Axe-Fx II input port not found'); process.exit(1); }

  input.ignoreTypes(false, true, true);
  const collected: Array<{ t: number; bytes: number[] }> = [];
  const startMs = Date.now();
  input.on('message', (_dt, bytes) => {
    if (bytes[0] === 0xf0) collected.push({ t: Date.now() - startMs, bytes: bytes.slice() });
  });
  input.openPort(inIdx);

  console.log('\nListening… interact with the device (turn knobs, switch scenes,');
  console.log('toggle bypass, switch presets, launch AxeEdit, etc.). Every inbound');
  console.log('Fractal SysEx frame is logged with a timestamp.\n');

  // Stream summary every 5s so the founder sees progress.
  const interval = setInterval(() => {
    const elapsedMs = Date.now() - startMs;
    console.log(`  [t=${(elapsedMs / 1000).toFixed(1)}s]  total inbound: ${collected.length}`);
  }, 5000);

  await new Promise<void>((r) => setTimeout(r, durationSec * 1000));
  clearInterval(interval);
  input.closePort();

  // ── Per-fn-byte histogram ──
  const fnCounts = new Map<number, { count: number; minLen: number; maxLen: number }>();
  for (const { bytes } of collected) {
    if (bytes.length >= 6 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x74) {
      const fn = bytes[5];
      const s = fnCounts.get(fn);
      if (s) {
        s.count++;
        s.minLen = Math.min(s.minLen, bytes.length);
        s.maxLen = Math.max(s.maxLen, bytes.length);
      } else {
        fnCounts.set(fn, { count: 1, minLen: bytes.length, maxLen: bytes.length });
      }
    }
  }
  console.log('\n────────────────────────────────────────────────────────────');
  console.log(`SUMMARY: ${collected.length} Fractal frames in ${durationSec}s`);
  console.log('────────────────────────────────────────────────────────────');
  console.log('Per-fn-byte histogram:');
  const sorted = Array.from(fnCounts.entries()).sort((a, b) => b[1].count - a[1].count);
  for (const [fn, s] of sorted) {
    const lenDesc = s.minLen === s.maxLen ? `len=${s.minLen}` : `len=${s.minLen}..${s.maxLen}`;
    console.log(`  fn=0x${fn.toString(16).padStart(2, '0')}  count=${String(s.count).padStart(5)}  ${lenDesc}`);
  }

  // ── Print first 30 non-tempo-beat frames with timestamps ──
  console.log('\nFirst 30 non-tempo (0x10) frames with timestamps:');
  const notTempo = collected.filter((c) => c.bytes[5] !== 0x10);
  for (let i = 0; i < Math.min(30, notTempo.length); i++) {
    const { t, bytes } = notTempo[i];
    const fn = bytes[5];
    const preview = toHex(bytes.slice(0, Math.min(24, bytes.length)));
    console.log(`  [t=${(t / 1000).toFixed(2)}s] fn=0x${fn.toString(16).padStart(2, '0')} len=${bytes.length}  ${preview}${bytes.length > 24 ? ' …' : ''}`);
  }
  if (notTempo.length > 30) console.log(`  ... (${notTempo.length - 30} more non-tempo frames)`);

  // ── State-broadcast triple specific output ──
  const triples = collected.filter((c) => c.bytes[5] === 0x74 || c.bytes[5] === 0x75 || c.bytes[5] === 0x76);
  if (triples.length > 0) {
    console.log(`\n${triples.length} state-broadcast frames captured:`);
    for (let i = 0; i < Math.min(20, triples.length); i++) {
      const { t, bytes } = triples[i];
      console.log(`  [t=${(t / 1000).toFixed(2)}s] fn=0x${bytes[5].toString(16)} len=${bytes.length}  ${toHex(bytes.slice(0, 16))}…`);
    }
    if (triples.length > 20) console.log(`  ... (${triples.length - 20} more)`);
  } else {
    console.log('\nNo state-broadcast triples captured (knob turn / front-panel edit didn\'t happen during the window).');
  }

  // ── Save raw bytes ──
  mkdirSync('samples/captured', { recursive: true });
  const fname = `probe-axefx2-passive-${Math.floor(startMs / 1000)}.syx`;
  const out = path.resolve('samples/captured', fname);
  const concat = collected.flatMap((c) => c.bytes);
  writeFileSync(out, Uint8Array.from(concat));
  console.log(`\nSaved ${concat.length} bytes to ${out}`);

  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(99);
});
