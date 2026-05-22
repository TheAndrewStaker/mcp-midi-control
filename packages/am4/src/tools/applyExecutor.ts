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
 *     so the unified `apply_preset` / `apply_setlist` / `restore_defaults`
 *     tools dispatch through the same executor.
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
            const ordered = Object.entries(slot.params).sort(([a], [b]) =>
                a === 'type' ? -1 : b === 'type' ? 1 : 0,
            );
            for (const [paramName, value] of ordered) {
                const write = buildParamWrite(at, canonicalBlock, paramName, value);
                if (write !== null) prepared.push(write);
                // null = applicability gate dropped the param; the
                // skip is already in `skipped[]`. The remaining writes
                // in this slot still go through.
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
                    const write = buildParamWrite(
                        `${at} channels.${letter}.${paramName}`,
                        canonicalBlock,
                        paramName,
                        value,
                    );
                    if (write !== null) prepared.push(write);
                    // null = applicability skip; reason already in `skipped[]`.
                }
            }
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
        const chList: PreparedScene['channels'] = [];
        for (const [block] of placedBlocks) {
            if (!CHANNEL_BLOCKS.has(block)) continue;
            chList.push({ block, letter: 'A', index: 0 });
        }
        preparedScenes.push({
            sceneIndex: sceneNum - 1,
            oneBased: sceneNum,
            channels: chList,
            bypass: [],
            name: '',
        });
    }
    preparedScenes.sort((a, b) => a.sceneIndex - b.sceneIndex);

    if (preparedScenes.length > 0) {
        for (const ps of preparedScenes) {
            prepared.push({
                kind: 'am4_switch_scene',
                sceneIndex: ps.sceneIndex,
                bytes: buildSwitchScene(ps.sceneIndex),
            });
            for (const ch of ps.channels) {
                const channelKey = `${ch.block}.channel` as ParamKey;
                prepared.push({
                    kind: 'scene_channel',
                    block: ch.block,
                    index: ch.index,
                    sceneIndex: ps.sceneIndex,
                    bytes: buildSetParam(channelKey, ch.index),
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

    return { prepared, nameWriteBytes, skipped };
}

/**
 * Writes that ack with the 18-byte command-ack shape (rename family) vs
 * the 64-byte write-echo shape (SET_PARAM / placement / scene-switch /
 * bypass). Used by the send loop to pick the right predicate.
 */
export const APPLY_PRESET_COMMAND_ACK_KINDS = new Set<ApplyPresetPreparedWrite['kind']>(['scene_name']);

export interface ApplyPresetWireResult {
    lines: string[];
    acked: number;
    unacked: number;
    totalWrites: number;
    /** Final scene index reported in user-facing summary (0..3); undefined when no scene was touched. */
    lastActiveScene: number | undefined;
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

    for (const w of prepared) {
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
        }
    }
    if (nameWriteBytes !== undefined) {
        totalWrites++;
        const result = await sendAndAwaitAck(conn, nameWriteBytes, isCommandAck);
        const label = `rename working buffer → "${workingBufferName}"`;
        if (result.acked) {
            acked++;
            lines.push(`  ✓ ${label}`);
        } else {
            unacked++;
            lines.push(`  ? ${label}, no ack within ${WRITE_ECHO_TIMEOUT_MS} ms`);
        }
    }

    return { lines, acked, unacked, totalWrites, lastActiveScene };
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
        : `Applied preset: ${totalWrites} writes, ${acked} acked, ${unacked} un-acked (server auto-reconnects after ${STALE_HANDLE_TIMEOUT_THRESHOLD} consecutive ack-less writes; or call reconnect_midi).`;
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
    try {
        ({ prepared, nameWriteBytes, skipped } = prepareApplyPresetWrites(preset));
    } catch (err) {
        return {
            ok: false,
            location: shortLocation,
            step: 'validate',
            error: err instanceof Error ? err.message : String(err),
            wallTimeMs: Date.now() - startMs,
        };
    }

    const switchBytes = buildSwitchPreset(locationIndex);
    const switchResult = await sendAndAwaitAck(conn, switchBytes, isWriteEcho);
    invalidateChannelCache();
    if (!switchResult.acked) {
        return {
            ok: false,
            location: shortLocation,
            step: 'switch',
            error: `Preset switch to ${shortLocation} sent but no ack received within ${WRITE_ECHO_TIMEOUT_MS} ms.`,
            wallTimeMs: Date.now() - startMs,
        };
    }

    try {
        await runApplyPresetWires(conn, prepared, nameWriteBytes, preset.name);
    } catch (err) {
        return {
            ok: false,
            location: shortLocation,
            step: 'apply',
            error: err instanceof Error ? err.message : String(err),
            wallTimeMs: Date.now() - startMs,
        };
    }

    if (!shouldSave) {
        // Audition-at-target: leave the working buffer at the target,
        // unsaved. Reversible by switching presets. The save step is
        // skipped entirely, caller invokes save_preset when the user
        // explicitly asks to persist.
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
            wallTimeMs: Date.now() - startMs,
        };
    }

    const saveBytes = buildSaveToLocation(locationIndex);
    const saveResult = await sendAndAwaitAck(conn, saveBytes, isCommandAck);
    if (!saveResult.acked) {
        return {
            ok: false,
            location: shortLocation,
            step: 'save',
            error: `Save to ${shortLocation} sent but no ack received within ${WRITE_ECHO_TIMEOUT_MS} ms.`,
            wallTimeMs: Date.now() - startMs,
        };
    }

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
        wallTimeMs: Date.now() - startMs,
    };
}
