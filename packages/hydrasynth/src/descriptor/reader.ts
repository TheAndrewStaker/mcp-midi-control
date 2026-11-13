/**
 * Hydrasynth DeviceDescriptor: DeviceReader implementation.
 *
 * BK-110 (2026-08-09) wired the device's documented STORED-content read
 * flows (SysexEncoding.txt), so the reader now implements:
 *
 *   - `scanLocations`: real bank-name reads (`02 00 BANK`, ~19 ack-driven
 *     chunks per bank of 128 names). Non-destructive, no navigation.
 *   - `getPreset` (location required): whole stored-patch read
 *     (`04 00 BANK PATCH`, 22 chunks → the same 2790-byte buffer
 *     `decodePatch` speaks), decoded to name + category + curated
 *     per-module params.
 *   - `dumpStoredPresetBinary`: the same read kept as verbatim chunk
 *     frames for byte-exact `.syx` backup (export_preset / backup_device).
 *
 * Still IMPOSSIBLE by protocol (spec "WHAT CAN BE DONE"): reading the
 * WORKING BUFFER. Every read here is the FLASH copy; unsaved front-panel
 * tweaks are invisible. `getParam`/`getParams` therefore still refuse —
 * there is no single-param query primitive — but the refusals now point
 * at the stored-read tools instead of claiming no read exists at all.
 */

import type {
  BatchReadResult,
  DeviceReader,
  DispatchCtx,
  GetPresetOptions,
  PresetBinaryDump,
  PresetSnapshot,
  PresetSnapshotSlot,
  ReadResult,
  ScannedLocation,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import { readBankNames, readStoredPatch } from '../patchRead.js';
import { decodePatch, findPatchOffset, readPatchCategory, readPatchName } from '../patchEncoder.js';
import { findHydraNrpn } from '../nrpn.js';
import { decodeNrpnDisplay } from '../nrpnDisplay.js';
import { HYDRASYNTH_ENUMS } from '../enums.js';
import {
  matrixImageFieldKind,
  modSourceLabelForImageIndex,
  modDestLabelForImageIndex,
} from '../modRouting.js';
import { parseHydrasynthLocation } from './schema.js';

const DEVICE_LABEL = 'ASM Hydrasynth Explorer';

/**
 * Widest scan per call: 4 banks (512 names, ~76 ack-driven round trips,
 * ~2-4 s). Both ceilings bind: the >5 s conversational wire budget and
 * the 50,000-char host delivery cliff (512 compact JSON rows ≈ 30 KB;
 * all 1024 would exceed both). The refusal names the paging.
 */
const SCAN_MAX_BANKS = 4;

/**
 * Module prefixes for grouping decoded patch params into snapshot
 * slots, longest-match-first. Anything unmatched lands in 'patch'
 * (misc voice-level bytes).
 */
const MODULE_PREFIXES: readonly string[] = [
  'modmatrix', 'mutator1', 'mutator2', 'mutator3', 'mutator4',
  'mixer', 'filter1', 'filter2', 'osc1', 'osc2', 'osc3',
  'prefx', 'postfx', 'delay', 'reverb',
  'lfo1', 'lfo2', 'lfo3', 'lfo4', 'lfo5',
  'env1', 'env2', 'env3', 'env4', 'env5',
  'amp', 'arp', 'voice', 'vibrato', 'macro', 'ribbon', 'glide',
];

function moduleFor(paramName: string): string {
  for (const p of MODULE_PREFIXES) {
    if (paramName.startsWith(p)) return p;
  }
  return 'patch';
}

/**
 * Resolve a decoded NRPN-wire value to the device's display shape:
 * curated display formula → enum label → bipolar display → raw wire.
 * (Same preference order as apply_patch's response formatting, minus
 * the FX-type-aware branch — FX sub-params return wire values with a
 * read_warnings note naming the FX type they are scaled under.)
 */
function displayFor(name: string, wire: number): number | string {
  // Route fields decode from the patch IMAGE's own value spaces (linear
  // list indices / category ids / wire-per-8 depths), not NRPN semantics.
  const kind = matrixImageFieldKind(name);
  if (kind === 'source') return modSourceLabelForImageIndex(wire) ?? wire;
  if (kind === 'target' || kind === 'macro_target') return modDestLabelForImageIndex(wire) ?? wire;
  if (kind === 'target_category') return wire;
  if (/^modmatrix\d+depth$/.test(name) || /^macro\d+(depth|buttonvalue)\d+$/.test(name)) {
    // readPatchValue returned the NRPN-scale wire (image * 8, 0..8192);
    // display is bipolar -128.0..+128.0.
    return Math.round((wire / 32 - 128) * 10) / 10;
  }
  const curated = decodeNrpnDisplay(name, wire);
  if (curated !== undefined) return curated;
  const entry = findHydraNrpn(name);
  if (entry?.enumTable) {
    const table = HYDRASYNTH_ENUMS[entry.enumTable];
    // enum-scaled params: the NRPN wire is idx*scale, so dividing recovers
    // the index — but `space: 'image-index'` offsets DECLARE that decodePatch
    // already returns the raw index, so no divide. (This replaced an enc-
    // sniffing heuristic: the 08-22 double-divide mislabeled every stored FX
    // type until the read-back-vs-byte-dump comparison caught it; the space
    // declaration is now the single source of truth for all consumers.)
    const isRawIndexOffset = findPatchOffset(name)?.space === 'image-index';
    const idx = entry.enumValueScale && !isRawIndexOffset ? Math.round(wire / entry.enumValueScale) : wire;
    const label = table?.[idx];
    if (label !== undefined) return String(label);
  }
  if (entry?.displayMin !== undefined && entry.displayMax !== undefined && entry.wireMax) {
    const span = entry.displayMax - entry.displayMin;
    const display = Math.round(((wire / entry.wireMax) * span + entry.displayMin) * 10) / 10;
    return display;
  }
  return wire;
}

export const reader: DeviceReader = {
  async getParam(_ctx: DispatchCtx, _block: string, _name: string): Promise<ReadResult> {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      `get_param is not supported on ASM Hydrasynth Explorer: the device has no single-param query, ` +
      `and no read of the WORKING BUFFER exists at all (unsaved knob tweaks are invisible to MIDI). ` +
      `STORED patches ARE readable: get_preset({location:"A001"}) decodes a saved patch, ` +
      `scan_locations reads bank names.`,
      { retry_action: 'For a stored patch, call get_preset with its location. For the live working buffer, read the front panel.' },
    );
  },

  async getParams(_ctx: DispatchCtx, _queries): Promise<BatchReadResult> {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      `get_params batch read is not supported on ASM Hydrasynth Explorer (no single-param query; ` +
      `the working buffer is unreadable by protocol). Use get_preset({location:"A001"}) for a ` +
      `stored patch's full decoded state, or the front panel for live values.`,
    );
  },

  /**
   * Bulk-read stored patch names. `from`/`to` accept "A001".."H128" or
   * flat 0..1023 indices. Reads whole banks (the wire has no narrower
   * name query) and slices to the requested range; capped at 4 banks
   * per call (see SCAN_MAX_BANKS).
   */
  async scanLocations(ctx: DispatchCtx, from: string | number, to: string | number): Promise<{
    scanned: readonly ScannedLocation[];
    failed_at?: string;
    failed_reason?: string;
  }> {
    const lo = parseHydrasynthLocation(from);
    const hi = parseHydrasynthLocation(to);
    if (lo.flatIndex > hi.flatIndex) {
      throw new DispatchError(
        'bad_location',
        DEVICE_LABEL,
        `scan_locations range is reversed: from=${lo.display} comes after to=${hi.display}. Pass from <= to.`,
      );
    }
    const bankCount = hi.bank - lo.bank + 1;
    if (bankCount > SCAN_MAX_BANKS) {
      throw new DispatchError(
        'value_out_of_range',
        DEVICE_LABEL,
        `scan_locations on ${DEVICE_LABEL} reads whole banks (128 names each) and caps at ` +
        `${SCAN_MAX_BANKS} banks (${SCAN_MAX_BANKS * 128} names) per call — ${lo.display}..${hi.display} ` +
        `spans ${bankCount} banks. Page by bank group, e.g. A001..D128 then E001..H128.`,
        { retry_action: `Re-call with a range spanning at most ${SCAN_MAX_BANKS} banks (e.g. from:"A001", to:"D128").` },
      );
    }
    const scanned: ScannedLocation[] = [];
    for (let bank = lo.bank; bank <= hi.bank; bank++) {
      let names: string[];
      try {
        names = await readBankNames(ctx.conn, bank);
      } catch (err) {
        return {
          scanned,
          failed_at: `${String.fromCharCode(65 + bank)}001`,
          failed_reason: err instanceof Error ? err.message : String(err),
        };
      }
      const first = bank === lo.bank ? lo.patch : 0;
      const last = bank === hi.bank ? hi.patch : 127;
      for (let p = first; p <= last; p++) {
        scanned.push({
          location: `${String.fromCharCode(65 + bank)}${(p + 1).toString().padStart(3, '0')}`,
          name: names[p] ?? '',
          // Every Hydrasynth slot holds a patch (factory content ships in
          // all 1024); there is no empty-slot state on this device.
          is_empty: false,
        });
      }
    }
    return { scanned };
  },

  /**
   * Read + decode one STORED patch. `location` is required: the device
   * cannot dump its working buffer (spec "WHAT CAN BE DONE"), so an
   * active-buffer snapshot does not exist on this device.
   */
  async getPreset(ctx: DispatchCtx, options?: GetPresetOptions): Promise<PresetSnapshot> {
    if (options?.location === undefined) {
      throw new DispatchError(
        'capability_not_supported',
        DEVICE_LABEL,
        `get_preset on ${DEVICE_LABEL} requires a location ("A001".."H128"): the device has no ` +
        `working-buffer dump, so only STORED patches are readable. The read is the FLASH copy — ` +
        `unsaved front-panel tweaks are not in it.`,
        { retry_action: 'Re-call with location, e.g. get_preset({port:"hydrasynth", location:"A001"}).' },
      );
    }
    const target = parseHydrasynthLocation(options.location);
    const startedAt = Date.now();
    const { payload } = await readStoredPatch(ctx.conn, target.bank, target.patch);
    const readMs = Date.now() - startedAt;

    const wireValues = decodePatch(payload);
    // Route-field pruning: only ACTIVE routes reach the snapshot. 32 matrix
    // rows x 4 fields + 8x8 macro slots x 4 fields would add ~380 params to
    // every stored read (response-ceiling hazard); an inactive row (source
    // AND target both Off/0; macro slot with target 0) carries no signal.
    // Category fields are always pruned: the target label implies them.
    const isInactiveRouteField = (name: string): boolean => {
      if (matrixImageFieldKind(name) === 'target_category') return true;
      const m = /^modmatrix(\d+)(depth|modsource|modtarget)$/.exec(name);
      if (m) {
        return (
          (wireValues.get(`modmatrix${m[1]}modsource`) ?? 0) === 0 &&
          (wireValues.get(`modmatrix${m[1]}modtarget`) ?? 0) === 0
        );
      }
      const mm = /^macro(\d+)(depth|target|buttonvalue)(\d+)$/.exec(name);
      if (mm) return (wireValues.get(`macro${mm[1]}target${mm[3]}`) ?? 0) === 0;
      return false;
    };
    const byModule = new Map<string, Record<string, number | string>>();
    let fxParamsSeen = false;
    for (const [name, wire] of wireValues) {
      if (isInactiveRouteField(name)) continue;
      const mod = moduleFor(name);
      let bucket = byModule.get(mod);
      if (bucket === undefined) {
        bucket = {};
        byModule.set(mod, bucket);
      }
      if (/^(pre|post)fxparam\d$/.test(name)) fxParamsSeen = true;
      bucket[name] = displayFor(name, wire);
    }
    const slots: PresetSnapshotSlot[] = [];
    let slotIdx = 1;
    for (const [mod, params] of byModule) {
      slots.push({ slot: slotIdx++, block_type: mod, params });
    }

    const warnings: string[] = [
      `This is the FLASH copy of ${target.display}. Unsaved working-buffer edits (front-panel tweaks since the last save) are NOT reflected.`,
    ];
    if (fxParamsSeen) {
      const pre = wireValues.get('prefxtype');
      const post = wireValues.get('postfxtype');
      warnings.push(
        `prefxparam1..5 / postfxparam1..5 are TYPE-DEPENDENT knobs shown here in generic units; ` +
        `interpret them under the patch's own FX types (prefxtype=${pre !== undefined ? displayFor('prefxtype', pre) : '?'}, ` +
        `postfxtype=${post !== undefined ? displayFor('postfxtype', post) : '?'}).`,
      );
    }

    return {
      name: readPatchName(payload),
      category: readPatchCategory(payload),
      slots,
      read_warnings: warnings,
      _meta: {
        device: DEVICE_LABEL,
        read_at_ms: Date.now(),
        active_scene_only: false,
        // Since the route-decode leg (2026-08-22) every ACTIVE mod-matrix/
        // macro route rides the snapshot, and this architecture has no other
        // routing edges (fixed signal chain) — so nothing routing-shaped is
        // omitted. Inactive rows are pruned as no-signal, not as omission.
        routing_omitted: false,
        read_duration_ms: readMs,
      },
    };
  },

  /**
   * Byte-exact backup of a stored patch: the verbatim 22 chunk-dump
   * frames as the device sent them, concatenated. Feeds export_preset
   * (location) and backup_device stored sweeps. `location` is the flat
   * 0..1023 index (dispatcher contract); "A001" strings are accepted
   * for direct callers.
   */
  async dumpStoredPresetBinary(location: number, ctx: DispatchCtx): Promise<PresetBinaryDump> {
    const target = parseHydrasynthLocation(location);
    const { payload, frames } = await readStoredPatch(ctx.conn, target.bank, target.patch);
    const total = frames.reduce((n, f) => n + f.length, 0);
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const f of frames) {
      bytes.set(Uint8Array.from(f), off);
      off += f.length;
    }
    return {
      bytes,
      byte_length: bytes.length,
      frame_count: frames.length,
      format: 'hydrasynth-patch-dump',
      name: readPatchName(payload),
      source: `stored patch ${target.display} (flash copy)`,
      file_extension: 'syx',
      structurally_valid: payload.length === 2790,
      warning:
        'Flash copy: unsaved working-buffer edits are not in this dump. Restore with import_preset ' +
        '(any target slot; chunk-0 addressing is rewritten automatically).',
    };
  },
};
