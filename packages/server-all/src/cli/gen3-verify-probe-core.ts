/**
 * Gen-3 WRITE-VERIFY probe, core logic (transport-injectable, no process / fs).
 *
 * `runVerifyProbe` drives every shipped gen-3 write op against the LOADED preset
 * and reads the result back to confirm the device ACCEPTS AND APPLIES our
 * writes. The headline question is whether set_param works for continuous knobs.
 * Because the editor uses TWO different wire shapes for a continuous value, the
 * probe tests BOTH and reports each verdict:
 *   - the typed `09 00` integer form (`buildSetParameter`, the form our shipped
 *     set_param actually emits), and
 *   - the mouse-drag `52 00` float32 form (what FM9-Edit emits for a knob drag;
 *     built here byte-for-byte from the captured frame layout).
 * Whichever the device accepts tells us if the shipped continuous path is right
 * or must switch to the float form.
 *
 * SAFETY (hard invariants):
 *   - NEVER saves / stores (no store op anywhere in this module).
 *   - Establishes a RESTORE POINT first (reads the active preset number); if it
 *     cannot, runs READ-ONLY and skips every write test. `onRestorePoint` is
 *     fired with that number so the CLI can also reload on Ctrl-C.
 *   - RELOADS the active preset at the end (the master undo: reloading from flash
 *     discards the working buffer), then RE-READS the preset number and warns if
 *     it does not match. The reload uses the SysEx-native fn=0x01 sub=0x27
 *     switch (FM3-hardware-confirmed), NOT MIDI Program Change: PC is 7-bit and
 *     the FM3 ignores CC32 Bank Select with the 'standard' encoding, so a PC
 *     restore of preset >127 lands on preset mod 128 (field-confirmed on FM3
 *     fw 12.00, 2026-06-12: restore of 438 landed on 54). sub=0x27 carries the
 *     full 14-bit preset number and has no bank-mode / MIDI-channel dependency.
 *
 * PLACEMENT IS GATED ON fn=0x13 STATUS_DUMP, NOT ON POLL ANSWERS. The FM3 field
 * test (fw 12.00, 2026-06-12) proved the fn=0x1F bulk-read poll ANSWERS for
 * UNPLACED blocks (35/42 block types answered while the device's own 0x13
 * status dump listed only 3 placed blocks), so "the block answered a poll" is
 * NOT evidence the block is in the preset — that run's reverb writes were
 * wire-acked but inaudible (the reverb was never placed). The probe therefore
 * reads the 0x13 placed-block list up front and gates the reverb tests and the
 * set_block test (before AND after placement) on it; pollBlock is kept only
 * for VALUE read-back. If the 0x13 reply is absent/unparseable, the probe
 * falls back to the old poll-based detection and records a warning.
 *
 * PARAM IDS ARE DEVICE-SPECIFIC. The reverb Mix/Type paramIds differ across the
 * gen-3 family (FM9: mix=0, type=10; III + FM3: type=0, mix=13), so the caller
 * MUST pass the device-true ids via `reverbIds` (the CLI resolves them from the
 * device's own catalog). Hardcoded FM9-shaped ids mis-addressed the FM3 field
 * test 2026-06-12: the "mix" test actually set reverb TYPE (float 0.75
 * quantized to ordinal 58/78 of the 79-entry enum) and the "type" test set
 * REVERB_LOWCUT (float32(45.0) landed as 45.0 Hz — wire 11540 under the log10
 * 20..2000 calibration, exact). Both decodes were byte-perfect; only the
 * addressing was wrong.
 */
import type { MidiConnection } from '@mcp-midi-control/fractal-gen3/midi.js';
import { toHex } from '@mcp-midi-control/fractal-gen3/midi.js';
import { fractalChecksum } from 'fractal-midi/shared';
import {
  buildBlockBulkReadPoll,
  assembleGen3BlockBulkRead,
  isGen3BroadcastFrame,
  buildSetParameter,
  parseGen3SetValueEcho,
  pack5Septet32,
  buildSetBypass,
  buildSetScene,
  buildGetScene,
  buildSetGridCell,
  buildStatusDump,
  buildSwitchPresetSysEx,
  buildQueryPatchName,
  isQueryPatchNameResponse,
  parseQueryPatchNameResponse,
  parseStatusDumpResponse,
} from 'fractal-midi/gen3/axe-fx-iii';

const REVERB_EFFECT_ID = 66;
// A discrete type SET carries float32(read-ordinal) at pos 12 (sub 09 00). Use a
// NON-power-of-2 ordinal so success proves the corrected wire specifically: ord 16
// encodes identically under the old (retired pos-15 packValue16) and new wire and
// cannot distinguish the fix. Music Hall = ordinal 45 is decisive.
const REVERB_TYPE_GROUND_TRUTH = { ordinal: 45, name: 'Music Hall' };
const DRIVE_EFFECT_ID = 118;

const POLL_WINDOW_MS = 400;
const SET_ECHO_WINDOW_MS = 400;
const QUERY_WINDOW_MS = 600;
const SETTLE_MS = 120;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Reusable IEEE-754 float32 <-> uint32 view (mirrors the codec's decoder), so
// the probe can build the captured `52 00` mouse-drag form, whose value is a
// 5-septet-LE float32 of the normalized [0,1] knob position at bytes 12-16.
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function buildDragSetFloat(eff: number, pid: number, normalized: number, model: number): number[] {
  _f32[0] = Math.max(0, Math.min(1, normalized));
  const [s0, s1, s2, s3, s4] = pack5Septet32(_u32[0]);
  const enc14 = (n: number): number[] => [n & 0x7f, (n >> 7) & 0x7f];
  // Byte-for-byte the captured FM9 drag frame: F0 00 01 74 <model> 01 52 00
  // <eff:2> <pid:2> <float:5> 00 00 00 00 <cks> F7.
  const body = [0xf0, 0x00, 0x01, 0x74, model, 0x01, 0x52, 0x00, ...enc14(eff), ...enc14(pid), s0, s1, s2, s3, s4, 0x00, 0x00, 0x00, 0x00];
  return [...body, fractalChecksum(body), 0xf7];
}

/** Device-true reverb paramIds — these DIFFER across the gen-3 family. */
export interface VerifyProbeReverbIds {
  /** paramId of reverb Mix (continuous). FM9: 0; III + FM3: 13. */
  mixParamId: number;
  /** paramId of reverb Type (discrete enum). FM9: 10; III + FM3: 0. */
  typeParamId: number;
}

export interface VerifyProbeOptions {
  conn: MidiConnection;
  modelByte: number;
  gridRows: number;
  label: string;
  /** Device-true reverb paramIds, resolved from the device's own catalog. */
  reverbIds: VerifyProbeReverbIds;
  timing?: { pollMs?: number; setMs?: number; queryMs?: number; settleMs?: number };
  log?: (line: string) => void;
  /** Fired once the restore point (active preset number) is known, so the CLI
   *  can reload it on Ctrl-C. Not called if the preset number is unreadable. */
  onRestorePoint?: (presetNumber: number) => void;
}

export interface TestResult { tool: string; status: 'pass' | 'fail' | 'skipped'; detail: string; data?: unknown }

export interface VerifyReport {
  probe: 'gen3-verify-probe';
  version: 2;
  device: string;
  modelByte: number;
  activePreset?: number;
  presetName?: string;
  restoreConfirmed?: boolean;
  note: string;
  summary: { passed: number; failed: number; skipped: number };
  results: TestResult[];
}

export async function runVerifyProbe(opts: VerifyProbeOptions): Promise<VerifyReport> {
  const { conn, modelByte: MODEL, gridRows, label } = opts;
  const { mixParamId: REVERB_MIX_PARAM_ID, typeParamId: REVERB_TYPE_PARAM_ID } = opts.reverbIds;
  const log = opts.log ?? ((): void => {});
  const pollMs = opts.timing?.pollMs ?? POLL_WINDOW_MS;
  const setMs = opts.timing?.setMs ?? SET_ECHO_WINDOW_MS;
  const queryMs = opts.timing?.queryMs ?? QUERY_WINDOW_MS;
  const settleMs = opts.timing?.settleMs ?? SETTLE_MS;

  const inbound: number[][] = [];
  const unsub = conn.onMessage((bytes) => { if (bytes[0] === 0xf0) inbound.push(bytes); });

  const results: TestResult[] = [];
  let activePreset: number | undefined;
  let presetName: string | undefined;
  let restoreConfirmed: boolean | undefined;

  async function sendAndCollect(
    bytes: number[], windowMs: number, doneWhen?: (frames: number[][]) => boolean,
  ): Promise<number[][]> {
    const startLen = inbound.length;
    conn.send(bytes);
    const deadline = Date.now() + windowMs;
    for (;;) {
      const frames = inbound.slice(startLen);
      if (doneWhen && frames.length > 0 && doneWhen(frames)) return frames;
      if (Date.now() >= deadline) return frames;
      await sleep(15);
    }
  }

  async function pollBlock(effectId: number): Promise<{ itemCount: number; values: number[] } | undefined> {
    const frames = await sendAndCollect(
      buildBlockBulkReadPoll(effectId, MODEL), pollMs,
      (fs) => fs.some((f) => isGen3BroadcastFrame(f, 0x76, MODEL)),
    );
    if (!frames.some((f) => isGen3BroadcastFrame(f, 0x74, MODEL))) return undefined;
    try {
      const burst = assembleGen3BlockBulkRead(frames, MODEL);
      return { itemCount: burst.itemCount, values: burst.values };
    } catch {
      return undefined;
    }
  }

  // ── fn=0x13 STATUS_DUMP placement read ───────────────────────────
  // The device's own placed-block list, the ONLY trustworthy placement signal
  // (fn=0x1F polls answer for unplaced blocks too — FM3 fw 12.00 field test,
  // 2026-06-12). Returns undefined when the reply is absent/unparseable so the
  // caller can fall back to poll-based detection instead of bricking the run.
  const isStatusDumpReply = (f: number[]): boolean =>
    f.length >= 8 && f[0] === 0xf0 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74
    && f[4] === MODEL && f[5] === 0x13;

  // Raw bytes of the most recent fn=0x13 STATUS_DUMP reply, so callers can
  // serialize it into the report for byte-level audit (the set_block PASS verdict
  // is otherwise asserted, not provable from the JSON — workflow finding 2026-06-20).
  let lastStatusDumpFrame: number[] | undefined;
  async function readPlacedBlocks(): Promise<Set<number> | undefined> {
    const frames = await sendAndCollect(buildStatusDump(MODEL), queryMs, (fs) => fs.some(isStatusDumpReply));
    const frame = frames.find(isStatusDumpReply);
    if (!frame) { lastStatusDumpFrame = undefined; return undefined; }
    lastStatusDumpFrame = frame;
    // parseStatusDumpResponse is now model-aware (it used to be locked to the
    // III's 0x10 envelope, which forced an inline triple decoder here); use it
    // directly for FM3/FM9 too. Payload is `id_lo id_hi dd` triples.
    try {
      return new Set(parseStatusDumpResponse(frame, MODEL).map((e) => e.effectId));
    } catch {
      return undefined;
    }
  }

  /** Send a SET (caller-built frame), capture any 0x64 reject + 60-byte echo. */
  async function sendSetAndCaptureEcho(
    frame: number[], effectId: number, paramId: number,
  ): Promise<{ rejected: boolean; echo?: { normalizedValue: number } }> {
    const frames = await sendAndCollect(frame, setMs);
    let echo: { normalizedValue: number } | undefined;
    let rejected = false;
    for (const f of frames) {
      if (f[5] === 0x64) { rejected = true; continue; }
      try {
        const e = parseGen3SetValueEcho(f);
        if (e.effectId === effectId && e.paramId === paramId) echo = { normalizedValue: e.normalizedValue };
      } catch { /* not an echo frame */ }
    }
    return { rejected, echo };
  }

  function record(tool: string, status: TestResult['status'], detail: string, data?: unknown): void {
    results.push({ tool, status, detail, data });
    const mark = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'skip';
    log(`  [${mark}] ${tool}: ${detail}`);
  }

  // One continuous-form sub-test: set reverb.mix to `targetWire`, read it back,
  // and judge. `form` is the human label; `frame` the bytes to send.
  async function continuousFormTest(form: string, frame: number[], targetWire: number, origMix: number): Promise<void> {
    const { rejected, echo } = await sendSetAndCaptureEcho(frame, REVERB_EFFECT_ID, REVERB_MIX_PARAM_ID);
    await sleep(settleMs);
    const after = await pollBlock(REVERB_EFFECT_ID);
    const readBack = after?.values[REVERB_MIX_PARAM_ID];
    // /65534 (NOT /65535): the shipped codec normalizes wire/65534 (see
    // fractal-gen3 writer.ts), so the probe frame is byte-identical to a
    // shipped set_param frame for the same wire value.
    const expectedNorm = targetWire / 65534;
    const echoMatches = echo !== undefined && Math.abs(echo.normalizedValue - expectedNorm) < 0.02;
    const readMatches = readBack !== undefined && Math.abs(readBack - targetWire) <= 256;
    const data = { form, sentWire: targetWire, echoNormalized: echo?.normalizedValue, expectedNorm, readBackWire: readBack, origWire: origMix };
    const tool = `set_param continuous (reverb.mix, ${form})`;
    if (rejected) {
      record(tool, 'fail', `device REJECTED the ${form} SET with a 0x64. This wire shape is not accepted for a continuous param.`, data);
    } else if (readMatches) {
      record(tool, 'pass', `wrote ${targetWire}, read back ${readBack}` + (echo ? `, echoed ${echo.normalizedValue.toFixed(4)} (expected ~${expectedNorm.toFixed(4)})` : ' (no value-echo)') + '. This form lands.', data);
    } else if (echoMatches) {
      record(tool, 'pass', `device echoed ${echo!.normalizedValue.toFixed(4)} (expected ~${expectedNorm.toFixed(4)}); read-back ${readBack ?? 'n/a'}. Echo confirms the value.`, data);
    } else {
      record(tool, 'fail', `wrote ${targetWire}, read back ${readBack ?? 'no response'}, echo ${echo?.normalizedValue.toFixed(4) ?? 'none'} (expected ~${expectedNorm.toFixed(4)}). This form was not applied.`, data);
    }
    // Restore the original mix (52 00 float form) before the next sub-test.
    await sendSetAndCaptureEcho(buildDragSetFloat(REVERB_EFFECT_ID, REVERB_MIX_PARAM_ID, origMix / 65534, MODEL), REVERB_EFFECT_ID, REVERB_MIX_PARAM_ID);
    await sleep(settleMs);
  }

  async function runWriteTests(): Promise<void> {
    // Placement ground truth: the 0x13 status dump. A poll answer is NOT
    // placement evidence (unplaced blocks answer fn=0x1F polls — FM3 field
    // test 2026-06-12, where reverb writes wire-acked against an unplaced
    // block and were inaudible).
    const placed = await readPlacedBlocks();
    if (placed === undefined) {
      record('status_dump (fn=0x13) placement read', 'skipped',
        'no parseable fn=0x13 STATUS_DUMP reply; falling back to fn=0x1F poll-answer placement '
        + 'detection, which the FM3 field test (fw 12.00, 2026-06-12) proved can false-positive '
        + '(unplaced blocks answer polls). Treat the reverb/set_block verdicts with caution.');
    }

    const reverbPlaced = placed !== undefined
      ? placed.has(REVERB_EFFECT_ID)
      : (await pollBlock(REVERB_EFFECT_ID)) !== undefined;
    // pollBlock stays the VALUE read-back (the 0x13 dump carries no param values).
    const reverb = reverbPlaced ? await pollBlock(REVERB_EFFECT_ID) : undefined;
    if (!reverbPlaced) {
      record('set_param/set_bypass (reverb tests)', 'skipped',
        'Reverb 1 (effect 66) is not in the device\'s 0x13 placed-block list. Writes to an '
        + 'unplaced block are wire-acked but INAUDIBLE (FM3 field test 2026-06-12), so the test '
        + 'would prove nothing. Load a preset that contains a Reverb block, then re-run.');
    } else if (reverb === undefined) {
      record('set_param/set_bypass (reverb tests)', 'skipped',
        'Reverb 1 (effect 66) is placed per the 0x13 status dump, but the fn=0x1F bulk read of its '
        + 'values failed, so the original mix value cannot be captured/restored. Re-run; if it '
        + 'persists, check nothing else is holding the MIDI port.');
    } else {
      const origMix = reverb.values[REVERB_MIX_PARAM_ID] ?? 0;
      const target = origMix < 32768 ? 49152 : 16384;

      // T1 (HEADLINE): a continuous param SET is sub 52 00 + float32(normalized
      // = wire/65534) at pos 12 — the same form shipped set_param emits for a
      // continuous param and the same FM9-Edit emits for a knob drag. (The
      // retired 09 00 packValue16-int form is gone; it was never the wire.)
      await continuousFormTest('52 00 float (shipped continuous set_param form)', buildDragSetFloat(REVERB_EFFECT_ID, REVERB_MIX_PARAM_ID, target / 65534, MODEL), target, origMix);

      // T2: set_param ENUM (discrete) round-trip on Reverb Type. Sends
      // float32(ordinal 45) at pos 12 (sub 09 00) and reads the ordinal back.
      // Not individually restored (we lack the original type ordinal); the
      // end-of-probe reload is the restore for this and the bypass/scene tests.
      const enumRes = await sendSetAndCaptureEcho(buildSetParameter(REVERB_EFFECT_ID, REVERB_TYPE_PARAM_ID, REVERB_TYPE_GROUND_TRUTH.ordinal, MODEL), REVERB_EFFECT_ID, REVERB_TYPE_PARAM_ID);
      await sleep(settleMs);
      const afterType = await pollBlock(REVERB_EFFECT_ID);
      const typeOrdinal = afterType?.values[REVERB_TYPE_PARAM_ID];
      const enumData = { sentOrdinal: REVERB_TYPE_GROUND_TRUTH.ordinal, expectedOrdinal: REVERB_TYPE_GROUND_TRUTH.ordinal, readBackOrdinal: typeOrdinal };
      if (enumRes.rejected) {
        record('set_param (enum, reverb.type)', 'fail', 'device REJECTED the discrete SET (0x64).', enumData);
      } else if (typeOrdinal === REVERB_TYPE_GROUND_TRUTH.ordinal) {
        record('set_param (enum, reverb.type)', 'pass', `set ordinal ${REVERB_TYPE_GROUND_TRUTH.ordinal} ("${REVERB_TYPE_GROUND_TRUTH.name}"), read back ${typeOrdinal}. Discrete float32(ordinal) SET lands (non-power-of-2 → proves the corrected wire).`, enumData);
      } else {
        record('set_param (enum, reverb.type)', 'fail', `set ordinal ${REVERB_TYPE_GROUND_TRUTH.ordinal}, read back ${typeOrdinal ?? 'no response'}.`, enumData);
      }

      // T3: set_bypass round-trip (toggle bypassed then re-engage). Bypass state
      // is not in the bulk-read body, so we can only confirm "no rejection".
      const byp1 = await sendAndCollect(buildSetBypass(REVERB_EFFECT_ID, true, MODEL), setMs);
      await sleep(settleMs);
      await sendAndCollect(buildSetBypass(REVERB_EFFECT_ID, false, MODEL), setMs);
      const bypRejected = byp1.some((f) => f[5] === 0x64);
      record('set_bypass (reverb)', bypRejected ? 'fail' : 'pass',
        bypRejected ? 'device REJECTED the bypass write (0x64).' : 'bypass toggle accepted (no 0x64). Confirm audibly: the reverb should have muted then returned.');
    }

    // T4: switch_scene (to scene 2, query active scene, return to scene 1). The
    // end-of-probe reload restores the preset's saved active scene.
    const sceneReply = await sendAndCollect(buildSetScene(1, MODEL), queryMs);
    await sleep(settleMs);
    const sceneQuery = await sendAndCollect(buildGetScene(MODEL), queryMs);
    await sendAndCollect(buildSetScene(0, MODEL), queryMs);
    const sceneRejected = sceneReply.some((f) => f[5] === 0x64);
    const sceneEcho = sceneQuery.find((f) => f[5] === 0x0c);
    const sceneByte = sceneEcho?.[6];
    const sceneApplied = sceneByte === 1; // we set wire scene 1 (display scene 2)
    record('switch_scene', sceneRejected ? 'fail' : (sceneEcho && !sceneApplied ? 'fail' : 'pass'),
      sceneRejected ? 'device REJECTED switch_scene (0x64).'
        : sceneEcho ? `set wire scene 1; active-scene query read back ${sceneByte}${sceneApplied ? ' (matches)' : ' (MISMATCH)'}.`
          : 'accepted (no 0x64); scene-query reply not observed, so application is unconfirmed.',
      { sceneQueryReply: sceneQuery.map(toHex) });

    // T5: set_block. Only run if our test cell's block type (Drive) is NOT
    // already placed, so we never clear a block the user already had. Placement
    // is judged by the 0x13 placed-block list both BEFORE (skip detection) and
    // AFTER (did the insert land?) — a fn=0x1F poll answers even for unplaced
    // blocks, so it can neither detect a pre-existing Drive nor confirm the
    // placement (FM3 field test 2026-06-12). Poll fallback only when 0x13 is
    // unavailable. Place a Drive, confirm via a FRESH 0x13, then clear it; the
    // end-of-probe reload is the backstop.
    const drivePlacedBefore = placed !== undefined
      ? placed.has(DRIVE_EFFECT_ID)
      : (await pollBlock(DRIVE_EFFECT_ID)) !== undefined;
    if (drivePlacedBefore) {
      record('set_block', 'skipped', 'a Drive block is already in this preset (per the 0x13 status dump), so the placement test would risk clearing it. Load a preset without a Drive to test set_block.');
    } else {
      const cell = { row: 1, col: gridRows === 6 ? 14 : 12, rows: gridRows };
      const insertFrame = buildSetGridCell({ ...cell, blockId: DRIVE_EFFECT_ID }, MODEL);
      const placeReply = await sendAndCollect(insertFrame, setMs);
      await sleep(settleMs);
      const placedAfter = await readPlacedBlocks();
      // Capture the post-placement 0x13 status dump raw bytes so the PASS verdict
      // is byte-auditable from the report, not just asserted (workflow 2026-06-20).
      const statusDumpAfter = lastStatusDumpFrame ? toHex(lastStatusDumpFrame) : undefined;
      const drivePresent = placedAfter !== undefined
        ? placedAfter.has(DRIVE_EFFECT_ID)
        : (await pollBlock(DRIVE_EFFECT_ID)) !== undefined;
      if (drivePresent) await sendAndCollect(buildSetGridCell({ ...cell, blockId: 0 }, MODEL), setMs); // clear only what we placed
      const placeRejected = placeReply.some((f) => f[5] === 0x64);
      const confirmSource = placedAfter !== undefined ? 'the 0x13 status dump' : 'a poll (0x13 unavailable — weak evidence)';
      record('set_block', placeRejected ? 'fail' : (drivePresent ? 'pass' : 'fail'),
        placeRejected ? 'device REJECTED set_block (0x64).'
          : drivePresent ? `placed Drive at r${cell.row}c${cell.col} and ${confirmSource} then listed it. Block placement lands.` : `sent the insert but ${confirmSource} did not list a Drive (cell may have been occupied, or placement was not applied).`,
        {
          cell,
          // Byte-auditable evidence: the insert frame we sent, any reply to it,
          // and the post-placement 0x13 status dump that lists (or doesn't) the
          // Drive. Lets the verdict be re-derived from the report, not trusted.
          insert_frame: toHex(insertFrame),
          insert_reply: placeReply.map((f) => toHex(f)),
          status_dump_after: statusDumpAfter,
        });
    }

    record('save_preset', 'skipped',
      'not auto-tested (it would overwrite a preset on your device). To verify manually: make a change, save to an EMPTY location, and confirm it persists after a power cycle.');
  }

  // Read the active preset number BEFORE any write, then re-read after the reload.
  async function readActivePreset(): Promise<{ number: number; name: string } | undefined> {
    const frames = await sendAndCollect(buildQueryPatchName('current', MODEL), queryMs);
    const frame = frames.find((f) => isQueryPatchNameResponse(f, MODEL));
    if (!frame) return undefined;
    try {
      const p = parseQueryPatchNameResponse(frame, MODEL);
      return { number: p.presetNumber, name: p.name };
    } catch { return undefined; }
  }

  try {
    // Cold-start resend: this is the FIRST wire transaction of the whole probe
    // run, and a freshly-opened USB-MIDI handle frequently drops the very
    // first outbound transaction during driver warm-up (same class as the
    // AM4 cold-start resend in am4/src/shared/wireOps.ts sendAndAwaitAck).
    // Direct evidence is the issue #18 report's own contrast, same session/
    // rig: this probe sent 0x0D ALONE as message #1 and got nothing, while
    // gen3-readback-probe's job0 sent an (always-unanswered) identity request
    // FIRST and 0x0D as message #2, which landed. An independent 2026-06-19
    // capture shows the same message-POSITION pattern (0x0D as message #2
    // succeeding), consistent with but not separate proof of cold-start on
    // its own — the identity request going unanswered doesn't by itself rule
    // out "the FM9 just never answers identity requests," so the message-1-
    // vs-message-2 contrast in the #18 report is what's load-bearing here.
    // Retry once, same open handle, before giving up.
    let start = await readActivePreset();
    if (start === undefined) start = await readActivePreset();
    if (start === undefined) {
      log('\nCould not read the active preset number; a safe restore point cannot be established.');
      log('Skipping all WRITE tests (read-only run). Close the editor, connect the device, re-run.');
      record('restore_point', 'skipped', 'active preset number unreadable; write tests skipped for safety.');
    } else {
      activePreset = start.number;
      presetName = start.name;
      opts.onRestorePoint?.(activePreset);
      log(`\nRestore point: preset ${activePreset}${presetName ? ` "${presetName.trim()}"` : ''}. Running write tests...\n`);
      try {
        await runWriteTests();
      } finally {
        // Master undo: reload the active preset to discard the working buffer,
        // then confirm we landed back on it. Uses the SysEx-native fn=0x01
        // sub=0x27 switch (full 14-bit preset number, FM3-hardware-confirmed)
        // instead of MIDI Program Change — PC is 7-bit and the FM3 ignores
        // CC32 Bank Select, so a PC restore of preset >127 landed on
        // preset mod 128 (FM3 fw 12.00 field test, 2026-06-12).
        conn.send(buildSwitchPresetSysEx(activePreset, MODEL));
        // A preset SWITCH loads a whole preset from flash, which takes longer
        // than a param write settles — give it 3× the param-write settle before
        // the confirmation re-read (the re-read's own query window then adds
        // its full timeout on top).
        await sleep(settleMs * 3);
        const back = await readActivePreset();
        restoreConfirmed = back?.number === activePreset;
        if (restoreConfirmed) {
          log(`\nReloaded preset ${activePreset} to discard all probe changes.`);
        } else {
          record('restore_check', 'fail', `after the restore switch (SysEx sub=0x27), the active preset read back as ${back?.number ?? 'unknown'}, not ${activePreset}. Manually reload preset ${activePreset} to discard the probe's working-buffer changes.`);
          log(`\nWARNING: could not confirm the reload. Manually reload preset ${activePreset} on the device.`);
        }
      }
    }
  } finally {
    unsub();
  }

  return {
    probe: 'gen3-verify-probe',
    version: 2,
    device: label,
    modelByte: MODEL,
    activePreset,
    presetName: presetName?.trim(),
    restoreConfirmed,
    note: 'WRITE-VERIFY round-trip. Never saves; reloads the active preset at the end (SysEx sub=0x27 switch — full 14-bit preset number) to discard changes. Reverb paramIds are resolved from the device-true catalog (they differ across the gen-3 family). Block placement is gated on the fn=0x13 STATUS_DUMP placed-block list, not on poll answers (unplaced blocks answer fn=0x1F polls — FM3 field test 2026-06-12). v2 fixes the FM3 field-test bugs: PC-restore 7-bit truncation and FM9-shaped hardcoded paramIds.',
    summary: {
      passed: results.filter((r) => r.status === 'pass').length,
      failed: results.filter((r) => r.status === 'fail').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
    },
    results,
  };
}
