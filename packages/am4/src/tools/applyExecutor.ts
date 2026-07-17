/**
 * AM4 apply-preset executor, hoisted from `apply.ts` so the BK-051 unified
 * tool surface (`src/protocol/generic/{dispatcher,tools}.ts`) can reuse the
 * same validate + wire-send + result-format pipeline without duplicating
 * 700+ LOC.
 *
 * The functions and types here are byte-identical to what previously lived
 * inside `registerApplyTools(server)` as nested locals; they're now at module
 * scope and exported so:
 *   - apply.ts (legacy `am4_apply_preset` / `_at` / `_setlist` tool bodies)
 *     imports them and registers the device-namespaced surface.
 *   - descriptor.ts (`AM4_DESCRIPTOR.writer.applyPreset` etc.) imports them
 *     so the unified `apply_preset` / `apply_setlist` tools dispatch
 *     through the same executor.
 *
 * The legacy device-namespaced am4_apply_* tools and the unified surface
 * therefore share one executor, same validation rules, same wire output,
 * same ack semantics. Adding a new validation rule lands in both surfaces
 * simultaneously.
 */

import {
    KNOWN_PARAMS,
    PARAM_ALIASES,
    type Param,
    type ParamKey,
} from 'fractal-midi/am4';
import {
    BLOCK_NAMES_BY_VALUE,
    BLOCK_TYPE_VALUES,
    resolveBlockType,
} from 'fractal-midi/am4';
import { formatLocationDisplay } from 'fractal-midi/am4';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';

import {
    STALE_HANDLE_TIMEOUT_THRESHOLD,
    WRITE_ECHO_TIMEOUT_MS,
    recordAckOutcome,
} from '@mcp-midi-control/core/server-shared/connections.js';
import { markClean, markDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';
import { lookupAmpLoudness } from '@mcp-midi-control/core/fractal-shared/loudness.js';
import { AM4_DIRTY_LABEL } from './safeEdit.js';
import {
    channelLetter,
    invalidateChannelCache,
    lastKnownChannel,
    lastKnownType,
    observeWrittenParam,
    preflightApplicabilityWarning,
    resolveChannel,
    CHANNEL_BLOCKS,
} from '../shared/channels.js';
import { checkApplicability } from 'fractal-midi/am4';
import { EnumAmbiguityError, resolveValue } from 'fractal-midi/am4';
import { formatUnknownParamError } from '@mcp-midi-control/core/protocol-generic/dispatcher/errorFormat.js';
import { sendAndAwaitAck } from '../shared/wireOps.js';
import {
    buildSaveToLocation,
    buildSetBlockBypass,
    buildSetBlockType,
    buildSetParam,
    buildSetPresetName,
    buildSetSceneName,
    buildSwitchPreset,
    buildSwitchScene,
    isCommandAck,
    isWriteEcho,
} from 'fractal-midi/am4';

// --- Apply-preset prepared-write types ---

export type ApplyPresetPreparedWrite =
    | { kind: 'place'; position: 1 | 2 | 3 | 4; blockName: string; bytes: number[] }
    | { kind: 'channel'; block: string; index: number; bytes: number[] }
    | { kind: 'param'; block: string; paramName: string; resolved: number; key: ParamKey; display: string; bytes: number[] }
    | { kind: 'am4_switch_scene'; sceneIndex: number; bytes: number[] }
    | { kind: 'scene_channel'; block: string; index: number; sceneIndex: number; bytes: number[] }
    | { kind: 'bypass'; block: string; bypassed: boolean; sceneIndex: number; bytes: number[] }
    | { kind: 'scene_name'; sceneIndex: number; name: string; bytes: number[] };

/**
 * A param-write the validator dropped because its applies_only_when
 * gate excludes the active (or in-batch) block type. The wire write
 * was NEVER sent, surfaced to the caller so its response can name
 * exactly what didn't land, instead of letting the agent claim a write
 * landed that the device silently no-op'd.
 *
 * Example: `{type: "Deluxe Verb Vibrato", mid: 6}`, the AB763 Vibrato
 * channel has Bass/Treble only, no Mid. The mid write would have been
 * acked by the device and produced no audible change; the gate skips
 * it and the response says "dropped amp.mid because Deluxe Verb
 * Vibrato has no Mid knob."
 */
export interface ApplyPresetSkippedParam {
    block: string;
    paramName: string;
    reason: string;
}

export interface ApplyPresetSlotInput {
    position: number;
    block_type: string;
    /**
     * Explicit target channel for a channel-capable block (amp / drive /
     * reverb / delay). When omitted and `params` (flat) is supplied, the
     * write defaults to channel A (BUG-4 fix) rather than whatever
     * channel the device happens to have active. Every scene that doesn't
     * explicitly map this block's channel (via `ApplyPresetSceneInput.channels`)
     * also defaults to A, so a fresh build lands audibly on channel A
     * without further configuration.
     */
    channel?: string | number;
    params?: Record<string, number | string>;
    channels?: Record<string, Record<string, number | string>>;
}

export interface ApplyPresetSceneInput {
    index: number;
    name?: string;
    channels?: Record<string, string>;
    bypass?: Record<string, boolean>;
}

export interface ApplyPresetInput {
    slots: ApplyPresetSlotInput[];
    name?: string;
    scenes?: ApplyPresetSceneInput[];
    /**
     * Scene 1..4 the AM4 lands on after the build. Defaults to 1 so the user
     * can play immediately on the song's first section. The final wire write
     * apply_preset emits is buildSwitchScene(landingScene - 1).
     */
    landingScene?: 1 | 2 | 3 | 4;
}

/**
 * Cab-polish defaults (BK-103b), injected server-side on fresh amp-bearing
 * builds. Close-mic'd IRs carry excess lows + highs; the validated
 * mix-ready starting point (cloudkake field report + Fractal's own
 * published practice, see the cab_polish agent-guidance topic) is a
 * low cut ~80 Hz / high cut ~6.5 kHz at 12 dB/oct plus a little cab room.
 *
 * These were guidance-only first and the 2026-07-16 bench test proved
 * guidance alone does not fire (the model built a fresh FRFR preset
 * wide open: 20 Hz / 20 kHz / 0% room). The executor now ENFORCES the
 * default: every amp channel a fresh build writes gets these params
 * appended, UNLESS the spec expresses any cab opinion of its own
 * (any trigger param below, on any channel) - explicit values always win.
 * The response reports exactly what was injected plus the undo phrase, so
 * the agent can relay it and one user phrase ("wide open") removes it.
 */
const CAB_POLISH_DEFAULTS: ReadonlyArray<readonly [name: string, value: number | string, display: string]> = [
    ['master_low_cut', 80, '80 Hz'],
    ['cab_master_high_cut', 6500, '6500 Hz'],  // assertive/mix-safe; Fractal's published start is 7500
    ['master_low_slope', '12 dB/OCT', '12 dB/OCT'],
    ['master_high_slope', '12 dB/OCT', '12 dB/OCT'],
    ['room_level', 8, '8%'],                   // validated band 5-10%
];

/**
 * Spec params (canonical amp.* names) that count as "the caller has cab
 * opinions": any of them anywhere on the amp slot suppresses injection
 * entirely. cab_section is included because cuts/room inside a bypassed
 * cab section are dead writes (the 4CM / real-cab case).
 */
const CAB_POLISH_TRIGGERS: ReadonlySet<string> = new Set([
    ...CAB_POLISH_DEFAULTS.map(([n]) => n),
    'cab_section',
]);

/** What the executor injected, for response reporting (undefined = nothing). */
export interface ApplyPresetCabPolish {
    /** Amp channels (letters) that received the defaults. */
    channels: string[];
    /** Display-shaped values injected, keyed by param name. */
    params: Record<string, string>;
    /** Relay-ready note incl. the undo phrase. */
    note: string;
}

/**
 * Scene-level initialization report (BK-103b sibling). Every apply_preset
 * is a FRESH BUILD (unlisted slots/scenes are cleared), but
 * preset.scene_N_level trims persist in the working buffer from whatever
 * preset occupied it before - the 2026-07-16 leveling bench left Y4 with
 * trims 0.3/0/-2.9/-3.1 that would silently shape the NEXT fresh build
 * there. So the executor always initializes scene levels 1-4:
 *   - `amp_offsets`: when every scene's amp channel has an in-spec type
 *     with a known per-amp loudness offset (the lineage corpus), scenes
 *     get STARTING trims toward the loudest scene (data-driven, labeled
 *     unverified; measure_loudness closes the loop).
 *   - `reset`: otherwise, all four to 0 dB (kills stale-trim leakage).
 */
export interface ApplyPresetSceneLevels {
    /** Display-shaped values written, keyed by param name. */
    values: Record<string, string>;
    source: 'reset' | 'amp_offsets';
    /** Relay-ready note. */
    note: string;
}

/**
 * Merge the executor's injections into the generic `ApplyResult.auto_applied`
 * shape. Returns undefined when nothing was injected.
 */
export function mergeAutoApplied(
    cabPolish: ApplyPresetCabPolish | undefined,
    sceneLevels: ApplyPresetSceneLevels | undefined,
): { params: Record<string, string>; channels?: readonly string[]; note: string } | undefined {
    if (cabPolish === undefined && sceneLevels === undefined) return undefined;
    return {
        params: { ...(cabPolish?.params ?? {}), ...(sceneLevels?.values ?? {}) },
        ...(cabPolish === undefined ? {} : { channels: cabPolish.channels }),
        note: [cabPolish?.note, sceneLevels?.note].filter((s) => s !== undefined).join(' '),
    };
}

/**
 * Validate an apply-preset input and produce the ordered list of wire
 * writes that realise it on the AM4 (block placements, channel switches,
 * param writes, scene switches, scene channel pointers, bypass writes,
 * scene renames). Throws a path-prefixed Error on any validation failure
 * before any wire bytes leave the host. The optional working-buffer
 * rename comes back separately because it uses a distinct ack shape
 * (18-byte command-ack vs 64-byte write-echo).
 */
export function prepareApplyPresetWrites(
    input: ApplyPresetInput,
): {
    prepared: ApplyPresetPreparedWrite[];
    nameWriteBytes: number[] | undefined;
    skipped: ApplyPresetSkippedParam[];
    cabPolish: ApplyPresetCabPolish | undefined;
    sceneLevels: ApplyPresetSceneLevels;
} {
    const { slots, name, scenes, landingScene } = input;
    // --- Validation pass (no MIDI yet) ---
    const seenPositions = new Set<number>();
    const prepared: ApplyPresetPreparedWrite[] = [];
    const skipped: ApplyPresetSkippedParam[] = [];
    // Track placed (non-"none") blocks so the scene-bypass-default pass can
    // emit implicit `bypass=false` writes for blocks the agent placed but
    // didn't explicitly bypass in a configured scene. Founder-driven
    // (Session 44 Sultans test): when apply_preset configured scenes 1 & 2
    // with channels-only, the AM4 retained scene 1's bypass state from the
    // previously-loaded U1 preset (comp + delay bypassed), silently
    // breaking the rhythm tone. Placing a block in a fresh-preset call
    // implies the user wants it ACTIVE in the configured scenes, defaulting
    // to active matches that intent and avoids stale-state leakage.
    const placedBlocks = new Map<string, number>();

    // In-batch type-gating context: when the same apply_preset call
    // contains `params.type` AND knob writes, the agent's intent is the
    // post-change type. Track resolved type writes per block as we
    // prepare them; refuse subsequent knob writes whose applicability
    // gate excludes that type. Catches the 2026-05-13 Z4 Fender test
    // case: `params: { type: "Deluxe Verb Vibrato", mid: 6 }`, the AB763
    // Vibrato channel has no Mid knob, AM4 silently no-ops the write.
    // Without this gate the agent sees a successful ack and reports the
    // mid value to the user; the device shows the previous mid.
    const inBatchTypes: Record<string, number> = {};

    /**
     * Build a single param write, OR return `null` when the validator
     * decides to skip the write (because the param doesn't apply on
     * the active block type, see applicability gate below). Hard
     * errors (unknown param name, out-of-range value) still throw,
     * those are caller mistakes, not silent-no-op risks.
     *
     * On skip, the reason is pushed to the shared `skipped` list and
     * surfaced in the apply_preset response so the agent reports
     * "dropped amp.mid because Deluxe Verb Vibrato has no Mid knob"
     * instead of claiming the write landed.
     */
    const buildParamWrite = (
        at: string,
        canonicalBlock: string,
        paramName: string,
        value: number | string,
    ): Extract<ApplyPresetPreparedWrite, { kind: 'param' }> | null => {
        const literalKey = `${canonicalBlock}.${paramName}` as ParamKey;
        let key: ParamKey;
        if (literalKey in KNOWN_PARAMS) {
            key = literalKey;
        } else if (PARAM_ALIASES[literalKey] !== undefined && PARAM_ALIASES[literalKey] in KNOWN_PARAMS) {
            key = PARAM_ALIASES[literalKey] as ParamKey;
        } else {
            // Surface the AM4-style canonical "unknown param" message via
            // the shared formatter so II / III / Hydra produce the same
            // shape. The bare names (without the "block." prefix) match
            // what the agent passes as `paramName`, and the formatter
            // ranks them by closeness so the closest candidates lead.
            const sameBlockKeys = Object.keys(KNOWN_PARAMS).filter((k) => k.startsWith(`${canonicalBlock}.`));
            const knownNames = sameBlockKeys.map((k) => k.slice(canonicalBlock.length + 1));
            throw new Error(
                formatUnknownParamError({
                    slotContext: at,
                    deviceName: 'Fractal AM4',
                    block: canonicalBlock,
                    badParam: paramName,
                    knownNames,
                }),
            );
        }
        const param: Param = KNOWN_PARAMS[key];
        let resolved: number;
        try {
            resolved = resolveValue(param, value);
        } catch (err) {
            if (err instanceof EnumAmbiguityError) {
                // Preserve structured candidates through the slot-context
                // prefix so asError can populate valid_options downstream.
                throw new EnumAmbiguityError(err.value, err.candidates, `${at}: `);
            }
            throw new Error(`${at}: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Applicability gate. Skip for the type write itself (the type
        // can never be gated against itself); enforce for every other
        // param against the in-batch type (preferred, known to be
        // accurate, since type writes are ordered first in this loop)
        // or the cross-call lastKnownType cache when no in-batch type
        // is set.
        //
        // Soft behavior: drop the param, record the skip, let the rest
        // of the apply continue. The skip list surfaces in the response
        // so the agent can honestly report what didn't land instead of
        // pretending the silent no-op was a successful write.
        if (paramName !== 'type' && paramName !== 'mode') {
            const effectiveTypes: Record<string, number> = {
                ...lastKnownType,
                ...inBatchTypes,
            };
            const check = checkApplicability(`${canonicalBlock}.${paramName}`, {
                currentTypes: effectiveTypes,
            });
            if (check.applicable === false) {
                const activeWire = effectiveTypes[canonicalBlock];
                skipped.push({
                    block: canonicalBlock,
                    paramName,
                    reason:
                        `Does not apply on ${canonicalBlock}.type wire ${activeWire} ` +
                        `(real-gear parity, the active type does not expose this knob; ` +
                        `the AM4 silently no-ops writes to it). Call ` +
                        `list_params(${canonicalBlock}) to see which knobs the active type ` +
                        `exposes.`,
                });
                return null;
            }
        }
        // Record type writes for downstream applicability checks in the
        // same batch. Resolved value is the post-encode wire enum index.
        if (paramName === 'type' || paramName === 'mode') {
            inBatchTypes[canonicalBlock] = Math.round(resolved);
        }
        const enumNameFor = (idx: number): string | undefined =>
            (param.enumValues as Record<number, string> | undefined)?.[idx];
        const display = param.unit === 'enum'
            ? `${resolved} (${enumNameFor(resolved) ?? '?'})`
            : String(resolved);
        return {
            kind: 'param',
            block: canonicalBlock,
            paramName,
            resolved,
            key,
            display,
            bytes: buildSetParam(key, resolved),
        };
    };

    // --- Cab-polish injection state (BK-103b) ---
    const cabPolishChannels: string[] = [];

    /** Canonicalize an amp param name through the alias table (so an alias spelling still counts as a cab opinion). */
    const canonicalAmpName = (paramName: string): string => {
        const literalKey = `amp.${paramName}`;
        if (literalKey in KNOWN_PARAMS) return paramName;
        const alias = PARAM_ALIASES[literalKey];
        return alias !== undefined ? alias.slice(alias.indexOf('.') + 1) : paramName;
    };

    /** Any cab-polish trigger param anywhere on this amp slot = caller has cab opinions, inject nothing. */
    const slotHasCabOpinion = (slot: ApplyPresetSlotInput): boolean => {
        const names: string[] = [];
        if (slot.params !== undefined) names.push(...Object.keys(slot.params));
        if (slot.channels !== undefined) {
            for (const channelParams of Object.values(slot.channels)) {
                names.push(...Object.keys(channelParams));
            }
        }
        return names.some((n) => CAB_POLISH_TRIGGERS.has(canonicalAmpName(n)));
    };

    /** Append the cab-polish default writes into the CURRENT channel window and record the letter. */
    const pushCabPolish = (at: string, letter: string): void => {
        for (const [paramName, value] of CAB_POLISH_DEFAULTS) {
            const write = buildParamWrite(`${at} cab-polish default`, 'amp', paramName, value);
            if (write !== null) prepared.push(write);
        }
        cabPolishChannels.push(letter);
    };

    // Amp type per written channel letter, for the scene-level starting-trim
    // computation (per-amp loudness offsets are keyed by enum label).
    const ampTypeLabelByLetter: Record<string, string> = {};
    const ampTypeLabel = (wireIdx: number): string | undefined =>
        ((KNOWN_PARAMS['amp.type' as ParamKey] as Param).enumValues as Record<number, string> | undefined)?.[
            wireIdx
        ];

    slots.forEach((slot, i) => {
        const at = `slots[${i}] (position ${slot.position}, ${slot.block_type})`;
        if (seenPositions.has(slot.position)) {
            throw new Error(`${at}: position ${slot.position} used twice, each slot may appear at most once per call`);
        }
        seenPositions.add(slot.position);

        const blockTypeValue = resolveBlockType(slot.block_type);
        if (blockTypeValue === undefined) {
            const known = Object.keys(BLOCK_TYPE_VALUES).join(', ');
            throw new Error(`${at}: unknown block_type "${slot.block_type}". Known: ${known}`);
        }
        const canonicalBlock = BLOCK_NAMES_BY_VALUE[blockTypeValue] ?? slot.block_type;
        const pos = slot.position as 1 | 2 | 3 | 4;
        prepared.push({
            kind: 'place',
            position: pos,
            blockName: canonicalBlock,
            bytes: buildSetBlockType(pos, blockTypeValue),
        });
        if (canonicalBlock !== 'none') {
            placedBlocks.set(canonicalBlock, blockTypeValue);
        }

        // BK-103b: a fresh amp-bearing build gets the mix-ready cab
        // defaults on every channel it writes, unless the spec expresses
        // ANY cab opinion of its own (explicit values always win).
        const injectCabPolish = canonicalBlock === 'amp' && !slotHasCabOpinion(slot);
        let cabPolishInjected = false;

        if (slot.channels !== undefined) {
            if (slot.channel !== undefined) {
                throw new Error(`${at}: 'channels' (per-channel params) and 'channel' (single-channel shortcut) are mutually exclusive. Use one or the other.`);
            }
            if (slot.params !== undefined) {
                throw new Error(`${at}: 'channels' (per-channel params) and 'params' (current-channel params) are mutually exclusive. Move params into channels.<A|B|C|D>.<name> or drop channels.`);
            }
        }

        if (slot.channel !== undefined) {
            if (canonicalBlock === 'none') {
                throw new Error(`${at}: channel supplied but block_type is "none" (empty slot). Remove channel.`);
            }
            if (!CHANNEL_BLOCKS.has(canonicalBlock)) {
                throw new Error(`${at}: block "${canonicalBlock}" doesn't have channels. Drop the channel argument (only amp / drive / reverb / delay expose A/B/C/D).`);
            }
            let channelIdx: number;
            try {
                channelIdx = resolveChannel(slot.channel);
            } catch (err) {
                throw new Error(`${at}: ${err instanceof Error ? err.message : String(err)}`);
            }
            const channelKey = `${canonicalBlock}.channel` as ParamKey;
            prepared.push({
                kind: 'channel',
                block: canonicalBlock,
                index: channelIdx,
                bytes: buildSetParam(channelKey, channelIdx),
            });
        }

        if (slot.params && Object.keys(slot.params).length > 0) {
            if (canonicalBlock === 'none') {
                throw new Error(`${at}: params supplied but block_type is "none" (empty slot). Remove params or pick a real block type.`);
            }
            // BUG-4 fix: flat params with no explicit `channel` must land
            // somewhere deterministic, not whatever channel the device
            // happens to have active when this call runs (which could be
            // whatever the previous preset/scene left selected). Default
            // to channel A; the scene-channel completion pass below
            // defaults every placed channel-block to A on any scene that
            // doesn't explicitly point it elsewhere, so a fresh build's
            // params are audible on the (also-A-by-default) landing scene
            // without the caller doing anything special. Explicit `channel`
            // (handled above) or `channels` (handled below) overrides this.
            if (slot.channel === undefined && slot.channels === undefined && CHANNEL_BLOCKS.has(canonicalBlock)) {
                const channelKey = `${canonicalBlock}.channel` as ParamKey;
                prepared.push({
                    kind: 'channel',
                    block: canonicalBlock,
                    index: 0,
                    bytes: buildSetParam(channelKey, 0),
                });
            }
            const flatLetter = slot.channel !== undefined
                ? (['A', 'B', 'C', 'D'][resolveChannel(slot.channel)] ?? 'A')
                : 'A';
            const ordered = Object.entries(slot.params).sort(([a], [b]) =>
                a === 'type' ? -1 : b === 'type' ? 1 : 0,
            );
            for (const [paramName, value] of ordered) {
                const write = buildParamWrite(at, canonicalBlock, paramName, value);
                if (write !== null) prepared.push(write);
                // null = applicability gate dropped the param; the
                // skip is already in `skipped[]`. The remaining writes
                // in this slot still go through.
                if (write !== null && canonicalBlock === 'amp' && paramName === 'type') {
                    const label = ampTypeLabel(write.resolved);
                    if (label !== undefined) ampTypeLabelByLetter[flatLetter] = label;
                }
            }
            if (injectCabPolish) {
                // After the ordered params (type sorts first), still inside
                // this channel's write window - the amp.type reset trap is
                // why order matters here.
                pushCabPolish(at, flatLetter);
                cabPolishInjected = true;
            }
        }

        if (slot.channels !== undefined) {
            if (canonicalBlock === 'none') {
                throw new Error(`${at}: channels supplied but block_type is "none" (empty slot). Remove channels.`);
            }
            if (!CHANNEL_BLOCKS.has(canonicalBlock)) {
                throw new Error(`${at}: block "${canonicalBlock}" doesn't have channels. Drop the channels field (only amp / drive / reverb / delay expose A/B/C/D).`);
            }
            const channelEntries = new Map<'A' | 'B' | 'C' | 'D', Record<string, number | string>>();
            for (const [rawKey, params] of Object.entries(slot.channels)) {
                const letter = rawKey.trim().toUpperCase();
                if (letter !== 'A' && letter !== 'B' && letter !== 'C' && letter !== 'D') {
                    throw new Error(`${at} channels.${rawKey}: must be one of A/B/C/D (case-insensitive), got "${rawKey}".`);
                }
                if (channelEntries.has(letter)) {
                    throw new Error(`${at} channels.${letter}: duplicated (keys are case-insensitive, so A and a collide).`);
                }
                channelEntries.set(letter, params);
            }
            for (const letter of ['A', 'B', 'C', 'D'] as const) {
                const channelParams = channelEntries.get(letter);
                if (channelParams === undefined) continue;
                if (Object.keys(channelParams).length === 0) continue;
                const channelIdx = ['A', 'B', 'C', 'D'].indexOf(letter);
                const channelKey = `${canonicalBlock}.channel` as ParamKey;
                prepared.push({
                    kind: 'channel',
                    block: canonicalBlock,
                    index: channelIdx,
                    bytes: buildSetParam(channelKey, channelIdx),
                });
                const orderedChannelEntries = Object.entries(channelParams).sort(([a], [b]) =>
                    a === 'type' ? -1 : b === 'type' ? 1 : 0,
                );
                for (const [paramName, value] of orderedChannelEntries) {
                    // Channel LED color is per-preset metadata keyed by the
                    // channel LETTER (amp.channel_a_color..channel_d_color), not
                    // a channel-register value, so it has no `amp.color` param.
                    // Accept `color` (or `led_color`) inside a channel map and
                    // route it to the letter-specific color param, so a full
                    // preset including footswitch colors applies in ONE call
                    // instead of a trailing set_params. Amp-only.
                    let effName = paramName;
                    if (paramName === 'color' || paramName === 'led_color' || paramName === 'channel_color') {
                        if (canonicalBlock !== 'amp') {
                            throw new Error(
                                `${at} channels.${letter}.${paramName}: channel LED color exists only on the amp block. Drop it from ${canonicalBlock}.`,
                            );
                        }
                        effName = `channel_${letter.toLowerCase()}_color`;
                    }
                    const write = buildParamWrite(
                        `${at} channels.${letter}.${paramName}`,
                        canonicalBlock,
                        effName,
                        value,
                    );
                    if (write !== null) prepared.push(write);
                    // null = applicability skip; reason already in `skipped[]`.
                    if (write !== null && canonicalBlock === 'amp' && effName === 'type') {
                        const label = ampTypeLabel(write.resolved);
                        if (label !== undefined) ampTypeLabelByLetter[letter] = label;
                    }
                }
                if (injectCabPolish) {
                    // Still inside this letter's channel window (after its
                    // type write, before the next channel switch).
                    pushCabPolish(`${at} channels.${letter}`, letter);
                    cabPolishInjected = true;
                }
            }
        }

        // BK-103b bare-amp case: the amp was placed with no params at all
        // (or an empty params object). Pin channel A deterministically
        // (same BUG-4 rationale as the flat-params default) and inject
        // there, unless an explicit `channel` already opened a window.
        if (injectCabPolish && !cabPolishInjected && slot.channels === undefined) {
            let letter = 'A';
            if (slot.channel === undefined) {
                prepared.push({
                    kind: 'channel',
                    block: canonicalBlock,
                    index: 0,
                    bytes: buildSetParam(`${canonicalBlock}.channel` as ParamKey, 0),
                });
            } else {
                letter = ['A', 'B', 'C', 'D'][resolveChannel(slot.channel)] ?? 'A';
            }
            pushCabPolish(at, letter);
        }
    });

    // FRESH-BUILD CLEARING - unlisted slots (Session 52, Mortal Kombat G03 fix):
    for (const position of [1, 2, 3, 4] as const) {
        if (seenPositions.has(position)) continue;
        prepared.push({
            kind: 'place',
            position,
            blockName: 'none',
            bytes: buildSetBlockType(position, BLOCK_TYPE_VALUES.none),
        });
    }

    type PreparedScene = {
        sceneIndex: number;
        oneBased: number;
        channels: Array<{ block: string; letter: 'A' | 'B' | 'C' | 'D'; index: number }>;
        bypass: Array<{ block: string; blockValue: number; bypassed: boolean }>;
        name?: string;
    };
    const preparedScenes: PreparedScene[] = [];
    const seenSceneIndices = new Set<number>();
    const userListedScenes = new Set<number>();
    if (scenes !== undefined) {
        scenes.forEach((sc, i) => {
            const at = `scenes[${i}] (scene ${sc.index})`;
            if (seenSceneIndices.has(sc.index)) {
                throw new Error(`${at}: scene index ${sc.index} used twice, each scene may appear at most once per call`);
            }
            seenSceneIndices.add(sc.index);

            const hasAny =
                sc.name !== undefined
                || (sc.channels !== undefined && Object.keys(sc.channels).length > 0)
                || (sc.bypass !== undefined && Object.keys(sc.bypass).length > 0);
            if (!hasAny) {
                throw new Error(`${at}: supply at least one of channels / bypass / name, an empty scene entry is a no-op.`);
            }

            const chList: PreparedScene['channels'] = [];
            if (sc.channels !== undefined) {
                for (const [rawBlock, rawLetter] of Object.entries(sc.channels)) {
                    const blockValue = resolveBlockType(rawBlock);
                    if (blockValue === undefined) {
                        const known = Object.keys(BLOCK_TYPE_VALUES).filter((n) => n !== 'none').join(', ');
                        throw new Error(`${at} channels.${rawBlock}: unknown block "${rawBlock}". Known: ${known}`);
                    }
                    const canonicalBlock = BLOCK_NAMES_BY_VALUE[blockValue] ?? rawBlock;
                    if (canonicalBlock === 'none') {
                        throw new Error(`${at} channels.${rawBlock}: "none" has no channel register. Remove the entry.`);
                    }
                    if (!CHANNEL_BLOCKS.has(canonicalBlock)) {
                        throw new Error(`${at} channels.${canonicalBlock}: block "${canonicalBlock}" doesn't have channels (only amp / drive / reverb / delay expose A/B/C/D).`);
                    }
                    if (typeof rawLetter !== 'string') {
                        throw new Error(`${at} channels.${canonicalBlock}: expected channel letter A/B/C/D, got ${JSON.stringify(rawLetter)}`);
                    }
                    const letter = rawLetter.trim().toUpperCase();
                    if (letter !== 'A' && letter !== 'B' && letter !== 'C' && letter !== 'D') {
                        throw new Error(`${at} channels.${canonicalBlock}: must be one of A/B/C/D, got "${rawLetter}"`);
                    }
                    chList.push({
                        block: canonicalBlock,
                        letter: letter as 'A' | 'B' | 'C' | 'D',
                        index: ['A', 'B', 'C', 'D'].indexOf(letter),
                    });
                }
            }

            const byList: PreparedScene['bypass'] = [];
            if (sc.bypass !== undefined) {
                for (const [rawBlock, rawVal] of Object.entries(sc.bypass)) {
                    const blockValue = resolveBlockType(rawBlock);
                    if (blockValue === undefined) {
                        const known = Object.keys(BLOCK_TYPE_VALUES).filter((n) => n !== 'none').join(', ');
                        throw new Error(`${at} bypass.${rawBlock}: unknown block "${rawBlock}". Known: ${known}`);
                    }
                    const canonicalBlock = BLOCK_NAMES_BY_VALUE[blockValue] ?? rawBlock;
                    if (canonicalBlock === 'none') {
                        throw new Error(`${at} bypass.${rawBlock}: "none" has no bypass state. Remove the entry.`);
                    }
                    if (typeof rawVal !== 'boolean') {
                        throw new Error(`${at} bypass.${canonicalBlock}: expected boolean (true = bypass, false = active), got ${JSON.stringify(rawVal)}`);
                    }
                    byList.push({ block: canonicalBlock, blockValue, bypassed: rawVal });
                }
            }

            if (sc.name !== undefined) {
                try {
                    buildSetSceneName(sc.index - 1, sc.name);
                } catch (err) {
                    throw new Error(`${at} name: ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            preparedScenes.push({
                sceneIndex: sc.index - 1,
                oneBased: sc.index,
                channels: chList,
                bypass: byList,
                name: sc.name,
            });
            userListedScenes.add(sc.index);
        });
    }

    // FRESH-BUILD CLEARING - unlisted scenes (Session 52, Stranglehold H03 fix):
    for (const sceneNum of [1, 2, 3, 4] as const) {
        if (userListedScenes.has(sceneNum)) continue;
        preparedScenes.push({
            sceneIndex: sceneNum - 1,
            oneBased: sceneNum,
            channels: [],
            bypass: [],
            name: '',
        });
    }
    preparedScenes.sort((a, b) => a.sceneIndex - b.sceneIndex);

    // --- Scene-level initialization (BK-103b sibling; see ApplyPresetSceneLevels) ---
    // Every apply is a fresh build, but preset.scene_N_level trims persist
    // in the working buffer from the previous occupant; initialize all 4.
    // When every scene's amp channel has an in-spec type with a known
    // loudness offset, seed data-driven starting trims toward the loudest
    // scene instead of flat zeros.
    let sceneLevelValues: readonly number[] = [0, 0, 0, 0];
    let sceneLevelSource: ApplyPresetSceneLevels['source'] = 'reset';
    if (placedBlocks.has('amp')) {
        const sceneAmpLetter = (oneBased: number): string => {
            const ps = preparedScenes.find((p) => p.oneBased === oneBased);
            const ampCh = ps?.channels.find((c) => c.block === 'amp');
            // Scenes without an explicit amp mapping default to channel A
            // (the BUG-4 completion pass writes exactly that).
            return ampCh !== undefined ? ampCh.letter : 'A';
        };
        const offsets: number[] = [];
        for (const n of [1, 2, 3, 4]) {
            const label = ampTypeLabelByLetter[sceneAmpLetter(n)];
            if (label === undefined) break; // channel type is device state, not in-spec
            const entry = lookupAmpLoudness(label);
            if (entry === undefined) break; // no corpus offset for this model
            offsets.push(entry.relative_loudness_dB);
        }
        if (offsets.length === 4) {
            const maxOff = Math.max(...offsets);
            // Positive-only lift toward the loudest scene, conservatively
            // clamped: a STARTING point, not a landing (measure_loudness
            // is the verification loop).
            const trims = offsets.map((o) => Math.round(Math.min(Math.max(maxOff - o, 0), 12) * 10) / 10);
            if (trims.some((t) => t !== 0)) {
                sceneLevelValues = trims;
                sceneLevelSource = 'amp_offsets';
            }
        }
    }
    for (const n of [1, 2, 3, 4] as const) {
        const write = buildParamWrite(
            `scene levels (fresh-build init, scene ${n})`,
            'preset',
            `scene_${n}_level`,
            sceneLevelValues[n - 1],
        );
        if (write !== null) prepared.push(write);
    }
    const sceneLevels: ApplyPresetSceneLevels = {
        values: Object.fromEntries(
            sceneLevelValues.map((v, i) => [`scene_${i + 1}_level`, `${v.toFixed(1)} dB`]),
        ),
        source: sceneLevelSource,
        note: sceneLevelSource === 'reset'
            ? 'THE SERVER initialized scene levels 1-4 to 0 dB as part of this apply ' +
              '(a fresh build resets stale per-scene trims left by whatever preset ' +
              'previously occupied the buffer); any values read back are from THIS ' +
              'build, not leftovers. To balance scenes: measure each with ' +
              'measure_loudness while the player repeats the same passage, then trim ' +
              'preset.scene_N_level.'
            : 'THE SERVER seeded scene levels 1-4 as part of this apply, with STARTING ' +
              'trims from the per-amp loudness offset table (loudest scene = ' +
              'reference); any values read back are from THIS build, not leftovers. ' +
              'They are data-driven but UNVERIFIED: confirm with measure_loudness per ' +
              'scene and adjust. TELL THE USER; to zero them, set ' +
              'preset.scene_N_level to 0.',
    };

    if (preparedScenes.length > 0) {
        for (const ps of preparedScenes) {
            prepared.push({
                kind: 'am4_switch_scene',
                sceneIndex: ps.sceneIndex,
                bytes: buildSwitchScene(ps.sceneIndex),
            });
            const explicitlyMappedChannelBlocks = new Set<string>();
            for (const ch of ps.channels) {
                explicitlyMappedChannelBlocks.add(ch.block);
                const channelKey = `${ch.block}.channel` as ParamKey;
                prepared.push({
                    kind: 'scene_channel',
                    block: ch.block,
                    index: ch.index,
                    sceneIndex: ps.sceneIndex,
                    bytes: buildSetParam(channelKey, ch.index),
                });
            }
            // BUG-4 completeness: any placed channel-block this scene
            // doesn't explicitly map defaults to channel A, deterministic
            // regardless of whatever channel the device inherited from the
            // previous preset/scene. Mirrors the bypass-completeness pass
            // below (placedBlocks not explicitly bypassed default to
            // active=false=engaged) so channel state is just as complete
            // as bypass state for every scene, listed or unlisted.
            for (const [block] of placedBlocks) {
                if (!CHANNEL_BLOCKS.has(block)) continue;
                if (explicitlyMappedChannelBlocks.has(block)) continue;
                const channelKey = `${block}.channel` as ParamKey;
                prepared.push({
                    kind: 'scene_channel',
                    block,
                    index: 0,
                    sceneIndex: ps.sceneIndex,
                    bytes: buildSetParam(channelKey, 0),
                });
            }
            const explicitlyBypassedBlocks = new Set<string>();
            for (const by of ps.bypass) {
                explicitlyBypassedBlocks.add(by.block);
                prepared.push({
                    kind: 'bypass',
                    block: by.block,
                    bypassed: by.bypassed,
                    sceneIndex: ps.sceneIndex,
                    bytes: buildSetBlockBypass(by.blockValue, by.bypassed),
                });
            }
            for (const [block, blockValue] of placedBlocks) {
                if (explicitlyBypassedBlocks.has(block)) continue;
                prepared.push({
                    kind: 'bypass',
                    block,
                    bypassed: false,
                    sceneIndex: ps.sceneIndex,
                    bytes: buildSetBlockBypass(blockValue, false),
                });
            }
            if (ps.name !== undefined) {
                prepared.push({
                    kind: 'scene_name',
                    sceneIndex: ps.sceneIndex,
                    name: ps.name,
                    bytes: buildSetSceneName(ps.sceneIndex, ps.name),
                });
            }
        }

        // FRESH-BUILD LANDING SCENE (Session 52 fix):
        const landingSceneIndex = ((landingScene ?? 1) - 1) as 0 | 1 | 2 | 3;
        prepared.push({
            kind: 'am4_switch_scene',
            sceneIndex: landingSceneIndex,
            bytes: buildSwitchScene(landingSceneIndex),
        });
    }

    let nameWriteBytes: number[] | undefined;
    if (name !== undefined) {
        try {
            nameWriteBytes = buildSetPresetName(0, name);
        } catch (err) {
            throw new Error(`name: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    const cabPolish: ApplyPresetCabPolish | undefined = cabPolishChannels.length === 0
        ? undefined
        : {
            channels: cabPolishChannels,
            params: Object.fromEntries(CAB_POLISH_DEFAULTS.map(([n, , display]) => [n, display])),
            note:
                'THE SERVER auto-applied mix-ready cab defaults to the amp as part of ' +
                'this apply (low cut 80 Hz, high cut 6.5 kHz, 12 dB/OCT slopes, 8% room) ' +
                'because the spec set no cab params; any values read back are from THIS ' +
                'build, not leftovers. TELL THE USER and give the undo: on "wide open" ' +
                '(or similar) set master_low_cut 20, cab_master_high_cut 20000, room_level 0. ' +
                'To build without them, pass any explicit cab value in the spec.',
        };
    return { prepared, nameWriteBytes, skipped, cabPolish, sceneLevels };
}

/**
 * Writes that ack with the 18-byte command-ack shape (rename family) vs
 * the 64-byte write-echo shape (SET_PARAM / placement / scene-switch /
 * bypass). Used by the send loop to pick the right predicate.
 */
export const APPLY_PRESET_COMMAND_ACK_KINDS = new Set<ApplyPresetPreparedWrite['kind']>(['scene_name']);

/**
 * Hard ceiling on total wall-clock for one apply-preset wire burst. When the
 * AM4 goes silent mid-burst, each write waits the full WRITE_ECHO_TIMEOUT_MS
 * (300 ms); ~80 silent writes would otherwise grind ~25-30 s per pass and,
 * with client retries, present as a multi-minute hang (the v0.1.0 incident).
 * The loop checks this budget before each write and aborts with a structured
 * partial result rather than walking every remaining write. Overridable via
 * MCP_APPLY_BUDGET_MS (tests set a tiny value). Default 50 s sits well above a
 * legitimately slow-but-alive device (80 × ~285 ms ≈ 23 s + overhead) and far
 * below the catastrophe.
 */
const APPLY_BUDGET_MS = (() => {
    const env = Number(process.env.MCP_APPLY_BUDGET_MS);
    return Number.isFinite(env) && env > 0 ? env : 50_000;
})();

export interface ApplyPresetWireResult {
    lines: string[];
    acked: number;
    unacked: number;
    totalWrites: number;
    /** Final scene index reported in user-facing summary (0..3); undefined when no scene was touched. */
    lastActiveScene: number | undefined;
    /** True when the burst aborted because APPLY_BUDGET_MS elapsed (device went silent mid-burst). */
    budgetExceeded: boolean;
}

/**
 * Run the wire-send pass for a prepared apply-preset payload. Sends every
 * write in `prepared` (placements, channel switches, params, scene
 * configuration) followed by the optional working-buffer rename. Updates
 * the channel cache and the stale-handle counter as side effects.
 *
 * Caller is responsible for the inbound-MIDI capture lifecycle (subscribe
 * before the call, unsubscribe in a finally), this lets the setlist tool
 * span a capture across multiple apply-preset+save cycles for one entry.
 */
export async function runApplyPresetWires(
    conn: MidiConnection,
    prepared: ApplyPresetPreparedWrite[],
    nameWriteBytes: number[] | undefined,
    workingBufferName: string | undefined,
): Promise<ApplyPresetWireResult> {
    const lines: string[] = [];
    let acked = 0;
    let unacked = 0;
    let lastActiveScene: number | undefined;
    let totalWrites = prepared.length;
    let budgetExceeded = false;
    const startMs = Date.now();
    let sent = 0;

    for (const w of prepared) {
        // Total-operation budget (FIX B): if the device went silent and the
        // per-write ack-waits piled up past the ceiling, stop walking the
        // remaining writes and return a partial result. Without this, ~80
        // silent writes grind ~25-30 s and present as a multi-minute hang.
        if (Date.now() - startMs > APPLY_BUDGET_MS) {
            budgetExceeded = true;
            const remaining = prepared.length - sent;
            const elapsed = Date.now() - startMs;
            lines.push(`  ⚠ apply budget (${APPLY_BUDGET_MS} ms) exceeded after ${elapsed} ms; ${remaining} write(s) not sent — device went silent.`);
            console.error(`apply_preset ABORTED: budget ${APPLY_BUDGET_MS} ms exceeded after ${sent}/${prepared.length} writes (acked=${acked} unacked=${unacked}), elapsed=${elapsed} ms`);
            break;
        }
        sent++;
        const predicate = APPLY_PRESET_COMMAND_ACK_KINDS.has(w.kind) ? isCommandAck : isWriteEcho;
        const echoPromise = conn.receiveSysExMatching(
            (resp) => predicate(w.bytes, resp),
            WRITE_ECHO_TIMEOUT_MS,
        );
        conn.send(w.bytes);
        let label: string;
        if (w.kind === 'place') label = `place slot ${w.position} → ${w.blockName}`;
        else if (w.kind === 'channel') label = `switch ${w.block} to channel ${channelLetter(w.index)}`;
        else if (w.kind === 'am4_switch_scene') label = `switch to scene ${w.sceneIndex + 1}`;
        else if (w.kind === 'scene_channel') label = `scene ${w.sceneIndex + 1}: point ${w.block} at channel ${channelLetter(w.index)}`;
        else if (w.kind === 'bypass') label = `scene ${w.sceneIndex + 1}: ${w.block} → ${w.bypassed ? 'bypassed' : 'active'}`;
        else if (w.kind === 'scene_name') label = `scene ${w.sceneIndex + 1} rename → "${w.name}"`;
        else label = `${w.key} = ${w.display}`;
        try {
            await echoPromise;
            acked++;
            markDirty(AM4_DIRTY_LABEL);
            recordAckOutcome(true);
            if (w.kind === 'channel' || w.kind === 'scene_channel') {
                lastKnownChannel[w.block] = w.index;
            }
            if (w.kind === 'am4_switch_scene') {
                invalidateChannelCache();
                lastActiveScene = w.sceneIndex;
            }
            if (w.kind === 'param') observeWrittenParam(w.block, w.paramName, w.resolved);
            let applicabilityNote = '';
            if (w.kind === 'param') {
                const warning = preflightApplicabilityWarning(`${w.block}.${w.paramName}`);
                if (warning) applicabilityNote = ' ⚠ type-gated; current ' + w.block + '.type may not expose this knob.';
            }
            lines.push(`  ✓ ${label}${applicabilityNote}`);
        } catch {
            unacked++;
            recordAckOutcome(false);
            lines.push(`  ? ${label}, no ack within ${WRITE_ECHO_TIMEOUT_MS} ms`);
            // FIX F: per-miss tally to stderr (the MCP log panel) so a reader
            // can watch the device go dark in real time instead of seeing a
            // silent hang with no output at all (the incident's worst part).
            console.error(`apply_preset: no ack (${label}) — unacked=${unacked}/${sent} sent, elapsed=${Date.now() - startMs} ms`);
        }
    }
    if (nameWriteBytes !== undefined) {
        totalWrites++;
        const result = await sendAndAwaitAck(conn, nameWriteBytes, isCommandAck);
        const label = `rename working buffer → "${workingBufferName}"`;
        if (result.acked) {
            acked++;
            markDirty(AM4_DIRTY_LABEL);
            lines.push(`  ✓ ${label}`);
        } else {
            unacked++;
            lines.push(`  ? ${label}, no ack within ${WRITE_ECHO_TIMEOUT_MS} ms`);
        }
    }

    return { lines, acked, unacked, totalWrites, lastActiveScene, budgetExceeded };
}

/**
 * Build the user-facing summary lines (header + state + write timeline)
 * from a wire result. Used by `am4_apply_preset` for the conversational
 * response shape.
 */
export function formatApplyPresetResult(result: ApplyPresetWireResult): {
    header: string;
    stateLines: string[];
    lines: string[];
} {
    const { lines, acked, unacked, totalWrites, lastActiveScene } = result;
    const stateLines: string[] = [];
    if (lastActiveScene !== undefined) {
        stateLines.push(
            `Active scene after this call: ${lastActiveScene + 1} (landing scene). All four scenes were configured: any scene you did not list was reset to defaults (channel A on every placed block, all blocks active, name cleared).`,
        );
        const channelPairs = (['amp', 'drive', 'reverb', 'delay'] as const)
            .filter((b) => lastKnownChannel[b] !== undefined)
            .map((b) => `${b}=${channelLetter(lastKnownChannel[b] as number)}`);
        if (channelPairs.length) {
            stateLines.push(
                `Channels the active scene (${lastActiveScene + 1}) now points at: ${channelPairs.join(', ')}.`,
            );
        }
    } else {
        const channelPairs = (['amp', 'drive', 'reverb', 'delay'] as const)
            .filter((b) => lastKnownChannel[b] !== undefined)
            .map((b) => `${b}=${channelLetter(lastKnownChannel[b] as number)}`);
        if (channelPairs.length) {
            stateLines.push(
                `Last channel written per block: ${channelPairs.join(', ')}. Param values are stored in those channels regardless of scene; which scene plays which channel is unchanged by this call.`,
            );
        }
    }

    const header = unacked === 0
        ? `Applied preset: ${totalWrites} writes, all wire-acked. Acks don't confirm audible change, cross-check on the AM4 if it matters. Working buffer only, the user can discard by switching presets, or ask to save/persist to a preset location.`
        : `Applied preset: ${totalWrites} writes, ${acked} acked, ${unacked} un-acked. The first write burst after a fresh connection commonly drops a few acks while the port warms up; retry the same call once and it almost always lands clean. The server also auto-reconnects after ${STALE_HANDLE_TIMEOUT_THRESHOLD} consecutive ack-less writes, so a persistent dead handle self-heals without manual intervention.`;
    return { header, stateLines, lines };
}

// --- apply-preset-at composite (switch + apply + optional save) ---

export type ApplyPresetAtSuccess = {
    ok: true;
    location: string;
    applied: { slots: ApplyPresetSlotInput[]; scenes: ApplyPresetSceneInput[]; name: string };
    /** True when the save step ran AND acked. False = audition only (working buffer at target). */
    saved: boolean;
    /**
     * Param writes the validator dropped because their applies_only_when
     * gate excluded the active (or in-batch) block type. Empty list =
     * everything in the spec landed. Non-empty = those params were not
     * sent over the wire; the response surfaces them so the caller can
     * honestly tell the user what didn't apply (vs claiming success on a
     * silent device no-op).
     */
    skipped: ApplyPresetSkippedParam[];
    /** BK-103b: cab-polish defaults the executor injected (undefined = none). */
    cabPolish?: ApplyPresetCabPolish;
    /** Scene-level initialization the executor always performs on a fresh build. */
    sceneLevels?: ApplyPresetSceneLevels;
    wallTimeMs: number;
};
export type ApplyPresetAtFailure = {
    ok: false;
    location: string;
    step: 'validate' | 'switch' | 'apply' | 'save';
    error: string;
    wallTimeMs: number;
};
export type ApplyPresetAtResult = ApplyPresetAtSuccess | ApplyPresetAtFailure;

export interface RunApplyPresetAtOptions {
    /**
     * When true (default), the executor runs switch + apply + save. When
     * false, only switch + apply runs, the preset lives in the working
     * buffer at the target location and is reversible by switching
     * presets. The user explicitly saves with `save_preset` (or by re-
     * calling apply_preset with save:true).
     */
    save?: boolean;
}

/**
 * Run the switch + apply + (optional) save sequence for one entry.
 * Validates the preset shape via `prepareApplyPresetWrites` before any
 * wire writes (matching `am4_apply_preset`'s up-front rejection). Reused
 * by both `apply_preset(target_location)` (single entry) and
 * `apply_setlist` (loop).
 *
 * `options.save` (default true) controls the save step. Setlist flows
 * always save (multi-preset intent implies save). Single-preset audition
 * passes `save: false`.
 *
 * On any failure the function captures which primitive failed (the `step`
 * field) so callers can surface "switch failed at G2" vs "save failed at
 * G2" without re-classifying the error string.
 */
export async function runApplyPresetAt(
    conn: MidiConnection,
    locationIndex: number,
    preset: ApplyPresetInput,
    options: RunApplyPresetAtOptions = {},
): Promise<ApplyPresetAtResult> {
    const shouldSave = options.save ?? true;
    const startMs = Date.now();
    const shortLocation = formatLocationDisplay(locationIndex);
    let prepared: ApplyPresetPreparedWrite[];
    let nameWriteBytes: number[] | undefined;
    let skipped: ApplyPresetSkippedParam[];
    let cabPolish: ApplyPresetCabPolish | undefined;
    let sceneLevels: ApplyPresetSceneLevels | undefined;
    try {
        ({ prepared, nameWriteBytes, skipped, cabPolish, sceneLevels } = prepareApplyPresetWrites(preset));
    } catch (err) {
        return {
            ok: false,
            location: shortLocation,
            step: 'validate',
            error: err instanceof Error ? err.message : String(err),
            wallTimeMs: Date.now() - startMs,
        };
    }

    console.error(`apply_preset start: location=${shortLocation}, prepared=${prepared.length} writes, save=${shouldSave}`);

    const switchBytes = buildSwitchPreset(locationIndex);
    const switchResult = await sendAndAwaitAck(conn, switchBytes, isWriteEcho);
    invalidateChannelCache();
    if (!switchResult.acked) {
        console.error(`apply_preset done: location=${shortLocation} FAILED step=switch (no ack), elapsed=${Date.now() - startMs} ms`);
        return {
            ok: false,
            location: shortLocation,
            step: 'switch',
            error: `Preset switch to ${shortLocation} sent but no ack received within ${WRITE_ECHO_TIMEOUT_MS} ms.`,
            wallTimeMs: Date.now() - startMs,
        };
    }

    let wireResult: ApplyPresetWireResult;
    try {
        wireResult = await runApplyPresetWires(conn, prepared, nameWriteBytes, preset.name);
    } catch (err) {
        return {
            ok: false,
            location: shortLocation,
            step: 'apply',
            error: err instanceof Error ? err.message : String(err),
            wallTimeMs: Date.now() - startMs,
        };
    }
    if (wireResult.budgetExceeded) {
        const wallTimeMs = Date.now() - startMs;
        console.error(`apply_preset done: location=${shortLocation} ABORTED acked=${wireResult.acked} unacked=${wireResult.unacked} elapsed=${wallTimeMs} ms step=apply`);
        return {
            ok: false,
            location: shortLocation,
            step: 'apply',
            error: `apply budget exceeded: sent ${wireResult.acked + wireResult.unacked} of ${wireResult.totalWrites} writes in ${wallTimeMs} ms before the device went silent. Reconnect (reconnect_midi) and retry — the same spec completes the unfinished writes idempotently.`,
            wallTimeMs,
        };
    }

    if (!shouldSave) {
        // Audition-at-target: leave the working buffer at the target,
        // unsaved. Reversible by switching presets. The save step is
        // skipped entirely, caller invokes save_preset when the user
        // explicitly asks to persist.
        console.error(`apply_preset done: location=${shortLocation} acked=${wireResult.acked} unacked=${wireResult.unacked} elapsed=${Date.now() - startMs} ms step=audition`);
        return {
            ok: true,
            location: shortLocation,
            applied: {
                slots: preset.slots,
                scenes: preset.scenes ?? [],
                name: preset.name ?? '',
            },
            saved: false,
            skipped,
            cabPolish,
            sceneLevels,
            wallTimeMs: Date.now() - startMs,
        };
    }

    const saveBytes = buildSaveToLocation(locationIndex);
    const saveResult = await sendAndAwaitAck(conn, saveBytes, isCommandAck);
    if (!saveResult.acked) {
        console.error(`apply_preset done: location=${shortLocation} FAILED step=save (no ack), elapsed=${Date.now() - startMs} ms`);
        return {
            ok: false,
            location: shortLocation,
            step: 'save',
            error: `Save to ${shortLocation} sent but no ack received within ${WRITE_ECHO_TIMEOUT_MS} ms.`,
            wallTimeMs: Date.now() - startMs,
        };
    }

    // Save persisted the re-applied buffer to flash → clean. Only the
    // save clears the flag (NOT the earlier switch): if runApplyPresetWires
    // had thrown mid-setup, a switch-time markClean would leave the flag
    // clean over a partially-mutated buffer.
    markClean(AM4_DIRTY_LABEL);

    console.error(`apply_preset done: location=${shortLocation} acked=${wireResult.acked} unacked=${wireResult.unacked} elapsed=${Date.now() - startMs} ms step=saved`);

    return {
        ok: true,
        location: shortLocation,
        applied: {
            slots: preset.slots,
            scenes: preset.scenes ?? [],
            name: preset.name ?? '',
        },
        saved: true,
        skipped,
        cabPolish,
        sceneLevels,
        wallTimeMs: Date.now() - startMs,
    };
}
