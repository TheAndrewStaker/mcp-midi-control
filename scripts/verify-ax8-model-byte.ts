#!/usr/bin/env tsx
/**
 * BK-094: AX8 config goldens.
 *
 * The AX8 (Fractal AX8, model byte 0x08) reuses the Axe-Fx II gen-2 codec
 * with its own `AxeFxIIConfig` (`packages/fractal-gen2/src/configs/ax8.ts`).
 * No AX8 hardware is on hand; these are offline structural goldens that lock
 * the three load-bearing claims of the config-factory refactor:
 *
 *   1. Model-byte parameterization: an AX8 frame differs from the XL+'s
 *      ONLY at the wire model-byte position (index 4); every other byte,
 *      including the checksum, is identical for the same logical write.
 *   2. Block-availability filter: AX8 refuses to address a block instance
 *      the physical unit lacks (Amp 2 / Reverb 2 / etc, per
 *      `blockTypes.ts`'s `availableOnAX8`), where the XL+ (unfiltered)
 *      succeeds on the exact same call.
 *   3. apply_preset / apply_setlist model-byte threading (BK-GEN2-FACTORY
 *      follow-up): the shared build pipeline (`tools/applyExecutor.ts`) is
 *      model-byte-parameterized. An apply_preset plan executed against the
 *      AX8 descriptor emits ONLY frames with model byte 0x08 at index 4
 *      (envelope F0 00 01 74 08 ...) and never 0x07, including the runtime
 *      reads/verifies (grid read, safety mute, channel + scene verify).
 *      The XL+ stays byte-identical (all-0x07). The AX8's former gate on
 *      these two ops is removed; a spec addressing a block instance the
 *      AX8 lacks refuses at build time instead (availability filter).
 *
 * Also locks the independently-surfaced AX8 capture cited in
 * `configs/ax8.ts` / `docs/_private/AX8-RESEARCH-2026-07-09.md`: the wire
 * example `F0 00 01 74 08 14 00 00 19 F7` (fn=0x14 GET_PRESET_NUMBER
 * response) checksum-validates against this codec's own XOR-&0x7F formula:
 * self-validating evidence for the 0x08 model byte, independent of anything
 * already in this repo's own tables.
 *
 * Run: npx tsx scripts/verify-ax8-model-byte.ts
 */

import { fractalChecksum } from 'fractal-midi/shared';
import { AXE_FX_II_XL_PLUS_MODEL_ID } from 'fractal-midi/gen2/axe-fx-ii';

import { createWriter } from '../packages/fractal-gen2/src/descriptor/writer.js';
import { createReader } from '../packages/fractal-gen2/src/descriptor/reader.js';
import { createAxeFxIIDescriptor } from '../packages/fractal-gen2/src/descriptor.js';
import { AXE_FX_II_XL_PLUS_CONFIG } from '../packages/fractal-gen2/src/configs/xl-plus.js';
import { AX8_CONFIG } from '../packages/fractal-gen2/src/configs/ax8.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

// ─── Section 0: independently-surfaced AX8 capture is checksum-valid ──────
console.log('\nSection 0: independently-surfaced AX8 capture checksum-validates');
{
  // F0 00 01 74 08 14 00 00 19 F7: fn=0x14 GET_PRESET_NUMBER response,
  // model byte 0x08, surfaced via community/forum search independent of
  // this repo's own MODEL_IDS / SYSEX-MAP.md tables (see configs/ax8.ts).
  const capture = [0xf0, 0x00, 0x01, 0x74, 0x08, 0x14, 0x00, 0x00];
  const expectedCs = 0x19;
  const computedCs = fractalChecksum(capture);
  check(
    'AX8 capture frame checksum matches this codec\'s XOR-&0x7F formula',
    computedCs === expectedCs,
    `computed 0x${computedCs.toString(16)}, capture byte 0x${expectedCs.toString(16)}`,
  );
  check('capture model byte (index 4) is 0x08', capture[4] === 0x08);
}

// ─── Section 1: model-byte parameterization ───────────────────────────────
console.log('\nSection 1: AX8 frames differ from XL+ ONLY at the model-byte position');
{
  const xlWriter = createWriter(AXE_FX_II_XL_PLUS_CONFIG);
  const ax8Writer = createWriter(AX8_CONFIG);

  function diffOnlyAtModelByte(xl: number[], ax8: number[], label: string): void {
    check(`${label}: same length`, xl.length === ax8.length, `xl=${xl.length} ax8=${ax8.length}`);
    const diffIdx: number[] = [];
    for (let i = 0; i < Math.max(xl.length, ax8.length); i++) {
      if (xl[i] !== ax8[i]) diffIdx.push(i);
    }
    // The model byte (index 4) is the DIRECT wire-affecting difference. The
    // checksum byte (second-to-last, index len-2) is XOR'd over the WHOLE
    // frame including the model byte, so it ALSO legitimately differs; this
    // is expected checksum recomputation, not a leak. Every OTHER byte
    // (envelope prefix, function byte, payload) must be byte-identical.
    const csIdx = xl.length - 2;
    check(
      `${label}: differs at exactly [4 (model byte), ${csIdx} (checksum)]`,
      diffIdx.length === 2 && diffIdx[0] === 4 && diffIdx[1] === csIdx,
      `diff indices: [${diffIdx.join(', ')}] xl=[${xl.map((b) => b.toString(16)).join(' ')}] ax8=[${ax8.map((b) => b.toString(16)).join(' ')}]`,
    );
    check(`${label}: XL+ frame carries model byte 0x07`, xl[4] === AXE_FX_II_XL_PLUS_MODEL_ID);
    check(`${label}: AX8 frame carries model byte 0x08`, ax8[4] === 0x08);
  }

  diffOnlyAtModelByte(
    xlWriter.buildSetParam('amp', 'input_drive', 32767),
    ax8Writer.buildSetParam('amp', 'input_drive', 32767),
    'buildSetParam(amp.input_drive)',
  );
  diffOnlyAtModelByte(
    xlWriter.buildSwitchPreset!(5),
    ax8Writer.buildSwitchPreset!(5),
    'buildSwitchPreset(5)',
  );
  diffOnlyAtModelByte(
    xlWriter.buildSavePreset!(5),
    ax8Writer.buildSavePreset!(5),
    'buildSavePreset(5)',
  );
  diffOnlyAtModelByte(
    xlWriter.buildSwitchScene!(3),
    ax8Writer.buildSwitchScene!(3),
    'buildSwitchScene(3)',
  );
  // Checksum recomputation: since only the model byte moved, the checksum
  // byte (second-to-last) MUST also differ (XOR is byte-position-sensitive):
  // confirms the diff isn't accidentally re-using a stale checksum.
  const xlBytes = xlWriter.buildSetParam('reverb', 'mix', 100);
  const ax8Bytes = ax8Writer.buildSetParam('reverb', 'mix', 100);
  check(
    'checksum byte recomputed (not stale) when model byte changes',
    xlBytes[xlBytes.length - 2] !== ax8Bytes[ax8Bytes.length - 2],
    `xl cs=0x${xlBytes[xlBytes.length - 2].toString(16)} ax8 cs=0x${ax8Bytes[ax8Bytes.length - 2].toString(16)}`,
  );
}

// ─── Section 2: block-availability filter ─────────────────────────────────
console.log('\nSection 2: AX8 refuses a block instance the physical unit lacks (Amp 2)');
{
  const xlWriter = createWriter(AXE_FX_II_XL_PLUS_CONFIG);
  const ax8Writer = createWriter(AX8_CONFIG);
  const ax8Reader = createReader(AX8_CONFIG);

  let xlThrew = false;
  try {
    xlWriter.buildSetParam('Amp 2', 'input_drive', 32767);
  } catch {
    xlThrew = true;
  }
  check('XL+ succeeds addressing "Amp 2" (unfiltered, every block present)', !xlThrew);

  let ax8Threw: unknown;
  try {
    ax8Writer.buildSetParam('Amp 2', 'input_drive', 32767);
  } catch (err) {
    ax8Threw = err;
  }
  check('AX8 refuses addressing "Amp 2" (availableOnAX8: false)', ax8Threw instanceof Error);
  check(
    'AX8 refusal message names the device + the missing block',
    ax8Threw instanceof Error && /Amp 2/.test(ax8Threw.message) && /Fractal AX8/.test(ax8Threw.message),
    ax8Threw instanceof Error ? ax8Threw.message : String(ax8Threw),
  );

  // Amp 1 (instance 1, available on AX8) still resolves fine on both.
  let ax8Amp1Threw = false;
  try {
    ax8Writer.buildSetParam('amp', 'input_drive', 32767);
  } catch {
    ax8Amp1Threw = true;
  }
  check('AX8 still accepts "amp" (Amp 1, available)', !ax8Amp1Threw);

  // describe_device's block_types surface: AX8 should NOT advertise "amp 2"
  // / "reverb 2" as a placeable block_type; XL+ should.
  const xlDescriptor = createAxeFxIIDescriptor(AXE_FX_II_XL_PLUS_CONFIG);
  const ax8Descriptor = createAxeFxIIDescriptor(AX8_CONFIG);
  check('XL+ block_types advertises "amp 2"', 'amp 2' in xlDescriptor.block_types!);
  check('AX8 block_types does NOT advertise "amp 2"', !('amp 2' in ax8Descriptor.block_types!));
  check('AX8 block_types still advertises "amp 1"', 'amp 1' in ax8Descriptor.block_types!);
  void ax8Reader; // reader shares the identical resolver path; covered structurally above
}

// ─── Section 3: apply pipeline model-byte threading (former gate removed) ──
console.log('\nSection 3: apply_preset / apply_setlist emit ONLY this config\'s model byte');

/**
 * Mock DispatchCtx.conn that records every sent frame and fabricates
 * device responses stamped with the given model byte (the same shapes a
 * real device would return). Adapted from verify-grid-routing.ts's mock,
 * extended with block-param (safety mute), block-channel, and scene
 * responses so the writer's full applyPreset pipeline runs end-to-end.
 * All fabricated responses carry `modelByte` at index 4, so this ALSO
 * exercises the executor's model-byte-threaded matchers + parsers: were
 * they still locked to the XL+ default, every verify would time out.
 */
function createModelByteMockConn(modelByte: number): { conn: DispatchCtx['conn']; sentFrames: number[][] } {
  const sentFrames: number[][] = [];
  let pendingPredicate: ((bytes: number[]) => boolean) | null = null;
  let pendingResolve: ((bytes: number[]) => void) | null = null;

  const FN_MULTI = 0x64;
  const FN_PARAM = 0x02;        // fn 0x02 GET (query) — enum SETs share the fn but are fire-and-forget
  const FN_PARAM_DIRECT = 0x2e; // continuous SET (display float)
  const FN_GRID_CELL = 0x05;
  const FN_CELL_ROUTING = 0x06;
  const FN_CHANNEL = 0x11;
  const FN_STORE = 0x1d;
  const FN_GRID = 0x20;
  const FN_SCENE = 0x29;

  // Device state the fabrications echo back.
  let outputSetCount = 0;                 // fn 0x2e SETs seen on Output (effectId 140)
  let lastScene = 0;                      // last fn 0x29 SET value (wire 0..7)
  const chanByEffect = new Map<number, number>(); // fn 0x11 SET action=1

  function fabricate(sent: number[]): number[] | undefined {
    if (sent[0] !== 0xf0 || sent[5] === undefined) return undefined;
    const fn = sent[5];
    if (fn === FN_GRID) {
      const bytes = [0xf0, 0x00, 0x01, 0x74, modelByte, FN_GRID];
      for (let c = 0; c < 48; c++) bytes.push(0x00, 0x00, 0x00, 0x00);
      bytes.push(0x00, 0xf7);
      return bytes;
    }
    if (fn === FN_GRID_CELL) return [0xf0, 0x00, 0x01, 0x74, modelByte, FN_MULTI, FN_GRID_CELL, 0x00, 0x00, 0xf7];
    if (fn === FN_CELL_ROUTING) return [0xf0, 0x00, 0x01, 0x74, modelByte, FN_MULTI, FN_CELL_ROUTING, 0x00, 0x00, 0xf7];
    if (fn === FN_STORE) return [0xf0, 0x00, 0x01, 0x74, modelByte, FN_MULTI, FN_STORE, 0x00, 0x00, 0xf7];
    if (fn === FN_PARAM) {
      // Only the safety-mute GET awaits a fn 0x02 response (enum SETs are
      // fire-and-forget, so no predicate is pending when they go out).
      // Echo effectId/paramId; label = current Output level per SET count.
      const label = outputSetCount === 1 ? '-80.0' : '0.0';
      const bytes = [0xf0, 0x00, 0x01, 0x74, modelByte, FN_PARAM, sent[6], sent[7], sent[8], sent[9], 0, 0, 0, 0, 0, 0, 0, 0];
      for (const ch of label) bytes.push(ch.charCodeAt(0));
      bytes.push(0x00, 0x00, 0xf7);
      return bytes;
    }
    if (fn === FN_CHANNEL && sent[9] === 0x00) {
      // GET: echo the recorded channel (SETs are recorded in send()).
      const eff = (sent[6] & 0x7f) | ((sent[7] & 0x7f) << 7);
      return [0xf0, 0x00, 0x01, 0x74, modelByte, FN_CHANNEL, sent[6], sent[7], chanByEffect.get(eff) ?? 0, 0x00, 0xf7];
    }
    if (fn === FN_SCENE && (sent[6] & 0x7f) === 0x7f) {
      // 0x7F sentinel = scene query; SETs are recorded in send().
      return [0xf0, 0x00, 0x01, 0x74, modelByte, FN_SCENE, lastScene, 0x00, 0xf7];
    }
    return undefined;
  }

  const conn: DispatchCtx['conn'] = {
    send(bytes: number[]): void {
      sentFrames.push([...bytes]);
      // Device-state tracking runs on EVERY send (fire-and-forget SETs
      // arrive with no receive pending, but must still mutate state).
      if (bytes[0] === 0xf0) {
        if (bytes[5] === FN_PARAM_DIRECT) {
          const eff = (bytes[6] & 0x7f) | ((bytes[7] & 0x7f) << 7);
          if (eff === 140) outputSetCount++;
        } else if (bytes[5] === FN_CHANNEL && bytes[9] === 0x01) {
          const eff = (bytes[6] & 0x7f) | ((bytes[7] & 0x7f) << 7);
          chanByEffect.set(eff, bytes[8] & 0x7f);
        } else if (bytes[5] === FN_SCENE && (bytes[6] & 0x7f) <= 0x07) {
          lastScene = bytes[6] & 0x7f;
        }
      }
      if (pendingPredicate && pendingResolve) {
        const fab = fabricate(bytes);
        if (fab !== undefined && pendingPredicate(fab)) {
          const resolve = pendingResolve;
          pendingPredicate = null;
          pendingResolve = null;
          queueMicrotask(() => resolve(fab));
        }
      }
    },
    receiveSysEx(): Promise<number[]> {
      return Promise.reject(new Error('mock conn: receiveSysEx not implemented'));
    },
    receiveSysExMatching(predicate: (bytes: number[]) => boolean, timeoutMs?: number): Promise<number[]> {
      return new Promise<number[]>((resolve, reject) => {
        pendingPredicate = predicate;
        pendingResolve = resolve;
        const timer = setTimeout(() => {
          if (pendingResolve === resolve) {
            pendingPredicate = null;
            pendingResolve = null;
            reject(new Error('mock conn: no matching response within timeout'));
          }
        }, timeoutMs ?? 2000);
        timer.unref?.();
      });
    },
    onMessage(): () => void {
      return () => {};
    },
    hasInput: true,
    close(): void {},
  };
  return { conn, sentFrames };
}

function frameModelBytes(frames: number[][]): Set<number> {
  const seen = new Set<number>();
  for (const f of frames) {
    if (f[0] === 0xf0 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74) seen.add(f[4]);
  }
  return seen;
}

{
  const ax8Writer = createWriter(AX8_CONFIG);
  const xlWriter = createWriter(AXE_FX_II_XL_PLUS_CONFIG);
  const ax8Descriptor = createAxeFxIIDescriptor(AX8_CONFIG);
  // The AX8 config's own example_spec: drive/amp/cab/reverb, X+Y amp
  // params (channel verifies), 2 scenes (scene walk + landing verify),
  // continuous + enum params (fn 0x2e + fn 0x02 + safety mute). Every
  // block in it is AX8-available, and it is also valid on the XL+.
  const spec = ax8Descriptor.example_spec!;

  // AX8, working-buffer applyPreset: full pipeline, all frames 0x08.
  {
    const { conn, sentFrames } = createModelByteMockConn(0x08);
    const ctx = { conn } as unknown as DispatchCtx;
    let result: Awaited<ReturnType<NonNullable<typeof ax8Writer.applyPreset>>> | undefined;
    let threw: unknown;
    try {
      result = await ax8Writer.applyPreset!(ctx, spec);
    } catch (err) {
      threw = err;
    }
    check(
      'AX8 apply_preset no longer refuses (gate removed)',
      threw === undefined && result !== undefined,
      threw instanceof Error ? threw.message : String(threw),
    );
    check('AX8 apply_preset returns ok:true against the mock device', result?.ok === true, JSON.stringify(result));
    const models = frameModelBytes(sentFrames);
    check(
      `AX8 apply_preset emitted ONLY model byte 0x08 across ${sentFrames.length} frames (incl. grid read, safety mute, channel/scene verifies)`,
      models.size === 1 && models.has(0x08),
      `model bytes seen: [${[...models].map((m) => `0x${m.toString(16)}`).join(', ')}]`,
    );
    check('AX8 apply_preset never emitted the XL+\'s 0x07', !models.has(0x07));
    check(`AX8 apply_preset exercised a real op stream (${sentFrames.length} frames)`, sentFrames.length > 20, `${sentFrames.length} frames`);
  }

  // XL+ control run: byte-identical behavior, all frames 0x07.
  {
    const { conn, sentFrames } = createModelByteMockConn(0x07);
    const ctx = { conn } as unknown as DispatchCtx;
    const result = await xlWriter.applyPreset!(ctx, spec);
    const models = frameModelBytes(sentFrames);
    check('XL+ apply_preset still emits ONLY 0x07 (byte-identical control run)', models.size === 1 && models.has(0x07),
      `model bytes seen: [${[...models].map((m) => `0x${m.toString(16)}`).join(', ')}]`);
    check('XL+ apply_preset ok:true against the mock device', result.ok === true, JSON.stringify(result));
  }

  // AX8 apply_setlist (save path incl. switch_preset head + STORE tail).
  {
    const { conn, sentFrames } = createModelByteMockConn(0x08);
    const ctx = { conn } as unknown as DispatchCtx;
    const setlistSpec = { name: 'AX8 Setlist', slots: [{ slot: { row: 2, col: 1 }, block_type: 'drive' }] };
    let threw: unknown;
    let result: Awaited<ReturnType<NonNullable<typeof ax8Writer.applySetlist>>> | undefined;
    try {
      result = await ax8Writer.applySetlist!(ctx, [{ location: 5, spec: setlistSpec }]);
    } catch (err) {
      threw = err;
    }
    check(
      'AX8 apply_setlist no longer refuses (gate removed)',
      threw === undefined && result !== undefined,
      threw instanceof Error ? threw.message : String(threw),
    );
    check('AX8 apply_setlist applied 1/1 against the mock device', result?.ok === true && result?.applied === 1, JSON.stringify(result));
    const models = frameModelBytes(sentFrames);
    check(
      'AX8 apply_setlist emitted ONLY model byte 0x08 (incl. LOAD_PRESET head + STORE_PRESET tail)',
      models.size === 1 && models.has(0x08),
      `model bytes seen: [${[...models].map((m) => `0x${m.toString(16)}`).join(', ')}]`,
    );
  }

  // Availability filter inside the apply pipeline: an AX8 spec addressing
  // "Amp 2" refuses at build time, BEFORE any wire I/O.
  {
    const { conn, sentFrames } = createModelByteMockConn(0x08);
    const ctx = { conn } as unknown as DispatchCtx;
    const badSpec = { name: 'No Amp 2', slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp 2' }] };
    const result = await ax8Writer.applyPreset!(ctx, badSpec);
    check('AX8 apply_preset refuses a spec with "Amp 2" (availableOnAX8: false)', result.ok === false, JSON.stringify(result));
    check(
      'refusal names the missing block + device (build-time, structured failed_step)',
      /Amp 2/.test(result.failed_step?.error ?? '') && /Fractal AX8/.test(result.failed_step?.error ?? ''),
      result.failed_step?.error,
    );
    check('refusal happened before any wire I/O', sentFrames.length === 0, `${sentFrames.length} frames sent`);
  }

  // set_bypass stays un-gated (regression from the old allowlist wording).
  {
    const { conn } = createModelByteMockConn(0x08);
    const ctx = { conn } as unknown as DispatchCtx;
    let setBypassGated = false;
    try {
      await ax8Writer.setBypass!(ctx, 'amp', true);
    } catch (err) {
      if (err instanceof Error && /GATED/.test(err.message)) setBypassGated = true;
    }
    check('AX8 set_bypass is not gated', !setBypassGated);
  }
}

// ─── Section 4: registry coexistence ──────────────────────────────────────
console.log('\nSection 4: XL+ and AX8 descriptors coexist without port_match collision');
{
  const xlDescriptor = createAxeFxIIDescriptor(AXE_FX_II_XL_PLUS_CONFIG);
  const ax8Descriptor = createAxeFxIIDescriptor(AX8_CONFIG);
  check('XL+ descriptor id is "axe-fx-ii"', xlDescriptor.id === 'axe-fx-ii');
  check('AX8 descriptor id is "ax8"', ax8Descriptor.id === 'ax8');
  check('XL+ model byte (capabilities.verification) mentions 0x07', /0x07/.test(xlDescriptor.capabilities.verification ?? ''));
  check('AX8 model byte (capabilities.verification) mentions 0x08', /0x08/.test(ax8Descriptor.capabilities.verification ?? ''));
  check('AX8 support_tier is community-beta', ax8Descriptor.capabilities.support_tier === 'community-beta');
  check('XL+ support_tier is verified', xlDescriptor.capabilities.support_tier === 'verified');

  const ax8PortMatch = ax8Descriptor.port_match[0].pattern as RegExp;
  const xlPortMatch = xlDescriptor.port_match[0].pattern as RegExp;
  check('AX8 port name "Fractal AX8" matches AX8 pattern', ax8PortMatch.test('Fractal AX8'));
  check('AX8 port name does NOT match the XL+\'s /axe-?fx/i pattern', !xlPortMatch.test('Fractal AX8'));
  check('An XL+ port name ("Axe-Fx II XL+ Port 1") does NOT match the AX8 pattern', !ax8PortMatch.test('Axe-Fx II XL+ Port 1'));
}

console.log(failed === 0 ? `\nverify-ax8-model-byte: all assertions passed.` : `\nverify-ax8-model-byte: ${failed} assertion(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
