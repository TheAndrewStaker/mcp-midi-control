/**
 * Axe-Fx III DeviceDescriptor — community-beta scaffold (BK-015).
 *
 * BEFORE EDITING, READ:
 *   - `docs/devices/axe-fx-iii/SYSEX-MAP.md`
 *   - `docs/devices/axe-fx-iii/manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.txt` (Fractal v1.4 PDF extracted)
 *
 * The v1.4 PDF is the only Fractal-published spec for the III's third-
 * party MIDI surface. It documents bypass / channel / scene / preset
 * name / tempo / looper / tuner only.
 *
 * Session 88 founder direction: "make it work as much as possible and
 * just have users confirm it works. not list anything as unsupported
 * until [tested]." Per that direction the unified surface now wires
 * `set_param` / `get_param` / `get_params` / `set_params` through the
 * III-native fn=0x01 PARAMETER_SETGET envelope (see `./setParam.ts`
 * `FN_PARAMETER_SETGET` for the community evidence chain — byte-
 * verified against 10 public captures, Session 97). Every response
 * carries a 🟡 BETA warning naming the unverified surfaces; the device
 * also surfaces malformed-request rejections as 0x64
 * MULTIPURPOSE_RESPONSE frames, which we catch and surface inline.
 *
 * Every unified-surface op is wired up — none refused. Per Session 88
 * founder direction: III owners should be able to exercise the full
 * tool surface and confirm what works. Each op surfaces 0x64
 * MULTIPURPOSE_RESPONSE rejections inline so users can report results.
 *
 * Unified surface status:
 *   - get_param / set_param      : 🟡 fn=0x01 envelope, byte-verified
 *                                  SET (10 public captures); GET shape
 *                                  hypothesized, no public GET capture
 *   - get_params / set_params    : 🟡 loop over the above
 *   - set_bypass                 : 🟡 spec-documented (function 0x0A)
 *   - switch_scene               : 🟡 spec-documented (function 0x0C)
 *   - switch_preset              : 🟢 standard MIDI Program Change +
 *                                  Bank Select (the spec-documented way)
 *   - save_preset                : 🟡 II's 0x1D STORE_PRESET envelope —
 *                                  no preset payload, just "persist
 *                                  working buffer to slot N"
 *   - rename                     : 🟡 II's 0x09 SET_PRESET_NAME
 *   - set_block                  : 🟡 II's 0x05 SET_GRID_CELL
 *   - apply_preset               : 🟡 composes set_block + set_param
 *                                  across PresetSpec.slots, then
 *                                  optionally save_preset at target
 *
 * 🟡 ops are NOT in the v1.4 III spec — wire shapes are ported from
 * the Axe-Fx II's hardware-verified encoder with the III's model byte
 * (0x10). Safe to attempt because the III's parser rejects unsupported
 * envelopes via the 0x64 MULTIPURPOSE_RESPONSE error channel rather
 * than executing partial / unintended state writes; we catch those and
 * surface the rejection (with the named error code) inline.
 *
 * Registration order in `packages/server-all/src/server/index.ts`
 * MUST put Axe-Fx III BEFORE AM4 — the III's port-name regex
 * `/axe-?fx ?iii/i` is more specific than AM4's catch-all
 * `/Fractal/i`, and the dispatcher uses registration order as the
 * tiebreaker (DECISIONS.md row 40).
 */
import type {
  DeviceDescriptor,
  DeviceReader,
  DeviceWriter,
  DispatchCtx,
  BlockSchema,
  ParamSchema,
  ReadResult,
  BatchReadResult,
  BatchWriteResult,
  ParamQuery,
  WriteOp,
  WriteResult,
  BlockChange,
  PresetSpec,
  LocationRef,
  SlotRef,
  RenameTarget,
  ApplyResult,
  ApplyPresetOptions,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { formatUnknownParamError } from '@mcp-midi-control/core/protocol-generic/dispatcher/errorFormat.js';

import {
  AXE_FX_III_BLOCKS,
  resolveEffectId,
  type AxeFxIIIBlock,
} from 'fractal-midi/axe-fx-iii';
import { PARAMS_BY_FAMILY, type Param as AxeFxIIIParam } from 'fractal-midi/axe-fx-iii';
import {
  buildGetParameter,
  buildSetGridCell,
  buildSetParameter,
  buildSetPresetName,
  buildSetScene,
  buildStorePreset,
  buildSwitchPresetPC,
  describeMultipurposeResultCode,
  isMultipurposeResponse,
  isSetGetParameterResponse,
  parseMultipurposeResponse,
  parseSetGetParameterResponse,
  buildSetBypass,
} from 'fractal-midi/axe-fx-iii';
import { guardActiveBufferOrSave } from './tools/shared.js';
import { markDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';
import { AXEFX3_LABEL } from '@mcp-midi-control/core/server-shared/connections.js';

const DEVICE_LABEL = 'Fractal Axe-Fx III';

/** Wire response window — same budget the device-namespaced tools use. */
const GET_RESPONSE_TIMEOUT_MS = 800;

/**
 * Banner appended to every UNIFIED set_param / get_param response. The
 * III ships without a maintainer-owned device, so every successful op
 * is "spec-correct or II-derived but unverified on real hardware." The
 * agent surfaces this to the user so they can confirm by ear / by panel.
 */
const BETA_WARNING = [
  'axe-fx-iii community beta. The parameter SET/GET path is not in the',
  'published Axe-Fx III third-party MIDI spec; the wire shape is ported',
  'from the Axe-Fx II and is unverified on Axe-Fx III hardware. Please',
  'confirm the audible/visible response on the device. If the op silently',
  'no-ops, run axefx3_probe_sysex to see whether the device emitted a',
  'rejection frame vs. accepting the write.',
].join(' ');

function notInSpec(op: string, gap: string): DispatchError {
  return new DispatchError(
    'capability_not_supported',
    DEVICE_LABEL,
    `axe-fx-iii ${op}: not in v1.4 third-party MIDI spec. ${gap}`,
    {
      retry_action:
        'See docs/devices/axe-fx-iii/SYSEX-MAP.md for the spec coverage ' +
        'and docs/AXEFX3-BETA-TESTING.md for the community ' +
        'capture workflow that can unlock this operation.',
    },
  );
}

// ── Block-slug ↔ catalog-family mapping ────────────────────────────
//
// AxeFxIIIBlock entries use 3-letter groupCodes (CMP, REV, DLY, etc.);
// the PARAMS catalog families are spelled-out (COMP, REVERB, DELAY).
// Keep the mapping explicit so missing entries fail loud instead of
// silently producing empty BlockSchemas.

const GROUP_TO_FAMILY: Readonly<Record<string, string>> = Object.freeze({
  CMP: 'COMP',
  GEQ: 'GEQ',
  PEQ: 'PEQ',
  DRV: 'DISTORT',
  CAB: 'CABINET',
  REV: 'REVERB',
  DLY: 'DELAY',
  MTD: 'MULTITAP',
  CHO: 'CHORUS',
  FLG: 'FLANGER',
  ROT: 'ROTARY',
  PHA: 'PHASER',
  WAH: 'WAH',
  FRM: 'FORMANT',
  PTR: 'TREMOLO',
  PIT: 'PITCH',
  FIL: 'FILTER',
  FUZ: 'FUZZ',
  ENH: 'ENHANCER',
  MIX: 'MIXER',
  SYN: 'SYNTH',
  VOC: 'VOCODER',
  MGD: 'MEGATAP',
  XOV: 'CROSSOVER',
  GAT: 'GATE',
  RNG: 'RINGMOD',
  MBC: 'MULTICOMP',
  TTD: 'TENTAP',
  RES: 'RESONATOR',
  VOL: 'VOLUME',
  PLX: 'PLEX',
  SND: 'FDBKSEND',
  RTN: 'FDBKRET',
  LPR: 'LOOPER',
  TMA: 'TONEMATCH',
  RTA: 'RTA',
  MUX: 'MULTIPLEXER',
  IRP: 'IRPLAYER',
  IN: 'INPUT',
  OUT: 'OUTPUT',
  SMI: 'MIDIBLOCK',
  FC: 'FC',
  PFC: 'PRESET',
  DYD: 'DYNDIST',
  // Blocks with NO catalog family: AMP, NAM (post-v1.13 additions),
  // CTR (Controllers), TUN (Tuner), IRC (IR Capture utility), GBK
  // (Global Block), SHT (Shunt). These get empty params and set_param
  // refuses with "no params catalogued for <block>".
});

/** Slug → catalog family. Built once at module load. */
const BLOCK_SLUG_TO_FAMILY: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};
  for (const b of AXE_FX_III_BLOCKS) {
    const family = GROUP_TO_FAMILY[b.groupCode];
    if (family !== undefined) map[blockSlug(b)] = family;
  }
  return Object.freeze(map);
})();

/** Slug → block descriptor. Built once at module load. */
const BLOCK_SLUG_TO_BLOCK: Readonly<Record<string, AxeFxIIIBlock>> = (() => {
  const map: Record<string, AxeFxIIIBlock> = {};
  for (const b of AXE_FX_III_BLOCKS) {
    map[blockSlug(b)] = b;
  }
  return Object.freeze(map);
})();

function blockSlug(b: AxeFxIIIBlock): string {
  return b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// ── Param schema builders ──────────────────────────────────────────
//
// III display↔wire calibration is unverified — most catalog entries
// carry `unit: 'unverified'` and no displayMin/Max. We deliberately
// use PASSTHROUGH encode/decode so callers move integers in display
// space and the same integer reaches the wire (within the 0..65534
// 16-bit range). When the founder or a contributor verifies a
// per-param scale, that lives in the catalog as a separate concern.
//
// The 186 AM4-inferred entries carry display ranges but those are
// AM4 conventions, not III-verified — still passthrough until proven.

function stripFamilyPrefix(family: string, paramName: string): string {
  // REVERB_TYPE → type ; PITCH_HARM1 → harm1 ; GLOBAL_REVERBMIX → reverbmix
  const prefix = `${family}_`;
  if (paramName.startsWith(prefix)) {
    return paramName.slice(prefix.length).toLowerCase();
  }
  return paramName.toLowerCase();
}

function humanize(snake: string): string {
  return snake
    .split('_')
    .filter((s) => s.length > 0)
    .map((s) => s[0].toUpperCase() + s.slice(1).toLowerCase())
    .join(' ');
}

function makePassthroughEncode(family: string, paramKey: string): ParamSchema['encode'] {
  return (value: number | string): number => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(
        `${family}.${paramKey}: expected a number (raw wire 0..65534), got "${value}". ` +
          'Axe-Fx III display→wire calibration is unverified — pass the 16-bit wire integer directly.',
      );
    }
    if (!Number.isInteger(num) || num < 0 || num > 65534) {
      throw new Error(
        `${family}.${paramKey} expects wire 0..65534 (uncalibrated): ${num}`,
      );
    }
    return num;
  };
}

function makePassthroughDecode(): ParamSchema['decode'] {
  return (wire: number): number => wire;
}

function buildParamSchema(family: string, param: AxeFxIIIParam): {
  key: string;
  schema: ParamSchema;
} {
  const key = stripFamilyPrefix(family, param.name);
  return {
    key,
    schema: {
      display_name: humanize(key),
      unit: param.unit,
      display_min: param.displayMin,
      display_max: param.displayMax,
      encode: makePassthroughEncode(family, key),
      decode: makePassthroughDecode(),
      parameter_name: param.name,
    },
  };
}

/**
 * Build the `blocks` map for `describe_device`. Each AXE_FX_III_BLOCKS
 * entry becomes one BlockSchema slug; per-block params come from
 * PARAMS_BY_FAMILY[family] for any block whose groupCode has a catalog
 * family mapping. Blocks without a mapped family (AMP, NAM, Tuner,
 * etc.) get an empty params map — list_params still surfaces the block,
 * but set_param refuses with a clean "no params catalogued" error.
 */
function buildBlocks(): Record<string, BlockSchema> {
  const out: Record<string, BlockSchema> = {};
  for (const b of AXE_FX_III_BLOCKS) {
    const slug = blockSlug(b);
    const family = GROUP_TO_FAMILY[b.groupCode];
    const params: Record<string, ParamSchema> = {};
    const aliases: Record<string, string> = {};
    if (family !== undefined) {
      const catalogEntries = PARAMS_BY_FAMILY[family] ?? [];
      for (const p of catalogEntries) {
        // Skip firmware-internal sentinels (paramId >= 65520 are *_SET_ALL,
        // *_VAL_ALL — see params.ts header). They're documentary only,
        // not wire-addressable.
        if (p.paramId >= 0x3fff) continue;
        const { key, schema } = buildParamSchema(family, p);
        // First wins on key collision (e.g. FLANGER_TYPE vs FLANGER_OLD_TYPE
        // both → "type"). The catalog header notes the _OLD_ variants exist
        // for backward preset compat — wire writes should target the
        // current symbol, which appears first per dispatcher-case order.
        if (!(key in params)) {
          params[key] = schema;
          // Alias the original symbol so callers can paste catalog names verbatim.
          if (p.name.toLowerCase() !== key) {
            aliases[p.name.toLowerCase()] = key;
          }
        }
      }
    }
    out[slug] = {
      display_name: b.name,
      params,
      aliases: Object.keys(aliases).length > 0 ? aliases : undefined,
    };
  }
  return out;
}

// ── Param-write/read helpers ───────────────────────────────────────

function resolveBlockOrThrow(slug: string): { block: AxeFxIIIBlock; effectId: number } {
  const block = BLOCK_SLUG_TO_BLOCK[slug];
  if (block === undefined) {
    throw new DispatchError(
      'unknown_block',
      DEVICE_LABEL,
      `Block slug '${slug}' is not registered on ${DEVICE_LABEL}.`,
    );
  }
  let effectId: number;
  try {
    // Default to instance 1; multi-instance routing is a future hook.
    effectId = resolveEffectId(block.name, 1);
  } catch (err) {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      err instanceof Error ? err.message : String(err),
    );
  }
  return { block, effectId };
}

function resolveParamOrThrow(slug: string, name: string): {
  family: string;
  param: AxeFxIIIParam;
} {
  const family = BLOCK_SLUG_TO_FAMILY[slug];
  if (family === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      `Block '${slug}' has no parameter catalog on ${DEVICE_LABEL} — the III's ` +
        `groupCode-to-family map has no entry for this block (likely AMP / NAM / ` +
        `Tuner / Global Block / Shunt). set_param / get_param refuse for these.`,
    );
  }
  const catalogEntries = PARAMS_BY_FAMILY[family] ?? [];
  for (const p of catalogEntries) {
    if (stripFamilyPrefix(family, p.name) === name && p.paramId < 0x3fff) {
      return { family, param: p };
    }
  }
  // Gather every valid param name for this block so the shared
  // formatter can produce an AM4-style "Known params: ... Did you
  // mean: ..." message — matches the format AM4 has used all along.
  const knownNames: string[] = [];
  for (const p of catalogEntries) {
    if (p.paramId < 0x3fff) {
      const stripped = stripFamilyPrefix(family, p.name);
      if (!knownNames.includes(stripped)) knownNames.push(stripped);
    }
  }
  throw new DispatchError(
    'unknown_param',
    DEVICE_LABEL,
    formatUnknownParamError({
      deviceName: DEVICE_LABEL,
      block: slug,
      badParam: name,
      knownNames,
    }) + ` (family ${family})`,
  );
}

/** Coerce a LocationRef (string | number) to an integer preset 0..1023. */
function parseLocation(location: LocationRef): number {
  const n = typeof location === 'number' ? location : Number(location);
  if (!Number.isInteger(n) || n < 0 || n > 1023) {
    throw new DispatchError(
      'bad_location',
      DEVICE_LABEL,
      `axe-fx-iii: preset location '${location}' is invalid (expected integer 0..1023).`,
    );
  }
  return n;
}

/** Render a MULTIPURPOSE_RESPONSE result-code into a human-readable suffix. */
function formatErrorCode(report: { resultCode: number; description?: string }): string {
  const hex = `0x${report.resultCode.toString(16).padStart(2, '0')}`;
  return report.description !== undefined ? `${report.description} (${hex})` : `unknown result code ${hex}`;
}

/**
 * Send a 0x02 SET_PARAMETER and watch for a 0x64 MULTIPURPOSE_RESPONSE
 * rejection in a short window after the write. The III emits 0x64 only
 * on rejection — no echo on accept — so the predicate is "rejection
 * came back" rather than "ack came back."
 */
async function sendAndWatchForError(
  ctx: DispatchCtx,
  bytes: number[],
  windowMs = 50,
): Promise<{ resultCode: number; description?: string } | undefined> {
  const watchPromise = ctx.conn.receiveSysExMatching(
    isMultipurposeResponse,
    windowMs,
  );
  ctx.conn.send(bytes);
  try {
    const frame = await watchPromise;
    const parsed = parseMultipurposeResponse(frame);
    return {
      resultCode: parsed.resultCode,
      description: describeMultipurposeResultCode(parsed.resultCode),
    };
  } catch {
    return undefined; // No rejection within window → write accepted.
  }
}

// ── Reader ─────────────────────────────────────────────────────────

const reader: DeviceReader = {
  async getParam(
    ctx: DispatchCtx,
    blockSlugIn: string,
    name: string,
    _channel?: string | number,
  ): Promise<ReadResult> {
    const { effectId } = resolveBlockOrThrow(blockSlugIn);
    const { param } = resolveParamOrThrow(blockSlugIn, name);
    const requestBytes = buildGetParameter(effectId, param.paramId);
    const responsePromise = ctx.conn.receiveSysExMatching(
      isSetGetParameterResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    ctx.conn.send(requestBytes);
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      throw new DispatchError(
        'no_ack',
        DEVICE_LABEL,
        `get_param: no response from ${DEVICE_LABEL} within ${GET_RESPONSE_TIMEOUT_MS}ms — ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Likely causes: device doesn't honor 0x02 SET_PARAMETER (the III may have ` +
          `removed the op in firmware > 1.13), or block '${blockSlugIn}' (effect ID ` +
          `${effectId}) isn't placed in the active preset.`,
      );
    }
    const parsed = parseSetGetParameterResponse(response);
    return {
      block: blockSlugIn,
      name,
      wire_value: parsed.value,
      display_value: parsed.value,
      unit: param.unit,
      raw_response: response,
    };
  },

  async getParams(
    ctx: DispatchCtx,
    queries: readonly ParamQuery[],
  ): Promise<BatchReadResult> {
    const reads: ReadResult[] = [];
    const failed: number[] = [];
    const errors: Record<number, string> = {};
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      try {
        reads.push(await reader.getParam(ctx, q.block, q.name, q.channel));
      } catch (err) {
        failed.push(i);
        errors[i] = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      reads,
      failed_indices: failed,
      errors: failed.length > 0 ? errors : undefined,
    };
  },
};

// ── Writer ─────────────────────────────────────────────────────────

const writer: DeviceWriter = {
  buildSetParam(block: string, name: string, wireValue: number): number[] {
    const { effectId } = resolveBlockOrThrow(block);
    const { param } = resolveParamOrThrow(block, name);
    return buildSetParameter(effectId, param.paramId, wireValue);
  },

  buildSwitchPreset(location: LocationRef): number[] {
    const n = parseLocation(location);
    return buildSwitchPresetPC(n);
  },

  buildSwitchScene(scene: number): number[] {
    // Unified surface scene numbers are 1-indexed (display); wire is 0-indexed.
    return buildSetScene(scene - 1);
  },

  async setParam(
    ctx: DispatchCtx,
    blockSlugIn: string,
    name: string,
    wireValue: number,
    _channel?: number,
  ): Promise<WriteResult> {
    const { effectId } = resolveBlockOrThrow(blockSlugIn);
    const { param } = resolveParamOrThrow(blockSlugIn, name);
    const bytes = buildSetParameter(effectId, param.paramId, wireValue);
    const errorReport = await sendAndWatchForError(ctx, bytes);
    // Call-site SET/GET discrimination — see EDIT_FUNCTIONS_III comment
    // in midi.ts. fn=0x01 is dual-purpose with no byte-level discriminator,
    // so SET handlers mark dirty explicitly; GET handlers don't.
    markDirty(AXEFX3_LABEL);
    if (errorReport !== undefined) {
      const desc = errorReport.description
        ? `${errorReport.description} (code 0x${errorReport.resultCode.toString(16).padStart(2, '0')})`
        : `unknown result code 0x${errorReport.resultCode.toString(16).padStart(2, '0')}`;
      return {
        op: 'set_param',
        target: `${blockSlugIn}.${name}`,
        block: blockSlugIn,
        name,
        wire_value: wireValue,
        display_value: wireValue,
        acked: false,
        warning:
          `Axe-Fx III rejected set_param via 0x64 MULTIPURPOSE_RESPONSE: ${desc}. ` +
          BETA_WARNING,
      };
    }
    return {
      op: 'set_param',
      target: `${blockSlugIn}.${name}`,
      block: blockSlugIn,
      name,
      wire_value: wireValue,
      display_value: wireValue,
      acked: true,
      warning: BETA_WARNING,
    };
  },

  async setParams(ctx: DispatchCtx, ops: readonly WriteOp[]): Promise<BatchWriteResult> {
    const writes: WriteResult[] = [];
    let ackedCount = 0;
    let unackedCount = 0;
    for (const op of ops) {
      // executeSetParams pre-encodes display → wire before calling us, so
      // every WriteOp.value here is already a number. The shared WriteOp
      // type permits `number | string` for the pure-side pipeline; assert
      // it's the number we expect at the writer boundary.
      const wireValue = typeof op.value === 'number' ? op.value : Number(op.value);
      const result = await writer.setParam!(ctx, op.block, op.name, wireValue, op.channel);
      writes.push(result);
      if (result.acked) ackedCount += 1;
      else unackedCount += 1;
    }
    return {
      writes,
      acked_count: ackedCount,
      unacked_count: unackedCount,
    };
  },

  async setBlock(
    ctx: DispatchCtx,
    slot: SlotRef,
    change: BlockChange,
  ): Promise<WriteResult> {
    if (typeof slot === 'number') {
      throw new DispatchError(
        'value_out_of_range',
        DEVICE_LABEL,
        `axe-fx-iii setBlock: slot must be {row, col} (grid coords) — got linear index ${slot}. ` +
          'The III uses a 4×14 grid; pass slot as {row: 1..4, col: 1..14}.',
      );
    }
    if (change.bypassed !== undefined && change.block_type === undefined) {
      // Bypass-only change — route through the spec-documented 0x0A path.
      // setBypass needs a block name, not slot; if the caller passed slot
      // without block_type we can't resolve the effectId from slot alone.
      throw new DispatchError(
        'value_out_of_range',
        DEVICE_LABEL,
        `axe-fx-iii setBlock: bypass-only changes require block_type to resolve the effect ID. ` +
          'For a pure bypass toggle, call set_bypass with the block name instead.',
      );
    }
    if (change.block_type === undefined) {
      throw new DispatchError(
        'value_out_of_range',
        DEVICE_LABEL,
        'axe-fx-iii setBlock: block_type is required (or "none" / "empty" / "shunt" to clear the cell).',
      );
    }
    const blockType = change.block_type.trim().toLowerCase();
    let blockId: number;
    if (blockType === 'none' || blockType === 'empty' || blockType === '') {
      blockId = 0; // 0 clears the cell per II convention
    } else {
      try {
        // Default to instance 1; multi-instance addressing for slot-placement
        // would need a separate API surface.
        blockId = resolveEffectId(change.block_type, 1);
      } catch (err) {
        throw new DispatchError(
          'unknown_block',
          DEVICE_LABEL,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const bytes = buildSetGridCell({
      row: slot.row,
      col: slot.col,
      blockId,
    });
    const errorReport = await sendAndWatchForError(ctx, bytes);
    if (errorReport !== undefined) {
      return {
        op: 'set_block',
        target: `r${slot.row}c${slot.col}`,
        acked: false,
        warning:
          `Axe-Fx III rejected set_block via 0x64 MULTIPURPOSE_RESPONSE: ${formatErrorCode(errorReport)}. ` +
          BETA_WARNING,
      };
    }
    return {
      op: 'set_block',
      target: `r${slot.row}c${slot.col}`,
      acked: true,
      display_value: blockType === 'none' || blockType === 'empty' ? 'cleared' : change.block_type,
      warning:
        '🟡 axe-fx-iii set_block: tried II 0x05 SET_GRID_CELL envelope on III. ' +
        'Device emitted no rejection but the III may have ignored the write — ' +
        'confirm by checking the grid layout (call get_grid_layout or look at the device).',
    };
  },

  async setBypass(
    ctx: DispatchCtx,
    block: string,
    bypassed: boolean,
  ): Promise<WriteResult> {
    let effectId: number;
    try {
      effectId = resolveEffectId(block);
    } catch (err) {
      throw new DispatchError(
        'unknown_block',
        DEVICE_LABEL,
        err instanceof Error ? err.message : String(err),
      );
    }
    const bytes = buildSetBypass(effectId, bypassed);
    await ctx.conn.send(bytes);
    return {
      op: 'set_bypass',
      target: block,
      acked: true,
      display_value: bypassed ? 'bypassed' : 'engaged',
      warning:
        '🟡 axe-fx-iii set_bypass: spec-documented (function 0x0A) but ' +
        'pending hardware verification. Targets the ACTIVE scene only — ' +
        'per v1.4 spec, the III has no per-scene bypass write.',
    };
  },

  async applyPreset(
    ctx: DispatchCtx,
    spec: PresetSpec,
    target?: LocationRef,
    options?: ApplyPresetOptions,
  ): Promise<ApplyResult> {
    // Compose: for each slot in spec.slots, attempt set_block to place
    // the block, then loop set_param for any per-block params. Optional
    // rename + save at the end.
    //
    // This is a best-effort attempt — the 🟡 ops (set_block via 0x05,
    // save via 0x1D, rename via 0x09) may all be rejected by III
    // firmware. The dispatcher's design surfaces each rejection
    // individually so the caller can see exactly which step failed.
    const writes: WriteResult[] = [];
    let anyFailed = false;

    // 1. Place blocks (set_block per slot — 🟡 0x05 untested on III)
    for (const slotSpec of spec.slots) {
      if (typeof slotSpec.slot !== 'object') {
        writes.push({
          op: 'set_block',
          target: String(slotSpec.slot),
          acked: false,
          warning:
            `axe-fx-iii apply_preset: skipped slot ${String(slotSpec.slot)} — ` +
            'linear slot indexing not supported on grid device.',
        });
        anyFailed = true;
        continue;
      }
      try {
        const result = await writer.setBlock!(ctx, slotSpec.slot, {
          block_type: slotSpec.block_type,
          bypassed: slotSpec.bypassed,
        });
        writes.push(result);
        if (!result.acked) anyFailed = true;
      } catch (err) {
        writes.push({
          op: 'set_block',
          target: `r${slotSpec.slot.row}c${slotSpec.slot.col}`,
          acked: false,
          warning: `set_block failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        anyFailed = true;
      }
    }

    // 2. Loop per-block params (set_param per entry — 🟡 0x02 untested on III)
    for (const slotSpec of spec.slots) {
      if (slotSpec.params === undefined) continue;
      // We don't unwrap channel-nested params here — the III's setParam
      // takes a single block slug + name. A channel-nested apply_preset
      // would need to set_channel between writes; left for a future pass.
      const blockSlug = slotSpec.block_type.trim().toLowerCase();
      for (const [paramName, value] of Object.entries(slotSpec.params)) {
        if (typeof value === 'object') {
          // Channel-nested entry — skip with note. Per-channel apply is
          // a follow-up.
          writes.push({
            op: 'set_param',
            target: `${blockSlug}.${paramName}`,
            acked: false,
            warning:
              `axe-fx-iii apply_preset: skipped channel-nested param ${blockSlug}.${paramName} — ` +
              'per-channel apply not yet wired on the III. Use set_param with explicit channel instead.',
          });
          anyFailed = true;
          continue;
        }
        try {
          // The value is display-shaped; for III this is wire-passthrough
          // per the catalog's passthrough encode/decode contract.
          const wireValue = typeof value === 'number' ? value : Number(value);
          if (!Number.isFinite(wireValue)) {
            throw new Error(`Non-numeric value for ${blockSlug}.${paramName}: ${value}`);
          }
          const result = await writer.setParam!(ctx, blockSlug, paramName, wireValue);
          writes.push(result);
          if (!result.acked) anyFailed = true;
        } catch (err) {
          writes.push({
            op: 'set_param',
            target: `${blockSlug}.${paramName}`,
            acked: false,
            warning: `set_param failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          anyFailed = true;
        }
      }
    }

    // 3. Optional rename + save (only if caller asked to persist)
    if (spec.name !== undefined) {
      try {
        const result = await writer.rename!(ctx, 'preset', spec.name);
        writes.push(result);
        if (!result.acked) anyFailed = true;
      } catch (err) {
        writes.push({
          op: 'rename',
          target: 'preset',
          acked: false,
          warning: `rename failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        anyFailed = true;
      }
    }
    if (target !== undefined) {
      try {
        const result = await writer.savePreset!(ctx, target);
        writes.push(result);
        if (!result.acked) anyFailed = true;
      } catch (err) {
        writes.push({
          op: 'save_preset',
          target: String(target),
          acked: false,
          warning: `save_preset failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        anyFailed = true;
      }
    }

    void options; // landingScene / no_save_on_done not yet wired

    const failedStepIdx = writes.findIndex((w) => !w.acked);
    return {
      ok: !anyFailed,
      steps: writes.length,
      duration_ms: 0, // not measured per-step on this path
      failed_step: failedStepIdx >= 0 ? {
        index: failedStepIdx,
        description: writes[failedStepIdx].target ?? writes[failedStepIdx].op ?? 'step',
        error: writes[failedStepIdx].warning ?? 'no warning recorded',
      } : undefined,
      warning:
        '🟡 axe-fx-iii apply_preset: composed of best-effort 0x05/0x02/0x09/0x1D ' +
        'envelopes (none of which are in the v1.4 III spec). Confirm the audible / ' +
        'visible result on the device. ' +
        `${writes.length} step(s) attempted; ${writes.filter((w) => w.acked).length} acked.`,
      saved: target !== undefined ? !anyFailed : undefined,
    };
  },

  async switchPreset(
    ctx: DispatchCtx,
    location: LocationRef,
  ): Promise<WriteResult> {
    const n = parseLocation(location);
    const bytes = buildSwitchPresetPC(n);
    ctx.conn.send(bytes);
    return {
      op: 'switch_preset',
      target: String(n),
      acked: true,
      display_value: String(n),
      warning:
        'axe-fx-iii switch_preset: sent standard MIDI Program Change + Bank ' +
        'Select on channel 1 (the III\'s factory-default MIDI channel). The III ' +
        'does not ack PC writes — confirm by reading the new active preset name ' +
        '(get_preset_name) or by checking the device front panel. If the device ' +
        'is configured to listen on a different MIDI channel, the switch will ' +
        'silently no-op; set the III back to channel 1 in its Global → MIDI menu.',
    };
  },

  async savePreset(
    ctx: DispatchCtx,
    location: LocationRef,
    name?: string,
  ): Promise<WriteResult> {
    // Try II's 0x1D STORE_PRESET envelope (10 bytes total — no preset
    // payload, just "persist working buffer to slot N"). The community-
    // known III-native 0x77/0x78/0x79 envelope requires Huffman-
    // compressed preset content and is out of scope here. If III ignores
    // 0x1D, the user can fall back to saving on the device front panel.
    const n = parseLocation(location);
    if (name !== undefined) {
      // Pre-write the new name before the store. If rename rejects, surface
      // the rejection but still attempt the store.
      try {
        const renameResult = await writer.rename!(ctx, 'preset', name);
        if (!renameResult.acked) {
          // Continue to save attempt anyway.
        }
      } catch {
        // Continue to save attempt anyway.
      }
    }
    const bytes = buildStorePreset(n);
    const errorReport = await sendAndWatchForError(ctx, bytes, 200);
    if (errorReport !== undefined) {
      return {
        op: 'save_preset',
        target: String(n),
        acked: false,
        warning:
          `Axe-Fx III rejected save_preset (II 0x1D envelope) via 0x64 MULTIPURPOSE_RESPONSE: ${formatErrorCode(errorReport)}. ` +
          'The III may require its native 0x77/0x78/0x79 multi-frame envelope ' +
          '(community RE, requires Huffman-compressed preset content — not yet ' +
          'implemented). For now, save on the device front panel. ' + BETA_WARNING,
      };
    }
    return {
      op: 'save_preset',
      target: String(n),
      acked: true,
      display_value: String(n),
      warning:
        '🟡 axe-fx-iii save_preset: sent II 0x1D STORE_PRESET envelope ' +
        '(10 bytes, no preset payload — just "persist working buffer to slot N"). ' +
        'Device emitted no rejection but the III may have ignored the write. ' +
        'CONFIRM by switching to a different preset and back — if the working ' +
        'buffer state survived, the save landed. If the original preset returns, ' +
        'the III needs its native 0x77/0x78/0x79 envelope (not yet implemented).',
    };
  },

  async switchScene(ctx: DispatchCtx, scene: number): Promise<WriteResult> {
    if (!Number.isInteger(scene) || scene < 1 || scene > 8) {
      throw new DispatchError(
        'value_out_of_range',
        DEVICE_LABEL,
        `axe-fx-iii switchScene: scene ${scene} out of range. ` +
          'The III has 8 scenes per preset (1..8 display, 0..7 wire).',
      );
    }
    const bytes = buildSetScene(scene - 1);
    await ctx.conn.send(bytes);
    return {
      op: 'switch_scene',
      target: String(scene),
      acked: true,
      warning:
        '🟡 axe-fx-iii switch_scene: spec-documented (function 0x0C) but ' +
        'pending hardware verification.',
    };
  },

  async rename(
    ctx: DispatchCtx,
    target: RenameTarget,
    name: string,
  ): Promise<WriteResult> {
    if (target !== 'preset') {
      throw new DispatchError(
        'capability_not_supported',
        DEVICE_LABEL,
        `axe-fx-iii rename: only target='preset' is wired (tried target='${target}'). ` +
          'Scene rename would need SET_SCENE_NAME (function 0x0X) which has no II analog ' +
          'to port from.',
      );
    }
    let bytes: number[];
    try {
      bytes = buildSetPresetName(name);
    } catch (err) {
      throw new DispatchError(
        'value_out_of_range',
        DEVICE_LABEL,
        err instanceof Error ? err.message : String(err),
      );
    }
    const errorReport = await sendAndWatchForError(ctx, bytes, 100);
    if (errorReport !== undefined) {
      return {
        op: 'rename',
        target: 'preset',
        acked: false,
        warning:
          `Axe-Fx III rejected rename (II 0x09 SET_PRESET_NAME envelope) via 0x64 MULTIPURPOSE_RESPONSE: ${formatErrorCode(errorReport)}. ` +
          BETA_WARNING,
      };
    }
    return {
      op: 'rename',
      target: 'preset',
      acked: true,
      display_value: name,
      warning:
        '🟡 axe-fx-iii rename: sent II 0x09 SET_PRESET_NAME envelope. ' +
        'Device emitted no rejection but the III may have ignored the write — ' +
        'confirm via get_preset_name (or by checking the front-panel preset title). ' +
        'Working-buffer scope only; persist with save_preset.',
    };
  },

  /**
   * Safe-edit dirty-gate adapter. Delegates to the III's device-sourced
   * dirty signal (STATE_BROADCAST `fn=0x01 04 01`) classified at the
   * connection layer in `midi.ts:wrapWithDirtyClassification`. See
   * `docs/devices/axe-fx-iii/dirty-state-research.md` for the evidence chain.
   *
   * 🟡 Beta: the inbound broadcast captures are all from AxeEdit-active
   * sessions; emission when the MCP server is the sole host has not been
   * confirmed on hardware. The outbound belt-and-suspenders markDirty on
   * edit-class SysEx keeps the gate fail-safe even if device-sourced
   * detection misses an edit.
   */
  async guardActiveBufferOrSave(_ctx, mode) {
    return guardActiveBufferOrSave(mode);
  },
};

// ── Agent guidance ─────────────────────────────────────────────────

const AXEFX3_AGENT_GUIDANCE: Record<string, string> = {
  note_response: [
    'play_note / play_chord on the Axe-Fx III are AUDIBLE only when the',
    'Synth block is placed in the active preset (the III\'s Synth block',
    'responds to incoming MIDI notes on channel 1). Without a Synth',
    'block, the III is an audio processor for guitar input and MIDI',
    'notes are silent. The unified tool always sends the bytes',
    'successfully; whether sound emerges depends on the preset.',
  ].join('\n'),

  diagnostic_isolation: [
    'When the user reports an unwanted artifact in a tone, isolate via',
    'set_bypass — toggle one block at a time and ask the user to play',
    'between toggles, before changing any param values. Without a Synth',
    'block in the active preset, MIDI notes don\'t produce sound on the',
    'III (see note_response above), so the human-in-the-loop is the test',
    'signal. Bulk edits during diagnosis hide which change mattered;',
    'isolation surfaces the source one round-trip at a time. Batching is',
    'correct for confident builds; isolation is the right tool for',
    'chasing artifacts.',
  ].join('\n'),

  beta_status: [
    'BETA / HARDWARE VERIFICATION NEEDED.',
    '',
    'The Axe-Fx III protocol layer is partly community-derived. Some',
    'operations are documented in the Fractal third-party MIDI spec;',
    'others are ported from the Axe-Fx II family with the III model',
    'byte. When an op is rejected, the device returns an error frame',
    'with a named result code — report it verbatim to the user so they',
    'can confirm by ear / by panel.',
    '',
    'No unified-surface op refuses outright. Every op attempts a wire',
    'send and surfaces device rejections inline so an Axe-Fx III owner',
    'can exercise the full surface and report results.',
    '',
    'When a write is acked, tell the user what you wrote AND ask them',
    'to confirm the audible / visible response on the device. Their',
    'confirmation is the verification path. Example: "I set pitch.harm1',
    'to wire 27 — can you confirm the harmony interval changed on the',
    'front panel?"',
    '',
    'If the device rejects an op, surface the named error code verbatim',
    '(e.g. "message not recognized", "invalid parameter ID", "DSP',
    'overload"). Do not paper over rejections.',
  ].join('\n'),
  channels: [
    'Axe-Fx III channel names: A, B, C, D (4 channels per block — same as',
    "AM4, different from Axe-Fx II's X/Y). Per-spec function 0x0B `id id dd`",
    'targets the ACTIVE scene only — the III has no per-scene channel write',
    'in the v1.4 spec.',
  ].join('\n'),
  scenes: [
    'Axe-Fx III: 8 scenes per preset. Scenes are 1-indexed in user-facing',
    'tools, 0-indexed on the wire (the descriptor handles conversion).',
  ].join('\n'),
  effect_ids: [
    'Block-level operations (bypass, channel) need an EFFECT ID, which is',
    "an integer 0..16383 from v1.4 Appendix 1. Examples:",
    "  - Compressor 1..4    →  46..49",
    "  - Drive 1..4         →  58..61",
    "  - Cab 1..4           →  62..65",
    "  - Reverb 1..4        →  66..69",
    "  - Delay 1..4         →  70..73",
    "  - Chorus 1..4        →  78..81",
    "  - Pitch 1..4         →  110..113",
    "  - Tone Match 1..4    →  170..173",
    "  - Plex Delay 1..4    →  178..181",
    "  - Multiplexer 1..4   →  191..194",
    "  - IR Player 1..4     →  195..198",
    'Full table: docs/devices/axe-fx-iii/SYSEX-MAP.md.',
    '',
    'AMP, Dynamic Distortion, NAM, Global Block, Shunt — effect IDs NOT',
    'in v1.4; bypass/channel control for these will refuse until decoded.',
  ].join('\n'),
  param_addressing: [
    'set_param / get_param address by (block, name) where:',
    '  - block is a single-instance slug (e.g. "reverb", "pitch", "drive")',
    '    that defaults to instance 1. Multi-instance routing (reverb 2,',
    '    drive 4) is a future hook — for now, all writes hit instance 1.',
    '  - name is the lowercase-stripped catalog symbol (REVERB_TYPE → type,',
    '    PITCH_HARM1 → harm1). The original symbol is also accepted as an',
    '    alias (so "reverb_type" works too).',
    '',
    'VALUE IS RAW WIRE 0..65534 — the III has no published display',
    'calibration so set_param/get_param pass the 16-bit wire integer',
    'through verbatim. Enum / select params: pass the wire index directly',
    '(0, 1, 2, ...). When you write, READ BACK and confirm with the user.',
    '',
    'list_params(port="axe-fx-iii", block=...) returns the per-block param',
    'list mined from AxeEdit III. The `parameter_name` field on each entry',
    'is the firmware-internal symbol (e.g. PITCH_HARM1) — useful for',
    'cross-referencing with community forum posts.',
  ].join('\n'),

  loudness: [
    'LOUDNESS MODEL on the Axe-Fx III. CRITICAL CAVEAT: the III ships',
    'WITHOUT a published display calibration, so set_param values are RAW',
    'WIRE INTEGERS 0..65534, not display units like AM4 and II. The midpoint',
    'of most loudness knobs is wire ~32767, NOT 5. Read the param_addressing',
    'topic before issuing any loudness write.',
    '',
    'Knobs that move loudness, with the wire ranges as best we know them',
    '(catalog mined from AxeEdit III, hardware verification pending; see',
    'the beta_status topic):',
    '',
    '  amp.gain           wire 0..65534   Amp input drive. Catalog name in the',
    '                                     III is the firmware-internal symbol',
    '                                     `AMP_DRIVE` / similar; the unified',
    '                                     surface accepts `gain` as the display',
    '                                     word per cross-device convention.',
    '  amp.master         wire 0..65534   Amp master volume. Cross-device',
    '                                     alias accepts `master_volume` and',
    '                                     `volume`.',
    '  drive.level        wire 0..65534   Drive block output. Matches the AM4',
    '                                     convention (the III uses the catalog',
    '                                     symbol DISTORT_LEVEL). The unified',
    '                                     alias table accepts `volume` and',
    '                                     `output` here.',
    '  drive.gain         wire 0..65534   Drive block input gain. The III\'s',
    '                                     catalog symbol is DISTORT_DRIVE; the',
    '                                     alias `drive` resolves to `gain`.',
    '  reverb.mix         wire 0..65534   Wet/dry of reverb. Wire midpoint ~',
    '                                     32767 ≈ 50%. Higher values mask the',
    '                                     amp mid-range.',
    '  delay.mix          wire 0..65534   Wet/dry of delay.',
    '  <fx>.mix           wire 0..65534   Same shape on chorus / flanger /',
    '                                     phaser / rotary / pitch / etc.',
    '',
    'WIRE-TO-PERCEPTION GUIDE (uncalibrated, treat as approximate until',
    'hardware verification lands):',
    '',
    '  wire 0          ≈ knob fully counterclockwise / -inf dB / muted',
    '  wire 16384      ≈ 25% knob / -6 dB-ish for log-shaped params',
    '  wire 32767      ≈ midpoint / unity-ish for dB-shaped params',
    '  wire 49152      ≈ 75% knob',
    '  wire 65534      ≈ knob fully clockwise / +max',
    '',
    'For "make this knob 50%" reach for wire 32767. For "subtle / quarter',
    'turn" reach for wire 16384. After every write, READ BACK with get_param',
    'and confirm the device label echoes a value consistent with your intent.',
    '',
    'CROSS-PARAM INTERACTIONS (same audio-engineer rules of thumb as AM4 / II):',
    '',
    '  - Raising amp.gain (input drive) lifts perceived loudness as well as',
    '    distortion. For "more crunch but same volume", raise amp.gain by',
    '    ~6500 wire units and drop amp.master by ~3000.',
    '  - Engaging a drive block in front of an amp typically adds 3-6 dB',
    '    perceived loudness even at unity drive.level (~32767). Expect to',
    '    drop amp.master or output trim by a few thousand wire units to',
    '    keep stage level constant.',
    '  - reverb.mix above wire ~32767 (≈50%) masks 1-3 kHz mid-range and',
    '    can swallow a lead. Aim for wire 8000-13000 (25-40%) for normal',
    '    rooms / plates.',
    '',
    'CROSS-DEVICE NAMING. Same conceptual knob, different canonical names:',
    '',
    '  Axe-Fx III drive.level     ↔  AM4 drive.level        ↔  Axe-Fx II drive.volume',
    '  Axe-Fx III amp.master      ↔  AM4 amp.master         ↔  Axe-Fx II amp.master_volume',
    '  Axe-Fx III amp.gain        ↔  AM4 amp.gain           ↔  Axe-Fx II amp.input_drive',
    '',
    'The unified surface ships a cross-device alias table at',
    'packages/core/src/protocol-generic/cross-device-aliases.ts. An agent',
    'trained on II vocabulary can type `drive.volume` on the III and the',
    'dispatcher resolves it to `drive.level`. Prefer the canonical III name',
    'when writing, and quote the canonical name back in summaries.',
    '',
    'SCENE LEVELING. The III has 8 scenes per preset. When you build a',
    'multi-scene preset, pick ONE scene as the loud reference (usually the',
    'highest-gain rhythm scene) and balance the others within roughly',
    '±3000 wire units of it via the Output block or amp.level (NOT',
    'amp.master, because master interacts with the amp model and can change',
    'tone). A clean scene more than ~6000 wire units quieter than the',
    'lead scene tends to feel disconnected on stage. Conventional spread:',
    'clean -3000, crunch 0 (reference), lead -1000, solo +1000.',
    '',
    'III BETA STATUS. Until a maintainer captures III hardware end-to-end,',
    'every loudness write on the III is a hypothesis. Tell the user the',
    'wire value you sent and ask them to confirm the audible result. Their',
    'confirmation IS our verification pipeline.',
  ].join('\n'),
};

// ── Example spec ───────────────────────────────────────────────────

/**
 * Working `apply_preset` payload literal for the unified surface. The III
 * uses {row, col} grid slot refs (4 rows x 14 cols) and A/B/C/D channels.
 * Values are RAW WIRE INTEGERS (0..65534) because the III ships without a
 * published display calibration; wire 32767 is the rough knob midpoint.
 *
 * The III amp block has no parameter catalog in the v1.4 PDF, so the amp
 * slot is placed empty here; channel and bypass control on amp still
 * work via scenes. The spec passes `collectApplyPresetPreflight` with
 * zero errors (verified by `scripts/verify-describe-device.ts`).
 */
const AXEFX3_EXAMPLE_SPEC: PresetSpec = {
  name: 'Demo',
  slots: [
    {
      slot: { row: 2, col: 1 },
      block_type: 'drive',
      params: {
        A: { type: 3, bass: 5, mid: 5, treble: 5, master: 5 },
      },
    },
    { slot: { row: 2, col: 2 }, block_type: 'amp' },
    { slot: { row: 2, col: 3 }, block_type: 'cab' },
    {
      slot: { row: 2, col: 4 },
      block_type: 'reverb',
      params: {
        A: { type: 3, time: 5, mix: 25 },
      },
    },
  ],
  scenes: [
    { scene: 1, name: 'Clean', channels: { reverb: 'A' }, bypassed: { drive: true } },
    { scene: 2, name: 'Lead', channels: { reverb: 'A' }, bypassed: { drive: false } },
  ],
  landingScene: 1,
};

// ── Descriptor ─────────────────────────────────────────────────────

export const AXEFX3_DESCRIPTOR: DeviceDescriptor = {
  id: 'axe-fx-iii',
  display_name: 'Fractal Axe-Fx III',
  connection_label: 'axe-fx-iii',
  port_match: [
    // /axe-?fx ?iii/i — matches "Axe-Fx III", "AxeFx III", "axe fx iii", etc.
    { pattern: /axe-?fx ?iii/i },
    // /axe-?fx ?3/i — covers "Axe-Fx 3" / "AxeFx3" / "axefx 3" / "axe fx 3".
    { pattern: /axe-?fx ?3/i },
  ],
  capabilities: {
    slot_model: 'grid',
    // 4×14 grid: Mark II (current firmware) ships 14 columns.
    grid: { rows: 4, cols: 14 },
    has_scenes: true,
    scene_count: 8,
    has_channels: true,
    channel_names: ['A', 'B', 'C', 'D'],
    preset_location_format: /^(?:\d{1,4})$/,
    supports_save: false,           // STORE envelope not in v1.4 PDF
    supports_factory_restore: false,
    supports_lineage: false,
  },
  canonical_terms: {
    block: 'block',
    slot: 'grid cell (row 1..4, col 1..14)',
    preset: 'preset',
    scene: 'scene 1..8',
    channel: 'channel A/B/C/D',
    location: 'preset slot 0..1023 (integer)',
  },
  blocks: buildBlocks(),
  reader,
  writer,
  agent_guidance: AXEFX3_AGENT_GUIDANCE,
  example_spec: AXEFX3_EXAMPLE_SPEC,
};
