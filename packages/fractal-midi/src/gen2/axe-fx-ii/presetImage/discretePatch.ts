/**
 * Axe-Fx II preset-image DISCRETE (rostered-select) word patch.
 *
 * Evidence (2026-07-16 corpus audit, adversarially reproduced):
 * X-channel discrete words in the II preset image ARE the raw wire
 * ordinal, needing no calibration: 24,324/24,324 rostered-select
 * X-channel observations across 389 dumps (384 Q8.02 factory + live
 * hardware dumps + the 2026-07-10 front-panel-confirmed ground-truth
 * fixture) decode in-roster with ZERO sentinels and ZERO out-of-roster
 * values. Three independent oracles agree (device fn 0x28 label dump
 * 154/155 vs catalog; the hardware fixture drive X word 844 = 6 =
 * T808 OD / Y word 865 = 36 = BLACKGLASS 7K; the BK-070 amp-type
 * ordinal 0 anchor at word 149 on A000). Byte-2 reserved bits are ZERO
 * on every select-param word in the corpus (61,272 observations), and
 * are preserved regardless (the image buffer carries them per word).
 *
 * Y-channel hazard (the kill-criterion finding, honored here): the
 * "second half of an even payload = channel-Y mirror" assumption FAILS
 * for specific families:
 *   - Multi Delay (MTD) and Controllers: the second half is NOT an X/Y
 *     param mirror at all. Channel-Y discrete patches REFUSE outright.
 *   - Amp (and small clusters in CHO/DLY/DRV/FIL/FLG/FRM/PIT/SYN):
 *     stale Y-half content at fixed pid subsets, including on live
 *     hardware dumps. Channel-Y patches on non-clean families are
 *     gated per-word by read-before-write: refused unless the CURRENT
 *     word at the target position is already in-roster or a sentinel
 *     (32767 / 65534; sentinels occur only on Y). This converts the
 *     stale-half hazard into a structured refusal.
 *   - Corpus-clean Y families (zero bad AND zero sentinel corpus-wide):
 *     CAB, CPR, GEQ, GTE, MBC, PEQ, PHA, REV, ROT, WAH pass without
 *     the read-before-write gate. (MBC is additionally unreachable on
 *     Y: it is a single-channel full-payload family, refused earlier.)
 *
 * Itemized exclusions (refused by name, never silently dropped):
 *   - controlType 'switch' / 'knob' / 'unknown' params: the census
 *     covered ROSTERED SELECTS only; switches ship when their own
 *     census lands. Knobs stay on the shipped continuous lane.
 *   - selects with no registered enumValues roster (e.g. cab.cab /
 *     cab.cab_r, the raw IR index): ordinal-by-number would work
 *     mechanically but violates display-first until the fn 0x12 name
 *     roster lands.
 *   - dual-mode tempo selects (name contains 'tempo'): they store raw
 *     ms when tempo-sync is off (known catalog modeling gap); excluded
 *     until remodeled.
 *   - `<block>.bypass` housekeeping pids: pid-identity refusal, defense
 *     in depth (that word is the 8-scene state mask; a discrete write
 *     there corrupts all 8 scenes' bypass + channel state).
 *
 * Type selectors (`effect_type`, paramId 0): the BYTES are pinned
 * (ordinal-in-word, X census clean over 381 amps + hardware anchors),
 * so the patch applies, but an image-patched type change bypasses
 * whatever dependent-param recompute a live fn 0x02 type set performs;
 * sonic equivalence with a live type switch is hardware-unverified.
 * Applied entries carry an explicit note.
 *
 * Support status: community-beta / hardware-unverified (the 2026-05-22
 * NACK-free modify-push evidence changed continuous words; nothing in
 * the framing/hash/byte-2 rules is value-kind-aware). Q8.02 / XL+
 * scoped.
 */

import { KNOWN_PARAMS, type AxeFxIIParam } from '../params.js';
import type { AxeFxIIImageBuffer } from './frames.js';
import {
  parseIIImageTlv,
  findIIImageBlock,
  imageParamWordIndex,
  II_BYPASS_PID_BY_GROUP,
} from './tlv.js';

/** Y-channel families with corpus-clean mirrors (see module docstring). */
export const II_CLEAN_Y_GROUPS: ReadonlySet<string> = new Set([
  'CAB', 'CPR', 'GEQ', 'GTE', 'MBC', 'PEQ', 'PHA', 'REV', 'ROT', 'WAH',
]);

/** Families whose second payload half is NOT an X/Y mirror: never patch Y. */
export const II_NEVER_Y_GROUPS: ReadonlySet<string> = new Set(['MTD', 'CONTROLLERS']);

/** Sentinel values observed on Y-channel select words (never on X). */
export const II_Y_SENTINELS: ReadonlySet<number> = new Set([32767, 65534]);

/** groupCode -> registry block slug ("AMP" -> "amp"). */
const SLUG_BY_GROUP: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const entry of Object.values(KNOWN_PARAMS)) {
    if (!map.has(entry.groupCode)) map.set(entry.groupCode, entry.block);
  }
  return map;
})();

export interface IIDiscretePatchInput {
  /** Block wire id (must be placed in the image's TLV chain). */
  readonly blockWireId: number;
  /** Registered param name within the block's family ("effect_type", "mic"). */
  readonly paramName: string;
  readonly channel: 'X' | 'Y';
  /**
   * Display-first value: the roster LABEL (exact, case-insensitive) or
   * the ordinal number itself. Labels are the preferred display shape;
   * ordinals are accepted because they are the documented wire contract
   * for rostered selects.
   */
  readonly value: string | number;
}

export interface IIAppliedDiscretePatch {
  readonly input: IIDiscretePatchInput;
  readonly wordIndex: number;
  readonly beforeWire: number;
  readonly afterWire: number;
  /** The roster label the new ordinal decodes to. */
  readonly label: string;
  /** True when the pre-patch word was already a valid roster ordinal. */
  readonly beforeInRoster: boolean;
  /** Present on type-selector patches (dependent-recompute caveat). */
  readonly note?: string;
}

export interface IIRefusedDiscretePatch {
  readonly input: IIDiscretePatchInput;
  readonly reason: string;
}

export type IIDiscretePatchResult =
  | {
      readonly ok: true;
      readonly image: AxeFxIIImageBuffer;
      readonly applied: readonly IIAppliedDiscretePatch[];
      readonly refused: readonly IIRefusedDiscretePatch[];
    }
  | { readonly ok: false; readonly reason: string; readonly refused?: readonly IIRefusedDiscretePatch[] };

function resolveParam(groupCode: string, paramName: string): AxeFxIIParam | undefined {
  const slug = SLUG_BY_GROUP.get(groupCode);
  if (slug === undefined) return undefined;
  const entry = (KNOWN_PARAMS as Record<string, AxeFxIIParam>)[`${slug}.${paramName}`];
  return entry;
}

/** Resolve a display label or ordinal against a roster. */
function resolveOrdinal(
  roster: Readonly<Record<number, string>>,
  value: string | number,
): { ok: true; ordinal: number; label: string } | { ok: false; reason: string } {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return { ok: false, reason: `ordinal ${value} is not an integer.` };
    const label = roster[value];
    if (label === undefined) return { ok: false, reason: `ordinal ${value} is not in the registered roster.` };
    return { ok: true, ordinal: value, label };
  }
  const wanted = value.trim().toLowerCase();
  const hits: Array<{ ordinal: number; label: string }> = [];
  for (const [k, label] of Object.entries(roster)) {
    if (label.trim().toLowerCase() === wanted) hits.push({ ordinal: Number(k), label });
  }
  if (hits.length === 1) return { ok: true, ...hits[0] };
  if (hits.length === 0) return { ok: false, reason: `label "${value}" is not in the registered roster.` };
  return { ok: false, reason: `label "${value}" is ambiguous in the roster (${hits.length} matches).` };
}

/**
 * Patch rostered-select param words in a COPY of the image. Per-patch
 * refusals are itemized; whole-op failure only when zero applied.
 * Reserved byte-2 bits are untouched (the image buffer carries them
 * per word; the frame layer re-encodes them verbatim).
 */
export function applyDiscreteSelectsToImage(
  source: AxeFxIIImageBuffer,
  patches: readonly IIDiscretePatchInput[],
): IIDiscretePatchResult {
  if (patches.length === 0) {
    return { ok: false, reason: 'applyDiscreteSelectsToImage: no patches given.' };
  }
  const tlv = parseIIImageTlv(source.words);
  const words = Uint16Array.from(source.words);
  const reserved = Uint8Array.from(source.reserved);
  const applied: IIAppliedDiscretePatch[] = [];
  const refused: IIRefusedDiscretePatch[] = [];

  for (const input of patches) {
    const block = findIIImageBlock(tlv, input.blockWireId);
    if (block === undefined) {
      refused.push({ input, reason: `wire_id ${input.blockWireId} is not placed in this preset's TLV chain.` });
      continue;
    }
    const group = block.block?.groupCode;
    if (group === undefined) {
      refused.push({ input, reason: `wire_id ${input.blockWireId} is not a registered block.` });
      continue;
    }
    const param = resolveParam(group, input.paramName);
    if (param === undefined) {
      refused.push({ input, reason: `family ${group} has no registered param "${input.paramName}".` });
      continue;
    }
    // Pid-identity refusal FIRST (defense in depth, Graft 1): the
    // family's bypass housekeeping pid is the 8-scene state word, and
    // this must refuse by NAME even if a select were ever registered
    // at that pid.
    const bypassPid = II_BYPASS_PID_BY_GROUP.get(group);
    if (bypassPid !== undefined && param.paramId === bypassPid) {
      refused.push({
        input,
        reason:
          `${param.block}.${param.name} shares paramId ${param.paramId} with the family's scene-state ` +
          `word (the <block>.bypass housekeeping pid). A discrete write there corrupts all 8 scenes' ` +
          `bypass + channel state; use the scene lane instead.`,
      });
      continue;
    }
    if (param.controlType === 'select' && /(^|_)tempo(_|$)|tempo$/i.test(param.name)) {
      refused.push({
        input,
        reason:
          `${param.block}.${param.name} is a dual-mode tempo select (stores raw ms when tempo sync is off; ` +
          `known catalog modeling gap). Excluded from discrete image patching until remodeled.`,
      });
      continue;
    }
    if (param.controlType !== 'select') {
      refused.push({
        input,
        reason:
          `${param.block}.${param.name} is controlType="${param.controlType}". The discrete image lane ` +
          `covers ROSTERED SELECTS only (knobs stay on the continuous lane; switches await their own census).`,
      });
      continue;
    }
    if (param.enumValues === undefined || Object.keys(param.enumValues).length === 0) {
      refused.push({
        input,
        reason:
          `${param.block}.${param.name} has no registered enumValues roster (e.g. the raw cab IR index). ` +
          `Ordinal-by-number would work mechanically but violates display-first; excluded until a roster lands.`,
      });
      continue;
    }
    if (input.channel === 'Y' && II_NEVER_Y_GROUPS.has(group)) {
      refused.push({
        input,
        reason:
          `family ${group}: the second payload half is NOT an X/Y param mirror (corpus-proven; ` +
          `Multi Delay "Y" is out-of-roster in 135/135 instances). Channel-Y patches refuse outright.`,
      });
      continue;
    }
    let wordIndex: number;
    try {
      wordIndex = imageParamWordIndex(block, param.paramId, input.channel);
    } catch (err) {
      refused.push({ input, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const before = words[wordIndex];
    const beforeInRoster = param.enumValues[before] !== undefined;
    if (input.channel === 'Y' && !II_CLEAN_Y_GROUPS.has(group)) {
      if (!beforeInRoster && !II_Y_SENTINELS.has(before)) {
        refused.push({
          input,
          reason:
            `family ${group} channel Y read-before-write gate: current word ${before} at image word ` +
            `${wordIndex} is neither in-roster nor a sentinel; this Y half looks stale/non-mirrored ` +
            `(the amp-Y hazard class). Refusing rather than overwriting unknown state.`,
        });
        continue;
      }
    }
    const resolved = resolveOrdinal(param.enumValues, input.value);
    if (!resolved.ok) {
      refused.push({ input, reason: `${param.block}.${param.name}: ${resolved.reason}` });
      continue;
    }
    words[wordIndex] = resolved.ordinal;
    const note =
      param.name === 'effect_type'
        ? 'type selector patched in-image: bypasses the live fn 0x02 dependent-param recompute; ' +
          'sonic equivalence with a live type switch is hardware-unverified.'
        : undefined;
    applied.push(
      note === undefined
        ? { input, wordIndex, beforeWire: before, afterWire: resolved.ordinal, label: resolved.label, beforeInRoster }
        : { input, wordIndex, beforeWire: before, afterWire: resolved.ordinal, label: resolved.label, beforeInRoster, note },
    );
  }

  if (applied.length === 0) {
    return { ok: false, reason: 'no discrete patches applied (all refused).', refused };
  }
  return { ok: true, image: { words, reserved }, applied, refused };
}
