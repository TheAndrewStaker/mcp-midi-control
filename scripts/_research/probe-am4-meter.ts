/**
 * AM4 DSP meter polling probe — MESSAGE_GET_METER (action 0x2B)
 * ==============================================================
 *
 * Session 104 (2026-05-20). Polls action 0x2B (MESSAGE_GET_METER) at
 * 20 Hz for 5 seconds while suggesting the user play notes through
 * the AM4 to vary the meter reading. Captures the response shape and
 * tracks whether the values change with audio activity.
 *
 * # Why a separate script
 *
 * Unlike the other read/write probes (single-shot per opcode), the
 * meter is INTERESTING ONLY IF IT TRACKS LIVE AUDIO. So this probe
 * needs to poll repeatedly while the user generates signal. A single
 * sample tells us almost nothing about whether the meter works.
 *
 * # What it tests
 *
 *   1. Sends `MESSAGE_GET_METER` with several addressing variants
 *      (no target, per-block) once each to establish the wire shape
 *      and which variant returns variable data.
 *   2. Polls the most-responsive variant at 50 ms intervals for 5
 *      seconds.
 *   3. Logs the response value per poll and reports min/max/variance.
 *
 * # Interpretation
 *
 *   - **Variance > 0 with audio**: meter tracks live DSP signal.
 *     Wire shape unlocks real-time level monitoring.
 *   - **Constant zero / constant nonzero**: meter is informational
 *     but doesn't track audio (maybe input-gain setting only).
 *   - **No response**: action doesn't apply or needs different
 *     addressing.
 *
 * # Safety
 *
 *   READ-ONLY. No writes. Safe to run any time.
 *
 * # Prereqs
 *
 *   - AM4 powered on, USB connected.
 *   - Guitar plugged in (otherwise no signal to meter).
 *   - **Close AM4-Edit before running.**
 *
 * # Run
 *
 *   npx tsx scripts/_research/probe-am4-meter.ts
 *
 * # During the 5-second polling window
 *
 *   PLAY THROUGH THE AM4. Strum chords, palm-mute, single notes.
 *   The probe will print readings as they come in. If the values
 *   change with your playing, the meter is live.
 */

import midi from 'midi';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { BLOCK_TYPE_VALUES } from 'fractal-midi/am4';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const AM4_MODEL = 0x15;
const FUNC_PARAM_RW = 0x01;
const ACTION_GET_METER = 0x2b;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}

function encode14(n: number): [number, number] {
  return [n & 0x7f, (n >> 7) & 0x7f];
}

function buildMeterRead(pidLow: number, pidHigh: number): number[] {
  const head = [
    SYSEX_START, ...FRACTAL_MFR, AM4_MODEL, FUNC_PARAM_RW,
    ...encode14(pidLow), ...encode14(pidHigh), ...encode14(ACTION_GET_METER),
    ...encode14(0x0000), ...encode14(0x0000),
  ];
  const cs = fractalChecksum(head);
  return [...head, cs, SYSEX_END];
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

interface AddressingVariant {
  name: string;
  pidLow: number;
  pidHigh: number;
}

const VARIANTS: AddressingVariant[] = [
  { name: 'global (0,0)',          pidLow: 0x0000,                 pidHigh: 0x0000 },
  { name: 'AMP block',             pidLow: BLOCK_TYPE_VALUES.amp,  pidHigh: 0x0000 },
  { name: 'DRIVE block',           pidLow: BLOCK_TYPE_VALUES.drive,pidHigh: 0x0000 },
  { name: 'REVERB block',          pidLow: BLOCK_TYPE_VALUES.reverb,pidHigh: 0x0000 },
  { name: 'preset-level (0xCE,0xB)',pidLow: 0x00ce,                pidHigh: 0x000b },
  { name: 'pidHigh=0x0001',        pidLow: 0x0000,                 pidHigh: 0x0001 },
];

async function main(): Promise<void> {
  console.log('AM4 DSP meter probe (action 0x2B / MESSAGE_GET_METER)');
  console.log('═════════════════════════════════════════════════════');

  const input = new midi.Input();
  const output = new midi.Output();
  console.log('\nInput ports:');
  for (let i = 0; i < input.getPortCount(); i++) console.log(`  [${i}] ${input.getPortName(i)}`);
  console.log('\nOutput ports:');
  for (let i = 0; i < output.getPortCount(); i++) console.log(`  [${i}] ${output.getPortName(i)}`);

  const needles = ['AM4', 'Axe Effects', 'Fractal'];
  const outIdx = findPort(output, needles);
  if (outIdx < 0) { console.error('ERROR: AM4 output port not found'); process.exit(1); }
  const inIdx = findPort(input, needles);
  if (inIdx < 0) { console.error('ERROR: AM4 input port not found'); process.exit(1); }

  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);
  const collected: number[][] = [];
  input.on('message', (_dt, bytes) => {
    if (bytes[0] === 0xf0) collected.push(bytes.slice());
  });
  input.openPort(inIdx);

  await sleep(500);
  collected.length = 0;

  // ── Phase 1: probe each addressing variant once ──────────────
  console.log('\nPhase 1: identify the most-responsive addressing variant\n');
  type VariantResult = { variant: AddressingVariant; inbound: number[][] };
  const phase1: VariantResult[] = [];
  for (const v of VARIANTS) {
    const req = buildMeterRead(v.pidLow, v.pidHigh);
    console.log(`  ${v.name}:`);
    console.log(`    SEND: ${toHex(req)}`);
    const before = collected.length;
    output.sendMessage(req);
    await sleep(400);
    const inbound = collected.slice(before);
    console.log(`    RX: ${inbound.length} frames`);
    for (const f of inbound) {
      console.log(`      len=${f.length} ${toHex(f.slice(0, 24))}${f.length > 24 ? ' …' : ''}`);
    }
    phase1.push({ variant: v, inbound });
    await sleep(100);
  }

  // ── Pick the variant with the most-promising response shape ──
  // Prefer length > 18 (meaningful payload), then any non-echo.
  let chosen: AddressingVariant | null = null;
  for (const r of phase1) {
    const req = buildMeterRead(r.variant.pidLow, r.variant.pidHigh);
    const hasResp = r.inbound.some((f) => !(f.length === req.length && f.every((b, i) => b === req[i])));
    if (hasResp && r.inbound.some((f) => f.length > 18)) {
      chosen = r.variant;
      break;
    }
  }
  if (!chosen) {
    for (const r of phase1) {
      if (r.inbound.length > 0) { chosen = r.variant; break; }
    }
  }
  if (!chosen) {
    console.log('\n🔴 No variant produced any response. MESSAGE_GET_METER may not be supported by this firmware.');
    input.closePort();
    output.closePort();
    process.exit(0);
  }
  console.log(`\nPhase 2: polling chosen variant "${chosen.name}" at 20 Hz for 5 seconds.`);
  console.log('         ── PLAY THROUGH THE AM4 NOW ─── strum / palm-mute / single notes.');
  console.log();

  // ── Phase 2: 5-second poll ───────────────────────────────────
  const POLL_INTERVAL_MS = 50;
  const POLL_DURATION_MS = 5000;
  const POLL_COUNT = Math.floor(POLL_DURATION_MS / POLL_INTERVAL_MS);

  interface Sample { t: number; rawBytes: number[]; }
  const samples: Sample[] = [];
  const meterReq = buildMeterRead(chosen.pidLow, chosen.pidHigh);
  const t0 = Date.now();
  for (let i = 0; i < POLL_COUNT; i++) {
    const tPoll = Date.now() - t0;
    const before = collected.length;
    output.sendMessage(meterReq);
    await sleep(POLL_INTERVAL_MS);
    const inbound = collected.slice(before);
    // Take the first non-echo response (if any).
    for (const f of inbound) {
      if (f.length !== meterReq.length || !f.every((b, j) => b === meterReq[j])) {
        samples.push({ t: tPoll, rawBytes: f });
        // Compact one-line log every 5 polls.
        if (i % 5 === 0) {
          console.log(`  t=${tPoll.toString().padStart(4)}ms  len=${f.length}  ${toHex(f.slice(0, 24))}${f.length > 24 ? ' …' : ''}`);
        }
        break;
      }
    }
  }

  console.log(`\nCollected ${samples.length} meter samples in 5 s.`);

  // ── Variance analysis ──────────────────────────────────────────
  // Extract the bytes at each offset and compute spread.
  if (samples.length > 0) {
    const len = samples[0]!.rawBytes.length;
    const byteVariance: number[] = [];
    for (let off = 0; off < len; off++) {
      const values = samples.map((s) => s.rawBytes[off] ?? 0);
      const min = Math.min(...values);
      const max = Math.max(...values);
      byteVariance.push(max - min);
    }
    console.log('\nPer-byte variance (max-min across samples):');
    for (let off = 0; off < len; off++) {
      const v = byteVariance[off]!;
      const flag = v > 0 ? '←' : ' ';
      console.log(`  off=${off.toString().padStart(2)}  variance=${v.toString().padStart(3)}  ${flag}`);
    }
    const varyingOffsets = byteVariance.map((v, i) => v > 0 ? i : -1).filter((i) => i >= 0);
    if (varyingOffsets.length === 0) {
      console.log('\n🟡 Meter response is CONSTANT — does not track live signal.');
    } else {
      console.log(`\n🟢 Meter response VARIES at byte offsets [${varyingOffsets.join(', ')}] — tracks live signal!`);
    }
  }

  // ── Save artifacts ───────────────────────────────────────────
  mkdirSync('samples/captured', { recursive: true });
  const out = path.resolve('samples/captured/probe-am4-meter-findings.md');
  const lines: string[] = [
    `# AM4 MESSAGE_GET_METER probe — findings`,
    ``,
    `> Auto-generated by \`scripts/_research/probe-am4-meter.ts\` at ${new Date().toISOString()}`,
    ``,
    `## Phase 1 — addressing variants`,
    ``,
    `| Variant | Inbound frames | Notable |`,
    `|---|---|---|`,
  ];
  for (const r of phase1) {
    const req = buildMeterRead(r.variant.pidLow, r.variant.pidHigh);
    const nonEcho = r.inbound.filter((f) => f.length !== req.length || !f.every((b, j) => b === req[j]));
    lines.push(`| ${r.variant.name} | ${r.inbound.length} | ${nonEcho.length > 0 ? `${nonEcho.length} non-echo` : 'echo only'} |`);
  }
  if (chosen) {
    lines.push('', `Chosen for poll phase: **${chosen.name}**`, '');
  }
  lines.push('## Phase 2 — 5-second poll', '');
  lines.push(`Samples collected: ${samples.length}`, '');
  if (samples.length > 0) {
    lines.push('First 10 samples (t in ms, raw hex):', '');
    lines.push('```');
    for (const s of samples.slice(0, 10)) {
      lines.push(`t=${s.t.toString().padStart(4)}ms  ${toHex(s.rawBytes)}`);
    }
    lines.push('```');
  }
  writeFileSync(out, lines.join('\n'));
  console.log(`\nWrote findings to ${out}`);

  input.closePort();
  output.closePort();
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
