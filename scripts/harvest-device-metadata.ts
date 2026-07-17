/**
 * harvest-device-metadata.ts, the one-command device self-describe harvest.
 *
 * Connects to a Fractal device over USB MIDI, sweeps every read-only
 * metadata surface the device serves, and writes ONE JSON file the tester
 * sends back. Replaces dozens of itemized capture asks.
 *
 * READ-ONLY BY CONSTRUCTION. Every outbound frame passes a mechanical
 * whitelist (assertReadOnly) before it reaches the wire: documented QUERY /
 * dump-request shapes only. No SET, no store/save, no preset or scene
 * switch, no program change, no fn=0x01 write sub-actions. The fn=0x01
 * frames this script sends are the editor's own read queries (sub-actions
 * 0x01 / 0x1a / 0x1f / 0x2a / 0x2e / 0x7b, byte-exact to captured editor
 * traffic) with the value region required to be all zeros.
 *
 * BOUNDED BY CONSTRUCTION. Every transaction carries a hard timeout
 * (default 1500 ms) and is recorded status=timeout when the device stays
 * silent; the run always moves on. A consecutive-timeout circuit breaker
 * skips the rest of a dead surface. A global watchdog aborts cleanly if no
 * transaction completes for 30 s, and total runtime is capped (default
 * 10 minutes, --max-minutes). Ctrl-C closes the ports and writes whatever
 * was collected. Progress streams to stderr and to an incremental .log
 * file next to the output JSON, so a stalled run is always diagnosable.
 *
 * Outbound frames are paced (>= 80 ms apart, with a settle pause every 50
 * transactions) so the device front panel stays responsive and the WinMM
 * driver queue never backs up. That pacing matters: node-midi's RtMidi
 * WinMM backend spins forever inside sendMessage (Sleep(1) loop waiting
 * for midiOutUnprepareHeader) if the driver never completes a SysEx long
 * message, and no JavaScript timeout can interrupt a blocked native call.
 *
 * Run:  npx tsx scripts/harvest-device-metadata.ts [--port <name>]
 *           [--device am4|axefx2|gen3] [--experimental] [--out <file>]
 *           [--verbose] [--max-minutes <n>] [--ignore-editors]
 *
 * EDITOR PRE-FLIGHT. The script refuses to start while a Fractal editor
 * (Axe-Edit, AM4-Edit, FM3-Edit, FM9-Edit, VP4-Edit, Fractal-Bot) is
 * running: an editor holding the port plus our traffic is the documented
 * WinMM-wedge trigger. --ignore-editors overrides (listen-only sessions).
 *
 * Output: harvest-<model>-<date>.json in the working directory, plus a
 * matching .log file. Raw hex of every request and every response (with
 * timestamps) is always included so future decodes can re-mine the file; a
 * light decoded layer is added where shapes are known (enum labels,
 * param-info records, names, firmware).
 *
 * --experimental additionally fires the gen-3 dictionary-dump requests
 * fn=0x40 and fn=0x1a (read-only requests, semantics unknown; responses
 * arrive as the 0x67/0x68/0x69 and 0x5a/0x5b/0x5c multi-frame families per
 * the AxeEdit III inbound-dispatcher mine) and records whatever comes back.
 *
 * Diagnostic flags (not for normal runs):
 *   --assume-detected  proceed with the first --device candidate model when
 *                      the firmware probe gets no answer (exercises the
 *                      timeout / circuit-breaker paths against a silent or
 *                      loopback port).
 *   --mock-silent      no MIDI at all: a fake session that drops every
 *                      frame, for self-testing the engine. Implies
 *                      --assume-detected; requires --device.
 *
 * Fully automated, no human observation step, so the interactive-probe rule
 * does not apply. Expect a 1-3 minute run; progress prints per surface.
 */

import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import midi from "@julusian/midi";

import { guardAgainstRunningEditors } from './_lib/editor-guard.js';

import {
  AXE_FX_III_BLOCKS,
  buildBlockBulkReadPoll,
  buildQueryPatchName,
  buildGetTempo,
  buildGetScene,
  buildStatusDump,
} from 'fractal-midi/gen3/axe-fx-iii';
import {
  buildGetPresetName as buildGetPresetNameII,
  buildGetGridLayout,
  buildGetAllParams as buildGetAllParamsII,
  buildQueryStates,
  buildGetPresetNumber,
  buildGetSceneNumber,
} from 'fractal-midi/gen2/axe-fx-ii';
import {
  buildGetAllParams as buildGetAllParamsAm4,
  buildRequestActiveBufferDump,
  buildGetPresetName as buildGetPresetNameAm4,
  formatLocationCode,
} from 'fractal-midi/am4';

// ── constants ───────────────────────────────────────────────────────

const FRACTAL_HEADER = [0xf0, 0x00, 0x01, 0x74] as const;

const MODEL_NAMES: Record<number, string> = {
  0x03: 'axe-fx-ii',
  0x05: 'axe-fx-ii-xl',
  0x06: 'ax8',
  0x07: 'axe-fx-ii-xl-plus',
  0x10: 'axe-fx-iii',
  0x11: 'fm3',
  0x12: 'fm9',
  0x14: 'vp4',
  0x15: 'am4',
};

type DeviceClass = 'am4' | 'axefx2' | 'gen3';

const CLASS_CANDIDATES: Record<DeviceClass, number[]> = {
  am4: [0x15],
  axefx2: [0x07, 0x05, 0x03],
  gen3: [0x12, 0x10, 0x11, 0x14],
};

function classOfModel(model: number): DeviceClass | undefined {
  if (model === 0x15) return 'am4';
  if (model === 0x03 || model === 0x05 || model === 0x07) return 'axefx2';
  if (model === 0x10 || model === 0x11 || model === 0x12 || model === 0x14) return 'gen3';
  return undefined;
}

// ── runtime safety limits ───────────────────────────────────────────
// Every limit exists because the first real-device run hung for 43 minutes
// holding the MIDI port. Do not remove one without replacing its guarantee.

/** Hard per-transaction cap when the caller does not override maxMs. */
const TX_TIMEOUT_MS = 1500;
/** Absolute ceiling for per-call maxMs overrides (multi-frame dumps). */
const TX_ABSOLUTE_MAX_MS = 15_000;
/** Minimum gap between outbound frames (front-panel courtesy + keeps the
 *  WinMM driver queue drained so the native send can never block). */
const PACE_MS = 80;
/** Every SETTLE_EVERY sends, pause SETTLE_MS so the device UI catches up. */
const SETTLE_EVERY = 50;
const SETTLE_MS = 500;
/** Consecutive timeouts on one breaker key before the rest is skipped. */
const BREAKER_THRESHOLD = 10;
/** Abort if no transaction completes (answer OR timeout) for this long. */
const WATCHDOG_MS = 30_000;
/** Total-runtime cap, minutes (overridable via --max-minutes). */
const DEFAULT_MAX_MINUTES = 10;

// gen-3 fn=0x01 read sub-actions this script is allowed to emit. These are
// the editor's own connect/sync READ queries (primitive
// gen3-editor-sync-read-surface, byte-exact captures). sub=0x09 (typed
// SET/GET) is deliberately ABSENT: a sub=0x09 frame with value 0 is a
// write of 0 on some params, so it never leaves this script.
const GEN3_READ_SUBS = new Set([0x01, 0x1a, 0x1f, 0x2a, 0x2e, 0x7b]);

// ── tiny wire helpers (envelope + checksum, probe.ts pattern) ───────

function checksum(bytes: number[]): number {
  return bytes.reduce((a, b) => a ^ b, 0) & 0x7f;
}

function frame(model: number, fn: number, payload: number[] = []): number[] {
  const head = [...FRACTAL_HEADER, model, fn, ...payload];
  return [...head, checksum(head), 0xf7];
}

function encode14(v: number): [number, number] {
  return [v & 0x7f, (v >> 7) & 0x7f];
}

function decode14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}

/** 23-byte gen-3 fn=0x01 read query, byte-exact to the captured editor shape. */
function gen3ReadQuery(model: number, sub: number, addr8: number, addr10 = 0): number[] {
  return frame(model, 0x01, [
    sub, 0x00,
    ...encode14(addr8),
    ...encode14(addr10),
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
}

function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** Printable-ASCII runs of length >= 4, for the always-honest decoded layer. */
function asciiRuns(bytes: readonly number[]): string[] {
  const runs: string[] = [];
  let cur = '';
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f) cur += String.fromCharCode(b);
    else { if (cur.length >= 4) runs.push(cur); cur = ''; }
  }
  if (cur.length >= 4) runs.push(cur);
  return runs;
}

/** gen-3 streaming MSB-first 8-to-7 septet unpack from byte 5 to len-2. */
function gen3SeptetUnpack(bytes: readonly number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 5; i < bytes.length - 2; i++) {
    acc = (acc << 7) | (bytes[i] & 0x7f);
    bits += 7;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
}

// ── read-only enforcement ───────────────────────────────────────────

class SafetyViolation extends Error {}

/**
 * Mechanical read-only gate. Throws unless the frame is a documented
 * QUERY / dump-request shape. This is the absolute guard behind the
 * "never writes" promise in the capture guide; extend the whitelist only
 * with frames proven read-only.
 */
function assertReadOnly(bytes: number[]): void {
  if (bytes[0] !== 0xf0 || bytes[1] !== 0x00 || bytes[2] !== 0x01 || bytes[3] !== 0x74) {
    throw new SafetyViolation('only Fractal SysEx frames may be sent');
  }
  const model = bytes[4];
  const fn = bytes[5];
  const payload = bytes.slice(6, bytes.length - 2);
  const allZero = (arr: number[]) => arr.every((b) => b === 0);
  const isQuerySentinel14 = payload.length === 2 && payload[0] === 0x7f && payload[1] === 0x7f;
  const isQuerySentinel7 = payload.length === 1 && payload[0] === 0x7f;

  // Broadcast identify: F0 00 01 74 7F 00 7A F7 (gen-3 editor handshake).
  if (model === 0x7f && fn === 0x00 && payload.length === 0) return;

  const cls = classOfModel(model);
  if (cls === undefined) throw new SafetyViolation(`unknown model byte 0x${model.toString(16)}`);

  // Cross-family no-payload queries (firmware, sysinfo, status snapshot).
  if ((fn === 0x08 || fn === 0x47 || fn === 0x13) && payload.length === 0) return;

  // Query-sentinel reads. A non-sentinel payload on these would be a SET
  // (scene switch, tempo set), so the sentinel is REQUIRED here.
  if (fn === 0x0c && isQuerySentinel7) return;                       // scene number GET
  if (fn === 0x0d && isQuerySentinel14) return;                      // patch name, current
  if (fn === 0x0e && isQuerySentinel7) return;                       // scene name, current
  if (fn === 0x14 && cls !== 'axefx2' && isQuerySentinel14) return;  // tempo GET (gen3/am4)

  if (cls === 'axefx2') {
    if (fn === 0x14 && payload.length === 0) return;                 // preset number GET
    if (fn === 0x0f && payload.length === 0) return;                 // preset name GET
    if (fn === 0x20 && payload.length === 0) return;                 // grid layout GET
    if (fn === 0x0e && payload.length === 0) return;                 // query states
    if (fn === 0x29 && isQuerySentinel7) return;                     // scene GET
    if (fn === 0x1f && payload.length === 2) return;                 // get-all-params
    if (fn === 0x16 && payload.length === 4) return;                 // get-param-info
    if (fn === 0x28 && payload.length === 4) return;                 // get-param-strings
  }

  if (cls === 'am4') {
    if (fn === 0x1f && payload.length === 2 && decode14(payload[0], payload[1]) !== 0) return;
    if (fn === 0x28 && payload.length === 4) return;                 // transfer-candidate query
    // Active-buffer dump request: exactly 7F 7F 00 (read-only, no mutation).
    if (fn === 0x03 && payload.length === 3
      && payload[0] === 0x7f && payload[1] === 0x7f && payload[2] === 0x00) return;
    // fn=0x01 is the AM4 param R/W dispatcher: ONLY the READ_PRESET_NAME
    // shape may pass (pidLow 0x00CE, pidHigh 0x000B, action 0x0012).
    if (fn === 0x01 && payload.length >= 10
      && payload[0] === 0x4e && payload[1] === 0x01    // pidLow 0x00CE
      && payload[2] === 0x0b && payload[3] === 0x00    // pidHigh 0x000B
      && payload[4] === 0x12 && payload[5] === 0x00    // action 0x0012 READ
    ) return;
  }

  if (cls === 'gen3') {
    if (fn === 0x1f && payload.length === 2) return;                 // block bulk-read poll
    if (fn === 0x01) {
      const sub = payload[0];
      if (!GEN3_READ_SUBS.has(sub)) {
        throw new SafetyViolation(`gen-3 fn=0x01 sub=0x${sub.toString(16)} is not a whitelisted read`);
      }
      // Value region (payload bytes 6 and beyond) must be all zeros: the
      // address slots at 2..5 (effectId + paramId/cursor) are the only
      // variable fields a read query carries.
      if (!allZero(payload.slice(6))) {
        throw new SafetyViolation('gen-3 fn=0x01 read query carries a nonzero value region');
      }
      return;
    }
    // Experimental dictionary-dump requests: read-requests with zero payload.
    if ((fn === 0x40 || fn === 0x1a) && payload.length <= 2 && allZero(payload)) return;
  }

  throw new SafetyViolation(
    `frame not on the read-only whitelist: model=0x${model.toString(16)} fn=0x${fn.toString(16)} (${toHex(bytes)})`,
  );
}

// ── run log (stderr + incremental file, both unbuffered) ────────────

/**
 * Progress logger. Writes to stderr (never stdout: stdout can be piped
 * into a full-buffered sink and show nothing for a whole run) and appends
 * every line synchronously to a .log file next to the output JSON, so a
 * killed or stalled run is diagnosable from disk.
 */
class RunLog {
  private readonly t0 = Date.now();
  private txCount = 0;

  constructor(private logPath: string, readonly verbose: boolean) {
    writeFileSync(this.logPath, `# harvest run log, started ${new Date().toISOString()}\n`);
  }

  get file(): string { return this.logPath; }

  /** Rename the log once the model (and so the final output name) is known. */
  moveTo(newPath: string): void {
    if (path.resolve(newPath) === path.resolve(this.logPath)) return;
    try {
      renameSync(this.logPath, newPath);
      this.logPath = newPath;
    } catch { /* keep logging to the provisional path */ }
  }

  private stamp(msg: string): string {
    return `[+${((Date.now() - this.t0) / 1000).toFixed(1)}s] ${msg}`;
  }

  private toFile(line: string): void {
    try { appendFileSync(this.logPath, `${line}\n`); } catch { /* disk full etc.; stderr still works */ }
  }

  /** Surface-level progress and warnings: stderr + file, always. */
  info(msg: string): void {
    const line = this.stamp(msg);
    process.stderr.write(`${line}\n`);
    this.toFile(line);
  }

  /** Per-transaction line: file always; stderr every 10th (every one with --verbose). */
  tx(msg: string): void {
    this.txCount++;
    const line = this.stamp(msg);
    this.toFile(line);
    if (this.verbose || this.txCount % 10 === 0) process.stderr.write(`${line}\n`);
  }

  /** Per-frame detail: only with --verbose, stderr + file. */
  frame(msg: string): void {
    if (!this.verbose) return;
    const line = this.stamp(`    ${msg}`);
    process.stderr.write(`${line}\n`);
    this.toFile(line);
  }
}

// ── transcript / output shapes ──────────────────────────────────────

interface ResponseRecord {
  at_ms: number;
  len: number;
  hex: string;
}

interface Transaction {
  surface: string;
  description: string;
  request_hex: string;
  sent_at_ms: number;
  responses: ResponseRecord[];
  status: 'answered' | 'nack' | 'timeout' | 'skipped';
  decoded?: unknown;
  note?: string;
  /** On a circuit-breaker record: how many requests were suppressed. */
  skipped_count?: number;
}

interface HarvestFile {
  meta: {
    script: string;
    generated: string;
    platform: string;
    port_in: string;
    port_out: string;
    device_class: DeviceClass | 'unknown';
    model_byte: string;
    model_name: string;
    experimental: boolean;
    duration_ms: number;
    read_only: true;
    completed: boolean;
    aborted_reason?: string;
    log_file: string;
    limits: {
      tx_timeout_ms_default: number;
      pace_ms: number;
      settle_every: number;
      settle_ms: number;
      breaker_consecutive_timeouts: number;
      watchdog_ms: number;
      max_minutes: number;
    };
  };
  identity: {
    firmware_response_hex?: string;
    firmware_ascii?: string[];
    sysinfo_response_hex?: string;
  };
  transactions: Transaction[];
  summary: {
    surfaces_answered: number;
    surfaces_timed_out: number;
    surfaces_skipped: number;
    total_response_frames: number;
    total_response_bytes: number;
  };
}

// ── MIDI session ────────────────────────────────────────────────────

interface Session {
  send: (bytes: number[]) => void;
  onMessage: (h: (bytes: number[]) => void) => () => void;
  close: () => void;
  portInName: string;
  portOutName: string;
}

function listPorts(): { inputs: string[]; outputs: string[] } {
  const i = new midi.Input();
  const o = new midi.Output();
  const inputs = Array.from({ length: i.getPortCount() }, (_, k) => i.getPortName(k));
  const outputs = Array.from({ length: o.getPortCount() }, (_, k) => o.getPortName(k));
  try { i.closePort(); } catch { /* never opened */ }
  try { o.closePort(); } catch { /* never opened */ }
  return { inputs, outputs };
}

const FRACTAL_NEEDLES = ['am4', 'vp4', 'fm3', 'fm9', 'axe-fx', 'axefx', 'fractal'];

function pickPort(names: string[], wanted?: string): number {
  if (wanted !== undefined) {
    const lower = wanted.toLowerCase();
    const idx = names.findIndex((n) => n.toLowerCase().includes(lower));
    return idx;
  }
  const hits = names
    .map((n, i) => ({ n: n.toLowerCase(), i }))
    .filter(({ n }) => FRACTAL_NEEDLES.some((needle) => n.includes(needle)));
  if (hits.length === 1) return hits[0].i;
  return -1;
}

function openSession(portArg?: string): Session {
  const { inputs, outputs } = listPorts();
  if (outputs.length === 0) {
    fail('No MIDI output ports visible. Is the device powered on and the USB cable connected? '
      + 'On Windows, the Fractal USB driver must be installed.');
  }
  const outIdx = pickPort(outputs, portArg);
  const inIdx = pickPort(inputs, portArg);
  if (outIdx < 0 || inIdx < 0) {
    const fmt = (arr: string[]) => arr.length === 0 ? '  (none)' : arr.map((n, i) => `  [${i}] ${n}`).join('\n');
    fail(
      (portArg !== undefined
        ? `No MIDI port matching "${portArg}" found in both directions.`
        : 'Could not auto-pick a Fractal port (none matched, or more than one did).')
      + `\n\nVisible inputs:\n${fmt(inputs)}\nVisible outputs:\n${fmt(outputs)}`
      + '\n\nRe-run with --port <name fragment>, e.g. --port FM9. '
      + 'Close the Fractal editor first if it is running (it holds the USB port).',
    );
  }

  const output = new midi.Output();
  output.openPort(outIdx);
  const input = new midi.Input();
  const handlers = new Set<(bytes: number[]) => void>();
  input.ignoreTypes(false, true, true);
  input.on('message', (_dt: number, bytes: number[]) => {
    for (const h of handlers) {
      try { h(bytes); } catch { /* one bad subscriber must not break others */ }
    }
  });
  input.openPort(inIdx);

  return {
    send: (bytes) => {
      assertReadOnly(bytes);     // the absolute gate, every frame, no exceptions
      output.sendMessage(bytes);
    },
    onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); },
    close: () => {
      handlers.clear();
      try { output.closePort(); } catch { /* already closed */ }
      try { input.closePort(); } catch { /* already closed */ }
    },
    portInName: inputs[inIdx],
    portOutName: outputs[outIdx],
  };
}

/** No-MIDI fake session for --mock-silent self-tests: drops every frame. */
function mockSession(): Session {
  return {
    send: (bytes) => { assertReadOnly(bytes); },
    onMessage: () => () => { /* nothing ever arrives */ },
    close: () => { /* nothing to close */ },
    portInName: '(mock-silent)',
    portOutName: '(mock-silent)',
  };
}

function fail(message: string): never {
  process.stderr.write(`\n${message}\n\n`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── run control (abort plumbing) ────────────────────────────────────

class RunAborted extends Error {
  constructor(readonly reason: string) { super(reason); }
}

interface RunControl {
  /** Set by SIGINT, the watchdog, or the runtime cap; transact throws on it. */
  abortReason?: string;
  /** Updated whenever a transaction completes (answer, nack, OR timeout). */
  lastDoneAt: number;
  /** Wall-clock deadline from --max-minutes. */
  deadlineAt: number;
  maxMinutes: number;
}

// ── harvest engine ──────────────────────────────────────────────────

interface TransactOpts {
  quietMs?: number;
  /** Hard cap for the whole transaction. Defaults to TX_TIMEOUT_MS,
   *  clamped to TX_ABSOLUTE_MAX_MS. */
  maxMs?: number;
  /** How long to wait for the FIRST frame before recording timeout. */
  firstMs?: number;
  /** Exempt this transaction from the circuit breaker (use for surfaces
   *  where silence is an expected, useful result: sparse probes). */
  noBreaker?: boolean;
  /** Breaker scope key; defaults to the surface name. Per-block sweeps
   *  pass `surface:eid` so one dead block does not skip its siblings. */
  breakerKey?: string;
  /** Per-key breaker threshold override (sparse sweeps tolerate longer
   *  silent gaps). */
  breakerAfter?: number;
}

class Harvester {
  readonly transactions: Transaction[] = [];
  private readonly t0 = Date.now();
  private lastSendAt = 0;
  private sendCount = 0;
  private readonly breakerCounts = new Map<string, number>();
  private readonly breakerRecords = new Map<string, Transaction>();

  constructor(
    private readonly session: Session,
    readonly log: RunLog,
    private readonly ctl: RunControl,
  ) {}

  now(): number { return Date.now() - this.t0; }

  private checkAbort(): void {
    if (this.ctl.abortReason === undefined && Date.now() > this.ctl.deadlineAt) {
      this.ctl.abortReason = `max runtime reached (${this.ctl.maxMinutes} min); writing partial results`;
    }
    if (this.ctl.abortReason !== undefined) throw new RunAborted(this.ctl.abortReason);
  }

  /**
   * Send one request and collect inbound SysEx until the stream has been
   * quiet for `quietMs`, the hard cap `maxMs` passes, or `firstMs` passes
   * with no frame at all (status=timeout). Multi-frame dumps (0x74/75/76
   * bursts, fn=0x28 chunks, 0x67/68/69 families) all collect correctly
   * with the quiet-window collector; every path is bounded.
   */
  async transact(
    surface: string,
    description: string,
    request: number[],
    opts: TransactOpts = {},
  ): Promise<Transaction> {
    const breakerKey = opts.breakerKey ?? surface;

    // Circuit breaker: once a key trips, suppress the rest of that surface
    // (no wire traffic, no per-request grind) and count what was skipped.
    const trippedRec = this.breakerRecords.get(breakerKey);
    if (trippedRec !== undefined) {
      trippedRec.skipped_count = (trippedRec.skipped_count ?? 0) + 1;
      this.ctl.lastDoneAt = Date.now();
      return {
        surface,
        description,
        request_hex: toHex(request),
        sent_at_ms: this.now(),
        responses: [],
        status: 'skipped',
        note: `suppressed by circuit breaker on "${breakerKey}"`,
      };
    }

    this.checkAbort();

    // Pacing: never send two frames closer than PACE_MS apart, and give
    // the device a settle pause every SETTLE_EVERY sends. This keeps the
    // front panel responsive AND keeps the WinMM output queue drained so
    // the synchronous native send cannot wedge the event loop.
    const gap = PACE_MS - (Date.now() - this.lastSendAt);
    if (gap > 0) await sleep(gap);
    if (this.sendCount > 0 && this.sendCount % SETTLE_EVERY === 0) {
      this.log.frame(`settle pause ${SETTLE_MS} ms after ${this.sendCount} sends`);
      await sleep(SETTLE_MS);
    }
    this.checkAbort();

    const maxMs = Math.min(opts.maxMs ?? TX_TIMEOUT_MS, TX_ABSOLUTE_MAX_MS);
    const firstMs = Math.min(opts.firstMs ?? 350, maxMs);
    const quietMs = opts.quietMs ?? 120;
    const responses: ResponseRecord[] = [];
    const frames: number[][] = [];
    const requestHex = toHex(request);
    let lastAt = 0;
    const unsub = this.session.onMessage((bytes) => {
      if (bytes[0] !== 0xf0) return;
      // Drop byte-exact echoes of our own request: real devices never
      // echo verbatim, but loopback ports (loopMIDI / LoopBe) do, and a
      // self-echo must not read as a device answer.
      if (toHex(bytes) === requestHex) return;
      lastAt = Date.now();
      responses.push({ at_ms: this.now(), len: bytes.length, hex: toHex(bytes) });
      frames.push([...bytes]);
      this.log.frame(`<- ${bytes.length} B: ${toHex(bytes.slice(0, 24))}${bytes.length > 24 ? ' ...' : ''}`);
    });
    const sentAt = this.now();
    const sendStart = Date.now();
    this.session.send(request);
    this.lastSendAt = Date.now();
    this.sendCount++;
    const sendDur = this.lastSendAt - sendStart;
    if (sendDur > 250) {
      this.log.info(`WARNING: native sendMessage took ${sendDur} ms (driver queue backing up?)`);
    }
    const start = Date.now();
    // Wait for a first frame, then for the quiet window. Bounded by maxMs.
    for (;;) {
      await sleep(20);
      if (this.ctl.abortReason !== undefined) break;
      const t = Date.now();
      if (t - start > maxMs) break;
      if (responses.length === 0) {
        if (t - start > firstMs) break;
      } else if (t - lastAt > quietMs) break;
    }
    unsub();
    const nack = frames.find((f) => f[3] === 0x74 && f[5] === 0x64);
    const tx: Transaction = {
      surface,
      description,
      request_hex: requestHex,
      sent_at_ms: sentAt,
      responses,
      status: responses.length === 0 ? 'timeout' : (nack !== undefined && frames.length === 1 ? 'nack' : 'answered'),
    };
    if (nack !== undefined && frames.length === 1) {
      tx.decoded = { multipurpose_response: { echoed_fn: nack[6], result_code: nack[7] } };
    }
    this.transactions.push(tx);
    this.ctl.lastDoneAt = Date.now();

    const bytes = responses.reduce((a, r) => a + r.len, 0);
    this.log.tx(`${surface} -> ${tx.status} (${responses.length} frames, ${bytes} B, ${Date.now() - start} ms) ${description.slice(0, 70)}`);

    // Breaker bookkeeping.
    if (opts.noBreaker !== true) {
      if (tx.status === 'timeout') {
        const n = (this.breakerCounts.get(breakerKey) ?? 0) + 1;
        this.breakerCounts.set(breakerKey, n);
        const threshold = opts.breakerAfter ?? BREAKER_THRESHOLD;
        if (n >= threshold) {
          const rec: Transaction = {
            surface,
            description: `circuit breaker tripped on "${breakerKey}": ${threshold} consecutive timeouts; the remaining requests on this surface are skipped (skipped_count below)`,
            request_hex: '',
            sent_at_ms: this.now(),
            responses: [],
            status: 'skipped',
            skipped_count: 0,
            note: 'breaker record: counts suppressed requests, no wire traffic occurred for them',
          };
          this.transactions.push(rec);
          this.breakerRecords.set(breakerKey, rec);
          this.log.info(`CIRCUIT BREAKER: ${threshold} consecutive timeouts on "${breakerKey}"; skipping the rest of this surface`);
        }
      } else {
        this.breakerCounts.set(breakerKey, 0);
      }
    }
    return tx;
  }

  lastFrames(tx: Transaction): number[][] {
    return tx.responses.map((r) => r.hex.split(' ').map((h) => parseInt(h, 16)));
  }
}

// ── device detection ────────────────────────────────────────────────

async function detectModel(h: Harvester, candidates: number[]): Promise<number | undefined> {
  for (const m of candidates) {
    const tx = await h.transact(
      'detect',
      `fn=0x08 firmware-version probe, model 0x${m.toString(16)}`,
      frame(m, 0x08),
      { firstMs: 450, maxMs: 900, noBreaker: true },
    );
    const hit = h.lastFrames(tx).find((f) => f[3] === 0x74 && f[4] === m);
    if (hit !== undefined) return m;
  }
  return undefined;
}

// ── per-device sweeps ───────────────────────────────────────────────

async function harvestAm4(h: Harvester): Promise<void> {
  const M = 0x15;
  const log = h.log;
  log.info('AM4 sweep: est. 45-90 seconds.');

  log.info('[1/6] identity: fn=0x08 firmware, fn=0x47 device info');
  await h.transact('am4_firmware', 'fn=0x08 GET_FIRMWARE_VERSION', frame(M, 0x08));
  await h.transact('am4_sysinfo', 'fn=0x47 device info / capability (AM4-Edit handshake query)', frame(M, 0x47));

  log.info('[2/6] state queries: preset number, names, scene, status');
  await h.transact('am4_preset_number', 'fn=0x14 query (sentinel 7F 7F)', frame(M, 0x14, [0x7f, 0x7f]));
  await h.transact('am4_patch_name', 'fn=0x0D QUERY_PATCH_NAME (current)', frame(M, 0x0d, [0x7f, 0x7f]));
  await h.transact('am4_scene_name', 'fn=0x0E QUERY_SCENE_NAME (current)', frame(M, 0x0e, [0x7f]));
  await h.transact('am4_scene', 'fn=0x0C scene query (sentinel 7F)', frame(M, 0x0c, [0x7f]));
  await h.transact('am4_status_dump', 'fn=0x13 STATUS_DUMP', frame(M, 0x13));

  log.info('[3/6] fn=0x03 active working-buffer dump (~12 KB)');
  const dump = await h.transact(
    'am4_active_buffer_dump',
    'fn=0x03 active-buffer dump request (7F 7F 00), response is 0x77/0x78/0x79 chain',
    buildRequestActiveBufferDump(),
    { quietMs: 400, maxMs: 8000 },
  );
  log.info(`        ${dump.responses.length} frames`);

  log.info('[4/6] fn=0x1F GET_ALL_PARAMS effectId sweep 1..255 (~60 s; silence per id is normal)');
  const answering: number[] = [];
  for (let eid = 1; eid <= 255; eid++) {
    const tx = await h.transact(
      'am4_fn1f_sweep',
      `fn=0x1F GET_ALL_PARAMS effectId=${eid}`,
      buildGetAllParamsAm4(eid),
      // Sparse sweep: most ids are silent on a healthy device, so the
      // breaker threshold is widened instead of disabled. 120 consecutive
      // silences still means the device is gone (or this sweep is over).
      { firstMs: 220, quietMs: 60, maxMs: 800, breakerAfter: 120 },
    );
    const head = h.lastFrames(tx).find((f) => f[5] === 0x74);
    if (head !== undefined) {
      answering.push(eid);
      tx.decoded = { effect_id: eid, item_count: decode14(head[8], head[9]) };
    }
    if (eid % 32 === 0) log.info(`        ...effectId ${eid}, ${answering.length} blocks answered so far`);
  }
  log.info(`        ${answering.length} effectIds answered: ${answering.join(', ')}`);

  log.info('[5/6] fn=0x28 enum-dump transfer-candidate probes (II primitive, AM4 unverified)');
  const probeEids = answering.slice(0, 3);
  if (probeEids.length === 0) probeEids.push(106);
  for (const eid of probeEids) {
    for (let pid = 0; pid <= 3; pid++) {
      const tx = await h.transact(
        'am4_fn28_transfer_candidate',
        `fn=0x28 GET_PARAM_STRINGS effectId=${eid} paramId=${pid} (transfer candidate from Axe-Fx II; NACK or silence is a useful result)`,
        frame(M, 0x28, [...encode14(eid), ...encode14(pid)]),
        { firstMs: 300, quietMs: 150, maxMs: 1500, noBreaker: true },
      );
      tx.note = 'transfer-candidate: fn=0x28 is hardware-verified on Axe-Fx II only';
    }
  }

  log.info('[6/6] preset-name sweep, locations A01..Z04 (104 reads)');
  for (let loc = 0; loc < 104; loc++) {
    const tx = await h.transact(
      'am4_preset_names',
      `fn=0x01 READ_PRESET_NAME location ${formatLocationCode(loc)}`,
      buildGetPresetNameAm4(loc),
      { firstMs: 200, quietMs: 40, maxMs: 600 },
    );
    const f = h.lastFrames(tx)[0];
    if (f !== undefined) tx.decoded = { location: formatLocationCode(loc), ascii: asciiRuns(f) };
    if ((loc + 1) % 26 === 0) log.info(`        ...${formatLocationCode(loc)}`);
  }

  log.info('AM4 sweep complete');
}

async function harvestAxeFx2(h: Harvester, model: number): Promise<void> {
  const opts = { modelId: model };
  const log = h.log;
  log.info('Axe-Fx II sweep: param-info + enum dumps scale with placed blocks; est. 1-3 minutes.');

  log.info('[1/7] identity: fn=0x08 firmware, fn=0x47 sysinfo');
  const fw = await h.transact('ii_firmware', 'fn=0x08 GET_FIRMWARE_VERSION', frame(model, 0x08));
  const fwf = h.lastFrames(fw)[0];
  if (fwf !== undefined) fw.decoded = { ascii: asciiRuns(fwf) };
  await h.transact('ii_sysinfo', 'fn=0x47 SYSEX_GET_SYSINFO (8-byte payload, semantics undecoded)', frame(model, 0x47));

  log.info('[2/7] state: preset number/name, scene');
  const pn = await h.transact('ii_preset_number', 'fn=0x14 GET_PRESET_NUMBER', buildGetPresetNumber(opts));
  const pnf = h.lastFrames(pn).find((f) => f[5] === 0x14 && f.length === 10);
  if (pnf !== undefined) pn.decoded = { preset_number_msb_first: ((pnf[6] & 0x7f) << 7) | (pnf[7] & 0x7f) };
  const nm = await h.transact('ii_preset_name', 'fn=0x0F GET_PRESET_NAME', buildGetPresetNameII(opts));
  const nmf = h.lastFrames(nm)[0];
  if (nmf !== undefined) nm.decoded = { ascii: asciiRuns(nmf) };
  await h.transact('ii_scene', 'fn=0x29 GET_SCENE_NUMBER (sentinel 7F)', buildGetSceneNumber(opts));

  log.info('[3/7] grid + block states: fn=0x20, fn=0x0E');
  const grid = await h.transact('ii_grid', 'fn=0x20 GET_GRID_LAYOUT_AND_ROUTING', buildGetGridLayout(opts));
  const placed: number[] = [];
  const gridFrame = h.lastFrames(grid).find((f) => f[5] === 0x20);
  if (gridFrame !== undefined) {
    for (let cell = 0; cell < 48; cell++) {
      const off = 6 + cell * 4;
      if (off + 3 >= gridFrame.length - 2) break;
      const id = decode14(gridFrame[off], gridFrame[off + 1]);
      if (id > 0 && id < 0x3fff && !placed.includes(id)) placed.push(id);
    }
    grid.decoded = { placed_effect_ids: placed };
  }
  await h.transact('ii_query_states', 'fn=0x0E SYSEX_QUERY_STATES (5-byte records, one per placed block)', buildQueryStates(opts));
  log.info(`        placed blocks: ${placed.join(', ') || '(none decoded)'}`);

  log.info('[4/7] fn=0x1F GET_ALL_PARAMS per placed block');
  const itemCounts = new Map<number, number>();
  for (const eid of placed) {
    const tx = await h.transact(
      'ii_fn1f_block_read',
      `fn=0x1F GET_ALL_PARAMS effectId=${eid}`,
      buildGetAllParamsII(eid, opts),
      { quietMs: 200, maxMs: 3000 },
    );
    const head = h.lastFrames(tx).find((f) => f[5] === 0x74);
    if (head !== undefined) {
      const count = decode14(head[8], head[9]);
      itemCounts.set(eid, count);
      tx.decoded = { effect_id: eid, item_count: count };
    }
  }

  log.info('[5/7] fn=0x16 GET_PARAM_INFO sweep per placed block');
  // Per-param descriptor: G0 default int, G1 min, G2/G3 range or enum
  // count, G4 step (0 for enums). Enum candidates feed the fn=0x28 sweep.
  const enumCandidates: Array<{ eid: number; pid: number; count: number }> = [];
  for (const eid of placed) {
    const n = Math.min(itemCounts.get(eid) ?? 64, 300);
    log.info(`        block ${eid}: paramIds 0..${n - 1}`);
    for (let pid = 0; pid < n; pid++) {
      const tx = await h.transact(
        'ii_fn16_param_info',
        `fn=0x16 GET_PARAM_INFO effectId=${eid} paramId=${pid}`,
        frame(model, 0x16, [...encode14(eid), ...encode14(pid)]),
        // Breaker is scoped per block: a dead tail (pid past the real
        // param count) or a wedged device skips THIS block after 10
        // consecutive silences instead of grinding all 300 paramIds.
        { firstMs: 200, quietMs: 30, maxMs: 500, breakerKey: `ii_fn16_param_info:eid=${eid}` },
      );
      const f = h.lastFrames(tx).find((x) => x[5] === 0x16);
      if (f !== undefined && f.length >= 33) {
        const group = (off: number) => {
          let v = 0;
          for (let i = 0; i < 5; i++) v |= (f[6 + off + i] & 0x7f) << (7 * i);
          return v >>> 0;
        };
        const asFloat = (u32: number) => {
          const buf = new DataView(new ArrayBuffer(4));
          buf.setUint32(0, u32, true);
          return buf.getFloat32(0, true);
        };
        const g0 = group(0);
        const g1 = asFloat(group(5));
        const g2 = asFloat(group(10));
        const g3 = asFloat(group(15));
        const g4 = asFloat(group(20));
        tx.decoded = { effect_id: eid, param_id: pid, default: g0, min: g1, g2, g3, step: g4 };
        if (g4 === 0 && Number.isInteger(g2) && g2 >= 2 && g2 <= 1500) {
          enumCandidates.push({ eid, pid, count: g2 });
        }
      }
    }
  }

  log.info(`[6/7] fn=0x28 GET_PARAM_STRINGS enum dumps (${enumCandidates.length} candidates)`);
  for (const { eid, pid, count } of enumCandidates) {
    const tx = await h.transact(
      'ii_fn28_enum_dump',
      `fn=0x28 GET_PARAM_STRINGS effectId=${eid} paramId=${pid} (expected ~${count} labels)`,
      frame(model, 0x28, [...encode14(eid), ...encode14(pid)]),
      { quietMs: 350, maxMs: 6000 },
    );
    const payload: number[] = [];
    for (const f of h.lastFrames(tx)) {
      if (f[5] !== 0x28) continue;
      const end = f[f.length - 1] === 0xf7 ? f.length - 2 : f.length;
      for (let i = 6; i < end; i++) payload.push(f[i]);
    }
    if (payload.length > 0) {
      const labels: string[] = [];
      let cur: number[] = [];
      for (const b of payload) {
        if (b === 0x00) { labels.push(String.fromCharCode(...cur)); cur = []; }
        else cur.push(b);
      }
      tx.decoded = { effect_id: eid, param_id: pid, labels };
    }
  }

  log.info('[7/7] Axe-Fx II sweep complete');
}

async function harvestGen3(h: Harvester, model: number): Promise<void> {
  const log = h.log;
  log.info(`gen-3 sweep (model 0x${model.toString(16)}): est. 1-2 minutes.`);

  log.info('[1/9] identity: broadcast identify, fn=0x08 firmware, fn=0x47 init/sysinfo');
  await h.transact('gen3_identify', 'fn=0x00 broadcast identify (model 0x7F, editor handshake)', frame(0x7f, 0x00));
  const fw = await h.transact('gen3_firmware', 'fn=0x08 firmware / WHO_AM_I', frame(model, 0x08));
  const fwf = h.lastFrames(fw)[0];
  if (fwf !== undefined) fw.decoded = { ascii: asciiRuns(fwf) };
  await h.transact('gen3_sysinfo', 'fn=0x47 init / sysinfo (editor handshake)', frame(model, 0x47));

  log.info('[2/9] state: tempo, patch name, scene name, scene number');
  await h.transact('gen3_tempo', 'fn=0x14 GET_TEMPO (sentinel 7F 7F)', buildGetTempo(model));
  const nm = await h.transact('gen3_patch_name', 'fn=0x0D QUERY_PATCH_NAME (current)', buildQueryPatchName('current', model));
  const nmf = h.lastFrames(nm)[0];
  if (nmf !== undefined) nm.decoded = { ascii: asciiRuns(nmf) };
  await h.transact('gen3_scene_name', 'fn=0x0E QUERY_SCENE_NAME (current)', frame(model, 0x0e, [0x7f]));
  await h.transact('gen3_scene', 'fn=0x0C GET_SCENE_NUMBER (sentinel 7F)', buildGetScene(model));

  log.info('[3/9] fn=0x13 STATUS_DUMP (placed-block snapshot)');
  const status = await h.transact('gen3_status_dump', 'fn=0x13 STATUS_DUMP, response is id/id/state triples', buildStatusDump(model), { quietMs: 250, maxMs: 3000 });
  const placedFromStatus: number[] = [];
  const stf = h.lastFrames(status).find((f) => f[5] === 0x13);
  if (stf !== undefined) {
    for (let i = 6; i + 2 < stf.length - 2; i += 3) {
      const id = decode14(stf[i], stf[i + 1]);
      if (id > 0) placedFromStatus.push(id);
    }
    status.decoded = { placed_effect_ids: placedFromStatus };
  }

  log.info('[4/9] fn=0x01 sub=0x2e whole-preset layout map');
  const layout = await h.transact(
    'gen3_sub2e_layout',
    'fn=0x01 sub=0x2e layout map query (byte-exact editor shape, zero address)',
    gen3ReadQuery(model, 0x2e, 0),
    { quietMs: 250, maxMs: 3000 },
  );
  const lf = h.lastFrames(layout).find((f) => f[5] === 0x01);
  if (lf !== undefined) layout.decoded = { septet_unpacked_ascii: asciiRuns(gen3SeptetUnpack(lf)) };

  log.info('[5/9] sub=0x7b placed-flag sweep across the block roster');
  const rosterIds = AXE_FX_III_BLOCKS
    .filter((b) => b.firstId !== null)
    .flatMap((b) => Array.from({ length: b.instances }, (_, k) => (b.firstId as number) + k));
  const candidateIds = [...new Set([...placedFromStatus, ...rosterIds])].sort((a, b) => a - b);
  const placed: number[] = [];
  let swept = 0;
  for (const eid of candidateIds) {
    const tx = await h.transact(
      'gen3_sub7b_placed_flag',
      `fn=0x01 sub=0x7b placed-flag effectId=${eid}`,
      gen3ReadQuery(model, 0x7b, eid),
      // Widened breaker: unknown ids may be silent on some firmware, but
      // 40 consecutive silences means the device stopped talking.
      { firstMs: 220, quietMs: 30, maxMs: 500, breakerAfter: 40 },
    );
    const f = h.lastFrames(tx).find((x) => x[5] === 0x01 && x[6] === 0x7b);
    if (f !== undefined && f.length >= 14) {
      const flag = decode14(f[12], f[13]);
      tx.decoded = { effect_id: eid, placed: flag !== 0 };
      if (flag !== 0) placed.push(eid);
    }
    swept++;
    if (swept % 40 === 0) log.info(`        ...${swept}/${candidateIds.length} ids, ${placed.length} placed`);
  }
  log.info(`        placed: ${placed.join(', ') || '(none flagged)'}`);
  const effectiveBlocks = placed.length > 0 ? placed : placedFromStatus;

  log.info('[6/9] sub=0x01 block descriptors + fn=0x1F bulk reads for placed blocks');
  for (const eid of effectiveBlocks) {
    await h.transact(
      'gen3_sub01_descriptor',
      `fn=0x01 sub=0x01 block descriptor effectId=${eid}`,
      gen3ReadQuery(model, 0x01, eid),
      { quietMs: 150, maxMs: 1500 },
    );
    const bulk = await h.transact(
      'gen3_fn1f_bulk_read',
      `fn=0x1F block bulk-read poll effectId=${eid}, reply is the 0x74/0x75/0x76 burst`,
      buildBlockBulkReadPoll(eid, model),
      { quietMs: 300, maxMs: 5000 },
    );
    const head = h.lastFrames(bulk).find((f) => f[5] === 0x74);
    if (head !== undefined) {
      bulk.decoded = { effect_id: eid, item_count: decode14(head[8], head[9]) };
    }
  }

  log.info('[7/9] sub=0x1a param-info reads (current-value labels) for placed blocks');
  for (const eid of effectiveBlocks) {
    for (let pid = 0; pid <= 40; pid++) {
      const tx = await h.transact(
        'gen3_sub1a_param_info',
        `fn=0x01 sub=0x1a get-parameter-info effectId=${eid} paramId=${pid}`,
        gen3ReadQuery(model, 0x1a, eid, pid),
        { firstMs: 200, quietMs: 30, maxMs: 500, breakerKey: `gen3_sub1a_param_info:eid=${eid}` },
      );
      const f = h.lastFrames(tx).find((x) => x[5] === 0x01 && x[6] === 0x1a);
      if (f !== undefined) {
        tx.decoded = {
          effect_id: eid,
          param_id: pid,
          septet_unpacked_ascii: asciiRuns(gen3SeptetUnpack(f)),
        };
      }
    }
    log.info(`        block ${eid} done`);
  }

  log.info('[8/9] sub=0x2a directory entries + sub=0x1f label stream (bounded walk)');
  for (let idx = 0; idx <= 15; idx++) {
    await h.transact(
      'gen3_sub2a_directory',
      `fn=0x01 sub=0x2a directory/browser entry index=${idx}`,
      gen3ReadQuery(model, 0x2a, idx),
      { firstMs: 200, quietMs: 30, maxMs: 500, noBreaker: true },
    );
  }
  await gen3LabelStreamWalk(h, model, 0, 'effectId=0 (global)');
  if (effectiveBlocks.length > 0) {
    await gen3LabelStreamWalk(h, model, effectiveBlocks[0], `effectId=${effectiveBlocks[0]} (first placed block)`);
  }

  log.info('[9/9] gen-3 sweep complete');
}

/**
 * Bounded sub=0x1f label-stream walk. The editor's "Query All Param
 * Definitions" runs a cursor-paged stream on this sub-action (cursor at
 * bytes 10..11); the device-side advance rule is not fully decoded, so
 * this walk records raw frames under strict bounds: it repeats the query
 * (the captured stream returned the NEXT chunk for a repeated address),
 * bumps the cursor when the stream sticks, and stops on repeats, on
 * silence, or at the frame/time cap. Everything lands raw in the file.
 */
async function gen3LabelStreamWalk(h: Harvester, model: number, eid: number, label: string): Promise<void> {
  h.log.info(`        sub=0x1f stream walk, ${label} (bounded: 600 frames / 25 s)`);
  let cursor = 0;
  let silentInARow = 0;
  let stuckInARow = 0;
  let bumpedSinceProgress = false;
  let prevHex = '';
  const tStart = Date.now();
  for (let i = 0; i < 600; i++) {
    if (Date.now() - tStart > 25_000) break;
    const tx = await h.transact(
      'gen3_sub1f_label_stream',
      `fn=0x01 sub=0x1f label-stream ${label} cursor=${cursor}`,
      gen3ReadQuery(model, 0x1f, eid, cursor),
      // Self-bounding on 2 consecutive silences; the breaker is redundant.
      { firstMs: 250, quietMs: 30, maxMs: 600, noBreaker: true },
    );
    if (tx.responses.length === 0) {
      silentInARow++;
      if (silentInARow >= 2) break;
      continue;
    }
    silentInARow = 0;
    const hex = tx.responses[0].hex;
    const f = h.lastFrames(tx)[0];
    tx.decoded = { septet_unpacked_ascii: asciiRuns(gen3SeptetUnpack(f)) };
    if (hex === prevHex) {
      // Stream stuck on a repeated frame: bump the cursor once; if the
      // bump does not unstick it, the walk is over.
      stuckInARow++;
      if (stuckInARow >= 3) {
        if (bumpedSinceProgress) break;
        cursor++;
        bumpedSinceProgress = true;
        stuckInARow = 0;
      }
    } else {
      stuckInARow = 0;
      bumpedSinceProgress = false;
    }
    prevHex = hex;
  }
}

async function harvestGen3Experimental(h: Harvester, model: number): Promise<void> {
  const log = h.log;
  log.info('[experimental] fn=0x40 and fn=0x1a dictionary-dump requests');
  log.info('  These are read-only requests with unknown semantics, mined from the');
  log.info('  AxeEdit III inbound dispatcher (responses arrive as 0x67/0x68/0x69 or');
  log.info('  0x5a/0x5b/0x5c multi-frame families). Whatever returns is recorded raw.');
  const shapes: Array<{ fn: number; payload: number[]; tag: string }> = [
    { fn: 0x40, payload: [], tag: 'empty' },
    { fn: 0x40, payload: [0x00, 0x00], tag: 'two zero bytes' },
    { fn: 0x1a, payload: [], tag: 'empty' },
    { fn: 0x1a, payload: [0x00, 0x00], tag: 'two zero bytes' },
  ];
  for (const { fn, payload, tag } of shapes) {
    const tx = await h.transact(
      'gen3_experimental_dictionary_dump',
      `EXPERIMENTAL fn=0x${fn.toString(16)} request (${tag}); semantics unknown, read-request family`,
      frame(model, fn, payload),
      { quietMs: 600, maxMs: 15_000, firstMs: 1200, noBreaker: true },
    );
    tx.note = 'experimental / unvalidated: request shape is a hypothesis from the dispatcher mine; response semantics undecoded';
    log.info(`        fn=0x${fn.toString(16)} (${tag}): ${tx.responses.length} frames`);
  }
}

// ── CLI / main ──────────────────────────────────────────────────────

interface CliArgs {
  port?: string;
  device?: DeviceClass;
  experimental: boolean;
  out?: string;
  verbose: boolean;
  maxMinutes: number;
  assumeDetected: boolean;
  mockSilent: boolean;
  ignoreEditors: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    experimental: false,
    verbose: false,
    maxMinutes: DEFAULT_MAX_MINUTES,
    assumeDetected: false,
    mockSilent: false,
    ignoreEditors: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = argv[++i];
    else if (a === '--device') {
      const d = argv[++i];
      if (d !== 'am4' && d !== 'axefx2' && d !== 'gen3') {
        fail(`--device must be am4, axefx2, or gen3 (got "${d}")`);
      }
      args.device = d;
    } else if (a === '--experimental') args.experimental = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--max-minutes') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) fail(`--max-minutes must be a positive number (got "${argv[i]}")`);
      args.maxMinutes = v;
    } else if (a === '--assume-detected') args.assumeDetected = true;
    else if (a === '--mock-silent') { args.mockSilent = true; args.assumeDetected = true; }
    else if (a === '--ignore-editors') args.ignoreEditors = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npx tsx scripts/harvest-device-metadata.ts [--port <name>] [--device am4|axefx2|gen3]'
        + ' [--experimental] [--out <file>] [--verbose] [--max-minutes <n>] [--ignore-editors]\n'
        + 'Diagnostic: [--assume-detected] [--mock-silent] (see header comment)');
      process.exit(0);
    } else fail(`Unknown argument: ${a}`);
  }
  if (args.mockSilent && args.device === undefined) {
    fail('--mock-silent requires --device (there is no real device to detect)');
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Editor pre-flight: refuse to touch the wire while a Fractal editor is
  // running (editor-held port + our traffic = the WinMM wedge). Skipped for
  // --mock-silent (no MIDI is opened at all) and for --ignore-editors.
  if (!args.mockSilent) {
    guardAgainstRunningEditors(args.ignoreEditors ? ['--ignore-editors'] : []);
  }

  const date = new Date().toISOString().slice(0, 10);

  // Output + log paths. The log opens immediately (provisional name when
  // the model is not yet known) so even a pre-detection stall is on disk.
  let outPath = path.resolve(args.out ?? `harvest-run-${date}.json`);
  const logPathFor = (jsonPath: string) => jsonPath.replace(/\.json$/i, '') + '.log';
  const log = new RunLog(logPathFor(outPath), args.verbose);

  log.info('Fractal device metadata harvest (read-only)');
  log.info('This sweep sends only documented query frames and listens.');
  log.info('It never saves, never switches presets or scenes, never changes a value.');
  log.info(`Expect a 1-3 minute run (hard cap ${args.maxMinutes} min). Close the Fractal editor first (it holds the USB port).`);
  log.info('The device front panel may respond slowly during the sweep; that is normal and ends with the run.');

  const session = args.mockSilent ? mockSession() : openSession(args.port);
  log.info(`Port: out="${session.portOutName}" in="${session.portInName}"`);

  const ctl: RunControl = {
    lastDoneAt: Date.now(),
    deadlineAt: Date.now() + args.maxMinutes * 60_000,
    maxMinutes: args.maxMinutes,
  };
  const h = new Harvester(session, log, ctl);

  const tRun = Date.now();
  let detected: { model: number; cls: DeviceClass; modelName: string } | undefined;

  const writeOutput = (abortedReason: string | undefined): string => {
    const answered = h.transactions.filter((t) => t.status === 'answered' || t.status === 'nack').length;
    const timedOut = h.transactions.filter((t) => t.status === 'timeout').length;
    const skipped = h.transactions
      .filter((t) => t.status === 'skipped')
      .reduce((a, t) => a + 1 + (t.skipped_count ?? 0), 0);
    const totalFrames = h.transactions.reduce((a, t) => a + t.responses.length, 0);
    const totalBytes = h.transactions.reduce((a, t) => a + t.responses.reduce((x, r) => x + r.len, 0), 0);

    const fwTx = h.transactions.find((t) => t.surface.endsWith('_firmware') && t.responses.length > 0);
    const siTx = h.transactions.find((t) => t.surface.endsWith('_sysinfo') && t.responses.length > 0);

    const out: HarvestFile = {
      meta: {
        script: 'scripts/harvest-device-metadata.ts',
        generated: new Date().toISOString(),
        platform: `${process.platform} node ${process.version}`,
        port_in: session.portInName,
        port_out: session.portOutName,
        device_class: detected?.cls ?? 'unknown',
        model_byte: detected !== undefined ? `0x${detected.model.toString(16).padStart(2, '0')}` : 'unknown',
        model_name: detected?.modelName ?? 'unknown',
        experimental: args.experimental,
        duration_ms: Date.now() - tRun,
        read_only: true,
        completed: abortedReason === undefined,
        ...(abortedReason !== undefined ? { aborted_reason: abortedReason } : {}),
        log_file: path.basename(log.file),
        limits: {
          tx_timeout_ms_default: TX_TIMEOUT_MS,
          pace_ms: PACE_MS,
          settle_every: SETTLE_EVERY,
          settle_ms: SETTLE_MS,
          breaker_consecutive_timeouts: BREAKER_THRESHOLD,
          watchdog_ms: WATCHDOG_MS,
          max_minutes: args.maxMinutes,
        },
      },
      identity: {
        firmware_response_hex: fwTx?.responses[0]?.hex,
        firmware_ascii: fwTx?.responses[0] !== undefined
          ? asciiRuns(fwTx.responses[0].hex.split(' ').map((x) => parseInt(x, 16)))
          : undefined,
        sysinfo_response_hex: siTx?.responses[0]?.hex,
      },
      transactions: h.transactions,
      summary: {
        surfaces_answered: answered,
        surfaces_timed_out: timedOut,
        surfaces_skipped: skipped,
        total_response_frames: totalFrames,
        total_response_bytes: totalBytes,
      },
    };
    writeFileSync(outPath, JSON.stringify(out, null, 1));
    log.info(`${abortedReason === undefined ? 'Done' : 'PARTIAL RESULTS WRITTEN'} in ${Math.round((Date.now() - tRun) / 1000)} s.`);
    log.info(`  ${answered} request shapes answered, ${timedOut} timed out, ${skipped} skipped, ${totalFrames} response frames (${totalBytes} bytes).`);
    log.info(`Wrote: ${outPath}`);
    return outPath;
  };

  // Ctrl-C: stop sending, write whatever was collected, close, exit 130.
  // A second Ctrl-C force-quits immediately.
  let sigints = 0;
  process.on('SIGINT', () => {
    sigints++;
    if (sigints >= 2) process.exit(130);
    ctl.abortReason = 'SIGINT (Ctrl-C)';
    log.info('Ctrl-C: finishing the in-flight transaction, then writing partial output. Press Ctrl-C again to force-quit.');
  });

  // Global watchdog: if NO transaction completes (answered or timed out)
  // for WATCHDOG_MS, write partial output, close, exit 3. Note the honest
  // limit: this timer cannot fire while a native sendMessage call blocks
  // the event loop (RtMidi WinMM unprepare spin); the PACE_MS pacing and
  // the slow-send warning exist to keep that path from ever arming.
  const watchdog = setInterval(() => {
    if (Date.now() - ctl.lastDoneAt <= WATCHDOG_MS) return;
    log.info(`WATCHDOG: no transaction completed in ${WATCHDOG_MS / 1000} s; aborting and writing partial output.`);
    try { writeOutput(`watchdog: no transaction completed in ${WATCHDOG_MS / 1000} s`); } catch { /* best effort */ }
    try { session.close(); } catch { /* best effort */ }
    process.exit(3);
  }, 2000);
  watchdog.unref();

  let abortedReason: string | undefined;
  let unexpected: unknown;
  try {
    const candidates = args.device !== undefined
      ? CLASS_CANDIDATES[args.device]
      : [...CLASS_CANDIDATES.gen3, ...CLASS_CANDIDATES.am4, ...CLASS_CANDIDATES.axefx2];

    log.info('Detecting device (fn=0x08 firmware probe per candidate model byte)...');
    let model = await detectModel(h, candidates);
    if (model === undefined && args.assumeDetected && args.device !== undefined) {
      model = CLASS_CANDIDATES[args.device][0];
      log.info(`WARNING: no firmware answer; --assume-detected proceeding as model 0x${model.toString(16)} (${args.device}). Expect timeouts.`);
    }
    if (model === undefined) {
      session.close();
      fail('No Fractal device answered the firmware probe on this port.\n'
        + 'Check: device powered on, USB seated, Fractal editor fully closed.\n'
        + 'If the port is right but the device class is not, re-run with --device am4|axefx2|gen3.');
    }
    const cls = classOfModel(model) as DeviceClass;
    const modelName = MODEL_NAMES[model] ?? `model-0x${model.toString(16)}`;
    detected = { model, cls, modelName };
    log.info(`Detected: ${modelName} (model byte 0x${model.toString(16)}, class ${cls})`);

    // Final output name is known now; move the log alongside it.
    if (args.out === undefined) {
      outPath = path.resolve(`harvest-${modelName}-${date}.json`);
      log.moveTo(logPathFor(outPath));
    }

    if (cls === 'am4') await harvestAm4(h);
    else if (cls === 'axefx2') await harvestAxeFx2(h, model);
    else {
      await harvestGen3(h, model);
      if (args.experimental) await harvestGen3Experimental(h, model);
    }
  } catch (e) {
    if (e instanceof RunAborted) {
      abortedReason = e.reason;
    } else {
      abortedReason = `unhandled error: ${e instanceof Error ? e.message : String(e)}`;
      unexpected = e;
    }
  }

  // Write the file BEFORE closing the ports: closePort can also block in
  // a wedged driver, and collected data must not be hostage to it.
  const written = writeOutput(abortedReason);
  session.close();

  if (unexpected !== undefined) throw unexpected;
  if (abortedReason !== undefined) {
    log.info(`Run aborted: ${abortedReason}`);
    process.exit(abortedReason.startsWith('SIGINT') ? 130 : 2);
  }

  console.log(`\nWrote: ${written}`);
  console.log('Please send that one file back (GitHub issue, label community-beta, or the Reddit thread).');
  process.exit(0);
}

main().catch((e) => {
  if (e instanceof SafetyViolation) {
    process.stderr.write(`\nSAFETY GATE TRIPPED (nothing was sent): ${e.message}\n`);
  } else {
    process.stderr.write(`\nFAILED: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  process.exit(1);
});
