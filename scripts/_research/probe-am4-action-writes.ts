/**
 * AM4 action-byte discovery probe — WRITE-STYLE (Z04 scratch only)
 * ================================================================
 *
 * Session 104 (2026-05-20). Companion to probe-am4-action-reads.ts.
 * Tests the unused WRITE / MUTATE actions in the 47-entry MESSAGE_*
 * table mined from AM4-Edit.exe.
 *
 * # Safety profile — READ THIS BEFORE RUNNING
 *
 *   This probe DOES write to the AM4. Each write is gated as follows:
 *
 *   1. **Working-buffer writes only**: actions that modify a single
 *      param (TOGGLE, DEFAULT_PARAM, SET_NORM, INCR, DECR) write into
 *      the working buffer. They are reversible by reloading the active
 *      preset.
 *
 *   2. **Preset-location writes**: actions that write to a specific
 *      preset location (RECALL_PATCH, COPY_SCENE, SWAP_SCENES) are
 *      gated to **Z04 ONLY** (location index 103). This script will
 *      refuse to send any address-carrying write whose target isn't
 *      Z04.
 *
 *   3. **Explicit opt-in**: the script requires the `--writes` flag.
 *      Without it, the script prints the planned send list and exits.
 *
 *   4. **Active-location guard**: before any write, the script
 *      switches to Z04 via `buildSwitchPreset(103)`. This makes Z04
 *      the working buffer's source. After the probe completes, the
 *      script reloads Z04 to discard any working-buffer mutations.
 *
 * # Prereqs
 *
 *   - AM4 powered on, USB connected.
 *   - **Z04 should be empty or contain disposable scratch.** This
 *     script will mutate the Z04 working buffer.
 *   - **Close AM4-Edit before running.**
 *
 * # Run
 *
 *   - Dry-run (no writes): `npx tsx scripts/_research/probe-am4-action-writes.ts`
 *   - Live writes:         `npx tsx scripts/_research/probe-am4-action-writes.ts --writes`
 *
 * # What each probe tests
 *
 * For each write-style action, we:
 *
 *   1. Read AMP.GAIN via the existing short-read (action=0x0E) and
 *      capture the baseline value.
 *   2. Send the new write action targeting AMP.GAIN.
 *   3. Wait 250 ms.
 *   4. Read AMP.GAIN again.
 *   5. Compare before/after — note any change in value, plus the
 *      structure of the response.
 *
 * Some actions don't target a specific param (RECALL_PATCH targets a
 * location, COPY_SCENE targets scenes). Those use bespoke baseline +
 * verification flows; see the per-probe comments below.
 *
 * # Interpretation
 *
 * After the probe runs, each action has one of these outcomes:
 *
 *   - **🟢 wire-shape confirmed**: device produced a structured ack
 *     AND the baseline / verification read shows the expected change.
 *   - **🟡 ack received, no observable effect**: device acknowledged
 *     but the read shows no change. Either the action is informational
 *     (UI hint?) or requires different addressing.
 *   - **🔴 no response**: device fully ignored. Likely wrong wire shape.
 *
 * Drop the per-action findings into `am4edit-action-table.md` once
 * understood.
 */

import midi from 'midi';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import {
  BLOCK_TYPE_VALUES,
  buildReadParam,
  buildSwitchPreset,
  buildSetParam,
  isReadResponse,
  parseReadResponse,
  KNOWN_PARAMS,
  encode,
} from 'fractal-midi/am4';

// ──────────────────────────────────────────────────────────────────
// Wire envelope helpers
// ──────────────────────────────────────────────────────────────────

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const AM4_MODEL = 0x15;
const FUNC_PARAM_RW = 0x01;

const Z04_LOCATION = 103;
const SCRATCH_LOCATION_REQUIRED = Z04_LOCATION;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}

function encode14(n: number): [number, number] {
  if (n < 0 || n > 0x3fff) throw new Error(`14-bit value out of range: ${n}`);
  return [n & 0x7f, (n >> 7) & 0x7f];
}

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

function buildActionFrame(opts: {
  pidLow: number;
  pidHigh: number;
  action: number;
  hdr3?: number;
  payload?: number[];
}): number[] {
  const { pidLow, pidHigh, action, hdr3 = 0x0000, payload = [] } = opts;
  const head = [
    SYSEX_START, ...FRACTAL_MFR, AM4_MODEL, FUNC_PARAM_RW,
    ...encode14(pidLow), ...encode14(pidHigh), ...encode14(action),
    ...encode14(hdr3), ...encode14(payload.length),
    ...packBytes(payload),
  ];
  const cs = fractalChecksum(head);
  return [...head, cs, SYSEX_END];
}

/** Pack a 32-bit float (IEEE 754 LE) into 4 raw bytes for payload use. */
function packFloat32LE(value: number): number[] {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  const bytes = new Uint8Array(buf);
  return Array.from(bytes);
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

// ──────────────────────────────────────────────────────────────────
// AMP.GAIN baseline read helper
// ──────────────────────────────────────────────────────────────────

const AMP_GAIN = KNOWN_PARAMS['amp.gain']!;

interface BaselineRead {
  rawBytes: Uint8Array;
  asUInt32LE: number;
  asInternalFloat: number;
}

async function readAmpGain(output: midi.Output, collected: number[][]): Promise<BaselineRead | null> {
  const req = buildReadParam(AMP_GAIN, 0x0e);
  const before = collected.length;
  output.sendMessage(req);
  await sleep(300);
  const inbound = collected.slice(before);
  for (const f of inbound) {
    if (isReadResponse(req, f)) {
      const parsed = parseReadResponse(f);
      return {
        rawBytes: parsed.rawValue,
        asUInt32LE: parsed.asUInt32LE(),
        asInternalFloat: parsed.asInternalFloat(),
      };
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// Probe definitions
// ──────────────────────────────────────────────────────────────────

interface WriteProbeDef {
  name: string;
  action: number;
  opcodeName: string;
  hypothesis: string;
  /**
   * Build the request frame to send. Receives the AMP.GAIN param
   * so probes can target it without re-importing.
   */
  buildRequest: () => number[];
  /**
   * What the probe expects to observe after the write. The runner
   * reads AMP.GAIN before + after and passes both readings. Return
   * a verdict string; "🟢 confirmed" / "🟡 no-effect" / "🟢 ack-only".
   */
  verify?: (before: BaselineRead | null, after: BaselineRead | null) => string;
  /**
   * Tier:
   *   1 = single-param working-buffer write (reversible by reload)
   *   2 = preset-level write, Z04-gated
   *   3 = grid manipulation (Z04-gated)
   */
  tier: 1 | 2 | 3;
  /** If true, skip until tier-3-explicit flag also enabled. */
  destructive?: boolean;
}

const AMP_PID = BLOCK_TYPE_VALUES.amp;
const REVERB_PID = BLOCK_TYPE_VALUES.reverb;
const PRESET_LEVEL_PIDLOW = 0x00ce;
const PRESET_LEVEL_PIDHIGH = 0x000b;

const PROBES: WriteProbeDef[] = [
  // ── Tier 1: single-param working-buffer writes ────────────────

  // 0x02 MESSAGE_SET_NORM — normalized 0..1.0 write.
  // Hypothesis: AMP.GAIN's display range is 0..10 but the wire
  // value is 0..1.0 internal. SET_NORM may want the 0..1 value
  // directly (no scale conversion). Send 0.7 = "70% gain".
  {
    name: 'SET_NORM @ AMP.GAIN = 0.7 (normalized)',
    action: 0x02, opcodeName: 'MESSAGE_SET_NORM',
    hypothesis: 'normalized 0..1.0 float write; bypasses display→internal scale',
    tier: 1,
    buildRequest: () => buildActionFrame({
      pidLow: AMP_PID, pidHigh: AMP_GAIN.pidHigh, action: 0x02,
      payload: packFloat32LE(0.7),
    }),
    verify: (b, a) => {
      if (!b || !a) return '⚪ baseline-or-after read failed';
      if (b.asInternalFloat === a.asInternalFloat) return '🟡 no observable change';
      // Internal float of 0.7 = AMP.GAIN display value 7.0
      const delta = a.asInternalFloat - b.asInternalFloat;
      return `🟢 changed: ${b.asInternalFloat.toFixed(4)} → ${a.asInternalFloat.toFixed(4)} (Δ ${delta.toFixed(4)})`;
    },
  },

  // 0x03 MESSAGE_INCR — increment by step.
  // Hypothesis: nudges the value up by the param's natural step size
  // (e.g., +0.1 for gain on a 0..10 scale). Payload may be empty
  // (use default step) or carry a step multiplier.
  {
    name: 'INCR @ AMP.GAIN (no payload)',
    action: 0x03, opcodeName: 'MESSAGE_INCR',
    hypothesis: 'increment by 1 step; no payload — device uses param-default step',
    tier: 1,
    buildRequest: () => buildActionFrame({
      pidLow: AMP_PID, pidHigh: AMP_GAIN.pidHigh, action: 0x03,
    }),
    verify: (b, a) => {
      if (!b || !a) return '⚪ baseline-or-after read failed';
      if (a.asUInt32LE === b.asUInt32LE) return '🟡 no change';
      const delta = a.asUInt32LE - b.asUInt32LE;
      return `🟢 incremented by u32 delta ${delta} (${b.asUInt32LE} → ${a.asUInt32LE})`;
    },
  },

  // 0x05 MESSAGE_DECR — decrement.
  {
    name: 'DECR @ AMP.GAIN (no payload)',
    action: 0x05, opcodeName: 'MESSAGE_DECR',
    hypothesis: 'decrement by 1 step',
    tier: 1,
    buildRequest: () => buildActionFrame({
      pidLow: AMP_PID, pidHigh: AMP_GAIN.pidHigh, action: 0x05,
    }),
    verify: (b, a) => {
      if (!b || !a) return '⚪ baseline-or-after read failed';
      if (a.asUInt32LE === b.asUInt32LE) return '🟡 no change';
      const delta = a.asUInt32LE - b.asUInt32LE;
      return `🟢 decremented by u32 delta ${delta} (${b.asUInt32LE} → ${a.asUInt32LE})`;
    },
  },

  // 0x04 MESSAGE_INCR_COARSE — coarser increment.
  {
    name: 'INCR_COARSE @ AMP.GAIN (no payload)',
    action: 0x04, opcodeName: 'MESSAGE_INCR_COARSE',
    hypothesis: 'increment by larger step than INCR; may multiply by 10 or step-shift',
    tier: 1,
    buildRequest: () => buildActionFrame({
      pidLow: AMP_PID, pidHigh: AMP_GAIN.pidHigh, action: 0x04,
    }),
    verify: (b, a) => {
      if (!b || !a) return '⚪ baseline-or-after read failed';
      if (a.asUInt32LE === b.asUInt32LE) return '🟡 no change';
      const delta = a.asUInt32LE - b.asUInt32LE;
      return `🟢 coarse-incremented by u32 delta ${delta} (${b.asUInt32LE} → ${a.asUInt32LE})`;
    },
  },

  // 0x06 MESSAGE_DECR_COARSE — coarser decrement.
  {
    name: 'DECR_COARSE @ AMP.GAIN (no payload)',
    action: 0x06, opcodeName: 'MESSAGE_DECR_COARSE',
    hypothesis: 'decrement by larger step',
    tier: 1,
    buildRequest: () => buildActionFrame({
      pidLow: AMP_PID, pidHigh: AMP_GAIN.pidHigh, action: 0x06,
    }),
    verify: (b, a) => {
      if (!b || !a) return '⚪ baseline-or-after read failed';
      if (a.asUInt32LE === b.asUInt32LE) return '🟡 no change';
      const delta = a.asUInt32LE - b.asUInt32LE;
      return `🟢 coarse-decremented by u32 delta ${delta} (${b.asUInt32LE} → ${a.asUInt32LE})`;
    },
  },

  // 0x07 MESSAGE_TOGGLE — toggle (boolean flip).
  // Hypothesis: on bypass-style params (1-bit), TOGGLE flips the
  // current state. On continuous params, behavior unclear — might
  // be no-op, might toggle around a midpoint. Test on AMP bypass
  // (pidHigh=0x0003).
  {
    name: 'TOGGLE @ AMP bypass (pidHigh=0x0003)',
    action: 0x07, opcodeName: 'MESSAGE_TOGGLE',
    hypothesis: 'flips boolean bypass state in-place',
    tier: 1,
    buildRequest: () => buildActionFrame({
      pidLow: AMP_PID, pidHigh: 0x0003, action: 0x07,
    }),
    verify: () => '⚪ check front panel: amp bypass should have flipped (LED on/off)',
  },

  // 0x08 MESSAGE_DEFAULT — generic default (no specific param?).
  // Hypothesis: "reset to default" but unclear what scope.
  // Companion zero-payload frames observed in captures use this.
  {
    name: 'DEFAULT (no target, no payload)',
    action: 0x08, opcodeName: 'MESSAGE_DEFAULT',
    hypothesis: 'broad default reset — likely a no-op probe to confirm device acceptance',
    tier: 1,
    buildRequest: () => buildActionFrame({
      pidLow: 0x0000, pidHigh: 0x0000, action: 0x08,
    }),
    verify: () => '⚪ baseline-unchanged expected; check inbound for ack',
  },

  // 0x09 MESSAGE_DEFAULT_PARAM — reset specific param to default.
  {
    name: 'DEFAULT_PARAM @ AMP.GAIN',
    action: 0x09, opcodeName: 'MESSAGE_DEFAULT_PARAM',
    hypothesis: 'AMP.GAIN should snap to its factory-default value',
    tier: 1,
    buildRequest: () => buildActionFrame({
      pidLow: AMP_PID, pidHigh: AMP_GAIN.pidHigh, action: 0x09,
    }),
    verify: (b, a) => {
      if (!b || !a) return '⚪ baseline-or-after read failed';
      if (a.asUInt32LE === b.asUInt32LE) return '🟡 no change (already at default?)';
      return `🟢 reset to u32=${a.asUInt32LE} (was ${b.asUInt32LE}) — likely the factory default`;
    },
  },

  // 0x0A MESSAGE_SET_PARAM — alternate SET (vs MESSAGE_SET=0x01).
  // Hypothesis: maybe accepts a different value encoding (int? Q-format?).
  // Send the same wire bytes our existing SET would send and see if
  // device responds differently.
  {
    name: 'SET_PARAM @ AMP.GAIN = 0.5 (float32)',
    action: 0x0a, opcodeName: 'MESSAGE_SET_PARAM',
    hypothesis: 'alternate write — possibly different value encoding',
    tier: 1,
    buildRequest: () => buildActionFrame({
      pidLow: AMP_PID, pidHigh: AMP_GAIN.pidHigh, action: 0x0a,
      payload: packFloat32LE(0.5),
    }),
    verify: (b, a) => {
      if (!b || !a) return '⚪ baseline-or-after read failed';
      if (a.asUInt32LE === b.asUInt32LE) return '🟡 no change — not the right encoding';
      return `🟢 changed: ${b.asUInt32LE} → ${a.asUInt32LE}; check internal float`;
    },
  },

  // 0x18 MESSAGE_EXECUTE — generic execute, no value.
  // Hypothesis: triggers a side-effect (refresh, init, etc.) without
  // value semantics. Send no payload.
  {
    name: 'EXECUTE (no target, no payload)',
    action: 0x18, opcodeName: 'MESSAGE_EXECUTE',
    hypothesis: 'fires a no-arg side effect; check for any inbound flurry',
    tier: 1,
    buildRequest: () => buildActionFrame({
      pidLow: 0x0000, pidHigh: 0x0000, action: 0x18,
    }),
    verify: () => '⚪ informational — inspect inbound frame burst (if any)',
  },

  // ── Tier 2: preset-level writes (Z04-gated) ───────────────────

  // 0x1C MESSAGE_RECALL_PATCH — load preset from location.
  // Hypothesis: alternative to buildSwitchPreset (float-write to
  // pidHigh=0x000A). RECALL may be a cleaner / official path.
  // CRITICAL: load Z04 itself (location 103) so we don't switch
  // away from the scratch preset.
  {
    name: 'RECALL_PATCH @ Z04 (loc 103)',
    action: 0x1c, opcodeName: 'MESSAGE_RECALL_PATCH',
    hypothesis: 'load preset 103 into working buffer; same as buildSwitchPreset(103)',
    tier: 2,
    buildRequest: () => buildActionFrame({
      pidLow: PRESET_LEVEL_PIDLOW, pidHigh: PRESET_LEVEL_PIDHIGH, action: 0x1c,
      payload: [SCRATCH_LOCATION_REQUIRED, 0, 0, 0],
    }),
    verify: () => '⚪ check front panel: preset display should show Z04 (or stay at Z04)',
  },

  // ── Tier 3: scene manipulation (Z04-gated) ────────────────────

  // 0x2D MESSAGE_COPY_CHANNEL — copy block channel state (A→B etc.).
  // Hypothesis: copies the SOURCE channel's params into the TARGET
  // channel of the same block. Payload likely [source_channel, dest_channel].
  // Test: copy AMP channel A → channel B.
  {
    name: 'COPY_CHANNEL @ AMP: A→B',
    action: 0x2d, opcodeName: 'MESSAGE_COPY_CHANNEL',
    hypothesis: 'copy channel A (0) to channel B (1) on AMP block',
    tier: 3, destructive: true,
    buildRequest: () => buildActionFrame({
      pidLow: AMP_PID, pidHigh: 0x0000, action: 0x2d,
      payload: [0, 1, 0, 0], // source=0 (A), dest=1 (B)
    }),
    verify: () => '⚪ check via channel-B param read after; should match channel-A',
  },

  // 0x2E MESSAGE_COPY_SCENE — copy scene 1 to scene 2 within active.
  {
    name: 'COPY_SCENE: 0→1 (scene 1 → scene 2)',
    action: 0x2e, opcodeName: 'MESSAGE_COPY_SCENE',
    hypothesis: 'copy entire scene 1 state into scene 2 slot',
    tier: 3, destructive: true,
    buildRequest: () => buildActionFrame({
      pidLow: PRESET_LEVEL_PIDLOW, pidHigh: PRESET_LEVEL_PIDHIGH, action: 0x2e,
      payload: [0, 1, 0, 0],
    }),
    verify: () => '⚪ check via per-scene reads; scene 2 should mirror scene 1',
  },

  // 0x32 MESSAGE_SWAP_SCENES — atomic scene swap.
  {
    name: 'SWAP_SCENES: 0↔1 (scene 1 ↔ scene 2)',
    action: 0x32, opcodeName: 'MESSAGE_SWAP_SCENES',
    hypothesis: 'swap scenes 1 and 2; verify by reading both before+after',
    tier: 3, destructive: true,
    buildRequest: () => buildActionFrame({
      pidLow: PRESET_LEVEL_PIDLOW, pidHigh: PRESET_LEVEL_PIDHIGH, action: 0x32,
      payload: [0, 1, 0, 0],
    }),
    verify: () => '⚪ check via per-scene reads; values should be swapped',
  },

  // ── Tier 3: grid manipulation (Z04-gated, very destructive) ───

  // 0x22 MESSAGE_PLACE_EFFECT — place an effect into a grid slot.
  // Hypothesis: [block_type_value, slot_position]. Place REVERB
  // into slot 4 (pidHigh=0x0012 in slot register convention).
  // SKIPPED unless --writes-tier3 flag is set — placing/removing
  // effects rearranges the audio chain.
  {
    name: 'PLACE_EFFECT: REVERB → slot 4',
    action: 0x22, opcodeName: 'MESSAGE_PLACE_EFFECT',
    hypothesis: 'place REVERB block into grid slot 4',
    tier: 3, destructive: true,
    buildRequest: () => buildActionFrame({
      pidLow: 0x00ce, pidHigh: 0x0012, action: 0x22,
      payload: [REVERB_PID, 0, 0, 0],
    }),
    verify: () => '⚪ check via fn 0x20 grid-layout read; slot 4 should hold REVERB',
  },

  // 0x23 MESSAGE_RESET_EFFECT — reset block params to defaults.
  {
    name: 'RESET_EFFECT @ AMP',
    action: 0x23, opcodeName: 'MESSAGE_RESET_EFFECT',
    hypothesis: 'reset all AMP block params to factory defaults',
    tier: 3, destructive: true,
    buildRequest: () => buildActionFrame({
      pidLow: AMP_PID, pidHigh: 0x0000, action: 0x23,
    }),
    verify: () => '⚪ AMP.GAIN, AMP.MASTER, AMP.TYPE should all be at defaults',
  },
];

// ──────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const liveWrites = args.includes('--writes');
  const tier3Live = args.includes('--writes-tier3');

  console.log('AM4 action-byte WRITE probe (Z04-gated)');
  console.log('════════════════════════════════════════');
  console.log(`Live writes:       ${liveWrites ? '🔴 YES — will mutate device' : '⚪ dry-run only'}`);
  console.log(`Tier-3 grid+scene: ${tier3Live ? '🔴 YES' : '⚪ skipped (use --writes-tier3 to enable)'}`);

  if (!liveWrites) {
    console.log('\nDry-run — listing planned probes:');
    for (const p of PROBES) {
      console.log(`  tier=${p.tier}  action=0x${p.action.toString(16).padStart(2, '0')}  ${p.name}`);
      console.log(`                   hypothesis: ${p.hypothesis}`);
    }
    console.log('\nAdd --writes to send tier-1+tier-2 writes.');
    console.log('Add --writes-tier3 to additionally send grid/scene manipulation.');
    process.exit(0);
  }

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

  // ── Setup: switch to Z04 ──────────────────────────────────────
  console.log(`\n→ Switching to Z04 (location ${Z04_LOCATION}) as scratch...`);
  output.sendMessage(buildSwitchPreset(Z04_LOCATION));
  await sleep(800);
  collected.length = 0;

  const results: Array<{ def: WriteProbeDef; before: BaselineRead | null; after: BaselineRead | null; verdict: string; inbound: number[][] }> = [];

  for (const def of PROBES) {
    if (def.tier === 3 && !tier3Live) {
      console.log(`\n⏭  SKIP (tier-3 disabled): ${def.name}`);
      continue;
    }
    console.log(`\n── ${def.name} ──`);
    console.log(`    action=0x${def.action.toString(16).padStart(2, '0')} (${def.opcodeName}) — tier ${def.tier}`);
    console.log(`    hypothesis: ${def.hypothesis}`);

    // Baseline read (only meaningful for tier-1 single-param writes).
    let before: BaselineRead | null = null;
    if (def.tier === 1) {
      before = await readAmpGain(output, collected);
      if (before) {
        console.log(`    baseline AMP.GAIN: u32=${before.asUInt32LE} float=${before.asInternalFloat.toFixed(4)}`);
      } else {
        console.log(`    baseline read failed`);
      }
    }

    // Send the write.
    const req = def.buildRequest();
    console.log(`    SEND (${req.length}B): ${toHex(req)}`);
    const sendCount = collected.length;
    output.sendMessage(req);
    await sleep(400);
    const inbound = collected.slice(sendCount);
    console.log(`    Received ${inbound.length} inbound frames`);
    for (let i = 0; i < inbound.length; i++) {
      const f = inbound[i]!;
      const preview = toHex(f.slice(0, Math.min(24, f.length)));
      console.log(`      [${i}] len=${f.length} ${preview}${f.length > 24 ? ' …' : ''}`);
    }

    // After-read.
    let after: BaselineRead | null = null;
    if (def.tier === 1) {
      after = await readAmpGain(output, collected);
      if (after) {
        console.log(`    after AMP.GAIN:    u32=${after.asUInt32LE} float=${after.asInternalFloat.toFixed(4)}`);
      }
    }

    const verdict = def.verify ? def.verify(before, after) : '⚪ no verify';
    console.log(`    verdict: ${verdict}`);
    results.push({ def, before, after, verdict, inbound });

    // Restore AMP.GAIN to a safe baseline between tier-1 probes.
    if (def.tier === 1) {
      output.sendMessage(buildSetParam('amp.gain', 5.0));
      await sleep(200);
    }
  }

  // ── Cleanup: reload Z04 to discard working-buffer mutations ──
  console.log(`\n→ Reloading Z04 to discard working-buffer mutations...`);
  output.sendMessage(buildSwitchPreset(Z04_LOCATION));
  await sleep(800);

  // ── Save artifacts ───────────────────────────────────────────
  mkdirSync('samples/captured', { recursive: true });
  const syxOut = path.resolve('samples/captured/probe-am4-action-writes.syx');
  const concat = results.flatMap((r) => [...r.def.buildRequest(), ...r.inbound.flat()]);
  writeFileSync(syxOut, Uint8Array.from(concat));
  console.log(`\nSaved raw bytes to ${syxOut}`);

  // ── Findings markdown ────────────────────────────────────────
  const md: string[] = [
    `# AM4 action-byte WRITE probe — findings`,
    ``,
    `> Auto-generated by \`scripts/_research/probe-am4-action-writes.ts\``,
    `> at ${new Date().toISOString()}`,
    ``,
    `## Per-probe verdict`,
    ``,
    `| Action | Opcode | Tier | Verdict |`,
    `|---|---|---|---|`,
  ];
  for (const r of results) {
    md.push(`| 0x${r.def.action.toString(16).padStart(2, '0')} | ${r.def.opcodeName} | ${r.def.tier} | ${r.verdict} |`);
  }
  md.push('', '## Per-probe details', '');
  for (const r of results) {
    md.push(`### ${r.def.name}`, '');
    md.push(`Hypothesis: ${r.def.hypothesis}`, '');
    md.push(`Verdict: ${r.verdict}`, '');
    if (r.before) md.push(`Before: u32=${r.before.asUInt32LE} float=${r.before.asInternalFloat}`);
    if (r.after) md.push(`After:  u32=${r.after.asUInt32LE} float=${r.after.asInternalFloat}`);
    md.push('');
    md.push('Inbound frames:');
    md.push('```');
    for (const f of r.inbound) md.push(toHex(f));
    if (r.inbound.length === 0) md.push('(none)');
    md.push('```');
    md.push('');
  }
  const mdOut = path.resolve('samples/captured/probe-am4-action-writes-findings.md');
  writeFileSync(mdOut, md.join('\n'));
  console.log(`Wrote findings markdown to ${mdOut}`);

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('SUMMARY');
  console.log('──────────────────────────────────────────────────────────────');
  for (const r of results) {
    console.log(`  0x${r.def.action.toString(16).padStart(2, '0')}  ${r.def.opcodeName.padEnd(30)} ${r.verdict}`);
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
