/**
 * Fractal editor emulator — reusable runner.
 *
 * The MIDI/loopMIDI plumbing + codec-backed SimDevice loop, extracted from the
 * `fractal-editor-emulator.ts` CLI so other tools (the controlled-capture
 * runner) can drive an editor session without duplicating the transport code.
 *
 * `runEmulator(opts)` opens the two loopMIDI ports, seeds the SimDevice, logs
 * both directions to a `.syx` + sibling `.annotated.jsonl`, answers the editor's
 * reads so it renders the grid, and on Ctrl+C flushes the logs and (optionally)
 * calls `onStop(jsonlPath)` so a caller can decode the just-captured session.
 *
 * Why this exists despite the negative primitive entry on virtual-MIDI bridges:
 * FM-Edit (unlike AxeEdit II / AM4-Edit) accepts an "AXE"-prefixed loopMIDI
 * port and reports "Connected!" with no hardware — see the CLI header.
 */
import fs from 'node:fs';
import path from 'node:path';
import midi from "@julusian/midi";
import { SimDevice, type CaptureFrame } from './SimDevice.js';
import type { FractalModernConfig } from './types.js';
import { AXE_FX_III_CONFIG } from '@mcp-midi-control/fractal-gen3/configs/axe-fx-iii.js';
import { FM3_CONFIG } from '@mcp-midi-control/fractal-gen3/configs/fm3.js';
import { FM9_CONFIG } from '@mcp-midi-control/fractal-gen3/configs/fm9.js';

export const CONFIG_BY_MODEL: Record<number, FractalModernConfig> = {
  0x10: AXE_FX_III_CONFIG,
  0x11: FM3_CONFIG,
  0x12: FM9_CONFIG,
};
export const DEFAULT_SEED =
  'samples/captured/decoded/fm9-capture3-enum-sweep-2026-06-03.frames.json';

export interface EmulatorOptions {
  modelByte: number;
  inNeedle: string;
  outNeedle: string;
  /** Output `.syx` path (the `.annotated.jsonl` is a sibling). */
  logPath: string;
  seedPath?: string;
  echo?: boolean;
  rateCap?: number;
  /** Extra instructions printed after the standard startup banner. */
  banner?: string;
  /** Called once after the logs flush on Ctrl+C, with the jsonl path. */
  onStop?: (jsonlPath: string) => void | Promise<void>;
}

interface PortInfo { index: number; name: string }

function listPorts(io: midi.Input | midi.Output): PortInfo[] {
  const ports: PortInfo[] = [];
  for (let i = 0; i < io.getPortCount(); i++) ports.push({ index: i, name: io.getPortName(i) });
  return ports;
}
function find(ports: PortInfo[], needle: string): PortInfo | undefined {
  const lc = needle.toLowerCase();
  return ports.find((p) => p.name.toLowerCase().includes(lc));
}

/** Print the input/output port lists (the no-args help path). */
export function printPorts(): void {
  const probeIn = new midi.Input();
  const probeOut = new midi.Output();
  const inPorts = listPorts(probeIn);
  const outPorts = listPorts(probeOut);
  console.error('MIDI INPUT ports (pick the one the editor sends OUT to):');
  inPorts.forEach((p) => console.error(`  [${p.index}] ${p.name}`));
  console.error('\nMIDI OUTPUT ports (pick the one the editor reads IN from):');
  outPorts.forEach((p) => console.error(`  [${p.index}] ${p.name}`));
  try { probeIn.closePort(); } catch { /* not open */ }
  try { probeOut.closePort(); } catch { /* not open */ }
}

const MANUF = [0x00, 0x01, 0x74];
const xor7 = (bytes: number[]): number => bytes.reduce((a, b) => a ^ b, 0) & 0x7f;
const hex = (bytes: number[]): string => bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
const hx = (s: string): number[] => s.trim().split(/\s+/).map((b) => parseInt(b, 16));

function describe(bytes: number[]): { isFractal: boolean; model?: number; fn?: number } {
  if (bytes[0] === 0xf0 && bytes[1] === MANUF[0] && bytes[2] === MANUF[1] && bytes[3] === MANUF[2]) {
    return { isFractal: true, model: bytes[4], fn: bytes[5] };
  }
  return { isFractal: false };
}

/** Open the ports, run the sim loop, and return when Ctrl+C is pressed. */
export function runEmulator(opts: EmulatorOptions): void {
  const { modelByte, inNeedle, outNeedle } = opts;
  const echo = opts.echo ?? true;
  const RATE_CAP = opts.rateCap ?? 700;

  const envelope = (fn: number, payload: number[] = []): number[] => {
    const body = [0xf0, ...MANUF, modelByte, fn, ...payload];
    return [...body, xor7(body), 0xf7];
  };
  const remapModel = (frame: number[]): number[] => {
    if (frame[4] === modelByte) return frame;
    const out = [...frame];
    out[4] = modelByte;
    out[out.length - 2] = xor7(out.slice(0, out.length - 2));
    return out;
  };

  // Authentic device->host handshake replies lifted verbatim from a real FM9
  // capture. WHO_AM_I byte[6] is the firmware major version; III-Edit checks
  // this and rejects anything outside the III firmware range. Serve version 29
  // (0x1d, matching the FW 29.247 last seen on the real III) for model 0x10/0x11;
  // keep FM9's version 11 (0x0b) for model 0x12.
  const WHO_AM_I_FW_MAJOR = modelByte === 0x12 ? 0x0b : 0x1d; // 11 for FM9, 29 for III/FM3
  const WHO_AM_I_BODY = [
    // fn=0x08, fw_major, fw_minor(0), pad, 0x04, pad, pad, build-date ASCII
    0x08, WHO_AM_I_FW_MAJOR, 0x00, 0x00, 0x01, 0x04, 0x00, 0x00,
    // "Jan 19 2026 11:03:42" as ASCII + null padding to fill 47-byte frame
    0x4a, 0x61, 0x6e, 0x20, 0x31, 0x39, 0x20, 0x32, 0x30, 0x32, 0x36, 0x20,
    0x31, 0x31, 0x3a, 0x30, 0x33, 0x3a, 0x34, 0x32,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x7f, // placeholder checksum — recomputed by remapModel
  ];
  const REPLY_WHO_AM_I = remapModel([0xf0, 0x00, 0x01, 0x74, 0x12, ...WHO_AM_I_BODY, 0xf7]);
  const REPLY_INIT = remapModel(hx('f0 00 01 74 12 47 4b 02 00 10 00 08 10 00 11 f7'));
  const ANNOUNCE = remapModel(hx('f0 00 01 74 12 64 00 00 73 f7'));
  const RESPONDERS: Record<number, (q: number[]) => number[] | undefined> = {
    0x08: () => REPLY_WHO_AM_I,
    0x47: () => REPLY_INIT,
    0x00: () => envelope(0x00, [modelByte]),
  };

  const probeIn = new midi.Input();
  const probeOut = new midi.Output();
  const inPort = find(listPorts(probeIn), inNeedle);
  const outPort = find(listPorts(probeOut), outNeedle);
  try { probeIn.closePort(); } catch { /* not open */ }
  try { probeOut.closePort(); } catch { /* not open */ }
  if (!inPort) { console.error(`No INPUT port matching "${inNeedle}". Run with no args to list ports.`); process.exit(1); }
  if (!outPort) { console.error(`No OUTPUT port matching "${outNeedle}". Run with no args to list ports.`); process.exit(1); }

  const simConfig = CONFIG_BY_MODEL[modelByte];
  if (!simConfig) {
    console.error(`No fractal-gen3 config for model 0x${modelByte.toString(16)} (expected 0x10/0x11/0x12).`);
    process.exit(1);
  }
  const sim = new SimDevice(simConfig);
  const seedArg = opts.seedPath ?? DEFAULT_SEED;
  const seedAbs = path.isAbsolute(seedArg) ? seedArg : path.resolve(process.cwd(), seedArg);
  if (fs.existsSync(seedAbs)) {
    const frames = JSON.parse(fs.readFileSync(seedAbs, 'utf8')) as CaptureFrame[];
    sim.seedFromCaptureFrames(frames);
    console.error(`sim: seeded ${sim.state.active.blocks.size} placed blocks from ${path.basename(seedAbs)} (model 0x${modelByte.toString(16)})`);
  } else {
    console.error(`sim: seed capture not found at ${seedAbs} — grid will render empty (handshake only).`);
  }

  const absLog = path.isAbsolute(opts.logPath) ? opts.logPath : path.resolve(process.cwd(), opts.logPath);
  fs.mkdirSync(path.dirname(absLog), { recursive: true });
  const jsonlPath = absLog.replace(/\.syx$/i, '') + '.annotated.jsonl';
  const rawStream = fs.createWriteStream(absLog, { flags: 'a' });
  const jsonlStream = fs.createWriteStream(jsonlPath, { flags: 'a' });

  const input = new midi.Input();
  const output = new midi.Output();
  input.ignoreTypes(false, true, true); // keep SysEx, drop clock + active-sensing

  const fnHistogram = new Map<number, number>();
  let msgCount = 0, byteCount = 0, sentCount = 0, simHandled = 0;
  const start = Date.now();
  let rateWindow = Date.now(), rateCount = 0, rateDrops = 0;
  const rateOk = (): boolean => {
    const now = Date.now();
    if (now - rateWindow >= 1000) { rateWindow = now; rateCount = 0; }
    if (rateCount >= RATE_CAP) { rateDrops++; return false; }
    rateCount++; return true;
  };
  const renderHistogram = (): string =>
    [...fnHistogram.entries()].sort((a, b) => a[0] - b[0])
      .map(([fn, n]) => `fn=0x${fn.toString(16).padStart(2, '0')}:${n}`).join('  ');

  input.on('message', (_dt, bytes) => {
    msgCount++;
    byteCount += bytes.length;
    rawStream.write(Buffer.from(bytes));
    const info = describe(bytes);
    if (info.isFractal && info.fn !== undefined) fnHistogram.set(info.fn, (fnHistogram.get(info.fn) ?? 0) + 1);
    jsonlStream.write(JSON.stringify({
      t: ((Date.now() - start) / 1000).toFixed(3),
      fractal: info.isFractal,
      model: info.model !== undefined ? `0x${info.model.toString(16)}` : undefined,
      fn: info.fn !== undefined ? `0x${info.fn.toString(16)}` : undefined,
      len: bytes.length,
      hex: hex(bytes),
    }) + '\n');

    if (info.fn === 0x00 || info.fn === 0x08) {
      try { output.sendMessage(ANNOUNCE); sentCount++; } catch { /* closed */ }
    }
    let replies: number[][] = [];
    let kind = 'echo';
    if (info.fn !== undefined && RESPONDERS[info.fn]) {
      const r = RESPONDERS[info.fn](bytes);
      if (r) { replies = [r]; kind = 'responder'; }
    } else if (info.fn === 0x01 || info.fn === 0x1f) {
      replies = sim.handle(bytes);
      kind = `sim:${sim.lastTrace.kind}`;
      simHandled++;
    } else if (echo) {
      replies = [bytes];
    }
    for (const reply of replies) {
      // The write-ack (sim:write) is what unblocks a multi-step editor write
      // (sub=0x30 select -> sub=0x32 insert): the editor stalls at grid_set_position
      // and times out if it never arrives. NEVER rate-drop it — the post-render
      // param-definition stream can saturate the cap and silently swallow the ack
      // (the "cables worked last session, not this one" failure). Bulk read
      // replies (sim:verbatim / sim:project) stay capped to avoid loopMIDI mute.
      const isWriteAck = kind === 'sim:write';
      if (!isWriteAck && !rateOk()) break;
      try {
        output.sendMessage(reply);
        sentCount++;
        const rinfo = describe(reply);
        jsonlStream.write(JSON.stringify({
          t: ((Date.now() - start) / 1000).toFixed(3),
          dir: 'OUT', kind,
          fn: rinfo.fn !== undefined ? `0x${rinfo.fn.toString(16)}` : undefined,
          len: reply.length,
          hex: hex(reply),
        }) + '\n');
      } catch { /* port closed mid-shutdown */ }
    }
    process.stderr.write(
      `\r[${((Date.now() - start) / 1000).toFixed(1)}s] in:${msgCount} out:${sentCount}` +
      ` sim:${simHandled}(${sim.lastTrace.kind})` +
      (rateDrops ? ` dropped:${rateDrops}` : '') +
      ` | ${renderHistogram()}        `,
    );
  });

  try {
    output.openPort(outPort.index);
    input.openPort(inPort.index);
  } catch (err) {
    console.error(`\nFailed to open ports: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.error(`Emulating Fractal model 0x${modelByte.toString(16)} on:`);
  console.error(`  IN  (editor->us): [${inPort.index}] ${inPort.name}`);
  console.error(`  OUT (us->editor): [${outPort.index}] ${outPort.name}`);
  console.error(`  echo: ${echo ? 'ON' : 'OFF'}   sim: model 0x${modelByte.toString(16)}, ${sim.state.active.blocks.size} placed blocks   announce: fn=0x64`);
  console.error(`  raw log:   ${absLog}`);
  console.error(`  annotated: ${jsonlPath}`);
  if (opts.banner) console.error(`\n${opts.banner}`);
  console.error('\nConnect FM-Edit (Out -> IN port, In -> OUT port). Ctrl+C to stop.\n');

  process.on('SIGINT', () => {
    console.error('\n\nStopping...');
    try { input.closePort(); } catch { /* already closed */ }
    try { output.closePort(); } catch { /* already closed */ }
    rawStream.end();
    jsonlStream.end(async () => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.error(`\nCaptured ${msgCount} messages (${byteCount} bytes), sent ${sentCount} replies over ${elapsed}s.`);
      console.error(`Function-byte histogram: ${renderHistogram() || '(none)'}`);
      console.error(`Raw:       ${absLog}`);
      console.error(`Annotated: ${jsonlPath}`);
      if (opts.onStop) {
        try { await opts.onStop(jsonlPath); } catch (err) {
          console.error(`onStop decode failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      process.exit(0);
    });
  });
}
