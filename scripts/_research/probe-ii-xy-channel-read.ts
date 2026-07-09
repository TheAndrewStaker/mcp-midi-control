/**
 * Axe-Fx II per-channel (X/Y) param-read round-trip probe.
 *
 * Goal: confirm that fn=0x02 GET_BLOCK_PARAMETER_VALUE returns the value
 * of the channel selected via fn=0x11 BLOCK_CHANNEL, i.e. that per-channel
 * reads round-trip (SYSEX-MAP open item on fn=0x02 channel awareness).
 * The SET half was hardware-confirmed 2026-05-26 (compressor X/Y
 * independently addressable); this probe closes the loop by writing a
 * DIFFERENT value to each channel and reading both back.
 *
 * # Method (self-restoring write probe)
 *
 * 1. Read the grid (fn=0x20) and pick a placed block with X/Y channels:
 *    Compressor 1/2 (effectId 100/101) or Drive 1/2 (133/134), in that
 *    priority order. Target param is the block's MIX knob (audible-safe
 *    at small deltas, never an output level).
 * 2. Record the block's current channel (fn=0x11 get), then read the
 *    target param on X and on Y (fn=0x11 set + fn=0x02 get each).
 * 3. Write value A to channel X and a DIFFERENT value B to channel Y
 *    (small deltas, ~5% of wire range, from each channel's own current
 *    value) via fn=0x02 SET (channel-aware per 2026-05-26 finding).
 * 4. Read both channels back via fn=0x02 GET with fn=0x11 channel
 *    select. PASS = X returns A, Y returns B, and A != B.
 * 5. Restore both original values, verify by re-read, and restore the
 *    block's original active channel.
 *
 * On any error mid-probe, the script attempts to restore whatever it
 * already wrote (values + channel) before exiting non-zero.
 *
 * Never saves, never switches presets. Only fn=0x20 / 0x11 / 0x02 are
 * sent. The working buffer is touched and restored; nothing persists.
 *
 * # Prereqs
 *
 * - Axe-Fx II XL+ powered on, USB connected.
 * - Close AxeEdit (its polling pollutes the inbound stream).
 * - Active preset must have a Compressor or Drive block placed.
 *
 * # Run
 *
 * ```
 * npx tsx scripts/_research/probe-ii-xy-channel-read.ts
 * npx tsx scripts/_research/probe-ii-xy-channel-read.ts --port "AXE-FX II"
 * ```
 *
 * # Output
 *
 * - samples/captured/probe-ii-xy-channel-read.json
 * - samples/captured/probe-ii-xy-channel-read-findings.md
 */

import midi from "@julusian/midi";
import type { Input as MidiInput, Output as MidiOutput } from "@julusian/midi";
import { writeFileSync, mkdirSync } from 'node:fs';
import { guardAgainstRunningEditors } from '../_lib/editor-guard.js';
import {
  AXE_FX_II_BLOCKS,
  KNOWN_PARAMS,
  buildGetGridLayout,
  isGetGridLayoutResponse,
  parseGetGridLayoutResponse,
  buildGetBlockParameterValue,
  isGetBlockParameterResponse,
  parseGetBlockParameterResponse,
  buildSetBlockParameterValueInteger,
  buildSetBlockChannel,
  buildGetBlockChannel,
  isGetBlockChannelResponse,
  parseGetBlockChannelResponse,
} from 'fractal-midi/gen2/axe-fx-ii';
import type { AxeFxIIChannel } from 'fractal-midi/gen2/axe-fx-ii';
import { createSysExAssembler } from '../../packages/core/src/midi/transport.js';

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_PORT_FRAGMENT = 'AXE-FX II';
/** Minimum spacing between wire sends (project pacing rule). */
const PACE_MS = 60;
/** Settle time after a SET (no reliable ack frame to wait on). */
const SETTLE_MS = 120;
/** Timeout waiting for a GET response frame. */
const RESPONSE_TIMEOUT_MS = 800;
/** ~5% of the 0..65534 wire range; audible but safe on a mix knob. */
const WIRE_DELTA = 3277;
const WIRE_MAX = 65534;

/** Candidate blocks, priority order. All have X/Y channels. */
const CANDIDATES = [
  { effectId: 100, paramKey: 'compressor.mix' as const },
  { effectId: 101, paramKey: 'compressor.mix' as const },
  { effectId: 133, paramKey: 'drive.mix' as const },
  { effectId: 134, paramKey: 'drive.mix' as const },
];

// 24 planned wire transactions; see the step list in the banner.
const PLANNED_TRANSACTIONS = 24;

// ── Helpers ────────────────────────────────────────────────────────

function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
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

function blockName(effectId: number): string {
  return (
    AXE_FX_II_BLOCKS.find((b) => b.id === effectId)?.name ??
    `block ${effectId}`
  );
}

/**
 * Pick a probe value near `orig`: shift up unless that would clamp,
 * then shift down. `avoid` forces a distinct result (A != B guard).
 */
function pickProbeValue(orig: number, avoid?: number): number {
  let v = orig + WIRE_DELTA <= WIRE_MAX ? orig + WIRE_DELTA : orig - WIRE_DELTA;
  if (avoid !== undefined && v === avoid) {
    v = v - Math.floor(WIRE_DELTA / 2) >= 0
      ? v - Math.floor(WIRE_DELTA / 2)
      : v + Math.floor(WIRE_DELTA / 2);
  }
  return Math.max(0, Math.min(WIRE_MAX, v));
}

// ── Transaction log ────────────────────────────────────────────────

interface WireLogEntry {
  n: number;
  dir: 'out' | 'in';
  label: string;
  hex: string;
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

  console.log('Axe-Fx II X/Y per-channel param-read round-trip probe');
  console.log('======================================================');
  console.log('Self-restoring write probe. Never saves, never switches');
  console.log('presets. Only fn=0x20 (grid read), fn=0x11 (channel');
  console.log('select), fn=0x02 (param get/set) are sent.');
  console.log(`Planned wire transactions: ${PLANNED_TRANSACTIONS}`);
  console.log(`Pacing: >= ${PACE_MS} ms between sends, expected ~8 s total.`);
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

  const wireLog: WireLogEntry[] = [];
  let txCount = 0;
  let lastSendAt = 0;

  async function send(bytes: number[], label: string): Promise<void> {
    const sinceLast = Date.now() - lastSendAt;
    if (sinceLast < PACE_MS) await sleep(PACE_MS - sinceLast);
    txCount++;
    wireLog.push({ n: txCount, dir: 'out', label, hex: toHex(bytes) });
    console.log(`  [tx ${String(txCount).padStart(2)}] ${label}`);
    output.sendMessage(bytes);
    lastSendAt = Date.now();
  }

  async function waitFor(
    match: (frame: number[]) => boolean,
    label: string,
  ): Promise<number[]> {
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    let scanned = 0;
    while (Date.now() < deadline) {
      for (; scanned < collected.length; scanned++) {
        const f = collected[scanned]!;
        if (match(f)) {
          wireLog.push({ n: txCount, dir: 'in', label, hex: toHex(f) });
          return f;
        }
      }
      await sleep(20);
    }
    throw new Error(`Timeout waiting for ${label} (${RESPONSE_TIMEOUT_MS} ms)`);
  }

  async function setChannel(
    effectId: number,
    channel: AxeFxIIChannel,
  ): Promise<void> {
    collected.length = 0;
    await send(
      buildSetBlockChannel(effectId, channel),
      `fn=0x11 SET channel ${channel} on ${blockName(effectId)}`,
    );
    await sleep(SETTLE_MS);
  }

  async function getChannel(effectId: number): Promise<AxeFxIIChannel> {
    collected.length = 0;
    await send(
      buildGetBlockChannel(effectId),
      `fn=0x11 GET channel of ${blockName(effectId)}`,
    );
    const frame = await waitFor(
      (f) => isGetBlockChannelResponse(f, effectId),
      'fn=0x11 channel response',
    );
    return parseGetBlockChannelResponse(frame);
  }

  async function getParam(
    effectId: number,
    paramId: number,
    what: string,
  ): Promise<{ value: number; label: string }> {
    collected.length = 0;
    await send(
      buildGetBlockParameterValue({ effectId, paramId }),
      `fn=0x02 GET ${what}`,
    );
    const frame = await waitFor(
      (f) => isGetBlockParameterResponse(f, { effectId, paramId }),
      `fn=0x02 response (${what})`,
    );
    return parseGetBlockParameterResponse(frame);
  }

  async function setParam(
    effectId: number,
    paramId: number,
    wireValue: number,
    what: string,
  ): Promise<void> {
    collected.length = 0;
    await send(
      buildSetBlockParameterValueInteger({ effectId, paramId }, wireValue),
      `fn=0x02 SET ${what} = wire ${wireValue}`,
    );
    await sleep(SETTLE_MS);
  }

  // State the abort handler needs for restoration.
  const restoreState: {
    effectId?: number;
    paramId?: number;
    origChannel?: AxeFxIIChannel;
    origX?: number;
    origY?: number;
    wroteX: boolean;
    wroteY: boolean;
  } = { wroteX: false, wroteY: false };

  let verdict = 'NOT-RUN';
  const findings: string[] = [];
  let report: Record<string, unknown> = {};

  try {
    // Quiet window: drain any pending inbound traffic.
    console.log('Ports open. Quiet window (500 ms) ...');
    await sleep(500);
    collected.length = 0;

    // Step 1: read the grid, find a placed candidate block.
    console.log('\nStep 1: grid read (fn=0x20), locate a placed X/Y block');
    collected.length = 0;
    await send(buildGetGridLayout(), 'fn=0x20 GET_GRID_LAYOUT');
    const gridFrame = await waitFor(
      (f) => isGetGridLayoutResponse(f),
      'fn=0x20 grid response',
    );
    const cells = parseGetGridLayoutResponse(gridFrame);
    const placedIds = new Set(cells.map((c) => c.blockId).filter((id) => id > 0));
    const candidate = CANDIDATES.find((c) => placedIds.has(c.effectId));
    if (!candidate) {
      const placedNames = [...placedIds]
        .filter((id) => id < 200)
        .map(blockName)
        .join(', ');
      throw new Error(
        'No Compressor or Drive block placed in the active preset. ' +
          `Placed blocks: ${placedNames || '(none)'}. ` +
          'Load a preset with a CPR or DRV block and re-run.',
      );
    }
    const { effectId } = candidate;
    const param = KNOWN_PARAMS[candidate.paramKey];
    const paramId = param.paramId;
    const target = `${blockName(effectId)} ${param.name} (paramId ${paramId})`;
    console.log(`  Target: ${target}`);
    restoreState.effectId = effectId;
    restoreState.paramId = paramId;

    // Step 2: record current channel + both channels' current values.
    console.log('\nStep 2: record original channel + per-channel values');
    const origChannel = await getChannel(effectId);
    restoreState.origChannel = origChannel;
    console.log(`  Original active channel: ${origChannel}`);

    await setChannel(effectId, 'X');
    const beforeX = await getParam(effectId, paramId, `${param.name} on X`);
    restoreState.origX = beforeX.value;
    console.log(`  X before: wire ${beforeX.value} ("${beforeX.label}")`);

    await setChannel(effectId, 'Y');
    const beforeY = await getParam(effectId, paramId, `${param.name} on Y`);
    restoreState.origY = beforeY.value;
    console.log(`  Y before: wire ${beforeY.value} ("${beforeY.label}")`);

    // Step 3: write distinct values to X and Y.
    const valueA = pickProbeValue(beforeX.value);
    const valueB = pickProbeValue(beforeY.value, valueA);
    if (valueA === valueB) {
      throw new Error(
        `Internal: probe values collided (A=${valueA}, B=${valueB})`,
      );
    }
    console.log(
      `\nStep 3: write X=${valueA}, Y=${valueB} (distinct, ~5% deltas)`,
    );
    await setChannel(effectId, 'X');
    await setParam(effectId, paramId, valueA, `${param.name} on X`);
    restoreState.wroteX = true;
    await setChannel(effectId, 'Y');
    await setParam(effectId, paramId, valueB, `${param.name} on Y`);
    restoreState.wroteY = true;

    // Step 4: read both back.
    console.log('\nStep 4: read back per channel');
    await setChannel(effectId, 'X');
    const afterX = await getParam(effectId, paramId, `${param.name} on X`);
    console.log(
      `  X readback: wire ${afterX.value} ("${afterX.label}"), expected ${valueA}`,
    );
    await setChannel(effectId, 'Y');
    const afterY = await getParam(effectId, paramId, `${param.name} on Y`);
    console.log(
      `  Y readback: wire ${afterY.value} ("${afterY.label}"), expected ${valueB}`,
    );

    const xOk = afterX.value === valueA;
    const yOk = afterY.value === valueB;
    const distinct = afterX.value !== afterY.value;
    const pass = xOk && yOk && distinct;
    verdict = pass ? 'PASS' : 'FAIL';
    findings.push(
      `X readback ${xOk ? 'matches' : 'DOES NOT match'} written value ` +
        `(wrote ${valueA}, read ${afterX.value}).`,
      `Y readback ${yOk ? 'matches' : 'DOES NOT match'} written value ` +
        `(wrote ${valueB}, read ${afterY.value}).`,
      `Channels read ${distinct ? 'distinct' : 'IDENTICAL'} values ` +
        `(X=${afterX.value}, Y=${afterY.value}).`,
    );
    if (!pass && afterX.value === afterY.value) {
      findings.push(
        'Identical readbacks suggest fn=0x02 GET ignored the fn=0x11 ' +
          'channel state, or the SET half landed both writes on one channel.',
      );
    }

    // Step 5: restore originals + verify + restore channel.
    console.log('\nStep 5: restore originals and verify');
    await setChannel(effectId, 'X');
    await setParam(effectId, paramId, beforeX.value, `${param.name} on X (restore)`);
    await setChannel(effectId, 'Y');
    await setParam(effectId, paramId, beforeY.value, `${param.name} on Y (restore)`);

    await setChannel(effectId, 'X');
    const verifyX = await getParam(effectId, paramId, `${param.name} on X (verify)`);
    await setChannel(effectId, 'Y');
    const verifyY = await getParam(effectId, paramId, `${param.name} on Y (verify)`);
    const restoredX = verifyX.value === beforeX.value;
    const restoredY = verifyY.value === beforeY.value;
    restoreState.wroteX = !restoredX;
    restoreState.wroteY = !restoredY;
    console.log(
      `  X restored: ${restoredX} (wire ${verifyX.value}), ` +
        `Y restored: ${restoredY} (wire ${verifyY.value})`,
    );
    if (!restoredX || !restoredY) {
      findings.push(
        'RESTORE INCOMPLETE: re-read did not match the original value. ' +
          `X: wanted ${beforeX.value} got ${verifyX.value}; ` +
          `Y: wanted ${beforeY.value} got ${verifyY.value}. ` +
          'Switch presets WITHOUT saving to discard the working buffer.',
      );
    }

    await setChannel(effectId, origChannel);
    const finalChannel = await getChannel(effectId);
    console.log(
      `  Channel restored to ${finalChannel} (original ${origChannel}): ` +
        `${finalChannel === origChannel}`,
    );

    report = {
      probe: 'probe-ii-xy-channel-read',
      timestamp: new Date().toISOString(),
      portFragment,
      target: {
        effectId,
        blockName: blockName(effectId),
        paramKey: candidate.paramKey,
        paramId,
      },
      verdict,
      originalChannel: origChannel,
      values: {
        beforeX: { wire: beforeX.value, label: beforeX.label },
        beforeY: { wire: beforeY.value, label: beforeY.label },
        writtenX: valueA,
        writtenY: valueB,
        readbackX: { wire: afterX.value, label: afterX.label },
        readbackY: { wire: afterY.value, label: afterY.label },
        verifyX: { wire: verifyX.value, label: verifyX.label },
        verifyY: { wire: verifyY.value, label: verifyY.label },
      },
      restored: {
        x: restoredX,
        y: restoredY,
        channel: finalChannel === origChannel,
      },
      findings,
      transactions: txCount,
      wireLog,
    };
  } catch (err) {
    verdict = 'ABORTED';
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nABORT: ${msg}`);
    findings.push(`Aborted: ${msg}`);

    // Best-effort restore of anything already written.
    try {
      const { effectId, paramId, origChannel, origX, origY } = restoreState;
      if (effectId !== undefined && paramId !== undefined) {
        if (restoreState.wroteX && origX !== undefined) {
          console.error('Restoring channel X original value ...');
          await setChannel(effectId, 'X');
          await setParam(effectId, paramId, origX, 'X (abort-restore)');
        }
        if (restoreState.wroteY && origY !== undefined) {
          console.error('Restoring channel Y original value ...');
          await setChannel(effectId, 'Y');
          await setParam(effectId, paramId, origY, 'Y (abort-restore)');
        }
        if (origChannel !== undefined) {
          await setChannel(effectId, origChannel);
        }
        console.error('Abort-restore sequence sent.');
      } else {
        console.error('Nothing was written; no restore needed.');
      }
    } catch (restoreErr) {
      console.error(
        'ABORT-RESTORE FAILED. The working buffer may hold probe values. ' +
          'Switch presets WITHOUT saving to discard. Detail:',
        restoreErr,
      );
    }

    report = {
      probe: 'probe-ii-xy-channel-read',
      timestamp: new Date().toISOString(),
      portFragment,
      verdict,
      findings,
      transactions: txCount,
      wireLog,
    };
  }

  // ── Artifacts ────────────────────────────────────────────────────
  mkdirSync('samples/captured', { recursive: true });
  writeFileSync(
    'samples/captured/probe-ii-xy-channel-read.json',
    JSON.stringify(report, null, 2),
  );

  const md: string[] = [
    '# Axe-Fx II X/Y per-channel param-read round-trip, findings',
    '',
    '> Auto-generated by `scripts/_research/probe-ii-xy-channel-read.ts`',
    `> at ${new Date().toISOString()}`,
    '',
    `**Verdict: ${verdict}**`,
    '',
    'PASS means fn=0x02 GET is channel-aware end to end: after writing',
    'distinct values to X and Y, each channel read back its own value.',
    '',
    '## Findings',
    '',
    ...findings.map((f) => `- ${f}`),
    '',
    '## Values',
    '',
    '```json',
    JSON.stringify(report['values'] ?? {}, null, 2),
    '```',
    '',
    `## Wire log (${txCount} transactions)`,
    '',
    '| # | dir | label | bytes |',
    '|---|-----|-------|-------|',
    ...wireLog.map(
      (e) => `| ${e.n} | ${e.dir} | ${e.label} | \`${e.hex}\` |`,
    ),
    '',
  ];
  writeFileSync(
    'samples/captured/probe-ii-xy-channel-read-findings.md',
    md.join('\n'),
  );

  console.log(`\nVerdict: ${verdict} (${txCount} wire transactions)`);
  console.log('Wrote samples/captured/probe-ii-xy-channel-read.json');
  console.log('Wrote samples/captured/probe-ii-xy-channel-read-findings.md');

  input.closePort();
  output.closePort();
  process.exit(verdict === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
