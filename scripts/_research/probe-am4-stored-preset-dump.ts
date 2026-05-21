/**
 * HW-121 — AM4 stored-preset bulk-dump envelope probe (READ-ONLY)
 * ================================================================
 *
 * 2026-05-22. Founder challenged the "AM4 can't return all 8 scenes +
 * params in one command" claim during the Tier-3 audit. For Axe-Fx II/III
 * BK-070 already proves a single `0x77/0x78/0x79` envelope returns the
 * full preset binary. For AM4 the equivalent path is unproven — HW-045
 * covers the working-buffer dump (active preset only); whether *stored*
 * presets dump via some `F0 00 01 74 15 [fn] [loc] F7` envelope at an
 * undiscovered `fn` byte is what this probe answers.
 *
 * Positive: supersedes the latency-polish framing of BK-025 / BK-026 and
 * unblocks an AM4 equivalent of BK-081 (atomic `get_preset`).
 * Negative: settles the "impossible by design" claim mechanically.
 *
 * # What this script does
 *
 * Walks `fn` candidates `0x10..0x7F` (skipping known-decoded bytes and
 * suspected write-side bytes — see SKIP set below) sending:
 *
 *     F0 00 01 74 15 [fn] [loc_lo] [loc_hi] [cksum] F7
 *
 * with `loc_lo=0x01, loc_hi=0x00` (septet-encoded 14-bit location index
 * 1 → A02, a known-content factory preset).
 *
 * For each `fn`, listens 500 ms for inbound SysEx frames. Classifies:
 *
 *   - 🟢 BULK (>200 bytes total inbound): the candidate envelope —
 *     record fn + response shape + save raw bytes to per-fn .syx file.
 *   - 🟡 SHORT-RESPONSE: device emitted something, but smaller than a
 *     preset dump. Could be a structured ack, a smaller data response,
 *     or a header-only response. Record for review.
 *   - ⚪ ECHO-ONLY / SILENT: device ignored or just looped back our
 *     request. Not the envelope.
 *
 * # Safety profile
 *
 * READ-ONLY by construction:
 *   - No PARAM_RW writes (fn=0x01 skipped).
 *   - No preset switching (fn=0x3C SET_PRESET_NUMBER skipped — would
 *     switch the active preset to A02).
 *   - No scene/mode switches (fn=0x12, 0x29 skipped).
 *   - No disconnect (fn=0x42 skipped).
 *   - No IR-download writes (fn=0x7A/0x7B/0x7C skipped).
 *   - All other fn bytes get only `[loc_lo, loc_hi]` payload — wrong
 *     shape for any structured write, so the device will mp-ack-reject
 *     them rather than misinterpret as a write.
 *
 * # Prereqs
 *
 *   - AM4 powered on, USB connected.
 *   - **Close AM4-Edit** (clean inbound stream — its poll loop pollutes
 *     response correlation).
 *
 * # Run
 *
 *   npx tsx scripts/_research/probe-am4-stored-preset-dump.ts
 *
 * # Output
 *
 *   - stdout: per-probe summary with hex preview + per-frame bucket.
 *   - samples/captured/hw-121-am4-stored-dump-findings.md: markdown
 *     summary with responsive_fn_bytes list, per-fn verdict table, and
 *     per-probe raw hex.
 *   - samples/captured/hw-121-am4-stored-dump-<fn>.syx: raw bytes of
 *     any BULK or SHORT response (one file per responsive fn).
 *
 * # Interpretation
 *
 *   - responsive_fn_bytes empty → negative finding. Append entry to
 *     fractal-midi AM4 SYSEX-MAP §10 documenting the sweep range and
 *     lack of bulk response.
 *   - responsive_fn_bytes non-empty → file BK-AM4-PRESET-DUMP and
 *     proceed with byte-level decode of the recovered envelope.
 */

import midi from 'midi';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

// ──────────────────────────────────────────────────────────────────
// Wire envelope helpers
// ──────────────────────────────────────────────────────────────────

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const AM4_MODEL = 0x15;

/** XOR-fold checksum over all bytes from F0..last-payload-byte, & 0x7F. */
function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}

/**
 * Build the HW-121 probe envelope:
 *   F0 00 01 74 15 [fn] [loc_lo] [loc_hi] [cs] F7
 */
function buildProbeFrame(fn: number, locLo: number, locHi: number): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, AM4_MODEL, fn, locLo, locHi];
  const cs = fractalChecksum(head);
  return [...head, cs, SYSEX_END];
}

function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

// ──────────────────────────────────────────────────────────────────
// Skip list — fn bytes we already know about OR that have known write
// side-effects. Sweep covers 0x10..0x7F minus these.
// ──────────────────────────────────────────────────────────────────

/**
 * Known-decoded AM4 fn bytes (per fractal-midi AM4 SYSEX-MAP). Skipping
 * to keep the sweep focused on undiscovered envelopes. Note: 0x01 / 0x03
 * are below the sweep range (0x10..0x7F) so don't need explicit listing,
 * but documented here for completeness.
 *
 *   - 0x01 PARAM_RW (below range, would also be a write)
 *   - 0x03 REQUEST_DUMP working-buffer (below range; HW-045)
 *   - 0x08 GET_FIRMWARE_VERSION (below range)
 *   - 0x14 GET_PRESET_NUMBER
 *   - 0x20 GET_GRID_LAYOUT_AND_ROUTING
 *   - 0x47 DEVICE_INFO_OR_CAPABILITY
 *   - 0x64 MULTIPURPOSE_RESPONSE (response-only)
 *   - 0x77 / 0x78 / 0x79 PRESET_DUMP_HEADER/CHUNK/FOOTER (response-only)
 *
 * Suspected write side effects (safety skip):
 *
 *   - 0x12 (mode switch, would change device mode)
 *   - 0x29 GET/SET_SCENE_NUMBER — SET variant could switch scene
 *   - 0x2E SET_TYPED_BLOCK_PARAMETER_VALUE
 *   - 0x3C SET_PRESET_NUMBER — would switch the active preset to A02
 *   - 0x42 DISCONNECT_FROM_CONTROLLER — disconnects the editor channel
 *   - 0x7A / 0x7B / 0x7C IR_DOWNLOAD — write side
 *
 * 0x09 SET_PRESET_NAME (below range, write).
 */
const SKIP_FN = new Set<number>([
  // Known reads
  0x14, 0x20, 0x47, 0x64,
  // Known response-only
  0x77, 0x78, 0x79,
  // Suspected writes / state-changers
  0x12, 0x29, 0x2e, 0x3c, 0x42, 0x7a, 0x7b, 0x7c,
]);

/** Target preset for the payload: A02 → location index 1, septet 14-bit `01 00`. */
const TARGET_LOC_LO = 0x01;
const TARGET_LOC_HI = 0x00;

// ──────────────────────────────────────────────────────────────────
// Connection helpers
// ──────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────
// Probe runner
// ──────────────────────────────────────────────────────────────────

interface ProbeResult {
  fn: number;
  request: number[];
  inboundFrames: number[][];
  totalInboundBytes: number;
}

interface FrameBucket {
  type: 'echo' | 'mp-ack' | 'short' | 'medium' | 'bulk' | 'other';
  detail?: string;
}

function classifyFrame(req: number[], f: number[]): FrameBucket {
  if (f.length === req.length && f.every((b, i) => b === req[i])) {
    return { type: 'echo' };
  }
  // Multipurpose ack: F0 00 01 74 15 64 [echoed_fn] [result] [cs] F7 (11 bytes)
  if (f.length === 11 && f[5] === 0x64) {
    const echoedFn = f[6];
    const result = f[7];
    return {
      type: 'mp-ack',
      detail: `echoed fn=0x${echoedFn?.toString(16)} result=0x${result?.toString(16)}` +
        ` (${result === 0x02 ? 'OK' : result === 0x05 ? 'unsupported/rejected' : 'unknown'})`,
    };
  }
  if (f.length <= 32) return { type: 'short' };
  if (f.length <= 200) return { type: 'medium' };
  return { type: 'bulk' };
}

async function main(): Promise<void> {
  console.log('HW-121 — AM4 stored-preset bulk-dump envelope probe');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('Read-only sweep: F0 00 01 74 15 [fn] 01 00 [cs] F7 with fn ∈ 0x10..0x7F');
  console.log(`Target preset: A02 (loc index 1, septet 14-bit ${TARGET_LOC_LO.toString(16).padStart(2, '0')} ${TARGET_LOC_HI.toString(16).padStart(2, '0')})`);
  console.log(`Skip list (${SKIP_FN.size} bytes): ${[...SKIP_FN].sort((a, b) => a - b).map((x) => '0x' + x.toString(16).padStart(2, '0')).join(' ')}`);

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
  console.log('  ports opened\n');

  // Warmup — discard any device-initial broadcast.
  await sleep(500);
  collected.length = 0;

  const results: ProbeResult[] = [];

  for (let fn = 0x10; fn <= 0x7f; fn++) {
    if (SKIP_FN.has(fn)) continue;

    const request = buildProbeFrame(fn, TARGET_LOC_LO, TARGET_LOC_HI);
    process.stdout.write(`fn=0x${fn.toString(16).padStart(2, '0')} → SEND ${toHex(request)} ...`);

    const before = collected.length;
    output.sendMessage(request);
    await sleep(500);
    const inbound = collected.slice(before);
    const totalBytes = inbound.reduce((sum, f) => sum + f.length, 0);

    const buckets = inbound.map((f) => classifyFrame(request, f));
    const summary = buckets.length === 0
      ? '⚪ silent'
      : buckets.every((b) => b.type === 'echo') ? '⚪ echo-only'
      : buckets.every((b) => b.type === 'echo' || b.type === 'mp-ack') ? '🟡 mp-ack(rejected)'
      : buckets.some((b) => b.type === 'bulk') ? '🟢 BULK'
      : buckets.some((b) => b.type === 'medium') ? '🟢 MEDIUM'
      : '🟡 short-response';

    console.log(` ← ${inbound.length} frames, ${totalBytes}B total :: ${summary}`);
    for (let i = 0; i < inbound.length; i++) {
      const f = inbound[i]!;
      const b = buckets[i]!;
      const detail = b.detail ? ` (${b.detail})` : '';
      const preview = toHex(f.slice(0, Math.min(24, f.length)));
      console.log(`    [${i}] len=${f.length} ${b.type}${detail} :: ${preview}${f.length > 24 ? ' …' : ''}`);
    }

    results.push({ fn, request, inboundFrames: inbound, totalInboundBytes: totalBytes });

    // Small inter-probe quiet — let device settle.
    await sleep(100);
  }

  // ── Identify responsive fn bytes ────────────────────────────────
  // "Responsive" = produced something other than pure echo / silence.
  // Any mp-ack counts as a known wire shape too, but the headline
  // metric is "bulk or medium" responses (the candidate envelope).
  const bulkResponsive: number[] = [];
  const ackResponsive: number[] = [];
  const shortResponsive: number[] = [];

  for (const r of results) {
    const buckets = r.inboundFrames.map((f) => classifyFrame(r.request, f));
    if (buckets.length === 0) continue;
    if (buckets.every((b) => b.type === 'echo')) continue;
    if (buckets.some((b) => b.type === 'bulk' || b.type === 'medium')) {
      bulkResponsive.push(r.fn);
    } else if (buckets.some((b) => b.type === 'mp-ack')) {
      ackResponsive.push(r.fn);
    } else if (buckets.some((b) => b.type === 'short' || b.type === 'other')) {
      shortResponsive.push(r.fn);
    }
  }

  // ── Save per-fn .syx for any non-echo/non-silent response ───────
  mkdirSync('samples/captured', { recursive: true });
  const savedFiles: string[] = [];
  for (const r of results) {
    const buckets = r.inboundFrames.map((f) => classifyFrame(r.request, f));
    const hasInteresting = buckets.some(
      (b) => b.type === 'bulk' || b.type === 'medium' || b.type === 'short' || b.type === 'mp-ack' || b.type === 'other'
    );
    if (!hasInteresting) continue;
    const fnHex = r.fn.toString(16).padStart(2, '0');
    const p = path.resolve(`samples/captured/hw-121-am4-stored-dump-${fnHex}.syx`);
    const concat = [...r.request, ...r.inboundFrames.flat()];
    writeFileSync(p, Uint8Array.from(concat));
    savedFiles.push(p);
  }

  // ── Findings markdown ───────────────────────────────────────────
  const md: string[] = [
    `# HW-121 — AM4 stored-preset bulk-dump envelope probe — findings`,
    ``,
    `> Auto-generated by \`scripts/_research/probe-am4-stored-preset-dump.ts\``,
    `> at ${new Date().toISOString()}`,
    ``,
    `## Summary`,
    ``,
    `- Sweep range: \`fn ∈ 0x10..0x7F\` minus ${SKIP_FN.size} skipped bytes`,
    `- Total probes sent: ${results.length}`,
    `- Target payload: \`[0x${TARGET_LOC_LO.toString(16).padStart(2, '0')}, 0x${TARGET_LOC_HI.toString(16).padStart(2, '0')}]\` (A02, location index 1)`,
    `- Listen window: 500 ms per probe`,
    ``,
    `### responsive_fn_bytes (BULK / MEDIUM — candidate envelope)`,
    ``,
    bulkResponsive.length === 0
      ? `**Empty.** Negative finding — no fn byte in 0x10..0x7F returned a bulk response to a \`[loc_lo, loc_hi]\` payload.`
      : `\`[${bulkResponsive.map((x) => '0x' + x.toString(16).padStart(2, '0')).join(', ')}]\``,
    ``,
    `### mp-ack responsive (recognized but rejected)`,
    ``,
    ackResponsive.length === 0
      ? `_None._`
      : `\`[${ackResponsive.map((x) => '0x' + x.toString(16).padStart(2, '0')).join(', ')}]\``,
    ``,
    `### short-response (something but not bulk)`,
    ``,
    shortResponsive.length === 0
      ? `_None._`
      : `\`[${shortResponsive.map((x) => '0x' + x.toString(16).padStart(2, '0')).join(', ')}]\``,
    ``,
    `## Per-fn verdict table`,
    ``,
    `| fn | request len | inbound frames | inbound bytes | verdict |`,
    `|---|---|---|---|---|`,
  ];

  for (const r of results) {
    const buckets = r.inboundFrames.map((f) => classifyFrame(r.request, f));
    const verdict = buckets.length === 0
      ? '⚪ silent'
      : buckets.every((b) => b.type === 'echo') ? '⚪ echo-only'
      : buckets.every((b) => b.type === 'echo' || b.type === 'mp-ack') ? '🟡 mp-ack(rejected)'
      : buckets.some((b) => b.type === 'bulk') ? '🟢 BULK'
      : buckets.some((b) => b.type === 'medium') ? '🟢 MEDIUM'
      : '🟡 short';
    md.push(
      `| 0x${r.fn.toString(16).padStart(2, '0')} | ${r.request.length} | ${r.inboundFrames.length} | ${r.totalInboundBytes} | ${verdict} |`
    );
  }

  md.push('', '## Per-fn raw inbound (responsive only)', '');
  for (const r of results) {
    const buckets = r.inboundFrames.map((f) => classifyFrame(r.request, f));
    if (buckets.length === 0) continue;
    if (buckets.every((b) => b.type === 'echo')) continue;
    md.push(`### fn=0x${r.fn.toString(16).padStart(2, '0')}`, '');
    md.push(`SEND (${r.request.length}B): \`${toHex(r.request)}\``, '');
    for (let i = 0; i < r.inboundFrames.length; i++) {
      const f = r.inboundFrames[i]!;
      const b = buckets[i]!;
      md.push(`Frame [${i}] (len=${f.length}, ${b.type}${b.detail ? ': ' + b.detail : ''}):`);
      md.push('```');
      for (let off = 0; off < f.length; off += 16) {
        md.push(toHex(f.slice(off, off + 16)));
      }
      md.push('```');
    }
    md.push('');
  }

  if (savedFiles.length > 0) {
    md.push('## Saved .syx files', '');
    for (const f of savedFiles) md.push(`- \`${f}\``);
    md.push('');
  }

  const mdOut = path.resolve('samples/captured/hw-121-am4-stored-dump-findings.md');
  writeFileSync(mdOut, md.join('\n'));
  console.log(`\nWrote findings to ${mdOut}`);

  // ── Console summary ──────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('HW-121 FINDINGS SUMMARY');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`  responsive_fn_bytes (bulk/medium): [${bulkResponsive.map((x) => '0x' + x.toString(16).padStart(2, '0')).join(', ')}]`);
  console.log(`  mp-ack responsive: [${ackResponsive.map((x) => '0x' + x.toString(16).padStart(2, '0')).join(', ')}]`);
  console.log(`  short-response: [${shortResponsive.map((x) => '0x' + x.toString(16).padStart(2, '0')).join(', ')}]`);
  console.log(`  total probes: ${results.length}`);
  console.log(`  saved files: ${savedFiles.length}`);
  console.log('──────────────────────────────────────────────────────────────');
  if (bulkResponsive.length === 0) {
    console.log('\nNegative finding: no bulk envelope discovered in this sweep.');
    console.log('Next: append negative entry to fractal-midi AM4 SYSEX-MAP §10.');
  } else {
    console.log('\nPositive finding: bulk envelope candidate(s) discovered.');
    console.log('Next: decode response shape and file BK-AM4-PRESET-DUMP.');
  }

  input.closePort();
  output.closePort();
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
