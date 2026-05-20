/**
 * Axe-Fx II DeviceDescriptor — `DeviceWriter` implementation.
 *
 * Wraps the existing Axe-Fx II protocol layer (setParam.ts, params.ts,
 * blockTypes.ts, applyExecutor.ts) into the `DeviceWriter` contract
 * from `src/protocol/generic/types.ts`.
 *
 * Two flavors of method:
 *   - Pure builders (`buildSetParam`, `buildSwitchPreset`,
 *     `buildSavePreset`, `buildSwitchScene`) — return wire bytes
 *     without touching the connection. Used by goldens to assert
 *     byte-equivalence with the legacy axefx2_* tools.
 *   - Execute methods (`setParam`, `setParams`, `switchPreset`,
 *     `savePreset`, `switchScene`, `setBlock`, `setBypass`,
 *     `applyPreset`, `applySetlist`, `rename`) — drive the wire
 *     round-trip via `ctx.conn` + the shared applyExecutor pipeline.
 *
 * Legacy `axefx2_*` tools keep working in parallel through v0.1.x;
 * this writer is what the unified `set_param` / `apply_preset` / etc.
 * dispatchers call at runtime.
 *
 * Per Q3 / Q6 (Session 66 wrap, 2026-05-12): scene-name rename and
 * multi-scene authoring are out of MVP scope. `rename(target='scene:N')`
 * throws `capability_not_supported`; PresetSpec.scenes[] uses only the
 * first entry's scene index (no per-scene channel/bypass walk).
 *
 * Per Q8 (Session 66 wrap): every `applyPreset` / `applySetlist` call
 * runs values through `descriptor.blocks[block].params[name].encode()`
 * BEFORE passing them to `buildApplyPresetAtOps` with `{wire: true}` —
 * the schema's encode closure is the canonical display→wire path; the
 * executor's auto-detect short-circuits in this mode.
 */

import type {
  ApplyResult,
  ApplySetlistResult,
  BatchWriteResult,
  BlockChange,
  ChainIntegrityResult,
  DeviceWriter,
  DispatchCtx,
  LocationRef,
  PresetSpec,
  RenameTarget,
  SetlistApplyOptions,
  SetlistEntryResult,
  SetlistEntrySpec,
  SlotRef,
  WriteResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { formatUnknownParamError } from '@mcp-midi-control/core/protocol-generic/dispatcher/errorFormat.js';
import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';

import {
  AXE_FX_II_BLOCKS,
  BLOCK_BY_ID,
  resolveBlock,
  type AxeFxIIBlock,
} from 'fractal-midi/axe-fx-ii';
import { KNOWN_PARAMS, type AxeFxIIParam } from 'fractal-midi/axe-fx-ii';
import {
  buildGetBlockChannel,
  buildGetPresetName,
  buildSetBlockBypass,
  buildSetBlockChannel,
  buildSetBlockParameterValue,
  buildSetGridCell,
  buildSetPresetName,
  buildSetSceneNumber,
  buildStorePreset,
  buildSwitchPreset,
  channelToWire,
  isGetBlockChannelResponse,
  isGetPresetNameResponse,
  isSetGridCellResponse,
  isStorePresetResponse,
  parseGetBlockChannelResponse,
  parseGetPresetNameResponse,
  parseSetGridCellResponse,
  parseStorePresetResponse,
  buildGetGridLayout,
  isGetGridLayoutResponse,
  parseGetGridLayoutResponse,
  type AxeFxIIChannel,
} from 'fractal-midi/axe-fx-ii';

import {
  buildApplyPresetAtOps,
  buildApplyPresetOps,
  runApplyPresetAtOps,
  type ApplyPresetAtInput,
  type ApplyPresetInput,
} from '../tools/applyExecutor.js';
import { findParamFuzzy } from 'fractal-midi/axe-fx-ii';
import { guardActiveBufferOrSave } from '../tools/shared.js';

import { findBlockBySlug, parseAxeFxIILocation } from './schema.js';

const DEVICE_LABEL = 'Fractal Axe-Fx II XL+';

// Channel-switch settle window. The Axe-Fx II silently absorbs param
// writes that race ahead of a channel switch — 20ms matches the legacy
// preset.ts settle.
const CHANNEL_SWITCH_SETTLE_MS = 20;

// Store-preset response timeout. The device acks 0x64 1D 00 within
// ~150ms on Q8.02; 800ms is generous.
const STORE_RESPONSE_TIMEOUT_MS = 800;
const GRID_CELL_RESPONSE_TIMEOUT_MS = 800;
const GET_NAME_TIMEOUT_MS = 800;
const GET_BLOCK_CHANNEL_TIMEOUT_MS = 800;

// ── Param-name → AxeFxIIParam ───────────────────────────────────────
// Resolution shared with legacy axefx2_* tools via paramAliases.ts.

function findParamByName(block: AxeFxIIBlock, name: string): AxeFxIIParam | undefined {
  return findParamFuzzy(block, name);
}

function resolveBlockOrThrow(slugOrName: string): AxeFxIIBlock {
  // Try descriptor-style slug first ("amp", "reverb"), then legacy
  // display-name resolver ("Amp 1", "Reverb 1") as fallback.
  const fromSlug = findBlockBySlug(slugOrName);
  if (fromSlug) return fromSlug;
  const fromName = resolveBlock(slugOrName);
  if (fromName) return fromName;
  const sample = AXE_FX_II_BLOCKS.slice(0, 6).map((b) => `"${b.name}"`).join(', ');
  throw new DispatchError(
    'unknown_block',
    DEVICE_LABEL,
    `Block '${slugOrName}' is not valid on Fractal Axe-Fx II. First few: ${sample}… (call list_params for the full list).`,
  );
}

/**
 * Enumerate valid param names on a block by walking `KNOWN_PARAMS`
 * and filtering on `groupCode`. Used by the shared unknown-param
 * error formatter so the error string lists every valid knob name
 * for the block, ordered by closeness to the bad input.
 */
function listParamNamesForBlock(block: AxeFxIIBlock): string[] {
  const out: string[] = [];
  for (const key of Object.keys(KNOWN_PARAMS)) {
    const p = KNOWN_PARAMS[key as keyof typeof KNOWN_PARAMS] as AxeFxIIParam;
    if (p.groupCode === block.groupCode && !out.includes(p.name)) {
      out.push(p.name);
    }
  }
  return out;
}

function findParamOrThrow(block: AxeFxIIBlock, name: string): AxeFxIIParam {
  const p = findParamByName(block, name);
  if (p) return p;
  throw new DispatchError(
    'unknown_param',
    DEVICE_LABEL,
    formatUnknownParamError({
      deviceName: DEVICE_LABEL,
      block: block.name,
      badParam: name,
      knownNames: listParamNamesForBlock(block),
    }),
  );
}

// ── Channel resolution helper ───────────────────────────────────────

function normalizeChannel(channel: string | number | undefined): AxeFxIIChannel | undefined {
  if (channel === undefined) return undefined;
  if (typeof channel === 'number') {
    if (channel === 0) return 'X';
    if (channel === 1) return 'Y';
    throw new DispatchError(
      'bad_channel',
      DEVICE_LABEL,
      `Channel index ${channel} is out of range on Fractal Axe-Fx II (valid: 0=X, 1=Y).`,
    );
  }
  const upper = channel.trim().toUpperCase();
  if (upper === 'X' || upper === 'Y') return upper as AxeFxIIChannel;
  throw new DispatchError(
    'bad_channel',
    DEVICE_LABEL,
    `Channel '${channel}' is not valid on Fractal Axe-Fx II (channels are X/Y).`,
    { valid_options: ['X', 'Y'] },
  );
}

// ── Pure builders ───────────────────────────────────────────────────

export const writer: DeviceWriter = {
  buildSetParam(blockSlug, name, wireValue): number[] {
    const block = resolveBlockOrThrow(blockSlug);
    const param = findParamOrThrow(block, name);
    return buildSetBlockParameterValue(
      { effectId: block.id, paramId: param.paramId },
      wireValue,
    );
  },

  buildChannelSwitch(blockSlug, channel): number[] {
    const block = resolveBlockOrThrow(blockSlug);
    if (!block.canBypass) {
      // canBypass is the closest proxy we have for "exposes channels" —
      // the channel field doesn't model "has channels" yet. Return empty
      // when channels aren't a concept for this block.
      return [];
    }
    return buildSetBlockChannel(block.id, channel === 0 ? 'X' : 'Y');
  },

  buildSwitchPreset(location): number[] {
    return buildSwitchPreset(parseAxeFxIILocation(location));
  },

  buildSavePreset(location, _name): number[] {
    // Pure builder returns ONLY the STORE bytes. Rename is a separate
    // wire op handled by the execute path.
    return buildStorePreset(parseAxeFxIILocation(location));
  },

  buildSwitchScene(scene): number[] {
    if (!Number.isInteger(scene) || scene < 1 || scene > 8) {
      throw new DispatchError(
        'bad_location',
        DEVICE_LABEL,
        `Scene index ${scene} out of range on Fractal Axe-Fx II (valid: 1..8).`,
      );
    }
    return buildSetSceneNumber(scene - 1);
  },

  // ── Execute: param writes ─────────────────────────────────────────

  async setParam(ctx, blockSlug, name, wireValue, channel): Promise<WriteResult> {
    const block = resolveBlockOrThrow(blockSlug);
    const param = findParamOrThrow(block, name);
    const channelWire = normalizeChannel(channel);

    // Channel-write safety (Session 102 fresh-machine finding). A
    // `buildSetBlockChannel` here mutates the block's channel pointer
    // on multiple scenes at once on Axe-Fx II (X/Y model), corrupting
    // the non-active scenes the user didn't intend to touch. The safe
    // pattern is to assert that the active scene's block is ALREADY on
    // the requested channel; if so the param write lands on that
    // channel's slot directly and no channel switch is needed. If the
    // active channel differs, refuse and point the agent at
    // `switch_scene` (or omit the channel arg). Root fix lives in
    // BK-070 via the preset-binary apply path.
    if (channelWire !== undefined && block.canBypass) {
      const reqBytes = buildGetBlockChannel(block.id);
      const ackPromise = ctx.conn.receiveSysExMatching(
        (bytes) => isGetBlockChannelResponse(bytes, block.id),
        GET_BLOCK_CHANNEL_TIMEOUT_MS,
      );
      ctx.conn.send(reqBytes);
      let active: AxeFxIIChannel;
      try {
        const ack = await ackPromise;
        active = parseGetBlockChannelResponse(ack);
      } catch (err) {
        throw new DispatchError(
          'no_ack',
          DEVICE_LABEL,
          `set_param: cannot verify ${block.name} channel before write — ${err instanceof Error ? err.message : String(err)}. ` +
          `Likely cause: ${block.name} is not placed on the active grid. Place the block first or omit the channel arg.`,
        );
      }
      if (active !== channelWire) {
        throw new DispatchError(
          'capability_not_supported',
          DEVICE_LABEL,
          `set_param: refusing to write ${block.name}.${param.name} on channel ${channelWire} — the active scene has ${block.name} on channel ${active}. ` +
          `On Axe-Fx II, switching a block's channel mutates the channel pointer across multiple scenes at once (not just the active scene), which silently corrupts other scenes' patches. ` +
          `Safe pattern: call switch_scene first to a scene that already has ${block.name} on channel ${channelWire}, OR omit the channel arg to write to whichever channel the active scene is already on.`,
          {
            valid_options: [active],
            retry_action:
              `Either call switch_scene to a scene that has ${block.name} on channel ${channelWire}, or drop the channel arg and write to the active channel (${active}).`,
          },
        );
      }
      // Channels already aligned — skip the SET_BLOCK_CHANNEL write
      // entirely; the param write below will land on this channel.
    }

    const bytes = buildSetBlockParameterValue(
      { effectId: block.id, paramId: param.paramId },
      wireValue,
    );
    ctx.conn.send(bytes);
    // Axe-Fx II SET is fire-and-forget — no wire ack. We surface
    // acked: true to match the AM4 descriptor's success shape and let
    // the warning carry the no-ack semantics.
    //
    // Reverse-display via the cross-device paramKind helper: one source
    // of truth for "wire -> display." Schema, reader, writer, and apply
    // executor all consult the same resolver so display_value matches
    // whatever set_param's encode closure round-trips to.
    const kind = resolveParamKind('axe-fx-ii', param.block, param.name);
    const display: number | string = kind.decodeWire !== undefined
      ? kind.decodeWire(wireValue)
      : wireValue;
    return {
      op: 'set_param',
      target: `${blockSlug}.${param.name}`,
      block: blockSlug,
      name: param.name,
      wire_value: wireValue,
      display_value: display,
      acked: true,
      channel: channelWire,
      warning: 'Axe-Fx II SET is fire-and-forget; verify by audible/visible response on the device.',
    };
  },

  async setParams(ctx, ops): Promise<BatchWriteResult> {
    const writes: WriteResult[] = [];
    let acked_count = 0;
    let unacked_count = 0;
    for (const op of ops) {
      try {
        const r = await writer.setParam!(ctx, op.block, op.name, op.value as number, op.channel);
        writes.push(r);
        if (r.acked) acked_count++;
        else unacked_count++;
      } catch (err) {
        writes.push({
          op: 'set_param',
          target: `${op.block}.${op.name}`,
          block: op.block,
          name: op.name,
          acked: false,
          warning: err instanceof Error ? err.message : String(err),
        });
        unacked_count++;
      }
    }
    return { writes, acked_count, unacked_count };
  },

  // ── Execute: preset navigation ────────────────────────────────────

  async switchPreset(ctx, location): Promise<WriteResult> {
    const n = parseAxeFxIILocation(location);
    const slot = n + 1;
    ctx.conn.send(buildSwitchPreset(n));
    // Switch is fire-and-forget; no ack from the device. Settle window
    // matches the legacy axefx2_apply_preset behavior.
    await new Promise((res) => setTimeout(res, CHANNEL_SWITCH_SETTLE_MS));
    return {
      op: 'switch_preset',
      target: String(slot),
      acked: true,
      info: `Loaded display slot ${slot} (wire ${n}). Any unsaved working-buffer edits were discarded.`,
    };
  },

  async savePreset(ctx, location, name): Promise<WriteResult> {
    const n = parseAxeFxIILocation(location);
    const slot = n + 1;
    // Optional rename FIRST (fire-and-forget — the device persists the
    // rename through the subsequent STORE).
    if (name !== undefined && name.length > 0) {
      try {
        ctx.conn.send(buildSetPresetName(name));
      } catch (err) {
        return {
          op: 'save_preset',
          target: String(slot),
          acked: false,
          warning: `Rename to "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    const ackPromise = ctx.conn.receiveSysExMatching(
      isStorePresetResponse,
      STORE_RESPONSE_TIMEOUT_MS,
    );
    ctx.conn.send(buildStorePreset(n));
    try {
      const ack = await ackPromise;
      const parsed = parseStorePresetResponse(ack);
      return {
        op: 'save_preset',
        target: String(slot),
        acked: parsed.ok,
        info: parsed.ok
          ? (name
              ? `Saved "${name}" to display slot ${slot} (wire ${n}).`
              : `Working buffer saved to display slot ${slot} (wire ${n}).`)
          : undefined,
        warning: parsed.ok
          ? undefined
          : `Device returned result code 0x${parsed.resultCode.toString(16)}; save likely rejected.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        op: 'save_preset',
        target: String(slot),
        acked: false,
        warning: `No STORE_PRESET ack within ${STORE_RESPONSE_TIMEOUT_MS}ms: ${msg}. Save state unknown; verify on the device.`,
      };
    }
  },

  async switchScene(ctx, scene): Promise<WriteResult> {
    if (!Number.isInteger(scene) || scene < 1 || scene > 8) {
      throw new DispatchError(
        'bad_location',
        DEVICE_LABEL,
        `Scene index ${scene} out of range on Fractal Axe-Fx II (valid: 1..8).`,
      );
    }
    ctx.conn.send(buildSetSceneNumber(scene - 1));
    return {
      op: 'switch_scene',
      target: `scene:${scene}`,
      acked: true,
      info: `Switched to scene ${scene} (wire ${scene - 1}). Subsequent param writes land in this scene's context.`,
    };
  },

  // ── Execute: block layout ─────────────────────────────────────────

  async setBlock(ctx, slot: SlotRef, change: BlockChange): Promise<WriteResult> {
    if (typeof slot === 'number') {
      throw new DispatchError(
        'bad_location',
        DEVICE_LABEL,
        `set_block on Fractal Axe-Fx II uses grid coordinates: pass slot as { row: 1..4, col: 1..12 }, not a single integer.`,
        { retry_action: 'Pass slot: { row, col }.' },
      );
    }
    const { row, col } = slot;
    if (change.block_type === undefined) {
      throw new DispatchError(
        'capability_not_supported',
        DEVICE_LABEL,
        `set_block on Fractal Axe-Fx II currently only handles block placement. Pass block_type to place/clear; use set_bypass for bypass writes; use set_param for channel switches.`,
        { retry_action: 'Call set_bypass(port, block, bypassed) or set_param(port, block, ...) for the other writes.' },
      );
    }
    let blockId: number;
    if (change.block_type === 'none' || change.block_type === 'empty') {
      blockId = 0;
    } else {
      const target = resolveBlockOrThrow(change.block_type);
      blockId = target.id;
    }
    const bytes = buildSetGridCell({ row, col, blockId });
    const ackPromise = ctx.conn.receiveSysExMatching(
      isSetGridCellResponse,
      GRID_CELL_RESPONSE_TIMEOUT_MS,
    );
    ctx.conn.send(bytes);
    try {
      const ack = await ackPromise;
      const parsed = parseSetGridCellResponse(ack);
      const blockName = blockId === 0 ? 'empty' : (BLOCK_BY_ID[blockId]?.name ?? `block #${blockId}`);
      return {
        op: 'set_block',
        target: `r${row}c${col}=${blockName}`,
        acked: parsed.ok,
        info: parsed.ok
          ? `Placed ${blockName} at row ${row}, col ${col}. Note: this write does NOT propagate routing; downstream cells' input masks still point at the previous occupant's position.`
          : undefined,
        warning: parsed.ok
          ? undefined
          : `Device returned result code 0x${parsed.resultCode.toString(16)}; placement rejected.`,
      };
    } catch (err) {
      return {
        op: 'set_block',
        target: `r${row}c${col}`,
        acked: false,
        warning: `No SET_GRID_CELL ack within ${GRID_CELL_RESPONSE_TIMEOUT_MS}ms: ${err instanceof Error ? err.message : String(err)}.`,
      };
    }
  },

  async setBypass(ctx, blockSlug, bypassed): Promise<WriteResult> {
    const block = resolveBlockOrThrow(blockSlug);
    if (!block.canBypass) {
      throw new DispatchError(
        'capability_not_supported',
        DEVICE_LABEL,
        `Block '${block.name}' on Fractal Axe-Fx II cannot be bypassed (e.g. Mixer / Input / Output blocks).`,
      );
    }
    ctx.conn.send(buildSetBlockBypass(block.id, bypassed));
    return {
      op: 'set_bypass',
      target: `${block.name}:${bypassed ? 'bypassed' : 'engaged'}`,
      acked: true,
      info: `${block.name} set to ${bypassed ? 'BYPASSED' : 'ENGAGED'}. Axe-Fx II SET is fire-and-forget; verify on the device.`,
    };
  },

  // ── Execute: apply preset ─────────────────────────────────────────

  async applyPreset(ctx, spec: PresetSpec, target?: LocationRef, options?): Promise<ApplyResult> {
    const startMs = Date.now();
    const shouldSave = options?.save ?? false;
    let translated: ApplyPresetAtInput | ApplyPresetInput;
    try {
      translated = translateSpec(spec);
    } catch (err) {
      return {
        ok: false,
        steps: 0,
        duration_ms: Date.now() - startMs,
        failed_step: {
          index: 0,
          description: 'validate',
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }

    if (target !== undefined) {
      // parseAxeFxIILocation returns wire (0-indexed); the executor's
      // internal `preset_number` field IS wire.
      const presetNumber = parseAxeFxIILocation(target);
      const fullOps = buildApplyPresetAtOps(
        { ...translated, preset_number: presetNumber },
        { wire: true },
      );
      // Audition-at-target mode strips the trailing STORE op so the
      // build lives in the working buffer at the target, unsaved.
      // Reversible by switching presets. The switch_preset head op
      // still runs — that's the navigation the user asked for.
      const ops = shouldSave ? fullOps : fullOps.filter((op) => op.kind !== 'save');
      const result = await runApplyPresetAtOps(ctx.conn, ops);
      const slot = presetNumber + 1;
      return {
        ok: result.ok,
        steps: ops.length,
        duration_ms: result.elapsedMs,
        saved: shouldSave && result.ok,
        failed_step: result.lastNack
          ? {
              index: 0,
              description: result.lastNack.summary,
              error: `result_code=0x${result.lastNack.resultCode.toString(16)}`,
            }
          : undefined,
        warning: !result.ok && !result.lastNack
          ? `STORE_PRESET did not ack within ${STORE_RESPONSE_TIMEOUT_MS}ms; save state unknown.`
          : !shouldSave && result.ok
          ? `Auditioning at display slot ${slot}, working buffer only, not saved. ` +
            `Reversible by switching presets. Call save_preset({port:'axe-fx-ii', location:${slot}}) ` +
            `when the user explicitly asks to save / keep / persist.`
          : undefined,
      };
    }

    // Working-buffer-only path: no switch_preset head, no STORE tail.
    const ops = buildApplyPresetOps(translated, { wire: true });
    const result = await runApplyPresetAtOps(ctx.conn, ops);
    return {
      ok: result.ok,
      steps: ops.length,
      duration_ms: result.elapsedMs,
      failed_step: result.lastNack
        ? {
            index: 0,
            description: result.lastNack.summary,
            error: `result_code=0x${result.lastNack.resultCode.toString(16)}`,
          }
        : undefined,
      warning: result.ok
        ? `Working buffer configured. Press SAVE on the device or call save_preset to persist.`
        : undefined,
    };
  },

  // ── Execute: BK-057 verify chain ──────────────────────────────────
  //
  // Read the working-buffer grid via fn 0x20 and walk row 2 cells past
  // col 1, flagging any cell with `routingFlags === 0`. A non-zero
  // routing mask means signal flows; a zero mask is a broken cable.
  // Logic lifted from axefx2_test_apply; this folds it into the
  // unified surface so the agent doesn't have to switch tools.

  async verifyChain(ctx, _spec): Promise<ChainIntegrityResult> {
    const GRID_TIMEOUT_MS = 800;
    const gridPromise = ctx.conn.receiveSysExMatching(
      isGetGridLayoutResponse,
      GRID_TIMEOUT_MS,
    );
    ctx.conn.send(buildGetGridLayout());
    let breaks: Array<{ slot_ref: SlotRef; reason: string }> = [];
    try {
      const gridBytes = await gridPromise;
      const cells = parseGetGridLayoutResponse(gridBytes);
      for (const c of cells) {
        if (c.blockId === 0) continue;
        if (c.row !== 2) continue;
        if (c.col > 1 && c.routingFlags === 0) {
          breaks.push({
            slot_ref: { row: c.row, col: c.col },
            reason: `block id ${c.blockId} placed at row ${c.row} col ${c.col} has routing_mask=0; signal does not flow through this cell.`,
          });
        }
      }
    } catch (err) {
      return {
        ok: false,
        breaks: [],
        summary: `verify_chain: failed to read grid (${err instanceof Error ? err.message : String(err)}).`,
        extra_round_trips: 1,
      };
    }
    return {
      ok: breaks.length === 0,
      breaks,
      summary: breaks.length === 0
        ? `verify_chain: chain intact; every placed block on row 2 has live routing.`
        : `verify_chain: ${breaks.length} broken cable${breaks.length === 1 ? '' : 's'} on row 2; signal will not flow past col ${breaks[0].slot_ref && typeof breaks[0].slot_ref === 'object' ? (breaks[0].slot_ref as { col: number }).col : '?'}.`,
      extra_round_trips: 1,
    };
  },

  async applySetlist(
    ctx,
    entries: readonly SetlistEntrySpec[],
    options?: SetlistApplyOptions,
  ): Promise<ApplySetlistResult> {
    const onError: 'stop' | 'continue' = options?.on_error ?? 'stop';
    const dryRun = options?.dry_run ?? false;
    const verifyEnabled = options?.verify ?? false;
    const startMs = Date.now();

    // Pre-validation: resolve locations, check uniqueness, translate spec,
    // build ops up front so a bad entry at index 7 doesn't half-execute.
    const resolved: { location: string; presetNumber: number; ops: ReturnType<typeof buildApplyPresetAtOps>; name?: string }[] = [];
    const seenPresets = new Set<number>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      // parseAxeFxIILocation returns wire (0-indexed); store display
      // slot in the user-facing `location` field.
      const presetNumber = parseAxeFxIILocation(e.location);
      const slot = presetNumber + 1;
      if (seenPresets.has(presetNumber)) {
        throw new DispatchError(
          'bad_location',
          DEVICE_LABEL,
          `entries[${i}] (display slot ${slot}): appears more than once in the batch; each preset slot may appear at most once per call.`,
        );
      }
      seenPresets.add(presetNumber);
      try {
        const translated = translateSpec(e.spec);
        const ops = buildApplyPresetAtOps(
          { ...translated, preset_number: presetNumber },
          { wire: true },
        );
        resolved.push({
          location: String(slot),
          presetNumber,
          ops,
          name: e.spec.name,
        });
      } catch (err) {
        throw new DispatchError(
          'value_out_of_range',
          DEVICE_LABEL,
          `entries[${i}] (display slot ${slot}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (dryRun) {
      return {
        ok: true,
        total: resolved.length,
        applied: 0,
        failed: 0,
        remaining: [],
        results: resolved.map((r) => ({
          location: r.location,
          status: 'ok' as const,
          wallTimeMs: 0,
        })),
        totalWallTimeMs: Date.now() - startMs,
      };
    }

    const results: SetlistEntryResult[] = [];
    let applied = 0;
    let failed = 0;
    let stopIndex: number | undefined;
    let finalActiveLocation: string | undefined;

    for (let i = 0; i < resolved.length; i++) {
      const entry = resolved[i];
      const entryStart = Date.now();
      try {
        const result = await runApplyPresetAtOps(ctx.conn, entry.ops);
        finalActiveLocation = entry.location;

        let verifyError: string | undefined;
        if (verifyEnabled && result.ok && entry.name !== undefined) {
          try {
            const ackPromise = ctx.conn.receiveSysExMatching(
              isGetPresetNameResponse,
              GET_NAME_TIMEOUT_MS,
            );
            ctx.conn.send(buildGetPresetName());
            const ack = await ackPromise;
            const liveName = parseGetPresetNameResponse(ack);
            if (liveName !== entry.name) {
              verifyError = `verify: preset name mismatch. Wrote "${entry.name}", device reports "${liveName}".`;
            }
          } catch (err) {
            verifyError = `verify: GET_PRESET_NAME failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        if (result.ok && verifyError === undefined) {
          applied++;
          results.push({
            location: entry.location,
            status: 'ok',
            wallTimeMs: Date.now() - entryStart,
          });
        } else {
          failed++;
          const errMsg = verifyError
            ?? (result.lastNack
              ? `${result.lastNack.summary} → result=0x${result.lastNack.resultCode.toString(16)}`
              : 'no STORE_PRESET ack arrived');
          results.push({
            location: entry.location,
            status: 'error',
            error: errMsg,
            wallTimeMs: Date.now() - entryStart,
          });
          if (onError === 'stop') {
            stopIndex = i;
            break;
          }
        }
      } catch (err) {
        failed++;
        results.push({
          location: entry.location,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          wallTimeMs: Date.now() - entryStart,
        });
        if (onError === 'stop') {
          stopIndex = i;
          break;
        }
      }
    }

    const remaining = stopIndex !== undefined
      ? resolved.slice(stopIndex + 1).map((r) => r.location)
      : [];

    return {
      ok: failed === 0,
      total: resolved.length,
      applied,
      failed,
      remaining,
      results,
      totalWallTimeMs: Date.now() - startMs,
      finalActiveLocation,
    };
  },

  // ── Execute: rename ───────────────────────────────────────────────

  async rename(ctx, target: RenameTarget, name): Promise<WriteResult> {
    if (target === 'preset') {
      ctx.conn.send(buildSetPresetName(name));
      return {
        op: 'rename',
        target: 'preset',
        acked: true,
        info: `Working-buffer preset renamed to "${name}". Press SAVE or call save_preset to persist.`,
      };
    }
    // 'scene:N' — no decoded SET_SCENE_NAME on Axe-Fx II yet.
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      `rename target '${target}' is not supported on Fractal Axe-Fx II; scene-name writes have no decoded SysEx envelope on this device. Only target='preset' is implemented.`,
    );
  },

  /**
   * Safe-edit dirty-gate adapter. Delegates to the device-specific
   * implementation in tools/shared.ts which uses Axe-Fx II's device-
   * sourced dirty signal (0x74 state-broadcast triple) for authoritative
   * dirty tracking.
   */
  async guardActiveBufferOrSave(_ctx, mode) {
    return guardActiveBufferOrSave(mode);
  },
};

// ── PresetSpec → ApplyPresetInput translation ───────────────────────
//
// Maps the device-agnostic `PresetSpec` from `src/protocol/generic/types.ts`
// onto the Axe-Fx II-native shape the executor consumes.
//
// MVP simplifications (Section 6, Q1 + Q6 + Q7 of the descriptor plan):
//   - Single-instance addressing — every `block_type` resolves to
//     instance 1 of that group (no `amp_1` / `amp_2` discrimination).
//
// BK-058 (Session 99): channel-nested params (`{X: {gain: 6}, Y: {gain: 8}}`)
// flow through to the executor as `paramsByChannel` so every channel's
// writes land on the wire. AM4's same-shape executor already did this;
// II previously honored only the first channel and silently dropped the
// rest (smoking gun in Session 98 Enter Sandman test).
//
// Multi-scene authoring + landingScene restored v0.3 parity audit
// (Session 68 / HW-106 — switch-write-switch-back walk maps each
// scene's per-block bypass + channel state).

function translateSpec(spec: PresetSpec): ApplyPresetInput {
  // v0.4 routing-walk landed (BK-054 step 4). When `spec.routing` is
  // present, every block must specify slot:{row,col} explicitly and the
  // executor emits one fn 0x06 cable per edge. When omitted, the
  // legacy row-2 auto-chain pipeline runs — back-compat for every
  // pre-v0.4 caller and golden.
  const explicitRouting = spec.routing !== undefined && spec.routing.length > 0;

  // Sort slots by grid column so the executor builds the chain
  // left-to-right. Per Section 6, all rows must be row 2 (auto-routing
  // limitation).
  const sorted = [...spec.slots].sort((a, b) => {
    const colA = typeof a.slot === 'object' ? a.slot.col : a.slot;
    const colB = typeof b.slot === 'object' ? b.slot.col : b.slot;
    return colA - colB;
  });

  const blocks: ApplyPresetAtInput['blocks'] = [];
  for (const s of sorted) {
    let row: number;
    let col: number | undefined;
    if (typeof s.slot === 'object') {
      row = s.slot.row;
      col = s.slot.col;
    } else {
      row = 2;
      col = s.slot;
    }
    if (!explicitRouting && row !== 2) {
      throw new DispatchError(
        'value_out_of_range',
        'Fractal Axe-Fx II',
        `slot row=${row}: without an explicit routing[] array, Axe-Fx II placement is row-2-only (auto-chain mode wires row 2 left-to-right).`,
        {
          retry_action: 'Either move every block to row 2 ({row:2,col:N}), or supply spec.routing[] with explicit cabling edges between block ids.',
        },
      );
    }

    let channel: AxeFxIIChannel | undefined;
    let params: Record<string, number> | undefined;
    let paramsByChannel:
      | Partial<Record<AxeFxIIChannel, Record<string, number>>>
      | undefined;
    if (s.params) {
      // PresetSpec.params accepts two shapes (unified schema): flat
      // `{gain: 6}` (writes land on the currently-active channel) or
      // channel-nested `{X: {gain: 6}, Y: {gain: 8}}`. Axe-Fx II has
      // X/Y on every block; flat = current-channel-write; nested = the
      // executor walks every supplied channel, switching channel and
      // writing that channel's params for each entry (BK-058).
      const entries = Object.entries(s.params as Record<string, unknown>);
      let nestedCount = 0;
      let flatCount = 0;
      for (const [, v] of entries) {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) nestedCount++;
        else flatCount++;
      }
      if (nestedCount > 0 && flatCount > 0) {
        throw new DispatchError(
          'value_out_of_range',
          'Fractal Axe-Fx II',
          `slots[${col ?? row}] (block ${s.block_type}): params mixes flat values and channel-nested objects.`,
          {
            retry_action: 'Use one shape per slot: flat `{gain: 6}` to write to the current channel, or channel-nested `{X: {gain: 6}}` to address X/Y explicitly.',
          },
        );
      }
      if (nestedCount > 0) {
        paramsByChannel = {};
        for (const [chKey, paramMap] of entries) {
          const upper = chKey.trim().toUpperCase();
          if (upper !== 'X' && upper !== 'Y') {
            throw new DispatchError(
              'value_out_of_range',
              'Fractal Axe-Fx II',
              `slots[${col ?? row}] (block ${s.block_type}): params has unknown channel key "${chKey}".`,
              {
                valid_options: ['X', 'Y'],
                retry_action: 'Axe-Fx II blocks have two channels: X and Y. AM4 / III A/B/C/D channel keys do not apply here.',
              },
            );
          }
          const ch = upper as AxeFxIIChannel;
          const encoded: Record<string, number> = {};
          for (const [k, v] of Object.entries(paramMap as Record<string, number | string>)) {
            // Values are still display units here; encodeParamForApply
            // runs them through display→wire BEFORE we hand off to the
            // executor with {wire: true}.
            encoded[k] = encodeParamForApply(s.block_type, k, v);
          }
          paramsByChannel[ch] = encoded;
        }
      } else if (flatCount > 0) {
        params = {};
        for (const [k, v] of entries) {
          params[k] = encodeParamForApply(s.block_type, k, v as number | string);
        }
      }
    }

    // Resolve the slot's block_type slug ("compressor", "amp", "reverb")
    // into the executor-expected display name ("Compressor 1", "Amp 1",
    // "Reverb 1"). The unified surface uses lowercase slugs per the
    // descriptor's `block_aliases`; the legacy applyExecutor's findBlock
    // helper only matches display names + effectIds. Without this
    // resolution step, applyPreset({port:'axe-fx-ii', spec:{slots:
    // [{block_type:'compressor'}]}}) errors with "Unknown block
    // 'compressor'" (caught in Session 73 hardware test 1).
    const resolvedBlock = findBlockBySlug(s.block_type);
    blocks.push({
      block: resolvedBlock ? resolvedBlock.name : s.block_type,
      bypass: s.bypassed,
      channel,
      params,
      paramsByChannel,
      // v0.4: thread id / row / col through. Auto-id derives from the
      // block_type slug when the caller didn't supply one.
      id: s.id ?? `${s.block_type.toLowerCase()}${s.instance !== undefined && s.instance !== 1 ? `_${s.instance}` : ''}`,
      row,
      col,
    });
  }

  // Multi-scene authoring (HW-106 / Session 68 parity, restored v0.3).
  // Walk every PresetSpec.scenes entry — each provides per-block
  // bypass + channel state for that scene. The executor handles the
  // switch-write-switch-back wire pattern.
  let scenes: NonNullable<ApplyPresetAtInput['scenes']> | undefined;
  if (spec.scenes && spec.scenes.length > 0) {
    scenes = spec.scenes.map((sc) => {
      if (!Number.isInteger(sc.scene) || sc.scene < 1 || sc.scene > 8) {
        throw new DispatchError(
          'value_out_of_range',
          'Fractal Axe-Fx II',
          `scenes[].scene=${sc.scene} out of range (1..8).`,
          { retry_action: 'Axe-Fx II has 8 scenes per preset; pass scene as 1..8.' },
        );
      }
      // Resolve scene-map block keys from slugs → executor display
      // names (same translation as slots[].block_type above). Without
      // this, scenes[].bypassed/channels with slug keys (e.g.
      // {drive: true}) error in the executor's findBlock helper which
      // only matches display names like "Drive 1".
      const resolveSceneKey = (slugOrName: string): string => {
        const fromSlug = findBlockBySlug(slugOrName);
        return fromSlug ? fromSlug.name : slugOrName;
      };
      const channels: Record<string, 'X' | 'Y'> | undefined = sc.channels && Object.keys(sc.channels).length > 0
        ? Object.fromEntries(Object.entries(sc.channels).map(([blk, ch]) => {
            const letter = typeof ch === 'number' ? (ch === 0 ? 'X' : 'Y') : String(ch).toUpperCase();
            if (letter !== 'X' && letter !== 'Y') {
              throw new DispatchError(
                'value_out_of_range',
                'Fractal Axe-Fx II',
                `scenes[${sc.scene}].channels.${blk}=${ch} not a valid Axe-Fx II channel.`,
                { valid_options: ['X', 'Y'], retry_action: 'Axe-Fx II channels are X or Y only.' },
              );
            }
            return [resolveSceneKey(blk), letter as 'X' | 'Y'];
          }))
        : undefined;
      const bypass: Record<string, boolean> | undefined = sc.bypassed && Object.keys(sc.bypassed).length > 0
        ? Object.fromEntries(Object.entries(sc.bypassed).map(([blk, b]) => [resolveSceneKey(blk), b]))
        : undefined;
      return { index: sc.scene, channels, bypass };
    });
  }

  // landingScene — scene the device sits on after the build. Default 1
  // when scenes are authored (executor enforces this). When only a
  // single scene is requested (legacy single-scene mode), keep the
  // back-compat behaviour: spec.landingScene drives `scene` (the
  // single-scene shortcut) so old callers that just want "switch to
  // scene N first" still work.
  let scene: number | undefined;
  if (scenes === undefined && spec.landingScene !== undefined) {
    if (!Number.isInteger(spec.landingScene) || spec.landingScene < 1 || spec.landingScene > 8) {
      throw new DispatchError(
        'value_out_of_range',
        'Fractal Axe-Fx II',
        `landingScene=${spec.landingScene} out of range (1..8).`,
        { retry_action: 'Axe-Fx II has 8 scenes; pass landingScene as 1..8.' },
      );
    }
    scene = spec.landingScene - 1;
  }

  // v0.4: thread routing[] through. Caller IDs must match the auto-
  // derived or explicit ids on blocks[]; the executor cross-checks and
  // errors clearly if a routing edge references a non-existent block.
  const routing: ApplyPresetAtInput['routing'] | undefined = spec.routing && spec.routing.length > 0
    ? spec.routing.map((e) => ({ from: e.from, to: e.to, connect: e.connect }))
    : undefined;

  return {
    blocks,
    scene,
    scenes,
    routing,
    landingScene: spec.landingScene,
    name: spec.name,
  };
}

/**
 * Pre-encode a single param value for the apply path. Funnels through
 * the shared `resolveParamKind` helper so apply_preset, set_param, and
 * the reader all share one display->wire source of truth.
 *
 * Calibrated params (catalog or overlay) use the helper's
 * `encodeDisplay` closure verbatim — same closure the schema's encode
 * uses. Uncalibrated params still fall back to wire pass-through with
 * 0..65534 range validation.
 */
function encodeParamForApply(
  blockSlug: string,
  paramName: string,
  value: number | string,
): number {
  const block = resolveBlockOrThrow(blockSlug);
  const param = findParamOrThrow(block, paramName);
  const kind = resolveParamKind('axe-fx-ii', param.block, param.name);
  if (kind.encodeDisplay !== undefined) {
    return kind.encodeDisplay(value);
  }
  // Uncalibrated path — wire pass-through. Matches schema.ts:makeEncode
  // fallback semantics so set_param and apply_preset behave identically
  // on opaque knobs.
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new DispatchError(
      'value_out_of_range',
      'Fractal Axe-Fx II',
      `${blockSlug}.${paramName}: expected a number, got "${value}".`,
      { retry_action: 'Pass a finite display value (number or enum string). This param lacks a calibrated display range so wire integers 0..65534 are also accepted.' },
    );
  }
  if (!Number.isInteger(num) || num < 0 || num > 65534) {
    throw new DispatchError(
      'value_out_of_range',
      'Fractal Axe-Fx II',
      `${blockSlug}.${paramName}: wire value out of range (0..65534): ${num}`,
      { retry_action: 'Uncalibrated param; pass an integer 0..65534. Call list_params({port:"axe-fx-ii", block:"<block>", name:"<param>"}) to confirm the controlType.' },
    );
  }
  return num;
}

// Re-export channelToWire so the writer-internal channel handling and
// the schema.ts findBlockBySlug helper share the same coercion path.
export { channelToWire };
