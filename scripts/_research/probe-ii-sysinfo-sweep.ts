/**
 * Axe-Fx II fn=0x47 SYSEX_GET_SYSINFO request-byte sweep (READ-ONLY).
 *
 * Goal: map the request-byte semantics of fn=0x47 (SYSEX-MAP section 5f
 * open item). Known so far (Q8.02 XL+):
 *
 * - The no-payload request `F0 00 01 74 07 47 45 F7` returns the 8-byte
 *   payload `0a 02 3d 01 00 08 04 00` (cksum 0x7d), i.e. the 8-byte
 *   frame is a device RESPONSE, direction confirmed.
 * - Payload byte index 1 = 0x02 is a constant shared with the AM4
 *   fn=0x47 frame; the other fields are undecoded.
 * - SYSEX-MAP names "single-byte selector variants" as the cheapest
 *   next probe.
 *
 * This script sends, one at a time:
 *
 *   1. the no-payload baseline request, then
 *   2. single-byte payload variants sweeping 0x00..0x10 (the 0x0a..0x10
 *      candidates from the SYSEX-MAP note, plus 0x00..0x09
 *      conservatively),
 *
 * collects each response, and emits a table of request byte to response
 * hex, highlighting which response payload fields move relative to the
 * baseline and across the sweep.
 *
 * STRICTLY READ-ONLY: only fn=0x47 requests are sent. No writes, no
 * preset switches, no saves. fn=0x47 is AxeEdit's GET_SYSINFO read
 * opcode; unknown selector bytes on a GET opcode are the probe the
 * SYSEX-MAP itself prescribes.
 *
 * # Prereqs
 *
 * - Axe-Fx II XL+ powered on, USB connected.
 * - Close AxeEdit (its polling pollutes the inbound stream).
 *
 * # Run
 *
 * ```
 * npx tsx scripts/_research/probe-ii-sysinfo-sweep.ts
 * npx tsx scripts/_research/probe-ii-sysinfo-sweep.ts --port "AXE-FX II"
 * ```
 *
 * # Output
 *
 * - samples/captured/probe-ii-sysinfo-sweep.json
 * - samples/captured/probe-ii-sysinfo-sweep-findings.md
 * - samples/captured/probe-ii-sysinfo-sweep.syx (raw request+response bytes)
 */

import midi from "@julusian/midi";
import type { Input as MidiInput, Output as MidiOutput } from "@julusian/midi";
import { writeFileSync, mkdirSync } from 'node:fs';
import { guardAgainstRunningEditors } from '../_lib/editor-guard.js';
import { fractalChecksum } from 'fractal-midi/shared';
import { createSysExAssembler } from '../../packages/core/src/midi/transport.js';

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_PORT_FRAGMENT = 'AXE-FX II';
/** XL+ model byte; the only II variant on hand. */
const MODEL_BYTE = 0x07;
const FN_GET_SYSINFO = 0x47;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;

/** Minimum spacing between wire sends (project pacing rule). */
const PACE_MS = 60;
/** Per-request listen window. */
const LISTEN_MS = 400;

/** Sweep range: 0x00..0x09 conservative + 0x0a..0x10 documented candidates. */
const SWEEP_FIRST = 0x00;
const SWEEP_LAST = 0x10;

// ── Helpers ────────────────────────────────────────────────────────

function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function buildSysinfoRequest(payload: number[]): number[] {
  const head = [
    SYSEX_START,
    ...FRACTAL_MFR,
    MODEL_BYTE,
    FN_GET_SYSINFO,
    ...payload,
  ];
  return [...head, fractalChecksum(head), SYSEX_END];
}

function findPort(io: MidiInput | MidiOutput, fragment: string): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    if (io.getPortName(i).toLowerCase().includes(fragment.toLowerCase())) {
      return i;
    }
  }
  return -1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Frame checksum check: XOR-7F over F0..last payload byte. */
function checksumValid(frame: readonly number[]): boolean {
  if (frame.length < 3 || frame[frame.length - 1] !== SYSEX_END) return false;
  const head = frame.slice(0, frame.length - 2);
  return fractalChecksum(head as number[]) === frame[frame.length - 2];
}

/** Extract the payload of a fn=0x47 response (drop header, cksum, F7). */
function responsePayload(frame: readonly number[]): number[] {
  return frame.slice(6, frame.length - 2) as number[];
}

interface SweepResult {
  /** Request selector byte, or undefined for the no-payload baseline. */
  selector: number | undefined;
  requestHex: string;
  /** All inbound frames seen in the window (hex). */
  inboundHex: string[];
  /** The fn=0x47 response frame, if any. */
  responseHex: string | undefined;
  payload: number[] | undefined;
  checksumOk: boolean | undefined;
  /** Byte indices where payload differs from the baseline payload. */
  diffVsBaseline: number[] | undefined;
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  guardAgainstRunningEditors(args); // editor-held port + our traffic = WinMM wedge; --ignore-editors overrides
  const portIdx = args.indexOf('--port');
  const portFragment =
    portIdx >= 0 && args[portIdx + 1] && !args[portIdx + 1]!.startsWith('--')
      ? args[portIdx + 1]!
      : DEFAULT_PORT_FRAGMENT;

  const selectors: Array<number | undefined> = [undefined];
  for (let b = SWEEP_FIRST; b <= SWEEP_LAST; b++) selectors.push(b);

  console.log('Axe-Fx II fn=0x47 SYSEX_GET_SYSINFO request-byte sweep');
  console.log('=======================================================');
  console.log('STRICTLY READ-ONLY: fn=0x47 requests only. No writes, no');
  console.log('preset switches, no saves.');
  console.log(
    `Planned wire transactions: ${selectors.length} ` +
      '(1 no-payload baseline + ' +
      `${SWEEP_LAST - SWEEP_FIRST + 1} single-byte selectors ` +
      `0x${SWEEP_FIRST.toString(16).padStart(2, '0')}..` +
      `0x${SWEEP_LAST.toString(16).padStart(2, '0')})`,
  );
  console.log(
    `Pacing: >= ${PACE_MS} ms between sends, ${LISTEN_MS} ms listen each, ` +
      `expected ~${Math.ceil((selectors.length * (LISTEN_MS + PACE_MS)) / 1000)} s total.`,
  );
  console.log(`Port fragment: "${portFragment}"\n`);

  const input = new midi.Input();
  const output = new midi.Output();
  const outIdx = findPort(output, portFragment);
  const inIdx = findPort(input, portFragment);
  if (outIdx < 0 || inIdx < 0) {
    console.error(
      `ERROR: no MIDI port matching "${portFragment}". ` +
        'Is the Axe-Fx II connected? Is AxeEdit holding the port?',
    );
    process.exit(1);
  }
  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);

  const collected: number[][] = [];
  const assemble = createSysExAssembler((bytes) => {
    if (bytes[0] === 0xf0) collected.push(bytes.slice());
  });
  input.on('message', (_dt, bytes) => assemble(bytes));
  input.openPort(inIdx);

  console.log('Ports open. Quiet window (500 ms) ...\n');
  await sleep(500);
  collected.length = 0;

  const rawTraffic: number[] = [];
  const results: SweepResult[] = [];
  let baselinePayload: number[] | undefined;

  for (let i = 0; i < selectors.length; i++) {
    const selector = selectors[i];
    const request = buildSysinfoRequest(
      selector === undefined ? [] : [selector],
    );
    const label =
      selector === undefined
        ? 'baseline (no payload)'
        : `selector 0x${selector.toString(16).padStart(2, '0')}`;

    collected.length = 0;
    output.sendMessage(request);
    rawTraffic.push(...request);
    await sleep(LISTEN_MS);

    const inbound = collected.slice();
    for (const f of inbound) rawTraffic.push(...f);

    // The fn=0x47 response: a Fractal frame whose function byte is 0x47
    // and which is not a verbatim echo of our own request.
    const responseFrame = inbound.find(
      (f) =>
        f.length >= 8 &&
        f[0] === SYSEX_START &&
        f[1] === FRACTAL_MFR[0] &&
        f[2] === FRACTAL_MFR[1] &&
        f[3] === FRACTAL_MFR[2] &&
        f[5] === FN_GET_SYSINFO &&
        toHex(f) !== toHex(request),
    );

    const payload = responseFrame ? responsePayload(responseFrame) : undefined;
    if (selector === undefined && payload) baselinePayload = payload;

    let diffVsBaseline: number[] | undefined;
    if (payload && baselinePayload) {
      diffVsBaseline = [];
      const maxLen = Math.max(payload.length, baselinePayload.length);
      for (let b = 0; b < maxLen; b++) {
        if (payload[b] !== baselinePayload[b]) diffVsBaseline.push(b);
      }
    }

    const result: SweepResult = {
      selector,
      requestHex: toHex(request),
      inboundHex: inbound.map(toHex),
      responseHex: responseFrame ? toHex(responseFrame) : undefined,
      payload,
      checksumOk: responseFrame ? checksumValid(responseFrame) : undefined,
      diffVsBaseline,
    };
    results.push(result);

    const verdict = responseFrame
      ? `response ${payload!.length}B` +
        (diffVsBaseline && diffVsBaseline.length > 0
          ? `, DIFFERS at byte(s) [${diffVsBaseline.join(', ')}]`
          : selector === undefined
            ? ''
            : ', identical to baseline')
      : 'SILENT';
    console.log(
      `[${String(i + 1).padStart(2)}/${selectors.length}] ${label}: ${verdict}` +
        (inbound.length > (responseFrame ? 1 : 0)
          ? ` (+${inbound.length - (responseFrame ? 1 : 0)} other frame(s))`
          : ''),
    );
  }

  // Per-payload-byte movement summary across all responses.
  const responsesWithPayload = results.filter((r) => r.payload !== undefined);
  const maxPayloadLen = Math.max(
    0,
    ...responsesWithPayload.map((r) => r.payload!.length),
  );
  const movingFields: Array<{ index: number; values: string[] }> = [];
  for (let b = 0; b < maxPayloadLen; b++) {
    const distinct = new Set(
      responsesWithPayload.map((r) =>
        r.payload![b] === undefined
          ? '(absent)'
          : r.payload![b]!.toString(16).padStart(2, '0'),
      ),
    );
    if (distinct.size > 1) {
      movingFields.push({ index: b, values: [...distinct].sort() });
    }
  }

  // ── Artifacts ────────────────────────────────────────────────────
  mkdirSync('samples/captured', { recursive: true });

  writeFileSync(
    'samples/captured/probe-ii-sysinfo-sweep.syx',
    Uint8Array.from(rawTraffic),
  );

  const report = {
    probe: 'probe-ii-sysinfo-sweep',
    timestamp: new Date().toISOString(),
    portFragment,
    modelByte: MODEL_BYTE,
    fn: FN_GET_SYSINFO,
    baselinePayloadHex: baselinePayload ? toHex(baselinePayload) : undefined,
    movingFields,
    results,
  };
  writeFileSync(
    'samples/captured/probe-ii-sysinfo-sweep.json',
    JSON.stringify(report, null, 2),
  );

  const md: string[] = [
    '# Axe-Fx II fn=0x47 SYSEX_GET_SYSINFO request-byte sweep, findings',
    '',
    '> Auto-generated by `scripts/_research/probe-ii-sysinfo-sweep.ts`',
    `> at ${new Date().toISOString()}`,
    '',
    'Read-only sweep of the fn=0x47 request byte (SYSEX-MAP section 5f',
    'open item). Baseline = no-payload request; each variant carries a',
    'single selector byte.',
    '',
    `Baseline response payload: \`${baselinePayload ? toHex(baselinePayload) : '(no response)'}\``,
    '',
    '## Request byte to response',
    '',
    '| selector | response (full frame hex) | payload | cksum | diff vs baseline |',
    '|---|---|---|---|---|',
    ...results.map((r) => {
      const sel =
        r.selector === undefined
          ? '(none)'
          : `0x${r.selector.toString(16).padStart(2, '0')}`;
      const resp = r.responseHex ? `\`${r.responseHex}\`` : 'SILENT';
      const pay = r.payload ? `\`${toHex(r.payload)}\`` : '';
      const ck =
        r.checksumOk === undefined ? '' : r.checksumOk ? 'ok' : 'BAD';
      const diff =
        r.diffVsBaseline === undefined
          ? ''
          : r.diffVsBaseline.length === 0
            ? 'identical'
            : `byte(s) [${r.diffVsBaseline.join(', ')}]`;
      return `| ${sel} | ${resp} | ${pay} | ${ck} | ${diff} |`;
    }),
    '',
    '## Moving payload fields (across all responses)',
    '',
    movingFields.length === 0
      ? 'No payload byte moved across the sweep: the response appears ' +
        'selector-insensitive in this range.'
      : [
          '| payload byte index | distinct values seen |',
          '|---|---|',
          ...movingFields.map(
            (m) => `| ${m.index} | ${m.values.join(', ')} |`,
          ),
        ].join('\n'),
    '',
    '## Other inbound frames per request',
    '',
    ...results.flatMap((r) => {
      const sel =
        r.selector === undefined
          ? '(none)'
          : `0x${r.selector.toString(16).padStart(2, '0')}`;
      const others = r.inboundHex.filter((h) => h !== r.responseHex);
      if (others.length === 0) return [];
      return [
        `### selector ${sel}`,
        '',
        ...others.map((h) => `- \`${h}\``),
        '',
      ];
    }),
  ];
  writeFileSync(
    'samples/captured/probe-ii-sysinfo-sweep-findings.md',
    md.join('\n'),
  );

  const silentCount = results.filter((r) => r.responseHex === undefined).length;
  console.log(
    `\nDone: ${results.length} requests, ` +
      `${results.length - silentCount} responded, ${silentCount} silent, ` +
      `${movingFields.length} payload byte position(s) moved.`,
  );
  console.log('Wrote samples/captured/probe-ii-sysinfo-sweep.json');
  console.log('Wrote samples/captured/probe-ii-sysinfo-sweep-findings.md');
  console.log('Wrote samples/captured/probe-ii-sysinfo-sweep.syx');

  input.closePort();
  output.closePort();
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
