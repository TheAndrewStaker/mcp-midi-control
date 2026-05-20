/**
 * AM4 DeviceDescriptor — `DeviceWriter` implementation.
 *
 * Wraps the existing AM4 protocol layer (params.ts, blockTypes.ts,
 * setParam.ts, applyExecutor.ts, factoryBank.ts) into the
 * `DeviceWriter` contract from `src/protocol/generic/types.ts`.
 *
 * Two flavors of method:
 *   - Pure builders (`buildSetParam`, `buildSwitchPreset`,
 *     `buildSavePreset`, `buildSwitchScene`) — return wire bytes
 *     without touching the connection. Used by goldens to assert
 *     byte-equivalence with the legacy am4_* tools.
 *   - Execute methods (`setParam`, `setParams`, `switchPreset`,
 *     `savePreset`, `switchScene`, `setBlock`, `setBypass`,
 *     `applyPreset`, `applySetlist`, `restoreDefaults`,
 *     `restoreDefaultsRange`, `rename`) — drive the wire round-trip
 *     via `sendAndAwaitAck` + the shared applyExecutor pipeline.
 *
 * Legacy `am4_*` tools keep working in parallel through v0.1.0; this
 * writer is what the unified `set_param` / `apply_preset` / etc.
 * dispatchers call at runtime.
 */

import type {
  ApplyResult,
  ApplySetlistResult,
  BatchWriteResult,
  DeviceWriter,
  DispatchCtx,
  PresetSpec,
  RenameTarget,
  RestoreDefaultsOptions,
  RestoreDefaultsRangeOptions,
  RestoreDefaultsRangeResult,
  RestoreDefaultsResult,
  SceneSpec,
  SetlistApplyOptions,
  SetlistEntrySpec,
  SetlistEntryResult,
  WriteResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  KNOWN_PARAMS,
  type Param,
  type ParamKey,
} from 'fractal-midi/am4';
import {
  BLOCK_NAMES_BY_VALUE,
  BLOCK_TYPE_VALUES,
  resolveBlockType,
} from 'fractal-midi/am4';
import {
  buildNudgeParam,
  buildSaveToLocation,
  buildSetBlockBypass,
  buildSetBlockType,
  buildSetParam,
  buildSetPresetName,
  buildSetSceneName,
  buildSwitchPreset,
  buildSwitchScene,
  buildToggleBlockBypass,
  isCommandAck,
  isWriteEcho,
} from 'fractal-midi/am4';
import {
  prepareApplyPresetWrites,
  runApplyPresetAt,
  runApplyPresetWires,
  type ApplyPresetInput,
  type ApplyPresetSceneInput,
  type ApplyPresetSlotInput,
} from '../tools/applyExecutor.js';
import { loadFactoryBank, sendFactoryRestore } from '../factoryBank.js';
import {
  guardActiveAM4BufferOrSave,
  refreshAM4Fingerprint,
  warmupAM4BaselineIfNeeded,
} from '../tools/safeEdit.js';
import { readPresetName } from '../shared/readOps.js';
import { recordInbound, sendAndAwaitAck } from '../shared/wireOps.js';
import {
  CHANNEL_BLOCKS,
  channelLetter,
  invalidateChannelCache,
  lastKnownType,
  observeWrittenParam,
  switchBlockChannel,
} from '../shared/channels.js';
import { checkApplicability } from 'fractal-midi/am4';
import type { ApplyPresetSkippedParam } from '../tools/applyExecutor.js';

/**
 * Predicate matching the AM4's wire-ack for the new Session 104 opcodes
 * (TOGGLE 0x07, INCR 0x03, DECR 0x05, INCR_COARSE 0x04, DECR_COARSE 0x06,
 * SET_NORM 0x02). Shape captured live Session 104:
 *
 *   F0 00 01 74 15 01 <pidLow septets> <pidHigh septets>
 *                     <ACTION septets> 00 00 <hdr4=0x0028> ...payload... <cs> F7
 *
 * Identical envelope to `isWriteEcho` BUT the action byte echoes the
 * outgoing request (e.g. 0x03 for INCR), not the canonical WRITE 0x01.
 * hdr4 is still 0x0028 (40-byte param descriptor payload) so the
 * receipt-echo / loopback variants (hdr4=0x0004) are still filtered out.
 */
function isNudgeOrToggleAck(write: number[], response: number[]): boolean {
  if (response.length < 16) return false;
  // Envelope + function byte (bytes 0..5) match the outgoing write.
  for (let i = 0; i < 6; i++) if (response[i] !== write[i]) return false;
  // Addressing (pidLow 6..7, pidHigh 8..9, action 10..11) echoes the request.
  for (let i = 6; i < 12; i++) if (response[i] !== write[i]) return false;
  // hdr4 = 0x0028 (40-byte payload). Filters out the 18B cmd-ack shape
  // and the loopback receipt-echo (which has the outgoing hdr4 of 0x0000).
  if (response[14] !== 0x28 || response[15] !== 0x00) return false;
  return true;
}

/**
 * Render a skip list (params the applicability gate dropped) into a
 * single human-readable warning string. Returns `undefined` when the
 * list is empty so the writer can omit the warning instead of carrying
 * a trailing "Skipped 0 params" line.
 *
 * Surfaced by apply_preset's response so the agent can honestly tell
 * the user which knobs were dropped from the build (e.g. "amp.mid on
 * Deluxe Verb Vibrato — no Mid knob on that amp model"). Without this
 * the agent would claim the writes landed; the device silently no-ops
 * them and the user wonders why their tweaks aren't audible.
 */
function formatSkippedNote(skipped: readonly ApplyPresetSkippedParam[]): string | undefined {
  if (skipped.length === 0) return undefined;
  const lines = skipped.map((s) => `  - ${s.block}.${s.paramName}: ${s.reason}`);
  return (
    `Dropped ${skipped.length} param${skipped.length === 1 ? '' : 's'} ` +
    `that don't apply on the active block type${skipped.length === 1 ? '' : 's'} ` +
    `(would have been silently no-op'd on the device):\n${lines.join('\n')}\n` +
    `The rest of the build landed; report these as "not applied" to the user.`
  );
}
import {
  formatLocationCode,
  formatLocationDisplay,
} from 'fractal-midi/am4';

import { parseAm4Location } from './schema.js';

/**
 * Translate the generic-surface PresetSpec into the AM4-native
 * ApplyPresetInput shape. The legacy AM4 schema supports `channel`
 * (single-channel shortcut) and `params` (current-channel) for backward
 * compat; the unified surface only exposes per-channel `channels`, so
 * we translate slots[].params (channel → name → value) onto the legacy
 * `channels` field. Shared by `validatePreset` (pre-MIDI) and
 * `applyPreset` (execute) so both paths see byte-identical translated
 * input.
 */
function specToApplyInput(spec: PresetSpec): ApplyPresetInput {
  // v0.4: linear devices route implicitly by slot order. Routing edges
  // are a grid-device concept; surfacing them on AM4 means the caller's
  // mental model is wrong (probably ported a wet/dry grid spec into an
  // AM4 call). Error early with a clear message rather than silently
  // ignoring — the silent path would let the user think they have a
  // parallel chain on a device that can't do one.
  if (spec.routing !== undefined && spec.routing.length > 0) {
    throw new DispatchError(
      'capability_not_supported',
      'Fractal AM4',
      `apply_preset on Fractal AM4 does not accept routing edges; AM4 routes implicitly by slot order (slots 1→2→3→4). Drop the routing array, or pick a grid device (Axe-Fx II) for parallel chains / wet-dry splits.`,
    );
  }
  const slots: ApplyPresetSlotInput[] = spec.slots.map((s, slotIdx) => {
    if (typeof s.slot !== 'number') {
      throw new DispatchError(
        'capability_not_supported',
        'Fractal AM4',
        `apply_preset on Fractal AM4 uses linear slots: pass slot as a 1..4 integer, not {row,col}.`,
      );
    }
    // v0.4: AM4 has one instance of each block type. Reject anything
    // other than 1 (or omitted) so the caller gets a clear "this is a
    // single-instance device" message instead of silent misbehavior.
    if (s.instance !== undefined && s.instance !== 1) {
      throw new DispatchError(
        'capability_not_supported',
        'Fractal AM4',
        `apply_preset on Fractal AM4 has one instance per block type (instance=${s.instance} requested for ${s.block_type}). Drop the instance field; AM4 doesn't expose Amp 1 / Amp 2 / etc.`,
      );
    }

    // The unified schema accepts two `params` shapes: flat
    // (`{rate: 0.8}`) for non-channel blocks, and channel-nested
    // (`{A: {gain: 6}}`) for channel blocks. Detect per slot — any
    // value being a plain object means the agent used the nested shape.
    // Reject mixed shapes (some primitive, some object) up front so the
    // caller gets a clear message rather than a confusing executor
    // error downstream.
    let flatParams: Record<string, number | string> | undefined;
    let nestedChannels: Record<string, Record<string, number | string>> | undefined;
    if (s.params) {
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
          'Fractal AM4',
          `slots[${slotIdx}] (slot ${s.slot}, ${s.block_type}): params mixes flat values and channel-nested objects. Use one shape per slot: flat \`{rate: 0.8}\` for non-channel blocks, or channel-nested \`{A: {gain: 6}}\` for channel blocks (amp/drive/reverb/delay).`,
        );
      }
      if (nestedCount > 0) {
        nestedChannels = {};
        for (const [ch, paramMap] of entries) {
          nestedChannels[ch] = { ...(paramMap as Record<string, number | string>) };
        }
      } else if (flatCount > 0) {
        flatParams = {};
        for (const [k, v] of entries) {
          flatParams[k] = v as number | string;
        }
      }
    }

    return {
      position: s.slot,
      block_type: s.block_type,
      params: flatParams,
      channels: nestedChannels,
    };
  });

  const scenes: ApplyPresetSceneInput[] | undefined = spec.scenes?.map((sc: SceneSpec) => {
    const channels: Record<string, string> = {};
    if (sc.channels) {
      for (const [block, ch] of Object.entries(sc.channels)) {
        channels[block] = typeof ch === 'number' ? ['A', 'B', 'C', 'D'][ch] : String(ch);
      }
    }
    return {
      index: sc.scene,
      name: sc.name,
      channels: Object.keys(channels).length > 0 ? channels : undefined,
      bypass: sc.bypassed ? { ...sc.bypassed } : undefined,
    };
  });

  // landingScene parity (restored v0.3 audit). AM4 scenes are 1..4
  // and the executor clamps; explicit out-of-range throws early.
  let landingScene: 1 | 2 | 3 | 4 | undefined;
  if (spec.landingScene !== undefined) {
    if (!Number.isInteger(spec.landingScene) || spec.landingScene < 1 || spec.landingScene > 4) {
      throw new DispatchError(
        'value_out_of_range',
        'Fractal AM4',
        `landingScene=${spec.landingScene} out of range on Fractal AM4 (valid: 1..4).`,
      );
    }
    landingScene = spec.landingScene as 1 | 2 | 3 | 4;
  }

  return { slots, name: spec.name, scenes, landingScene };
}

/**
 * After a successful save_preset, switch the active location to the
 * just-saved target so the user sees and hears what they saved.
 *
 * No dirty gate here: the user explicitly authorized the save, and the
 * working buffer's contents now match the save target. Switching to
 * target can't surprise them — there is nothing to lose. (The
 * fingerprint gate exists to prevent SILENT data loss on navigation
 * the user didn't ask for; that isn't this case.)
 *
 * Returns `undefined` on success, or a warning string when the post-
 * save switch didn't ack. Callers append the warning to their result
 * rather than reporting a save failure — the save itself succeeded.
 */
async function runPostSaveSwitch(
  ctx: DispatchCtx,
  locationIndex: number,
): Promise<string | undefined> {
  const switchBytes = buildSwitchPreset(locationIndex);
  const switchResult = await sendAndAwaitAck(ctx.conn, switchBytes, isWriteEcho);
  // New preset = new channel layout; existing cache is stale.
  invalidateChannelCache();
  if (!switchResult.acked) {
    return (
      `Saved, but the follow-up switch to ${formatLocationDisplay(locationIndex)} ` +
      `didn't ack within the write-echo timeout. The save persisted; navigate ` +
      `to ${formatLocationDisplay(locationIndex)} manually on the AM4 to load it.`
    );
  }
  // Save committed the working buffer to flash at this location; the
  // buffer now matches the stored preset. Refresh the fingerprint
  // cache so the next dirty-gate check has a clean baseline.
  await refreshAM4Fingerprint(ctx.conn, locationIndex);
  return undefined;
}

export const writer: DeviceWriter = {
  buildSetParam(block, name, displayValue): number[] {
    const key = `${block}.${name}` as ParamKey;
    return buildSetParam(key, displayValue);
  },

  buildSwitchPreset(location): number[] {
    return buildSwitchPreset(parseAm4Location(location));
  },

  buildSavePreset(location, name): number[] {
    // Pure-builder shape: returns ONLY the save bytes. Rename + save is
    // a 2-message sequence the execute path handles; the pure builder
    // is the canonical save step for goldens.
    if (name !== undefined && name.length > 0) {
      // No-op — the name argument is honored by the execute path.
    }
    return buildSaveToLocation(parseAm4Location(location));
  },

  buildSwitchScene(scene): number[] {
    if (!Number.isInteger(scene) || scene < 1 || scene > 4) {
      throw new DispatchError(
        'bad_location',
        'Fractal AM4',
        `Scene index ${scene} out of range on Fractal AM4 (valid: 1..4).`,
      );
    }
    return buildSwitchScene(scene - 1);
  },

  async setParam(
    ctx: DispatchCtx,
    block: string,
    name: string,
    value: number,
    channel?: string | number,
  ): Promise<WriteResult> {
    await warmupAM4BaselineIfNeeded(ctx.conn);
    const key = `${block}.${name}` as ParamKey;
    const param: Param = KNOWN_PARAMS[key];
    const bytes = buildSetParam(key, value);
    let channelSwitched: boolean | undefined;
    if (channel !== undefined && CHANNEL_BLOCKS.has(block)) {
      const switchResult = await switchBlockChannel(ctx.conn, block, channel);
      channelSwitched = switchResult.switched;
    }
    const result = await sendAndAwaitAck(ctx.conn, bytes, isWriteEcho);
    if (result.acked) {
      // Keep lastKnownType / lastKnownChannel current so cross-call
      // applicability checks (set_param after a separate amp.type write)
      // and channel tracking see fresh values. Type-gated refusal logic
      // lives below in setParams (in-batch context); this observer is
      // the only thing that catches a type write done in an isolated
      // call.
      observeWrittenParam(block, name, value);
    }
    const enumName = param.unit === 'enum'
      ? (param.enumValues as Record<number, string> | undefined)?.[value]
      : undefined;
    const display: number | string = param.unit === 'enum'
      ? (enumName ?? value)
      : value;
    const channelName = channelSwitched && typeof channel === 'number'
      ? channelLetter(channel)
      : (typeof channel === 'string' ? channel.toUpperCase() : undefined);
    return {
      op: 'set_param',
      target: `${block}.${name}`,
      block,
      name,
      wire_value: value,
      display_value: display,
      acked: result.acked,
      channel: channelName,
      warning: result.acked
        ? undefined
        : `No ack within timeout; typically a stale MIDI handle or the block isn't placed. Try reconnect_midi or check the layout.`,
    };
  },

  async setParams(ctx, ops): Promise<BatchWriteResult> {
    await warmupAM4BaselineIfNeeded(ctx.conn);
    const writes: WriteResult[] = [];
    let acked_count = 0;
    let unacked_count = 0;

    // In-batch type-gating context. When the agent batches a type write
    // and a knob write in the same set_params call (e.g. amp.type=
    // "5F8 Tweed Normal" followed by amp.master=5), the second write
    // would silently corrupt unrelated state on a model where the knob
    // doesn't exist — AM4 amp models without master_volume reuse the
    // master register for amp.gain, so amp.master=5 overwrites
    // amp.gain=3 to gain=5. Refuse rather than warn: the batch knows
    // exactly what type just landed and can be deterministic.
    //
    // Cross-call gating (set_params after a separate amp.type write)
    // still relies on observeWrittenParam → lastKnownType, set by
    // setParam above; an isolated knob write only sees a warning, not
    // a refusal, because the cache may be stale.
    const inBatchTypes: Record<string, number> = {};

    for (const op of ops) {
      const isTypeOp = op.name === 'type' || op.name === 'mode';

      // Refusal gate runs BEFORE the wire op. Skipped for type writes
      // themselves (they're never type-gated against themselves), and
      // for ops where the param isn't strictly gated.
      if (!isTypeOp) {
        const effectiveTypes: Record<string, number> = {
          ...lastKnownType,
          ...inBatchTypes,
        };
        const check = checkApplicability(`${op.block}.${op.name}`, {
          currentTypes: effectiveTypes,
        });
        if (check.applicable === false) {
          const activeIndex = effectiveTypes[op.block];
          writes.push({
            op: 'set_param',
            target: `${op.block}.${op.name}`,
            block: op.block,
            name: op.name,
            acked: false,
            warning:
              `Skipped (does not apply): ${op.block}.${op.name} is not exposed on ` +
              `${op.block}.type wire ${activeIndex}. The device would silently no-op ` +
              `this write (or, on some types, the register is reused for a different ` +
              `param: e.g. amp.master writes to amp.gain on amps without a master ` +
              `knob). Report this to the user as "not applied" and skip in the next ` +
              `iteration. Call list_params(${op.block}) to see which knobs apply on ` +
              `the current type.`,
          });
          unacked_count++;
          continue;
        }
      }

      try {
        const r = await writer.setParam!(ctx, op.block, op.name, op.value as number, op.channel);
        writes.push(r);
        if (r.acked) {
          acked_count++;
          if (isTypeOp) {
            // Future ops in this batch can be gated against the type
            // that just landed, not the type that was active before.
            inBatchTypes[op.block] = Math.round(op.value as number);
          }
        } else {
          unacked_count++;
        }
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

  async switchPreset(ctx, location): Promise<WriteResult> {
    await warmupAM4BaselineIfNeeded(ctx.conn);
    const locationIndex = parseAm4Location(location);
    const bytes = buildSwitchPreset(locationIndex);
    const result = await sendAndAwaitAck(ctx.conn, bytes, isWriteEcho);
    // New preset = new channel layout; existing cache is stale.
    invalidateChannelCache();
    if (result.acked) {
      // Switching presets loads a stored preset into the working
      // buffer — the buffer matches flash. Refresh the fingerprint
      // cache so the next dirty-gate check has a clean baseline
      // (and can detect front-panel edits made before the next
      // navigation). Best-effort: failures are swallowed so the
      // switch's success isn't penalized by a non-critical side task.
      // See bufferFingerprint.ts.
      await refreshAM4Fingerprint(ctx.conn, locationIndex);
    }
    return {
      op: 'switch_preset',
      target: formatLocationDisplay(locationIndex),
      acked: result.acked,
      info: result.acked
        ? 'Any unsaved working-buffer edits were discarded. Channel cache cleared.'
        : undefined,
      warning: result.acked
        ? undefined
        : 'No write-echo within timeout; verify on the AM4 display.',
    };
  },

  async savePreset(ctx, location, name): Promise<WriteResult> {
    await warmupAM4BaselineIfNeeded(ctx.conn);
    const locationIndex = parseAm4Location(location);
    if (name !== undefined && name.length > 0) {
      // Composite rename + save (mirrors am4_save_preset).
      const renameBytes = buildSetPresetName(locationIndex, name);
      const renameResult = await sendAndAwaitAck(ctx.conn, renameBytes, isCommandAck);
      if (!renameResult.acked) {
        return {
          op: 'save_preset',
          target: formatLocationDisplay(locationIndex),
          acked: false,
          warning: `Rename to "${name}" didn't ack; save skipped to avoid persisting the old name.`,
        };
      }
    }
    const saveBytes = buildSaveToLocation(locationIndex);
    const saveResult = await sendAndAwaitAck(ctx.conn, saveBytes, isCommandAck);
    if (!saveResult.acked) {
      return {
        op: 'save_preset',
        target: formatLocationDisplay(locationIndex),
        acked: false,
        warning:
          `Save to ${formatLocationDisplay(locationIndex)} sent but no ack; verify by loading another location and coming back.`,
      };
    }

    // Switch the active location to the just-saved target so the user
    // sees and hears what they saved. Without this, the active location
    // stayed at whatever-was-active-before-the-save and the user
    // assumed the save targeted the wrong location (the 2026-05-13
    // founder-test confusion).
    const switchTrouble = await runPostSaveSwitch(ctx, locationIndex);
    const baseWarning = name
      ? `Saved "${name}" to ${formatLocationDisplay(locationIndex)}.`
      : `Working buffer saved to ${formatLocationDisplay(locationIndex)}.`;
    return {
      op: 'save_preset',
      target: formatLocationDisplay(locationIndex),
      acked: true,
      info: `${baseWarning} Active location switched to ${formatLocationDisplay(locationIndex)}.`,
      warning: switchTrouble,
    };
  },

  async switchScene(ctx, scene): Promise<WriteResult> {
    if (!Number.isInteger(scene) || scene < 1 || scene > 4) {
      throw new DispatchError(
        'bad_location',
        'Fractal AM4',
        `Scene index ${scene} out of range on Fractal AM4 (valid: 1..4).`,
      );
    }
    await warmupAM4BaselineIfNeeded(ctx.conn);
    const bytes = buildSwitchScene(scene - 1);
    const result = await sendAndAwaitAck(ctx.conn, bytes, isWriteEcho);
    invalidateChannelCache();
    return {
      op: 'switch_scene',
      target: `scene:${scene}`,
      acked: result.acked,
      info: result.acked
        ? 'Channel cache cleared; the new scene may point each block at a different channel.'
        : undefined,
      warning: result.acked
        ? undefined
        : 'No write-echo within timeout; verify on the AM4 display.',
    };
  },

  async setBlock(ctx, slot, change): Promise<WriteResult> {
    await warmupAM4BaselineIfNeeded(ctx.conn);
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 1 || slot > 4) {
      throw new DispatchError(
        'bad_location',
        'Fractal AM4',
        `Slot ${typeof slot === 'number' ? slot : JSON.stringify(slot)} is out of range on Fractal AM4 (linear slot_model, valid: 1..4).`,
      );
    }
    if (change.block_type === undefined) {
      throw new DispatchError(
        'capability_not_supported',
        'Fractal AM4',
        `set_block on Fractal AM4 currently only handles block placement. Pass block_type to place/clear a block; use set_bypass for bypass writes.`,
        { retry_action: 'Call set_bypass(port, block, bypassed) for the bypass write.' },
      );
    }
    const wire = resolveBlockType(change.block_type);
    if (wire === undefined) {
      const known = Object.keys(BLOCK_TYPE_VALUES).join(', ');
      throw new DispatchError(
        'unknown_block',
        'Fractal AM4',
        `Block type '${change.block_type}' is not valid on Fractal AM4. Known: ${known}.`,
      );
    }
    const bytes = buildSetBlockType(slot as 1 | 2 | 3 | 4, wire);
    const result = await sendAndAwaitAck(ctx.conn, bytes, isWriteEcho);
    const displayName = BLOCK_NAMES_BY_VALUE[wire] ?? `0x${wire.toString(16)}`;
    return {
      op: 'set_block',
      target: `slot:${slot}=${displayName}`,
      acked: result.acked,
      info: result.acked
        ? `Placed ${displayName} in slot ${slot}.`
        : undefined,
      warning: result.acked
        ? undefined
        : `No write-echo within timeout; verify on the AM4 display.`,
    };
  },

  async setBypass(ctx, block, bypassed): Promise<WriteResult> {
    await warmupAM4BaselineIfNeeded(ctx.conn);
    const wire = resolveBlockType(block);
    if (wire === undefined || wire === BLOCK_TYPE_VALUES.none) {
      const known = Object.keys(BLOCK_TYPE_VALUES).filter((n) => n !== 'none').join(', ');
      throw new DispatchError(
        'unknown_block',
        'Fractal AM4',
        `Block '${block}' is not valid on Fractal AM4 (cannot bypass 'none'). Known: ${known}.`,
      );
    }
    const bytes = buildSetBlockBypass(wire, bypassed);
    const result = await sendAndAwaitAck(ctx.conn, bytes, isWriteEcho);
    const stateWord = bypassed ? 'bypassed' : 'active';
    return {
      op: 'set_bypass',
      target: `${block}:${stateWord}`,
      acked: result.acked,
      info: result.acked
        ? `${block} set to ${stateWord} on the active scene. To change a different scene's bypass, switch_scene first and re-issue.`
        : undefined,
      warning: result.acked
        ? undefined
        : `No write-echo within timeout; verify on the AM4 display.`,
    };
  },

  async nudgeParam(ctx, block, name, direction, granularity, channel): Promise<WriteResult> {
    await warmupAM4BaselineIfNeeded(ctx.conn);
    const key = `${block}.${name}` as ParamKey;
    const param: Param | undefined = KNOWN_PARAMS[key];
    if (param === undefined) {
      throw new DispatchError(
        'unknown_param',
        'Fractal AM4',
        `Param '${key}' is not known on Fractal AM4.`,
      );
    }
    let channelSwitched: boolean | undefined;
    if (channel !== undefined && CHANNEL_BLOCKS.has(block)) {
      const switchResult = await switchBlockChannel(ctx.conn, block, channel);
      channelSwitched = switchResult.switched;
    }
    const wireDirection: 'incr' | 'decr' = direction === 'up' ? 'incr' : 'decr';
    const bytes = buildNudgeParam(param, wireDirection, granularity);
    const result = await sendAndAwaitAck(ctx.conn, bytes, isNudgeOrToggleAck);
    const channelName = channelSwitched && typeof channel === 'number'
      ? channelLetter(channel)
      : (typeof channel === 'string' ? channel.toUpperCase() : undefined);
    const stepWord = granularity === 'coarse' ? 'coarse step' : 'fine step';
    const dirWord = direction === 'up' ? '+' : '−';
    return {
      op: 'nudge_param',
      target: `${block}.${name}`,
      block,
      name,
      acked: result.acked,
      channel: channelName,
      info: result.acked
        ? `${block}.${name} ${dirWord}1 ${stepWord}. Read back with get_param to see the landed value.`
        : undefined,
      warning: result.acked
        ? undefined
        : `Nudge sent but no ack within timeout. The step may still have landed; verify with get_param.`,
    };
  },

  async toggleBypass(ctx, block): Promise<WriteResult> {
    await warmupAM4BaselineIfNeeded(ctx.conn);
    const wire = resolveBlockType(block);
    if (wire === undefined || wire === BLOCK_TYPE_VALUES.none) {
      const known = Object.keys(BLOCK_TYPE_VALUES).filter((n) => n !== 'none').join(', ');
      throw new DispatchError(
        'unknown_block',
        'Fractal AM4',
        `Block '${block}' is not valid on Fractal AM4 (cannot toggle 'none'). Known: ${known}.`,
      );
    }
    // AM4 quirk surfaced Session 104: the AMP slot has no bypass register.
    // pidHigh=0x03 on AMP is the BOOST register, so TOGGLE @ AMP flips
    // boost, not bypass. Refuse rather than silently mis-route — the
    // caller can call set_bypass on AMP if they truly want the (no-op)
    // semantics, or set the boost knob explicitly.
    if (block === 'amp') {
      throw new DispatchError(
        'capability_not_supported',
        'Fractal AM4',
        `toggle_bypass on Fractal AM4 's AMP slot would flip the boost register, not bypass (the AMP slot has no bypass). Use set_bypass(port:'am4', block:'amp', bypassed:false) for a no-op confirmation, or set_param(port:'am4', block:'amp', name:'boost') to control boost explicitly.`,
      );
    }
    const bytes = buildToggleBlockBypass(wire);
    const result = await sendAndAwaitAck(ctx.conn, bytes, isNudgeOrToggleAck);
    return {
      op: 'toggle_bypass',
      target: block,
      acked: result.acked,
      info: result.acked
        ? `${block} bypass flipped on the active scene. Read back with set_bypass or get_block_layout to confirm direction; two toggles return to the original state.`
        : undefined,
      warning: result.acked
        ? undefined
        : `Toggle sent but no ack within timeout. The flip may still have landed; verify on the AM4 display.`,
    };
  },

  validatePreset(spec: PresetSpec, _target): void {
    // Translate generic PresetSpec → AM4-native ApplyPresetInput and run
    // applyExecutor's pre-MIDI validation pass. Throws a plain Error
    // with the human-facing rejection message; the dispatcher's tool
    // handler formats it via asError. Same translation logic as the
    // execute path (kept in sync via specToApplyInput below).
    const input = specToApplyInput(spec);
    prepareApplyPresetWrites(input);
  },

  async applyPreset(ctx, spec: PresetSpec, target, options): Promise<ApplyResult> {
    const input = specToApplyInput(spec);
    const shouldSave = options?.save ?? false;
    await warmupAM4BaselineIfNeeded(ctx.conn);

    const startMs = Date.now();
    if (target !== undefined) {
      const locationIndex = parseAm4Location(target);
      const capture = recordInbound(ctx.conn);
      let result;
      try {
        result = await runApplyPresetAt(ctx.conn, locationIndex, input, { save: shouldSave });
      } finally {
        capture.unsubscribe();
      }
      if (result.ok) {
        // A save run persists the working buffer to flash, so the
        // buffer matches the target. Refresh the cache so the next
        // dirty-gate check has a clean baseline. An audition run
        // leaves the buffer mutated relative to flash — no refresh,
        // so the next gate check sees the mismatch.
        if (result.saved) {
          await refreshAM4Fingerprint(ctx.conn, locationIndex);
        }
        const auditionNote = result.saved
          ? undefined
          : `Auditioning at ${formatLocationDisplay(locationIndex)}, working buffer only, not saved. ` +
            `Reversible by switching presets. Call save_preset({port:'am4', location:'${formatLocationDisplay(locationIndex)}'}) ` +
            `when the user explicitly asks to save / keep / persist.`;
        const skipNote = formatSkippedNote(result.skipped);
        const warning = [auditionNote, skipNote].filter((s) => s !== undefined).join(' ');
        return {
          ok: true,
          steps: spec.slots.length + (spec.scenes?.length ?? 0) + (shouldSave ? 2 : 1),
          duration_ms: result.wallTimeMs,
          saved: result.saved,
          warning: warning.length > 0 ? warning : undefined,
        };
      }
      return {
        ok: false,
        steps: 0,
        duration_ms: result.wallTimeMs,
        failed_step: {
          index: 0,
          description: result.step,
          error: result.error,
        },
      };
    }

    // Working-buffer-only path: validate + run wires, no switch/save.
    let prepared;
    let nameWriteBytes;
    let skipped: ApplyPresetSkippedParam[];
    try {
      ({ prepared, nameWriteBytes, skipped } = prepareApplyPresetWrites(input));
    } catch (err) {
      return {
        ok: false,
        steps: 0,
        duration_ms: Date.now() - startMs,
        failed_step: { index: 0, description: 'validate', error: err instanceof Error ? err.message : String(err) },
      };
    }
    const capture = recordInbound(ctx.conn);
    let wireResult;
    try {
      wireResult = await runApplyPresetWires(ctx.conn, prepared, nameWriteBytes, input.name);
    } finally {
      capture.unsubscribe();
    }
    const ackNote = wireResult.unacked > 0
      ? `${wireResult.unacked} of ${wireResult.totalWrites} writes did not ack within timeout; verify on the AM4 display or call reconnect_midi.`
      : undefined;
    const skipNote = formatSkippedNote(skipped);
    const warning = [ackNote, skipNote].filter((s) => s !== undefined).join(' ');
    return {
      ok: wireResult.unacked === 0,
      steps: wireResult.totalWrites,
      duration_ms: Date.now() - startMs,
      warning: warning.length > 0 ? warning : undefined,
    };
  },

  async applySetlist(
    ctx,
    entries: readonly SetlistEntrySpec[],
    options?: SetlistApplyOptions,
  ): Promise<ApplySetlistResult> {
    const startMs = Date.now();
    const onError: 'stop' | 'continue' = options?.on_error ?? 'stop';
    const dryRun = options?.dry_run ?? false;
    const verifyEnabled = options?.verify ?? true;

    // Pre-validation: resolve locations, check uniqueness, run prepare pass.
    const resolved: { shortLocation: string; locationIndex: number; input: ApplyPresetInput }[] = [];
    const seenLocations = new Set<number>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const locationIndex = parseAm4Location(e.location);
      if (seenLocations.has(locationIndex)) {
        throw new DispatchError(
          'bad_location',
          'Fractal AM4',
          `entries[${i}] (location ${formatLocationDisplay(locationIndex)}): appears more than once in the batch; each location may appear at most once per call.`,
        );
      }
      seenLocations.add(locationIndex);

      // Translate PresetSpec → ApplyPresetInput for this entry.
      let input: ApplyPresetInput;
      try {
        input = specToApplyInput(e.spec);
        prepareApplyPresetWrites(input);
      } catch (err) {
        throw new DispatchError(
          'value_out_of_range',
          'Fractal AM4',
          `entries[${i}] (location ${formatLocationDisplay(locationIndex)}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      resolved.push({
        shortLocation: formatLocationDisplay(locationIndex),
        locationIndex,
        input,
      });
    }

    if (dryRun) {
      return {
        ok: true,
        total: resolved.length,
        applied: 0,
        failed: 0,
        remaining: [],
        results: resolved.map((r) => ({
          location: r.shortLocation,
          status: 'ok' as const,
          wallTimeMs: 0,
        })),
        totalWallTimeMs: Date.now() - startMs,
      };
    }

    const capture = recordInbound(ctx.conn);
    const results: SetlistEntryResult[] = [];
    let applied = 0;
    let failed = 0;
    let finalActiveLocation = resolved[0].shortLocation;
    let stopIndex: number | undefined;
    try {
      for (let i = 0; i < resolved.length; i++) {
        const r = resolved[i];
        const result = await runApplyPresetAt(ctx.conn, r.locationIndex, r.input);
        finalActiveLocation = r.shortLocation;
        if (!result.ok) {
          failed++;
          results.push({
            location: r.shortLocation,
            status: 'error',
            error: `${result.step}: ${result.error}`,
            wallTimeMs: result.wallTimeMs,
          });
          if (onError === 'stop') {
            stopIndex = i;
            break;
          }
          continue;
        }
        const expectedName = r.input.name?.trim();
        if (verifyEnabled && expectedName !== undefined && expectedName !== '') {
          const verifyStart = Date.now();
          let verifyError: string | undefined;
          try {
            const parsed = await readPresetName(ctx.conn, r.locationIndex);
            const actualName = parsed.isEmpty ? '<EMPTY>' : parsed.name;
            if (expectedName.toLowerCase() !== actualName.trim().toLowerCase()) {
              verifyError = `verification mismatch: applied "${expectedName}" but device reads back "${actualName}".`;
            }
          } catch (err) {
            verifyError = `verification timeout: could not read back name at ${r.shortLocation} (${err instanceof Error ? err.message : String(err)}).`;
          }
          if (verifyError) {
            failed++;
            results.push({
              location: r.shortLocation,
              status: 'error',
              error: verifyError,
              wallTimeMs: result.wallTimeMs + (Date.now() - verifyStart),
            });
            if (onError === 'stop') {
              stopIndex = i;
              break;
            }
            continue;
          }
        }
        applied++;
        results.push({ location: r.shortLocation, status: 'ok', wallTimeMs: result.wallTimeMs });
      }
    } finally {
      capture.unsubscribe();
    }
    const remaining = stopIndex !== undefined
      ? resolved.slice(stopIndex + 1).map((r) => r.shortLocation)
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

  async restoreDefaults(
    ctx,
    target,
    options?: RestoreDefaultsOptions,
  ): Promise<RestoreDefaultsResult> {
    const startMs = Date.now();
    const verifyEnabled = options?.verify ?? true;
    const locationIndex = parseAm4Location(target);
    try {
      loadFactoryBank();
    } catch (err) {
      return {
        ok: false,
        location: formatLocationDisplay(locationIndex),
        message: err instanceof Error ? err.message : String(err),
        wallTimeMs: Date.now() - startMs,
      };
    }
    let preRestoreName: string | undefined;
    if (verifyEnabled) {
      try {
        const parsed = await readPresetName(ctx.conn, locationIndex);
        preRestoreName = parsed.isEmpty ? '<EMPTY>' : parsed.name;
      } catch {
        preRestoreName = '<read-failed>';
      }
    }
    const result = await sendFactoryRestore(ctx.conn, locationIndex);
    let postRestoreName: string | undefined;
    let verified: boolean | undefined;
    if (verifyEnabled) {
      try {
        const parsed = await readPresetName(ctx.conn, locationIndex);
        postRestoreName = parsed.isEmpty ? '<EMPTY>' : parsed.name;
        if (postRestoreName === '<EMPTY>') {
          return {
            ok: false,
            location: formatLocationDisplay(locationIndex),
            message: `verification failure: post-restore name at ${formatLocationDisplay(locationIndex)} is <EMPTY>. Factory presets are never empty; the restore did not land.`,
            wallTimeMs: Date.now() - startMs,
            verified: false,
            preRestoreName,
            postRestoreName,
            totalBytes: result.totalBytes,
            messageCount: result.messageCount,
          };
        }
        verified = preRestoreName === undefined
          || preRestoreName.trim().toLowerCase() !== postRestoreName.trim().toLowerCase()
          || preRestoreName === '<EMPTY>';
      } catch (err) {
        return {
          ok: false,
          location: formatLocationDisplay(locationIndex),
          message: `verification timeout: could not read back preset name at ${formatLocationDisplay(locationIndex)} (${err instanceof Error ? err.message : String(err)}). Restore status unknown.`,
          wallTimeMs: Date.now() - startMs,
          preRestoreName,
          postRestoreName: '<read-failed>',
          totalBytes: result.totalBytes,
          messageCount: result.messageCount,
        };
      }
    }
    return {
      ok: true,
      location: formatLocationDisplay(locationIndex),
      message: verified === false
        ? `verification soft warning: pre="${preRestoreName}" equals post="${postRestoreName}"; either already factory or restore didn't land.`
        : `verified: pre="${preRestoreName}" → post="${postRestoreName}".`,
      wallTimeMs: Date.now() - startMs,
      verified,
      preRestoreName,
      postRestoreName,
      totalBytes: result.totalBytes,
      messageCount: result.messageCount,
    };
  },

  async restoreDefaultsRange(
    ctx,
    from,
    to,
    options?: RestoreDefaultsRangeOptions,
  ): Promise<RestoreDefaultsRangeResult> {
    const startMs = Date.now();
    const onError: 'stop' | 'continue' = options?.on_error ?? 'stop';
    const dryRun = options?.dry_run ?? false;
    const verifyEnabled = options?.verify ?? true;
    const fromIdx = parseAm4Location(from);
    const toIdx = parseAm4Location(to);
    if (fromIdx > toIdx) {
      throw new DispatchError(
        'bad_location',
        'Fractal AM4',
        `Restore range invalid: ${from} (idx ${fromIdx}) is after ${to} (idx ${toIdx}).`,
      );
    }
    const totalSlots = toIdx - fromIdx + 1;
    const RANGE_CEILING = 26;
    if (totalSlots > RANGE_CEILING) {
      throw new DispatchError(
        'value_out_of_range',
        'Fractal AM4',
        `Range size ${totalSlots} exceeds the per-call ceiling of ${RANGE_CEILING} slots.`,
      );
    }
    try {
      loadFactoryBank();
    } catch (err) {
      throw new DispatchError(
        'capability_not_supported',
        'Fractal AM4',
        err instanceof Error ? err.message : String(err),
      );
    }
    if (dryRun) {
      return {
        ok: true,
        total: totalSlots,
        restored: 0,
        failed: 0,
        remaining: [],
        results: [],
        totalWallTimeMs: Date.now() - startMs,
      };
    }
    const results: RestoreDefaultsRangeResult['results'] = [];
    const resultsMut = results as Array<RestoreDefaultsRangeResult['results'][number]>;
    let restored = 0;
    let failed = 0;
    let stopIndex: number | undefined;
    for (let i = 0; i < totalSlots; i++) {
      const locationIndex = fromIdx + i;
      const display = formatLocationDisplay(locationIndex);
      const slotStart = Date.now();
      const single = await writer.restoreDefaults!(ctx, locationIndex, { verify: verifyEnabled });
      if (!single.ok) {
        failed++;
        resultsMut.push({
          location: display,
          status: 'error',
          error: single.message,
          preRestoreName: single.preRestoreName,
          postRestoreName: single.postRestoreName,
          wallTimeMs: Date.now() - slotStart,
        });
        if (onError === 'stop') {
          stopIndex = i;
          break;
        }
        continue;
      }
      restored++;
      resultsMut.push({
        location: display,
        status: 'ok',
        preRestoreName: single.preRestoreName,
        postRestoreName: single.postRestoreName,
        wallTimeMs: Date.now() - slotStart,
      });
    }
    const remaining = stopIndex !== undefined
      ? Array.from({ length: totalSlots - stopIndex - 1 }, (_, k) =>
          formatLocationDisplay(fromIdx + stopIndex! + 1 + k))
      : [];
    return {
      ok: failed === 0,
      total: totalSlots,
      restored,
      failed,
      remaining,
      results,
      totalWallTimeMs: Date.now() - startMs,
    };
  },

  async rename(ctx, target: RenameTarget, name): Promise<WriteResult> {
    if (target === 'preset') {
      // AM4's set_preset_name requires a location to write to. The
      // working-buffer rename in the legacy `am4_set_preset_name` tool
      // is actually a "rename and save to this location" — the AM4
      // doesn't expose a pure working-buffer rename without an address.
      // For the unified rename(target='preset'), the caller must supply
      // a name only; we throw here because there's no implicit location.
      // Use save_preset(location, name) instead — the composite covers
      // the rename + persist flow honestly.
      throw new DispatchError(
        'capability_not_supported',
        'Fractal AM4',
        'rename(target="preset") needs a location on Fractal AM4. Use save_preset(location, name) to rename + persist, or am4_set_preset_name with an explicit location.',
        { retry_action: 'Call save_preset(port, location, name).' },
      );
    }
    const m = /^scene:([1-4])$/.exec(target);
    if (!m) {
      throw new DispatchError(
        'bad_location',
        'Fractal AM4',
        `rename target '${target}' is not valid on Fractal AM4. Valid: 'scene:1'..'scene:4'.`,
      );
    }
    const sceneIdx = Number(m[1]) - 1;
    const bytes = buildSetSceneName(sceneIdx, name);
    const result = await sendAndAwaitAck(ctx.conn, bytes, isCommandAck);
    return {
      op: 'rename',
      target,
      acked: result.acked,
      info: result.acked
        ? `Scene ${sceneIdx + 1} renamed to "${name}" in the working buffer. Call save_preset to persist.`
        : undefined,
      warning: result.acked
        ? undefined
        : `Scene rename sent but no ack; verify on the AM4 display.`,
    };
  },

  /**
   * Safe-edit dirty-gate adapter. Delegates to the device-specific
   * implementation in tools/safeEdit.ts which knows AM4's location-
   * code naming + READ_PRESET_NAME wire format.
   */
  async guardActiveBufferOrSave(ctx, mode) {
    return guardActiveAM4BufferOrSave(ctx.conn, mode);
  },
};
