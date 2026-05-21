/**
 * Decode fn 0x16 SYSEX_GET_PARAM_INFO response — per-parameter
 * descriptor from the live Axe-Fx II firmware.
 *
 * Source: `samples/captured/probe-axefx2-new-opcodes-findings.md`,
 * Session 104's `probe-axefx2-new-opcodes.ts` run (2026-05-20).
 *
 * Two samples available (both AMP 1):
 *   • paramId=0 (AMP.TYPE, control_type=select)
 *   • paramId=10 (likely AMP.MASTER or similar knob)
 *
 * Both responses are 33-byte SysEx frames:
 *
 *   F0 00 01 74 07 16 <25-byte payload> <checksum> F7
 *
 * Two samples are not enough to fully isolate every field, but the
 * pairwise diff shows the active offsets. This script prints
 * candidate decodings (8-bit, 2-septet LE pair, 3-septet LE pack) at
 * every position and the operator can spot field boundaries.
 *
 * Run:
 *   npx tsx scripts/_research/decode-fn16-param-info.ts
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const FINDINGS_PATH = path.resolve(
  'samples/captured/probe-axefx2-new-opcodes-findings.md',
);

function extractSection(md: string, sectionHeader: string): string[] {
  const lines = md.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim() === sectionHeader);
  if (idx < 0) throw new Error(`section not found: ${sectionHeader}`);
  const frame0Idx = lines.findIndex(
    (l, i) => i > idx && l.startsWith('Frame [0] (len='),
  );
  const openFence = lines.findIndex(
    (l, i) => i > frame0Idx && l.trim() === '```',
  );
  const closeFence = lines.findIndex(
    (l, i) => i > openFence && l.trim() === '```',
  );
  return lines.slice(openFence + 1, closeFence);
}

function hexLinesToBytes(lines: string[]): number[] {
  const bytes: number[] = [];
  for (const ln of lines) {
    for (const tok of ln.trim().split(/\s+/)) {
      if (tok) bytes.push(parseInt(tok, 16));
    }
  }
  return bytes;
}

function septet2LE(low: number, high: number): number {
  return (low & 0x7f) | ((high & 0x7f) << 7);
}

function septet3LE(low: number, mid: number, hi: number): number {
  return (low & 0x7f) | ((mid & 0x7f) << 7) | ((hi & 0x7f) << 14);
}

function formatPayload(label: string, frame: number[]): void {
  console.log(`\n=== ${label} ===`);
  console.log(`Total frame bytes: ${frame.length}`);
  // header: F0 00 01 74 07 16 (6B), then payload, then checksum + F7 (2B)
  const payload = frame.slice(6, frame.length - 2);
  console.log(`Payload bytes (post-header, pre-checksum): ${payload.length}`);
  console.log(
    `  Hex: ${payload
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')}`,
  );

  console.log('\nPer-offset candidate decodings:');
  console.log(
    'off | u8(hex) | u8(dec) | 2-septet LE pair | 3-septet LE pack',
  );
  console.log(
    '----+---------+---------+------------------+------------------',
  );
  for (let i = 0; i < payload.length; i++) {
    const u8 = payload[i]!;
    const sept2 =
      i + 1 < payload.length ? septet2LE(u8, payload[i + 1]!) : '—';
    const sept3 =
      i + 2 < payload.length
        ? septet3LE(u8, payload[i + 1]!, payload[i + 2]!)
        : '—';
    console.log(
      `${i.toString().padStart(3)} | 0x${u8.toString(16).padStart(2, '0')}    | ${u8
        .toString()
        .padStart(7)} | ${typeof sept2 === 'number' ? sept2.toString().padStart(16) : sept2.toString().padStart(16)} | ${typeof sept3 === 'number' ? sept3.toString().padStart(16) : sept3.toString().padStart(16)}`,
    );
  }
}

function pairwiseDiff(a: number[], b: number[]): void {
  console.log('\n=== Pairwise diff (post-header, pre-checksum) ===');
  const aP = a.slice(6, a.length - 2);
  const bP = b.slice(6, b.length - 2);
  const len = Math.min(aP.length, bP.length);
  console.log(
    'off | paramId=0 (hex/dec) | paramId=10 (hex/dec) | DIFFERS?',
  );
  console.log(
    '----+---------------------+----------------------+---------',
  );
  for (let i = 0; i < len; i++) {
    const same = aP[i] === bP[i];
    console.log(
      `${i.toString().padStart(3)} |  0x${aP[i]!.toString(16).padStart(2, '0')} (${aP[i]!
        .toString()
        .padStart(3)})        |  0x${bP[i]!.toString(16).padStart(2, '0')} (${bP[i]!
        .toString()
        .padStart(3)})         | ${same ? '   .' : ' !!!'}`,
    );
  }
}

async function main(): Promise<void> {
  const md = readFileSync(FINDINGS_PATH, 'utf8');
  const p0 = hexLinesToBytes(
    extractSection(md, '### fn 0x16 GET_PARAM_INFO (AMP 1, paramId=0)'),
  );
  const p10 = hexLinesToBytes(
    extractSection(md, '### fn 0x16 GET_PARAM_INFO (AMP 1, paramId=10)'),
  );

  formatPayload('paramId=0 (AMP.TYPE, control_type=select)', p0);
  formatPayload('paramId=10 (knob, exact knob TBD)', p10);
  pairwiseDiff(p0, p10);

  console.log(`
Decode hypothesis (TENTATIVE — needs more samples + ideally Ghidra
trace of the response parser to lock down):

  Offset 0 (u8?):
    paramId=0:  0x10 (16) — could be CURRENT VALUE of AMP.TYPE
                            (16 = "HIPOWER NORMAL" in the
                            AMP_EFFECT_TYPE_VALUES table — plausible
                            value present in active preset).
    paramId=10: 0x41 (65) — different parameter, different value.

  Offset 1 (u8?):
    paramId=0:  0x00 — could be paramId echo low septet, or value high.
    paramId=10: 0x10 — matches sent paramId=10 echo, OR high septet
                       of value (giving 16-bit current = 0x10*128+0x41 =
                       2113).

  Offsets 2-11 (mostly-zero on enum, varied on knob):
    Could be (min, max, default, step) descriptor — populated only
    for knob params, not enum/select.

  Offsets 12-14:
    Vary significantly between probes — possibly (current_value Q15
    septet-3 pack) followed by (display_units enum byte) at offset
    14-15.

  Offsets 16-19:
    paramId=10 carries non-zero; could be (displayMin, displayMax)
    septet-encoded.

Action items to lock decoding:
  1. Capture paramId=0 BEFORE and AFTER setting AMP.TYPE to a known
     value (e.g. "USA CLEAN" = wire 18). Compare to identify which
     bytes are the current-value field.
  2. Capture a third knob param (e.g. paramId=1 = INPUT DRIVE) with
     a known value set. Compare to paramId=10 to lock displayMin/Max
     positions.
  3. Trace the response parser in AxeEdit II.exe via Ghidra — the
     opcode-table generator from Session 104 already located the
     0x16 opcode handler.
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
