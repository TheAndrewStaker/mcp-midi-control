/**
 * AM4 action-byte discovery probe — READ-ONLY
 * ===========================================
 *
 * Session 104 (2026-05-20). Ghidra mining of AM4-Edit.exe recovered the
 * full 47-entry MESSAGE_* action-code table inside the 0x01 PARAM_RW
 * dispatcher. See `fractal-midi/docs/devices/am4/am4edit-action-table.md`
 * for the complete map. We currently use only 6 of those 47 actions in
 * the MCP codec. This probe tests the unused GET-style actions live on
 * hardware to confirm wire shape, response format, and the meaning of
 * each opcode.
 *
 * # What this script does
 *
 * For each unused GET-style action byte (0x0F, 0x10, 0x11, 0x19, 0x1A,
 * 0x1D, 0x1E, 0x1F, 0x20, 0x25, 0x26, 0x2B, 0x2C, 0x30, 0x31), the
 * script sends ONE OR MORE request frames varying:
 *
 *   - pidLow  (block target, 0 for "no target")
 *   - pidHigh (param target / category code)
 *   - hdr4    (payload byte count)
 *   - payload (4-byte u32 LE if needed — location index / scene index)
 *
 * It listens for inbound frames for ~1500 ms per request, prints the
 * raw bytes plus a brief shape analysis (length, hdr4 value, payload
 * length, any embedded ASCII string fragments). All response bytes
 * are also saved to a single .syx file for offline byte-level diff.
 *
 * # Safety profile
 *
 *   READ-ONLY. No writes to params, no preset switching, no save.
 *   Each request goes to either pidLow=0 (no specific target) or to a
 *   benign known address (AMP.GAIN, REVERB.MIX). The device may emit
 *   error/multipurpose acks for unsupported requests — that's expected
 *   and informative; do not interpret an error response as a problem.
 *
 * # Prereqs
 *
 *   - AM4 powered on, USB connected.
 *   - **Close AM4-Edit before running** — its polling will mix with the
 *     probe's inbound stream and pollute the response correlation.
 *   - No specific preset required, but Z04 with amp+drive+reverb+delay
 *     placed (the standard scratch layout from HW-064) gives the richest
 *     responses since several probes target real block addresses.
 *
 * # Run
 *
 *   npx tsx scripts/_research/probe-am4-action-reads.ts
 *
 * # Output
 *
 *   - stdout: per-probe summary, hex preview of every inbound frame,
 *     and a "FINDINGS" section at the end with a per-action verdict
 *     (responsive vs silent vs error).
 *   - samples/captured/probe-am4-action-reads.syx: raw byte stream of
 *     every (request, response) pair, in send order. Suitable for
 *     loading into a hex viewer or feeding into a follow-up parser.
 *   - samples/captured/probe-am4-action-reads-findings.md: a markdown
 *     summary auto-written at the end. Drop sections into
 *     `am4edit-action-table.md` once the wire shape per opcode is
 *     understood.
 *
 * # Interpretation guide
 *
 * For each probe, the inbound frames fall into one of these buckets:
 *
 *   1. **Echo only** — the AM4 echoes our request back via USB-MIDI
 *      driver loopback. 23-byte frame, byte-identical to the request.
 *      Means: device received the frame but didn't choose to respond.
 *      Either the action is invalid, OR the request needs different
 *      addressing.
 *
 *   2. **Multipurpose ack** — 18-byte frame with fn=0x64. Format:
 *      `F0 00 01 74 15 64 [echoed_fn] [result_code] [cs] F7`.
 *      Means: device received the frame and produced a structured
 *      ack. result_code 0x02 typically means "OK", 0x05 means
 *      "unsupported / rejected". See SYSEX-MAP.md §multipurpose-ack.
 *
 *   3. **Long-form descriptor** — 64-byte frame with hdr4=0x0028
 *      (40-byte payload). Same shape as bypass long-read.
 *      Means: action is valid AND the response carries structured
 *      data — needs payload decode.
 *
 *   4. **Variable-length payload** — frame with hdr4 != {0, 4, 0x28}.
 *      Means: action returns a different shape than the canonical
 *      param reads. Decode the hdr4 and payload bytes individually.
 *
 *   5. **Silent** — no inbound frames at all (after filtering echo).
 *      Means: device fully ignored the request. Likely wrong wire
 *      shape (e.g., wrong addressing) or unsupported action.
 *
 * Capture the bucket per action in the findings file. Each "responsive"
 * action becomes a follow-up codec implementation task in fractal-midi.
 */

import midi from 'midi';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { BLOCK_TYPE_VALUES } from 'fractal-midi/am4';

// ──────────────────────────────────────────────────────────────────
// Wire envelope helpers
// ──────────────────────────────────────────────────────────────────

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const AM4_MODEL = 0x15;
const FUNC_PARAM_RW = 0x01;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}

function encode14(n: number): [number, number] {
  if (n < 0 || n > 0x3fff) throw new Error(`14-bit value out of range: ${n}`);
  return [n & 0x7f, (n >> 7) & 0x7f];
}

/**
 * Build a 0x01 PARAM_RW envelope with an arbitrary action byte and
 * optional packed payload. Used to probe novel action codes that
 * don't have a dedicated builder in fractal-midi yet.
 */
function buildActionFrame(opts: {
  pidLow: number;
  pidHigh: number;
  action: number;
  hdr3?: number;
  payload?: number[]; // raw payload bytes (before 8-to-7 packing)
}): number[] {
  const { pidLow, pidHigh, action, hdr3 = 0x0000, payload = [] } = opts;
  const head = [
    SYSEX_START,
    ...FRACTAL_MFR,
    AM4_MODEL,
    FUNC_PARAM_RW,
    ...encode14(pidLow),
    ...encode14(pidHigh),
    ...encode14(action),
    ...encode14(hdr3),
    ...encode14(payload.length),
    ...packBytes(payload),
  ];
  const cs = fractalChecksum(head);
  return [...head, cs, SYSEX_END];
}

/**
 * 8-to-7 sliding-window pack used by AM4 0x01 envelopes. For N raw
 * bytes, outputs ceil((N*8 + 6) / 7) wire bytes. Identical to the
 * shared packValue util in fractal-midi but inlined here so the
 * probe is self-contained.
 */
function packBytes(raw: number[]): number[] {
  if (raw.length === 0) return [];
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const b of raw) {
    buf |= (b & 0xff) << bits;
    bits += 8;
    while (bits >= 7) {
      out.push(buf & 0x7f);
      buf >>= 7;
      bits -= 7;
    }
  }
  if (bits > 0) out.push(buf & 0x7f);
  return out;
}

function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

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
// Probe definitions
// ──────────────────────────────────────────────────────────────────

/**
 * Each probe describes one request frame to send. Multiple probes per
 * action are encouraged when the addressing convention is unknown —
 * cheaper to send all variants than to guess and miss the right one.
 */
interface ProbeDef {
  /** Display name including the action byte and addressing variant. */
  name: string;
  /** The Ghidra MESSAGE_* opcode this probe targets. */
  action: number;
  opcodeName: string;
  /** Optional hypothesis describing what we expect on success. */
  hypothesis: string;
  /** Frame bytes to send. */
  request: number[];
  /** Listen window in ms after sending. Longer for likely-bulky responses. */
  listenMs?: number;
}

const AMP_PID = BLOCK_TYPE_VALUES.amp;     // pidLow for amp block
const REVERB_PID = BLOCK_TYPE_VALUES.reverb;
const DELAY_PID = BLOCK_TYPE_VALUES.delay;
const DRIVE_PID = BLOCK_TYPE_VALUES.drive;

// Real param addresses for "valid target" probes.
// AMP.GAIN = pidLow=AMP, pidHigh=0x000B
const AMP_GAIN_PIDHIGH = 0x000b;
// REVERB.MIX = pidLow=REVERB, pidHigh=0x0001 (verify in your params.ts)
const REVERB_MIX_PIDHIGH = 0x0001;

// Preset-level address (used by rename, save, switch).
const PRESET_LEVEL_PIDLOW = 0x00ce;
const PRESET_LEVEL_PIDHIGH = 0x000b;

const PROBES: ProbeDef[] = [
  // ── 0x0F MESSAGE_GET_PARAM_INFO ────────────────────────────────
  // Hypothesis: returns a long-form param descriptor (range, units,
  // default, applicability) — like the AxeFx II 0x16 SYSEX_GET_PARAM_INFO.
  // Likely 64-byte response with hdr4=0x0028 carrying packed descriptor.
  {
    name: 'GET_PARAM_INFO @ AMP.GAIN',
    action: 0x0f, opcodeName: 'MESSAGE_GET_PARAM_INFO',
    hypothesis: 'long-form param descriptor (range/units/default) for AMP.GAIN',
    request: buildActionFrame({ pidLow: AMP_PID, pidHigh: AMP_GAIN_PIDHIGH, action: 0x0f }),
  },
  {
    name: 'GET_PARAM_INFO @ REVERB.MIX',
    action: 0x0f, opcodeName: 'MESSAGE_GET_PARAM_INFO',
    hypothesis: 'same as above for REVERB.MIX — checks per-param variability',
    request: buildActionFrame({ pidLow: REVERB_PID, pidHigh: REVERB_MIX_PIDHIGH, action: 0x0f }),
  },

  // ── 0x10 MESSAGE_GET_KNOBVALUE ─────────────────────────────────
  // Hypothesis: returns the front-panel knob position (UI-side state),
  // possibly distinct from the wire-level param value. Useful for
  // "is the user touching the knob right now" detection.
  {
    name: 'GET_KNOBVALUE @ AMP.GAIN',
    action: 0x10, opcodeName: 'MESSAGE_GET_KNOBVALUE',
    hypothesis: 'front-panel knob position; may equal or differ from wire value',
    request: buildActionFrame({ pidLow: AMP_PID, pidHigh: AMP_GAIN_PIDHIGH, action: 0x10 }),
  },

  // ── 0x11 MESSAGE_GET_STR ───────────────────────────────────────
  // Hypothesis: short display string (e.g., the formatted "3.5" or
  // "100 ms" the front panel shows for the param).
  {
    name: 'GET_STR @ AMP.GAIN',
    action: 0x11, opcodeName: 'MESSAGE_GET_STR',
    hypothesis: 'short formatted display string for the param',
    request: buildActionFrame({ pidLow: AMP_PID, pidHigh: AMP_GAIN_PIDHIGH, action: 0x11 }),
  },

  // ── 0x19 MESSAGE_GET_VAL ───────────────────────────────────────
  // Hypothesis: just the value (no descriptor), like 0x0E but possibly
  // a different encoding (int vs float, Q-format vs raw).
  {
    name: 'GET_VAL @ AMP.GAIN',
    action: 0x19, opcodeName: 'MESSAGE_GET_VAL',
    hypothesis: 'value-only read, alternate encoding to 0x0E short read',
    request: buildActionFrame({ pidLow: AMP_PID, pidHigh: AMP_GAIN_PIDHIGH, action: 0x19 }),
  },

  // ── 0x1A MESSAGE_GET_VAL_AND_STR ───────────────────────────────
  // Hypothesis: value + display string in ONE round-trip. Would
  // save a wire transaction for "show me what this param is set to".
  {
    name: 'GET_VAL_AND_STR @ AMP.GAIN',
    action: 0x1a, opcodeName: 'MESSAGE_GET_VAL_AND_STR',
    hypothesis: 'value + display string combined response — saves a round-trip',
    request: buildActionFrame({ pidLow: AMP_PID, pidHigh: AMP_GAIN_PIDHIGH, action: 0x1a }),
  },

  // ── 0x1D MESSAGE_GET_PATCH_NAME_BY_NUM ─────────────────────────
  // We ALREADY have buildGetPresetName which uses action=0x12
  // (MESSAGE_GET_STRING). This is a DIFFERENT action — what does it
  // do differently? Possibly returns just the name (no padding) or
  // a different encoding. Test with location 0 (A01) and 103 (Z04).
  {
    name: 'GET_PATCH_NAME_BY_NUM @ A01 (loc 0)',
    action: 0x1d, opcodeName: 'MESSAGE_GET_PATCH_NAME_BY_NUM',
    hypothesis: 'alternate preset-name read — may differ from MESSAGE_GET_STRING (action=0x12)',
    request: buildActionFrame({
      pidLow: PRESET_LEVEL_PIDLOW, pidHigh: PRESET_LEVEL_PIDHIGH, action: 0x1d,
      payload: [0, 0, 0, 0], // u32 LE location index 0
    }),
  },
  {
    name: 'GET_PATCH_NAME_BY_NUM @ Z04 (loc 103)',
    action: 0x1d, opcodeName: 'MESSAGE_GET_PATCH_NAME_BY_NUM',
    hypothesis: 'same probe at end-of-bank for variation',
    request: buildActionFrame({
      pidLow: PRESET_LEVEL_PIDLOW, pidHigh: PRESET_LEVEL_PIDHIGH, action: 0x1d,
      payload: [103, 0, 0, 0],
    }),
  },

  // ── 0x1E MESSAGE_GET_ALL_SCENE_NAMES ──────────────────────────
  // Hypothesis: bulk read of all 4 scene names of the active preset
  // in ONE response. Currently we'd need 4 individual queries; this
  // would save 75% wire traffic.
  // Likely no payload needed — addresses the active preset by default.
  {
    name: 'GET_ALL_SCENE_NAMES (active preset, no payload)',
    action: 0x1e, opcodeName: 'MESSAGE_GET_ALL_SCENE_NAMES',
    hypothesis: 'bulk-return all 4 scene names in one frame — ~128 bytes payload',
    request: buildActionFrame({
      pidLow: 0x0000, pidHigh: 0x0000, action: 0x1e,
    }),
    listenMs: 3000, // larger response — listen longer
  },
  // Variant with preset-level address — in case the action wants a
  // target.
  {
    name: 'GET_ALL_SCENE_NAMES @ preset-level address',
    action: 0x1e, opcodeName: 'MESSAGE_GET_ALL_SCENE_NAMES',
    hypothesis: 'with preset-level addressing in case 0,0 fails',
    request: buildActionFrame({
      pidLow: PRESET_LEVEL_PIDLOW, pidHigh: PRESET_LEVEL_PIDHIGH, action: 0x1e,
    }),
    listenMs: 3000,
  },

  // ── 0x1F MESSAGE_GET_PATCH ─────────────────────────────────────
  // Hypothesis: full preset binary read — alternate path to the
  // existing fn 0x03 [7F 7F 00] dump request? Or maybe a structured
  // JSON-ish blob instead of the 0x77/0x78/0x79 binary stream.
  // BE CAREFUL — large response, listen long.
  {
    name: 'GET_PATCH (no payload)',
    action: 0x1f, opcodeName: 'MESSAGE_GET_PATCH',
    hypothesis: 'full preset binary OR descriptor; may emit 0x77/0x78/0x79 stream',
    request: buildActionFrame({
      pidLow: 0x0000, pidHigh: 0x0000, action: 0x1f,
    }),
    listenMs: 5000,
  },
  {
    name: 'GET_PATCH @ Z04 (loc 103)',
    action: 0x1f, opcodeName: 'MESSAGE_GET_PATCH',
    hypothesis: 'specific stored preset by location — would close preset-read-without-switching',
    request: buildActionFrame({
      pidLow: PRESET_LEVEL_PIDLOW, pidHigh: PRESET_LEVEL_PIDHIGH, action: 0x1f,
      payload: [103, 0, 0, 0],
    }),
    listenMs: 5000,
  },

  // ── 0x20 MESSAGE_GET_GRID_INFO ─────────────────────────────────
  // We already have a fn 0x20 GET_GRID_LAYOUT (top-level function
  // byte, not the action subcode). This is the ACTION 0x20 inside
  // the 0x01 envelope — might be the same thing or might return
  // additional info (e.g., per-slot bypass state, channel state).
  {
    name: 'GET_GRID_INFO (no payload)',
    action: 0x20, opcodeName: 'MESSAGE_GET_GRID_INFO',
    hypothesis: 'grid layout via 0x01 dispatcher — overlap with top-level fn 0x20?',
    request: buildActionFrame({
      pidLow: 0x0000, pidHigh: 0x0000, action: 0x20,
    }),
    listenMs: 2000,
  },

  // ── 0x25 MESSAGE_GET_EFFECT_AVAIL ──────────────────────────────
  // Hypothesis: returns the list of available effect types for a
  // given slot position. Useful for "what could I place here".
  // No payload variant — global "which effects exist".
  {
    name: 'GET_EFFECT_AVAIL (no payload — global)',
    action: 0x25, opcodeName: 'MESSAGE_GET_EFFECT_AVAIL',
    hypothesis: 'list of available effect type IDs',
    request: buildActionFrame({
      pidLow: 0x0000, pidHigh: 0x0000, action: 0x25,
    }),
    listenMs: 3000,
  },
  // Slot-specific variant.
  {
    name: 'GET_EFFECT_AVAIL @ slot 1 (pidHigh=0x000F)',
    action: 0x25, opcodeName: 'MESSAGE_GET_EFFECT_AVAIL',
    hypothesis: 'per-slot availability — may differ between slots',
    request: buildActionFrame({
      pidLow: 0x00ce, pidHigh: 0x000f, action: 0x25,
    }),
    listenMs: 3000,
  },

  // ── 0x26 MESSAGE_GET_MODIFIER ─────────────────────────────────
  // AM4 has limited modifier support (LFO/envelope assignments).
  // Hypothesis: returns the modifier graph for a target param.
  {
    name: 'GET_MODIFIER @ AMP.GAIN',
    action: 0x26, opcodeName: 'MESSAGE_GET_MODIFIER',
    hypothesis: 'modifier graph (LFO/env source) for AMP.GAIN',
    request: buildActionFrame({
      pidLow: AMP_PID, pidHigh: AMP_GAIN_PIDHIGH, action: 0x26,
    }),
  },
  // No-target variant — list all active modifiers.
  {
    name: 'GET_MODIFIER (no target — list all)',
    action: 0x26, opcodeName: 'MESSAGE_GET_MODIFIER',
    hypothesis: 'list ALL active modifiers in the preset',
    request: buildActionFrame({
      pidLow: 0x0000, pidHigh: 0x0000, action: 0x26,
    }),
    listenMs: 2000,
  },

  // ── 0x2B MESSAGE_GET_METER ─────────────────────────────────────
  // Hypothesis: returns a DSP-side audio level meter — input level,
  // output level, possibly per-block. Would enable real-time level
  // monitoring during play.
  {
    name: 'GET_METER (no target — global)',
    action: 0x2b, opcodeName: 'MESSAGE_GET_METER',
    hypothesis: 'global input/output audio levels',
    request: buildActionFrame({
      pidLow: 0x0000, pidHigh: 0x0000, action: 0x2b,
    }),
  },
  {
    name: 'GET_METER @ AMP',
    action: 0x2b, opcodeName: 'MESSAGE_GET_METER',
    hypothesis: 'per-block level read',
    request: buildActionFrame({
      pidLow: AMP_PID, pidHigh: 0x0000, action: 0x2b,
    }),
  },

  // ── 0x2C MESSAGE_GET_SPI_ADC ──────────────────────────────────
  // Hardware diagnostic. Hypothesis: returns raw SPI ADC value
  // (front-panel knob position, expression pedal input, etc.).
  // Specific to hardware troubleshooting — low priority for MCP
  // exposure but informative for understanding what AM4-Edit
  // queries during init.
  {
    name: 'GET_SPI_ADC (no payload)',
    action: 0x2c, opcodeName: 'MESSAGE_GET_SPI_ADC',
    hypothesis: 'raw SPI ADC value — knob/pedal hardware reading',
    request: buildActionFrame({
      pidLow: 0x0000, pidHigh: 0x0000, action: 0x2c,
    }),
  },
  // Pedal-input variant — pidHigh=0x0001 for the first ADC channel.
  {
    name: 'GET_SPI_ADC @ pidHigh=0x0001',
    action: 0x2c, opcodeName: 'MESSAGE_GET_SPI_ADC',
    hypothesis: 'channel-1 ADC if pidHigh selects which channel',
    request: buildActionFrame({
      pidLow: 0x0000, pidHigh: 0x0001, action: 0x2c,
    }),
  },

  // ── 0x30 MESSAGE_GET_EFFECT_INUSE ─────────────────────────────
  // Hypothesis: returns which effect types are currently placed
  // (a bitmask or list). Useful for "which slots are filled".
  // We have fn 0x20 GET_GRID_LAYOUT for this but this may be a
  // simpler / faster path.
  {
    name: 'GET_EFFECT_INUSE (no payload)',
    action: 0x30, opcodeName: 'MESSAGE_GET_EFFECT_INUSE',
    hypothesis: 'list of in-use effect type IDs — slot-placement summary',
    request: buildActionFrame({
      pidLow: 0x0000, pidHigh: 0x0000, action: 0x30,
    }),
    listenMs: 2000,
  },

  // ── 0x31 MESSAGE_GET_SCENE_NAME_BY_NUM ────────────────────────
  // Read a single scene name by index. Cheaper variant of
  // GET_ALL_SCENE_NAMES if only one scene is needed.
  {
    name: 'GET_SCENE_NAME_BY_NUM @ scene 0',
    action: 0x31, opcodeName: 'MESSAGE_GET_SCENE_NAME_BY_NUM',
    hypothesis: 'scene-1 name; same shape as GET_PATCH_NAME_BY_NUM with scene index',
    request: buildActionFrame({
      pidLow: PRESET_LEVEL_PIDLOW, pidHigh: PRESET_LEVEL_PIDHIGH, action: 0x31,
      payload: [0, 0, 0, 0],
    }),
  },
  {
    name: 'GET_SCENE_NAME_BY_NUM @ scene 3',
    action: 0x31, opcodeName: 'MESSAGE_GET_SCENE_NAME_BY_NUM',
    hypothesis: 'scene-4 name — out-of-range test',
    request: buildActionFrame({
      pidLow: PRESET_LEVEL_PIDLOW, pidHigh: PRESET_LEVEL_PIDHIGH, action: 0x31,
      payload: [3, 0, 0, 0],
    }),
  },
];

// ──────────────────────────────────────────────────────────────────
// Probe runner
// ──────────────────────────────────────────────────────────────────

interface ProbeResult {
  def: ProbeDef;
  inboundFrames: number[][];
}

function classifyResponse(req: number[], frames: number[][]): {
  buckets: string[];
  notes: string[];
} {
  const buckets: string[] = [];
  const notes: string[] = [];
  if (frames.length === 0) {
    buckets.push('silent');
    notes.push('Device emitted no inbound frames within the listen window.');
    return { buckets, notes };
  }
  for (const f of frames) {
    if (f.length === req.length && f.every((b, i) => b === req[i])) {
      buckets.push('echo');
      continue;
    }
    if (f.length === 11 && f[5] === 0x64) {
      // Multipurpose ack: F0 00 01 74 15 64 [echoed_fn] [result] [cs] F7
      const echoedFn = f[6];
      const result = f[7];
      buckets.push(`mp-ack(fn=0x${echoedFn?.toString(16)},res=0x${result?.toString(16)})`);
      notes.push(`Multipurpose ack: echoed fn=0x${echoedFn?.toString(16)} result=0x${result?.toString(16)}` +
        ` — ${result === 0x02 ? 'OK' : result === 0x05 ? 'unsupported/rejected' : 'unknown result code'}`);
      continue;
    }
    if (f.length === 18 && f[5] === 0x01) {
      buckets.push('cmd-ack(18B)');
      continue;
    }
    if (f.length === 23 && f[5] === 0x01) {
      buckets.push('short-resp(23B)');
      continue;
    }
    if (f.length === 64 && f[5] === 0x01) {
      buckets.push('long-resp(64B)');
      continue;
    }
    buckets.push(`other(${f.length}B,fn=0x${f[5]?.toString(16)})`);
  }
  return { buckets, notes };
}

async function main(): Promise<void> {
  console.log('AM4 action-byte READ probe (Session 104 — Ghidra opcode-table follow-up)');
  console.log('═══════════════════════════════════════════════════════════════════════════');

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

  for (const def of PROBES) {
    const listenMs = def.listenMs ?? 1500;
    console.log(`\n── ${def.name} ──`);
    console.log(`    action=0x${def.action.toString(16).padStart(2, '0')} (${def.opcodeName})`);
    console.log(`    hypothesis: ${def.hypothesis}`);
    console.log(`    SEND (${def.request.length}B): ${toHex(def.request)}`);

    const before = collected.length;
    output.sendMessage(def.request);
    await sleep(listenMs);
    const inbound = collected.slice(before);
    console.log(`    Received ${inbound.length} inbound frames in ${listenMs}ms`);
    for (let i = 0; i < inbound.length; i++) {
      const f = inbound[i];
      const preview = toHex(f.slice(0, Math.min(24, f.length)));
      console.log(`      [${i}] len=${f.length} ${preview}${f.length > 24 ? ' …' : ''}`);
    }
    const { buckets, notes } = classifyResponse(def.request, inbound);
    console.log(`    buckets: [${buckets.join(', ')}]`);
    for (const n of notes) console.log(`    note: ${n}`);

    results.push({ def, inboundFrames: inbound });

    // Small inter-probe quiet period — let device settle before next.
    await sleep(150);
  }

  // ── Save raw bytes ─────────────────────────────────────────────
  mkdirSync('samples/captured', { recursive: true });
  const syxOut = path.resolve('samples/captured/probe-am4-action-reads.syx');
  const concat = results.flatMap((r) => [...r.def.request, ...r.inboundFrames.flat()]);
  writeFileSync(syxOut, Uint8Array.from(concat));
  console.log(`\nSaved raw bytes to ${syxOut}`);

  // ── Findings markdown ──────────────────────────────────────────
  const mdLines: string[] = [
    `# AM4 action-byte READ probe — findings`,
    ``,
    `> Auto-generated by \`scripts/_research/probe-am4-action-reads.ts\``,
    `> at ${new Date().toISOString()}`,
    ``,
    `## Per-action verdict`,
    ``,
    `| Action | Opcode | Probes | Verdict | Notes |`,
    `|---|---|---|---|---|`,
  ];
  const byAction = new Map<number, ProbeResult[]>();
  for (const r of results) {
    const list = byAction.get(r.def.action) ?? [];
    list.push(r);
    byAction.set(r.def.action, list);
  }
  for (const [action, items] of [...byAction.entries()].sort((a, b) => a[0] - b[0])) {
    const opcode = items[0]!.def.opcodeName;
    const probeCount = items.length;
    const totalFrames = items.reduce((sum, r) => sum + r.inboundFrames.length, 0);
    const anyResponse = items.some((r) =>
      r.inboundFrames.some((f) => !(f.length === r.def.request.length && f.every((b, i) => b === r.def.request[i])))
    );
    const verdict = totalFrames === 0
      ? '🔴 silent'
      : anyResponse
      ? '🟢 responsive'
      : '⚪ echo-only';
    const notes = items
      .flatMap((r) => classifyResponse(r.def.request, r.inboundFrames).buckets)
      .filter((b, i, arr) => arr.indexOf(b) === i)
      .join(', ');
    mdLines.push(`| 0x${action.toString(16).padStart(2, '0')} | ${opcode} | ${probeCount} | ${verdict} | ${notes || '—'} |`);
  }
  mdLines.push('', '## Per-probe raw inbound', '');
  for (const r of results) {
    mdLines.push(`### ${r.def.name} (action=0x${r.def.action.toString(16).padStart(2, '0')})`, '');
    mdLines.push(`Hypothesis: ${r.def.hypothesis}`, '');
    mdLines.push(`SEND: \`${toHex(r.def.request)}\``, '');
    if (r.inboundFrames.length === 0) {
      mdLines.push(`No inbound frames.`, '');
    } else {
      for (let i = 0; i < r.inboundFrames.length; i++) {
        const f = r.inboundFrames[i]!;
        mdLines.push(`Frame [${i}] (len=${f.length}):`);
        mdLines.push('```');
        // 16-byte rows.
        for (let off = 0; off < f.length; off += 16) {
          mdLines.push(toHex(f.slice(off, off + 16)));
        }
        mdLines.push('```');
      }
    }
    mdLines.push('');
  }
  const mdOut = path.resolve('samples/captured/probe-am4-action-reads-findings.md');
  writeFileSync(mdOut, mdLines.join('\n'));
  console.log(`Wrote findings markdown to ${mdOut}`);

  // ── Console summary ────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('FINDINGS SUMMARY');
  console.log('──────────────────────────────────────────────────────────────');
  for (const [action, items] of [...byAction.entries()].sort((a, b) => a[0] - b[0])) {
    const opcode = items[0]!.def.opcodeName;
    const totalFrames = items.reduce((sum, r) => sum + r.inboundFrames.length, 0);
    const anyResponse = items.some((r) =>
      r.inboundFrames.some((f) => !(f.length === r.def.request.length && f.every((b, i) => b === r.def.request[i])))
    );
    const verdict = totalFrames === 0 ? '🔴 silent' : anyResponse ? '🟢 responsive' : '⚪ echo-only';
    console.log(`  0x${action.toString(16).padStart(2, '0')}  ${opcode.padEnd(36)} ${verdict}`);
  }
  console.log('──────────────────────────────────────────────────────────────');
  console.log('\nNext: review samples/captured/probe-am4-action-reads-findings.md');
  console.log('and decode the responsive opcodes\' wire shapes one by one.');

  input.closePort();
  output.closePort();
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
