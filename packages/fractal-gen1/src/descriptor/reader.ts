/**
 * Axe-Fx Standard/Ultra (gen-1) DeviceReader.
 *
 * Scope: parameter READ (get_param / get_params) + the SPEC-PINNED SUBSET of
 * the whole-patch dump (get_preset). The gen-1 protocol is bidirectional —
 * function 0x02 both sets and queries, selected by a trailing query(0)/set(1)
 * flag, and a query returns a MIDI_PARAM_VALUE response with the live value
 * (0..254) and the device's own label string. See `fractal-midi/gen1`
 * (readParam.ts, patchDump.ts) and the SYSEX-MAP.
 *
 * get_preset sends MIDI_GET_PATCH (fn 0x03; edit buffer, or a stored preset
 * 0..255) and parses the pinned regions of the MIDI_PATCH_DUMP (fn 0x04)
 * reply: source flag, 20-char name, and the 4×12 effect grid. Per-parameter
 * VALUES are NOT included — the spec leaves the dump's ~1790-byte parameter
 * region "undetermined", so the snapshot honestly says so instead of guessing
 * (one community capture closes it; captures-axe-fx-gen1.md C1). Bank-C
 * stored requests (≥ 256) refuse: the spec flags their request byte as OR'd
 * with an unknown value.
 *
 * Community-beta: the read wire is decoded byte-exactly from the gen-1 wiki
 * spec, but the project owns no gen-1 hardware, so whether the unit actually
 * answers a query is unconfirmed. When it does answer, the returned label is
 * ground truth (it is the device's own rendering). On no response within the
 * window the reader fails with `no_ack` and points the user at the front panel.
 *
 * Still out of scope (no implemented wire path): the dump's parameter region
 * (unpinned), save, preset/scene switching, channels, block placement.
 */

import type {
  BatchReadResult,
  DeviceReader,
  DispatchCtx,
  GetPresetOptions,
  ParamQuery,
  PresetSnapshot,
  PresetSnapshotSlot,
  ReadResult,
  Unit,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  KNOWN_PARAMS,
  AXE_FX_GEN1_BLOCKS,
  blockIdFor,
  buildGetParam,
  parseParamValue,
  isParamValueResponse,
  buildGetPatchDump,
  parsePatchDump,
  isPatchDumpResponse,
  type AxeFxGen1Param,
} from 'fractal-midi/gen1';

const DEVICE_LABEL = 'Fractal Axe-Fx Standard/Ultra';
/** Query response window. gen-1 round-trips are short; 300 ms matches AM4. */
const READ_RESPONSE_TIMEOUT_MS = 300;
/**
 * Patch-dump response window. The dump is ~2060 bytes — at DIN MIDI speed
 * (~3125 bytes/s) that is ~700 ms of wire time alone, so give it 2 s.
 */
const DUMP_RESPONSE_TIMEOUT_MS = 2000;

/** blockId ("Amp 1" = 106) → { slug, instance } for snapshot-slot mapping. */
const SLOT_INFO_BY_BLOCK_ID: ReadonlyMap<number, { slug: string; instance: number; name: string }> = new Map(
  AXE_FX_GEN1_BLOCKS.flatMap((b) =>
    b.instances.map((inst, i) => [inst.blockId, { slug: b.slug, instance: i + 1, name: inst.name }] as const),
  ),
);

function resolveParam(block: string, name: string): AxeFxGen1Param {
  const p = KNOWN_PARAMS[`${block}.${name}` as keyof typeof KNOWN_PARAMS] as AxeFxGen1Param | undefined;
  if (!p) {
    const known = Object.values(KNOWN_PARAMS)
      .filter((x) => (x as AxeFxGen1Param).block === block)
      .map((x) => (x as AxeFxGen1Param).name);
    throw new DispatchError(
      'unknown_param',
      DEVICE_LABEL,
      `Unknown parameter '${block}.${name}' on ${DEVICE_LABEL}.` +
        (known.length
          ? ` Known params for ${block}: ${known.slice(0, 20).join(', ')}${known.length > 20 ? ', …' : ''}.`
          : ` Unknown block '${block}'.`),
      { retry_action: `Call list_params({port, block:["${block}"]}) for the canonical names.` },
    );
  }
  return p;
}

async function readOne(ctx: DispatchCtx, block: string, name: string): Promise<ReadResult> {
  const p = resolveParam(block, name);
  const blockId = blockIdFor(block, 1);
  if (blockId === undefined) {
    throw new DispatchError('unknown_block', DEVICE_LABEL, `No wire blockId for '${block}' on ${DEVICE_LABEL}.`);
  }
  const req = buildGetParam(blockId, p.paramId);
  // Subscribe BEFORE sending so the device's response cannot outrace the
  // listener (mirrors the AM4 read path).
  const respPromise = ctx.conn.receiveSysExMatching(
    (resp) => isParamValueResponse(req, resp),
    READ_RESPONSE_TIMEOUT_MS,
  );
  ctx.conn.send(req);

  let resp: number[];
  try {
    resp = await respPromise;
  } catch {
    throw new DispatchError(
      'no_ack',
      DEVICE_LABEL,
      `No PARAM_VALUE response from ${DEVICE_LABEL} for '${block}.${name}' within ${READ_RESPONSE_TIMEOUT_MS}ms. ` +
        `gen-1 read-back is community-beta and unconfirmed on hardware; the unit may not answer queries on ` +
        `your firmware, or the port may have routed to a different codec.`,
      { retry_action: "Read the value off the device's front-panel display, and report the result so we can confirm gen-1 reads." },
    );
  }

  const parsed = parseParamValue(resp);
  if (!parsed) {
    throw new DispatchError(
      'no_ack',
      DEVICE_LABEL,
      `Malformed PARAM_VALUE response from ${DEVICE_LABEL} for '${block}.${name}'. Confirm on the front panel.`,
      { retry_action: 'Read the value off the front panel.' },
    );
  }

  // The device's own label is ground truth when present; fall back to the
  // descriptor's display decode (the device label is empty only if firmware
  // sent no string).
  const ps = ctx.descriptor.blocks[block]?.params[name];
  const unit: Unit = ps?.unit ?? 'opaque';
  const display_value =
    parsed.label !== ''
      ? parsed.label
      : ps?.decode
        ? ps.decode(parsed.value)
        : parsed.value;

  return {
    block,
    name,
    wire_value: parsed.value,
    display_value,
    unit,
    raw_response: resp,
  };
}

/**
 * Resolve a get_preset `location` to a gen-1 preset number. Accepts an
 * integer, a numeric string, or the spec's bank-letter labels ("A000",
 * "B128"; the digits are the absolute preset number, the letter is
 * informational). Presets ≥ 256 (bank C) refuse: their request bytes are
 * unpinned by the spec.
 */
function resolvePresetNumber(loc: string | number): number {
  let preset: number;
  if (typeof loc === 'number') {
    preset = loc;
  } else {
    const m = /^\s*(?:[abc])?\s*(\d{1,3})\s*$/i.exec(loc);
    if (!m) {
      throw new DispatchError(
        'bad_location',
        DEVICE_LABEL,
        `gen-1 preset locations are numbers 0..255 (spec labels A000..B255), got ${JSON.stringify(loc)}. ` +
          `Omit location to read the edit buffer.`,
      );
    }
    preset = Number.parseInt(m[1], 10);
  }
  if (!Number.isInteger(preset) || preset < 0 || preset > 383) {
    throw new DispatchError(
      'bad_location',
      DEVICE_LABEL,
      `gen-1 stored presets are 0..383 (banks A/B/C), got ${JSON.stringify(loc)}.`,
    );
  }
  if (preset > 255) {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      `Stored-preset reads are pinned only for presets 0..255 (banks A/B); ${preset} is in bank C. ` +
        `The published gen-1 spec flags bank-C request bytes as OR'd with an unknown value, so bank-C ` +
        `requests need one community capture to decode (captures-axe-fx-gen1.md, C1). ` +
        `Workaround: recall the preset on the device (send_program_change + bank select), then read the edit buffer.`,
    );
  }
  return preset;
}

async function getPresetSnapshot(ctx: DispatchCtx, options?: GetPresetOptions): Promise<PresetSnapshot> {
  const preset = options?.location === undefined ? undefined : resolvePresetNumber(options.location);
  const started = Date.now();
  const req = buildGetPatchDump(preset);
  // Subscribe BEFORE sending so the dump cannot outrace the listener.
  const respPromise = ctx.conn.receiveSysExMatching(
    (resp) => isPatchDumpResponse(req, resp),
    DUMP_RESPONSE_TIMEOUT_MS,
  );
  ctx.conn.send(req);

  let resp: number[];
  try {
    resp = await respPromise;
  } catch {
    throw new DispatchError(
      'no_ack',
      DEVICE_LABEL,
      `No MIDI_PATCH_DUMP response from ${DEVICE_LABEL} within ${DUMP_RESPONSE_TIMEOUT_MS}ms ` +
        `(request: ${preset === undefined ? 'edit buffer' : `stored preset ${preset}`}). ` +
        `The gen-1 patch dump is community-beta and unconfirmed on hardware; the unit may not answer ` +
        `fn 0x03 on your firmware, or the port may have routed to a different codec.`,
      { retry_action: 'Read the preset name off the front panel, and report the result so we can confirm the gen-1 patch dump.' },
    );
  }

  let dump;
  try {
    dump = parsePatchDump(resp);
  } catch (err) {
    throw new DispatchError(
      'no_ack',
      DEVICE_LABEL,
      `Malformed MIDI_PATCH_DUMP from ${DEVICE_LABEL}: ${err instanceof Error ? err.message : String(err)} ` +
        `A capture of this frame would be valuable — see captures-axe-fx-gen1.md (C1).`,
    );
  }

  const slots: PresetSnapshotSlot[] = [];
  const unresolved: string[] = [];
  for (const cell of dump.cells) {
    if (cell.effectId === 0) continue; // empty cell
    const info = SLOT_INFO_BY_BLOCK_ID.get(cell.effectId);
    if (!info) {
      unresolved.push(`grid cell ${cell.index}: effect id ${cell.effectId} (not in the gen-1 block table; raw)`);
      continue;
    }
    slots.push({
      slot: cell.index + 1, // 1-based serialized grid order (row/col streaming order unpinned)
      block_type: info.slug,
      ...(info.instance > 1 ? { instance: info.instance } : {}),
    });
  }

  const read_warnings: string[] = [
    `Snapshot source: ${dump.source === 'edit-buffer' ? 'the live EDIT BUFFER' : `STORED preset ${preset}`} ` +
      `(dump flag byte; ${dump.totalLength}-byte dump).`,
    'Per-parameter values are NOT included in this snapshot: the gen-1 patch dump\'s parameter region ' +
      `(${dump.paramBlockBytes} bytes in this dump) is not pinned by the published spec ("undetermined — ` +
      'assume parameter and modifier state"), so it is not decoded — a guess could return wrong values. ' +
      'Name + block layout only. Use get_param / get_params for live values. One community capture closes ' +
      'the gap (captures-axe-fx-gen1.md, C1).',
    'gen-1 patch dump is community-beta, decoded from the published spec, hardware-unverified: confirm the ' +
      'name and block list against the front panel and report the result.',
  ];
  if (unresolved.length) {
    read_warnings.push(...unresolved.map((u) => `Unresolved block: ${u}`));
  }

  return {
    name: dump.name,
    slots,
    read_warnings,
    _meta: {
      device: DEVICE_LABEL,
      read_at_ms: Date.now(),
      active_scene_only: true, // gen-1 has no scenes; the dump is the whole state
      routing_omitted: true, // per-cell state/routing bytes are undetermined in the spec
      read_duration_ms: Date.now() - started,
    },
  };
}

export const reader: DeviceReader = {
  async getParam(ctx: DispatchCtx, block: string, name: string): Promise<ReadResult> {
    return readOne(ctx, block, name);
  },

  async getPreset(ctx: DispatchCtx, options?: GetPresetOptions): Promise<PresetSnapshot> {
    return getPresetSnapshot(ctx, options);
  },

  async getParams(ctx: DispatchCtx, queries: readonly ParamQuery[]): Promise<BatchReadResult> {
    const reads: ReadResult[] = [];
    const failed_indices: number[] = [];
    const errors: Record<number, string> = {};
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      try {
        reads.push(await readOne(ctx, q.block, q.name));
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
};
