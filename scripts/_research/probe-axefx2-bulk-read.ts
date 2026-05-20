/**
 * Probe the three "atomic read" envelopes the Ghidra opcode-table dump
 * (Session 103) suggested but we haven't verified live yet:
 *
 *   1. fn 0x21 SYSEX_RESYNC               — request device push state.
 *      Hypothesis: device responds with 0x74/0x75/0x76 state-broadcast
 *      triples, one per placed block. We already decode those.
 *
 *   2. fn 0x1F SYSEX_GET_ALL_PARAMS [blockId_lo, blockId_hi] — bulk
 *      per-block param dump. Hypothesis: device responds with a
 *      structured envelope listing every param of the queried block.
 *
 *   3. fn 0x0E SYSEX_QUERY_STATES [empty?] — bulk block-inventory.
 *      Already observed in session-58-direct-sync.syx (62-byte response
 *      with 10 chunks × 5 bytes); confirms the OUTBOUND query shape.
 *
 * READ-ONLY probe. Sends each envelope, listens for inbound frames
 * for 2 s, decodes anything captured. No writes, no state mutation.
 *
 * Prereq: Axe-Fx II XL+ powered on and connected via USB. node-midi
 * installed. Run:
 *
 *   npx tsx scripts/_research/probe-axefx2-bulk-read.ts
 *
 * Output: per-envelope summary on stdout, plus raw bytes saved to
 * samples/captured/probe-axefx2-bulk-read.syx for offline analysis.
 */

import midi from 'midi';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

const AXE_FX_II_MODEL = 0x07;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}

/** Build a Fractal SysEx envelope: F0 00 01 74 [model] [fn] [payload] [cs] F7. */
function buildEnvelope(fn: number, payload: number[] = []): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, AXE_FX_II_MODEL, fn, ...payload];
  const cs = fractalChecksum(head);
  return [...head, cs, SYSEX_END];
}

function encode14(n: number): [number, number] {
  return [n & 0x7f, (n >> 7) & 0x7f];
}

function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ProbeResult {
  name: string;
  request: number[];
  inboundFrames: number[][];
}

async function probe(
  name: string,
  request: number[],
  output: midi.Output,
  collected: number[][],
  durationMs: number,
): Promise<ProbeResult> {
  console.log(`\n── ${name} ──`);
  console.log(`  SEND (${request.length}B): ${toHex(request)}`);
  // Snapshot collected length BEFORE send so we can extract only this probe's inbound.
  const before = collected.length;
  output.sendMessage(request);
  await sleep(durationMs);
  const inboundFrames = collected.slice(before);
  console.log(`  Received ${inboundFrames.length} inbound frames in ${durationMs}ms`);
  for (let i = 0; i < inboundFrames.length; i++) {
    const f = inboundFrames[i];
    const fn = f.length >= 6 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74
      ? `fn=0x${f[5]?.toString(16).padStart(2, '0')}`
      : '(non-Fractal)';
    const preview = toHex(f.slice(0, Math.min(20, f.length)));
    console.log(`    [${i}] ${fn} len=${f.length}  ${preview}${f.length > 20 ? ' …' : ''}`);
  }
  return { name, request, inboundFrames };
}

async function main(): Promise<void> {
  console.log('Axe-Fx II bulk-read probe (read-only)');

  const input = new midi.Input();
  const output = new midi.Output();

  console.log('\nInput ports:');
  for (let i = 0; i < input.getPortCount(); i++) console.log(`  [${i}] ${input.getPortName(i)}`);
  console.log('\nOutput ports:');
  for (let i = 0; i < output.getPortCount(); i++) console.log(`  [${i}] ${output.getPortName(i)}`);

  const needles = ['Axe-Fx II', 'AxeFxII', 'AXE-FX II', 'XL+'];
  const outIdx = findPort(output, needles);
  if (outIdx < 0) { console.error('ERROR: Axe-Fx II output port not found'); process.exit(1); }
  const inIdx = findPort(input, needles);
  if (inIdx < 0) { console.error('ERROR: Axe-Fx II input port not found'); process.exit(1); }

  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);
  // Collect every inbound frame.
  const collected: number[][] = [];
  input.on('message', (_dt, bytes) => {
    if (bytes[0] === 0xf0) collected.push(bytes.slice());
  });
  input.openPort(inIdx);
  console.log('  ports opened');

  // Brief warmup — let any device-initial broadcast settle.
  await sleep(500);
  collected.length = 0;
  console.log(`  warmup done, ${collected.length} inbound after settle`);

  const results: ProbeResult[] = [];

  // ── Probe 1: fn 0x21 SYSEX_RESYNC (long listen — device may flood) ──
  // Hypothesis: triggers a series of 0x74/0x75/0x76 state-broadcast
  // triples, one per placed block. 5s listen handles slow floods.
  results.push(
    await probe('fn 0x21 SYSEX_RESYNC', buildEnvelope(0x21), output, collected, 5000),
  );

  // ── Probe 2a: fn 0x1F SYSEX_GET_ALL_PARAMS — empty payload ──
  // Tests whether the envelope returns global state without a target.
  results.push(
    await probe('fn 0x1F SYSEX_GET_ALL_PARAMS (no payload)', buildEnvelope(0x1f), output, collected, 3000),
  );

  // ── Probe 2b: fn 0x1F SYSEX_GET_ALL_PARAMS [blockId AMP 1] ──
  // blockId AMP 1 = 106 = 0x6A. Wiki block-ID convention.
  results.push(
    await probe(
      'fn 0x1F SYSEX_GET_ALL_PARAMS (AMP 1, blockId 106)',
      buildEnvelope(0x1f, [...encode14(106)]),
      output, collected, 3000,
    ),
  );

  // ── Probe 2c: fn 0x1F with effectId padding ──
  // Some envelopes need a longer payload — try AMP 1 with 0 padding
  // matching the fn 0x18 shape (8 bytes payload).
  results.push(
    await probe(
      'fn 0x1F SYSEX_GET_ALL_PARAMS (AMP 1 + zero pad)',
      buildEnvelope(0x1f, [...encode14(106), 0, 0, 0, 0, 0, 0]),
      output, collected, 3000,
    ),
  );

  // ── Probe 3: fn 0x0E SYSEX_QUERY_STATES (empty payload) ──
  results.push(
    await probe('fn 0x0E SYSEX_QUERY_STATES (no payload)', buildEnvelope(0x0e), output, collected, 3000),
  );

  // ── Probe 4: fn 0x18 SYSEX_GET_MODIFIER_INFO (AMP 1) ──
  // Per AxeEdit's wire shape: [blockId_lo, blockId_hi, 0,0,0,0,0,0]
  results.push(
    await probe(
      'fn 0x18 SYSEX_GET_MODIFIER_INFO (AMP 1, blockId 106)',
      buildEnvelope(0x18, [...encode14(106), 0, 0, 0, 0, 0, 0]),
      output, collected, 1500,
    ),
  );

  // ── Probe 5: fn 0x47 SYSEX_GET_SYSINFO (empty payload) ──
  results.push(
    await probe('fn 0x47 SYSEX_GET_SYSINFO (no payload)', buildEnvelope(0x47), output, collected, 1500),
  );

  // ── Probe 6: fn 0x47 with the AxeEdit captured payload ──
  // session-58 had fn 0x47 with `0a 02 3d 01 00 08 04 00` (8 bytes).
  // Test whether the payload shape changes the response.
  results.push(
    await probe(
      'fn 0x47 SYSEX_GET_SYSINFO (AxeEdit-captured payload)',
      buildEnvelope(0x47, [0x0a, 0x02, 0x3d, 0x01, 0x00, 0x08, 0x04, 0x00]),
      output, collected, 1500,
    ),
  );

  // ── Save raw bytes ──
  mkdirSync('samples/captured', { recursive: true });
  const out = path.resolve('samples/captured/probe-axefx2-bulk-read.syx');
  const concat = results.flatMap((r) => [...r.request, ...r.inboundFrames.flat()]);
  writeFileSync(out, Uint8Array.from(concat));
  console.log(`\nSaved raw bytes to ${out}`);

  // ── Summary ──
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('SUMMARY (which probes got responses):');
  for (const r of results) {
    const fnCounts = new Map<number, number>();
    for (const f of r.inboundFrames) {
      if (f.length >= 6 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74) {
        const fn = f[5];
        fnCounts.set(fn, (fnCounts.get(fn) ?? 0) + 1);
      }
    }
    const summary = fnCounts.size === 0
      ? '(no Fractal inbound — fire-and-forget OR device ignored)'
      : Array.from(fnCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([fn, n]) => `fn=0x${fn.toString(16).padStart(2, '0')}×${n}`)
          .join(' ');
    console.log(`  ${r.name}: ${summary}`);
  }
  console.log('──────────────────────────────────────────────────────────────');

  input.closePort();
  output.closePort();
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(99);
});
