/**
 * Modern Fractal family — DeviceWriter.
 *
 * `makeWriter` binds the gen-3 codec (model byte) + the device shape
 * (grid dims, scene count, channel names, preset count) + the per-
 * response beta warning. Every emitted frame is a spec-documented or
 * III-capture-verified envelope with this device's model byte — never a
 * guessed wire shape (preference_axefx3_no_untested_wire_paths). The
 * device's 0x64 MULTIPURPOSE_RESPONSE error channel catches malformed
 * requests, which we surface inline rather than silently corrupting state.
 */
import type {
  DeviceWriter,
  DispatchCtx,
  BatchWriteResult,
  WriteOp,
  WriteResult,
  BlockChange,
  PresetSpec,
  LocationRef,
  SlotRef,
  RenameTarget,
  ApplyResult,
  ApplyPresetOptions,
  ChainIntegrityResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError, SpecValidationError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { markDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';
import { parseGen3SetValueEcho, type ModernFractalCodec } from 'fractal-midi/gen3/axe-fx-iii';
import { parseLocationCode } from 'fractal-midi/am4';
import type { ModernCatalog } from './catalog.js';
import { makeGuard } from './guard.js';
import { runGen3Build, planForDevice, checkGen3ApplyTarget, type BuildDeps } from './applyBuild.js';
import { verifyGen3Chain } from './buildVerify.js';
import { readLiveGrid, readStatus, readActiveScene } from './liveGrid.js';
import { instanceLimitFor } from './instanceLimits.js';
import { SHUNT_EFFECT_ID_BASE } from './buildPlan.js';

export interface WriterShape {
  id: string;
  /** Grid dimensions for grid-shaped devices; undefined for serial (VP4). */
  grid?: { rows: number; cols: number };
  /** Serial slot count for AM4-shape devices (VP4 = 4); undefined for grid. */
  slot_count?: number;
  scene_count: number;
  channel_names: readonly string[];
  preset_count: number;
  /** Whether STORE is spec-supported (false for III/FM3/FM9 → gate auto-save). */
  supportsSave: boolean;
  /**
   * When true, every device-state write refuses with a clear "untested on
   * hardware" message (VP4: param/block write path inferred-not-confirmed,
   * placement wire shape undecoded). Reads are unaffected. Defaults false.
   */
  writesGated?: boolean;
  /**
   * When `writesGated` is true, these op names are EXEMPT from the gate (they
   * have a hardware-confirmed wire shape). e.g. VP4 allows `set_bypass` and
   * `save_preset` (decoded byte-exact from a community capture) while every other
   * write stays refused. Empty/undefined ⇒ all writes gated (the prior behavior).
   */
  writeAllowlist?: readonly string[];
  /**
   * Switch presets via the gen-3 fn=0x01 sub=0x27 SysEx-native op instead of
   * MIDI Program Change + Bank Select. FM3: sub=0x27 is hardware-confirmed,
   * while the PC path truncates presets >127 to mod 128 (fw 12.00 ignores
   * CC32 — field-confirmed 2026-06-12). Default false (PC path).
   */
  switchPresetViaSysEx?: boolean;
  /** save_preset refuses a target other than the loaded location (see factory `save_targets_loaded_only`). */
  saveTargetsLoadedOnly?: boolean;
}

export function makeWriter(opts: {
  codec: ModernFractalCodec;
  catalog: ModernCatalog;
  shape: WriterShape;
  deviceLabel: string;
  connectionLabel: string;
  betaWarning: string;
  getResponseTimeoutMs: number;
}): DeviceWriter {
  const { codec, catalog, shape, deviceLabel, connectionLabel, betaWarning, getResponseTimeoutMs } = opts;
  const { resolveBlockOrThrow, resolveParamOrThrow } = catalog;
  const BETA_WARNING = betaWarning;
  const channelValues: Readonly<Record<string, number>> = Object.freeze(
    Object.fromEntries(shape.channel_names.map((c, i) => [c.toUpperCase(), i])),
  );

  /**
   * Refuse a device-state write on a write-gated device. The gen-3 param/block
   * write path is inferred from the III/AM4 codec but is NOT confirmed on this
   * device's hardware, and (for the serial VP4) the block-placement wire shape
   * is undecoded, so emitting any write risks silently corrupting state with no
   * acked confirmation. Reads (get_param / get_preset) stay live; writes refuse
   * until a hardware capture lands. No-op on non-gated devices (III/FM3/FM9).
   */
  function gateWrite(op: string): void {
    if (!shape.writesGated) return;
    if (shape.writeAllowlist?.includes(op)) return;
    const allowed = shape.writeAllowlist?.length
      ? ` Confirmed writes on this device: ${shape.writeAllowlist.join(', ')}.`
      : '';
    throw new DispatchError(
      'capability_not_supported',
      deviceLabel,
      `${shape.id} ${op}: this write is GATED on ${deviceLabel}. Its wire shape is not yet ` +
        `decoded/confirmed on this device's hardware (block placement and per-param value ` +
        `calibration are still undecoded). Reads work; this write refuses until a capture lands.` +
        `${allowed} ${BETA_WARNING}`,
    );
  }

  function parseLocation(location: LocationRef): number {
    const max = shape.preset_count - 1;
    // Serial AM4-shape devices (VP4) name locations A01..Z04 (the
    // descriptor's own preset_location_format and canonical_terms spelling),
    // so accept that form alongside the integer index. Grid devices
    // (III/FM3/FM9) address presets by integer only.
    let n: number;
    if (
      typeof location === 'string' &&
      shape.slot_count !== undefined &&
      /^[A-Za-z]0?\d$/.test(location.trim())
    ) {
      n = parseLocationCode(location);
    } else {
      n = typeof location === 'number' ? location : Number(location);
    }
    if (!Number.isInteger(n) || n < 0 || n > max) {
      throw new DispatchError(
        'bad_location',
        deviceLabel,
        `${shape.id}: preset location '${location}' is invalid (expected ` +
          (shape.slot_count !== undefined ? `A01..Z04 or integer 0..${max}` : `integer 0..${max}`) +
          ').',
      );
    }
    return n;
  }

  function formatErrorCode(report: { resultCode: number; description?: string }): string {
    const hex = `0x${report.resultCode.toString(16).padStart(2, '0')}`;
    return report.description !== undefined
      ? `${report.description} (${hex})`
      : `unknown result code ${hex}`;
  }

  /**
   * Send a frame and watch for a 0x64 MULTIPURPOSE_RESPONSE rejection in
   * a short window. The device emits 0x64 only on rejection — no echo on
   * accept — so the predicate is "rejection came back".
   */
  async function sendAndWatchForError(
    ctx: DispatchCtx,
    bytes: number[],
    // The device emits 0x64 only on rejection (no positive ack), and a SysEx
    // round-trip is 30-60 ms per the performance budget, so a 50 ms window
    // could close before a genuine rejection arrives and report a rejected
    // write as accepted. Structural ops (set_block/set_bypass/switch_scene/
    // save/rename/routing) are infrequent, so a generous window costs little
    // latency and ensures a rejection is never missed.
    windowMs = 250,
  ): Promise<{ resultCode: number; description?: string } | undefined> {
    // Only accept a 0x64 that echoes the function we just sent (frame byte 5),
    // so a stray status/other-op 0x64 in the window isn't read as this op's
    // rejection.
    const sentFn = bytes[5];
    const watchPromise = ctx.conn.receiveSysExMatching(
      (b) => codec.isMultipurposeResponse(b, sentFn),
      windowMs,
    );
    ctx.conn.send(bytes);
    try {
      const frame = await watchPromise;
      const parsed = codec.parseMultipurposeResponse(frame);
      return {
        resultCode: parsed.resultCode,
        description: codec.describeMultipurposeResultCode(parsed.resultCode),
      };
    } catch {
      return undefined; // No rejection within window → write accepted.
    }
  }

  async function readActiveChannel(ctx: DispatchCtx, effectId: number, op = 'set_param'): Promise<number> {
    const reply = ctx.conn.receiveSysExMatching(
      (bytes) => codec.isStatusDumpResponse(bytes),
      getResponseTimeoutMs,
    );
    ctx.conn.send(codec.buildStatusDump());
    let entries: ReturnType<ModernFractalCodec['parseStatusDumpResponse']>;
    try {
      entries = codec.parseStatusDumpResponse(await reply);
    } catch (error) {
      throw new DispatchError(
        'no_ack',
        deviceLabel,
        `${shape.id} ${op}: could not read the active block channel: ` +
          `${error instanceof Error ? error.message : String(error)}. No parameter write was sent.`,
      );
    }
    const entry = entries.find((candidate) => candidate.effectId === effectId);
    if (entry === undefined) {
      throw new DispatchError(
        'capability_not_supported',
        deviceLabel,
        `${shape.id} ${op}: effect ${effectId} is absent from the live status dump, so the block is not ` +
          `placed in the active preset. No parameter write was sent.`,
      );
    }
    return entry.channel;
  }

  /**
   * Send a SET frame and, within a short window, watch for EITHER:
   *   - a 0x64 MULTIPURPOSE_RESPONSE rejection, or
   *   - the synchronous 60-byte fn=0x01 value-echo whose effectId+paramId
   *     match this write. The echo carries the device's quantized value as a
   *     NORMALIZED float32 ([0,1] = wire16/65534 for continuous params), so a
   *     write can confirm in display units rather than reporting the value we
   *     sent.
   *
   * The echo is parsed opportunistically: our typed-SET (sub=0x09) echo is not
   * yet hardware-confirmed (the FM9 capture used the editor's own sub-action),
   * so a missing echo is the expected case and resolves as a plain accept.
   * Parsing inbound bytes emits nothing on the wire.
   */
  /** fn=0x0D: the active preset's number + name, or a stored preset's name by
   *  number (answered from flash, nothing loads). Undefined when the unit is silent. */
  async function queryPatchName(
    ctx: DispatchCtx,
    preset: number | 'current',
    timeoutMs = 400,
  ): Promise<{ presetNumber: number; name: string } | undefined> {
    if (shape.id === 'vp4') return undefined;
    try {
      const p = ctx.conn.receiveSysExMatching((b) => codec.isQueryPatchNameResponse(b), timeoutMs);
      p.catch(() => {});
      ctx.conn.send(codec.buildQueryPatchName(preset));
      return codec.parseQueryPatchNameResponse(await p);
    } catch {
      return undefined;
    }
  }

  /**
   * Read back which preset is active after a switch. A gen-3 unit does not
   * ack a preset switch, so "sent" used to be reported as "acked": a location
   * the unit refused (past a Mark I's 512, or a PC landing in the wrong bank)
   * read as success. Returns a WriteResult patch.
   */
  async function confirmSwitch(
    ctx: DispatchCtx,
    n: number,
    how: string,
  ): Promise<{ acked: boolean; unconfirmed?: boolean; warning: string; display_value: string }> {
    // The unit needs a moment to load before fn=0x0D reports the new number.
    let active: { presetNumber: number; name: string } | undefined;
    for (const waitMs of [60, 150, 300]) {
      await new Promise((r) => setTimeout(r, waitMs));
      active = await queryPatchName(ctx, 'current');
      if (active === undefined || active.presetNumber === n) break;
    }
    const offsetNote =
      `Preset numbers here are the 0-based wire number; the unit's screen shows ${n} or ${n + 1} ` +
      `depending on its Display Offset setting.`;
    if (active === undefined) {
      // No read-back is not an ack: report sent-but-unconfirmed.
      return {
        acked: false,
        unconfirmed: true,
        display_value: String(n),
        warning:
          `${shape.id} switch_preset: ${how}. ${deviceLabel} did not answer the active-preset query, ` +
          `so the switch is UNCONFIRMED; check the front panel. ${offsetNote}`,
      };
    }
    const nm = active.name.trim();
    if (active.presetNumber !== n) {
      return {
        acked: false,
        display_value: String(active.presetNumber),
        warning:
          `${shape.id} switch_preset: ${how}, but ${deviceLabel} reports preset ` +
          `${active.presetNumber}${nm ? ` ("${nm}")` : ''} is active, NOT ${n}. The switch did not land ` +
          `(a location past the unit's last preset is ignored: a Mark I Axe-Fx III holds 0..511). ` +
          `Any unsaved edits on the previous preset may already be gone. ${offsetNote}`,
      };
    }
    return {
      acked: true,
      display_value: String(n),
      warning:
        `${shape.id} switch_preset: ${how}; ${deviceLabel} confirms preset ${n}` +
        `${nm ? ` ("${nm}")` : ''} is now active. ${offsetNote}`,
    };
  }

  async function sendAndWatchSetResponse(
    ctx: DispatchCtx,
    bytes: number[],
    effectId: number,
    paramId: number,
    // Per-param SET is on the apply_preset hot path, so this window is kept
    // tighter than the structural-op window, but still above the 30-60 ms
    // round-trip so a 0x64 rejection is not missed. An inbound value-echo or
    // rejection resolves early; only the silent-accept path waits the window.
    windowMs = 120,
  ): Promise<
    | { kind: 'reject'; resultCode: number; description?: string }
    | { kind: 'echo'; normalizedValue: number }
    | { kind: 'accept' }
  > {
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (
        r:
          | { kind: 'reject'; resultCode: number; description?: string }
          | { kind: 'echo'; normalizedValue: number }
          | { kind: 'accept' },
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (typeof unsubscribe === 'function') unsubscribe();
        resolve(r);
      };
      const sentFn = bytes[5]; // 0x01 for a SET; reject must echo it
      const unsubscribe = ctx.conn.onMessage((frame) => {
        if (codec.isMultipurposeResponse(frame, sentFn)) {
          const parsed = codec.parseMultipurposeResponse(frame);
          finish({
            kind: 'reject',
            resultCode: parsed.resultCode,
            description: codec.describeMultipurposeResultCode(parsed.resultCode),
          });
          return;
        }
        // Opportunistic value-echo: a fn=0x01 frame for OUR effectId+paramId.
        // parse throws on any other frame shape (broadcasts, GET responses),
        // which we swallow and keep waiting.
        try {
          const echo = parseGen3SetValueEcho(frame);
          if (echo.effectId === effectId && echo.paramId === paramId) {
            finish({ kind: 'echo', normalizedValue: echo.normalizedValue });
          }
        } catch {
          // not a value-echo; ignore.
        }
      });
      const timer = setTimeout(() => finish({ kind: 'accept' }), windowMs);
      ctx.conn.send(bytes);
    });
  }

  /**
   * Turn a SET value-echo's normalized float ([0,1]) into a display-unit
   * value via the param's catalog schema. Continuous params normalize as
   * wire16/65534, so the device-quantized wire is `round(normalized*65534)`
   * and we decode that. Discrete (enum/type) params are sent as
   * float32(ordinal), not a normalized knob, so the [0,1]→wire16 inversion
   * does not apply; for those we return undefined and the caller decodes the
   * ordinal it sent.
   */
  function echoToDisplay(
    blockSlug: string,
    name: string,
    normalizedValue: number,
  ): { wire: number; display: number | string } | undefined {
    const schema = catalog.blocks[blockSlug]?.params[name];
    if (schema === undefined) return undefined;
    // Discrete selectors (named enums AND count-known device-cache enums) carry
    // float32(ordinal), not a normalized knob, so the [0,1]→wire16 inversion
    // does not apply; the caller decodes the ordinal it sent.
    if (schema.wire_kind === 'discrete') return undefined;
    if (schema.enum_values !== undefined) return undefined; // enum: not a wire16 normalize
    if (!Number.isFinite(normalizedValue)) return undefined;
    const wire = Math.round(Math.min(1, Math.max(0, normalizedValue)) * 65534);
    return { wire, display: schema.decode(wire) };
  }

  /** Decode a value we SENT through the param's schema, for display-unit
   *  confirmation when no device echo is available. Falls back to the raw
   *  wire integer when the block/param has no schema. */
  function sentToDisplay(blockSlug: string, name: string, wireValue: number): number | string {
    const schema = catalog.blocks[blockSlug]?.params[name];
    return schema !== undefined ? schema.decode(wireValue) : wireValue;
  }

  /**
   * Build the gen-3 SET frame for a param, choosing the wire form from its
   * schema. DISCRETE (enum/type selectors): the encoded `wireValue` is the
   * read-roster ordinal → `float32(ordinal)` via sub 09 00. CONTINUOUS (knobs):
   * the encoded `wireValue` is the 0..65534 wire → normalized to [0,1] and sent
   * as `float32(normalized)` via sub 52 00. Both ride a 5-septet float32 at pos
   * 12; only the sub-action + value semantics differ. Default (no schema /
   * uncatalogued param) is continuous, the common gen-3 param shape.
   */
  function buildSetForKind(
    effectId: number,
    paramId: number,
    wireValue: number,
    kind: 'discrete' | 'continuous' | undefined,
  ): number[] {
    if (kind === 'discrete') {
      // Ordinal 0 cannot ride the discrete form: sub 09 00 with value 0 is
      // byte-identical to the zeroed GET, so the device treats it as a read
      // and nothing changes (ToneCommand replay testing, FM9). A continuous
      // 0.0 lands the first entry instead. Grid devices only: the VP4 has no
      // decoded discrete SET and must keep refusing.
      if (wireValue === 0 && shape.grid !== undefined) {
        return codec.buildSetParameterContinuous(effectId, paramId, 0);
      }
      return codec.buildSetParameter(effectId, paramId, wireValue);
    }
    const normalized = Math.min(1, Math.max(0, wireValue / 65534));
    return codec.buildSetParameterContinuous(effectId, paramId, normalized);
  }

  const writer: DeviceWriter = {
    buildSetParam(block: string, name: string, wireValue: number): number[] {
      const { effectId } = resolveBlockOrThrow(block, deviceLabel);
      const { param } = resolveParamOrThrow(block, name, deviceLabel);
      const kind = catalog.blocks[block]?.params[name]?.wire_kind;
      return buildSetForKind(effectId, param.paramId, wireValue, kind);
    },

    buildSwitchPreset(location: LocationRef): number[] {
      return codec.buildSwitchPresetPC(parseLocation(location));
    },

    buildSwitchScene(scene: number): number[] {
      // Unified surface scene numbers are 1-indexed (display); wire is 0-indexed.
      return codec.buildSetScene(scene - 1);
    },

    async setParam(
      ctx: DispatchCtx,
      blockSlugIn: string,
      name: string,
      wireValue: number,
      channel?: number,
      instance?: number,
    ): Promise<WriteResult> {
      gateWrite('set_param');
      const { effectId } = resolveBlockOrThrow(blockSlugIn, deviceLabel, instance);
      const { param } = resolveParamOrThrow(blockSlugIn, name, deviceLabel);
      const kind = catalog.blocks[blockSlugIn]?.params[name]?.wire_kind;
      // The channel arg used to be dropped here, so `set_param(channel: "B")`
      // wrote whichever channel the active scene happened to be on. Capture the
      // original channel, select and verify the requested channel, then restore
      // and verify the original channel in `finally`, including rejected/failed
      // parameter writes. fn=0x0B targets the ACTIVE scene only.
      const channelName = channel !== undefined ? shape.channel_names[channel] : undefined;
      let originalChannel: number | undefined;
      let targetSelected = false;
      if (channel !== undefined) {
        if (channelName === undefined) {
          throw new DispatchError(
            'bad_channel',
            deviceLabel,
            `${shape.id} set_param: channel index ${channel} is out of range ` +
              `(valid: 0..${shape.channel_names.length - 1} / ${shape.channel_names.join('/')}).`,
          );
        }
        originalChannel = await readActiveChannel(ctx, effectId);
      }
      const channelField = channelName !== undefined ? { channel: channelName } : {};
      try {
        if (channel !== undefined && originalChannel !== channel) {
          const channelError = await sendAndWatchForError(
            ctx,
            codec.buildSetChannel(effectId, channel as 0 | 1 | 2 | 3),
          );
          if (channelError !== undefined) {
            return {
              op: 'set_param',
              target: `${blockSlugIn}.${name}`,
              block: blockSlugIn,
              name,
              wire_value: wireValue,
              acked: false,
              channel: channelName,
              warning:
                `${deviceLabel} rejected the channel ${channelName} select ahead of set_param via 0x64 ` +
                `MULTIPURPOSE_RESPONSE: ${formatErrorCode(channelError)}. Nothing was written. ` +
                BETA_WARNING,
            };
          }
          targetSelected = true;
          markDirty(connectionLabel);
          const selected = await readActiveChannel(ctx, effectId);
          if (selected !== channel) {
            throw new DispatchError(
              'no_ack',
              deviceLabel,
              `${shape.id} set_param: requested channel ${channelName}, but fresh status reported ` +
                `${shape.channel_names[selected] ?? selected}. No parameter write was sent.`,
            );
          }
        }

        let bytes: number[];
        try {
          bytes = buildSetForKind(effectId, param.paramId, wireValue, kind);
        } catch (err) {
          throw new DispatchError(
            'capability_not_supported',
            deviceLabel,
            `${shape.id} set_param ${blockSlugIn}.${name}: ${err instanceof Error ? err.message : String(err)} ${BETA_WARNING}`,
          );
        }
        const response = await sendAndWatchSetResponse(ctx, bytes, effectId, param.paramId);
        markDirty(connectionLabel);
        if (response.kind === 'reject') {
          const desc = response.description
            ? `${response.description} (code 0x${response.resultCode.toString(16).padStart(2, '0')})`
            : `unknown result code 0x${response.resultCode.toString(16).padStart(2, '0')}`;
          return {
            op: 'set_param', target: `${blockSlugIn}.${name}`, block: blockSlugIn, name,
            wire_value: wireValue, display_value: sentToDisplay(blockSlugIn, name, wireValue),
            acked: false, ...channelField,
            warning: `${deviceLabel} rejected set_param via 0x64 MULTIPURPOSE_RESPONSE: ${desc}. ${BETA_WARNING}`,
          };
        }
        if (response.kind === 'echo') {
          const echoDisplay = echoToDisplay(blockSlugIn, name, response.normalizedValue);
          return {
            op: 'set_param', target: `${blockSlugIn}.${name}`, block: blockSlugIn, name,
            wire_value: echoDisplay?.wire ?? wireValue,
            display_value: echoDisplay?.display ?? sentToDisplay(blockSlugIn, name, wireValue),
            acked: true, ...channelField, warning: BETA_WARNING,
          };
        }
        return {
          op: 'set_param', target: `${blockSlugIn}.${name}`, block: blockSlugIn, name,
          wire_value: wireValue, display_value: sentToDisplay(blockSlugIn, name, wireValue),
          acked: false, unconfirmed: true, ...channelField,
          warning:
            `${deviceLabel} did not confirm set_param ${blockSlugIn}.${name}: the write was sent ` +
            `and not rejected, but no device value-echo returned, so it is UNVERIFIED (it may have ` +
            `landed). Confirm on the front panel. The gen-3 SET wire is byte-confirmed against device ` +
            `captures; the server-issued frame drawing an echo is not yet hardware-confirmed end to end. ` +
            `${BETA_WARNING}`,
        };
      } finally {
        if (targetSelected && originalChannel !== undefined) {
          const restoreError = await sendAndWatchForError(
            ctx,
            codec.buildSetChannel(effectId, originalChannel as 0 | 1 | 2 | 3),
          );
          if (restoreError !== undefined) {
            throw new DispatchError(
              'no_ack',
              deviceLabel,
              `${shape.id} set_param may have written ${blockSlugIn}.${name}, but restoring channel ` +
                `${shape.channel_names[originalChannel] ?? originalChannel} was rejected: ` +
                `${formatErrorCode(restoreError)}. Recovery is required before continuing.`,
            );
          }
          const restored = await readActiveChannel(ctx, effectId);
          if (restored !== originalChannel) {
            throw new DispatchError(
              'no_ack',
              deviceLabel,
              `${shape.id} set_param may have written ${blockSlugIn}.${name}, but channel restoration ` +
                `failed: expected ${shape.channel_names[originalChannel] ?? originalChannel}, got ` +
                `${shape.channel_names[restored] ?? restored}. Recovery is required before continuing.`,
            );
          }
        }
      }
    },

    async setParams(ctx: DispatchCtx, ops: readonly WriteOp[]): Promise<BatchWriteResult> {
      gateWrite('set_params');
      const writes: WriteResult[] = [];
      let ackedCount = 0;
      let unackedCount = 0;
      for (const op of ops) {
        const wireValue = typeof op.value === 'number' ? op.value : Number(op.value);
        let result: WriteResult;
        try {
          result = await writer.setParam!(ctx, op.block, op.name, wireValue, op.channel, op.instance);
        } catch (err) {
          // One bad op must not abort the batch or hide the writes before it.
          result = {
            op: 'set_param', target: `${op.block}.${op.name}`, acked: false,
            warning: `set_param failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        writes.push(result);
        if (result.acked) ackedCount += 1;
        else unackedCount += 1;
      }
      return { writes, acked_count: ackedCount, unacked_count: unackedCount };
    },

    async setBlock(
      ctx: DispatchCtx,
      slot: SlotRef,
      change: BlockChange,
    ): Promise<WriteResult> {
      gateWrite('set_block');
      const grid = shape.grid;
      if (grid === undefined) {
        // Serial AM4-shape devices place blocks by slot index, not grid cell.
        // The serial block-placement wire shape is undecoded, so this path is
        // unreachable on a gated device (gateWrite already threw) and refuses
        // defensively on any future non-gated serial device.
        throw new DispatchError(
          'capability_not_supported',
          deviceLabel,
          `${shape.id} setBlock: serial block placement is not wired (the block-placement ` +
            `wire shape is undecoded for ${deviceLabel}).`,
        );
      }
      if (typeof slot === 'number') {
        throw new DispatchError(
          'value_out_of_range',
          deviceLabel,
          `${shape.id} setBlock: slot must be {row, col} (grid coords). Got linear index ${slot}. ` +
            `${deviceLabel} uses a ${grid.rows}×${grid.cols} grid; pass slot as ` +
            `{row: 1..${grid.rows}, col: 1..${grid.cols}}.`,
        );
      }
      // Grid-bound check. buildSetGridCell now takes the row count (we pass
      // grid.rows below), but its column backstop is the III's 14, so a
      // smaller device (FM3 is 4 cols) would otherwise encode an out-of-grid
      // cell with no error. Reject against this device's real shape first.
      if (
        slot.row < 1 || slot.row > grid.rows ||
        slot.col < 1 || slot.col > grid.cols
      ) {
        throw new DispatchError(
          'value_out_of_range',
          deviceLabel,
          `${shape.id} setBlock: slot {row:${slot.row}, col:${slot.col}} is outside ` +
            `${deviceLabel}'s ${grid.rows}×${grid.cols} grid ` +
            `(valid: row 1..${grid.rows}, col 1..${grid.cols}).`,
        );
      }
      if (change.bypassed !== undefined && change.block_type === undefined) {
        throw new DispatchError(
          'value_out_of_range',
          deviceLabel,
          `${shape.id} setBlock: bypass-only changes require block_type to resolve the effect ID. ` +
            'For a pure bypass toggle, call set_bypass with the block name instead.',
        );
      }
      if (change.block_type === undefined) {
        throw new DispatchError(
          'value_out_of_range',
          deviceLabel,
          `${shape.id} setBlock: block_type is required (or "none" / "empty" to clear the cell).`,
        );
      }
      const blockType = change.block_type.trim().toLowerCase();
      let blockId: number;
      if (blockType === 'none' || blockType === 'empty' || blockType === '') {
        blockId = 0; // 0 clears the cell per II convention
      } else if (blockType === 'shunt') {
        // A shunt is id 1024 + n with n unique on the grid (our FM9-Edit
        // capture inserts them as sub=0x32 with id hi byte 0x08, lo byte
        // 0, 1, 2; ai-tone-assistant numbers from 0). The index is assigned
        // below from a live grid read (lowest free).
        blockId = -1;
      } else {
        // Resolve through the CATALOG, exactly as every read path does.
        // Passing the raw descriptor slug to `resolveEffectId` (which matches
        // display names and 3-letter group codes) worked only for blocks whose
        // slug and display name coincide: 15 blocks per device silently failed,
        // among them `graphic_eq`, `gate_expander`, `volume_pan` and
        // `multitap_delay`. Every one of them is advertised by describe_device
        // and list_params, so an agent doing exactly what it was told got an
        // "unknown block" error naming a block the device really has.
        try {
          // instance selects which block of the type (Amp 2 = effect id 59);
          // default 1 keeps single-instance placements byte-identical.
          ({ effectId: blockId } = resolveBlockOrThrow(blockType, deviceLabel, change.instance ?? 1));
        } catch (err) {
          // resolveBlockOrThrow already throws a well-formed DispatchError
          // (unknown_block with the device's own label, or
          // capability_not_supported for a block with no addressable effect
          // id). Re-wrapping it discarded the code and produced a plain
          // "Unknown Axe-Fx III block" on an FM9.
          if (err instanceof DispatchError) throw err;
          throw new DispatchError('unknown_block', deviceLabel, err instanceof Error ? err.message : String(err));
        }
      }
      const target = `r${slot.row}c${slot.col}`;
      if (blockId > 0 && blockType !== 'shunt') {
        const limit = instanceLimitFor(codec.modelByte, blockType);
        if (limit !== undefined && (change.instance ?? 1) > limit.limit) {
          throw new DispatchError(
            'value_out_of_range',
            deviceLabel,
            `${shape.id} set_block: ${deviceLabel} allows ${limit.limit} ${blockType} block${limit.limit === 1 ? '' : 's'}; ` +
              `instance ${change.instance} does not exist on the unit (source: ${limit.evidence}). Nothing was sent.`,
          );
        }
      }
      // Read the grid first: a block sits in ONE grid location, and the unit
      // answers a second insert of a placed block by moving or ignoring it.
      const liveBefore = await readLiveGrid(ctx, codec.modelByte, getResponseTimeoutMs);
      if (blockId === -1) {
        if (liveBefore === undefined) {
          throw new DispatchError('no_ack', deviceLabel,
            `${shape.id} set_block: placing a shunt needs a free shunt index from a live grid read, and ${deviceLabel} did not answer it. Nothing was sent.`);
        }
        const used = new Set(liveBefore.filter((c) => c.isShunt).map((c) => c.shuntIndex));
        let idx = 0;
        while (used.has(idx)) idx++;
        blockId = SHUNT_EFFECT_ID_BASE + idx;
      } else if (blockId > 0 && liveBefore !== undefined) {
        const here = liveBefore.find((c) => c.row === slot.row && c.col === slot.col);
        const elsewhere = liveBefore.find((c) => !c.isShunt && c.effectId === blockId && !(c.row === slot.row && c.col === slot.col));
        if (elsewhere) {
          throw new DispatchError('value_out_of_range', deviceLabel,
            `${shape.id} set_block: ${change.block_type}${change.instance && change.instance > 1 ? ` ${change.instance}` : ''} is already placed at ` +
              `r${elsewhere.row}c${elsewhere.col}. A block sits in one grid location: move it (clear r${elsewhere.row}c${elsewhere.col} with ` +
              `"none", then place it here) or place another instance. Nothing was sent.`);
        }
        if (here && !here.isShunt && here.effectId === blockId) {
          let bypassNote = '';
          if (change.bypassed !== undefined) {
            const b = await writer.setBypass!(ctx, blockType, change.bypassed, change.instance);
            bypassNote = ` ${b.warning ?? ''}`;
          }
          return {
            op: 'set_block', target, acked: true, display_value: change.block_type,
            info: `${change.block_type} is already at ${target}; no insert was sent.${bypassNote}`,
          };
        }
      }
      const bytes = codec.buildSetGridCell({ row: slot.row, col: slot.col, blockId, rows: grid.rows });
      // The insert lands at the edit cursor, not at its own target cell, unless
      // a sub=0x30 cell-select moves the cursor there first. Hardware-confirmed
      // on the FM3 (2026-06-27) and on the FM9 fw 12 (issue #23: every insert
      // landed at r1c1 until select -> insert). Sent on every grid device.
      ctx.conn.send(codec.buildSelectCell({ row: slot.row, col: slot.col, rows: grid.rows }));
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      const errorReport = await sendAndWatchForError(ctx, bytes);
      markDirty(connectionLabel);
      if (errorReport !== undefined) {
        return {
          op: 'set_block', target, acked: false,
          warning: `${deviceLabel} rejected set_block via 0x64 MULTIPURPOSE_RESPONSE: ${formatErrorCode(errorReport)}. ` + BETA_WARNING,
        };
      }
      const shown = blockId === 0 ? 'cleared' : blockId >= SHUNT_EFFECT_ID_BASE ? `shunt ${blockId - SHUNT_EFFECT_ID_BASE}` : change.block_type;
      // The insert has no confirming echo: read the grid back.
      const liveAfter = await readLiveGrid(ctx, codec.modelByte, getResponseTimeoutMs);
      const cell = liveAfter?.find((c) => c.row === slot.row && c.col === slot.col);
      const landed = liveAfter !== undefined && (
        blockId === 0 ? cell === undefined
          : blockId >= SHUNT_EFFECT_ID_BASE ? cell?.isShunt === true
            : cell !== undefined && !cell.isShunt && cell.effectId === blockId);
      let bypassNote = '';
      if (landed && blockId > 0 && blockId < SHUNT_EFFECT_ID_BASE && change.bypassed !== undefined) {
        const b = await writer.setBypass!(ctx, blockType, change.bypassed, change.instance);
        bypassNote = b.acked ? ` ${change.block_type} is ${change.bypassed ? 'bypassed' : 'engaged'} in the active scene.` : ` The bypass was not confirmed: ${b.warning ?? ''}`;
      }
      if (liveAfter === undefined) {
        return {
          op: 'set_block', target, acked: false, unconfirmed: true, display_value: shown,
          warning: `${shape.id} set_block: sent (select + insert, no rejection), but ${deviceLabel} did not answer the grid read-back, ` +
            `so the placement is unconfirmed. Check the grid on the device.${bypassNote} ` + BETA_WARNING,
        };
      }
      if (!landed) {
        return {
          op: 'set_block', target, acked: false, display_value: shown,
          warning: `${shape.id} set_block: sent with no rejection, but the grid read-back shows ${cell === undefined ? 'an empty cell' : cell.isShunt ? 'a shunt' : `effect ${cell.effectId}`} ` +
            `at ${target}, not ${shown}. The placement did not land (an instance the unit lacks, or a full DSP budget). ` + BETA_WARNING,
        };
      }
      return {
        op: 'set_block', target, acked: true, display_value: shown,
        info: `${shown} at ${target}, confirmed by a grid read-back (fn=0x01 sub=0x2E). It is not cabled: route it with apply_preset routing[] or on the device.${bypassNote}`,
      };
    },

    async setBypass(
      ctx: DispatchCtx,
      block: string,
      bypassed: boolean,
      instance?: number,
    ): Promise<WriteResult> {
      gateWrite('set_bypass');
      // Same slug-vs-display-name defect as setBlock above, in a tool an agent
      // reaches for far more often: `set_bypass({block:"gate_expander"})`
      // resolved nothing, because `resolveEffectId` matches display names and
      // group codes, not descriptor slugs. Route through the catalog, which is
      // what every read path already does.
      let effectId: number;
      try {
        ({ effectId } = resolveBlockOrThrow(block, deviceLabel, instance ?? 1));
      } catch (err) {
        if (err instanceof DispatchError) throw err;
        throw new DispatchError('unknown_block', deviceLabel, err instanceof Error ? err.message : String(err));
      }
      const bytes = codec.buildSetBypass(effectId, bypassed);
      const errorReport = await sendAndWatchForError(ctx, bytes);
      if (errorReport !== undefined) {
        return {
          op: 'set_bypass',
          target: block,
          acked: false,
          warning:
            `${deviceLabel} rejected set_bypass via 0x64 MULTIPURPOSE_RESPONSE: ${formatErrorCode(errorReport)}. ` +
            BETA_WARNING,
        };
      }
      if (shape.grid !== undefined) {
        // Read the active scene's status dump back: no rejection is not proof.
        const status = await readStatus(ctx, codec, getResponseTimeoutMs);
        const entry = status?.find((e) => e.effectId === effectId);
        const shown = bypassed ? 'bypassed' : 'engaged';
        if (status === undefined) {
          return {
            op: 'set_bypass', target: block, acked: false, unconfirmed: true, display_value: shown,
            warning: `${shape.id} set_bypass: sent (fn=0x0A, no rejection) but ${deviceLabel} did not answer the status read-back; check the front panel. ${BETA_WARNING}`,
          };
        }
        if (entry === undefined || entry.bypassed !== bypassed) {
          return {
            op: 'set_bypass', target: block, acked: false,
            warning: entry === undefined
              ? `${shape.id} set_bypass: ${block} is not placed in the active preset (absent from the status read). ${BETA_WARNING}`
              : `${shape.id} set_bypass: sent, but the status read-back shows ${block} ${entry.bypassed ? 'bypassed' : 'engaged'}. ${BETA_WARNING}`,
          };
        }
        return {
          op: 'set_bypass', target: block, acked: true, display_value: shown,
          info: `${block} is ${shown} in the ACTIVE scene (fn=0x0A, confirmed by a status read). The scene keeps it once the preset is saved.`,
        };
      }
      // VP4: no read-back is wired, so a sent bypass is unconfirmed, not acked.
      return {
        op: 'set_bypass',
        target: block,
        acked: false,
        unconfirmed: true,
        display_value: bypassed ? 'bypassed' : 'engaged',
        warning:
          (shape.id === 'vp4'
            ? `🟡 vp4 set_bypass: decoded byte-exact from a community capture (fn=0x01, paramId 3; ` +
              `enable=0.0 / bypass replicated verbatim). The device emitted no rejection, but this is ` +
              `UNTESTED on VP4 hardware; confirm on the front panel. `
            : `🟡 ${shape.id} set_bypass: spec-documented (function 0x0A). Targets the ACTIVE ` +
              'scene only; per spec, the modern family has no per-scene bypass write. ') + BETA_WARNING,
      };
    },

    async setChannel(
      ctx: DispatchCtx,
      block: string,
      channel: string | number,
      instance?: number,
    ): Promise<WriteResult> {
      gateWrite('set_channel');
      const names = shape.channel_names;
      const index = typeof channel === 'number'
        ? channel
        : names.findIndex((n) => n.toUpperCase() === channel.trim().toUpperCase());
      if (!Number.isInteger(index) || index < 0 || index >= names.length) {
        throw new DispatchError(
          'bad_channel',
          deviceLabel,
          `${shape.id} set_channel: channel ${JSON.stringify(channel)} is not valid (use ${names.join('/')}).`,
        );
      }
      let effectId: number;
      try {
        ({ effectId } = resolveBlockOrThrow(block, deviceLabel, instance ?? 1));
      } catch (err) {
        if (err instanceof DispatchError) throw err;
        throw new DispatchError('unknown_block', deviceLabel, err instanceof Error ? err.message : String(err));
      }
      const name = names[index];
      // The status dump both proves the block is placed (an absent block
      // refuses before anything is sent) and lets a no-op select skip the wire.
      const before = await readActiveChannel(ctx, effectId, 'set_channel');
      if (before === index) {
        return {
          op: 'set_channel', target: block, acked: true, channel: name, display_value: name,
          info: `${block} was already on channel ${name} in the active scene; nothing was sent.`,
        };
      }
      const rejected = await sendAndWatchForError(ctx, codec.buildSetChannel(effectId, index as 0 | 1 | 2 | 3));
      if (rejected !== undefined) {
        return {
          op: 'set_channel', target: block, acked: false, channel: name,
          warning:
            `${deviceLabel} rejected set_channel via 0x64 MULTIPURPOSE_RESPONSE: ${formatErrorCode(rejected)}. ` +
            BETA_WARNING,
        };
      }
      markDirty(connectionLabel);
      const after = await readActiveChannel(ctx, effectId, 'set_channel');
      if (after !== index) {
        return {
          op: 'set_channel', target: block, acked: false, channel: name,
          warning:
            `${deviceLabel} accepted the channel ${name} select, but a fresh status read reports channel ` +
            `${names[after] ?? after}. Check the front panel. ${BETA_WARNING}`,
        };
      }
      return {
        op: 'set_channel', target: block, acked: true, channel: name, display_value: name,
        info:
          `${block} is on channel ${name} in the active scene (fn=0x0B, confirmed by a fresh status read). ` +
          'The scene keeps this channel only once the preset is saved.',
      };
    },

    validatePreset(spec: PresetSpec): void {
      // Grid devices plan the whole build before the MIDI handle opens, so
      // layout, duplicate-block, instance-limit and scene-key errors come back
      // together with zero writes (buildPlan.ts).
      if (shape.grid === undefined) return;
      const { errors } = planForDevice({ catalog, shape, codec, deviceLabel }, spec);
      if (errors.length > 0) throw new SpecValidationError(errors);
    },

    async applyPreset(
      ctx: DispatchCtx,
      spec: PresetSpec,
      target?: LocationRef,
      options?: ApplyPresetOptions,
    ): Promise<ApplyResult> {
      gateWrite('apply_preset');
      if (shape.grid === undefined) {
        throw new DispatchError('capability_not_supported', deviceLabel, `${shape.id} apply_preset: a serial build is not wired on ${deviceLabel}.`);
      }
      return runGen3Build(buildDeps, ctx, spec, target, options);
    },

    async preflightApplyTarget(ctx: DispatchCtx, target: LocationRef, options?: ApplyPresetOptions) {
      if (shape.grid === undefined) return undefined;
      return checkGen3ApplyTarget(buildDeps, ctx, target, options);
    },

    async verifyChain(ctx: DispatchCtx, spec: PresetSpec): Promise<ChainIntegrityResult> {
      return verifyGen3Chain(buildDeps, ctx, spec);
    },

    async switchPreset(ctx: DispatchCtx, location: LocationRef): Promise<WriteResult> {
      gateWrite('switch_preset');
      const n = parseLocation(location);
      if (shape.switchPresetViaSysEx) {
        // fn=0x01 sub=0x27: full 14-bit preset number, no MIDI-channel or
        // bank-encoding dependency. FM3-hardware-confirmed (475→100 live,
        // 2026-06-10; field-test restore, 2026-06-12). The PC path is
        // hardware-FALSIFIED on the FM3 for presets >127 (fw 12.00 ignores
        // CC32 → preset 438 landed on 54).
        ctx.conn.send(codec.buildSwitchPresetSysEx(n));
        return {
          op: 'switch_preset',
          target: String(n),
          ...(await confirmSwitch(ctx, n, 'sent the gen-3 SysEx preset switch (fn=0x01 sub=0x27)')),
        };
      }
      const bytes = codec.buildSwitchPresetPC(n);
      // node-midi on Windows (WinMM) silently drops a single non-sysex
      // message longer than 3 bytes, so the concatenated Bank-MSB +
      // Bank-LSB + Program-Change blob never leaves the host and the switch
      // no-ops. Split on MIDI status bytes (high bit set) and send each
      // message separately — the same pattern send_program_change already
      // uses. Hardware-found on a real FM9 (community fm9-catalog branch,
      // 2026-06-06); latent for every gen-3 device on Windows.
      for (let i = 0; i < bytes.length; ) {
        let j = i + 1;
        while (j < bytes.length && (bytes[j] & 0x80) === 0) j++;
        ctx.conn.send(bytes.slice(i, j));
        i = j;
      }
      if (shape.id === 'vp4') {
        return {
          op: 'switch_preset',
          target: String(n),
          acked: false,
          unconfirmed: true,
          display_value: String(n),
          warning:
            `${shape.id} switch_preset: sent MIDI Program Change + Bank Select on channel 1. ` +
            `${deviceLabel} does not ack PC writes; confirm on the front panel.`,
        };
      }
      const confirmed = await confirmSwitch(
        ctx, n, 'sent MIDI Program Change + Bank Select on channel 1 (the factory-default MIDI channel)',
      );
      return {
        op: 'switch_preset',
        target: String(n),
        ...confirmed,
        warning: confirmed.acked
          ? confirmed.warning
          : confirmed.warning +
            ` If the unit listens on another MIDI channel, has Program Change off, or has PC Mapping on, ` +
            `a Program Change lands elsewhere or nowhere; check Setup > MIDI/Remote.`,
      };
    },

    async savePreset(ctx: DispatchCtx, location: LocationRef, name?: string): Promise<WriteResult> {
      gateWrite('save_preset');
      const n = parseLocation(location);
      // Where is the unit, before the store? One report (FM3) has the store
      // ignoring its destination and writing the LOADED preset instead, so the
      // receipt below compares what landed against what was asked.
      const before = await queryPatchName(ctx, 'current');
      if (shape.saveTargetsLoadedOnly && before === undefined) {
        // Without knowing what is loaded, a store on this unit could
        // overwrite a preset other than the one asked for.
        throw new DispatchError(
          'no_ack',
          deviceLabel,
          `${deviceLabel} did not answer the loaded-preset query, so save_preset cannot tell which preset its ` +
            `store would overwrite (this unit stores the LOADED preset whatever the destination). Nothing was sent. ` +
            `Retry, or save on the front panel.`,
        );
      }
      if (shape.saveTargetsLoadedOnly && before !== undefined && before.presetNumber !== n) {
        // Refuse BEFORE the rename or the store: on this unit a store aimed at
        // another location overwrites the loaded preset (community PR #24).
        throw new DispatchError(
          'capability_not_supported',
          deviceLabel,
          `${deviceLabel} cannot save to ${n} while preset ${before.presetNumber} is loaded: its store ` +
            `ignores the destination and overwrites the LOADED preset. Nothing was sent. Save to ` +
            `${before.presetNumber}, or switch to ${n} and build the preset there (switching discards ` +
            `unsaved edits). Preset numbers are 0-based wire numbers.`,
        );
      }
      let renameNote = '';
      if (name !== undefined) {
        // The name is written to the working buffer first; a refused or
        // failed rename must be REPORTED, not swallowed (a save with `name`
        // used to ack while the stored name stayed unchanged).
        try {
          const r = await writer.rename!(ctx, 'preset', name);
          if (!r.acked && !r.unconfirmed) renameNote = ` The rename to "${name}" did not land (${r.warning ?? 'rejected'}), so the stored name may be unchanged.`;
          else if (!r.acked) renameNote = ` The rename to "${name}" could not be read back.`;
        } catch (err) {
          renameNote = ` The rename to "${name}" failed (${err instanceof Error ? err.message : String(err)}), so the stored name is unchanged.`;
        }
      }
      const bytes = codec.buildStorePreset(n);
      const errorReport = await sendAndWatchForError(ctx, bytes, 200);
      if (errorReport !== undefined) {
        return {
          op: 'save_preset',
          target: String(n),
          acked: false,
          warning:
            `${deviceLabel} rejected save_preset (fn=0x01 sub=0x26 store envelope) via 0x64 ` +
            `MULTIPURPOSE_RESPONSE: ${formatErrorCode(errorReport)}. This is the gen-3 editor's ` +
            `own store op, captured byte-exact; a rejection here likely means a different firmware ` +
            `state (e.g. an unsaved-edit guard). For now, save on the device front panel. ` + BETA_WARNING,
        };
      }
      // Read-back receipt (grid devices): the stored name AT THE TARGET, read
      // from flash without loading it. Proves the destination now holds this
      // preset's name; when it does not, say so instead of acking.
      if (shape.id !== 'vp4' && before !== undefined) {
        await new Promise((r) => setTimeout(r, 150));
        const stored = await queryPatchName(ctx, n);
        const renameLanded = name !== undefined && !/did not land|failed/.test(renameNote);
        const expect = (renameLanded ? name! : before.name).trim();
        if (stored !== undefined) {
          const got = stored.name.trim();
          const elsewhere = before.presetNumber !== n;
          if (got === expect || (name !== undefined && got === name.trim())) {
            return {
              op: 'save_preset',
              target: String(n),
              acked: true,
              display_value: String(n),
              warning:
                `${shape.id} save_preset: stored to preset ${n}; read back from flash, it now holds "${got}".` +
                (elsewhere ? ` (The loaded preset is ${before.presetNumber}; this was a save to a different location.)` : '') +
                renameNote +
                ` Preset numbers are 0-based wire numbers; the unit's screen shows ${n} or ${n + 1} per its Display Offset. ` +
                `The name read-back does not prove every parameter persisted; a power cycle is the full test.`,
            };
          }
          return {
            op: 'save_preset',
            target: String(n),
            acked: false,
            display_value: String(n),
            warning:
              `${shape.id} save_preset: the store was sent with no rejection, but preset ${n} reads back as ` +
              `"${got}", not "${expect}".` +
              (elsewhere
                ? ` The loaded preset is ${before.presetNumber}: this unit may have stored the loaded preset in place ` +
                  `instead of writing to ${n} (reported on the FM3). Switch to ${n} first, or save from the front panel.`
                : ` The save may not have landed; check the front panel.`) +
              renameNote + ' ' + BETA_WARNING,
          };
        }
      }
      // No read-back receipt (VP4 has none; a grid unit that did not answer the
      // name query): sent with no rejection is UNCONFIRMED, never acked.
      return {
        op: 'save_preset',
        target: String(n),
        acked: false,
        unconfirmed: true,
        display_value: String(n),
        warning:
          renameNote +
          (shape.id === 'vp4'
            ? `🟡 vp4 save_preset: sent the VP4 store command (fn=0x01 tc=0x1b), byte-identical to ` +
              `the captured save. It saves the ACTIVE preset IN PLACE: the location argument (${n}) is not a ` +
              `destination on the VP4 (save-in-place vs index is undecoded), so whatever preset is loaded is ` +
              `what was overwritten. Untested persistence. `
            : `🟡 ${shape.id} save_preset: sent the gen-3 editor store envelope (fn=0x01 sub=0x26, ` +
              `destination preset at the 14-bit arg slot). Wire shape is captured byte-exact from the ` +
              `editor, but device persistence is not yet hardware-verified. `) +
          `Device emitted no rejection. CONFIRM by switching to a different preset and back: if the ` +
          `saved state survived, the save landed. ` + BETA_WARNING,
      };
    },

    async switchScene(ctx: DispatchCtx, scene: number): Promise<WriteResult> {
      gateWrite('switch_scene');
      if (!Number.isInteger(scene) || scene < 1 || scene > shape.scene_count) {
        throw new DispatchError(
          'value_out_of_range',
          deviceLabel,
          `${shape.id} switchScene: scene ${scene} out of range. ` +
            `${deviceLabel} has ${shape.scene_count} scenes per preset ` +
            `(1..${shape.scene_count} display, 0..${shape.scene_count - 1} wire).`,
        );
      }
      const bytes = codec.buildSetScene(scene - 1);
      // Short rejection window: the scene GET below is the judge.
      const errorReport = await sendAndWatchForError(ctx, bytes, shape.grid !== undefined ? 60 : 250);
      if (errorReport !== undefined) {
        return {
          op: 'switch_scene',
          target: String(scene),
          acked: false,
          warning:
            `${deviceLabel} rejected switch_scene via 0x64 MULTIPURPOSE_RESPONSE: ${formatErrorCode(errorReport)}. ` +
            BETA_WARNING,
        };
      }
      if (shape.grid === undefined) {
        return {
          op: 'switch_scene', target: String(scene), acked: false, unconfirmed: true,
          warning: `🟡 ${shape.id} switch_scene: sent (function 0x0C), no read-back on this device; confirm on the front panel. ` + BETA_WARNING,
        };
      }
      const active = await readActiveScene(ctx, codec, getResponseTimeoutMs);
      if (active === undefined) {
        return {
          op: 'switch_scene', target: String(scene), acked: false, unconfirmed: true,
          warning: `🟡 ${shape.id} switch_scene: sent (function 0x0C) but ${deviceLabel} did not answer the scene query; check the front panel. ` + BETA_WARNING,
        };
      }
      if (active !== scene) {
        return {
          op: 'switch_scene', target: String(scene), acked: false,
          warning: `${shape.id} switch_scene: sent, but ${deviceLabel} reports scene ${active} is active, not ${scene}. ` + BETA_WARNING,
        };
      }
      return {
        op: 'switch_scene',
        target: String(scene),
        acked: true,
        info: `scene ${scene} is active (function 0x0C, confirmed by a scene query).`,
      };
    },

    async rename(ctx: DispatchCtx, target: RenameTarget, name: string): Promise<WriteResult> {
      gateWrite('rename');
      // Preset rename rides the gen-3 editor's OWN name write (fn=0x01
      // sub=0x28, Ghidra FACT tier), superseding the earlier fn=0x09 II-port
      // hypothesis. Scene rename rides the editor's indexed name write
      // (fn=0x01 sub=0x2b, scene index in the paramId14 field), the same op
      // its "Clear All Names" loop emits. Both are editor-decoded and
      // hardware-unverified (community-beta); the 0x64 error watch below
      // catches an on-device rejection either way.
      const sceneMatch = /^scene:(\d+)$/.exec(target);
      let bytes: number[];
      let what: string;
      try {
        if (target === 'preset') {
          bytes = codec.buildRenamePreset(name);
          what = 'preset';
        } else if (sceneMatch !== null) {
          const scene = Number(sceneMatch[1]); // 1-indexed (dispatcher-validated vs scene_count)
          bytes = codec.buildSetSceneName(scene - 1, name);
          what = `scene ${scene}`;
        } else {
          throw new DispatchError(
            'capability_not_supported',
            deviceLabel,
            `${shape.id} rename: unrecognized target '${target}' (valid: 'preset' or 'scene:N').`,
          );
        }
      } catch (err) {
        if (err instanceof DispatchError) throw err;
        throw new DispatchError(
          'value_out_of_range',
          deviceLabel,
          err instanceof Error ? err.message : String(err),
        );
      }
      const envelope = target === 'preset'
        ? 'fn=0x01 sub=0x28 RENAME_PRESET'
        : 'fn=0x01 sub=0x2b SET_SCENE_NAME';
      const errorReport = await sendAndWatchForError(ctx, bytes, 100);
      if (errorReport !== undefined) {
        return {
          op: 'rename',
          target,
          acked: false,
          warning:
            `${deviceLabel} rejected rename (${envelope} envelope) via 0x64 ` +
            `MULTIPURPOSE_RESPONSE: ${formatErrorCode(errorReport)}. ` + BETA_WARNING,
        };
      }
      if (target === 'preset') {
        // The loaded preset's name reads back with fn=0x0D (current).
        const now = await queryPatchName(ctx, 'current');
        if (now !== undefined) {
          const got = now.name.trim();
          const want = name.trim().slice(0, 32);
          return got === want
            ? { op: 'rename', target, acked: true, display_value: got, info: `the loaded preset is now named "${got}" (read back). Persist with save_preset.` }
            : { op: 'rename', target, acked: false, display_value: got, warning: `${shape.id} rename: sent, but the loaded preset reads back as "${got}", not "${want}". ` + BETA_WARNING };
        }
      }
      // Scene names (no model-bound read-back here) and a silent name query:
      // sent with no rejection is unconfirmed.
      return {
        op: 'rename',
        target,
        acked: false,
        unconfirmed: true,
        display_value: name,
        warning:
          `🟡 ${shape.id} rename: sent the ${envelope} envelope (the gen-3 editor's own ` +
          `name-write op, editor-decoded, hardware-unverified). Device emitted no rejection ` +
          `but may have ignored the write; confirm the ${what} title on the front panel. ` +
          `Working-buffer scope only; persist with save_preset. ` + BETA_WARNING,
      };
    },

    guardActiveBufferOrSave: makeGuard({
      codec,
      connectionLabel,
      deviceLabel,
      getResponseTimeoutMs,
      // Save persistence is not yet hardware-verified for III/FM3/FM9
      // (supports_save is false on the descriptor), so the auto-save path
      // must not emit the store op (fn=0x01 sub=0x26) during navigation.
      supportsSave: shape.supportsSave,
    }),
  };

  const buildDeps: BuildDeps = {
    writer, codec, catalog, shape, deviceLabel, connectionLabel, betaWarning: BETA_WARNING, getResponseTimeoutMs,
    channelValues, sendAndWatchForError, queryPatchName, formatErrorCode, parseLocation,
  };

  return writer;
}
