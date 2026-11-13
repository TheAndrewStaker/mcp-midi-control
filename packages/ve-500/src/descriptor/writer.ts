/**
 * Boss VE-500 DeviceWriter.
 *
 * Write path over Roland SysEx (DT1) to the ACTIVE (temporary) patch, plus
 * patch recall (user memories over Program Change; factory presets over a
 * SysEx register write). Decoded from the VE-500 Editor's own wire code and
 * HARDWARE-CONFIRMED end-to-end on the maintainer's unit (2026-06-28) for
 * set_param / get_param / set_bypass / user-memory recall. Ordinary
 * patch-address DT1 writes (set_param) are NOT echoed by the device, so
 * get_param (RQ1→DT1) is their confirm.
 *
 * Wired: set_param / set_params (live edit, enum names accepted), set_bypass
 * (a section's on/off switch), switch_preset (recall USER memories U01–U99 via a
 * BARE Program Change, hardware-confirmed, GATED on a pre-flight read of the
 * unit's MIDI Program Change IN switch because the unit ignores the recall while
 * that is off and never says so; recall PRESETS P01–P50 via a DT1
 * write to the "Current Patch Number" register, decoded from the editor's own
 * patch-switch handler (see `patch.ts`); community-beta/hardware-unverified,
 * and deliberately NOT gated because a register write does not depend on PC IN),
 * applyPreset (build a whole patch into the active buffer), and savePreset
 * (persist the active buffer to a user memory). savePreset's store sequence: a
 * bare store command was HARDWARE-REFUTED on 2026-07-08 (did not persist a
 * MIDI-set value); re-derived from the editor's connect handshake (Editor
 * Communication Mode ON before the store, see `save.ts` for the evidence
 * trail) and HARDWARE-CONFIRMED 2026-07-08 on the maintainer's unit (a set +
 * save + flash-reload round-trip persisted, and the device echoes the store).
 */

import type {
  ApplyPresetOptions,
  ApplyResult,
  BatchWriteResult,
  DeviceWriter,
  DispatchCtx,
  LocationRef,
  PresetSpec,
  WriteOp,
  WriteResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  buildCommMode,
  buildGetParam as buildGetBytes,
  buildSavePreset as buildSaveBytes,
  buildSetParam as buildSetBytes,
  buildSetPatchName,
  buildSwitchPatch,
  decodeParamReply,
  findParam,
  paramReplyMatcher,
  saveAckMatcher,
  CURRENT_PATCH_ADDR,
  VE500_TARGET,
} from 'roland-midi/ve-500';
import { buildRQ1, decodeWire, parseDT1, Size } from 'roland-midi/shared';

const LABEL = 'Boss VE-500';
const BETA_NOTE =
  'Ordinary patch-address DT1 writes are not echoed, so get_param (RQ1->DT1) is their confirm. ' +
  '(set_param / get_param / set_bypass / user-memory recall / save_preset are hardware-confirmed; ' +
  'factory preset P01-P50 recall is newly wired via a SysEx write, community-beta / hardware-unverified.)';

/**
 * VE-500 MIDI receive channel for Program Change, 0-indexed. Defaults to
 * channel 1; override with `MCP_VE500_RX_CHANNEL` (1..16).
 *
 * This was hardcoded, which quietly blocked the unit's two most interesting
 * vocal features. The VOCODER block carries no channel parameter of its own, so
 * it follows the GLOBAL `system_midi.midi_rx_channel`. Moving that global off
 * channel 1 (which you must do to isolate a vocal-target melody from the rest of
 * a sequencer's stream, or the vocoder chases drum and bass notes) then left
 * `switch_preset` transmitting on a channel the device was no longer listening
 * to, so preset recall silently stopped working. Making it configurable is what
 * lets both coexist. Matches the per-device channel-env pattern already used by
 * the Arturia and Boss RC descriptors.
 *
 * PITCH CORRECT's `M>PCR` is unaffected either way: it has its OWN channel
 * setting (Ch.1-16 / RX / OFF), so it can be pinned independently of the global.
 */
function rxChannel(): number {
  const raw = process.env.MCP_VE500_RX_CHANNEL;
  const n = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 16) return 0;
  return n - 1;
}

/** Wait window for the device's STORE-command echo (0x7F000104 DT1 reply). */
const SAVE_ACK_TIMEOUT_MS = 300;

/**
 * Wait window for the PC-IN pre-flight read. Same 300ms as the reader's ordinary
 * get_param window: a VE-500 answers an RQ1 in tens of milliseconds, so this is
 * the "device is not talking" threshold, not a latency budget.
 */
const PC_IN_READ_TIMEOUT_MS = 300;

/** What the pre-flight read of `system_midi.midi_program_change_in` found. */
type PcInState = 'on' | 'off' | 'unknown';

/**
 * Read the unit's MIDI Program Change IN switch before recalling a user memory.
 *
 * WHY THIS READ EXISTS. U01-U99 recall is a bare Program Change and the VE-500
 * acts on one only when this global is ON. It is a real setting people turn off
 * on purpose (the maintainer did, to stop a stray Program Change on a shared bus
 * recalling a patch mid-song). With it off, the Program Change goes out, nothing
 * on the device moves, and nothing comes back to say so, because a Program
 * Change is never echoed. So `switch_preset` reported a clean success while the
 * patch did not change. That is the worst failure shape available: healthy
 * everywhere, wrong on the device.
 *
 * WHY IT IS AFFORDABLE. One RQ1 -> DT1 round trip, which this device answers in
 * roughly 50ms, against a per-call budget of about 200ms. `switch_preset` was a
 * single fire-and-forget message, so this roughly doubles a very small number
 * and stays well inside the budget.
 *
 * WHY IT IS NOT CACHED. Caching would need an invalidation story, and the two
 * events that change this value are (a) a `set_param` through this server, which
 * we could hook, and (b) somebody pressing buttons on the front panel, which we
 * cannot see at all. A cache that misses (b) hands back a stale "PC IN is on"
 * and re-opens the exact silent failure this read closes, only now with the
 * server's own confidence behind it. Fifty milliseconds is not worth that.
 */
async function readPcIn(ctx: DispatchCtx): Promise<PcInState> {
  const def = findParam('system_midi', 'midi_program_change_in');
  if (!def) return 'unknown';
  // Subscribe before sending so the reply cannot outrace the listener.
  const respPromise = ctx.conn
    .receiveSysExMatching(paramReplyMatcher(def), PC_IN_READ_TIMEOUT_MS)
    .catch(() => undefined);
  ctx.conn.send(buildGetBytes(def));
  const resp = await respPromise;
  if (resp === undefined) return 'unknown';
  const value = decodeParamReply(def, resp);
  if (value === 1) return 'on';
  if (value === 0) return 'off';
  return 'unknown';
}

function resolve(block: string, name: string) {
  const def = findParam(block, name);
  if (!def) {
    throw new DispatchError(
      'unknown_param',
      LABEL,
      `Unknown parameter '${block}.${name}' on ${LABEL}.`,
      {
        retry_action: `Call list_params({port, block:["${block}"]}) for the canonical names.`,
      },
    );
  }
  return def;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** A resolved VE-500 patch recall target. */
export interface PatchTarget {
  /** 0-based recall index: 0..98 = user U01..U99; 99..148 = preset P01..P50. */
  n: number;
  label: string;
  kind: 'user' | 'preset';
}

/**
 * Resolve a location to a 0-based recall index (product_setting.js's
 * minPatchOfUser..maxPatchOfPreset numbering: 0..98 user, 99..148 preset) +
 * a human label + which bank it is.
 *
 * User-memory recall (2026-06-28, hardware-confirmed): a BARE Program Change
 * (U01..U99 -> PC 0..98). Prepending a Bank Select (CC0/CC32) makes the unit
 * IGNORE the recall, so we never send one; see `switchPreset` below.
 *
 * Preset recall (2026-07-09): NOT a Program Change at all. Decoded from the
 * editor's `preset_patch.js` (see `patch.ts` for the full citation); see
 * `switchPreset` below for the SysEx write this resolves into.
 *
 * The kind is what decides whether the PC-IN pre-flight applies. USER recall
 * rides a Program Change and is gated on it; PRESET recall is a SysEx register
 * write that the unit obeys regardless, so gating it would refuse a path that
 * works. Keep that asymmetry: it is the difference between the two mechanisms,
 * not a policy choice.
 */
export function resolvePatchTarget(location: LocationRef): PatchTarget {
  if (typeof location === 'number') {
    if (location >= 1 && location <= 99) {
      return { n: location - 1, label: `U${pad2(location)}`, kind: 'user' };
    }
  } else {
    const s = location.trim().toUpperCase();
    const p = s.match(/^P0*(\d{1,2})$/);
    if (p) {
      const v = Number(p[1]);
      if (v >= 1 && v <= 50) {
        return { n: 98 + v, label: `P${pad2(v)}`, kind: 'preset' };
      }
    }
    const m = s.match(/^U?0*(\d{1,2})$/);
    if (m) {
      const v = Number(m[1]);
      if (v >= 1 && v <= 99) {
        return { n: v - 1, label: `U${pad2(v)}`, kind: 'user' };
      }
    }
  }
  throw new DispatchError(
    'bad_location',
    LABEL,
    `Invalid VE-500 memory '${location}'. Use a user memory U01–U99 (or 1–99) or a preset P01–P50.`,
  );
}

/** How long the unit takes to report a recalled memory in its register. */
const RECALL_SETTLE_MS = 150;
const RECALL_READ_ATTEMPTS = 4;

/**
 * The loaded memory's 0-based recall index (0..98 = U01..U99, 99..148 =
 * P01..P50), read from the "Current Patch Number" register `switch_preset`
 * writes. Undefined when the unit does not answer. Hardware-confirmed
 * 2026-11-12.
 */
export async function readCurrentPatchIndex(ctx: DispatchCtx): Promise<number | undefined> {
  const respPromise = ctx.conn.receiveSysExMatching(
    (m) => parseDT1(VE500_TARGET, m)?.addr === CURRENT_PATCH_ADDR,
    PC_IN_READ_TIMEOUT_MS,
  );
  ctx.conn.send(buildRQ1(VE500_TARGET, CURRENT_PATCH_ADDR, 2));
  try {
    const parsed = parseDT1(VE500_TARGET, await respPromise);
    if (!parsed || parsed.data.length < 2) return undefined;
    const idx = decodeWire(Size.INTEGER2x4, parsed.data, 0);
    return typeof idx === 'number' && idx >= 0 && idx <= 148 ? idx : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Neither recall path is echoed, so read the loaded memory number back and
 * state on the receipt whether the unit actually moved.
 */
async function confirmRecall(ctx: DispatchCtx, target: PatchTarget, sent: WriteResult): Promise<WriteResult> {
  // The unit is briefly deaf while it loads a memory, so poll rather than read once.
  let loaded: number | undefined;
  for (let attempt = 0; attempt < RECALL_READ_ATTEMPTS && loaded !== target.n; attempt++) {
    await new Promise((r) => setTimeout(r, RECALL_SETTLE_MS));
    loaded = (await readCurrentPatchIndex(ctx)) ?? loaded;
  }
  if (loaded === undefined) {
    return {
      ...sent,
      warning: `${target.label} was sent, but the unit did not answer the read-back, so the recall is unconfirmed. Check the front panel.`,
    };
  }
  if (loaded === target.n) {
    return {
      ...sent,
      confirmed_by: 'read_back',
      info: `${target.label} is loaded: the unit reports it as the current memory on read-back. ${sent.info ?? ''}`.trim(),
    };
  }
  const now = loaded <= 98 ? `U${pad2(loaded + 1)}` : `P${pad2(loaded - 98)}`;
  return {
    ...sent,
    acked: false,
    warning:
      `The recall was sent but the unit still reports ${now} as the loaded memory, not ${target.label}. ` +
      `Try again; if it repeats, check the unit's MIDI receive channel (OMNI or channel 1).`,
  };
}

export const writer: DeviceWriter = {
  buildSetParam(block, name, wireValue): number[] {
    return buildSetBytes(resolve(block, name), wireValue);
  },

  async setParam(ctx, block, name, wireValue): Promise<WriteResult> {
    const bytes = writer.buildSetParam!(block, name, wireValue);
    ctx.conn.send(bytes);
    return {
      op: 'set_param',
      target: `${block}.${name}`,
      block,
      name,
      wire_value: wireValue,
      acked: true,
      info: `Set sent to ${LABEL} (active patch). ${BETA_NOTE}`,
    };
  },

  async setParams(
    ctx: DispatchCtx,
    ops: readonly WriteOp[],
  ): Promise<BatchWriteResult> {
    const writes: WriteResult[] = [];
    let acked_count = 0;
    let unacked_count = 0;
    for (const op of ops) {
      try {
        writes.push(
          await writer.setParam!(ctx, op.block, op.name, op.value as number),
        );
        acked_count++;
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

  async setBypass(ctx, block, bypassed): Promise<WriteResult> {
    const sw = findParam(block, 'switch');
    if (!sw) {
      throw new DispatchError(
        'capability_not_supported',
        LABEL,
        `Block '${block}' has no on/off switch on ${LABEL}.`,
      );
    }
    const wire = bypassed ? 0 : 1;
    ctx.conn.send(buildSetBytes(sw, wire));
    return {
      op: 'set_bypass',
      target: `${block}.switch`,
      block,
      name: 'switch',
      wire_value: wire,
      display_value: bypassed ? 'OFF' : 'ON',
      acked: true,
      info: `${block} turned ${bypassed ? 'OFF' : 'ON'} on ${LABEL} (active patch). ${BETA_NOTE}`,
    };
  },

  async switchPreset(ctx, location): Promise<WriteResult> {
    const target = resolvePatchTarget(location);
    const sent = await (async (): Promise<WriteResult> => {
    if (target.kind === 'user') {
      // PRE-FLIGHT: the whole recall depends on a device setting that can be off,
      // and a Program Change is never echoed, so without this read a recall onto
      // a unit with PC IN off reports success and does nothing. See readPcIn.
      const pcIn = await readPcIn(ctx);
      if (pcIn !== 'on') {
        // PC IN is off, so a bare Program Change would be ignored silently. Do NOT refuse and do NOT
        // ask the owner to touch the front panel: fall back to the register write the EDITOR ITSELF
        // uses for user memories. `preset_patch.js` lines 106-142 call the same
        // `Parameter.setValue("Setup%SetupCommon%0", INTEGER2x4, 0, nextPatch)` from its
        // '#user-preset-button' handler, with `nextPatch = lastUserPatch` (0..98) — the identical
        // 0-based index a Program Change uses. One register, min 0 max 148, spans BOTH banks, so the
        // user half needs no separate decode (see roland-midi/ve-500/patch.ts for the citation trail).
        //
        // This path deliberately does not depend on PC IN and does not re-expose the unit to stray
        // Program Changes on the bus, which is the whole reason PC IN is off on a rig where a
        // sequencer is broadcasting (the maintainer's Circuit does, on a bus this unit sits on with
        // RX OMNI = ON).
        //
        // HARDWARE-CONFIRMED 2026-09-30 for USER memories, on the maintainer's unit with PC IN off:
        // recalled U95, read back its own distinguishing content (fx1 DELAY, time 2009, duck 40,
        // reverb 44, fx2 OFF), then recalled U94 and U95 again and read the round trip. So this leg
        // is confirmed, not beta, and it is what makes "save then verify from flash" possible at all
        // on a unit that ignores Program Change. The PC path below stays the preferred leg when PC IN
        // is on, because it is the older confirmed mechanism and costs one fewer decode assumption.
        //
        // 'unknown' (the PC IN read got no answer) takes this leg too. Found on hardware
        // 2026-11-12: the unit is briefly deaf right after a recall, so a second recall in
        // quick succession read PC IN as unknown, sent a Program Change, and a unit with PC IN
        // off ignored it. The register write works whatever PC IN is set to.
        ctx.conn.send(buildSwitchPatch(target.n));
        return {
          op: 'switch_preset',
          target: target.label,
          acked: true,
          info:
            `Recalled ${target.label} on ${LABEL} by writing its "Current Patch Number" register, not a ` +
            `Program Change: ` +
            (pcIn === 'off'
              ? `this unit has MIDI Program Change IN switched off, so a Program Change would have been ignored. `
              : `the unit did not answer the Program Change IN read, and this write works whichever way it is set. `) +
            `Nothing was changed in the unit's MIDI settings.`,
        };
      }

      // BARE Program Change, NO Bank Select. Hardware-confirmed (2026-06-28):
      // the VE-500 ignores the recall if a Bank Select precedes the PC.
      const rx = rxChannel();
      ctx.conn.send([0xc0 | rx, target.n]);
      return {
        op: 'switch_preset',
        target: target.label,
        acked: true,
        info:
          `Recalled ${target.label} on ${LABEL} (Program Change ${target.n} on MIDI ch ${rx + 1}; ` +
          `PC IN was read as ON before sending).`,
      };
    }

    // Factory PRESET recall (P01-P50): NOT a Program Change. Decoded from the
    // VE-500 Editor's own patch-switch handler (`preset_patch.js`, see
    // roland-midi/ve-500/patch.ts for the full citation trail): the editor
    // recalls ANY patch (user or preset) with a single DT1 write to the
    // "Current Patch Number" register (Setup > SetupCommon, absolute address
    // 0x00000000), packed INTEGER2x4, value = the same 0-based index Program
    // Change uses (99..148 for presets). This supersedes the earlier
    // "undecoded Bank Select" gate: the editor never uses Bank Select/Program
    // Change for recall at all. Community-beta: this write has not yet been
    // pressed on the maintainer's unit (only user-memory PC recall is
    // hardware-confirmed so far).
    ctx.conn.send(buildSwitchPatch(target.n));
    return {
      op: 'switch_preset',
      target: target.label,
      acked: true,
      info:
        `Recalled ${target.label} on ${LABEL} via a SysEx write to the "Current Patch Number" register ` +
        `(decoded from the VE-500 Editor's own patch-switch handler; NOT a Program Change). Not echoed, ` +
        `so the front panel is ground truth. Community-beta: hardware-unverified. ${BETA_NOTE}`,
    };
    })();
    return confirmRecall(ctx, target, sent);
  },

  /**
   * Build a whole patch into the ACTIVE buffer in one call: for each slot
   * (= a fixed VE-500 section), set its on/off switch (from `bypassed`) then
   * its params. Working-buffer only — VE-500 has no MIDI save, so there is no
   * target_location/persist path (the dispatcher already gates that). Press
   * WRITE on the device to keep the result.
   *
   * Param values are display-form; they are encoded through the same per-param
   * schema as set_param (so enum names, on/off, and ranges all behave identically).
   */
  async applyPreset(
    ctx: DispatchCtx,
    spec: PresetSpec,
    _target?: LocationRef,
    _options?: ApplyPresetOptions,
  ): Promise<ApplyResult> {
    const startedAt = Date.now();
    let steps = 0;
    const nacked: {
      index: number;
      description: string;
      error: string;
      kind: string;
    }[] = [];

    for (let i = 0; i < spec.slots.length; i++) {
      const slot = spec.slots[i];
      const block = slot.block_type; // canonical (preflight resolved it)

      if (slot.bypassed !== undefined) {
        const sw = findParam(block, 'switch');
        if (sw) {
          ctx.conn.send(buildSetBytes(sw, slot.bypassed ? 0 : 1));
          steps++;
        }
      }

      const params = slot.params as
        | Record<string, number | string>
        | undefined;
      if (params) {
        for (const [name, value] of Object.entries(params)) {
          const def = findParam(block, name);
          const schema = ctx.descriptor.blocks[block]?.params[name];
          if (!def || !schema) {
            nacked.push({
              index: i,
              description: `${block}.${name}`,
              error: `unknown parameter '${block}.${name}'`,
              kind: 'unknown_param',
            });
            continue;
          }
          try {
            const wire = schema.encode(value) as number;
            ctx.conn.send(buildSetBytes(def, wire));
            steps++;
          } catch (err) {
            nacked.push({
              index: i,
              description: `${block}.${name}`,
              error: err instanceof Error ? err.message : String(err),
              kind: 'value_out_of_range',
            });
          }
        }
      }
    }

    const ok = nacked.length === 0;
    return {
      ok,
      steps,
      duration_ms: Date.now() - startedAt,
      ...(nacked.length ? { nacked_steps: nacked } : {}),
      ...(ok
        ? {}
        : {
            warning: `${nacked.length} setting(s) could not be applied; the rest were sent.`,
          }),
      applied_spec: spec,
    };
  },

  /**
   * Persist the active edit buffer to a USER memory (U01–U99). The buffer is
   * already live on the device (set_param/apply_preset wrote there); this sends
   * the editor's STORE command (DT1 to 0x7F000104 = the 0-based user index).
   * Optionally writes a 16-char patch name into the buffer first.
   *
   * HARDWARE-REFUTED then RE-DERIVED (2026-07-08): a bare store command alone
   * did NOT persist a MIDI-set value on the maintainer's unit (set enhancer.
   * enhance=77, saved to U99, switched away+back, read back the ORIGINAL 25).
   * The editor's own connect handshake (`js/product/midi.js`
   * `MIDIController.manager.connect`) ALWAYS sends Editor Communication Mode
   * ON (`dt1raw('7F000001','01')`) before its UI allows any interaction, so
   * every `command.write()` the real editor issues happens with that mode
   * already on. The VE-500's 0x7F0000xx "command" register space (where STORE
   * lives) appears to be gated behind it, while ordinary patch-address writes
   * (set_param/get_param) are not — matching the observed symptom. This send
   * now precedes the store with that same mode-on command. The device DOES
   * echo a DT1 back to the store address once it processes the write
   * (decoded from the editor's receive dispatch, `saveAckMatcher`); we wait
   * for that echo so `acked` reflects a real device response instead of
   * merely "sent". HARDWARE-CONFIRMED 2026-07-08 on the maintainer's unit: a
   * set + save + flash-reload round-trip persisted, and the store echo arrived.
   * Preset (P01–P50) targets are rejected (factory, not writable).
   */
  async savePreset(ctx, location, name?): Promise<WriteResult> {
    const target = resolvePatchTarget(location);
    if (target.kind !== 'user') {
      throw new DispatchError(
        'capability_not_supported',
        LABEL,
        `Preset ${target.label} is factory/read-only on ${LABEL}; save_preset only writes user memories U01–U99.`,
      );
    }
    const { n: userIndex, label } = target;
    if (name) ctx.conn.send(buildSetPatchName(name));

    ctx.conn.send(buildCommMode(true));

    // Subscribe before sending so the device's echo cannot outrace the listener.
    const ackPromise = ctx.conn.receiveSysExMatching(
      saveAckMatcher(),
      SAVE_ACK_TIMEOUT_MS,
    );
    ctx.conn.send(buildSaveBytes(userIndex));

    let acked = true;
    try {
      await ackPromise;
    } catch {
      acked = false;
    }

    return {
      op: 'save_preset',
      target: label,
      acked,
      info: acked
        ? `Store command sent + device-acked: active edit buffer → memory ${label}` +
          `${name ? ` ("${name.trim()}")` : ''}. Confirm by recalling ${label}. ${BETA_NOTE}`
        : `Store command sent to ${LABEL} but no device ack was seen within ${SAVE_ACK_TIMEOUT_MS}ms; ` +
          `it may not have persisted. Confirm by recalling ${label}. ${BETA_NOTE}`,
    };
  },
};
