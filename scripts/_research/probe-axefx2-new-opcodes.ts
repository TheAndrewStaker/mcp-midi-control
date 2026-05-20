/**
 * Axe-Fx II new-opcode probe — Session 103 Ghidra follow-ups
 * ==========================================================
 *
 * Session 104 (2026-05-20). Session 103 mined the full 94-opcode wire
 * vocabulary from AxeEdit II.exe but only LIVE-PROBED a subset
 * (fn 0x21, 0x1F, 0x0E, 0x18, 0x47). This script probes the remaining
 * still-undecoded wire bytes that look most useful:
 *
 *   - fn 0x0C SYSEX_SET_GRID         — grid-position write (param TBD)
 *   - fn 0x16 SYSEX_GET_PARAM_INFO   — per-param descriptor (range, units)
 *   - fn 0x28 SYSEX_GET_PARAM_STRINGS — enum-value display strings per param
 *   - fn 0x48 SYSEX_FSGRID           — footswitch grid (probably FC-only on II)
 *   - fn 0x47 SYSEX_GET_SYSINFO payload variations
 *   - fn 0x0E SYSEX_QUERY_STATES with different payloads
 *
 * # Safety profile
 *
 *   Mixed: most probes are reads (safe). fn 0x0C SET_GRID is a WRITE
 *   and will rearrange the working buffer — gated behind --include-writes
 *   and uses a no-op shape (move a block to its current position).
 *
 * # Prereqs
 *
 *   - Axe-Fx II XL+ powered on, USB connected.
 *   - **Close AxeEdit** — its polling pollutes the inbound stream.
 *   - Active preset should have a few blocks placed (AMP, CAB at minimum)
 *     so the responses carry real data.
 *
 * # Run
 *
 *   - Read-only:           npx tsx scripts/_research/probe-axefx2-new-opcodes.ts
 *   - With write probe:    npx tsx scripts/_research/probe-axefx2-new-opcodes.ts --include-writes
 *
 * # Interpretation
 *
 * Each probe's verdict:
 *   - 🟢 responsive  — device returned a structured payload (decode next).
 *   - 🟡 ack-only    — device received but emitted only generic ack.
 *   - 🔴 silent      — likely wrong wire shape / unsupported on Q8.02.
 *
 * Findings auto-write to samples/captured/probe-axefx2-new-opcodes-findings.md.
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

interface Probe {
  name: string;
  fn: number;
  opcodeName: string;
  hypothesis: string;
  request: number[];
  listenMs?: number;
  isWrite?: boolean;
}

// Known block IDs from existing fractal-midi/axe-fx-ii catalog.
const BLOCK_AMP_1   = 106;
const BLOCK_CAB_1   = 108;
const BLOCK_REVERB_1 = 116;
const BLOCK_DELAY_1 = 112;

const PROBES: Probe[] = [
  // ── fn 0x16 GET_PARAM_INFO ─────────────────────────────────────
  // Wire shape hypothesis: [blockId_lo, blockId_hi, paramId_lo, paramId_hi]
  // Returns a long-form descriptor: range, default, units, label.
  {
    name: 'fn 0x16 GET_PARAM_INFO (AMP 1, paramId=0)',
    fn: 0x16, opcodeName: 'SYSEX_GET_PARAM_INFO',
    hypothesis: 'per-param descriptor (range, units, default, label)',
    request: buildEnvelope(0x16, [
      ...encode14(BLOCK_AMP_1),
      ...encode14(0),
    ]),
  },
  // paramId=10 — beyond the first knob, exercise the catalog.
  {
    name: 'fn 0x16 GET_PARAM_INFO (AMP 1, paramId=10)',
    fn: 0x16, opcodeName: 'SYSEX_GET_PARAM_INFO',
    hypothesis: 'same shape with different param',
    request: buildEnvelope(0x16, [
      ...encode14(BLOCK_AMP_1),
      ...encode14(10),
    ]),
  },
  // Variant with 8-byte padded payload (fn 0x18 used 8 bytes).
  {
    name: 'fn 0x16 GET_PARAM_INFO (AMP 1, padded to 8B)',
    fn: 0x16, opcodeName: 'SYSEX_GET_PARAM_INFO',
    hypothesis: 'in case the wire shape expects 8 bytes (matches GET_MODIFIER_INFO)',
    request: buildEnvelope(0x16, [
      ...encode14(BLOCK_AMP_1),
      ...encode14(0),
      0, 0, 0, 0,
    ]),
  },

  // ── fn 0x28 GET_PARAM_STRINGS ──────────────────────────────────
  // Hypothesis: returns the enum-value display strings for a param
  // (e.g., AMP.TYPE → "USA CLEAN", "USA RHYTHM 1", "USA RHYTHM 2", …).
  // This would supercede the current static enum tables in params.ts
  // for AxeFx II — the device knows its own enum names.
  {
    name: 'fn 0x28 GET_PARAM_STRINGS (AMP 1, paramId=0 = type?)',
    fn: 0x28, opcodeName: 'SYSEX_GET_PARAM_STRINGS',
    hypothesis: 'enum-value display strings — game-changer for enum coverage',
    request: buildEnvelope(0x28, [
      ...encode14(BLOCK_AMP_1),
      ...encode14(0),
    ]),
    listenMs: 3000,
  },
  // With 8-byte padding.
  {
    name: 'fn 0x28 GET_PARAM_STRINGS (AMP 1, paramId=0, padded)',
    fn: 0x28, opcodeName: 'SYSEX_GET_PARAM_STRINGS',
    hypothesis: 'same with 8B padding',
    request: buildEnvelope(0x28, [
      ...encode14(BLOCK_AMP_1),
      ...encode14(0),
      0, 0, 0, 0,
    ]),
    listenMs: 3000,
  },

  // ── fn 0x48 FSGRID ─────────────────────────────────────────────
  // Likely returns FC-12 footswitch grid mapping. Mostly informational
  // for II since we don't manipulate footswitches via MCP. Still
  // useful to confirm the wire shape exists / what it returns.
  {
    name: 'fn 0x48 FSGRID (no payload)',
    fn: 0x48, opcodeName: 'SYSEX_FSGRID',
    hypothesis: 'footswitch grid layout (FC-12 mapping)',
    request: buildEnvelope(0x48),
    listenMs: 2000,
  },

  // ── fn 0x47 GET_SYSINFO payload variations ─────────────────────
  // Session 103 captured payload `0a 02 3d 01 00 08 04 00` and saw a
  // structured response. Try alternative payloads:
  //   - All zeros — does the device return defaults?
  //   - All 0x7F — what's the "max" response?
  //   - Bit-flip the captured payload byte-by-byte to identify each
  //     byte's effect.
  {
    name: 'fn 0x47 GET_SYSINFO (all zeros, 8B)',
    fn: 0x47, opcodeName: 'SYSEX_GET_SYSINFO',
    hypothesis: 'baseline — what does the device emit with neutral input',
    request: buildEnvelope(0x47, [0, 0, 0, 0, 0, 0, 0, 0]),
  },
  {
    name: 'fn 0x47 GET_SYSINFO (toggling byte 0: 0x0b)',
    fn: 0x47, opcodeName: 'SYSEX_GET_SYSINFO',
    hypothesis: 'changing byte 0 from 0x0a to 0x0b — does the response shift?',
    request: buildEnvelope(0x47, [0x0b, 0x02, 0x3d, 0x01, 0x00, 0x08, 0x04, 0x00]),
  },
  {
    name: 'fn 0x47 GET_SYSINFO (toggling byte 4: 0x01)',
    fn: 0x47, opcodeName: 'SYSEX_GET_SYSINFO',
    hypothesis: 'changing byte 4 from 0x00 to 0x01',
    request: buildEnvelope(0x47, [0x0a, 0x02, 0x3d, 0x01, 0x01, 0x08, 0x04, 0x00]),
  },

  // ── fn 0x0E QUERY_STATES payload variations ────────────────────
  // Session 103: 10 × 5-byte chunks per response, address deltas ~1024.
  // Likely the device expects a "start address" or "block selector" in
  // the request to scope which states to return.
  {
    name: 'fn 0x0E QUERY_STATES (empty payload)',
    fn: 0x0e, opcodeName: 'SYSEX_QUERY_STATES',
    hypothesis: 'no scope; expect full inventory',
    request: buildEnvelope(0x0e),
    listenMs: 3000,
  },
  {
    name: 'fn 0x0E QUERY_STATES (AMP 1 selector)',
    fn: 0x0e, opcodeName: 'SYSEX_QUERY_STATES',
    hypothesis: 'maybe scopes the inventory to one block',
    request: buildEnvelope(0x0e, [...encode14(BLOCK_AMP_1)]),
    listenMs: 3000,
  },

  // ── fn 0x0C SET_GRID (write — gated behind --include-writes) ───
  // No-op shape: read current grid first then move slot 0 to slot 0.
  // The request only fires if --include-writes is passed.
  {
    name: 'fn 0x0C SET_GRID (no-op: slot 0 → slot 0)',
    fn: 0x0c, opcodeName: 'SYSEX_SET_GRID',
    hypothesis: 'write the grid layout; no-op shape just confirms wire acceptance',
    request: buildEnvelope(0x0c, [0, 0, 0, 0]),
    isWrite: true,
  },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const includeWrites = args.includes('--include-writes');

  console.log('Axe-Fx II new-opcode probe (Session 103 follow-ups)');
  console.log('═══════════════════════════════════════════════════');
  console.log(`Include writes: ${includeWrites ? '🔴 YES (fn 0x0C SET_GRID will fire)' : '⚪ skipped'}`);

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
  const collected: number[][] = [];
  input.on('message', (_dt, bytes) => {
    if (bytes[0] === 0xf0) collected.push(bytes.slice());
  });
  input.openPort(inIdx);
  console.log('  ports opened');

  await sleep(500);
  collected.length = 0;

  // Optional handshake (fn 0x08) — Session 58 showed AxeEdit sends
  // this once before any other command. Some opcodes may require it.
  console.log('\nSending fn 0x08 handshake...');
  output.sendMessage(buildEnvelope(0x08));
  await sleep(500);
  collected.length = 0;

  interface Result { probe: Probe; inbound: number[][]; }
  const results: Result[] = [];

  for (const def of PROBES) {
    if (def.isWrite && !includeWrites) {
      console.log(`\n⏭  SKIP (write — use --include-writes): ${def.name}`);
      continue;
    }
    const listenMs = def.listenMs ?? 1500;
    console.log(`\n── ${def.name} ──`);
    console.log(`    fn=0x${def.fn.toString(16).padStart(2, '0')} (${def.opcodeName})`);
    console.log(`    hypothesis: ${def.hypothesis}`);
    console.log(`    SEND (${def.request.length}B): ${toHex(def.request)}`);
    const before = collected.length;
    output.sendMessage(def.request);
    await sleep(listenMs);
    const inbound = collected.slice(before);
    console.log(`    Received ${inbound.length} inbound frames in ${listenMs}ms`);
    for (let i = 0; i < inbound.length; i++) {
      const f = inbound[i]!;
      const inFn = f.length >= 6 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74
        ? `fn=0x${f[5]?.toString(16).padStart(2, '0')}`
        : '(non-Fractal)';
      const preview = toHex(f.slice(0, Math.min(24, f.length)));
      console.log(`      [${i}] ${inFn} len=${f.length} ${preview}${f.length > 24 ? ' …' : ''}`);
    }
    results.push({ probe: def, inbound });
    await sleep(150);
  }

  // ── Save artifacts ───────────────────────────────────────────
  mkdirSync('samples/captured', { recursive: true });
  const syxOut = path.resolve('samples/captured/probe-axefx2-new-opcodes.syx');
  const concat = results.flatMap((r) => [...r.probe.request, ...r.inbound.flat()]);
  writeFileSync(syxOut, Uint8Array.from(concat));
  console.log(`\nSaved raw bytes to ${syxOut}`);

  // ── Findings markdown ────────────────────────────────────────
  const md: string[] = [
    `# Axe-Fx II new-opcode probe — findings`,
    ``,
    `> Auto-generated by \`scripts/_research/probe-axefx2-new-opcodes.ts\``,
    `> at ${new Date().toISOString()}`,
    ``,
    `## Per-probe verdict`,
    ``,
    `| fn | Opcode | Probe | Verdict | Notes |`,
    `|---|---|---|---|---|`,
  ];
  for (const r of results) {
    const inboundNonEcho = r.inbound.filter((f) =>
      !(f.length === r.probe.request.length && f.every((b, i) => b === r.probe.request[i]))
    );
    const verdict = inboundNonEcho.length === 0
      ? (r.inbound.length === 0 ? '🔴 silent' : '⚪ echo-only')
      : '🟢 responsive';
    const noteBits: string[] = [];
    for (const f of inboundNonEcho) {
      const inFn = f.length >= 6 ? `fn=0x${f[5]?.toString(16)}` : '?';
      noteBits.push(`${inFn} (${f.length}B)`);
    }
    md.push(`| 0x${r.probe.fn.toString(16).padStart(2, '0')} | ${r.probe.opcodeName} | ${r.probe.name} | ${verdict} | ${noteBits.join(', ') || '—'} |`);
  }
  md.push('', '## Per-probe raw inbound', '');
  for (const r of results) {
    md.push(`### ${r.probe.name}`, '');
    md.push(`Hypothesis: ${r.probe.hypothesis}`, '');
    md.push(`SEND: \`${toHex(r.probe.request)}\``, '');
    if (r.inbound.length === 0) {
      md.push('No inbound frames.', '');
    } else {
      for (let i = 0; i < r.inbound.length; i++) {
        const f = r.inbound[i]!;
        md.push(`Frame [${i}] (len=${f.length}):`, '');
        md.push('```');
        for (let off = 0; off < f.length; off += 16) {
          md.push(toHex(f.slice(off, off + 16)));
        }
        md.push('```');
      }
    }
    md.push('');
  }
  const mdOut = path.resolve('samples/captured/probe-axefx2-new-opcodes-findings.md');
  writeFileSync(mdOut, md.join('\n'));
  console.log(`Wrote findings to ${mdOut}`);

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('SUMMARY');
  console.log('──────────────────────────────────────────────────────────────');
  for (const r of results) {
    const inboundNonEcho = r.inbound.filter((f) =>
      !(f.length === r.probe.request.length && f.every((b, i) => b === r.probe.request[i]))
    );
    const verdict = inboundNonEcho.length === 0
      ? (r.inbound.length === 0 ? '🔴 silent' : '⚪ echo-only')
      : '🟢 responsive';
    console.log(`  fn=0x${r.probe.fn.toString(16).padStart(2, '0')}  ${r.probe.opcodeName.padEnd(28)} ${verdict}`);
  }
  console.log('──────────────────────────────────────────────────────────────');

  input.closePort();
  output.closePort();
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
