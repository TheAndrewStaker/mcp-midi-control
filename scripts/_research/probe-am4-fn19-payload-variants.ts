/**
 * HW-121 follow-up — fn=0x19 payload-shape disambiguation
 * =======================================================
 *
 * The initial HW-121 sweep landed on fn=0x19 as a bulk-responsive envelope
 * (10 frames, 10,345 bytes via a 0x7a/0x7b/0x7c stream — a NEW response
 * family distinct from the working-buffer 0x77/0x78/0x79 stream from
 * HW-045). However the chunk bodies came back 100% 0x7f bytes — an empty
 * / scratch / sentinel pattern, NOT the populated factory preset content
 * we'd expect at A02.
 *
 * Three plausible explanations:
 *
 *   1. fn=0x19 IS a stored-preset dump opcode but the 2-byte
 *      `[loc_lo, loc_hi]` payload is incomplete — it may want 3 bytes
 *      like fn=0x03's working-buffer request (`[7F 7F 00]`), or a full
 *      4-byte u32 location index.
 *   2. fn=0x19 is a different bulk-response opcode (e.g. "fetch scratch
 *      template", "fetch IR slot", etc.) that uses the 0x7a/0x7b/0x7c
 *      response envelope coincidentally.
 *   3. fn=0x19 IS the right opcode but addresses something other than
 *      stored presets (e.g. global config, a system buffer).
 *
 * This probe disambiguates by sending fn=0x19 with several payload
 * shapes and target locations, then comparing response bodies. If the
 * response varies with location, the loc field is being read; if not,
 * we're looking at a non-preset envelope.
 *
 * # Safety profile
 *
 * READ-ONLY. fn=0x19 has not been observed to mutate device state in
 * the initial sweep — it returns a bulk response with no side effects.
 * Repeated requests across payload shapes do not write anything.
 *
 * # Run
 *
 *   npx tsx scripts/_research/probe-am4-fn19-payload-variants.ts
 */

import midi from 'midi';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const AM4_MODEL = 0x15;
const FN_PROBE = 0x19;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}

function buildFrame(payload: number[]): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, AM4_MODEL, FN_PROBE, ...payload];
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
      if (name.toLowerCase().includes(n.toLowerCase())) return i;
    }
  }
  return -1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Variant {
  label: string;
  payload: number[];
}

const VARIANTS: Variant[] = [
  // 2-byte [loc_lo, loc_hi] — original sweep shape (baseline).
  { label: '2B loc=A02 (loc index 1)', payload: [0x01, 0x00] },
  { label: '2B loc=A03 (loc index 2)', payload: [0x02, 0x00] },
  { label: '2B loc=Z04 (loc index 103)', payload: [103 & 0x7f, (103 >> 7) & 0x7f] },
  // 3-byte [loc_lo, loc_hi, 00] — mimics fn=0x03 working-buffer envelope.
  { label: '3B loc=A02 + 00 trailer', payload: [0x01, 0x00, 0x00] },
  { label: '3B loc=Z04 + 00 trailer', payload: [103 & 0x7f, (103 >> 7) & 0x7f, 0x00] },
  // 3-byte active-buffer sentinel (matches fn=0x03's [7F 7F 00]).
  { label: '3B active-buffer sentinel 7F 7F 00', payload: [0x7f, 0x7f, 0x00] },
  // 4-byte u32 LE location index.
  { label: '4B u32 LE loc=1 (A02)', payload: [0x01, 0x00, 0x00, 0x00] },
  { label: '4B u32 LE loc=103 (Z04)', payload: [103, 0x00, 0x00, 0x00] },
  // No payload.
  { label: 'No payload (zero-length)', payload: [] },
  // 1-byte raw location index.
  { label: '1B raw loc=1 (A02)', payload: [0x01] },
  { label: '1B raw loc=103 (Z04)', payload: [103] },
];

async function main(): Promise<void> {
  console.log('HW-121 follow-up — fn=0x19 payload-shape disambiguation');
  console.log('═══════════════════════════════════════════════════════════════════════════');

  const input = new midi.Input();
  const output = new midi.Output();
  const needles = ['AM4', 'Axe Effects', 'Fractal'];
  const outIdx = findPort(output, needles);
  const inIdx = findPort(input, needles);
  if (outIdx < 0 || inIdx < 0) { console.error('AM4 port not found'); process.exit(1); }
  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);

  const collected: number[][] = [];
  input.on('message', (_dt, bytes) => { if (bytes[0] === 0xf0) collected.push(bytes.slice()); });
  input.openPort(inIdx);
  await sleep(500);
  collected.length = 0;

  interface Outcome {
    variant: Variant;
    request: number[];
    frames: number[][];
    chunkBodyHash: string;
    chunkBytesAll7f: boolean;
  }

  const outcomes: Outcome[] = [];

  for (const v of VARIANTS) {
    const req = buildFrame(v.payload);
    process.stdout.write(`\n[${v.label}] SEND ${toHex(req)}\n`);
    const before = collected.length;
    output.sendMessage(req);
    await sleep(800);
    const frames = collected.slice(before);
    const totalBytes = frames.reduce((s, f) => s + f.length, 0);
    console.log(`  ← ${frames.length} frames, ${totalBytes}B total`);
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]!;
      console.log(`    [${i}] len=${f.length} ${toHex(f.slice(0, Math.min(24, f.length)))}${f.length > 24 ? ' …' : ''}`);
    }

    // Hash the concatenated chunk bodies (frames sized ~1290 with fn=0x7b).
    const chunkBodies: number[] = [];
    let chunkAll7f = true;
    for (const f of frames) {
      if (f.length >= 12 && f[5] === 0x7b) {
        const body = f.slice(8, -2); // strip header(8) + checksum + F7
        chunkBodies.push(...body);
        if (body.some((b) => b !== 0x7f)) chunkAll7f = false;
      }
    }
    const hash = chunkBodies.length === 0
      ? '(no chunk frames)'
      : `len=${chunkBodies.length} first16=${toHex(chunkBodies.slice(0, 16))} all7f=${chunkAll7f}`;
    console.log(`  chunk-body summary: ${hash}`);
    outcomes.push({ variant: v, request: req, frames, chunkBodyHash: hash, chunkBytesAll7f: chunkAll7f });
    await sleep(150);
  }

  // ── Save raw bytes per variant + comparison markdown ────────────────
  mkdirSync('samples/captured', { recursive: true });
  const md: string[] = [
    `# HW-121 follow-up — fn=0x19 payload variants`,
    ``,
    `> ${new Date().toISOString()}`,
    ``,
    `## Per-variant outcome`,
    ``,
    `| Variant | Payload | Frames | Total bytes | Chunk body all-0x7f | First 16 chunk bytes |`,
    `|---|---|---|---|---|---|`,
  ];
  for (const o of outcomes) {
    const totalBytes = o.frames.reduce((s, f) => s + f.length, 0);
    const chunkBodies: number[] = [];
    for (const f of o.frames) {
      if (f.length >= 12 && f[5] === 0x7b) chunkBodies.push(...f.slice(8, -2));
    }
    const first16 = chunkBodies.length > 0 ? toHex(chunkBodies.slice(0, 16)) : '—';
    md.push(`| ${o.variant.label} | \`${toHex(o.variant.payload)}\` | ${o.frames.length} | ${totalBytes} | ${o.chunkBytesAll7f ? 'yes' : 'NO'} | \`${first16}\` |`);
  }
  md.push('', '## Verdict', '');
  const allSame = outcomes.every((o) => o.chunkBytesAll7f);
  if (allSame) {
    md.push('Every fn=0x19 variant returned 100% 0x7f chunk bodies regardless of payload shape OR target location.');
    md.push('Implication: fn=0x19 returns a constant sentinel/empty response; the loc field is not being read,');
    md.push('OR this opcode is a "reset / clear scratch buffer" command that does not vary with input.');
    md.push('');
    md.push('**fn=0x19 is NOT the AM4 stored-preset dump envelope.**');
    md.push('Recommendation: classify the negative finding in fractal-midi AM4 SYSEX-MAP §10.');
  } else {
    md.push('Chunk bodies VARY across variants — fn=0x19 is reading at least one of the payload fields.');
    md.push('Identify the variant that produces non-0x7f content; that is the candidate stored-preset envelope.');
  }

  for (const o of outcomes) {
    const slug = o.variant.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '');
    const p = path.resolve(`samples/captured/hw-121-fn19-${slug}.syx`);
    const concat = [...o.request, ...o.frames.flat()];
    writeFileSync(p, Uint8Array.from(concat));
  }

  const mdOut = path.resolve('samples/captured/hw-121-fn19-payload-variants-findings.md');
  writeFileSync(mdOut, md.join('\n'));
  console.log(`\nWrote ${mdOut}`);

  console.log('\nVerdict:', allSame ? 'fn=0x19 is NOT preset-addressing (constant sentinel)' : 'fn=0x19 IS reading the payload — candidate envelope confirmed');

  input.closePort();
  output.closePort();
  process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
