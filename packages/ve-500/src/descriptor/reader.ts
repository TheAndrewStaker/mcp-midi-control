/**
 * Boss VE-500 DeviceReader.
 *
 * Parameter READ over Roland RQ1 → DT1: request an address, the device replies
 * with a DT1 carrying the current value. Decoded from the VE-500 Editor's own
 * read path and HARDWARE-CONFIRMED (2026-06-28): the device's DT1 reply is
 * byte-identical to the encoder. On no reply within the window the reader fails
 * with `no_ack` and points the user at the front panel.
 *
 * Memory reads (hardware-confirmed 2026-11-12 on the maintainer's unit):
 *   - the loaded memory NUMBER: an RQ1 on the "Current Patch Number" register
 *     (absolute address 0), the same register `switch_preset` writes;
 *   - a memory's NAME: the 16-character ASCII field at the start of a patch,
 *     read at the edit buffer or at a stored user memory's own base address;
 *   - a STORED user memory's parameters at that base address, without loading
 *     it and without touching the edit buffer.
 * These back `scan_locations`, `get_preset` (loaded or stored), the overwrite
 * check in front of `save_preset`, and its read-back receipt.
 *
 * `get_preset` is a SUMMARY, not the whole patch: every section's on/off state
 * and type, plus the parameters of the sections that are on. All 874 patch
 * parameters would take about 19 s of serial round trips (22 ms each), and a
 * single wide RQ1 answers only its first field.
 */

import type {
  BatchReadResult,
  DeviceReader,
  DispatchCtx,
  GetPresetOptions,
  LocationRef,
  OverwriteTargetInfo,
  ParamQuery,
  PresetSnapshot,
  PresetSnapshotSlot,
  ReadResult,
  SavedSnapshot,
  ScannedLocation,
  Unit,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  blockParams,
  buildGetParam,
  decodeParamReply,
  findParam,
  paramReplyMatcher,
  userPatchAddr,
  type Ve500ParamDef,
} from 'roland-midi/ve-500';

import { readCurrentPatchIndex, resolvePatchTarget, type PatchTarget } from './writer.js';

const LABEL = 'Boss VE-500';
const READ_RESPONSE_TIMEOUT_MS = 300;
/** The name every unused user memory carries from the factory. */
const INIT_PATCH_NAME = 'INIT PATCH';

/**
 * Sections `get_preset` reports. Each has an on/off switch; `harmony` and
 * `vocoder` are the two modes of the lead-FX section. `expand` names further
 * blocks whose parameters are read when the section is on.
 */
const SECTIONS: ReadonlyArray<{ block: string; expand?: readonly string[]; typeOnly?: boolean }> = [
  { block: 'enhancer' },
  { block: 'pitch_correct' },
  { block: 'harmony', expand: ['harmony1', 'harmony2', 'harmony3'] },
  { block: 'vocoder' },
  // An FX section carries 130 parameters covering all 20 FX types; only its
  // type is reported. Read the rest with get_params on the loaded memory.
  { block: 'fx1', typeOnly: true },
  { block: 'fx2', typeOnly: true },
  { block: 'fx3', typeOnly: true },
  { block: 'fx4', typeOnly: true },
  { block: 'reverb1' },
  { block: 'reverb2' },
];

function resolve(block: string, name: string): Ve500ParamDef {
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

/** One RQ1 → DT1 round trip. `patchBase` addresses a stored memory instead of the edit buffer. */
async function readRaw(
  ctx: DispatchCtx,
  def: Ve500ParamDef,
  patchBase?: number,
): Promise<{ value: number | string | undefined; resp?: number[] }> {
  const opts = patchBase === undefined ? undefined : { patchBase };
  // Subscribe before sending so the reply cannot outrace the listener.
  const respPromise = ctx.conn.receiveSysExMatching(
    paramReplyMatcher(def, opts),
    READ_RESPONSE_TIMEOUT_MS,
  );
  ctx.conn.send(buildGetParam(def, opts));
  let resp: number[];
  try {
    resp = await respPromise;
  } catch {
    return { value: undefined };
  }
  return { value: decodeParamReply(def, resp, opts), resp };
}

async function readOne(
  ctx: DispatchCtx,
  block: string,
  name: string,
): Promise<ReadResult> {
  const def = resolve(block, name);
  const { value: decoded, resp } = await readRaw(ctx, def);
  if (resp === undefined) {
    throw new DispatchError(
      'no_ack',
      LABEL,
      `No DT1 reply from ${LABEL} for '${block}.${name}' within ${READ_RESPONSE_TIMEOUT_MS}ms. ` +
        `Check the USB connection and the VE-500's MIDI mode, or read the value off the front panel.`,
      {
        retry_action:
          'Check the USB-MIDI connection and try again, or read the value off the device display.',
      },
    );
  }
  if (typeof decoded !== 'number') {
    // Never fabricate a reading (a coerced 0 would render as a plausible 'OFF').
    throw new DispatchError(
      'no_ack',
      LABEL,
      `Malformed DT1 reply from ${LABEL} for '${block}.${name}' (could not decode the value). Confirm on the front panel.`,
      { retry_action: 'Read the value off the front panel.' },
    );
  }
  const wire = decoded;
  const ps = ctx.descriptor.blocks[block]?.params[name];
  const unit: Unit = ps?.unit ?? 'opaque';
  const display_value = ps?.decode ? ps.decode(wire) : wire;

  return {
    block,
    name,
    wire_value: wire,
    display_value,
    unit,
    raw_response: resp,
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Label for a 0-based recall index: 0..98 = U01..U99, 99..148 = P01..P50. */
function labelOf(index: number): string {
  return index <= 98 ? `U${pad2(index + 1)}` : `P${pad2(index - 98)}`;
}

/** A memory's name, trimmed. `patchBase` undefined reads the edit buffer. */
async function readPatchName(ctx: DispatchCtx, patchBase?: number): Promise<string | undefined> {
  const { value } = await readRaw(ctx, resolve('common', 'patch_name'), patchBase);
  return typeof value === 'string' ? value.trim() : undefined;
}

/** Resolve a location to a stored USER memory; factory presets have no readable address. */
function userTarget(location: LocationRef, verb: string): PatchTarget {
  const target = resolvePatchTarget(location);
  if (target.kind !== 'user') {
    throw new DispatchError(
      'capability_not_supported',
      LABEL,
      `${verb} reads user memories U01-U99 only. Factory preset ${target.label} has no stored address this server can read; ` +
        `load it with switch_preset and read the loaded memory instead.`,
    );
  }
  return target;
}

/** Display value of one parameter, or undefined when the read failed. */
async function readDisplay(
  ctx: DispatchCtx,
  def: Ve500ParamDef,
  patchBase?: number,
): Promise<number | string | undefined> {
  const { value } = await readRaw(ctx, def, patchBase);
  if (typeof value !== 'number') return undefined;
  const ps = ctx.descriptor.blocks[def.block]?.params[def.param];
  return ps?.decode ? ps.decode(value) : value;
}

/** Every exposed parameter of a block, in display units. Failed reads are counted, not invented. */
async function readBlock(
  ctx: DispatchCtx,
  block: string,
  patchBase: number | undefined,
  only?: readonly string[],
): Promise<{ params: Record<string, number | string>; failed: number }> {
  const params: Record<string, number | string> = {};
  let failed = 0;
  for (const def of blockParams(block)) {
    if (ctx.descriptor.blocks[block]?.params[def.param] === undefined) continue;
    if (only && !only.includes(def.param)) continue;
    const v = await readDisplay(ctx, def, patchBase);
    if (v === undefined) failed++;
    else params[def.param] = v;
  }
  return { params, failed };
}

export const reader: DeviceReader = {
  async getParam(ctx, block, name): Promise<ReadResult> {
    return readOne(ctx, block, name);
  },

  async getParams(
    ctx: DispatchCtx,
    queries: readonly ParamQuery[],
  ): Promise<BatchReadResult> {
    const reads: ReadResult[] = [];
    const failed_indices: number[] = [];
    const errors: Record<number, string> = {};
    for (let i = 0; i < queries.length; i++) {
      try {
        reads.push(await readOne(ctx, queries[i].block, queries[i].name));
      } catch (err) {
        failed_indices.push(i);
        errors[i] = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      reads,
      failed_indices,
      ...(failed_indices.length ? { errors } : {}),
    };
  },

  async getPreset(ctx: DispatchCtx, options?: GetPresetOptions): Promise<PresetSnapshot> {
    const started = Date.now();
    const stored = options?.location !== undefined ? userTarget(options.location, 'get_preset') : undefined;
    const base = stored ? userPatchAddr(stored.n + 1) : undefined;

    const name = await readPatchName(ctx, base);
    if (name === undefined) {
      throw new DispatchError(
        'no_ack',
        LABEL,
        `No reply from ${LABEL} when reading the memory name. Check the USB connection, and that the VE-500 Editor is closed.`,
        { retry_action: 'Check the USB-MIDI connection and try again.' },
      );
    }
    // Always the memory the unit is actually on, never the one being read: a
    // stored read does not load anything, and reporting the read target here
    // made an agent tell the user the unit had switched memories.
    const currentIdx = await readCurrentPatchIndex(ctx);

    const warnings: string[] = [];
    const slots: PresetSnapshotSlot[] = [];
    let failed = 0;
    const push = (block: string, bypassed: boolean | undefined, params: Record<string, number | string>): void => {
      slots.push({
        slot: slots.length + 1,
        block_type: block,
        ...(bypassed !== undefined ? { bypassed } : {}),
        params,
      });
    };
    for (const section of SECTIONS) {
      const sw = await readDisplay(ctx, resolve(section.block, 'switch'), base);
      if (sw === undefined) {
        failed++;
        continue;
      }
      const on = sw === 'ON';
      const hasType = findParam(section.block, 'type') !== undefined;
      if (!on || section.typeOnly) {
        const r = hasType ? await readBlock(ctx, section.block, base, ['type']) : { params: {}, failed: 0 };
        failed += r.failed;
        push(section.block, !on, r.params);
        continue;
      }
      const r = await readBlock(ctx, section.block, base);
      failed += r.failed;
      delete r.params.switch;
      push(section.block, false, r.params);
      for (const extra of section.expand ?? []) {
        const e = await readBlock(ctx, extra, base);
        failed += e.failed;
        push(extra, undefined, e.params);
      }
    }
    const master = await readBlock(ctx, 'master', base);
    failed += master.failed;
    push('master', undefined, master.params);

    warnings.push(
      'Summary read: sections that are off report only their type, and fx1-fx4 report only their type whether on or off. ' +
        (stored
          ? 'To read more of this stored memory, load it with switch_preset and use get_params.'
          : 'Read anything else on the loaded memory with get_params.'),
    );
    if (failed > 0) warnings.push(`${failed} read(s) got no reply and are missing from this snapshot.`);
    if (stored) {
      warnings.unshift(
        `This is STORED memory ${stored.label}, read without loading it. ` +
          (currentIdx !== undefined
            ? `The unit is still on ${labelOf(currentIdx)} (_meta.current_location), and its unsaved edits are untouched.`
            : 'The loaded memory did not change.'),
      );
    }
    if (currentIdx === undefined) {
      warnings.push('The loaded memory number could not be read; the front panel shows it.');
    }

    return {
      name,
      slots,
      read_warnings: warnings,
      _meta: {
        device: ctx.descriptor.display_name,
        read_at_ms: Date.now(),
        active_scene_only: false,
        routing_omitted: true,
        read_duration_ms: Date.now() - started,
        ...(currentIdx !== undefined ? { current_location: labelOf(currentIdx) } : {}),
      },
    };
  },

  async scanLocations(ctx, from, to): Promise<{
    scanned: readonly ScannedLocation[];
    failed_at?: string;
    failed_reason?: string;
  }> {
    const first = userTarget(from, 'scan_locations');
    const last = userTarget(to, 'scan_locations');
    const lo = Math.min(first.n, last.n);
    const hi = Math.max(first.n, last.n);
    const scanned: ScannedLocation[] = [];
    for (let n = lo; n <= hi; n++) {
      const name = await readPatchName(ctx, userPatchAddr(n + 1));
      if (name === undefined) {
        return {
          scanned,
          failed_at: labelOf(n),
          failed_reason: `No reply from ${LABEL} for the name of ${labelOf(n)}.`,
        };
      }
      scanned.push({ location: labelOf(n), name, is_empty: name === INIT_PATCH_NAME });
    }
    return { scanned };
  },

  async checkOverwriteTarget(ctx, location): Promise<OverwriteTargetInfo | undefined> {
    const target = resolvePatchTarget(location);
    if (target.kind !== 'user') return undefined;
    const name = await readPatchName(ctx, userPatchAddr(target.n + 1));
    if (name === undefined) return undefined;
    const current = await readCurrentPatchIndex(ctx);
    return {
      target_display: target.label,
      // A memory still named INIT PATCH is treated as free.
      ...(name === INIT_PATCH_NAME ? {} : { occupant_name: name }),
      is_active_location: current === target.n,
    };
  },

  async readSaveSnapshot(ctx, location): Promise<{ snapshot: SavedSnapshot; missing: readonly string[] }> {
    const target = userTarget(location, 'save_preset read-back');
    const base = userPatchAddr(target.n + 1);
    const missing: string[] = [];
    const preset_name = await readPatchName(ctx, base);
    if (preset_name === undefined) missing.push('preset_name');
    const on: string[] = [];
    for (const section of SECTIONS) {
      const sw = await readDisplay(ctx, resolve(section.block, 'switch'), base);
      if (sw === undefined) missing.push(`${section.block}.switch`);
      else if (sw === 'ON') on.push(section.block);
    }
    return {
      // On this device the "chain" is the list of sections that are ON in the stored memory.
      snapshot: { block_chain: on, ...(preset_name !== undefined ? { preset_name } : {}) },
      missing,
    };
  },
};
