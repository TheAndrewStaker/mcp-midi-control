/**
 * AM4 fn 0x1F probe — does the AM4 expose an atomic bulk-read primitive
 * analogous to the Axe-Fx II's SYSEX_GET_ALL_PARAMS (fn 0x1F)?
 *
 * The Axe-Fx II decode confirmed that firing fn 0x1F with a 2-byte
 * septet-packed `effectId` payload causes the
 * device to respond with a 0x74/0x75/0x76 state-broadcast triple
 * containing every paramId of that block in one round-trip. AM4-Edit
 * is part of the same JUCE/Fractal codebase as AxeEdit II, so a
 * similar primitive may exist on AM4 — if so, it's a ~500ms-1s win
 * on every full-block state read (currently a per-paramId loop).
 *
 * # What this script does
 *
 * 1. Open the AM4 USB MIDI in/out endpoints.
 * 2. For each of a handful of payload shapes (empty, 2-byte zero,
 *    2-byte effect-id-like values, 4-byte values), send
 *    `F0 00 01 74 15 1F <payload> <cksum> F7` and capture the
 *    inbound stream for 500ms.
 * 3. Classify each result:
 *      - silent (no response within window)         → opcode unsupported
 *      - fn 0x64 multipurpose-response with NACK   → opcode known but
 *                                                     payload rejected
 *      - fn 0x74/0x75/0x76 triple                  → BULK READ HIT!
 *      - any other inbound frame                    → log + classify
 *        downstream
 * 4. Write a findings markdown to `samples/captured/decoded/
 *    probe-am4-fn1f-findings.md` with a per-shape verdict + the raw
 *    response bytes (so a future decode pass can extract the payload
 *    structure).
 *
 * # Prereqs
 *
 * - AM4 powered on, USB connected (driver per
 *   https://www.fractalaudio.com/am4-downloads/).
 * - **Close AM4-Edit** — its polling traffic would pollute the
 *   inbound stream while the probe is running.
 *
 * # Run
 *
 * ```
 * npx tsx scripts/_research/probe-am4-fn1f.ts
 * ```
 *
 * # Output
 *
 * - `samples/captured/probe-am4-fn1f.syx` — raw inbound bytes
 *   concatenated across all probes.
 * - `samples/captured/decoded/probe-am4-fn1f-findings.md` — per-shape
 *   verdict + decoded structure hints.
 *
 * # What to do with the result
 *
 * - If silent across all shapes → fn 0x1F is unsupported on AM4.
 *   Close the lane as a negative finding (primitives _negative entry).
 * - If 0x74/0x75/0x76 triple returned → port the II `readAllParams`
 *   pattern to AM4 (codec primitive in `fractal-midi/src/am4/setParam.ts`
 *   + descriptor wrap in `packages/am4/src/descriptor/reader.ts`).
 * - If a different envelope shape returned → decode + register the
 *   new primitive in the primitives corpus + ship a codec helper.
 */
import midi from "@julusian/midi";
import { writeFileSync, mkdirSync } from 'node:fs';

const AM4_MODEL = 0x15;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FN_GET_ALL_PARAMS = 0x1f;
const PROBE_WAIT_MS = 500;
const NODEMIDI_FRAME_CAP = 2048;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}

function buildEnvelope(payload: number[]): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, AM4_MODEL, FN_GET_ALL_PARAMS, ...payload];
  return [...head, fractalChecksum(head), SYSEX_END];
}

function encode14(n: number): [number, number] {
  return [n & 0x7f, (n >> 7) & 0x7f];
}

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

interface ProbeShape {
  /** Label shown in the report. */
  label: string;
  /** Bytes between fn=0x1F and the checksum (no envelope). */
  payload: number[];
  /** Why we're trying this. */
  rationale: string;
}

const SHAPES: ProbeShape[] = [
  { label: 'empty',          payload: [],                        rationale: 'Minimum envelope — does the device recognize the opcode at all?' },
  { label: 'zero14',         payload: [0x00, 0x00],              rationale: 'II expects a 2-byte septet-packed effectId; try zero first.' },
  { label: 'amp1',           payload: encode14(106),             rationale: 'II amp-1 effectId; if AM4 follows II shape, this is the test.' },
  { label: 'preset_zero14',  payload: encode14(0),               rationale: 'AM4 thinks in preset locations + scenes; try preset 0.' },
  { label: 'scene1',         payload: [0x01, 0x00],              rationale: 'AM4 has 4 scenes; try a scene index.' },
  { label: 'slot1_amp',      payload: [0x01, 0x00, 0x00, 0x00],  rationale: 'AM4-style 4-byte param-addr (slot, block) shape.' },
  { label: 'longer_zeros',   payload: [0, 0, 0, 0, 0, 0],        rationale: 'Catch-all for unexpected payload widths.' },
];

// ── Inbound collector ──────────────────────────────────────────────
interface InboundFrame {
  ts: number;
  bytes: number[];
}

function collectInbound(input: midi.Input, windowMs: number): Promise<InboundFrame[]> {
  return new Promise((resolve) => {
    const frames: InboundFrame[] = [];
    const handler = (_deltaTime: number, message: number[]) => {
      frames.push({ ts: Date.now(), bytes: [...message] });
    };
    input.on('message', handler);
    setTimeout(() => {
      input.removeListener('message', handler);
      resolve(frames);
    }, windowMs);
  });
}

// ── Classification ─────────────────────────────────────────────────
type Verdict =
  | { kind: 'silent' }
  | { kind: 'multipurpose_nack'; resultCode: number; bytes: number[] }
  | { kind: 'state_broadcast_triple'; bytes: number[][] }
  | { kind: 'unknown'; bytes: number[] };

function classify(frames: InboundFrame[]): Verdict {
  if (frames.length === 0) return { kind: 'silent' };
  // Filter to Fractal-mfr frames matching our model byte.
  const ours = frames
    .map((f) => f.bytes)
    .filter((b) =>
      b.length >= 7
      && b[0] === SYSEX_START
      && b[1] === FRACTAL_MFR[0]
      && b[2] === FRACTAL_MFR[1]
      && b[3] === FRACTAL_MFR[2]
      && b[4] === AM4_MODEL,
    );
  if (ours.length === 0) {
    return { kind: 'unknown', bytes: frames[0]?.bytes ?? [] };
  }
  // 0x64 multipurpose-response with echoed fn 0x1F = NACK
  const mpResp = ours.find((b) => b[5] === 0x64 && b.length >= 8 && b[6] === FN_GET_ALL_PARAMS);
  if (mpResp) {
    return { kind: 'multipurpose_nack', resultCode: mpResp[7] ?? 0, bytes: mpResp };
  }
  // 0x74/0x75/0x76 state-broadcast triple (II pattern)
  const hasHeader = ours.some((b) => b[5] === 0x74);
  const hasChunk  = ours.some((b) => b[5] === 0x75);
  const hasFooter = ours.some((b) => b[5] === 0x76);
  if (hasHeader && hasChunk && hasFooter) {
    return { kind: 'state_broadcast_triple', bytes: ours };
  }
  return { kind: 'unknown', bytes: ours[0] };
}

// ── Main ───────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const input = new midi.Input();
  const output = new midi.Output();

  // Locate AM4 endpoints.
  const findPort = (instance: midi.Input | midi.Output, label: string): number => {
    const count = instance.getPortCount();
    for (let i = 0; i < count; i++) {
      const name = instance.getPortName(i);
      if (/AM4|Fractal.*AM4/i.test(name)) return i;
    }
    const names = Array.from({ length: count }, (_, i) => instance.getPortName(i));
    throw new Error(`No AM4 ${label} port found. Available: ${names.join(' | ') || '(none)'}`);
  };

  const inPort = findPort(input, 'input');
  const outPort = findPort(output, 'output');
  console.log(`AM4 input:  port ${inPort} (${input.getPortName(inPort)})`);
  console.log(`AM4 output: port ${outPort} (${output.getPortName(outPort)})`);

  input.ignoreTypes(false, true, true); // accept SysEx, ignore timing+active-sense
  input.openPort(inPort);
  output.openPort(outPort);

  const findings: { shape: ProbeShape; verdict: Verdict; envelope: number[]; rawFrames: InboundFrame[] }[] = [];
  const allRawBytes: number[] = [];

  for (const shape of SHAPES) {
    const envelope = buildEnvelope(shape.payload);
    console.log(`\n[${shape.label}] sending ${envelope.length}B: ${hex(envelope)}`);

    const collector = collectInbound(input, PROBE_WAIT_MS);
    output.sendMessage(envelope);
    const frames = await collector;
    for (const f of frames) allRawBytes.push(...f.bytes);

    const verdict = classify(frames);
    console.log(`  → ${frames.length} inbound frame(s); verdict: ${verdict.kind}`);
    findings.push({ shape, verdict, envelope, rawFrames: frames });

    // 50ms breather between probes to let any straggler frames land
    // before we start the next inbound window.
    await new Promise((res) => setTimeout(res, 50));
  }

  input.closePort();
  output.closePort();

  // ── Write outputs ───────────────────────────────────────────────
  mkdirSync('samples/captured/decoded', { recursive: true });
  const sxPath = 'samples/captured/probe-am4-fn1f.syx';
  writeFileSync(sxPath, Buffer.from(allRawBytes));
  console.log(`\nRaw inbound bytes: ${allRawBytes.length} → ${sxPath}`);

  const md: string[] = [];
  md.push('# AM4 fn 0x1F probe — findings');
  md.push('');
  md.push(`Probe run: ${new Date().toISOString()}`);
  md.push(`Raw inbound (concatenated across all probes): \`${sxPath}\``);
  md.push('');
  md.push('## Per-shape verdicts');
  md.push('');
  for (const { shape, verdict, envelope, rawFrames } of findings) {
    md.push(`### \`${shape.label}\` — ${verdict.kind}`);
    md.push('');
    md.push(`**Rationale:** ${shape.rationale}`);
    md.push(`**Sent (${envelope.length}B):** \`${hex(envelope)}\``);
    md.push(`**Inbound frames:** ${rawFrames.length}`);
    md.push('');
    if (verdict.kind === 'silent') {
      md.push('Device did not respond within the probe window. Either the');
      md.push("opcode isn't recognized for this payload shape, OR the device");
      md.push('is still mid-other-operation. Cross-check with `empty` shape:');
      md.push("if THAT is also silent, fn 0x1F likely isn't an AM4 opcode.");
    } else if (verdict.kind === 'multipurpose_nack') {
      md.push(`Device responded with multipurpose-response (0x64), echoing fn 0x1F with result_code 0x${verdict.resultCode.toString(16).padStart(2, '0')}. This means the opcode IS recognized but the payload shape was rejected. Try other shapes; the right payload may unlock the response.`);
      md.push('');
      md.push(`Raw NACK: \`${hex(verdict.bytes)}\``);
    } else if (verdict.kind === 'state_broadcast_triple') {
      md.push('**🎯 HIT.** Device responded with a 0x74/0x75/0x76 state-broadcast');
      md.push("triple — same envelope shape as the Axe-Fx II's fn 0x1F bulk-read.");
      md.push('Decode the chunk contents using the same pattern as');
      md.push('`packages/fractal-gen2/src/descriptor/reader.ts:213` (`readAllParams`).');
      md.push('Next step: port that pattern to AM4 codec + descriptor.');
      md.push('');
      md.push('Frames:');
      for (const b of verdict.bytes) {
        md.push(`- \`${hex(b)}\``);
      }
    } else {
      md.push('Device responded with an unexpected envelope shape. Inspect:');
      md.push('');
      md.push(`First frame: \`${hex(verdict.bytes)}\``);
    }
    md.push('');
  }

  md.push('## Next actions');
  md.push('');
  md.push('- If every shape is `silent`: register negative finding in');
  md.push('  `fractal-midi/docs/research/primitives/_negative/` —');
  md.push('  `am4-fn-1f-unsupported.md`. AM4 has no bulk-read primitive');
  md.push('  analogous to II; per-paramId loop is the canonical path.');
  md.push('- If any shape is `state_broadcast_triple`: add a `buildGetAllParams`');
  md.push('  to `fractal-midi/src/am4/setParam.ts` mirroring the II shape, and');
  md.push('  wire a descriptor-layer `readAllParams` analogous to');
  md.push('  `packages/fractal-gen2/src/descriptor/reader.ts:213`. Cut a new');
  md.push('  fractal-midi release; install in this repo; expose via the');
  md.push('  unified `get_params` tool.');
  md.push('- If any shape is `multipurpose_nack`: log the result_code, then');
  md.push('  try variants of that payload (longer/shorter, different field');
  md.push('  widths) to find the accepted shape.');

  const mdPath = 'samples/captured/decoded/probe-am4-fn1f-findings.md';
  writeFileSync(mdPath, md.join('\n'));
  console.log(`\nFindings: ${mdPath}`);
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exitCode = 1;
});
